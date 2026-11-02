using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using SimCEO.Api.Data;

namespace SimCEO.Api.Work;

// Live Meta Model API gateway (https://dev.meta.ai/docs). Shapes verified
// against the official docs: chat completions (OpenAI-compatible), Responses
// API + web_search grounding, /asr/transcribe multipart, /images/generations.
// Every call records model, purpose, real token counts, latency, computed
// cost, and whether search ran. Without META_API_KEY, calls fail fast with
// 503 instead of pretending.
public sealed record ModelCall(
  Guid Id, string Model, string Purpose, int InputTokens, int OutputTokens,
  long LatencyMs, bool RanSearch, string? SearchNote, DateTime At);

public sealed class ProviderNotConfiguredException()
  : Exception("Model provider not configured: set META_API_KEY.");

public sealed class ProviderException(int status, string body)
  : Exception($"Provider error {status}: {body}")
{
  public int Status { get; } = status;
  public string Body { get; } = body;
}

public sealed class CapExceededException(decimal cap, decimal spent)
  : Exception($"Monthly spend cap ${cap} reached (known spend ${spent}).")
{
  public decimal Cap { get; } = cap;
  public decimal Spent { get; } = spent;
}

public sealed class ModelGateway
{
  private readonly InMemoryStore _store;
  private static readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(180) };

  public ModelGateway(InMemoryStore store) => _store = store;

  private static string Base =>
    Environment.GetEnvironmentVariable("META_API_BASE") is { Length: > 0 } b
      ? b.Trim().TrimEnd('/') : "https://api.meta.ai/v1";

  private string EffectiveKey =>
    !string.IsNullOrWhiteSpace(_store.ModelApiKeyOverride) ? _store.ModelApiKeyOverride
    : Environment.GetEnvironmentVariable("META_API_KEY") ?? string.Empty;

  public void EnsureAvailable()
  {
    if (string.IsNullOrWhiteSpace(EffectiveKey)) throw new ProviderNotConfiguredException();
  }

  public static (decimal known, int unknownCalls) MonthSpend(InMemoryStore store)
  {
    var now = DateTime.UtcNow;
    var rows = store.Usage.Where(u => u.At.Year == now.Year && u.At.Month == now.Month).ToList();
    return (rows.Where(u => u.Cost.HasValue).Sum(u => u.Cost!.Value),
      rows.Count(u => !u.Cost.HasValue));
  }

  public void ThrowIfCapped(bool ownerOverride)
  {
    if (ownerOverride) return;
    if (_store.Spend.Mode != "block" || _store.Spend.MonthlyCapUsd is not decimal cap) return;
    var (known, _) = MonthSpend(_store);
    if (known >= cap) throw new CapExceededException(cap, known);
  }

  private static string Truncate(string s, int maxChars) =>
    s.Length <= maxChars ? s : s[..maxChars];

  private static decimal TokenCost(string model, int inTok, int outTok)
  {
    var p = ModelPolicy.PriceFor(model);
    return inTok / 1_000_000m * p.InPerM + outTok / 1_000_000m * p.OutPerM;
  }

  private void Record(string model, string purpose, int inTok, int outTok, long ms,
    bool ranSearch, string? note, decimal? cost, Guid? boardId = null, Guid? meetingId = null)
  {
    _store.ModelCalls.Add(new ModelCall(Guid.NewGuid(), model, purpose, inTok, outTok, ms, ranSearch, note, DateTime.UtcNow));
    _store.Usage.Add(new Domain.UsageRow
    {
      Kind = purpose, Model = model, InputTokens = inTok, Cost = cost,
      BoardId = boardId, MeetingId = meetingId, At = DateTime.UtcNow,
      Note = note ?? "",
    });
  }

  private async Task<JsonDocument> PostJson(string path, object body, CancellationToken ct)
  {
    using var req = new HttpRequestMessage(HttpMethod.Post, $"{Base}{path}");
    req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", EffectiveKey);
    req.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
    using var res = await _http.SendAsync(req, ct);
    var text = await res.Content.ReadAsStringAsync(ct);
    if (!res.IsSuccessStatusCode)
      throw new ProviderException((int)res.StatusCode, text.Length > 500 ? text[..500] : text);
    return JsonDocument.Parse(text);
  }

  public async Task<string> CompleteAsync(string model, string purpose, string prompt,
    int inputBudget, int outputBudget, CancellationToken ct = default, bool ownerOverride = false,
    Guid? boardId = null, Guid? meetingId = null)
  {
    ThrowIfCapped(ownerOverride);
    EnsureAvailable();
    var sw = System.Diagnostics.Stopwatch.StartNew();
    using var doc = await PostJson("/chat/completions", new
    {
      model,
      messages = new[] { new { role = "user", content = Truncate(prompt, inputBudget * 4) } },
      max_tokens = Math.Clamp(outputBudget, 16, 16000),
      stream = false,
    }, ct);
    sw.Stop();
    var root = doc.RootElement;
    var text = root.GetProperty("choices")[0].GetProperty("message").GetProperty("content").GetString() ?? "";
    var usage = root.GetProperty("usage");
    var inTok = usage.GetProperty("prompt_tokens").GetInt32();
    var outTok = usage.GetProperty("completion_tokens").GetInt32();
    var id = root.TryGetProperty("id", out var rid) ? rid.GetString() : null;
    var cost = TokenCost(model, inTok, outTok);
    Record(model, purpose, inTok, outTok, sw.ElapsedMilliseconds, false,
      $"response {id}; cost ${cost:F6}", cost, boardId, meetingId);
    return text;
  }

  public sealed record Citation(string Url, string Title, string Excerpt);
  public sealed record GroundedResult(string Text, bool RanSearch, string? ResponseId,
    List<Citation> Citations, int InTokens, int OutTokens, int SearchCalls, decimal Cost);

  public async Task<GroundedResult> CompleteGroundedAsync(string model, string purpose, string prompt,
    int inputBudget, int outputBudget, CancellationToken ct = default, bool ownerOverride = false,
    Guid? boardId = null, Guid? meetingId = null)
  {
    ThrowIfCapped(ownerOverride);
    EnsureAvailable();
    var sw = System.Diagnostics.Stopwatch.StartNew();
    using var doc = await PostJson("/responses", new
    {
      model,
      input = Truncate(prompt, inputBudget * 4),
      tools = new[] { new { type = "web_search" } },
      include = new[] { "web_search_call.results" },
      max_output_tokens = Math.Clamp(outputBudget, 16, 16000),
    }, ct);
    sw.Stop();
    var root = doc.RootElement;
    var text = new StringBuilder();
    var citations = new List<Citation>();
    var searches = 0;
    string? responseId = root.TryGetProperty("id", out var rid) ? rid.GetString() : null;
    foreach (var item in root.GetProperty("output").EnumerateArray())
    {
      var type = item.TryGetProperty("type", out var t) ? t.GetString() : "";
      if (type == "web_search_call")
      {
        searches++;
        if (item.TryGetProperty("results", out var res) && res.ValueKind == JsonValueKind.Array)
          foreach (var hit in res.EnumerateArray())
            citations.Add(new Citation(
              hit.TryGetProperty("url", out var u) ? u.GetString() ?? "" : "",
              hit.TryGetProperty("title", out var ti) ? ti.GetString() ?? "" : "",
              hit.TryGetProperty("snippet", out var sn) ? sn.GetString() ?? ""
                : hit.TryGetProperty("text", out var tx) ? tx.GetString() ?? "" : ""));
      }
      else if (type == "message")
      {
        foreach (var part in item.GetProperty("content").EnumerateArray())
        {
          if (part.TryGetProperty("text", out var tx)) text.Append(tx.GetString());
          if (part.TryGetProperty("annotations", out var an) && an.ValueKind == JsonValueKind.Array)
            foreach (var a in an.EnumerateArray())
              if (a.TryGetProperty("type", out var at) && at.GetString() == "url_citation")
                citations.Add(new Citation(
                  a.TryGetProperty("url", out var u) ? u.GetString() ?? "" : "",
                  a.TryGetProperty("title", out var ti) ? ti.GetString() ?? "" : "", ""));
        }
      }
    }
    var usage = root.GetProperty("usage");
    var inTok = usage.GetProperty("input_tokens").GetInt32();
    var outTok = usage.GetProperty("output_tokens").GetInt32();
    var searchCost = searches / 1000m * ModelPolicy.SearchPer1k;
    var cost = TokenCost(model, inTok, outTok) + searchCost;
    var note = $"response {responseId}; searches {searches} (~${searchCost:F4}); cost ${cost:F6}";
    Record(model, purpose, inTok, outTok, sw.ElapsedMilliseconds, searches > 0, note, cost, boardId, meetingId);
    return new GroundedResult(text.ToString(), searches > 0, responseId, citations, inTok, outTok, searches, cost);
  }

  public async Task<(string transcript, decimal cost)> TranscribeAsync(
    byte[] audio, string contentType, string fileName,
    CancellationToken ct = default, bool ownerOverride = false,
    Guid? boardId = null, Guid? meetingId = null)
  {
    ThrowIfCapped(ownerOverride);
    EnsureAvailable();
    var sw = System.Diagnostics.Stopwatch.StartNew();
    using var form = new MultipartFormDataContent();
    var requestJson = JsonSerializer.Serialize(new
    {
      model = ModelPolicy.Voice,
      audioEncoding = contentType.Contains("wav", StringComparison.OrdinalIgnoreCase) ? "WAV" : "AUTO",
    });
    form.Add(new StringContent(requestJson, Encoding.UTF8, "application/json"), "request");
    var bytes = new ByteArrayContent(audio);
    bytes.Headers.ContentType = new MediaTypeHeaderValue(
      contentType.Split(';')[0].Trim() is { Length: > 0 } ct2 ? ct2 : "application/octet-stream");
    form.Add(bytes, "audio", fileName);
    using var req = new HttpRequestMessage(HttpMethod.Post, $"{Base}/asr/transcribe");
    req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", EffectiveKey);
    req.Content = form;
    using var res = await _http.SendAsync(req, ct);
    var text = await res.Content.ReadAsStringAsync(ct);
    if (!res.IsSuccessStatusCode)
      throw new ProviderException((int)res.StatusCode, text.Length > 500 ? text[..500] : text);
    sw.Stop();
    using var doc = JsonDocument.Parse(text);
    var transcript = doc.RootElement.TryGetProperty("transcript", out var t) ? t.GetString() ?? "" : "";
    if (string.IsNullOrWhiteSpace(transcript) && doc.RootElement.TryGetProperty("turns", out var turns))
      transcript = string.Join(" ", turns.EnumerateArray()
        .Select(x => x.TryGetProperty("transcript", out var tt) ? tt.GetString() ?? "" : "")
        .Where(x => x != ""));
    var seconds = 0;
    if (doc.RootElement.TryGetProperty("audioProcessedMs", out var ms) && ms.TryGetInt32(out var msv))
      seconds = msv / 1000;
    var cost = seconds / 3600m * ModelPolicy.VoicePerHour;
    Record(ModelPolicy.Voice, "voice-transcribe", 0, 0, sw.ElapsedMilliseconds, false,
      $"{seconds}s audio; cost ${cost:F6}", cost, boardId, meetingId);
    return (transcript, cost);
  }

  public async Task<List<byte[]>> GenerateImagesAsync(string prompt, int n,
    CancellationToken ct = default, bool ownerOverride = false,
    Guid? boardId = null, Guid? meetingId = null)
  {
    ThrowIfCapped(ownerOverride);
    EnsureAvailable();
    var sw = System.Diagnostics.Stopwatch.StartNew();
    using var doc = await PostJson("/images/generations", new
    {
      model = ModelPolicy.Image,
      prompt = Truncate(prompt, 4000),
      n = Math.Clamp(n, 1, 4),
      response_format = "b64_json",
    }, ct);
    sw.Stop();
    var images = new List<byte[]>();
    foreach (var item in doc.RootElement.GetProperty("data").EnumerateArray())
      if (item.TryGetProperty("b64_json", out var b) && b.GetString() is { } s)
        try { images.Add(Convert.FromBase64String(s)); } catch (FormatException) { }
    var cost = images.Count * ModelPolicy.ImagePerImage;
    Record(ModelPolicy.Image, "image-generate", 0, 0, sw.ElapsedMilliseconds, false,
      $"{images.Count} images; cost ${cost:F2}", cost, boardId, meetingId);
    return images;
  }
}
