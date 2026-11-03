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
public static class SourceEndpoints
{
  private const long MaxUploadBytes = 10 * 1024 * 1024;

  private static object ShapeDoc(InMemoryStore s, SourceDoc d)
  {
    SourceGovernance.EnsureMigrated(s, d);
    var head = s.SourceHeads.Values.FirstOrDefault(h => h.BoardId == d.BoardId && h.FamilyKey == d.FamilyKey);
    var isHead = head is not null && head.HeadVersion == d.Version;
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

  public static void MapSourcesX(this WebApplication app)
  {
    app.MapPost("/api/boards/{bid:guid}/sources/upload", async (
      InMemoryStore s, HttpRequest req, Guid bid, IFormFile file, string? scope, Guid? meetingId) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badUp) return badUp;
      if (!s.Boards.TryGetValue(bid, out var pboard)) return Results.NotFound("board");
      try { if (req.HasFormContentType && (scope is null || meetingId is null)) { var fscope = req.Form["scope"].ToString(); if (!string.IsNullOrWhiteSpace(fscope)) scope = fscope; var fmid = req.Form["meetingId"].ToString(); if (!string.IsNullOrWhiteSpace(fmid) && Guid.TryParse(fmid, out var fg)) meetingId = fg; } } catch { } if (!PeopleOps.Can(s, req, bid, meetingId, "contribute")) return PeopleOps.Denied();
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
      // Dedup is family-scoped (same bytes in the same board/scope/meeting/
      // origin/file family): identical bytes under a different family are a
      // separate pending version, never an unrelated board-wide conflict.
      var dup = s.Sources.Values.FirstOrDefault(x => x.BoardId == bid && x.FamilyKey == familyKey && x.ContentHash == hash);
      if (dup is not null) return Results.Conflict($"Identical content already stored as {dup.Id} (v{dup.Version}).");
      var version = s.Sources.Values
        .Where(x => x.BoardId == bid && x.FamilyKey == familyKey)
        .Select(x => (int?)x.Version).Max()
        ?? s.Sources.Values.Where(x => x.BoardId == bid && string.Equals(x.FileName, file.FileName, StringComparison.OrdinalIgnoreCase)).Select(x => (int?)x.Version).Max()
        ?? 0;
      var doc = new SourceDoc
      {
        BoardId = bid, FileName = file.FileName, ContentHash = hash,
        Version = version + 1, Approved = false, Excluded = false,
        ReviewState = "pending", Origin = "upload",
        FamilyKey = familyKey,
        Scope = effScope, MeetingId = effMeeting,
        IndexState = "queued", IndexGeneration = 0,
      };
      doc.Original = bytes;
      s.Sources[doc.Id] = doc;
      try
      {
        var exr = await Extraction.ExtractAsync(bytes, file.FileName);
        doc.ExtractionJson = Extraction.ToJson(exr);
      }
      catch (Exception ex)
      {
        doc.ExtractionJson = Extraction.ToJson(new Extraction.Result("failed", null, ex.Message));
      }
      s.Sources.Flush();
      SourceGovernance.IndexSource(s, doc, false);
      SourceGovernance.RecordEvent(s, doc, "upload", "scope=" + effScope);
      return Results.Created($"/api/sources/{doc.Id}", ShapeDoc(s, doc));
    }).DisableAntiforgery();

    app.MapGet("/api/boards/{bid:guid}/sources", (InMemoryStore s, HttpRequest req, Guid bid, string? review, string? family) =>
    {
      if (!PeopleOps.Can(s, req, bid, null, "read")) return PeopleOps.Denied();
      SourceGovernance.EnsureMigratedAll(s);
      var q = s.Sources.Values.Where(x => x.BoardId == bid);
      if (!string.IsNullOrWhiteSpace(review))
      {
        var r = review.Trim().ToLowerInvariant();
        q = q.Where(x => (x.ReviewState ?? "pending").ToLower() == r);
      }
      if (!string.IsNullOrWhiteSpace(family)) q = q.Where(x => x.FamilyKey == family);
      return Results.Ok(q.OrderByDescending(x => x.Version).ToList().Select(d => ShapeDoc(s, d)));
    });

