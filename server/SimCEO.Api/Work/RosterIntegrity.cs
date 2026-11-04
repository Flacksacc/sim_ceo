using System.Text.Json;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;

namespace SimCEO.Api.Work;

// Roster integrity: canonical-link authority for board attachments.
// User rule (overrides the old independent board-profile-copy design):
//  - A board advisor MUST link a canonical, authorized roster entry.
//  - Roster edits change effective advisor BEHAVIOR on boards.
//  - Board-specific role / participation metadata stay board-specific;
//    canonical capabilities and profile content come from the roster.
// This file owns ONLY new policy/resolver helpers. It does not mutate
// existing endpoint behavior; the primary integrates wiring (see
// docs/roster-integrity-integration.md written by this task).
public static class RosterIntegrity
{
  public const int MaxAdvisorsPerBoard = 10;

  public sealed record AttachCheck(bool Ok, string? Error, int Status);

  // Canonical attach gate: every board advisor links an authorized roster entry.
  // callerCanReadRoster: the caller already passed the roster-read boundary
  // (RosterEndpoints.CanReadRoster or owner/admin). canAttachBoard: caller may
  // manage this board. Kept dependency-free (booleans in) so QA can drive it
  // without HTTP scaffolding; the endpoint wiring lives with the primary.
  public static AttachCheck CheckAttach(
    InMemoryStore s, Guid rosterId, Guid boardId,
    bool callerCanReadRoster, bool canAttachBoard)
  {
    if (!s.Boards.ContainsKey(boardId))
      return new AttachCheck(false, "Board not found.", 404);
    if (!s.Roster.TryGetValue(rosterId, out var entry) || entry is null || entry.Archived)
      return new AttachCheck(false, "Roster entry not found or archived. Create or unarchive a roster entry first.", 409);
    if (!callerCanReadRoster)
      return new AttachCheck(false, "Not authorized for this roster entry.", 403);
    if (!canAttachBoard)
      return new AttachCheck(false, "Board manage permission required.", 403);
    if (s.Advisors.Values.Any(a => a.BoardId == boardId && a.RosterEntryId == rosterId && !a.Removed))
      return new AttachCheck(false, "Advisor already attached to this board.", 409);
    var active = s.Advisors.Values.Count(a => a.BoardId == boardId && !a.Removed);
    if (active >= MaxAdvisorsPerBoard)
      return new AttachCheck(false, "Board already has 10 advisors. Remove an advisor to add another.", 409);
    var (complete, missing) = RosterOps.DataCompleteness(s, rosterId);
    if (!complete)
      return new AttachCheck(false, "Roster entry is incomplete: " + string.Join(", ", missing) + ".", 409);
    return new AttachCheck(true, null, 200);
  }

  // Canonical behavior fingerprint: what the advisor WILL do on a board.
  // Roster-driven only (profile + dossier + research state + portrait).
  // Board role is intentionally excluded: role/participation metadata stay
  // board-specific and never leak into the canonical behavior hash.
  public static string CanonicalBehaviorFingerprint(InMemoryStore s, BoardAdvisor a)
  {
    if (!s.Roster.TryGetValue(a.RosterEntryId, out var rent) || rent is null)
      return "missing:" + a.RosterEntryId;
    string profileHash;
    try { profileHash = Hashing.HashOf(rent.ProfileJson ?? "{}"); }
    catch { profileHash = "hash-error"; }
    string researchHash;
    try { researchHash = Hashing.HashOf(rent.ResearchJson ?? "{}"); }
    catch { researchHash = "hash-error"; }
    var researchedAt = rent.ResearchedAt.HasValue ? rent.ResearchedAt.Value.ToString("o") : "null";
    var portrait = RosterOps.ReviewedPortraitFingerprint(s, a);
    return "roster:" + rent.Id + ":v" + rent.Version
      + ":profile:" + profileHash
      + ":research:" + researchHash
      + ":req:" + rent.ResearchRequested + ":at:" + researchedAt + ":ev:" + rent.EvidenceCount
      + ":portrait:[" + portrait + "]";
  }

  // Board attachment fingerprint: board-specific metadata only.
  public static string BoardAttachmentFingerprint(BoardAdvisor a) =>
    "board:" + a.BoardId + ":adv:" + a.Id + ":role:" + (a.BoardRole ?? "")
    + ":approved:" + a.Approved + ":removed:" + a.Removed + ":imgprov:" + (a.ImageProvenance ?? "");

  public sealed record CanonicalView(
    Guid AdvisorId, Guid BoardId, Guid RosterEntryId,
    int PinnedVersion, int CurrentVersion, bool Stale,
    string Name, string ProfileJson, string ResearchJson,
    bool ResearchRequested, DateTime? ResearchedAt, int EvidenceCount,
    string BoardRole, bool Approved, string PortraitFingerprint,
    string BehaviorFingerprint);

