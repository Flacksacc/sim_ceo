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

  // Shared actual-consumer ref/scalar validation (F6): BOTH export modes and the resolver reject the same
  // malformed ref shapes. Non-array refs, non-object entries, and numeric kind/ref/id/version properties
  // fail closed with no failopen partial render. Semantic validity (unknown kinds, fractional versions,
  // stale pins) stays with EvidenceRef.Parse and the resolver; stored bytes are never erased.
  public static bool RefScalarsValid(JsonElement refs, out string error)
  {
    error = "";
    if (refs.ValueKind != JsonValueKind.Array) { error = "refs must be an array."; return false; }
    foreach (var r in refs.EnumerateArray())
    {
      if (r.ValueKind != JsonValueKind.Object) { error = "ref must be an object."; return false; }
      if (r.TryGetProperty("kind", out var rk) && rk.ValueKind != JsonValueKind.String && rk.ValueKind != JsonValueKind.Null) { error = "ref kind must be a string."; return false; }
      if (r.TryGetProperty("ref", out var rr) && rr.ValueKind != JsonValueKind.String && rr.ValueKind != JsonValueKind.Null) { error = "ref ref must be a string."; return false; }
      if (r.TryGetProperty("id", out var ri) && ri.ValueKind != JsonValueKind.String && ri.ValueKind != JsonValueKind.Null) { error = "ref id must be a string."; return false; }
      if (r.TryGetProperty("version", out var rv) && rv.ValueKind != JsonValueKind.Number && rv.ValueKind != JsonValueKind.Null) { error = "ref version must be a number."; return false; }
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
    catch (InvalidOperationException) { return ""; }
    using (items) using (approved)
    {
    try
    {
    if (items.RootElement.ValueKind != JsonValueKind.Array || approved.RootElement.ValueKind != JsonValueKind.Array) return "";
    // Typed consumers: approved entries must be strings; numeric ids fail closed (no failopen partial export).
    var ok = new HashSet<string>(StringComparer.Ordinal);
    foreach (var e in approved.RootElement.EnumerateArray())
    {
      if (e.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(e.GetString())) return "";
      ok.Add(e.GetString()!);
    }
    // Whole-graph field validation BEFORE any render decision (F6): every item (approved or not) must
    // carry well-typed id/text/detail/status/scope and well-typed ref scalars. A malformed UNAPPROVED item
    // fails the whole export closed instead of being silently skipped. Stored bytes are never erased.
    foreach (var el in items.RootElement.EnumerateArray())
    {
      if (el.ValueKind != JsonValueKind.Object) return "";
      if (!el.TryGetProperty("id", out var pi) || pi.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(pi.GetString())) return "";
      if (!el.TryGetProperty("text", out var ptx) || ptx.ValueKind != JsonValueKind.String) return "";
      foreach (var opt in new[] { "detail", "status", "scope" })
      {
        if (el.TryGetProperty(opt, out var pov) && pov.ValueKind != JsonValueKind.String) return "";
      }
      if (el.TryGetProperty("refs", out var prf) && !RefScalarsValid(prf, out _)) return "";
    }
    var sb = new StringBuilder();
    foreach (var el in items.RootElement.EnumerateArray())
    {
      if (el.ValueKind != JsonValueKind.Object) return "";
      if (!el.TryGetProperty("id", out var i) || i.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(i.GetString())) return "";
      var id = i.GetString() ?? "";
      if (!ok.Contains(id)) continue;
      if (!el.TryGetProperty("text", out var t) || t.ValueKind != JsonValueKind.String) return "";
      var text = t.GetString() ?? "";
      sb.AppendLine("- [" + id + "] " + text);
      if (detailed)
      {
        foreach (var opt in new[] { "detail", "status", "scope" })
        {
          if (el.TryGetProperty(opt, out var ov) && ov.ValueKind != JsonValueKind.String) return "";
        }
        if (el.TryGetProperty("detail", out var d) && d.ValueKind == JsonValueKind.String && d.GetString() is { } detail) sb.AppendLine("  detail: " + detail);
        if (el.TryGetProperty("status", out var st) && st.ValueKind == JsonValueKind.String && st.GetString() is { } status) sb.AppendLine("  status: " + status);
        if (el.TryGetProperty("scope", out var sc) && sc.ValueKind == JsonValueKind.String && sc.GetString() is { } scope) sb.AppendLine("  scope: " + scope);
        if (el.TryGetProperty("refs", out var rf))
        {
          if (!RefScalarsValid(rf, out _)) return "";
          var bits = new List<string>();
          foreach (var r in rf.EnumerateArray())
          {
            if (EvidenceRef.Parse(r) is { } er) bits.Add(er.Kind + ":" + er.Ref);
          }
          if (bits.Count > 0) sb.AppendLine("  refs: " + string.Join(", ", bits));
        }
      }
      else
      {
        // Non-detailed reads enforce the SAME shared ref/scalar gate as detailed reads (F6, no failopen):
        // numeric kind/ref/id/version properties fail the whole export closed.
        if (el.TryGetProperty("refs", out var rf2) && !RefScalarsValid(rf2, out _)) return "";
      }
    }
    return sb.ToString();
    }
    catch (InvalidOperationException) { return ""; }
    catch (JsonException) { return ""; }
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
    // Strict readability: every element must be an object with string id/text.
    // Malformed (numeric/missing) items fail closed to unavailable cards and
    // never reach BuildExport failopen. Legacy healthy arrays still pass.
    try
    {
      using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(itemsJson) ? "[]" : itemsJson);
      if (doc.RootElement.ValueKind != JsonValueKind.Array) return false;
      foreach (var el in doc.RootElement.EnumerateArray())
      {
        if (el.ValueKind != JsonValueKind.Object) return false;
        if (!el.TryGetProperty("id", out var iv) || iv.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(iv.GetString())) return false;
        if (!el.TryGetProperty("text", out var tv) || tv.ValueKind != JsonValueKind.String) return false;
      }
      return true;
    }
    catch (JsonException) { return false; }
    catch (InvalidOperationException) { return false; }
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
      { error = "Decision history field `" + name + "` must be a string."; return false; }
    // Actor/item identity is typed AND required: builders always emit a
    // non-empty actor and a string itemId (empty for non-item actions).
    // Missing/numeric actor or non-string itemId proves foreign or corrupt
    // state and fails closed. Reads stay lenient; mutations prewrite-fail.
    if (!e.TryGetProperty("actor", out var hac) || hac.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(hac.GetString()))
    { error = "Decision history entries must carry a non-empty string actor."; return false; }
    if (!e.TryGetProperty("itemId", out var hid) || hid.ValueKind != JsonValueKind.String)
    { error = "Decision history entries must carry a string itemId."; return false; }
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
    // Supersedes PARENT correspondence: every persisted parent must exist in
    // the same board/meeting. Dangling or cross-scope parents fail closed on
    // mutation (reads stay lenient and surface explicit unavailable).
    foreach (var pid in SupersededIdSet(d))
    {
      if (!Guid.TryParse(pid, out var pg) || !s.Drafts.TryGetValue(pg, out var ptarget) || ptarget is null)
      { error = "Supersedes parent `" + pid + "` is missing; explicit repair required."; return false; }
      if (ptarget.BoardId != d.BoardId || ptarget.MeetingId != d.MeetingId)
      { error = "Supersedes parent belongs to another board or meeting; explicit repair required."; return false; }
    }
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
    // Snapshot/ref/approval correspondence (not just array shape): every
    // snapshot entry must name an existing draft item and a declared ref
    // (same kind+ref) on that item; duplicates fail closed. Reads stay
    // lenient; mutations prewrite-fail.
    try
    {
      var snaps = GetSnapshots(d);
      var seenSnap = new HashSet<string>(StringComparer.Ordinal);
      foreach (var sn in snaps)
      {
        if (!map.TryGetValue(sn.ItemId, out var snapItem))
        { error = "Evidence snapshot item `" + sn.ItemId + "` has no draft item; explicit repair required."; return false; }
        if (!seenSnap.Add(SnapshotKeyV(sn.ItemId, sn.Kind, sn.Ref, sn.Version)))
        { error = "Evidence snapshot entries duplicate an item/ref/version; explicit repair required."; return false; }
        var hasRef = false;
        if (snapItem.TryGetProperty("refs", out var snapRefs) && snapRefs.ValueKind == JsonValueKind.Array)
        {
          foreach (var r in snapRefs.EnumerateArray())
          {
            var pr = EvidenceRef.Parse(r);
            if (pr is null) continue;
            if (string.Equals(pr.Kind, sn.Kind, StringComparison.OrdinalIgnoreCase) && string.Equals(pr.Ref, sn.Ref, StringComparison.Ordinal)) { hasRef = true; break; }
          }
        }
        if (!hasRef)
        { error = "Evidence snapshot ref `" + sn.Kind + ":" + sn.Ref + "` has no declared item ref; explicit repair required."; return false; }
      }
    }
    catch (Exception)
    { error = "Evidence snapshot correspondence unreadable; explicit repair required."; return false; }
    if (string.IsNullOrWhiteSpace(d.ReviewToken)) { error = "Review state uninitialized; explicit repair required."; return false; }
    // Revision relationship: a non-empty history must end at the drafts current revision/token (shared tip check).
    if (!HistoryTipMatches(d, out var tipErr)) { error = tipErr; return false; }
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

  // Final revision/token correspondence (shared): a non-empty history must end at the row's current
  // revision/token. A foreign or rolled-back history that no longer matches the row it is attached to
  // fails closed instead of approving under stale guards. Empty histories carry no tip to compare.
  public static bool HistoryTipMatches(RecordDraft d, out string error)
  {
    error = "";
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

  // Actor/item-action correspondence (shared): approve/discard/revise entries must name an item that the
  // row actually carries in the matching decision set; branch/refresh/create entries carry no item.
  // Unknown actions with an item fall back to item membership; unknown actions without one are allowed.
  public static bool HistoryActionCheck(RecordDraft d, Dictionary<string, JsonElement> map, HashSet<string> approved, HashSet<string> discarded, out string error)
  {
    error = "";
    try
    {
      using var hdoc = JsonDocument.Parse(string.IsNullOrWhiteSpace(d.HistoryJson) ? "[]" : d.HistoryJson);
      if (hdoc.RootElement.ValueKind != JsonValueKind.Array) { error = "Decision history is malformed; explicit repair required."; return false; }
      foreach (var e in hdoc.RootElement.EnumerateArray())
      {
        var action = e.TryGetProperty("action", out var av) && av.ValueKind == JsonValueKind.String ? (av.GetString() ?? "") : "";
        var item = e.TryGetProperty("itemId", out var iv) && iv.ValueKind == JsonValueKind.String ? (iv.GetString() ?? "") : "";
        var a = (action ?? "").Trim().ToLowerInvariant();
        if (a == "approve")
        {
          if (string.IsNullOrWhiteSpace(item)) { error = "Decision history approve entry names no item; explicit repair required."; return false; }
          if (!approved.Contains(item)) { error = "Decision history approve entry names item outside the approved set; explicit repair required."; return false; }
        }
        else if (a == "discard")
        {
          if (string.IsNullOrWhiteSpace(item)) { error = "Decision history discard entry names no item; explicit repair required."; return false; }
          if (!discarded.Contains(item)) { error = "Decision history discard entry names item outside the discarded set; explicit repair required."; return false; }
        }
        else if (a == "revise")
        {
          if (string.IsNullOrWhiteSpace(item)) { error = "Decision history revise entry names no item; explicit repair required."; return false; }
          if (!map.ContainsKey(item)) { error = "Decision history revise entry names an item with no draft item; explicit repair required."; return false; }
        }
        else if (!string.IsNullOrWhiteSpace(item) && !map.ContainsKey(item))
        { error = "Decision history entry names an item with no draft item; explicit repair required."; return false; }
      }
    }
    catch (JsonException) { error = "Decision history is malformed; explicit repair required."; return false; }
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
  }
  // Snapshot-graph correspondence for restore validation (F2): every snapshot entry must name an existing
  // draft item carrying a DECLARED ref with the same kind+ref, at most ONE entry per item/ref/version, and no
  // same-target different-version duplicates. Entries must sit on approved items and carry bytes when marked
  // available; a requested version pin must equal the entry version or a genuine original-version source alias
  // (requested1/resolved3 valid, unrelated999 rejected). Reads stay lenient; replace-time validation is strict.
  public static bool SnapshotRestoreCheck(Dictionary<string, JsonElement> map, HashSet<string> approved,
    List<EvidenceSnapshot> snaps, IDictionary<string, int>? sourceOriginalOf, out string error)
  {
    error = "";
    var seenKey = new HashSet<string>(StringComparer.Ordinal);
    var seenTarget = new Dictionary<string, int>(StringComparer.Ordinal);
    foreach (var sn in snaps)
    {
      if (!map.TryGetValue(sn.ItemId, out var item))
      { error = "Backup record snapshot item `" + sn.ItemId + "` has no draft item."; return false; }
      var vkey = SnapshotKeyV(sn.ItemId, sn.Kind, sn.Ref, sn.Version);
      if (!seenKey.Add(vkey))
      { error = "Backup record snapshot entries duplicate an item/ref/version."; return false; }
      var tkey = SnapshotKey(sn.ItemId, sn.Kind.ToLowerInvariant(), sn.Ref);
      if (seenTarget.TryGetValue(tkey, out var priorVer))
      {
        var curVer = sn.Version ?? -1;
        if (curVer != priorVer)
        { error = "Backup record snapshot captures two versions of one declared target; pin one version."; return false; }
      }
      else seenTarget[tkey] = sn.Version ?? -1;
      if (!approved.Contains(sn.ItemId))
      { error = "Backup record snapshot item `" + sn.ItemId + "` is not approved."; return false; }
      // Declared-ref correspondence: the item must actually declare this kind+ref.
      var hasRef = false;
      var declaredPins = new HashSet<int>();
      if (item.TryGetProperty("refs", out var srefs) && srefs.ValueKind == JsonValueKind.Array)
      {
        foreach (var r in srefs.EnumerateArray())
        {
          var pr = EvidenceRef.Parse(r);
          if (pr is null) continue;
          if (string.Equals(pr.Kind, sn.Kind, StringComparison.OrdinalIgnoreCase) && string.Equals(pr.Ref, sn.Ref, StringComparison.Ordinal))
          { hasRef = true; if (pr.Version.HasValue) declaredPins.Add(pr.Version.Value); }
        }
      }
      if (!hasRef)
      { error = "Backup record snapshot ref `" + sn.Kind + ":" + sn.Ref + "` has no declared item ref."; return false; }
      // Requested/version correspondence: unpinned declarations accept the captured version; pinned ones
      // must equal the entry version or a genuine same-source original-version alias.
      if (declaredPins.Count > 0 && !(sn.Version.HasValue && declaredPins.Contains(sn.Version.Value)))
      {
        var aliasOk = false;
        if (string.Equals(sn.Kind, "source", StringComparison.OrdinalIgnoreCase) && sourceOriginalOf is not null)
        {
          try
          {
            if (sourceOriginalOf.TryGetValue(sn.Ref, out var orig))
              foreach (var pin in declaredPins) if (pin == orig) { aliasOk = true; break; }
          }
          catch { aliasOk = false; }
        }
        if (!aliasOk)
        { error = "Backup record snapshot version does not match its declared requested version."; return false; }
      }
      if (sn.Available && string.IsNullOrWhiteSpace(sn.Title) && string.IsNullOrWhiteSpace(sn.Excerpt))
      { error = "Backup record available snapshot `" + sn.ItemId + "` carries no bytes."; return false; }
    }
    return true;
  }

  // Domain validator handoff for Ops restore (minimal, no Ops rewrite): Ops owner
  // calls this BEFORE any destructive replacement. Validates typed record graphs,
  // parent correspondence, and snapshot/ref/approval correspondence pre-mutation.
  // Returns an error string or null when valid.
  // Legacy readonly rows (blank review token AND blank history AND blank snapshots, e.g. genuine
  // pre-review v2 backups) are ACCEPTED with bytes preserved: they read/export readonly and every
  // mutation still fails closed until explicit repair. No approval history is fabricated and no
  // healthy old graph is blanket-rejected. Only malformed graphs fail here.
  // sourceOriginalOf maps a source id string to its ORIGINAL version (pre-renumber alias root).
  public static string ValidateRestoreEntries(IEnumerable<RecordDraft> drafts, IDictionary<string, int>? sourceOriginalOf = null)
  {
    var byId = new Dictionary<string, RecordDraft>(StringComparer.OrdinalIgnoreCase);
    foreach (var d in drafts)
    {
      if (d is null) return "Backup record draft is null.";
      if (d.Id == Guid.Empty || d.BoardId == Guid.Empty || d.MeetingId == Guid.Empty) return "Backup record draft missing lineage.";
      if (byId.ContainsKey(d.Id.ToString())) return "Backup record draft ids are not unique.";
      byId[d.Id.ToString()] = d;
    }
    foreach (var d in drafts)
    {
      if (d is null) return "Backup record draft is null.";
      var map = ItemMap(d.ItemsJson, out var mapErr);
      if (mapErr != "") return "Backup record draft items malformed (" + mapErr + ").";
      if (!TryStrictIdList(d.ApprovedJson, out var ap, out var ae)) return "Backup record draft ApprovedJson malformed (" + ae + ").";
      if (!TryStrictIdList(d.DiscardedJson, out var dc, out var de)) return "Backup record draft DiscardedJson malformed (" + de + ").";
      foreach (var id in ap) if (!map.ContainsKey(id)) return "Backup record draft approved id has no draft item.";
      foreach (var id in dc) if (!map.ContainsKey(id)) return "Backup record draft discarded id has no draft item.";
      var apSet = new HashSet<string>(ap, StringComparer.Ordinal);
      var dcSet = new HashSet<string>(dc, StringComparer.Ordinal);
      if (apSet.Overlaps(dcSet)) return "Backup record draft approved and discarded sets overlap.";
      if (!StrictSupersedesEntries(d.SupersedesJson, d.Id, out var serr)) return "Backup record draft supersedes malformed (" + serr + ").";
      foreach (var pid in SupersededIdSet(d))
      {
        if (!byId.TryGetValue(pid, out var pt) || pt is null) return "Backup record draft supersedes parent is missing.";
        if (pt.BoardId != d.BoardId || pt.MeetingId != d.MeetingId) return "Backup record draft supersedes parent crosses scope.";
      }
      // Supersedes CYCLE detection within the staged batch (A->B->A rejects before replace).
      try
      {
        var seenCyc = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var qcyc = new Queue<string>(SupersededIdSet(d));
        while (qcyc.Count > 0)
        {
          var xid = qcyc.Dequeue();
          if (string.Equals(xid, d.Id.ToString(), StringComparison.OrdinalIgnoreCase))
            return "Backup record draft supersedes chain is cyclic.";
          if (!seenCyc.Add(xid)) continue;
          if (byId.TryGetValue(xid, out var xdd) && xdd is not null)
            foreach (var xp in SupersededIdSet(xdd)) qcyc.Enqueue(xp);
        }
      }
      catch { return "Backup record draft supersedes chain unreadable."; }
      // Status/state coherence as actual consumers read it.
      var knownStatus = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "open", "partially-approved", "approved", "discarded", "superseded" };
      if (!string.IsNullOrWhiteSpace(d.Status) && !knownStatus.Contains(d.Status.Trim()))
        return "Backup record draft carries an unknown status.";
      if (d.Decided && apSet.Count == 0 && dcSet.Count == 0)
        return "Backup record draft decided with no decisions.";
      // Legacy readonly rule: blank token AND blank history AND blank snapshots = genuine pre-review row.
      // Bytes preserved, reads stay lenient, mutations stay closed. Anything partial is inconsistent.
      var histBlank = string.IsNullOrWhiteSpace(d.HistoryJson) || d.HistoryJson.Trim() == "[]";
      var tokenBlank = string.IsNullOrWhiteSpace(d.ReviewToken);
      var snapsBlank = string.IsNullOrWhiteSpace(d.EvidenceSnapshotJson) || d.EvidenceSnapshotJson.Trim() == "[]";
      if (histBlank && tokenBlank && snapsBlank) continue;
      if (tokenBlank) return "Backup record draft decision history without review token.";
      if (histBlank) return "Backup record draft review state without decision history.";
      if (!snapsBlank && (histBlank || tokenBlank)) return "Backup record draft snapshots without review state.";
      if (string.IsNullOrWhiteSpace(d.Hash)) return "Backup record draft review state without content hash.";
      if (!StrictHistoryEntries(d.HistoryJson, out var herr)) return "Backup record draft history malformed (" + herr + ").";
      if (!HistoryTipMatches(d, out var tipErr)) return "Backup record draft " + tipErr;
      if (!HistoryActionCheck(d, map, apSet, dcSet, out var actErr)) return "Backup record draft " + actErr;
      if (!StrictSnapshotEntries(d.EvidenceSnapshotJson, out var eerr)) return "Backup record draft snapshot malformed (" + eerr + ").";
      List<EvidenceSnapshot> snapList;
      try { snapList = GetSnapshots(d); }
      catch { return "Backup record snapshot correspondence unreadable."; }
      if (!SnapshotRestoreCheck(map, apSet, snapList, sourceOriginalOf, out var snapErr))
        return "Backup record " + snapErr;
    }
    return null;
  }
  
public static HashSet<string> SupersededIdSet(RecordDraft d)
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
    // Record refs: bare recordId (legacy whole-record) or explicit sourceRecordId:itemId (exact item
    // provenance). Malformed composites never fall back to whole-record: they authorize nothing.
    if (kind == "record")
    {
      if (!EvidenceRef.TryParseRecordRef(rf, out var rid, out _, out _)) return false;
      if (s.Drafts.TryGetValue(rid, out var rd) && rd is not null)
        return rd.BoardId == d.BoardId && PeopleOps.Can(s, req, rd.BoardId, rd.MeetingId, "read");
      return false;
    }
    if (kind == "message")
    {
      var parts = rf.Split((char)58);
      return parts.Length == 2 && Guid.TryParse(parts[0], out var mm) && mm == d.MeetingId;
    }
    if (kind == "dossier" && Guid.TryParse(rf, out var eid) && s.Roster.TryGetValue(eid, out var ent) && ent is not null)
    {
      // Stored snapshots must not bypass the current private/pending/unselected
      // roster projection via ANY non-removed board link. Require an eligible
      // link (approved board copy OR owner-owned entry, demo owner preserved)
      // AND current consumer permission via CanReadRoster (revocation/expiry
      // rechecked). Valid approved public advisors and the owner private case
      // still pass; private pending/unselected snapshots deny with no content.
      if (ent.Archived) return false;
      var links = s.Advisors.Values.Where(a => a.BoardId == d.BoardId && a.RosterEntryId == ent.Id && !a.Removed).ToList();
      if (links.Count == 0) return false;
      var me = PeopleOps.UserOf(s, req);
      var owned = !string.IsNullOrWhiteSpace(ent.OwnerKey) && string.Equals(ent.OwnerKey, me, StringComparison.OrdinalIgnoreCase);
      var demoOwner = !PeopleOps.IsSecure(s) && PeopleOps.IsOwner(req);
      var approvedLink = links.Any(a => a.Approved);
      if (!approvedLink && !owned && !demoOwner) return false;
      if (!RosterEndpoints.CanReadRoster(s, req, ent)) return false;
      return true;
    }
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
    // Per-referenced-record effective-chain cache: LIVE owner checks share one chain per record.
    var recordChains = new Dictionary<Guid, List<EffectiveView>>();
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
        else if (kind == "record")
        {
          // Explicit item refs (sourceRecordId:itemId) resolve the REFERENCED item at its historical exact version; bare recordIds (legacy) resolve the whole-record export. Ownership follows the referenced item, never the destination itemId. Malformed composites are unavailable, never whole-record.
          if (!EvidenceRef.TryParseRecordRef(rf, out var rid, out var recItemPart, out _)
            || !s.Drafts.TryGetValue(rid, out var rd) || rd is null)
          { cards.Add(Unavailable(itemId, kind, rf, parsed.Version)); }
          else
          {
            var okBoard = rd.BoardId == d.BoardId;
            var okAuth = okBoard && PeopleOps.Can(s, req, rd.BoardId, rd.MeetingId, "read");
            var okVersion = !parsed.Version.HasValue || parsed.Version.Value == rd.Version;
            var okState = ParseIdList(rd.ApprovedJson).Count > 0
              && !string.Equals(rd.Status, "superseded", StringComparison.OrdinalIgnoreCase);
            var okReadable = IsReadableItems(rd.ItemsJson);
            var okItem = true;
            string itemTxt = "";
            if (!string.IsNullOrWhiteSpace(recItemPart))
            {
              var rmap = ItemMap(rd.ItemsJson, out var rmapErr);
              if (rmapErr != "" || !rmap.TryGetValue(recItemPart, out var ritem)) okItem = false;
              else
              {
                var rap = new HashSet<string>(ParseIdList(rd.ApprovedJson), StringComparer.Ordinal);
                if (!rap.Contains(recItemPart)) okItem = false;
                else itemTxt = ItemText(ritem);
              }
              // LIVE Current follows the EFFECTIVE referenced owner (F5): a replaced historical item
              // (A:s1 BUY superseded by B:s1 CUT) is NOT live-current even when the old record row still
              // carries approvals. History stays readable through stored snapshots, never live text.
              if (okItem)
              {
                if (!recordChains.TryGetValue(rid, out var rchain))
                { rchain = EffectiveChains(s.Drafts.Values.Where(x => x.BoardId == rd.BoardId && x.MeetingId == rd.MeetingId)); recordChains[rid] = rchain; }
                var mine = rchain.FirstOrDefault(v => v.CoveredIds.Contains(rid.ToString(), StringComparer.OrdinalIgnoreCase));
                okItem = mine is not null
                  && mine.EffectiveOwners.TryGetValue(recItemPart, out var eo)
                  && string.Equals(eo.RecordId, rid.ToString(), StringComparison.OrdinalIgnoreCase)
                  && eo.Version == rd.Version;
              }
            }
            if (okBoard && okAuth && okVersion && okState && okReadable && okItem)
            {
              string txt;
              string ttl;
              if (!string.IsNullOrWhiteSpace(recItemPart)) { txt = itemTxt; ttl = "record v" + rd.Version + " [" + recItemPart + "]"; }
              else { txt = BuildExport(rd.ItemsJson, rd.ApprovedJson, false); ttl = "record v" + rd.Version; }
              // Empty/invalid approved content never yields a valid available CURRENT card (F6).
              if (string.IsNullOrWhiteSpace(txt)) { cards.Add(Unavailable(itemId, kind, rf, parsed.Version)); }
              else cards.Add(new EvidenceCard(itemId, kind, rf, rd.Version, ttl, Trunc(txt, 600), true, true, false));
            }
            else
              cards.Add(Unavailable(itemId, kind, rf, parsed.Version));
          }
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
  // sourceOriginalOf maps a source id string to its ORIGINAL version (pre-renumber alias root), or null
  // when unknown. Callers pass the store-backed lookup so requested1/resolved3 alias pins capture available.
  public static bool TryBuildSnapshots(string existingJson,
    Dictionary<string, JsonElement> itemMap, List<EvidenceCard> authorized,
    IEnumerable<string> newIds, int revision, out string nextJson, out string error,
    Func<string, int?> sourceOriginalOf)
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
        // Universal-alias capture: live resolution already gates the requested pin (canonical or original alias). The snapshot pins the RESOLVED canonical version, not the requested alias, so readback compares resolved-against-resolved. A stale pin yields no live card and captures unavailable.
        // Requested/version correspondence (F3): an explicit pin must name the resolved capture version or a
        // genuine original-version alias of the SAME source (requested1/resolved3 valid). A pin naming no actual
        // version (unrelated999) captures unavailable, never another version's bytes.
        int? aliasOrig = null;
        if (parsed.Version.HasValue && string.Equals(parsed.Kind, "source", StringComparison.OrdinalIgnoreCase) && sourceOriginalOf is not null)
        { try { aliasOrig = sourceOriginalOf(parsed.Ref); } catch { aliasOrig = null; } }
        var pinOk = parsed.Version is null || (card is not null && card.Version == parsed.Version) || (aliasOrig.HasValue && aliasOrig.Value == parsed.Version);
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
    // Version-less keys alias the plain identity (no trailing delimiter): an
    // unversioned request that resolved to v1 reads back ONE available card
    // instead of emitting a duplicate unavailable null-version card.
    if (version is null) return SnapshotKey(itemId, kind, rf);
    return SnapshotKey(itemId, kind, rf) + ((char)1) + version.Value.ToString();
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
        // Record references: current eligibility follows the REFERENCED item owner, not the destination itemId.
        // Explicit sourceRecordId:itemId refs resolve that item at its historical exact version; legacy bare
        // recordIds (whole-record) keep the live eligibility result without per-item owner narrowing.
        if (stillEligible && string.Equals(sn.Kind, "record", StringComparison.OrdinalIgnoreCase))
        {
          // Stored eligibility follows the REFERENCED item owner (never the destination itemId): a moved
          // owner shows historical bytes as non-current, never current. Malformed composites show unavailable.
          if (!EvidenceRef.TryParseRecordRef(sn.Ref, out var ownRid2, out var ownItemM, out _))
            stillEligible = false;
          else if (!string.IsNullOrWhiteSpace(ownItemM))
          {
            var ownerMatch = false;
            try
            {
              if (s.Drafts.TryGetValue(ownRid2, out var ownRd2) && ownRd2 is not null)
              {
                foreach (var v in EffectiveChains(s.Drafts.Values.Where(x => x.BoardId == ownRd2.BoardId && x.MeetingId == ownRd2.MeetingId)))
                {
                  if (v.EffectiveOwners.TryGetValue(ownItemM, out var eo) && string.Equals(eo.RecordId, ownRid2.ToString(), StringComparison.OrdinalIgnoreCase) && eo.Version == sn.Version) { ownerMatch = true; break; }
                }
              }
            }
            catch { ownerMatch = false; }
            stillEligible = ownerMatch;
          }
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
        // A capture keyed by the RESOLVED version satisfies the original request (requested v1 reads back
        // resolved v3): the version-less target identity covers every requested pin for that target, so
        // readback emits the ONE captured card instead of appending an unavailable duplicate (F4).
        // Malformed record composites never match a capture: they stay unavailable, never whole-record.
        if (string.Equals(parsed.Kind, "record", StringComparison.OrdinalIgnoreCase)
          && !EvidenceRef.TryParseRecordRef(parsed.Ref, out _, out _, out _))
          result.Add(Unavailable(itemId, parsed.Kind, parsed.Ref, parsed.Version));
        else if (!snapKeys.Contains(SnapshotKey(itemId, parsed.Kind, parsed.Ref)))
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
          result = Atomic.Run(s, () =>
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
      if (pendingAudit is not null) Atomic.Audit(s, pendingAudit);
      return result;
    });    IResult ItemApprove(InMemoryStore s, HttpRequest req, Guid draftId, JsonElement body)
    {
      AuditEvent? pendingAudit = null;
      IResult result;
      lock (s.MessageLock)
      {
        try
        {
          result = Atomic.Run(s, () =>
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
            if (!RecordsOps.TryBuildSnapshots(d.EvidenceSnapshotJson, map, cards, new[] { itemId }, d.ReviewRevision + 1, out var newSnaps, out var snerr,
              refId => Guid.TryParse(refId, out var og) && s.Sources.TryGetValue(og, out var odoc) && odoc is not null ? SourceGovernance.OriginalVersionOf(s, odoc) : (int?)null))
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
      if (pendingAudit is not null) Atomic.Audit(s, pendingAudit);
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
          result = Atomic.Run(s, () =>
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
            if (!RecordsOps.TryBuildSnapshots(d.EvidenceSnapshotJson, map, cards, pending, d.ReviewRevision + 1, out var newSnapsAll, out var snerr,
              refId => Guid.TryParse(refId, out var og2) && s.Sources.TryGetValue(og2, out var odoc2) && odoc2 is not null ? SourceGovernance.OriginalVersionOf(s, odoc2) : (int?)null))
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
      if (pendingAudit is not null) Atomic.Audit(s, pendingAudit);
      return result;
    });    app.MapPost("/api/records/{draftId:guid}/items/revise", (InMemoryStore s, HttpRequest req, Guid draftId, JsonElement body) =>
    {
      AuditEvent? pendingAudit = null;
      IResult result;
      lock (s.MessageLock)
      {
        try
        {
          result = Atomic.Run(s, () =>
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
      if (pendingAudit is not null) Atomic.Audit(s, pendingAudit);
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
          result = Atomic.Run(s, () =>
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
      if (pendingAudit is not null) Atomic.Audit(s, pendingAudit);
      return result;
    });    IResult NewVersion(InMemoryStore s, HttpRequest req, Guid draftId, JsonElement body, string[] extraSupersedes, bool amend)
    {
      AuditEvent? pendingAudit = null;
      IResult result;
      lock (s.MessageLock)
      {
        try
        {
          result = Atomic.Run(s, () =>
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
      if (pendingAudit is not null) Atomic.Audit(s, pendingAudit);
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
          result = Atomic.Run(s, () =>
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
      if (pendingAudit is not null) Atomic.Audit(s, pendingAudit);
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
