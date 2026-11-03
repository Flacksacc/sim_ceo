using System.Text;
using System.Text.Json;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;
using SimCEO.Api.Work;

namespace SimCEO.Api;

public static partial class RecordsOps
{
  public static bool ValidateDraftItems(JsonElement items, out string error)
  {
    error = "";
    if (items.ValueKind != JsonValueKind.Array) { error = "Draft items must be a JSON array."; return false; }
    var seen = new HashSet<string>(StringComparer.Ordinal);
    var idx = 0;
    foreach (var el in items.EnumerateArray())
    {
      if (el.ValueKind != JsonValueKind.Object) { error = "Draft item " + idx + " must be an object."; return false; }
      var id = el.TryGetProperty("id", out var iv) && iv.ValueKind == JsonValueKind.String ? (iv.GetString() ?? "") : "";
      if (string.IsNullOrWhiteSpace(id)) { error = "Draft item " + idx + " must carry a non-empty string id."; return false; }
      if (id != id.Trim()) { error = "Draft item id must not have leading or trailing whitespace."; return false; }
      var hasText = el.TryGetProperty("text", out var tv) && tv.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(tv.GetString());
      if (!hasText) { error = "Draft item '" + id + "' must carry non-empty string text."; return false; }
      if ((tv.GetString() ?? "").Length > 8000) { error = "Draft item '" + id + "' text exceeds 8000 characters."; return false; }
      if (!seen.Add(id)) { error = "Duplicate draft item id '" + id + "'."; return false; }
      foreach (var opt in new[] { "detail", "status", "scope" })
      {
        if (el.TryGetProperty(opt, out var ov))
        {
          if (ov.ValueKind != JsonValueKind.String) { error = "Draft item '" + id + "' field '" + opt + "' must be a string."; return false; }
          if ((ov.GetString() ?? "").Length > 8000) { error = "Draft item '" + id + "' field '" + opt + "' exceeds 8000 characters."; return false; }
        }
      }
      if (el.TryGetProperty("refs", out var refs))
      {
        if (refs.ValueKind != JsonValueKind.Array) { error = "Draft item '" + id + "' refs must be an array."; return false; }
        var seenRefs = new Dictionary<string, string?>(StringComparer.Ordinal);
        foreach (var r in refs.EnumerateArray())
        {
          if (r.ValueKind != JsonValueKind.Object) { error = "Draft item '" + id + "' ref must be an object."; return false; }
          var parsedRef = EvidenceRef.Parse(r);
          if (parsedRef is null) { error = "Draft item '" + id + "' carries an invalid evidence ref."; return false; }
          foreach (var meta in new[] { "url", "title", "excerpt" })
          {
            if (r.TryGetProperty(meta, out var mv) && mv.ValueKind != JsonValueKind.String && mv.ValueKind != JsonValueKind.Null)
            { error = "Draft item '" + id + "' ref field '" + meta + "' must be a string."; return false; }
          }
          // Ambiguous duplicate targets (same kind+ref, different requested
          // versions) are rejected before publication: snapshot identity and
          // resolution must never depend on ref order.
          var rkey = parsedRef.Kind.ToLowerInvariant() + "\u0001" + parsedRef.Ref;
          var rver = parsedRef.Version?.ToString();
          if (seenRefs.TryGetValue(rkey, out var prior))
          {
            if (!string.Equals(prior, rver, StringComparison.Ordinal))
            { error = "Draft item '" + id + "' has ambiguous duplicate evidence refs for '" + parsedRef.Kind + ":" + parsedRef.Ref + "' with different versions; pin one version."; return false; }
          }
          else seenRefs[rkey] = rver;
        }
      }
      idx++;
    }
    return true;
  }

  public static string BuildExport(string itemsJson, string approvedJson, bool detailed)
  {
    JsonDocument items; JsonDocument approved;
    try
    {
      items = JsonDocument.Parse(string.IsNullOrWhiteSpace(itemsJson) ? "[]" : itemsJson);
      approved = JsonDocument.Parse(string.IsNullOrWhiteSpace(approvedJson) ? "[]" : approvedJson);
    }
    catch (JsonException) { return ""; }
    using (items) using (approved)
    {
    if (items.RootElement.ValueKind != JsonValueKind.Array || approved.RootElement.ValueKind != JsonValueKind.Array) return "";
    var ok = new HashSet<string>(approved.RootElement.EnumerateArray().Select(e => e.GetString() ?? ""), StringComparer.Ordinal);
    var sb = new StringBuilder();
    foreach (var el in items.RootElement.EnumerateArray())
    {
      if (el.ValueKind != JsonValueKind.Object) continue;
      var id = el.TryGetProperty("id", out var i) ? (i.GetString() ?? "") : "";
      if (!ok.Contains(id)) continue;
      var text = el.TryGetProperty("text", out var t) && t.ValueKind == JsonValueKind.String ? (t.GetString() ?? "") : "";
      sb.AppendLine("- [" + id + "] " + text);
      if (detailed)
      {
        if (el.TryGetProperty("detail", out var d) && d.ValueKind == JsonValueKind.String && d.GetString() is { } detail) sb.AppendLine("  detail: " + detail);
        if (el.TryGetProperty("status", out var st) && st.ValueKind == JsonValueKind.String && st.GetString() is { } status) sb.AppendLine("  status: " + status);
        if (el.TryGetProperty("scope", out var sc) && sc.ValueKind == JsonValueKind.String && sc.GetString() is { } scope) sb.AppendLine("  scope: " + scope);
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

  public static List<string> ParseIdList(string json)
  {
    var outList = new List<string>();
    try
    {
      using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(json) ? "[]" : json);
      if (doc.RootElement.ValueKind != JsonValueKind.Array) return outList;
      foreach (var e in doc.RootElement.EnumerateArray())
        if (e.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(e.GetString()))
          outList.Add(e.GetString()!);
    }
    catch (JsonException) { }
    return outList;
  }

  public static bool TryStrictIdList(string json, out List<string> ids, out string error)
  {
    ids = new List<string>(); error = "";
    JsonDocument doc;
    try { doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(json) ? "[]" : json); }
    catch (JsonException) { error = "not a JSON array."; return false; }
    using (doc)
    {
      if (doc.RootElement.ValueKind != JsonValueKind.Array) { error = "not a JSON array."; return false; }
      foreach (var e in doc.RootElement.EnumerateArray())
      {
        if (e.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(e.GetString())) { error = "entries must be non-empty strings."; return false; }
        ids.Add(e.GetString()!);
      }
    }
    if (ids.Distinct(StringComparer.Ordinal).Count() != ids.Count) { error = "duplicate entries."; return false; }
    return true;
  }

  public static bool IsReadableItems(string itemsJson)
  {
    try
    {
      using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(itemsJson) ? "[]" : itemsJson);
      return doc.RootElement.ValueKind == JsonValueKind.Array;
    }
    catch (JsonException) { return false; }
  }

  public static string ToIdList(IEnumerable<string> ids)
  {
    return JsonSerializer.Serialize(ids.ToList());
  }

  // Response projection: every draft response DTO omits EvidenceSnapshotJson.
  // Snapshot bytes are internal decision facts, never a disclosure grant.
  public static Dictionary<string, object?> SafeDraft(RecordDraft d)
  {
    return new Dictionary<string, object?>
    {
      ["id"] = d.Id, ["boardId"] = d.BoardId, ["meetingId"] = d.MeetingId,
      ["version"] = d.Version, ["watermark"] = d.Watermark, ["itemsJson"] = d.ItemsJson,
      ["hash"] = d.Hash, ["approvedJson"] = d.ApprovedJson, ["discardedJson"] = d.DiscardedJson,
      ["reviewRevision"] = d.ReviewRevision, ["reviewToken"] = d.ReviewToken,
      ["historyJson"] = d.HistoryJson, ["supersedesJson"] = d.SupersedesJson,
      ["decided"] = d.Decided, ["status"] = d.Status, ["createdAt"] = d.CreatedAt,
    };
  }  public static Dictionary<string, JsonElement> ItemMap(string itemsJson, out string error)
  {
    error = "";
    var map = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
    JsonDocument doc;
    try { doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(itemsJson) ? "[]" : itemsJson); }
    catch (JsonException) { error = "Draft items unreadable; revise instead."; return map; }
    using (doc)
    {
      if (doc.RootElement.ValueKind != JsonValueKind.Array) { error = "Draft items unreadable; revise instead."; return map; }
      if (!ValidateDraftItems(doc.RootElement, out error)) { map.Clear(); return map; }
      foreach (var el in doc.RootElement.EnumerateArray())
      {
        var id = el.TryGetProperty("id", out var iv) ? (iv.GetString() ?? "") : "";
        map[id] = el.Clone();
      }
    }
    return map;
  }

  public static List<string> PendingIds(RecordDraft d)
  {
    var map = ItemMap(d.ItemsJson, out _);
    var ap = new HashSet<string>(ParseIdList(d.ApprovedJson), StringComparer.Ordinal);
    var dc = new HashSet<string>(ParseIdList(d.DiscardedJson), StringComparer.Ordinal);
    return map.Keys.Where(k => !ap.Contains(k) && !dc.Contains(k)).OrderBy(k => k, StringComparer.Ordinal).ToList();
  }

  public static string ComputeStatus(int approved, int discarded, int pending, bool superseded)
  {
    if (superseded) return "superseded";
    if (pending > 0 && approved > 0) return "partially-approved";
    if (pending > 0 && approved == 0 && discarded > 0) return "open";
    if (pending > 0) return "open";
    if (approved > 0) return "approved";
    return "discarded";
  }

  public static void RefreshDecided(RecordDraft d)
  {
    var ap = ParseIdList(d.ApprovedJson).Count;
    var dc = ParseIdList(d.DiscardedJson).Count;
    var pe = PendingIds(d).Count;
    if (string.Equals(d.Status, "superseded", StringComparison.OrdinalIgnoreCase)) { d.Decided = true; return; }
    d.Status = ComputeStatus(ap, dc, pe, false);
    d.Decided = pe == 0 && (ap > 0 || dc > 0);
  }

  public static string NewReviewToken()
  {
    return Hashing.HashOf(Guid.NewGuid().ToString("N") + DateTime.UtcNow.Ticks);
  }

  public static string LegacyReviewToken(Guid id, int version, string hash)
  {
    return Hashing.HashOf("legacy-review:" + id.ToString("N") + ":" + version + ":" + (hash ?? ""));
  }