    app.MapGet("/api/boards/{bid:guid}/sources/review", (InMemoryStore s, HttpRequest req, Guid bid) =>
    {
      if (!PeopleOps.Can(s, req, bid, null, "read")) return PeopleOps.Denied();
      SourceGovernance.EnsureMigratedAll(s);
      var docs = s.Sources.Values.Where(x => x.BoardId == bid).ToList();
      foreach (var d in docs) SourceGovernance.EnsureMigrated(s, d);
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
          versions = ordered.Select(d => ShapeDoc(s, d)),
        };
      }).OrderBy(g => g.fileName).ToList();
      return Results.Ok(groups);
    });

    app.MapGet("/api/sources/{id:guid}/versions", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (!s.Sources.TryGetValue(id, out var doc)) return Results.NotFound();
      if (!PeopleOps.Can(s, req, doc.BoardId, doc.MeetingId, "read")) return PeopleOps.Denied();
      SourceGovernance.EnsureMigratedAll(s);
      var list = s.Sources.Values
        .Where(x => x.BoardId == doc.BoardId && x.FamilyKey == doc.FamilyKey)
        .OrderByDescending(x => x.Version).ToList();
      if (list.Count == 0)
        list = s.Sources.Values.Where(x => x.BoardId == doc.BoardId && x.FileName == doc.FileName).OrderByDescending(x => x.Version).ToList();
      return Results.Ok(list.Select(d => ShapeDoc(s, d)));
    });

    app.MapGet("/api/sources/{id:guid}/history", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (!s.Sources.TryGetValue(id, out var doc)) return Results.NotFound();
      if (!PeopleOps.Can(s, req, doc.BoardId, doc.MeetingId, "read")) return PeopleOps.Denied();
      var evs = s.SourceEvents.Values.Where(e => e.SourceId == id || (e.BoardId == doc.BoardId && e.FamilyKey == doc.FamilyKey))
        .OrderBy(e => e.CreatedAt).Take(200).ToList();
      return Results.Ok(evs);
    });

    app.MapGet("/api/sources/{id:guid}/sections", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (!s.Sources.TryGetValue(id, out var doc)) return Results.NotFound();
      if (!PeopleOps.Can(s, req, doc.BoardId, doc.MeetingId, "read")) return PeopleOps.Denied();
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
      if (!PeopleOps.Can(s, req, doc.BoardId, doc.MeetingId, "read")) return PeopleOps.Denied();
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

    app.MapPost("/api/sources/{id:guid}/reindex", async (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (!s.Sources.TryGetValue(id, out var doc)) return Results.NotFound();
      if (PeopleOps.BadToken(s, req) is { } badRe) return badRe;
      if (!PeopleOps.Can(s, req, doc.BoardId, doc.MeetingId, "contribute")) return PeopleOps.Denied();
      SourceGovernance.EnsureMigrated(s, doc);
      var before = doc.ReviewState ?? "";
      var wasEligible = SourceGovernance.IsEligible(s, doc, doc.Scope == "meeting" ? doc.MeetingId : null);
      // Refresh extraction from stored bytes when available: reindex genuinely
      // retries a previously failed extraction instead of fail-closing on its
      // stale failure status.
      if (doc.Original is not null)
      {
        var ext = await Extraction.ExtractAsync(doc.Original, doc.FileName);
        doc.ExtractionJson = Extraction.ToJson(ext);
        s.Sources.Flush();
      }
      SourceGovernance.IndexSource(s, doc, true);
      // Reindex never approves: restore any drifted review decision.
      if (!string.Equals(doc.ReviewState ?? "", before, StringComparison.OrdinalIgnoreCase))
      {
        doc.ReviewState = before; doc.Approved = string.Equals(before, "approved", StringComparison.OrdinalIgnoreCase);
        s.Sources.Flush();
      }
      // Losing index eligibility through reindex pauses affected work (P2 #12).
      var lost = SourceGovernance.InvalidateIfEligibilityLost(s, doc, wasEligible, "source.reindex " + doc.FileName + " v" + doc.Version);
      return Results.Ok(new { doc = ShapeDoc(s, doc), reviewUnchanged = string.Equals(doc.ReviewState ?? "", before, StringComparison.OrdinalIgnoreCase), eligibilityLost = lost });
    });

    app.MapPost("/api/sources/{id:guid}/approve", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (!s.Sources.TryGetValue(id, out var apd)) return Results.NotFound();
      if (PeopleOps.BadToken(s, req) is { } badAp) return badAp;
      if (!PeopleOps.Can(s, req, apd.BoardId, apd.MeetingId, "contribute")) return PeopleOps.Denied();
      // Explicit review only: wiki-only and blocked policy still apply at approval.
      if (!s.Boards.TryGetValue(apd.BoardId, out var b)) return Results.NotFound("board");
      SourceGovernance.EnsureMigrated(s, apd);
      if (!SourceGovernance.PolicyAllows(b, apd))
        return Results.Json(new { error = "Board policy forbids this source; approval blocked." }, statusCode: 409);
      var (ok, err, status) = SourceGovernance.TryApprove(s, apd);
      if (!ok) return Results.Json(new { error = err }, statusCode: status);
      return Results.Ok(ShapeDoc(s, apd));
    });

    app.MapPost("/api/sources/{id:guid}/reject", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (!s.Sources.TryGetValue(id, out var doc)) return Results.NotFound();
      if (PeopleOps.BadToken(s, req) is { } badRj) return badRj;
      if (!PeopleOps.Can(s, req, doc.BoardId, doc.MeetingId, "contribute")) return PeopleOps.Denied();
      var (ok, err, status) = SourceGovernance.TryReject(s, doc);
      if (!ok) return Results.Json(new { error = err }, statusCode: status);
      return Results.Ok(ShapeDoc(s, doc));
    });

    app.MapGet("/api/sources/{id:guid}/download", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (!s.Sources.TryGetValue(id, out var doc)) return Results.NotFound();
      if (!PeopleOps.Can(s, req, doc.BoardId, doc.MeetingId, "read")) return PeopleOps.Denied();
      if (doc.Original is null) return Results.NotFound("original not retained");
      return Results.Bytes(doc.Original, "application/octet-stream", doc.FileName);
    });

    app.MapPost("/api/sources/{id:guid}/restore", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (!s.Sources.TryGetValue(id, out var doc)) return Results.NotFound();
      if (!PeopleOps.Can(s, req, doc.BoardId, doc.MeetingId, "contribute")) return PeopleOps.Denied();
      SourceGovernance.SetExcluded(s, doc, false);
      return Results.Ok(ShapeDoc(s, doc));
    });

    app.MapPatch("/api/sources/{id:guid}", (InMemoryStore s, HttpRequest req, Guid id, JsonElement body) =>
    {
      if (!s.Sources.TryGetValue(id, out var doc)) return Results.NotFound();
      if (!PeopleOps.Can(s, req, doc.BoardId, doc.MeetingId, "contribute")) return PeopleOps.Denied();
      SourceGovernance.EnsureMigrated(s, doc);
      // Wiki connector scope is authoritative: generic source scope editing
      // must never corrupt wiki family identity (resourceId+locale+full path).
      // Connector moves happen only via the Wiki resource endpoints, which
      // preserve identity and revalidate rules. Reject direct wiki scope moves.
      if (string.Equals((doc.Origin ?? "").Trim(), "wiki", System.StringComparison.OrdinalIgnoreCase) && body.ValueKind == JsonValueKind.Object && (body.TryGetProperty("scope", out _) || body.TryGetProperty("meetingId", out _)))
        return Results.Json(new { error = "Wiki connector scope is authoritative; move the resource via its Wiki resource (scope/meeting), not generic source scope editing." }, statusCode: 409);
      // Origin is server-controlled: caller cannot spoof upload vs wiki.
      // Scope moves are collision-safe (P1 #2): a move into an occupied target
      // family is rejected with an actionable conflict, and approval never
      // transfers into the new family — the moved row re-enters pending
      // review while the old head marker stays so no fallback revives history.
      if (body.TryGetProperty("scope", out var sc) && sc.GetString() is { } scope
          && (scope == "board" || scope == "meeting"))
      {
        Guid? mid = null;
        if (scope == "meeting")
        {
          if (body.TryGetProperty("meetingId", out var mi) && mi.ValueKind == JsonValueKind.String && Guid.TryParse(mi.GetString(), out var g)) mid = g;
          else if (doc.MeetingId.HasValue) mid = doc.MeetingId;
          if (!mid.HasValue) return Results.BadRequest("meetingId is required for meeting scope.");
          if (!s.Meetings.TryGetValue(mid.Value, out var mtg) || mtg.BoardId != doc.BoardId)
            return Results.Json(new { error = "Meeting does not belong to this board." }, statusCode: 409);
        }
        var newKey = SourceGovernance.FamilyKeyFor(doc.BoardId, scope, scope == "meeting" ? mid : null, doc.Origin, doc.FileName);
        if (!string.Equals(newKey, doc.FamilyKey, StringComparison.Ordinal))
        {
          var collision = s.Sources.Values.Any(x => x.BoardId == doc.BoardId && x.FamilyKey == newKey && x.Id != doc.Id);
          if (collision)
            return Results.Json(new { error = "Target family already holds a version of this file; upload a new version there instead of moving this one." }, statusCode: 409);
          var oldKey = doc.FamilyKey;
          var wasApproved = string.Equals(doc.ReviewState, "approved", StringComparison.OrdinalIgnoreCase);
          var scopeDetail = "scope " + scope + " " + oldKey + " -> " + newKey;
          if (wasApproved) scopeDetail = "scope " + scope + " (approval reset; re-review required) " + oldKey + " -> " + newKey;
          SourceGovernance.MutateEvidence(s, doc.BoardId, "source.scope " + doc.FileName, () =>
          {
            doc.Scope = scope;
            doc.MeetingId = scope == "meeting" ? mid : null;
            doc.FamilyKey = newKey;
            if (wasApproved) { doc.ReviewState = "pending"; doc.Approved = false; }
            s.Sources.Flush();
            SourceGovernance.RecordEvent(s, doc, "scope", scopeDetail);
          });
        }
      }
      if (body.TryGetProperty("approved", out var ap)
          && (ap.ValueKind == JsonValueKind.True || ap.ValueKind == JsonValueKind.False))
      {
        var want = ap.ValueKind == JsonValueKind.True;
        if (want)
        {
          if (!s.Boards.TryGetValue(doc.BoardId, out var bb)) return Results.NotFound("board");
          if (!SourceGovernance.PolicyAllows(bb, doc))
            return Results.Json(new { error = "Board policy forbids this source; approval blocked." }, statusCode: 409);
          var (ok, err, status) = SourceGovernance.TryApprove(s, doc);
          if (!ok) return Results.Json(new { error = err }, statusCode: status);
        }
        else
        {
          // Every review change routes through the legal transition (P2 #7):
          // approved rows cannot be un-approved via edit (exclude to revoke),
          // rejected rows cannot be reset to pending via edit (upload a new
          // version), and pending rows are already un-approved (no-op).
          var rs = (doc.ReviewState ?? "").Trim().ToLowerInvariant();
          if (rs == "approved") return Results.Json(new { error = "Approved versions cannot be un-approved via edit; exclude to revoke current evidence." }, statusCode: 409);
          if (rs == "rejected") return Results.Json(new { error = "Rejected versions cannot be reset via edit; upload a new version." }, statusCode: 409);
        }
      }
      if (body.TryGetProperty("excluded", out var ex)
          && (ex.ValueKind == JsonValueKind.True || ex.ValueKind == JsonValueKind.False))
        SourceGovernance.SetExcluded(s, doc, ex.ValueKind == JsonValueKind.True);
      // Legacy: ignore caller origin/resourceId (server-controlled seam for phase7).
      return Results.Ok(ShapeDoc(s, doc));
    });

    app.MapPost("/api/sources/{id:guid}/retry", async (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (!s.Sources.TryGetValue(id, out var doc)) return Results.NotFound();
      if (!PeopleOps.Can(s, req, doc.BoardId, doc.MeetingId, "contribute")) return PeopleOps.Denied();
      SourceGovernance.EnsureMigrated(s, doc);
      var before = doc.ReviewState ?? "";
      var wasEligible = SourceGovernance.IsEligible(s, doc, doc.Scope == "meeting" ? doc.MeetingId : null);
      if (doc.Original is not null)
      {
        var ext = await Extraction.ExtractAsync(doc.Original, doc.FileName);
        doc.ExtractionJson = Extraction.ToJson(ext);
        s.Sources.Flush();
      }
      SourceGovernance.IndexSource(s, doc, true);
      // Retry/reindex never approves: restore any drifted review decision.
      if (!string.Equals(doc.ReviewState ?? "", before, StringComparison.OrdinalIgnoreCase))
      {
        doc.ReviewState = before; doc.Approved = string.Equals(before, "approved", StringComparison.OrdinalIgnoreCase);
        s.Sources.Flush();
      }
      // Losing index eligibility through retry pauses affected work (P2 #12).
      var lost = SourceGovernance.InvalidateIfEligibilityLost(s, doc, wasEligible, "source.retry " + doc.FileName + " v" + doc.Version);
      s.Audit.Add(new AuditEvent { BoardId = doc.BoardId, Action = "source.retry", Detail = JsonSerializer.Serialize(new { id }) });
      return Results.Ok(new { doc = ShapeDoc(s, doc), review = doc.ReviewState, reviewUnchanged = string.Equals(doc.ReviewState ?? "", before, StringComparison.OrdinalIgnoreCase), eligibilityLost = lost });
    });

    app.MapGet("/api/boards/{bid:guid}/source-policy", (InMemoryStore s, HttpRequest req, Guid bid) =>
    {
      if (!PeopleOps.Can(s, req, bid, null, "read")) return PeopleOps.Denied();
      s.Boards.TryGetValue(bid, out var pb);
      return Results.Ok(new { blockedTypes = pb?.BlockedTypes ?? "", mode = SourceGovernance.PolicyModeOf(pb) });
    });

    app.MapPut("/api/boards/{bid:guid}/source-policy", (InMemoryStore s, HttpRequest req, Guid bid, JsonElement body) =>
    {
      if (PeopleOps.Can(s, req, bid, null, "manage") != true) return PeopleOps.Denied();
      var blocked = body.TryGetProperty("blockedTypes", out var b) ? (b.GetString() ?? "") : "";
      var mode = body.TryGetProperty("mode", out var m) ? (m.GetString() ?? "allowAll") : (body.TryGetProperty("policyMode", out var pm) ? (pm.GetString() ?? "allowAll") : null);
      if (mode is null)
      {
        s.Boards.TryGetValue(bid, out var cur);
        mode = cur?.SourcePolicyMode ?? "allowAll";
      }
      mode = mode.Trim();
      var ml = mode.ToLowerInvariant();
      if (ml is not ("allowall" or "allow-all" or "wikionly" or "wiki-only" or "wiki_only"))
        return Results.BadRequest("mode must be allowAll or wikiOnly.");
      var canon = (ml.StartsWith("wiki")) ? "wikiOnly" : "allowAll";
      // Validate blocked list shape (comma-separated extensions, no paths).
      var parts = blocked.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToList();
      foreach (var p in parts)
      {
        var q = p.Trim().TrimStart('.');
        if (q.Length == 0 || q.Length > 16 || q.Any(c => !(char.IsLetterOrDigit(c) || c == '-' || c == '_')))
          return Results.BadRequest($"Blocked type '{p}' is not a plain extension.");
      }
      var normBlocked = string.Join(", ", parts.Select(p => p.Trim().TrimStart('.').ToLowerInvariant()).Distinct());
      if (s.Boards.TryGetValue(bid, out var pbb))
      {
        var changed = !string.Equals(pbb.BlockedTypes ?? "", normBlocked, StringComparison.Ordinal) || !string.Equals(SourceGovernance.PolicyModeOf(pbb), canon, StringComparison.Ordinal);
        if (changed)
        {
          // Policy mutation + invalidation share the central governance locks
          // (P1 #1): the policy must never commit ahead of the generation
          // increment + pause a concurrent publication relies on.
          SourceGovernance.MutateEvidence(s, bid, "source.policy " + canon, () =>
          {
            pbb.BlockedTypes = normBlocked; pbb.SourcePolicyMode = canon; s.Boards.Flush();
            s.Audit.Add(new AuditEvent { BoardId = bid, Action = "source.policy", Detail = JsonSerializer.Serialize(new { blocked = normBlocked, mode = canon }) });
            foreach (var d in s.Sources.Values.Where(x => x.BoardId == bid).ToList())
              SourceGovernance.RecordEvent(s, d, "policy", canon + "|" + normBlocked);
          });
        }
      }
      return Results.Ok(new { blockedTypes = normBlocked, mode = canon });
    });

    app.MapGet("/api/boards/{bid:guid}/context", (InMemoryStore s, HttpRequest req, Guid bid) =>
    {
      if (!PeopleOps.Can(s, req, bid, null, "read")) return PeopleOps.Denied();
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



