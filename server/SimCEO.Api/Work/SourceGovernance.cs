using System.Text;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;

namespace SimCEO.Api.Work;

// Phase 6 central source-governance helper. Single eligibility predicate +
// family head + deterministic local indexing. All producers/consumers must
// route through IsEligible; review transitions are explicit, serialized, and
// audited. Storage state/pause/generation mutations share one atomic unit;
// audit entries are written only after the unit commits.

// Outstanding index job marker. Stored runtime-only in the store (never
// serialized into backups): reservations that survived a restore would
// otherwise commit against replaced state.
public sealed record ActiveIndexJob(Guid JobId, long Epoch, int Generation);

public static class SourceGovernance
{
  public const int MaxSections = 20;
  public const int MaxSectionChars = 2000;
  public const int MaxTotalChars = 12000;

  public static string NormalizeFileName(string name)
  {
    var t = (name ?? "").Trim();
    var idx = t.LastIndexOfAny(new[] { '/', '\\' });
    if (idx >= 0) t = t.Substring(idx + 1);
    return t.Trim().ToLowerInvariant();
  }

  public static string GetExtension(string fileName)
  {
    var n = (fileName ?? "").Trim();
    var dot = n.LastIndexOf('.');
    if (dot < 0) return "";
    var ext = n.Substring(dot + 1).Trim().ToLowerInvariant();
    var cut = ext.IndexOfAny(new[] { ' ', '?', '#', '/' , '\\' });
    if (cut >= 0) ext = ext.Substring(0, cut);
    return ext;
  }

  public static string FamilyKeyFor(Guid boardId, string scope, Guid? meetingId, string origin, string fileName)
  {
    var norm = NormalizeFileName(fileName);
    var sc = scope == "meeting" ? "meeting" : "board";
    var mid = sc == "meeting" && meetingId.HasValue ? meetingId.Value.ToString("N") : "-";
    var org = string.IsNullOrWhiteSpace(origin) ? "upload" : origin.Trim().ToLowerInvariant();
    return boardId.ToString("N") + "|" + sc + "|" + mid + "|" + org + "|" + norm;
  }

  public static string PolicyModeOf(Board? b)
  {
    var m = (b?.SourcePolicyMode ?? "allowAll").Trim().ToLowerInvariant();
    return m == "wikionly" || m == "wiki-only" || m == "wiki_only" ? "wikiOnly" : "allowAll";
  }

  public static bool IsBlockedByPolicy(Board? board, string fileName)
  {
    if (PolicyModeOf(board) == "wikiOnly") return true;
    return IsBlockedByPolicy_ExtensionOnly(board, fileName);
  }

  public static bool PolicyAllows(Board? board, SourceDoc doc)
  {
    var mode = PolicyModeOf(board);
    if (mode == "wikiOnly")
    {
      var org = (doc.Origin ?? "upload").Trim().ToLowerInvariant();
      if (org != "wiki") return false;
      return !IsBlockedByPolicy_ExtensionOnly(board, doc.FileName);
    }
    return !IsBlockedByPolicy_ExtensionOnly(board, doc.FileName);
  }

  private static bool IsBlockedByPolicy_ExtensionOnly(Board? board, string fileName)
  {
    var ext = GetExtension(fileName);
    if (string.IsNullOrEmpty(ext)) return false;
    var raw = board?.BlockedTypes ?? "";
    var parts = raw.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    foreach (var p in parts)
    {
      var q = p.Trim().TrimStart('.').ToLowerInvariant();
      if (q.Length == 0) continue;
      if (string.Equals(q, ext, StringComparison.OrdinalIgnoreCase)) return true;
    }
    return false;
  }
  public static void EnsureMigrated(InMemoryStore s, SourceDoc d)
  {
    var dirty = false;
    if (string.IsNullOrWhiteSpace(d.ReviewState))
    {
      d.ReviewState = d.Approved ? "approved" : "pending";
      dirty = true;
    }
    else
    {
      var rs = d.ReviewState.Trim().ToLowerInvariant();
      if (rs != "pending" && rs != "approved" && rs != "rejected") { d.ReviewState = d.Approved ? "approved" : "pending"; dirty = true; }
      else if (rs != d.ReviewState) { d.ReviewState = rs; dirty = true; }
    }
    if (string.IsNullOrWhiteSpace(d.Origin)) { d.Origin = "upload"; dirty = true; }
    else { var o = d.Origin.Trim().ToLowerInvariant(); if (o != d.Origin) { d.Origin = o; dirty = true; } }
    if (string.IsNullOrWhiteSpace(d.FamilyKey))
    {
      d.FamilyKey = FamilyKeyFor(d.BoardId, d.Scope, d.MeetingId, d.Origin, d.FileName);
      dirty = true;
    }
    if (string.IsNullOrWhiteSpace(d.IndexState)) { d.IndexState = "queued"; dirty = true; }
    var shouldApproved = string.Equals(d.ReviewState, "approved", StringComparison.OrdinalIgnoreCase);
    if (d.Approved != shouldApproved) { d.Approved = shouldApproved; dirty = true; }
    if (dirty) { try { s.Sources.Flush(); } catch { } }
  }

  // Field normalization only. Ordinary reads may normalize legacy sentinel
  // values, but they must NEVER create, update, or reconstruct family heads:
  // existing promoted heads are monotonic retained facts, and missing heads
  // are established solely by the controlled startup migration and by
  // validated restore (both inside explicit units, never on reads).
  public static void EnsureMigratedAll(InMemoryStore s)
  {
    lock (s.SetupLock)
    {
      lock (s.MessageLock)
      {
        foreach (var d in s.Sources.Values.ToList()) EnsureMigrated(s, d);
        try { s.Sources.Flush(); } catch { }
      }
    }
  }

