using System.Collections.Concurrent;
using System.Text.Json;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;
using SimCEO.Api.Work;

namespace SimCEO.Api;

// Advisor Roster: unlimited account templates, board chips derived live from
// board copies, copy-to-board under the 10-seat cap, archive, character
// drafts, isolated auditions (never meeting messages), and explicit images.
public static class RosterOps
{
  public static object BoardsFor(InMemoryStore s, Guid rosterId) =>
    s.Advisors.Values.Where(a => a.RosterEntryId == rosterId && !a.Removed)
      .Select(a => new
      {
        boardId = a.BoardId,
        board = s.Boards.TryGetValue(a.BoardId, out var b) ? b.Name : "?",
        role = a.BoardRole,
        approved = a.Approved,
      }).ToList();

  // Single attach choke point: every board attach (advisor POST, roster copy)
  // routes through RosterIntegrity.CheckAttach, so a board advisor can ONLY
  // link an authorized, existing, non-archived roster entry. The portrait
  // completeness rule stays here: a roster entry without an image is still
  // not board-usable (ApprovalGate parity).
  public static (BoardAdvisor? advisor, string? error, int status) TryCopy(
    InMemoryStore s, Guid rosterId, Guid boardId, string role,
    bool callerCanReadRoster = true, bool canAttachBoard = true)
  {
    var gate = RosterIntegrity.CheckAttach(s, rosterId, boardId, callerCanReadRoster, canAttachBoard);
    if (!gate.Ok) return (null, gate.Error, gate.Status);
    if (!s.Roster.TryGetValue(rosterId, out var entry) || entry.Archived)
      return (null, "Roster entry not found.", 404);
    // Source authorization required before copy: caller must read the source template entry.
    // (Source roster entries are account templates; unrelated private research is filtered at read sites.)
    lock (s.SetupLock)
    {
      if (s.Advisors.Values.Any(a => a.BoardId == boardId && a.RosterEntryId == rosterId && !a.Removed))
        return (null, "Advisor already attached to this board.", 409);
      if (s.Advisors.Values.Count(a => a.BoardId == boardId && !a.Removed) >= 10)
        return (null, "Board already has 10 advisors. Remove an advisor to add another.", 409);
      var (dok, dmissing) = RosterOps.Completeness(s, rosterId);
      if (!dok)
        return (null, "Roster entry is incomplete: " + string.Join(", ", dmissing) + ".", 409);
      var copy = new BoardAdvisor
      {
        Id = Guid.NewGuid(), BoardId = boardId, RosterEntryId = rosterId,
        RosterVersion = entry.Version,
        BoardRole = string.IsNullOrWhiteSpace(role) ? entry.Name : role.Trim(),
        CreatedAt = DateTime.UtcNow,
      };
      Atomic.Run(s, () => { s.Advisors[copy.Id] = copy; s.Advisors.Flush(); });
      Atomic.Audit(s, new AuditEvent
      {
        BoardId = boardId, Action = "roster.copy",
        Detail = JsonSerializer.Serialize(new { rosterId, version = entry.Version, copy = copy.Id }),
      });
      return (copy, null, 200);
    }
  }

