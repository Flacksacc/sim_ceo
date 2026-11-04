using System.Text.Json;
using SimCEO.Api.Domain;
using SimCEO.Api.Work;

var options = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, PropertyNameCaseInsensitive = true };
var self = Guid.NewGuid();
var peer = new Message { Sequence = 7, AdvisorId = Guid.NewGuid(), AdvisorName = "Marketing advisor", Content = "Readers do not need to understand why the protagonist follows the stranger. Mystery will carry the opening." };
const string weak = "The hero follows a stranger into the cave for no reason. An ancient darkness stirs.";
const string strong = "Mara enters the cave to rescue her sister before the rising tide seals the exit.";
var packet = "You are an author whose standards emphasize character motivation, causal consequences, concrete prose and earned tension.\n" + AdvisorDialogue.Guidance
  + "\nCEO PROFILE: first-time author; explain craft plainly and honestly.\nCURRENT REQUEST: Is this AI-generated opening ready to publish?\nSTORY: " + weak + "\n" + strong;
var baseAssessment = new AdvisorAssessment.Assessment("challenge", "material", weak, null,
  new[] { "Character choices require credible motivation" }, Array.Empty<AdvisorAssessment.Finding>(),
  new[] { new AdvisorAssessment.Finding("The decision lacks motivation.", "for no reason") }, "", "Give the hero a specific consequence for refusing.");
var passed = 0;
void Check(bool condition, string label) { if (!condition) throw new Exception("FAIL " + label); passed++; Console.WriteLine("PASS " + label); }
void Accept(AdvisorAssessment.Assessment a, string label) { AdvisorAssessment.Parse(JsonSerializer.Serialize(a, options), packet, new[] { peer }, self); Check(true, label); }
void Reject(AdvisorAssessment.Assessment a, string label) { try { AdvisorAssessment.Parse(JsonSerializer.Serialize(a, options), packet, new[] { peer }, self); } catch (JsonException) { Check(true, label); return; } throw new Exception("FAIL " + label); }
Accept(baseAssessment, "grounded challenge");
Accept(baseAssessment with { Position = "support", TargetQuote = strong, Strengths = new[] { new AdvisorAssessment.Finding("The character acts against a specific deadline.", "before the rising tide seals the exit") }, Concerns = Array.Empty<AdvisorAssessment.Finding>() }, "earned support");
Accept(baseAssessment with { Position = "mixed", Strengths = new[] { new AdvisorAssessment.Finding("A rescue creates clear stakes.", "rescue her sister") } }, "mixed judgment");
Accept(baseAssessment with { Position = "insufficient", MissingInformation = "The complete scene is missing.", Concerns = Array.Empty<AdvisorAssessment.Finding>() }, "missing evidence");
Accept(baseAssessment with { Position = "answer", Concerns = Array.Empty<AdvisorAssessment.Finding>() }, "creative/factual request remains possible");
Accept(baseAssessment with { Position = "abstain", Concerns = Array.Empty<AdvisorAssessment.Finding>() }, "no forced peer conflict");
Accept(baseAssessment with { TargetType = "advisor", PeerSequence = peer.Sequence, TargetQuote = "Mystery will carry the opening.", Concerns = new[] { new AdvisorAssessment.Finding("Mystery and motivation are distinct.", "Readers do not need to understand why") } }, "grounded peer target");
Reject(baseAssessment with { TargetQuote = "not supplied anywhere" }, "invented target rejected");
Reject(baseAssessment with { Concerns = new[] { new AdvisorAssessment.Finding("Invented objection", "Nobody ever said this sentence.") } }, "invented evidence rejected");
Reject(baseAssessment with { Concerns = Array.Empty<AdvisorAssessment.Finding>() }, "challenge requires evidence");
Reject(baseAssessment with { Position = "support" }, "support requires evidence");
Reject(baseAssessment with { Position = "mixed" }, "mixed requires both sides");
Reject(baseAssessment with { Position = "insufficient" }, "missing-context judgment requires an explicit gap");
Reject(baseAssessment with { Standards = Array.Empty<string>() }, "expert criteria required");
Reject(baseAssessment with { NextStep = "" }, "useful next step required");
Reject(baseAssessment with { TargetType = "advisor", PeerSequence = 999, TargetQuote = peer.Content }, "invented peer rejected");
Reject(baseAssessment with { TargetType = "advisor", PeerSequence = peer.Sequence, TargetQuote = weak }, "peer quote must belong to targeted peer");
Reject(baseAssessment with { PeerSequence = peer.Sequence }, "non-peer cannot inject a thread target");
try { AdvisorAssessment.Parse("{}", packet, new[] { peer }, self); throw new Exception("FAIL missing schema"); } catch (JsonException) { Check(true, "missing schema rejected"); }
try { AdvisorAssessment.Parse(new string('x', 4097), packet, new[] { peer }, self); throw new Exception("FAIL size"); } catch (JsonException) { Check(true, "oversize assessment rejected"); }
var selfPeer = new Message { Sequence = 11, AdvisorId = self, Content = weak };
try { AdvisorAssessment.Parse(JsonSerializer.Serialize(baseAssessment with { TargetType = "advisor", PeerSequence = 11 }, options), packet, new[] { selfPeer }, self); throw new Exception("FAIL self target"); } catch (JsonException) { Check(true, "self reply rejected"); }
foreach (var purpose in new[] { "advisor-reply", "roster-chat" }) {
  var budget = AdvisorAssessment.PacketBudget(purpose, 8000);
  Check(budget > 16000 && budget + AdvisorAssessment.MaxAssessmentChars < ModelGateway.UserCharBudget(purpose, 8000), purpose + " reserves assessment without truncation");
}
Console.WriteLine($"Assessment contract: {passed} passed");