  // Outstanding index job marker. Stored runtime-only in the store (never
  // Establish heads ONLY for families that have live approved rows and no
  // head row at all. Existing head rows are never touched: a retained pin
  // (including one that points at a moved-away source) stays exactly as it
  // is, and CurrentForFamily resolves it fail-closed by family+identity.
  public static void EnsureMissingHeads(InMemoryStore s)
  {
    var fams = s.Sources.Values
      .Where(x => string.Equals(x.ReviewState, "approved", StringComparison.OrdinalIgnoreCase))
      .GroupBy(x => (x.BoardId, x.FamilyKey))
      .ToList();
    foreach (var g in fams)
    {
      if (s.SourceHeads.Values.Any(h => h.BoardId == g.Key.BoardId && h.FamilyKey == g.Key.FamilyKey)) continue;
      var maxV = g.Max(x => x.Version);
      var tops = g.Where(x => x.Version == maxV).OrderBy(x => x.CreatedAt).ThenBy(x => x.Id).ToList();
      // Uniqueness is enforced by migration/validation before this runs; if
      // duplicates somehow remain, fail closed with no head.
      if (tops.Count != 1) continue;
      var head = new SourceFamilyHead { BoardId = g.Key.BoardId, FamilyKey = g.Key.FamilyKey, HeadVersion = maxV, HeadSourceId = tops[0].Id, UpdatedAt = DateTime.UtcNow };
      s.SourceHeads[head.Id] = head;
    }
    try { s.SourceHeads.Flush(); } catch { }
  }
  // One-time controlled migration. Idempotent and convergent: after one
  // successful run every step is a no-op. Runs at startup after the backend
  // is wired (and inside the validated restore unit), NEVER on ordinary
  // reads. Any failure throws: startup refuses to serve rather than serve
  // a half-migrated graph.
  public static void MigrateStore(InMemoryStore s)
  {
    lock (s.SetupLock)
    {
      lock (s.MessageLock)
      {
        Atomic.Run(() =>
        {
          foreach (var d in s.Sources.Values.ToList()) EnsureMigrated(s, d);
          // 1. Canonical family identity for every row. Legacy rows may
          // carry wrong or empty keys (path prefixes, case variants,
          // pre-family snapshots); new code always writes canonical keys,
          // so this step converges immediately.
          foreach (var d in s.Sources.Values.ToList())
          {
            var canon = FamilyKeyFor(d.BoardId, d.Scope, d.MeetingId, d.Origin, d.FileName);
            if (!string.Equals(d.FamilyKey ?? "", canon, StringComparison.Ordinal))
              d.FamilyKey = canon;
          }
          // 2. Deterministic same-version collision resolution per canonical
          // family. The earliest row (CreatedAt, Id) keeps its version;
          // later duplicates move above the live max, preserving every
          // document/content/identity/history row. Dependent section and
          // event versions follow; the original version is recorded.
          foreach (var g in s.Sources.Values.ToList().GroupBy(x => (x.BoardId, x.FamilyKey)).ToList())
          {
            var ordered = g.OrderBy(x => x.Version).ThenBy(x => x.CreatedAt).ThenBy(x => x.Id).ToList();
            var seen = new HashSet<int>();
            var maxV = ordered.Count == 0 ? 0 : ordered.Max(x => x.Version);
            foreach (var d in ordered)
            {
              if (seen.Add(d.Version)) continue;
              maxV++;
              var oldV = d.Version;
              d.Version = maxV;
              foreach (var sec in s.SourceSections.Values.Where(x => x.SourceId == d.Id).ToList())
                sec.SourceVersion = maxV;
              foreach (var e in s.SourceEvents.Values.Where(x => x.SourceId == d.Id && x.Version == oldV).ToList())
                e.Version = maxV;
              var pin = s.SourceHeads.Values.FirstOrDefault(h => h.BoardId == d.BoardId && h.FamilyKey == d.FamilyKey && h.HeadSourceId == d.Id && h.HeadVersion == oldV);
              if (pin is not null) pin.HeadVersion = maxV;
              RecordEvent(s, d, "migrate-version", "v" + oldV + "->v" + maxV);
            }
          }
          // 3. Re-pin sections/events to their canonical owner; drop
          // corrupt duplicate section ordinals (regenerable via reindex).
          var byId = s.Sources.Values.ToDictionary(x => x.Id);
          foreach (var sec in s.SourceSections.Values.ToList())
          {
            if (!byId.TryGetValue(sec.SourceId, out var owner) || owner is null) continue;
            sec.BoardId = owner.BoardId; sec.FamilyKey = owner.FamilyKey;
            sec.SourceVersion = owner.Version; sec.ContentHash = owner.ContentHash ?? "";
            sec.IndexGeneration = owner.IndexGeneration;
          }
          foreach (var sg in s.SourceSections.Values.ToList().GroupBy(x => (x.SourceId, x.Ordinal)).Where(g => g.Count() > 1).ToList())
            foreach (var dup in sg.OrderBy(x => x.Id).Skip(1).ToList())
              s.SourceSections.TryRemove(dup.Id, out _);
          var famMax = new Dictionary<(Guid, string), int>();
          foreach (var d in s.Sources.Values)
          {
            var k = (d.BoardId, d.FamilyKey ?? "");
            famMax[k] = famMax.TryGetValue(k, out var m) ? Math.Max(m, d.Version) : d.Version;
          }
          foreach (var e in s.SourceEvents.Values.ToList())
          {
            if (!byId.TryGetValue(e.SourceId, out var owner) || owner is null) continue;
            e.BoardId = owner.BoardId; e.FamilyKey = owner.FamilyKey ?? "";
            var mv = famMax.TryGetValue((owner.BoardId, owner.FamilyKey ?? ""), out var fmv) ? fmv : owner.Version;
            if (e.Version < 1 || e.Version > mv) e.Version = owner.Version;
          }
          // 4. Merge duplicate heads left by canonicalization (keep one
          // deterministic pin), pin unambiguous transitional heads, then
          // establish heads missing for approved families.
          foreach (var hg in s.SourceHeads.Values.ToList().GroupBy(h => (h.BoardId, h.FamilyKey)).Where(g => g.Count() > 1).ToList())
          {
            var keep = hg
              .OrderByDescending(h => s.Sources.Values.Any(x => x.BoardId == h.BoardId && x.FamilyKey == h.FamilyKey && x.Id == h.HeadSourceId && x.Version == h.HeadVersion))
              .ThenByDescending(h => h.HeadVersion).ThenBy(h => h.UpdatedAt).ThenBy(h => h.Id)
              .First();
            foreach (var drop in hg.Where(h => h.Id != keep.Id).ToList())
              s.SourceHeads.TryRemove(drop.Id, out _);
          }
          foreach (var head in s.SourceHeads.Values.ToList())
          {
            if (head.HeadSourceId != Guid.Empty) continue;
            var cands = s.Sources.Values.Where(x => x.BoardId == head.BoardId && x.FamilyKey == head.FamilyKey && x.Version == head.HeadVersion).ToList();
            if (cands.Count == 1) { head.HeadSourceId = cands[0].Id; head.UpdatedAt = DateTime.UtcNow; }
          }
          EnsureMissingHeads(s);
          s.Sources.Flush(); s.SourceSections.Flush(); s.SourceEvents.Flush(); s.SourceHeads.Flush();
        });
      }
    }
  }

  // Serialized startup/bootstrap migration. Runs after the backend is wired
  // and before the API serves: deterministic, idempotent, and fatal-safe —
  // no consumer can observe an unmigrated graph.
  public static void Bootstrap(InMemoryStore s)
  {
    s.SourceEpoch = DateTime.UtcNow.Ticks;
    s.ActiveIndexJobs.Clear();
    MigrateStore(s);
  }
  // Deliberate legacy-restore migration (P2 #9). Backup snapshots predating
  // phase 6 carry Approved=true with NO ReviewState field; deserialization
  // leaves the "" sentinel, so EnsureMigrated promotes them to "approved".
  // Rows that already carry an explicit ReviewState (including explicit
  // "rejected") are never touched: no implicit reapproval, no resurrection.
  // Uniformly empty legacy family keys are canonicalized here (validation
  // only accepts empty keys for a uniformly legacy graph); completed-
  // without-sections metadata is failed-closed until reindex; established
  // heads cover families the snapshot left headless.
  public static void MigrateRestoredSources(InMemoryStore s)
  {
    foreach (var d in s.Sources.Values.ToList()) EnsureMigrated(s, d);
    foreach (var d in s.Sources.Values.ToList())
    {
      if (string.IsNullOrWhiteSpace(d.FamilyKey))
        d.FamilyKey = FamilyKeyFor(d.BoardId, d.Scope, d.MeetingId, d.Origin, d.FileName);
    }
    foreach (var sec in s.SourceSections.Values.ToList())
    {
      if (s.Sources.TryGetValue(sec.SourceId, out var owner) && owner is not null
        && !string.Equals(sec.FamilyKey ?? "", owner.FamilyKey ?? "", StringComparison.Ordinal))
        sec.FamilyKey = owner.FamilyKey;
    }
    foreach (var e in s.SourceEvents.Values.ToList())
    {
      if (s.Sources.TryGetValue(e.SourceId, out var owner) && owner is not null
        && !string.Equals(e.FamilyKey ?? "", owner.FamilyKey ?? "", StringComparison.Ordinal))
        e.FamilyKey = owner.FamilyKey;
    }
    foreach (var d in s.Sources.Values.ToList())
    {
      if (string.Equals(d.IndexState, "completed", StringComparison.OrdinalIgnoreCase) && !HasValidSections(s, d))
      {
        d.IndexState = "failed";
        d.IndexError = "sections missing or mismatched after restore; reindex required";
        d.IndexCompletedAt = DateTime.UtcNow;
      }
    }
    try { s.Sources.Flush(); } catch { }
    try { s.SourceSections.Flush(); } catch { }
    try { s.SourceEvents.Flush(); } catch { }
    EnsureMissingHeads(s);
    try { s.SourceHeads.Flush(); } catch { }
  }

