using SimCEO.Api.Data;

namespace SimCEO.Api.Work;

// Strict resource authority: manager-only configure/enable/disable/sync/delete
// at the ACTUAL board/single-meeting destination. Meeting-only grants can never
// configure board resources or move one to a sibling meeting. Guests read only
// eligible excerpts/settings, never connector credentials/config writes.
// Board-level management requires an explicit board-wide grant
// (MeetingId == null), never a meeting-only grant. Read filtering is per-row:
// a guest for M1 cannot see M2 origins/rules/counts.
public static class WikiAuth
{
  public static bool IsBoardManager(InMemoryStore s, HttpRequest req, Guid boardId)
    => IsBoardManagerUser(s, boardId, PeopleOps.UserOf(s, req));

  // Auth8 integration: in secure mode there is no open/demo bypass and no
  // grantless default. Board owner and installation admin are recognized;
  // everyone else needs an explicit grant. The literal "system" principal is
  // reserved for in-process scheduled work and never satisfies a remote call.
  static bool SecureApplies(InMemoryStore s) { try { return PeopleOps.IsSecure(s); } catch { return false; } }

  static bool IsOwnerOrAdmin(InMemoryStore s, Guid boardId, string user)
  {
    try
    {
      if (s.Boards.TryGetValue(boardId, out var b) && !string.IsNullOrWhiteSpace(b.OwnerKey)
        && string.Equals(b.OwnerKey, user, StringComparison.OrdinalIgnoreCase)) return true;
    }
    catch { }
    try { return PeopleOps.IsInstallationAdmin(s, user); } catch { return false; }
  }

  public static bool IsBoardManagerUser(InMemoryStore s, Guid boardId, string user)
  {
    if (SecureApplies(s)) return IsOwnerOrAdmin(s, boardId, user)
      || s.Grants.Values.Any(g => g.BoardId == boardId && g.MeetingId == null
        && string.Equals(g.UserKey, user, StringComparison.OrdinalIgnoreCase)
        && (g.Access == "manage" || g.Access == "open"));
    if (string.Equals(user, "owner", StringComparison.OrdinalIgnoreCase)) return true;
    if (!s.Grants.Values.Any(g => g.BoardId == boardId) && !s.Invites.Values.Any(i => i.BoardId == boardId)) return true;
    return s.Grants.Values.Any(g => g.BoardId == boardId && g.MeetingId == null
      && string.Equals(g.UserKey, user, StringComparison.OrdinalIgnoreCase)
      && (g.Access == "manage" || g.Access == "open"));
  }

  public static bool CanManageResource(InMemoryStore s, HttpRequest req, Guid boardId, string scope, Guid? meetingId)
  {
    if (PeopleOps.HasInvalidToken(s, req)) return false;
    return CanManageByUser(s, boardId, scope, meetingId, PeopleOps.UserOf(s, req));
  }

  // Commit-time authority recheck by resolved user (no HttpRequest needed):
  // resource revision is NOT authorization state; this checks the actual
  // current grant for that user. System scheduled work is handled separately.
  public static bool CanManageByUser(InMemoryStore s, Guid boardId, string scope, Guid? meetingId, string user)
  {
    if (string.IsNullOrWhiteSpace(user)) return false;
    if (scope == "meeting")
    {
      if (!meetingId.HasValue) return false;
      if (SecureApplies(s))
      {
        if (IsOwnerOrAdmin(s, boardId, user)) return true;
      }
      else
      {
        if (string.Equals(user, "owner", StringComparison.OrdinalIgnoreCase)) return true;
        if (!s.Grants.Values.Any(g => g.BoardId == boardId) && !s.Invites.Values.Any(i => i.BoardId == boardId)) return true;
      }
      if (IsBoardManagerUser(s, boardId, user)) return true;
      return s.Grants.Values.Any(g => g.BoardId == boardId && g.MeetingId == meetingId
        && string.Equals(g.UserKey, user, StringComparison.OrdinalIgnoreCase)
        && (g.Access == "manage" || g.Access == "open"));
    }
    return IsBoardManagerUser(s, boardId, user);
  }

  // Strict per-resource read: board resources require board-wide read;
  // meeting resources require board read OR that exact meeting read.
  // Meeting-only grants NEVER satisfy board-resource reads.
  public static bool CanReadResource(InMemoryStore s, HttpRequest req, Guid boardId, string scope, Guid? meetingId)
  {
    if (PeopleOps.HasInvalidToken(s, req)) return false;
    return CanReadByUser(s, boardId, scope, meetingId, PeopleOps.UserOf(s, req));
  }

  public static bool CanReadByUser(InMemoryStore s, Guid boardId, string scope, Guid? meetingId, string user)
  {
    if (string.IsNullOrWhiteSpace(user)) return false;
    if (SecureApplies(s))
    {
      if (IsOwnerOrAdmin(s, boardId, user)) return true;
    }
    else
    {
      if (string.Equals(user, "owner", StringComparison.OrdinalIgnoreCase)) return true;
      var hasAnyGrant = s.Grants.Values.Any(g => g.BoardId == boardId) || s.Invites.Values.Any(i => i.BoardId == boardId);
      if (!hasAnyGrant) return true; // single-user default
    }
    var sc = (scope ?? "board").Trim().ToLowerInvariant() == "meeting" ? "meeting" : "board";
    if (sc == "board")
    {
      // Board resource: explicit board-wide grant (MeetingId==null) with read+.
      return s.Grants.Values.Any(g => g.BoardId == boardId && g.MeetingId == null
        && string.Equals(g.UserKey, user, StringComparison.OrdinalIgnoreCase)
        && (g.Access == "manage" || g.Access == "open" || g.Access == "contribute" || g.Access == "read"));
    }
    if (!meetingId.HasValue) return false;
    // Meeting resource: board-wide read OR exact-meeting read.
    if (s.Grants.Values.Any(g => g.BoardId == boardId && g.MeetingId == null
      && string.Equals(g.UserKey, user, StringComparison.OrdinalIgnoreCase)
      && (g.Access == "manage" || g.Access == "open" || g.Access == "contribute" || g.Access == "read")))
      return true;
    return s.Grants.Values.Any(g => g.BoardId == boardId && g.MeetingId == meetingId
      && string.Equals(g.UserKey, user, StringComparison.OrdinalIgnoreCase)
      && (g.Access == "manage" || g.Access == "open" || g.Access == "contribute" || g.Access == "read"));
  }
}