  public static int HistoryCount(string historyJson)
  {
    try
    {
      using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(historyJson) ? "[]" : historyJson);
      return doc.RootElement.ValueKind == JsonValueKind.Array ? doc.RootElement.GetArrayLength() : 0;
    }
    catch (JsonException) { return 0; }
  }

  public static void AppendHistory(RecordDraft d, string action, string? itemId, string? oldText, string? newText, string actor)
  {
    TryAppendHistory(d, action, itemId, oldText, newText, actor, d.Version, d.Hash, d.Watermark, d.ReviewToken, out _);
  }

  // Pure history builder for staged mutations: validates and renders the new
  // history JSON WITHOUT touching the draft, so validation failures and
  // render errors leave no partial record changes.
  public static bool TryBuildHistoryJson(string historyJson, string action, string? itemId, string? oldText, string? newText, string actor,
    int viewedVersion, string viewedHash, long viewedWatermark, string viewedToken,
    int resultingRevision, string resultingToken, out string nextJson, out string error)
  {
    error = ""; nextJson = historyJson;
    List<JsonElement> existing;
    try
    {
      using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(historyJson) ? "[]" : historyJson);
      if (doc.RootElement.ValueKind != JsonValueKind.Array) { error = "Decision history is malformed; explicit repair required."; return false; }
      existing = doc.RootElement.EnumerateArray().Select(e => e.Clone()).ToList();
    }
    catch (JsonException) { error = "Decision history is malformed; explicit repair required."; return false; }
    foreach (var he in existing)
      if (!TryParseHistoryEntry(he, out var heerr)) { error = heerr; return false; }
    var entry = new
    {
      seq = existing.Count + 1,
      at = DateTime.UtcNow,
      actor = string.IsNullOrWhiteSpace(actor) ? "owner" : actor,
      action,
      itemId = itemId ?? "",
      oldText = oldText ?? "",
      newText = newText ?? "",
      viewedVersion,
      viewedHash = viewedHash ?? "",
      viewedWatermark,
      viewedToken = viewedToken ?? "",
      revision = resultingRevision,
      token = resultingToken ?? "",
    };
    using var edoc = JsonDocument.Parse(JsonSerializer.Serialize(entry));
    existing.Add(edoc.RootElement.Clone());
    nextJson = JsonSerializer.Serialize(existing);
    return true;
  }

  public static bool TryParseHistoryEntry(JsonElement e, out string error)
  {
    error = "";
    if (e.ValueKind != JsonValueKind.Object) { error = "Decision history entries must be objects."; return false; }
    if (!e.TryGetProperty("action", out var a) || a.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(a.GetString()))
    { error = "Decision history entries must carry a non-empty string action."; return false; }
    foreach (var name in new[] { "itemId", "oldText", "newText", "actor", "viewedHash", "viewedToken", "token", "at" })
      if (e.TryGetProperty(name, out var s) && s.ValueKind != JsonValueKind.String)
      { error = "Decision history field '" + name + "' must be a string."; return false; }
    // Sequence numbers are integral and start at 1; revisions/viewed counters
    // must be integral (fractional or negative counters are never written by
    // the builders, so their presence proves foreign or corrupt state).
    // Builders always emit seq, revision and token: their absence proves foreign rows.
    if (!e.TryGetProperty("seq", out var sq) || sq.ValueKind != JsonValueKind.Number || !sq.TryGetInt32(out var si) || si < 1)
    { error = "Decision history field 'seq' must be a positive integer."; return false; }
    if (!e.TryGetProperty("revision", out var rv) || rv.ValueKind != JsonValueKind.Number || !rv.TryGetInt32(out var ri) || ri < 1)
    { error = "Decision history field 'revision' must be a positive integer."; return false; }
    if (!e.TryGetProperty("token", out var tk) || tk.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(tk.GetString()))
    { error = "Decision history entries must carry a non-empty string token."; return false; }
    foreach (var name in new[] { "viewedVersion", "viewedWatermark", "revision" })
    {
      if (e.TryGetProperty(name, out var n))
      {
        if (n.ValueKind != JsonValueKind.Number || !n.TryGetInt64(out var ni))
        { error = "Decision history field '" + name + "' must be an integer."; return false; }
        if (ni < 0)
        { error = "Decision history field '" + name + "' must not be negative."; return false; }
      }
    }
    return true;
  }

  public static bool TryAppendHistory(RecordDraft d, string action, string? itemId, string? oldText, string? newText, string actor,
    int viewedVersion, string viewedHash, long viewedWatermark, string viewedToken, out string error)
  {
    if (!TryBuildHistoryJson(d.HistoryJson, action, itemId, oldText, newText, actor,
      viewedVersion, viewedHash, viewedWatermark, viewedToken, d.ReviewRevision, d.ReviewToken, out var next, out error))
      return false;
    d.HistoryJson = next;
    return true;
  }

  // Fail-closed persisted-state gate for every mutation. Blank state is
  // invalid outside the boot-time compatibility initializer; malformed
  // arrays AND structurally invalid entries reject with a controlled 4xx.
  // Reads stay lenient and never reset this state.
  public static bool StrictStateCheck(InMemoryStore s, RecordDraft d, out string error)
  {
    error = "";
    if (string.IsNullOrWhiteSpace(d.ItemsJson)) { error = "Draft items are blank; explicit repair required."; return false; }
    var map = ItemMap(d.ItemsJson, out var mapErr);
    if (mapErr != "") { error = mapErr; return false; }
    if (string.IsNullOrWhiteSpace(d.ApprovedJson)) { error = "Approved state is blank; explicit repair required."; return false; }
    if (string.IsNullOrWhiteSpace(d.DiscardedJson)) { error = "Discarded state is blank; explicit repair required."; return false; }
    if (!TryStrictIdList(d.ApprovedJson, out var ap, out var ae)) { error = "Approved state malformed (" + ae + "); explicit repair required."; return false; }
    if (!TryStrictIdList(d.DiscardedJson, out var dc, out var de)) { error = "Discarded state malformed (" + de + "); explicit repair required."; return false; }
    foreach (var id in ap)
      if (!map.ContainsKey(id)) { error = "Approved id '" + id + "' has no draft item; explicit repair required."; return false; }
    foreach (var id in dc)
      if (!map.ContainsKey(id)) { error = "Discarded id '" + id + "' has no draft item; explicit repair required."; return false; }
    if (ap.Any(id => dc.Contains(id, StringComparer.Ordinal))) { error = "Decision state overlaps; explicit repair required."; return false; }
    if (string.IsNullOrWhiteSpace(d.HistoryJson)) { error = "Decision history is blank; explicit repair required."; return false; }
    if (!StrictHistoryEntries(d.HistoryJson, out var herr)) { error = herr; return false; }
    if (string.IsNullOrWhiteSpace(d.SupersedesJson)) { error = "Supersedes state is blank; explicit repair required."; return false; }
    if (!StrictSupersedesEntries(d.SupersedesJson, d.Id, out var serr)) { error = serr; return false; }
    try
    {
      // Cycle probe WITHOUT seeding self: ClosureIds always contains the root,
      // so removing it first would make the check vacuously true. A cycle exists
      // only if following supersedes links returns to this record.
      var seenCyc = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
      var qcyc = new Queue<string>(SupersededIdSet(d));
      var cyclic = false;
      while (qcyc.Count > 0 && !cyclic)
      {
        var xid = qcyc.Dequeue();
        if (string.Equals(xid, d.Id.ToString(), StringComparison.OrdinalIgnoreCase)) { cyclic = true; break; }
        if (!seenCyc.Add(xid)) continue;
        if (Guid.TryParse(xid, out var xg) && s.Drafts.TryGetValue(xg, out var xdd) && xdd is not null)
          foreach (var xp in SupersededIdSet(xdd)) qcyc.Enqueue(xp);
      }
      if (cyclic) { error = "Supersedes chain is cyclic; explicit repair required."; return false; }
    }
    catch { error = "Supersedes chain unreadable; explicit repair required."; return false; }
    if (string.IsNullOrWhiteSpace(d.EvidenceSnapshotJson)) { error = "Evidence snapshot state is blank; explicit repair required."; return false; }
    if (!StrictSnapshotEntries(d.EvidenceSnapshotJson, out var eerr)) { error = eerr; return false; }
    if (string.IsNullOrWhiteSpace(d.ReviewToken)) { error = "Review state uninitialized; explicit repair required."; return false; }
    // Revision relationship: a non-empty history must end at the drafts current
    // revision/token. A foreign or rolled-back history that no longer matches the
    // row it is attached to fails closed instead of approving under stale guards.
    try
    {
      using var hdoc = JsonDocument.Parse(string.IsNullOrWhiteSpace(d.HistoryJson) ? "[]" : d.HistoryJson);
      if (hdoc.RootElement.ValueKind == JsonValueKind.Array && hdoc.RootElement.GetArrayLength() > 0)
      {
        var last = hdoc.RootElement.EnumerateArray().Last();
        var lrev = last.TryGetProperty("revision", out var lrv) && lrv.ValueKind == JsonValueKind.Number && lrv.TryGetInt32(out var lriv) ? lriv : -1;
        var ltok = last.TryGetProperty("token", out var ltk) && ltk.ValueKind == JsonValueKind.String ? (ltk.GetString() ?? "") : "";
        if (lrev != d.ReviewRevision || !string.Equals(ltok, d.ReviewToken, StringComparison.Ordinal))
        { error = "Decision history is detached from the current review state; explicit repair required."; return false; }
      }
    }
    catch (JsonException) { error = "Decision history is malformed; explicit repair required."; return false; }
    return true;
  }

  public static bool StrictHistoryEntries(string historyJson, out string error)
  {
    error = "";
    try
    {
      using var h = JsonDocument.Parse(historyJson);
      if (h.RootElement.ValueKind != JsonValueKind.Array) { error = "Decision history is malformed; explicit repair required."; return false; }
      var lastSeq = 0;
      foreach (var e in h.RootElement.EnumerateArray())
      {
        if (!TryParseHistoryEntry(e, out var eerr)) { error = eerr; return false; }
        if (e.TryGetProperty("seq", out var sq) && sq.ValueKind == JsonValueKind.Number && sq.TryGetInt32(out var si))
        {
          if (si != lastSeq + 1) { error = "Decision history sequence must ascend without gaps; explicit repair required."; return false; }
          lastSeq = si;
        }
      }
    }
    catch (JsonException) { error = "Decision history is malformed; explicit repair required."; return false; }
    return true;
  }

  public static bool StrictSupersedesEntries(string supersedesJson, Guid selfId, out string error)
  {
    error = "";
    try
    {
      using var s = JsonDocument.Parse(supersedesJson);
      if (s.RootElement.ValueKind != JsonValueKind.Array) { error = "Supersedes state is malformed; explicit repair required."; return false; }
      var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
      foreach (var e in s.RootElement.EnumerateArray())
      {
        if (e.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(e.GetString()) || !Guid.TryParse(e.GetString(), out var g))
        { error = "Supersedes entries must be record ids; explicit repair required."; return false; }
        var key = g.ToString();
        if (string.Equals(key, selfId.ToString(), StringComparison.OrdinalIgnoreCase))
        { error = "Supersedes chain must not reference its own record; explicit repair required."; return false; }
        if (!seen.Add(key))
        { error = "Supersedes entries must not repeat a record; explicit repair required."; return false; }
      }
    }
    catch (JsonException) { error = "Supersedes state is malformed; explicit repair required."; return false; }
    return true;
  }

  public static bool StrictSnapshotEntries(string snapshotJson, out string error)
  {
    error = "";
    try
    {
      using var e = JsonDocument.Parse(snapshotJson);
      if (e.RootElement.ValueKind != JsonValueKind.Array) { error = "Evidence snapshot state is malformed; explicit repair required."; return false; }
      foreach (var en in e.RootElement.EnumerateArray())
        if (!TryParseSnapshotEntry(en, out _, out var eerr)) { error = eerr; return false; }
    }
    catch (JsonException) { error = "Evidence snapshot state is malformed; explicit repair required."; return false; }
    return true;
  }  public static HashSet<string> SupersededIdSet(RecordDraft d)
  {
    var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    try
    {
      using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(d.SupersedesJson) ? "[]" : d.SupersedesJson);
      if (doc.RootElement.ValueKind == JsonValueKind.Array)
        foreach (var e in doc.RootElement.EnumerateArray())
          if (e.ValueKind == JsonValueKind.String && Guid.TryParse(e.GetString(), out var g)) set.Add(g.ToString());
    }
    catch (JsonException) { }
    return set;
  }

  public static List<RecordDraft> CurrentApproved(IEnumerable<RecordDraft> all)
  {
    var cands = all.Where(d =>
      (string.Equals(d.Status, "approved", StringComparison.OrdinalIgnoreCase)
        || string.Equals(d.Status, "partially-approved", StringComparison.OrdinalIgnoreCase))
      && !string.Equals(d.Status, "superseded", StringComparison.OrdinalIgnoreCase)
      && ParseIdList(d.ApprovedJson).Count > 0).ToList();
    if (cands.Count <= 1) return cands;
    var covered = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    foreach (var c in cands)
      foreach (var s in SupersededIdSet(c)) covered.Add(s);
    var kept = cands.Where(c => !covered.Contains(c.Id.ToString())).ToList();
    return kept.Count > 0 ? kept : cands;
  }

  public static string ItemText(JsonElement item)
  {
    return item.TryGetProperty("text", out var t) && t.ValueKind == JsonValueKind.String ? (t.GetString() ?? "") : "";
  }

  private static HashSet<string> ClosureIds(InMemoryStore s, RecordDraft head)
  {
    var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { head.Id.ToString() };
    var q = new Queue<string>(SupersededIdSet(head));
    while (q.Count > 0)
    {
      var id = q.Dequeue();
      if (!seen.Add(id)) continue;
      if (Guid.TryParse(id, out var g) && s.Drafts.TryGetValue(g, out var dd) && dd is not null)
        foreach (var p in SupersededIdSet(dd)) q.Enqueue(p);
    }
    return seen;
  }

  public sealed record EffectiveOwner(string RecordId, int Version);
  public sealed record EffectiveView(RecordDraft Head, List<string> ChainIds, List<string> EffectiveIds, string ConciseExport, Dictionary<string, string> EffectiveTexts, Dictionary<string, EffectiveOwner> EffectiveOwners, List<string> CoveredIds);

  static bool HasApprovals(RecordDraft d)
  {
    try
    {
      using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(d.ApprovedJson) ? "[]" : d.ApprovedJson);
      return doc.RootElement.ValueKind == JsonValueKind.Array && doc.RootElement.GetArrayLength() > 0;
    }
    catch (JsonException) { return false; }
  }

  static bool IsTerminal(RecordDraft d) =>
    string.Equals(d.Status, "discarded", StringComparison.OrdinalIgnoreCase)
    || string.Equals(d.Status, "superseded", StringComparison.OrdinalIgnoreCase);

  public static List<EffectiveView> EffectiveChains(IEnumerable<RecordDraft> all)
  {
    var byId = new Dictionary<string, RecordDraft>(StringComparer.OrdinalIgnoreCase);
    foreach (var d in all) byId[d.Id.ToString()] = d;
    // Authority coverage: only APPROVED successors retire an ancestor. Pending
    // or discarded proposals retire nothing and never become authoritative.
    var coveredByApproved = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    foreach (var d in byId.Values)
    {
      if (!HasApprovals(d)) continue;
      foreach (var s in SupersededIdSet(d)) coveredByApproved.Add(s);
    }
    // Authoritative heads: approved content, not terminal, not superseded by
    // another approved draft. Pending/discarded drafts are never heads.
    var heads = byId.Values
      .Where(d => HasApprovals(d) && !IsTerminal(d) && !coveredByApproved.Contains(d.Id.ToString()))
      .OrderBy(d => d.Version).ThenBy(d => d.CreatedAt).ToList();
    var views = new List<EffectiveView>();
    foreach (var head in heads)
    {
      // Ancestor closure of the authority (approved lineage only for effect).
      var ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { head.Id.ToString() };
      var q = new Queue<string>(SupersededIdSet(head));
      while (q.Count > 0)
      {
        var id = q.Dequeue();
        if (!ids.Add(id)) continue;
        if (byId.TryGetValue(id, out var dd))
          foreach (var pp in SupersededIdSet(dd)) q.Enqueue(pp);
      }
      // Family membership: every draft in this board+meeting whose closure
      // reaches the authority (pending/discarded descendants included), so a
      // pending amendment still resolves its inherited approved context.
      var covers = new HashSet<string>(ids, StringComparer.OrdinalIgnoreCase);
      foreach (var d in byId.Values)
      {
        if (covers.Contains(d.Id.ToString())) continue;
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var qq = new Queue<string>(SupersededIdSet(d));
        var reaches = false;
        while (qq.Count > 0 && !reaches)
        {
          var x = qq.Dequeue();
          if (!seen.Add(x)) continue;
          if (ids.Contains(x)) { reaches = true; break; }
          if (byId.TryGetValue(x, out var dx))
            foreach (var pp in SupersededIdSet(dx)) qq.Enqueue(pp);
        }
        if (reaches) covers.Add(d.Id.ToString());
      }
      var lineage = ids
        .Select(id => byId.TryGetValue(id, out var dd) ? dd : null)
        .Where(d => d is not null)
        .OrderBy(d => d!.Version).ThenBy(d => d!.CreatedAt).ToList();
      var eff = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
      var owners = new Dictionary<string, EffectiveOwner>(StringComparer.Ordinal);
      foreach (var d in lineage)
      {
        if (d is null) continue;
        var map = ItemMap(d.ItemsJson, out var merr);
        if (merr != "") continue;
        if (!TryStrictIdList(d.ApprovedJson, out var ap, out _)) continue;
        foreach (var id2 in ap)
        {
          if (map.TryGetValue(id2, out var el))
          {
            eff[id2] = el.Clone();
            // Owner provenance: the exact approving record+version that last
            // set this item. New-ID-only amendments inherit old owners and add
            // their own; nothing is text-only.
            owners[id2] = new EffectiveOwner(d.Id.ToString(), d.Version);
          }
        }
      }
      var eids = eff.Keys.OrderBy(x => x, StringComparer.Ordinal).ToList();
      var sb = new StringBuilder();
      var texts = new Dictionary<string, string>(StringComparer.Ordinal);
      foreach (var id2 in eids)
      {
        var tx = ItemText(eff[id2]);
        texts[id2] = tx;
        sb.AppendLine("- [" + id2 + "] " + tx);
      }
      views.Add(new EffectiveView(head,
        lineage.Where(d => d is not null).Select(d => d!.Id.ToString()).ToList(),
        eids, sb.ToString(), texts, owners,
        covers.OrderBy(x => x, StringComparer.Ordinal).ToList()));
    }
    return views;
  }

  static HashSet<string> ClosureOf(Dictionary<string, RecordDraft> byId, RecordDraft root)
  {
    var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { root.Id.ToString() };
    var q = new Queue<string>(SupersededIdSet(root));
    while (q.Count > 0)
    {
      var id = q.Dequeue();
      if (!seen.Add(id)) continue;
      if (byId.TryGetValue(id, out var dd))
        foreach (var p in SupersededIdSet(dd)) q.Enqueue(p);
    }
    return seen;
  }

  // Approval-time authority: the FIRST legitimate approved successor wins
  // WITHIN its lineage family. Approving draft D is rejected with 409 only when
  // another same-scope approved draft competes for the SAME authority: either
  // it shares supersedes ancestry with D (sibling/descendant, not an ancestor)
  // or it already owns one of Ds item ids. Independent roots with disjoint items
  // are separate lineages and never block each other; ambiguous same-item claims
  // across families stay rejected until rebased or discarded.
  public static bool CheckApprovalAuthority(InMemoryStore s, RecordDraft d, out string error)
  {
    error = "";
    var byId = new Dictionary<string, RecordDraft>(StringComparer.OrdinalIgnoreCase);
    foreach (var x in s.Drafts.Values)
      if (x.BoardId == d.BoardId && x.MeetingId == d.MeetingId) byId[x.Id.ToString()] = x;
    var mine = ClosureOf(byId, d);
    var myItems = new HashSet<string>(ItemMap(d.ItemsJson, out _).Keys, StringComparer.Ordinal);
    foreach (var other in byId.Values)
    {
      if (other.Id == d.Id) continue;
      if (!HasApprovals(other)) continue;
      if (mine.Contains(other.Id.ToString())) continue; // proper ancestor: normal continuation
      var otherClosure = ClosureOf(byId, other);
      var sharesAncestry = mine.Any(id => otherClosure.Contains(id)) || otherClosure.Any(id => mine.Contains(id));
      if (!sharesAncestry && !myItems.Overlaps(ParseIdList(other.ApprovedJson))) continue; // independent lineage
      error = "Another approved review already carries this lineage forward; continue on the authoritative head instead of approving a competing branch.";
      return false;
    }
    return true;
  }
  // At most ONE open (undecided) successor per authoritative lineage. A
  // discarded unapproved proposal retires nothing and allows a new proposal.
  public static bool CheckSingleOpenSuccessor(InMemoryStore s, RecordDraft old, out string error)
  {
    error = "";
    foreach (var d in s.Drafts.Values)
    {
      if (d.Id == old.Id) continue;
      if (d.BoardId != old.BoardId || d.MeetingId != old.MeetingId) continue;
      if (!SupersededIdSet(d).Contains(old.Id.ToString())) continue;
      if (d.Decided) continue;
      if (HasApprovals(d)) continue; // decided-content handled by approval authority
      error = "This review already has an open successor; continue on it instead of branching again.";
      return false;
    }
    return true;
  }

  public static bool ValidateSupersedesChain(InMemoryStore s, RecordDraft old, string[] extra, out string error)
  {
    error = "";
    var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { old.Id.ToString() };
    foreach (var raw in extra)
    {
      if (string.IsNullOrWhiteSpace(raw) || !Guid.TryParse(raw, out var g)) { error = "Supersedes id is not a record id."; return false; }
      var key = g.ToString();
      if (!seen.Add(key)) { error = "Duplicate supersedes id."; return false; }
      if (!s.Drafts.TryGetValue(g, out var target) || target is null) { error = "Superseded record not found."; return false; }
      if (target.BoardId != old.BoardId || target.MeetingId != old.MeetingId) { error = "Supersedes target belongs to another board or meeting."; return false; }
      if (ParseIdList(target.ApprovedJson).Count == 0) { error = "Supersedes target has no approved items."; return false; }
      foreach (var other in extra.Concat(new[] { old.Id.ToString() }))
      {
        if (!Guid.TryParse(other, out var og) || og == g) continue;
        if (!s.Drafts.TryGetValue(og, out var ot) || ot is null) continue;
        var shared = new HashSet<string>(ParseIdList(target.ApprovedJson), StringComparer.Ordinal);
        shared.IntersectWith(ParseIdList(ot.ApprovedJson));
        if (shared.Count > 0) { error = "Supersedes parents share approved item '" + string.Join(",", shared.OrderBy(x => x)) + "'; rebase onto one authoritative head instead of merging."; return false; }
      }
      if (ClosureIds(s, target).Contains(old.Id.ToString())) { error = "Supersedes chain would cycle."; return false; }
    }
    return true;
  }

  // Authoritative amendment lineage. Once ANY successor in the transitive
  // closure carries committed approved content, the historical ancestor can
  // no longer branch again; the authoritative head must be amended instead.
  // Pending-only or fully-discarded successors retire nothing and a
  // discarded proposal can be deliberately replaced.
  public static bool HasApprovedSuccessor(InMemoryStore s, RecordDraft old)
  {
    var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    var q = new Queue<RecordDraft>();
    foreach (var d in s.Drafts.Values)
      if (d.Id != old.Id && SupersededIdSet(d).Contains(old.Id.ToString())) q.Enqueue(d);
    while (q.Count > 0)
    {
      var cur = q.Dequeue();
      if (!seen.Add(cur.Id.ToString())) continue;
      if (ParseIdList(cur.ApprovedJson).Count > 0) return true;
      foreach (var d in s.Drafts.Values)
        if (d.Id != cur.Id && SupersededIdSet(d).Contains(cur.Id.ToString())) q.Enqueue(d);
    }
    return false;
  }

  public sealed record LineageEffect(string Id, string Text, string Status, int FromVersion, int ToVersion);

  // Item-specific amendment effects for the chain containing d: for each
  // effective approved id, which ancestor version introduced it and whether
  // the head replaced, added, inherited, or reaffirmed it.
  public static List<LineageEffect> AmendmentEffects(InMemoryStore s, RecordDraft d)
  {
    var outList = new List<LineageEffect>();
    var chain = EffectiveChains(s.Drafts.Values.Where(x => x.BoardId == d.BoardId && x.MeetingId == d.MeetingId));
    var mine = chain.FirstOrDefault(v => v.CoveredIds.Contains(d.Id.ToString(), StringComparer.OrdinalIgnoreCase));
    if (mine is null) return outList;
    var byId = new Dictionary<string, RecordDraft>(StringComparer.OrdinalIgnoreCase);
    foreach (var x in s.Drafts.Values) byId[x.Id.ToString()] = x;
    var ordered = mine.ChainIds
      .Select(id => byId.TryGetValue(id, out var dd) ? dd : null)
      .Where(x => x is not null)
      .OrderBy(x => x!.Version).ThenBy(x => x!.CreatedAt).ToList();
    var perDraft = new List<(RecordDraft Draft, Dictionary<string, string> Texts)>();
    foreach (var dd in ordered)
    {
      if (dd is null) continue;
      var map = ItemMap(dd.ItemsJson, out var merr);
      if (merr != "") continue;
      if (!TryStrictIdList(dd.ApprovedJson, out var ap, out _)) continue;
      var texts = new Dictionary<string, string>(StringComparer.Ordinal);
      foreach (var id in ap)
        if (map.TryGetValue(id, out var el)) texts[id] = ItemText(el);
      perDraft.Add((dd, texts));
    }
    foreach (var id in mine.EffectiveIds)
    {
      var sources = perDraft.Where(p => p.Texts.ContainsKey(id)).ToList();
      if (sources.Count == 0) continue;
      var first = sources.First(); var last = sources.Last();
      string status = sources.Count == 1
        ? (first.Draft.Id == mine.Head.Id ? "added" : "inherited")
        : (!string.Equals(first.Texts[id], last.Texts[id], StringComparison.Ordinal) ? "replaced" : "reaffirmed");
      outList.Add(new LineageEffect(id, mine.EffectiveTexts.TryGetValue(id, out var t) ? t : "", status, first.Draft.Version, last.Draft.Version));
    }
    return outList.OrderBy(e => e.Id, StringComparer.Ordinal).ToList();
  }
}public sealed record EvidenceCard(string ItemId, string Kind, string Ref, int? Version, string Title, string Excerpt, bool CurrentEligible, bool Historical, bool Missing);

