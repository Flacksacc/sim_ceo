using System.Text;
using System.Text.Json;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;

namespace SimCEO.Api.Work;

public static class SecretaryDirect
{
  public const int InputTokens = 8000;
  // Single authoritative normalization, server-side only. Client detects
  // routing but sends raw input. Strips exactly one leading addressing
  // prefix (Secretary, or Secretary:) after optional leading whitespace,
  // preserving every remainder byte (whitespace, newlines, repeated text).
  public static string StripPrefix(string input)
  {
    var s = input ?? "";
    int i = 0;
    while (i < s.Length && char.IsWhiteSpace(s[i])) i++;
    var rest = s.Substring(i);
    if (rest.Length >= 10)
    {
      var head = rest.Substring(0, 10);
      if (head.Equals("Secretary,", StringComparison.OrdinalIgnoreCase) || head.Equals("Secretary:", StringComparison.OrdinalIgnoreCase))
        return rest.Substring(10);
    }
    return s;
  }
  public static bool HasPrefix(string input)
  {
    var t = (input ?? "").TrimStart();
    if (t.Length >= 10)
    {
      var h = t.Substring(0, 10);
      if (h.Equals("Secretary,", StringComparison.OrdinalIgnoreCase)) return true;
      if (h.Equals("Secretary:", StringComparison.OrdinalIgnoreCase)) return true;
    }
    return false;
  }
  public static string CausalHash(string normalizedInput, string canonicalEvidenceJson)
  {
    return Hashing.HashOf((normalizedInput ?? "") + "\n||EVIDENCE||\n" + (canonicalEvidenceJson ?? "[]"));
  }
  public static string CanonicalEvidenceJson(List<EvidenceRef> refs)
  {
    var sorted = (refs ?? new List<EvidenceRef>()).OrderBy(r => r.Kind).ThenBy(r => r.Ref).ThenBy(r => r.SectionId ?? "").ThenBy(r => r.Version ?? -1).ToList();
    return JsonSerializer.Serialize(sorted.Select(r => new { kind = r.Kind, @ref = r.Ref, version = r.Version, sectionId = r.SectionId, location = r.Location, indexGeneration = r.IndexGeneration, contentHash = r.ContentHash, excerpt = r.Excerpt }));
  }
  // Immutable submission identity: normalized input + EVERY caller-supplied
  // evidence selector (kind/ref/version/sectionId/excerpt/indexGeneration/
  // contentHash/location) exactly as received. Never includes canonicalized
  // text or current eligibility, so completed replay is stable across
  // exclude/reindex/record-change/provider-down/setup-change/read-downgrade,
  // while genuinely changed selectors conflict.
  public static string RawCallerIdentityJson(List<EvidenceRef> refs)
  {
    var sorted = (refs ?? new List<EvidenceRef>()).OrderBy(r => (r.Kind ?? "").ToLowerInvariant()).ThenBy(r => r.Ref ?? "").ThenBy(r => r.SectionId ?? "").ToList();
    return JsonSerializer.Serialize(sorted.Select(r => new { kind = (r.Kind ?? "").Trim().ToLowerInvariant(), @ref = (r.Ref ?? "").Trim(), version = r.Version, sectionId = (r.SectionId ?? "").Trim(), excerpt = r.Excerpt ?? "", indexGeneration = r.IndexGeneration, contentHash = r.ContentHash ?? "", location = r.Location ?? "" }));
  }
  public static string SubmissionHash(string normalizedInput, List<EvidenceRef> rawCaller)
  {
    return Hashing.HashOf((normalizedInput ?? "") + "\n||SUBMIT||\n" + RawCallerIdentityJson(rawCaller));
  }
  public static string RawCallerIdentityJsonLegacy(List<EvidenceRef> refs)
  {
    var sorted = (refs ?? new List<EvidenceRef>()).OrderBy(r => (r.Kind ?? "").ToLowerInvariant()).ThenBy(r => r.Ref ?? "").ThenBy(r => r.SectionId ?? "").ToList();
    return JsonSerializer.Serialize(sorted.Select(r => new { kind = (r.Kind ?? "").Trim().ToLowerInvariant(), @ref = (r.Ref ?? "").Trim(), version = r.Version, sectionId = (r.SectionId ?? "").Trim() }));
  }
  public static string SubmissionHashLegacy(string normalizedInput, List<EvidenceRef> rawCaller)
  {
    return Hashing.HashOf((normalizedInput ?? "") + "\n||SUBMIT||\n" + RawCallerIdentityJsonLegacy(rawCaller));
  }
  public static bool IsLegacyCallerIdentityJson(string? json)
  {
    try
    {
      if (string.IsNullOrWhiteSpace(json)) return false;
      using var d = JsonDocument.Parse(json);
      if (d.RootElement.ValueKind != JsonValueKind.Array) return false;
      var any = false;
      foreach (var el in d.RootElement.EnumerateArray())
      {
        any = true;
        if (el.ValueKind != JsonValueKind.Object) continue;
        if (el.TryGetProperty("excerpt", out _) || el.TryGetProperty("indexGeneration", out _) || el.TryGetProperty("contentHash", out _) || el.TryGetProperty("location", out _))
          return false;
      }
      return any;
    }
    catch { return false; }
  }
  public static List<EvidenceRef> RehydrateRawCallerRefs(string? json)
  {
    var list = new List<EvidenceRef>();
    try
    {
      using var d = JsonDocument.Parse(string.IsNullOrWhiteSpace(json) ? "[]" : json);
      if (d.RootElement.ValueKind != JsonValueKind.Array) return list;
      foreach (var el in d.RootElement.EnumerateArray())
      {
        if (el.ValueKind != JsonValueKind.Object) continue;
        string kind = el.TryGetProperty("kind", out var k) && k.ValueKind == JsonValueKind.String ? k.GetString() ?? "" : "";
        string rf = el.TryGetProperty("ref", out var r) && r.ValueKind == JsonValueKind.String ? r.GetString() ?? "" : "";
        if (!EvidenceRef.ValidKind(kind) || string.IsNullOrWhiteSpace(rf)) continue;
        int? ver = el.TryGetProperty("version", out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var n) ? n : (int?)null;
        string? sec = el.TryGetProperty("sectionId", out var s2) && s2.ValueKind == JsonValueKind.String ? s2.GetString() : null;
        string? exc = el.TryGetProperty("excerpt", out var e2) && e2.ValueKind == JsonValueKind.String ? e2.GetString() : null;
        int? ig = el.TryGetProperty("indexGeneration", out var g2) && g2.ValueKind == JsonValueKind.Number && g2.TryGetInt32(out var gn) ? gn : (int?)null;
        string? ch = el.TryGetProperty("contentHash", out var c2) && c2.ValueKind == JsonValueKind.String ? c2.GetString() : null;
        string? loc = el.TryGetProperty("location", out var l2) && l2.ValueKind == JsonValueKind.String ? l2.GetString() : null;
        list.Add(new EvidenceRef(kind.Trim().ToLowerInvariant(), rf.Trim(), ver, null, null, exc,
          string.IsNullOrWhiteSpace(sec) ? null : sec!.Trim(),
          string.IsNullOrWhiteSpace(loc) ? null : loc, ig,
          string.IsNullOrWhiteSpace(ch) ? null : ch));
      }
    }
    catch { }
    return list;
  }
}

public static class SecretaryEpoch
{
  // Shared restore-epoch contract: Secretary workers (including legacy briefings) consume the
  // Core-owned SourceEpoch, NOT a process-lifetime static. Restore bumps SourceEpoch, so a held
  // identical restore invalidates old workers (epoch mismatch discards). No parallel helper.
  public static string CurrentFor(SimCEO.Api.Data.InMemoryStore s) => "src-" + s.SourceEpoch.ToString(System.Globalization.CultureInfo.InvariantCulture);
  [System.Obsolete("Use CurrentFor(store): process-lifetime epoch does not invalidate on restore.")]
  public static string Current => "src-0";
}
public sealed record SecretarySnapshot(
  string Brief, long Generation, long DeliveredRevision, string BoardConfig,
  string LeadFp, string EvFp, List<string> DirectionIds, string DirectionHash,
  List<string> RecordIds, string RecordHash, List<string> SectionIds, string SectionHash,
  string RecentHash, string EvidenceTextHash, string DossierHash, string EpochId, List<string> CitedMessages);

