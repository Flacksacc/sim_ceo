using SimCEO.Api.Data;
using SimCEO.Api.Domain;
using SimCEO.Api.Work;
using System.Text.Json;

var failures = new List<string>();
void Check(bool ok, string name, string detail)
{
  Console.WriteLine((ok ? "PASS " : "FAIL ") + name + " :: " + detail);
  if (!ok) failures.Add(name);
}

// Fixture helper: isolated store + board + meeting + roster advisor.
(InMemoryStore s, Board board, Meeting meeting, BoardAdvisor adv) NewMeeting(string profileJson, string description)
{
  var s = new InMemoryStore();
  var board = new Board { Name = "Budget Board", Mission = "Mission", Stage = "Stage" };
  s.Boards[board.Id] = board;
  var meeting = new Meeting { BoardId = board.Id, Title = "Budget meeting", State = MeetingState.Active, Brief = "Brief" };
  s.Meetings[meeting.Id] = meeting;
  var rent = new RosterEntry { Name = "Adv", Description = description, ProfileJson = profileJson, Version = 3 };
  s.Roster[rent.Id] = rent;
  var adv = new BoardAdvisor { BoardId = board.Id, RosterEntryId = rent.Id, RosterVersion = rent.Version, BoardRole = "Strategist", Approved = true };
  s.Advisors[adv.Id] = adv;
  return (s, board, meeting, adv);
}
void AddLead(InMemoryStore s, Meeting m, string content, long seq)
{
  var list = s.Messages.GetOrAdd(m.Id, _ => new List<Message>());
  list.Add(new Message { BoardId = m.BoardId, MeetingId = m.Id, Sequence = seq, Sender = "lead", Content = content, Status = "committed" });
}
string Tail(string head, char fill, string tail, int total)
{
  var t = head + new string(fill, Math.Max(0, total - head.Length - tail.Length)) + tail;
  if (t.Length != total) t = t.Substring(0, total - tail.Length) + tail;
  return t;
}

// ---- Oversized legal legacy fixture: 19.9k strengths + 4k desc + 4k question + 4k lead ----
var legacyProfile = JsonSerializer.Serialize(new { fictional = true, name = "Legacy Adv", strengths = new[] { new string((char)83, 19900) } });
var legacyDesc = new string((char)68, 4000);
var overQ = Tail("Q-HEAD-", (char)81, "-Q-TAIL-OVERSIZED-12345", 4000);
var overL = Tail("L-HEAD-DISTINCT-", (char)76, "-L-TAIL-OVERSIZED-67890", 4000);
Check(legacyProfile.Length <= 20000, "oversized-fixture-legal-profile", "profileJson=" + legacyProfile.Length + " (must stay <=20000 so rejection is budget, not save-bounds)");
{
  var (s, board, meeting, adv) = NewMeeting(legacyProfile, legacyDesc);
  AddLead(s, meeting, overL, 7);
  var bidBudget = ModelGateway.UserCharBudget("advisor-bid", CharacterBehavior.BidInputTokens);
  var replyBudget = ModelGateway.UserCharBudget("advisor-reply", ContextBudget.DraftTokens);
  // Bid route is attempted first in production; record honest reachability.
  string bidOutcome;
  try
  {
    var bp = ContextCurator.BidPacket(s, meeting, adv, overQ, board);
    var deliveredBid = bp + ContextCurator.AdvisorBidSuffix;
    bidOutcome = "BID-RETURNED len=" + deliveredBid.Length + " budget=" + bidBudget;
    Check(false, "oversized-bid-rejects", bidOutcome + " :: expected EssentialBudgetExceededException, got truncated success");
  }
  catch (ContextCurator.EssentialBudgetExceededException ex)
  {
    bidOutcome = "BID-REJECTED";
    Check(ex.Message.Contains("advisor profile and question are too long together"), "oversized-bid-rejects", "bid refused before provider; msg=" + ex.Message.Substring(0, Math.Min(120, ex.Message.Length)));
  }
  catch (Exception ex)
  {
    bidOutcome = "BID-OTHER-" + ex.GetType().Name;
    Check(false, "oversized-bid-rejects", "wrong category: " + ex.GetType().Name + " " + ex.Message);
  }
  try
  {
    var built = ContextCurator.BuildPacket(s, meeting, adv, overQ, board, null);
    Check(false, "oversized-reply-rejects", "expected EssentialBudgetExceededException, got packet len=" + built.packet.Length);
  }
  catch (ContextCurator.EssentialBudgetExceededException ex)
  {
    Check(ex.Message.Contains("advisor profile and question are too long together"), "oversized-reply-rejects", "reply refused before provider (" + bidOutcome + " first); msg=" + ex.Message.Substring(0, Math.Min(120, ex.Message.Length)));
  }
  catch (Exception ex)
  {
    Check(false, "oversized-reply-rejects", "wrong category: " + ex.GetType().Name + " " + ex.Message);
  }
  Console.WriteLine("REACHABILITY oversized-legacy: " + bidOutcome + " -> reply BuildPacket also rejects; no provider dispatch attempted by builder (honest: bid fails first, reply never reached).");
}

