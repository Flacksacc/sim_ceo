using System.Collections.Concurrent;
using Microsoft.AspNetCore.SignalR;
using SimCEO.Api.Data;

namespace SimCEO.Api.Hubs;

public sealed record HubConn(string ConnectionId, string UserKey, string SessionToken, Guid? BoardId, Guid? MeetingId, DateTime ConnectedAt);

public sealed class BoardHub : Hub
{
  private static readonly ConcurrentDictionary<string, HubConn> Conns = new();
  private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, System.Collections.Generic.HashSet<string>> JoinedGroups = new();
  private static string Canonical(Guid g) => g.ToString("N").ToLowerInvariant();
  private static readonly ConcurrentDictionary<string, bool> RevokedTokens = new();
  private static IHubContext<BoardHub>? Ctx;
  private static IServiceProvider? Services;
  // Lock order (P1): ROOT (Atomic/Setup/Message/Auth/PG table/backend gate) is NEVER
  // acquired under HubGate. HubGate guards ONLY connection metadata (Conns,
  // JoinedGroups, LiveContexts) plus Groups add/remove coordination. All
  // store/DB/session/CanForUser validation runs under ROOT (Atomic) OUTSIDE
  // HubGate: pre-validate under ROOT, group-add under HubGate WITHOUT ROOT,
  // release HubGate, then post-add revalidate under ROOT. Cleanup/revoke runs
  // outside BOTH locks. No await is ever held under ROOT.
  private static readonly SemaphoreSlim HubGate = new(1, 1);
  // Live per-connection abort capability: captured HubCallerContext per connection.
  private static readonly ConcurrentDictionary<string, HubCallerContext> LiveContexts = new();
  private static System.Threading.Timer? ExpiryTimer;

  public static void Wire(IHubContext<BoardHub> ctx, IServiceProvider services)
  {
    Ctx = ctx;
    Services = services;
    try
    {
      ExpiryTimer ??= new System.Threading.Timer(_ =>
      {
        try { EnforceExpiry(); } catch { }
      }, null, TimeSpan.FromSeconds(30), TimeSpan.FromSeconds(30));
    }
    catch { }
  }

  // Real ongoing expiry enforcement (not only join checks): abort connections
  // whose server session is missing or past expiry; drop their groups.
  // No HubGate is held while touching the store: snapshot under ROOT, then
  // RemoveConnection (HubGate-only) outside ROOT.
  private static void EnforceExpiry()
  {
    try
    {
      var svc = Services;
      if (svc is null) return;
      InMemoryStore store;
      try { store = svc.GetRequiredService<InMemoryStore>(); } catch { return; }
      var snap = Conns.ToList();
      bool secureNow = false;
      try { secureNow = Atomic.Run(store, () => { try { return PeopleOps.IsSecure(store); } catch { return false; } }); }
      catch { return; }
      List<string> expired = new();
      List<string> anon = new();
      try
      {
        var res = Atomic.Run(store, () =>
        {
          var ex = new System.Collections.Generic.List<string>();
          var an = new System.Collections.Generic.List<string>();
          foreach (var kv in snap)
          {
            var tok = kv.Value.SessionToken;
            if (string.IsNullOrEmpty(tok)) { if (secureNow) an.Add(kv.Key); continue; }
            try
            {
              if (RevokedTokens.ContainsKey(tok)) { ex.Add(kv.Key); continue; }
              if (!store.Sessions.TryGetValue(tok, out var sess) || sess.ExpiresAt <= System.DateTime.UtcNow) ex.Add(kv.Key);
            }
            catch { }
          }
          return (ex, an);
        });
        expired = res.Item1;
        anon = res.Item2;
      }
      catch { return; }
      foreach (var id in expired)
      {
        string? tok = null;
        if (Conns.TryGetValue(id, out var c)) tok = c.SessionToken;
        try { RemoveConnection(id, tok is null ? null : new { token = tok }); } catch { }
      }
      foreach (var id in anon)
      {
        try { RemoveConnection(id, new { anonymousTransition = true }); } catch { }
      }
    }
    catch { }
  }