  // Honest research state for review gates: live work blocks as "in progress";
  // terminal failed/unsupported/interrupted research is named, never "running".
  // An "unsupported" run finished but gathered zero grounded evidence: the entry
  // may attach (stage an unapproved copy) but approval still requires grounded
  // evidence, so review eligibility stays honest without blocking staging.
  public static string? ResearchTerminalStatus(RosterEntry entry)
  {
    if (!string.IsNullOrEmpty(entry.ResearchJobId) && IsLiveResearchJob(entry.ResearchJobId)) return null;
    try
    {
      using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(entry.ResearchJson) ? "{}" : entry.ResearchJson);
      if (doc.RootElement.ValueKind != JsonValueKind.Object) return null;
      if (!doc.RootElement.TryGetProperty("draftStatus", out var ds) || ds.ValueKind != JsonValueKind.String) return null;
      var st = (ds.GetString() ?? "").Trim().ToLowerInvariant();
      if (st is "failed" or "unsupported" or "superseded") return st;
    }
    catch (JsonException) { }
    return null;
  }

  public static string ResearchMissingReason(InMemoryStore s, RosterEntry entry)
  {
    if (!string.IsNullOrEmpty(entry.ResearchJobId) && IsLiveResearchJob(entry.ResearchJobId))
      return "research in progress";
    return ResearchTerminalStatus(entry) switch
    {
      "failed" => "research failed (rerun research)",
      "unsupported" => "research unsupported (editable draft, not grounded; rerun for grounding)",
      "superseded" => "research interrupted (rerun research)",
      _ => "research in progress",
    };
  }

  public static (bool complete, List<string> missing) DataCompleteness(InMemoryStore s, Guid rosterId)
  {
    var missing = new List<string>();
    if (!s.Roster.TryGetValue(rosterId, out var de) || de.Archived)
      return (false, new List<string> { "roster entry not found" });
    if ((de.Tags ?? "").Split(",").Any(t => string.Equals(t.Trim(), "recovered", StringComparison.OrdinalIgnoreCase)))
      missing.Add("recovered placeholder: complete the profile or run grounded research");
    if (string.IsNullOrWhiteSpace(de.Name)) missing.Add("name");
    if (string.IsNullOrWhiteSpace(de.Description)) missing.Add("description");
    var dpj = (de.ProfileJson ?? "").Trim();
    if (dpj.Length < 20) missing.Add("profile");
    if (de.ResearchRequested && de.ResearchedAt is null && RosterOps.ResearchTerminalStatus(de) != "unsupported") missing.Add(RosterOps.ResearchMissingReason(s, de));
    return (missing.Count == 0, missing);
  }

  public static (bool complete, List<string> missing) Completeness(InMemoryStore s, Guid rosterId)
  {
    var missing = new List<string>();
    if (!s.Roster.TryGetValue(rosterId, out var entry) || entry.Archived)
      return (false, new List<string> { "roster entry not found" });
    if ((entry.Tags ?? "").Split(",").Any(t => string.Equals(t.Trim(), "recovered", StringComparison.OrdinalIgnoreCase)))
      missing.Add("recovered placeholder: complete the profile or run grounded research");
    if (string.IsNullOrWhiteSpace(entry.Name)) missing.Add("name");
    if (string.IsNullOrWhiteSpace(entry.Description)) missing.Add("description");
    var pj = (entry.ProfileJson ?? "").Trim();
    if (pj.Length < 20) missing.Add("profile");
    if (entry.ResearchRequested && entry.ResearchedAt is null && RosterOps.ResearchTerminalStatus(entry) != "unsupported") missing.Add(RosterOps.ResearchMissingReason(s, entry));
    if (!s.Images.Values.Any(i => i.RosterEntryId == rosterId)) missing.Add("portrait");
    return (missing.Count == 0, missing);
  }

  // Lane A: live research jobs distinguish actual running work from persisted
  // orphaned ResearchJobId after restart. Orphans are retryable, never permanent 409.
  private static readonly ConcurrentDictionary<string, bool> LiveResearchJobs = new();

  public static bool IsLiveResearchJob(string jobId) =>
    !string.IsNullOrEmpty(jobId) && LiveResearchJobs.ContainsKey(jobId);

  public static void MarkLiveResearchJob(string jobId)
  {
    if (!string.IsNullOrEmpty(jobId)) LiveResearchJobs[jobId] = true;
  }

  public static void ClearLiveResearchJob(string jobId)
  {
    if (!string.IsNullOrEmpty(jobId)) LiveResearchJobs.TryRemove(jobId, out _);
  }

  public static bool IsPortraitAccepted(AdvisorImage img) =>
    img.Review == "accepted" || img.Review == "grandfathered";

  // Exact selected portrait identity: actual provenance selection first, then
  // linked rows. A full-ID provenance match within the same roster scope wins
  // even when several images link to this advisor (legacy double-link rows).
  // Legacy truncated 8-char prefixes resolve only when they match exactly one
  // same-roster image. An ambiguous or unresolvable explicit selection is
  // rejected (null) rather than rescued by an arbitrary accepted upload.
  // With no explicit provenance a single linked row wins, while conflicting
  // links resolve to null instead of guessing the newest upload.
  public static AdvisorImage? ResolveSelectedImage(InMemoryStore s, BoardAdvisor a)
  {
    if (!string.IsNullOrWhiteSpace(a.ImageProvenance) && a.ImageProvenance != "initials")
    {
      foreach (var part in a.ImageProvenance.Split((char)58))
      {
        var trimmed = part.Trim();
        if (Guid.TryParse(trimmed, out var gid)
            && s.Images.TryGetValue(gid, out var byId)
            && byId.RosterEntryId == a.RosterEntryId)
          return byId;
      }
      foreach (var part in a.ImageProvenance.Split((char)58))
      {
        var trimmed = part.Trim();
        if (trimmed.Length == 8 && trimmed.All(char.IsAsciiHexDigit))
        {
          var matches = s.Images.Values
            .Where(i => i.RosterEntryId == a.RosterEntryId
              && i.Id.ToString("D").StartsWith(trimmed, StringComparison.OrdinalIgnoreCase))
            .ToList();
          if (matches.Count == 1) return matches[0];
          return null; // zero or ambiguous legacy prefix: reject, never guess
        }
      }
      return null; // explicit selection that resolves to nothing: invalid
    }
    var linked = s.Images.Values.Where(i => i.BoardAdvisorId == a.Id).ToList();
    if (linked.Count == 1) return linked[0];
    return null; // none, or conflicting links: never guess newest upload
  }

  public static bool HasExplicitPortraitSelection(BoardAdvisor a) =>
    !string.IsNullOrWhiteSpace(a.ImageProvenance) && a.ImageProvenance != "initials";

  // Exact identity/state for activation hashing: selected image wins; legacy
  // no-selection falls back to a deterministic accepted image; explicit
  // invalid selections stay distinct so they cannot be rescued.
  public static string ReviewedPortraitFingerprint(InMemoryStore s, BoardAdvisor a)
  {
    var sel = ResolveSelectedImage(s, a);
    if (sel is not null)
      return "portrait:" + sel.Id + ":review:" + sel.Review + ":prov:" + sel.Provenance + ":kind:" + sel.Kind;
    if (HasExplicitPortraitSelection(a))
      return "portrait:invalid:" + a.ImageProvenance;
    var legacy = s.Images.Values
      .Where(i => i.RosterEntryId == a.RosterEntryId && IsPortraitAccepted(i))
      .OrderBy(i => i.CreatedAt).ThenBy(i => i.Id)
      .FirstOrDefault();
    if (legacy is not null)
      return "legacy:" + legacy.Id + ":review:" + legacy.Review + ":prov:" + legacy.Provenance + ":kind:" + legacy.Kind;
    return "portrait:none";
  }

  // Shared reviewed-input boundary for discussion/activation: roster identity,
  // version, profile hash, subject, research job/state, archive flag, plus the
  // resolved portrait identity. Capture before the model call and compare at
  // commit to detect edits/sync/review races. Does not itself force Approved.
  public static string ReviewedInputFingerprint(InMemoryStore s, BoardAdvisor a)
  {
    if (!s.Roster.TryGetValue(a.RosterEntryId, out var rent) || rent is null)
      return "missing:" + a.RosterEntryId + ":" + a.RosterVersion + ":portrait:[" + ReviewedPortraitFingerprint(s, a) + "]";
    string profileHash;
    try { profileHash = Hashing.HashOf(rent.ProfileJson ?? "{}"); }
    catch { profileHash = "hash-error"; }
    var subject = rent.Name + " (" + rent.Type + ")";
    var researchedAt = rent.ResearchedAt.HasValue ? rent.ResearchedAt.Value.ToString("o") : "null";
    var portraitFp = ReviewedPortraitFingerprint(s, a);
    return "roster:" + rent.Id + ":v:" + rent.Version + ":profile:" + profileHash + ":subject:" + subject + ":job:" + rent.ResearchJobId + ":base:" + rent.ResearchBaseVersion + ":req:" + rent.ResearchRequested + ":at:" + researchedAt + ":ev:" + rent.EvidenceCount + ":arch:" + rent.Archived + ":portrait:[" + portraitFp + "]";
  }

  // Approval binds to the reviewed portrait/profile: an explicitly accepted
  // portrait (Review == "accepted" or grandfathered) is required for the exact
  // selected image. Legacy/empty reviews are pending, never implicitly accepted.
  // Explicit invitation compatibility is preserved: this gate does not itself
  // force the Approved boolean; lane B enforces approval unless explicitly invited.
  public static string? ParticipationGate(InMemoryStore s, BoardAdvisor advisor)
  {
    if (advisor.Removed) return "removed";
    if (!s.Roster.TryGetValue(advisor.RosterEntryId, out var entry) || entry.Archived) return "archived-entry";
    return DataCompleteness(s, entry.Id).complete ? null : "profile-incomplete";
  }

  public static string? ApprovalGate(InMemoryStore s, BoardAdvisor a)
  {
    if (a.Removed) return "removed";
    if (!s.Roster.TryGetValue(a.RosterEntryId, out var rent) || rent.Archived) return "archived-entry";
    if (a.RosterVersion != rent.Version) return "stale-version";
    // BACKEND-PROFILE HOOK (cherry-pick note): recovered reconstructions stay
    // explicitly incomplete until the owner completes the profile (removes the
    // "recovered" tag) or grounded research completes with evidence (which
    // strips the tag). Portrait acceptance alone never unblocks approval.
    if ((rent.Tags ?? "").Split(",").Any(t => string.Equals(t.Trim(), "recovered", StringComparison.OrdinalIgnoreCase))) return "recovered-incomplete";
    if (rent.ResearchRequested && rent.ResearchedAt is null)
    {
      // Terminal research states fail closed with honest codes: a finished-but-
      // ungrounded run ("unsupported") may stage copies but never approve without
      // grounded evidence; failed/interrupted runs must rerun first.
      var terminal = RosterOps.ResearchTerminalStatus(rent);
      if (terminal == "unsupported") return "research-unsupported";
      if (terminal == "failed") return "research-failed";
      if (terminal == "superseded") return "research-interrupted";
      return "research-pending";
    }
    if (rent.ResearchRequested && rent.EvidenceCount < 1) return "no-evidence";
    var sel = ResolveSelectedImage(s, a);
    if (sel is not null)
    {
      if (sel.RosterEntryId != a.RosterEntryId) return "portrait-pending";
      if (!IsPortraitAccepted(sel)) return "portrait-pending";
      return null;
    }
    if (HasExplicitPortraitSelection(a)) return "portrait-pending";
    var legacy = s.Images.Values
      .Where(i => i.RosterEntryId == a.RosterEntryId && IsPortraitAccepted(i))
      .OrderBy(i => i.CreatedAt).ThenBy(i => i.Id)
      .FirstOrDefault();
    if (legacy is null) return "portrait-pending";
    return null;
  }

  // Server-controlled owner identity: creator identity is set server-side.
  // Legacy ownerless templates require BOARD-scoped management on linked boards
  // (all linked boards, since the template affects each). Meeting-scoped grants
  // and management on unrelated boards never permit writes. Demo owner preserved.
  // An ownerless template with no linked boards has no appropriate board scope:
  // non-owner writes are denied even with an unrelated management grant.
  public static bool CanWriteRoster(InMemoryStore s, HttpRequest req, RosterEntry entry)
  {
    if (PeopleOps.HasInvalidToken(s, req)) return false;
    if (PeopleOps.IsOwner(req)) return true;
    var user = PeopleOps.UserOf(s, req);
    if (!string.IsNullOrWhiteSpace(entry.OwnerKey))
      return string.Equals(entry.OwnerKey, user, StringComparison.OrdinalIgnoreCase);
    // BACKEND-PROFILE HOOK (cherry-pick note): blank legacy OwnerKey resolves ONLY via
    // strict history-aware ownership (removed links count as evidence; unknown, missing,
    // or conflicting owners fail closed). A conflicting or unknown owner denies the write
    // outright: board grants never override ownership ambiguity, so a removed link can
    // never silently transfer the entry to another account. Unanimous ownership (including
    // unanimous removed-link history) grants the single owner; grant holders still qualify
    // through the linked-board grant rule below.
    var strictOwner = RosterLegacyAccess.MutationOwnerKey(s, entry.Id);
    if (strictOwner is null) return false;
    if (string.Equals(strictOwner, user, StringComparison.OrdinalIgnoreCase)) return true;
    var linked = s.Advisors.Values
      .Where(a => a.RosterEntryId == entry.Id && !a.Removed)
      .Select(a => a.BoardId).Distinct().ToList();
    if (linked.Count > 0)
    {
      foreach (var bid in linked)
      {
        var okBid = s.Grants.Values.Any(g => string.Equals(g.UserKey, user, StringComparison.OrdinalIgnoreCase)
          && g.BoardId == bid
          && (g.Access == "manage" || g.Access == "open")
          && g.MeetingId == null);
        if (!okBid) return false;
      }
      return true;
    }
    return false;
  }

  // Editing profile content invalidates the old dossier: support, timestamps
  // Editing research IDENTITY/inputs (name, description, background) invalidates the old
  // dossier: support, timestamps and counts reset and board copies unapprove until
  // research reruns. Preserves ResearchRequested=true so failed/started research still blocks approval.
  public static void InvalidateDossier(InMemoryStore s, RosterEntry entry)
  {
    entry.ResearchJson = "{}";
    entry.ResearchedAt = null;
    entry.EvidenceCount = 0;
    entry.ResearchJobId = "";
    entry.ResearchBaseVersion = entry.Version;
    UnapproveBoardCopies(s, entry.Id);
  }

  // Finalizing BEHAVIOR (the 3 editable paragraphs, or other profile/metadata edits)
  // without changing research identity/inputs preserves the pinned research proof:
  // ResearchJson dossier, ResearchedAt and EvidenceCount survive; the canonical
  // version still bumps and board copies still unapprove for renewed review.
  // The save is recorded on the dossier (draftStatus "saved" + profile hash) so
  // reload shows what was finalized against which research version.
  public static void PreserveResearchOnBehaviorSave(RosterEntry entry, string savedProfileJson)
  {
    try
    {
      using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(entry.ResearchJson) ? "{}" : entry.ResearchJson);
      if (doc.RootElement.ValueKind != JsonValueKind.Object) return;
      var hasDraft = doc.RootElement.TryGetProperty("draftProfile", out _)
        || doc.RootElement.TryGetProperty("claims", out _);
      if (!hasDraft) return;
      var draftStatus = doc.RootElement.TryGetProperty("draftStatus", out var ds) && ds.ValueKind == JsonValueKind.String
        ? (ds.GetString() ?? "") : "";
      var payload = new Dictionary<string, object?>();
      foreach (var p in doc.RootElement.EnumerateObject())
      {
        if (p.NameEquals("draftStatus") || p.NameEquals("savedAt") || p.NameEquals("savedProfileHash")) continue;
        payload[p.Name] = JsonSerializer.Deserialize<object?>(p.Value.GetRawText());
      }
      payload["draftStatus"] = string.Equals(draftStatus, "failed", StringComparison.OrdinalIgnoreCase)
        || string.Equals(draftStatus, "unsupported", StringComparison.OrdinalIgnoreCase)
        ? draftStatus : "saved";
      payload["savedAt"] = DateTime.UtcNow;
      try { payload["savedProfileHash"] = Hashing.HashOf(savedProfileJson); }
      catch { payload["savedProfileHash"] = "hash-error"; }
      entry.ResearchJson = JsonSerializer.Serialize(payload);
    }
    catch (JsonException) { }
  }

  // research identity = the subject research was ABOUT. Subject changes
  // invalidate the dossier; paragraph-only edits preserve it (see above).
  public static bool IsSubjectChange(string? oldProfileJson, string? newProfileJson)
  {
    // A new profile that omits background entirely is paragraph-only w.r.t.
    // identity: it must not invalidate the dossier or wipe persisted inputs.
    // An explicitly present background (even empty) IS an identity statement.
    if (!HasBackgroundProperty(newProfileJson)) return false;
    TryProfileBackground(newProfileJson, out var newBg);
    var oldBg = HasBackgroundProperty(oldProfileJson) && TryProfileBackground(oldProfileJson, out var ob) ? ob : "";
    return !string.Equals(oldBg, newBg, StringComparison.Ordinal);
  }

  public static bool HasBackgroundProperty(string? profileJson)
  {
    try
    {
      using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(profileJson) ? "{}" : profileJson);
      return doc.RootElement.ValueKind == JsonValueKind.Object
        && doc.RootElement.TryGetProperty("background", out var b) && b.ValueKind == JsonValueKind.String;
    }
    catch (JsonException) { return false; }
  }

  public static bool TryProfileBackground(string? profileJson, out string background)
  {
    background = "";
    try
    {
      using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(profileJson) ? "{}" : profileJson);
      if (doc.RootElement.ValueKind != JsonValueKind.Object) return false;
      if (doc.RootElement.TryGetProperty("background", out var b) && b.ValueKind == JsonValueKind.String)
        background = (b.GetString() ?? "").Trim();
      return true;
    }
    catch (JsonException) { background = ""; return false; }
  }

  public static string ProfileBackground(string? profileJson) =>
    TryProfileBackground(profileJson, out var bg) ? bg : "\u0000unparseable";

  public static bool SameSourceUrls(string? inputsJson, List<string> urls)
  {
    // Strict URI identity: /Case vs /case, query case, trailing slash are distinct inputs.
    var stored = CharacterBehavior.ParseInputs(inputsJson).SourceUrls;
    var rhs = urls ?? new List<string>();
    var da = new List<string>();
    foreach (var u in stored) SimCEO.Api.Work.EvidenceUri.AddDistinct(da, u);
    var db = new List<string>();
    foreach (var u in rhs) SimCEO.Api.Work.EvidenceUri.AddDistinct(db, u);
    if (da.Count != db.Count) return false;
    foreach (var u in da) if (!SimCEO.Api.Work.EvidenceUri.ContainsStrict(db, u)) return false;
    return true;
  }
  public static void UnapproveBoardCopies(InMemoryStore s, Guid rosterId)
  {
    foreach (var a in s.Advisors.Values.Where(a => a.RosterEntryId == rosterId && !a.Removed && a.Approved).ToList())
    {
      a.Approved = false;
      s.Advisors[a.Id] = a;
    }
    s.Advisors.Flush();
  }

  public static string CharacterJson(string name, string role, string problem) =>
    JsonSerializer.Serialize(new
    {
      fictional = true,
      name, role, problem,
      background = $"Fictional {role} created for advisory discussion. No real employment, degrees, licenses, publications, or endorsements are claimed.",
      strengths = new[] { $"{role} methods", "practical tradeoffs", "risk surfacing" },
      canHandle = new[] { problem },
      methods = new[] { "structured comparison", "assumption check", "next-step proposal" },
      evidenceNeeded = new[] { "approved board sources", "board-lead brief" },
      limits = new[] { "defers outside specialty", "abstains without evidence", "never overrides board instructions" },
      challengeTriggers = new[] { "unsupported premise", "missing risk" },
      collaboration = "direct, concise, cites evidence",
      capability = new
      {
        lead = new[] { role },
        contribute = new[] { "options", "risks" },
        defer = new[] { "final decisions", "unrelated specialties" },
      },
    });
}

