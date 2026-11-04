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
  // Serialize join (auth + group add + registry) against revocation (group removal + abort).
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
  private static void EnforceExpiry()
  {
    try
    {
      var svc = Services;
      if (svc is null) return;
      InMemoryStore store;
      try { store = svc.GetRequiredService<InMemoryStore>(); }
      catch { return; }
      bool secureNow = false;
      try { secureNow = PeopleOps.IsSecure(store); } catch { return; }
      var expired = new System.Collections.Generic.List<string>();
      var anon = new System.Collections.Generic.List<string>();
      foreach (var kv in Conns.ToList())
      {
        var tok = kv.Value.SessionToken;
        if (string.IsNullOrEmpty(tok)) { if (secureNow) anon.Add(kv.Key); continue; }
        try
        {
          if (RevokedTokens.ContainsKey(tok)) { expired.Add(kv.Key); continue; }
          if (!store.Sessions.TryGetValue(tok, out var sess) || sess.ExpiresAt <= System.DateTime.UtcNow) expired.Add(kv.Key);
        }
        catch { }
      }
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
        await HubGate.WaitAsync();
        try
        {
          if (PeopleOps.HasInvalidToken(http.RequestServices.GetRequiredService<InMemoryStore>(), http.Request))
          {
            Context.Abort();
            return;
          }
          if (TryGetSession(http, out var email, out var token))
          {
            Conns[Context.ConnectionId] = new HubConn(Context.ConnectionId, email, token, null, null, DateTime.UtcNow);
            LiveContexts[Context.ConnectionId] = Context;
          }
          else
          {
            var store = http.RequestServices.GetRequiredService<InMemoryStore>();
            if (PeopleOps.IsSecure(store))
            {
              Context.Abort();
              return;
            }
            var anon = "owner";
            try
            {
              if (http.Request.Headers.TryGetValue("X-User", out var xv) && !string.IsNullOrWhiteSpace(xv.ToString()))
                anon = xv.ToString();
            }
            catch { }
            Conns[Context.ConnectionId] = new HubConn(Context.ConnectionId, anon, "", null, null, DateTime.UtcNow);
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
    await HubGate.WaitAsync();
    try
    {
      string user = "";
      if (TryGetSession(http, out var em, out var tok)) user = em;
      else if (!PeopleOps.IsSecure(store))
      {
        user = "owner";
        try { if (http.Request.Headers.TryGetValue("X-User", out var xv) && !string.IsNullOrWhiteSpace(xv.ToString())) user = xv.ToString(); } catch { }
      }
      else { Context.Abort(); throw new HubException("Authentication required."); }
      if (!CanForUser(store, user, bid, null, "read"))
      {
        if (PeopleOps.IsSecure(store)) { Context.Abort(); throw new HubException("Access revoked or not granted for this scope."); }
        throw new HubException("Access revoked or not granted for this scope.");
      }
      if (Conns.TryGetValue(Context.ConnectionId, out var ex))
        Conns[Context.ConnectionId] = ex with { UserKey = user, BoardId = bid };
      LiveContexts[Context.ConnectionId] = Context;
      var grp = $"board:{Canonical(bid)}";
      await Groups.AddToGroupAsync(Context.ConnectionId, grp);
      JoinedGroups.AddOrUpdate(Context.ConnectionId, new System.Collections.Generic.HashSet<string> { grp }, (k, s) => { lock (s) { s.Add(grp); } return s; });
    }
    finally { try { HubGate.Release(); } catch { } }
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
    if (!store.Meetings.TryGetValue(mid, out var mtg0)) throw new HubException("Unknown meeting.");
    var boardId0 = mtg0.BoardId;
    string preUser = "";
    string preTok = "";
    if (TryGetSession(http, out var preEm, out var preTk)) { preUser = preEm; preTok = preTk; }
    else if (!PeopleOps.IsSecure(store))
    {
      preUser = "owner";
      try { if (http.Request.Headers.TryGetValue("X-User", out var xv0) && !string.IsNullOrWhiteSpace(xv0.ToString())) preUser = xv0.ToString(); } catch { }
    }
    else { Context.Abort(); throw new HubException("Authentication required."); }
    if (!string.IsNullOrEmpty(preTok) && RevokedTokens.ContainsKey(preTok)) { Context.Abort(); throw new HubException("Session revoked."); }
    var ensured = PeopleOps.EnsureMeetingMembershipForConnection(store, preUser, preTok, boardId0, mid, explicitJoin: false);
    if (ensured.Error is not null)
    {
      if (PeopleOps.IsSecure(store)) { try { Context.Abort(); } catch { } }
      throw new HubException("Access revoked or not granted for this scope.");
    }
    string pinnedUser = preUser;
string pinnedTok = preTok;
Guid pinnedBoard = boardId0;
Guid pinnedRestore = Guid.Empty;
try { pinnedRestore = store.RestoreEpochId; } catch { }
bool needCentralCleanup = false;
string cleanupId = string.Empty;
await HubGate.WaitAsync();
    try
    {
      string user = "";
      string tok = "";
      if (TryGetSession(http, out var em, out var tk)) { user = em; tok = tk; }
      else if (!PeopleOps.IsSecure(store))
      {
        user = "owner";
        try { if (http.Request.Headers.TryGetValue("X-User", out var xv) && !string.IsNullOrWhiteSpace(xv.ToString())) user = xv.ToString(); } catch { }
      }
      else { Context.Abort(); throw new HubException("Authentication required."); }
      if (!string.IsNullOrEmpty(tok) && RevokedTokens.ContainsKey(tok)) { Context.Abort(); throw new HubException("Session revoked."); }
      if (!CanForUser(store, user, boardId0, mid, "read"))
      {
        if (PeopleOps.IsSecure(store)) { Context.Abort(); throw new HubException("Access revoked or not granted for this scope."); }
        throw new HubException("Access revoked or not granted for this scope.");
      }
      if (Conns.TryGetValue(Context.ConnectionId, out var ex))
        Conns[Context.ConnectionId] = ex with { UserKey = user, SessionToken = tok, BoardId = boardId0, MeetingId = mid };
      else
        Conns[Context.ConnectionId] = new HubConn(Context.ConnectionId, user, tok, boardId0, mid, DateTime.UtcNow);
      LiveContexts[Context.ConnectionId] = Context;
      var grp = $"meeting:{Canonical(mid)}";
      await Groups.AddToGroupAsync(Context.ConnectionId, grp);
      JoinedGroups.AddOrUpdate(Context.ConnectionId, new System.Collections.Generic.HashSet<string> { grp }, (k, s) => { lock (s) { s.Add(grp); } return s; });
            bool stillOk = false;
      try
      {
        stillOk = Atomic.Run(store, () =>
        {
          if (!string.IsNullOrEmpty(tok))
          {
            if (RevokedTokens.ContainsKey(tok)) return false;
            if (!store.Sessions.TryGetValue(tok, out var ss)) return false;
            if (ss.ExpiresAt <= System.DateTime.UtcNow) return false;
            if (!string.Equals(ss.Email, user, StringComparison.OrdinalIgnoreCase)) return false;
            if (!string.Equals(user, pinnedUser, StringComparison.OrdinalIgnoreCase)) return false;
            if (!string.Equals(tok, pinnedTok, StringComparison.Ordinal)) return false;
          }
          if (!store.Meetings.TryGetValue(mid, out var cm)) return false;
          if (cm == null) return false;
          if (cm.BoardId != pinnedBoard) return false;
          if (store.RestoreEpochId != pinnedRestore) return false;
          var mem = (Domain.Membership)null;
foreach (var mm in store.Memberships.Values)
{
if (mm.BoardId != pinnedBoard) continue;
if (mm.MeetingId != mid) continue;
if (!string.Equals(mm.UserKey, user, StringComparison.OrdinalIgnoreCase)) continue;
mem = mm;
}
          if (mem != null)
          {
            if (!mem.Active)
            {
              if (!PeopleOps.HasIndependentAuthority(store, pinnedBoard, user)) return false;
            }
          }
          if (!CanForUser(store, user, pinnedBoard, mid, "read")) return false;
          return true;
        });
      }
      catch { stillOk = false; }

            if (!stillOk)
      {
        bool removedOk = false;
        try { await Groups.RemoveFromGroupAsync(Context.ConnectionId, grp); removedOk = true; } catch { removedOk = false; }
        try
        {
          if (removedOk)
          {
            if (JoinedGroups.TryGetValue(Context.ConnectionId, out var gs0)) { lock (gs0) { gs0.Remove(grp); } }
          }
        }
        catch { }
        needCentralCleanup = true;
        cleanupId = Context.ConnectionId;
        if (PeopleOps.IsSecure(store)) { try { Context.Abort(); } catch { } }
        throw new HubException("Access revoked or not granted for this scope.");
      }
    }
    finally { try { HubGate.Release(); } catch { } }
    if (needCentralCleanup)
    {
      try { if (!string.IsNullOrEmpty(cleanupId)) RemoveConnection(cleanupId, new { revoked = true }); } catch { }
    }

  }

  // Central removal: remove ALL tracked groups first, notify, abort the actual
  // connection, and only then drop registry entries. Abort is the enforcement
  // guarantee even if a group removal fails (retried once).
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

  // Protected delivery: validate EVERY recipient's current principal, live
  // session, and scope at the send boundary. An expired/revoked session or a
  // lost grant suppresses that recipient (and schedules cleanup) instead of
  // relying on the periodic sweep. Abort timers supplement, never replace,
  // this boundary.
  public static async System.Threading.Tasks.Task PublishMeeting(
    Microsoft.AspNetCore.SignalR.IHubContext<BoardHub> hub,
    SimCEO.Api.Data.InMemoryStore s, Guid meetingId, string method, object payload, string need = "read")
  {
    if (!s.Meetings.TryGetValue(meetingId, out var mtg) || mtg is null) return;
    var grp = $"meeting:{Canonical(meetingId)}";
    System.Collections.Generic.List<(string id, string user, string token)> targets;
    bool secure;
    try { secure = SimCEO.Api.PeopleOps.IsSecure(s); }
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
        var ok = false;
        if (!string.IsNullOrEmpty(token))
        {
          if (RevokedTokens.ContainsKey(token)) continue;
          if (!s.Sessions.TryGetValue(token, out var sess) || sess.ExpiresAt <= System.DateTime.UtcNow) continue;
          var liveUser = sess.Email ?? "";
          if (!CanForUser(s, liveUser, mtg.BoardId, meetingId, need)) continue;
          ok = true;
        }
        else if (!secure)
        {
          if (!CanForUser(s, user, mtg.BoardId, meetingId, need)) continue;
          ok = true;
        }
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
    if (!s.Meetings.TryGetValue(meetingId, out var mtg) || mtg is null) return;
    var grp = $"meeting:{Canonical(meetingId)}";
    System.Collections.Generic.List<(string id, string user, string token)> targets;
    bool secure;
    try { secure = SimCEO.Api.PeopleOps.IsSecure(s); }
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
        var ok = false;
        if (!string.IsNullOrEmpty(token))
        {
          if (RevokedTokens.ContainsKey(token)) continue;
          if (!s.Sessions.TryGetValue(token, out var sess) || sess.ExpiresAt <= System.DateTime.UtcNow) continue;
          var liveUser = sess.Email ?? "";
          if (!string.Equals(liveUser, userKey, System.StringComparison.OrdinalIgnoreCase)) continue;
          if (!CanForUser(s, liveUser, mtg.BoardId, meetingId, "read")) continue;
          ok = true;
        }
        else if (!secure)
        {
          if (!CanForUser(s, user, mtg.BoardId, meetingId, "read")) continue;
          ok = true;
        }
        if (!ok) continue;
        await hub.Clients.Client(id).SendAsync(method, payload);
      }
      catch { }
    }
  }
}