public static class SecretaryContext
{
  public static string LeadFingerprint(LeadProfile? lead)
  {
    if (lead is null) return "lead:none";
    return JsonSerializer.Serialize(new { id = lead.Id, boardId = lead.BoardId, version = lead.Version, name = lead.Name ?? "", roleLabel = lead.RoleLabel ?? "", background = lead.Background ?? "", familiarTopics = lead.FamiliarTopics ?? "", simplerTopics = lead.SimplerTopics ?? "", commPrefs = lead.CommPrefs ?? "" });
  }
  public static string BoardConfigJson(InMemoryStore s, Guid boardId)
  {
    if (!s.Boards.TryGetValue(boardId, out var b) || b is null) return "board:missing";
    var eff = LeadSetup.EffectiveView(s, b);
    return JsonSerializer.Serialize(new { id = b.Id, name = eff.name, mission = eff.mission, stage = eff.stage, policy = eff.policy, dataUse = eff.dataUse, activeJson = b.ActiveJson ?? "", leadVersion = b.LeadProfileVersion, blocked = b.BlockedTypes ?? "", policyMode = SourceGovernance.PolicyModeOf(b) });
  }
  public static string EvidenceFingerprint(InMemoryStore s, Guid boardId, Guid? meetingId)
  {
    var ids = s.Sources.Values.Where(x => x.BoardId == boardId && SourceGovernance.IsEligible(s, x, meetingId)).OrderBy(x => x.Id.ToString()).Select(x => x.Id.ToString() + ":v" + x.Version + ":" + (x.ContentHash ?? "") + ":g" + x.IndexGeneration).ToList();
    string policy = "";
    if (s.Boards.TryGetValue(boardId, out var b)) policy = SourceGovernance.PolicyModeOf(b) + "|" + (b.BlockedTypes ?? "");
    return JsonSerializer.Serialize(new { policy, ids });
  }
  public static bool IsBusinessNote(Note n)
  {
    var k = (n.Kind ?? "").Trim().ToLowerInvariant();
    if (k == "note" || k == "briefing" || k == "secretary-note" || k == "secretary-briefing") return n.Provisional;
    return false;
  }
  public static bool IsOperationalNote(Note n)
  {
    var k = (n.Kind ?? "").Trim().ToLowerInvariant();
    return k.StartsWith("run-") || k == "run-outcome" || k == "run-cap" || k == "yield" || k == "cap";
  }
  public static string Trunc(string s, int max)
  {
    if (string.IsNullOrEmpty(s)) return "";
    if (s.Length <= max) return s;
    return s.Substring(0, max) + "...";
  }
  public static SecretarySnapshot CaptureSnapshot(InMemoryStore s, Meeting m, List<EvidenceRef>? citedCallerRefs = null)
  {
    var brief = m.Brief ?? "";
    var gen = m.Generation;
    var rev = m.DeliveredRevision;
    var boardCfg = BoardConfigJson(s, m.BoardId);
    LeadProfile? __capLead = null;
    try { if (s.Boards.TryGetValue(m.BoardId, out var __capBoard)) __capLead = LeadSetup.ResolveLeadForBoard(s, __capBoard); } catch { __capLead = null; }
    var leadFp = LeadFingerprint(__capLead);
    var evFp = EvidenceFingerprint(s, m.BoardId, m.Id);
    var dirs = s.Notes.Values.Where(n => n.BoardId == m.BoardId && n.Kind == "direction" && !n.Provisional && (n.Scope == "board" || n.MeetingId == m.Id)).OrderBy(n => n.Id.ToString()).ToList();
    var dirIds = dirs.Select(d => d.Id.ToString()).ToList();
    var dirHash = Hashing.HashOf(JsonSerializer.Serialize(dirs.Select(d => new { id = d.Id, scope = d.Scope, meeting = d.MeetingId, body = d.Body })));
    var recs = s.Drafts.Values.Where(d => d.MeetingId == m.Id && d.Status == "approved").OrderBy(d => d.Id.ToString()).ToList();
    var recIds = recs.Select(d => d.Id.ToString() + ":v" + d.Version).ToList();
    var recHash = Hashing.HashOf(JsonSerializer.Serialize(recs.Select(d => new { id = d.Id, v = d.Version, items = d.ItemsJson, approved = d.ApprovedJson })));
    var secs = new List<string>();
    foreach (var doc in s.Sources.Values.Where(x => x.BoardId == m.BoardId && SourceGovernance.IsEligible(s, x, m.Id)))
    {
      var list = s.SourceSections.Values.Where(x => x.SourceId == doc.Id).OrderBy(x => x.Ordinal).ToList();
      foreach (var sec in list) secs.Add(sec.Id.ToString() + ":sv" + sec.SourceVersion + ":g" + sec.IndexGeneration + ":" + (sec.ContentHash ?? ""));
    }
    secs.Sort(StringComparer.Ordinal);
    var secHash = Hashing.HashOf(string.Join(",", secs));
    var recentList = new List<Message>();
    lock (s.MessageLock) { if (s.Messages.TryGetValue(m.Id, out var rl)) recentList = rl.Where(x => !string.Equals(x.Sender, "lead", StringComparison.OrdinalIgnoreCase)).OrderByDescending(x => x.Sequence).Take(8).OrderBy(x => x.Sequence).ToList(); }
    var citedBits = new List<string>();
    foreach (var cr in citedCallerRefs ?? new List<EvidenceRef>())
    {
      if (!string.Equals(cr.Kind, "message", StringComparison.OrdinalIgnoreCase)) continue;
      var parts = (cr.Ref ?? "").Split(":");
      if (parts.Length != 2 || !Guid.TryParse(parts[0], out var cmid) || cmid != m.Id || !long.TryParse(parts[1], out var cseq)) continue;
      Message? cm = null;
      lock (s.MessageLock) { if (s.Messages.TryGetValue(m.Id, out var cl)) cm = cl.FirstOrDefault(x => x.Sequence == cseq); }
      if (cm is null) citedBits.Add(cmid + ":" + cseq + ":missing");
      else citedBits.Add(cmid + ":" + cseq + ":" + Hashing.HashOf(cm.Sender + "|" + (cm.Content ?? "")));
    }
    citedBits.Sort(StringComparer.Ordinal);
    var recentHash = Hashing.HashOf(m.DeliveredRevision + "|" + JsonSerializer.Serialize(recentList.Select(x => new { s = x.Sequence, sender = x.Sender, content = x.Content })) + "|" + string.Join(",", citedBits));
    var secTexts = new List<string>();
    foreach (var doc in s.Sources.Values.Where(x => x.BoardId == m.BoardId && SourceGovernance.IsEligible(s, x, m.Id)))
    {
      var list2 = s.SourceSections.Values.Where(x => x.SourceId == doc.Id).OrderBy(x => x.Ordinal).ToList();
      foreach (var sec2 in list2) secTexts.Add(doc.Id + ":" + sec2.Id + ":" + sec2.Ordinal + ":" + (sec2.Location ?? "") + ":" + sec2.SourceVersion + ":g" + sec2.IndexGeneration + ":" + (sec2.Heading ?? "") + ":" + (sec2.Text ?? ""));
    }
    secTexts.Sort(StringComparer.Ordinal);
    var evTextHash = Hashing.HashOf(string.Join("\n", secTexts));
    var dossierBits = new List<string>();
    foreach (var a in s.Advisors.Values.Where(x => x.BoardId == m.BoardId && !x.Removed && x.Approved).OrderBy(x => x.Id.ToString()))
    {
      s.Roster.TryGetValue(a.RosterEntryId, out var rent);
      dossierBits.Add(a.Id + ":" + a.RosterEntryId + ":rv" + a.RosterVersion + ":" + (a.BoardRole ?? "") + ":" + (rent is null ? "missing" : (rent.Name ?? "") + "|v" + rent.Version + "|" + Hashing.HashOf(rent.ProfileJson ?? "")));
    }
    var dossierHash = Hashing.HashOf(JsonSerializer.Serialize(dossierBits));
    return new SecretarySnapshot(brief, gen, rev, boardCfg, leadFp, evFp, dirIds, dirHash, recIds, recHash, secs, secHash, recentHash, evTextHash, dossierHash, SecretaryEpoch.CurrentFor(s), citedBits);
  }
  public static string SnapshotToJson(SecretarySnapshot snap) => JsonSerializer.Serialize(snap);
  public static bool SnapshotEquals(SecretarySnapshot a, SecretarySnapshot b)
  {
    if (a is null || b is null) return false;
    if (string.IsNullOrWhiteSpace(a.Brief) != string.IsNullOrWhiteSpace(b.Brief)) return false;
    if (!string.Equals(a.EpochId ?? "", b.EpochId ?? "", StringComparison.Ordinal)) return false;
    if (!((a.CitedMessages ?? new List<string>()).SequenceEqual(b.CitedMessages ?? new List<string>()))) return false;
    return a.Brief == b.Brief && a.Generation == b.Generation && a.DeliveredRevision == b.DeliveredRevision && a.BoardConfig == b.BoardConfig
      && a.LeadFp == b.LeadFp && a.EvFp == b.EvFp && a.DirectionHash == b.DirectionHash
      && a.RecordHash == b.RecordHash && a.SectionHash == b.SectionHash
      && a.RecentHash == b.RecentHash && a.EvidenceTextHash == b.EvidenceTextHash && a.DossierHash == b.DossierHash;
  }
  public static bool TryParseSnapshot(string? json, out SecretarySnapshot? snap)
  {
    snap = null;
    try
    {
      if (string.IsNullOrWhiteSpace(json)) return false;
      snap = JsonSerializer.Deserialize<SecretarySnapshot>(json);
      if (snap is null) return false;
      if (snap.DirectionIds is null || snap.RecordIds is null || snap.SectionIds is null) return false;
      if (string.IsNullOrWhiteSpace(snap.BoardConfig) || string.IsNullOrWhiteSpace(snap.LeadFp)) return false;
      return true;
    }
    catch { snap = null; return false; }
  }
  public static string SnapshotMismatchReason(SecretarySnapshot before, SecretarySnapshot now)
  {
    if (!string.Equals(before.EpochId ?? "", now.EpochId ?? "", StringComparison.Ordinal)) return "Service generation changed during secretary work; retry with the same nonce.";
    if (!(before.CitedMessages ?? new List<string>()).SequenceEqual(now.CitedMessages ?? new List<string>())) return "Cited conversation history changed during secretary work; draft discarded.";
    if (before.DeliveredRevision != now.DeliveredRevision || before.RecentHash != now.RecentHash) return "Conversation history changed during secretary work; draft discarded.";
    if (before.EvidenceTextHash != now.EvidenceTextHash) return "Source section text changed during secretary work; draft discarded.";
    if (before.DossierHash != now.DossierHash) return "Advisor roster changed during secretary work; draft discarded.";
    if (before.Brief != now.Brief) return "Meeting brief changed during secretary work.";
    if (before.Generation != now.Generation) return "Meeting was interrupted during secretary work; draft discarded.";
    if (before.BoardConfig != now.BoardConfig) return "Board configuration changed during secretary work.";
    if (before.LeadFp != now.LeadFp) return "Board lead changed during secretary work.";
    if (before.EvFp != now.EvFp || before.SectionHash != now.SectionHash) return "Source evidence changed during secretary work.";
    if (before.DirectionHash != now.DirectionHash) return "Adopted directions changed during secretary work.";
    if (before.RecordHash != now.RecordHash) return "Approved records changed during secretary work.";
    return "Authoritative inputs changed during secretary work.";
  }
  // Destination-aware resolver for ALL caller ref kinds. Only same-board,
  // same-meeting-visible, currently eligible/approved/current identities are
  // kept, and every kept ref carries exact persisted text (never caller text).
  public static List<EvidenceRef> CanonicalizeCaller(InMemoryStore s, Guid boardId, Guid meetingId, List<EvidenceRef> caller)
  {
    var outRefs = new List<EvidenceRef>();
    if (!s.Meetings.TryGetValue(meetingId, out var dest) || dest.BoardId != boardId) return outRefs;
    foreach (var r in caller ?? new List<EvidenceRef>())
    {
      if (r is null) continue;
      var kind = (r.Kind ?? "").Trim().ToLowerInvariant();
      if (kind == "source")
      {
        if (!Guid.TryParse(r.Ref, out var sid)) continue;
        if (!s.Sources.TryGetValue(sid, out var doc) || doc is null) continue;
        if (doc.BoardId != boardId) continue;
        if (!SourceGovernance.VisibleForRecall(s, doc, boardId, meetingId)) continue;
        if (r.Version.HasValue && r.Version.Value != doc.Version) continue;
        var secs = s.SourceSections.Values.Where(x => x.SourceId == doc.Id).OrderBy(x => x.Ordinal).ToList();
        if (secs.Count == 0) continue;
        SourceSection? picked = null;
        string? spanExcerpt = null;
        bool explicitSection = !string.IsNullOrWhiteSpace(r.SectionId);
        if (explicitSection)
        {
          if (!Guid.TryParse(r.SectionId, out var secId)) continue;
          picked = secs.FirstOrDefault(x => x.Id == secId);
          if (picked is null) continue;
          if (r.Version.HasValue && r.Version.Value != doc.Version) continue;
          if (picked.SourceVersion != doc.Version || picked.IndexGeneration != doc.IndexGeneration) continue;
          if (r.IndexGeneration.HasValue && r.IndexGeneration.Value != picked.IndexGeneration) continue;
          if (!string.IsNullOrWhiteSpace(r.ContentHash) && !string.Equals(r.ContentHash, picked.ContentHash ?? doc.ContentHash ?? "", StringComparison.Ordinal)) continue;
          if (!string.Equals(picked.ContentHash ?? "", doc.ContentHash ?? "", StringComparison.Ordinal)) continue;
          if (!string.IsNullOrWhiteSpace(r.Excerpt))
          {
            var qi = (picked.Text ?? "").IndexOf(r.Excerpt!, StringComparison.Ordinal);
            if (qi < 0) continue;
            int start = Math.Max(0, qi - 60);
            int len = Math.Min((picked.Text ?? "").Length - start, (r.Excerpt ?? "").Length + 120);
            spanExcerpt = (picked.Text ?? "").Substring(start, len);
          }
        }
        else if (!string.IsNullOrWhiteSpace(r.Excerpt))
        {
          foreach (var cand in secs)
          {
            var qi2 = (cand.Text ?? "").IndexOf(r.Excerpt!, StringComparison.Ordinal);
            if (qi2 < 0) continue;
            if (cand.SourceVersion != doc.Version || cand.IndexGeneration != doc.IndexGeneration) continue;
            if (!string.Equals(cand.ContentHash ?? "", doc.ContentHash ?? "", StringComparison.Ordinal)) continue;
            picked = cand;
            int start2 = Math.Max(0, qi2 - 60);
            int len2 = Math.Min((cand.Text ?? "").Length - start2, (r.Excerpt ?? "").Length + 120);
            spanExcerpt = (cand.Text ?? "").Substring(start2, len2);
            break;
          }
          if (picked is null) continue;
        }
        else
        {
          picked = secs.First();
          if (picked.SourceVersion != doc.Version || picked.IndexGeneration != doc.IndexGeneration) continue;
          if (!string.Equals(picked.ContentHash ?? "", doc.ContentHash ?? "", StringComparison.Ordinal)) continue;
        }
        if (string.IsNullOrWhiteSpace(picked.Text)) continue;
        if (spanExcerpt is not null) outRefs.Add(new EvidenceRef("source", doc.Id.ToString(), doc.Version, null, doc.FileName, spanExcerpt, picked.Id.ToString(), picked.Location ?? "", picked.IndexGeneration, picked.ContentHash ?? doc.ContentHash ?? ""));
        else outRefs.Add(EvidenceRef.ForSection(doc, picked));
      }
      else if (kind == "direction")
      {
        if (!Guid.TryParse(r.Ref, out var nid)) continue;
        if (!s.Notes.TryGetValue(nid, out var note) || note is null) continue;
        if (note.BoardId != boardId || note.Kind != "direction" || note.Provisional) continue;
        if (note.Scope == "meeting" && note.MeetingId != meetingId) continue;
        if (note.Scope != "board" && note.Scope != "meeting") continue;
        // Preserve validated SELECTED late quote: exact caller substring, not leading excerpt.
        if (!string.IsNullOrWhiteSpace(r.Excerpt))
        {
          if (!(note.Body ?? "").Contains(r.Excerpt!, StringComparison.Ordinal)) continue;
          outRefs.Add(new EvidenceRef("direction", note.Id.ToString(), null, null, note.Title, r.Excerpt!));
        }
        else outRefs.Add(EvidenceRef.ForNoteFull(note));
      }
      else if (kind == "record")
      {
        if (!Guid.TryParse(r.Ref, out var did)) continue;
        if (!s.Drafts.TryGetValue(did, out var draft) || draft is null) continue;
        if (draft.BoardId != boardId || draft.MeetingId != meetingId || draft.Status != "approved") continue;
        if (r.Version.HasValue && r.Version.Value != draft.Version) continue;
        var exp = RecordsOps.BuildExport(draft.ItemsJson ?? "[]", draft.ApprovedJson ?? "[]", false);
        if (string.IsNullOrWhiteSpace(exp)) continue;
        if (!string.IsNullOrWhiteSpace(r.Excerpt))
        {
          if (!exp.Contains(r.Excerpt!, StringComparison.Ordinal)) continue;
          outRefs.Add(EvidenceRef.ForRecord(draft, r.Excerpt!));
        }
        else outRefs.Add(EvidenceRef.ForRecord(draft, exp.Trim()));
      }
      else if (kind == "message")
      {
        var parts = (r.Ref ?? "").Split(":");
        if (parts.Length != 2) continue;
        if (!Guid.TryParse(parts[0], out var mmid) || mmid != meetingId) continue;
        if (!long.TryParse(parts[1], out var seq)) continue;
        List<Message> list;
        lock (s.MessageLock) { list = s.Messages.TryGetValue(meetingId, out var l) ? l.ToList() : new List<Message>(); }
        var msg = list.FirstOrDefault(x => x.Sequence == seq && x.MeetingId == meetingId && x.BoardId == boardId);
        if (msg is null || string.IsNullOrWhiteSpace(msg.Content)) continue;
        // Preserve validated SELECTED late quote for messages (char-500 span must survive, not become leading 240).
        if (!string.IsNullOrWhiteSpace(r.Excerpt))
        {
          if (!(msg.Content ?? "").Contains(r.Excerpt!, StringComparison.Ordinal)) continue;
          outRefs.Add(new EvidenceRef("message", meetingId.ToString() + ":" + seq, null, null, (msg.Sender ?? "") + " #" + seq, r.Excerpt!));
        }
        else outRefs.Add(new EvidenceRef("message", meetingId.ToString() + ":" + seq, null, null, (msg.Sender ?? "") + " #" + seq, EvidenceRef.ExactExcerpt(msg.Content ?? "", 240)));
      }
      else if (kind == "dossier")
      {
        if (!Guid.TryParse(r.Ref, out var eid)) continue;
        if (!s.Roster.TryGetValue(eid, out var ent) || ent is null) continue;
        if (r.Version.HasValue && r.Version.Value != ent.Version) continue;
        var link = s.Advisors.Values.FirstOrDefault(a => a.BoardId == boardId && a.RosterEntryId == eid && !a.Removed && a.Approved);
        if (link is null) continue;
        string dossierText = (link.BoardRole ?? "") + " " + (ent.Name ?? "") + " " + (ent.ProfileJson ?? "");
        if (string.IsNullOrWhiteSpace(dossierText)) continue;
        // Preserve validated SELECTED late quote for dossiers.
        if (!string.IsNullOrWhiteSpace(r.Excerpt))
        {
          if (!dossierText.Contains(r.Excerpt!, StringComparison.Ordinal)) continue;
          outRefs.Add(new EvidenceRef("dossier", ent.Id.ToString(), ent.Version, null, ent.Name, r.Excerpt!));
        }
        else
        {
          var dex = EvidenceRef.ExactExcerpt(dossierText, 240);
          outRefs.Add(new EvidenceRef("dossier", ent.Id.ToString(), ent.Version, null, ent.Name, dex));
        }
      }
      else if (kind == "note") continue;
    }
    return outRefs;
  }
  // Budgeted packet: caller refs are delivered first, then directions,
  // records, then per-section sources. Only actually included refs are
  // returned. Throws 502 if required caller evidence cannot fit.
  // Budgeted packet: caller refs are delivered first IN FULL, then automatic
  // directions/records/sources in full or not at all. Every persisted ref is
  // an exact substring of the returned packet. Automatic omissions are
  // reported via omittedOut and must be surfaced to the user, never saved
  // as citations. Throws 502 when required caller evidence cannot fit.
  // The owner input appears ONLY in the caller wrapper, never as an
  // OWNER REQUEST line and never via lead history (history is advisor-only).
  public static string BuildPacket(InMemoryStore s, Meeting m, string ownerInputForRanking, List<EvidenceRef> callerCanon, List<EvidenceRef> evidenceOut, int budgetChars, List<string>? omittedOut = null)
  {
    var sb = new StringBuilder();
    Board? board = null;
    s.Boards.TryGetValue(m.BoardId, out board);
    var eff = board is null ? "board:unknown" : LeadSetup.EffectiveView(s, board).name + " | " + LeadSetup.EffectiveView(s, board).mission;
    bool AppendLineBudgeted(string line, bool required)
    {
      if (sb.Length + line.Length + 1 > budgetChars)
      {
        if (required) throw new ProviderException(502, "Secretary context exceeds prompt budget; essential evidence cannot fit.");
        return false;
      }
      sb.AppendLine(line);
      return true;
    }
    // Essential mandatory context MUST be delivered whole or fail locally before any reservation.
    // Truncation of board/lead/brief tails is forbidden: a mandatory restriction after char 800 must not be silently dropped.
    AppendLineBudgeted("BOARD: " + eff, true);
    var __pb = s.Boards.TryGetValue(m.BoardId, out var __pbb) ? __pbb : null;
    var lead = __pb is null ? LeadSetup.ResolveLeadFor(s, m.BoardId) : LeadSetup.ResolveLeadForBoard(s, __pb);
    if (lead is not null) AppendLineBudgeted("LEAD: " + lead.Name + " (" + lead.RoleLabel + "). " + lead.Background, true);
    AppendLineBudgeted("MEETING BRIEF: " + (m.Brief ?? ""), true);
    List<Message> recent = new List<Message>();
    lock (s.MessageLock) { if (s.Messages.TryGetValue(m.Id, out var list)) recent = list.Where(x => !string.Equals(x.Sender, "lead", StringComparison.OrdinalIgnoreCase)).OrderByDescending(x => x.Sequence).Take(8).OrderBy(x => x.Sequence).ToList(); }
    foreach (var msg in recent) AppendLineBudgeted("HISTORY [" + msg.Sequence + "] " + msg.Sender + ": " + Trunc(msg.Content ?? "", 400), false);
    foreach (var c in callerCanon ?? new List<EvidenceRef>())
    {
      if (sb.Length > budgetChars - 500) throw new ProviderException(502, "Secretary caller evidence exceeds prompt budget.");
      if (c.Kind == "source")
      {
        if (!Guid.TryParse(c.Ref, out var sid) || !s.Sources.TryGetValue(sid, out var doc) || doc is null) continue;
        SourceSection? sec = null;
        if (!string.IsNullOrWhiteSpace(c.SectionId) && Guid.TryParse(c.SectionId, out var scid))
          sec = s.SourceSections.Values.FirstOrDefault(x => x.Id == scid && x.SourceId == doc.Id);
        if (sec is null) continue;
        var span = string.IsNullOrWhiteSpace(c.Excerpt) ? (sec.Text ?? "") : c.Excerpt!;
        var line = "CALLER SOURCE " + doc.FileName + " v" + doc.Version + " sec:" + sec.Ordinal + " [" + sec.Id + "] loc:" + (sec.Location ?? "") + ": " + span;
        var before = sb.Length;
        AppendLineBudgeted(line, true);
        if (sb.Length > before) evidenceOut.Add(c);
      }
      else if (c.Kind == "direction")
      {
        if (!Guid.TryParse(c.Ref, out var nid) || !s.Notes.TryGetValue(nid, out var note) || note is null) continue;
        var span = string.IsNullOrWhiteSpace(c.Excerpt) ? (note.Body ?? "") : c.Excerpt!;
        var line = "CALLER DIRECTION (" + note.Scope + "): " + span;
        var before = sb.Length;
        AppendLineBudgeted(line, true);
        if (sb.Length > before) evidenceOut.Add(c);
      }
      else if (c.Kind == "record")
      {
        if (!Guid.TryParse(c.Ref, out var did) || !s.Drafts.TryGetValue(did, out var draft) || draft is null) continue;
        var span = string.IsNullOrWhiteSpace(c.Excerpt) ? RecordsOps.BuildExport(draft.ItemsJson ?? "[]", draft.ApprovedJson ?? "[]", false).Trim() : c.Excerpt!;
        var line = "CALLER RECORD v" + draft.Version + ": " + span;
        var before = sb.Length;
        AppendLineBudgeted(line, true);
        if (sb.Length > before) evidenceOut.Add(c);
      }
      else
      {
        var line = "CALLER " + c.Kind.ToUpperInvariant() + " " + c.Ref + ": " + (c.Excerpt ?? "");
        var before = sb.Length;
        AppendLineBudgeted(line, true);
        if (sb.Length > before) evidenceOut.Add(c);
      }
    }
    var callerKeys = new HashSet<string>((callerCanon ?? new List<EvidenceRef>()).Select(r => r.Kind + ":" + r.Ref + ":" + (r.SectionId ?? "")));
    var dirs = s.Notes.Values.Where(n => n.BoardId == m.BoardId && n.Kind == "direction" && !n.Provisional && (n.Scope == "board" || n.MeetingId == m.Id)).OrderByDescending(n => n.CreatedAt).ToList();
    foreach (var d in dirs)
    {
      var key = "direction:" + d.Id;
      if (callerKeys.Any(k => k.StartsWith(key))) continue;
      var body = d.Body ?? "";
      var line = "ADOPTED DIRECTION (" + d.Scope + "): " + body;
      var before = sb.Length;
      if (AppendLineBudgeted(line, false)) evidenceOut.Add(EvidenceRef.ForNote(d));
      else { omittedOut?.Add("direction:" + d.Id); continue; }
    }
    var approved = s.Drafts.Values.Where(d => d.MeetingId == m.Id && d.Status == "approved").OrderByDescending(d => d.Version).ToList();
    foreach (var d in approved)
    {
      var key = "record:" + d.Id;
      if (callerKeys.Any(k => k.StartsWith(key))) continue;
      var exp = RecordsOps.BuildExport(d.ItemsJson ?? "[]", d.ApprovedJson ?? "[]", false).Trim();
      if (string.IsNullOrWhiteSpace(exp)) continue;
      var line = "APPROVED RECORD v" + d.Version + ": " + exp;
      var before = sb.Length;
      if (AppendLineBudgeted(line, false)) evidenceOut.Add(EvidenceRef.ForRecord(d, EvidenceRef.ExactExcerpt(exp, 240)));
      else { omittedOut?.Add("record:" + d.Id + ":v" + d.Version); continue; }
    }
    var words = (ownerInputForRanking ?? "").ToLowerInvariant().Split(new[] { " ", ",", ".", ";", ":", "?", "!", "\n", "\r", "\t", "-", "(", ")" }, StringSplitOptions.RemoveEmptyEntries).Where(w => w.Length > 3).Distinct().Take(30).ToHashSet();
    var ranked = s.Sources.Values.Where(x => x.BoardId == m.BoardId && SourceGovernance.VisibleForRecall(s, x, m.BoardId, m.Id)).Select(x => new { doc = x, secs = s.SourceSections.Values.Where(z => z.SourceId == x.Id).OrderBy(z => z.Ordinal).ToList() }).Where(e => e.secs.Count > 0).ToList();
    int Score(SourceDoc doc, List<SourceSection> secs)
    {
      var corpus = string.Join(" ", secs.Select(z => (z.Heading ?? "") + " " + (z.Text ?? ""))).ToLowerInvariant();
      int sc = 0;
      foreach (var w in words) { int idx = 0; while ((idx = corpus.IndexOf(w, idx, StringComparison.Ordinal)) >= 0) { sc++; idx += w.Length; } }
      return sc;
    }
    var orderedDocs = ranked.OrderByDescending(e => Score(e.doc, e.secs)).ToList();
    foreach (var e in orderedDocs)
    {
      foreach (var sec in e.secs)
      {
        var key = "source:" + e.doc.Id + ":" + sec.Id;
        if (callerKeys.Contains(key)) continue;
        if (sec.SourceVersion != e.doc.Version || sec.IndexGeneration != e.doc.IndexGeneration) continue;
        if (!string.Equals(sec.ContentHash ?? "", e.doc.ContentHash ?? "", StringComparison.Ordinal)) continue;
        if (string.IsNullOrWhiteSpace(sec.Text)) continue;
        var line = "SOURCE " + e.doc.FileName + " v" + e.doc.Version + " sec:" + sec.Ordinal + " [" + sec.Id + "] loc:" + (sec.Location ?? "") + ": " + (sec.Text ?? "");
        var before = sb.Length;
        if (AppendLineBudgeted(line, false)) evidenceOut.Add(EvidenceRef.ForSection(e.doc, sec));
        else { omittedOut?.Add("source:" + e.doc.Id + ":" + sec.Id); continue; }
      }
      // No early budget-stop break: every remaining automatic input must be enumerated in omittedOut.
      // If budget is exhausted, subsequent AppendLineBudgeted calls will fail and record each omission individually.
    }
    if (evidenceOut.Count == 0)
      AppendLineBudgeted("EVIDENCE LIMITATION: No eligible approved sources, adopted directions, or approved records are available for this meeting. State this limitation clearly and do not invent support.", false);
    return sb.ToString();
  }
}