public static class RosterEndpoints
{

  // Resource ownership/readability for direct roster reads: owner, installation admin,
  // or a board-level read on a board the entry is attached to.
  internal static bool CanReadRoster(InMemoryStore s, HttpRequest req, RosterEntry entry)
  {
    var me = PeopleOps.UserOf(s, req);
    if (PeopleOps.IsInstallationAdmin(s, me)) return true;
    if (RosterLegacyAccess.OwnerMatches(s, entry, me)) return true;
    try
    {
      return s.Advisors.Values.Any(a => a.RosterEntryId == entry.Id && !a.Removed
        && PeopleOps.Can(s, req, a.BoardId, null, "read"));
    }
    catch { return false; }
  }

  // ai-draft structured prompts (P1-F2): dossier requests the mapper-required
  // KIND/EVIDENCE grammar; profile is built from VERIFIED claims only, never
  // raw dossier text, so unsupported notes cannot steer the profile.
  public static string BuildAiDraftDossierPrompt(string name, string role, string focus)
  {
    return "Research this fictional advisor persona for a business advisory board. Name: " + (name ?? "").Trim() + ". Role: " + (role ?? "").Trim() + ". Focus: " + (focus ?? "").Trim() + "."
      + " Web search is enabled; for web-discovered sources cite the full https URL plus the exact quote from the retrieved passage."
      + " Return ONE claim per line in EXACT format: KIND | claim text || EVIDENCE: <full-url> :: \"<exact supporting quote>\" [ ;; <full-url> :: \"<exact quote>\" ]"
      + " Where KIND is FACT (directly supported by the quoted passage) or INTERPRETATION (inference that still needs a quote showing its basis, or leave EVIDENCE empty when no source supports it)."
      + " Rules: the exact quote must appear verbatim (whitespace-normalized) in that source retrieval excerpt; do not invent URLs or quotes; do not copy the same source onto unrelated claims; leave EVIDENCE empty when no passage supports the claim. Do not use VERIFIED prefix; use KIND. Distinguish facts from interpretation via KIND only.";
  }

  public static string BuildAiDraftProfilePrompt(string name, string role, string focus, string groundedDossier)
  {
    var dossierPart = string.IsNullOrWhiteSpace(groundedDossier)
      ? "(no verified grounded claims; draft from the owner seed and explicit limits only; do not invent grounding)"
      : groundedDossier;
    return "Draft a fictional advisor profile as ONLY a JSON object (no code fences, no commentary) with keys: background, strengths (array of 3), methods (array of 3), evidenceNeeded (array), limits (array of 3), collaboration (string). Persona: " + (name ?? "").Trim() + ", " + (role ?? "").Trim() + ", focus: " + (focus ?? "").Trim() + "."
      + " Verified grounded claims (only these plus the seed may inform behavior; unverified notes excluded): " + dossierPart
      + " Explicit limits: never invent real-world credentials, employment, degrees, licenses, or endorsements; abstain where evidence is missing or the topic is outside the seed."
      + " State that the advisor is fictional with no real employment, degrees, licenses, or endorsements.";
  }

  public static void MapRoster(this WebApplication app)
  {
    var gw = new ModelGateway(app.Services.GetRequiredService<InMemoryStore>());

    app.MapGet("/api/roster/{id:guid}/boards", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (PeopleOps.IsSecure(s) && !AuthOps.TrySession(s, req, out _)) return Results.Json(new { error = "Authentication required." }, statusCode: 401);
      if (!s.Roster.TryGetValue(id, out var __be) || __be.Archived) return Results.NotFound();
      if (PeopleOps.IsSecure(s) && !CanReadRoster(s, req, __be)) return PeopleOps.Denied();
      if (PeopleOps.IsSecure(s) && !PeopleOps.IsInstallationAdmin(s, PeopleOps.UserOf(s, req)))
        return Results.Ok(s.Advisors.Values.Where(a => a.RosterEntryId == id && !a.Removed && PeopleOps.Can(s, req, a.BoardId, null, "read"))
          .Select(a => new
          {
            boardId = a.BoardId,
            board = s.Boards.TryGetValue(a.BoardId, out var __bf) ? __bf.Name : "?",
            role = a.BoardRole,
            approved = a.Approved,
          }).ToList());
      return Results.Ok(RosterOps.BoardsFor(s, id));
    });

    app.MapPost("/api/roster/{id:guid}/copy", (InMemoryStore s, HttpRequest req, Guid id, JsonElement body) =>
    {
      var boardId = body.TryGetProperty("boardId", out var b) ? b.GetGuid() : Guid.Empty;
      if (PeopleOps.BadToken(s, req) is { } badCopy) return badCopy;
      if (PeopleOps.Check(s, req, boardId, null, "manage") is { } deniedCopy) return deniedCopy;
      // Source authorization: caller must own the template, be installation admin,
      // or read a board the template is already attached to.
      if (!s.Roster.TryGetValue(id, out var __srcCp) || __srcCp.Archived) return Results.NotFound("Roster entry not found.");
      bool __canSrcCp = false;
      {
        var __meCp = PeopleOps.UserOf(s, req);
        __canSrcCp = PeopleOps.IsInstallationAdmin(s, __meCp)
          || string.Equals(__srcCp.OwnerKey ?? "", __meCp, StringComparison.OrdinalIgnoreCase)
          || string.Equals(RosterLegacyAccess.EffectiveOwnerKey(s, __srcCp) ?? "", __meCp, StringComparison.OrdinalIgnoreCase)
          || s.Advisors.Values.Any(a => a.RosterEntryId == id && !a.Removed && PeopleOps.Can(s, req, a.BoardId, null, "read"));
        if (!__canSrcCp) return PeopleOps.Denied();
      }
      var role = body.TryGetProperty("boardRole", out var r) ? (r.GetString() ?? "") : "";
      var (copy, error, status) = RosterOps.TryCopy(s, id, boardId, role, callerCanReadRoster: __canSrcCp, canAttachBoard: true);
      return copy is not null ? Results.Created($"/api/boards/{boardId}/advisors/{copy.Id}", copy)
        : Results.Json(new { error }, statusCode: status);
    });

