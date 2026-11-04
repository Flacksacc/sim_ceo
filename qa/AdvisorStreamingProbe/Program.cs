using System.Net;
using System.Text;
using System.Text.Json;
using SimCEO.Api.Data;
using SimCEO.Api.Work;

var passed = 0;
void Check(bool value, string label) { if (!value) throw new Exception("FAIL " + label); Console.WriteLine("PASS " + label); passed++; }
string Frame(object value) => "data: " + JsonSerializer.Serialize(value) + "\r\n\r\n";
string Stream(string finish = "stop", bool done = true, bool usage = true) => ": heartbeat\r\n\r\n"
  + Frame(new { id = "stream-fixture", choices = new[] { new { index = 0, delta = new { reasoning_content = "PRIVATE REASONING NEVER DISPLAYED" }, finish_reason = (string?)null } } })
  + Frame(new { id = "stream-fixture", choices = new[] { new { index = 0, delta = new { content = "**Plan** café " }, finish_reason = (string?)null } } })
  + Frame(new { id = "stream-fixture", choices = new[] { new { index = 0, delta = new { content = "🌿 <u>Next</u>" }, finish_reason = finish } } })
  + (usage ? Frame(new { id = "stream-fixture", choices = Array.Empty<object>(), usage = new { prompt_tokens = 100, completion_tokens = 20, prompt_tokens_details = new { cached_tokens = 10 } } }) : "")
  + (done ? "data: [DONE]\r\n\r\n" : "");

async Task<(InMemoryStore Store, string? Text, Exception? Error, List<string> Deltas)> Run(string source, string media = "text/event-stream", bool cancel = false)
{
  var store = new InMemoryStore(); var deltas = new List<string>();
  var client = new HttpClient(new Handler(async request => {
    using var json = JsonDocument.Parse(await request.Content!.ReadAsStringAsync());
    Check(json.RootElement.GetProperty("stream").GetBoolean(), "provider receives real stream flag");
    Check(json.RootElement.GetProperty("stream_options").GetProperty("include_usage").GetBoolean(), "final usage requested");
    return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(source, Encoding.UTF8, media) };
  }));
  var gateway = new ModelGateway(store, client); using var cts = new CancellationTokenSource();
  try {
    var text = await gateway.CompleteAsync(ModelPolicy.SparkStandard, "advisor-reply", "Explain a plan.", 8000, 2048,
      cts.Token, ownerOverride: true, boundKey: "fixture-not-a-real-key", onDelta: value => { deltas.Add(value); if (cancel) { cts.Cancel(); cts.Token.ThrowIfCancellationRequested(); } return Task.CompletedTask; });
    return (store, text, null, deltas);
  } catch (Exception error) { return (store, null, error, deltas); }
}
var valid = await Run(Stream());
Check(valid.Error is null && valid.Text == "**Plan** café 🌿 <u>Next</u>", "SSE accumulates content and Unicode");
Check(valid.Deltas.Count == 2 && !string.Join("", valid.Deltas).Contains("PRIVATE REASONING"), "only final-answer deltas delivered");
var call = valid.Store.ModelCalls.Single();
Check(call.InputTokens == 100 && call.OutputTokens == 20 && call.CachedInputTokens == 10 && call.Cost.HasValue && call.Status == "succeeded", "stream usage and cost recorded exactly once");
var interrupted = await Run(Stream(done: false));
Check(interrupted.Error is ProviderException && interrupted.Text is null, "EOF without done never commits partial output");
Check(interrupted.Store.ModelCalls.Single().InputTokens == 100 && interrupted.Store.ModelCalls.Single().Cost.HasValue, "known usage retained on interrupted stream");
var truncated = await Run(Stream(finish: "length"));
Check(truncated.Error is ProviderException && truncated.Store.ModelCalls.Single().Status == "truncated", "length finish rejected with billed usage");
var unknown = await Run(Stream(usage: false));
Check(unknown.Error is null && unknown.Store.ModelCalls.Single().Cost is null, "missing usage remains unknown rather than free");
var cancelled = await Run(Stream(), cancel: true);
Check(cancelled.Error is OperationCanceledException && cancelled.Store.ModelCalls.Count() == 1, "cancellation remains cancellation and records one call");
var fallback = await Run(JsonSerializer.Serialize(new { id = "fallback", choices = new[] { new { message = new { content = "Completed JSON fallback" }, finish_reason = "stop" } }, usage = new { prompt_tokens = 10, completion_tokens = 5 } }), "application/json");
Check(fallback.Error is null && fallback.Text == "Completed JSON fallback", "non-streaming compatible provider fallback remains valid");
var oversized = await Run(": " + new string('x', 140000) + "\n\n");
Check(oversized.Error is ProviderException && oversized.Store.ModelCalls.Count() == 1, "oversize SSE frame rejected and metered once");
var malformed = await Run("data: {\"choices\":[{\"index\":null}]}\n\n");
Check(malformed.Error is ProviderException && malformed.Store.ModelCalls.Count() == 1, "malformed SSE shape fails as a provider error");
Check(AdvisorAssessment.PreviewText("Hello [sta") == "Hello ", "partial control tag suppressed");
Check(AdvisorAssessment.PreviewText("Hello [stance: Agrees]") == "Hello ", "complete control tag suppressed");
Console.WriteLine($"Streaming contract: {passed} passed");

sealed class Handler(Func<HttpRequestMessage, Task<HttpResponseMessage>> handler) : HttpMessageHandler
{
  protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) => handler(request);
}
