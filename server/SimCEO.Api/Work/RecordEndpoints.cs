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
      var text = el.TryGetProperty("text", out var t) ? (t.GetString() ?? el.GetRawText()) : el.GetRawText();
      sb.AppendLine($"- [{id}] {text}");
      if (detailed)
      {
        if (el.TryGetProperty("detail", out var d) && d.GetString() is { } detail) sb.AppendLine($"  detail: {detail}");
        if (el.TryGetProperty("status", out var st) && st.GetString() is { } status) sb.AppendLine($"  status: {status}");
        if (el.TryGetProperty("scope", out var sc) && sc.GetString() is { } scope) sb.AppendLine($"  scope: {scope}");
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
      if (!PeopleOps.Can(s, req, m.BoardId, id, "read")) return PeopleOps.Denied();
      return Results.Ok(s.Drafts.Values.Where(d => d.MeetingId == id)
        .OrderByDescending(d => d.Version).Take(50));
    });

    app.MapGet("/api/records/{draftId:guid}", (InMemoryStore s, HttpRequest req, Guid draftId) =>
    {
      if (!s.Drafts.TryGetValue(draftId, out var d)) return Results.NotFound();
      if (!PeopleOps.Can(s, req, d.BoardId, d.MeetingId, "read")) return PeopleOps.Denied();
      return Results.Ok(d);
    });

    IResult NewVersion(InMemoryStore s, Guid draftId, JsonElement body, string[] extraSupersedes)
    {
      if (!s.Drafts.TryGetValue(draftId, out var old)) return Results.NotFound();
      if (!s.Meetings.TryGetValue(old.MeetingId, out var meeting)) return Results.NotFound("meeting");
      var items = body.TryGetProperty("items", out var it) ? it.GetRawText() : old.ItemsJson;
      var next = new RecordDraft
      {
        BoardId = old.BoardId, MeetingId = old.MeetingId,
        Version = old.Version + 1, Watermark = meeting.DeliveredRevision,
        ItemsJson = items, Hash = Hashing.HashOf(items),
        SupersedesJson = JsonSerializer.Serialize(
          old.Supersedes(extraSupersedes)),
      };
      old.Decided = true;
      old.Status = "superseded";
      s.Drafts[next.Id] = next;
      s.Audit.Add(new AuditEvent { BoardId = old.BoardId, Action = "record.revise", Detail = JsonSerializer.Serialize(new { from = draftId, to = next.Id, version = next.Version }) });
      return Results.Created($"/api/records/{next.Id}", next);
    }

    app.MapPost("/api/records/{draftId:guid}/revise", (InMemoryStore s, HttpRequest req, Guid draftId, JsonElement body) =>
    {
      if (!s.Drafts.TryGetValue(draftId, out var d)) return Results.NotFound();
      if (!PeopleOps.Can(s, req, d.BoardId, d.MeetingId, "contribute")) return PeopleOps.Denied();
      if (d.Decided) return Results.Conflict("Draft already decided; revise the current version instead.");
      return NewVersion(s, draftId, body, Array.Empty<string>());
    });

    app.MapPost("/api/records/{draftId:guid}/amend", (InMemoryStore s, HttpRequest req, Guid draftId, JsonElement body) =>
    {
      if (!s.Drafts.TryGetValue(draftId, out var d)) return Results.NotFound();
      if (!PeopleOps.Can(s, req, d.BoardId, d.MeetingId, "contribute")) return PeopleOps.Denied();
      var extra = body.TryGetProperty("supersedes", out var se) && se.ValueKind == JsonValueKind.Array
        ? se.EnumerateArray().Select(e => e.GetString() ?? "").Where(x => x != "").ToArray()
        : Array.Empty<string>();
      return NewVersion(s, draftId, body, extra);
    });

    app.MapPost("/api/records/{draftId:guid}/discard", (InMemoryStore s, HttpRequest req, Guid draftId) =>
    {
      if (!s.Drafts.TryGetValue(draftId, out var d)) return Results.NotFound();
      if (!PeopleOps.Can(s, req, d.BoardId, d.MeetingId, "contribute")) return PeopleOps.Denied();
      d.Decided = true;
      d.Status = "discarded";
      s.Audit.Add(new AuditEvent { BoardId = d.BoardId, Action = "record.discard", Detail = JsonSerializer.Serialize(new { draft = draftId }) });
      return Results.Ok(d);
    });

    app.MapGet("/api/records/{draftId:guid}/export", (InMemoryStore s, HttpRequest req, Guid draftId, string format = "concise") =>
    {
      if (!s.Drafts.TryGetValue(draftId, out var d)) return Results.NotFound();
      if (!PeopleOps.Can(s, req, d.BoardId, d.MeetingId, "read")) return PeopleOps.Denied();
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