  // Full Phase 6 restore-graph validation. Runs BEFORE any mutation so an
  // expected failure leaves zero partial state. In addition to nulls,
  // identities, parents, and legal states, every source family key is
  // verified against the canonical server-computed identity
  // (board/scope/meeting/origin/file): a nonempty forged key is rejected,
  // while a uniformly empty legacy graph is accepted for controlled
  // canonicalization inside the restore unit. Events pin their exact
  // source/board/family/version relationships with unique identities; heads
  // are fully identity-checked and ambiguous empty-identity heads with live
  // rows fail closed. Returns false + error on any violation.
  public static bool ValidateRestoreGraph(BackupSnapshot restored, out string error)
  {
    error = "";
    if (restored is null) { error = "snapshot is empty."; return false; }
    if (restored.boards is null || restored.roster is null || restored.advisors is null
      || restored.meetings is null || restored.messages is null || restored.notes is null
      || restored.drafts is null || restored.sources is null || restored.blobs is null
      || restored.leads is null || restored.grants is null || restored.invites is null
      || restored.images is null)
    { error = "snapshot is missing required collections."; return false; }
    var boardIds = new HashSet<Guid>(restored.boards.Where(b => b is not null).Select(b => b.Id));
    var meetingBoard = new Dictionary<Guid, Guid>();
    foreach (var m in restored.meetings)
    {
      if (m is null) { error = "snapshot meeting is null."; return false; }
      if (m.Id == Guid.Empty) { error = "snapshot meeting has an empty id."; return false; }
      if (!boardIds.Contains(m.BoardId)) { error = "snapshot meeting references an unknown board."; return false; }
      meetingBoard[m.Id] = m.BoardId;
    }
    static bool LegalReview(string? v) => string.IsNullOrWhiteSpace(v)
      || v.Trim().ToLowerInvariant() is "pending" or "approved" or "rejected";
    static bool LegalOrigin(string? v) => string.IsNullOrWhiteSpace(v)
      || v.Trim().ToLowerInvariant() is "upload" or "wiki" or "inline";
    static bool LegalScope(string? v) => v is "board" or "meeting";
    static bool LegalIndex(string? v) => string.IsNullOrWhiteSpace(v)
      || v.Trim().ToLowerInvariant() is "queued" or "running" or "completed" or "failed";
    var sourceIds = new HashSet<Guid>();
    var familyVersions = new HashSet<string>(StringComparer.Ordinal);
    var canonical = new Dictionary<Guid, string>();
    foreach (var d in restored.sources)
    {
      if (d is null) { error = "snapshot source is null."; return false; }
      if (d.Id == Guid.Empty) { error = "snapshot source has an empty id."; return false; }
      if (!sourceIds.Add(d.Id)) { error = "snapshot sources contain a duplicate id."; return false; }
      if (!boardIds.Contains(d.BoardId)) { error = "snapshot source references an unknown board."; return false; }
      if (string.IsNullOrWhiteSpace(d.FileName)) { error = "snapshot source has an empty file name."; return false; }
      if (d.Version < 1) { error = "snapshot source has an illegal version."; return false; }
      if (!LegalReview(d.ReviewState)) { error = "snapshot source has an illegal review state."; return false; }
      if (!LegalOrigin(d.Origin)) { error = "snapshot source has an illegal origin."; return false; }
      if (!LegalScope(d.Scope)) { error = "snapshot source has an illegal scope."; return false; }
      if (!LegalIndex(d.IndexState)) { error = "snapshot source has an illegal index state."; return false; }
      if (d.IndexGeneration < 0) { error = "snapshot source has an illegal index generation."; return false; }
      if (d.Scope == "meeting")
      {
        if (!d.MeetingId.HasValue || d.MeetingId.Value == Guid.Empty) { error = "snapshot meeting source has no meeting."; return false; }
        if (!meetingBoard.TryGetValue(d.MeetingId.Value, out var mb) || mb != d.BoardId)
        { error = "snapshot meeting source references a meeting outside its board."; return false; }
      }
      var org = string.IsNullOrWhiteSpace(d.Origin) ? "upload" : d.Origin.Trim().ToLowerInvariant();
      if (org == "wiki" && d.ResourceId.HasValue && d.ResourceId.Value == Guid.Empty)
      { error = "snapshot wiki source carries an empty resource id."; return false; }
      var canon = FamilyKeyFor(d.BoardId, d.Scope, d.MeetingId, d.Origin, d.FileName);
      if (string.IsNullOrWhiteSpace(d.FamilyKey))
      {
        // Empty key: only legitimate as a uniformly empty legacy graph,
        // canonicalized inside the restore unit. Verified below.
        canonical[d.Id] = canon;
      }
      else if (!string.Equals(d.FamilyKey, canon, StringComparison.Ordinal))
      { error = "snapshot source family is forged: '" + d.FamilyKey + "' is not the canonical identity for this board/scope/meeting/origin/file."; return false; }
      else canonical[d.Id] = d.FamilyKey;
      var fv = d.BoardId.ToString("N") + "|" + canonical[d.Id] + "|v" + d.Version;
      if (!familyVersions.Add(fv)) { error = "snapshot sources contain an ambiguous family/version collision; resolve by uploading a new version instead."; return false; }
    }
    var legacyShape = restored.sources.All(d => d is null || string.IsNullOrWhiteSpace(d.FamilyKey))
      && (restored.sections is null || restored.sections.All(x => x is null))
      && (restored.heads is null || restored.heads.All(x => x is null))
      && (restored.events is null || restored.events.All(x => x is null));
    if (!legacyShape)
    {
      foreach (var d in restored.sources)
        if (d is not null && string.IsNullOrWhiteSpace(d.FamilyKey))
        { error = "snapshot source has an empty family outside a legacy graph."; return false; }
    }
    var byId = restored.sources.Where(d => d is not null).ToDictionary(d => d.Id);
    var famMax = new Dictionary<string, int>(StringComparer.Ordinal);
    foreach (var d in byId.Values)
    {
      var fk = canonical[d.Id];
      var key = d.BoardId.ToString("N") + "|" + fk;
      famMax[key] = famMax.TryGetValue(key, out var m) ? Math.Max(m, d.Version) : d.Version;
    }
    if (restored.sections is not null)
    {
      var secIds = new HashSet<Guid>();
      var ordinals = new HashSet<string>(StringComparer.Ordinal);
      foreach (var sec in restored.sections)
      {
        if (sec is null) { error = "snapshot section is null."; return false; }
        if (sec.Id == Guid.Empty) { error = "snapshot section has an empty id."; return false; }
        if (!secIds.Add(sec.Id)) { error = "snapshot sections contain a duplicate id."; return false; }
        if (!byId.TryGetValue(sec.SourceId, out var owner) || owner is null)
        { error = "snapshot section references an unknown source."; return false; }
        if (sec.BoardId != owner.BoardId) { error = "snapshot section belongs to another board than its source."; return false; }
        var ownerFam = canonical[owner.Id];
        if (string.IsNullOrWhiteSpace(sec.FamilyKey))
        {
          if (!legacyShape) { error = "snapshot section has an empty family outside a legacy graph."; return false; }
        }
        else if (!string.Equals(sec.FamilyKey, ownerFam, StringComparison.Ordinal))
        { error = "snapshot section belongs to another family than its source."; return false; }
        if (sec.SourceVersion != owner.Version) { error = "snapshot section pins the wrong source version."; return false; }
        if (!string.Equals(sec.ContentHash ?? "", owner.ContentHash ?? "", StringComparison.Ordinal))
        { error = "snapshot section pins the wrong content hash."; return false; }
        if (sec.IndexGeneration != owner.IndexGeneration) { error = "snapshot section pins the wrong index generation."; return false; }
        if (sec.Ordinal < 1) { error = "snapshot section has an illegal ordinal."; return false; }
        var ok = sec.SourceId.ToString("N") + "#" + sec.Ordinal;
        if (!ordinals.Add(ok)) { error = "snapshot sections contain a duplicate ordinal."; return false; }
        if (string.IsNullOrWhiteSpace(sec.Location)) { error = "snapshot section has an empty location."; return false; }
        if (string.IsNullOrWhiteSpace(sec.Text)) { error = "snapshot section has empty text."; return false; }
        if (sec.Heading is null) { error = "snapshot section has a null heading."; return false; }
      }
    }
    if (restored.heads is not null)
    {
      var headKeys = new HashSet<string>(StringComparer.Ordinal);
      var headIds = new HashSet<Guid>();
      foreach (var h in restored.heads)
      {
        if (h is null) { error = "snapshot head is null."; return false; }
        if (h.Id == Guid.Empty) { error = "snapshot head has an empty id."; return false; }
        if (!headIds.Add(h.Id)) { error = "snapshot heads contain a duplicate id."; return false; }
        if (h.BoardId == Guid.Empty) { error = "snapshot head has an empty board."; return false; }
        if (!boardIds.Contains(h.BoardId)) { error = "snapshot head references an unknown board."; return false; }
        if (string.IsNullOrWhiteSpace(h.FamilyKey)) { error = "snapshot head has an empty family."; return false; }
        if (h.HeadVersion < 0) { error = "snapshot head has an illegal version."; return false; }
        var hk = h.BoardId.ToString("N") + "|" + h.FamilyKey;
        if (!headKeys.Add(hk)) { error = "snapshot heads contain two heads for one family."; return false; }
        var liveHere = byId.Values.Any(x => x.BoardId == h.BoardId && canonical[x.Id] == h.FamilyKey);
        if (h.HeadSourceId != Guid.Empty)
        {
          if (!byId.TryGetValue(h.HeadSourceId, out var hd) || hd is null)
          { error = "snapshot head pins an unknown source."; return false; }
          if (hd.BoardId != h.BoardId)
          { error = "snapshot head pins a source from another board."; return false; }
          if (hd.Version != h.HeadVersion) { error = "snapshot head pins the wrong source version."; return false; }
          if (!string.Equals(canonical[hd.Id] ?? "", h.FamilyKey ?? "", StringComparison.Ordinal))
          {
            // Deliberate retained history: an approved head pin may stay behind
            // a scope change recorded before deny-and-upload (the moved row
            // re-enters pending and CurrentForFamily resolves by
            // family+identity, so the retained pin can never revive a
            // fallback). Allowed ONLY when no live sources remain in the head
            // family; any other cross-family pin is rejected.
            if (liveHere)
            { error = "snapshot head pins a source from another family while its own family still holds sources."; return false; }
          }
        }
        else if (liveHere)
        { error = "snapshot head has an ambiguous empty identity while its family still holds sources; resolve by uploading a new version instead."; return false; }
      }
    }
    // No-fallback on removal: a non-legacy family that still holds
    // approved rows must carry its head. A snapshot that deletes the current
    // version (and its head) while approved history survives is not a state
    // this feature can create — removal is expressed by exclusion (the head
    // is retained and the excluded target stays ineligible) or by removing
    // the whole family. Accepting a headless approved family would let
    // migration crown an older version as current evidence again. Legacy
    // graphs (uniformly empty keys, no heads) keep their controlled
    // canonicalization path. Pending-only families never need a head.
    if (!legacyShape)
    {
      var headed = new HashSet<string>(StringComparer.Ordinal);
      if (restored.heads is not null)
        foreach (var h in restored.heads)
        {
          if (h is null) continue;
          headed.Add(h.BoardId.ToString("N") + "|" + (h.FamilyKey ?? ""));
        }
      foreach (var d in byId.Values)
      {
        if (!string.Equals((d.ReviewState ?? "").Trim(), "approved", StringComparison.OrdinalIgnoreCase)) continue;
        var key = d.BoardId.ToString("N") + "|" + canonical[d.Id];
        if (!headed.Contains(key))
        { error = "snapshot leaves an approved family headless after removing its current version; exclude the current version instead of deleting it."; return false; }
      }
    }
    if (restored.events is not null)
    {
      var eventIds = new HashSet<Guid>();
      foreach (var e in restored.events)
      {
        if (e is null) { error = "snapshot event is null."; return false; }
        if (e.Id == Guid.Empty || e.BoardId == Guid.Empty || e.SourceId == Guid.Empty)
        { error = "snapshot event has an empty identity."; return false; }
        if (!eventIds.Add(e.Id)) { error = "snapshot events contain a duplicate id."; return false; }
        if (string.IsNullOrWhiteSpace(e.Action)) { error = "snapshot event has an empty action."; return false; }
        if (!byId.TryGetValue(e.SourceId, out var owner) || owner is null)
        { error = "snapshot event references an unknown source."; return false; }
        if (e.BoardId != owner.BoardId)
        { error = "snapshot event belongs to another board than its source."; return false; }
        var ownerFam = canonical[owner.Id];
        if (string.IsNullOrWhiteSpace(e.FamilyKey))
        {
          if (!legacyShape) { error = "snapshot event has an empty family outside a legacy graph."; return false; }
        }
        else if (!string.Equals(e.FamilyKey ?? "", ownerFam, StringComparison.Ordinal))
        { error = "snapshot event belongs to another family than its source."; return false; }
        var fmax = famMax.TryGetValue(owner.BoardId.ToString("N") + "|" + ownerFam, out var mv) ? mv : owner.Version;
        if (e.Version < 1 || e.Version > fmax)
        { error = "snapshot event pins a version outside its source family history."; return false; }
      }
    }
    foreach (var kv in restored.blobs)
    {
      if (!Guid.TryParse(kv.Key, out _))
      { error = "snapshot blob key is not a source id."; return false; }
      if (string.IsNullOrWhiteSpace(kv.Value)) continue;
      try { Convert.FromBase64String(kv.Value); }
      catch (FormatException) { error = "snapshot blob is not valid base64."; return false; }
    }
    return true;
  }
  public static bool ScopeReachesMeeting(SourceDoc d, Guid meetingId, InMemoryStore s)
  {
    if (d.Scope == "board") return true;
    return d.MeetingId.HasValue && d.MeetingId.Value == meetingId;
  }

