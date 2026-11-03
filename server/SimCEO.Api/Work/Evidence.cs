using System.Text.Json;
using SimCEO.Api.Domain;

namespace SimCEO.Api.Work;

// Shared evidence reference: one JSON shape reused by advisor dossiers,
// briefing/direction notes, and record items. Minimum-compatible by design:
// every field besides kind+ref is optional, producers attach refs additively,
// and consumers ignore unknown kinds instead of failing.
//
// JSON shape (camelCase over the wire):
//   { kind, ref, version?, url?, title?, excerpt?, sectionId?, location?, indexGeneration?, contentHash? }
// kind is one of: source | record | message | dossier | direction | note
// ref carries the target identity:
//   source    -> SourceDoc id (version = SourceDoc.Version)
//   record    -> RecordDraft id (version = RecordDraft.Version)
//   message   -> meeting id + ":" + sequence, e.g. "<guid>:12"
//   dossier   -> RosterEntry id
//   direction -> Note id | note -> Note id
// sectionId/location/indexGeneration/contentHash carry exact section provenance
// for source refs. Old rows without them remain readable; new rows must carry
// them. Consumers never substitute current text for old versions.
public sealed record EvidenceRef(
  string Kind, string Ref, int? Version, string? Url, string? Title, string? Excerpt,
  string? SectionId = null, string? Location = null, int? IndexGeneration = null, string? ContentHash = null)
{
  public static readonly HashSet<string> Kinds = new(StringComparer.OrdinalIgnoreCase)
    { "source", "record", "message", "dossier", "direction", "note" };

  public static bool ValidKind(string? kind) =>
    !string.IsNullOrWhiteSpace(kind) && Kinds.Contains(kind.Trim());

  static string? SafeStr(JsonElement el, string name)
  {
    try
    {
      if (el.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String) return v.GetString();
      return null;
    }
    catch { return null; }
  }
  static int? SafeInt(JsonElement el, string name)
  {
    try
    {
      if (el.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var n)) return n;
      return null;
    }
    catch { return null; }
  }
  public static EvidenceRef? Parse(JsonElement el)
  {
    if (el.ValueKind != JsonValueKind.Object) return null;
    var kind = SafeStr(el, "kind") ?? "";
    var rf = SafeStr(el, "ref") ?? SafeStr(el, "id") ?? "";
    if (!ValidKind(kind) || string.IsNullOrWhiteSpace(rf)) return null;
    // Strict version gate (Records R4/R6): null or positive integer only, matching the
    // snapshot parser. Zero/fractional/negative versions invalidate the whole ref (never defaulted).
    int? version = null;
    if (el.TryGetProperty("version", out var v))
    {
      if (v.ValueKind == JsonValueKind.Null) version = null;
      else if (v.ValueKind != JsonValueKind.Number || !v.TryGetInt32(out var vi) || vi < 1) return null;
      else version = vi;
    }
    // Exact section provenance for source refs; old rows without them stay readable.
    string? sec = SafeStr(el, "sectionId");
    string? loc = SafeStr(el, "location");
    int? ig = SafeInt(el, "indexGeneration");
    string? ch = SafeStr(el, "contentHash");
    return new EvidenceRef(kind.Trim().ToLowerInvariant(), rf.Trim(), version,
      SafeStr(el, "url"),
      SafeStr(el, "title"),
      SafeStr(el, "excerpt"),
      string.IsNullOrWhiteSpace(sec) ? null : sec!.Trim(),
      string.IsNullOrWhiteSpace(loc) ? null : loc,
      ig, string.IsNullOrWhiteSpace(ch) ? null : ch);
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

  public static List<EvidenceRef> ParseJsonList(string json)
  {
    try
    {
      using var d = JsonDocument.Parse(string.IsNullOrWhiteSpace(json) ? "[]" : json);
      var list = new List<EvidenceRef>();
      if (d.RootElement.ValueKind == JsonValueKind.Array)
        foreach (var item in d.RootElement.EnumerateArray())
          if (Parse(item) is { } r) list.Add(r);
      return list;
    }
    catch { return new List<EvidenceRef>(); }
  }

  public static string ToJsonList(IEnumerable<EvidenceRef> refs)
  {
    var opts = new JsonSerializerOptions(JsonSerializerDefaults.Web);
    return JsonSerializer.Serialize(refs.Select(r => new
    {
      kind = r.Kind, @ref = r.Ref, version = r.Version,
      url = r.Url, title = r.Title, excerpt = r.Excerpt,
      sectionId = r.SectionId, location = r.Location,
      indexGeneration = r.IndexGeneration, contentHash = r.ContentHash,
    }), opts);
  }

  // Exact-substring excerpt: never append markers. Caller must pass a true
  // substring of the stored section text; truncation keeps a prefix verbatim.
  public static string ExactExcerpt(string text, int max)
  {
    if (string.IsNullOrEmpty(text)) return "";
    if (text.Length <= max) return text;
    return text.Substring(0, max);
  }

  public static EvidenceRef ForSource(SourceDoc d, string? excerpt = null) =>
    new("source", d.Id.ToString(), d.Version, null, d.FileName, excerpt);

  public static EvidenceRef ForSection(SourceDoc d, SourceSection sec, int maxExcerpt = 240)
  {
    var ex = ExactExcerpt(sec.Text ?? "", maxExcerpt);
    return new EvidenceRef("source", d.Id.ToString(), d.Version, null, d.FileName, ex,
      sec.Id.ToString(), sec.Location ?? "", sec.IndexGeneration, sec.ContentHash ?? d.ContentHash ?? "");
  }



  // Exact owner provenance: the approving record+version that last set this
  // item, never the unapproved head that merely inherits its text.
  public static EvidenceRef ForRecordItem(string recordId, int version, string itemId, string? excerpt = null) =>
    new("record", recordId, version, null, "record v" + version + " [" + itemId + "]", excerpt);

  public static EvidenceRef ForRecord(RecordDraft d, string? exactExport = null) =>
    new("record", d.Id.ToString(), d.Version, null, "record v" + d.Version, exactExport);

  public static EvidenceRef ForNote(Note n)
  {
    var body = n.Body ?? "";
    var ex = body.Length > 240 ? body.Substring(0, 240) : body;
    return new(n.Kind == "direction" ? "direction" : "note", n.Id.ToString(),
      null, null, n.Title, ex);
  }

  public static EvidenceRef ForNoteFull(Note n) =>
    new(n.Kind == "direction" ? "direction" : "note", n.Id.ToString(),
      null, null, n.Title, n.Body ?? "");

  public static EvidenceRef ForDossier(RosterEntry e) =>
    new("dossier", e.Id.ToString(), e.Version, null, e.Name, null);
}
