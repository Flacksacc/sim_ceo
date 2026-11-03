using System.Text;
using System.Text.Json;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;
using SimCEO.Api.Work;

namespace SimCEO.Api;

// Record review: list, detail, revision (new immutable version), amendment
// naming superseded IDs, discard preserving conversation, and concise /
// detailed exports built only from approved items. Free-text agreement never
// approves; approval still flows through the hash + watermark endpoint.
public static class RecordsOps
{
  public static bool ValidateDraftItems(JsonElement items, out string error)
  {
    error = "";
    if (items.ValueKind != JsonValueKind.Array) { error = "Draft items must be a JSON array."; return false; }
    var seen = new HashSet<string>(StringComparer.Ordinal);
    var idx = 0;
    foreach (var el in items.EnumerateArray())
    {
      if (el.ValueKind != JsonValueKind.Object) { error = $"Draft item {idx} must be an object."; return false; }
      var id = el.TryGetProperty("id", out var iv) && iv.ValueKind == JsonValueKind.String ? (iv.GetString() ?? "") : "";
      if (string.IsNullOrWhiteSpace(id)) { error = $"Draft item {idx} must carry a non-empty string id."; return false; }
      var hasText = el.TryGetProperty("text", out var tv) && tv.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(tv.GetString());
      if (!hasText) { error = $"Draft item '{id}' must carry non-empty string text."; return false; }
      if (!seen.Add(id)) { error = $"Duplicate draft item id '{id}'."; return false; }
      idx++;
    }
    return true;
  }

  public static string BuildExport(string itemsJson, string approvedJson, bool detailed)
  {
    using var items = JsonDocument.Parse(string.IsNullOrWhiteSpace(itemsJson) ? "[]" : itemsJson);
    using var approved = JsonDocument.Parse(string.IsNullOrWhiteSpace(approvedJson) ? "[]" : approvedJson);
    var ok = new HashSet<string>(approved.RootElement.EnumerateArray().Select(e => e.GetString() ?? ""));
    var sb = new StringBuilder();
    foreach (var el in items.RootElement.EnumerateArray())
    {
      if (el.ValueKind != JsonValueKind.Object) continue;
      var id = el.TryGetProperty("id", out var i) ? (i.GetString() ?? "") : "";
      if (!ok.Contains(id)) continue;
      var text = el.TryGetProperty("text", out var t) && t.ValueKind == JsonValueKind.String ? (t.GetString() ?? "") : "";
      sb.AppendLine($"- [{id}] {text}");
      if (detailed)
      {
        if (el.TryGetProperty("detail", out var d) && d.GetString() is { } detail) sb.AppendLine($"  detail: {detail}");
        if (el.TryGetProperty("status", out var st) && st.GetString() is { } status) sb.AppendLine($"  status: {status}");
        if (el.TryGetProperty("scope", out var sc) && sc.GetString() is { } scope) sb.AppendLine($"  scope: {scope}");
        if (el.TryGetProperty("refs", out var rf) && rf.ValueKind == JsonValueKind.Array)
        {
          var bits = new List<string>();
          foreach (var r in rf.EnumerateArray())
            if (EvidenceRef.Parse(r) is { } er) bits.Add(er.Kind + ":" + er.Ref);
          if (bits.Count > 0) sb.AppendLine("  refs: " + string.Join(", ", bits));
        }
      }
    }
    return sb.ToString();
  }
}

public static class RecordEndpoints
{
  public static void MapRecords(this WebApplication app)
  {
    app.MapGet("/api/meetings/{id:guid}/records", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (!s.Meetings.TryGetValue(id, out var m)) return Results.NotFound("meeting");
      if (PeopleOps.Check(s, req, m.BoardId, id, "read") is { } deniedRL) return deniedRL;
      var isMgr = PeopleOps.Can(s, req, m.BoardId, null, "manage") || PeopleOps.Can(s, req, m.BoardId, id, "contribute");
      var rows = s.Drafts.Values.Where(d => d.MeetingId == id).OrderByDescending(d => d.Version).Take(50).ToList();
      if (!isMgr)
      {
        // Meeting-only guests: approved records only, approved items/content only.
        rows = rows.Where(d => d.Decided && !string.IsNullOrWhiteSpace(d.ApprovedJson) && d.ApprovedJson.Trim() != "[]").ToList();
        var out_ = new System.Collections.Generic.List<object>();
        foreach (var d in rows) { out_.Add(new { d.Id, d.BoardId, d.MeetingId, d.Version, d.Decided, d.Status, ApprovedJson = d.ApprovedJson, d.CreatedAt }); }
        return Results.Ok(out_);
      }
      return Results.Ok(rows);
    });

