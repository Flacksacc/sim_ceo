using System.Text.Json;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;
using SimCEO.Api.Work;

namespace SimCEO.Api;

public static class PeopleOps
{
  public static string UserOf(InMemoryStore s, HttpRequest req) =>
    AuthOps.ResolveUser(s, req);

  public static bool IsSecure(InMemoryStore s)
  {
    // Security availability: storage failure must throw so callers return 503,
    // never silently downgrade to demo/owner mode.
    bool sec;
    try { sec = s.Security.Values.Any(x => x.AuthRequired); }
    catch (Exception ex) { throw new InvalidOperationException("Security state unavailable.", ex); }
    if (sec) return true;
    try { return s.Accounts.Values.Any(); }
    catch (Exception ex) { throw new InvalidOperationException("Account state unavailable.", ex); }
  }
  public static bool TryIsSecure(InMemoryStore s, out bool secure)
  {
    try { secure = IsSecure(s); return true; }
    catch { secure = false; return false; }
  }
  public static bool IsInstallationAdmin(InMemoryStore s, string email)
  {
    try
    {
      var adm = AdminEmail(s);
      return !string.IsNullOrWhiteSpace(adm) && !string.IsNullOrWhiteSpace(email)
        && string.Equals(adm.Trim(), email.Trim(), StringComparison.OrdinalIgnoreCase);
    }
    catch { throw new InvalidOperationException("Security state unavailable."); }
  }

  public static string AdminEmail(InMemoryStore s)
  {
    try
    {
      var st = s.Security.Values.FirstOrDefault();
      if (st is not null && !string.IsNullOrWhiteSpace(st.AdminEmail)) return st.AdminEmail;
    }
    catch { }
    return "";
  }

  private static int Rank(string a) => a switch
  {
    "open" or "manage" => 30,
    "contribute" => 20,
    "read" => 10,
    "discuss" => 5,
    _ => 0,
  };

  public static string AccessFor(InMemoryStore s, Guid boardId, Guid? meetingId, string user)
  {
    var secure = IsSecure(s);
    var u = (user ?? "").Trim();
    if (secure && (string.Equals(u, "owner", StringComparison.OrdinalIgnoreCase) || string.IsNullOrWhiteSpace(u)))
      return "none";
    Board? board = null;
    try { s.Boards.TryGetValue(boardId, out board); } catch { board = null; }
    if (board is not null && !string.IsNullOrWhiteSpace(board.OwnerKey)
        && string.Equals(board.OwnerKey, u, StringComparison.OrdinalIgnoreCase))
      return "manage";
    var admin = AdminEmail(s);
    if (secure && !string.IsNullOrWhiteSpace(admin)
        && string.Equals(admin, u, StringComparison.OrdinalIgnoreCase))
      return "manage";
    List<Grant> boardGrants;
    try { boardGrants = s.Grants.Values.Where(g => g.BoardId == boardId).ToList(); }
    catch { boardGrants = new List<Grant>(); }
    List<Invite> boardInvites;
    try { boardInvites = s.Invites.Values.Where(i => i.BoardId == boardId).ToList(); }
    catch { boardInvites = new List<Invite>(); }
    if (board is not null && board.AccessEnforced && boardGrants.Count == 0 && boardInvites.Count == 0) return "none";
    if (!secure && boardGrants.Count == 0 && boardInvites.Count == 0) return "open";
    if (board is not null && !board.AccessEnforced && boardGrants.Count == 0 && boardInvites.Count == 0)
      return secure ? "none" : "open";
    IEnumerable<Grant> scoped;
    if (meetingId == null)
      scoped = boardGrants.Where(g => g.MeetingId == null);
    else
      scoped = boardGrants.Where(g => g.MeetingId == null || g.MeetingId == meetingId);
    var best = 0;
    var bestStr = "none";
    foreach (var g in scoped.Where(g => string.Equals(g.UserKey, u, StringComparison.OrdinalIgnoreCase)))
    {
      var r = Rank(g.Access);
      if (r > best) { best = r; bestStr = g.Access; }
    }
    if (meetingId != null && bestStr == "none")
    {
      try
      {
        var mem = s.Memberships.Values.FirstOrDefault(m => m.BoardId == boardId && m.MeetingId == meetingId
          && string.Equals(m.UserKey, u, StringComparison.OrdinalIgnoreCase) && m.Active);
        if (mem is not null)
        {
          var mg = boardGrants.FirstOrDefault(g => g.BoardId == boardId && g.MeetingId == meetingId
            && string.Equals(g.UserKey, u, StringComparison.OrdinalIgnoreCase));
          if (mg is not null) { best = Rank(mg.Access); bestStr = mg.Access; }
        }
      }
      catch { }
    }
    return best >= 30 ? "manage" : best >= 20 ? "contribute" : best >= 10 ? "read" : best >= 5 ? "discuss" : "none";
  }