public sealed record EvidenceSnapshot(string ItemId, string Kind, string Ref, int? Version, bool Available, string Title, string Excerpt, string At, int Revision);

public static partial class RecordsOps
{
  private static string Trunc(string s, int max)
  {
    if (string.IsNullOrEmpty(s)) return "";
    return s.Length <= max ? s : s.Substring(0, max) + char.ConvertFromUtf32(0x2026);
  }

  private static string ReadableSourceText(InMemoryStore s, Domain.SourceDoc doc)
  {
    var md = Extraction.MarkdownOf(doc.ExtractionJson);
    if (!string.IsNullOrWhiteSpace(md)) return md;
    if (doc.Original is null) return "";
    string text;
    try { text = Encoding.UTF8.GetString(doc.Original); } catch (DecoderFallbackException) { return ""; }
    if (text.Length == 0) return "";
    var printable = 0;
    foreach (var c in text) if (!char.IsControl(c) || c == 10 || c == 13 || c == 9) printable++;
    if ((double)printable / text.Length < 0.7) return "";
    return text.Length > 12000 ? text.Substring(0, 12000) : text;
  }

  private static EvidenceCard Unavailable(string itemId, string kind, string rf, int? version)
  {
    return new EvidenceCard(itemId, kind, rf, version, "", "", false, true, true);
  }

  // Disclosure authorization for persisted snapshots. Verifies the board,
  // the reader permission on the referenced resource, and parent/scope
  // match WITHOUT reading any referenced title or text. Eligibility
  // (approved/excluded/version state) is intentionally not consulted here.
  public static bool SnapshotAuthorize(InMemoryStore s, HttpRequest req, RecordDraft d, EvidenceSnapshot sn)
  {
    var kind = sn.Kind; var rf = sn.Ref;
    if (kind == "source" && Guid.TryParse(rf, out var sid) && s.Sources.TryGetValue(sid, out var doc) && doc is not null)
      return doc.BoardId == d.BoardId && PeopleOps.Can(s, req, doc.BoardId, doc.MeetingId, "read");
    if ((kind == "direction" || kind == "note") && Guid.TryParse(rf, out var nid) && s.Notes.TryGetValue(nid, out var note) && note is not null)
    {
      var scopeOk = note.Scope == "board" || (note.Scope == "meeting" && note.MeetingId == d.MeetingId);
      return note.BoardId == d.BoardId && scopeOk && PeopleOps.Can(s, req, note.BoardId, note.MeetingId, "read");
    }
    if (kind == "record" && Guid.TryParse(rf, out var rid) && s.Drafts.TryGetValue(rid, out var rd) && rd is not null)
      return rd.BoardId == d.BoardId && PeopleOps.Can(s, req, rd.BoardId, rd.MeetingId, "read");
    if (kind == "message")
    {
      var parts = rf.Split((char)58);
      return parts.Length == 2 && Guid.TryParse(parts[0], out var mm) && mm == d.MeetingId;
    }
    if (kind == "dossier" && Guid.TryParse(rf, out var eid) && s.Roster.TryGetValue(eid, out var ent) && ent is not null)
      return s.Advisors.Values.Any(a => a.BoardId == d.BoardId && a.RosterEntryId == ent.Id && !a.Removed);
    return false;
  }

