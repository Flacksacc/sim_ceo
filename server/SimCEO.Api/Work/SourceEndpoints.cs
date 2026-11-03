using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;
using SimCEO.Api.Work;

namespace SimCEO.Api;

// Phase 6 source governance: per-version pending/approved/rejected review
// with separate temporary exclusion, durable promoted head (no fallback),
// wiki-only / allow-all-with-exclusions policy on ALL writers/consumers,
// persisted index state + deterministic sections. Reuse bounded local
// indexing + existing storage atomics; no new services/vector frameworks.
//
// Concurrency contract: version allocation + insert serialize under
// SetupLock -> MessageLock (ReserveVersion covers live rows + retained
// head high-water); extraction awaits run outside the locks under an index
// reservation; the commit re-validates identity/generation and never
// rewrites review state. The full PATCH validates before any write and
// commits in one atomic unit.
public static class SourceEndpoints
{
  private const long MaxUploadBytes = 10 * 1024 * 1024;

  private static object ShapeDoc(InMemoryStore s, SourceDoc d)
  {
    SourceGovernance.EnsureMigrated(s, d);
    var head = s.SourceHeads.Values.FirstOrDefault(h => h.BoardId == d.BoardId && h.FamilyKey == d.FamilyKey);
    // Identity-pinned head flag: version alone never suffices.
    var isHead = head is not null && head.HeadVersion == d.Version
      && head.HeadSourceId != Guid.Empty && head.HeadSourceId == d.Id;
    SourceDoc? cur = null;
    try { cur = SourceGovernance.CurrentForFamily(s, d.BoardId, d.FamilyKey); } catch { }
    var secs = s.SourceSections.Values.Count(x => x.SourceId == d.Id);
    return new
    {
      d.Id, d.BoardId, d.FileName, d.ContentHash, d.Version,
      d.Approved, d.Excluded, reviewState = d.ReviewState, origin = d.Origin,
      resourceId = d.ResourceId, familyKey = d.FamilyKey,
      indexState = d.IndexState, indexGeneration = d.IndexGeneration,
      indexError = d.IndexError, indexCompletedAt = d.IndexCompletedAt,
      sectionCount = secs, isHead, currentId = cur?.Id,
      isCurrent = cur is not null && cur.Id == d.Id,
      d.Scope, meetingId = d.MeetingId, d.ExtractionJson, d.CreatedAt,
    };
  }

  private static bool IsSourceManager(InMemoryStore s, HttpRequest req, Guid boardId, Guid? meetingId)
  {
    // Auth8 boundary: meeting-scoped discuss grants satisfy reads of their own
    // meeting only and never board-level reads or mutation. Guests see
    // decided (approved, non-excluded) sources in their scope, without
    // indexed text or original bytes.
    return PeopleOps.Can(s, req, boardId, null, "manage")
      || (meetingId.HasValue && PeopleOps.Can(s, req, boardId, meetingId, "contribute"));
  }

  private static bool IsBoardReader(InMemoryStore s, HttpRequest req, Guid boardId)
  {
    // Board-wide read (reader/contribute/manage). Meeting-scoped discuss grants
    // do NOT satisfy this: Can with a null meeting excludes discuss by design.
    return PeopleOps.Can(s, req, boardId, null, "read");
  }

  private static object GuestShape(InMemoryStore s, SourceDoc d)
  {
    // Guests receive metadata only: no ExtractionJson (indexed text) and no
    // content hash or original bytes. Approved, non-excluded rows in the
    // caller\'s own scope only.
    SourceGovernance.EnsureMigrated(s, d);
    var head = s.SourceHeads.Values.FirstOrDefault(h => h.BoardId == d.BoardId && h.FamilyKey == d.FamilyKey);
    var isHead = head is not null && head.HeadVersion == d.Version
      && head.HeadSourceId != Guid.Empty && head.HeadSourceId == d.Id;
    SourceDoc? cur = null;
    try { cur = SourceGovernance.CurrentForFamily(s, d.BoardId, d.FamilyKey); } catch { }
    var secs = s.SourceSections.Values.Count(x => x.SourceId == d.Id);
    return new
    {
      d.Id, d.BoardId, d.FileName, d.Version,
      d.Approved, d.Excluded, reviewState = d.ReviewState, origin = d.Origin,
      familyKey = d.FamilyKey,
      indexState = d.IndexState, indexGeneration = d.IndexGeneration,
      indexError = d.IndexError,
      sectionCount = secs, isHead, isCurrent = cur is not null && cur.Id == d.Id, currentId = cur?.Id,
      d.Scope, meetingId = d.MeetingId, d.CreatedAt,
    };
  }

  private static bool IsApprovedVisible(SourceDoc d) =>
    string.Equals(d.ReviewState ?? "", "approved", StringComparison.OrdinalIgnoreCase) && !d.Excluded;