  public static bool HasInvalidToken(InMemoryStore s, HttpRequest req)
  {
    if (!req.Headers.TryGetValue("Authorization", out var auth)) return false;
    var t = auth.ToString().Trim();
    if (!t.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)) return true;
    return !AuthOps.TrySession(s, req, out _);
  }

  public static IResult? BadToken(InMemoryStore s, HttpRequest req) =>
    HasInvalidToken(s, req) ? Results.Json(new { error = "Invalid or expired session token." }, statusCode: 401) : null;

  public static bool IsOwner(HttpRequest req)
  {
    if (req.Headers.ContainsKey("Authorization")) return false;
    return !req.Headers.TryGetValue("X-User", out var v) || string.IsNullOrWhiteSpace(v.ToString())
      || string.Equals(v.ToString(), "owner", StringComparison.OrdinalIgnoreCase);
  }

  public static IResult? Guard(ModelGateway gw, HttpRequest req)
  {
    try
    {
      gw.ThrowIfCapped(IsOwner(req));
      gw.EnsureAvailable();
      return null;
    }
    catch (CapExceededException ex)
    {
      return Results.Json(new { error = ex.Message }, statusCode: 402);
    }
    catch (ProviderNotConfiguredException ex)
    {
      return Results.Json(new { error = ex.Message }, statusCode: 503);
    }
    catch (SimCEO.Api.Data.PolicyUnavailableException)
    {
      return Results.Json(new { error = "Installation policy store unavailable; try again." }, statusCode: 503);
    }
  }

  public static IResult ProviderError(ProviderException ex) =>
    Results.Json(new { error = ex.Message }, statusCode: 502);

  public static IResult ModelError(Exception ex) => ex switch
  {
    CapExceededException cex => Results.Json(new { error = cex.Message }, statusCode: 402),
    SimCEO.Api.Data.PolicyUnavailableException => Results.Json(new { error = "Installation policy store unavailable; try again." }, statusCode: 503),
    ProviderException pex => ProviderError(pex),
    _ => Results.Json(new { error = ex.Message }, statusCode: 502),
  };

  public static bool Can(InMemoryStore s, HttpRequest req, Guid boardId, Guid? meetingId, string need)
  {
    if (HasInvalidToken(s, req)) return false;
    if (IsSecure(s) && !AuthOps.TrySession(s, req, out _)) return false;
    var have = AccessFor(s, boardId, meetingId, UserOf(s, req));
    if (have == "open") return true;
    return need switch
    {
      "manage" => have == "manage",
      "contribute" => have == "contribute" || have == "manage",
      "read" => have == "read" || have == "contribute" || have == "manage"
        || (have == "discuss" && meetingId != null),
      "discuss" => have == "discuss" || have == "contribute" || have == "manage",
      _ => false,
    };
  }

  public static IResult? Check(InMemoryStore s, HttpRequest req, Guid boardId, Guid? meetingId, string need)
  {
    if (HasInvalidToken(s, req))
      return Results.Json(new { error = "Invalid or expired session token." }, statusCode: 401);
    if (IsSecure(s) && !AuthOps.TrySession(s, req, out _))
      return Results.Json(new { error = "Authentication required." }, statusCode: 401);
    if (!Can(s, req, boardId, meetingId, need))
      return Denied();
    return null;
  }

  public static Exception AuthFault(InMemoryStore s, HttpRequest req)
  {
    try { if (IsSecure(s) && !AuthOps.TrySession(s, req, out _)) return new UnauthorizedAccessException("revoked"); }
    catch (InvalidOperationException) { return new InvalidOperationException("security-unavailable"); }
    return new UnauthorizedAccessException("denied");
  }

  public static IResult Denied() =>
    Results.Json(new { error = "Access revoked or not granted for this scope." }, statusCode: 403);

  public static bool HasMeetingGrant(InMemoryStore s, string user, Guid boardId, Guid meetingId)
  {
    try
    {
      return s.Grants.Values.Any(g => g.BoardId == boardId && g.MeetingId == meetingId
        && string.Equals(g.UserKey, user, StringComparison.OrdinalIgnoreCase));
    }
    catch { return false; }
  }

  public static List<Guid> GuestMeetingIds(InMemoryStore s, string user, Guid boardId)
  {
    try
    {
      return s.Grants.Values.Where(g => g.BoardId == boardId && g.MeetingId != null
        && string.Equals(g.UserKey, user, StringComparison.OrdinalIgnoreCase))
        .Select(g => g.MeetingId!.Value).Distinct()
        .Where(mid => s.Meetings.TryGetValue(mid, out var mt) && mt is not null && mt.BoardId == boardId)
        .ToList();
    }
    catch { return new List<Guid>(); }
  }

  public static void MarkEnforced(InMemoryStore s, Guid boardId)
  {
    try
    {
      if (s.Boards.TryGetValue(boardId, out var b) && !b.AccessEnforced)
      {
        b.AccessEnforced = true;
        s.Boards[boardId] = b;
        s.Boards.Flush();
      }
    }
    catch { }
  }

  public static void BumpMeeting(InMemoryStore s, Guid meetingId)
  {
    // Post-commit effect: inside a store-bound unit the generation bump applies
    // only after the outermost commit (never a phantom bump on rollback);
    // outside any unit it runs immediately as before.
    Atomic.DeferOrRun(s, () =>
    {
      try
      {
        lock (s.RootGate)
        {
          if (s.Meetings.TryGetValue(meetingId, out var m))
          {
            m.Generation++;
            s.Meetings.Flush();
          }
        }
      }
      catch { }
    });
  }

  public static bool WasExplicitlyLeft(InMemoryStore s, Guid boardId, Guid meetingId, string user) { try { var m = s.Memberships.Values.FirstOrDefault(x => x.BoardId == boardId && x.MeetingId == meetingId && string.Equals(x.UserKey, user, StringComparison.OrdinalIgnoreCase)); return m is not null && !m.Active; } catch { return false; } }
  public static bool HasIndependentAuthority(InMemoryStore s, Guid boardId, string user)
  {
    try
    {
      var u = (user ?? "").Trim();
      if (string.IsNullOrWhiteSpace(u)) return false;
      if (s.Boards.TryGetValue(boardId, out var bb) && bb != null && !string.IsNullOrWhiteSpace(bb.OwnerKey) && string.Equals(bb.OwnerKey, u, StringComparison.OrdinalIgnoreCase)) return true;
      var adm = AdminEmail(s);
      if (!string.IsNullOrWhiteSpace(adm) && string.Equals(adm, u, StringComparison.OrdinalIgnoreCase)) return true;
      try { return s.Grants.Values.Any(g => g.BoardId == boardId && g.MeetingId == null && string.Equals(g.UserKey, u, StringComparison.OrdinalIgnoreCase)); } catch { return false; }
    } catch { return false; }
  }
  public static void RevokeLive(string userKey, Guid? boardId = null, Guid? meetingId = null)
  {
    try { SimCEO.Api.Hubs.BoardHub.RevokeUser(userKey, boardId, meetingId); } catch { }
  }
  public sealed record MembershipEnsureResult(SimCEO.Api.Domain.Membership? Membership, IResult? Error);
  public static MembershipEnsureResult EnsureMeetingMembership(InMemoryStore s, HttpRequest req, Guid boardId, Guid meetingId, bool explicitJoin)
  {
    SimCEO.Api.Domain.Membership? result = null;
    IResult? error = null;
    try
    {
      Atomic.Run(s, () =>
      {
        if (HasInvalidToken(s, req)) throw new UnauthorizedAccessException("revoked-token");
        string currentUser;
        if (IsSecure(s))
        {
          if (!AuthOps.TrySession(s, req, out var sessUser) || string.IsNullOrWhiteSpace(sessUser))
            throw new UnauthorizedAccessException("revoked");
          currentUser = sessUser;
        }
        else
        {
          currentUser = AuthOps.TrySession(s, req, out var eu) ? eu : UserOf(s, req);
        }
        if (!s.Meetings.TryGetValue(meetingId, out var mtg) || mtg == null || mtg.BoardId != boardId)
          throw new InvalidOperationException("meeting-gone");
        Guid restoreBefore = s.RestoreEpochId;
        var access = AccessFor(s, boardId, meetingId, currentUser);
        if (access == "none" || (access == "open" && IsSecure(s)))
          throw new UnauthorizedAccessException("denied");
        if (s.RestoreEpochId != restoreBefore)
          throw new InvalidOperationException("restored");
        if (!s.Meetings.TryGetValue(meetingId, out var mtg2) || mtg2 == null || mtg2.BoardId != boardId)
          throw new InvalidOperationException("meeting-gone");
        var existing = s.Memberships.Values.FirstOrDefault(m => m.BoardId == boardId && m.MeetingId == meetingId
          && string.Equals(m.UserKey, currentUser, StringComparison.OrdinalIgnoreCase));
        if (existing != null && existing.Active)
        {
          result = existing;
          return;
        }
        if (existing != null && !existing.Active)
        {
          if (!explicitJoin) { if (HasIndependentAuthority(s, boardId, currentUser)) { result = existing; return; } throw new UnauthorizedAccessException("denied"); }
          existing.Active = true;
          existing.LeftAt = null;
          existing.JoinedAt = DateTime.UtcNow;
          s.Memberships[existing.Id] = existing;
          result = existing;
          return;
        }
        var nm = new SimCEO.Api.Domain.Membership
        {
          BoardId = boardId,
          MeetingId = meetingId,
          UserKey = currentUser,
          Active = true,
          JoinedAt = DateTime.UtcNow,
        };
        s.Memberships[nm.Id] = nm;
        result = nm;
      });
    }
    catch (UnauthorizedAccessException uae) when (uae.Message == "revoked-token")
    {
      error = Results.Json(new { error = "Invalid or expired session token." }, statusCode: 401);
    }
    catch (UnauthorizedAccessException uae) when (uae.Message == "revoked")
    {
      error = Results.Json(new { error = "Authentication required." }, statusCode: 401);
    }
    catch (UnauthorizedAccessException)
    {
      error = Denied();
    }
    catch (InvalidOperationException iox) when (iox.Message == "meeting-gone")
    {
      error = Results.NotFound("meeting");
    }
    catch (InvalidOperationException iox) when (iox.Message == "restored")
    {
      error = Results.Conflict("Domain was restored during join; retry.");
    }
    catch (Exception ex)
    {
      error = Results.Json(new { error = "Join could not be stored: " + ex.Message }, statusCode: 500);
    }
    return new MembershipEnsureResult(result, error);
  }
  public static MembershipEnsureResult EnsureMeetingMembershipForConnection(InMemoryStore s, string user, string token, Guid boardId, Guid meetingId, bool explicitJoin)
  {
    SimCEO.Api.Domain.Membership? result = null;
    IResult? error = null;
    try
    {
      Atomic.Run(s, () =>
      {
        string currentUser = (user ?? "").Trim();
        if (IsSecure(s))
        {
          if (string.IsNullOrWhiteSpace(currentUser) || string.Equals(currentUser, "owner", StringComparison.OrdinalIgnoreCase))
            throw new UnauthorizedAccessException("revoked");
          if (SimCEO.Api.Hubs.BoardHub.IsTokenRevoked(token))
            throw new UnauthorizedAccessException("revoked");
          bool sessOk = false;
          string sessEmail = "";
          try
          {
            if (!string.IsNullOrEmpty(token) && s.Sessions.TryGetValue(token, out var sess) && sess.ExpiresAt > DateTime.UtcNow)
            {
              sessOk = true;
              sessEmail = sess.Email ?? "";
            }
          }
          catch { sessOk = false; }
          if (!sessOk) throw new UnauthorizedAccessException("revoked");
          if (!string.Equals(sessEmail, currentUser, StringComparison.OrdinalIgnoreCase))
            throw new UnauthorizedAccessException("revoked");
          currentUser = sessEmail;
        }
        else if (string.IsNullOrWhiteSpace(currentUser))
        {
          currentUser = "owner";
        }
        if (!s.Meetings.TryGetValue(meetingId, out var mtg) || mtg == null || mtg.BoardId != boardId)
          throw new InvalidOperationException("meeting-gone");
        Guid restoreBefore = s.RestoreEpochId;
        var access = AccessFor(s, boardId, meetingId, currentUser);
        if (access == "none" || (access == "open" && IsSecure(s)))
          throw new UnauthorizedAccessException("denied");
        if (s.RestoreEpochId != restoreBefore)
          throw new InvalidOperationException("restored");
        if (!s.Meetings.TryGetValue(meetingId, out var mtg2) || mtg2 == null || mtg2.BoardId != boardId)
          throw new InvalidOperationException("meeting-gone");
        var existing = s.Memberships.Values.FirstOrDefault(m => m.BoardId == boardId && m.MeetingId == meetingId
          && string.Equals(m.UserKey, currentUser, StringComparison.OrdinalIgnoreCase));
        if (existing != null && existing.Active)
        {
          result = existing;
          return;
        }
        if (existing != null && !existing.Active)
        {
          if (!explicitJoin) { if (HasIndependentAuthority(s, boardId, currentUser)) { result = existing; return; } throw new UnauthorizedAccessException("denied"); }
          existing.Active = true;
          existing.LeftAt = null;
          existing.JoinedAt = DateTime.UtcNow;
          s.Memberships[existing.Id] = existing;
          result = existing;
          return;
        }
        var nm = new SimCEO.Api.Domain.Membership
        {
          BoardId = boardId,
          MeetingId = meetingId,
          UserKey = currentUser,
          Active = true,
          JoinedAt = DateTime.UtcNow,
        };
        s.Memberships[nm.Id] = nm;
        result = nm;
      });
    }
    catch (UnauthorizedAccessException uae) when (uae.Message == "revoked")
    {
      error = Results.Json(new { error = "Authentication required." }, statusCode: 401);
    }
    catch (UnauthorizedAccessException)
    {
      error = Denied();
    }
    catch (InvalidOperationException iox) when (iox.Message == "meeting-gone")
    {
      error = Results.NotFound("meeting");
    }
    catch (InvalidOperationException iox) when (iox.Message == "restored")
    {
      error = Results.Conflict("Domain was restored during join; retry.");
    }
    catch (Exception ex)
    {
      error = Results.Json(new { error = "Join could not be stored: " + ex.Message }, statusCode: 500);
    }
    return new MembershipEnsureResult(result, error);
  }
}

