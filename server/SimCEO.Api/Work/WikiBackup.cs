using System.Text.Json;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;

namespace SimCEO.Api.Work;

// Typed consistent Wiki backup metadata. Export and restore share camelCase
// (JsonSerializerDefaults.Web) naming deliberately; legacy PascalCase exports
// are accepted on restore for backward compatibility but never emitted.
// Validated BEFORE any clear; restored atomically with disabled resources,
// absent credentials, and blocked cached sources.
public sealed record WikiBackupRecord(
  Guid Id, Guid BoardId, string Scope, Guid? MeetingId, string BaseUrl,
  string Description, string AllowedUse, bool SetupUse, bool ManualOnly,
  string AllowlistJson, string ExclusionsJson, string RequiredTagsJson,
  string Locale, long ConfigRevision, int SyncIntervalMinutes, DateTime CreatedAt);

public static class WikiBackup
{
  public static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);

  public static List<object> Export(InMemoryStore s)
  {
    return s.WikiResources.Values.OrderBy(r => r.CreatedAt).ThenBy(r => r.Id).Select(r => (object)new
    {
      id = r.Id, boardId = r.BoardId, scope = r.Scope, meetingId = r.MeetingId, baseUrl = r.BaseUrl,
      description = r.Description ?? "", allowedUse = r.AllowedUse ?? "", setupUse = r.SetupUse, manualOnly = r.ManualOnly,
      allowlistJson = r.AllowlistJson ?? "[]", exclusionsJson = r.ExclusionsJson ?? "[]",
      requiredTagsJson = r.RequiredTagsJson ?? "[]", locale = r.Locale ?? "",
      configRevision = r.ConfigRevision, syncIntervalMinutes = r.SyncIntervalMinutes, createdAt = r.CreatedAt,
    }).ToList();
  }

  private static string GetStr(JsonElement el, string camel, string pascal)
  {
    if (el.TryGetProperty(camel, out var a) && a.ValueKind == JsonValueKind.String) return a.GetString() ?? "";
    if (el.TryGetProperty(pascal, out var b) && b.ValueKind == JsonValueKind.String) return b.GetString() ?? "";
    return "";
  }

  private static bool GetGuidStrict(JsonElement el, string camel, string pascal, string field, out Guid value, out string error)
  {
    value = Guid.Empty; error = "";
    JsonElement p;
    bool has = el.TryGetProperty(camel, out p) || el.TryGetProperty(pascal, out p);
    if (!has || p.ValueKind != JsonValueKind.String || !Guid.TryParse(p.GetString(), out var g) || g == Guid.Empty)
    { error = "Snapshot wiki resource has a missing or invalid " + field + "; IDs are required and preserved exactly."; return false; }
    value = g; return true;
  }

  // Strict rule-array parsing for restore: the stored value must be JSON for an
  // array of non-blank strings. Malformed JSON, non-arrays, and non-string or
  // blank entries reject the whole snapshot (F6/F11: no silent drops).
  private static bool StrictRuleJson(string? raw, string field, out List<string> values, out string error)
  {
    values = new(); error = "";
    if (string.IsNullOrWhiteSpace(raw)) return true;
    JsonDocument d;
    try { d = JsonDocument.Parse(raw); }
    catch { error = "Snapshot wiki " + field + " is malformed JSON."; return false; }
    using (d)
    {
      var root = d.RootElement;
      if (root.ValueKind != JsonValueKind.Array) { error = "Snapshot wiki " + field + " must be an array of strings."; return false; }
      foreach (var x in root.EnumerateArray())
      {
        if (x.ValueKind != JsonValueKind.String) { error = "Snapshot wiki " + field + " must be an array of strings; non-string entries reject the snapshot."; return false; }
        var s = (x.GetString() ?? "").Trim();
        if (s.Length == 0) { error = "Snapshot wiki " + field + " must not contain blank entries."; return false; }
        values.Add(s);
      }
    }
    return true;
  }

  // Detached-evidence provenance: wiki sources whose connector was deleted
  // keep their rows (missing-resource reads fail closed with 409), so the
  // canonical backup records their resource IDs explicitly. Restore accepts
  // ONLY listed known-deleted references; any other dangling reference
  // rejects before any clear. Tampered unlisted GUIDs still fail closed.
  public static List<string> DeletedWikiResourceIds(InMemoryStore s)
  {
    var live = new HashSet<Guid>(s.WikiResources.Values.Select(r => r.Id));
    return s.Sources.Values
      .Where(d => string.Equals((d.Origin ?? "").Trim(), "wiki", StringComparison.OrdinalIgnoreCase)
        && d.ResourceId.HasValue && d.ResourceId.Value != Guid.Empty && !live.Contains(d.ResourceId.Value))
      .Select(d => d.ResourceId!.Value).Distinct().OrderBy(g => g).Select(g => g.ToString()).ToList();
  }

  // Validates the exported snapshot wiki graph WITHOUT mutating state.
  // Strict: every ID is required (never generated), scope is exactly
  // board/meeting, board membership is always checked, meeting resources
  // require a present snapshot meeting with matching parent, rule JSON is
  // strictly parsed and validated, CreatedAt is preserved, and the
  // source/section graph must reference the validated wiki resources.
  // Dangling, cross-board, malformed, and secret-carrying graphs reject
  // before any clear. Duplicate same-origin bindings are allowed: creation
  // permits distinct resources with one origin and different rules (F7).
  public static (List<WikiBackupRecord>? records, string? error) Validate(JsonElement root, InMemoryStore current)
  {
    var out_ = new List<WikiBackupRecord>();
    if (!root.TryGetProperty("wikiResources", out var wr) && !root.TryGetProperty("WikiResources", out wr))
      return (out_, null);
    if (wr.ValueKind != JsonValueKind.Array) return (null, "Snapshot wikiResources must be an array.");
    if (!root.TryGetProperty("boards", out var sb) || sb.ValueKind != JsonValueKind.Array)
      return (null, "Snapshot boards must be an array.");
    if (!root.TryGetProperty("meetings", out var sm) || sm.ValueKind != JsonValueKind.Array)
      return (null, "Snapshot meetings must be an array.");
    var snapBoards = new HashSet<Guid>();
    foreach (var b in sb.EnumerateArray())
    {
      if (b.ValueKind != JsonValueKind.Object) return (null, "Snapshot boards entries must be objects.");
      if (!GetGuidStrict(b, "id", "Id", "board id", out var bid, out var berr)) return (null, berr);
      snapBoards.Add(bid);
    }
    var snapMeetings = new Dictionary<Guid, Guid>(); // meetingId -> boardId
    foreach (var m in sm.EnumerateArray())
    {
      if (m.ValueKind != JsonValueKind.Object) return (null, "Snapshot meetings entries must be objects.");
      if (!GetGuidStrict(m, "id", "Id", "meeting id", out var mid, out var merr)) return (null, merr);
      if (!GetGuidStrict(m, "boardId", "BoardId", "meeting boardId", out var mbid, out var mberr)) return (null, mberr);
      snapMeetings[mid] = mbid;
    }
    var seen = new HashSet<Guid>();
    foreach (var x in wr.EnumerateArray())
    {
      if (x.ValueKind != JsonValueKind.Object) return (null, "Snapshot wikiResources entries must be objects.");
      if (!GetGuidStrict(x, "id", "Id", "id", out var id, out var idErr)) return (null, idErr);
      if (!seen.Add(id)) return (null, "Snapshot wikiResources contains a duplicate id.");
      if (!GetGuidStrict(x, "boardId", "BoardId", "boardId", out var boardId, out var boardErr)) return (null, boardErr);
      if (!snapBoards.Contains(boardId)) return (null, "Snapshot wiki resource references an unknown board.");
      string scope;
      {
        JsonElement sc;
        bool has = x.TryGetProperty("scope", out sc) || x.TryGetProperty("Scope", out sc);
        if (!has || sc.ValueKind != JsonValueKind.String) return (null, "Snapshot wiki resource has a missing or invalid scope.");
        scope = (sc.GetString() ?? "").Trim().ToLowerInvariant();
        if (scope != "board" && scope != "meeting") return (null, "Snapshot wiki resource has an unknown scope; must be board or meeting.");
      }
      Guid? meetingId = null;
      JsonElement me;
      bool hasMeet = x.TryGetProperty("meetingId", out me) || x.TryGetProperty("MeetingId", out me);
      if (scope == "meeting")
      {
        if (!hasMeet || me.ValueKind != JsonValueKind.String || !Guid.TryParse(me.GetString(), out var mg) || mg == Guid.Empty)
          return (null, "Snapshot wiki meeting resource has a missing or invalid meetingId.");
        meetingId = mg;
        if (!snapMeetings.TryGetValue(mg, out var mbid) || mbid != boardId)
          return (null, "Snapshot wiki meeting is absent or does not belong to its board.");
      }
      else if (hasMeet && me.ValueKind != JsonValueKind.Null)
        return (null, "Snapshot wiki board resource must not carry a meetingId.");
      var baseUrl = GetStr(x, "baseUrl", "BaseUrl");
      var (origin, urlErr) = WikiUrl.NormalizeBaseUrl(baseUrl);
      if (origin is null) return (null, "Snapshot wiki resource has an invalid baseUrl: " + urlErr);
      if (!StrictRuleJson(GetStr(x, "allowlistJson", "AllowlistJson"), "allowlistJson", out var allow, out var aerr)) return (null, aerr);
      if (!StrictRuleJson(GetStr(x, "exclusionsJson", "ExclusionsJson"), "exclusionsJson", out var excl, out var eerr)) return (null, eerr);
      if (!StrictRuleJson(GetStr(x, "requiredTagsJson", "RequiredTagsJson") ?? "[]", "requiredTagsJson", out var tags, out var terr)) return (null, terr);
      var (rulesOk, rulesErr) = WikiRules.ValidateRuleLists(allow, excl, tags);
      if (!rulesOk) return (null, "Snapshot wiki rules rejected: " + rulesErr);
      var locale = GetStr(x, "locale", "Locale") ?? "";
      if (locale.Length > 32) return (null, "Snapshot wiki locale is too long.");
      var desc = GetStr(x, "description", "Description") ?? "";
      if (desc.Length > 500) return (null, "Snapshot wiki description is too long.");
      var allowedUse = GetStr(x, "allowedUse", "AllowedUse") ?? "";
      if (allowedUse.Length > 2000) return (null, "Snapshot wiki allowedUse is too long.");
      long rev;
      {
        JsonElement cr;
        bool has = x.TryGetProperty("configRevision", out cr) || x.TryGetProperty("ConfigRevision", out cr);
        if (!has || cr.ValueKind != JsonValueKind.Number || !cr.TryGetInt64(out rev) || rev < 1)
          return (null, "Snapshot wiki resource has a missing or invalid configRevision.");
      }
      int iv;
      {
        JsonElement sv;
        bool has = x.TryGetProperty("syncIntervalMinutes", out sv) || x.TryGetProperty("SyncIntervalMinutes", out sv);
        if (!has || sv.ValueKind != JsonValueKind.Number || !sv.TryGetInt32(out iv) || iv < 5 || iv > 1440)
          return (null, "Snapshot wiki resource has a missing or invalid syncIntervalMinutes.");
      }
      bool setupUse = false, manualOnly = false;
      if (x.TryGetProperty("setupUse", out var su) || x.TryGetProperty("SetupUse", out su))
      {
        if (su.ValueKind == JsonValueKind.True) setupUse = true;
        else if (su.ValueKind == JsonValueKind.False) setupUse = false;
        else return (null, "Snapshot wiki setupUse must be a boolean.");
      }
      if (x.TryGetProperty("manualOnly", out var mo) || x.TryGetProperty("ManualOnly", out mo))
      {
        if (mo.ValueKind == JsonValueKind.True) manualOnly = true;
        else if (mo.ValueKind == JsonValueKind.False) manualOnly = false;
        else return (null, "Snapshot wiki manualOnly must be a boolean.");
      }
      DateTime createdAt;
      {
        JsonElement ca;
        bool has = x.TryGetProperty("createdAt", out ca) || x.TryGetProperty("CreatedAt", out ca);
        if (!has || ca.ValueKind != JsonValueKind.String || !DateTime.TryParse(ca.GetString(), null, System.Globalization.DateTimeStyles.RoundtripKind, out createdAt))
          return (null, "Snapshot wiki resource has a missing or invalid createdAt; history is preserved exactly.");
        createdAt = createdAt.ToUniversalTime();
      }
      var raw = x.GetRawText();
      if (raw.Contains("protectedToken", StringComparison.OrdinalIgnoreCase))
        return (null, "Snapshot wiki resource must not carry secrets.");
      out_.Add(new WikiBackupRecord(id, boardId, scope, meetingId, origin, desc, allowedUse, setupUse, manualOnly, WikiRules.ToJson(allow), WikiRules.ToJson(excl), WikiRules.ToJson(tags), locale, rev, iv, createdAt));
    }
    // Source-to-resource graph: every snapshot wiki source must reference a
    // validated snapshot wiki resource; every section must reference a
    // snapshot source (F6).
    var wikiIds = new HashSet<Guid>(out_.Select(r => r.Id));
    // Known-deleted connector references (detached evidence preserved by
    // explicit resource deletes). Listed IDs must be valid, distinct, and
    // must NOT collide with live snapshot resources; only listed references
    // are tolerated, everything else dangling still rejects (F6).
    var deletedIds = new HashSet<Guid>();
    if (root.TryGetProperty("deletedWikiResourceIds", out var del) || root.TryGetProperty("DeletedWikiResourceIds", out del))
    {
      if (del.ValueKind != JsonValueKind.Array) return (null, "Snapshot deletedWikiResourceIds must be an array of resource IDs.");
      foreach (var x in del.EnumerateArray())
      {
        if (x.ValueKind != JsonValueKind.String || !Guid.TryParse(x.GetString(), out var dg) || dg == Guid.Empty)
          return (null, "Snapshot deletedWikiResourceIds must contain only valid resource IDs.");
        if (!deletedIds.Add(dg)) return (null, "Snapshot deletedWikiResourceIds contains a duplicate id.");
      }
      foreach (var dg in deletedIds)
        if (wikiIds.Contains(dg)) return (null, "Snapshot deletedWikiResourceIds must not list a live wiki resource.");
    }
    if (root.TryGetProperty("sources", out var srcs))
    {
      if (srcs.ValueKind != JsonValueKind.Array) return (null, "Snapshot sources must be an array.");
      var sourceIds = new HashSet<Guid>();
      foreach (var sdoc in srcs.EnumerateArray())
      {
        if (sdoc.ValueKind != JsonValueKind.Object) return (null, "Snapshot sources entries must be objects.");
        JsonElement sid;
        bool hasS = sdoc.TryGetProperty("id", out sid) || sdoc.TryGetProperty("Id", out sid);
        if (!hasS || sid.ValueKind != JsonValueKind.String || !Guid.TryParse(sid.GetString(), out var sg) || sg == Guid.Empty)
          return (null, "Snapshot source has a missing or invalid id.");
        sourceIds.Add(sg);
        string org = "";
        JsonElement o;
        bool hasO = sdoc.TryGetProperty("origin", out o) || sdoc.TryGetProperty("Origin", out o);
        if (hasO)
        {
          if (o.ValueKind != JsonValueKind.String) return (null, "Snapshot source origin must be a string.");
          org = (o.GetString() ?? "").Trim().ToLowerInvariant();
        }
        if (org == "wiki")
        {
          JsonElement ri;
          bool hasR = sdoc.TryGetProperty("resourceId", out ri) || sdoc.TryGetProperty("ResourceId", out ri);
          if (!hasR || ri.ValueKind != JsonValueKind.String || !Guid.TryParse(ri.GetString(), out var rg) || rg == Guid.Empty)
            return (null, "Snapshot wiki source references a missing wiki resource.");
          if (!wikiIds.Contains(rg) && !deletedIds.Contains(rg))
            return (null, "Snapshot wiki source references a missing wiki resource.");
        }
      }
      if (root.TryGetProperty("sections", out var secs) && secs.ValueKind != JsonValueKind.Null)
      {
        if (secs.ValueKind != JsonValueKind.Array) return (null, "Snapshot sections must be an array.");
        foreach (var sec in secs.EnumerateArray())
        {
          if (sec.ValueKind != JsonValueKind.Object) return (null, "Snapshot sections entries must be objects.");
          JsonElement so;
          bool hasS = sec.TryGetProperty("sourceId", out so) || sec.TryGetProperty("SourceId", out so);
          if (!hasS || so.ValueKind != JsonValueKind.String || !Guid.TryParse(so.GetString(), out var sog) || !sourceIds.Contains(sog))
            return (null, "Snapshot section references a missing source.");
        }
      }
    }
    return (out_, null);
  }

  // Whole-store memory image for rollback when no PG backend is wired
  // (PG relies on the Atomic transaction instead). Shallow: restore never
  // mutates pre-existing objects, it only clears and re-adds.
  public sealed record WikiRestoreSnapshot(
    List<Board> Boards, List<RosterEntry> Roster, List<BoardAdvisor> Advisors,
    List<Meeting> Meetings, Dictionary<Guid, List<Message>> Messages,
    List<Note> Notes, List<RecordDraft> Drafts, List<SourceDoc> Sources,
    List<SourceSection> Sections, List<SourceFamilyHead> Heads, List<SourceEvent> Events,
    List<WikiResource> WikiResources, List<WikiResourceSecret> WikiSecrets,
    List<LeadProfile> Leads, List<Grant> Grants, List<Invite> Invites,
    List<AdvisorImage> Images, List<WizardDraft> WizardDrafts);

  public static WikiRestoreSnapshot CaptureStore(InMemoryStore s)
    => new(
      s.Boards.Values.ToList(), s.Roster.Values.ToList(), s.Advisors.Values.ToList(),
      s.Meetings.Values.ToList(), s.Messages.ToDictionary(kv => kv.Key, kv => kv.Value.ToList()),
      s.Notes.Values.ToList(), s.Drafts.Values.ToList(), s.Sources.Values.ToList(),
      s.SourceSections.Values.ToList(), s.SourceHeads.Values.ToList(), s.SourceEvents.Values.ToList(),
      s.WikiResources.Values.ToList(), s.WikiSecrets.Values.ToList(),
      s.LeadProfiles.Values.ToList(), s.Grants.Values.ToList(), s.Invites.Values.ToList(),
      s.Images.Values.ToList(), s.WizardDrafts.Values.ToList());

  public static void RestoreStore(InMemoryStore s, WikiRestoreSnapshot b)
  {
    s.Boards.Clear(); s.Roster.Clear(); s.Advisors.Clear(); s.Meetings.Clear(); s.Messages.Clear();
    s.Notes.Clear(); s.Drafts.Clear(); s.Sources.Clear(); s.SourceSections.Clear(); s.SourceHeads.Clear(); s.SourceEvents.Clear();
    s.WikiResources.Clear(); s.WikiSecrets.Clear();
    s.LeadProfiles.Clear(); s.Grants.Clear(); s.Invites.Clear(); s.Images.Clear(); s.WizardDrafts.Clear();
    foreach (var x in b.Boards) s.Boards[x.Id] = x;
    foreach (var x in b.Roster) s.Roster[x.Id] = x;
    foreach (var x in b.Advisors) s.Advisors[x.Id] = x;
    foreach (var x in b.Meetings) s.Meetings[x.Id] = x;
    foreach (var kv in b.Messages) s.Messages[kv.Key] = new MessageList(null, kv.Key, kv.Value);
    foreach (var x in b.Notes) s.Notes[x.Id] = x;
    foreach (var x in b.Drafts) s.Drafts[x.Id] = x;
    foreach (var x in b.Sources) s.Sources[x.Id] = x;
    foreach (var x in b.Sections) s.SourceSections[x.Id] = x;
    foreach (var x in b.Heads) s.SourceHeads[x.Id] = x;
    foreach (var x in b.Events) s.SourceEvents[x.Id] = x;
    foreach (var x in b.WikiResources) s.WikiResources[x.Id] = x;
    foreach (var x in b.WikiSecrets) s.WikiSecrets[x.Id] = x;
    foreach (var x in b.Leads) s.LeadProfiles[x.Id] = x;
    foreach (var x in b.Grants) s.Grants[x.Id] = x;
    foreach (var x in b.Invites) s.Invites[x.Id] = x;
    foreach (var x in b.Images) s.Images[x.Id] = x;
    foreach (var x in b.WizardDrafts) s.WizardDrafts[x.Id] = x;
  }
}