// ---- Accepted max: 3x2000 + 4000 question + distinct 4000 lead ----
var cTail = "-C-TAIL-11111";
var rTail = "-R-TAIL-22222";
var sTail = "-S-TAIL-33333";
var qTail = "-Q-TAIL-ACCEPTED-44444";
var lTail = "-L-TAIL-ACCEPTED-DISTINCT-55555";
var cPara = Tail("C-HEAD-", (char)67, cTail, 2000);
var rPara = Tail("R-HEAD-", (char)82, rTail, 2000);
var sPara = Tail("S-HEAD-", (char)83, sTail, 2000);
var okQ = Tail("Q-HEAD-", (char)81, qTail, 4000);
var okL = Tail("L-HEAD-DISTINCT-", (char)76, lTail, 4000);
var okProfile = JsonSerializer.Serialize(new { contributionCriteria = cPara, reasoningApproach = rPara, responseStyle = sPara });
{
  var (ok, err, _) = CharacterBehavior.ValidateSavedProfile(okProfile);
  Check(ok, "accepted-fixture-legal-save", err ?? "3x2000 canonical profile accepted (no max changed)");
}
{
  var (s, board, meeting, adv) = NewMeeting(okProfile, "Owner description.");
  AddLead(s, meeting, okL, 7);
  string packet = "";
  CuratorManifest? manifest = null;
  try
  {
    var built = ContextCurator.BuildPacket(s, meeting, adv, okQ, board, null);
    packet = built.packet; manifest = built.manifest;
    Check(true, "accepted-build-succeeds", "packet=" + packet.Length);
  }
  catch (Exception ex) { Check(false, "accepted-build-succeeds", ex.GetType().Name + " " + ex.Message); }
  if (manifest is not null)
  {
    var suffix = ContextCurator.AdvisorReplySuffix;
    var delivered = packet + suffix;
    var budget = ModelGateway.UserCharBudget("advisor-reply", ContextBudget.DraftTokens);
    Check(packet.Contains(cTail) && packet.Contains(rTail) && packet.Contains(sTail), "accepted-3-paragraph-tails", "all behavior tails preserved whole");
    Check(packet.Contains(qTail), "accepted-question-tail", "current question tail preserved");
    Check(packet.Contains(lTail), "accepted-lead-tail", "distinct latest-lead tail preserved");
    Check(delivered.Length <= budget, "accepted-delivered-budget", "delivered=" + delivered.Length + " suffix=" + suffix.Length + " budget=" + budget);
    Check(manifest.TokenEstimate == delivered.Length / 4, "accepted-manifest-estimate", "estimate=" + manifest.TokenEstimate + " delivered/4=" + (delivered.Length / 4));
    Check(manifest.MessageSeqs.Contains(7), "accepted-manifest-seqs", "seqs=[" + string.Join(",", manifest.MessageSeqs) + "] retains lead seq");
    Check(manifest.SourceIds.Count == 0 && manifest.Evidence.Count == 0, "accepted-manifest-empty-honest", "no sources added so manifest honestly empty");
    // Bid side for the same accepted essentials (question trimmed to 2k but tail-preserved).
    try
    {
      var bp = ContextCurator.BidPacket(s, meeting, adv, okQ, board);
      var bDelivered = bp + ContextCurator.AdvisorBidSuffix;
      var bBudget = ModelGateway.UserCharBudget("advisor-bid", CharacterBehavior.BidInputTokens);
      Check(bDelivered.Length <= bBudget, "accepted-bid-budget", "bidDelivered=" + bDelivered.Length + " budget=" + bBudget);
    }
    catch (Exception ex) { Check(false, "accepted-bid-budget", ex.GetType().Name + " " + ex.Message); }
  }
}

// ---- Sender contract: source check alone (NOT provider proof) ----
{
  var src = File.ReadAllText("server/SimCEO.Api/Work/Endpoints.cs");
  var hasReplyConst = src.Contains("packet + ContextCurator.AdvisorReplySuffix");
  var hasBidConst = src.Contains("bidPacket + ContextCurator.AdvisorBidSuffix");
  var hasReplyNoTrunc = src.Contains("\"advisor-reply\"") && src.Contains("truncatePrompt: false");
  var hasBidNoTrunc = src.Contains("\"advisor-bid\"") && src.Contains("truncatePrompt: false");
  Check(hasReplyConst && hasBidConst, "sender-shared-suffix", "builder reserve + sender append share one constant (no duplicated magic margin)");
  Check(hasReplyNoTrunc && hasBidNoTrunc, "sender-truncate-false", "CompleteAsync truncatePrompt:false for bid+reply (source check only, not provider proof)");
  Console.WriteLine("NOTE sender-source-check is static text evidence only; provider behavior is proven by fake-transport tests below, never claimed from text.");
}