public static class SecurityOps
{
  public static void EnsureMigrated(InMemoryStore s)
  {
      bool hasAccounts;
      try { hasAccounts = s.Accounts.Values.Any(); } catch (Exception ex) { throw new InvalidOperationException("Account state unavailable.", ex); }
      Domain.SecurityState? state;
      try { state = s.Security.Values.FirstOrDefault(); } catch (Exception ex) { throw new InvalidOperationException("Security state unavailable.", ex); }
      if (state is not null && state.AuthRequired && state.MigrationDone) return;
      if (!hasAccounts) return;
      lock (s.SetupLock)
      {
        string adminEmail = "";
        bool didMigrate = false;
        var narrowed = 0; var reviewed = 0;
        var bumpAfter = new System.Collections.Generic.HashSet<System.Guid>();
        var wizAdopted = 0;
        Atomic.Run(s, () =>
        {
        try { state = s.Security.Values.FirstOrDefault(); } catch (Exception ex) { throw new InvalidOperationException("Security state unavailable.", ex); }
        if (state is not null && state.AuthRequired && state.MigrationDone) return;
        bool anyAccounts = false;
        try { anyAccounts = s.Accounts.Values.Any(); } catch (Exception ex) { throw new InvalidOperationException("Account state unavailable.", ex); }
        if (!anyAccounts) return;
        var oldest = s.Accounts.Values.OrderBy(a => a.CreatedAt).First();
        adminEmail = (oldest.Email ?? "").Trim().ToLowerInvariant();
        state ??= new SecurityState { Id = Guid.Empty };
        state.AuthRequired = true;
        state.AdminEmail = adminEmail;
        state.AdminAccountId = oldest.Id;
        state.UpdatedAt = DateTime.UtcNow;
        if (state.Id == Guid.Empty) state.Id = Guid.NewGuid();
        s.Security[state.Id] = state;
        s.Security.Flush();
        foreach (var b in s.Boards.Values.Where(b => string.IsNullOrWhiteSpace(b.OwnerKey) || string.Equals(b.OwnerKey, "owner", System.StringComparison.OrdinalIgnoreCase)).ToList())
        {
          b.OwnerKey = adminEmail;
          if (s.Grants.Values.Any(g => g.BoardId == b.Id) || s.Invites.Values.Any(i => i.BoardId == b.Id))
            b.AccessEnforced = true;
          s.Boards[b.Id] = b;
        }
        s.Boards.Flush();
        foreach (var r in s.Roster.Values.Where(r => string.IsNullOrWhiteSpace(r.OwnerKey) || string.Equals(r.OwnerKey, "owner", System.StringComparison.OrdinalIgnoreCase)).ToList())
        {
          r.OwnerKey = adminEmail;
          s.Roster[r.Id] = r;
        }
        s.Roster.Flush();
        foreach (var wdz in s.WizardDrafts.Values.Where(x => string.IsNullOrWhiteSpace(x.OwnerKey)).ToList())
        {
          wdz.OwnerKey = adminEmail;
          s.WizardDrafts[wdz.Id] = wdz;
          wizAdopted++;
        }
        s.WizardDrafts.Flush();
        foreach (var inv in s.Invites.Values.Where(i => i.State == "accepted" && i.MeetingId != null).ToList())
        {
          // Only live-bound accepts (UserKey stamped by the accept flow in
          // this store) may reconstruct access. Predecessor/unknown-provenance
          // accepts without a bound identity are owner-review items, never
          // automatic grants or memberships.
          if (string.IsNullOrWhiteSpace(inv.UserKey)) { reviewed++; continue; }
          var user = inv.UserKey;
          // Non-destructive: validate current parent; respect explicit leave/revocation.
          if (!s.Meetings.TryGetValue(inv.MeetingId.Value, out var __pm) || __pm.BoardId != inv.BoardId) { reviewed++; continue; }
          var __mem = s.Memberships.Values.FirstOrDefault(mm => mm.BoardId == inv.BoardId && mm.MeetingId == inv.MeetingId.Value
            && string.Equals(mm.UserKey, user, StringComparison.OrdinalIgnoreCase));
          if (__mem is not null && !__mem.Active) continue; // left/revoked: never resurrect
          if (PeopleOps.WasExplicitlyLeft(s, inv.BoardId, inv.MeetingId.Value, user)) continue;
          var hasScoped = s.Grants.Values.Any(g => g.BoardId == inv.BoardId && g.MeetingId == inv.MeetingId
            && string.Equals(g.UserKey, user, StringComparison.OrdinalIgnoreCase));
          // NEVER reconstruct access from accepted history alone (predecessor
          // accepted-but-revoked rows carry nonblank UserKey yet no live grant).
          // The live accept flow binds grants/memberships at accept time; any
          // accepted invite without current rights is owner-review material,
          // surfaced via repair-access, never auto-resurrected here.
          if (!hasScoped) { reviewed++; continue; }
          // Independent board-wide grants are NEVER deleted here; explicit narrowing is a separate admin action.
          var hasBoardWide = s.Grants.Values.Any(g => g.BoardId == inv.BoardId && g.MeetingId == null
            && string.Equals(g.UserKey, user, StringComparison.OrdinalIgnoreCase));
          if (hasBoardWide) reviewed++;
          PeopleOps.MarkEnforced(s, inv.BoardId);
          try { if (inv.MeetingId.HasValue) bumpAfter.Add(inv.MeetingId.Value); } catch { }
        }
        s.Grants.Flush();
        try { s.Memberships.Flush(); } catch { }
        try { var __st = s.Security.Values.FirstOrDefault(); if (__st is not null) { __st.MigrationDone = true; s.Security[__st.Id] = __st; s.Security.Flush(); } } catch (Exception ex) { throw new InvalidOperationException("Migration commit failed.", ex); }
        didMigrate = true;
        }); // end Atomic: account/admin/security/ownership commit together
        // Generation bumps and the migration audit are post-COMMIT effects: inside
        // a store-bound unit they defer to outermost success (never phantom on
        // rollback); outside any unit they run immediately (legacy behavior).
        var __bumpCopy = bumpAfter.ToList();
        var __didMig = didMigrate;
        var __adm = adminEmail; var __nar = narrowed; var __rev = reviewed;
        Atomic.DeferOrRun(s, () =>
        {
          foreach (var __bm in __bumpCopy) { try { PeopleOps.BumpMeeting(s, __bm); } catch { } }
          if (__didMig) Atomic.Audit(s, new AuditEvent { Action = "security.migrate", Detail = JsonSerializer.Serialize(new { admin = __adm, scopedAdded = __nar, needsReview = __rev }) });
        });
      }
  }