  // ROOT-ONLY helpers (never call while holding HubGate): they touch Sessions,
  // Security/Accounts/Boards/Grants tables (PG backend) and must run inside
  // Atomic (ROOT -> backend order).
  private static bool TryGetSession(HttpContext? http, out string email, out string token)
  {
    email = ""; token = "";
    try
    {
      if (http is null) return false;
      var q = http.Request.Query["access_token"].ToString();
      var auth = http.Request.Headers["Authorization"].ToString();
      var t = "";
      if (!string.IsNullOrWhiteSpace(q)) t = q.Trim();
      else if (!string.IsNullOrWhiteSpace(auth) && auth.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
        t = auth["Bearer ".Length..].Trim();
      if (string.IsNullOrWhiteSpace(t)) return false;
      token = t;
      if (RevokedTokens.ContainsKey(t)) return false;
      var store = http.RequestServices.GetRequiredService<InMemoryStore>();
      if (!store.Sessions.TryGetValue(t, out var sess) || sess.ExpiresAt <= System.DateTime.UtcNow) return false;
      email = sess.Email;
      return true;
    }
    catch { return false; }
  }

  private static bool CanForUser(InMemoryStore s, string user, Guid boardId, Guid? meetingId, string need)
  {
    try
    {
      if (!PeopleOps.IsSecure(s))
      {
        var have = PeopleOps.AccessFor(s, boardId, meetingId, user);
        if (have == "open") return true;
        return need switch
        {
          "read" => have is "read" or "contribute" or "manage" or "discuss",
          "discuss" => have is "discuss" or "read" or "contribute" or "manage",
          _ => have == "manage" || have == "contribute",
        };
      }
      if (string.IsNullOrWhiteSpace(user) || string.Equals(user, "owner", StringComparison.OrdinalIgnoreCase)) return false;
      var access = PeopleOps.AccessFor(s, boardId, meetingId, user);
      if (need == "read")
        return access is "read" or "contribute" or "manage" || (access == "discuss" && meetingId != null);
      if (need == "discuss")
        return access is "discuss" or "read" or "contribute" or "manage";
      return access == "manage" || (need == "contribute" && access == "manage");
    }
    catch { return false; }
  }

  public override async Task OnConnectedAsync()
  {
    var http = Context.GetHttpContext();
    if (http is not null)
    {
      var path = http.Request.Path.Value ?? "";
      if (path.StartsWith("/hubs/board", StringComparison.OrdinalIgnoreCase))
      {
        var store = http.RequestServices.GetRequiredService<InMemoryStore>();
        // Phase 1 (ROOT, no HubGate): validate bearer/session/security.
        bool invalid = false;
        bool authed = false;
        string email = "";
        string token = "";
        bool secure = false;
        string anonUser = "owner";
        try
        {
          var r = Atomic.Run(store, () =>
          {
            bool inv = false;
            bool au = false;
            string em = "";
            string tk = "";
            bool sec = false;
            try { inv = PeopleOps.HasInvalidToken(store, http.Request); } catch { inv = false; }
            try { au = TryGetSession(http, out em, out tk); } catch { au = false; }
            try { sec = PeopleOps.IsSecure(store); } catch { sec = false; }
            string an = "owner";
            try { if (http.Request.Headers.TryGetValue("X-User", out var xv) && !string.IsNullOrWhiteSpace(xv.ToString())) an = xv.ToString(); } catch { }
            return (inv, au, em, tk, sec, an);
          });
          invalid = r.Item1; authed = r.Item2; email = r.Item3; token = r.Item4; secure = r.Item5; anonUser = r.Item6;
        }
        catch { invalid = false; authed = false; secure = false; }
        if (invalid)
        {
          try { Context.Abort(); } catch { }
          await base.OnConnectedAsync();
          return;
        }
        // Phase 2 (HubGate ONLY): registry insert, no store access.
        await HubGate.WaitAsync();
        try
        {
          if (authed)
          {
            Conns[Context.ConnectionId] = new HubConn(Context.ConnectionId, email, token, null, null, DateTime.UtcNow);
            LiveContexts[Context.ConnectionId] = Context;
          }
          else
          {
            if (secure)
            {
              try { Context.Abort(); } catch { }
              return;
            }
            Conns[Context.ConnectionId] = new HubConn(Context.ConnectionId, anonUser, "", null, null, DateTime.UtcNow);
            LiveContexts[Context.ConnectionId] = Context;
          }
        }
        finally { try { HubGate.Release(); } catch { } }
      }
    }
    await base.OnConnectedAsync();
  }

  public override async Task OnDisconnectedAsync(Exception? ex)
  {
    Conns.TryRemove(Context.ConnectionId, out _);
    JoinedGroups.TryRemove(Context.ConnectionId, out _);
    LiveContexts.TryRemove(Context.ConnectionId, out _);
    await base.OnDisconnectedAsync(ex);
  }

  public async Task JoinBoard(string boardId)
  {
    var http = Context.GetHttpContext();
    var store = http!.RequestServices.GetRequiredService<InMemoryStore>();
    if (!Guid.TryParse(boardId, out var bid)) throw new HubException("Unknown board.");
    // Phase 1 (ROOT, no HubGate, no await): full pre-add validation.
    string user = "";
    string tok = "";
    bool secure = false;
    Guid restore = Guid.Empty;
    bool preOk = false;
    bool needAbort = false;
    try
    {
      var r = Atomic.Run(store, () =>
      {
        string u = "";
        string t = "";
        bool sec = false;
        Guid rs = Guid.Empty;
        try { rs = store.RestoreEpochId; } catch { }
        try { sec = PeopleOps.IsSecure(store); } catch { sec = false; }
        if (TryGetSession(http, out var em, out var tk)) { u = em; t = tk; }
        else if (!sec)
        {
          u = "owner";
          try { if (http.Request.Headers.TryGetValue("X-User", out var xv) && !string.IsNullOrWhiteSpace(xv.ToString())) u = xv.ToString(); } catch { }
        }
        else return (u, t, sec, rs, false, true);
        if (!string.IsNullOrEmpty(t) && RevokedTokens.ContainsKey(t)) return (u, t, sec, rs, false, true);
        try { if (!store.Boards.TryGetValue(bid, out var b) || b is null) return (u, t, sec, rs, false, false); } catch { return (u, t, sec, rs, false, false); }
        bool ok = false;
        try { ok = CanForUser(store, u, bid, null, "read"); } catch { ok = false; }
        return (u, t, sec, rs, ok, !ok && sec);
      });
      user = r.Item1; tok = r.Item2; secure = r.Item3; restore = r.Item4; preOk = r.Item5; needAbort = r.Item6;
    }
    catch { preOk = false; }
    if (!preOk)
    {
      if (needAbort) { try { Context.Abort(); } catch { } }
      throw new HubException(!secure ? "Access revoked or not granted for this scope." : "Access revoked or not granted for this scope.");
    }
    if (!string.IsNullOrEmpty(tok) && RevokedTokens.ContainsKey(tok)) { try { Context.Abort(); } catch { } throw new HubException("Session revoked."); }
    // Phase 2 (HubGate ONLY, no store): registry + group add.
    var grp = $"board:{Canonical(bid)}";
    await HubGate.WaitAsync();
    try
    {
      if (Conns.TryGetValue(Context.ConnectionId, out var ex))
        Conns[Context.ConnectionId] = ex with { UserKey = user, SessionToken = tok, BoardId = bid };
      else
        Conns[Context.ConnectionId] = new HubConn(Context.ConnectionId, user, tok, bid, null, DateTime.UtcNow);
      LiveContexts[Context.ConnectionId] = Context;
      await Groups.AddToGroupAsync(Context.ConnectionId, grp);
      JoinedGroups.AddOrUpdate(Context.ConnectionId, new System.Collections.Generic.HashSet<string> { grp }, (k, s) => { lock (s) { s.Add(grp); } return s; });
    }
    finally { try { HubGate.Release(); } catch { } }
    // Phase 3 (ROOT, no HubGate): complete post-add revalidation.
    bool stillOk = false;
    try
    {
      var pinnedUser = user; var pinnedTok = tok; var pinnedRestore = restore;
      stillOk = Atomic.Run(store, () =>
      {
        if (!string.IsNullOrEmpty(pinnedTok))
        {
          if (RevokedTokens.ContainsKey(pinnedTok)) return false;
          if (!store.Sessions.TryGetValue(pinnedTok, out var ss)) return false;
          if (ss.ExpiresAt <= System.DateTime.UtcNow) return false;
          if (!string.Equals(ss.Email, pinnedUser, StringComparison.OrdinalIgnoreCase)) return false;
        }
        else if (secure) return false;
        try { if (!store.Boards.TryGetValue(bid, out var cb) || cb is null) return false; } catch { return false; }
        try { if (store.RestoreEpochId != pinnedRestore) return false; } catch { return false; }
        if (!CanForUser(store, pinnedUser, bid, null, "read")) return false;
        return true;
      });
    }
    catch { stillOk = false; }
    // Phase 4 (outside BOTH locks): ALWAYS central cleanup before throw.
    if (!stillOk)
    {
      // Best-effort single-group removal under HubGate; retain bookkeeping on failure for retry.
      try
      {
        await HubGate.WaitAsync();
        try
        {
          bool removedOk = false;
          try { await Groups.RemoveFromGroupAsync(Context.ConnectionId, grp); removedOk = true; } catch { removedOk = false; }
          if (removedOk)
          {
            try { if (JoinedGroups.TryGetValue(Context.ConnectionId, out var gs0)) { lock (gs0) { gs0.Remove(grp); } } } catch { }
          }
        }
        finally { try { HubGate.Release(); } catch { } }
      }
      catch { }
      try { RemoveConnection(Context.ConnectionId, new { revoked = true }); } catch { }
      if (secure) { try { Context.Abort(); } catch { } }
      throw new HubException("Access revoked or not granted for this scope.");
    }
  }

  public static bool IsTokenRevoked(string token)
  {
    try { return !string.IsNullOrEmpty(token) && RevokedTokens.ContainsKey(token); }
    catch { return false; }
  }
  public async Task JoinMeeting(string meetingId)
  {
    var http = Context.GetHttpContext();
    var store = http!.RequestServices.GetRequiredService<InMemoryStore>();
    if (!Guid.TryParse(meetingId, out var mid)) throw new HubException("Unknown meeting.");
    // Phase 0 (ROOT, no HubGate): resolve current meeting parent.
    Guid boardId0 = Guid.Empty;
    try
    {
      boardId0 = Atomic.Run(store, () =>
      {
        if (!store.Meetings.TryGetValue(mid, out var mtg0) || mtg0 is null) throw new HubException("Unknown meeting.");
        return mtg0.BoardId;
      });
    }
    catch (HubException) { throw; }
    catch { throw new HubException("Unknown meeting."); }
    // Durable implicit membership (own Atomic, no HubGate).
    string preUser0 = "";
    string preTok0 = "";
    try
    {
      var pre = Atomic.Run(store, () =>
      {
        string u = ""; string t = "";
        bool sec = false;
        try { sec = PeopleOps.IsSecure(store); } catch { sec = false; }
        if (TryGetSession(http, out var em, out var tk)) { u = em; t = tk; }
        else if (!sec)
        {
          u = "owner";
          try { if (http.Request.Headers.TryGetValue("X-User", out var xv0) && !string.IsNullOrWhiteSpace(xv0.ToString())) u = xv0.ToString(); } catch { }
        }
        return (u, t, sec);
      });
      preUser0 = pre.Item1; preTok0 = pre.Item2;
      bool preSecure = pre.Item3;
      if (!string.IsNullOrEmpty(preTok0) && RevokedTokens.ContainsKey(preTok0)) { try { Context.Abort(); } catch { } throw new HubException("Session revoked."); }
      if (string.IsNullOrEmpty(preUser0) && preSecure) { try { Context.Abort(); } catch { } throw new HubException("Authentication required."); }
    }
    catch (HubException) { throw; }
    catch { preUser0 = ""; preTok0 = ""; }
    if (!string.IsNullOrEmpty(preTok0) && RevokedTokens.ContainsKey(preTok0)) { try { Context.Abort(); } catch { } throw new HubException("Session revoked."); }
    var ensured = PeopleOps.EnsureMeetingMembershipForConnection(store, preUser0, preTok0, boardId0, mid, explicitJoin: false);
    if (ensured.Error is not null)
    {
      bool sec2 = false;
      try { sec2 = Atomic.Run(store, () => { try { return PeopleOps.IsSecure(store); } catch { return false; } }); } catch { }
      if (sec2) { try { Context.Abort(); } catch { } }
      throw new HubException("Access revoked or not granted for this scope.");
    }
    // Phase 1 (ROOT, no HubGate, no await): pin current identity/parent/epoch/grant.
    string pinnedUser = "";
    string pinnedTok = "";
    Guid pinnedBoard = boardId0;
    Guid pinnedRestore = Guid.Empty;
    bool preOk = false;
    bool preSecureFlag = false;
    try
    {
      var r = Atomic.Run(store, () =>
      {
        string u = ""; string t = ""; bool sec = false; Guid rs = Guid.Empty;
        try { sec = PeopleOps.IsSecure(store); } catch { sec = false; }
        try { rs = store.RestoreEpochId; } catch { }
        if (TryGetSession(http, out var em, out var tk)) { u = em; t = tk; }
        else if (!sec)
        {
          u = "owner";
          try { if (http.Request.Headers.TryGetValue("X-User", out var xv) && !string.IsNullOrWhiteSpace(xv.ToString())) u = xv.ToString(); } catch { }
        }
        else return (u, t, sec, rs, false);
        if (!string.IsNullOrEmpty(t) && RevokedTokens.ContainsKey(t)) return (u, t, sec, rs, false);
        if (!store.Meetings.TryGetValue(mid, out var cm) || cm is null || cm.BoardId != pinnedBoard) return (u, t, sec, rs, false);
        bool ok = false;
        try { ok = CanForUser(store, u, pinnedBoard, mid, "read"); } catch { ok = false; }
        if (!ok) return (u, t, sec, rs, false);
        return (u, t, sec, rs, true);
      });
      pinnedUser = r.Item1; pinnedTok = r.Item2; preSecureFlag = r.Item3; pinnedRestore = r.Item4; preOk = r.Item5;
    }
    catch { preOk = false; }
    if (!preOk)
    {
      if (preSecureFlag) { try { Context.Abort(); } catch { } }
      throw new HubException("Access revoked or not granted for this scope.");
    }
    // Phase 2 (HubGate ONLY, no store): registry + group add.
    var grp = $"meeting:{Canonical(mid)}";
    await HubGate.WaitAsync();
    try
    {
      if (Conns.TryGetValue(Context.ConnectionId, out var ex))
        Conns[Context.ConnectionId] = ex with { UserKey = pinnedUser, SessionToken = pinnedTok, BoardId = pinnedBoard, MeetingId = mid };
      else
        Conns[Context.ConnectionId] = new HubConn(Context.ConnectionId, pinnedUser, pinnedTok, pinnedBoard, mid, DateTime.UtcNow);
      LiveContexts[Context.ConnectionId] = Context;
      await Groups.AddToGroupAsync(Context.ConnectionId, grp);
      JoinedGroups.AddOrUpdate(Context.ConnectionId, new System.Collections.Generic.HashSet<string> { grp }, (k, s) => { lock (s) { s.Add(grp); } return s; });
    }
    finally { try { HubGate.Release(); } catch { } }
    // Phase 3 (ROOT, no HubGate): complete post-add revalidation (auth/session/
    // meeting parent/grant/membership/epoch).
    bool stillOk = false;
    try
    {
      var pu = pinnedUser; var pt = pinnedTok; var pb = pinnedBoard; var pr = pinnedRestore;
      stillOk = Atomic.Run(store, () =>
      {
        if (!string.IsNullOrEmpty(pt))
        {
          if (RevokedTokens.ContainsKey(pt)) return false;
          if (!store.Sessions.TryGetValue(pt, out var ss)) return false;
          if (ss.ExpiresAt <= System.DateTime.UtcNow) return false;
          if (!string.Equals(ss.Email, pu, StringComparison.OrdinalIgnoreCase)) return false;
          if (!string.Equals(pu, pinnedUser, StringComparison.OrdinalIgnoreCase)) return false;
          if (!string.Equals(pt, pinnedTok, StringComparison.Ordinal)) return false;
        }
        if (!store.Meetings.TryGetValue(mid, out var cm)) return false;
        if (cm == null) return false;
        if (cm.BoardId != pb) return false;
        try { if (store.RestoreEpochId != pr) return false; } catch { return false; }
        Domain.Membership? mem = null;
        try
        {
          foreach (var mm in store.Memberships.Values)
          {
            if (mm.BoardId != pb) continue;
            if (mm.MeetingId != mid) continue;
            if (!string.Equals(mm.UserKey, pu, StringComparison.OrdinalIgnoreCase)) continue;
            mem = mm; break;
          }
        }
        catch { return false; }
        if (mem != null)
        {
          if (!mem.Active)
          {
            bool indep = false;
            try { indep = PeopleOps.HasIndependentAuthority(store, pb, pu); } catch { indep = false; }
            if (!indep) return false;
          }
        }
        if (!CanForUser(store, pu, pb, mid, "read")) return false;
        return true;
      });
    }
    catch { stillOk = false; }
    // Phase 4 (outside BOTH locks): ALWAYS central cleanup before throw.
    // The flag is consumed here, after HubGate was released, so the throw path
    // is reachable (no unreachable post-throw call).
    if (!stillOk)
    {
      // Best-effort single-group removal under HubGate; retain bookkeeping on
      // failure so the central remover retries that tracked group.
      try
      {
        await HubGate.WaitAsync();
        try
        {
          bool removedOk = false;
          try { await Groups.RemoveFromGroupAsync(Context.ConnectionId, grp); removedOk = true; } catch { removedOk = false; }
          if (removedOk)
          {
            try { if (JoinedGroups.TryGetValue(Context.ConnectionId, out var gs0)) { lock (gs0) { gs0.Remove(grp); } } } catch { }
          }
        }
        finally { try { HubGate.Release(); } catch { } }
      }
      catch { }
      try { RemoveConnection(Context.ConnectionId, new { revoked = true }); } catch { }
      bool secNow = false;
      try { secNow = Atomic.Run(store, () => { try { return PeopleOps.IsSecure(store); } catch { return false; } }); } catch { }
      if (secNow) { try { Context.Abort(); } catch { } }
      throw new HubException("Access revoked or not granted for this scope.");
    }
  }

  // Central removal: remove ALL tracked groups first, notify, abort the actual
  // connection, and only then drop registry entries. Abort is the enforcement
  // guarantee even if a group removal fails (retried once). HubGate ONLY: no
  // store/ROOT access here.
  private static void RemoveConnection(string id, object? reason)
  {
    HubGate.Wait();
    try
    {
      var ctx = Ctx;
      System.Collections.Generic.List<string> groups;
      if (JoinedGroups.TryGetValue(id, out var gs)) { lock (gs) { groups = new System.Collections.Generic.List<string>(gs); } }
      else groups = new System.Collections.Generic.List<string>();
      Exception? firstError = null;
      if (ctx is not null)
      {
        foreach (var g in groups)
        {
          try { ctx.Groups.RemoveFromGroupAsync(id, g).GetAwaiter().GetResult(); }
          catch (Exception ex)
          {
            Exception? groupError = ex;
            try { ctx.Groups.RemoveFromGroupAsync(id, g).GetAwaiter().GetResult(); groupError = null; }
            catch (Exception ex2) { groupError = ex2; }
            if (groupError is not null && firstError is null) firstError = groupError;
          }
        }
        try { ctx.Clients.Client(id).SendAsync("access-revoked", reason ?? new { revoked = true }).GetAwaiter().GetResult(); }
        catch { }
      }
      try
      {
        if (LiveContexts.TryGetValue(id, out var live)) { try { live.Abort(); } catch { } }
      }
      catch { }
      Conns.TryRemove(id, out _);
      JoinedGroups.TryRemove(id, out _);
      LiveContexts.TryRemove(id, out _);
      if (firstError is not null) throw new InvalidOperationException("Hub group removal failed after retry; connection aborted.", firstError);
    }
    finally { try { HubGate.Release(); } catch { } }
  }

  public static void RevokeUser(string userKey, Guid? boardId = null, Guid? meetingId = null)
  {
    try
    {
      // Whole-principal selection: every live connection of this user, across ALL
      // joined scopes. Never depends on one last-recorded meeting/board field.
      var ids = Conns.Where(kv =>
        string.Equals(kv.Value.UserKey, userKey, StringComparison.OrdinalIgnoreCase)).Select(kv => kv.Key).ToList();
      foreach (var id in ids)
      {
        try { RemoveConnection(id, new { user = userKey, boardId, meetingId }); }
        catch { }
      }
    }
    catch { }
  }

  public static void RevokeTokenAndConnections(string token)
  {
    try { RevokedTokens[token] = true; } catch { }
    try
    {
      var ids = Conns.Where(kv => kv.Value.SessionToken == token).Select(kv => kv.Key).ToList();
      foreach (var id in ids)
      {
        try { RemoveConnection(id, new { revoked = true }); }
        catch { }
      }
    }
    catch { }
  }

  public static void AbortAnonymous()
  {
    try
    {
      var ids = Conns.Where(kv => string.IsNullOrEmpty(kv.Value.SessionToken)).Select(kv => kv.Key).ToList();
      foreach (var id in ids)
      {
        try { RemoveConnection(id, new { anonymousTransition = true }); }
        catch { }
      }
    }
    catch { }
  }

  public static void RevokeToken(string token)
  {
    try { RevokedTokens[token] = true; } catch { }
  }

  // Protected delivery: validate EVERY recipient current principal, live
  // session, and scope at the send boundary. An expired/revoked session or a
  // lost grant suppresses that recipient (and schedules cleanup) instead of
  // relying on the periodic sweep. Abort timers supplement, never replace,
  // this boundary. HubGate ONLY snapshots group membership; per-recipient
  // authority runs under ROOT (no HubGate held) and sends await outside ROOT.
  public static async System.Threading.Tasks.Task PublishMeeting(
    Microsoft.AspNetCore.SignalR.IHubContext<BoardHub> hub,
    SimCEO.Api.Data.InMemoryStore s, Guid meetingId, string method, object payload, string need = "read")
  {
    Guid boardId = Guid.Empty;
    try
    {
      boardId = Atomic.Run(s, () =>
      {
        if (!s.Meetings.TryGetValue(meetingId, out var mtg) || mtg is null) throw new InvalidOperationException("gone");
        return mtg.BoardId;
      });
    }
    catch { return; }
    var grp = $"meeting:{Canonical(meetingId)}";
    System.Collections.Generic.List<(string id, string user, string token)> targets;
    bool secure;
    try { secure = Atomic.Run(s, () => { try { return SimCEO.Api.PeopleOps.IsSecure(s); } catch { return false; } }); }
    catch { secure = false; }
    await HubGate.WaitAsync();
    try
    {
      targets = new System.Collections.Generic.List<(string, string, string)>();
      foreach (var kv in Conns.ToList())
      {
        var c = kv.Value;
        // Joined-group membership is authoritative: one connection may hold several
        // meetings (M1 then M2). The single last-recorded MeetingId must NOT filter
        // delivery, or M1 events are suppressed on still-joined connections.
        bool inGroup = false;
        if (JoinedGroups.TryGetValue(kv.Key, out var gs))
        { lock (gs) { inGroup = gs.Contains(grp); } }
        if (!inGroup) continue;
        targets.Add((kv.Key, c.UserKey ?? "", c.SessionToken ?? ""));
      }
    }
    finally { try { HubGate.Release(); } catch { } }
    foreach (var (id, user, token) in targets)
    {
      try
      {
        bool ok = false;
        try
        {
          ok = Atomic.Run(s, () =>
          {
            if (!string.IsNullOrEmpty(token))
            {
              if (RevokedTokens.ContainsKey(token)) return false;
              if (!s.Sessions.TryGetValue(token, out var sess) || sess.ExpiresAt <= System.DateTime.UtcNow) return false;
              var liveUser = sess.Email ?? "";
              if (!CanForUser(s, liveUser, boardId, meetingId, need)) return false;
              return true;
            }
            else if (!secure)
            {
              if (!CanForUser(s, user, boardId, meetingId, need)) return false;
              return true;
            }
            return false;
          });
        }
        catch { ok = false; }
        if (!ok) continue;
        await hub.Clients.Client(id).SendAsync(method, payload);
      }
      catch { }
    }
  }
  // Private delivery: same meeting-group + per-recipient auth as PublishMeeting,
  // additionally restricted to one user key. Used for requester-scoped activity
  // (secretary) that must never leak to other users or meeting-only guests.
  public static async System.Threading.Tasks.Task PublishPrivateMeeting(
    Microsoft.AspNetCore.SignalR.IHubContext<BoardHub> hub,
    SimCEO.Api.Data.InMemoryStore s, Guid meetingId, string userKey, string method, object payload)
  {
    if (string.IsNullOrWhiteSpace(userKey)) return;
    Guid boardId = Guid.Empty;
    try
    {
      boardId = Atomic.Run(s, () =>
      {
        if (!s.Meetings.TryGetValue(meetingId, out var mtg) || mtg is null) throw new InvalidOperationException("gone");
        return mtg.BoardId;
      });
    }
    catch { return; }
    var grp = $"meeting:{Canonical(meetingId)}";
    System.Collections.Generic.List<(string id, string user, string token)> targets;
    bool secure;
    try { secure = Atomic.Run(s, () => { try { return SimCEO.Api.PeopleOps.IsSecure(s); } catch { return false; } }); }
    catch { secure = false; }
    await HubGate.WaitAsync();
    try
    {
      targets = new System.Collections.Generic.List<(string, string, string)>();
      foreach (var kv in Conns.ToList())
      {
        var c = kv.Value;
        bool inGroup = false;
        if (JoinedGroups.TryGetValue(kv.Key, out var gs))
        { lock (gs) { inGroup = gs.Contains(grp); } }
        if (!inGroup) continue;
        if (!string.Equals(c.UserKey ?? "", userKey, System.StringComparison.OrdinalIgnoreCase)) continue;
        targets.Add((kv.Key, c.UserKey ?? "", c.SessionToken ?? ""));
      }
    }
    finally { try { HubGate.Release(); } catch { } }
    foreach (var (id, user, token) in targets)
    {
      try
      {
        bool ok = false;
        try
        {
          ok = Atomic.Run(s, () =>
          {
            if (!string.IsNullOrEmpty(token))
            {
              if (RevokedTokens.ContainsKey(token)) return false;
              if (!s.Sessions.TryGetValue(token, out var sess) || sess.ExpiresAt <= System.DateTime.UtcNow) return false;
              var liveUser = sess.Email ?? "";
              if (!string.Equals(liveUser, userKey, System.StringComparison.OrdinalIgnoreCase)) return false;
              if (!CanForUser(s, liveUser, boardId, meetingId, "read")) return false;
              return true;
            }
            else if (!secure)
            {
              if (!CanForUser(s, user, boardId, meetingId, "read")) return false;
              return true;
            }
            return false;
          });
        }
        catch { ok = false; }
        if (!ok) continue;
        await hub.Clients.Client(id).SendAsync(method, payload);
      }
      catch { }
    }
  }
}
