using System.Text;
using System.Text.Json;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;

namespace SimCEO.Api.Work;

// Context Curator: builds the bounded per-agent packet from the approved
// board-lead profile, mission/constraints, brief, reply target, a bounded
// window of delivered messages, current approved decisions and directions,
// and ranked source excerpts. Never full transcripts or whole documents.
// Every packet's manifest (ids, versions, token estimate) is returned for
// the audit trail; full context blobs are never stored.
// Phase 6: ALL source selection routes through SourceGovernance.IsEligible;
// excerpts prefer persisted SourceSections; raw text never bypasses.
public sealed record CuratorManifest(
  List<string> SourceIds, List<long> MessageSeqs, int LeadVersion,
  string Policy, int TokenEstimate, long SnapshotRevision,
  List<EvidenceRef> Evidence);

public static class ContextCurator
{
  public static string BidPacket(InMemoryStore s, Meeting m, BoardAdvisor adv,
    string prompt, Board? board)
  {
    var sb = new StringBuilder();
    var effName = board is null ? "?" : LeadSetup.EffectiveView(s, board).name;
    sb.AppendLine($"BOARD: {effName} | BRIEF: {Truncate(m.Brief, 500)}");
    sb.AppendLine($"YOUR ROLE: {adv.BoardRole}");
    foreach (var msg in Recent(s, m.Id, 3))
      sb.AppendLine($"[{msg.Sequence}] {msg.Sender}: {Truncate(msg.Content, 300)}");
    sb.AppendLine($"QUESTION: {Truncate(prompt, 800)}");
    return sb.ToString();
  }