// ---- Gateway budget defense without network (no provider proof claimed) ----
{
  var big = new string((char)88, ModelGateway.UserCharBudget("advisor-reply", ContextBudget.DraftTokens) + 5000);
  bool threw = false;
  try { var _ = ModelGateway.BuildSecretaryPayload("advisor-reply", big, ContextBudget.DraftTokens, false); }
  catch (ProviderException) { threw = true; }
  catch (Exception ex) { Check(false, "gateway-notrunc-rejects", "wrong: " + ex.GetType().Name); }
  Check(threw, "gateway-notrunc-rejects", "truncatePrompt:false throws instead of silently cutting tail");
}

// ---- Fake-transport delivered honesty (authored+executed here; fake, not real LLM) ----
{
  string? captured = null;
  int calls = 0;
  var handler = new CaptureHandler(async (req) =>
  {
    calls++;
    var body = await req.Content!.ReadAsStringAsync();
    captured = body;
    var json = "{\"id\":\"fake-1\",\"choices\":[{\"message\":{\"content\":\"hello\"},\"finish_reason\":\"stop\"}]}";
    return new HttpResponseMessage(System.Net.HttpStatusCode.OK) { Content = new StringContent(json, System.Text.Encoding.UTF8, "application/json") };
  });
  var (s, board, meeting, adv) = NewMeeting(okProfile, "Owner description.");
  AddLead(s, meeting, okL, 9);
  var built = ContextCurator.BuildPacket(s, meeting, adv, okQ, board, null);
  var delivered = built.packet + ContextCurator.AdvisorReplySuffix;
  var gw = new ModelGateway(s, new HttpClient(handler));
  string? text = null;
  try { text = await gw.CompleteAsync("fake-model", "advisor-reply", delivered, ContextBudget.DraftTokens, 512, ownerOverride: true, boundKey: "test-key"); }
  catch (Exception ex) { Check(false, "fake-delivered-roundtrip", ex.GetType().Name + " " + ex.Message); }
  Check(text == "hello", "fake-delivered-roundtrip", "fake provider returned canned hello");
  Check(calls == 1, "fake-dispatched-once", "calls=" + calls);
  try
  {
    using var doc = JsonDocument.Parse(captured ?? "{}");
    var msgs = doc.RootElement.GetProperty("messages");
    var userContent = msgs[1].GetProperty("content").GetString() ?? "";
    Check(userContent == delivered, "fake-delivered-exact", "captured user content equals packet+suffix exactly (" + userContent.Length + ")");
    var devLen = msgs[0].GetProperty("content").GetString()!.Length;
    Check(userContent.Length + devLen <= ContextBudget.DraftTokens * 4, "fake-delivered-total", "user+dev=" + (userContent.Length + devLen) + " inputBudget*4=" + (ContextBudget.DraftTokens * 4));
  }
  catch (Exception ex) { Check(false, "fake-delivered-exact", ex.Message); }
  // Oversized direct dispatch must reject BEFORE any HTTP call.
  int calls2 = 0;
  var handler2 = new CaptureHandler(req => { calls2++; throw new InvalidOperationException("must not dispatch"); });
  var gw2 = new ModelGateway(s, new HttpClient(handler2));
  var tooBig = new string((char)89, ModelGateway.UserCharBudget("advisor-reply", ContextBudget.DraftTokens) + 1000);
  bool threw2 = false;
  try { var _ = await gw2.CompleteAsync("fake-model", "advisor-reply", tooBig, ContextBudget.DraftTokens, 512, ownerOverride: true, boundKey: "test-key", truncatePrompt: false); }
  catch (ProviderException) { threw2 = true; }
  catch (Exception ex) { Check(false, "fake-oversized-rejects", "wrong: " + ex.GetType().Name); }
  Check(threw2 && calls2 == 0, "fake-oversized-rejects", "truncatePrompt:false rejects pre-dispatch (calls=" + calls2 + "); no silent tail cut");
}

Console.WriteLine(failures.Count == 0 ? "ESSENTIAL-BUDGET-PROBE ALL PASS (fake transport only; no real LLM claim)" : "ESSENTIAL-BUDGET-PROBE FAILURES: " + string.Join(",", failures));
return failures.Count == 0 ? 0 : 1;

sealed class CaptureHandler(Func<HttpRequestMessage, Task<HttpResponseMessage>> fn) : HttpMessageHandler
{
  protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) => fn(request);
}