  public static (SecurityState state, bool first) EnsureFirstAdmin(InMemoryStore s, string email, Guid accountId)
  {
    lock (s.SetupLock)
    {
      var existing = s.Security.Values.FirstOrDefault();
      if (existing is not null && existing.AuthRequired) return (existing, false);
      if (s.Accounts.Values.Count > 1) { EnsureMigrated(s); existing = s.Security.Values.FirstOrDefault(); return (existing!, false); }
      var st = existing ?? new SecurityState { Id = Guid.NewGuid() };
      Atomic.Run(s, () =>
      {
        st.AuthRequired = true;
        st.AdminEmail = email;
        st.AdminAccountId = accountId;
        st.UpdatedAt = DateTime.UtcNow;
        s.Security[st.Id] = st;
        s.Security.Flush();
        foreach (var b in s.Boards.Values.Where(b => string.IsNullOrWhiteSpace(b.OwnerKey) || string.Equals(b.OwnerKey, "owner", System.StringComparison.OrdinalIgnoreCase)).ToList())
        {
          b.OwnerKey = email;
          if (s.Grants.Values.Any(g => g.BoardId == b.Id) || s.Invites.Values.Any(i => i.BoardId == b.Id))
            b.AccessEnforced = true;
          s.Boards[b.Id] = b;
        }
        s.Boards.Flush();
        foreach (var r in s.Roster.Values.Where(r => string.IsNullOrWhiteSpace(r.OwnerKey) || string.Equals(r.OwnerKey, "owner", System.StringComparison.OrdinalIgnoreCase)).ToList())
        {
          r.OwnerKey = email;
          s.Roster[r.Id] = r;
        }
        s.Roster.Flush();
      });
      Atomic.Audit(s, new AuditEvent { Action = "security.first-admin", Detail = JsonSerializer.Serialize(new { admin = email }) });
      return (st, true);
    }
  }
}

public static class PeopleEndpoints
{
  private static string AccessForRole(string role) => role switch
  {
    "manager" => "manage",
    "viewer" => "read",
    "guest" or "discuss" => "discuss",
    _ => "contribute",
  };

  private static object CapabilityView(InMemoryStore s, HttpRequest req, Guid bid, Guid? meetingId)
  {
    var user = PeopleOps.UserOf(s, req);
    // Raw scope access first; "open" demo boards grant full local capability,
    // secure boards require a session (enforced by Can/Check callers).
    var rawBoard = PeopleOps.AccessFor(s, bid, null, user);
    var board = rawBoard == "open" ? "manage" : rawBoard;
    string? meeting = null;
    if (meetingId.HasValue)
    {
      var rawMeeting = PeopleOps.AccessFor(s, bid, meetingId, user);
      meeting = rawMeeting == "open" ? "manage" : rawMeeting;
    }
    var allowed = PeopleOps.GuestMeetingIds(s, user, bid);
    var guest = !PeopleOps.Can(s, req, bid, null, "read") && allowed.Count > 0;
    bool admin = false;
    try { admin = PeopleOps.IsInstallationAdmin(s, user); } catch { }
    return new { board, meeting, meetings = allowed, guest, admin };
  }

