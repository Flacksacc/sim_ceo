using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;
using SimCEO.Api.Work;

namespace SimCEO.Api;

// Source storage and approval: uploads with content-hash dedupe and filename
// versioning, blocked-type policy, meeting/board scope, exclude/restore,
// retry from saved state, and original downloads. Documents are the knowledge
// input (no wiki connector); extraction output lands here once Docling Serve
// is configured on a networked machine.
public static class SourceEndpoints
{
  private const long MaxUploadBytes = 10 * 1024 * 1024;

  public static void MapSourcesX(this WebApplication app)
  {
    app.MapPost("/api/boards/{bid:guid}/sources/upload", async (
      InMemoryStore s, HttpRequest req, Guid bid, IFormFile file, string? scope, Guid? meetingId) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badUp) return badUp;
      if (!s.Boards.TryGetValue(bid, out var pboard)) return Results.NotFound("board");
      var finalScope = scope == "meeting" && meetingId.HasValue ? "meeting" : "board";
      var finalMid = finalScope == "meeting" ? meetingId : null;
      if (PeopleOps.Check(s, req, bid, finalMid, "contribute") is { } deniedUp) return deniedUp;
      if (finalMid.HasValue) { if (!s.Meetings.TryGetValue(finalMid.Value, out var __m) || __m.BoardId != bid) return Results.NotFound("meeting"); }
      if (file is null || file.Length == 0) return Results.BadRequest("No file.");
      if (file.Length > MaxUploadBytes) return Results.BadRequest("File exceeds 10 MB.");
      var ext = Path.GetExtension(file.FileName).TrimStart('.').ToLowerInvariant();
      if (!string.IsNullOrEmpty(pboard.BlockedTypes)
          && pboard.BlockedTypes.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Any(b => string.Equals(b, ext, StringComparison.OrdinalIgnoreCase)))
        return Results.Json(new { error = $"Source type '.{ext}' is blocked on this board." }, statusCode: 415);
      using var ms = new MemoryStream();
      await file.CopyToAsync(ms);
      var bytes = ms.ToArray();
      var hash = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
      var dup = s.Sources.Values.FirstOrDefault(x => x.BoardId == bid && x.ContentHash == hash);
      if (dup is not null) return Results.Conflict($"Identical content already stored as {dup.Id} (v{dup.Version}).");
      var version = s.Sources.Values
        .Where(x => x.BoardId == bid && string.Equals(x.FileName, file.FileName, StringComparison.OrdinalIgnoreCase))
        .Select(x => (int?)x.Version).Max() ?? 0;
      var doc = new SourceDoc
      {
        BoardId = bid, FileName = file.FileName, ContentHash = hash,
        Version = version + 1, Approved = false, Excluded = false,
        Scope = finalScope,
        MeetingId = finalMid,
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
      s.Audit.Add(new AuditEvent { BoardId = bid, Action = "source.upload", Detail = JsonSerializer.Serialize(new { doc.Id, doc.FileName, doc.Version }) });
      return Results.Created($"/api/sources/{doc.Id}", doc);
    }).DisableAntiforgery(); // token-less API: no cookie auth, scope checks are explicit per request

