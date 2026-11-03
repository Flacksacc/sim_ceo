using System.Text.Json;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;

namespace SimCEO.Api.Work;

// Board-lead profile ("Your Profile") and setup draft/activate rules.
// Lead saves are explicit and versioned; a save based on an older version
// is rejected so the owner refreshes instead of silently overwriting.
// Board effective lead = that board's own profile, else the global
// (Guid.Empty) profile. cross-board fallback is never used: two boards with
// distinct versions resolve independently.
// Setup activation requires a name, a saved lead profile, and at least one
// eligible approved advisor; only the exact reviewed draft hash activates.
// Once ActiveConfig is set, the accepted snapshot (ActiveJson) governs the
// effective mission/stage/policy/dataUse consumed by ContextCurator and
// ModelPolicy; draft edits take effect only after re-activation. Legacy
// unactivated boards keep the long-standing live-fields behavior.
public static class LeadSetup
{
  public static LeadProfile? ResolveLead(InMemoryStore s) =>
    s.LeadProfiles.Values.Where(l => l.BoardId == Guid.Empty).OrderByDescending(l => l.UpdatedAt).FirstOrDefault();

  public static LeadProfile? ResolveLeadFor(InMemoryStore s, Guid boardId) =>
    s.LeadProfiles.Values.Where(l => l.BoardId == boardId).OrderByDescending(l => l.UpdatedAt).FirstOrDefault()
    ?? (boardId == Guid.Empty ? null : ResolveLead(s));

  // Strict resolution: board-owned profile only, NEVER the global fallback.
  // Fallback content is installation data; direct reads gate it separately.
  public static LeadProfile? ResolveLeadForStrict(InMemoryStore s, Guid boardId) =>
    s.LeadProfiles.Values.Where(l => l.BoardId == boardId).OrderByDescending(l => l.UpdatedAt).FirstOrDefault();

  // Installation-data boundary for lead inheritance: the global (Guid.Empty)
  // profile may stand in only for boards owned by the installation admin or
  // for legacy demo boards (blank/"owner" key). Any other board must carry
  // its own profile; otherwise there is no effective lead (never another
  // owner's or the installation's private content).
  public static bool InheritsGlobalLead(InMemoryStore s, Board board)
  {
    try
    {
      if (string.IsNullOrWhiteSpace(board.OwnerKey) || string.Equals(board.OwnerKey, "owner", StringComparison.OrdinalIgnoreCase))
        return true;
      try { return PeopleOps.IsInstallationAdmin(s, board.OwnerKey); } catch { return false; }
    }
    catch { return false; }
  }

  public static LeadProfile? ResolveLeadForBoard(InMemoryStore s, Board board) =>
    ResolveLeadForStrict(s, board.Id) ?? (InheritsGlobalLead(s, board) ? ResolveLead(s) : null);

  public static bool IsFallback(LeadProfile? lead, Guid boardId) =>
    lead is not null && lead.BoardId != boardId;

  // Canonical reviewed draft: identity + full content of the effective lead
  // and per-advisor role/profile/version/reviewed inputs, not just counters.
  // Changing a fallback lead to another profile with the same version still
  // changes this hash.
  public static string CanonicalDraftJson(InMemoryStore s, Board board)
  {
    var lead = ResolveLeadForBoard(s, board);
    var advisorViews = s.Advisors.Values.Where(a => a.BoardId == board.Id && !a.Removed)
      .OrderBy(a => a.Id).Select(a =>
      {
        s.Roster.TryGetValue(a.RosterEntryId, out var rent);
                var portrait = RosterOps.ReviewedPortraitFingerprint(s, a);
        return new
        {
          id = a.Id,
          role = a.BoardRole,
          rosterVersion = a.RosterVersion,
          rosterEntryVersion = rent?.Version ?? 0,
          approved = a.Approved,
          profileHash = rent is null ? "" : Hashing.HashOf(rent.ProfileJson ?? "{}"),
          evidenceCount = rent?.EvidenceCount ?? 0,
          researchedAt = rent?.ResearchedAt,
          portrait,
        };
      }).ToList();
    return JsonSerializer.Serialize(new
    {
      name = board.Name,
      mission = board.Mission,
      stage = board.Stage,
      retainAudio = board.RetainAudio,
      discussionPolicy = board.DiscussionPolicy,
      dataUse = board.DataUse,
      blockedTypes = board.BlockedTypes,
      lead = lead is null ? null : new
      {
        boardId = lead.BoardId,
        version = lead.Version,
        name = lead.Name,
        roleLabel = lead.RoleLabel,
        background = lead.Background,
        familiarTopics = lead.FamiliarTopics,
        simplerTopics = lead.SimplerTopics,
        commPrefs = lead.CommPrefs,
      },
      advisors = advisorViews,
    });
  }