  public static (string packet, CuratorManifest manifest) BuildPacket(
    InMemoryStore s, Meeting m, BoardAdvisor adv, string prompt,
    Board? board, LeadProfile? lead, int draftTokens = 8000)
  {
    var sb = new StringBuilder();
    var eff = board is null ? (name: "?", mission: "", stage: "", policy: "balanced", dataUse: "contributor") : LeadSetup.EffectiveView(s, board);
    sb.Append("BOARD: ").Append(eff.name);
    sb.Append(" | MISSION: ").Append(Truncate(eff.mission, 600));
    sb.Append(" | STAGE: ").Append(Truncate(eff.stage, 200)).AppendLine();
    if (lead is not null)
      sb.AppendLine($"LEAD: {lead.Name} ({lead.RoleLabel}). Familiar: {Truncate(lead.FamiliarTopics, 300)}. Explain simply: {Truncate(lead.SimplerTopics, 300)}. Prefs: {Truncate(lead.CommPrefs, 300)}");
    sb.AppendLine($"MEETING BRIEF: {Truncate(m.Brief, 800)}");
    sb.AppendLine($"YOUR ROLE: {adv.BoardRole} (roster v{adv.RosterVersion})");
    sb.AppendLine($"QUESTION: {Truncate(prompt, 800)}");
    if (s.Roster.TryGetValue(adv.RosterEntryId, out var rent) && rent is not null)
    {
      sb.AppendLine($"ADVISOR PROFILE (roster v{rent.Version}): {Truncate(rent.ProfileJson, 1500)}");
      foreach (var claim in DossierClaims(rent).Take(5))
        sb.AppendLine($"DOSSIER: {Truncate(claim, 400)}");
    }
    var recent = Recent(s, m.Id, 12);
    foreach (var msg in recent)
      sb.AppendLine($"[{msg.Sequence}] {msg.Sender}{(msg.AdvisorName is null ? "" : "/" + msg.AdvisorName)}: {Truncate(msg.Content, 600)}");
    var evidence = new List<EvidenceRef>();
    foreach (var v in RecordsOps.EffectiveChains(s.Drafts.Values.Where(d => d.MeetingId == m.Id))
      .Where(v => v.EffectiveIds.Count > 0).OrderByDescending(v => v.Head.Version).Take(3))
    {
      sb.AppendLine($"APPROVED RECORD v{v.Head.Version}: {Truncate(v.ConciseExport, 1500)}");
      foreach (var id2 in v.EffectiveIds)
      {
        if (v.EffectiveOwners.TryGetValue(id2, out var own) && v.EffectiveTexts.TryGetValue(id2, out var et))
          evidence.Add(EvidenceRef.ForRecordItem(own.RecordId, own.Version, id2, Truncate(et, 200)));
      }
    }
    foreach (var n in s.Notes.Values
      .Where(n => n.BoardId == m.BoardId && n.Kind == "direction" && !n.Provisional
        && (n.Scope == "board" || n.MeetingId == m.Id))
      .OrderByDescending(n => n.CreatedAt).Take(5))
    {
      var nref = EvidenceRef.ForNote(n);
      sb.AppendLine($"DIRECTION ({n.Scope} {nref.Ref}): {Truncate(n.Body, 500)}");
      evidence.Add(nref);
    }
    var words = Keywords(prompt);
    var ranked = s.Sources.Values
      .Where(x => x.BoardId == m.BoardId && SourceGovernance.IsEligible(s, x, m.Id))
      .Select(x => (doc: x, text: ReadableText(s, x)))
      .Where(e => !string.IsNullOrWhiteSpace(e.text))
      .OrderByDescending(e => Score(e.text, words))
      .Take(6).ToList();
    // Permitted-use guidance for Wiki excerpts: the resource's COMPLETE
    // AllowedUse text is emitted ONCE per resource (never truncated, never
    // redacted as content). This is model-use guidance, not content redaction,
    // and credentials never enter model context.
    var wikiUseIds = ranked
      .Where(e => e.doc.ResourceId.HasValue)
      .Select(e => e.doc.ResourceId!.Value).Distinct().ToList();
    foreach (var rid in wikiUseIds)
    {
      if (s.WikiResources.TryGetValue(rid, out var wr) && wr.BoardId == m.BoardId
        && wr.Enabled && !string.IsNullOrWhiteSpace(wr.AllowedUse))
        sb.AppendLine($"[WIKI PERMITTED USE ({wr.Description.Trim()}): {wr.AllowedUse.Trim()}]");
    }
    var sourceIds = new List<string>();
    var room = draftTokens * 4 - sb.Length;
    if (room > 0 && ranked.Count > 0)
    {
      var share = room / ranked.Count;
      foreach (var (doc, text) in ranked)
      {
        sb.AppendLine($"[SOURCE:{doc.FileName} v{doc.Version}]: {Truncate(text, share)}");
        sourceIds.Add($"{doc.Id}:v{doc.Version}:g{doc.IndexGeneration}:{doc.ContentHash}:s{SourceGovernance.SectionRevision(s, doc.Id)}");
        evidence.Add(EvidenceRef.ForSource(doc, Truncate(text, 200)));
      }
    }
    var packet = sb.ToString();
    var manifest = new CuratorManifest(sourceIds,
      recent.Select(x => x.Sequence).ToList(),
      board?.LeadProfileVersion ?? 0,
      eff.policy,
      packet.Length / 4, m.DeliveredRevision, evidence);
    return (packet, manifest);
  }

