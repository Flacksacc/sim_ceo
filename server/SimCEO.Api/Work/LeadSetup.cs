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
  public static string NormalizeOwner(string? v) => (v ?? "").Trim().ToLowerInvariant();

  // Legacy installation-global default: BoardId empty AND OwnerKey empty.
  // Per-account defaults (BoardId empty + OwnerKey set) are NEVER returned here.
  public static LeadProfile? ResolveLead(InMemoryStore s) =>
    s.LeadProfiles.Values.Where(l => l.BoardId == Guid.Empty && string.IsNullOrEmpty(l.OwnerKey ?? "")).OrderByDescending(l => l.Version).ThenByDescending(l => l.UpdatedAt).FirstOrDefault();

  // Per-account default profile: BoardId empty + OwnerKey == normalized owner.
  // Empty/blank owner has no per-account default (legacy global covers demo only via InheritsGlobalLead).
  public static LeadProfile? ResolveDefaultForOwner(InMemoryStore s, string? ownerKey)
  {
    var norm = NormalizeOwner(ownerKey);
    if (string.IsNullOrEmpty(norm)) return null;
    return s.LeadProfiles.Values.Where(l => l.BoardId == Guid.Empty && string.Equals(NormalizeOwner(l.OwnerKey), norm, StringComparison.Ordinal)).OrderByDescending(l => l.Version).ThenByDescending(l => l.UpdatedAt).FirstOrDefault();
  }

  public static LeadProfile? ResolveDefaultForCaller(InMemoryStore s, HttpRequest? req)
  {
    if (req is null) return null;
    try
    {
      var user = PeopleOps.UserOf(s, req);
      return ResolveDefaultForOwner(s, user);
    }
    catch { return null; }
  }

  // Board-scoped resolution: NEVER returns an arbitrary personal or global
  // profile for a missing/empty board identity. Empty or unknown boards yield
  // null; callers needing the legacy installation global use ResolveLead
  // explicitly at an admin-gated boundary.
  public static LeadProfile? ResolveLeadFor(InMemoryStore s, Guid boardId)
  {
    if (boardId == Guid.Empty) return null;
    if (s.Boards.TryGetValue(boardId, out var b) && b is not null)
      return ResolveLeadForBoard(s, b);
    return null;
  }

  // Strict resolution: board-owned profile only, NEVER any fallback.
  // Fallback content is account or installation data; direct reads gate it separately.
  // The empty board identity never matches account defaults: it resolves to the
  // legacy installation global only.
  public static LeadProfile? ResolveLeadForStrict(InMemoryStore s, Guid boardId)
  {
    if (boardId == Guid.Empty)
      return s.LeadProfiles.Values.Where(l => l.BoardId == Guid.Empty && string.IsNullOrEmpty(l.OwnerKey ?? "")).OrderByDescending(l => l.Version).ThenByDescending(l => l.UpdatedAt).FirstOrDefault();
    return s.LeadProfiles.Values.Where(l => l.BoardId == boardId).OrderByDescending(l => l.Version).ThenByDescending(l => l.UpdatedAt).FirstOrDefault();
  }

  // Installation-data boundary for lead inheritance: the global (Guid.Empty)
  // profile may stand in only for boards owned by the installation admin or
  // for legacy demo boards (blank/"owner" key). Any other board must carry
  // its own profile or its owner's default; otherwise there is no effective
  // lead (never another owner's or the installation's private content).
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

  // Effective board lead: strict board override, else the board OWNER's
  // per-account default, else the legacy installation global (only where
  // InheritsGlobalLead allows). Resolution is by board.OwnerKey, NEVER by
  // caller identity, so one owner's private default never leaks into
  // another owner's board packet.
  public static LeadProfile? ResolveLeadForBoard(InMemoryStore s, Board board) =>
    ResolveLeadForStrict(s, board.Id)
    ?? ResolveDefaultForOwner(s, board.OwnerKey)
    ?? (InheritsGlobalLead(s, board) ? ResolveLead(s) : null);

  public static bool IsFallback(LeadProfile? lead, Guid boardId) =>
    lead is not null && lead.BoardId != boardId;

  public static string LeadSource(LeadProfile? lead, Guid boardId)
  {
    if (lead is null) return "none";
    if (lead.BoardId == boardId) return "board";
    if (lead.BoardId == Guid.Empty && !string.IsNullOrEmpty(lead.OwnerKey ?? "")) return "default";
    if (lead.BoardId == Guid.Empty) return "global";
    return "other";
  }

  // Canonical reviewed draft: identity + full content of the effective lead
  // and per-advisor role/profile/version/reviewed inputs, not just counters.
  // Changing a fallback lead to another profile with the same version still
  // changes this hash.
  public static string CanonicalDraftJson(InMemoryStore s, Board board) =>
    CanonicalDraftJsonWithLead(s, board, ResolveLeadForBoard(s, board));

  // Redacted canonical for viewers who must not see the effective lead content
  // (legacy-global hidden from non-admins): identical shape with lead null so
  // hashes stay comparable within the redacted view but never leak content.
  public static string CanonicalDraftJsonWithLead(InMemoryStore s, Board board, LeadProfile? lead)
  {
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

  // Redact an already-serialized canonical/active JSON view: replace the top-level
  // lead object with null. Used only for display to viewers who must not see
  // legacy-global content. Malformed input yields a minimal redacted shell.
  public static string RedactLeadJson(string? json)
  {
    try
    {
      if (string.IsNullOrWhiteSpace(json)) return "{}";
      using var doc = JsonDocument.Parse(json);
      if (doc.RootElement.ValueKind != JsonValueKind.Object) return "{}";
      var dict = new Dictionary<string, object?>();
      foreach (var prop in doc.RootElement.EnumerateObject())
      {
        if (string.Equals(prop.Name, "lead", StringComparison.OrdinalIgnoreCase))
          dict[prop.Name] = null;
        else
          dict[prop.Name] = JsonSerializer.Deserialize<object>(prop.Value.GetRawText());
      }
      return JsonSerializer.Serialize(dict);
    }
    catch (JsonException) { return "{}"; }
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
        if (req is not null && need == "contribute") { if (PeopleOps.IsSecure(s) && !AuthOps.TrySession(s, req, out _)) throw new UnauthorizedAccessException("revoked"); if (!PeopleOps.Can(s, req, boardId, null, "contribute")) throw new UnauthorizedAccessException("denied"); }
        // Fresh fetch + version guard inside the unit: a concurrent save between
        // the route check and this commit cannot silently overwrite.
        Board? freshBoard = null;
        if (boardId != Guid.Empty && !s.Boards.TryGetValue(boardId, out freshBoard))
          throw new InvalidOperationException("gone");
        var currentVersion = s.LeadProfiles.Values
          .Where(l => l.BoardId == boardId && (boardId != Guid.Empty || string.IsNullOrEmpty(l.OwnerKey ?? "")))
          .Select(l => (int?)l.Version).Max() ?? 0;
        if (currentVersion != 0 && wantVersion != currentVersion)
          throw new InvalidOperationException("stale");
        string ownerForRow = "";
        if (boardId != Guid.Empty && freshBoard is not null)
          ownerForRow = NormalizeOwner(freshBoard.OwnerKey);
        var saved = new LeadProfile
        {
          Id = Guid.NewGuid(),
          BoardId = boardId,
          OwnerKey = ownerForRow,
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
    catch (InvalidOperationException iox) when (iox.Message == "gone") { return (null, "board not found", 404); }
    catch (SimCEO.Api.Data.CommitUnknownException cux) { return (null, "Lead save outcome is unknown (the commit may have succeeded); refresh and verify before retrying: " + cux.Message, 500); }
    catch (SimCEO.Api.Data.PostCommitException pcx) { return (null, "Lead save committed, but a post-commit effect failed: " + pcx.Message, 500); }
    catch (AggregateException agx) { return (null, "Lead save failed and rollback is uncertain; prior state may be partial: " + agx.Message, 500); }
    catch (UnauthorizedAccessException) { throw; }
    catch (Exception ex) { return (null, "Lead save failed; no state changed: " + ex.Message, 500); }
    return (savedOut, null, 200);
  }

  // Per-account default save: BoardId empty + OwnerKey == caller identity.
  // Version guard is scoped to (empty, owner); other owners and the legacy
  // global (OwnerKey empty) are untouched. No board rows are written and no
  // broadcast across boards occurs; boards without an explicit override read
  // the new default via ResolveLeadForBoard fingerprint checks (lead-changed
  // invalidates in-flight context without a board bump).
  public static (LeadProfile? saved, string? error, int status) SaveDefault(
    InMemoryStore s, LeadProfile input, HttpRequest? req = null)
  {
    if (string.IsNullOrWhiteSpace(input.Name))
      return (null, "Lead name is required.", 400);
    var wantVersion = input.Version;
    var wantName = (input.Name ?? "").Trim();
    var wantRole = string.IsNullOrWhiteSpace(input.RoleLabel) ? "Board Lead" : input.RoleLabel.Trim();
    string callerOwner = "";
    try
    {
      if (req is null) return (null, "Authentication required.", 401);
      if (PeopleOps.IsSecure(s))
      {
        if (!AuthOps.TrySession(s, req, out var em)) return (null, "Authentication required.", 401);
        callerOwner = NormalizeOwner(em);
      }
      else
      {
        callerOwner = NormalizeOwner(PeopleOps.UserOf(s, req));
      }
      if (string.IsNullOrEmpty(callerOwner)) return (null, "Authentication required.", 401);
    }
    catch (InvalidOperationException) { return (null, "Security state unavailable.", 503); }
    LeadProfile? savedOut = null;
    try
    {
      Atomic.Run(s, () =>
      {
        string freshOwner = "";
        try
        {
          if (PeopleOps.IsSecure(s))
          {
            if (!AuthOps.TrySession(s, req!, out var emIn)) throw new UnauthorizedAccessException("revoked");
            freshOwner = NormalizeOwner(emIn);
          }
          else
          {
            freshOwner = NormalizeOwner(PeopleOps.UserOf(s, req!));
          }
        }
        catch (InvalidOperationException) { throw new InvalidOperationException("security-unavailable"); }
        if (string.IsNullOrEmpty(freshOwner)) throw new UnauthorizedAccessException("revoked");
        if (!string.Equals(freshOwner, callerOwner, StringComparison.Ordinal)) throw new UnauthorizedAccessException("denied");
        var currentVersion = s.LeadProfiles.Values
          .Where(l => l.BoardId == Guid.Empty && string.Equals(NormalizeOwner(l.OwnerKey), freshOwner, StringComparison.Ordinal))
          .Select(l => (int?)l.Version).Max() ?? 0;
        if (currentVersion != 0 && wantVersion != currentVersion)
          throw new InvalidOperationException("stale");
        var saved = new LeadProfile
        {
          Id = Guid.NewGuid(),
          BoardId = Guid.Empty,
          OwnerKey = freshOwner,
          Version = currentVersion + 1,
          Name = wantName,
          RoleLabel = wantRole,
          Background = input.Background ?? "",
          FamiliarTopics = input.FamiliarTopics ?? "",
          SimplerTopics = input.SimplerTopics ?? "",
          CommPrefs = input.CommPrefs ?? "",
          UpdatedAt = DateTime.UtcNow,
        };
        saved.ProvenanceJson = JsonSerializer.Serialize(new Dictionary<string, object> { ["name"] = new { source = "owner", at = saved.UpdatedAt }, ["roleLabel"] = new { source = "owner", at = saved.UpdatedAt }, ["background"] = new { source = "owner", at = saved.UpdatedAt }, ["familiarTopics"] = new { source = "owner", at = saved.UpdatedAt }, ["simplerTopics"] = new { source = "owner", at = saved.UpdatedAt }, ["commPrefs"] = new { source = "owner", at = saved.UpdatedAt } });
        s.LeadProfiles[saved.Id] = saved;
        Atomic.Audit(s, new AuditEvent
        {
          BoardId = Guid.Empty, Action = "lead.default-save",
          Detail = JsonSerializer.Serialize(new { version = saved.Version }),
        });
        savedOut = saved;
      });
    }
    catch (InvalidOperationException iox) when (iox.Message == "stale")
    {
      return (null, "Stale default profile; refresh and re-apply your edit.", 409);
    }
    catch (InvalidOperationException iox) when (iox.Message == "security-unavailable") { return (null, "Security state unavailable.", 503); }
    catch (SimCEO.Api.Data.CommitUnknownException cux) { return (null, "Default save outcome is unknown (the commit may have succeeded); refresh and verify before retrying: " + cux.Message, 500); }
    catch (SimCEO.Api.Data.PostCommitException pcx) { return (null, "Default save committed, but a post-commit effect failed: " + pcx.Message, 500); }
    catch (AggregateException agx) { return (null, "Default save failed and rollback is uncertain; prior state may be partial: " + agx.Message, 500); }
    catch (UnauthorizedAccessException uex) when (uex.Message == "revoked") { return (null, "Authentication required.", 401); }
    catch (UnauthorizedAccessException) { return (null, "Access revoked or not granted for this scope.", 403); }
    catch (Exception ex) { return (null, "Default save failed; no state changed: " + ex.Message, 500); }
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
        if (req is not null) { if (PeopleOps.IsSecure(s) && !AuthOps.TrySession(s, req, out _)) throw new UnauthorizedAccessException("revoked"); if (!PeopleOps.Can(s, req, boardId, null, "manage")) throw new UnauthorizedAccessException("denied"); }
        // Fresh fetch + full activation guard inside the unit: name, own lead,
        // eligible advisor, and exact reviewed hash are rechecked against
        // current rows so a concurrent edit cannot activate a stale draft.
        if (!s.Boards.TryGetValue(boardId, out var cur) || cur is null) throw new InvalidOperationException("gone");
        if (string.IsNullOrWhiteSpace(cur.Name))
          throw new InvalidOperationException("noname");
        var hasLead = ResolveLeadForBoard(s, cur) is not null;
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
    catch (InvalidOperationException iox) when (iox.Message == "gone") { return (null, "board not found", 404); }
    catch (SimCEO.Api.Data.CommitUnknownException cux) { return (null, "Activation outcome is unknown (the commit may have succeeded); refresh and verify before retrying: " + cux.Message, 500); }
    catch (SimCEO.Api.Data.PostCommitException pcx) { return (null, "Activation committed, but a post-commit effect failed: " + pcx.Message, 500); }
    catch (AggregateException agx) { return (null, "Activation failed and rollback is uncertain; prior state may be partial: " + agx.Message, 500); }
    catch (UnauthorizedAccessException) { throw; }
    catch (Exception ex) { return (null, "Activation failed; no state changed: " + ex.Message, 500); }
    return (activatedOut, null, 200);
  }
}
