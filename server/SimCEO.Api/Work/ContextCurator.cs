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
  // Delivered instruction suffixes: SINGLE shared source for builder reserve + sender append.
  // The provider USER message is packet + suffix; the builder reserves suffix.Length inside
  // ModelGateway.UserCharBudget so packet+suffix never exceeds the delivered budget. Sender
  // must append these constants (never a duplicated literal) with truncatePrompt:false.
  public const string AdvisorReplySuffix = "\nYOUR TURN. Cite [source:name] or [record:version] where used; if you add nothing, reply with exactly ABSTAIN. If your reply takes a clear position on the lead question or another advisor point, end with [stance: Agrees|Disagrees|Raises risk|Proposes alternative]; otherwise omit the tag.";
  public const string AdvisorBidSuffix = "\nReply with exactly YES or NO, then one line why.";

  // Explicit budget rejection: essentials (behavior + question + latest lead + suffix) cannot
  // fit together. Callers surface Message (contains advisor profile and question are too long
  // together); essentials are never silently cropped and metadata never describes trimmed text.
  public sealed class EssentialBudgetExceededException : Exception
  {
    public EssentialBudgetExceededException(string message) : base(message) { }
  }

  // Latest posted lead message: when the run prompt is a bare continue, the
  // actual question lives in the transcript. The full essential text rides
  // with the run prompt so a decisive instruction past old truncation caps is
  // never lost from bidding or replies.
  public static string LatestLeadMessage(InMemoryStore s, Guid meetingId, int maxChars = 4000)
  {
    Message? latest = null;
    foreach (var msg in Recent(s, meetingId, 40))
      if (string.Equals(msg.Sender, "lead", StringComparison.OrdinalIgnoreCase)) latest = msg;
    if (latest is null) return "";
    return CharacterBehavior.EssentialQuestion(latest.Content ?? "", maxChars);
  }
  // Bid packet: selection MUST consume the full character (not BoardRole alone).
  // ALL THREE accepted paragraphs are delivered whole: oversize input is
  // rejected at save, never silently cut here. The run question PLUS the latest
  // posted lead message are essential context alongside behavior; transcript
  // history is droppable and trimmed oldest-first under the bid budget.
  public static string BidPacket(InMemoryStore s, Meeting m, BoardAdvisor adv,
    string prompt, Board? board)
  {
    var sb = new StringBuilder();
    var effName = board is null ? "?" : LeadSetup.EffectiveView(s, board).name;
    sb.AppendLine($"BOARD: {effName} | BRIEF: {Truncate(m.Brief, 500)}");
    string rosterProfile = "{}";
    int rosterVersion = adv.RosterVersion;
    string advisorName = adv.BoardRole;
    string? seedDesc = null;
    if (s.Roster.TryGetValue(adv.RosterEntryId, out var rent) && rent is not null)
    {
      rosterProfile = rent.ProfileJson ?? "{}";
      rosterVersion = rent.Version;
      advisorName = rent.Name;
      seedDesc = rent.Description;
    }
    var behavior = CharacterBehavior.Resolve(rosterProfile);
    sb.AppendLine($"ADVISOR: {advisorName} (canonical roster v{rosterVersion}, pinned v{adv.RosterVersion}{(adv.RosterVersion != rosterVersion ? " STALE" : "")})");
    sb.AppendLine($"YOUR ROLE: {adv.BoardRole}");
    sb.AppendLine("Contribution criteria: " + behavior.ContributionCriteria);
    sb.AppendLine("Reasoning approach: " + behavior.ReasoningApproach);
    sb.AppendLine("Response style: " + behavior.ResponseStyle);
    sb.Append(CharacterBehavior.SeedContextSection(sb.ToString(), rosterProfile, seedDesc));
    sb.AppendLine("QUESTION (essential - bid on THIS request): " + CharacterBehavior.EssentialQuestion(prompt, CharacterBehavior.MaxBidQuestionChars));
    var leadQ = LatestLeadMessage(s, m.Id);
    if (!string.IsNullOrWhiteSpace(leadQ))
      sb.AppendLine("LATEST LEAD MESSAGE (essential - the posted question this run continues): " + leadQ);
    var essential = sb.ToString();
    var droppable = Recent(s, m.Id, 3)
      .Select(msg => "[" + msg.Sequence + "] " + msg.Sender + ": " + Truncate(msg.Content, 300)).ToList();
    var budget = ModelGateway.UserCharBudget("advisor-bid", CharacterBehavior.BidInputTokens);
    var effective = budget - AdvisorBidSuffix.Length;
    if (essential.Length > effective)
      throw new EssentialBudgetExceededException($"advisor profile and question are too long together ({essential.Length} chars essential + {AdvisorBidSuffix.Length} chars instruction exceed {budget} chars delivered budget); shorten the saved paragraphs or the request and try again.");
    return CharacterBehavior.FitEssentialFirst(essential, droppable, effective)
      ?? throw new EssentialBudgetExceededException($"advisor profile and question are too long together ({essential.Length} chars essential exceed {budget} chars delivered budget); shorten the saved paragraphs or the request and try again.");
  }

  public static (string packet, CuratorManifest manifest) BuildPacket(
    InMemoryStore s, Meeting m, BoardAdvisor adv, string prompt,
    Board? board, LeadProfile? lead, int draftTokens = 8000, string? reviewContext = null)
  {
    var sb = new StringBuilder();
    var eff = board is null ? (name: "?", mission: "", stage: "", policy: "balanced", dataUse: "contributor") : LeadSetup.EffectiveView(s, board);
    sb.Append("BOARD: ").Append(eff.name);
    sb.Append(" | MISSION: ").Append(Truncate(eff.mission, 600));
    sb.Append(" | STAGE: ").Append(Truncate(eff.stage, 200)).AppendLine();
    if (lead is not null)
      sb.AppendLine($"LEAD: {lead.Name} ({lead.RoleLabel}). Familiar: {Truncate(lead.FamiliarTopics, 300)}. Explain simply: {Truncate(lead.SimplerTopics, 300)}. Prefs: {Truncate(lead.CommPrefs, 300)}");
    sb.Append(AdvisorDialogue.UserContext(lead));
    sb.AppendLine(AdvisorDialogue.Guidance);
    sb.AppendLine($"MEETING BRIEF: {Truncate(m.Brief, 800)}");
    // Canonical roster authority: the packet embeds the CURRENT roster entry (full behavior
    // paragraphs + dossier + version pin), never a forked board copy. Roster edits therefore
    // change effective behavior; board-specific role stays on its own line and never leaks
    // into the canonical behavior hash. ESSENTIAL FIRST: behavior + the actual run question
    // are never trimmed; evidence, sources and transcript below yield to the deterministic
    // budget instead (see enforcement at the end).
    var behaviorSection = RosterIntegrity.CanonicalPacketSection(s, adv);
    var questionSection = "CURRENT REQUEST (essential - answer THIS, even when it differs from transcript): "
      + CharacterBehavior.EssentialQuestion(prompt) + "\n";
    var leadQ = LatestLeadMessage(s, m.Id);
    if (!string.IsNullOrWhiteSpace(leadQ))
      questionSection += "LATEST LEAD MESSAGE (essential - the posted question this run continues): " + leadQ + "\n";
    string? pktSeedDesc = null;
    string pktSeedProf = "{}";
    if (s.Roster.TryGetValue(adv.RosterEntryId, out var pktRent) && pktRent is not null)
    {
      pktSeedDesc = pktRent.Description;
      pktSeedProf = pktRent.ProfileJson ?? "{}";
    }
    sb.Append(behaviorSection);
    sb.Append(AdvisorDialogue.Background(pktSeedProf, pktSeedDesc));
    sb.Append(CharacterBehavior.SeedContextSection(behaviorSection, pktSeedProf, pktSeedDesc));
    sb.Append(questionSection);
    if (!string.IsNullOrWhiteSpace(reviewContext)) sb.AppendLine(reviewContext);
    var essentialPrefix = sb.ToString();
    // Transcript blocks (single-line, atomic): seq tracked with its rendered line.
    var recent = Recent(s, m.Id, 12);
    var transcriptBlocks = recent.Select(msg => (seq: msg.Sequence, line: $"[{msg.Sequence}] {msg.Sender}{(msg.AdvisorName is null ? "" : "/" + msg.AdvisorName)}: {SingleLine(Truncate(msg.Content, 600))}")).ToList();
    // Record blocks with their evidence (atomic units).
    var recordBlocks = new List<(string Line, List<EvidenceRef> Refs)>();
    foreach (var v in RecordsOps.EffectiveChains(s.Drafts.Values.Where(d => d.MeetingId == m.Id))
      .Where(v => v.EffectiveIds.Count > 0).OrderByDescending(v => v.Head.Version).Take(3))
    {
      var line = $"APPROVED RECORD v{v.Head.Version}: {SingleLine(Truncate(v.ConciseExport, 1500))}";
      var refs = new List<EvidenceRef>();
      foreach (var id2 in v.EffectiveIds)
      {
        if (v.EffectiveOwners.TryGetValue(id2, out var own) && v.EffectiveTexts.TryGetValue(id2, out var et))
          refs.Add(EvidenceRef.ForRecordItem(own.RecordId, own.Version, id2, SingleLine(Truncate(et, 200))));
      }
      recordBlocks.Add((line, refs));
    }
    // Direction blocks with their evidence (atomic units).
    var directionBlocks = new List<(string Line, EvidenceRef Ref)>();
    foreach (var n in s.Notes.Values
      .Where(n => n.BoardId == m.BoardId && n.Kind == "direction" && !n.Provisional
        && (n.Scope == "board" || n.MeetingId == m.Id))
      .OrderByDescending(n => n.CreatedAt).Take(5))
    {
      var nref = EvidenceRef.ForNote(n);
      var line = $"DIRECTION ({n.Scope} {nref.Ref}): {SingleLine(Truncate(n.Body, 500))}";
      directionBlocks.Add((line, nref));
    }
    var words = Keywords(prompt);
    var ranked = s.Sources.Values
      .Where(x => x.BoardId == m.BoardId && SourceGovernance.IsEligible(s, x, m.Id))
      .Select(x => (doc: x, text: ReadableText(s, x)))
      .Where(e => !string.IsNullOrWhiteSpace(e.text))
      .OrderByDescending(e => Score(e.text, words))
      .Take(6).ToList();
    // Permitted-use guidance per wiki resource (model-use guidance, never content).
    var wikiUseByRes = new Dictionary<Guid, string>();
    foreach (var rid in ranked.Where(e => e.doc.ResourceId.HasValue).Select(e => e.doc.ResourceId!.Value).Distinct().ToList())
    {
      if (s.WikiResources.TryGetValue(rid, out var wr) && wr.BoardId == m.BoardId
        && wr.Enabled && !string.IsNullOrWhiteSpace(wr.AllowedUse))
        wikiUseByRes[rid] = $"[WIKI PERMITTED USE ({SingleLine(wr.Description.Trim())}): {SingleLine(wr.AllowedUse.Trim())}]";
    }
    // Source blocks: COMPLETE single-line blocks with metadata/pins/evidence.
    // Multiline excerpts are flattened to one line per block so trimming can
    // never leave a quoted body orphan after removing its header line.
    var replyBudget0 = ModelGateway.UserCharBudget("advisor-reply", draftTokens);
    var effective0 = replyBudget0 - AdvisorReplySuffix.Length;
    var baseLen = essentialPrefix.Length
      + transcriptBlocks.Sum(b => b.line.Length + 1)
      + recordBlocks.Sum(b => b.Line.Length + 1)
      + directionBlocks.Sum(b => b.Line.Length + 1)
      + wikiUseByRes.Values.Sum(v => v.Length + 1);
    var room = effective0 - baseLen;
    var sourceBlocks = new List<(string Block, string SourceId, EvidenceRef Evidence, Guid? ResourceId)>();
    if (room > 0 && ranked.Count > 0)
    {
      var share = room / ranked.Count;
      foreach (var (doc, text) in ranked)
      {
        var clean = SingleLine(Truncate(text, share));
        var block = $"[SOURCE:{doc.FileName} v{doc.Version}]: {clean}";
        var sid = $"{doc.Id}:v{doc.Version}:g{doc.IndexGeneration}:{doc.ContentHash}:s{SourceGovernance.SectionRevision(s, doc.Id)}";
        var ev = EvidenceRef.ForSource(doc, SingleLine(Truncate(text, 200)));
        sourceBlocks.Add((block, sid, ev, doc.ResourceId));
      }
    }
    // Atomic assembly from RETAINED blocks with the corresponding manifest.
    // Priority: sources (lowest-ranked last) then records then directions, then
    // transcript oldest-first. Essential prefix (3 paragraphs + question) is never cut.
    string Rebuild(out List<string> outSourceIds, out List<long> outSeqs, out List<EvidenceRef> outEvidence)
    {
      var b = new StringBuilder(essentialPrefix);
      foreach (var tb in transcriptBlocks) b.AppendLine(tb.line);
      foreach (var rb in recordBlocks) b.AppendLine(rb.Line);
      foreach (var db in directionBlocks) b.AppendLine(db.Line);
      var liveRes = new HashSet<Guid>(sourceBlocks.Where(x => x.ResourceId.HasValue).Select(x => x.ResourceId!.Value));
      foreach (var kv in wikiUseByRes.Where(kv => liveRes.Contains(kv.Key))) b.AppendLine(kv.Value);
      foreach (var src in sourceBlocks) b.AppendLine(src.Block);
      outSourceIds = sourceBlocks.Select(x => x.SourceId).ToList();
      outSeqs = transcriptBlocks.Select(x => (long)x.seq).ToList();
      outEvidence = new List<EvidenceRef>();
      foreach (var rb in recordBlocks) outEvidence.AddRange(rb.Refs);
      foreach (var db in directionBlocks) outEvidence.Add(db.Ref);
      foreach (var src in sourceBlocks) outEvidence.Add(src.Evidence);
      return b.ToString();
    }
    var budget = ModelGateway.UserCharBudget("advisor-reply", draftTokens);
    var effectiveBudget = budget - AdvisorReplySuffix.Length;
    if (essentialPrefix.Length > effectiveBudget)
      throw new EssentialBudgetExceededException($"advisor profile and question are too long together ({essentialPrefix.Length} chars essential + {AdvisorReplySuffix.Length} chars instruction exceed {budget} chars delivered budget); shorten the saved paragraphs or the request and try again.");
    var packet = Rebuild(out var curSourceIds, out var curSeqs, out var curEvidence);
    while (packet.Length > effectiveBudget && sourceBlocks.Count > 0) { sourceBlocks.RemoveAt(sourceBlocks.Count - 1); packet = Rebuild(out curSourceIds, out curSeqs, out curEvidence); }
    while (packet.Length > effectiveBudget && recordBlocks.Count > 0) { recordBlocks.RemoveAt(recordBlocks.Count - 1); packet = Rebuild(out curSourceIds, out curSeqs, out curEvidence); }
    while (packet.Length > effectiveBudget && directionBlocks.Count > 0) { directionBlocks.RemoveAt(directionBlocks.Count - 1); packet = Rebuild(out curSourceIds, out curSeqs, out curEvidence); }
    while (packet.Length > effectiveBudget && transcriptBlocks.Count > 0) { transcriptBlocks.RemoveAt(0); packet = Rebuild(out curSourceIds, out curSeqs, out curEvidence); }
    if (packet.Length > effectiveBudget)
      throw new EssentialBudgetExceededException($"advisor profile and question are too long together ({essentialPrefix.Length} chars essential + {AdvisorReplySuffix.Length} chars instruction exceed {budget} chars delivered budget); shorten the saved paragraphs or the request and try again.");
    var manifest = new CuratorManifest(curSourceIds, curSeqs,
      lead?.Version ?? 0,
      eff.policy,
      (packet.Length + AdvisorReplySuffix.Length) / 4, m.DeliveredRevision, curEvidence);
    return (packet, manifest);
  }

  private static string SingleLine(string s) =>
    string.IsNullOrEmpty(s) ? "" : s.Replace("\r", " ").Replace("\n", " ").Trim();

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
    // Meeting-scoped recall sees only that meeting's records; board-wide recall
    // sees every meeting. A reader confined to M1 must never receive M2 record text.
    foreach (var v in RecordsOps.EffectiveChains(s.Drafts.Values.Where(d => d.BoardId == boardId && (!meetingId.HasValue || d.MeetingId == meetingId.Value))))
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
    // Board-wide directions apply to every meeting; meeting directions only to their own.
    foreach (var n in s.Notes.Values.Where(n => n.BoardId == boardId && n.Kind == "direction" && !n.Provisional && (!meetingId.HasValue || n.Scope == "board" || n.MeetingId == meetingId.Value)))
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
