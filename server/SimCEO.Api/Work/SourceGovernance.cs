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
  /// <summary>Code-only FinishIndex fault seam for rollback tests. In-process QA may set
  /// <see cref="FinishIndexCallbackFault"/> to force the ACTUAL FinishIndex unit callback to fail AFTER
  /// staged section/head/event writes, proving full rollback. Never exposed via HTTP routes, environment,
  /// or headers: it is a plain in-process Func like the PgFaults seams.</summary>
  public static Func<bool>? FinishIndexCallbackFault;

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


  public static bool IsWikiOrigin(string? origin) =>
    string.Equals((origin ?? "").Trim(), "wiki", StringComparison.OrdinalIgnoreCase);

  // Shared canonical identity (Source6 + Wiki7 integration contract). Upload
  // families canonicalize from board/scope/meeting/origin/file. Wiki families
  // are resource-bound and IMMUTABLE: the stored key is validated structurally
  // (resource binding + original locale/path) and never recomputed from mutable
  // resource config, so reconfigured locales/rules cannot rewrite historical
  // families or collapse distinct connectors. Returns false with an explicit
  // error for empty wiki keys (re-sync the connector) and structural mismatches.
  public static bool TryCanonicalFamilyKey(SourceDoc d, out string canonical, out string error)
  {
    canonical = ""; error = "";
    if (!IsWikiOrigin(d.Origin))
    {
      canonical = FamilyKeyFor(d.BoardId, d.Scope, d.MeetingId, d.Origin, d.FileName);
      return true;
    }
    var parts = (d.FamilyKey ?? "").Split("|");
    if (parts.Length != 7 || parts[3] != "wiki")
    { error = "Snapshot wiki source family is not a resource-bound wiki identity; re-sync the connector instead of migrating a bare key."; return false; }
    if (!Guid.TryParseExact(parts[0], "N", out var b) || b != d.BoardId)
    { error = "Snapshot wiki source family binds another board."; return false; }
    var sc = (d.Scope ?? "").Trim().ToLowerInvariant() == "meeting" ? "meeting" : "board";
    if (parts[1] != sc)
    { error = "Snapshot wiki source family binds another scope."; return false; }
    var mid = sc == "meeting" && d.MeetingId.HasValue ? d.MeetingId.Value.ToString("N") : "-";
    if (parts[2] != mid)
    { error = "Snapshot wiki source family binds another meeting."; return false; }
    if (!Guid.TryParseExact(parts[4], "N", out var rid) || !d.ResourceId.HasValue || rid != d.ResourceId.Value)
    { error = "Snapshot wiki source family binds another connector resource."; return false; }
    if (!string.Equals(parts[6] ?? "", d.FileName ?? "", StringComparison.Ordinal))
    { error = "Snapshot wiki source path does not match its family identity; re-sync the connector instead."; return false; }
    canonical = d.FamilyKey;
    return true;
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
    if (string.IsNullOrWhiteSpace(d.FamilyKey) && !IsWikiOrigin(d.Origin))
    {
      // Wiki rows never take an upload-style key here: an empty wiki family
      // means the connector must re-sync, not a silent recomputation.
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
  // Server-owned legacy version alias: migrate-version events record the
  // ORIGINAL version a renumbered duplicate carried before canonicalization.
  // Currency (head winner, eligibility lineage) is decided by original
  // version, then creation order: an old duplicate parked above the actual
  // newer version never outranks it. No schema change: the alias is derived
  // from persisted, backed-up history events.
  public static int OriginalVersionOf(InMemoryStore s, SourceDoc d)
  {
    try
    {
      var best = d.Version;
      var found = false;
      foreach (var e in s.SourceEvents.Values.Where(x => x.SourceId == d.Id && string.Equals(x.Action ?? "", "migrate-version", StringComparison.OrdinalIgnoreCase)).ToList())
      {
        var det = e.Detail ?? "";
        var arrow = det.IndexOf("->", StringComparison.Ordinal);
        if (arrow <= 1) continue;
        var from = det.Substring(0, arrow).Trim().TrimStart('v', 'V');
        if (int.TryParse(from, out var fv) && fv >= 1 && (!found || fv < best)) { best = fv; found = true; }
      }
      return found ? best : d.Version;
    }
    catch { return d.Version; }
  }

  public static void EnsureMissingHeads(InMemoryStore s)
  {
    var fams = s.Sources.Values
      .Where(x => string.Equals(x.ReviewState, "approved", StringComparison.OrdinalIgnoreCase))
      .GroupBy(x => (x.BoardId, x.FamilyKey))
      .ToList();
    foreach (var g in fams)
    {
      if (s.SourceHeads.Values.Any(h => h.BoardId == g.Key.BoardId && h.FamilyKey == g.Key.FamilyKey && !(h.HeadVersion <= 0 && h.HeadSourceId == Guid.Empty))) continue;
      // Winner by ORIGINAL version (alias), then earliest creation: an old
      // duplicate renumbered above the actual newer version never wins.
      var ordered = g.Select(x => new { row = x, orig = OriginalVersionOf(s, x) })
        .OrderByDescending(x => x.orig).ThenBy(x => x.row.CreatedAt).ThenBy(x => x.row.Id).ToList();
      var win = ordered.First();
      // Fold any stub allocation tracker water into the promoted head so no
      // allocation history is lost when the real head materializes.
      var stubHw = s.SourceHeads.Values.Where(h => h.BoardId == g.Key.BoardId && h.FamilyKey == g.Key.FamilyKey && h.HeadVersion <= 0 && h.HeadSourceId == Guid.Empty).Select(h => (int?)h.HighWater).Max() ?? 0;
      // Family floor (provenance baseline): first-known legitimate version =
      // min present version across ALL family rows (approved or pending), folded
      // with any stub floor already recorded for this family.
      var famMin = s.Sources.Values.Where(x => x.BoardId == g.Key.BoardId && x.FamilyKey == g.Key.FamilyKey).Select(x => (int?)x.Version).Min() ?? win.row.Version;
      var stubFloor = s.SourceHeads.Values.Where(h => h.BoardId == g.Key.BoardId && h.FamilyKey == g.Key.FamilyKey && h.HeadVersion <= 0 && h.HeadSourceId == Guid.Empty && h.FloorVersion >= 1).Select(h => (int?)h.FloorVersion).Min() ?? famMin;
      var head = new SourceFamilyHead { BoardId = g.Key.BoardId, FamilyKey = g.Key.FamilyKey, HeadVersion = win.row.Version, HeadSourceId = win.row.Id, HighWater = Math.Max(g.Max(x => x.Version), stubHw), FloorVersion = Math.Min(famMin, stubFloor), UpdatedAt = DateTime.UtcNow };
      s.SourceHeads[head.Id] = head;
      // Remove absorbed stubs in the same unit: a leftover zero-version row would
      // make unordered head lookups ambiguous between the stub and the real head.
      foreach (var sh in s.SourceHeads.Values.Where(h => h.Id != head.Id && h.BoardId == g.Key.BoardId && h.FamilyKey == g.Key.FamilyKey && h.HeadVersion <= 0 && h.HeadSourceId == Guid.Empty).ToList())
        s.SourceHeads.TryRemove(sh.Id, out _);
    }
    // Maintain monotonic high-water on existing heads, and backfill the family
    // floor for pre-provenance heads (upgrade path): the truthful first-known
    // version is the min present version on live/accepted data. Never raises an
    // established floor and never invents history: governed flows only ever add
    // rows above the floor. Blank-family heads are skipped (transient legacy
    // state converges through canonicalization first).
    foreach (var h in s.SourceHeads.Values.ToList())
    {
      var liveMax = s.Sources.Values.Where(x => x.BoardId == h.BoardId && x.FamilyKey == h.FamilyKey).Select(x => (int?)x.Version).Max() ?? 0;
      var want = Math.Max(Math.Max(h.HeadVersion, liveMax), h.HighWater);
      if (want != h.HighWater) { h.HighWater = want; h.UpdatedAt = DateTime.UtcNow; }
      if (h.FloorVersion <= 0 && !string.IsNullOrWhiteSpace(h.FamilyKey))
      {
        var liveMin = s.Sources.Values.Where(x => x.BoardId == h.BoardId && x.FamilyKey == h.FamilyKey).Select(x => (int?)x.Version).Min();
        if (liveMin.HasValue && liveMin.Value >= 1) { h.FloorVersion = liveMin.Value; h.UpdatedAt = DateTime.UtcNow; }
      }
    }
    // Provenance stubs for headless families (P1 sparse): pending-only sparse
    // families (e.g. genuine single-v3 legacy migrations) carry no head, event,
    // or approval history, so a floor-less restore cannot tell them from
    // partial-family removal. Record the truthful first-known floor (min
    // present version) and high-water (max present) in a stub head (version 0,
    // empty identity): stubs never satisfy headship, are skipped by
    // head-coverage validation, and fold into real heads on promotion. Backup
    // tampering (a member deleted post-export) still rejects because the
    // exported stub retains the pre-deletion floor.
    foreach (var fg in s.Sources.Values.ToList().GroupBy(x => (x.BoardId, x.FamilyKey)).ToList())
    {
      if (string.IsNullOrWhiteSpace(fg.Key.FamilyKey)) continue;
      if (s.SourceHeads.Values.Any(h => h.BoardId == fg.Key.BoardId && h.FamilyKey == fg.Key.FamilyKey)) continue;
      var fmin = fg.Min(x => x.Version);
      var fmax = fg.Max(x => x.Version);
      if (fmin < 1 || fmax < 1) continue;
      var stub = new SourceFamilyHead { BoardId = fg.Key.BoardId, FamilyKey = fg.Key.FamilyKey, HeadVersion = 0, HeadSourceId = Guid.Empty, HighWater = fmax, FloorVersion = fmin, UpdatedAt = DateTime.UtcNow };
      s.SourceHeads[stub.Id] = stub;
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
        Atomic.Run(s, () =>
        {
          foreach (var d in s.Sources.Values.ToList()) EnsureMigrated(s, d);
          // 1. Canonical family identity for every non-wiki row. Legacy rows may
          // carry wrong or empty keys (path prefixes, case variants,
          // pre-family snapshots); new code always writes canonical keys,
          // so this step converges immediately. Wiki rows are resource-bound
          // and immutable: validated structurally by TryCanonicalFamilyKey,
          // never recomputed from mutable resource config.
          foreach (var d in s.Sources.Values.ToList())
          {
            if (IsWikiOrigin(d.Origin)) continue;
            var canon = FamilyKeyFor(d.BoardId, d.Scope, d.MeetingId, d.Origin, d.FileName);
            if (!string.Equals(d.FamilyKey ?? "", canon, StringComparison.Ordinal))
              d.FamilyKey = canon;
          }
          // 2. Deterministic same-version collision resolution per canonical
          // family. The earliest row (CreatedAt, Id) keeps its version;
          // later duplicates move above the live max, preserving every
          // document/content/identity/history row. Dependent section and
          // event versions follow; the original version is recorded as a
          // migrate-version event (the server-owned original-version alias).
          // Currency is decided by that alias, so a parked duplicate never
          // outranks the actual newer version it once collided with.
          ResolveCollisions(s);
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
            {
              if (drop.HighWater > keep.HighWater) keep.HighWater = drop.HighWater;
              if (drop.FloorVersion >= 1) keep.FloorVersion = keep.FloorVersion >= 1 ? Math.Min(keep.FloorVersion, drop.FloorVersion) : drop.FloorVersion;
              s.SourceHeads.TryRemove(drop.Id, out _);
            }
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

  // Shared collision resolver: also used by legacy-restore migration so a
  // genuine predecessor backup with old inline-v1 duplicates canonicalizes
  // through the same deterministic path as a live predecessor database.
  public static void ResolveCollisions(InMemoryStore s)
  {
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
        var hw = s.SourceHeads.Values.FirstOrDefault(h => h.BoardId == d.BoardId && h.FamilyKey == d.FamilyKey);
        if (hw is not null && maxV > hw.HighWater) hw.HighWater = maxV;
        RecordEvent(s, d, "migrate-version", "v" + oldV + "->v" + maxV);
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
  static bool IsPlaceholderHash(string? h)
  {
    var c = (h ?? "").Trim().ToLowerInvariant();
    if (c.Length != 64) return true;
    return !System.Text.RegularExpressions.Regex.IsMatch(c, "^[0-9a-f]{64}$");
  }

  public static void MigrateRestoredSources(InMemoryStore s)
  {
    foreach (var d in s.Sources.Values.ToList()) EnsureMigrated(s, d);
    // Legacy placeholder repair: predecessor rows whose hash is not a real
    // content hash adopt the restored bytes (validation only admits these
    // inside uniformly legacy graphs, and those carry no sections to repin).
    foreach (var d in s.Sources.Values.ToList())
    {
      if (d.Original is not null && d.Original.Length > 0 && IsPlaceholderHash(d.ContentHash))
      {
        try
        {
          using var sha = System.Security.Cryptography.SHA256.Create();
          d.ContentHash = Convert.ToHexString(sha.ComputeHash(d.Original)).ToLowerInvariant();
        }
        catch { }
      }
    }
    foreach (var d in s.Sources.Values.ToList())
    {
      if (string.IsNullOrWhiteSpace(d.FamilyKey) && !IsWikiOrigin(d.Origin))
        d.FamilyKey = FamilyKeyFor(d.BoardId, d.Scope, d.MeetingId, d.Origin, d.FileName);
    }
    // Same deterministic collision path as live startup: predecessor inline
    // duplicates canonicalize and renumber here instead of being rejected.
    ResolveCollisions(s);
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
      || restored.leads is null
      || restored.images is null)
    { error = "snapshot is missing required collections."; return false; }
    foreach (var b in restored.boards)
    { if (b is null) { error = "snapshot board is null."; return false; } }
    var boardIds = new HashSet<Guid>(restored.boards.Where(b => b is not null).Select(b => b.Id));
    // Uniformly-legacy predecessor graphs (empty keys, no sections/heads/
    // events) defer key + collision validation to the controlled restore
    // migration, which canonicalizes and resolves collisions deterministically.
    bool legacyKeys = restored.sources.All(d => d is null || string.IsNullOrWhiteSpace(d.FamilyKey))
      && (restored.sections is null || restored.sections.All(x => x is null))
      && (restored.heads is null || restored.heads.All(x => x is null))
      && (restored.events is null || restored.events.All(x => x is null));
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
      // Shared canonical identity: upload families recompute from request fields;
      // wiki families validate structurally against their immutable resource binding
      // and are never recomputed from mutable resource config.
      if (!TryCanonicalFamilyKey(d, out var canon, out var famErr))
      { error = famErr; return false; }
      if (string.IsNullOrWhiteSpace(d.FamilyKey))
      {
        // Empty key: only legitimate as a uniformly empty legacy graph,
        // canonicalized (+collisions resolved) inside the restore unit.
        // Wiki rows never take this path (empty wiki keys fail closed above).
        if (!legacyKeys)
        { error = "snapshot source has an empty family outside a legacy graph."; return false; }
        canonical[d.Id] = canon;
      }
      else if (!string.Equals(d.FamilyKey, canon, StringComparison.Ordinal))
      { error = "snapshot source family is forged: '" + d.FamilyKey + "' is not the canonical identity for this board/scope/meeting/origin/file."; return false; }
      else canonical[d.Id] = d.FamilyKey;
      var fv = d.BoardId.ToString("N") + "|" + canonical[d.Id] + "|v" + d.Version;
      if (!legacyKeys && !familyVersions.Add(fv)) { error = "snapshot sources contain an ambiguous family/version collision; resolve by uploading a new version instead."; return false; }
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
    var famVersions = new Dictionary<string, HashSet<int>>(StringComparer.Ordinal);
    foreach (var d in byId.Values)
    {
      var fk = canonical[d.Id];
      var key = d.BoardId.ToString("N") + "|" + fk;
      famMax[key] = famMax.TryGetValue(key, out var m) ? Math.Max(m, d.Version) : d.Version;
      if (!famVersions.TryGetValue(key, out var vs)) { vs = new HashSet<int>(); famVersions[key] = vs; }
      vs.Add(d.Version);
    }
    // Floor-aware density (family provenance baseline): every version in
    // floor..max must be present. The floor comes from staged head/stub
    // provenance (0/unknown = strict dense-from-1). Genuine sparse legacy
    // families (first-known v3, no v1/v2 ever) carry their floor in an exported
    // stub; backup tampering (a member deleted post-export) still rejects
    // because the stub retains the pre-deletion floor.
    // No silent partial-family removal: surviving non-legacy families must
    // hold dense versions floor..max. A gap means versions were deleted outside
    // the supported whole-family removal or exclusion; reject instead of
    // recycling numbers.
    if (!legacyKeys)
    {
      var famFloor = new Dictionary<string, int>(StringComparer.Ordinal);
      if (restored.heads is not null)
        foreach (var hh in restored.heads)
        {
          if (hh is null || string.IsNullOrWhiteSpace(hh.FamilyKey) || hh.FloorVersion < 1) continue;
          var hk = hh.BoardId.ToString("N") + "|" + hh.FamilyKey;
          if (!famFloor.TryGetValue(hk, out var ffe) || hh.FloorVersion < ffe) famFloor[hk] = hh.FloorVersion;
        }
      foreach (var kv in famVersions)
      {
        var max = famMax[kv.Key];
        var floor = famFloor.TryGetValue(kv.Key, out var ffg) ? ffg : 1;
        if (floor > max) { error = "snapshot family floor v" + floor + " is above its maximum v" + max + "; partial-family state is not supported."; return false; }
        for (var v = floor; v <= max; v++)
          if (!kv.Value.Contains(v))
          { error = "snapshot family skips version v" + v + "; partial-family removal is not supported (exclude or remove the whole family instead)."; return false; }
      }
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
        var ownerFailed = string.Equals(owner.IndexState ?? "", "failed", StringComparison.OrdinalIgnoreCase)
        || string.Equals(owner.IndexState ?? "", "running", StringComparison.OrdinalIgnoreCase);
      // Failed/running sources keep their last good sections under the older
      // generation; the source is ineligible until a successful reindex
      // rebuilds matching sections, so the relaxed pin cannot launder evidence.
      if (ownerFailed)
      {
        if (sec.IndexGeneration < 0 || sec.IndexGeneration > owner.IndexGeneration)
        { error = "snapshot section pins an index generation newer than its failed source."; return false; }
      }
      else if (sec.IndexGeneration != owner.IndexGeneration) { error = "snapshot section pins the wrong index generation."; return false; }
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
      if (h.HighWater < 0) { error = "snapshot head has an illegal high-water."; return false; }
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
        {
          // Allocation stubs (version 0, empty identity) are legitimate
          // pending-family high-water markers created by ReserveVersion, not
          // ambiguous head pins: they never satisfy headship and are folded on
          // promotion. Only a non-stub headless pin rejects here; an approved
          // family backed by a stub alone still fails the head-coverage check
          // below, so headless-approved revival stays closed.
          var isAllocStub = h.HeadVersion <= 0 && h.HeadSourceId == Guid.Empty;
          if (!isAllocStub)
          { error = "snapshot head has an ambiguous empty identity while its family still holds sources; resolve by uploading a new version instead."; return false; }
        }
        // Persisted allocation high-water must cover the family maximum and
        // the head pin: a lowered high-water would silently recycle a retired
        // version number for new content.
        if (byId.Values.Any(x => x.BoardId == h.BoardId && canonical[x.Id] == h.FamilyKey))
        {
          var fmax = byId.Values.Where(x => x.BoardId == h.BoardId && canonical[x.Id] == h.FamilyKey).Max(x => x.Version);
          // HighWater 0 means unmaintained (heads promoted before water tracking);
          // MigrateRestoredSources recomputes it after replacement, so only a
          // present-but-insufficient water rejects. ReserveVersion also floors on
          // live rows, so no version is ever recycled through a zero water.
          if (h.HighWater != 0 && (h.HighWater < fmax || h.HighWater < h.HeadVersion))
          { error = "snapshot head high-water does not cover its family; versions would be recycled."; return false; }
        }
        // Persisted family floor (provenance baseline): 0 = unknown/pre-provenance
        // (strict dense-from-1 applies in the family check). A negative floor is
        // forged; a floor above a positive head pin is inconsistent (stubs pin
        // version 0 and are exempt from the pin comparison).
        if (h.FloorVersion < 0) { error = "snapshot head carries an illegal family floor."; return false; }
        if (h.FloorVersion > 0 && h.HeadVersion > 0 && h.FloorVersion > h.HeadVersion) { error = "snapshot head family floor is above its head version."; return false; }
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
          // Stub allocation trackers (version 0, empty identity) are not heads:
          // a pending-only family backed only by a stub is still headless by design.
          if (h.HeadVersion <= 0 && h.HeadSourceId == Guid.Empty) continue;
          headed.Add(h.BoardId.ToString("N") + "|" + (h.FamilyKey ?? ""));
        }
      foreach (var d in byId.Values)
      {
        // Effective review state: legacy "" + Approved=true counts as approved
        // so a headless-approved revival cannot slip through the sentinel.
        var effReview = string.IsNullOrWhiteSpace(d.ReviewState)
          ? (d.Approved ? "approved" : "pending")
          : d.ReviewState.Trim();
        if (!string.Equals(effReview, "approved", StringComparison.OrdinalIgnoreCase)) continue;
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
        if (e.Version != owner.Version)
        { error = "snapshot event pins a version other than its owning source row."; return false; }
      }
    }
    // Effective-bytes identity: the restored row carries inline Original bytes AND/OR a blobs entry.
    // The blob wins when present and non-empty (restore overwrites inline bytes with it);
    // otherwise the inline bytes are effective. Whichever bytes will land must hash to
    // the server-computed content hash, so swapped inline payloads with a removed blob
    // entry cannot reindex under a false approved identity.
    var blobBytes = new Dictionary<Guid, byte[]>(restored.blobs.Count);
    foreach (var kv in restored.blobs)
    {
      if (!Guid.TryParse(kv.Key, out var blobId))
      { error = "snapshot blob key is not a source id."; return false; }
      if (!byId.TryGetValue(blobId, out var bowner) || bowner is null)
      { error = "snapshot blob references an unknown source."; return false; }
      if (string.IsNullOrWhiteSpace(kv.Value)) continue;
      try { blobBytes[blobId] = Convert.FromBase64String(kv.Value); }
      catch (FormatException) { error = "snapshot blob is not valid base64."; return false; }
    }
    foreach (var d in byId.Values)
    {
      byte[]? eff = null;
      if (blobBytes.TryGetValue(d.Id, out var bb)) eff = bb;
      else if (d.Original is not null && d.Original.Length > 0) eff = d.Original;
      if (eff is null || eff.Length == 0) continue;
      string hex2;
      try
      {
        using var sha2 = System.Security.Cryptography.SHA256.Create();
        hex2 = Convert.ToHexString(sha2.ComputeHash(eff)).ToLowerInvariant();
      }
      catch { error = "snapshot original bytes cannot be hashed."; return false; }
      var claimed2 = (d.ContentHash ?? "").Trim().ToLowerInvariant();
      var isRealHash2 = claimed2.Length == 64 && System.Text.RegularExpressions.Regex.IsMatch(claimed2, "^[0-9a-f]{64}$");
      if (isRealHash2)
      {
        if (!string.Equals(hex2, claimed2, StringComparison.Ordinal))
        { error = "snapshot effective bytes do not match the owning source content hash."; return false; }
      }
      else if (!legacyKeys)
      { error = "snapshot source carries a placeholder content hash outside a legacy graph; re-upload instead."; return false; }
      // Non-hash placeholders inside a uniformly legacy graph are repaired
      // at restore: the real bytes are adopted and hashed (see MigrateRestoredSources).
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
    // Phase7 seam: wiki docs additionally require a present, enabled, current-healthy resource with current membership.
    if (!WikiEligibility.IsUsable(s, d)) return false;
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
    try { Atomic.Audit(s, new AuditEvent { BoardId = boardId, Action = action, Detail = detail ?? "" }); } catch { }
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
        if (PeopleOps.Check(s, req, seen.BoardId, seen.MeetingId, "contribute") is { } deniedSx)
          return deniedSx is Microsoft.AspNetCore.Http.HttpResults.JsonHttpResult<object> deniedJson
            ? (false, "Access denied for this scope.", deniedJson.StatusCode ?? 403)
            : (false, "Access denied for this scope.", 403);
        if (!s.Boards.TryGetValue(seen.BoardId, out var b))
          return (false, "Board not found.", 404);
        if (!PolicyAllows(b, seen))
          return (false, "Board policy forbids this source; approval blocked.", 409);
        var rs = (seen.ReviewState ?? "").Trim().ToLowerInvariant();
        var head = s.SourceHeads.Values.FirstOrDefault(h => h.BoardId == seen.BoardId && h.FamilyKey == seen.FamilyKey);
        // Ordering is by ORIGINAL version (server-owned alias), not canonical number:
        // a renumbered old duplicate (orig v1, now v3) must never supersede the actual
        // newer version (orig v2). Without migrate history the alias equals the version.
        var seenOrig = OriginalVersionOf(s, seen);
        var headOrig = head is null ? 0 : head.HeadVersion;
        if (head is not null && head.HeadSourceId != Guid.Empty && s.Sources.TryGetValue(head.HeadSourceId, out var headDoc) && headDoc is not null && headDoc.BoardId == seen.BoardId && headDoc.FamilyKey == seen.FamilyKey)
          headOrig = OriginalVersionOf(s, headDoc);
        if (head is not null && head.HeadVersion > 0)
        {
          if (seenOrig < headOrig)
            return (false, "Superseded by newer approved version v" + head.HeadVersion + "; approval rejected.", 409);
          if (seen.Version == head.HeadVersion && head.HeadSourceId != Guid.Empty && seen.Id != head.HeadSourceId)
            return (false, "Family/version collision: another approved document already heads v" + head.HeadVersion + ".", 409);
          // Same original position but a different row (competing renumbered duplicate):
          // never promote above the current head; rebase onto the authoritative head.
          if (seenOrig == headOrig && head.HeadSourceId != Guid.Empty && seen.Id != head.HeadSourceId)
            return (false, "Superseded by the current family head; approval rejected.", 409);
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
          Atomic.Run(s, () =>
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
              var promMin = s.Sources.Values.Where(x => x.BoardId == d.BoardId && x.FamilyKey == d.FamilyKey).Select(x => (int?)x.Version).Min() ?? d.Version;
              // Promotion-time floor: first-known version across live family rows.
              h = new SourceFamilyHead { BoardId = d.BoardId, FamilyKey = d.FamilyKey, HeadVersion = d.Version, HeadSourceId = d.Id, HighWater = d.Version, FloorVersion = promMin >= 1 ? promMin : d.Version, UpdatedAt = DateTime.UtcNow };
              s.SourceHeads[h.Id] = h;
            }
            // Promotion-time floor backfill for pre-provenance heads/stubs: keep
            // an established floor, otherwise record the truthful first-known version.
            if (h.FloorVersion <= 0)
            {
              var promMin2 = s.Sources.Values.Where(x => x.BoardId == d.BoardId && x.FamilyKey == d.FamilyKey).Select(x => (int?)x.Version).Min() ?? d.Version;
              if (promMin2 >= 1) { h.FloorVersion = promMin2; h.UpdatedAt = DateTime.UtcNow; }
            }
            // Promotion follows ORIGINAL-version ordering (server-owned alias), consistent with the pre-commit eligibility gate above: an actual newer original (e.g. orig v2, canonical v2) promotes above a parked old duplicate (orig v1, canonical v3). Canonical numbers alone never decide the head.
            var dOrigProm = OriginalVersionOf(s, d);
            int hOrigProm = h.HeadVersion;
            if (h.HeadSourceId != Guid.Empty && s.Sources.TryGetValue(h.HeadSourceId, out var hDocProm) && hDocProm is not null && hDocProm.BoardId == d.BoardId && hDocProm.FamilyKey == d.FamilyKey)
              hOrigProm = OriginalVersionOf(s, hDocProm);
            if (dOrigProm > hOrigProm)
            {
              h.HeadVersion = d.Version; h.HeadSourceId = d.Id; if (d.Version > h.HighWater) h.HighWater = d.Version; h.UpdatedAt = DateTime.UtcNow;
            }
            else if (dOrigProm == hOrigProm)
            {
              if (h.HeadSourceId != Guid.Empty && h.HeadSourceId != d.Id)
                throw new InvalidOperationException("family/version collision at promotion");
              if (h.HeadSourceId == Guid.Empty)
              { h.HeadSourceId = d.Id; h.UpdatedAt = DateTime.UtcNow; }
            }
            else
              throw new InvalidOperationException("superseded by newer original version before commit");
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
        if (PeopleOps.Check(s, req, seen.BoardId, seen.MeetingId, "contribute") is { } deniedSx)
          return deniedSx is Microsoft.AspNetCore.Http.HttpResults.JsonHttpResult<object> deniedJson
            ? (false, "Access denied for this scope.", deniedJson.StatusCode ?? 403)
            : (false, "Access denied for this scope.", 403);
        var rs = (seen.ReviewState ?? "").Trim().ToLowerInvariant();
        if (rs == "rejected") return (true, null, 200);
        if (rs == "approved")
          return (false, "Approved versions cannot be rejected; exclude to revoke current evidence.", 409);
        var reason = "source.reject " + seen.FileName + " v" + seen.Version;
        string? failure = null;
        try
        {
          Atomic.Run(s, () =>
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
        if (PeopleOps.Check(s, req, seen.BoardId, seen.MeetingId, "contribute") is { } deniedSx)
          return deniedSx is Microsoft.AspNetCore.Http.HttpResults.JsonHttpResult<object> deniedJson
            ? (false, "Access denied for this scope.", deniedJson.StatusCode ?? 403)
            : (false, "Access denied for this scope.", 403);
        var reason = (excluded ? "source.exclude " : "source.restore ") + seen.FileName + " v" + seen.Version;
        string? failure = null;
        try
        {
          Atomic.Run(s, () =>
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
        Atomic.Run(s, () =>
        {
          mutation();
          InvalidateLocked(s, boardId);
        });
      }
    }
    RecordAudit(s, boardId, "source.invalidate", reason ?? "");
  }
  // Conditional variant: the callback reports whether it changed evidence.
  // Meetings are paused / generation-bumped and the invalidation audit is
  // written ONLY when the callback actually changed something. Stale or
  // no-op completions (superseded sync attempts, unchanged refreshes,
  // identical reconfigurations) must never pause meetings, bump generation,
  // or write success/failure audits. Non-wiki callers keep MutateEvidence.
  public static bool MutateEvidenceIfChanged(InMemoryStore s, Guid boardId, string reason, Func<bool> mutation)
  {
    bool changed;
    lock (s.SetupLock)
    {
      lock (s.MessageLock)
      {
        changed = Atomic.Run(s, mutation);
        if (changed) InvalidateLocked(s, boardId);
      }
    }
    if (changed) try { Atomic.Audit(s, new AuditEvent { BoardId = boardId, Action = "source.invalidate", Detail = reason ?? "" }); } catch { }
    return changed;
  }

  // Meeting invalidation for callers that already hold SetupLock (they run
  // their own Atomic unit): takes MessageLock, pauses/bumps affected
  // meetings, and audits. Same lock order as MutateEvidence.
  public static void InvalidateBoardUnderSetupLock(InMemoryStore s, Guid boardId, string reason)
  {
    lock (s.MessageLock)
    {
      InvalidateLocked(s, boardId);
    }
    try { Atomic.Audit(s, new AuditEvent { BoardId = boardId, Action = "source.invalidate", Detail = reason ?? "" }); } catch { }
  }

  // Bounded detached index staging for Wiki sync: builds exactly the sections
  // IndexSource would persist for this document, WITHOUT touching the store.
  // Returns false with a safe fixed error when the page is unindexable
  // (failed/unreachable extraction, empty/whitespace text, or no nonempty
  // sections), so the whole sync attempt can fail closed BEFORE publishing
  // any new source row. Mirrors IndexSource's pure text/section logic.
  public static bool TryStageIndexSections(SourceDoc template, out List<SourceSection> sections, out string error)
  {
    sections = new();
    error = "";
    var gen = template.IndexGeneration <= 0 ? 1 : template.IndexGeneration;
    var md = Extraction.MarkdownOf(template.ExtractionJson);
    var extStatus = "";
    try
    {
      using var ej = JsonDocument.Parse(string.IsNullOrWhiteSpace(template.ExtractionJson) ? "{}" : template.ExtractionJson);
      if (ej.RootElement.TryGetProperty("status", out var st) && st.ValueKind == JsonValueKind.String)
        extStatus = (st.GetString() ?? "").Trim().ToLowerInvariant();
    }
    catch (JsonException) { }
    if (string.IsNullOrWhiteSpace(md) && (extStatus == "failed" || extStatus == "unreachable"))
    { error = "extraction failed or unreachable; raw bytes are not indexed without extractor output"; return false; }
    var text = ReadableTextFor(template);
    if (string.IsNullOrWhiteSpace(text))
    { error = string.IsNullOrWhiteSpace(Extraction.MarkdownOf(template.ExtractionJson)) ? "no extractable text; extraction failed or binary without extractor output" : "empty text"; return false; }
    var built = BuildSections(text);
    if (built.Count == 0 || built.Any(b => string.IsNullOrWhiteSpace(b.Text)))
    { error = "no indexable sections built"; return false; }
    var now = DateTime.UtcNow;
    int ord = 1;
    foreach (var b in built)
    {
      sections.Add(new SourceSection
      {
        BoardId = template.BoardId, SourceId = template.Id, FamilyKey = template.FamilyKey ?? "",
        SourceVersion = template.Version, ContentHash = template.ContentHash ?? "",
        Ordinal = ord++, Heading = b.Heading ?? "", Location = b.Location ?? "", Text = b.Text ?? "",
        IndexGeneration = gen, CreatedAt = now,
      });
    }
    return true;
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
        Atomic.Run(s, () => InvalidateLocked(s, boardId));
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
    var high = head is null ? 0 : Math.Max(head.HeadVersion, head.HighWater);
    var next = Math.Max(live, high) + 1;
    // Durable allocation history IN the reservation unit: even a family with no
    // approved head (stub head: version 0, empty identity) carries its high-water
    // forward, so deleting a trailing pending version can never recycle its number.
    // Stub heads never satisfy headship (version 0 / empty identity fail closed
    // everywhere a current head is required) and are replaced by real promotions.
    if (head is null)
    {
      // Stub floor: truthful first-known version across live family rows (a legacy
      // transient may already hold rows below the reservation); a row-less family
      // records the reservation itself as its first-known version.
      var rmin = s.Sources.Values.Where(x => x.BoardId == boardId && x.FamilyKey == familyKey).Select(x => (int?)x.Version).Min() ?? next;
      head = new SourceFamilyHead { BoardId = boardId, FamilyKey = familyKey, HeadVersion = 0, HeadSourceId = Guid.Empty, HighWater = next, FloorVersion = rmin >= 1 ? rmin : next, UpdatedAt = DateTime.UtcNow };
      s.SourceHeads[head.Id] = head;
    }
    else if (next > head.HighWater) head.HighWater = next;
    // Durability faults propagate to the caller's Atomic unit (which rolls back
    // the whole reservation+insertion on failure). Swallowing Flush here would
    // silently lose allocation history and recycle versions after a restart.
    s.SourceHeads.Flush();
    return next;
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

  public static bool TryBeginIndex(InMemoryStore s, HttpRequest req, Guid id, string need, out IndexReservation? reservation, out string error)
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
        string? gateErr = null;
        Atomic.Run(s, () =>
        {
          if (!s.Sources.TryGetValue(id, out var cur) || cur is null)
            throw new InvalidOperationException("source vanished during index reservation");
          // Fresh caller + board/scope/policy validation inside the backend
          // unit: a revocation or policy change between the entry check and
          // this reservation must fail closed with zero mutation.
          if (PeopleOps.Check(s, req, cur.BoardId, cur.Scope == "meeting" ? cur.MeetingId : null, need) is { } deniedBi)
          {
            gateErr = deniedBi is Microsoft.AspNetCore.Http.HttpResults.JsonHttpResult<object> deniedJson && deniedJson.StatusCode == 401
              ? "Authentication required."
              : "Access revoked or not granted for this scope.";
            return;
          }
          if (!string.Equals(PolicyRevisionKey(s, cur.BoardId), policyKey, StringComparison.Ordinal))
          {
            gateErr = "Source policy changed before index reservation; retry with current policy.";
            return;
          }
          // Effective allowance for THIS operation: a board that now forbids
          // this kind (wiki-only mode, blocked extension) must not reserve or
          // process it, even if the policy revision key is unchanged.
          if (!s.Boards.TryGetValue(cur.BoardId, out var polBoard) || polBoard is null || !PolicyAllows(polBoard, cur))
          {
            gateErr = "Source type is blocked on this board; uploads and retries are disabled by policy.";
            return;
          }
          var jobId = Guid.NewGuid();
          cur.IndexState = "running";
          cur.IndexGeneration = cur.IndexGeneration <= 0 ? 1 : cur.IndexGeneration + 1;
          cur.IndexError = "";
          s.Sources.Flush();
          var hadPriorIndex = s.ActiveIndexJobs.TryGetValue(id, out var priorIndex);
          s.ActiveIndexJobs[id] = new ActiveIndexJob(jobId, s.SourceEpoch, cur.IndexGeneration);
          var capPrior = priorIndex; var capHad = hadPriorIndex;
          Atomic.Compensate(s, () => { if (capHad && capPrior is not null) s.ActiveIndexJobs[id] = capPrior; else s.ActiveIndexJobs.TryRemove(id, out _); });
          if (wasEligible) InvalidateLocked(s, cur.BoardId);
          made = new IndexReservation(jobId, s.SourceEpoch, cur.Id, cur.Version, cur.ContentHash ?? "",
            cur.FamilyKey ?? "", cur.BoardId, cur.Scope ?? "board", cur.MeetingId, policyKey,
            cur.IndexGeneration, wasEligible);
        });
        if (gateErr is not null) { error = gateErr; return false; }
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
    InMemoryStore s, HttpRequest req, IndexReservation res, bool isReindex, string need)
  {
    lock (s.SetupLock)
    {
      lock (s.MessageLock)
      {
        // Every fetch, authorization, policy, and revision check runs INSIDE
        // the actual backend transaction against freshly fetched rows: the
        // pre-gate captured source object never sources the mutation, so an
        // intervening tracker-clear cannot detach the write target.
        // Partial-write faults escape the unit below (no failure swallowing):
        // the store-bound unit rolls back ALL staged effects and the exception
        // propagates to the caller for an honest post-commit/uncertain-rollback
        // classification. Controlled stale/failed-extraction paths return normally.
        bool stale = false;
        string? staleErr = null;
        var eventName = isReindex ? "reindex" : "index";
        Atomic.Run(s, () =>
        {
          if (!s.Sources.TryGetValue(res.SourceId, out var cur) || cur is null)
          { stale = true; staleErr = "Source is gone; stale index completion discarded."; return; }
          EnsureMigrated(s, cur);
          if (PeopleOps.Check(s, req, cur.BoardId, cur.Scope == "meeting" ? cur.MeetingId : null, need) is { } deniedFi)
          { stale = true; staleErr = "Access revoked or not granted for this scope."; return; }
          if (res.Epoch != s.SourceEpoch)
          { stale = true; staleErr = "Index epoch changed during indexing (restore replaced state); reindex required."; return; }
          if (!s.ActiveIndexJobs.TryGetValue(res.SourceId, out var active)
            || active.JobId != res.JobId || active.Epoch != res.Epoch || active.Generation != res.Generation)
          { stale = true; staleErr = "A newer index attempt superseded this one; stale completion discarded."; return; }
          if (cur.Version != res.Version
            || !string.Equals(cur.ContentHash ?? "", res.ContentHash ?? "", StringComparison.Ordinal)
            || !string.Equals(cur.FamilyKey ?? "", res.FamilyKey ?? "", StringComparison.Ordinal)
            || cur.BoardId != res.BoardId
            || !string.Equals(cur.Scope ?? "", res.Scope ?? "", StringComparison.OrdinalIgnoreCase)
            || cur.MeetingId != res.MeetingId
            || !string.Equals(PolicyRevisionKey(s, cur.BoardId), res.PolicyKey, StringComparison.Ordinal))
          { stale = true; staleErr = "Source identity or policy changed during indexing; stale completion discarded."; return; }
          if (!string.Equals(cur.IndexState ?? "", "running", StringComparison.OrdinalIgnoreCase)
            || cur.IndexGeneration != res.Generation)
          { stale = true; staleErr = "A newer index attempt superseded this one; stale completion discarded."; return; }
          // Fail closed on explicit extraction failure (partial-write faults escape, no inner catch): raw Original bytes must
            // not stand in for extractor output. Textual uploads extract locally;
            // anything else requires a successful extractor result first.
            var md = Extraction.MarkdownOf(cur.ExtractionJson);
            string extStatus = "";
            try
            {
              using var ej = JsonDocument.Parse(string.IsNullOrWhiteSpace(cur.ExtractionJson) ? "{}" : cur.ExtractionJson);
              if (ej.RootElement.TryGetProperty("status", out var st) && st.ValueKind == JsonValueKind.String)
                extStatus = (st.GetString() ?? "").Trim().ToLowerInvariant();
            }
            catch (JsonException) { }
            if (string.IsNullOrWhiteSpace(md) && (extStatus == "failed" || extStatus == "unreachable"))
            {
              cur.IndexState = "failed";
              cur.IndexError = "extraction " + extStatus + "; raw bytes are not indexed without extractor output";
              cur.IndexCompletedAt = DateTime.UtcNow;
              s.Sources.Flush();
              RecordEvent(s, cur, eventName + "-failed", cur.IndexError);
              return;
            }
            var text = ReadableTextFor(cur);
            if (string.IsNullOrWhiteSpace(text))
            {
              cur.IndexState = "failed";
              cur.IndexError = string.IsNullOrWhiteSpace(Extraction.MarkdownOf(cur.ExtractionJson)) ? "no extractable text; extraction failed or binary without extractor output" : "empty text";
              cur.IndexCompletedAt = DateTime.UtcNow;
              s.Sources.Flush();
              RecordEvent(s, cur, eventName + "-failed", cur.IndexError);
              return;
            }
            var built = BuildSections(text);
            if (built.Count == 0)
            {
              cur.IndexState = "failed"; cur.IndexError = "no sections built"; cur.IndexCompletedAt = DateTime.UtcNow;
              s.Sources.Flush();
              RecordEvent(s, cur, eventName + "-failed", cur.IndexError);
              return;
            }
            foreach (var old in s.SourceSections.Values.Where(x => x.SourceId == cur.Id).ToList())
              s.SourceSections.TryRemove(old.Id, out _);
            int ord = 1;
            foreach (var b in built)
            {
              var sec = new SourceSection
              {
                BoardId = cur.BoardId, SourceId = cur.Id, FamilyKey = cur.FamilyKey,
                SourceVersion = cur.Version, ContentHash = cur.ContentHash,
                Ordinal = ord++, Heading = b.Heading, Location = b.Location,
                Text = b.Text, IndexGeneration = res.Generation, CreatedAt = DateTime.UtcNow,
              };
              s.SourceSections[sec.Id] = sec;
            }
            cur.IndexState = "completed"; cur.IndexError = ""; cur.IndexCompletedAt = DateTime.UtcNow;
            s.Sources.Flush(); s.SourceSections.Flush();
            RecordEvent(s, cur, eventName, "gen" + res.Generation + " sections" + built.Count);
            // QA-only inner-callback fault (code-only, never HTTP/env/header): fires AFTER staged writes inside
            // the ACTUAL unit callback, so the fault escapes and rolls back ALL staged effects. A predecessor
            // inner-catch that swallowed this would commit partials and fail the rollback assertions.
            if (FinishIndexCallbackFault?.Invoke() == true) throw new InvalidOperationException("injected finish-index callback fault (SourceGovernance.FinishIndexCallbackFault)");
          // No catch inside the unit: a partial-write failure must escape Atomic.Run so ALL staged source/section/head/event effects roll back instead of committing partials.
        });
        if (stale)
          return (false, true, false, staleErr, 409);
        // Retire the completed reservation only if it is still current.
        if (s.ActiveIndexJobs.TryGetValue(res.SourceId, out var curJob)
          && curJob.JobId == res.JobId && curJob.Epoch == res.Epoch)
          s.ActiveIndexJobs.TryRemove(res.SourceId, out _);
        if (!s.Sources.TryGetValue(res.SourceId, out var done) || done is null)
          return (false, true, false, "Source is gone; stale index completion discarded.", 409);
        Guid? fmeeting = done.Scope == "meeting" ? done.MeetingId : null;
        var nowEligible = IsEligible(s, done, fmeeting);
        var lost = res.WasEligible && !nowEligible;
        // The Begin reservation already paused affected meetings when the
        // source was eligible; only report here, never restore old state.
        RecordAudit(s, done.BoardId, "source.index", eventName + " " + done.FileName + " v" + done.Version + " gen" + res.Generation);
        return (true, false, lost, null, 200);
      }
    }
  }
  // Stamp extractor output only when this reservation is still the current
  // running attempt for the current epoch; a superseded attempt must not
  // overwrite newer output.
  public static void StampExtraction(InMemoryStore s, HttpRequest req, IndexReservation res, string extractionJson, string need)
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
          try
          {
            Atomic.Run(s, () =>
            {
              if (!s.Sources.TryGetValue(res.SourceId, out var stamped) || stamped is null) return;
              if (!string.Equals(stamped.IndexState ?? "", "running", StringComparison.OrdinalIgnoreCase)
                || stamped.IndexGeneration != res.Generation) return;
              // Caller + authority revalidated inside the unit: a revocation or
              // logout between reservation and stamping must not mutate the row.
              if (PeopleOps.Check(s, req, stamped.BoardId, stamped.Scope == "meeting" ? stamped.MeetingId : null, need) is not null) return;
              // Policy-drift gate BEFORE any derived write: a board policy change
              // (mode/blocked-type revision or allowance) between reservation and
              // stamping must not mutate the row. Reservation key + live allowance
              // are both rechecked against the freshly fetched board/row.
              if (!string.Equals(PolicyRevisionKey(s, stamped.BoardId), res.PolicyKey, StringComparison.Ordinal)) return;
              if (!s.Boards.TryGetValue(stamped.BoardId, out var stampBoard) || stampBoard is null) return;
              if (!PolicyAllows(stampBoard, stamped)) return;
              stamped.ExtractionJson = extractionJson;
              s.Sources.Flush();
            });
          }
          catch { }
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
  public static List<EvidenceRef> ResolveEvidence(InMemoryStore s, HttpRequest req, IEnumerable<EvidenceRef> refs, Guid boardId, Guid? meetingId)
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
      // Current referenced-resource authorization BEFORE any title/text.
      if (!PeopleOps.Can(s, req, doc.BoardId, doc.MeetingId, "read")) continue;
      // Version pins match the current version OR the server-owned legacy
      // alias (migrate-version history): renumbered duplicates still resolve
      // their original citations; anything else is a stale pin.
      if (r.Version.HasValue && r.Version.Value != doc.Version && r.Version.Value != OriginalVersionOf(s, doc)) continue; // stale version pin
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
