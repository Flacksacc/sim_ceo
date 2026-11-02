using System.Text;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;

namespace SimCEO.Api.Work;

// Context Curator: builds the bounded per-agent packet from the approved
// board-lead profile, mission/constraints, brief, reply target, a bounded
// window of delivered messages, current approved decisions and directions,
// and ranked source excerpts. Never full transcripts or whole documents.
// Every packet's manifest (ids, versions, token estimate) is returned for
// the audit trail; full context blobs are never stored.
public sealed record CuratorManifest(
  List<string> SourceIds, List<long> MessageSeqs, int LeadVersion,
  string Policy, int TokenEstimate, long SnapshotRevision);

public static class ContextCurator
{
  public static string BidPacket(InMemoryStore s, Meeting m, BoardAdvisor adv,
    string prompt, Board? board)
  {
    var sb = new StringBuilder();
    sb.AppendLine($"BOARD: {(board is null ? "?" : board.Name)} | BRIEF: {Truncate(m.Brief, 500)}");
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
    sb.Append("BOARD: ").Append(board?.Name ?? "?");
    sb.Append(" | MISSION: ").Append(Truncate(board?.Mission ?? "", 600));
    sb.Append(" | STAGE: ").Append(Truncate(board?.Stage ?? "", 200)).AppendLine();
    if (lead is not null)
      sb.AppendLine($"LEAD: {lead.Name} ({lead.RoleLabel}). Familiar: {Truncate(lead.FamiliarTopics, 300)}. Explain simply: {Truncate(lead.SimplerTopics, 300)}. Prefs: {Truncate(lead.CommPrefs, 300)}");
    sb.AppendLine($"MEETING BRIEF: {Truncate(m.Brief, 800)}");
    sb.AppendLine($"YOUR ROLE: {adv.BoardRole} (roster v{adv.RosterVersion})");
    var recent = Recent(s, m.Id, 12);
    foreach (var msg in recent)
      sb.AppendLine($"[{msg.Sequence}] {msg.Sender}{(msg.AdvisorName is null ? "" : "/" + msg.AdvisorName)}: {Truncate(msg.Content, 600)}");
    foreach (var d in s.Drafts.Values
      .Where(d => d.MeetingId == m.Id && d.Status == "approved")
      .OrderByDescending(d => d.Version).Take(3))
      sb.AppendLine($"APPROVED RECORD v{d.Version}: {Truncate(RecordsOps.BuildExport(d.ItemsJson, d.ApprovedJson, false), 1500)}");
    foreach (var n in s.Notes.Values
      .Where(n => n.BoardId == m.BoardId && n.Kind == "direction" && !n.Provisional
        && (n.Scope == "board" || n.MeetingId == m.Id))
      .OrderByDescending(n => n.CreatedAt).Take(5))
      sb.AppendLine($"DIRECTION ({n.Scope}): {Truncate(n.Body, 500)}");
    var words = Keywords(prompt);
    var ranked = s.Sources.Values
      .Where(x => x.BoardId == m.BoardId && x.Approved && !x.Excluded
        && (x.Scope == "board" || x.MeetingId == m.Id)
        && x.Original is not null)
      .Select(x => (doc: x, text: ReadableText(s, x)))
      .Where(e => !string.IsNullOrWhiteSpace(e.text))
      .OrderByDescending(e => Score(e.text, words))
      .Take(6).ToList();
    var sourceIds = new List<string>();
    var room = draftTokens * 4 - sb.Length;
    if (room > 0 && ranked.Count > 0)
    {
      var share = room / ranked.Count;
      foreach (var (doc, text) in ranked)
      {
        sb.AppendLine($"[SOURCE:{doc.FileName} v{doc.Version}]: {Truncate(text, share)}");
        sourceIds.Add($"{doc.Id}:v{doc.Version}");
      }
    }
    var packet = sb.ToString();
    var manifest = new CuratorManifest(sourceIds,
      recent.Select(x => x.Sequence).ToList(),
      board?.LeadProfileVersion ?? 0,
      board?.DiscussionPolicy ?? "balanced",
      packet.Length / 4, m.DeliveredRevision);
    return (packet, manifest);
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

  public static List<RecallHit> Recall(InMemoryStore s, Guid boardId, string query, int take = 8)
  {
    var words = Keywords(query);
    var hits = new List<RecallHit>();
    foreach (var doc in s.Sources.Values.Where(x => x.BoardId == boardId && x.Approved && !x.Excluded))
    {
      var text = ReadableText(s, doc);
      if (string.IsNullOrWhiteSpace(text)) continue;
      hits.Add(new RecallHit("source", $"{doc.FileName} v{doc.Version}", Truncate(text, 600), Score(text, words)));
    }
    foreach (var d in s.Drafts.Values.Where(d => d.BoardId == boardId && d.Status == "approved"))
    {
      var text = RecordsOps.BuildExport(d.ItemsJson, d.ApprovedJson, false);
      if (!string.IsNullOrWhiteSpace(text))
        hits.Add(new RecallHit("record", $"record v{d.Version}", Truncate(text, 600), Score(text, words) + 2));
    }
    foreach (var n in s.Notes.Values.Where(n => n.BoardId == boardId && n.Kind == "direction" && !n.Provisional))
      hits.Add(new RecallHit("direction", n.Scope, Truncate(n.Body, 400), Score(n.Body, words) + 2));
    return hits.OrderByDescending(h => h.Score).Take(Math.Clamp(take, 1, 20)).ToList();
  }

  private static string ReadableText(InMemoryStore s, SourceDoc doc)
  {
    if (Extraction.MarkdownOf(doc.ExtractionJson) is { } md && !string.IsNullOrWhiteSpace(md))
      return md;
    return doc.Original is null ? "" : DecodeText(doc.Original);
  }

  private static string DecodeText(byte[] bytes)
  {
    string text;
    try { text = Encoding.UTF8.GetString(bytes); }
    catch (DecoderFallbackException) { return ""; }
    if (text.Length == 0) return "";
    var printable = text.Count(c => !char.IsControl(c) || c is '\n' or '\r' or '\t');
    if ((double)printable / text.Length < 0.7) return ""; // binary: waits for Docling extraction
    return text.Length > 12000 ? text[..12000] : text;
  }
}