    app.MapGet("/api/records/{draftId:guid}", (InMemoryStore s, HttpRequest req, Guid draftId) =>
    {
      if (!s.Drafts.TryGetValue(draftId, out var d)) return Results.NotFound();
      if (PeopleOps.Check(s, req, d.BoardId, d.MeetingId, "read") is { } deniedRD) return deniedRD;
      var isMgrD = PeopleOps.Can(s, req, d.BoardId, null, "manage") || PeopleOps.Can(s, req, d.BoardId, d.MeetingId, "contribute");
      if (!isMgrD)
      {
        // Non-managers (incl. meeting guests): decided + approved items/content only,
        // even on direct detail reads. Pending/discarded/superseded payloads never leak.
        if (!d.Decided || string.IsNullOrWhiteSpace(d.ApprovedJson) || d.ApprovedJson.Trim() == "[]")
          return PeopleOps.Denied();
        return Results.Ok(new { d.Id, d.BoardId, d.MeetingId, d.Version, d.Decided, d.Status, ApprovedJson = d.ApprovedJson, d.CreatedAt });
      }
      return Results.Ok(d);
    });

    IResult NewVersion(InMemoryStore s, HttpRequest req, Guid draftId, JsonElement body, string[] extraSupersedes, bool amend)
    {
      if (!s.Drafts.TryGetValue(draftId, out var preOld)) return Results.NotFound();
      if (!s.Meetings.TryGetValue(preOld.MeetingId, out var preMeeting)) return Results.NotFound("meeting");
      lock (s.MessageLock)
      {
        if (!s.Drafts.TryGetValue(draftId, out var old)) return Results.NotFound();
        if (!s.Meetings.TryGetValue(old.MeetingId, out var meeting)) return Results.NotFound("meeting");
        if (PeopleOps.Check(s, req, old.BoardId, old.MeetingId, "contribute") is { } deniedNV2) return deniedNV2;
        // Distinct guards: revise continues an undecided draft; amend succeeds an approved record.
        if (!amend && old.Decided) return Results.Conflict("Draft already decided; revise the current version instead.");
        if (amend && (!old.Decided || old.Status != "approved"))
          return Results.Conflict("Only an approved record can be amended; revise the current open version instead.");
        JsonElement itemsEl;
        string items;
        if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("items", out var it))
        {
          itemsEl = it;
          if (!RecordsOps.ValidateDraftItems(itemsEl, out var itemErr))
            return Results.Json(new { error = itemErr }, statusCode: 422);
          items = it.GetRawText();
        }
        else
        {
          using var prev = JsonDocument.Parse(string.IsNullOrWhiteSpace(old.ItemsJson) ? "[]" : old.ItemsJson);
          if (!RecordsOps.ValidateDraftItems(prev.RootElement, out var prevErr))
            return Results.Json(new { error = prevErr }, statusCode: 422);
          items = old.ItemsJson;
        }
        var next = new RecordDraft
        {
          BoardId = old.BoardId, MeetingId = old.MeetingId,
          Version = old.Version + 1, Watermark = meeting.DeliveredRevision,
          ItemsJson = items, Hash = Hashing.HashOf(items),
          SupersedesJson = JsonSerializer.Serialize(
            old.Supersedes(extraSupersedes)),
        };
        IResult result = Results.Conflict("unreachable");
        Atomic.Run(() =>
        {
          if (!amend)
          {
            old.Decided = true;
            old.Status = "superseded";
          }
          s.Drafts[next.Id] = next;
          // Flush inside the atomic unit: single SaveChanges + commit once.
          s.Drafts.Flush();
          s.Audit.Add(new AuditEvent { BoardId = old.BoardId, Action = amend ? "record.amend" : "record.revise", Detail = JsonSerializer.Serialize(new { from = draftId, to = next.Id, version = next.Version }) });
          result = Results.Created($"/api/records/{next.Id}", next);
        });
        return result;
      }
    }

    app.MapPost("/api/records/{draftId:guid}/revise", (InMemoryStore s, HttpRequest req, Guid draftId, JsonElement body) =>
    {
      if (!s.Drafts.TryGetValue(draftId, out var d)) return Results.NotFound();
      if (PeopleOps.Check(s, req, d.BoardId, d.MeetingId, "contribute") is { } deniedRev) return deniedRev;
      if (d.Decided) return Results.Conflict("Draft already decided; revise the current version instead.");
      return NewVersion(s, req, draftId, body, Array.Empty<string>(), amend: false);
    });

    app.MapPost("/api/records/{draftId:guid}/amend", (InMemoryStore s, HttpRequest req, Guid draftId, JsonElement body) =>
    {
      if (!s.Drafts.TryGetValue(draftId, out var d)) return Results.NotFound();
      if (PeopleOps.Check(s, req, d.BoardId, d.MeetingId, "contribute") is { } deniedAm) return deniedAm;
      var extra = body.TryGetProperty("supersedes", out var se) && se.ValueKind == JsonValueKind.Array
        ? se.EnumerateArray().Select(e => e.GetString() ?? "").Where(x => x != "").ToArray()
        : Array.Empty<string>();
      return NewVersion(s, req, draftId, body, extra, amend: true);
    });

    app.MapPost("/api/records/{draftId:guid}/discard", (InMemoryStore s, HttpRequest req, Guid draftId) =>
    {
      if (!s.Drafts.TryGetValue(draftId, out var preD)) return Results.NotFound();
      if (PeopleOps.Check(s, req, preD.BoardId, preD.MeetingId, "contribute") is { } deniedDis) return deniedDis;
      lock (s.MessageLock)
      {
        if (!s.Drafts.TryGetValue(draftId, out var d)) return Results.NotFound();
        if (PeopleOps.Check(s, req, d.BoardId, d.MeetingId, "contribute") is { } deniedDis2) return deniedDis2;
        if (d.Decided) return Results.Conflict("Draft already decided; revise the current version instead.");
        d.Decided = true;
        d.Status = "discarded";
        s.Drafts.Flush();
        s.Audit.Add(new AuditEvent { BoardId = d.BoardId, Action = "record.discard", Detail = JsonSerializer.Serialize(new { draft = draftId }) });
        return Results.Ok(d);
      }
    });

    app.MapGet("/api/records/{draftId:guid}/export", (InMemoryStore s, HttpRequest req, Guid draftId, string format = "concise") =>
    {
      if (!s.Drafts.TryGetValue(draftId, out var d)) return Results.NotFound();
      if (PeopleOps.Check(s, req, d.BoardId, d.MeetingId, "read") is { } deniedEx) return deniedEx;
      if (string.Equals(d.Status, "discarded", StringComparison.OrdinalIgnoreCase))
        return Results.Conflict("Draft discarded; conversation preserved, nothing to export.");
      var text = RecordsOps.BuildExport(d.ItemsJson, d.ApprovedJson, format == "detailed");
      if (string.IsNullOrWhiteSpace(text)) return Results.Conflict("Nothing approved to export.");
      return Results.Text(text, "text/plain");
    });
  }

  private static List<string> Supersedes(this RecordDraft old, string[] extra)
  {
    var ids = new List<string>();
    try
    {
      using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(old.SupersedesJson) ? "[]" : old.SupersedesJson);
      ids.AddRange(doc.RootElement.EnumerateArray().Select(e => e.GetString() ?? "").Where(x => x != ""));
    }
    catch (JsonException) { }
    ids.Add(old.Id.ToString());
    ids.AddRange(extra.Except(ids));
    return ids;
  }
}