  public static void MapPeople(this WebApplication app)
  {
    // Server-derived selected-scope capabilities: the UI gates EVERY tab and
    // action on these values, never on a board-DTO heuristic. Board access is
    // board-wide; meeting access is the effective scope for the selected
    // meeting (board-wide grants satisfy meeting scope by AccessFor).
    app.MapGet("/api/boards/{bid:guid}/capabilities", (InMemoryStore s, HttpRequest req, Guid bid, Guid? meetingId) =>
    {
      if (!s.Boards.ContainsKey(bid)) return Results.NotFound("board");
      if (PeopleOps.BadToken(s, req) is { } badCap) return badCap;
      if (PeopleOps.IsSecure(s) && !AuthOps.TrySession(s, req, out _))
        return Results.Json(new { error = "Authentication required." }, statusCode: 401);
      var user = PeopleOps.UserOf(s, req);
      if (!PeopleOps.Can(s, req, bid, null, "read") && PeopleOps.GuestMeetingIds(s, user, bid).Count == 0)
        return PeopleOps.Denied();
      if (meetingId.HasValue && (!s.Meetings.TryGetValue(meetingId.Value, out var cm) || cm.BoardId != bid))
        return Results.NotFound("meeting");
      return Results.Ok(CapabilityView(s, req, bid, meetingId));
    });

    // Effective (activated) board settings for guests and owners alike.
    // Activated blanks are preserved verbatim and never fall back to draft
    // text; dataUse/policy come from the activated snapshot when present.
    // Guests receive board-owned lead identity only (no global fallback) and
    // only their own meeting ids; board readers see all meeting ids.
    app.MapGet("/api/boards/{bid:guid}/guest-settings", (InMemoryStore s, HttpRequest req, Guid bid) =>
    {
      if (!s.Boards.TryGetValue(bid, out var b)) return Results.NotFound("board");
      if (PeopleOps.BadToken(s, req) is { } badGs) return badGs;
      if (PeopleOps.IsSecure(s) && !AuthOps.TrySession(s, req, out _))
        return Results.Json(new { error = "Authentication required." }, statusCode: 401);
      var user = PeopleOps.UserOf(s, req);
      var allowed = PeopleOps.GuestMeetingIds(s, user, bid);
      var reader = PeopleOps.Can(s, req, bid, null, "read");
      if (!reader && allowed.Count == 0) return PeopleOps.Denied();
      var eff = LeadSetup.EffectiveView(s, b);
      var leadOwned = LeadSetup.ResolveLeadForStrict(s, bid);
      var meetingIds = reader
        ? s.Meetings.Values.Where(m => m.BoardId == bid).Select(m => m.Id).ToList()
        : allowed;
      return Results.Ok(new
      {
        id = b.Id,
        name = eff.name,
        mission = eff.mission,
        stage = eff.stage,
        discussionPolicy = eff.policy,
        dataUse = eff.dataUse,
        lead = leadOwned is null ? null : new { name = leadOwned.Name, roleLabel = leadOwned.RoleLabel },
        meetingIds,
      });
    });

    app.MapGet("/api/boards/{bid:guid}/invites", (InMemoryStore s, HttpRequest req, Guid bid) =>
      PeopleOps.Check(s, req, bid, null, "manage") ?? Results.Ok(s.Invites.Values.Where(i => i.BoardId == bid).OrderByDescending(i => i.CreatedAt)));

    app.MapPost("/api/boards/{bid:guid}/invites", (InMemoryStore s, HttpRequest req, Guid bid, Invite input) =>
    {
      if (PeopleOps.Check(s, req, bid, null, "manage") is { } denied) return denied;
      if (string.IsNullOrWhiteSpace(input.Email)) return Results.BadRequest("Email is required.");
      try { if (input.MeetingId.HasValue && !PeopleOps.IsSecure(s)) return Results.Json(new { error = "Registration required: guest collaboration needs a secure account. Register to continue." }, statusCode: 403); } catch (InvalidOperationException) { return Results.Json(new { error = "Security state unavailable." }, statusCode: 503); }
      if (input.MeetingId.HasValue)
      {
        if (!s.Meetings.TryGetValue(input.MeetingId.Value, out var mm) || mm.BoardId != bid)
          return Results.NotFound("meeting");
      }
      var role = (input.Role ?? "").Trim().ToLowerInvariant();
      if (string.IsNullOrWhiteSpace(role)) role = input.MeetingId.HasValue ? "guest" : "contributor";
      if (role is not ("manager" or "viewer" or "contributor" or "guest" or "discuss"))
        return Results.BadRequest("role must be manager, viewer, contributor, or guest.");
      // ONE critical section: validate, recheck CURRENT authority, and insert atomically.
      lock (s.SetupLock)
      {
        if (PeopleOps.Check(s, req, bid, null, "manage") is { } deniedInner2) return deniedInner2;
        if (input.MeetingId.HasValue)
        {
          if (!s.Meetings.TryGetValue(input.MeetingId.Value, out var mm2) || mm2.BoardId != bid)
            return Results.NotFound("meeting");
        }
        input.Id = Guid.NewGuid();
        input.BoardId = bid;
        input.Role = role == "discuss" ? "guest" : role;
        input.State = "pending";
        input.CreatedAt = DateTime.UtcNow;
        try
        {
          Atomic.Run(s, () =>
          {
            if (PeopleOps.Check(s, req, bid, null, "manage") is { } deniedAtomic) throw new UnauthorizedAccessException("Access revoked or not granted for this scope.");
            s.Invites[input.Id] = input;
          });
        }
        catch (UnauthorizedAccessException) { return PeopleOps.Denied(); }
        catch (Exception ex) { return Results.Json(new { error = "Invite could not be stored: " + ex.Message }, statusCode: 500); }
        PeopleOps.MarkEnforced(s, bid);
        Atomic.Audit(s, new AuditEvent { BoardId = bid, Action = "invite.create", Detail = JsonSerializer.Serialize(new { input.Email, input.Role, input.MeetingId }) });
        return Results.Created($"/api/invites/{input.Id}", input);
      }
    });

    app.MapGet("/api/invites/{id:guid}/public", (InMemoryStore s, Guid id) =>
    {
      if (!s.Invites.TryGetValue(id, out var inv)) return Results.NotFound();
      string boardName = "";
      string meetingTitle = "";
      try { if (s.Boards.TryGetValue(inv.BoardId, out var b)) boardName = b.Name; } catch { }
      try { if (inv.MeetingId.HasValue && s.Meetings.TryGetValue(inv.MeetingId.Value, out var m)) meetingTitle = m.Title; } catch { }
      return Results.Ok(new { id = inv.Id, boardId = inv.BoardId, meetingId = inv.MeetingId, state = inv.State, boardName, meetingTitle });
    });

    app.MapPost("/api/invites/{id:guid}/accept", (InMemoryStore s, HttpRequest req, Guid id, JsonElement body) =>
    {
      if (PeopleOps.BadToken(s, req) is { } bad) return bad;
      string sessEmail = "";
      if (PeopleOps.IsSecure(s))
      {
        if (!AuthOps.TrySession(s, req, out var se)) return Results.Json(new { error = "Authentication required." }, statusCode: 401);
        sessEmail = se;
      }
      if (!s.Invites.TryGetValue(id, out var inv) || inv.State != "pending")
        return Results.Conflict("Invite is not pending.");
      var sessionUser = PeopleOps.IsSecure(s) ? sessEmail : (AuthOps.TrySession(s, req, out var e2) ? e2 : PeopleOps.UserOf(s, req));
      string? claimed = null;
      if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("userKey", out var u) && u.ValueKind == JsonValueKind.String)
        claimed = (u.GetString() ?? "").Trim();
      if (PeopleOps.IsSecure(s) && !string.IsNullOrWhiteSpace(claimed)
          && !string.Equals(claimed, sessionUser, StringComparison.OrdinalIgnoreCase))
        return Results.Json(new { error = "Invite acceptance binds the signed-in identity; caller userKey mismatch." }, statusCode: 403);
      var user = sessionUser;
      if (string.IsNullOrWhiteSpace(user)) user = (!string.IsNullOrWhiteSpace(claimed) ? claimed : inv.Email);
      if (string.IsNullOrWhiteSpace(user)) return Results.BadRequest("No identity to bind.");
      if (inv.MeetingId.HasValue)
      {
        if (!s.Meetings.TryGetValue(inv.MeetingId.Value, out var mm) || mm.BoardId != inv.BoardId)
          return Results.Conflict("Invite meeting is missing or belongs to another board.");
      }
      else if (string.Equals(inv.Role, "guest", StringComparison.OrdinalIgnoreCase))
        return Results.Conflict("Guest invite requires a meeting.");
      lock (s.SetupLock)
      {
        if (!s.Invites.TryGetValue(id, out inv) || inv.State != "pending")
          return Results.Conflict("Invite is not pending.");
        // No tracked mutation before the durable unit: the accept flip, grant and
        // membership writes commit together inside ONE Atomic unit. Storage failure
        // rolls back and returns 500; never partial state or false success.
        Grant? acceptedGrant = null;
        var acceptBid = inv.BoardId; var acceptMid = inv.MeetingId;
        try
        {
          Atomic.Run(s, () =>
          {
            if (!s.Invites.TryGetValue(id, out var curA) || curA.State != "pending")
              throw new InvalidOperationException("Invite is not pending.");
            // Re-resolve the CURRENT session identity inside the durable unit:
            // a logout or revocation between the preliminary checks and commit
            // must fail closed, never bind a stale identity.
            string inUser;
            if (PeopleOps.IsSecure(s))
            {
              if (!AuthOps.TrySession(s, req, out var inSess))
                throw new UnauthorizedAccessException("Session ended before commit.");
              inUser = inSess;
              if (!string.Equals(inUser, user, StringComparison.OrdinalIgnoreCase))
                throw new UnauthorizedAccessException("Identity changed before commit.");
            }
            else inUser = AuthOps.TrySession(s, req, out var eIn) ? eIn : PeopleOps.UserOf(s, req);
            if (string.IsNullOrWhiteSpace(inUser)) throw new InvalidOperationException("No identity to bind.");
            user = inUser;
            curA.State = "accepted";
            curA.UserKey = user;
            s.Invites[id] = curA;
            foreach (var old in s.Grants.Values.Where(g => g.BoardId == curA.BoardId
              && g.MeetingId == curA.MeetingId
              && string.Equals(g.UserKey, user, StringComparison.OrdinalIgnoreCase)).ToList())
              s.Grants.TryRemove(old.Id, out _);
            var ng = new Grant
            {
              BoardId = curA.BoardId, MeetingId = curA.MeetingId, UserKey = user,
              Access = AccessForRole(curA.Role), CreatedAt = DateTime.UtcNow,
            };
            s.Grants[ng.Id] = ng;
            if (curA.MeetingId.HasValue)
            {
              var exA = s.Memberships.Values.FirstOrDefault(m => m.BoardId == curA.BoardId && m.MeetingId == curA.MeetingId.Value
                && string.Equals(m.UserKey, user, StringComparison.OrdinalIgnoreCase));
              if (exA is null)
              {
                var nm = new Membership { BoardId = curA.BoardId, MeetingId = curA.MeetingId.Value, UserKey = user, Active = true, JoinedAt = DateTime.UtcNow };
                s.Memberships[nm.Id] = nm;
              }
              else if (!exA.Active) { exA.Active = true; exA.LeftAt = null; exA.JoinedAt = DateTime.UtcNow; s.Memberships[exA.Id] = exA; }
            }
            PeopleOps.MarkEnforced(s, curA.BoardId);
            acceptedGrant = ng;
          });
        }
        catch (InvalidOperationException iox) when (iox.Message == "Invite is not pending.") { return Results.Conflict(iox.Message); }
          catch (UnauthorizedAccessException) { return Results.Json(new { error = "Access revoked or not granted for this scope." }, statusCode: 403); }
        catch (Exception ex) { return Results.Json(new { error = "Invite acceptance could not be stored: " + ex.Message }, statusCode: 500); }
        try { if (acceptMid.HasValue) PeopleOps.BumpMeeting(s, acceptMid.Value); } catch { }
        Atomic.Audit(s, new AuditEvent { BoardId = acceptBid, Action = "invite.accept", Detail = JsonSerializer.Serialize(new { user, meeting = acceptMid }) });
        return Results.Ok(new { grant = acceptedGrant, meetingId = acceptMid, user });
      }
    });