  public static bool MeetingBelongsToBoard(Guid meetingId, Guid boardId, InMemoryStore s)
  {
    if (!s.Meetings.TryGetValue(meetingId, out var m)) return false;
    return m.BoardId == boardId;
  }

  // THE single eligibility predicate. Every creation/import/ingestion/
  // retrieval/recall/briefing/discussion path must call this. An approved
  // document is eligible ONLY with an existing, positive-version head whose
  // nonempty identity pins this exact row. Missing, empty, or ambiguous
  // heads fail closed; GET endpoints never establish the invariant (startup
  // Bootstrap does).
  public static bool IsEligible(InMemoryStore s, SourceDoc d, Guid? forMeetingId = null)
  {
    EnsureMigrated(s, d);
    if (!string.Equals(d.ReviewState, "approved", StringComparison.OrdinalIgnoreCase)) return false;
    if (d.Excluded) return false;
    // Strict head pinning: the promoted head version AND identity is current.
    // Older approved versions never reappear once a newer version is
    // promoted; a legacy version collision can never share eligibility.
    var head = s.SourceHeads.Values.FirstOrDefault(h => h.BoardId == d.BoardId && h.FamilyKey == d.FamilyKey);
    if (head is null || head.HeadVersion <= 0) return false;
    if (head.HeadSourceId == Guid.Empty) return false;
    if (d.Id != head.HeadSourceId) return false;
    if (d.Version != head.HeadVersion) return false;
    // Board must exist for policy; unknown board fails closed.
    if (!s.Boards.TryGetValue(d.BoardId, out var board)) return false;
    if (!PolicyAllows(board, d)) return false;
    // Unknown/dangling wiki resource fails closed (phase7 seam).
    var org = (d.Origin ?? "upload").Trim().ToLowerInvariant();
    if (org == "wiki" && (!d.ResourceId.HasValue || d.ResourceId.Value == Guid.Empty)) return false;
    if (org != "upload" && org != "wiki" && org != "inline") return false;
    // Scope check.
    if (d.Scope == "meeting")
    {
      if (!d.MeetingId.HasValue) return false;
      if (!MeetingBelongsToBoard(d.MeetingId.Value, d.BoardId, s)) return false;
      if (forMeetingId.HasValue && d.MeetingId.Value != forMeetingId.Value) return false;
    }
    else if (d.Scope != "board") return false;
    // Index must be completed with persisted sections; failed/incomplete
    // never supplies evidence.
    if (!string.Equals(d.IndexState, "completed", StringComparison.OrdinalIgnoreCase)) return false;
    // Completed string alone never suffices: require persisted sections that
    // match this exact source/version/hash/generation with nonempty text.
    // Raw extraction/original bytes must never satisfy eligibility (P2 #13).
    if (!HasValidSections(s, d)) return false;
    return true;
  }

  // Section graph identity: every section pins its exact board, source,
  // family, version, content hash, and index generation, with unique
  // positive ordinals and nonempty location/text. A section from another
  // board or family can never satisfy eligibility even when the checked
  // version/hash/generation fields coincide.
  public static bool HasValidSections(InMemoryStore s, SourceDoc d)
  {
    var secs = s.SourceSections.Values.Where(x => x.SourceId == d.Id).ToList();
    if (secs.Count == 0) return false;
    var seenOrd = new HashSet<int>();
    foreach (var sec in secs)
    {
      if (sec.BoardId != d.BoardId) return false;
      if (sec.SourceId != d.Id) return false;
      if (!string.Equals(sec.FamilyKey ?? "", d.FamilyKey ?? "", StringComparison.Ordinal)) return false;
      if (sec.SourceVersion != d.Version) return false;
      if (!string.Equals(sec.ContentHash ?? "", d.ContentHash ?? "", StringComparison.Ordinal)) return false;
      if (sec.IndexGeneration != d.IndexGeneration) return false;
      if (sec.Ordinal < 1 || !seenOrd.Add(sec.Ordinal)) return false;
      if (string.IsNullOrWhiteSpace(sec.Location)) return false;
      if (string.IsNullOrWhiteSpace(sec.Text)) return false;
    }
    return true;
  }

  public static string CanonicalSectionText(InMemoryStore s, SourceDoc d, int maxChars = 600)
  {
    var secs = s.SourceSections.Values.Where(x => x.SourceId == d.Id).OrderBy(x => x.Ordinal).Take(6).ToList();
    if (secs.Count == 0) return "";
    var joined = string.Join("\n\n", secs.Select(x => (string.IsNullOrWhiteSpace(x.Heading) ? "" : "## " + x.Heading + "\n") + x.Text));
    joined = joined.Trim();
    if (joined.Length > maxChars) joined = joined.Substring(0, maxChars) + "…";
    return joined;
  }

  public static bool ExcerptMatchesSections(InMemoryStore s, SourceDoc d, string excerpt)
  {
    if (string.IsNullOrWhiteSpace(excerpt)) return true;
    var corpus = string.Join("\n", s.SourceSections.Values
      .Where(x => x.SourceId == d.Id).OrderBy(x => x.Ordinal).Take(10).Select(x => x.Text ?? ""));
    static string Norm(string v) => string.Join(" ", v.ToLowerInvariant().Split(new[] { (char)32, (char)9, (char)10, (char)13 }, StringSplitOptions.RemoveEmptyEntries));
    return Norm(corpus).Contains(Norm(excerpt), StringComparison.Ordinal);
  }