  // Authorized evidence resolution. Destination, caller, parent, and version
  // authority are checked BEFORE any referenced title or text is read.
  // Unknown, unauthorized, wrong-parent, or version-mismatched references
  // yield unavailable cards with NO private content. Caller-supplied
  // url/title/excerpt hints are never echoed.
  public static List<EvidenceCard> ResolveEvidenceAuthorized(InMemoryStore s, HttpRequest req, RecordDraft d)
  {
    var cards = new List<EvidenceCard>();
    var map = ItemMap(d.ItemsJson, out var mapErr);
    if (mapErr != "") return cards;
    foreach (var (itemId, item) in map)
    {
      if (!item.TryGetProperty("refs", out var refs) || refs.ValueKind != JsonValueKind.Array) continue;
      foreach (var r in refs.EnumerateArray())
      {
        var parsed = EvidenceRef.Parse(r);
        if (parsed is null) { cards.Add(new EvidenceCard(itemId, "ref", "", null, "", "", false, true, true)); continue; }
        var kind = parsed.Kind;
        var rf = parsed.Ref;
        if (kind == "source" && Guid.TryParse(rf, out var sid) && s.Sources.TryGetValue(sid, out var doc) && doc is not null)
        {
          var okBoard = doc.BoardId == d.BoardId;
          // Governed eligibility (not raw approved flags): superseded, failed,
          // running, blocked, excluded, or headless sources never supply live text.
          // Version pins honor the server-owned legacy alias after renumbering.
          var okElig = okBoard && SourceGovernance.IsEligible(s, doc, d.MeetingId);
          var okVersion = !parsed.Version.HasValue || parsed.Version.Value == doc.Version || parsed.Version.Value == SourceGovernance.OriginalVersionOf(s, doc);
          // Current referenced-resource authorization BEFORE any title/text:
          // a reader confined to another meeting must not receive this source.
          var okAuth = okBoard && PeopleOps.Can(s, req, doc.BoardId, doc.MeetingId, "read");
          if (okBoard && okElig && okVersion && okAuth)
            cards.Add(new EvidenceCard(itemId, kind, rf, doc.Version, doc.FileName, Trunc(SourceGovernance.CanonicalSectionText(s, doc), 600), true, true, false));
          else
            cards.Add(Unavailable(itemId, kind, rf, parsed.Version));
        }
        else if ((kind == "direction" || kind == "note") && !parsed.Version.HasValue && Guid.TryParse(rf, out var nid) && s.Notes.TryGetValue(nid, out var note) && note is not null)
        {
          var wantDir = kind == "direction";
          var okKind = wantDir
            ? string.Equals(note.Kind, "direction", StringComparison.OrdinalIgnoreCase)
            : !string.Equals(note.Kind, "direction", StringComparison.OrdinalIgnoreCase);
          var okBoard = note.BoardId == d.BoardId;
          var okState = !note.Provisional;
          var okScope = note.Scope == "board" || (note.Scope == "meeting" && note.MeetingId == d.MeetingId);
          var okNoteAuth = okBoard && PeopleOps.Can(s, req, note.BoardId, note.Scope == "meeting" ? (Guid?)note.MeetingId : d.MeetingId, "read");
          if (okKind && okBoard && okState && okScope && okNoteAuth)
            cards.Add(new EvidenceCard(itemId, kind, rf, null, note.Title ?? "", Trunc(note.Body ?? "", 600), true, true, false));
          else
            cards.Add(Unavailable(itemId, kind, rf, parsed.Version));
        }
        else if (kind == "record" && Guid.TryParse(rf, out var rid) && s.Drafts.TryGetValue(rid, out var rd) && rd is not null)
        {
          var okBoard = rd.BoardId == d.BoardId;
          var okAuth = okBoard && PeopleOps.Can(s, req, rd.BoardId, rd.MeetingId, "read");
          var okVersion = !parsed.Version.HasValue || parsed.Version.Value == rd.Version;
          var okState = ParseIdList(rd.ApprovedJson).Count > 0
            && !string.Equals(rd.Status, "superseded", StringComparison.OrdinalIgnoreCase);
          var okReadable = IsReadableItems(rd.ItemsJson);
          if (okBoard && okAuth && okVersion && okState && okReadable)
          {
            var txt = BuildExport(rd.ItemsJson, rd.ApprovedJson, false);
            cards.Add(new EvidenceCard(itemId, kind, rf, rd.Version, "record v" + rd.Version, Trunc(txt, 600), true, true, false));
          }
          else
            cards.Add(Unavailable(itemId, kind, rf, parsed.Version));
        }
        else if (kind == "message" && !parsed.Version.HasValue)
        {
          var parts = rf.Split((char)58);
          if (parts.Length == 2 && Guid.TryParse(parts[0], out var msgMid) && long.TryParse(parts[1], out var seq)
            && msgMid == d.MeetingId && s.Messages.TryGetValue(msgMid, out var list) && list is not null)
          {
            var hit = list.FirstOrDefault(m => m.Sequence == seq);
            if (hit is not null && hit.MeetingId == d.MeetingId)
              cards.Add(new EvidenceCard(itemId, kind, rf, null, "message " + seq, Trunc(hit.Content ?? "", 600), true, true, false));
            else
              cards.Add(Unavailable(itemId, kind, rf, parsed.Version));
          }
          else
            cards.Add(Unavailable(itemId, kind, rf, parsed.Version));
        }
        else if (kind == "dossier" && Guid.TryParse(rf, out var eid) && s.Roster.TryGetValue(eid, out var ent) && ent is not null)
        {
          // Private-profile boundary: the referenced roster template must be readable
          // by THIS caller (owner/admin/readable-board link). Meeting guests without
          // board read cannot pull unselected or pending advisor profiles through evidence.
          var linked = !ent.Archived
            && s.Advisors.Values.Any(a => a.BoardId == d.BoardId && a.RosterEntryId == ent.Id && !a.Removed)
            && RosterEndpoints.CanReadRoster(s, req, ent);
          var okVersion = !parsed.Version.HasValue || parsed.Version.Value == ent.Version;
          if (linked && okVersion)
            cards.Add(new EvidenceCard(itemId, kind, rf, ent.Version, ent.Name ?? "", Trunc(ent.ProfileJson ?? "", 600), true, true, false));
          else
            cards.Add(Unavailable(itemId, kind, rf, parsed.Version));
        }
        else
        {
          cards.Add(Unavailable(itemId, kind, rf, parsed.Version));
        }
      }
    }
    return cards;
  }

