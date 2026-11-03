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
  private readonly PublicEvidenceFetcher _evidence;

  public ModelGateway(InMemoryStore store)
  {
    _store = store;
    _evidence = new PublicEvidenceFetcher();
  }

  public ModelGateway(InMemoryStore store, PublicEvidenceFetcher evidence)
  {
    _store = store;
    _evidence = evidence;
  }

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

  // Bounded reasoning: thinking tokens count against the output budget
  // (reasoning effort minimal/low/medium/high; max_completion_tokens includes
  // reasoning). Simple classification (model-test, bid) uses minimal;
  // interview, research, drafts and chat use low. No unbounded effort and no
  // automatic infinite retry.
  private static string ReasoningEffortFor(string purpose) => purpose switch
  {
    "model-test" => "minimal",
    "advisor-bid" => "minimal",
    _ => "low",
  };

  // Sufficient output room: reasoning + final answer must fit in one call.
  // Minimal tasks need at least 512 total tokens (16-token probes starve
  // reasoning and yield null/empty content with finish length). Low tasks
  // need at least 2048. Callers keep their own limits; this only enforces a
  // floor so bounded effort still leaves room for the final answer.
  private static int EnsureOutputBudget(string purpose, int requested)
  {
    var floor = ReasoningEffortFor(purpose) == "minimal" ? 512 : 2048;
    return Math.Clamp(Math.Max(requested, floor), 16, 16000);
  }

  // Developer instructions (preferred role per chat-completions protocol).
  // Final-format guidance only; caller prompts keep their own limits and
  // model-privacy wording.
  private static string DeveloperInstructionFor(string purpose) => purpose switch
  {
    "model-test" => "Reply with exactly: OK. No other text.",
    "advisor-bid" => "Reply with exactly YES or NO, then one line why. This is a relevance/contribution bid, not the business answer and not approval. Evaluate YOUR ROLE against the provided question/context. Bid YES if you can offer a useful within-role contribution (including clearly labeled general tradeoffs/assumptions). Bid NO if irrelevant or required specific facts are missing. Do not answer the business question yet. Do not fabricate evidence/credentials. No other text.",
    "wizard-guide" => "Reply with JSON only, no other text.",
    "wizard-interview" => "Reply with JSON only, no other text.",
    "advisor-profile" => "Reply with a single JSON object only, no code fences or commentary.",
    "advisor-reply" => "If you add nothing, reply with exactly ABSTAIN.",
    "advisor-research" => "Return concise factual claims only, one per line, as the final answer. Do not reply with progress commentary.",
    _ => "Return only the requested final answer. No progress commentary.",
  };

  private static bool TryReadUsage(JsonElement root, out int inTok, out int outTok)
  {
    inTok = 0; outTok = 0;
    try
    {
      if (!root.TryGetProperty("usage", out var u) || u.ValueKind != JsonValueKind.Object) return false;
      if (u.TryGetProperty("prompt_tokens", out var pt) && pt.ValueKind == JsonValueKind.Number && pt.TryGetInt32(out var pi)) inTok = pi;
      else if (u.TryGetProperty("input_tokens", out var it) && it.ValueKind == JsonValueKind.Number && it.TryGetInt32(out var ii)) inTok = ii;
      else return false;
      if (u.TryGetProperty("completion_tokens", out var c2) && c2.ValueKind == JsonValueKind.Number && c2.TryGetInt32(out var co)) outTok = co;
      else if (u.TryGetProperty("output_tokens", out var ot) && ot.ValueKind == JsonValueKind.Number && ot.TryGetInt32(out var oo)) outTok = oo;
      else return false;
      return true;
    }
    catch { return false; }
  }

  // Actual extracted excerpt per search-grounding protocol:
  // web_search_call.results supplies SNIPPET. Accept observed casings plus
  // legacy text/content keys; never return model prose as an excerpt.
  private static string GetSearchSnippet(JsonElement hit)
  {
    foreach (var key in new[] { "snippet", "SNIPPET", "Snippet", "text", "content", "excerpt" })
    {
      try
      {
        if (hit.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String)
        {
          var s = v.GetString() ?? "";
          if (!string.IsNullOrWhiteSpace(s)) return s;
        }
      }
      catch { }
    }
    return "";
  }

  private static string GetStr(JsonElement el, string name)
  {
    try { return el.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : ""; }
    catch { return ""; }
  }

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
    try { return JsonDocument.Parse(text); }
    catch (JsonException ex) { throw new ProviderException(502, "malformed provider JSON: " + ex.Message); }
  }

  public async Task<string> CompleteAsync(string model, string purpose, string prompt,
    int inputBudget, int outputBudget, CancellationToken ct = default, bool ownerOverride = false,
    Guid? boardId = null, Guid? meetingId = null, bool truncatePrompt = true)
  {
    ThrowIfCapped(ownerOverride);
    EnsureAvailable();
    var effort = ReasoningEffortFor(purpose);
    var ensured = EnsureOutputBudget(purpose, outputBudget);
    var dev = DeveloperInstructionFor(purpose);
    var sw = System.Diagnostics.Stopwatch.StartNew();
    JsonDocument doc;
    try
    {
      doc = await PostJson("/chat/completions", new
      {
        model,
        messages = new object[]
        {
          new { role = "developer", content = dev },
          new { role = "user", content = truncatePrompt ? Truncate(prompt, inputBudget * 4) : (prompt.Length <= inputBudget * 4 ? prompt : throw new ProviderException(502, "Secretary prompt exceeds budget; essential context cannot fit.")) },
        },
        max_completion_tokens = Math.Clamp(ensured, 16, 16000),
        reasoning_effort = effort,
        stream = false,
      }, ct);
    }
    catch (ProviderException) { throw; }
    catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
    {
      throw new ProviderException(502, "provider transport failure: " + ex.GetType().Name);
    }
    using (doc)
    {
      sw.Stop();
      var root = doc.RootElement;
      var hasUsage = TryReadUsage(root, out var uIn, out var uOut);
      void MeterTruncated(string note)
      {
        if (hasUsage)
        {
          var tc = TokenCost(model, uIn, uOut);
          Record(model, purpose, uIn, uOut, sw.ElapsedMilliseconds, false,
            note + " (input " + uIn + ", output " + uOut + "; cost $" + tc.ToString("F6") + ")", tc, boardId, meetingId);
        }
      }
      try
      {
        if (!root.TryGetProperty("choices", out var choices) || choices.ValueKind != JsonValueKind.Array || choices.GetArrayLength() == 0)
        {
          MeterTruncated("malformed provider envelope: choices array empty or missing");
          throw new ProviderException(502, "malformed provider envelope: choices array empty or missing");
        }
        var first = choices[0];
        if (first.ValueKind != JsonValueKind.Object || !first.TryGetProperty("message", out var msg) || msg.ValueKind != JsonValueKind.Object)
        {
          MeterTruncated("malformed provider envelope: message missing");
          throw new ProviderException(502, "malformed provider envelope: message missing");
        }
        var finish = first.TryGetProperty("finish_reason", out var fr) && fr.ValueKind == JsonValueKind.String
          ? (fr.GetString() ?? "") : "";
        if (!string.IsNullOrEmpty(finish) && !string.Equals(finish, "stop", StringComparison.OrdinalIgnoreCase))
        {
          MeterTruncated("malformed provider envelope: non-completed finish_reason=" + finish);
          throw new ProviderException(502, "malformed provider envelope: non-completed finish_reason=" + finish);
        }
        if (!msg.TryGetProperty("content", out var contentEl) || contentEl.ValueKind != JsonValueKind.String)
        {
          MeterTruncated("malformed provider envelope: content missing");
          throw new ProviderException(502, "malformed provider envelope: content missing");
        }
        var text = contentEl.GetString() ?? "";
        if (string.IsNullOrWhiteSpace(text))
        {
          MeterTruncated("malformed provider envelope: content empty");
          throw new ProviderException(502, "malformed provider envelope: content empty");
        }
        if (!hasUsage)
          throw new ProviderException(502, "malformed provider envelope: usage missing");
        var id = root.TryGetProperty("id", out var rid) && rid.ValueKind == JsonValueKind.String ? rid.GetString() : null;
        var cost = TokenCost(model, uIn, uOut);
        Record(model, purpose, uIn, uOut, sw.ElapsedMilliseconds, false,
          "response " + id + "; effort " + effort + "; cost $" + cost.ToString("F6"), cost, boardId, meetingId);
        return text;
      }
      catch (ProviderException) { throw; }
      catch (Exception ex) when (ex is JsonException or KeyNotFoundException or InvalidOperationException or FormatException)
      {
        throw new ProviderException(502, "malformed provider envelope: " + ex.GetType().Name);
      }
    }
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
    var effort = ReasoningEffortFor(purpose);
    var ensured = EnsureOutputBudget(purpose, outputBudget);
    var dev = DeveloperInstructionFor(purpose);
    var sw = System.Diagnostics.Stopwatch.StartNew();
    JsonDocument doc;
    try
    {
      doc = await PostJson("/responses", new
      {
        model,
        input = Truncate(prompt, inputBudget * 4),
        instructions = dev,
        tools = new[] { new { type = "web_search" } },
        include = new[] { "web_search_call.results" },
        max_output_tokens = Math.Clamp(ensured, 16, 16000),
        reasoning = new { effort },
      }, ct);
    }
    catch (ProviderException) { throw; }
    catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
    {
      throw new ProviderException(502, "provider transport failure: " + ex.GetType().Name);
    }
    using (doc)
    {
      sw.Stop();
      var root = doc.RootElement;
      var hasUsage = TryReadUsage(root, out var uIn, out var uOut);
      void MeterGrounded(string note, int searches)
      {
        if (hasUsage)
        {
          var sc = searches / 1000m * ModelPolicy.SearchPer1k;
          var tc = TokenCost(model, uIn, uOut) + sc;
          Record(model, purpose, uIn, uOut, sw.ElapsedMilliseconds, searches > 0,
            note + " (input " + uIn + ", output " + uOut + "; searches " + searches + "; cost $" + tc.ToString("F6") + ")", tc, boardId, meetingId);
        }
      }
      try
      {
        var status = GetStr(root, "status");
        if (!string.IsNullOrEmpty(status) && !string.Equals(status, "completed", StringComparison.OrdinalIgnoreCase))
        {
          var reason = "";
          try
          {
            if (root.TryGetProperty("incomplete_details", out var inc) && inc.ValueKind == JsonValueKind.Object)
              reason = GetStr(inc, "reason");
          }
          catch { }
          MeterGrounded("non-completed research: status=" + status + " reason=" + reason, 0);
          throw new ProviderException(502, "non-completed research: status=" + status + " reason=" + reason);
        }
        if (!root.TryGetProperty("output", out var output) || output.ValueKind != JsonValueKind.Array)
        {
          MeterGrounded("malformed provider envelope: output missing", 0);
          throw new ProviderException(502, "malformed provider envelope: output missing");
        }
        var text = new StringBuilder();
        var citations = new List<Citation>();
        var searches = 0;
        string? responseId = root.TryGetProperty("id", out var rid) && rid.ValueKind == JsonValueKind.String ? rid.GetString() : null;
        foreach (var item in output.EnumerateArray())
        {
          if (item.ValueKind != JsonValueKind.Object) continue;
          var type = GetStr(item, "type");
          if (string.Equals(type, "web_search_call", StringComparison.Ordinal))
          {
            searches++;
            if (item.TryGetProperty("results", out var res) && res.ValueKind == JsonValueKind.Array)
              foreach (var hit in res.EnumerateArray())
              {
                if (hit.ValueKind != JsonValueKind.Object) continue;
                var u = GetStr(hit, "url");
                if (string.IsNullOrEmpty(u)) u = GetStr(hit, "URL");
                var t = GetStr(hit, "title");
                if (string.IsNullOrEmpty(t)) t = GetStr(hit, "Title");
                citations.Add(new Citation(u, t, GetSearchSnippet(hit)));
              }
          }
          else if (string.Equals(type, "message", StringComparison.Ordinal))
          {
            var phase = GetStr(item, "phase");
            if (!string.IsNullOrEmpty(phase) && !string.Equals(phase, "final_answer", StringComparison.OrdinalIgnoreCase))
              continue;
            if (!item.TryGetProperty("content", out var content) || content.ValueKind != JsonValueKind.Array) continue;
            foreach (var part in content.EnumerateArray())
            {
              if (part.ValueKind != JsonValueKind.Object) continue;
              if (part.TryGetProperty("text", out var tx))
              {
                if (tx.ValueKind == JsonValueKind.String)
                  text.Append(tx.GetString());
                else if (tx.ValueKind == JsonValueKind.Object)
                {
                  var nested = GetStr(tx, "text");
                  if (string.IsNullOrEmpty(nested)) nested = GetStr(tx, "value");
                  if (!string.IsNullOrEmpty(nested)) text.Append(nested);
                }
              }
              if (part.TryGetProperty("annotations", out var an) && an.ValueKind == JsonValueKind.Array)
                foreach (var a in an.EnumerateArray())
                {
                  if (a.ValueKind != JsonValueKind.Object) continue;
                  if (!string.Equals(GetStr(a, "type"), "url_citation", StringComparison.Ordinal)) continue;
                  citations.Add(new Citation(GetStr(a, "url"), GetStr(a, "title"), ""));
                }
            }
          }
        }
        if (!hasUsage)
          throw new ProviderException(502, "malformed provider envelope: usage missing");
        var finalText = text.ToString().Trim();
        if (finalText.Length == 0)
        {
          MeterGrounded("non-completed research: progress-only, no final answer", searches);
          throw new ProviderException(502, "non-completed research: progress-only, no final answer");
        }
        try
        {
          var needsHydration = false;
          foreach (var cc in citations)
          {
            var u0 = cc.Url ?? "";
            if (string.IsNullOrWhiteSpace(cc.Excerpt) && (u0.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || u0.StartsWith("https://", StringComparison.OrdinalIgnoreCase))) { needsHydration = true; break; }
          }
          if (needsHydration)
          {
            var hydrated = await _evidence.HydrateAsync(citations, prompt, ct).ConfigureAwait(false);
            citations.Clear();
            citations.AddRange(hydrated);
          }
        }
        catch { }
        var hasEvidence = false;
        foreach (var cc in citations)
        {
          if (!string.IsNullOrWhiteSpace(cc.Url) && !string.IsNullOrWhiteSpace(cc.Excerpt)) { hasEvidence = true; break; }
        }
        var grounded = searches > 0 && finalText.Length > 0 && hasEvidence;
        var searchCost = searches / 1000m * ModelPolicy.SearchPer1k;
        var cost = TokenCost(model, uIn, uOut) + searchCost;
        var excerptCount = 0;
        foreach (var cc in citations) if (!string.IsNullOrWhiteSpace(cc.Excerpt)) excerptCount++;
        var note = "response " + responseId + "; status completed; effort " + effort + "; searches " + searches + " (~$" + searchCost.ToString("F4") + "); excerpts " + excerptCount + "; cost $" + cost.ToString("F6");
        Record(model, purpose, uIn, uOut, sw.ElapsedMilliseconds, searches > 0, note, cost, boardId, meetingId);
        return new GroundedResult(finalText, grounded, responseId, citations, uIn, uOut, searches, cost);
      }
      catch (ProviderException) { throw; }
      catch (Exception ex) when (ex is JsonException or KeyNotFoundException or InvalidOperationException or FormatException)
      {
        throw new ProviderException(502, "malformed provider envelope: " + ex.GetType().Name);
      }
    }
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