  private static bool InGuestScope(InMemoryStore s, HttpRequest req, SourceDoc d)
  {
    // Guests see decided sources in their own scope: board scope, or their meeting.
    if (d.Scope != "meeting") return true;
    if (!d.MeetingId.HasValue) return true;
    var allowed = PeopleOps.GuestMeetingIds(s, PeopleOps.UserOf(s, req), d.BoardId);
    return allowed.Contains(d.MeetingId.Value);
  }

  public static void MapSourcesX(this WebApplication app)
  {
    app.MapPost("/api/boards/{bid:guid}/sources/upload", async (
      InMemoryStore s, HttpRequest req, Guid bid, IFormFile file, string? scope, Guid? meetingId) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badUp) return badUp;
      if (!s.Boards.TryGetValue(bid, out var pboard)) return Results.NotFound("board");
      try { if (req.HasFormContentType && (scope is null || meetingId is null)) { var fscope = req.Form["scope"].ToString(); if (!string.IsNullOrWhiteSpace(fscope)) scope = fscope; var fmid = req.Form["meetingId"].ToString(); if (!string.IsNullOrWhiteSpace(fmid) && Guid.TryParse(fmid, out var fg)) meetingId = fg; } } catch { }
      if (file is null || file.Length == 0) return Results.BadRequest("No file.");
      if (file.Length > MaxUploadBytes) return Results.BadRequest("File exceeds 10 MB.");
      // A requested meeting scope without a chosen meeting is rejected: it must
      // never silently widen to board scope (P2 #6).
      if (string.Equals(scope, "meeting", StringComparison.OrdinalIgnoreCase) && !meetingId.HasValue)
        return Results.BadRequest("meetingId is required for meeting scope; pick a meeting instead of defaulting to board.");
      var effScope = string.Equals(scope, "meeting", StringComparison.OrdinalIgnoreCase) ? "meeting" : "board";
      Guid? effMeeting = effScope == "meeting" ? meetingId : null;
      if (effScope == "meeting")
      {
        if (!effMeeting.HasValue) return Results.BadRequest("meetingId is required for meeting scope.");
        if (!s.Meetings.TryGetValue(effMeeting.Value, out var mtg) || mtg.BoardId != bid)
          return Results.Json(new { error = "Meeting does not belong to this board." }, statusCode: 409);
      }
      // Capability checked against the EFFECTIVE scope: a meeting grant never
      // confers board-scope uploads.
      if (PeopleOps.Check(s, req, bid, effMeeting, "contribute") is { } deniedSrc1) return deniedSrc1;
      // Policy enforced at creation: wiki-only denies ordinary uploads; blocked extensions 415.
      var probe = new SourceDoc { BoardId = bid, FileName = file.FileName, Origin = "upload" };
      if (SourceGovernance.PolicyModeOf(pboard) == "wikiOnly")
        return Results.Json(new { error = "Board policy is wiki-only; uploads are disabled. Add a Wiki connector resource instead." }, statusCode: 415);
      var ext = SourceGovernance.GetExtension(file.FileName);
      if (!string.IsNullOrEmpty(pboard.BlockedTypes)
          && pboard.BlockedTypes.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Any(b => string.Equals(b.Trim().TrimStart('.'), ext, StringComparison.OrdinalIgnoreCase)))
        return Results.Json(new { error = $"Source type '.{ext}' is blocked on this board." }, statusCode: 415);
      using var ms = new MemoryStream();
      await file.CopyToAsync(ms);
      var bytes = ms.ToArray();
      var hash = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
      var familyKey = SourceGovernance.FamilyKeyFor(bid, effScope, effMeeting, "upload", file.FileName);
      // Allocation AND insertion happen in one serialized transaction so two
      // concurrent uploads (or upload vs inline) can never reserve and store
      // the same family/version twice.
      SourceDoc? doc = null;
      string? dupMsg = null;
      string? createDenied = null;
      int createDeniedStatus = 403;
      lock (s.SetupLock)
      {
        lock (s.MessageLock)
        {
          Atomic.Run(() =>
          {
            // Fresh board/scope/caller/policy validation inside the backend
            // unit: a revocation, meeting move, or wiki-only switch between
            // the entry check and insertion must fail closed with zero write.
            if (!s.Boards.TryGetValue(bid, out var curBoard) || curBoard is null)
            { createDenied = "Board not found."; createDeniedStatus = 404; return; }
            if (PeopleOps.Check(s, req, bid, effMeeting, "contribute") is { } deniedCr)
            { createDenied = "Access revoked or not granted for this scope."; return; }
            if (SourceGovernance.PolicyModeOf(curBoard) == "wikiOnly")
            { createDenied = "Board policy is wiki-only; uploads are disabled. Add a Wiki connector resource instead."; createDeniedStatus = 415; return; }
            var blockedNow = (curBoard.BlockedTypes ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
              .Any(b => string.Equals(b.Trim().TrimStart('.'), SourceGovernance.GetExtension(file.FileName), StringComparison.OrdinalIgnoreCase));
            if (blockedNow)
            { createDenied = "Source type is blocked on this board."; createDeniedStatus = 415; return; }
            if (effScope == "meeting" && (!effMeeting.HasValue
              || !s.Meetings.TryGetValue(effMeeting.Value, out var curMtg) || curMtg.BoardId != bid))
            { createDenied = "Meeting does not belong to this board."; createDeniedStatus = 409; return; }
            // Dedup is family-scoped (same bytes in the same board/scope/meeting/
            // origin/file family): identical bytes under a different family are a
            // separate pending version, never an unrelated board-wide conflict.
            var dup = s.Sources.Values.FirstOrDefault(x => x.BoardId == bid && x.FamilyKey == familyKey && x.ContentHash == hash);
            if (dup is not null) { dupMsg = $"Identical content already stored as {dup.Id} (v{dup.Version})."; return; }
            var version = SourceGovernance.ReserveVersion(s, bid, familyKey);
            var fresh = new SourceDoc
            {
              BoardId = bid, FileName = file.FileName, ContentHash = hash,
              Version = version, Approved = false, Excluded = false,
              ReviewState = "pending", Origin = "upload",
              FamilyKey = familyKey,
              Scope = effScope, MeetingId = effMeeting,
              IndexState = "queued", IndexGeneration = 0,
              ExtractionJson = "{}",
            };
            fresh.Original = bytes;
            s.Sources[fresh.Id] = fresh;
            s.Sources.Flush();
            SourceGovernance.RecordEvent(s, fresh, "upload", "scope=" + effScope);
            doc = fresh;
          });
        }
      }
      if (createDenied is not null) return Results.Json(new { error = createDenied }, statusCode: createDeniedStatus);
      if (doc is null) return Results.Conflict(dupMsg ?? "Identical content already stored.");
      // Reserve the index slot, then run actual extraction outside the
      // transaction under that reservation: textual formats decode locally,
      // binary formats go to the extractor. A failed extraction can never
      // become completed raw-byte evidence (fail closed at commit).
      if (!SourceGovernance.TryBeginIndex(s, req, doc.Id, "contribute", out var res, out var beginErr) || res is null)
        return Results.Json(new { error = beginErr }, statusCode: 500);
      var extr = await Extraction.ExtractAsync(bytes, file.FileName);
      SourceGovernance.StampExtraction(s, req, res, Extraction.ToJson(extr), "contribute");
      var (ok, stale, lost, finErr, status) = SourceGovernance.FinishIndex(s, req, res, false, "contribute");
      if (!ok)
        return Results.Json(new { error = finErr, stale }, statusCode: status);
      _ = lost;
      if (!s.Sources.TryGetValue(doc.Id, out var stored) || stored is null) return Results.NotFound();
      return Results.Created($"/api/sources/{stored.Id}", ShapeDoc(s, stored));
    }).DisableAntiforgery();
    app.MapGet("/api/boards/{bid:guid}/sources", (InMemoryStore s, HttpRequest req, Guid bid, string? review, string? family) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badSrcList) return badSrcList;
      if (PeopleOps.IsSecure(s) && !AuthOps.TrySession(s, req, out _)) return Results.Json(new { error = "Authentication required." }, statusCode: 401);
      SourceGovernance.EnsureMigratedAll(s);
      var q = s.Sources.Values.Where(x => x.BoardId == bid);
      if (!string.IsNullOrWhiteSpace(review))
      {
        var r = review.Trim().ToLowerInvariant();
        q = q.Where(x => (x.ReviewState ?? "pending").ToLower() == r);
      }
      if (!string.IsNullOrWhiteSpace(family)) q = q.Where(x => x.FamilyKey == family);
      if (IsBoardReader(s, req, bid))
        return Results.Ok(q.OrderByDescending(x => x.Version).ToList().Select(d => ShapeDoc(s, d)));
      var lu = PeopleOps.UserOf(s, req);
      var lallowed = PeopleOps.GuestMeetingIds(s, lu, bid);
      if (lallowed.Count == 0) return PeopleOps.Denied();
      var gq = q.Where(x => IsApprovedVisible(x) && (x.Scope != "meeting" || (x.MeetingId.HasValue && lallowed.Contains(x.MeetingId.Value))));
      return Results.Ok(gq.OrderByDescending(x => x.Version).ToList().Select(d => GuestShape(s, d)));
    });

    app.MapGet("/api/boards/{bid:guid}/sources/review", (InMemoryStore s, HttpRequest req, Guid bid) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badSrcRev) return badSrcRev;
      if (PeopleOps.IsSecure(s) && !AuthOps.TrySession(s, req, out _)) return Results.Json(new { error = "Authentication required." }, statusCode: 401);
      SourceGovernance.EnsureMigratedAll(s);
      var docs = s.Sources.Values.Where(x => x.BoardId == bid).ToList();
      foreach (var d in docs) SourceGovernance.EnsureMigrated(s, d);
      var reader = IsBoardReader(s, req, bid);
      List<Guid> gallowed = new();
      if (!reader)
      {
        gallowed = PeopleOps.GuestMeetingIds(s, PeopleOps.UserOf(s, req), bid);
        if (gallowed.Count == 0) return PeopleOps.Denied();
        docs = docs.Where(x => IsApprovedVisible(x) && (x.Scope != "meeting" || (x.MeetingId.HasValue && gallowed.Contains(x.MeetingId.Value)))).ToList();
      }
      var groups = docs.GroupBy(x => x.FamilyKey).Select(g =>
      {
        var ordered = g.OrderByDescending(x => x.Version).ToList();
        SourceDoc? cur = null;
        try { cur = SourceGovernance.CurrentForFamily(s, bid, g.Key); } catch { }
        return new
        {
          familyKey = g.Key,
          fileName = ordered.First().FileName,
          scope = ordered.First().Scope,
          meetingId = ordered.First().MeetingId,
          origin = ordered.First().Origin,
          currentId = cur?.Id,
          hasCurrent = cur is not null,
          versions = ordered.Select(d => reader ? ShapeDoc(s, d) : GuestShape(s, d)),
        };
      }).OrderBy(g => g.fileName).ToList();
      return Results.Ok(groups);
    });

    app.MapGet("/api/sources/{id:guid}/versions", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (!s.Sources.TryGetValue(id, out var doc)) return Results.NotFound();
      if (PeopleOps.Check(s, req, doc.BoardId, doc.MeetingId, "read") is { } deniedSrc4) return deniedSrc4;
      SourceGovernance.EnsureMigratedAll(s);
      var list = s.Sources.Values
        .Where(x => x.BoardId == doc.BoardId && x.FamilyKey == doc.FamilyKey)
        .OrderByDescending(x => x.Version).ToList();
      if (list.Count == 0)
        list = s.Sources.Values.Where(x => x.BoardId == doc.BoardId && x.FileName == doc.FileName && x.Scope == doc.Scope && x.MeetingId == doc.MeetingId).OrderByDescending(x => x.Version).ToList();
      if (IsBoardReader(s, req, doc.BoardId) || IsSourceManager(s, req, doc.BoardId, doc.MeetingId))
        return Results.Ok(list.Select(d => ShapeDoc(s, d)));
      if (!IsApprovedVisible(doc) || !InGuestScope(s, req, doc)) return PeopleOps.Denied();
      var gv = list.Where(x => IsApprovedVisible(x) && InGuestScope(s, req, x)).ToList();
      if (gv.Count == 0) return PeopleOps.Denied();
      return Results.Ok(gv.Select(d => GuestShape(s, d)));
    });

    app.MapGet("/api/sources/{id:guid}/history", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (!s.Sources.TryGetValue(id, out var doc)) return Results.NotFound();
      if (PeopleOps.Check(s, req, doc.BoardId, doc.MeetingId, "read") is { } deniedSrc5) return deniedSrc5;
      if (!IsBoardReader(s, req, doc.BoardId) && !IsSourceManager(s, req, doc.BoardId, doc.MeetingId))
      {
        var fam = s.Sources.Values.Where(x => x.BoardId == doc.BoardId && x.FamilyKey == doc.FamilyKey).ToList();
        if (!fam.Any(x => IsApprovedVisible(x) && InGuestScope(s, req, x))) return PeopleOps.Denied();
      }
      var evs = s.SourceEvents.Values.Where(e => e.SourceId == id || (e.BoardId == doc.BoardId && e.FamilyKey == doc.FamilyKey))
        .OrderBy(e => e.CreatedAt).Take(200).ToList();
      return Results.Ok(evs);
    });

    app.MapGet("/api/sources/{id:guid}/sections", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (!s.Sources.TryGetValue(id, out var doc)) return Results.NotFound();
      if (PeopleOps.Check(s, req, doc.BoardId, doc.MeetingId, "read") is { } deniedSrc6) return deniedSrc6;
      if (!IsBoardReader(s, req, doc.BoardId) && !IsSourceManager(s, req, doc.BoardId, doc.MeetingId)
        && (!IsApprovedVisible(doc) || !InGuestScope(s, req, doc))) return PeopleOps.Denied();
      var secs = s.SourceSections.Values.Where(x => x.SourceId == id).OrderBy(x => x.Ordinal).Take(40).ToList();
      return Results.Ok(new
      {
        sourceId = id, version = doc.Version, contentHash = doc.ContentHash,
        indexState = doc.IndexState, indexGeneration = doc.IndexGeneration,
        indexError = doc.IndexError, indexCompletedAt = doc.IndexCompletedAt,
        sections = secs,
      });
    });

    app.MapGet("/api/sources/{id:guid}/index", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (!s.Sources.TryGetValue(id, out var doc)) return Results.NotFound();
      if (PeopleOps.Check(s, req, doc.BoardId, doc.MeetingId, "read") is { } deniedSrc7) return deniedSrc7;
      var secs = s.SourceSections.Values.Count(x => x.SourceId == id);
      return Results.Ok(new
      {
        sourceId = id, version = doc.Version, contentHash = doc.ContentHash,
        state = doc.IndexState, generation = doc.IndexGeneration,
        error = doc.IndexError, completedAt = doc.IndexCompletedAt,
        sectionCount = secs,
        eligible = SourceGovernance.IsEligible(s, doc, doc.Scope == "meeting" ? doc.MeetingId : null),
      });
    });
    // Retry/reindex never touches review state: the reservation captures the
    // current version/hash/generation before the extraction await, and the
    // commit verifies them after. A rejection or approval that lands during
    // extraction stands; stale completions are discarded without restoring
    // old domain state.
    app.MapPost("/api/sources/{id:guid}/reindex", async (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (!s.Sources.TryGetValue(id, out var found)) return Results.NotFound();
      if (PeopleOps.BadToken(s, req) is { } badRe) return badRe;
      if (PeopleOps.Check(s, req, found.BoardId, found.MeetingId, "contribute") is { } deniedSrc8) return deniedSrc8;
      if (!SourceGovernance.TryBeginIndex(s, req, id, "contribute", out var res, out var beginErr) || res is null)
        return Results.Json(new { error = beginErr }, statusCode: 404);
      var reviewBefore = "";
      lock (s.SetupLock) { lock (s.MessageLock) {
        if (s.Sources.TryGetValue(id, out var rb) && rb is not null) reviewBefore = rb.ReviewState ?? "";
      } }
      // Refresh extraction from stored bytes when available: reindex genuinely
      // retries a previously failed extraction instead of fail-closing on its
      // stale failure status. Only the current attempt may stamp its output.
      SourceDoc? snap = null;
      lock (s.SetupLock) { lock (s.MessageLock) {
        if (s.Sources.TryGetValue(id, out var cur) && cur is not null) snap = cur;
      } }
      if (snap is not null && snap.Original is not null)
      {
        var ext = await Extraction.ExtractAsync(snap.Original, snap.FileName);
        SourceGovernance.StampExtraction(s, req, res, Extraction.ToJson(ext), "contribute");
      }
      var (ok, stale, lost, finErr, status) = SourceGovernance.FinishIndex(s, req, res, true, "contribute");
      if (!ok)
        return Results.Json(new { error = finErr, stale }, statusCode: status);
      if (!s.Sources.TryGetValue(id, out var doc) || doc is null) return Results.NotFound();
      var reviewAfter = doc.ReviewState ?? "";
      return Results.Ok(new { doc = ShapeDoc(s, doc), reviewUnchanged = string.Equals(reviewAfter, reviewBefore, StringComparison.OrdinalIgnoreCase), eligibilityLost = lost });
    });

    app.MapPost("/api/sources/{id:guid}/approve", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badAp) return badAp;
      // All authorization and validation run inside the helper against the
      // freshly fetched rows under the governance locks.
      var (ok, err, status) = SourceGovernance.TryApproveById(s, req, id);
      if (!ok) return Results.Json(new { error = err }, statusCode: status);
      if (!s.Sources.TryGetValue(id, out var cur) || cur is null) return Results.NotFound();
      return Results.Ok(ShapeDoc(s, cur));
    });

    app.MapPost("/api/sources/{id:guid}/reject", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badRj) return badRj;
      var (ok, err, status) = SourceGovernance.TryRejectById(s, req, id);
      if (!ok) return Results.Json(new { error = err }, statusCode: status);
      if (!s.Sources.TryGetValue(id, out var cur) || cur is null) return Results.NotFound();
      return Results.Ok(ShapeDoc(s, cur));
    });

    app.MapGet("/api/sources/{id:guid}/download", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (!s.Sources.TryGetValue(id, out var doc)) return Results.NotFound();
      if (PeopleOps.Check(s, req, doc.BoardId, doc.MeetingId, "read") is { } deniedSrc9) return deniedSrc9;
      if (!IsBoardReader(s, req, doc.BoardId) && !IsSourceManager(s, req, doc.BoardId, doc.MeetingId)
        && (!IsApprovedVisible(doc) || !InGuestScope(s, req, doc))) return PeopleOps.Denied();
      if (doc.Original is null) return Results.NotFound("original not retained");
      return Results.Bytes(doc.Original, "application/octet-stream", doc.FileName);
    });

    app.MapPost("/api/sources/{id:guid}/restore", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badRs) return badRs;
      var (ok, err, status) = SourceGovernance.SetExcludedById(s, req, id, false);
      if (!ok) return Results.Json(new { error = err }, statusCode: status);
      if (!s.Sources.TryGetValue(id, out var cur) || cur is null) return Results.NotFound();
      return Results.Ok(ShapeDoc(s, cur));
    });
    // Scope PATCH + review/exclusion PATCH. Canonical family identity is
    // immutable: any request that would change a source's board/scope/
    // meeting/origin/file identity is denied with 409 and an actionable
    // message to upload a new version in the destination scope instead
    // (deny-and-upload). The ENTIRE remaining operation is validated first
    // against freshly fetched rows inside the serialized boundary —
    // including the caller's authorization on the fresh source — and only
    // then does one atomic unit mutate. A rejected request leaves scope,
    // review, and exclusion exactly unchanged.
    app.MapPatch("/api/sources/{id:guid}", (InMemoryStore s, HttpRequest req, Guid id, JsonElement body) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badPa) return badPa;
      // Parse desired ops (no state reads yet beyond shape validation).
      string? wantScope = null;
      if (body.TryGetProperty("scope", out var sc) && sc.ValueKind == JsonValueKind.String
          && (sc.GetString() == "board" || sc.GetString() == "meeting"))
        wantScope = sc.GetString();
      bool hasMeetingId = body.TryGetProperty("meetingId", out var mi)
        && mi.ValueKind == JsonValueKind.String && Guid.TryParse(mi.GetString(), out _);
      bool hasApproved = body.TryGetProperty("approved", out var ap)
        && (ap.ValueKind == JsonValueKind.True || ap.ValueKind == JsonValueKind.False);
      bool wantApproved = hasApproved && ap.ValueKind == JsonValueKind.True;
      bool hasExcluded = body.TryGetProperty("excluded", out var ex)
        && (ex.ValueKind == JsonValueKind.True || ex.ValueKind == JsonValueKind.False);
      bool wantExcluded = hasExcluded && ex.ValueKind == JsonValueKind.True;
      lock (s.SetupLock)
      {
        lock (s.MessageLock)
        {
          if (!s.Sources.TryGetValue(id, out var doc) || doc is null) return Results.NotFound();
          SourceGovernance.EnsureMigrated(s, doc);
          if (PeopleOps.Check(s, req, doc.BoardId, doc.MeetingId, "contribute") is { } deniedSrc10) return deniedSrc10;
          // ---- scope change requests are denied, never applied ----
          if (wantScope is not null)
          {
            Guid? wantMeeting = null;
            if (wantScope == "meeting")
            {
              if (body.TryGetProperty("meetingId", out var mi2) && mi2.ValueKind == JsonValueKind.String && Guid.TryParse(mi2.GetString(), out var g)) wantMeeting = g;
              else if (doc.MeetingId.HasValue) wantMeeting = doc.MeetingId;
            }
            var targetMeeting = wantScope == "meeting" ? wantMeeting : null;
            if (wantScope == "meeting" && !targetMeeting.HasValue)
              return Results.BadRequest("meetingId is required for meeting scope.");
            if (wantScope != doc.Scope || targetMeeting != doc.MeetingId)
            {
              if (string.Equals((doc.Origin ?? "").Trim(), "wiki", System.StringComparison.OrdinalIgnoreCase))
                return Results.Json(new { error = "Wiki connector scope is authoritative; move the resource via its Wiki resource (scope/meeting), not generic source scope editing." }, statusCode: 409);
              return Results.Json(new { error = "Scope changes are not performed by edit; upload a new version in the destination board/meeting scope instead. This version keeps its scope, review, and history." }, statusCode: 409);
            }
          }
          else if (hasMeetingId && !doc.MeetingId.HasValue)
          {
            // Legacy tolerance: a bare unparseable meetingId with no scope
            // change is ignored.
          }
          var freshRs = (doc.ReviewState ?? "").Trim().ToLowerInvariant();
          var freshHead = s.SourceHeads.Values.FirstOrDefault(h => h.BoardId == doc.BoardId && h.FamilyKey == doc.FamilyKey);
          if (hasApproved && wantApproved)
          {
            if (!s.Boards.TryGetValue(doc.BoardId, out var bb)) return Results.NotFound("board");
            if (!SourceGovernance.PolicyAllows(bb, doc))
              return Results.Json(new { error = "Board policy forbids this source; approval blocked." }, statusCode: 409);
            if (freshHead is not null && freshHead.HeadVersion > 0)
            {
              if (doc.Version < freshHead.HeadVersion)
                return Results.Json(new { error = "Superseded by newer approved version v" + freshHead.HeadVersion + "; approval rejected." }, statusCode: 409);
              if (doc.Version == freshHead.HeadVersion && freshHead.HeadSourceId != Guid.Empty && doc.Id != freshHead.HeadSourceId)
                return Results.Json(new { error = "Family/version collision: another approved document already heads v" + freshHead.HeadVersion + "." }, statusCode: 409);
            }
            if (freshRs == "rejected")
              return Results.Json(new { error = "Rejected versions cannot be approved; upload a new version." }, statusCode: 409);
            if (freshRs == "approved" && !(freshHead is not null && freshHead.HeadVersion == doc.Version && freshHead.HeadSourceId == doc.Id))
              return Results.Json(new { error = "Superseded by the current family head; approval rejected." }, statusCode: 409);
          }
          if (hasApproved && !wantApproved)
          {
            // Every review change routes through the legal transition:
            // approved rows cannot be un-approved via edit (exclude to revoke),
            // rejected rows cannot be reset to pending via edit (upload a new
            // version), and pending rows are already un-approved (no-op).
            if (freshRs == "approved") return Results.Json(new { error = "Approved versions cannot be un-approved via edit; exclude to revoke current evidence." }, statusCode: 409);
            if (freshRs == "rejected") return Results.Json(new { error = "Rejected versions cannot be reset via edit; upload a new version." }, statusCode: 409);
          }
          // ---- all valid: one atomic mutation + invalidation unit ----
          string? atomicFailure = null;
          try
          {
            SourceGovernance.MutateEvidence(s, doc.BoardId, "source.patch " + doc.FileName, () =>
            {
              if (!s.Sources.TryGetValue(id, out var cur) || cur is null)
                throw new InvalidOperationException("source vanished during patch");
              if (!PeopleOps.Can(s, req, cur.BoardId, cur.MeetingId, "contribute"))
                throw new InvalidOperationException("authorization changed before commit");
              if (wantScope is not null || hasMeetingId)
              {
                Guid? wantMeetingNow = null;
                if ((wantScope ?? cur.Scope) == "meeting")
                {
                  if (body.TryGetProperty("meetingId", out var mi3) && mi3.ValueKind == JsonValueKind.String && Guid.TryParse(mi3.GetString(), out var g3)) wantMeetingNow = g3;
                  else if (cur.MeetingId.HasValue) wantMeetingNow = cur.MeetingId;
                }
                var wantScopeNow = wantScope ?? cur.Scope;
                var targetNow = wantScopeNow == "meeting" ? wantMeetingNow : null;
                if (wantScopeNow != cur.Scope || targetNow != cur.MeetingId)
                  throw new InvalidOperationException("scope change denied; upload a new version in the destination scope instead");
              }
              if (hasApproved && wantApproved && !string.Equals((cur.ReviewState ?? "").Trim(), "approved", StringComparison.OrdinalIgnoreCase))
              {
                if (!string.Equals((cur.ReviewState ?? "").Trim(), "pending", StringComparison.OrdinalIgnoreCase))
                  throw new InvalidOperationException("review state changed before commit");
                if (!s.Boards.TryGetValue(cur.BoardId, out var pcb) || pcb is null)
                  throw new InvalidOperationException("board vanished during patch");
                if (!SourceGovernance.PolicyAllows(pcb, cur))
                  throw new InvalidOperationException("board policy forbids this source at commit");
                cur.ReviewState = "approved"; cur.Approved = true;
                var h = s.SourceHeads.Values.FirstOrDefault(x => x.BoardId == cur.BoardId && x.FamilyKey == cur.FamilyKey);
                if (h is null)
                {
                  h = new SourceFamilyHead { BoardId = cur.BoardId, FamilyKey = cur.FamilyKey, HeadVersion = cur.Version, HeadSourceId = cur.Id, HighWater = cur.Version, UpdatedAt = DateTime.UtcNow };
                  s.SourceHeads[h.Id] = h;
                }
                else if (cur.Version > h.HeadVersion)
                {
                  h.HeadVersion = cur.Version; h.HeadSourceId = cur.Id; if (cur.Version > h.HighWater) h.HighWater = cur.Version; h.UpdatedAt = DateTime.UtcNow;
                }
                else if (cur.Version == h.HeadVersion && h.HeadSourceId != Guid.Empty && h.HeadSourceId != cur.Id)
                {
                  throw new InvalidOperationException("family/version collision at promotion");
                }
                else if (cur.Version == h.HeadVersion && h.HeadSourceId == Guid.Empty)
                {
                  h.HeadSourceId = cur.Id; h.UpdatedAt = DateTime.UtcNow;
                }
                SourceGovernance.RecordEvent(s, cur, "approve", "v" + cur.Version);
              }
              if (hasExcluded)
              {
                cur.Excluded = wantExcluded;
                SourceGovernance.RecordEvent(s, cur, wantExcluded ? "exclude" : "restore", "v" + cur.Version);
              }
              s.Sources.Flush(); s.SourceHeads.Flush();
            });
          }
          catch (InvalidOperationException px) { atomicFailure = px.Message; }
          if (atomicFailure is not null)
            return Results.Json(new { error = "Patch conflict; no state changed (" + atomicFailure + ")." }, statusCode: 409);
          if (!s.Sources.TryGetValue(id, out var fin) || fin is null) return Results.NotFound();
          return Results.Ok(ShapeDoc(s, fin));
        }
      }
    });
    // Retry shares the reindex reservation contract: never restores old
    // review state, discards stale completions, reports eligibility loss.
    app.MapPost("/api/sources/{id:guid}/retry", async (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (!s.Sources.TryGetValue(id, out var found)) return Results.NotFound();
      if (PeopleOps.Check(s, req, found.BoardId, found.MeetingId, "contribute") is { } deniedSrc11) return deniedSrc11;
      if (!SourceGovernance.TryBeginIndex(s, req, id, "contribute", out var res, out var beginErr) || res is null)
        return Results.Json(new { error = beginErr }, statusCode: 404);
      var reviewBefore = "";
      lock (s.SetupLock) { lock (s.MessageLock) {
        if (s.Sources.TryGetValue(id, out var rb) && rb is not null) reviewBefore = rb.ReviewState ?? "";
      } }
      SourceDoc? snap = null;
      lock (s.SetupLock) { lock (s.MessageLock) {
        if (s.Sources.TryGetValue(id, out var cur) && cur is not null) snap = cur;
      } }
      if (snap is not null && snap.Original is not null)
      {
        var ext = await Extraction.ExtractAsync(snap.Original, snap.FileName);
        SourceGovernance.StampExtraction(s, req, res, Extraction.ToJson(ext), "contribute");
      }
      var (ok, stale, lost, finErr, status) = SourceGovernance.FinishIndex(s, req, res, true, "contribute");
      if (!ok)
        return Results.Json(new { error = finErr, stale }, statusCode: status);
      if (!s.Sources.TryGetValue(id, out var doc) || doc is null) return Results.NotFound();
      s.Audit.Add(new AuditEvent { BoardId = doc.BoardId, Action = "source.retry", Detail = JsonSerializer.Serialize(new { id }) });
      return Results.Ok(new { doc = ShapeDoc(s, doc), review = doc.ReviewState, reviewUnchanged = string.Equals(doc.ReviewState ?? "", reviewBefore, StringComparison.OrdinalIgnoreCase), eligibilityLost = lost });
    });

    app.MapGet("/api/boards/{bid:guid}/source-policy", (InMemoryStore s, HttpRequest req, Guid bid) =>
    {
      if (PeopleOps.Check(s, req, bid, null, "read") is { } deniedSrc12) return deniedSrc12;
      s.Boards.TryGetValue(bid, out var pb);
      return Results.Ok(new { blockedTypes = pb?.BlockedTypes ?? "", mode = SourceGovernance.PolicyModeOf(pb) });
    });

    app.MapPut("/api/boards/{bid:guid}/source-policy", (InMemoryStore s, HttpRequest req, Guid bid, JsonElement body) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badPol) return badPol;
      var blocked = body.TryGetProperty("blockedTypes", out var b) ? (b.GetString() ?? "") : "";
      var mode = body.TryGetProperty("mode", out var m) ? (m.GetString() ?? "allowAll") : (body.TryGetProperty("policyMode", out var pm) ? (pm.GetString() ?? "allowAll") : null);
      // All authorization, validation, fetch, and mutation run inside the
      // authoritative core against freshly fetched rows under the locks.
      var (ok, err, status, normBlocked, canon) = SourceGovernance.ApplySourcePolicy(s, req, bid, blocked, mode);
      if (!ok)
        return status == 400 ? Results.BadRequest(err)
          : status == 404 ? Results.NotFound(err)
          : Results.Json(new { error = err }, statusCode: status);
      return Results.Ok(new { blockedTypes = normBlocked, mode = canon });
    });

    app.MapGet("/api/boards/{bid:guid}/context", (InMemoryStore s, HttpRequest req, Guid bid) =>
    {
      if (PeopleOps.Check(s, req, bid, null, "read") is { } deniedSrc13) return deniedSrc13;
      SourceGovernance.EnsureMigratedAll(s);
      var docs = s.Sources.Values.Where(x => x.BoardId == bid).ToList();
      Guid? anyMeeting = s.Meetings.Values.Where(m => m.BoardId == bid).Select(m => (Guid?)m.Id).FirstOrDefault();
      return Results.Ok(new
      {
        total = docs.Count,
        approved = docs.Count(d => SourceGovernance.IsEligible(s, d, d.Scope == "meeting" ? d.MeetingId : null)),
        pending = docs.Count(d => string.Equals(d.ReviewState, "pending", StringComparison.OrdinalIgnoreCase) && !d.Excluded),
        rejected = docs.Count(d => string.Equals(d.ReviewState, "rejected", StringComparison.OrdinalIgnoreCase)),
        excluded = docs.Count(d => d.Excluded),
        indexed = docs.Count(d => string.Equals(d.IndexState, "completed", StringComparison.OrdinalIgnoreCase)),
        indexFailed = docs.Count(d => string.Equals(d.IndexState, "failed", StringComparison.OrdinalIgnoreCase)),
        policy = SourceGovernance.PolicyModeOf(s.Boards.TryGetValue(bid, out var bb) ? bb : null),
        extraction = "local deterministic sections; no vector index",
        hindsight = "PostgreSQL remains authoritative; no vector index configured",
      });
    });
  }
}