public sealed record SecretaryOutcome(string Kind, string Title, string Body, string Question);

public static class SecretaryOutcomeParser
{
  static void ValidateShape(string text)
  {
    var seen = new HashSet<string>(StringComparer.Ordinal);
    var bytes = Encoding.UTF8.GetBytes(text);
    var reader = new Utf8JsonReader(bytes, new JsonReaderOptions { AllowTrailingCommas = false, CommentHandling = JsonCommentHandling.Disallow });
    if (!reader.Read() || reader.TokenType != JsonTokenType.StartObject)
      throw new ProviderException(502, "malformed secretary response: expected JSON object");
    int depth = 1;
    while (reader.Read())
    {
      if (reader.TokenType == JsonTokenType.StartObject || reader.TokenType == JsonTokenType.StartArray) { depth++; continue; }
      if (reader.TokenType == JsonTokenType.EndObject || reader.TokenType == JsonTokenType.EndArray)
      {
        depth--;
        if (depth == 0) break;
        continue;
      }
      if (reader.TokenType == JsonTokenType.PropertyName && depth == 1)
      {
        string name = reader.GetString() ?? "";
        if (!seen.Add(name)) throw new ProviderException(502, "malformed secretary response: duplicate field '" + name + "'");
        if (name == "kind" || name == "title" || name == "body" || name == "question")
        {
          if (!reader.Read()) throw new ProviderException(502, "malformed secretary response: field '" + name + "' missing value");
          if (reader.TokenType != JsonTokenType.String)
            throw new ProviderException(502, "malformed secretary response: field '" + name + "' must be a string");
        }
      }
    }
  }
  public static SecretaryOutcome Parse(string raw)
  {
    var text = (raw ?? "").Trim();
    if (string.IsNullOrWhiteSpace(text)) throw new ProviderException(502, "malformed provider envelope: secretary content empty");
    if (text.StartsWith("```")) throw new ProviderException(502, "malformed secretary response: fenced code block");
    if (!text.StartsWith("{")) throw new ProviderException(502, "malformed secretary response: expected JSON object");
    try
    {
      ValidateShape(text);
      using var doc = JsonDocument.Parse(text);
      var root = doc.RootElement;
      if (root.ValueKind != JsonValueKind.Object) throw new ProviderException(502, "malformed secretary response: expected JSON object");
      if (root.ValueKind == JsonValueKind.Array) throw new ProviderException(502, "malformed secretary response: array not allowed");
      string Get(string n) { if (root.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String) return v.GetString() ?? ""; return ""; }

      var kind = Get("kind").Trim().ToLowerInvariant();
      var title = Get("title");
      var body = Get("body");
      var question = Get("question");
      var allowed = new HashSet<string> { "note", "briefing", "secretary-note", "secretary-briefing", "question" };
      if (string.IsNullOrWhiteSpace(kind)) throw new ProviderException(502, "malformed secretary response: kind missing");
      if (!allowed.Contains(kind)) throw new ProviderException(502, "malformed secretary response: unknown kind " + kind);
      bool hasBody = !string.IsNullOrWhiteSpace(body);
      bool hasQuestion = !string.IsNullOrWhiteSpace(question);
      if (hasBody && hasQuestion) throw new ProviderException(502, "malformed secretary response: contradictory body+question");
      if (kind == "question")
      {
        if (!hasQuestion) throw new ProviderException(502, "malformed secretary response: question missing");
        if (hasBody) throw new ProviderException(502, "malformed secretary response: question must not carry body");
        if (question.Trim().Length > 2000) throw new ProviderException(502, "malformed secretary response: question too long");
        return new SecretaryOutcome("question", "", "", question.Trim());
      }
      if (!hasBody) throw new ProviderException(502, "malformed secretary response: body missing");
      if (body.Trim().Length > 12000) throw new ProviderException(502, "malformed secretary response: body too long");
      if (string.IsNullOrWhiteSpace(title)) throw new ProviderException(502, "malformed secretary response: title missing");
      if (title.Trim().Length > 300) throw new ProviderException(502, "malformed secretary response: title too long");
      var nk = kind == "briefing" || kind == "secretary-briefing" ? "secretary-briefing" : "secretary-note";
      return new SecretaryOutcome(nk, title.Trim(), body.Trim(), "");
    }
    catch (JsonException ex) { throw new ProviderException(502, "malformed secretary response: invalid json " + ex.Message); }
  }
}