    app.MapPut("/api/roster/{id:guid}", (InMemoryStore s, HttpRequest req, Guid id, JsonElement body) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badPut) return badPut;
      if (!s.Roster.TryGetValue(id, out var probe) || probe.Archived) return Results.NotFound();
      if (!RosterOps.CanWriteRoster(s, req, probe)) return PeopleOps.Denied();
      string? newName = null;
      var nameProvided = false;
      if (body.TryGetProperty("name", out var n) && n.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(n.GetString()))
      {
        newName = n.GetString()!.Trim();
        nameProvided = true;
      }
      string? newDesc = null;
      var descProvided = false;
      if (body.TryGetProperty("description", out var d) && d.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(d.GetString()))
      {
        newDesc = d.GetString()!.Trim();
        descProvided = true;
      }
      if (nameProvided && newName!.Trim().Length > 120) return Results.BadRequest("Name must be 120 chars or fewer.");
      if (descProvided && newDesc!.Trim().Length > CharacterBehavior.MaxBackgroundChars) return Results.BadRequest("Description must be 4000 chars or fewer.");
      string? newProfile = null;
      var profileProvided = false;
      if (body.TryGetProperty("profileJson", out var pp)
          && pp.ValueKind != JsonValueKind.Null && pp.ValueKind != JsonValueKind.Undefined)
      {
        if (pp.ValueKind != JsonValueKind.String && pp.ValueKind != JsonValueKind.Object)
          return Results.BadRequest("profileJson must be a JSON object or a JSON-encoded object string.");
        var pj = pp.ValueKind == JsonValueKind.String ? (pp.GetString() ?? "") : pp.GetRawText();
        if (pj.Trim().Length < 20) return Results.BadRequest("Profile must be at least 20 characters.");
        if (pj.Length > CharacterBehavior.MaxProfileJsonChars) return Results.BadRequest("Profile must be " + CharacterBehavior.MaxProfileJsonChars + " chars or fewer (got " + pj.Length + "). Shorten paragraphs instead of embedding documents.");
        var (pok, perr, _) = CharacterBehavior.ValidateSavedProfile(pj);
        if (!pok) return Results.BadRequest(perr);
        newProfile = pj;
        profileProvided = true;
      }
      List<string>? newSourceUrls = null;
      var urlsProvided = false;
      if (body.TryGetProperty("sourceUrls", out var psu) && psu.ValueKind == JsonValueKind.Array)
      {
        var (uok, uerr, urls) = CharacterBehavior.ValidateSourceUrls(body);
        if (!uok) return Results.BadRequest(uerr);
        newSourceUrls = urls;
        urlsProvided = true;
      }
      else if (body.TryGetProperty("sourceUrls", out var psuBad) && psuBad.ValueKind != JsonValueKind.Null && psuBad.ValueKind != JsonValueKind.Undefined)
        return Results.BadRequest("sourceUrls must be an array of up to " + CharacterBehavior.MaxSourceUrls + " http(s) URLs.");
      string? newTags = null;
      var tagsProvided = false;
      if (body.TryGetProperty("tags", out var tt) && tt.ValueKind == JsonValueKind.String)
      {
        newTags = tt.GetString() ?? "";
        tagsProvided = true;
      }
      lock (s.SetupLock)
      {
        if (!s.Roster.TryGetValue(id, out var entry) || entry.Archived) return Results.NotFound();
        if (!RosterOps.CanWriteRoster(s, req, entry)) return PeopleOps.Denied();
        var profileChanged = false;
        if (nameProvided && newName != entry.Name) profileChanged = true;
        if (descProvided && newDesc != entry.Description) profileChanged = true;
        if (profileProvided && newProfile != entry.ProfileJson) profileChanged = true;
        // Research identity vs behavior finalization: name/description/background
        // changes invalidate the dossier (research was ABOUT the old subject);
        // paragraph-only edits preserve the pinned research proof while the
        // canonical version still bumps and copies still unapprove for review.
        var subjectChanged = (nameProvided && newName != entry.Name)
          || (descProvided && newDesc != entry.Description)
          || (profileProvided && RosterOps.IsSubjectChange(entry.ProfileJson, newProfile))
          || (urlsProvided && !RosterOps.SameSourceUrls(entry.ResearchInputsJson, newSourceUrls ?? new List<string>()));
        RosterEntry? applied = null;
        try
        {
          Atomic.Run(s, () =>
          {
            if (!s.Roster.TryGetValue(id, out var cur) || cur is null || cur.Archived) throw new InvalidOperationException("gone");
            if (!RosterOps.CanWriteRoster(s, req, cur)) throw new UnauthorizedAccessException("Access revoked or not granted for this scope.");
            var backgroundChanged = profileProvided && RosterOps.IsSubjectChange(cur.ProfileJson, newProfile);
            if (nameProvided) cur.Name = newName!;
            if (descProvided) cur.Description = newDesc!;
            if (profileProvided) cur.ProfileJson = newProfile!;
            if (tagsProvided) cur.Tags = newTags!;
            cur.Version += 1;
            cur.UpdatedAt = DateTime.UtcNow;
            if (backgroundChanged || urlsProvided)
            {
              var inp = CharacterBehavior.ParseInputs(cur.ResearchInputsJson);
              var bg = inp.Background;
              // Sync the persisted background ONLY on an actual canonical background change versus the fresh stored profile (never on mere property presence): paragraph-only full-profile saves keep the exact B1/URLs/focus inputs and their proof.
              if (backgroundChanged && RosterOps.TryProfileBackground(newProfile, out var newBg)) bg = newBg;
              var urls = urlsProvided && newSourceUrls is not null ? newSourceUrls : inp.SourceUrls;
              cur.ResearchInputsJson = CharacterBehavior.SerializeInputs(bg, urls, inp.Focus);
            }
            if (subjectChanged) RosterOps.InvalidateDossier(s, cur);
            else
            {
              if (profileChanged && profileProvided) RosterOps.PreserveResearchOnBehaviorSave(cur, newProfile!);
              RosterOps.UnapproveBoardCopies(s, id);
            }
            s.Roster[cur.Id] = cur;
            applied = cur;
          });
          Atomic.Audit(s, new AuditEvent { Action = "roster.edit", Detail = JsonSerializer.Serialize(new { entry = applied!.Id, version = applied!.Version }) });
        }
        catch (UnauthorizedAccessException) { return PeopleOps.Denied(); }
        catch (InvalidOperationException iox) when (CommitOutcome.IsMissing(iox, "gone")) { return Results.NotFound(); }
        catch (InvalidOperationException iox) { return CommitOutcome.StorageFault("Roster edit", iox); }
        catch (Exception ex) { return CommitOutcome.MapCommitFailure(ex, "Roster edit") ?? Results.Json(new { error = "Roster edit failed; no state changed: " + ex.Message }, statusCode: 500); }
        if (applied is null) return Results.NotFound();
        return Results.Ok(applied);
      }
    });    app.MapPost("/api/roster/{id:guid}/archive", (InMemoryStore s, HttpRequest req, Guid id, JsonElement body) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badArch) return badArch;
      if (!s.Roster.TryGetValue(id, out var probeArch)) return Results.NotFound();
      if (!RosterOps.CanWriteRoster(s, req, probeArch)) return PeopleOps.Denied();
      var archived = body.ValueKind == JsonValueKind.Object && body.TryGetProperty("archived", out var aa)
        ? aa.GetBoolean() : true;
      lock (s.SetupLock)
      {
        if (!s.Roster.TryGetValue(id, out var entry)) return Results.NotFound();
        if (!RosterOps.CanWriteRoster(s, req, entry)) return PeopleOps.Denied();
        RosterEntry? saved = null;
        try
        {
          Atomic.Run(s, () =>
          {
            if (!s.Roster.TryGetValue(id, out var cur) || cur is null) throw new InvalidOperationException("gone");
            if (!RosterOps.CanWriteRoster(s, req, cur)) throw new UnauthorizedAccessException("Access revoked or not granted for this scope.");
            cur.Archived = archived;
            cur.UpdatedAt = DateTime.UtcNow;
            RosterOps.UnapproveBoardCopies(s, id);
            s.Roster[cur.Id] = cur;
            saved = cur;
          });
        }
        catch (UnauthorizedAccessException) { return PeopleOps.Denied(); }
        catch (InvalidOperationException iox) when (CommitOutcome.IsMissing(iox, "gone")) { return Results.NotFound(); }
        catch (InvalidOperationException iox) { return CommitOutcome.StorageFault("Roster archive", iox); }
        catch (Exception ex) { return CommitOutcome.MapCommitFailure(ex, "Roster archive") ?? Results.Json(new { error = "Roster archive failed; no state changed: " + ex.Message }, statusCode: 500); }
        if (saved is null) return Results.NotFound();
        return Results.Ok(saved);
      }
    });

    app.MapPost("/api/boards/{bid:guid}/advisors/{aid:guid}/sync-roster", (InMemoryStore s, HttpRequest req, Guid bid, Guid aid) =>
    {
      if (PeopleOps.Check(s, req, bid, null, "manage") is { } deniedSync) return deniedSync;
      if (!s.Advisors.TryGetValue(aid, out var probeSync) || probeSync.BoardId != bid || probeSync.Removed) return Results.NotFound();
      if (!s.Roster.TryGetValue(probeSync.RosterEntryId, out var probeEntry)) return Results.NotFound("roster entry");
      lock (s.SetupLock)
      {
        if (!s.Advisors.TryGetValue(aid, out var a) || a.BoardId != bid || a.Removed) return Results.NotFound();
        if (!s.Roster.TryGetValue(a.RosterEntryId, out var entry)) return Results.NotFound("roster entry");
        var ver = entry.Version;
        Atomic.Run(s, () =>
        {
          a.RosterVersion = ver;
          a.Approved = false;
          s.Advisors[a.Id] = a;
          s.Advisors.Flush();
        });
        Atomic.Audit(s, new AuditEvent { BoardId = bid, Action = "roster.sync", Detail = JsonSerializer.Serialize(new { advisor = aid, version = ver, reapproval = true }) });
        return Results.Ok(a);
      }
    });

    app.MapPost("/api/roster/character", (InMemoryStore s, HttpRequest req, JsonElement body) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badChar) return badChar;
      var accountId = body.TryGetProperty("accountId", out var ac) && Guid.TryParse(ac.GetString(), out var ag) ? ag : Guid.Empty;
      var role = body.TryGetProperty("role", out var r) ? (r.GetString() ?? "") : "";
      var problem = body.TryGetProperty("problem", out var p) ? (p.GetString() ?? "") : "";
      var name = body.TryGetProperty("name", out var n) ? (n.GetString() ?? "Unnamed character") : "Unnamed character";
      if (string.IsNullOrWhiteSpace(role) || string.IsNullOrWhiteSpace(problem))
        return Results.BadRequest("role and problem are required; the rest is generated as a draft.");
      if (name.Trim().Length > 120) return Results.BadRequest("Name must be 120 chars or fewer.");
      if (role.Trim().Length > 500) return Results.BadRequest("Role must be 500 chars or fewer.");
      if (problem.Trim().Length > 4000) return Results.BadRequest("Problem must be 4000 chars or fewer.");
      var hasDescription = body.TryGetProperty("description", out var dd) && !string.IsNullOrWhiteSpace(dd.GetString());
      // The full role/problem remain in CharacterJson; keep the generated
      // summary within its own limit when both seed fields are at capacity.
      var descText = hasDescription ? dd.GetString()! : role + " helping with: " + problem;
      if (!hasDescription && descText.Length > 4000) descText = descText[..4000];
      if (descText.Trim().Length > 4000) return Results.BadRequest("Description must be 4000 chars or fewer.");
      string suppliedProfile = "";
      if (body.TryGetProperty("profileJson", out var pj))
      {
        if (pj.ValueKind == JsonValueKind.Object) suppliedProfile = pj.GetRawText();
        else if (pj.ValueKind == JsonValueKind.String) suppliedProfile = pj.GetString() ?? "";
      }
      if (!string.IsNullOrWhiteSpace(suppliedProfile))
      {
        if (suppliedProfile.Trim().Length < 20) return Results.BadRequest("Provided profile must be at least 20 characters.");
        if (suppliedProfile.Length > CharacterBehavior.MaxProfileJsonChars) return Results.BadRequest("Profile must be " + CharacterBehavior.MaxProfileJsonChars + " chars or fewer.");
        try
        {
          using var pjDoc = JsonDocument.Parse(suppliedProfile);
          if (pjDoc.RootElement.ValueKind == JsonValueKind.Object)
          {
            var (cvok, cverr, _) = CharacterBehavior.ValidateSavedProfile(suppliedProfile);
            if (!cvok) return Results.BadRequest(cverr);
          }
          else if (suppliedProfile.Length > CharacterBehavior.MaxProfileJsonChars)
            return Results.BadRequest("Profile must be " + CharacterBehavior.MaxProfileJsonChars + " chars or fewer.");
        }
        catch (JsonException) { return Results.BadRequest("Provided profileJson must be a JSON object."); }
      }
      var entry = new RosterEntry
      {
        Id = Guid.NewGuid(), AccountId = accountId, OwnerKey = PeopleOps.UserOf(s, req), Type = AdvisorType.FictionalCharacter,
        Name = name,
        Description = descText,
        ProfileJson = string.IsNullOrWhiteSpace(suppliedProfile) ? RosterOps.CharacterJson(name, role, problem) : suppliedProfile,
        Version = 1, UpdatedAt = DateTime.UtcNow,
      };
      if (body.TryGetProperty("tags", out var t)) entry.Tags = t.GetString() ?? "";
      var newEntry = entry;
      try
      {
        Atomic.Run(s, () => { s.Roster[newEntry.Id] = newEntry; });
      }
      catch (Exception ex) { return CommitOutcome.MapCommitFailure(ex, "Roster creation") ?? Results.Json(new { error = "Roster creation failed; no state changed: " + ex.Message }, statusCode: 500); }
      return Results.Created($"/api/roster/{newEntry.Id}", newEntry);
    });

    app.MapGet("/api/roster/{id:guid}/completeness", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (PeopleOps.IsSecure(s) && !AuthOps.TrySession(s, req, out _)) return Results.Json(new { error = "Authentication required." }, statusCode: 401);
      if (!s.Roster.TryGetValue(id, out var __ce) || __ce.Archived) return Results.NotFound();
      if (PeopleOps.IsSecure(s) && !CanReadRoster(s, req, __ce)) return PeopleOps.Denied();
      var (ok, missing) = RosterOps.Completeness(s, id);
      return Results.Ok(new { complete = ok, missing, imageCount = s.Images.Values.Count(i => i.RosterEntryId == id) });
    });


    app.MapPost("/api/roster/quick", (InMemoryStore s, HttpRequest req, JsonElement body) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badQuick) return badQuick;
      var accountId = body.TryGetProperty("accountId", out var qac) && Guid.TryParse(qac.GetString(), out var qag) ? qag : Guid.Empty;
      var name = body.TryGetProperty("name", out var qan) ? (qan.GetString() ?? "") : "";
      var desc = body.TryGetProperty("description", out var qad) ? (qad.GetString() ?? "") : "";
      if (string.IsNullOrWhiteSpace(name)) return Results.BadRequest("Name is required.");
      if (string.IsNullOrWhiteSpace(name.Trim()) || name.Trim().Length > 120) return Results.BadRequest("Name must be 1-120 chars.");
      if (string.IsNullOrWhiteSpace(desc) || desc.Trim().Length < 5) return Results.BadRequest("Description is required (a sentence or more).");
      if (desc.Trim().Length > 4000) return Results.BadRequest("Description must be 4000 chars or fewer.");
      string? background = null;
      if (body.TryGetProperty("background", out var qbg) && qbg.ValueKind == JsonValueKind.String)
      {
        background = (qbg.GetString() ?? "").Trim();
        if (background.Length > 4000) return Results.BadRequest("Background must be 4000 chars or fewer.");
        if (background.Length == 0) background = null;
      }
      var (urlsOk, urlsError, seedUrls) = CharacterBehavior.ValidateSourceUrls(body);
      if (!urlsOk) return Results.BadRequest(urlsError);
      // Seed only: user text verbatim, no invented persona. The 3 behavior keys are present as
      // explicitly-marked seeds so meeting behavior is deterministic before research + explicit save.
      var profile = CharacterBehavior.SeedProfileJson(name, desc, background);
      var entry = new RosterEntry
      {
        Id = Guid.NewGuid(), AccountId = accountId, OwnerKey = PeopleOps.UserOf(s, req), Type = AdvisorType.FictionalCharacter,
        Name = name.Trim(), Description = desc.Trim(), ProfileJson = profile,
        Version = 1, UpdatedAt = DateTime.UtcNow,
        ResearchJson = JsonSerializer.Serialize(new { seed = true }),
        ResearchInputsJson = CharacterBehavior.SerializeInputs(background ?? "", seedUrls),
      };
      if (body.TryGetProperty("tags", out var qtg)) entry.Tags = qtg.GetString() ?? "";
      var quickEntry = entry;
      try
      {
        Atomic.Run(s, () =>
        {
          s.Roster[quickEntry.Id] = quickEntry;
          Atomic.Audit(s, new AuditEvent { Action = "roster.quick", Detail = JsonSerializer.Serialize(new { entry = quickEntry.Id, name }) });
        });
      }
      catch (Exception ex) { return CommitOutcome.MapCommitFailure(ex, "Roster creation") ?? Results.Json(new { error = "Roster creation failed; no state changed: " + ex.Message }, statusCode: 500); }
      return Results.Created($"/api/roster/{quickEntry.Id}", quickEntry);
    });

    app.MapPost("/api/roster/ai-draft", async (InMemoryStore s, HttpRequest req, JsonElement body) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badAi) return badAi;
      if (PeopleOps.Guard(gw, req) is { } cappedAi) return cappedAi;
      var accountId = body.TryGetProperty("accountId", out var aac) && Guid.TryParse(aac.GetString(), out var aag) ? aag : Guid.Empty;
      var name = body.TryGetProperty("name", out var aan) ? (aan.GetString() ?? "") : "";
      var role = body.TryGetProperty("role", out var aar) ? (aar.GetString() ?? "") : "";
      var focus = body.TryGetProperty("focus", out var aaf) ? (aaf.GetString() ?? "") : "";
      if (string.IsNullOrWhiteSpace(name) || string.IsNullOrWhiteSpace(role))
        return Results.BadRequest("name and role are required; focus steers the research.");
      if (name.Trim().Length > 120) return Results.BadRequest("Name must be 120 chars or fewer.");
      if (role.Trim().Length > 500) return Results.BadRequest("Role must be 500 chars or fewer.");
      if (focus.Trim().Length > CharacterBehavior.MaxFocusChars) return Results.BadRequest("Focus must be " + CharacterBehavior.MaxFocusChars + " chars or fewer.");
      ModelGateway.GroundedResult dossier;
      string aiDossierPrompt = BuildAiDraftDossierPrompt(name, role, focus);
      try
      {
        dossier = await gw.CompleteGroundedAsync(ModelPolicy.SparkFor(s, null), "advisor-research",
        aiDossierPrompt,
        ContextBudget.BidTokens, 2048, ownerOverride: PeopleOps.IsOwner(req));
      }
      catch (Exception ex) when (ex is CapExceededException or ProviderException or TaskCanceledException or HttpRequestException or JsonException) { return PeopleOps.ModelError(ex); }
      // Map BEFORE compiling: only verified quote-linked claims may inform the profile.
      var aiPoolMulti = new Dictionary<string, List<SimCEO.Api.Work.PoolPassage>>(StringComparer.Ordinal);
      foreach (var cite in dossier.Citations.Where(c => !string.IsNullOrWhiteSpace(c.Url)))
      {
        if (string.IsNullOrWhiteSpace(cite.Excerpt)) continue;
        string akey = cite.Url.Trim();
        foreach (var k in new List<string>(aiPoolMulti.Keys)) { if (SimCEO.Api.Work.ClaimEvidenceMapper.UrlsMatch(k, akey)) { akey = k; break; } }
        if (!aiPoolMulti.TryGetValue(akey, out var alist)) { alist = new List<SimCEO.Api.Work.PoolPassage>(); aiPoolMulti[akey] = alist; }
        // Propagate actual gateway provenance: provider snippets stay fetched=false/provider-search;
        // successful application fetches stay fetched=true with their origin (never downgraded).
        bool cf = cite.Fetched;
        string co = (cite.Origin ?? "").Trim();
        if (cf && string.IsNullOrWhiteSpace(co)) co = "application-fetch";
        if (!cf) co = "provider-search";
        alist.Add(new SimCEO.Api.Work.PoolPassage(cite.Title ?? "", cite.Excerpt ?? "", cf, co));
      }
      // SID-keyed (S1..Sn), not URL-keyed: keys are case-insensitive identifiers; URL values compare strictly via UrlsMatch.
      var aiSid = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
      var aiLines = dossier.Text.Split((char)10, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).Take(12).ToList();
      var aiValidated = SimCEO.Api.Work.ClaimEvidenceMapper.MapAll(aiLines, aiPoolMulti, aiSid);
      var groundedDossier = aiValidated.Any(v => v.Verified)
        ? string.Join("\n", aiValidated.Where(v => v.Verified).Select(v => v.Kind.ToUpperInvariant() + " | " + v.Text + " || EVIDENCE: " + string.Join(" ;; ", v.Refs.Select(r => r.Url + " :: \"" + r.Quote + "\""))))
        : "";
      string aiProfilePrompt = BuildAiDraftProfilePrompt(name, role, focus, groundedDossier);
      string profile;
      try
      {
        profile = await gw.CompleteAsync(ModelPolicy.SparkFor(s, null), "advisor-profile",
          aiProfilePrompt,
          ContextBudget.BidTokens, 2048, ownerOverride: PeopleOps.IsOwner(req));
      }
      catch (Exception ex) when (ex is CapExceededException or ProviderException or TaskCanceledException or HttpRequestException or JsonException) { return PeopleOps.ModelError(ex); }
      profile = profile.Trim();
      if (profile.StartsWith("```"))
      {
        var pnl = profile.IndexOf("\n");
        var pend = profile.LastIndexOf("```");
        if (pnl >= 0 && pend > pnl) profile = profile.Substring(pnl + 1, pend - pnl - 1).Trim();
      }
      var aiDraftUrls = new List<string>();
      foreach (var cite in dossier.Citations.Where(c => !string.IsNullOrWhiteSpace(c.Url)))
      {
        var cu = cite.Url.Trim();
        bool dup = false;
        foreach (var e in aiDraftUrls) { if (SimCEO.Api.Work.ClaimEvidenceMapper.UrlsMatch(e, cu)) { dup = true; break; } }
        if (!dup) aiDraftUrls.Add(cu);
        if (aiDraftUrls.Count >= 10) break;
      }
      // Inventory prefers the fetched passage per strict URL (P2); pool keeps every passage and claims keep matched origin.
      var draftRefs = aiDraftUrls.Select(u =>
      {
        var hit = SimCEO.Api.Work.ClaimEvidenceMapper.SelectPreferredCitation(dossier.Citations, u);
        bool hf = hit?.Fetched ?? false;
        string ho = (hit?.Origin ?? "").Trim();
        if (hf && string.IsNullOrWhiteSpace(ho)) ho = "application-fetch";
        if (!hf) ho = string.IsNullOrWhiteSpace(hit?.Excerpt) ? "unfetched" : "provider-search";
        return new { kind = "source", @ref = u, url = u, title = hit?.Title ?? "", excerpt = hit?.Excerpt ?? "", fetched = hf, origin = ho, ownerSupplied = false };
      }).ToList();
      var draftClaims = new List<object>();
      foreach (var vc in aiValidated)
      {
        if (vc.Verified)
        {
          var vcAngle = string.Equals(vc.Kind, "interpretation", StringComparison.OrdinalIgnoreCase) ? "dossier [interpretation]" : "dossier";
          draftClaims.Add(new { angle = vcAngle, text = vc.Text, kind = vc.Kind, verified = true, sources = vc.Refs.Select(r => new { url = r.Url, title = r.Title }).ToList<object>(), refs = vc.Refs.Select(r => new { kind = "source", @ref = r.Url, url = r.Url, title = r.Title, excerpt = r.Quote, fetched = r.Fetched, origin = r.Origin }).ToList<object>() });
        }
        else
          draftClaims.Add(new { angle = "dossier [unverified]", text = vc.Text, kind = vc.Kind, verified = false, sources = new List<object>(), refs = new List<object>() });
      }
      foreach (var c in dossier.Citations.Take(6).Where(c => !string.IsNullOrWhiteSpace(c.Excerpt)))
        draftClaims.Add(new { angle = "dossier [citation]", text = c.Excerpt, kind = "citation", verified = false, sources = new[] { new { url = c.Url, title = c.Title } }.ToList<object>(), refs = new[] { new { kind = "source", @ref = c.Url, url = c.Url, title = c.Title, excerpt = c.Excerpt } }.ToList<object>() });
      var aiSupported = aiValidated.Any(v => v.Verified);
      var aiDistinct = new List<string>();
      foreach (var u in aiValidated.Where(v => v.Verified).SelectMany(v => v.Refs.Select(r => r.Url)))
      {
        var tu = (u ?? "").Trim();
        if (tu.Length == 0) continue;
        bool dup2 = false;
        foreach (var d in aiDistinct) { if (SimCEO.Api.Work.ClaimEvidenceMapper.UrlsMatch(d, tu)) { dup2 = true; break; } }
        if (!dup2) aiDistinct.Add(tu);
      }
      var entry = new RosterEntry
      {
        Id = Guid.NewGuid(), AccountId = accountId, OwnerKey = PeopleOps.UserOf(s, req), Type = AdvisorType.FictionalCharacter,
        Name = name.Trim(),
        Description = role.Trim() + " persona for: " + (string.IsNullOrWhiteSpace(focus) ? "general advisory" : focus.Trim()),
        ProfileJson = profile,
        ResearchJson = JsonSerializer.Serialize(new
        {
          subject = name.Trim() + " (" + role.Trim() + ")",
          searched = dossier.SearchCalls,
          supported = aiSupported,
          claims = draftClaims,
          responseIds = dossier.ResponseId is null ? new List<string>() : new List<string> { dossier.ResponseId },
          version = 1,
          evidenceRefs = draftRefs,
          draftStatus = aiSupported ? "done" : "unsupported",
          note = aiSupported
            ? "Snippet-level claims need cross-checking against independent sources before approval. Only claims with validated per-claim quotes are marked verified; unverified notes carry no support refs. Quote linkage proves passage provenance only, not claim truth."
            : "No grounded evidence completed (no verified quote-linked claims). The draft below is editable but UNSUPPORTED: not marked complete, not eligible for approval. Rerun research with better inputs, or proceed without research-gated approval.",
        }),
        ResearchedAt = aiSupported ? DateTime.UtcNow : null,
        ResearchRequested = true,
        EvidenceCount = aiDistinct.Count,
        Version = 1, UpdatedAt = DateTime.UtcNow,
      };
      var aiEntry = entry;
      try
      {
        Atomic.Run(s, () =>
        {
          s.Roster[aiEntry.Id] = aiEntry;
          Atomic.Audit(s, new AuditEvent { Action = "roster.ai-draft", Detail = JsonSerializer.Serialize(new { entry = aiEntry.Id, name, role, searches = dossier.SearchCalls }) });
        });
      }
      catch (Exception ex) { return CommitOutcome.MapCommitFailure(ex, "Roster draft") ?? Results.Json(new { error = "Roster draft failed; no state changed: " + ex.Message }, statusCode: 500); }
      var aiCommittedSupported = aiValidated.Any(v => v.Verified);
      return Results.Created("/api/roster/" + aiEntry.Id, new { entry = aiEntry, researched = aiCommittedSupported, draftStatus = aiCommittedSupported ? "done" : "unsupported", supported = aiCommittedSupported, evidenceCount = aiDistinct.Count, citations = dossier.Citations.Count, note = "Draft created. Add a portrait to complete this advisor." });
    });

    app.MapPost("/api/boards/{bid:guid}/advisors/{aid:guid}/chat", (InMemoryStore s, HttpRequest req, Guid bid, Guid aid) =>
    {
      // RETIRED (roster-only direct chat): board-scoped direct advisor chat would let a caller
      // with bare board-read reach an advisor without roster authorization and injects board
      // context outside the canonical roster profile. The ONLY direct-chat path is roster-scoped:
      // POST /api/roster/{rosterId}/chat with an authorized selected roster entry. Board group
      // discussion (/api/meetings/{id}/run) is unaffected. Kept as 410 (not 404) so old clients
      // learn the canonical route instead of silently failing.
      if (!s.Advisors.TryGetValue(aid, out var adv) || adv.BoardId != bid || adv.Removed) return Results.NotFound("advisor");
      if (!s.Boards.ContainsKey(bid)) return Results.NotFound("board");
      if (!PeopleOps.Can(s, req, bid, null, "read")) return PeopleOps.Denied();
      return Results.Json(new { error = "Board-scoped direct advisor chat is retired. Chat from your roster: POST /api/roster/{rosterId}/chat.", rosterId = adv.RosterEntryId, rosterChat = "/api/roster/" + adv.RosterEntryId + "/chat" }, statusCode: 410);
    });




    app.MapPost("/api/auditions", async (InMemoryStore s, HttpRequest req, JsonElement body) =>
    {
      if (PeopleOps.Guard(gw, req) is { } cappedAu) return cappedAu;
      var question = body.TryGetProperty("question", out var q) ? (q.GetString() ?? "") : "";
      if (string.IsNullOrWhiteSpace(question)) return Results.BadRequest("question is required.");
      if (question.Length > 4000) return Results.BadRequest("question must be 4000 chars or fewer.");
      // Inline drafts must be a JSON object or a JSON-encoded object string;
      // malformed text, arrays and other shapes are 400 before any provider call.
      // Canonical behavior (any of the 3 keys) enforces the same save-time bounds;
      // legacy objects without behavior keys keep the deterministic mapping.
      string? inlineProfile = null;
      if (body.TryGetProperty("profileJson", out var pj)
        && pj.ValueKind != JsonValueKind.Null && pj.ValueKind != JsonValueKind.Undefined)
      {
        if (pj.ValueKind == JsonValueKind.Object) inlineProfile = pj.GetRawText();
        else if (pj.ValueKind == JsonValueKind.String) inlineProfile = pj.GetString() ?? "";
        else return Results.BadRequest("profileJson must be a JSON object or a JSON-encoded object string.");
        var (iok, ierr) = CharacterBehavior.ValidateInlineProfile(inlineProfile);
        if (!iok) return Results.BadRequest(ierr);
      }
      string profile = inlineProfile ?? "{}";
      var auditionName = "draft character";
      var auditionVersion = 0;
      Guid? auditionRosterId = null;
      string auditionProfile = profile;
      string? auditionDesc = null;
      (Guid epochId, long epochRev) auditionPin = default;
      bool auditionHasPin = false;
      Guid auditionRid = Guid.Empty;
      var hasRid = false;
      if (body.TryGetProperty("rosterId", out var ri))
      {
        if (ri.ValueKind == JsonValueKind.String && Guid.TryParse(ri.GetString(), out var g)) { auditionRid = g; hasRid = true; }
        else return Results.BadRequest("rosterId must be a guid.");
      }
      if (hasRid)
      {
        // Authorize the referenced private roster source BEFORE reading its
        // profile or dispatching to the provider; strangers are denied here
        // without consuming any metered call. Snapshot, restore pin and access
        // are captured atomically under ONE RootGate: no old-profile /
        // new-restore-pin window exists.
        lock (s.RootGate)
        {
          if (!s.Roster.TryGetValue(auditionRid, out var rent) || rent is null || rent.Archived) return Results.NotFound();
          if (!CanReadRoster(s, req, rent)) return PeopleOps.Denied();
          auditionProfile = rent.ProfileJson ?? "{}";
          auditionDesc = rent.Description;
          auditionName = rent.Name;
          auditionVersion = rent.Version;
          auditionRosterId = auditionRid;
          auditionPin = PublicationGuard.Capture(s);
          auditionHasPin = true;
        }
      }
      // Same behavior contract as meetings and roster chat: all 3 researched
      // paragraphs (or the deterministic legacy mapping) drive the answer in
      // FULL; profile text is never truncated and never passed as raw JSON.
      var auditionBehavior = CharacterBehavior.BehaviorSection(auditionProfile, auditionName, auditionVersion, auditionVersion, "");
      auditionBehavior += CharacterBehavior.SeedContextSection(auditionBehavior, auditionProfile, auditionDesc);
      var boardInfo = body.TryGetProperty("boardInfo", out var bi) ? (bi.GetString() ?? "") : "";
      if (boardInfo.Length > 2000) return Results.BadRequest("boardInfo must be 2000 chars or fewer.");
      // Essential-first packet: behavior + current question always whole;
      // owner board info is droppable context. truncatePrompt:false so the
      // gateway never blindly cuts the question tail.
      var essentialAud = "AUDITION (isolated, not a meeting message). " + AdvisorDialogue.Guidance + auditionBehavior
        + " Question: " + question + "\nReply in character from the criteria above: agree/disagree/challenge as the character's bluntness or diplomacy; concise; flag missing evidence, stay within specialty, never claim real employment, degrees, licenses, or endorsements. ";
      var audPacket = CharacterBehavior.FitEssentialFirst(essentialAud,
        string.IsNullOrWhiteSpace(boardInfo) ? new List<string>() : new List<string> { "Board info: " + boardInfo },
        AdvisorAssessment.PacketBudget("audition", CharacterBehavior.ChatInputTokens));
      if (audPacket is null)
        return Results.Json(new { error = "Character behavior plus question exceed the audition prompt budget; shorten the saved paragraphs." }, statusCode: 413);
      string answer;
      try
      {
        answer = await AdvisorAssessment.CompleteAsync(gw, ModelPolicy.SparkStandard, "audition",
          audPacket, CharacterBehavior.ChatInputTokens, req.HttpContext.RequestAborted, ownerOverride: PeopleOps.IsOwner(req));
      }
      catch (OperationCanceledException) { return Results.StatusCode(499); }
      catch (Exception ex) when (ex is ProviderException or TaskCanceledException or HttpRequestException or JsonException) { return PeopleOps.ProviderError(ex is ProviderException pex ? pex : new ProviderException(502, ex.Message)); }
      // Post-await recheck under ONE RootGate THROUGH the immutable final
      // response: the roster checks and the answer object are built at one
      // boundary, so a restore/edit between two reads cannot mix states.
      lock (s.RootGate)
      {
        if (auditionRosterId.HasValue)
        {
          if (PeopleOps.BadToken(s, req) is { } badAu) return badAu;
          if (auditionHasPin && (s.RestoreEpochId != auditionPin.epochId || s.RestoreEpochRev != auditionPin.epochRev))
            return Results.Conflict("Domain was restored during generation; stale answer discarded, retry.");
          if (!s.Roster.TryGetValue(auditionRosterId.Value, out var freshAu)) return Results.NotFound();
          if (freshAu.Archived)
            return Results.Conflict("Roster entry was archived during generation; stale answer discarded.");
          if (!CanReadRoster(s, req, freshAu)) return PeopleOps.Denied();
          if (freshAu.Version != auditionVersion)
            return Results.Conflict("Advisor was edited during generation; stale answer discarded, retry with the current version.");
          auditionVersion = freshAu.Version;
        }
        return Results.Ok(new
        {
          answer,
          rosterVersion = auditionVersion,
          indicators = new
          {
            expertiseUsed = auditionName,
            assumptions = new[] { "draft profile only; no meeting history" },
            sources = new[] { "none: auditions use only owner-entered board info" },
            withinLimits = true,
          },
          stored = false,
          note = "Auditions never create meeting messages, records, or agent memory.",
        });
      }
    });


    app.MapPost("/api/roster/{id:guid}/image/upload", async (InMemoryStore s, HttpRequest req, Guid id, IFormFile file) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badUp) return badUp;
      if (!s.Roster.TryGetValue(id, out var upEntry) || upEntry.Archived) return Results.NotFound();
      if (!RosterOps.CanWriteRoster(s, req, upEntry)) return PeopleOps.Denied();
      if (file is null || file.Length == 0) return Results.BadRequest("No file.");
      if (file.Length > 5 * 1024 * 1024) return Results.BadRequest("Image exceeds 5 MB.");
      var ct = file.ContentType ?? "";
      if (!ct.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
        return Results.BadRequest("Only image uploads are accepted.");
      using var ms = new MemoryStream();
      await file.CopyToAsync(ms);
      var img = new AdvisorImage
      {
        RosterEntryId = id, Kind = "upload",
        Review = "pending",
        Provenance = $"upload:{file.FileName}", ContentType = ct, Data = ms.ToArray(),
      };
      var newImg = img;
      try
      {
        Atomic.Run(s, () =>
        {
          if (!s.Roster.TryGetValue(id, out var cur) || cur is null || cur.Archived) throw new InvalidOperationException("gone");
          if (!RosterOps.CanWriteRoster(s, req, cur)) throw new UnauthorizedAccessException("Access revoked or not granted for this scope.");
          s.Images[newImg.Id] = newImg;
          RosterOps.UnapproveBoardCopies(s, id);
        });
      }
      catch (UnauthorizedAccessException) { return PeopleOps.Denied(); }
      catch (InvalidOperationException iox) when (CommitOutcome.IsMissing(iox, "gone")) { return Results.NotFound(); }
      catch (InvalidOperationException iox) { return CommitOutcome.StorageFault("Image upload", iox); }
      catch (Exception ex) { return CommitOutcome.MapCommitFailure(ex, "Image upload") ?? Results.Json(new { error = "Image upload failed; no state changed: " + ex.Message }, statusCode: 500); }
      return Results.Created($"/api/images/{newImg.Id}", new { newImg.Id, newImg.Kind, newImg.Provenance });
    }).DisableAntiforgery(); // token-less API: no cookie auth to forge against

    app.MapPost("/api/roster/{id:guid}/image/url", async (InMemoryStore s, HttpRequest req, Guid id, JsonElement body) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badUrl) return badUrl;
      if (!s.Roster.TryGetValue(id, out var urlEntry) || urlEntry.Archived) return Results.NotFound();
      if (!RosterOps.CanWriteRoster(s, req, urlEntry)) return PeopleOps.Denied();
      var url = body.TryGetProperty("url", out var u) ? (u.GetString() ?? "") : "";
      var source = body.TryGetProperty("source", out var sn) ? (sn.GetString() ?? "") : "";
      if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)
          || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
        return Results.BadRequest("A public http(s) image URL is required.");
      // Pinned public raster retrieval: single DNS resolution with ALL-addresses-public
      // enforcement, pinned TCP (no rebinding), whole-operation deadline, no redirects,
      // no auth/cookies/proxy, streamed size cap, raster magic validation, redacted errors.
      var (bytes, ct) = await PublicImageFetcher.FetchRasterAsync(url, req.HttpContext.RequestAborted);
      if (bytes is null || ct is null)
        return Results.Json(new { error = "Image fetch failed." }, statusCode: 502);
      {
        var img = new AdvisorImage
        {
          RosterEntryId = id, Kind = "url",
        Review = "pending",
          Provenance = $"url:{url} source:{source}", ContentType = ct, Data = bytes,
        };
        var newImg2 = img;
        try
        {
          Atomic.Run(s, () =>
          {
            if (!s.Roster.TryGetValue(id, out var cur) || cur is null || cur.Archived) throw new InvalidOperationException("gone");
            if (!RosterOps.CanWriteRoster(s, req, cur)) throw new UnauthorizedAccessException("Access revoked or not granted for this scope.");
            s.Images[newImg2.Id] = newImg2;
            RosterOps.UnapproveBoardCopies(s, id);
          });
        }
        catch (UnauthorizedAccessException) { return PeopleOps.Denied(); }
        catch (InvalidOperationException iox) when (CommitOutcome.IsMissing(iox, "gone")) { return Results.NotFound(); }
        catch (InvalidOperationException iox) { return CommitOutcome.StorageFault("Image fetch", iox); }
        catch (Exception ex) { return CommitOutcome.MapCommitFailure(ex, "Image fetch") ?? Results.Json(new { error = "Image fetch failed to store; no state changed: " + ex.Message }, statusCode: 500); }
        return Results.Created($"/api/images/{newImg2.Id}", new { newImg2.Id, newImg2.Kind, newImg2.Provenance });
      }
    });

    app.MapPost("/api/roster/{id:guid}/image/generate", async (InMemoryStore s, HttpRequest req, Guid id, JsonElement body) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badGen) return badGen;
      if (!s.Roster.TryGetValue(id, out var entry)) return Results.NotFound();
      if (!RosterOps.CanWriteRoster(s, req, entry)) return PeopleOps.Denied();
      var count = body.TryGetProperty("count", out var c) ? c.GetInt32() : 0;
      if (count is not (1 or 2 or 4))
        return Results.BadRequest("Choose Generate 1, 2, or 4 options with an explicit click.");
      if (PeopleOps.Guard(gw, req) is { } capped) return capped;
      var prompt = body.TryGetProperty("prompt", out var p) && !string.IsNullOrWhiteSpace(p.GetString())
        ? p.GetString()!
        : $"Professional portrait of a fictional advisor: {entry.Name}. {entry.ProfileJson[..Math.Min(500, entry.ProfileJson.Length)]}. Must not resemble any real person.";
      List<byte[]> images;
      try
      {
        images = await gw.GenerateImagesAsync(prompt, count, ownerOverride: PeopleOps.IsOwner(req));
      }
      catch (ProviderException ex) { return PeopleOps.ProviderError(ex); }
      var created = new List<object>();
      var genImgs = new List<AdvisorImage>();
      foreach (var bytes in images)
      {
        genImgs.Add(new AdvisorImage
        {
          RosterEntryId = id, Kind = "generated",
          Review = "pending",
          Provenance = $"generated:muse-image prompt:{prompt[..Math.Min(120, prompt.Length)]}",
          ContentType = "image/png", Data = bytes,
        });
      }
      try
      {
        Atomic.Run(s, () =>
        {
          if (!s.Roster.TryGetValue(id, out var cur) || cur is null || cur.Archived) throw new InvalidOperationException("gone");
          if (!RosterOps.CanWriteRoster(s, req, cur)) throw new UnauthorizedAccessException("Access revoked or not granted for this scope.");
          foreach (var gi in genImgs)
          {
            s.Images[gi.Id] = gi;
            created.Add(new { gi.Id, gi.Kind, gi.Provenance });
          }
          if (created.Count > 0) RosterOps.UnapproveBoardCopies(s, id);
        });
      }
      catch (UnauthorizedAccessException) { return PeopleOps.Denied(); }
      catch (InvalidOperationException iox) when (CommitOutcome.IsMissing(iox, "gone")) { return Results.NotFound(); }
      catch (InvalidOperationException iox) { return CommitOutcome.StorageFault("Image generation", iox); }
      catch (Exception ex) { return CommitOutcome.MapCommitFailure(ex, "Image generation") ?? Results.Json(new { error = "Image generation store failed; no state changed: " + ex.Message }, statusCode: 500); }
      return Results.Ok(created);
    });

    app.MapGet("/api/roster/{id:guid}/images", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (PeopleOps.IsSecure(s) && !AuthOps.TrySession(s, req, out _)) return Results.Json(new { error = "Authentication required." }, statusCode: 401);
      if (!s.Roster.TryGetValue(id, out var __ie) || __ie.Archived) return Results.NotFound();
      if (PeopleOps.IsSecure(s) && !CanReadRoster(s, req, __ie)) return PeopleOps.Denied();
      return Results.Ok(s.Images.Values.Where(i => i.RosterEntryId == id)
        .Select(i => new { i.Id, i.Kind, i.Provenance, i.ContentType, i.Review, i.CreatedAt }).OrderByDescending(i => i.CreatedAt));
    });

    app.MapDelete("/api/images/{imgId:guid}", (InMemoryStore s, HttpRequest req, Guid imgId) =>
    {
      if (!s.Images.TryGetValue(imgId, out var img)) return Results.NotFound();
      if (PeopleOps.BadToken(s, req) is { } badDel) return badDel;
      RosterEntry? delEntry = img.RosterEntryId.HasValue && s.Roster.TryGetValue(img.RosterEntryId.Value, out var delRe) ? delRe : null;
      var boardId = Guid.Empty;
      if (img.BoardAdvisorId.HasValue && s.Advisors.TryGetValue(img.BoardAdvisorId.Value, out var adv))
        boardId = adv.BoardId;
      else if (delEntry is not null)
        boardId = s.Advisors.Values.FirstOrDefault(a => a.RosterEntryId == delEntry.Id && !a.Removed)?.BoardId ?? Guid.Empty;
      // Shared-image scope: a roster-linked image mutates every board copy
      // (review state + UnapproveBoardCopies), so roster-linked images require
      // the full roster-write boundary even when the caller manages one linked
      // board. Board-manage suffices only for board-local images with no roster
      // entry. Preserves owner-owned templates (owner passes CanWriteRoster)
      // and legacy ownerless all-linked-manage via that same boundary.
      var delAllowed = delEntry is not null
        ? RosterOps.CanWriteRoster(s, req, delEntry)
        : (boardId != Guid.Empty && PeopleOps.Can(s, req, boardId, null, "manage"));
      if (!delAllowed) return PeopleOps.Denied();
      var delImgId = imgId;
      try
      {
        Atomic.Run(s, () =>
        {
          if (!s.Images.TryGetValue(delImgId, out var cur) || cur is null) throw new InvalidOperationException("gone");
          RosterEntry? curEntry = cur.RosterEntryId.HasValue && s.Roster.TryGetValue(cur.RosterEntryId.Value, out var curRe) ? curRe : null;
          Guid curBoard = Guid.Empty;
          if (cur.BoardAdvisorId.HasValue && s.Advisors.TryGetValue(cur.BoardAdvisorId.Value, out var curAdv))
            curBoard = curAdv.BoardId;
          else if (curEntry is not null)
            curBoard = s.Advisors.Values.FirstOrDefault(a => a.RosterEntryId == curEntry.Id && !a.Removed)?.BoardId ?? Guid.Empty;
          var allowedNow = curEntry is not null
            ? RosterOps.CanWriteRoster(s, req, curEntry)
            : (curBoard != Guid.Empty && PeopleOps.Can(s, req, curBoard, null, "manage"));
          if (!allowedNow) throw new UnauthorizedAccessException("Access revoked or not granted for this scope.");
          s.Images.TryRemove(delImgId, out _);
          if (cur.RosterEntryId.HasValue) RosterOps.UnapproveBoardCopies(s, cur.RosterEntryId.Value);
        });
      }
      catch (UnauthorizedAccessException) { return PeopleOps.Denied(); }
      catch (InvalidOperationException iox) when (CommitOutcome.IsMissing(iox, "gone")) { return Results.NotFound(); }
      catch (InvalidOperationException iox) { return CommitOutcome.StorageFault("Image delete", iox); }
      catch (Exception ex) { return CommitOutcome.MapCommitFailure(ex, "Image delete") ?? Results.Json(new { error = "Image delete failed; no state changed: " + ex.Message }, statusCode: 500); }
      return Results.NoContent();
    });

    app.MapPost("/api/images/{imgId:guid}/select", (InMemoryStore s, HttpRequest req, Guid imgId, JsonElement body) =>
    {
      if (!s.Images.TryGetValue(imgId, out var probeImg)) return Results.NotFound();
      var advisorId = body.TryGetProperty("boardAdvisorId", out var aa) ? aa.GetGuid() : (Guid?)null;
      if (advisorId is null || !s.Advisors.TryGetValue(advisorId.Value, out var probeAdv)) return Results.BadRequest("boardAdvisorId is required.");
      if (!PeopleOps.Can(s, req, probeAdv.BoardId, null, "manage")) return PeopleOps.Denied();
      if (!probeImg.RosterEntryId.HasValue || probeImg.RosterEntryId.Value != probeAdv.RosterEntryId)
        return Results.BadRequest("Image does not belong to this advisor roster entry.");
      lock (s.SetupLock)
      {
        if (!s.Images.TryGetValue(imgId, out var img)) return Results.NotFound();
        if (!s.Advisors.TryGetValue(advisorId.Value, out var adv)) return Results.BadRequest("boardAdvisorId is required.");
        if (!PeopleOps.Can(s, req, adv.BoardId, null, "manage")) return PeopleOps.Denied();
        if (!img.RosterEntryId.HasValue || img.RosterEntryId.Value != adv.RosterEntryId)
          return Results.BadRequest("Image does not belong to this advisor roster entry.");
        var selImgId = img.Id; var selAdvId = adv.Id;
        BoardAdvisor? savedAdv = null;
        try
        {
          Atomic.Run(s, () =>
          {
            if (!s.Images.TryGetValue(selImgId, out var cur) || cur is null) throw new InvalidOperationException("gone");
            if (!s.Advisors.TryGetValue(selAdvId, out var a2) || a2 is null || a2.Removed) throw new InvalidOperationException("gone");
            if (!PeopleOps.Can(s, req, a2.BoardId, null, "manage")) throw new UnauthorizedAccessException("Access revoked or not granted for this scope.");
            if (!cur.RosterEntryId.HasValue || cur.RosterEntryId.Value != a2.RosterEntryId)
              throw new InvalidOperationException("mismatch");
            foreach (var other in s.Images.Values.Where(i => i.BoardAdvisorId == a2.Id && i.Id != cur.Id).ToList())
            {
              other.BoardAdvisorId = null;
              s.Images[other.Id] = other;
            }
          // Per-board selection only: record identity (link + provenance) and
          // require re-approval of this copy, but never mutate the shared
          // global Review. A pending/rejected image stays pending/rejected, so
          // approval remains blocked until an explicit review accept with the
          // full roster-write scope. Only explicit review accept changes Review.
            cur.BoardAdvisorId = a2.Id;
            s.Images[cur.Id] = cur;
            a2.Approved = false;
            a2.ImageProvenance = cur.Kind + ":" + cur.Id.ToString();
            s.Images[cur.Id] = cur;
            s.Advisors[a2.Id] = a2;
            savedAdv = a2;
          });
        }
        catch (UnauthorizedAccessException) { return PeopleOps.Denied(); }
        catch (InvalidOperationException iox) when (iox.Message == "mismatch") { return Results.BadRequest("Image does not belong to this advisor roster entry."); }
        catch (InvalidOperationException iox) when (CommitOutcome.IsMissing(iox, "gone")) { return Results.NotFound(); }
        catch (InvalidOperationException iox) { return CommitOutcome.StorageFault("Image select", iox); }
        catch (Exception ex) { return CommitOutcome.MapCommitFailure(ex, "Image select") ?? Results.Json(new { error = "Image select failed; no state changed: " + ex.Message }, statusCode: 500); }
        if (savedAdv is null) return Results.NotFound();
        Atomic.Audit(s, new AuditEvent { BoardId = savedAdv.BoardId, Action = "image.select", Detail = JsonSerializer.Serialize(new { imgId, advisor = advisorId }) });
        return Results.Ok(savedAdv);
      }
    });

    app.MapPost("/api/images/{imgId:guid}/review", (InMemoryStore s, HttpRequest req, Guid imgId, JsonElement body) =>
    {
      if (!s.Images.TryGetValue(imgId, out var probeRev)) return Results.NotFound();
      if (PeopleOps.BadToken(s, req) is { } badRevProbe) return badRevProbe;
      var decProbe = body.TryGetProperty("decision", out var dvp) ? (dvp.GetString() ?? "") : "";
      if (decProbe != "accept" && decProbe != "retry") return Results.BadRequest("decision must be accept or retry.");
      Guid? rbBoardProbe = null;
      if (probeRev.BoardAdvisorId.HasValue && s.Advisors.TryGetValue(probeRev.BoardAdvisorId.Value, out var rbAdvProbe)) rbBoardProbe = rbAdvProbe.BoardId;
      else if (probeRev.RosterEntryId.HasValue && s.Roster.TryGetValue(probeRev.RosterEntryId.Value, out var rbEntryProbe)) rbBoardProbe = s.Advisors.Values.FirstOrDefault(a => a.RosterEntryId == rbEntryProbe.Id && !a.Removed)?.BoardId;
      RosterEntry? revEntryProbe = probeRev.RosterEntryId.HasValue && s.Roster.TryGetValue(probeRev.RosterEntryId.Value, out var revReProbe) ? revReProbe : null;
      // Shared-review scope: same full roster-write boundary as delete.
      // A roster-linked image rejection unapproves copies on every board, so
      // single-board manage must not suffice. Board-manage fallback covers
      // only board-local images with no roster entry.
      var revAllowedProbe = revEntryProbe is not null
        ? RosterOps.CanWriteRoster(s, req, revEntryProbe)
        : (rbBoardProbe.HasValue && PeopleOps.Can(s, req, rbBoardProbe.Value, null, "manage"));
      if (!revAllowedProbe) return PeopleOps.Denied();
      lock (s.SetupLock)
      {
        if (!s.Images.TryGetValue(imgId, out var imgr)) return Results.NotFound();
        if (PeopleOps.BadToken(s, req) is { } badRev) return badRev;
        var dec = body.TryGetProperty("decision", out var dv) ? (dv.GetString() ?? "") : "";
        if (dec != "accept" && dec != "retry") return Results.BadRequest("decision must be accept or retry.");
        Guid? rbBoard = null;
        if (imgr.BoardAdvisorId.HasValue && s.Advisors.TryGetValue(imgr.BoardAdvisorId.Value, out var rbAdv)) rbBoard = rbAdv.BoardId;
        else if (imgr.RosterEntryId.HasValue && s.Roster.TryGetValue(imgr.RosterEntryId.Value, out var rbEntry)) rbBoard = s.Advisors.Values.FirstOrDefault(a => a.RosterEntryId == rbEntry.Id && !a.Removed)?.BoardId;
        RosterEntry? revEntry = imgr.RosterEntryId.HasValue && s.Roster.TryGetValue(imgr.RosterEntryId.Value, out var revRe) ? revRe : null;
        // Shared-review scope (in-lock recheck): roster-linked images require
        // the full roster-write boundary; board-manage covers only
        // board-local images with no roster entry.
        var revAllowed = revEntry is not null
          ? RosterOps.CanWriteRoster(s, req, revEntry)
          : (rbBoard.HasValue && PeopleOps.Can(s, req, rbBoard.Value, null, "manage"));
        if (!revAllowed) return PeopleOps.Denied();
        AdvisorImage? savedImg = null;
        try
        {
          Atomic.Run(s, () =>
          {
            if (!s.Images.TryGetValue(imgId, out var cur) || cur is null) throw new InvalidOperationException("gone");
            if (body.TryGetProperty("decision", out var dv2) && (dv2.GetString() ?? "") is var decNow && decNow != "accept" && decNow != "retry") throw new InvalidOperationException("bad-decision");
            RosterEntry? curEntry = cur.RosterEntryId.HasValue && s.Roster.TryGetValue(cur.RosterEntryId.Value, out var curRe) ? curRe : null;
            Guid? curBoard = null;
            if (cur.BoardAdvisorId.HasValue && s.Advisors.TryGetValue(cur.BoardAdvisorId.Value, out var curAdv0)) curBoard = curAdv0.BoardId;
            else if (curEntry is not null) curBoard = s.Advisors.Values.FirstOrDefault(a => a.RosterEntryId == curEntry.Id && !a.Removed)?.BoardId;
            var allowedNow = curEntry is not null
              ? RosterOps.CanWriteRoster(s, req, curEntry)
              : (curBoard.HasValue && PeopleOps.Can(s, req, curBoard.Value, null, "manage"));
            if (!allowedNow) throw new UnauthorizedAccessException("Access revoked or not granted for this scope.");
            cur.Review = dec == "accept" ? "accepted" : "rejected";
            s.Images[cur.Id] = cur;
            if (curEntry is not null) RosterOps.UnapproveBoardCopies(s, curEntry.Id);
            if (cur.BoardAdvisorId.HasValue && s.Advisors.TryGetValue(cur.BoardAdvisorId.Value, out var revAdv))
            {
              revAdv.Approved = false;
              s.Advisors[revAdv.Id] = revAdv;
            }
            savedImg = cur;
          });
        }
        catch (UnauthorizedAccessException) { return PeopleOps.Denied(); }
        catch (InvalidOperationException iox) when (iox.Message == "bad-decision") { return Results.BadRequest("decision must be accept or retry."); }
        catch (InvalidOperationException iox) when (CommitOutcome.IsMissing(iox, "gone")) { return Results.NotFound(); }
        catch (InvalidOperationException iox) { return CommitOutcome.StorageFault("Image review", iox); }
        catch (Exception ex) { return CommitOutcome.MapCommitFailure(ex, "Image review") ?? Results.Json(new { error = "Image review failed; no state changed: " + ex.Message }, statusCode: 500); }
        if (savedImg is null) return Results.NotFound();
        Guid? rb = null;
        if (savedImg.BoardAdvisorId.HasValue && s.Advisors.TryGetValue(savedImg.BoardAdvisorId.Value, out var rba)) rb = rba.BoardId;
        else if (savedImg.RosterEntryId.HasValue && s.Roster.TryGetValue(savedImg.RosterEntryId.Value, out var rre)) rb = s.Advisors.Values.FirstOrDefault(a => a.RosterEntryId == rre.Id && !a.Removed)?.BoardId;
        Atomic.Audit(s, new AuditEvent { BoardId = rb, Action = "image.review", Detail = JsonSerializer.Serialize(new { imgId, decision = dec }) });
        return Results.Ok(savedImg);
      }
    });

    app.MapGet("/api/images/{imgId:guid}", (InMemoryStore s, HttpRequest req, Guid imgId) =>
    {
      if (!s.Images.TryGetValue(imgId, out var img) || img.Data is null) return Results.NotFound();
      if (PeopleOps.IsSecure(s))
      {
        if (PeopleOps.BadToken(s, req) is { } badImg) return badImg;
        if (!AuthOps.TrySession(s, req, out var iu)) return Results.Json(new { error = "Authentication required." }, statusCode: 401);
        var ok = false;
        var admin = PeopleOps.AdminEmail(s);
        if (!string.IsNullOrWhiteSpace(admin) && string.Equals(admin, iu, StringComparison.OrdinalIgnoreCase)) ok = true;
        if (!ok && img.RosterEntryId.HasValue && s.Roster.TryGetValue(img.RosterEntryId.Value, out var re) && string.Equals(re.OwnerKey, iu, StringComparison.OrdinalIgnoreCase)) ok = true;
        // Ordinary board readers/managers: the same roster-read boundary that
        // permits listing this image's metadata also permits its exact bytes.
        // Meeting guests remain confined to the accepted selected-portrait
        // path below (CanReadRoster excludes meeting-scoped discuss grants).
        if (!ok && img.RosterEntryId.HasValue && s.Roster.TryGetValue(img.RosterEntryId.Value, out var re2) && CanReadRoster(s, req, re2)) ok = true;
        if (!ok)
        {
          // Meeting guests: only the accepted, selected portrait of an approved
          // participant in one of their own meetings. No other meeting scope,
          // no pending/unselected/shared-pool reads.
          Guid bid = Guid.Empty;
          BoardAdvisor? selAdv = null;
          if (img.BoardAdvisorId.HasValue && s.Advisors.TryGetValue(img.BoardAdvisorId.Value, out var adv0)) { bid = adv0.BoardId; selAdv = adv0; }
          if (bid != Guid.Empty && string.Equals(img.Review ?? "", "accepted", StringComparison.OrdinalIgnoreCase)
            && selAdv is not null && selAdv.BoardId == bid && !selAdv.Removed && RosterOps.ParticipationGate(s, selAdv) is null
            && string.Equals(img.RosterEntryId, selAdv.RosterEntryId))
          {
            var mids = PeopleOps.GuestMeetingIds(s, iu, bid);
            foreach (var gmid in mids)
            {
              if (!s.Meetings.TryGetValue(gmid, out var gmtg)) continue;
              var parts = new System.Collections.Generic.HashSet<Guid>();
              try
              {
                using var dd = System.Text.Json.JsonDocument.Parse(string.IsNullOrWhiteSpace(gmtg.ParticipantIdsJson) ? "[]" : gmtg.ParticipantIdsJson);
                foreach (var ee in dd.RootElement.EnumerateArray())
                  if (ee.ValueKind == System.Text.Json.JsonValueKind.String && Guid.TryParse(ee.GetString(), out var gg)) parts.Add(gg);
              }
              catch { }
              if (parts.Count == 0 || (selAdv is not null && parts.Contains(selAdv.Id))) { ok = true; break; }
            }
          }
        }
        if (!ok) return PeopleOps.Denied();
      }
      return Results.Bytes(img.Data, img.ContentType);
    });
  }
}