  private static List<string> DossierClaims(RosterEntry doc)
  {
    try
    {
      using var parsed = JsonDocument.Parse(string.IsNullOrWhiteSpace(doc.ResearchJson) ? "{}" : doc.ResearchJson);
      var root = parsed.RootElement;
      if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty("claims", out var claims)
          && claims.ValueKind == JsonValueKind.Array)
      {
        var list = new List<string>();
        foreach (var c in claims.EnumerateArray())
        {
          var text = c.ValueKind == JsonValueKind.Object && c.TryGetProperty("text", out var t) ? (t.GetString() ?? "") : c.GetRawText();
          if (!string.IsNullOrWhiteSpace(text)) list.Add(text.Trim());
        }
        if (list.Count > 0) return list;
      }
    }
    catch (JsonException) { }
    return new List<string>();
  }

  private static List<Message> Recent(InMemoryStore s, Guid meetingId, int take)
  {
    lock (s.MessageLock)
      return s.Messages.TryGetValue(meetingId, out var list)
        ? list.OrderByDescending(x => x.Sequence).Take(take).OrderBy(x => x.Sequence).ToList()
        : new List<Message>();
  }

  private static string Truncate(string s, int max) =>
    string.IsNullOrEmpty(s) || s.Length <= max ? s ?? "" : s[..max] + "…";

  private static HashSet<string> Keywords(string prompt) =>
    prompt.ToLowerInvariant()
      .Split(new[] { ' ', ',', '.', ';', ':', '?', '!', '\n', '\r', '\t', '-', '(', ')' },
        StringSplitOptions.RemoveEmptyEntries)
      .Where(w => w.Length > 3).Distinct().Take(40).ToHashSet();

  private static int Score(string text, HashSet<string> words)
  {
    if (words.Count == 0) return 0;
    var lower = text.ToLowerInvariant();
    var score = 0;
    foreach (var w in words)
    {
      var idx = 0;
      while ((idx = lower.IndexOf(w, idx, StringComparison.Ordinal)) >= 0) { score++; idx += w.Length; }
    }
    return score;
  }

  public sealed record RecallHit(string Kind, string Ref, string Text, int Score);

  public static List<RecallHit> Recall(InMemoryStore s, Guid boardId, string query, int take = 8, Guid? meetingId = null)
  {
    var words = Keywords(query);
    var hits = new List<RecallHit>();
    foreach (var doc in s.Sources.Values.Where(x => x.BoardId == boardId))
    {
      if (!SourceGovernance.VisibleForRecall(s, doc, boardId, meetingId)) continue;
      var text = ReadableText(s, doc);
      if (string.IsNullOrWhiteSpace(text)) continue;
      hits.Add(new RecallHit("source", $"{doc.FileName} v{doc.Version}", Truncate(text, 600), Score(text, words)));
    }
    foreach (var v in RecordsOps.EffectiveChains(s.Drafts.Values.Where(d => d.BoardId == boardId)))
    {
      if (v.EffectiveIds.Count == 0) continue;
      // One hit per effective item pinned to its exact approving owner:
      // inherited text is never labeled with an unapproved head version.
      foreach (var id2 in v.EffectiveIds)
      {
        if (!v.EffectiveTexts.TryGetValue(id2, out var et) || string.IsNullOrWhiteSpace(et)) continue;
        if (!v.EffectiveOwners.TryGetValue(id2, out var own)) continue;
        hits.Add(new RecallHit("record", own.RecordId + "#" + id2, Truncate($"[{id2}] record v{own.Version}: " + et, 600), Score(et, words) + 2));
      }
    }
    foreach (var n in s.Notes.Values.Where(n => n.BoardId == boardId && n.Kind == "direction" && !n.Provisional))
      hits.Add(new RecallHit("direction", n.Id.ToString(), Truncate(n.Body, 400), Score(n.Body, words) + 2));
    return hits.OrderByDescending(h => h.Score).Take(Math.Clamp(take, 1, 20)).ToList();
  }

  // Phase 6: excerpts come ONLY from persisted sections. Raw extraction or
  // original bytes must never bypass the section graph (P2 #13): when the
  // index is not completed or no valid sections exist there is no usable text.
  internal static string ReadableText(InMemoryStore s, SourceDoc doc)
  {
    if (!string.Equals(doc.IndexState, "completed", StringComparison.OrdinalIgnoreCase)) return "";
    if (!SourceGovernance.HasValidSections(s, doc)) return "";
    var secs = s.SourceSections.Values.Where(x => x.SourceId == doc.Id).OrderBy(x => x.Ordinal).Take(6).ToList();
    if (secs.Count == 0) return "";
    return string.Join("\n\n", secs.Select(x => (string.IsNullOrWhiteSpace(x.Heading) ? "" : "## " + x.Heading + "\n") + x.Text));
  }

  private static string DecodeText(byte[] bytes)
  {
    string text;
    try { text = Encoding.UTF8.GetString(bytes); }
    catch (DecoderFallbackException) { return ""; }
    if (text.Length == 0) return "";
    var printable = text.Count(c => !char.IsControl(c) || c is '\n' or '\r' or '\t');
    if ((double)printable / text.Length < 0.7) return "";
    return text.Length > 12000 ? text[..12000] : text;
  }
}
