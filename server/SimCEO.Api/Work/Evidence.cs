using System.Text.Json;
using SimCEO.Api.Domain;

namespace SimCEO.Api.Work;

// Shared evidence reference: one JSON shape reused by advisor dossiers,
// briefing/direction notes, and record items. Minimum-compatible by design:
// every field besides kind+ref is optional, producers attach refs additively,
// and consumers ignore unknown kinds instead of failing.
//
// JSON shape (camelCase over the wire):
//   { kind, ref, version?, url?, title?, excerpt? }
// kind is one of: source | record | message | dossier | direction | note
// ref carries the target identity:
//   source    -> SourceDoc id (version = SourceDoc.Version)
//   record    -> RecordDraft id (version = RecordDraft.Version)
//   message   -> meeting id + ":" + sequence, e.g. "<guid>:12"
//   dossier   -> RosterEntry id
//   direction -> Note id | note -> Note id
public sealed record EvidenceRef(
  string Kind, string Ref, int? Version, string? Url, string? Title, string? Excerpt)
{
  public static readonly HashSet<string> Kinds = new(StringComparer.OrdinalIgnoreCase)
    { "source", "record", "message", "dossier", "direction", "note" };

  public static bool ValidKind(string? kind) =>
    !string.IsNullOrWhiteSpace(kind) && Kinds.Contains(kind.Trim());

  public static EvidenceRef? Parse(JsonElement el)
  {
    if (el.ValueKind != JsonValueKind.Object) return null;
    var kind = (el.TryGetProperty("kind", out var k) && k.ValueKind == JsonValueKind.String) ? (k.GetString() ?? "") : "";
    var rf = (el.TryGetProperty("ref", out var r) && r.ValueKind == JsonValueKind.String) ? (r.GetString() ?? "")
      : (el.TryGetProperty("id", out var i) && i.ValueKind == JsonValueKind.String) ? (i.GetString() ?? "") : "";
    if (!ValidKind(kind) || string.IsNullOrWhiteSpace(rf)) return null;
    int? version = null;
    if (el.TryGetProperty("version", out var v))
    {
      if (v.ValueKind == JsonValueKind.Null) version = null;
      else if (v.ValueKind != JsonValueKind.Number || !v.TryGetInt32(out var vi) || vi < 0) return null;
      else version = vi;
    }
    return new EvidenceRef(kind.Trim().ToLowerInvariant(), rf.Trim(), version,
      (el.TryGetProperty("url", out var u) && u.ValueKind == JsonValueKind.String) ? u.GetString() : null,
      (el.TryGetProperty("title", out var t) && t.ValueKind == JsonValueKind.String) ? t.GetString() : null,
      (el.TryGetProperty("excerpt", out var e) && e.ValueKind == JsonValueKind.String) ? e.GetString() : null);
  }

  public static List<EvidenceRef> ParseList(JsonElement el, string prop)
  {
    var list = new List<EvidenceRef>();
    if (el.ValueKind == JsonValueKind.Object
        && el.TryGetProperty(prop, out var arr) && arr.ValueKind == JsonValueKind.Array)
      foreach (var item in arr.EnumerateArray())
        if (Parse(item) is { } r) list.Add(r);
    return list;
  }

  public static string ToJsonList(IEnumerable<EvidenceRef> refs)
  {
    var opts = new JsonSerializerOptions(JsonSerializerDefaults.Web);
    return JsonSerializer.Serialize(refs.Select(r => new
    {
      kind = r.Kind, @ref = r.Ref, version = r.Version,
      url = r.Url, title = r.Title, excerpt = r.Excerpt,
    }), opts);
  }

  public static EvidenceRef ForSource(SourceDoc d, string? excerpt = null) =>
    new("source", d.Id.ToString(), d.Version, null, d.FileName, excerpt);

  public static EvidenceRef ForRecord(RecordDraft d) =>
    new("record", d.Id.ToString(), d.Version, null, "record v" + d.Version, null);

  // Exact owner provenance: the approving record+version that last set this
  // item, never the unapproved head that merely inherits its text.
  public static EvidenceRef ForRecordItem(string recordId, int version, string itemId, string? excerpt = null) =>
    new("record", recordId, version, null, "record v" + version + " [" + itemId + "]", excerpt);

  public static EvidenceRef ForNote(Note n) =>
    new(n.Kind == "direction" ? "direction" : "note", n.Id.ToString(),
      null, null, n.Title, n.Body.Length > 240 ? n.Body.Substring(0, 240) : n.Body);

  public static EvidenceRef ForDossier(RosterEntry e) =>
    new("dossier", e.Id.ToString(), e.Version, null, e.Name, null);
}