    app.MapPost("/api/invites/{id:guid}/revoke", (InMemoryStore s, HttpRequest req, Guid id, string? scope) =>
    {
      if (!s.Invites.TryGetValue(id, out var inv)) return Results.NotFound();
      var boardWide = string.Equals(scope, "board", StringComparison.OrdinalIgnoreCase);
      if (boardWide)
      {
        if (PeopleOps.Check(s, req, inv.BoardId, null, "manage") is { } deniedB) return deniedB;
        if (!s.Boards.TryGetValue(inv.BoardId, out var __bo) || (!string.Equals(__bo.OwnerKey, PeopleOps.UserOf(s, req), StringComparison.OrdinalIgnoreCase) && !PeopleOps.IsInstallationAdmin(s, PeopleOps.UserOf(s, req)))) return PeopleOps.Denied();
      }
      else if (PeopleOps.Check(s, req, inv.BoardId, inv.MeetingId, "manage") is { } denied) return denied;
      lock (s.SetupLock)
      {
        // Recheck CURRENT authority inside the mutation lock (TOCTOU).
        if (boardWide)
        {
          if (PeopleOps.Check(s, req, inv.BoardId, null, "manage") is { } deniedB2) return deniedB2;
        }
        else if (PeopleOps.Check(s, req, inv.BoardId, inv.MeetingId, "manage") is { } denied2) return denied2;
        if (!s.Invites.TryGetValue(id, out inv)) return Results.NotFound();
        // Identity-bound: the accepted UserKey is authoritative; email alone is not.
        var target = !string.IsNullOrWhiteSpace(inv.UserKey) ? inv.UserKey : inv.Email;
        if (string.IsNullOrWhiteSpace(target)) return Results.BadRequest("Invite has no bound identity.");
        // NOTE: do NOT mutate the tracked invite here; the state flip happens exactly once
        // inside the Atomic unit below (pre-Atomic tracked mutation would poison the in-gate check).
        var removedUsers = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        try
        {
          Atomic.Run(s, () =>
          {
            // Recheck once more inside the durable unit.
            if (boardWide)
            {
              if (PeopleOps.Check(s, req, inv.BoardId, null, "manage") is not null) throw new UnauthorizedAccessException("Access revoked or not granted for this scope.");
            }
            else if (PeopleOps.Check(s, req, inv.BoardId, inv.MeetingId, "manage") is not null) throw new UnauthorizedAccessException("Access revoked or not granted for this scope.");
            if (!s.Invites.TryGetValue(id, out var cur) || (cur.State != "pending" && cur.State != "accepted")) throw new InvalidOperationException("Invite is not active.");
            cur.State = "revoked";
            s.Invites[id] = cur;
            // Default scope: EXACT meeting (or board-only when invite has no meeting).
            foreach (var g in s.Grants.Values.Where(g => g.BoardId == inv.BoardId
              && (boardWide || g.MeetingId == inv.MeetingId)
              && string.Equals(g.UserKey, target, StringComparison.OrdinalIgnoreCase)).ToList())
            {
              removedUsers.Add(g.UserKey);
              s.Grants.TryRemove(g.Id, out _);
            }
            foreach (var m in s.Memberships.Values.Where(m => m.BoardId == inv.BoardId
              && (boardWide || m.MeetingId == (inv.MeetingId ?? Guid.Empty))
              && string.Equals(m.UserKey, target, StringComparison.OrdinalIgnoreCase)).ToList())
            {
              m.Active = false; m.LeftAt = DateTime.UtcNow; s.Memberships[m.Id] = m;
            }
          });
        }
        catch (UnauthorizedAccessException) { return PeopleOps.Denied(); }
        catch (InvalidOperationException iox) { return Results.Conflict(iox.Message); }
        catch (Exception ex) { return Results.Json(new { error = "Revocation could not be stored: " + ex.Message }, statusCode: 500); }
        try { if (inv.MeetingId.HasValue) PeopleOps.BumpMeeting(s, inv.MeetingId.Value); else if (boardWide) foreach (var __mm in s.Meetings.Values.Where(mm => mm.BoardId == inv.BoardId).ToList()) PeopleOps.BumpMeeting(s, __mm.Id); } catch { }
        foreach (var u in removedUsers) PeopleOps.RevokeLive(u, inv.BoardId, boardWide ? null : inv.MeetingId);
        Atomic.Audit(s, new AuditEvent { BoardId = inv.BoardId, Action = "invite.revoke", Detail = JsonSerializer.Serialize(new { target, scope = boardWide ? "board" : "meeting", meeting = inv.MeetingId }) });
        return Results.Ok(inv);
      }
    });