  // Effective board view: once activated, the accepted snapshot governs the
  // fields ContextCurator and ModelPolicy consume; draft edits stay inert
  // until re-activation. Unactivated boards use live fields (legacy).
  public static (string name, string mission, string stage, string policy, string dataUse) EffectiveView(InMemoryStore s, Board board)
  {
    if (board.ActiveConfig && !string.IsNullOrWhiteSpace(board.ActiveJson))
    {
      try
      {
        using var doc = JsonDocument.Parse(board.ActiveJson);
        var r = doc.RootElement;
        if (r.ValueKind == JsonValueKind.Object)
        {
          // Activated blanks are preserved verbatim: a blank activated name
          // must NOT resurrect draft text. Only a missing/malformed snapshot
          // falls through to live fields.
          string Str(string n) => r.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? (v.GetString() ?? "") : "";
          return (Str("name"), mission: Str("mission"), stage: Str("stage"), policy: Str("discussionPolicy"), dataUse: Str("dataUse"));
        }
      }
      catch (JsonException) { }
    }
    return (board.Name, board.Mission, board.Stage, board.DiscussionPolicy, board.DataUse);
  }

  public static string EffectiveDataUse(InMemoryStore s, Board board) => EffectiveView(s, board).dataUse;

  public static (LeadProfile? saved, string? error, int status) SaveLead(
    InMemoryStore s, Guid boardId, LeadProfile input)
  {
    Board? board = null;
    if (boardId != Guid.Empty && !s.Boards.TryGetValue(boardId, out board))
      return (null, "board not found", 404);
    if (string.IsNullOrWhiteSpace(input.Name))
      return (null, "Lead name is required.", 400);
    lock (s.SetupLock)
    {
      var currentVersion = s.LeadProfiles.Values
        .Where(l => l.BoardId == boardId)
        .Select(l => (int?)l.Version).Max() ?? 0;
      if (currentVersion != 0 && input.Version != currentVersion)
        return (null, "Stale lead profile; refresh and re-apply your edit.", 409);
      var saved = new LeadProfile
      {
        Id = Guid.NewGuid(),
        BoardId = boardId,
        Version = currentVersion + 1,
        Name = input.Name.Trim(),
        RoleLabel = string.IsNullOrWhiteSpace(input.RoleLabel) ? "Board Lead" : input.RoleLabel.Trim(),
        Background = input.Background,
        FamiliarTopics = input.FamiliarTopics,
        SimplerTopics = input.SimplerTopics,
        CommPrefs = input.CommPrefs,
        UpdatedAt = DateTime.UtcNow,
      };
      saved.ProvenanceJson = JsonSerializer.Serialize(new Dictionary<string, object> { ["name"] = new { source = "owner", at = saved.UpdatedAt }, ["roleLabel"] = new { source = "owner", at = saved.UpdatedAt }, ["background"] = new { source = "owner", at = saved.UpdatedAt }, ["familiarTopics"] = new { source = "owner", at = saved.UpdatedAt }, ["simplerTopics"] = new { source = "owner", at = saved.UpdatedAt }, ["commPrefs"] = new { source = "owner", at = saved.UpdatedAt } });
      s.LeadProfiles[saved.Id] = saved;
      if (board is not null) board.LeadProfileVersion = saved.Version;
      s.Boards.Flush();
      s.LeadProfiles.Flush();
      s.Audit.Add(new AuditEvent
      {
        BoardId = boardId, Action = "lead.save",
        Detail = JsonSerializer.Serialize(new { version = saved.Version }),
      });
      return (saved, null, 200);
    }
  }

  public static (Board? board, string? error, int status) Activate(
    InMemoryStore s, Guid boardId, string? expectedHash)
  {
    if (!s.Boards.TryGetValue(boardId, out var board))
      return (null, "board not found", 404);
    lock (s.SetupLock)
    {
      if (string.IsNullOrWhiteSpace(board.Name))
        return (null, "Board name is required before activation.", 409);
      // Activation requires the board's OWN lead, except admin/legacy boards
      // which may inherit the installation-global profile.
      var hasLead = (ResolveLeadForStrict(s, boardId) ?? (InheritsGlobalLead(s, board) ? ResolveLead(s) : null)) is not null;
      if (!hasLead)
        return (null, "Reviewed board-lead profile is required before activation.", 409);
      var approved = s.Advisors.Values.Count(a => a.BoardId == boardId && !a.Removed && a.Approved
        && RosterOps.ApprovalGate(s, a) is null);
      if (approved < 1)
        return (null, "At least one eligible approved advisor is required before activation.", 409);
      if (string.IsNullOrWhiteSpace(expectedHash))
        return (null, "Reviewed draft hash is required; refresh review and activate the exact draft.", 400);
      var canonical = CanonicalDraftJson(s, board);
      if (!string.Equals(Hashing.HashOf(canonical), expectedHash, StringComparison.OrdinalIgnoreCase))
        return (null, "Setup draft changed; refresh review.", 409);
      board.ActiveJson = canonical;
      board.ActiveConfig = true;
      s.Boards.Flush();
      s.Audit.Add(new AuditEvent
      {
        BoardId = boardId, Action = "setup.activate",
        Detail = JsonSerializer.Serialize(new { leadVersion = board.LeadProfileVersion, approved }),
      });
      return (board, null, 200);
    }
  }
}