    app.MapGet("/api/sources/{id:guid}/versions", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (!s.Sources.TryGetValue(id, out var doc)) return Results.NotFound();
      if (PeopleOps.BadToken(s, req) is { } badVer) return badVer;
      if (PeopleOps.IsSecure(s) && !AuthOps.TrySession(s, req, out _)) return Results.Json(new { error = "Authentication required." }, statusCode: 401);
      if (!PeopleOps.Can(s, req, doc.BoardId, null, "read"))
      {
        var u = PeopleOps.UserOf(s, req);
        var allowed = PeopleOps.GuestMeetingIds(s, u, doc.BoardId);
        if (allowed.Count == 0) return PeopleOps.Denied();
        var mid = doc.MeetingId ?? allowed[0];
        if (PeopleOps.Check(s, req, doc.BoardId, mid, "read") is { } deniedVer2) return deniedVer2;
        if (!(doc.Approved && !doc.Excluded && (doc.Scope == "board" || (doc.MeetingId.HasValue && allowed.Contains(doc.MeetingId.Value))))) return PeopleOps.Denied();
      }
      var rows = s.Sources.Values
        .Where(x => x.BoardId == doc.BoardId && x.FileName == doc.FileName)
        .OrderByDescending(x => x.Version).ToList();
      // Per-row eligible-evidence filtering: meeting guests see only approved+non-excluded rows in their scope.
      if (!PeopleOps.Can(s, req, doc.BoardId, null, "read"))
      {
        var u2 = PeopleOps.UserOf(s, req);
        var allowed2 = PeopleOps.GuestMeetingIds(s, u2, doc.BoardId);
        rows = rows.Where(x => x.Approved && !x.Excluded && (x.Scope == "board" || (x.MeetingId.HasValue && allowed2.Contains(x.MeetingId.Value)))).ToList();
        // Strip payload for guest rows to eligible evidence only (no Original bytes for unapproved already filtered).
      }
      return Results.Ok(rows);
    });

    app.MapPost("/api/sources/{id:guid}/approve", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (!s.Sources.TryGetValue(id, out var apd)) return Results.NotFound();
      if (PeopleOps.BadToken(s, req) is { } badAp) return badAp;
      if (PeopleOps.Check(s, req, apd.BoardId, apd.MeetingId, "contribute") is { } deniedAp) return deniedAp;
      apd.Approved = true;
      apd.Excluded = false;
      s.Sources.Flush();
      return Results.Ok(apd);
    });

    app.MapGet("/api/sources/{id:guid}/download", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (!s.Sources.TryGetValue(id, out var doc)) return Results.NotFound();
      if (PeopleOps.BadToken(s, req) is { } badDl) return badDl;
      if (PeopleOps.IsSecure(s) && !AuthOps.TrySession(s, req, out _)) return Results.Json(new { error = "Authentication required." }, statusCode: 401);
      if (!PeopleOps.Can(s, req, doc.BoardId, null, "read"))
      {
        var u2 = PeopleOps.UserOf(s, req);
        var allowed2 = PeopleOps.GuestMeetingIds(s, u2, doc.BoardId);
        if (allowed2.Count == 0) return PeopleOps.Denied();
        var mid2 = doc.MeetingId ?? allowed2[0];
        if (PeopleOps.Check(s, req, doc.BoardId, mid2, "read") is { } deniedDl2) return deniedDl2;
        if (!(doc.Approved && !doc.Excluded && (doc.Scope == "board" || (doc.MeetingId.HasValue && allowed2.Contains(doc.MeetingId.Value))))) return PeopleOps.Denied();
      }
      if (doc.Original is null) return Results.NotFound("original not retained");
      return Results.Bytes(doc.Original, "application/octet-stream", doc.FileName);
    });

    app.MapPost("/api/sources/{id:guid}/restore", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (!s.Sources.TryGetValue(id, out var doc)) return Results.NotFound();
      if (PeopleOps.Check(s, req, doc.BoardId, doc.MeetingId, "contribute") is { } deniedDoc) return deniedDoc;
      doc.Excluded = false;
      s.Sources.Flush();
      s.Audit.Add(new AuditEvent { BoardId = doc.BoardId, Action = "source.restore", Detail = JsonSerializer.Serialize(new { id }) });
      return Results.Ok(doc);
    });

    app.MapPatch("/api/sources/{id:guid}", (InMemoryStore s, HttpRequest req, Guid id, JsonElement body) =>
    {
      if (!s.Sources.TryGetValue(id, out var doc)) return Results.NotFound();
      if (PeopleOps.Check(s, req, doc.BoardId, doc.MeetingId, "contribute") is { } deniedDoc) return deniedDoc;
      if (body.TryGetProperty("scope", out var sc) && sc.GetString() is { } scope
          && (scope == "board" || scope == "meeting"))
      {
        var __nm = scope == "meeting" && body.TryGetProperty("meetingId", out var mi) ? mi.GetGuid() : (Guid?)null;
        var __ns = scope == "meeting" && __nm.HasValue ? "meeting" : "board";
        if (__nm.HasValue) { if (!s.Meetings.TryGetValue(__nm.Value, out var __mm2) || __mm2.BoardId != doc.BoardId) return Results.NotFound("meeting"); }
        if (PeopleOps.Check(s, req, doc.BoardId, __ns == "meeting" ? __nm : null, "contribute") is { } deniedScope) return deniedScope;
        doc.Scope = __ns;
        doc.MeetingId = __ns == "meeting" ? __nm : null;
      }
      if (body.TryGetProperty("approved", out var ap)
          && (ap.ValueKind == JsonValueKind.True || ap.ValueKind == JsonValueKind.False))
        doc.Approved = ap.ValueKind == JsonValueKind.True;
      if (body.TryGetProperty("excluded", out var ex)
          && (ex.ValueKind == JsonValueKind.True || ex.ValueKind == JsonValueKind.False))
        doc.Excluded = ex.ValueKind == JsonValueKind.True;
      s.Sources.Flush();
      return Results.Ok(doc);
    });

    app.MapPost("/api/sources/{id:guid}/retry", async (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (!s.Sources.TryGetValue(id, out var doc)) return Results.NotFound();
      if (PeopleOps.Check(s, req, doc.BoardId, doc.MeetingId, "contribute") is { } deniedDoc) return deniedDoc;
      if (doc.Original is not null)
      {
        var ext = await Extraction.ExtractAsync(doc.Original, doc.FileName);
        doc.ExtractionJson = Extraction.ToJson(ext);
        s.Sources.Flush();
      }
      s.Audit.Add(new AuditEvent { BoardId = doc.BoardId, Action = "source.retry", Detail = JsonSerializer.Serialize(new { id }) });
      return Results.Ok(new { doc, extraction = doc.ExtractionJson });
    });

    app.MapGet("/api/boards/{bid:guid}/source-policy", (InMemoryStore s, HttpRequest req, Guid bid) =>
    {
      if (PeopleOps.Check(s, req, bid, null, "read") is { } deniedPol) return deniedPol;
      s.Boards.TryGetValue(bid, out var pb);
      return Results.Ok(new { blockedTypes = pb?.BlockedTypes ?? "" });
    });

    app.MapPut("/api/boards/{bid:guid}/source-policy", (InMemoryStore s, HttpRequest req, Guid bid, JsonElement body) =>
    {
      if (PeopleOps.Check(s, req, bid, null, "manage") is { } deniedPolPut) return deniedPolPut;
      var blocked = body.TryGetProperty("blockedTypes", out var b) ? (b.GetString() ?? "") : "";
      if (s.Boards.TryGetValue(bid, out var pbb)) { pbb.BlockedTypes = blocked; s.Boards.Flush(); }
      s.Audit.Add(new AuditEvent { BoardId = bid, Action = "source.policy", Detail = JsonSerializer.Serialize(new { blocked }) });
      return Results.Ok(new { blockedTypes = blocked });
    });

    app.MapGet("/api/boards/{bid:guid}/context", (InMemoryStore s, HttpRequest req, Guid bid) =>
    {
      if (PeopleOps.BadToken(s, req) is { } badCx) return badCx;
      if (PeopleOps.IsSecure(s) && !AuthOps.TrySession(s, req, out _)) return Results.Json(new { error = "Authentication required." }, statusCode: 401);
      if (!PeopleOps.Can(s, req, bid, null, "read"))
      {
        var gu = PeopleOps.UserOf(s, req);
        var gm = PeopleOps.GuestMeetingIds(s, gu, bid);
        if (gm.Count == 0) return PeopleOps.Denied();
        var eligible = s.Sources.Values.Where(x => x.BoardId == bid && x.Approved && !x.Excluded && (x.Scope == "board" || (x.MeetingId.HasValue && gm.Contains(x.MeetingId.Value)))).ToList();
        return Results.Ok(new { total = eligible.Count, approved = eligible.Count(d => d.Approved && !d.Excluded), pending = 0, excluded = 0, guest = true, extraction = "stub: document service not configured; text/Markdown read directly on upload path", hindsight = "stub: PostgreSQL remains authoritative; no vector index configured" });
      }
      var docs = s.Sources.Values.Where(x => x.BoardId == bid).ToList();
      return Results.Ok(new
      {
        total = docs.Count,
        approved = docs.Count(d => d.Approved && !d.Excluded),
        pending = docs.Count(d => !d.Approved && !d.Excluded),
        excluded = docs.Count(d => d.Excluded),
        extraction = "stub: document service not configured; text/Markdown read directly on upload path",
        hindsight = "stub: PostgreSQL remains authoritative; no vector index configured",
      });
    });

  }
}