// One fresh-attempt/status-checked atomic transition helper for ALL durable
// changes. Fetch, validate, authorize, and mutate the same object inside the
// actual backend gate under Setup->MessageLock order. Callers must not mutate
// tracked request/note/history state outside this helper.
public static class SecretaryTransitions
{
  public static T Run<T>(InMemoryStore s, Func<T> op)
  {
    lock (s.SetupLock) { lock (s.MessageLock) { return Atomic.Run(s, op); } }
  }
  public static void Run(InMemoryStore s, Action op)
  {
    lock (s.SetupLock) { lock (s.MessageLock) { Atomic.Run(s, op); } }
  }
  public static bool TryBindAttempt(InMemoryStore s, Guid reqId, Guid attempt, bool answer, out SecretaryRequest? req)
  {
    req = null;
    if (!s.SecretaryRequests.TryGetValue(reqId, out var r) || r is null) return false;
    if (answer) { if (r.AnswerAttemptId != attempt) return false; }
    else { if (r.AttemptId != attempt) return false; }
    req = r;
    return true;
  }
  // Determinate publication failure -> durable recoverable state (failed or
  // discarded) bound to the exact attempt. Never leaves inflight/answering.
  public static void MarkTerminal(InMemoryStore s, Guid reqId, Guid attempt, bool answer, string status, string error)
  {
    Run(s, () =>
    {
      if (!TryBindAttempt(s, reqId, attempt, answer, out var r) || r is null) return;
      if (answer) { if (r.Status != "answering") return; }
      else { if (r.Status != "inflight" && r.Status != "pending") return; }
      r.Status = status; r.Error = error; r.UpdatedAt = DateTime.UtcNow;
      s.SecretaryRequests[reqId] = r;
      s.SecretaryRequests.Flush();
    });
  }
  // Uncertain commit outcome (timeout/connection drop during commit): the note
  // may or may not have persisted. Reconcile durably before any new
  // generation: if the addressed note + created-history row exist, adopt the
  // completed result; otherwise mark failed-retryable. No blind retry.
  public static void ReconcileAfterUncertainCommit(InMemoryStore s, Guid reqId, Guid? noteId, Guid rootId)
  {
    Run(s, () =>
    {
      if (!s.SecretaryRequests.TryGetValue(reqId, out var r) || r is null) return;
      if (r.Status == "completed") return;
      if (noteId.HasValue && s.Notes.TryGetValue(noteId.Value, out var n) && n is not null
        && s.NoteHistories.Values.Any(h => h.NoteId == n.Id && h.RootId == rootId && h.Action == "created"))
      {
        r.Status = "completed"; r.NoteId = n.Id; r.CompletedAt = r.CompletedAt ?? DateTime.UtcNow;
        r.Error = "Recovered after uncertain commit; result adopted without regeneration.";
        r.UpdatedAt = DateTime.UtcNow;
      }
      else
      {
        if (r.Status == "inflight" || r.Status == "answering" || r.Status == "pending")
        { r.Status = "failed"; r.Error = "Uncertain commit outcome; reconciled with no persisted note. Safe to retry with the same nonce."; r.UpdatedAt = DateTime.UtcNow; }
      }
      s.SecretaryRequests[reqId] = r;
      s.SecretaryRequests.Flush();
    });
  }
}
public static class SecretaryRecovery
{
  // Called once after PG wire (Program.cs). Errors fail closed (throw) so a
  // half-recovered store never serves traffic. No blanket catch.
  public static int RecoverInterrupted(InMemoryStore s)
  {
    int n = 0;
    SecretaryTransitions.Run(s, () =>
    {
      foreach (var r in s.SecretaryRequests.Values.ToList())
      {
        if (r.Status == "pending" || r.Status == "inflight" || r.Status == "answering")
        {
          r.Status = "interrupted";
          r.Error = "Process restarted during generation; retry with the same nonce and payload.";
          r.UpdatedAt = DateTime.UtcNow;
          s.SecretaryRequests[r.Id] = r;
          n++;
        }
      }
      s.SecretaryRequests.Flush();
    });
    return n;
  }
}
// Current availability of a persisted historical ref, resolved separately
// from the immutable historical quotation. Historical text is never mutated;
// this label only describes what is current NOW.
public static class EvidenceAvailability
{
  public sealed record Status(bool Available, string Reason);
  public static Status Resolve(InMemoryStore s, EvidenceRef r, Guid boardId, Guid? meetingId)
  {
    var kind = (r.Kind ?? "").Trim().ToLowerInvariant();
    if (kind == "source")
    {
      if (!Guid.TryParse(r.Ref, out var sid) || !s.Sources.TryGetValue(sid, out var doc) || doc is null)
        return new Status(false, "source removed");
      if (doc.BoardId != boardId) return new Status(false, "source moved");
      if (!SourceGovernance.VisibleForRecall(s, doc, boardId, meetingId))
        return new Status(false, "source not currently eligible");
      if (r.Version.HasValue && r.Version.Value != doc.Version)
        return new Status(false, "superseded by v" + doc.Version);
      if (!string.IsNullOrWhiteSpace(r.SectionId) && Guid.TryParse(r.SectionId, out var secId))
      {
        var sec = s.SourceSections.Values.FirstOrDefault(x => x.Id == secId && x.SourceId == doc.Id);
        if (sec is null) return new Status(false, "section removed");
        if (sec.SourceVersion != doc.Version || sec.IndexGeneration != doc.IndexGeneration)
          return new Status(false, "section reindexed");
        if (r.IndexGeneration.HasValue && r.IndexGeneration.Value != sec.IndexGeneration)
          return new Status(false, "section reindexed to g" + sec.IndexGeneration);
        if (!string.IsNullOrWhiteSpace(r.ContentHash) && !string.Equals(r.ContentHash, sec.ContentHash ?? doc.ContentHash ?? "", StringComparison.Ordinal))
          return new Status(false, "section content changed");
        if (r.Version.HasValue && r.Version.Value != sec.SourceVersion)
          return new Status(false, "section superseded");
      }
      return new Status(true, "current");
    }
    if (kind == "direction")
    {
      if (!Guid.TryParse(r.Ref, out var nid) || !s.Notes.TryGetValue(nid, out var note) || note is null)
        return new Status(false, "direction removed");
      if (note.BoardId != boardId) return new Status(false, "direction moved");
      if (note.Kind != "direction" || note.Provisional) return new Status(false, "direction no longer adopted");
      if (note.Scope == "meeting" && (!meetingId.HasValue || note.MeetingId != meetingId.Value))
        return new Status(false, "direction not in this meeting");
      if (note.Scope != "board" && note.Scope != "meeting") return new Status(false, "direction scope changed");
      return new Status(true, "current");
    }
    if (kind == "record")
    {
      if (!Guid.TryParse(r.Ref, out var did) || !s.Drafts.TryGetValue(did, out var d) || d is null)
        return new Status(false, "record removed");
      if (d.BoardId != boardId) return new Status(false, "record moved");
      if (d.MeetingId != meetingId) return new Status(false, "record not in this meeting");
      if (r.Version.HasValue && r.Version.Value != d.Version)
        return new Status(false, "superseded by v" + d.Version);
      if (!string.Equals(d.Status, "approved", StringComparison.OrdinalIgnoreCase))
        return new Status(false, "record no longer approved");
      return new Status(true, "current");
    }
    if (kind == "message")
    {
      var parts = (r.Ref ?? "").Split(":");
      if (parts.Length != 2 || !Guid.TryParse(parts[0], out var mmid)) return new Status(false, "message removed");
      List<Message> list;
      lock (s.MessageLock) { list = s.Messages.TryGetValue(mmid, out var l) ? l.ToList() : new List<Message>(); }
      if (!long.TryParse(parts[1], out var seq) || !list.Any(x => x.Sequence == seq)) return new Status(false, "message removed");
      return new Status(true, "current");
    }
    if (kind == "dossier")
    {
      if (!Guid.TryParse(r.Ref, out var eid) || !s.Roster.TryGetValue(eid, out var ent) || ent is null)
        return new Status(false, "dossier removed");
      if (r.Version.HasValue && r.Version.Value != ent.Version)
        return new Status(false, "dossier superseded by v" + ent.Version);
      var link = s.Advisors.Values.FirstOrDefault(a => a.BoardId == boardId && a.RosterEntryId == eid && !a.Removed && a.Approved);
      if (link is null) return new Status(false, "advisor not currently assigned");
      return new Status(true, "current");
    }
    return new Status(false, "unknown kind");
  }
}
public static class SecretaryEndpoints
{
  static bool IsRetryableStatus(string st) => st == "failed" || st == "discarded" || st == "interrupted";
  static readonly System.Collections.Concurrent.ConcurrentDictionary<Guid, byte> LiveAttempts = new();
  // Uncertain terminal marker bound to the exact failed attempt. Value is the attempt id whose terminal write failed.
  // A marker for an old attempt MUST NOT supersede a newer live attempt; it retires only after authoritative reconcile + successful new reservation.
  static readonly System.Collections.Concurrent.ConcurrentDictionary<Guid, Guid> UncertainTerminal = new();
  static int LeaseSeconds = 120;
  // Best-effort error-path transition; the mutation itself runs inside the
  // atomic gate via MarkTerminal. Returns false when even the recovery write
  // failed; callers must then surface an honest 503 (never a blind retry).
  // Storage-layer faults (Postgres/EF/Npgsql/transport) get controlled
  // recoverable outcomes; code bugs still surface. Transport breaks during
  // publication are genuinely uncertain (commit may have succeeded), so
  // they reconcile against ground truth instead of assuming failure.
  internal static bool IsStorageFault(Exception? ex)
  {
    if (ex is null) return false;
    if (ex is SimCEO.Api.Data.PolicyUnavailableException) return true;
    if (ex is TimeoutException or System.IO.IOException or TaskCanceledException or OperationCanceledException) return true;
    var tn = ex.GetType().FullName ?? "";
    if (tn.Contains("Npgsql", StringComparison.OrdinalIgnoreCase) || tn.Contains("Postgres", StringComparison.OrdinalIgnoreCase) || tn.Contains("EntityFramework", StringComparison.OrdinalIgnoreCase) || tn.Contains("DbUpdate", StringComparison.Ordinal)) return true;
    return IsStorageFault(ex.InnerException);
  }
  internal static bool IsTransportBreak(Exception? ex)
  {
    if (ex is null) return false;
    if (ex is SimCEO.Api.Data.PostCommitException) return true;
    if (ex is TimeoutException or System.IO.IOException or TaskCanceledException or OperationCanceledException || ex is System.Net.Sockets.SocketException) return true;
    return IsTransportBreak(ex.InnerException);
  }
  // Narrow delivery-shape helper (review #11): distinguish missing manifests
  // from known-empty manifests. Null/whitespace/invalid JSON => null (missing,
  // never fabricated as []); valid JSON (including "[]") is returned as-is so
  // normal/answer/initial-failure hydrate/replay stay consistent. Callers
  // expose this as `omitted` on idempotent replay and GET request.
  internal static List<string>? ParseOmittedManifest(string? json)
  {
    if (string.IsNullOrWhiteSpace(json)) return null;
    try { return System.Text.Json.JsonSerializer.Deserialize<List<string>>(json); }
    catch { return null; }
  }
  static bool FailBound(InMemoryStore s, Guid reqId, Guid attempt, string err)
  {
    try { SecretaryTransitions.MarkTerminal(s, reqId, attempt, false, "failed", err); return true; }
    catch { try { UncertainTerminal[reqId] = attempt; } catch { } return false; }
  }
  static bool FailBoundAnswer(InMemoryStore s, Guid reqId, Guid attempt, string err)
  {
    try { SecretaryTransitions.MarkTerminal(s, reqId, attempt, true, "needs-clarification", err); return true; }
    catch { try { UncertainTerminal[reqId] = attempt; } catch { } return false; }
  }
  public static void MapSecretary(this WebApplication app)
  {
    var gw = new ModelGateway(app.Services.GetRequiredService<InMemoryStore>());
    app.MapPost("/api/meetings/{id:guid}/secretary", async (InMemoryStore s, HttpRequest req, Guid id, JsonElement body) =>
    {
      if (!s.Meetings.TryGetValue(id, out var m0)) return Results.NotFound("meeting");
      if (!PeopleOps.Can(s, req, m0.BoardId, id, "read")) return PeopleOps.Denied();
      string rawInput = "";
      if (body.ValueKind == JsonValueKind.Object)
      {
        if (body.TryGetProperty("input", out var iv) && iv.ValueKind == JsonValueKind.String) rawInput = iv.GetString() ?? "";
        else if (body.TryGetProperty("request", out var rv) && rv.ValueKind == JsonValueKind.String) rawInput = rv.GetString() ?? "";
        else if (body.TryGetProperty("text", out var tv) && tv.ValueKind == JsonValueKind.String) rawInput = tv.GetString() ?? "";
        else if (body.TryGetProperty("topic", out var tp) && tp.ValueKind == JsonValueKind.String) rawInput = tp.GetString() ?? "";
      }
      var nonce = "";
      if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("clientNonce", out var nv) && nv.ValueKind == JsonValueKind.String) nonce = (nv.GetString() ?? "").Trim();
      if (string.IsNullOrWhiteSpace(nonce) && body.ValueKind == JsonValueKind.Object && body.TryGetProperty("requestId", out var ridv) && ridv.ValueKind == JsonValueKind.String) nonce = (ridv.GetString() ?? "").Trim();
      if (string.IsNullOrWhiteSpace(nonce)) return Results.BadRequest("clientNonce is required.");
      var normalized = SecretaryDirect.StripPrefix(rawInput ?? "");
      if (string.IsNullOrWhiteSpace(normalized)) return Results.BadRequest("input is required.");
      var rawCaller = new List<EvidenceRef>();
      if (body.ValueKind == JsonValueKind.Object) rawCaller = EvidenceRef.ParseList(body, "evidence");
      SecretaryRequest? reserved = null;
      string reservedPrompt = "";
      List<EvidenceRef> reservedDelivered = new();
      bool staleSupersede = false;
      SecretaryRequest? replay = null;
      string replayKind = "";
      IResult? early = null;
      lock (s.SetupLock) { lock (s.MessageLock) {
        try { early = Atomic.Run<IResult?>(s, () =>
        {
          if (!s.Meetings.TryGetValue(id, out var cur0)) return Results.NotFound("meeting");
          var sub0 = SecretaryDirect.SubmissionHash(normalized, rawCaller);
          var existing = s.SecretaryRequests.Values.Where(r => r.MeetingId == id && r.ClientNonce == nonce).OrderByDescending(r => r.CreatedAt).FirstOrDefault();
          if (existing is not null)
          {
            bool samePayload;
            if (!string.IsNullOrWhiteSpace(existing.SubmissionHash))
            {
              samePayload = string.Equals(existing.SubmissionHash, sub0, StringComparison.Ordinal);
              if (!samePayload && SecretaryDirect.IsLegacyCallerIdentityJson(existing.CallerRefsJson))
                samePayload = string.Equals(existing.SubmissionHash, SecretaryDirect.SubmissionHashLegacy(normalized, rawCaller), StringComparison.Ordinal);
            }
            else
            {
              var canonLegacy = SecretaryContext.CanonicalizeCaller(s, cur0.BoardId, id, rawCaller);
              samePayload = string.Equals(existing.InputHash, SecretaryDirect.CausalHash(normalized, SecretaryDirect.CanonicalEvidenceJson(canonLegacy)), StringComparison.Ordinal);
            }
            if (!samePayload)
              return Results.Json(new { error = "Conflicting payload for the same clientNonce." }, statusCode: 409);
            if (existing.Status == "completed")
            {
              if (!PeopleOps.Can(s, req, existing.BoardId, id, "read")) return Results.Json(new { error = "Access revoked or not granted for this scope." }, statusCode: 403);
              if (!existing.NoteId.HasValue || !s.Notes.TryGetValue(existing.NoteId.Value, out var doneNote) || doneNote is null)
              {
                existing.Status = "failed"; existing.Error = "Completed result is no longer available; safe to retry with the same nonce."; existing.UpdatedAt = DateTime.UtcNow;
                s.SecretaryRequests[existing.Id] = existing; s.SecretaryRequests.Flush();
                return Results.Json(new { error = "Completed result is no longer available; retry with the same nonce." }, statusCode: 409);
              }
              if (doneNote.BoardId != existing.BoardId || doneNote.MeetingId != id) return Results.NotFound("secretary request not found.");
              if (!PeopleOps.Can(s, req, doneNote.BoardId, doneNote.MeetingId, "read")) return Results.Json(new { error = "Access revoked or not granted for this scope." }, statusCode: 403);
              replay = existing; replayKind = "completed"; return null;
            }
            if (existing is not null && existing.Status == "needs-clarification")
            {
              if (!PeopleOps.Can(s, req, existing.BoardId, id, "read")) return Results.Json(new { error = "Access revoked or not granted for this scope." }, statusCode: 403);
              replay = existing; replayKind = "clarify"; return null;
            }
            if (existing is not null && (string.Equals(existing.Phase, "continuation", StringComparison.OrdinalIgnoreCase) || !string.IsNullOrWhiteSpace(existing.Question)))
              return Results.Json(new { error = "This request is awaiting a clarification answer; retry the continuation via /secretary/answer with the same requestId." }, statusCode: 409);
            if (existing is not null && (existing.Status == "pending" || existing.Status == "inflight" || existing.Status == "answering"))
            {
              var rel0 = existing.Status == "answering" ? existing.AnswerAttemptId : existing.AttemptId;
              bool live0 = rel0 != Guid.Empty && LiveAttempts.ContainsKey(rel0);
              if (live0)
                return Results.Json(new { error = "Secretary request is already in flight for this nonce." }, statusCode: 409);
              Guid failedAtt0 = Guid.Empty;
              bool hasUncertain0 = false;
              try { hasUncertain0 = UncertainTerminal.TryGetValue(existing.Id, out failedAtt0); } catch { }
              bool uncertainForCurrent0 = hasUncertain0 && (failedAtt0 == Guid.Empty || failedAtt0 == rel0);
              bool stale = false;
              if (!uncertainForCurrent0)
              {
                if ((DateTime.UtcNow - existing.UpdatedAt).TotalSeconds > LeaseSeconds) stale = true;
                if (!stale)
                  return Results.Json(new { error = "Secretary request is already in flight for this nonce." }, statusCode: 409);
              }
              if (uncertainForCurrent0)
              {
                Guid unRoot = Guid.Empty;
                if (existing.NoteId.HasValue && s.Notes.TryGetValue(existing.NoteId.Value, out var un0) && un0 is not null)
                  unRoot = un0.RootId == Guid.Empty ? un0.Id : un0.RootId;
                SecretaryTransitions.ReconcileAfterUncertainCommit(s, existing.Id, existing.NoteId, unRoot);
                if (s.SecretaryRequests.TryGetValue(existing.Id, out var reconciled) && reconciled is not null) existing = reconciled;
                if (existing.Status == "completed")
                {
                  if (!PeopleOps.Can(s, req, existing.BoardId, id, "read")) return Results.Json(new { error = "Access revoked or not granted for this scope." }, statusCode: 403);
                  if (!existing.NoteId.HasValue || !s.Notes.TryGetValue(existing.NoteId.Value, out var doneNote2) || doneNote2 is null)
                  {
                    existing.Status = "failed"; existing.Error = "Reconciled result is no longer available; safe to retry with the same nonce."; existing.UpdatedAt = DateTime.UtcNow;
                    s.SecretaryRequests[existing.Id] = existing; s.SecretaryRequests.Flush();
                    return Results.Json(new { error = "Reconciled result is no longer available; retry with the same nonce." }, statusCode: 409);
                  }
                  if (doneNote2.BoardId != existing.BoardId || doneNote2.MeetingId != id) return Results.NotFound("secretary request not found.");
                  if (!PeopleOps.Can(s, req, doneNote2.BoardId, doneNote2.MeetingId, "read")) return Results.Json(new { error = "Access revoked or not granted for this scope." }, statusCode: 403);
                  try { UncertainTerminal.TryRemove(existing.Id, out _); } catch { }
                  replay = existing; replayKind = "completed"; return null;
                }
              }
              staleSupersede = true;
            }
          }
          bool canContrib = PeopleOps.Can(s, req, cur0.BoardId, id, "contribute");
          if (!canContrib) return Results.Json(new { error = "Access revoked or not granted for this scope." }, statusCode: 403);
          var setupFixes = new List<string>();
          { var __sb = s.Boards.TryGetValue(cur0.BoardId, out var __sbb) ? __sbb : null; var __sl = __sb is null ? LeadSetup.ResolveLeadFor(s, cur0.BoardId) : LeadSetup.ResolveLeadForBoard(s, __sb); if (__sl is null) setupFixes.Add("Save the board-lead profile."); }
          if (!s.Advisors.Values.Any(a => a.BoardId == cur0.BoardId && !a.Removed && a.Approved && RosterOps.ApprovalGate(s, a) is null)) setupFixes.Add("Approve at least one eligible advisor on this board.");
          if (setupFixes.Count > 0) return Results.Json(new { error = "Board setup is incomplete.", fixes = setupFixes }, statusCode: 409);
          if (PeopleOps.Guard(gw, req) is { } capped) return capped;
          if (cur0.State is not (MeetingState.Active or MeetingState.AwaitingBrief)) return Results.Json(new { error = "Meeting is not active." }, statusCode: 409);
                    bool isRetryBase = existing is not null && IsRetryableStatus(existing.Status);
          bool doReserve = isRetryBase || staleSupersede;
          SecretaryRequest reqRow;
          var attempt = Guid.NewGuid();
          var canonNew = SecretaryContext.CanonicalizeCaller(s, cur0.BoardId, id, rawCaller);
          var curHash = SecretaryDirect.CausalHash(normalized, SecretaryDirect.CanonicalEvidenceJson(canonNew));
          const string head = "You are the board secretary. Return JSON only.\nIf the request is genuinely ambiguous, return one clarification question as JSON.\nOtherwise return a provisional note or briefing as JSON with title and body.\n";
          string tail = "\nRAW OWNER INPUT: " + normalized + "\n";
          int packetBudget = 32000 - head.Length - tail.Length - 1000;
          if (packetBudget < 4000)
            return Results.Json(new { error = "Secretary prompt exceeds budget; essential context cannot fit." }, statusCode: 502);
          var prepRefs = new List<EvidenceRef>(); var prepOmit = new List<string>();
          string prepPacket;
          try { prepPacket = SecretaryContext.BuildPacket(s, cur0, normalized, canonNew, prepRefs, packetBudget, prepOmit); }
          catch (ProviderException pexPrep) { return PeopleOps.ProviderError(pexPrep); }
          string prepFooter = prepOmit.Count > 0 ? "\nOMITTED FROM PACKET (not cited as evidence): " + string.Join("; ", prepOmit) + "\n" : "";
          if (head.Length + prepPacket.Length + prepFooter.Length + tail.Length > 32000)
            return Results.Json(new { error = "Secretary prompt exceeds budget; essential context cannot fit." }, statusCode: 502);
          string prepPrompt = head + prepPacket + prepFooter + tail;
          foreach (var d in prepRefs.ToList())
          {
            if (string.IsNullOrWhiteSpace(d.Excerpt) || !prepPrompt.Contains(d.Excerpt!, StringComparison.Ordinal))
            {
              bool isCaller = canonNew.Any(c => c.Kind == d.Kind && c.Ref == d.Ref && (c.SectionId ?? "") == (d.SectionId ?? ""));
              if (isCaller)
                return Results.Json(new { error = "Secretary caller evidence exceeds prompt budget." }, statusCode: 502);
              prepRefs.Remove(d);
              prepOmit.Add(d.Kind + ":" + d.Ref + ":undelivered");
            }
          }
          if (prepOmit.Count > 0 && string.IsNullOrWhiteSpace(prepFooter))
          {
            prepFooter = "\nOMITTED FROM PACKET (not cited as evidence): " + string.Join("; ", prepOmit) + "\n";
            prepPrompt = head + prepPacket + prepFooter + tail;
            if (prepPrompt.Length > 32000)
              return Results.Json(new { error = "Secretary prompt exceeds budget; essential context cannot fit." }, statusCode: 502);
          }
          string prepHash;
          try
          {
            var (prepDev, prepUser) = ModelGateway.BuildSecretaryPayload("secretary", prepPrompt, SecretaryDirect.InputTokens, false);
            prepHash = ModelGateway.HashDeliveredPrompt(prepDev, prepUser);
          }
          catch (ProviderException pexGw) { return PeopleOps.ProviderError(pexGw); }
          if (doReserve && existing is not null)
          {
            reqRow = existing;
            string keepQuestion = reqRow.Question ?? "";
            string keepAnswer = reqRow.Answer ?? "";
            string keepPhase = !string.IsNullOrWhiteSpace(reqRow.Phase) ? reqRow.Phase : "initial";
            reqRow.AttemptId = attempt; reqRow.AnswerAttemptId = Guid.Empty;
            reqRow.InputText = normalized; reqRow.InputHash = curHash;
            reqRow.SubmissionHash = sub0; reqRow.CallerRefsJson = SecretaryDirect.RawCallerIdentityJson(rawCaller);
            reqRow.Phase = keepPhase; reqRow.Question = keepQuestion; reqRow.Answer = keepAnswer;
            reqRow.Status = "inflight"; reqRow.NoteId = null; reqRow.Error = ""; reqRow.UpdatedAt = DateTime.UtcNow;
            cur0.Generation++; reqRow.Generation = cur0.Generation;
            // Fresh capture AFTER the reservation mutations: RecentHash binds
            // DeliveredRevision, so a pre-mutation snapshot patched with new
            // counters would never equal the publication-time snapshot.
            var snapStored = SecretaryContext.CaptureSnapshot(s, cur0, rawCaller);
            reqRow.LeadFingerprint = snapStored.LeadFp; reqRow.EvidenceFingerprintJson = snapStored.EvFp;
            reqRow.RecentHash = snapStored.RecentHash; reqRow.EvidenceTextHash = snapStored.EvidenceTextHash; reqRow.DossierHash = snapStored.DossierHash;
            reqRow.SnapshotJson = SecretaryContext.SnapshotToJson(snapStored);
            reqRow.DeliveredRefsJson = EvidenceRef.ToJsonList(prepRefs);
            reqRow.DeliveredPromptHash = prepHash;
            try { reqRow.OmittedJson = System.Text.Json.JsonSerializer.Serialize(prepOmit); } catch { reqRow.OmittedJson = "[]"; }
            s.SecretaryRequests[reqRow.Id] = reqRow; s.Meetings.Flush(); s.SecretaryRequests.Flush();
            try { UncertainTerminal.TryRemove(existing.Id, out _); } catch { }
            reserved = reqRow; reservedPrompt = prepPrompt; reservedDelivered = prepRefs;
          }
          else
          {
            reqRow = new SecretaryRequest { BoardId = cur0.BoardId, MeetingId = id, ClientNonce = nonce, InputHash = curHash, InputText = normalized, Status = "inflight", Generation = cur0.Generation, LeadFingerprint = "", EvidenceFingerprintJson = "[]", SnapshotJson = "{}", Phase = "initial", SubmissionHash = sub0, CallerRefsJson = SecretaryDirect.RawCallerIdentityJson(rawCaller), AttemptId = attempt, CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow };
            var list = s.Messages.GetOrAdd(id, _ => new List<Message>());
            long newSeq = (list.Count == 0 ? 0 : list.Max(x => x.Sequence)) + 1;
            var msg = new Message { MeetingId = id, BoardId = cur0.BoardId, Sender = "lead", Content = normalized, Status = "committed", Sequence = newSeq, CreatedAt = DateTime.UtcNow };
            list.Add(msg);
            cur0.DeliveredRevision = newSeq;
            cur0.Generation++;
            reqRow.Generation = cur0.Generation;
            // Fresh capture AFTER the reservation mutations: RecentHash binds
            // DeliveredRevision, so a pre-mutation snapshot patched with new
            // counters would never equal the publication-time snapshot.
            var snapStored = SecretaryContext.CaptureSnapshot(s, cur0, rawCaller);
            reqRow.LeadFingerprint = snapStored.LeadFp; reqRow.EvidenceFingerprintJson = snapStored.EvFp;
            reqRow.RecentHash = snapStored.RecentHash; reqRow.EvidenceTextHash = snapStored.EvidenceTextHash; reqRow.DossierHash = snapStored.DossierHash;
            reqRow.SnapshotJson = SecretaryContext.SnapshotToJson(snapStored);
            reqRow.DeliveredRefsJson = EvidenceRef.ToJsonList(prepRefs);
            reqRow.DeliveredPromptHash = prepHash;
            try { reqRow.OmittedJson = System.Text.Json.JsonSerializer.Serialize(prepOmit); } catch { reqRow.OmittedJson = "[]"; }
            s.SecretaryRequests[reqRow.Id] = reqRow;
            s.Meetings.Flush();
            s.SecretaryRequests.Flush();
            reserved = reqRow; reservedPrompt = prepPrompt; reservedDelivered = prepRefs;
          }
return null;
        }); } catch (Exception ex) {
          if (ex is ProviderException) throw;
          var msg = ex.Message ?? "";
          if (msg.Contains("duplicate", StringComparison.OrdinalIgnoreCase) || msg.Contains("unique", StringComparison.OrdinalIgnoreCase) || msg.Contains("IX_SecretaryRequests"))
          {
            var subCatch = SecretaryDirect.SubmissionHash(normalized, rawCaller);
            var existing2 = s.SecretaryRequests.Values.Where(r => r.MeetingId == id && r.ClientNonce == nonce).OrderByDescending(r => r.CreatedAt).FirstOrDefault();
            if (existing2 is not null)
            {
              bool same2 = !string.IsNullOrWhiteSpace(existing2.SubmissionHash)
                ? string.Equals(existing2.SubmissionHash, subCatch, StringComparison.Ordinal)
                : string.Equals(existing2.InputHash, SecretaryDirect.CausalHash(normalized, SecretaryDirect.CanonicalEvidenceJson(SecretaryContext.CanonicalizeCaller(s, existing2.BoardId, id, rawCaller))), StringComparison.Ordinal);
              if (!same2) return Results.Json(new { error = "Conflicting payload for the same clientNonce." }, statusCode: 409);
              if (existing2.Status == "completed") return Results.Ok(new { requestId = existing2.Id, clientNonce = existing2.ClientNonce, status = existing2.Status, note = existing2.NoteId.HasValue && s.Notes.TryGetValue(existing2.NoteId.Value, out var dn) ? dn : null, replay = true });
              return Results.Json(new { error = "Secretary request is already in flight for this nonce." }, statusCode: 409);
            }
          }
          if (IsStorageFault(ex))
          {
            var gateRow = s.SecretaryRequests.Values.Where(r => r.MeetingId == id && r.ClientNonce == nonce).OrderByDescending(r => r.CreatedAt).FirstOrDefault();
            if (gateRow is not null && (gateRow.Status == "inflight" || gateRow.Status == "answering" || gateRow.Status == "pending"))
            {
              try { var __ga = gateRow.AttemptId != Guid.Empty ? gateRow.AttemptId : gateRow.AnswerAttemptId; UncertainTerminal[gateRow.Id] = __ga; } catch { }
              return Results.Json(new { error = "Reservation storage fault; recovery state marked uncertain. Re-read the request before retrying with the same nonce." }, statusCode: 503);
            }
            return Results.Json(new { error = "Reservation storage fault before any live reservation; safe to retry with the same nonce." }, statusCode: 502);
          }
          throw;
        }
      } }
      if (early is not null) return early;
      if (replay is not null)
      {
        if (replayKind == "completed")
        {
          s.Notes.TryGetValue(replay.NoteId!.Value, out var rn);
          var __omReplay = ParseOmittedManifest(replay.OmittedJson);
          return Results.Ok(new { requestId = replay.Id, clientNonce = replay.ClientNonce, status = replay.Status, note = rn, omitted = __omReplay, replay = true });
        }
        var __omReplayQ = ParseOmittedManifest(replay.OmittedJson);
        return Results.Ok(new { requestId = replay.Id, clientNonce = replay.ClientNonce, status = replay.Status, question = replay.Question, omitted = __omReplayQ, replay = true });
      }
      if (reserved is null || string.IsNullOrEmpty(reservedPrompt)) return Results.Json(new { error = "Reservation failed; retry with the same nonce." }, statusCode: 409);
      var myReq = reserved; var myAttempt = myReq.AttemptId;
      // Global restore identity pin: a restore between reservation and
      // publication must discard the stale reply even if snapshots coincide.
      var restoreBeforeS = s.RestoreEpochId;
      var delivered = reservedDelivered;
      string prompt = reservedPrompt;
      LiveAttempts[myAttempt] = 1;
      string modelText;
      try { modelText = await gw.CompleteAsync(ModelPolicy.SparkFor(s, myReq.BoardId), "secretary", prompt, SecretaryDirect.InputTokens, 2048, ownerOverride: PeopleOps.IsOwner(req), boardId: myReq.BoardId, meetingId: id, truncatePrompt: false); }
      catch (Exception ex) when (ex is ProviderException or CapExceededException)
      {
        if (!FailBound(s, myReq.Id, myAttempt, ex.Message))
          return Results.Json(new { error = "Provider failed and recovery state could not be persisted; do not retry blindly. Re-read the request before retrying with the same nonce." }, statusCode: 503);
        return PeopleOps.ModelError(ex);
      }
      finally { try { LiveAttempts.TryRemove(myAttempt, out _); } catch { } }
      SecretaryOutcome outcome;
      try { outcome = SecretaryOutcomeParser.Parse(modelText); }
      catch (ProviderException pex)
      {
        if (!FailBound(s, myReq.Id, myAttempt, pex.Message))
          return Results.Json(new { error = "Response was malformed and recovery state could not be persisted; do not retry blindly. Re-read the request before retrying with the same nonce." }, statusCode: 503);
        return PeopleOps.ProviderError(pex);
      }
      var pubNoteId = Guid.NewGuid();
      lock (s.SetupLock) { lock (s.MessageLock) {
        IResult pubResult;
        try
        {
        pubResult = Atomic.Run<IResult>(s, () =>
        {
          if (!s.SecretaryRequests.TryGetValue(myReq.Id, out var fresh) || fresh is null) return Results.Conflict("Secretary request moved on; retry.");
          if (fresh.AttemptId != myAttempt) return Results.Conflict("Secretary request moved on; retry.");
          if (fresh.Status != "inflight") return Results.Conflict("Secretary request moved on; retry.");
          if (!s.Meetings.TryGetValue(id, out var cur)) return Results.Conflict("Meeting moved on; draft discarded.");
          if (PeopleOps.IsSecure(s) && !AuthOps.TrySession(s, req, out _)) { fresh.Status = "failed"; fresh.Error = "Session expired during secretary work."; s.SecretaryRequests.Flush(); return Results.Json(new { error = "Authentication required." }, statusCode: 401); }
          if (!PeopleOps.Can(s, req, cur.BoardId, id, "contribute")) { fresh.Status = "failed"; fresh.Error = "Access revoked during secretary work."; s.SecretaryRequests.Flush(); return Results.Json(new { error = "Access revoked or not granted for this scope." }, statusCode: 403); }
          if (cur.State is not (MeetingState.Active or MeetingState.AwaitingBrief)) { fresh.Status = "discarded"; fresh.Error = "Meeting state changed during secretary work."; s.SecretaryRequests.Flush(); return Results.Json(new { error = "Meeting state changed during secretary work; draft discarded." }, statusCode: 409); }
          var nowSnap = SecretaryContext.CaptureSnapshot(s, cur, SecretaryDirect.RehydrateRawCallerRefs(fresh.CallerRefsJson));
          if (!SecretaryContext.TryParseSnapshot(fresh.SnapshotJson, out var beforeSnap) || beforeSnap is null)
          {
            fresh.Status = "discarded"; fresh.Error = "Stored request snapshot is invalid; retry with the same nonce."; s.SecretaryRequests.Flush();
            return Results.Json(new { error = fresh.Error }, statusCode: 409);
          }
          if (!SecretaryContext.SnapshotEquals(beforeSnap, nowSnap))
          {
            fresh.Status = "discarded"; fresh.Error = SecretaryContext.SnapshotMismatchReason(beforeSnap, nowSnap); s.SecretaryRequests.Flush();
            return Results.Json(new { error = fresh.Error }, statusCode: 409);
          }
          if (s.RestoreEpochId != restoreBeforeS)
          {
            fresh.Status = "discarded"; fresh.Error = "Domain was restored during secretary work; retry with the same nonce."; s.SecretaryRequests.Flush();
            return Results.Json(new { error = fresh.Error }, statusCode: 409);
          }
          if (outcome.Kind == "question")
          {
            fresh.Status = "needs-clarification"; fresh.Phase = "continuation"; fresh.Question = outcome.Question; fresh.DeliveredRefsJson = EvidenceRef.ToJsonList(delivered); fresh.DeliveredPromptHash = myReq.DeliveredPromptHash; fresh.UpdatedAt = DateTime.UtcNow; s.SecretaryRequests.Flush();
            List<string> __omQ = new();
            try { __omQ = System.Text.Json.JsonSerializer.Deserialize<List<string>>(fresh.OmittedJson ?? "[]") ?? new(); } catch { }
            return Results.Ok(new { requestId = fresh.Id, clientNonce = fresh.ClientNonce, status = fresh.Status, question = fresh.Question, omitted = __omQ });
          }
          var noteBody = outcome.Body;
          if (delivered.Count == 0) noteBody = noteBody + " [Limitation: No eligible approved sources, adopted directions, or approved records were available for this meeting.]";
          List<string> __omNoteEarly = new();
          try { __omNoteEarly = System.Text.Json.JsonSerializer.Deserialize<List<string>>(fresh.OmittedJson ?? "[]") ?? new(); } catch { }
          if (__omNoteEarly.Count > 0) noteBody = noteBody + " [Omitted from packet (not cited as evidence): " + string.Join("; ", __omNoteEarly) + "]";
          Note? created = null;
          {
            var note = new Note { BoardId = cur.BoardId, MeetingId = id, Kind = outcome.Kind, Title = outcome.Title, Body = noteBody, Scope = "meeting", Provisional = true, EvidenceJson = EvidenceRef.ToJsonList(delivered), Revision = 1, NoteStatus = "current", CreatedAt = DateTime.UtcNow };
            note.Id = pubNoteId; note.RootId = pubNoteId;
            s.Notes[note.Id] = note;
            var h = new NoteHistory { BoardId = cur.BoardId, MeetingId = id, NoteId = note.Id, RootId = note.RootId, Revision = 1, Title = note.Title, Body = note.Body, EvidenceJson = note.EvidenceJson, Action = "created", CreatedAt = DateTime.UtcNow };
            s.NoteHistories[h.Id] = h;
            fresh.Status = "completed"; fresh.NoteId = note.Id; fresh.CompletedAt = DateTime.UtcNow; fresh.UpdatedAt = DateTime.UtcNow;
            fresh.DeliveredRefsJson = EvidenceRef.ToJsonList(delivered); fresh.DeliveredPromptHash = myReq.DeliveredPromptHash;
            s.SecretaryRequests[myReq.Id] = fresh;
            s.Notes.Flush(); s.NoteHistories.Flush(); s.SecretaryRequests.Flush();
            created = note;
          }
          List<string> __omPub = new();
          try { __omPub = System.Text.Json.JsonSerializer.Deserialize<List<string>>(fresh.OmittedJson ?? "[]") ?? new(); } catch { }
          return Results.Ok(new { requestId = fresh.Id, clientNonce = fresh.ClientNonce, status = fresh.Status, note = created, omitted = __omPub });
        });
        }
        catch (Exception pubEx) when (pubEx is SimCEO.Api.Data.PostCommitException)
        {
          SecretaryTransitions.ReconcileAfterUncertainCommit(s, myReq.Id, pubNoteId, pubNoteId);
          return Results.Json(new { error = "Publication committed (or the commit outcome is unknown); reconciled against stored state. Re-read before retrying with the same nonce." }, statusCode: 502);
        }
        catch (Exception pubEx) when (IsTransportBreak(pubEx))
        {
          SecretaryTransitions.ReconcileAfterUncertainCommit(s, myReq.Id, pubNoteId, pubNoteId);
          return Results.Json(new { error = "Storage outcome uncertain during publication; reconciled. Retry with the same nonce." }, statusCode: 502);
        }
        catch (Exception pubEx) when (IsStorageFault(pubEx))
        {
          try { SecretaryTransitions.MarkTerminal(s, myReq.Id, myAttempt, false, "failed", "Storage fault during publication: " + pubEx.GetType().Name + ". Safe to retry with the same nonce."); }
          catch { try { UncertainTerminal[myReq.Id] = myAttempt; } catch { } return Results.Json(new { error = "Storage fault during publication and recovery state could not be persisted; do not retry blindly. Re-read the request before retrying with the same nonce." }, statusCode: 503); }
          return Results.Json(new { error = "Storage fault during publication; safe to retry with the same nonce." }, statusCode: 502);
        }
        return pubResult;
      } }
    });
    app.MapPost("/api/meetings/{id:guid}/secretary/answer", async (InMemoryStore s, HttpRequest req, Guid id, JsonElement body) =>
    {
      if (!s.Meetings.TryGetValue(id, out var m0)) return Results.NotFound("meeting");
      if (!PeopleOps.Can(s, req, m0.BoardId, id, "read")) return PeopleOps.Denied();
      Guid reqId = Guid.Empty;
      if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("requestId", out var rj)) { if (rj.ValueKind == JsonValueKind.String) Guid.TryParse(rj.GetString(), out reqId); }
      var answer = body.ValueKind == JsonValueKind.Object && body.TryGetProperty("answer", out var av) && av.ValueKind == JsonValueKind.String ? (av.GetString() ?? "") : "";
      if (reqId == Guid.Empty) return Results.BadRequest("requestId is required.");
      if (string.IsNullOrWhiteSpace(answer)) return Results.BadRequest("answer is required.");
      var cleanAnswer = answer.Trim();
      SecretaryRequest? reservedAns = null; Guid myAnsAttempt = Guid.Empty;
      string reservedAnsPrompt = "";
      List<EvidenceRef> reservedAnsDelivered = new();
      SecretaryRequest? replayAns = null;
      IResult? earlyAns = null;
      bool ansSupersede = false;
      lock (s.SetupLock) { lock (s.MessageLock) {
        try { earlyAns = Atomic.Run<IResult?>(s, () =>
        {
          if (!s.SecretaryRequests.TryGetValue(reqId, out var reqRow) || reqRow is null || reqRow.MeetingId != id) return Results.NotFound("secretary request not found.");
          if (!s.Meetings.TryGetValue(id, out var cur0)) return Results.NotFound("meeting");
          if (reqRow.Status == "completed")
          {
            if (!PeopleOps.Can(s, req, reqRow.BoardId, id, "read")) return Results.Json(new { error = "Access revoked or not granted for this scope." }, statusCode: 403);
            if (!string.Equals(reqRow.Phase, "continuation", StringComparison.OrdinalIgnoreCase) || string.IsNullOrWhiteSpace(reqRow.Question))
              return Results.Json(new { error = "This request never asked a clarification question." }, statusCode: 409);
            if (!string.IsNullOrWhiteSpace(reqRow.Answer) && reqRow.Answer.Trim() != cleanAnswer)
              return Results.Json(new { error = "Conflicting answer for the same request." }, statusCode: 409);
            if (string.IsNullOrWhiteSpace(reqRow.Answer) || reqRow.AnswerAttemptId == Guid.Empty)
              return Results.Json(new { error = "Completed clarification result is unavailable; retry the continuation." }, statusCode: 409);
            if (!reqRow.NoteId.HasValue || !s.Notes.TryGetValue(reqRow.NoteId.Value, out var dn) || dn is null)
            {
              reqRow.Status = "failed"; reqRow.Error = "Completed result is no longer available; safe to retry the continuation."; reqRow.UpdatedAt = DateTime.UtcNow;
              s.SecretaryRequests[reqRow.Id] = reqRow; s.SecretaryRequests.Flush();
              return Results.Json(new { error = "Completed result is no longer available; safe to retry the continuation." }, statusCode: 409);
            }
            if (dn.BoardId != reqRow.BoardId || dn.MeetingId != id) return Results.NotFound("secretary request not found.");
            if (!PeopleOps.Can(s, req, dn.BoardId, dn.MeetingId, "read")) return Results.Json(new { error = "Access revoked or not granted for this scope." }, statusCode: 403);
            replayAns = reqRow; return null;
          }
          string ansPhase = string.IsNullOrWhiteSpace(reqRow.Phase) && !string.IsNullOrWhiteSpace(reqRow.Question) ? "continuation" : (reqRow.Phase ?? "");
          bool ansHasQuestion = !string.IsNullOrWhiteSpace(reqRow.Question);
          if (ansPhase != "continuation" || !ansHasQuestion)
            return Results.Json(new { error = "Request is not awaiting clarification." }, statusCode: 409);
          if (!string.IsNullOrWhiteSpace(reqRow.Answer) && reqRow.Answer.Trim() != cleanAnswer)
            return Results.Json(new { error = "Conflicting answer for the same request." }, statusCode: 409);
          if (reqRow.Status == "answering")
          {
            if (!string.IsNullOrWhiteSpace(reqRow.Answer) && reqRow.Answer.Trim() != cleanAnswer)
              return Results.Json(new { error = "Conflicting answer for the same request." }, statusCode: 409);
            var relAns0 = reqRow.AnswerAttemptId;
            bool liveAns0 = relAns0 != Guid.Empty && LiveAttempts.ContainsKey(relAns0);
            if (liveAns0)
              return Results.Json(new { error = "Secretary continuation is already in flight for this answer." }, statusCode: 409);
            Guid failedAns0 = Guid.Empty;
            bool hasUncertainAns0 = false;
            try { hasUncertainAns0 = UncertainTerminal.TryGetValue(reqRow.Id, out failedAns0); } catch { }
            bool uncertainForAns0 = hasUncertainAns0 && (failedAns0 == Guid.Empty || failedAns0 == relAns0);
            bool ansStale = false;
            if (!uncertainForAns0)
            {
              if ((DateTime.UtcNow - reqRow.UpdatedAt).TotalSeconds > LeaseSeconds) ansStale = true;
              if (!ansStale)
                return Results.Json(new { error = "Secretary continuation is already in flight for this answer." }, statusCode: 409);
            }
            if (uncertainForAns0)
            {
              Guid unRootA = Guid.Empty;
              if (reqRow.NoteId.HasValue && s.Notes.TryGetValue(reqRow.NoteId.Value, out var unA) && unA is not null)
                unRootA = unA.RootId == Guid.Empty ? unA.Id : unA.RootId;
              SecretaryTransitions.ReconcileAfterUncertainCommit(s, reqRow.Id, reqRow.NoteId, unRootA);
              if (s.SecretaryRequests.TryGetValue(reqRow.Id, out var reconciledA) && reconciledA is not null) reqRow = reconciledA;
              if (reqRow.Status == "completed")
              {
                if (!PeopleOps.Can(s, req, reqRow.BoardId, id, "read")) return Results.Json(new { error = "Access revoked or not granted for this scope." }, statusCode: 403);
                if (!reqRow.NoteId.HasValue || !s.Notes.TryGetValue(reqRow.NoteId.Value, out var dnA) || dnA is null)
                {
                  reqRow.Status = "failed"; reqRow.Error = "Reconciled result is no longer available; safe to retry the continuation."; reqRow.UpdatedAt = DateTime.UtcNow;
                  s.SecretaryRequests[reqRow.Id] = reqRow; s.SecretaryRequests.Flush();
                  return Results.Json(new { error = "Reconciled result is no longer available; safe to retry the continuation." }, statusCode: 409);
                }
                if (dnA.BoardId != reqRow.BoardId || dnA.MeetingId != id) return Results.NotFound("secretary request not found.");
                if (!PeopleOps.Can(s, req, dnA.BoardId, dnA.MeetingId, "read")) return Results.Json(new { error = "Access revoked or not granted for this scope." }, statusCode: 403);
                try { UncertainTerminal.TryRemove(reqRow.Id, out _); } catch { }
                replayAns = reqRow; return null;
              }
            }
            ansSupersede = true;
          }
          if (reqRow.Status == "pending" || reqRow.Status == "inflight")
            return Results.Json(new { error = "Request is not awaiting clarification." }, statusCode: 409);
          if (!ansSupersede && reqRow.Status != "needs-clarification" && !IsRetryableStatus(reqRow.Status))
            return Results.Json(new { error = "Request is not awaiting clarification." }, statusCode: 409);
          if (!PeopleOps.Can(s, req, cur0.BoardId, id, "contribute")) return Results.Json(new { error = "Access revoked or not granted for this scope." }, statusCode: 403);
          if (PeopleOps.Guard(gw, req) is { } capped) return capped;
          if (cur0.State is not (MeetingState.Active or MeetingState.AwaitingBrief)) return Results.Json(new { error = "Meeting is not active." }, statusCode: 409);
          var attempt = Guid.NewGuid();
          bool firstAnswer = string.IsNullOrWhiteSpace(reqRow.Answer);
          string answerText = firstAnswer ? cleanAnswer : (reqRow.Answer ?? "").Trim();
          var storedCallerA = SecretaryDirect.RehydrateRawCallerRefs(reqRow.CallerRefsJson);
          var canonAns = SecretaryContext.CanonicalizeCaller(s, cur0.BoardId, id, storedCallerA);
          const string ahead = "You are the board secretary. Return JSON only.\n";
          string amid = "OWNER QUESTION: " + reqRow.Question + "\nOWNER ANSWER: " + answerText + "\nORIGINAL: " + reqRow.InputText + "\nCONTEXT:\n";
          int abudget = 32000 - ahead.Length - amid.Length - 500;
          if (abudget < 4000)
            return Results.Json(new { error = "Secretary prompt exceeds budget; essential context cannot fit." }, statusCode: 502);
          var tmpa = new List<EvidenceRef>(); var omitteda = new List<string>();
          string packeta;
          try { packeta = SecretaryContext.BuildPacket(s, cur0, reqRow.InputText + " CLARIFIED: " + answerText, canonAns, tmpa, abudget, omitteda); }
          catch (ProviderException pexA) { return PeopleOps.ProviderError(pexA); }
          string afooter = omitteda.Count > 0 ? "\nOMITTED FROM PACKET (not cited as evidence): " + string.Join("; ", omitteda) + "\n" : "";
          string fullAns = ahead + amid + packeta + afooter;
          if (fullAns.Length > 32000)
            return Results.Json(new { error = "Secretary prompt exceeds budget; essential context cannot fit." }, statusCode: 502);
          foreach (var d in tmpa.ToList())
          {
            if (string.IsNullOrWhiteSpace(d.Excerpt) || !fullAns.Contains(d.Excerpt!, StringComparison.Ordinal))
            {
              bool isCallerA = canonAns.Any(c => c.Kind == d.Kind && c.Ref == d.Ref && (c.SectionId ?? "") == (d.SectionId ?? ""));
              if (isCallerA)
                return Results.Json(new { error = "Secretary caller evidence exceeds prompt budget." }, statusCode: 502);
              tmpa.Remove(d);
              omitteda.Add(d.Kind + ":" + d.Ref + ":undelivered");
            }
          }
          if (omitteda.Count > 0 && string.IsNullOrWhiteSpace(afooter))
          {
            afooter = "\nOMITTED FROM PACKET (not cited as evidence): " + string.Join("; ", omitteda) + "\n";
            fullAns = ahead + amid + packeta + afooter;
            if (fullAns.Length > 32000)
              return Results.Json(new { error = "Secretary prompt exceeds budget; essential context cannot fit." }, statusCode: 502);
          }
          string ansHash;
          try
          {
            var (ansDev, ansUser) = ModelGateway.BuildSecretaryPayload("secretary", fullAns, SecretaryDirect.InputTokens, false);
            ansHash = ModelGateway.HashDeliveredPrompt(ansDev, ansUser);
          }
          catch (ProviderException pexGwA) { return PeopleOps.ProviderError(pexGwA); }
          if (firstAnswer)
          {
            var list = s.Messages.GetOrAdd(id, _ => new List<Message>());
            long ansSeq = (list.Count == 0 ? 0 : list.Max(x => x.Sequence)) + 1;
            var msg = new Message { MeetingId = id, BoardId = cur0.BoardId, Sender = "lead", Content = cleanAnswer, Status = "committed", Sequence = ansSeq, CreatedAt = DateTime.UtcNow };
            list.Add(msg);
            cur0.DeliveredRevision = ansSeq;
            reqRow.Answer = cleanAnswer;
          }
          cur0.Generation++;
          reqRow.AnswerAttemptId = attempt;
          reqRow.AttemptId = reqRow.AttemptId == Guid.Empty ? Guid.NewGuid() : reqRow.AttemptId;
          reqRow.Status = "answering";
          reqRow.Phase = "continuation";
          reqRow.Generation = cur0.Generation;
          // Fresh capture AFTER the answer-reservation mutations: RecentHash binds
            // DeliveredRevision, so a pre-mutation snapshot patched with new
            // counters would never equal the publication-time snapshot.
          var snapStoredA = SecretaryContext.CaptureSnapshot(s, cur0, storedCallerA);
          reqRow.LeadFingerprint = snapStoredA.LeadFp; reqRow.EvidenceFingerprintJson = snapStoredA.EvFp;
          reqRow.RecentHash = snapStoredA.RecentHash; reqRow.EvidenceTextHash = snapStoredA.EvidenceTextHash; reqRow.DossierHash = snapStoredA.DossierHash;
          reqRow.SnapshotJson = SecretaryContext.SnapshotToJson(snapStoredA);
          reqRow.UpdatedAt = DateTime.UtcNow;
          reqRow.DeliveredRefsJson = EvidenceRef.ToJsonList(tmpa);
          reqRow.DeliveredPromptHash = ansHash;
          try { reqRow.OmittedJson = System.Text.Json.JsonSerializer.Serialize(omitteda); } catch { reqRow.OmittedJson = "[]"; }
          s.SecretaryRequests[reqRow.Id] = reqRow; s.Meetings.Flush(); s.SecretaryRequests.Flush();
          try { UncertainTerminal.TryRemove(reqRow.Id, out _); } catch { }
          reservedAns = reqRow; myAnsAttempt = attempt; reservedAnsPrompt = fullAns; reservedAnsDelivered = tmpa;
          return null;
        }); } catch (Exception gateEx)
        {
          if (IsStorageFault(gateEx))
          {
            s.SecretaryRequests.TryGetValue(reqId, out var gateAnsRow);
            if (gateAnsRow is not null && (gateAnsRow.Status == "answering" || gateAnsRow.Status == "needs-clarification"))
            {
              try { var __ga2 = gateAnsRow.AnswerAttemptId != Guid.Empty ? gateAnsRow.AnswerAttemptId : gateAnsRow.AttemptId; UncertainTerminal[gateAnsRow.Id] = __ga2; } catch { }
              earlyAns = Results.Json(new { error = "Continuation reservation storage fault; recovery state marked uncertain. Re-read the request before retrying." }, statusCode: 503);
            }
            else earlyAns = Results.Json(new { error = "Continuation reservation storage fault before any live reservation; safe to retry." }, statusCode: 502);
          }
          else throw;
        }

      } }
      if (earlyAns is not null) return earlyAns;
      if (replayAns is not null)
      {
        s.Notes.TryGetValue(replayAns.NoteId!.Value, out var rn2);
        var __omReplayA = ParseOmittedManifest(replayAns.OmittedJson);
        return Results.Ok(new { requestId = replayAns.Id, clientNonce = replayAns.ClientNonce, status = replayAns.Status, note = rn2, omitted = __omReplayA, replay = true });
      }
      if (reservedAns is null || string.IsNullOrEmpty(reservedAnsPrompt)) return Results.Json(new { error = "Continuation reservation failed; retry." }, statusCode: 409);
      var myReq2 = reservedAns;
      var restoreBeforeA = s.RestoreEpochId;
      var autoEvidence = reservedAnsDelivered;
      string prompt2 = reservedAnsPrompt;
      LiveAttempts[myAnsAttempt] = 1;
      string modelText2;
      try { modelText2 = await gw.CompleteAsync(ModelPolicy.SparkFor(s, myReq2.BoardId), "secretary", prompt2, SecretaryDirect.InputTokens, 2048, ownerOverride: PeopleOps.IsOwner(req), boardId: myReq2.BoardId, meetingId: id, truncatePrompt: false); }
      catch (Exception ex) when (ex is ProviderException or CapExceededException)
      {
        if (!FailBoundAnswer(s, myReq2.Id, myAnsAttempt, ex.Message))
          return Results.Json(new { error = "Provider failed and recovery state could not be persisted; do not retry blindly. Re-read the request before retrying." }, statusCode: 503);
        return PeopleOps.ModelError(ex);
      }
      finally { try { LiveAttempts.TryRemove(myAnsAttempt, out _); } catch { } }
      SecretaryOutcome outcome2;
      try { outcome2 = SecretaryOutcomeParser.Parse(modelText2); }
      catch (ProviderException pex2)
      {
        if (!FailBoundAnswer(s, myReq2.Id, myAnsAttempt, pex2.Message))
          return Results.Json(new { error = "Response was malformed and recovery state could not be persisted; do not retry blindly. Re-read the request before retrying." }, statusCode: 503);
        return PeopleOps.ProviderError(pex2);
      }
      if (outcome2.Kind == "question")
      {
        if (!FailBoundAnswer(s, myReq2.Id, myAnsAttempt, "Secretary asked a second clarification; answer the first question only."))
          return Results.Json(new { error = "Second clarification received and recovery state could not be persisted; do not retry blindly." }, statusCode: 503);
        return Results.Json(new { error = "Secretary asked a second clarification; answer the first question only." }, statusCode: 502);
      }
      var pubNoteId2 = Guid.NewGuid();
      lock (s.SetupLock) { lock (s.MessageLock) {
        IResult pubResult2;
        try
        {
        pubResult2 = Atomic.Run<IResult>(s, () =>
        {
          if (!s.SecretaryRequests.TryGetValue(myReq2.Id, out var fresh2) || fresh2 is null) return Results.Conflict("Secretary request moved on; retry.");
          if (fresh2.AnswerAttemptId != myAnsAttempt) return Results.Conflict("Secretary request moved on; retry.");
          if (fresh2.Status != "answering") return Results.Conflict("Secretary request moved on; retry.");
          if (!s.Meetings.TryGetValue(id, out var cur2)) return Results.Conflict("Meeting moved on; draft discarded.");
          if (PeopleOps.IsSecure(s) && !AuthOps.TrySession(s, req, out _)) { fresh2.Status = "needs-clarification"; fresh2.Error = "Session expired during secretary work."; s.SecretaryRequests.Flush(); return Results.Json(new { error = "Authentication required." }, statusCode: 401); }
          if (!PeopleOps.Can(s, req, cur2.BoardId, id, "contribute")) { fresh2.Status = "needs-clarification"; fresh2.Error = "Access revoked during secretary work."; s.SecretaryRequests.Flush(); return Results.Json(new { error = "Access revoked or not granted for this scope." }, statusCode: 403); }
          if (cur2.State is not (MeetingState.Active or MeetingState.AwaitingBrief)) { fresh2.Status = "discarded"; fresh2.Error = "Meeting state changed; draft discarded."; s.SecretaryRequests.Flush(); return Results.Json(new { error = "Meeting state changed; draft discarded." }, statusCode: 409); }
          var nowSnap2 = SecretaryContext.CaptureSnapshot(s, cur2, SecretaryDirect.RehydrateRawCallerRefs(fresh2.CallerRefsJson));
          if (!SecretaryContext.TryParseSnapshot(fresh2.SnapshotJson, out var before2) || before2 is null)
          {
            fresh2.Status = "discarded"; fresh2.Error = "Stored request snapshot is invalid; retry with the same nonce."; s.SecretaryRequests.Flush();
            return Results.Json(new { error = fresh2.Error }, statusCode: 409);
          }
          if (!SecretaryContext.SnapshotEquals(before2, nowSnap2))
          {
            fresh2.Status = "discarded"; fresh2.Error = SecretaryContext.SnapshotMismatchReason(before2, nowSnap2); s.SecretaryRequests.Flush();
            return Results.Json(new { error = fresh2.Error }, statusCode: 409);
          }
          if (s.RestoreEpochId != restoreBeforeA)
          {
            fresh2.Status = "discarded"; fresh2.Error = "Domain was restored during secretary work; retry with the same nonce."; s.SecretaryRequests.Flush();
            return Results.Json(new { error = fresh2.Error }, statusCode: 409);
          }
          var noteBody2 = outcome2.Body;
          if (autoEvidence.Count == 0) noteBody2 = noteBody2 + " [Limitation: No eligible approved sources were available.]";
          List<string> __omNoteEarly2 = new();
          try { __omNoteEarly2 = System.Text.Json.JsonSerializer.Deserialize<List<string>>(fresh2.OmittedJson ?? "[]") ?? new(); } catch { }
          if (__omNoteEarly2.Count > 0) noteBody2 = noteBody2 + " [Omitted from packet (not cited as evidence): " + string.Join("; ", __omNoteEarly2) + "]";
          Note? created2 = null;
          {
            var note = new Note { BoardId = cur2.BoardId, MeetingId = id, Kind = outcome2.Kind, Title = outcome2.Title, Body = noteBody2, Scope = "meeting", Provisional = true, EvidenceJson = EvidenceRef.ToJsonList(autoEvidence), Revision = 1, NoteStatus = "current", CreatedAt = DateTime.UtcNow };
            note.Id = pubNoteId2; note.RootId = pubNoteId2;
            s.Notes[note.Id] = note;
            var hh = new NoteHistory { BoardId = cur2.BoardId, MeetingId = id, NoteId = note.Id, RootId = note.RootId, Revision = 1, Title = note.Title, Body = note.Body, EvidenceJson = note.EvidenceJson, Action = "created", CreatedAt = DateTime.UtcNow };
            s.NoteHistories[hh.Id] = hh;
            fresh2.Status = "completed"; fresh2.NoteId = note.Id; fresh2.CompletedAt = DateTime.UtcNow; fresh2.UpdatedAt = DateTime.UtcNow;
            fresh2.DeliveredRefsJson = EvidenceRef.ToJsonList(autoEvidence); fresh2.DeliveredPromptHash = myReq2.DeliveredPromptHash;
            s.SecretaryRequests[fresh2.Id] = fresh2;
            s.Notes.Flush(); s.NoteHistories.Flush(); s.SecretaryRequests.Flush();
            created2 = note;
          }
          List<string> __omPub2 = new();
          try { __omPub2 = System.Text.Json.JsonSerializer.Deserialize<List<string>>(fresh2.OmittedJson ?? "[]") ?? new(); } catch { }
          return Results.Ok(new { requestId = fresh2.Id, clientNonce = fresh2.ClientNonce, status = fresh2.Status, note = created2, omitted = __omPub2 });
        });
        }
        catch (Exception pubEx2) when (pubEx2 is SimCEO.Api.Data.PostCommitException)
        {
          SecretaryTransitions.ReconcileAfterUncertainCommit(s, myReq2.Id, pubNoteId2, pubNoteId2);
          return Results.Json(new { error = "Continuation publication committed (or the commit outcome is unknown); reconciled against stored state. Re-read before retrying with the same nonce." }, statusCode: 502);
        }
        catch (Exception pubEx2) when (IsTransportBreak(pubEx2))
        {
          SecretaryTransitions.ReconcileAfterUncertainCommit(s, myReq2.Id, pubNoteId2, pubNoteId2);
          return Results.Json(new { error = "Storage outcome uncertain during publication; reconciled. Retry with the same nonce." }, statusCode: 502);
        }
        catch (Exception pubEx2) when (IsStorageFault(pubEx2))
        {
          try { SecretaryTransitions.MarkTerminal(s, myReq2.Id, myAnsAttempt, true, "failed", "Storage fault during publication: " + pubEx2.GetType().Name + ". Safe to retry the continuation."); }
          catch { try { UncertainTerminal[myReq2.Id] = myAnsAttempt; } catch { } return Results.Json(new { error = "Storage fault during publication and recovery state could not be persisted; do not retry blindly. Re-read the request before retrying." }, statusCode: 503); }
          return Results.Json(new { error = "Storage fault during publication; safe to retry the continuation." }, statusCode: 502);
        }
        return pubResult2;
      } }
    });
    app.MapGet("/api/meetings/{id:guid}/secretary/requests", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (!s.Meetings.TryGetValue(id, out var m)) return Results.NotFound("meeting");
      if (!PeopleOps.Can(s, req, m.BoardId, id, "read")) return PeopleOps.Denied();
      return Results.Ok(s.SecretaryRequests.Values.Where(r => r.MeetingId == id).OrderByDescending(r => r.CreatedAt).Take(100));
    });
    app.MapGet("/api/meetings/{id:guid}/secretary/requests/{reqId:guid}", (InMemoryStore s, HttpRequest req, Guid id, Guid reqId) =>
    {
      if (!s.Meetings.TryGetValue(id, out var m)) return Results.NotFound("meeting");
      if (!PeopleOps.Can(s, req, m.BoardId, id, "read")) return PeopleOps.Denied();
      if (!s.SecretaryRequests.TryGetValue(reqId, out var r) || r is null || r.MeetingId != id || r.BoardId != m.BoardId) return Results.NotFound();
      Note? note = null;
      if (r.NoteId.HasValue)
      {
        if (!s.Notes.TryGetValue(r.NoteId.Value, out note) || note is null) return Results.NotFound();
        if (note.BoardId != r.BoardId || note.MeetingId != id) return Results.NotFound();
        if (!PeopleOps.Can(s, req, note.BoardId, note.MeetingId, "read")) return PeopleOps.Denied();
      }
      var __omGet = ParseOmittedManifest(r.OmittedJson);
      return Results.Ok(new { request = r, note, omitted = __omGet });
    });
    app.MapGet("/api/meetings/{id:guid}/notes/history", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (!s.Meetings.TryGetValue(id, out var m)) return Results.NotFound("meeting");
      if (!PeopleOps.Can(s, req, m.BoardId, id, "read")) return PeopleOps.Denied();
      var roots = s.Notes.Values.Where(n => n.MeetingId == id && n.BoardId == m.BoardId).Select(n => n.RootId == Guid.Empty ? n.Id : n.RootId).Distinct().ToList();
      var result = new List<object>();
      foreach (var root in roots)
      {
        var chain = s.Notes.Values.Where(n => (n.Id == root || n.RootId == root) && n.BoardId == m.BoardId && n.MeetingId == id).OrderBy(n => n.Revision).ToList();
        if (chain.Count == 0) continue;
        var current = chain.FirstOrDefault(n => n.NoteStatus == "current") ?? chain.OrderByDescending(n => n.Revision).First();
        result.Add(new { root, current, revisions = chain });
      }
      return Results.Ok(result.OrderByDescending(r => ((dynamic)r).current.CreatedAt).Take(100).ToList());
    });
    app.MapPost("/api/notes/{id:guid}/edit", (InMemoryStore s, HttpRequest req, Guid id, JsonElement body) =>
    {
      if (!s.Notes.TryGetValue(id, out var cur) || cur is null) return Results.NotFound();
      if (!PeopleOps.Can(s, req, cur.BoardId, cur.MeetingId, "contribute")) return PeopleOps.Denied();
      if (!SecretaryContext.IsBusinessNote(cur)) return Results.Json(new { error = "Only provisional business working notes may be edited with this endpoint." }, statusCode: 422);
      if (cur.NoteStatus != "current") return Results.Json(new { error = "Only the current revision may be edited." }, statusCode: 409);
      int want = -1;
      if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("expectedRevision", out var ev) && ev.ValueKind == JsonValueKind.Number) ev.TryGetInt32(out want);
      if (want != cur.Revision) return Results.Json(new { error = "Stale revision; refresh history and retry.", currentRevision = cur.Revision }, statusCode: 409);
      var title = body.ValueKind == JsonValueKind.Object && body.TryGetProperty("title", out var tv) && tv.ValueKind == JsonValueKind.String ? (tv.GetString() ?? cur.Title) : cur.Title;
      var nbody = body.ValueKind == JsonValueKind.Object && body.TryGetProperty("body", out var bv) && bv.ValueKind == JsonValueKind.String ? (bv.GetString() ?? cur.Body) : cur.Body;
      if (string.IsNullOrWhiteSpace(nbody)) return Results.BadRequest("body is required.");
      Note? created = null;
      lock (s.SetupLock) { lock (s.MessageLock) {
        try { return Atomic.Run<IResult>(s, () =>
        {
          if (!s.Notes.TryGetValue(id, out var fresh) || fresh is null) return Results.NotFound();
          if (!PeopleOps.Can(s, req, fresh.BoardId, fresh.MeetingId, "contribute")) return Results.Json(new { error = "Access revoked or not granted for this scope." }, statusCode: 403);
          if (fresh.Revision != want || fresh.NoteStatus != "current") return Results.Json(new { error = "Stale revision; refresh history and retry.", currentRevision = fresh.Revision }, statusCode: 409);
          if (!SecretaryContext.IsBusinessNote(fresh)) return Results.Json(new { error = "Only provisional business working notes may be edited." }, statusCode: 422);
          {
            var root = fresh.RootId == Guid.Empty ? fresh.Id : fresh.RootId;
            var next = new Note { BoardId = fresh.BoardId, MeetingId = fresh.MeetingId, Kind = fresh.Kind, Title = title.Trim(), Body = nbody.Trim(), Scope = fresh.Scope, Provisional = true, EvidenceJson = fresh.EvidenceJson, RootId = root, Revision = fresh.Revision + 1, PredecessorId = fresh.Id, NoteStatus = "current", CreatedAt = DateTime.UtcNow };
            fresh.NoteStatus = "superseded";
            s.Notes[fresh.Id] = fresh;
            s.Notes[next.Id] = next;
            var h1 = new NoteHistory { BoardId = fresh.BoardId, MeetingId = fresh.MeetingId, NoteId = fresh.Id, RootId = root, Revision = fresh.Revision, Title = fresh.Title, Body = fresh.Body, EvidenceJson = fresh.EvidenceJson, Action = "superseded", CreatedAt = DateTime.UtcNow };
            var h2 = new NoteHistory { BoardId = next.BoardId, MeetingId = next.MeetingId, NoteId = next.Id, RootId = root, Revision = next.Revision, Title = next.Title, Body = next.Body, EvidenceJson = next.EvidenceJson, Action = "edited", CreatedAt = DateTime.UtcNow };
            s.NoteHistories[h1.Id] = h1;
            s.NoteHistories[h2.Id] = h2;
            s.Notes.Flush(); s.NoteHistories.Flush();
            created = next;
          }
          return Results.Ok(created);
        }); } catch (Exception editEx) when (SecretaryEndpoints.IsStorageFault(editEx))
        { return Results.Json(new { error = "Storage fault during note edit; safe to retry." }, statusCode: 502); }
      } }
    });
    app.MapPost("/api/notes/{id:guid}/reverse", (InMemoryStore s, HttpRequest req, Guid id, JsonElement body) =>
    {
      if (!s.Notes.TryGetValue(id, out var cur) || cur is null) return Results.NotFound();
      if (!PeopleOps.Can(s, req, cur.BoardId, cur.MeetingId, "contribute")) return PeopleOps.Denied();
      if (!SecretaryContext.IsBusinessNote(cur)) return Results.Json(new { error = "Only provisional business working notes may be reversed." }, statusCode: 422);
      if (cur.NoteStatus != "current") return Results.Json(new { error = "Only the current revision may be reversed." }, statusCode: 409);
      int want = -1;
      if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("expectedRevision", out var ev) && ev.ValueKind == JsonValueKind.Number) ev.TryGetInt32(out want);
      if (want != cur.Revision) return Results.Json(new { error = "Stale revision; refresh history and retry.", currentRevision = cur.Revision }, statusCode: 409);
      lock (s.SetupLock) { lock (s.MessageLock) {
        try { return Atomic.Run<IResult>(s, () =>
        {
          if (!s.Notes.TryGetValue(id, out var fresh) || fresh is null) return Results.NotFound();
          if (!PeopleOps.Can(s, req, fresh.BoardId, fresh.MeetingId, "contribute")) return Results.Json(new { error = "Access revoked or not granted for this scope." }, statusCode: 403);
          if (!SecretaryContext.IsBusinessNote(fresh)) return Results.Json(new { error = "Only provisional business working notes may be reversed." }, statusCode: 422);
          if (fresh.Revision != want || fresh.NoteStatus != "current") return Results.Json(new { error = "Stale revision.", currentRevision = fresh.Revision }, statusCode: 409);
          {
            fresh.NoteStatus = "reversed";
            s.Notes[fresh.Id] = fresh;
            var h = new NoteHistory { BoardId = fresh.BoardId, MeetingId = fresh.MeetingId, NoteId = fresh.Id, RootId = fresh.RootId == Guid.Empty ? fresh.Id : fresh.RootId, Revision = fresh.Revision, Title = fresh.Title, Body = fresh.Body, EvidenceJson = fresh.EvidenceJson, Action = "reversed", CreatedAt = DateTime.UtcNow };
            s.NoteHistories[h.Id] = h;
            s.Notes.Flush(); s.NoteHistories.Flush();
          }
          return Results.Ok(fresh);
        }); } catch (Exception revEx) when (SecretaryEndpoints.IsStorageFault(revEx))
        { return Results.Json(new { error = "Storage fault during note reversal; safe to retry." }, statusCode: 502); }
      } }
    });
    app.MapGet("/api/notes/{id:guid}/history", (InMemoryStore s, HttpRequest req, Guid id) =>
    {
      if (!s.Notes.TryGetValue(id, out var cur) || cur is null) return Results.NotFound();
      if (!PeopleOps.Can(s, req, cur.BoardId, cur.MeetingId, "read")) return PeopleOps.Denied();
      var root = cur.RootId == Guid.Empty ? cur.Id : cur.RootId;
      var chain = s.Notes.Values.Where(n => (n.Id == root || n.RootId == root) && n.BoardId == cur.BoardId && n.MeetingId == cur.MeetingId).OrderBy(n => n.Revision).ToList();
      if (chain.Count == 0) return Results.NotFound();
      var current = chain.FirstOrDefault(n => n.NoteStatus == "current") ?? chain.OrderByDescending(n => n.Revision).First();
      var hist = s.NoteHistories.Values.Where(h => h.RootId == root && h.BoardId == cur.BoardId && h.MeetingId == cur.MeetingId).OrderBy(h => h.CreatedAt).Take(100).ToList();
      var avail = EvidenceRef.ParseJsonList(cur.EvidenceJson ?? "[]").Select(r => new { kind = r.Kind, @ref = r.Ref, sectionId = r.SectionId, available = EvidenceAvailability.Resolve(s, r, cur.BoardId, cur.MeetingId).Available, reason = EvidenceAvailability.Resolve(s, r, cur.BoardId, cur.MeetingId).Reason }).ToList();
      return Results.Ok(new { root = root, current = current, revisions = chain, history = hist, availability = avail });
    });
  }
}