    app.MapGet("/api/boards/{bid:guid}/grants", (InMemoryStore s, HttpRequest req, Guid bid) =>
      PeopleOps.Check(s, req, bid, null, "manage") ?? Results.Ok(s.Grants.Values.Where(g => g.BoardId == bid).OrderByDescending(g => g.CreatedAt)));

    app.MapPost("/api/boards/{bid:guid}/grants", (InMemoryStore s, HttpRequest req, Guid bid, Grant input) =>
    {
      if (PeopleOps.Check(s, req, bid, input.MeetingId, "manage") is { } denied) return denied;
      // Secure-account prerequisite for meeting collaboration (parity with invites).
      try { if (input.MeetingId.HasValue && !PeopleOps.IsSecure(s)) return Results.Json(new { error = "Registration required: meeting collaboration needs a secure account. Register to continue." }, statusCode: 403); } catch (InvalidOperationException) { return Results.Json(new { error = "Security state unavailable." }, statusCode: 503); }
      if (string.IsNullOrWhiteSpace(input.UserKey)) return Results.BadRequest("userKey is required.");
      var access = (input.Access ?? "").Trim().ToLowerInvariant();
      if (access is not ("read" or "contribute" or "manage" or "discuss" or "guest"))
        return Results.BadRequest("access must be read, contribute, manage, or discuss.");
      if (access == "guest") access = "discuss";
      if (input.MeetingId.HasValue)
      {
        if (!s.Meetings.TryGetValue(input.MeetingId.Value, out var mm) || mm.BoardId != bid)
          return Results.NotFound("meeting");
      }
      else if (access == "discuss")
        return Results.BadRequest("discuss grants require a meeting.");
      lock (s.SetupLock)
      {
        // Recheck CURRENT authorization inside the mutation critical section (TOCTOU).
        if (PeopleOps.Check(s, req, bid, input.MeetingId, "manage") is { } deniedInner) return deniedInner;
        // ONE durable unit: recheck CURRENT authority inside the commit; storage
        // failure rolls back and returns 500 instead of a false Created.
        Grant? created = null;
        try
        {
          Atomic.Run(s, () =>
          {
            if (PeopleOps.Check(s, req, bid, input.MeetingId, "manage") is not null) throw new UnauthorizedAccessException("Access revoked or not granted for this scope.");
            foreach (var old in s.Grants.Values.Where(g => g.BoardId == bid
              && g.MeetingId == input.MeetingId
              && string.Equals(g.UserKey, input.UserKey, StringComparison.OrdinalIgnoreCase)).ToList())
              s.Grants.TryRemove(old.Id, out _);
            var ng = new Grant { Id = Guid.NewGuid(), BoardId = bid, MeetingId = input.MeetingId, UserKey = input.UserKey.Trim(), Access = access, CreatedAt = DateTime.UtcNow };
            s.Grants[ng.Id] = ng;
            PeopleOps.MarkEnforced(s, bid);
            created = ng;
          });
        }
        catch (UnauthorizedAccessException) { return PeopleOps.Denied(); }
        catch (Exception ex) { return Results.Json(new { error = "Grant could not be stored: " + ex.Message }, statusCode: 500); }
        var g = created!;
        try { if (g.MeetingId.HasValue) PeopleOps.BumpMeeting(s, g.MeetingId.Value); else foreach (var mm in s.Meetings.Values.Where(m => m.BoardId == g.BoardId).ToList()) PeopleOps.BumpMeeting(s, mm.Id); } catch { }
        Atomic.Audit(s, new AuditEvent { BoardId = bid, Action = "grant.set", Detail = JsonSerializer.Serialize(new { g.UserKey, g.MeetingId, g.Access }) });
        return Results.Created($"/api/grants/{g.Id}", g);
      }
    });