  // Board-level recall must not leak meeting-only material: when no meeting
  // is supplied, only board-scoped docs are visible.
  public static bool VisibleForRecall(InMemoryStore s, SourceDoc d, Guid boardId, Guid? meetingId)
  {
    if (d.BoardId != boardId) return false;
    if (!meetingId.HasValue && d.Scope == "meeting") return false;
    if (meetingId.HasValue)
    {
      if (!MeetingBelongsToBoard(meetingId.Value, boardId, s)) return false;
      if (d.Scope == "meeting" && (!d.MeetingId.HasValue || d.MeetingId.Value != meetingId.Value)) return false;
    }
    return IsEligible(s, d, meetingId);
  }

  public static SourceDoc? CurrentForFamily(InMemoryStore s, Guid boardId, string familyKey)
  {
    var head = s.SourceHeads.Values.FirstOrDefault(h => h.BoardId == boardId && h.FamilyKey == familyKey);
    if (head is null || head.HeadVersion <= 0 || head.HeadSourceId == Guid.Empty) return null;
    var doc = s.Sources.Values.FirstOrDefault(x => x.BoardId == boardId && x.FamilyKey == familyKey && x.Id == head.HeadSourceId && x.Version == head.HeadVersion);
    if (doc is null) return null;
    // Current requires full eligibility (any meeting scope that could reach it).
    // Board-scoped heads are checked without meeting; meeting heads need parent.
    Guid? meeting = doc.Scope == "meeting" ? doc.MeetingId : null;
    if (doc.Scope == "meeting" && !meeting.HasValue) return null;
    return IsEligible(s, doc, meeting) ? doc : null;
  }

  // Durable per-source history row. Table-only: transactional, so a rolled
  // back unit leaves no event row. Human audit entries are appended only
  // after the unit commits (see MutateEvidence), never on failure.
  public static void RecordEvent(InMemoryStore s, SourceDoc d, string action, string detail)
  {
    var e = new SourceEvent { BoardId = d.BoardId, SourceId = d.Id, FamilyKey = d.FamilyKey, Version = d.Version, Action = action, Detail = detail ?? "", CreatedAt = DateTime.UtcNow };
    s.SourceEvents[e.Id] = e;
    try { s.SourceEvents.Flush(); } catch { }
  }

  public static void RecordAudit(InMemoryStore s, Guid boardId, string action, string detail)
  {
    try { s.Audit.Add(new AuditEvent { BoardId = boardId, Action = action, Detail = detail ?? "" }); } catch { }
  }
  // Serialized review gate. The caller/context is re-authorized INSIDE the
  // boundary against the freshly fetched rows, and the SAME freshly fetched
  // objects are validated and mutated inside the backend transaction — no
  // pre-captured tracked object is ever used as a write target. Conflicts
  // perform no review, head, event, or generation mutation and preserve exact
  // history/head/review. The already-approved branch is inside the same
  // boundary: a re-approval is a no-op only for the exact current head
  // identity under a still-allowing policy.
  public static (bool ok, string? error, int status) TryApproveById(InMemoryStore s, HttpRequest req, Guid id)
  {
    lock (s.SetupLock)
    {
      lock (s.MessageLock)
      {
        if (!s.Sources.TryGetValue(id, out var seen) || seen is null)
          return (false, "Source not found.", 404);
        EnsureMigrated(s, seen);
        if (!PeopleOps.Can(s, req, seen.BoardId, seen.MeetingId, "contribute"))
          return (false, "Access revoked or not granted for this scope.", 403);
        if (!s.Boards.TryGetValue(seen.BoardId, out var b))
          return (false, "Board not found.", 404);
        if (!PolicyAllows(b, seen))
          return (false, "Board policy forbids this source; approval blocked.", 409);
        var rs = (seen.ReviewState ?? "").Trim().ToLowerInvariant();
        var head = s.SourceHeads.Values.FirstOrDefault(h => h.BoardId == seen.BoardId && h.FamilyKey == seen.FamilyKey);
        if (head is not null && head.HeadVersion > 0)
        {
          if (seen.Version < head.HeadVersion)
            return (false, "Superseded by newer approved version v" + head.HeadVersion + "; approval rejected.", 409);
          if (seen.Version == head.HeadVersion && head.HeadSourceId != Guid.Empty && seen.Id != head.HeadSourceId)
            return (false, "Family/version collision: another approved document already heads v" + head.HeadVersion + ".", 409);
        }
        if (rs == "approved")
        {
          // Idempotent no-op only on the exact currently legal head identity.
          if (head is not null && head.HeadVersion == seen.Version
            && head.HeadSourceId != Guid.Empty && head.HeadSourceId == seen.Id)
            return (true, null, 200);
          // Approved row that is not the head (superseded or ambiguous):
          // never a silent no-op.
          return (false, "Superseded by the current family head; approval rejected.", 409);
        }
        if (rs == "rejected")
          return (false, "Rejected versions cannot be approved; upload a new version.", 409);
        var reason = "source.approve " + seen.FileName + " v" + seen.Version;
        string? failure = null;
        try
        {
          Atomic.Run(() =>
          {
            if (!s.Sources.TryGetValue(id, out var d) || d is null)
              throw new InvalidOperationException("source vanished during approval");
            if (!PeopleOps.Can(s, req, d.BoardId, d.MeetingId, "contribute"))
              throw new InvalidOperationException("authorization changed before commit");
            if (!s.Boards.TryGetValue(d.BoardId, out var cb) || cb is null)
              throw new InvalidOperationException("board vanished during approval");
            if (!PolicyAllows(cb, d))
              throw new InvalidOperationException("board policy forbids this source at commit");
            // Re-verify the legal transition on the authoritative row: any
            // drift between validation and commit fails the whole unit.
            var rrs = (d.ReviewState ?? "").Trim().ToLowerInvariant();
            if (rrs == "approved")
              throw new InvalidOperationException("version was already approved before commit");
            if (rrs == "rejected")
              throw new InvalidOperationException("version was rejected before commit");
            if (d.Version != seen.Version
              || !string.Equals(d.ContentHash ?? "", seen.ContentHash ?? "", StringComparison.Ordinal))
              throw new InvalidOperationException("source identity changed before commit");
            d.ReviewState = "approved"; d.Approved = true;
            var h = s.SourceHeads.Values.FirstOrDefault(x => x.BoardId == d.BoardId && x.FamilyKey == d.FamilyKey);
            if (h is null)
            {
              h = new SourceFamilyHead { BoardId = d.BoardId, FamilyKey = d.FamilyKey, HeadVersion = d.Version, HeadSourceId = d.Id, UpdatedAt = DateTime.UtcNow };
              s.SourceHeads[h.Id] = h;
            }
            else if (d.Version > h.HeadVersion)
            {
              h.HeadVersion = d.Version; h.HeadSourceId = d.Id; h.UpdatedAt = DateTime.UtcNow;
            }
            else if (d.Version == h.HeadVersion && h.HeadSourceId != Guid.Empty && h.HeadSourceId != d.Id)
            {
              throw new InvalidOperationException("family/version collision at promotion");
            }
            else if (d.Version == h.HeadVersion && h.HeadSourceId == Guid.Empty)
            {
              h.HeadSourceId = d.Id; h.UpdatedAt = DateTime.UtcNow;
            }
            s.Sources.Flush(); s.SourceHeads.Flush();
            RecordEvent(s, d, "approve", "v" + d.Version);
            InvalidateLocked(s, d.BoardId);
          });
        }
        catch (InvalidOperationException ex) { failure = ex.Message; }
        if (failure is not null)
          return (false, "Approval conflict; no state changed (" + failure + ").", 409);
        RecordAudit(s, seen.BoardId, "source.invalidate", reason);
        return (true, null, 200);
      }
    }
  }

  public static (bool ok, string? error, int status) TryRejectById(InMemoryStore s, HttpRequest req, Guid id)
  {
    lock (s.SetupLock)
    {
      lock (s.MessageLock)
      {
        if (!s.Sources.TryGetValue(id, out var seen) || seen is null)
          return (false, "Source not found.", 404);
        EnsureMigrated(s, seen);
        if (!PeopleOps.Can(s, req, seen.BoardId, seen.MeetingId, "contribute"))
          return (false, "Access revoked or not granted for this scope.", 403);
        var rs = (seen.ReviewState ?? "").Trim().ToLowerInvariant();
        if (rs == "rejected") return (true, null, 200);
        if (rs == "approved")
          return (false, "Approved versions cannot be rejected; exclude to revoke current evidence.", 409);
        var reason = "source.reject " + seen.FileName + " v" + seen.Version;
        string? failure = null;
        try
        {
          Atomic.Run(() =>
          {
            if (!s.Sources.TryGetValue(id, out var d) || d is null)
              throw new InvalidOperationException("source vanished during rejection");
            if (!PeopleOps.Can(s, req, d.BoardId, d.MeetingId, "contribute"))
              throw new InvalidOperationException("authorization changed before commit");
            var rrs = (d.ReviewState ?? "").Trim().ToLowerInvariant();
            if (rrs != "pending")
              throw new InvalidOperationException("review state changed before commit");
            d.ReviewState = "rejected"; d.Approved = false;
            s.Sources.Flush();
            RecordEvent(s, d, "reject", "v" + d.Version);
            InvalidateLocked(s, d.BoardId);
          });
        }
        catch (InvalidOperationException ex) { failure = ex.Message; }
        if (failure is not null)
          return (false, "Rejection conflict; no state changed (" + failure + ").", 409);
        RecordAudit(s, seen.BoardId, "source.invalidate", reason);
        return (true, null, 200);
      }
    }
  }

