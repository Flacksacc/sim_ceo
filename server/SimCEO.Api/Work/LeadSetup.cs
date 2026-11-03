using System.Text.Json;
using Microsoft.AspNetCore.Http;
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
    InMemoryStore s, Guid boardId, LeadProfile input, HttpRequest? req = null, string? need = null)
  {
    if (boardId != Guid.Empty && !s.Boards.TryGetValue(boardId, out _))
      return (null, "board not found", 404);
    if (string.IsNullOrWhiteSpace(input.Name))
      return (null, "Lead name is required.", 400);
    var wantVersion = input.Version;
    var wantName = (input.Name ?? "").Trim();
    var wantRole = string.IsNullOrWhiteSpace(input.RoleLabel) ? "Board Lead" : input.RoleLabel.Trim();
    LeadProfile? savedOut = null;
    try
    {
      Atomic.Run(s, () =>
      {
        // Fresh authority INSIDE the mutation unit.
        if (req is not null && need == "admin") { if (PeopleOps.IsSecure(s)) { if (!AuthOps.TrySession(s, req, out var leIn)) throw new UnauthorizedAccessException("revoked"); var admIn = PeopleOps.AdminEmail(s); if (string.IsNullOrWhiteSpace(admIn) || !string.Equals(admIn, leIn, StringComparison.OrdinalIgnoreCase)) throw new UnauthorizedAccessException("denied"); } else if (!PeopleOps.IsOwner(req)) throw new UnauthorizedAccessException("denied"); }
        if (req is not null && need == "contribute") { if (PeopleOps.Check(s, req, boardId, null, "contribute") is not null) throw new UnauthorizedAccessException("revoked"); }
        // Fresh fetch + version guard inside the unit: a concurrent save between
        // the route check and this commit cannot silently overwrite.
        Board? freshBoard = null;
        if (boardId != Guid.Empty && !s.Boards.TryGetValue(boardId, out freshBoard))
          throw new InvalidOperationException("gone");
        var currentVersion = s.LeadProfiles.Values
          .Where(l => l.BoardId == boardId)
          .Select(l => (int?)l.Version).Max() ?? 0;
        if (currentVersion != 0 && wantVersion != currentVersion)
          throw new InvalidOperationException("stale");
        var saved = new LeadProfile
        {
          Id = Guid.NewGuid(),
          BoardId = boardId,
          Version = currentVersion + 1,
          Name = wantName,
          RoleLabel = wantRole,
          Background = input.Background,
          FamiliarTopics = input.FamiliarTopics,
          SimplerTopics = input.SimplerTopics,
          CommPrefs = input.CommPrefs,
          UpdatedAt = DateTime.UtcNow,
        };
        saved.ProvenanceJson = JsonSerializer.Serialize(new Dictionary<string, object> { ["name"] = new { source = "owner", at = saved.UpdatedAt }, ["roleLabel"] = new { source = "owner", at = saved.UpdatedAt }, ["background"] = new { source = "owner", at = saved.UpdatedAt }, ["familiarTopics"] = new { source = "owner", at = saved.UpdatedAt }, ["simplerTopics"] = new { source = "owner", at = saved.UpdatedAt }, ["commPrefs"] = new { source = "owner", at = saved.UpdatedAt } });
        s.LeadProfiles[saved.Id] = saved;
        if (freshBoard is not null) { freshBoard.LeadProfileVersion = saved.Version; s.Boards[freshBoard.Id] = freshBoard; }
        Atomic.Audit(s, new AuditEvent
        {
          BoardId = boardId, Action = "lead.save",
          Detail = JsonSerializer.Serialize(new { version = saved.Version }),
        });
        savedOut = saved;
      });
    }
    catch (InvalidOperationException iox) when (iox.Message == "stale")
    {
      return (null, "Stale lead profile; refresh and re-apply your edit.", 409);
    }
    catch (InvalidOperationException) { return (null, "board not found", 404); }
    catch (UnauthorizedAccessException) { throw; }
    catch (Exception ex) { return (null, "Lead save failed; no state changed: " + ex.Message, 500); }
    return (savedOut, null, 200);
  }

  public static (Board? board, string? error, int status) Activate(
    InMemoryStore s, Guid boardId, string? expectedHash, HttpRequest? req = null)
  {
    if (!s.Boards.TryGetValue(boardId, out var board))
      return (null, "board not found", 404);
    var wantHash = expectedHash;
    Board? activatedOut = null;
    try
    {
      Atomic.Run(s, () =>
      {
        if (req is not null && PeopleOps.Check(s, req, boardId, null, "manage") is not null) throw new UnauthorizedAccessException("revoked");
        // Fresh fetch + full activation guard inside the unit: name, own lead,
        // eligible advisor, and exact reviewed hash are rechecked against
        // current rows so a concurrent edit cannot activate a stale draft.
        if (!s.Boards.TryGetValue(boardId, out var cur) || cur is null) throw new InvalidOperationException("gone");
        if (string.IsNullOrWhiteSpace(cur.Name))
          throw new InvalidOperationException("noname");
        var hasLead = (ResolveLeadForStrict(s, boardId) ?? (InheritsGlobalLead(s, cur) ? ResolveLead(s) : null)) is not null;
        if (!hasLead)
          throw new InvalidOperationException("nolead");
        var approved = s.Advisors.Values.Count(a => a.BoardId == boardId && !a.Removed && a.Approved
          && RosterOps.ApprovalGate(s, a) is null);
        if (approved < 1)
          throw new InvalidOperationException("noadvisor");
        if (string.IsNullOrWhiteSpace(wantHash))
          throw new InvalidOperationException("nohash");
        var canonical = CanonicalDraftJson(s, cur);
        if (!string.Equals(Hashing.HashOf(canonical), wantHash, StringComparison.OrdinalIgnoreCase))
          throw new InvalidOperationException("changed");
        cur.ActiveJson = canonical;
        cur.ActiveConfig = true;
        s.Boards[cur.Id] = cur;
        Atomic.Audit(s, new AuditEvent
        {
          BoardId = boardId, Action = "setup.activate",
          Detail = JsonSerializer.Serialize(new { leadVersion = cur.LeadProfileVersion, approved }),
        });
        activatedOut = cur;
      });
    }
    catch (InvalidOperationException iox) when (iox.Message == "noname")
    {
      return (null, "Board name is required before activation.", 409);
    }
    catch (InvalidOperationException iox) when (iox.Message == "nolead")
    {
      return (null, "Reviewed board-lead profile is required before activation.", 409);
    }
    catch (InvalidOperationException iox) when (iox.Message == "noadvisor")
    {
      return (null, "At least one eligible approved advisor is required before activation.", 409);
    }
    catch (InvalidOperationException iox) when (iox.Message == "nohash")
    {
      return (null, "Reviewed draft hash is required; refresh review and activate the exact draft.", 400);
    }
    catch (InvalidOperationException iox) when (iox.Message == "changed")
    {
      return (null, "Setup draft changed; refresh review.", 409);
    }
    catch (InvalidOperationException) { return (null, "board not found", 404); }
    catch (UnauthorizedAccessException) { throw; }
    catch (Exception ex) { return (null, "Activation failed; no state changed: " + ex.Message, 500); }
    return (activatedOut, null, 200);
  }
}