    app.MapDelete("/api/grants/{id:guid}", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (!s.Grants.TryGetValue(id, out var g)) return Results.NotFound();
      if (PeopleOps.Check(s, req, g.BoardId, g.MeetingId, "manage") is { } denied) return denied;
      lock (s.SetupLock)
      {
        // Recheck CURRENT authority inside the mutation lock (TOCTOU).
        if (!s.Grants.TryGetValue(id, out var gg0)) return Results.NotFound();
        if (PeopleOps.Check(s, req, gg0.BoardId, gg0.MeetingId, "manage") is { } deniedD0) return deniedD0;
        if (!s.Grants.TryGetValue(id, out g)) return Results.NotFound();
        var mid = g.MeetingId; var bid = g.BoardId; var user = g.UserKey;
        // ONE durable unit: grant removal + membership deactivation commit together;
        // storage failure returns 500 with no partial commit and no false NoContent.
        try
        {
          Atomic.Run(s, () =>
          {
            if (PeopleOps.Check(s, req, bid, mid, "manage") is not null) throw new UnauthorizedAccessException("Access revoked or not granted for this scope.");
            if (!s.Grants.TryGetValue(id, out _)) throw new InvalidOperationException("Grant is gone.");
            s.Grants.TryRemove(id, out _);
            foreach (var m in s.Memberships.Values.Where(m => m.BoardId == bid && m.MeetingId == mid
              && string.Equals(m.UserKey, user, StringComparison.OrdinalIgnoreCase)).ToList())
            { m.Active = false; m.LeftAt = DateTime.UtcNow; s.Memberships[m.Id] = m; }
          });
        }
        catch (UnauthorizedAccessException) { return PeopleOps.Denied(); }
        catch (InvalidOperationException iox) when (iox.Message == "Grant is gone.") { return Results.NotFound(); }
        catch (Exception ex) { return Results.Json(new { error = "Grant revocation could not be stored: " + ex.Message }, statusCode: 500); }
        try { if (mid.HasValue) PeopleOps.BumpMeeting(s, mid.Value); else foreach (var __mm in s.Meetings.Values.Where(m => m.BoardId == bid).ToList()) PeopleOps.BumpMeeting(s, __mm.Id); } catch { }
        PeopleOps.RevokeLive(user, bid, mid);
        Atomic.Audit(s, new AuditEvent { BoardId = bid, Action = "grant.revoke", Detail = JsonSerializer.Serialize(new { user, meeting = mid }) });
        return Results.NoContent();
      }
    });

    app.MapGet("/api/boards/{bid:guid}/memberships", (InMemoryStore s, HttpRequest req, Guid bid) =>
      PeopleOps.Check(s, req, bid, null, "manage") ?? Results.Ok(s.Memberships.Values.Where(m => m.BoardId == bid).OrderByDescending(m => m.JoinedAt)));

    app.MapGet("/api/me/memberships", (InMemoryStore s, HttpRequest req) =>
    {
      if (PeopleOps.BadToken(s, req) is { } bad) return bad;
      if (PeopleOps.IsSecure(s) && !AuthOps.TrySession(s, req, out var em))
        return Results.Json(new { error = "Authentication required." }, statusCode: 401);
      var user = AuthOps.TrySession(s, req, out var e2) ? e2 : PeopleOps.UserOf(s, req);
      try { return Results.Ok(s.Memberships.Values.Where(m => string.Equals(m.UserKey, user, StringComparison.OrdinalIgnoreCase) && m.Active).ToList()); }
      catch { return Results.Ok(Array.Empty<Membership>()); }
    });

    app.MapPost("/api/meetings/{meetingId:guid}/join", (InMemoryStore s, HttpRequest req, Guid meetingId) =>
    {
      if (!s.Meetings.TryGetValue(meetingId, out var mtg)) return Results.NotFound("meeting");
      // Shared authorized durable join: CURRENT session/grant/restore/meeting are
      // rechecked inside ONE Atomic unit; idempotent (active membership keeps its
      // original JoinedAt); explicit rejoin may reactivate an inactive row only
      // with a live grant. No HubGate interaction here.
      var ensured = PeopleOps.EnsureMeetingMembership(s, req, mtg.BoardId, meetingId, explicitJoin: true);
      if (ensured.Error is not null) return ensured.Error;
      return Results.Ok(ensured.Membership);
    });

    app.MapPost("/api/meetings/{meetingId:guid}/leave", (InMemoryStore s, HttpRequest req, Guid meetingId) =>
    {
      if (!s.Meetings.TryGetValue(meetingId, out var mtg)) return Results.NotFound("meeting");
      if (PeopleOps.BadToken(s, req) is { } bad) return bad;
      if (PeopleOps.IsSecure(s) && !AuthOps.TrySession(s, req, out var em))
        return Results.Json(new { error = "Authentication required." }, statusCode: 401);
      var user = AuthOps.TrySession(s, req, out var e2) ? e2 : PeopleOps.UserOf(s, req);
      lock (s.SetupLock)
      {
        // Recheck CURRENT session identity inside the mutation lock: a stale
        // pre-lock session must not mutate another identity's access state.
        if (PeopleOps.BadToken(s, req) is { } badL2) return badL2;
        var lu = PeopleOps.IsSecure(s) && AuthOps.TrySession(s, req, out var le2) ? le2 : PeopleOps.UserOf(s, req);
        if (!string.Equals(lu, user, StringComparison.OrdinalIgnoreCase))
          return Results.Json(new { error = "Authentication required." }, statusCode: 401);
        try
        {
          Atomic.Run(s, () =>
          {
            foreach (var g in s.Grants.Values.Where(g => g.BoardId == mtg.BoardId && g.MeetingId == meetingId
              && string.Equals(g.UserKey, lu, StringComparison.OrdinalIgnoreCase)).ToList())
              s.Grants.TryRemove(g.Id, out _);
            foreach (var m in s.Memberships.Values.Where(m => m.BoardId == mtg.BoardId && m.MeetingId == meetingId
              && string.Equals(m.UserKey, lu, StringComparison.OrdinalIgnoreCase)).ToList())
            { m.Active = false; m.LeftAt = DateTime.UtcNow; s.Memberships[m.Id] = m; }
          });
        }
        catch (Exception ex) { return Results.Json(new { error = "Leave could not be stored: " + ex.Message }, statusCode: 500); }
        try { PeopleOps.BumpMeeting(s, meetingId); } catch { }
        PeopleOps.RevokeLive(lu, mtg.BoardId, meetingId);
        Atomic.Audit(s, new AuditEvent { BoardId = mtg.BoardId, Action = "membership.leave", Detail = JsonSerializer.Serialize(new { user = lu, meeting = meetingId }) });
        return Results.Ok(new { left = true, meetingId });
      }
    });

    app.MapPost("/api/boards/{bid:guid}/repair-access", (InMemoryStore s, HttpRequest req, Guid bid) =>
    {
      var admin = PeopleOps.AdminEmail(s);
      var user = PeopleOps.UserOf(s, req);
      var isAdmin = !string.IsNullOrWhiteSpace(admin) && string.Equals(admin, user, StringComparison.OrdinalIgnoreCase);
      if (!isAdmin)
      {
        if (PeopleOps.Check(s, req, bid, null, "manage") is { } denied) return denied;
        if (!s.Boards.TryGetValue(bid, out var bchk) || !string.Equals(bchk.OwnerKey, user, StringComparison.OrdinalIgnoreCase))
          return Results.Json(new { error = "Only the installation admin or board owner can repair access." }, statusCode: 403);
      }
      if (!s.Boards.TryGetValue(bid, out var board)) return Results.NotFound();
      var repaired = new List<object>();
      lock (s.SetupLock)
      {
        var revokedLive = new List<string>();
        try
        {
          Atomic.Run(s, () =>
          {
            // Recheck CURRENT repair authority inside the durable unit.
            var __adm2 = PeopleOps.AdminEmail(s); var __me2 = PeopleOps.UserOf(s, req);
            var __isAdm2 = !string.IsNullOrWhiteSpace(__adm2) && string.Equals(__adm2, __me2, StringComparison.OrdinalIgnoreCase);
            if (!__isAdm2)
            {
              if (PeopleOps.Check(s, req, bid, null, "manage") is not null) throw new UnauthorizedAccessException("Access revoked or not granted for this scope.");
              if (!s.Boards.TryGetValue(bid, out var __b2) || !string.Equals(__b2.OwnerKey, __me2, StringComparison.OrdinalIgnoreCase)) throw new UnauthorizedAccessException("Only the installation admin or board owner can repair access.");
            }
            if (!s.Boards.TryGetValue(bid, out var __board2)) throw new InvalidOperationException("Board is gone.");
            var needsReview = new List<object>();
            foreach (var inv in s.Invites.Values.Where(i => i.BoardId == bid && i.State == "accepted" && i.MeetingId != null).ToList())
            {
              if (string.IsNullOrWhiteSpace(inv.UserKey)) { needsReview.Add(new { user = inv.Email ?? "", note = "accepted invite without bound identity; owner review, never automatic grant" }); continue; }
              var u = inv.UserKey;
              if (string.IsNullOrWhiteSpace(u)) continue;
              // Respect explicit leave/revoke and current meeting parent: an old accepted invite
              // must NOT silently reissue a revoked grant. Only a genuinely NEW explicit invitation
              // (state pending -> accept) grants access.
              if (!s.Meetings.TryGetValue(inv.MeetingId.Value, out var __pm) || __pm.BoardId != bid) continue;
              { var __ex = s.Memberships.Values.FirstOrDefault(x => x.BoardId == bid && x.MeetingId == inv.MeetingId.Value && string.Equals(x.UserKey, u, StringComparison.OrdinalIgnoreCase)); if (__ex is not null && !__ex.Active) continue; }
              if (PeopleOps.WasExplicitlyLeft(s, bid, inv.MeetingId.Value, u)) continue;
              // Independent board-wide grants are NEVER deleted: the current
              // accept flow binds meeting-scoped grants only, so a coexisting
              // board grant is either independently issued (preserve) or of
              // unknown provenance (owner review, never automatic deletion).
              var coexisting = s.Grants.Values.Where(g => g.BoardId == bid && g.MeetingId == null
                && string.Equals(g.UserKey, u, StringComparison.OrdinalIgnoreCase)).ToList();
              foreach (var w in coexisting)
                needsReview.Add(new { user = u, boardGrant = w.Id, access = w.Access, note = "accepted meeting invite coexists with board-wide grant; owner review, not automatic removal" });
              // No reissue: repair never grants access and never resurrects
              // revoked/leave state.
            }
            if (needsReview.Count > 0) repaired.Add(new { needsReview });
            PeopleOps.MarkEnforced(s, bid);
          });
        }
        catch (UnauthorizedAccessException) { return Results.Json(new { error = "Only the installation admin or board owner can repair access." }, statusCode: 403); }
        catch (InvalidOperationException iox) when (iox.Message == "Board is gone.") { return Results.NotFound(); }
        catch (Exception ex) { return Results.Json(new { error = "Access repair could not be stored: " + ex.Message }, statusCode: 500); }
        foreach (var __u in revokedLive.Distinct(StringComparer.OrdinalIgnoreCase)) PeopleOps.RevokeLive(__u, bid, null);
      }
      Atomic.Audit(s, new AuditEvent { BoardId = bid, Action = "access.repair", Detail = JsonSerializer.Serialize(new { repaired = repaired.Count }) });
      return Results.Ok(new { repaired });
    });
  }
}