  public static (bool ok, string? error, int status) SetExcludedById(InMemoryStore s, HttpRequest req, Guid id, bool excluded)
  {
    lock (s.SetupLock)
    {
      lock (s.MessageLock)
      {
        if (!s.Sources.TryGetValue(id, out var seen) || seen is null)
          return (false, "Source not found.", 404);
        EnsureMigrated(s, seen);
        if (!PeopleOps.Can(s, req, seen.BoardId, seen.MeetingId, "contribute"))
          return (false, "Access revoked or not granted for this scope.", 403);
        var reason = (excluded ? "source.exclude " : "source.restore ") + seen.FileName + " v" + seen.Version;
        string? failure = null;
        try
        {
          Atomic.Run(() =>
          {
            if (!s.Sources.TryGetValue(id, out var d) || d is null)
              throw new InvalidOperationException("source vanished during exclusion change");
            if (!PeopleOps.Can(s, req, d.BoardId, d.MeetingId, "contribute"))
              throw new InvalidOperationException("authorization changed before commit");
            d.Excluded = excluded;
            s.Sources.Flush();
            RecordEvent(s, d, excluded ? "exclude" : "restore", "v" + d.Version);
            InvalidateLocked(s, d.BoardId);
          });
        }
        catch (InvalidOperationException ex) { failure = ex.Message; }
        if (failure is not null)
          return (false, "Exclusion conflict; no state changed (" + failure + ").", 409);
        RecordAudit(s, seen.BoardId, "source.invalidate", reason);
        return (true, null, 200);
      }
    }
  }
  // Central governance mutation boundary (P1 #1/#4): evidence state/head/
  // index mutations AND the affected-meeting generation increment + pause
  // happen in ONE atomic unit under SetupLock then MessageLock — the same
  // lock order the discussion publication commit holds. Source revocation
  // must never flush/commit evidence objects before acquiring these locks:
  // otherwise a publication that already passed its revocation check can
  // commit already-checked drafts after the exclusion lands. A storage
  // failure at either side rolls ALL state back; audit entries are appended
  // only after the unit commits, never on failure. No await inside.
  public static void MutateEvidence(InMemoryStore s, Guid boardId, string reason, Action mutation)
  {
    lock (s.SetupLock)
    {
      lock (s.MessageLock)
      {
        Atomic.Run(() =>
        {
          mutation();
          InvalidateLocked(s, boardId);
        });
      }
    }
    RecordAudit(s, boardId, "source.invalidate", reason ?? "");
  }

  private static void InvalidateLocked(InMemoryStore s, Guid boardId)
  {
    foreach (var m in s.Meetings.Values.Where(x => x.BoardId == boardId).ToList())
    {
      if (m.State is MeetingState.Active or MeetingState.AwaitingBrief)
      {
        m.State = MeetingState.Paused;
        m.Generation++;
      }
      else
      {
        m.Generation++;
      }
    }
    s.Meetings.Flush();
  }

  // Policy/revocation invalidation: bump generation + pause Active/AwaitingBrief
  // meetings on this board. SetupLock then MessageLock ordering (matches run path).
  // Storage failures propagate to the caller; only audit reporting is best-effort.
  // Prefer MutateEvidence when an evidence mutation accompanies the invalidation.
  public static void InvalidateForBoard(InMemoryStore s, Guid boardId, string reason)
  {
    lock (s.SetupLock)
    {
      lock (s.MessageLock)
      {
        Atomic.Run(() => InvalidateLocked(s, boardId));
      }
    }
    RecordAudit(s, boardId, "source.invalidate", reason ?? "");
  }

  // Eligibility-loss invalidation (retry/reindex path): when a mutation outside
  // the governance lock (extraction await, reindex) turns a previously eligible
  // source ineligible, affected meetings must still be paused + bumped.
  public static bool InvalidateIfEligibilityLost(InMemoryStore s, SourceDoc d, bool wasEligible, string reason)
  {
    if (!wasEligible) return false;
    Guid? meeting = d.Scope == "meeting" ? d.MeetingId : null;
    if (IsEligible(s, d, meeting)) return false;
    InvalidateForBoard(s, d.BoardId, reason);
    return true;
  }
  // Authoritative policy writer. Authorization, validation, fetch, and
  // mutation all happen inside the governance locks; the board row mutated
  // is freshly fetched inside the backend transaction (no pre-captured
  // tracked object is used as a write target). Detail audit is appended
  // only after the unit commits, never on failure.
  public static (bool ok, string? error, int status, string blocked, string mode) ApplySourcePolicy(
    InMemoryStore s, HttpRequest req, Guid bid, string blockedRaw, string? modeRaw)
  {
    lock (s.SetupLock)
    {
      lock (s.MessageLock)
      {
        if (!s.Boards.TryGetValue(bid, out var seen) || seen is null)
          return (false, "Board not found.", 404, "", "allowAll");
        if (PeopleOps.Can(s, req, bid, null, "manage") != true)
          return (false, "Access revoked or not granted for this scope.", 403, "", "allowAll");
        var mode = modeRaw;
        if (mode is null) mode = seen.SourcePolicyMode ?? "allowAll";
        mode = mode.Trim();
        var ml = mode.ToLowerInvariant();
        if (ml is not ("allowall" or "allow-all" or "wikionly" or "wiki-only" or "wiki_only"))
          return (false, "mode must be allowAll or wikiOnly.", 400, "", "allowAll");
        var canon = ml.StartsWith("wiki") ? "wikiOnly" : "allowAll";
        var parts = blockedRaw.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();
        foreach (var p in parts)
        {
          var q = p.Trim().TrimStart('.');
          if (q.Length == 0 || q.Length > 16 || q.Any(c => !(char.IsLetterOrDigit(c) || c == '-' || c == '_')))
            return (false, $"Blocked type '{p}' is not a plain extension.", 400, "", "allowAll");
        }
        var normBlocked = string.Join(", ", parts.Select(p => p.Trim().TrimStart('.').ToLowerInvariant()).Distinct());
        var changed = !string.Equals(seen.BlockedTypes ?? "", normBlocked, StringComparison.Ordinal)
          || !string.Equals(PolicyModeOf(seen), canon, StringComparison.Ordinal);
        if (changed)
        {
          string? failure = null;
          try
          {
            MutateEvidence(s, bid, "source.policy " + canon, () =>
            {
              if (!s.Boards.TryGetValue(bid, out var b) || b is null)
                throw new InvalidOperationException("board vanished during policy change");
              if (PeopleOps.Can(s, req, bid, null, "manage") != true)
                throw new InvalidOperationException("policy authorization changed before commit");
              b.BlockedTypes = normBlocked; b.SourcePolicyMode = canon; s.Boards.Flush();
              foreach (var d in s.Sources.Values.Where(x => x.BoardId == bid).ToList())
                RecordEvent(s, d, "policy", canon + "|" + normBlocked);
            });
          }
          catch (InvalidOperationException ex) { failure = ex.Message; }
          if (failure is not null)
            return (false, "Policy conflict; no state changed (" + failure + ").", 409, "", "allowAll");
          RecordAudit(s, bid, "source.policy", JsonSerializer.Serialize(new { blocked = normBlocked, mode = canon }));
        }
        return (true, null, 200, normBlocked, canon);
      }
    }
  }

  // Atomic family version reservation across upload + inline creation paths.
  // Accounts for live rows AND the retained head high-water mark, so a move
  // or removal can never free a version for reuse. Callers must hold
  // SetupLock -> MessageLock (reentrant) so concurrent creations serialize.
  public static int ReserveVersion(InMemoryStore s, Guid boardId, string familyKey)
  {
    var live = s.Sources.Values
      .Where(x => x.BoardId == boardId && x.FamilyKey == familyKey)
      .Select(x => (int?)x.Version).Max() ?? 0;
    var head = s.SourceHeads.Values.FirstOrDefault(h => h.BoardId == boardId && h.FamilyKey == familyKey);
    var high = head is null ? 0 : head.HeadVersion;
    return Math.Max(live, high) + 1;
  }