  public static List<EvidenceSnapshot> GetSnapshots(RecordDraft d)
  {
    var list = new List<EvidenceSnapshot>();
    try
    {
      using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(d.EvidenceSnapshotJson) ? "[]" : d.EvidenceSnapshotJson);
      if (doc.RootElement.ValueKind != JsonValueKind.Array) return list;
      foreach (var e in doc.RootElement.EnumerateArray())
      {
        if (e.ValueKind != JsonValueKind.Object) continue;
        var itemId = e.TryGetProperty("itemId", out var a) && a.ValueKind == JsonValueKind.String ? (a.GetString() ?? "") : "";
        var kind = e.TryGetProperty("kind", out var b) && b.ValueKind == JsonValueKind.String ? (b.GetString() ?? "") : "";
        var rf = e.TryGetProperty("ref", out var c) && c.ValueKind == JsonValueKind.String ? (c.GetString() ?? "") : "";
        if (string.IsNullOrWhiteSpace(itemId) || string.IsNullOrWhiteSpace(kind) || string.IsNullOrWhiteSpace(rf)) continue;
        int? ver = e.TryGetProperty("version", out var vv) && vv.ValueKind == JsonValueKind.Number && vv.TryGetInt32(out var vi) ? vi : null;
        var available = !e.TryGetProperty("available", out var av) || av.ValueKind != JsonValueKind.False;
        list.Add(new EvidenceSnapshot(itemId, kind, rf, ver, available,
          e.TryGetProperty("title", out var t) && t.ValueKind == JsonValueKind.String ? (t.GetString() ?? "") : "",
          e.TryGetProperty("excerpt", out var x) && x.ValueKind == JsonValueKind.String ? (x.GetString() ?? "") : "",
          e.TryGetProperty("at", out var at) && at.ValueKind == JsonValueKind.String ? (at.GetString() ?? "") : "",
          e.TryGetProperty("revision", out var rv) && rv.ValueKind == JsonValueKind.Number && rv.TryGetInt32(out var ri) ? ri : 0));
      }
    }
    catch (JsonException) { }
    return list;
  }

  // Pure snapshot builder: captures ONLY newly approved item/ref pairs and
  // NEVER replaces an existing snapshot entry. Refs that are unavailable or
  // unauthorized at approval time persist an explicit unavailable entry, so
  // later live text can never backfill decision-time evidence.
  public static bool TryBuildSnapshots(string existingJson,
    Dictionary<string, JsonElement> itemMap, List<EvidenceCard> authorized,
    IEnumerable<string> newIds, int revision, out string nextJson, out string error)
  {
    error = ""; nextJson = existingJson;
    var snaps = new List<EvidenceSnapshot>();
    try
    {
      using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(existingJson) ? "[]" : existingJson);
      if (doc.RootElement.ValueKind != JsonValueKind.Array) { error = "Evidence snapshot state is malformed; explicit repair required."; return false; }
      foreach (var e in doc.RootElement.EnumerateArray())
      {
        if (!TryParseSnapshotEntry(e, out var sn, out var eerr)) { error = eerr; return false; }
        snaps.Add(sn);
      }
    }
    catch (JsonException) { error = "Evidence snapshot state is malformed; explicit repair required."; return false; }
    var idx = new Dictionary<string, int>(StringComparer.Ordinal);
    for (var i = 0; i < snaps.Count; i++) idx[SnapshotKeyV(snaps[i].ItemId, snaps[i].Kind, snaps[i].Ref, snaps[i].Version)] = i;
    var live = new Dictionary<string, EvidenceCard>(StringComparer.Ordinal);
    foreach (var c in authorized) live[SnapshotKey(c.ItemId, c.Kind, c.Ref)] = c;
    foreach (var id in newIds)
    {
      if (!itemMap.TryGetValue(id, out var item)) continue;
      if (!item.TryGetProperty("refs", out var refs) || refs.ValueKind != JsonValueKind.Array) continue;
      foreach (var r in refs.EnumerateArray())
      {
        var parsed = EvidenceRef.Parse(r);
        if (parsed is null) continue;
        var key = SnapshotKeyV(id, parsed.Kind, parsed.Ref, parsed.Version);
        if (idx.ContainsKey(key)) continue; // never overwrite an existing capture
        EvidenceSnapshot entry;
        // Live lookup ignores the requested version pin: the persisted entry
        // always carries the RESOLVED capture version, so readback compares
        // resolved-against-resolved. A versioned request that does not match
        // the current resolution captures unavailable (stale pin), never
        // another versions bytes. Duplicate same-target different-version refs
        // are rejected at validation, so one requested version owns this key.
        var liveHit = live.TryGetValue(SnapshotKey(id, parsed.Kind, parsed.Ref), out var card) && !card.Missing
          && (!string.IsNullOrWhiteSpace(card.Title) || !string.IsNullOrWhiteSpace(card.Excerpt));
        var pinOk = parsed.Version is null || (card is not null && card.Version == parsed.Version);
        if (liveHit && pinOk)
          entry = new EvidenceSnapshot(id, parsed.Kind, parsed.Ref, card!.Version, true, card!.Title, card!.Excerpt, DateTime.UtcNow.ToString("o"), revision);
        else
          entry = new EvidenceSnapshot(id, parsed.Kind, parsed.Ref, parsed.Version, false, "", "", DateTime.UtcNow.ToString("o"), revision);
        idx[key] = snaps.Count; snaps.Add(entry);
      }
    }
    nextJson = JsonSerializer.Serialize(snaps, new JsonSerializerOptions(JsonSerializerDefaults.Web));
    return true;
  }

  public static string SnapshotKey(string itemId, string kind, string rf)
  {
    return itemId + "\u0001" + kind + "\u0001" + rf;
  }

  public static string SnapshotKeyV(string itemId, string kind, string rf, int? version)
  {
    return itemId + "\u0001" + kind + "\u0001" + rf + "\u0001" + (version?.ToString() ?? "");
  }

  public static bool TryParseSnapshotEntry(JsonElement e, out EvidenceSnapshot sn, out string error)
  {
    sn = new EvidenceSnapshot("", "", "", null, false, "", "", "", 0); error = "";
    if (e.ValueKind != JsonValueKind.Object) { error = "Evidence snapshot entries must be objects."; return false; }
    var itemId = e.TryGetProperty("itemId", out var a) && a.ValueKind == JsonValueKind.String ? (a.GetString() ?? "") : "";
    var kind = e.TryGetProperty("kind", out var b) && b.ValueKind == JsonValueKind.String ? (b.GetString() ?? "") : "";
    var rf = e.TryGetProperty("ref", out var c) && c.ValueKind == JsonValueKind.String ? (c.GetString() ?? "") : "";
    if (string.IsNullOrWhiteSpace(itemId) || string.IsNullOrWhiteSpace(kind) || string.IsNullOrWhiteSpace(rf))
    { error = "Evidence snapshot entries must carry itemId, kind, and ref."; return false; }
    if (!EvidenceRef.ValidKind(kind)) { error = "Evidence snapshot kind '" + kind + "' is not a known evidence kind."; return false; }
    int? ver = null;
    if (e.TryGetProperty("version", out var vv))
    {
      if (vv.ValueKind == JsonValueKind.Null) ver = null;
      else if (vv.ValueKind != JsonValueKind.Number || !vv.TryGetInt32(out var vi)) { error = "Evidence snapshot version must be an integer or null."; return false; }
      else if (vi < 1) { error = "Evidence snapshot version must be a positive version or null."; return false; }
      else ver = vi;
    }
    var title = "";
    if (e.TryGetProperty("title", out var t))
    {
      if (t.ValueKind != JsonValueKind.String) { error = "Evidence snapshot title must be a string."; return false; }
      title = t.GetString() ?? "";
    }
    var excerpt = "";
    if (e.TryGetProperty("excerpt", out var x))
    {
      if (x.ValueKind != JsonValueKind.String) { error = "Evidence snapshot excerpt must be a string."; return false; }
      excerpt = x.GetString() ?? "";
    }
    var at = "";
    if (e.TryGetProperty("at", out var atv))
    {
      if (atv.ValueKind != JsonValueKind.String) { error = "Evidence snapshot at must be a string."; return false; }
      at = atv.GetString() ?? "";
    }
    var rev = 0;
    if (e.TryGetProperty("revision", out var rv))
    {
      if (rv.ValueKind != JsonValueKind.Number || !rv.TryGetInt32(out var ri)) { error = "Evidence snapshot revision must be an integer."; return false; }
      rev = ri;
    }
    var available = true;
    if (e.TryGetProperty("available", out var av))
    {
      if (av.ValueKind != JsonValueKind.True && av.ValueKind != JsonValueKind.False) { error = "Evidence snapshot available must be a boolean."; return false; }
      available = av.ValueKind == JsonValueKind.True;
    }
    sn = new EvidenceSnapshot(itemId, kind, rf, ver, available, title, excerpt, at, rev);
    return true;
  }  // Read merge with disclosure authorization. Approved items show ONLY
  // their persisted snapshot bytes when the snapshot is available AND the
  // current reader is authorized for the referenced resource; otherwise an
  // unavailable card with no private content. Approved items with no snapshot
  // entry (legacy no-capture) are honestly unavailable: live text is never
  // substituted for decision-time evidence. Pending items show live
  // authorized resolution, including unavailable cards.
  public static List<EvidenceCard> MergeEvidenceForRead(InMemoryStore s, HttpRequest req, RecordDraft d)
  {
    var live = ResolveEvidenceAuthorized(s, req, d);
    var snaps = GetSnapshots(d);
    var approved = new HashSet<string>(ParseIdList(d.ApprovedJson), StringComparer.Ordinal);
    var result = new List<EvidenceCard>();
    var snapKeys = new HashSet<string>(StringComparer.Ordinal);
    foreach (var sn in snaps)
    {
      if (!approved.Contains(sn.ItemId)) continue;
      snapKeys.Add(SnapshotKeyV(sn.ItemId, sn.Kind, sn.Ref, sn.Version));
      // Version-less identity too: a capture keyed by resolved version satisfies the original unversioned request.
      snapKeys.Add(SnapshotKey(sn.ItemId, sn.Kind, sn.Ref));
      if (sn.Available && SnapshotAuthorize(s, req, d, sn))
      {
        var stillEligible = live.Any(c => !c.Missing && c.ItemId == sn.ItemId && c.Kind == sn.Kind && c.Ref == sn.Ref
          && ((!c.Version.HasValue && !sn.Version.HasValue) || c.Version == sn.Version));
        // Record references: current eligibility follows the per-item approving owner.
        // A replaced approved item keeps its readable historical snapshot, but is no
        // longer current when another record+version now owns that item.
        if (stillEligible && string.Equals(sn.Kind, "record", StringComparison.OrdinalIgnoreCase) && Guid.TryParse(sn.Ref, out var ownRid) && s.Drafts.TryGetValue(ownRid, out var ownRd) && ownRd is not null)
        {
          var ownerMatch = false;
          try
          {
            foreach (var v in EffectiveChains(s.Drafts.Values.Where(x => x.BoardId == ownRd.BoardId && x.MeetingId == ownRd.MeetingId)))
            {
              if (v.EffectiveOwners.TryGetValue(sn.ItemId, out var eo) && string.Equals(eo.RecordId, sn.Ref, StringComparison.OrdinalIgnoreCase) && eo.Version == sn.Version) { ownerMatch = true; break; }
            }
          }
          catch { ownerMatch = false; }
          stillEligible = ownerMatch;
        }
        result.Add(new EvidenceCard(sn.ItemId, sn.Kind, sn.Ref, sn.Version, sn.Title, sn.Excerpt, stillEligible, true, false));
      }
      else result.Add(Unavailable(sn.ItemId, sn.Kind, sn.Ref, sn.Version));
    }
    foreach (var c in live)
    {
      if (approved.Contains(c.ItemId)) continue;
      result.Add(c);
    }
    // Approved item/refs with no snapshot entry: unavailable, never live text.
    var map = ItemMap(d.ItemsJson, out _);
    foreach (var (itemId, item) in map)
    {
      if (!approved.Contains(itemId)) continue;
      if (!item.TryGetProperty("refs", out var refs) || refs.ValueKind != JsonValueKind.Array) continue;
      foreach (var r in refs.EnumerateArray())
      {
        var parsed = EvidenceRef.Parse(r);
        if (parsed is null) continue;
        if (!snapKeys.Contains(SnapshotKeyV(itemId, parsed.Kind, parsed.Ref, parsed.Version)))
          result.Add(Unavailable(itemId, parsed.Kind, parsed.Ref, parsed.Version));
      }
    }
    return result;
  }

  public static bool CheckGuard(JsonElement body, RecordDraft d, Meeting m, out int status, out string error)
  {
    status = 409; error = "";
    if (body.ValueKind != JsonValueKind.Object) { status = 400; error = "Refresh review: send the current version, hash, review token and watermark together."; return false; }
    if (!body.TryGetProperty("version", out var vw) || vw.ValueKind != JsonValueKind.Number || !vw.TryGetInt32(out var wantVer))
    { status = 400; error = "Refresh review: version is required; reload the review and retry deliberately."; return false; }
    if (!body.TryGetProperty("hash", out var hw) || hw.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(hw.GetString()))
    { status = 400; error = "Refresh review: hash is required; reload the review and retry deliberately."; return false; }
    if (!body.TryGetProperty("reviewToken", out var tw) || tw.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(tw.GetString()))
    { status = 400; error = "Refresh review: review token is required; reload the review and retry deliberately."; return false; }
    if (!body.TryGetProperty("watermark", out var ww) || ww.ValueKind != JsonValueKind.Number || !ww.TryGetInt64(out var wantWm))
    { status = 400; error = "Refresh review: watermark is required; reload the review and retry deliberately."; return false; }
    if (wantVer != d.Version) { error = "Document version moved on; refresh review and choose again."; return false; }
    if (!string.Equals(hw.GetString(), d.Hash, StringComparison.OrdinalIgnoreCase)) { error = "Draft hash mismatch; refresh review and choose again."; return false; }
    if (!string.Equals(tw.GetString(), d.ReviewToken, StringComparison.Ordinal)) { error = "Review changed since you loaded it; refresh review and choose again."; return false; }
    if (wantWm != d.Watermark || d.Watermark != m.DeliveredRevision || wantWm != m.DeliveredRevision)
    { error = "Meeting moved on; refresh review and choose again."; return false; }
    return true;
  }

  // Guest projection: approved items/content only. Pending/discarded text,
  // provisional notes, recent messages and the version graph are withheld;
  // evidence is limited to approved item refs (authorized bytes or explicit
  public static Dictionary<string, object?> GuestDraftView(InMemoryStore s, RecordDraft d)
  {
    // Requested-version content, immutable.
    var items = new List<object>();
    try
    {
      var ownMap = ItemMap(d.ItemsJson, out var ownErr);
      if (ownErr == "")
      {
        foreach (var id in ParseIdList(d.ApprovedJson))
        {
          if (!ownMap.TryGetValue(id, out var el)) continue;
          items.Add(new
          {
            id,
            text = ItemText(el),
            approvedBy = new { recordId = d.Id.ToString(), version = d.Version },
          });
        }
      }
    }
    catch { }
    object? effective = null;
    try
    {
      var chain = EffectiveChains(s.Drafts.Values.Where(x => x.BoardId == d.BoardId && x.MeetingId == d.MeetingId));
      var mine = chain.FirstOrDefault(v => v.CoveredIds.Contains(d.Id.ToString(), StringComparer.OrdinalIgnoreCase));
      if (mine is not null)
      {
        var effItems = new List<object>();
        foreach (var id in mine.EffectiveIds)
          effItems.Add(new
          {
            id,
            text = mine.EffectiveTexts.TryGetValue(id, out var tx) ? tx : "",
            approvedBy = mine.EffectiveOwners.TryGetValue(id, out var ow)
              ? new { recordId = ow.RecordId, version = ow.Version } : null,
          });
        effective = new
        {
          headId = mine.Head.Id,
          headVersion = mine.Head.Version,
          approvedIds = mine.EffectiveIds,
          approvedItems = effItems,
          conciseExport = mine.ConciseExport,
        };
      }
    }
    catch { }
    return new Dictionary<string, object?>
    {
      ["id"] = d.Id, ["boardId"] = d.BoardId, ["meetingId"] = d.MeetingId,
      ["version"] = d.Version, ["decided"] = d.Decided, ["status"] = d.Status,
      ["approvedJson"] = d.ApprovedJson, ["approvedItems"] = items, ["effective"] = effective, ["createdAt"] = d.CreatedAt,
    };
  }

  public static Dictionary<string, object?> GuestReviewPayload(InMemoryStore s, HttpRequest req, RecordDraft d, Meeting mtg)
  {
    var approved = ParseIdList(d.ApprovedJson);
    var aset = new HashSet<string>(approved, StringComparer.Ordinal);
    var cards = MergeEvidenceForRead(s, req, d).Where(c => aset.Contains(c.ItemId)).ToList();
    var chain = EffectiveChains(s.Drafts.Values.Where(x => x.BoardId == d.BoardId && x.MeetingId == d.MeetingId));
    var mine = chain.FirstOrDefault(v => v.CoveredIds.Contains(d.Id.ToString(), StringComparer.OrdinalIgnoreCase));
    return new Dictionary<string, object?>
    {
      ["draft"] = GuestDraftView(s, d),
      ["approved"] = approved,
      ["discarded"] = new List<string>(),
      ["pending"] = new List<string>(),
      ["notes"] = new List<object>(),
      ["recentMessages"] = new List<object>(),
      ["predecessors"] = new List<string>(),
      ["successors"] = new List<string>(),
      ["evidence"] = cards,
      ["historyCount"] = HistoryCount(d.HistoryJson),
      ["meetingWatermark"] = mtg.DeliveredRevision,
      ["effectiveIds"] = mine is null ? new List<string>() : mine.EffectiveIds,
      ["effectiveExport"] = mine is null ? "" : mine.ConciseExport,
      ["lineageEffects"] = AmendmentEffects(s, d),
    };
  }

  public static Dictionary<string, object?> ReviewPayload(InMemoryStore s, HttpRequest req, RecordDraft d, Meeting mtg)
  {
    // Authoritative persisted-state validity: every approval control in the
    // UI gates on this server-computed flag, not on partial client checks.
    var stateValid = StrictStateCheck(s, d, out var stateError);
    var approved = ParseIdList(d.ApprovedJson);
    var discarded = ParseIdList(d.DiscardedJson);
    var pending = PendingIds(d);
    var notes = s.Notes.Values
      .Where(n => n.MeetingId == d.MeetingId && n.Provisional && (n.Kind == "note" || n.Kind == "briefing"))
      .OrderByDescending(n => n.CreatedAt).Take(20)
      .Select(n => new { n.Id, n.Kind, n.Title, n.Body, n.CreatedAt }).ToList();
    List<object> recent = new();
    if (s.Messages.TryGetValue(d.MeetingId, out var list) && list is not null)
    {
      lock (s.MessageLock)
      {
        recent = list.OrderByDescending(m => m.Sequence).Take(10).OrderBy(m => m.Sequence)
          .Select(m => (object)new { m.Sequence, m.Sender, m.AdvisorName, content = (m.Content ?? "").Length > 600 ? m.Content!.Substring(0, 600) : m.Content }).ToList();
      }
    }
    var predIds = new List<string>();
    try
    {
      using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(d.SupersedesJson) ? "[]" : d.SupersedesJson);
      if (doc.RootElement.ValueKind == JsonValueKind.Array)
        foreach (var e in doc.RootElement.EnumerateArray())
          if (e.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(e.GetString())) predIds.Add(e.GetString()!);
    }
    catch (JsonException) { }
    var succIds = s.Drafts.Values
      .Where(x => x.Id != d.Id && SupersededIdSet(x).Contains(d.Id.ToString()))
      .OrderBy(x => x.Version).Select(x => x.Id.ToString()).ToList();
    var cards = MergeEvidenceForRead(s, req, d);
    int histCount = HistoryCount(d.HistoryJson);
    var chain = EffectiveChains(s.Drafts.Values.Where(x => x.BoardId == d.BoardId && x.MeetingId == d.MeetingId));
    var mine = chain.FirstOrDefault(v => v.CoveredIds.Contains(d.Id.ToString(), StringComparer.OrdinalIgnoreCase));
    return new Dictionary<string, object?>
    {
      ["draft"] = SafeDraft(d),
      ["stateValid"] = stateValid,
      ["stateError"] = stateValid ? "" : stateError,
      ["approved"] = approved,
      ["discarded"] = discarded,
      ["pending"] = pending,
      ["notes"] = notes,
      ["recentMessages"] = recent,
      ["predecessors"] = predIds,
      ["successors"] = succIds,
      ["evidence"] = cards,
      ["historyCount"] = histCount,
      ["meetingWatermark"] = mtg.DeliveredRevision,
      ["effectiveIds"] = mine is null ? new List<string>() : mine.EffectiveIds,
      ["effectiveExport"] = mine is null ? "" : mine.ConciseExport,
      ["lineageEffects"] = AmendmentEffects(s, d),
    };
  }
}public static class RecordEndpoints
{
  private static List<string> SupersedesOf(RecordDraft old, string[] extra)
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

  private static string ActorOf(InMemoryStore s, HttpRequest req)
  {
    try { return PeopleOps.UserOf(s, req); } catch { return "owner"; }
  }

  private static IResult CommitFailed()
  {
    return Results.Json(new { error = "Record mutation failed before commit; no state changed." }, statusCode: 500);
  }

  private static bool IsSuperseded(RecordDraft d)
  {
    return string.Equals(d.Status, "superseded", StringComparison.OrdinalIgnoreCase);
  }

  private static bool IsManager(InMemoryStore s, HttpRequest req, Guid boardId, Guid? meetingId)
  {
    // Auth8 boundary: meeting-scoped discuss grants satisfy read but never
    // board-level or mutation capability. Guests see decided+approved only.
    return PeopleOps.Can(s, req, boardId, null, "manage")
      || (meetingId.HasValue && PeopleOps.Can(s, req, boardId, meetingId, "contribute"));
  }

  private static Dictionary<string, object?> GuestDraft(InMemoryStore s, RecordDraft d) => RecordsOps.GuestDraftView(s, d);

  public static void MapRecords(this WebApplication app)
  {
    app.MapGet("/api/meetings/{id:guid}/records", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (!s.Meetings.TryGetValue(id, out var m)) return Results.NotFound("meeting");
      if (PeopleOps.Check(s, req, m.BoardId, id, "read") is { } deniedRL) return deniedRL;
      var rows = s.Drafts.Values.Where(d => d.MeetingId == id).OrderByDescending(d => d.Version).Take(50).ToList();
      if (!IsManager(s, req, m.BoardId, id))
      {
        rows = rows.Where(d => d.Decided && !string.IsNullOrWhiteSpace(d.ApprovedJson) && d.ApprovedJson.Trim() != "[]").ToList();
        return Results.Ok(rows.Select(x => GuestDraft(s, x)).ToList());
      }
      return Results.Ok(rows.Select(RecordsOps.SafeDraft).ToList());
    });

    app.MapGet("/api/records/{draftId:guid}", (InMemoryStore s, HttpRequest req, Guid draftId) =>
    {
      if (!s.Drafts.TryGetValue(draftId, out var d)) return Results.NotFound();
      if (PeopleOps.Check(s, req, d.BoardId, d.MeetingId, "read") is { } deniedRD) return deniedRD;
      if (!IsManager(s, req, d.BoardId, d.MeetingId))
        return Results.Ok(RecordsOps.GuestDraftView(s, d));
      return Results.Ok(RecordsOps.SafeDraft(d));
    });

    app.MapGet("/api/records/{draftId:guid}/evidence", (InMemoryStore s, HttpRequest req, Guid draftId) =>
    {
      if (!s.Drafts.TryGetValue(draftId, out var d)) return Results.NotFound();
      if (PeopleOps.Check(s, req, d.BoardId, d.MeetingId, "read") is { } deniedEv) return deniedEv;
      if (!IsManager(s, req, d.BoardId, d.MeetingId))
      {
        var approvedOnly = new HashSet<string>(RecordsOps.ParseIdList(d.ApprovedJson), StringComparer.Ordinal);
        return Results.Ok(RecordsOps.MergeEvidenceForRead(s, req, d).Where(c => approvedOnly.Contains(c.ItemId)).ToList());
      }
      return Results.Ok(RecordsOps.MergeEvidenceForRead(s, req, d));
    });

    app.MapGet("/api/records/{draftId:guid}/review", (InMemoryStore s, HttpRequest req, Guid draftId) =>
    {
      if (!s.Drafts.TryGetValue(draftId, out var d)) return Results.NotFound();
      if (PeopleOps.Check(s, req, d.BoardId, d.MeetingId, "read") is { } deniedRv) return deniedRv;
      if (!s.Meetings.TryGetValue(d.MeetingId, out var mtg)) return Results.NotFound("meeting");
      if (!IsManager(s, req, d.BoardId, d.MeetingId))
        return Results.Ok(RecordsOps.GuestReviewPayload(s, req, d, mtg));
      return Results.Ok(RecordsOps.ReviewPayload(s, req, d, mtg));
    });

    app.MapGet("/api/records/{draftId:guid}/effective", (InMemoryStore s, HttpRequest req, Guid draftId) =>
    {
      if (!s.Drafts.TryGetValue(draftId, out var d)) return Results.NotFound();
      if (PeopleOps.Check(s, req, d.BoardId, d.MeetingId, "read") is { } deniedEf) return deniedEf;
      var chain = RecordsOps.EffectiveChains(s.Drafts.Values.Where(x => x.BoardId == d.BoardId && x.MeetingId == d.MeetingId));
      var mine = chain.FirstOrDefault(v => v.CoveredIds.Contains(d.Id.ToString(), StringComparer.OrdinalIgnoreCase));
      if (mine is null) return Results.NotFound("chain");
      return Results.Ok(new { head = mine.Head.Id, chain = mine.ChainIds, effectiveIds = mine.EffectiveIds, conciseExport = mine.ConciseExport, effectiveTexts = mine.EffectiveTexts });
    });

    app.MapPost("/api/records/{draftId:guid}/refresh", (InMemoryStore s, HttpRequest req, Guid draftId, JsonElement body) =>
    {
      AuditEvent? pendingAudit = null;
      IResult result;
      lock (s.MessageLock)
      {
        try
        {
          result = Atomic.Run(() =>
          {
            if (!s.Drafts.TryGetValue(draftId, out var d) || d is null) return Results.NotFound();
            if (!s.Meetings.TryGetValue(d.MeetingId, out var meeting) || meeting is null) return Results.NotFound("meeting");
            if (PeopleOps.Check(s, req, d.BoardId, d.MeetingId, "contribute") is { } deniedAuto1) return deniedAuto1;
            if (IsSuperseded(d))
              return Results.Json(new { error = "Review is superseded by a newer version; use the successor." }, statusCode: 409);
            if (!RecordsOps.StrictStateCheck(s, d, out var serr))
              return Results.Json(new { error = serr }, statusCode: 422);
            if (body.ValueKind != JsonValueKind.Object)
              return Results.Json(new { error = "Refresh review: send the current version, hash, review token and watermark together." }, statusCode: 400);
            if (!body.TryGetProperty("version", out var vw) || vw.ValueKind != JsonValueKind.Number || !vw.TryGetInt32(out var wantVer))
              return Results.Json(new { error = "Refresh review: version is required; reload the review and retry deliberately." }, statusCode: 400);
            if (!body.TryGetProperty("hash", out var hw) || hw.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(hw.GetString()))
              return Results.Json(new { error = "Refresh review: hash is required; reload the review and retry deliberately." }, statusCode: 400);
            if (!body.TryGetProperty("reviewToken", out var tw) || tw.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(tw.GetString()))
              return Results.Json(new { error = "Refresh review: review token is required; reload the review and retry deliberately." }, statusCode: 400);
            if (!body.TryGetProperty("watermark", out var ww) || ww.ValueKind != JsonValueKind.Number || !ww.TryGetInt64(out var wantWm))
              return Results.Json(new { error = "Refresh review: watermark is required; reload the review and retry deliberately." }, statusCode: 400);
            if (wantVer != d.Version)
              return Results.Json(new { error = "Document version moved on; reload the review and choose again." }, statusCode: 409);
            if (!string.Equals(hw.GetString(), d.Hash, StringComparison.OrdinalIgnoreCase))
              return Results.Json(new { error = "Draft hash mismatch; reload the review and choose again." }, statusCode: 409);
            if (!string.Equals(tw.GetString(), d.ReviewToken, StringComparison.Ordinal))
              return Results.Json(new { error = "Review changed since you loaded it; refresh review and choose again." }, statusCode: 409);
            if (wantWm != d.Watermark)
              return Results.Json(new { error = "Stale refresh snapshot; reload the review and refresh deliberately." }, statusCode: 409);
            if (d.Watermark == meeting.DeliveredRevision)
              return Results.Json(new { error = "Review is already current; approve deliberately instead of refreshing." }, statusCode: 409);
            var actor = ActorOf(s, req);
            var viewedV = d.Version; var viewedH = d.Hash; var viewedW = d.Watermark; var viewedT = d.ReviewToken;
            var newWm = meeting.DeliveredRevision;
            var newTokenF = RecordsOps.NewReviewToken();
            if (!RecordsOps.TryBuildHistoryJson(d.HistoryJson, "refresh", "", "watermark " + viewedW, "watermark " + newWm, actor, viewedV, viewedH, viewedW, viewedT, d.ReviewRevision + 1, newTokenF, out var newHistoryF, out var herr))
              return Results.Json(new { error = herr }, statusCode: 422);
            // Fallible response construction completes BEFORE any mutation:
            // build the review payload from a staged copy, so a malformed
            // referenced row fails closed with zero state change.
            var staged = new RecordDraft
            {
              Id = d.Id, BoardId = d.BoardId, MeetingId = d.MeetingId, Version = d.Version,
              Watermark = newWm, ItemsJson = d.ItemsJson, Hash = d.Hash,
              ApprovedJson = d.ApprovedJson, DiscardedJson = d.DiscardedJson,
              ReviewRevision = d.ReviewRevision + 1, ReviewToken = newTokenF,
              HistoryJson = newHistoryF, SupersedesJson = d.SupersedesJson,
              EvidenceSnapshotJson = d.EvidenceSnapshotJson,
              Decided = d.Decided, Status = d.Status, CreatedAt = d.CreatedAt,
            };
            Dictionary<string, object?> payload;
            try { payload = RecordsOps.ReviewPayload(s, req, staged, meeting); }
            catch (Exception px) { return Results.Json(new { error = "Review payload failed before commit; no state changed (" + px.GetType().Name + ")." }, statusCode: 500); }
            d.Watermark = newWm;
            d.HistoryJson = newHistoryF;
            d.ReviewRevision++;
            d.ReviewToken = newTokenF;
            s.Drafts.Flush();
            pendingAudit = new AuditEvent { BoardId = d.BoardId, Action = "record.refresh", Detail = JsonSerializer.Serialize(new { draft = draftId, watermark = d.Watermark, revision = d.ReviewRevision }) };
            return Results.Ok(payload);
          });
        }
        catch (Exception) { return CommitFailed(); }
      }
      if (pendingAudit is not null) s.Audit.Add(pendingAudit);
      return result;
    });    IResult ItemApprove(InMemoryStore s, HttpRequest req, Guid draftId, JsonElement body)
    {
      AuditEvent? pendingAudit = null;
      IResult result;
      lock (s.MessageLock)
      {
        try
        {
          result = Atomic.Run(() =>
          {
            if (!s.Drafts.TryGetValue(draftId, out var d) || d is null) return Results.NotFound();
            if (!s.Meetings.TryGetValue(d.MeetingId, out var meeting) || meeting is null) return Results.NotFound("meeting");
            if (PeopleOps.Check(s, req, d.BoardId, d.MeetingId, "manage") is { } deniedAuto2) return deniedAuto2;
            if (IsSuperseded(d))
              return Results.Json(new { error = "Review is superseded by a newer version; use the successor." }, statusCode: 409);
            if (d.Decided)
              return Results.Json(new { error = "Review is already decided; refresh review." }, statusCode: 409);
            if (!RecordsOps.StrictStateCheck(s, d, out var serr))
              return Results.Json(new { error = serr }, statusCode: 422);
            if (!RecordsOps.CheckGuard(body, d, meeting, out var gs, out var ge))
              return Results.Json(new { error = ge }, statusCode: gs);
            if (!RecordsOps.CheckApprovalAuthority(s, d, out var authErr))
              return Results.Json(new { error = authErr }, statusCode: 409);
            string itemId = "";
            if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("itemId", out var iv) && iv.ValueKind == JsonValueKind.String)
              itemId = (iv.GetString() ?? "").Trim();
            if (string.IsNullOrWhiteSpace(itemId)) return Results.BadRequest("itemId is required.");
            var map = RecordsOps.ItemMap(d.ItemsJson, out var mapErr);
            if (mapErr != "") return Results.Json(new { error = mapErr }, statusCode: 422);
            if (!map.ContainsKey(itemId)) return Results.Json(new { error = "Unknown item id '" + itemId + "'." }, statusCode: 422);
            RecordsOps.TryStrictIdList(d.ApprovedJson, out var apList, out _);
            RecordsOps.TryStrictIdList(d.DiscardedJson, out var dcList, out _);
            var ap = new HashSet<string>(apList, StringComparer.Ordinal);
            var dc = new HashSet<string>(dcList, StringComparer.Ordinal);
            if (ap.Contains(itemId) || dc.Contains(itemId))
              return Results.Conflict("Item '" + itemId + "' is already decided; refresh review.");
            var actor = ActorOf(s, req);
            var viewedV = d.Version; var viewedH = d.Hash; var viewedW = d.Watermark; var viewedT = d.ReviewToken;
            var newAp = new HashSet<string>(ap, StringComparer.Ordinal);
            newAp.Add(itemId);
            var newToken = RecordsOps.NewReviewToken();
            if (!RecordsOps.TryBuildHistoryJson(d.HistoryJson, "approve", itemId, "", RecordsOps.ItemText(map[itemId]), actor, viewedV, viewedH, viewedW, viewedT, d.ReviewRevision + 1, newToken, out var newHistory, out var herr))
              return Results.Json(new { error = herr }, statusCode: 422);
            var cards = RecordsOps.ResolveEvidenceAuthorized(s, req, d);
            if (!RecordsOps.TryBuildSnapshots(d.EvidenceSnapshotJson, map, cards, new[] { itemId }, d.ReviewRevision + 1, out var newSnaps, out var snerr))
              return Results.Json(new { error = snerr }, statusCode: 422);
            d.ApprovedJson = RecordsOps.ToIdList(newAp.OrderBy(x => x, StringComparer.Ordinal));
            d.HistoryJson = newHistory;
            d.EvidenceSnapshotJson = newSnaps;
            d.ReviewRevision++;
            d.ReviewToken = newToken;
            RecordsOps.RefreshDecided(d);
            s.Drafts.Flush();
            pendingAudit = new AuditEvent { BoardId = d.BoardId, Action = "record.item.approve", Detail = JsonSerializer.Serialize(new { draft = draftId, item = itemId, revision = d.ReviewRevision }) };
            return Results.Ok(RecordsOps.SafeDraft(d));
          });
        }
        catch (Exception) { return CommitFailed(); }
      }
      if (pendingAudit is not null) s.Audit.Add(pendingAudit);
      return result;
    }

    app.MapPost("/api/records/{draftId:guid}/items/approve", (InMemoryStore s, HttpRequest req, Guid draftId, JsonElement body) =>
      ItemApprove(s, req, draftId, body));

    app.MapPost("/api/records/{draftId:guid}/approve-all", (InMemoryStore s, HttpRequest req, Guid draftId, JsonElement body) =>
    {
      AuditEvent? pendingAudit = null;
      IResult result;
      lock (s.MessageLock)
      {
        try
        {
          result = Atomic.Run(() =>
          {
            if (!s.Drafts.TryGetValue(draftId, out var d) || d is null) return Results.NotFound();
            if (!s.Meetings.TryGetValue(d.MeetingId, out var meeting) || meeting is null) return Results.NotFound("meeting");
            if (PeopleOps.Check(s, req, d.BoardId, d.MeetingId, "manage") is { } deniedAuto3) return deniedAuto3;
            if (IsSuperseded(d))
              return Results.Json(new { error = "Review is superseded by a newer version; use the successor." }, statusCode: 409);
            if (d.Decided)
              return Results.Json(new { error = "Review is already decided; refresh review." }, statusCode: 409);
            if (!RecordsOps.StrictStateCheck(s, d, out var serr))
              return Results.Json(new { error = serr }, statusCode: 422);
            if (!RecordsOps.CheckGuard(body, d, meeting, out var gs, out var ge))
              return Results.Json(new { error = ge }, statusCode: gs);
            if (!RecordsOps.CheckApprovalAuthority(s, d, out var authErrAll))
              return Results.Json(new { error = authErrAll }, statusCode: 409);
            var map = RecordsOps.ItemMap(d.ItemsJson, out var mapErr);
            if (mapErr != "") return Results.Json(new { error = mapErr }, statusCode: 422);
            RecordsOps.TryStrictIdList(d.ApprovedJson, out var apList, out _);
            RecordsOps.TryStrictIdList(d.DiscardedJson, out var dcList, out _);
            var ap = new HashSet<string>(apList, StringComparer.Ordinal);
            var dc = new HashSet<string>(dcList, StringComparer.Ordinal);
            var pending = map.Keys.Where(k => !ap.Contains(k) && !dc.Contains(k)).OrderBy(k => k, StringComparer.Ordinal).ToList();
            if (pending.Count == 0) return Results.Conflict("No pending items; review is already fully decided.");
            var actor = ActorOf(s, req);
            var viewedV = d.Version; var viewedH = d.Hash; var viewedW = d.Watermark; var viewedT = d.ReviewToken;
            var newApAll = new HashSet<string>(ap, StringComparer.Ordinal);
            foreach (var p in pending) newApAll.Add(p);
            var newTokenAll = RecordsOps.NewReviewToken();
            var stagedHistory = d.HistoryJson;
            foreach (var p in pending)
            {
              if (!RecordsOps.TryBuildHistoryJson(stagedHistory, "approve", p, "", map.TryGetValue(p, out var el) ? RecordsOps.ItemText(el) : "", actor, viewedV, viewedH, viewedW, viewedT, d.ReviewRevision + 1, newTokenAll, out var stagedNext, out var herr))
                return Results.Json(new { error = herr }, statusCode: 422);
              stagedHistory = stagedNext;
            }
            var cards = RecordsOps.ResolveEvidenceAuthorized(s, req, d);
            if (!RecordsOps.TryBuildSnapshots(d.EvidenceSnapshotJson, map, cards, pending, d.ReviewRevision + 1, out var newSnapsAll, out var snerr))
              return Results.Json(new { error = snerr }, statusCode: 422);
            d.ApprovedJson = RecordsOps.ToIdList(newApAll.OrderBy(x => x, StringComparer.Ordinal));
            d.HistoryJson = stagedHistory;
            d.EvidenceSnapshotJson = newSnapsAll;
            d.ReviewRevision++;
            d.ReviewToken = newTokenAll;
            RecordsOps.RefreshDecided(d);
            s.Drafts.Flush();
            pendingAudit = new AuditEvent { BoardId = d.BoardId, Action = "record.approve-all", Detail = JsonSerializer.Serialize(new { draft = draftId, items = pending }) };
            return Results.Ok(RecordsOps.SafeDraft(d));
          });
        }
        catch (Exception) { return CommitFailed(); }
      }
      if (pendingAudit is not null) s.Audit.Add(pendingAudit);
      return result;
    });    app.MapPost("/api/records/{draftId:guid}/items/revise", (InMemoryStore s, HttpRequest req, Guid draftId, JsonElement body) =>
    {
      AuditEvent? pendingAudit = null;
      IResult result;
      lock (s.MessageLock)
      {
        try
        {
          result = Atomic.Run(() =>
          {
            if (!s.Drafts.TryGetValue(draftId, out var d) || d is null) return Results.NotFound();
            if (!s.Meetings.TryGetValue(d.MeetingId, out var meeting) || meeting is null) return Results.NotFound("meeting");
            if (PeopleOps.Check(s, req, d.BoardId, d.MeetingId, "contribute") is { } deniedAuto4) return deniedAuto4;
            if (IsSuperseded(d))
              return Results.Json(new { error = "Review is superseded by a newer version; use the successor." }, statusCode: 409);
            if (d.Decided)
              return Results.Json(new { error = "Review is already decided; refresh review." }, statusCode: 409);
            if (!RecordsOps.StrictStateCheck(s, d, out var serr))
              return Results.Json(new { error = serr }, statusCode: 422);
            if (!RecordsOps.CheckGuard(body, d, meeting, out var gs, out var ge))
              return Results.Json(new { error = ge }, statusCode: gs);
            string itemId = "";
            if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("itemId", out var iv) && iv.ValueKind == JsonValueKind.String)
              itemId = (iv.GetString() ?? "").Trim();
            string text = "";
            if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("text", out var tv) && tv.ValueKind == JsonValueKind.String)
              text = tv.GetString() ?? "";
            if (string.IsNullOrWhiteSpace(itemId)) return Results.BadRequest("itemId is required.");
            if (string.IsNullOrWhiteSpace(text)) return Results.Json(new { error = "Revised text must be non-empty plain text." }, statusCode: 422);
            if (text.Length > 8000) return Results.Json(new { error = "Revised text exceeds 8000 characters." }, statusCode: 422);
            var map = RecordsOps.ItemMap(d.ItemsJson, out var mapErr);
            if (mapErr != "") return Results.Json(new { error = mapErr }, statusCode: 422);
            if (!map.ContainsKey(itemId)) return Results.Json(new { error = "Unknown item id '" + itemId + "'." }, statusCode: 422);
            RecordsOps.TryStrictIdList(d.ApprovedJson, out var apList, out _);
            RecordsOps.TryStrictIdList(d.DiscardedJson, out var dcList, out _);
            var ap = new HashSet<string>(apList, StringComparer.Ordinal);
            var dc = new HashSet<string>(dcList, StringComparer.Ordinal);
            if (ap.Contains(itemId)) return Results.Conflict("Item '" + itemId + "' is approved and immutable; use the explicit amendment flow to change it.");
            if (dc.Contains(itemId)) return Results.Conflict("Item '" + itemId + "' is already decided; refresh review.");
            var oldText = RecordsOps.ItemText(map[itemId]);
            var actor = ActorOf(s, req);
            var viewedV = d.Version; var viewedH = d.Hash; var viewedW = d.Watermark; var viewedT = d.ReviewToken;
            var newTokenR = RecordsOps.NewReviewToken();
            using var doc = JsonDocument.Parse(d.ItemsJson);
            var arr = new List<Dictionary<string, object?>>();
            foreach (var el in doc.RootElement.EnumerateArray())
            {
              var dict = new Dictionary<string, object?>(StringComparer.Ordinal);
              foreach (var p in el.EnumerateObject())
              {
                if (p.NameEquals("text") && string.Equals(el.TryGetProperty("id", out var idv) ? (idv.GetString() ?? "") : "", itemId, StringComparison.Ordinal))
                  dict[p.Name] = text;
                else dict[p.Name] = JsonToObj(p.Value);
              }
              arr.Add(dict);
            }
            var web = new JsonSerializerOptions(JsonSerializerDefaults.Web);
            var newItemsJson = JsonSerializer.Serialize(arr, web);
            var newHash = Hashing.HashOf(newItemsJson);
            if (!RecordsOps.TryBuildHistoryJson(d.HistoryJson, "revise", itemId, oldText, text, actor, viewedV, viewedH, viewedW, viewedT, d.ReviewRevision + 1, newTokenR, out var newHistoryR, out var herr))
              return Results.Json(new { error = herr }, statusCode: 422);
            d.ItemsJson = newItemsJson;
            d.Hash = newHash;
            d.HistoryJson = newHistoryR;
            d.ReviewRevision++;
            d.ReviewToken = newTokenR;
            RecordsOps.RefreshDecided(d);
            s.Drafts.Flush();
            pendingAudit = new AuditEvent { BoardId = d.BoardId, Action = "record.item.revise", Detail = JsonSerializer.Serialize(new { draft = draftId, item = itemId }) };
            return Results.Ok(RecordsOps.SafeDraft(d));
          });
        }
        catch (Exception) { return CommitFailed(); }
      }
      if (pendingAudit is not null) s.Audit.Add(pendingAudit);
      return result;
    });

    app.MapPost("/api/records/{draftId:guid}/items/discard", (InMemoryStore s, HttpRequest req, Guid draftId, JsonElement body) =>
    {
      AuditEvent? pendingAudit = null;
      IResult result;
      lock (s.MessageLock)
      {
        try
        {
          result = Atomic.Run(() =>
          {
            if (!s.Drafts.TryGetValue(draftId, out var d) || d is null) return Results.NotFound();
            if (!s.Meetings.TryGetValue(d.MeetingId, out var meeting) || meeting is null) return Results.NotFound("meeting");
            if (PeopleOps.Check(s, req, d.BoardId, d.MeetingId, "contribute") is { } deniedAuto5) return deniedAuto5;
            if (IsSuperseded(d))
              return Results.Json(new { error = "Review is superseded by a newer version; use the successor." }, statusCode: 409);
            if (d.Decided)
              return Results.Json(new { error = "Review is already decided; refresh review." }, statusCode: 409);
            if (!RecordsOps.StrictStateCheck(s, d, out var serr))
              return Results.Json(new { error = serr }, statusCode: 422);
            if (!RecordsOps.CheckGuard(body, d, meeting, out var gs, out var ge))
              return Results.Json(new { error = ge }, statusCode: gs);
            string itemId = "";
            if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("itemId", out var iv) && iv.ValueKind == JsonValueKind.String)
              itemId = (iv.GetString() ?? "").Trim();
            if (string.IsNullOrWhiteSpace(itemId)) return Results.BadRequest("itemId is required.");
            var map = RecordsOps.ItemMap(d.ItemsJson, out var mapErr);
            if (mapErr != "") return Results.Json(new { error = mapErr }, statusCode: 422);
            if (!map.ContainsKey(itemId)) return Results.Json(new { error = "Unknown item id '" + itemId + "'." }, statusCode: 422);
            RecordsOps.TryStrictIdList(d.ApprovedJson, out var apList, out _);
            RecordsOps.TryStrictIdList(d.DiscardedJson, out var dcList, out _);
            var ap = new HashSet<string>(apList, StringComparer.Ordinal);
            var dc = new HashSet<string>(dcList, StringComparer.Ordinal);
            if (ap.Contains(itemId)) return Results.Conflict("Item '" + itemId + "' is approved and cannot be discarded; approved content is preserved.");
            if (dc.Contains(itemId)) return Results.Conflict("Item '" + itemId + "' is already decided; refresh review.");
            var actor = ActorOf(s, req);
            var viewedV = d.Version; var viewedH = d.Hash; var viewedW = d.Watermark; var viewedT = d.ReviewToken;
            var newDc = new HashSet<string>(dc, StringComparer.Ordinal);
            newDc.Add(itemId);
            var newTokenD = RecordsOps.NewReviewToken();
            if (!RecordsOps.TryBuildHistoryJson(d.HistoryJson, "discard", itemId, RecordsOps.ItemText(map[itemId]), "", actor, viewedV, viewedH, viewedW, viewedT, d.ReviewRevision + 1, newTokenD, out var newHistoryD, out var herr))
              return Results.Json(new { error = herr }, statusCode: 422);
            d.DiscardedJson = RecordsOps.ToIdList(newDc.OrderBy(x => x, StringComparer.Ordinal));
            d.HistoryJson = newHistoryD;
            d.ReviewRevision++;
            d.ReviewToken = newTokenD;
            RecordsOps.RefreshDecided(d);
            s.Drafts.Flush();
            pendingAudit = new AuditEvent { BoardId = d.BoardId, Action = "record.item.discard", Detail = JsonSerializer.Serialize(new { draft = draftId, item = itemId }) };
            return Results.Ok(RecordsOps.SafeDraft(d));
          });
        }
        catch (Exception) { return CommitFailed(); }
      }
      if (pendingAudit is not null) s.Audit.Add(pendingAudit);
      return result;
    });    IResult NewVersion(InMemoryStore s, HttpRequest req, Guid draftId, JsonElement body, string[] extraSupersedes, bool amend)
    {
      AuditEvent? pendingAudit = null;
      IResult result;
      lock (s.MessageLock)
      {
        try
        {
          result = Atomic.Run(() =>
          {
            if (!s.Drafts.TryGetValue(draftId, out var old) || old is null) return Results.NotFound();
            if (!s.Meetings.TryGetValue(old.MeetingId, out var meeting) || meeting is null) return Results.NotFound("meeting");
            if (PeopleOps.Check(s, req, old.BoardId, old.MeetingId, "contribute") is { } deniedAuto6) return deniedAuto6;
            if (!RecordsOps.ValidateSupersedesChain(s, old, extraSupersedes, out var verr))
              return Results.Json(new { error = verr }, statusCode: 422);
            if (IsSuperseded(old))
              return Results.Json(new { error = "Review is superseded; branch from the current successor instead." }, statusCode: 409);
            if (!RecordsOps.CheckSingleOpenSuccessor(s, old, out var openErr))
              return Results.Json(new { error = openErr }, statusCode: 409);
            if (!amend && old.Decided) return Results.Conflict("Draft already decided; revise the current version instead.");
            if (amend && (!old.Decided || !string.Equals(old.Status, "approved", StringComparison.OrdinalIgnoreCase)))
              return Results.Conflict("Only a final approved record can be amended; revise the current open version instead.");
            if (!RecordsOps.StrictStateCheck(s, old, out var serr))
              return Results.Json(new { error = serr }, statusCode: 422);
            if (!RecordsOps.CheckGuard(body, old, meeting, out var gs, out var ge))
              return Results.Json(new { error = ge }, statusCode: gs);

            if (!amend)
            {
              var decidedCount = RecordsOps.ParseIdList(old.ApprovedJson).Count + RecordsOps.ParseIdList(old.DiscardedJson).Count;
              if (decidedCount > 0)
                return Results.Json(new { error = "This review already has per-item decisions; revise remaining pending items individually or amend approved items instead of rewriting the whole draft." }, statusCode: 409);
            }
            if (RecordsOps.HasApprovedSuccessor(s, old))
              return Results.Json(new { error = "An approved successor already carries this line forward; continue on the authoritative head instead." }, statusCode: 409);

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
            var actor = ActorOf(s, req);
            var parentViewedT = old.ReviewToken;
            var parentViewedV = old.Version; var parentViewedH = old.Hash; var parentViewedW = old.Watermark;
            var next = new RecordDraft
            {
              BoardId = old.BoardId, MeetingId = old.MeetingId,
              Version = old.Version + 1, Watermark = meeting.DeliveredRevision,
              ItemsJson = items, Hash = Hashing.HashOf(items),
              ApprovedJson = "[]", DiscardedJson = "[]",
              ReviewRevision = 1, ReviewToken = RecordsOps.NewReviewToken(),
              HistoryJson = "[]", EvidenceSnapshotJson = "[]",
              SupersedesJson = JsonSerializer.Serialize(SupersedesOf(old, extraSupersedes)),
            };
            RecordsOps.AppendHistory(next, amend ? "amend-branch" : "revise-branch", "", old.ItemsJson, items, actor);
            var newOldToken = RecordsOps.NewReviewToken();
            if (!RecordsOps.TryBuildHistoryJson(old.HistoryJson, amend ? "amend-child" : "revise-child", "", old.ItemsJson, items, actor, parentViewedV, parentViewedH, parentViewedW, parentViewedT, old.ReviewRevision + 1, newOldToken, out var newOldHistory, out var pherr))
              return Results.Json(new { error = pherr }, statusCode: 422);
            if (!amend)
            {
              old.Decided = true;
              old.Status = "superseded";
            }
            old.HistoryJson = newOldHistory;
            old.ReviewToken = newOldToken;
            old.ReviewRevision++;
            if (!amend) RecordsOps.RefreshDecided(old);
            s.Drafts[next.Id] = next;
            s.Drafts.Flush();
            pendingAudit = new AuditEvent { BoardId = old.BoardId, Action = amend ? "record.amend" : "record.revise", Detail = JsonSerializer.Serialize(new { from = draftId, to = next.Id, version = next.Version }) };
            return Results.Created("/api/records/" + next.Id, RecordsOps.SafeDraft(next));
          });
        }
        catch (Exception) { return CommitFailed(); }
      }
      if (pendingAudit is not null) s.Audit.Add(pendingAudit);
      return result;
    }

    app.MapPost("/api/records/{draftId:guid}/revise", (InMemoryStore s, HttpRequest req, Guid draftId, JsonElement body) =>
    {
      RecordDraft? pre;
      lock (s.MessageLock) { s.Drafts.TryGetValue(draftId, out pre); }
      if (pre is not null && pre.Decided) return Results.Conflict("Draft already decided; revise the current version instead.");
      return NewVersion(s, req, draftId, body, Array.Empty<string>(), amend: false);
    });

    app.MapPost("/api/records/{draftId:guid}/amend", (InMemoryStore s, HttpRequest req, Guid draftId, JsonElement body) =>
    {
      var extra = body.ValueKind == JsonValueKind.Object && body.TryGetProperty("supersedes", out var se) && se.ValueKind == JsonValueKind.Array
        ? se.EnumerateArray().Select(e => e.ValueKind == JsonValueKind.String ? (e.GetString() ?? "") : "").Where(x => x != "").ToArray()
        : Array.Empty<string>();
      return NewVersion(s, req, draftId, body, extra, amend: true);
    });    app.MapPost("/api/records/{draftId:guid}/discard", (InMemoryStore s, HttpRequest req, Guid draftId, JsonElement body) =>
    {
      AuditEvent? pendingAudit = null;
      IResult result;
      lock (s.MessageLock)
      {
        try
        {
          result = Atomic.Run(() =>
          {
            if (!s.Drafts.TryGetValue(draftId, out var d) || d is null) return Results.NotFound();
            if (!s.Meetings.TryGetValue(d.MeetingId, out var meeting) || meeting is null) return Results.NotFound("meeting");
            if (PeopleOps.Check(s, req, d.BoardId, d.MeetingId, "contribute") is { } deniedAuto7) return deniedAuto7;
            if (IsSuperseded(d))
              return Results.Json(new { error = "Review is superseded by a newer version." }, statusCode: 409);
            if (d.Decided) return Results.Conflict("Draft already decided; revise the current version instead.");
            if (!RecordsOps.StrictStateCheck(s, d, out var serr))
              return Results.Json(new { error = serr }, statusCode: 422);
            if (!RecordsOps.CheckGuard(body, d, meeting, out var gs, out var ge))
              return Results.Json(new { error = ge }, statusCode: gs);
            RecordsOps.TryStrictIdList(d.ApprovedJson, out var apList, out _);
            var approved = apList;
            var map = RecordsOps.ItemMap(d.ItemsJson, out var mapErr);
            if (mapErr != "") return Results.Json(new { error = mapErr }, statusCode: 422);
            RecordsOps.TryStrictIdList(d.DiscardedJson, out var dcList, out _);
            var pending = map.Keys.Where(k => !apList.Contains(k, StringComparer.Ordinal) && !dcList.Contains(k, StringComparer.Ordinal)).OrderBy(k => k, StringComparer.Ordinal).ToList();
            var actor = ActorOf(s, req);
            var viewedV = d.Version; var viewedH = d.Hash; var viewedW = d.Watermark; var viewedT = d.ReviewToken;
            var newDcAll = new HashSet<string>(dcList, StringComparer.Ordinal);
            foreach (var p in pending) newDcAll.Add(p);
            var newTokenAll = RecordsOps.NewReviewToken();
            var stagedHistAll = d.HistoryJson;
            foreach (var p in pending)
            {
              if (!RecordsOps.TryBuildHistoryJson(stagedHistAll, "discard", p, "", "", actor, viewedV, viewedH, viewedW, viewedT, d.ReviewRevision + 1, newTokenAll, out var stagedNextAll, out var herr))
                return Results.Json(new { error = herr }, statusCode: 422);
              stagedHistAll = stagedNextAll;
            }
            if (approved.Count > 0)
            {
              if (!RecordsOps.TryBuildHistoryJson(stagedHistAll, "discard-remaining", "", "", "", actor, viewedV, viewedH, viewedW, viewedT, d.ReviewRevision + 1, newTokenAll, out var stagedFinalAll, out var herr2))
                return Results.Json(new { error = herr2 }, statusCode: 422);
              stagedHistAll = stagedFinalAll;
            }
            d.DiscardedJson = RecordsOps.ToIdList(newDcAll.OrderBy(x => x, StringComparer.Ordinal));
            d.HistoryJson = stagedHistAll;
            d.ReviewRevision++;
            d.ReviewToken = newTokenAll;
            RecordsOps.RefreshDecided(d);
            s.Drafts.Flush();
            pendingAudit = new AuditEvent { BoardId = d.BoardId, Action = "record.discard", Detail = JsonSerializer.Serialize(new { draft = draftId, preserved = approved.Count }) };
            return Results.Ok(RecordsOps.SafeDraft(d));
          });
        }
        catch (Exception) { return CommitFailed(); }
      }
      if (pendingAudit is not null) s.Audit.Add(pendingAudit);
      return result;
    });

    app.MapGet("/api/records/{draftId:guid}/export", (InMemoryStore s, HttpRequest req, Guid draftId, string format = "concise") =>
    {
      if (!s.Drafts.TryGetValue(draftId, out var d)) return Results.NotFound();
      if (PeopleOps.Check(s, req, d.BoardId, d.MeetingId, "read") is { } deniedAuto8) return deniedAuto8;
      var approved = RecordsOps.ParseIdList(d.ApprovedJson);
      if (approved.Count == 0)
      {
        if (string.Equals(d.Status, "discarded", StringComparison.OrdinalIgnoreCase))
          return Results.Conflict("Draft discarded; conversation preserved, nothing to export.");
        return Results.Conflict("Nothing approved to export.");
      }
      var text = RecordsOps.BuildExport(d.ItemsJson, d.ApprovedJson, format == "detailed");
      if (string.IsNullOrWhiteSpace(text)) return Results.Conflict("Nothing approved to export.");
      return Results.Text(text, "text/plain");
    });
  }

  private static object? JsonToObj(JsonElement v)
  {
    return v.ValueKind switch
    {
      JsonValueKind.String => v.GetString(),
      JsonValueKind.Number => v.TryGetInt64(out var l) ? (object)l : v.GetDouble(),
      JsonValueKind.True => true,
      JsonValueKind.False => false,
      JsonValueKind.Null => null,
      JsonValueKind.Array => v.EnumerateArray().Select(JsonToObj).ToList(),
      _ => v.Clone(),
    };
  }
}