  // Canonical view resolver: Boards render THIS, never a forked profile copy.
  // Roster edits therefore change effective behavior; board role stays local.
  public static CanonicalView? ResolveCanonicalView(InMemoryStore s, BoardAdvisor a)
  {
    if (!s.Roster.TryGetValue(a.RosterEntryId, out var rent) || rent is null) return null;
    var stale = a.RosterVersion != rent.Version;
    return new CanonicalView(
      a.Id, a.BoardId, rent.Id,
      a.RosterVersion, rent.Version, stale,
      rent.Name, rent.ProfileJson ?? "{}", rent.ResearchJson ?? "{}",
      rent.ResearchRequested, rent.ResearchedAt, rent.EvidenceCount,
      a.BoardRole ?? "", a.Approved,
      RosterOps.ReviewedPortraitFingerprint(s, a),
      CanonicalBehaviorFingerprint(s, a));
  }

  // Material research change: a roster edit that must NOT silently approve
  // new unreviewed facts. Compares the pinned-reviewed research state (taken
  // at the last approval) with the roster's current state.
  public static bool IsMaterialResearchChange(
    string pinnedResearchJson, DateTime? pinnedAt, int pinnedEvidence,
    RosterEntry current)
  {
    string pinnedHash, currentHash;
    try { pinnedHash = Hashing.HashOf(pinnedResearchJson ?? "{}"); }
    catch { return true; }
    try { currentHash = Hashing.HashOf(current.ResearchJson ?? "{}"); }
    catch { return true; }
    if (!string.Equals(pinnedHash, currentHash, StringComparison.Ordinal)) return true;
    if (pinnedEvidence != current.EvidenceCount) return true;
    var pinnedStr = pinnedAt.HasValue ? pinnedAt.Value.ToString("o") : "null";
    var curStr = current.ResearchedAt.HasValue ? current.ResearchedAt.Value.ToString("o") : "null";
    return !string.Equals(pinnedStr, curStr, StringComparison.Ordinal);
  }

  // Stale-context rule: updates invalidate pending old context. Any pinned
  // behavior fingerprint that no longer matches the live canonical
  // fingerprint must be discarded and re-reviewed, never published.
  public static bool IsStaleContext(string pinnedBehaviorFingerprint, string liveBehaviorFingerprint) =>
    !string.Equals(pinnedBehaviorFingerprint, liveBehaviorFingerprint, StringComparison.Ordinal);

  // Canonical packet section for the context curator: the exact reviewed
  // Canonical packet section for the context curator: the exact reviewed
  // roster content + version pin an advisor agent may use. The 3 behavior
  // paragraphs (contributionCriteria, reasoningApproach, responseStyle) are
  // ESSENTIAL and always emitted IN FULL (accepted sizes are validated at
  // save, never silently cut here); dossier claims are secondary and bounded.
  // Callers trim evidence/sources/transcript first, never this section.
  // maxProfileChars bounds only the secondary dossier tail for compat.
  public static string CanonicalPacketSection(InMemoryStore s, BoardAdvisor a, int maxProfileChars = 4500, int maxClaims = 5)
  {
    var view = ResolveCanonicalView(s, a);
    if (view is null) return "ADVISOR: missing roster entry " + a.RosterEntryId + " (unlinked; must reconcile before use).";
    var sb = new System.Text.StringBuilder();
    sb.Append(CharacterBehavior.BehaviorSection(view.ProfileJson, view.Name, view.CurrentVersion, view.PinnedVersion, view.BoardRole));
    foreach (var claim in DossierClaims(view.ResearchJson).Take(maxClaims))
      sb.AppendLine("DOSSIER: " + (claim.Length > 400 ? claim.Substring(0, 400) : claim));
    var section = sb.ToString();
    var cap = System.Math.Clamp(maxProfileChars, 1500, 8000);
    // Deterministic essential budget: trim trailing dossier lines first so
    // the behavior paragraphs are never truncated. If the behavior alone
    // exceeds the cap, it is still returned whole: the packet-level budget
    // enforcement (ContextCurator) protects the essential prefix instead.
    while (section.Length > cap)
    {
      var idx = section.LastIndexOf("DOSSIER:", System.StringComparison.Ordinal);
      if (idx < 0) break;
      var nl = section.LastIndexOf("\n", idx, System.StringComparison.Ordinal);
      section = nl < 0 ? section[..idx] : section[..nl] + "\n";
      if (!section.Contains("DOSSIER:", System.StringComparison.Ordinal)) break;
    }
    return section;
  }

  private static List<string> DossierClaims(string researchJson)
  {
    try
    {
      using var parsed = JsonDocument.Parse(string.IsNullOrWhiteSpace(researchJson) ? "{}" : researchJson);
      var root = parsed.RootElement;
      if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty("claims", out var claims)
          && claims.ValueKind == JsonValueKind.Array)
      {
        var list = new List<string>();
        foreach (var c in claims.EnumerateArray())
        {
          var text = c.ValueKind == JsonValueKind.Object && c.TryGetProperty("text", out var t)
            ? (t.GetString() ?? "") : c.GetRawText();
          if (!string.IsNullOrWhiteSpace(text)) list.Add(text.Trim());
        }
        if (list.Count > 0) return list;
      }
    }
    catch (JsonException) { }
    return new List<string>();
  }
}