  // Index reservation for the retry/reindex/upload extraction window.
  // Every reservation carries a unique unrepeatable job ID plus the
  // process/runtime epoch and the exact captured revision: source, version,
  // hash, family, board, scope, meeting, and policy-input revision.
  // Atomically marks the source running with a fresh index generation AND,
  // when the source was eligible, pauses/bumps affected meetings in the SAME
  // unit — so no publication can slip between the last eligibility check and
  // an unprotected index mutation. Scope moves no longer exist (deny-and-
  // upload); restore bumps the epoch and clears active jobs, invalidating
  // every outstanding reservation. Extraction runs outside the locks; the
  // commit re-validates the full captured revision and discards stale work.
  public sealed record IndexReservation(
    Guid JobId, long Epoch, Guid SourceId, int Version, string ContentHash,
    string FamilyKey, Guid BoardId, string Scope, Guid? MeetingId,
    string PolicyKey, int Generation, bool WasEligible);

  public static string PolicyRevisionKey(InMemoryStore s, Guid boardId)
  {
    if (!s.Boards.TryGetValue(boardId, out var b) || b is null) return "?";
    return (b.BlockedTypes ?? "") + "|" + SourceGovernance.PolicyModeOf(b);
  }

  public static bool TryBeginIndex(InMemoryStore s, Guid id, out IndexReservation? reservation, out string error)
  {
    lock (s.SetupLock)
    {
      lock (s.MessageLock)
      {
        reservation = null; error = "";
        if (!s.Sources.TryGetValue(id, out var d) || d is null) { error = "Source not found."; return false; }
        EnsureMigrated(s, d);
        Guid? meeting = d.Scope == "meeting" ? d.MeetingId : null;
        var wasEligible = IsEligible(s, d, meeting);
        var policyKey = PolicyRevisionKey(s, d.BoardId);
        IndexReservation? made = null;
        Atomic.Run(() =>
        {
          if (!s.Sources.TryGetValue(id, out var cur) || cur is null)
            throw new InvalidOperationException("source vanished during index reservation");
          var jobId = Guid.NewGuid();
          cur.IndexState = "running";
          cur.IndexGeneration = cur.IndexGeneration <= 0 ? 1 : cur.IndexGeneration + 1;
          cur.IndexError = "";
          s.Sources.Flush();
          s.ActiveIndexJobs[id] = new ActiveIndexJob(jobId, s.SourceEpoch, cur.IndexGeneration);
          if (wasEligible) InvalidateLocked(s, cur.BoardId);
          made = new IndexReservation(jobId, s.SourceEpoch, cur.Id, cur.Version, cur.ContentHash ?? "",
            cur.FamilyKey ?? "", cur.BoardId, cur.Scope ?? "board", cur.MeetingId, policyKey,
            cur.IndexGeneration, wasEligible);
        });
        reservation = made;
        return true;
      }
    }
  }

  // Index commit. Re-fetches the CURRENT row under the governance locks and
  // verifies the unique job, the runtime epoch, and the full captured
  // revision before touching sections: a concurrent retry, a restore that
  // replaced state, or a policy change during extraction discards the stale
  // completion instead of publishing stale sections. The CURRENT review
  // decision is never overwritten — a rejection or approval during
  // extraction simply stands. Returns stale=true on any mismatch; the
  // caller must report a conflict and change nothing further.
  public static (bool ok, bool stale, bool eligibilityLost, string? error, int status) FinishIndex(
    InMemoryStore s, IndexReservation res, bool isReindex)
  {
    lock (s.SetupLock)
    {
      lock (s.MessageLock)
      {
        if (res.Epoch != s.SourceEpoch)
          return (false, true, false, "Index epoch changed during indexing (restore replaced state); reindex required.", 409);
        if (!s.ActiveIndexJobs.TryGetValue(res.SourceId, out var active)
          || active.JobId != res.JobId || active.Epoch != res.Epoch || active.Generation != res.Generation)
          return (false, true, false, "A newer index attempt superseded this one; stale completion discarded.", 409);
        if (!s.Sources.TryGetValue(res.SourceId, out var d) || d is null)
          return (false, true, false, "Source is gone; stale index completion discarded.", 409);
        EnsureMigrated(s, d);
        if (d.Version != res.Version
          || !string.Equals(d.ContentHash ?? "", res.ContentHash ?? "", StringComparison.Ordinal)
          || !string.Equals(d.FamilyKey ?? "", res.FamilyKey ?? "", StringComparison.Ordinal)
          || d.BoardId != res.BoardId
          || !string.Equals(d.Scope ?? "", res.Scope ?? "", StringComparison.OrdinalIgnoreCase)
          || d.MeetingId != res.MeetingId
          || !string.Equals(PolicyRevisionKey(s, d.BoardId), res.PolicyKey, StringComparison.Ordinal))
          return (false, true, false, "Source identity or policy changed during indexing; stale completion discarded.", 409);
        if (!string.Equals(d.IndexState ?? "", "running", StringComparison.OrdinalIgnoreCase)
          || d.IndexGeneration != res.Generation)
          return (false, true, false, "A newer index attempt superseded this one; stale completion discarded.", 409);
        string? failure = null;
        var eventName = isReindex ? "reindex" : "index";
        try
        {
          Atomic.Run(() =>
          {
            // Fail closed on explicit extraction failure: raw Original bytes must
            // not stand in for extractor output. Textual uploads extract locally;
            // anything else requires a successful extractor result first.
            var md = Extraction.MarkdownOf(d.ExtractionJson);
            string extStatus = "";
            try
            {
              using var ej = JsonDocument.Parse(string.IsNullOrWhiteSpace(d.ExtractionJson) ? "{}" : d.ExtractionJson);
              if (ej.RootElement.TryGetProperty("status", out var st) && st.ValueKind == JsonValueKind.String)
                extStatus = (st.GetString() ?? "").Trim().ToLowerInvariant();
            }
            catch (JsonException) { }
            if (string.IsNullOrWhiteSpace(md) && (extStatus == "failed" || extStatus == "unreachable"))
            {
              d.IndexState = "failed";
              d.IndexError = "extraction " + extStatus + "; raw bytes are not indexed without extractor output";
              d.IndexCompletedAt = DateTime.UtcNow;
              s.Sources.Flush();
              RecordEvent(s, d, eventName + "-failed", d.IndexError);
              return;
            }
            var text = ReadableTextFor(d);
            if (string.IsNullOrWhiteSpace(text))
            {
              d.IndexState = "failed";
              d.IndexError = string.IsNullOrWhiteSpace(Extraction.MarkdownOf(d.ExtractionJson)) ? "no extractable text; extraction failed or binary without extractor output" : "empty text";
              d.IndexCompletedAt = DateTime.UtcNow;
              s.Sources.Flush();
              RecordEvent(s, d, eventName + "-failed", d.IndexError);
              return;
            }
            var built = BuildSections(text);
            if (built.Count == 0)
            {
              d.IndexState = "failed"; d.IndexError = "no sections built"; d.IndexCompletedAt = DateTime.UtcNow;
              s.Sources.Flush();
              RecordEvent(s, d, eventName + "-failed", d.IndexError);
              return;
            }
            foreach (var old in s.SourceSections.Values.Where(x => x.SourceId == d.Id).ToList())
              s.SourceSections.TryRemove(old.Id, out _);
            int ord = 1;
            foreach (var b in built)
            {
              var sec = new SourceSection
              {
                BoardId = d.BoardId, SourceId = d.Id, FamilyKey = d.FamilyKey,
                SourceVersion = d.Version, ContentHash = d.ContentHash,
                Ordinal = ord++, Heading = b.Heading, Location = b.Location,
                Text = b.Text, IndexGeneration = res.Generation, CreatedAt = DateTime.UtcNow,
              };
              s.SourceSections[sec.Id] = sec;
            }
            d.IndexState = "completed"; d.IndexError = ""; d.IndexCompletedAt = DateTime.UtcNow;
            s.Sources.Flush(); s.SourceSections.Flush();
            RecordEvent(s, d, eventName, "gen" + res.Generation + " sections" + built.Count);
          });
        }
        catch (Exception ex)
        {
          failure = ex.Message;
        }
        if (failure is not null)
          return (false, false, false, failure, 500);
        // Retire the completed reservation only if it is still current.
        if (s.ActiveIndexJobs.TryGetValue(res.SourceId, out var cur)
          && cur.JobId == res.JobId && cur.Epoch == res.Epoch)
          s.ActiveIndexJobs.TryRemove(res.SourceId, out _);
        Guid? fmeeting = d.Scope == "meeting" ? d.MeetingId : null;
        var nowEligible = IsEligible(s, d, fmeeting);
        var lost = res.WasEligible && !nowEligible;
        // The Begin reservation already paused affected meetings when the
        // source was eligible; only report here, never restore old state.
        RecordAudit(s, d.BoardId, "source.index", eventName + " " + d.FileName + " v" + d.Version + " gen" + res.Generation);
        return (true, false, lost, null, 200);
      }
    }
  }
  // Stamp extractor output only when this reservation is still the current
  // running attempt for the current epoch; a superseded attempt must not
  // overwrite newer output.
  public static void StampExtraction(InMemoryStore s, IndexReservation res, string extractionJson)
  {
    lock (s.SetupLock)
    {
      lock (s.MessageLock)
      {
        if (res.Epoch != s.SourceEpoch) return;
        if (!s.ActiveIndexJobs.TryGetValue(res.SourceId, out var job) || job.JobId != res.JobId || job.Epoch != res.Epoch) return;
        if (s.Sources.TryGetValue(res.SourceId, out var cur) && cur is not null
          && string.Equals(cur.IndexState ?? "", "running", StringComparison.OrdinalIgnoreCase)
          && cur.IndexGeneration == res.Generation)
        {
          cur.ExtractionJson = extractionJson;
          try { s.Sources.Flush(); } catch { }
        }
      }
    }
  }