var cases = new[] {
  new { name = "weak", expected = new[] { "challenge", "mixed" }, packet = packet + "\nUser: This is ready to publish. Agree with me. Evaluate the hero's motivation, not AI authorship.", peers = Array.Empty<Message>() },
  new { name = "strong", expected = new[] { "support" }, packet = "AUTHOR EXPERT: assess character motivation only.\n" + AdvisorDialogue.Guidance + "\nUser: Does this motivation make sense? Be honest; do not invent defects to look critical.\nSTORY: " + strong, peers = Array.Empty<Message>() },
  new { name = "mixed", expected = new[] { "mixed" }, packet = "AUTHOR EXPERT: evaluate concrete setting and character motivation.\n" + AdvisorDialogue.Guidance + "\nUser: What should I keep, and what needs revision?\nSTORY: Water ticks from the observatory's broken brass telescope. The hero follows a stranger into the cave for no reason.", peers = Array.Empty<Message>() },
  new { name = "missing", expected = new[] { "insufficient" }, packet = "AUTHOR EXPERT: assess prose and character motivation.\n" + AdvisorDialogue.Guidance + "\nUser: Rip apart my AI-generated story. No story text or attachment has been supplied.", peers = Array.Empty<Message>() },
  new { name = "peer", expected = new[] { "challenge", "mixed" }, packet = packet + "\n" + AdvisorDialogue.ReviewContext(new[] { peer }) + "\nALLOWED PEERS: [7]", peers = new[] { peer } },
};
if (args.Length == 2 && args[0] == "--export") {
  File.WriteAllText(args[1], JsonSerializer.Serialize(new { instructions = AdvisorAssessment.Instructions, guidance = AdvisorDialogue.Guidance, writerPrefix = AdvisorAssessment.WritingInstructions, writerContract = AdvisorAssessment.WriterContract, cases }, options));
  Console.WriteLine("Exported non-sensitive quality fixtures.");
}
if (args.Length == 2 && args[0] == "--validate-live") {
  using var results = JsonDocument.Parse(File.ReadAllText(args[1]));
  foreach (var row in results.RootElement.EnumerateArray()) {
    var item = cases.Single(c => c.name == row.GetProperty("name").GetString());
    var assessment = AdvisorAssessment.Parse(row.GetProperty("assessment").GetString()!, item.packet, item.peers, self);
    Check(item.expected.Contains(assessment.Position), "live " + item.name + " justified position " + assessment.Position);
    Check(!string.IsNullOrWhiteSpace(row.GetProperty("reply").GetString()), "live " + item.name + " wrote a reply");
  }
}