  public static string ReadableTextFor(SourceDoc d)
  {
    var md = Extraction.MarkdownOf(d.ExtractionJson);
    if (!string.IsNullOrWhiteSpace(md)) return md!;
    // Direct Original-byte decoding is restricted to supported textual
    // formats: a printable binary payload (e.g. PDF) must never become
    // completed sections without a successful extractor result.
    if (!Extraction.IsTextual(d.FileName ?? "")) return "";
    if (d.Original is null) return "";
    try
    {
      var text = Encoding.UTF8.GetString(d.Original);
      if (string.IsNullOrEmpty(text)) return "";
      var printable = text.Count(c => !char.IsControl(c) || c is '\n' or '\r' or '\t');
      if ((double)printable / Math.Max(1, text.Length) < 0.7) return "";
      return text.Length > MaxTotalChars ? text.Substring(0, MaxTotalChars) : text;
    }
    catch { return ""; }
  }

  public sealed record BuiltSection(string Heading, string Location, string Text);

  public static List<BuiltSection> BuildSections(string fullText)
  {
    var out_ = new List<BuiltSection>();
    if (string.IsNullOrWhiteSpace(fullText)) return out_;
    var text = fullText.Length > MaxTotalChars ? fullText.Substring(0, MaxTotalChars) : fullText;
    var lines = text.Split('\n');
    string curHeading = "";
    var cur = new StringBuilder();
    int loc = 1;
    void Flush()
    {
      var t = cur.ToString().Trim();
      if (t.Length == 0) return;
      var chunk = t;
      int start = 0;
      while (start < chunk.Length && out_.Count < MaxSections)
      {
        var len = Math.Min(MaxSectionChars, chunk.Length - start);
        out_.Add(new BuiltSection(curHeading, "sec-" + loc + "#" + (out_.Count + 1), chunk.Substring(start, len).Trim()));
        start += len;
        loc++;
      }
      cur.Clear();
    }
    foreach (var raw in lines)
    {
      if (out_.Count >= MaxSections) break;
      var line = raw.TrimEnd('\r');
      var trimmed = line.Trim();
      if ((trimmed.StartsWith("# ") || trimmed.StartsWith("## ") || trimmed.StartsWith("### ")) && cur.Length > 0)
      {
        Flush();
        curHeading = trimmed.TrimStart('#', ' ').Trim();
        if (curHeading.Length > 120) curHeading = curHeading.Substring(0, 120);
        cur.AppendLine(line);
      }
      else
      {
        if (trimmed.StartsWith("#")) { curHeading = trimmed.TrimStart('#', ' ').Trim(); if (curHeading.Length > 120) curHeading = curHeading.Substring(0, 120); }
        cur.AppendLine(line);
        if (cur.Length > MaxSectionChars * 2) Flush();
      }
    }
    Flush();
    if (out_.Count == 0 && text.Trim().Length > 0)
      out_.Add(new BuiltSection("", "sec-1#1", text.Trim().Substring(0, Math.Min(MaxSectionChars, text.Trim().Length))));
    return out_.Take(MaxSections).ToList();
  }

  // Revision hash over the actual persisted section identities and text
  // (section IDs, ordinals, headings, locations, text). A restore that keeps
  // source ID/version/generation/hash and section count while swapping
  // section text changes this hash, so in-flight publications still discard.
  public static string SectionRevision(InMemoryStore s, Guid sourceId)
  {
    var parts = s.SourceSections.Values.Where(x => x.SourceId == sourceId)
      .OrderBy(x => x.Ordinal).ThenBy(x => x.Id)
      .Select(x => x.Id.ToString("N") + "|" + x.Ordinal + "|" + (x.Heading ?? "") + "|" + (x.Location ?? "") + "|" + (x.Text ?? ""));
    using var sha = SHA256.Create();
    return Convert.ToHexString(sha.ComputeHash(Encoding.UTF8.GetBytes(string.Join("\n", parts)))).ToLowerInvariant();
  }

  // Eligible-input fingerprint for publication/briefing boundaries. Pins the
  // exact eligible set with per-source version, index generation, content
  // hash, and section revision, so a same-bytes/version reindex that
  // silently swaps text — or a restore that replays identical counters with
  // different text — still discards in-flight drafts.
  public static List<string> EligibleFingerprint(InMemoryStore s, Guid boardId, Guid meetingId)
  {
    return s.Sources.Values
      .Where(x => x.BoardId == boardId && IsEligible(s, x, meetingId))
      .OrderBy(x => x.Id.ToString("N"))
      .Select(x => x.Id.ToString("N") + ":v" + x.Version + ":g" + x.IndexGeneration + ":"
        + (x.ContentHash ?? "") + ":s" + SectionRevision(s, x.Id))
      .ToList();
  }

  // External recall hits must never bypass governance: drop hits that claim a
  // source identity but do not resolve to an eligible doc under the SAME
  // board-vs-meeting visibility rule as local recall (board-level recall must
  // not leak meeting-only material, P1 #3). Accepted hits are re-resolved to
  // canonical persisted section text: remote text is untrusted and never
  // returned verbatim. Hindsight-kind hits remain informational only and are
  // never promoted to source EvidenceRefs.
  public static List<ContextCurator.RecallHit> FilterExternalHits(InMemoryStore s, Guid boardId, IEnumerable<ContextCurator.RecallHit> remote, Guid? meetingId)
  {
    var kept = new List<ContextCurator.RecallHit>();
    foreach (var h in remote)
    {
      var kind = (h.Kind ?? "").Trim().ToLowerInvariant();
      var rf = (h.Ref ?? "").Trim();
      if (kind == "source" || kind.StartsWith("source:") || kind == "hindsight:source" || kind.StartsWith("hindsight:source"))
      {
        if (Guid.TryParse(rf.Split(' ').FirstOrDefault() ?? "", out var sid)
          && s.Sources.TryGetValue(sid, out var doc)
          && doc.BoardId == boardId
          && VisibleForRecall(s, doc, boardId, meetingId))
        {
          var canon = CanonicalSectionText(s, doc);
          if (string.IsNullOrWhiteSpace(canon)) continue; // eligible yet sectionless: fail closed
          kept.Add(h with { Ref = doc.FileName + " v" + doc.Version, Text = canon });
        }
        // else: unresolvable/ineligible/external source hit — drop (fail closed).
        continue;
      }
      // Non-source external hits pass through as informational only.
      kept.Add(h);
    }
    return kept;
  }

  // Evidence resolution with explicit destination visibility. A board-wide
  // destination (meetingId null) accepts board-scoped sources only:
  // meeting-only sources can never land in a board-wide direction, even
  // though they are eligible inside their own meeting.
  public static List<EvidenceRef> ResolveEvidence(InMemoryStore s, IEnumerable<EvidenceRef> refs, Guid boardId, Guid? meetingId)
  {
    var ok = new List<EvidenceRef>();
    foreach (var r in refs)
    {
      if (r is null) continue;
      if (!string.Equals(r.Kind, "source", StringComparison.OrdinalIgnoreCase)) { ok.Add(r); continue; }
      if (!Guid.TryParse(r.Ref, out var sid)) continue;
      if (!s.Sources.TryGetValue(sid, out var doc)) continue;
      if (doc.BoardId != boardId) continue;
      if (!meetingId.HasValue && doc.Scope != "board") continue;
      if (!IsEligible(s, doc, meetingId)) continue;
      if (r.Version.HasValue && r.Version.Value != doc.Version) continue; // stale version pin
      // Caller-supplied excerpts are untrusted quotations, not evidence (P2 #10):
      // an eligible identity never authenticates the quoted text. Keep the
      // caller text only when it matches persisted sections; otherwise resolve
      // the canonical excerpt from stored sections.
      var excerpt = r.Excerpt;
      if (!string.IsNullOrWhiteSpace(excerpt) && !ExcerptMatchesSections(s, doc, excerpt!))
        excerpt = null;
      if (string.IsNullOrWhiteSpace(excerpt))
        excerpt = CanonicalSectionText(s, doc);
      ok.Add(new EvidenceRef("source", doc.Id.ToString(), doc.Version, null, doc.FileName, excerpt));
    }
    return ok;
  }
}
