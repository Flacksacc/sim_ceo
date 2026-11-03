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
public sealed class ModelCall
{
  [System.ComponentModel.DataAnnotations.Key] public Guid Id { get; set; } = Guid.NewGuid();
  public string Model { get; set; } = "";
  public string Purpose { get; set; } = "";
  public int InputTokens { get; set; }
  public int OutputTokens { get; set; }
  public int CachedInputTokens { get; set; }
  public long LatencyMs { get; set; }
  public bool RanSearch { get; set; }
  public int SearchCalls { get; set; }
  public string? ProviderCallId { get; set; }
  public string Status { get; set; } = "succeeded";
  public decimal? Cost { get; set; }
  public string? CostBasis { get; set; }
  public Guid? BoardId { get; set; }
  public Guid? MeetingId { get; set; }
  public string? SearchNote { get; set; }
  public DateTime At { get; set; } = DateTime.UtcNow;
}

public sealed class ProviderNotConfiguredException()
  : Exception("Model provider not configured: set META_API_KEY.");

public sealed class ProviderException(int status, string body, string? fullBody = null)
  : Exception($"Provider error {status}: {body}")
{
  public int Status { get; } = status;
  public string Body { get; } = body;
  public string? FullBody { get; } = fullBody ?? body;
}

public sealed class CapExceededException(decimal cap, decimal spent)
  : Exception($"Monthly spend cap ${cap} reached (known spend ${spent}).")
{
  public decimal Cap { get; } = cap;
  public decimal Spent { get; } = spent;
}
public sealed class UsageStorageException(string message, Exception? inner = null)
  : Exception(message, inner);


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
    var ok = UsagePricing.TryReadUsage(root, out inTok, out int cached, out outTok);
    return ok;
  }

  private static bool TryReadUsageCached(JsonElement root, out int inTok, out int cachedTok, out int outTok)
  {
    return UsagePricing.TryReadUsage(root, out inTok, out cachedTok, out outTok);
  }

  private static string FormatCost(decimal? cost)
  {
    return cost.HasValue ? cost.Value.ToString("F6") : "unknown";
  }

  // ONE ledger + ONE usage event per ACTUAL provider call. Callers pass a
  // fresh callId per HTTP attempt (each retry is its own billed call).
  // Never stores prompts, responses, keys, or chain-of-thought: only safe
  // ids, status, token counts, cost basis, and redacted classification.
  private void RecordFull(Guid callId, string model, string purpose,
    int inTok, int cachedTok, int outTok, long ms, bool ranSearch, int searchCalls,
    string status, string? providerCallId, decimal? cost, string? costBasis,
    string note, Guid? boardId, Guid? meetingId)
  {
    Guid? b = boardId; Guid? m = meetingId;
    try
    {
      if (m.HasValue && _store.Meetings.TryGetValue(m.Value, out var mtg))
      {
        if (!b.HasValue) b = mtg.BoardId;
      }
    }
    catch { }
    var at = DateTime.UtcNow;
    var call = new ModelCall
    {
      Id = callId, Model = model, Purpose = purpose,
      InputTokens = inTok, OutputTokens = outTok, CachedInputTokens = cachedTok,
      LatencyMs = ms, RanSearch = ranSearch, SearchCalls = searchCalls,
      ProviderCallId = providerCallId, Status = status, Cost = cost, CostBasis = costBasis,
      BoardId = b, MeetingId = m, SearchNote = note, At = at,
    };
    var row = new Domain.UsageRow
    {
      Id = callId, Kind = purpose, Model = model,
      InputTokens = inTok, OutputTokens = outTok, CachedInputTokens = cachedTok,
      SearchCalls = searchCalls, LatencyMs = ms, RanSearch = ranSearch,
      Status = status, ProviderCallId = providerCallId, CostBasis = costBasis, Cost = cost,
      BoardId = b, MeetingId = m, At = at, Note = note,
    };
    try
    {
      Atomic.Run(() =>
      {
        _store.ModelCalls.Add(call);
        _store.Usage.Add(row);
      });
    }
    catch (Exception ex)
    {
      throw new UsageStorageException("usage ledger append failed; provider result not recorded", ex);
    }
  }

  // Pre-dispatch cancellation boundary: a token cancelled before any HTTP
  // attempt produces zero usage/ledger events. Cancellations after dispatch
  // are recorded as failed attempts handed to the transport.
  private static void ThrowIfPrecancelled(CancellationToken ct)
  {
    if (ct.IsCancellationRequested) throw new OperationCanceledException(ct);
  }

  // Safely extract observable billing metadata (usage tokens + provider
  // response id + observable search calls) from an HTTP-error body.
  // Never persists error text, prompts, or response content: numbers and id only.
  // Provider id is extracted independently of usage so an id-only error still
  // preserves observable identity with unknown cost. Search calls are counted
  // from an observable output array when present; callers decide how an
  // unobservable search component affects TOTAL honesty.
  private static bool TryParseErrorBilling(string body, out int inTok, out int cachedTok, out int outTok, out string? pid)
  {
    return TryParseErrorBillingFull(body, out inTok, out cachedTok, out outTok, out pid, out _);
  }
  private static bool TryParseErrorBillingFull(string body, out int inTok, out int cachedTok, out int outTok, out string? pid, out int searchCalls)
  {
    inTok = 0; cachedTok = 0; outTok = 0; pid = null; searchCalls = -1;
    try
    {
      using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(body) ? "{}" : body);
      var root = doc.RootElement;
      if (root.ValueKind != JsonValueKind.Object) return false;
      try { if (root.TryGetProperty("id", out var rid) && rid.ValueKind == JsonValueKind.String) pid = rid.GetString(); } catch { pid = null; }
      try { searchCalls = CountErrorSearches(root); } catch { searchCalls = -1; }
      if (!UsagePricing.TryReadUsage(root, out inTok, out cachedTok, out outTok)) return false;
      return true;
    }
    catch { return false; }
  }
  // Verifiable supported raster: PNG / JPEG / WebP magic only, minimal bound.
  // Nonempty base64 that decodes to other bytes (e.g. "hello") is NOT an image.
  private static bool IsVerifiableImage(byte[] bytes)
  {
    try
    {
      if (bytes == null || bytes.Length < 12) return false;
      // PNG: 89 50 4E 47 0D 0A 1A 0A
      if (bytes.Length >= 8 && bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4E && bytes[3] == 0x47
        && bytes[4] == 0x0D && bytes[5] == 0x0A && bytes[6] == 0x1A && bytes[7] == 0x0A) return true;
      // JPEG: FF D8 FF
      if (bytes.Length >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF) return true;
      // WebP: RIFF....WEBP
      if (bytes.Length >= 12 && bytes[0] == 0x52 && bytes[1] == 0x49 && bytes[2] == 0x46 && bytes[3] == 0x46
        && bytes[8] == 0x57 && bytes[9] == 0x45 && bytes[10] == 0x42 && bytes[11] == 0x50) return true;
      return false;
    }
    catch { return false; }
  }
  private static bool IsValidProviderUrl(string s)
  {
    try
    {
      if (string.IsNullOrWhiteSpace(s)) return false;
      if (!Uri.TryCreate(s.Trim(), UriKind.Absolute, out var uri)) return false;
      if (!string.Equals(uri.Scheme, "http", StringComparison.OrdinalIgnoreCase)
        && !string.Equals(uri.Scheme, "https", StringComparison.OrdinalIgnoreCase)) return false;
      if (string.IsNullOrWhiteSpace(uri.Host)) return false;
      return true;
    }
    catch { return false; }
  }
  // Fail-closed search observability: output MUST be a valid complete array.
  // Missing/null/non-array, or any entry that is not an object with a string
  // type, conceals search and yields observable=false (TOTAL null). An
  // explicit valid empty array proves 0 searches (observable=true, 0).
  private static bool TryGetSearchObservability(JsonElement root, out int searchCalls)
  {
    searchCalls = 0;
    try
    {
      if (!root.TryGetProperty("output", out var outputEl)) return false;
      if (outputEl.ValueKind == JsonValueKind.Null) return false;
      if (outputEl.ValueKind != JsonValueKind.Array) return false;
      var n = 0;
      foreach (var item in outputEl.EnumerateArray())
      {
        if (item.ValueKind != JsonValueKind.Object) return false;
        string? itype = null;
        try
        {
          if (!item.TryGetProperty("type", out var tv) || tv.ValueKind != JsonValueKind.String) return false;
          itype = tv.GetString();
        }
        catch { return false; }
        if (string.Equals(itype, "web_search_call", StringComparison.Ordinal)) n++;
      }
      searchCalls = n;
      return true;
    }
    catch { searchCalls = 0; return false; }
  }
  private static int CountErrorSearches(JsonElement root)
  {
    return TryGetSearchObservability(root, out var n) ? n : -1;
  }
  private static string? TryExtractProviderId(string body)
  {
    try
    {
      using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(body) ? "{}" : body);
      var root = doc.RootElement;
      if (root.ValueKind != JsonValueKind.Object) return null;
      if (root.TryGetProperty("id", out var rid) && rid.ValueKind == JsonValueKind.String) return rid.GetString();
      return null;
    }
    catch { return null; }
  }

  private void Record(string model, string purpose, int inTok, int outTok, long ms,
    bool ranSearch, string? note, decimal? cost, Guid? boardId = null, Guid? meetingId = null)
  {
    RecordFull(Guid.NewGuid(), model, purpose, inTok, 0, outTok, ms, ranSearch, 0,
      cost.HasValue ? "succeeded" : "unknown", null, cost, UsageAccounting.BasisTokens,
      note ?? "", boardId, meetingId);
  }

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

  private const int BodyBoundBytes = 131072;
  private static string RedactedError(int status) =>
    $"provider HTTP {status}; billing preserved in ledger; no upstream content retained";
  // Bounded transport read: headers first, then stream up to BodyBoundBytes
  // under deadline/cancellation. Never buffers unbounded body then truncates.
  // Parses billing metadata from the bounded bytes BEFORE emitting the
  // classified redacted outward error. Oversized reads stop at the bound and
  // record one unknown pair with a safe error.
  private async Task<(string boundedBody, bool oversized)> ReadBoundedBodyAsync(HttpResponseMessage res, CancellationToken ct)
  {
    using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
    cts.CancelAfter(TimeSpan.FromSeconds(60));
    var token = cts.Token;
    try
    {
      using var stream = await res.Content.ReadAsStreamAsync(token).ConfigureAwait(false);
      var buf = new byte[8192];
      using var ms = new MemoryStream();
      int read;
      while ((read = await stream.ReadAsync(buf, 0, buf.Length, token).ConfigureAwait(false)) > 0)
      {
        if (ms.Length + read > BodyBoundBytes)
        {
          var room = BodyBoundBytes - (int)ms.Length;
          if (room > 0) ms.Write(buf, 0, room);
          try { res.Content.LoadIntoBufferAsync().ConfigureAwait(false); } catch { }
          return (Encoding.UTF8.GetString(ms.ToArray()), true);
        }
        ms.Write(buf, 0, read);
      }
      return (Encoding.UTF8.GetString(ms.ToArray()), false);
    }
    catch (OperationCanceledException) { throw; }
    catch (Exception ex) { throw new ProviderException(502, "provider transport failure: " + ex.GetType().Name); }
  }
  private async Task<JsonDocument> PostJson(string path, object body, CancellationToken ct)
  {
    using var req = new HttpRequestMessage(HttpMethod.Post, $"{Base}{path}");
    req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", EffectiveKey);
    req.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
    using var res = await _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
    var (bounded, oversized) = await ReadBoundedBodyAsync(res, ct).ConfigureAwait(false);
    if (oversized)
      throw new ProviderException((int)res.StatusCode, RedactedError((int)res.StatusCode) + "; oversized body truncated at bound", bounded);
    if (!res.IsSuccessStatusCode)
      throw new ProviderException((int)res.StatusCode, RedactedError((int)res.StatusCode), bounded);
    try { return JsonDocument.Parse(string.IsNullOrWhiteSpace(bounded) ? "{}" : bounded); }
    catch (JsonException) { throw new ProviderException(502, RedactedError(502), bounded); }
  }

  public async Task<string> CompleteAsync(string model, string purpose, string prompt,
    int inputBudget, int outputBudget, CancellationToken ct = default, bool ownerOverride = false,
    Guid? boardId = null, Guid? meetingId = null)
  {
    ThrowIfCapped(ownerOverride);
    EnsureAvailable();
    ThrowIfPrecancelled(ct);
    var effort = ReasoningEffortFor(purpose);
    var ensured = EnsureOutputBudget(purpose, outputBudget);
    var dev = DeveloperInstructionFor(purpose);
    var callId = Guid.NewGuid();
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
          new { role = "user", content = Truncate(prompt, inputBudget * 4) },
        },
        max_completion_tokens = Math.Clamp(ensured, 16, 16000),
        reasoning_effort = effort,
        stream = false,
      }, ct);
    }
    catch (ProviderException pex)
    {
      sw.Stop();
      var knownErr = UsagePricing.PriceForOrNull(model) is not null;
      var basisErr = knownErr ? UsageAccounting.BasisTokens : UsageAccounting.BasisTokens + "; unknown model";
      var fullErr = pex.FullBody ?? pex.Body;
      if (TryParseErrorBillingFull(fullErr, out var eIn, out var eCached, out var eOut, out var ePid, out _))
      {
        var eCost = UsagePricing.ChatCost(model, eIn, eCached, eOut);
        RecordFull(callId, model, purpose, eIn, eCached, eOut, sw.ElapsedMilliseconds, false, 0,
          "failed", ePid, eCost, basisErr,
          "failed: provider HTTP " + pex.Status + "; billed usage preserved", boardId, meetingId);
      }
      else
      {
        var onlyPid = TryExtractProviderId(fullErr);
        RecordFull(callId, model, purpose, 0, 0, 0, sw.ElapsedMilliseconds, false, 0,
          "failed", onlyPid, null, basisErr,
          "failed: provider HTTP " + pex.Status + "; cost unknown", boardId, meetingId);
      }
      throw;
    }
    catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
    {
      sw.Stop();
      RecordFull(callId, model, purpose, 0, 0, 0, sw.ElapsedMilliseconds, false, 0,
        "failed", null, null, UsageAccounting.BasisTokens,
        "failed: provider transport failure after dispatch: " + ex.GetType().Name + "; cost unknown", boardId, meetingId);
      throw new ProviderException(502, "provider transport failure: " + ex.GetType().Name);
    }
    using (doc)
    {
      sw.Stop();
      try
      {
        var root = doc.RootElement;
        var hasUsage = TryReadUsageCached(root, out var uIn, out var uCached, out var uOut);
        string? pid = null;
        try { if (root.TryGetProperty("id", out var rid) && rid.ValueKind == JsonValueKind.String) pid = rid.GetString(); } catch { }
        var knownModel = UsagePricing.PriceForOrNull(model) is not null;
        var basis = knownModel ? UsageAccounting.BasisTokens : UsageAccounting.BasisTokens + "; unknown model";
        if (!root.TryGetProperty("choices", out var choices) || choices.ValueKind != JsonValueKind.Array || choices.GetArrayLength() == 0)
        {
          if (hasUsage)
          {
            var c0 = UsagePricing.ChatCost(model, uIn, uCached, uOut);
            RecordFull(callId, model, purpose, uIn, uCached, uOut, sw.ElapsedMilliseconds, false, 0,
              "truncated", pid, c0, basis,
              "truncated: choices array empty or missing", boardId, meetingId);
          }
          else
          {
            RecordFull(callId, model, purpose, 0, 0, 0, sw.ElapsedMilliseconds, false, 0,
              "unknown", pid, null, basis,
              "unknown: choices missing; usage missing; cost unknown", boardId, meetingId);
          }
          throw new ProviderException(502, RedactedError(502));
        }
        var first = choices[0];
        if (first.ValueKind != JsonValueKind.Object || !first.TryGetProperty("message", out var msg) || msg.ValueKind != JsonValueKind.Object)
        {
          if (hasUsage)
          {
            var c1 = UsagePricing.ChatCost(model, uIn, uCached, uOut);
            RecordFull(callId, model, purpose, uIn, uCached, uOut, sw.ElapsedMilliseconds, false, 0,
              "truncated", pid, c1, basis,
              "truncated: message missing", boardId, meetingId);
          }
          else
          {
            RecordFull(callId, model, purpose, 0, 0, 0, sw.ElapsedMilliseconds, false, 0,
              "unknown", pid, null, basis,
              "unknown: message missing; usage missing", boardId, meetingId);
          }
          throw new ProviderException(502, RedactedError(502));
        }
        var finish = first.TryGetProperty("finish_reason", out var fr) && fr.ValueKind == JsonValueKind.String ? (fr.GetString() ?? "") : "";
        if (!string.IsNullOrEmpty(finish) && !string.Equals(finish, "stop", StringComparison.OrdinalIgnoreCase))
        {
          if (hasUsage)
          {
            var c2 = UsagePricing.ChatCost(model, uIn, uCached, uOut);
            RecordFull(callId, model, purpose, uIn, uCached, uOut, sw.ElapsedMilliseconds, false, 0,
              "truncated", pid, c2, basis,
              "truncated: finish_reason=" + finish, boardId, meetingId);
          }
          else
          {
            RecordFull(callId, model, purpose, 0, 0, 0, sw.ElapsedMilliseconds, false, 0,
              "unknown", pid, null, basis,
              "unknown: finish_reason=" + finish + "; usage missing", boardId, meetingId);
          }
          throw new ProviderException(502, RedactedError(502));
        }
        if (!msg.TryGetProperty("content", out var contentEl) || contentEl.ValueKind != JsonValueKind.String)
        {
          if (hasUsage)
          {
            var c3 = UsagePricing.ChatCost(model, uIn, uCached, uOut);
            RecordFull(callId, model, purpose, uIn, uCached, uOut, sw.ElapsedMilliseconds, false, 0,
              "truncated", pid, c3, basis,
              "truncated: content missing", boardId, meetingId);
          }
          else
          {
            RecordFull(callId, model, purpose, 0, 0, 0, sw.ElapsedMilliseconds, false, 0,
              "unknown", pid, null, basis,
              "unknown: content missing; usage missing", boardId, meetingId);
          }
          throw new ProviderException(502, RedactedError(502));
        }
        var text = contentEl.GetString() ?? "";
        if (string.IsNullOrWhiteSpace(text))
        {
          if (hasUsage)
          {
            var c4 = UsagePricing.ChatCost(model, uIn, uCached, uOut);
            RecordFull(callId, model, purpose, uIn, uCached, uOut, sw.ElapsedMilliseconds, false, 0,
              "truncated", pid, c4, basis,
              "truncated: content empty", boardId, meetingId);
          }
          else
          {
            RecordFull(callId, model, purpose, 0, 0, 0, sw.ElapsedMilliseconds, false, 0,
              "unknown", pid, null, basis,
              "unknown: content empty; usage missing", boardId, meetingId);
          }
          throw new ProviderException(502, RedactedError(502));
        }
        if (!hasUsage)
        {
          RecordFull(callId, model, purpose, 0, 0, 0, sw.ElapsedMilliseconds, false, 0,
            "succeeded", pid, null, basis,
            "response " + pid + "; effort " + effort + "; usage invalid/unobservable; cost unknown", boardId, meetingId);
          return text;
        }
        var cost = UsagePricing.ChatCost(model, uIn, uCached, uOut);
        RecordFull(callId, model, purpose, uIn, uCached, uOut, sw.ElapsedMilliseconds, false, 0,
          "succeeded", pid, cost, basis,
          "response " + pid + "; effort " + effort, boardId, meetingId);
        return text;
      }
      catch (ProviderException) { throw; }
      catch (UsageStorageException) { throw; }
      catch (Exception ex) when (ex is JsonException or KeyNotFoundException or InvalidOperationException or FormatException)
      {
        RecordFull(callId, model, purpose, 0, 0, 0, sw.ElapsedMilliseconds, false, 0,
          "unknown", null, null, UsageAccounting.BasisTokens + "; envelope unparseable",
          "unknown: malformed provider envelope (" + ex.GetType().Name + "); cost unknown", boardId, meetingId);
        throw new ProviderException(502, RedactedError(502));
      }
    }
  }

  public sealed record Citation(string Url, string Title, string Excerpt);
  public sealed record GroundedResult(string Text, bool RanSearch, string? ResponseId,
    List<Citation> Citations, int InTokens, int OutTokens, int SearchCalls, decimal? Cost);


  public async Task<GroundedResult> CompleteGroundedAsync(string model, string purpose, string prompt,
    int inputBudget, int outputBudget, CancellationToken ct = default, bool ownerOverride = false,
    Guid? boardId = null, Guid? meetingId = null)
  {
    ThrowIfCapped(ownerOverride);
    EnsureAvailable();
    ThrowIfPrecancelled(ct);
    var effort = ReasoningEffortFor(purpose);
    var ensured = EnsureOutputBudget(purpose, outputBudget);
    var dev = DeveloperInstructionFor(purpose);
    var callId = Guid.NewGuid();
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
    catch (ProviderException pex)
    {
      sw.Stop();
      var knownErr = UsagePricing.PriceForOrNull(model) is not null;
      var basisErr = knownErr ? UsageAccounting.BasisSearch : UsageAccounting.BasisSearch + "; unknown model";
      var fullErr = pex.FullBody ?? "";
      if (TryParseErrorBillingFull(fullErr, out var eIn, out var eCached, out var eOut, out var ePid, out var eSearchesRaw))
      {
        // Unobservable search component => TOTAL null, even with valid tokens.
        // Observable explicit empty array (0) or valid complete array (N) => known.
        var obs = eSearchesRaw >= 0;
        var eSearches = obs ? eSearchesRaw : 0;
        var eRan = obs && eSearches > 0;
        decimal? eCost = obs ? UsagePricing.GroundedCost(model, eIn, eCached, eOut, eSearches) : null;
        RecordFull(callId, model, purpose, eIn, eCached, eOut, sw.ElapsedMilliseconds, eRan, eSearches,
          "failed", ePid, eCost, basisErr,
          "failed: provider HTTP " + pex.Status + "; tokens preserved id " + (ePid ?? "none") + "; searches " + (obs ? eSearches.ToString() : "unobservable") + "; total " + (eCost.HasValue ? "known" : "unknown"), boardId, meetingId);
      }
      else
      {
        var onlyPid = TryExtractProviderId(fullErr);
        int obsRaw = -1;
        try
        {
          using var sdoc = System.Text.Json.JsonDocument.Parse(string.IsNullOrWhiteSpace(fullErr) ? "{}" : fullErr);
          if (sdoc.RootElement.ValueKind == JsonValueKind.Object && TryGetSearchObservability(sdoc.RootElement, out var oc)) obsRaw = oc;
        }
        catch { obsRaw = -1; }
        var obs2 = obsRaw >= 0;
        var ranS = obs2 && obsRaw > 0;
        RecordFull(callId, model, purpose, 0, 0, 0, sw.ElapsedMilliseconds, ranS, obs2 ? obsRaw : 0,
          "failed", onlyPid, null, basisErr,
          "failed: provider HTTP " + pex.Status + "; cost unknown; searches " + (obs2 ? obsRaw.ToString() : "unobservable"), boardId, meetingId);
      }
      throw;
    }
    catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
    {
      sw.Stop();
      RecordFull(callId, model, purpose, 0, 0, 0, sw.ElapsedMilliseconds, false, 0,
        "failed", null, null, UsageAccounting.BasisSearch,
        "failed: provider transport failure after dispatch: " + ex.GetType().Name + "; cost unknown", boardId, meetingId);
      throw new ProviderException(502, "provider transport failure: " + ex.GetType().Name);
    }
    using (doc)
    {
      sw.Stop();
      try
      {
        var root = doc.RootElement;
        var hasUsage = TryReadUsageCached(root, out var uIn, out var uCached, out var uOut);
        string? responseId0 = null;
        try { if (root.TryGetProperty("id", out var rid0) && rid0.ValueKind == JsonValueKind.String) responseId0 = rid0.GetString(); } catch { }
        var knownModel = UsagePricing.PriceForOrNull(model) is not null;
        var basisG = knownModel ? UsageAccounting.BasisSearch : UsageAccounting.BasisSearch + "; unknown model";
        var searches = 0;
        var citations = new List<Citation>();
        var hasOutput = false;
        var searchObservable = false;
        var text = new StringBuilder();
        if (root.TryGetProperty("output", out var outputEl))
        {
          if (outputEl.ValueKind == JsonValueKind.Array)
          {
            hasOutput = true;
            searchObservable = true;
            foreach (var item in outputEl.EnumerateArray())
            {
              if (item.ValueKind != JsonValueKind.Object) { searchObservable = false; continue; }
              string? itype = null;
              try
              {
                if (!item.TryGetProperty("type", out var tvx) || tvx.ValueKind != JsonValueKind.String) { searchObservable = false; continue; }
                itype = tvx.GetString();
              }
              catch { searchObservable = false; continue; }
              var type = itype ?? "";
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
        }
        }
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
          if (hasUsage)
          {
            decimal? cc0 = searchObservable ? UsagePricing.GroundedCost(model, uIn, uCached, uOut, searches) : null;
            var ran0 = searchObservable && searches > 0;
            RecordFull(callId, model, purpose, uIn, uCached, uOut, sw.ElapsedMilliseconds, ran0, searchObservable ? searches : 0,
              "incomplete", responseId0, cc0, basisG,
              "incomplete: status=" + status + " reason=" + reason + "; searches " + (searchObservable ? searches.ToString() : "unobservable") + "; total " + (cc0.HasValue ? "known" : "unknown"), boardId, meetingId);
          }
          else
          {
            var ran0u = searchObservable && searches > 0;
            RecordFull(callId, model, purpose, 0, 0, 0, sw.ElapsedMilliseconds, ran0u, searchObservable ? searches : 0,
              "unknown", responseId0, null, basisG,
              "unknown: status=" + status + "; usage missing; searches " + (searchObservable ? searches.ToString() : "unobservable"), boardId, meetingId);
          }
          throw new ProviderException(502, RedactedError(502));
        }
        if (!hasOutput || !searchObservable)
        {
          if (hasUsage)
          {
            RecordFull(callId, model, purpose, uIn, uCached, uOut, sw.ElapsedMilliseconds, false, 0,
              "truncated", responseId0, null, basisG,
              "truncated: output " + (!hasOutput ? "missing" : "malformed/unobservable") + "; searches unobservable; total unknown", boardId, meetingId);
          }
          else
          {
            RecordFull(callId, model, purpose, 0, 0, 0, sw.ElapsedMilliseconds, false, 0,
              "unknown", responseId0, null, basisG,
              "unknown: output " + (!hasOutput ? "missing" : "malformed/unobservable") + "; usage missing", boardId, meetingId);
          }
          throw new ProviderException(502, RedactedError(502));
        }
        string? responseId = responseId0;
        if (!hasUsage)
        {
          var ranU = searchObservable && searches > 0;
          RecordFull(callId, model, purpose, 0, 0, 0, sw.ElapsedMilliseconds, ranU, searchObservable ? searches : 0,
            "unknown", responseId0, null, basisG,
            "unknown: usage missing; searches " + (searchObservable ? searches.ToString() : "unobservable"), boardId, meetingId);
          throw new ProviderException(502, RedactedError(502));
        }
        var finalText = text.ToString().Trim();
        if (finalText.Length == 0)
        {
          decimal? cc2 = searchObservable ? UsagePricing.GroundedCost(model, uIn, uCached, uOut, searches) : null;
          var ranP = searchObservable && searches > 0;
          RecordFull(callId, model, purpose, uIn, uCached, uOut, sw.ElapsedMilliseconds, ranP, searchObservable ? searches : 0,
            "incomplete", responseId, cc2, basisG,
            "incomplete: progress-only, no final answer; searches " + (searchObservable ? searches.ToString() : "unobservable") + "; total " + (cc2.HasValue ? "known" : "unknown"), boardId, meetingId);
          throw new ProviderException(502, RedactedError(502));
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
        var cost = UsagePricing.GroundedCost(model, uIn, uCached, uOut, searches);
        var excerptCount = 0;
        foreach (var cc in citations) if (!string.IsNullOrWhiteSpace(cc.Excerpt)) excerptCount++;
        var note = "response " + responseId + "; status completed; effort " + effort + "; searches " + searches + "; excerpts " + excerptCount;
        RecordFull(callId, model, purpose, uIn, uCached, uOut, sw.ElapsedMilliseconds, searches > 0, searches,
          "succeeded", responseId, cost, basisG, note, boardId, meetingId);
        return new GroundedResult(finalText, grounded, responseId, citations, uIn, uOut, searches, cost);
      }
      catch (ProviderException) { throw; }
      catch (UsageStorageException) { throw; }
      catch (Exception ex) when (ex is JsonException or KeyNotFoundException or InvalidOperationException or FormatException)
      {
        RecordFull(callId, model, purpose, 0, 0, 0, sw.ElapsedMilliseconds, false, 0,
          "unknown", null, null, UsageAccounting.BasisSearch + "; envelope unparseable",
          "unknown: malformed provider envelope (" + ex.GetType().Name + "); cost unknown", boardId, meetingId);
        throw new ProviderException(502, RedactedError(502));
      }
    }
  }
  public async Task<(string transcript, decimal? cost)> TranscribeAsync(
    byte[] audio, string contentType, string fileName,
    CancellationToken ct = default, bool ownerOverride = false,
    Guid? boardId = null, Guid? meetingId = null)
  {
    ThrowIfCapped(ownerOverride);
    EnsureAvailable();
    ThrowIfPrecancelled(ct);
    var callId = Guid.NewGuid();
    var sw = System.Diagnostics.Stopwatch.StartNew();
    using var form = new MultipartFormDataContent();
    var requestJson = JsonSerializer.Serialize(new
    {
      model = ModelPolicy.Voice,
      audioEncoding = contentType.Contains("wav", StringComparison.OrdinalIgnoreCase) ? "WAV" : "AUTO",
    });
    form.Add(new StringContent(requestJson, Encoding.UTF8, "application/json"), "request");
    var bytes = new ByteArrayContent(audio);
    var ctPart = contentType.Split((char)59)[0].Trim();
    if (string.IsNullOrWhiteSpace(ctPart)) ctPart = "application/octet-stream";
    bytes.Headers.ContentType = new MediaTypeHeaderValue(ctPart);
    form.Add(bytes, "audio", fileName);
    using var req = new HttpRequestMessage(HttpMethod.Post, Base + "/asr/transcribe");
    req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", EffectiveKey);
    req.Content = form;
    HttpResponseMessage? res = null;
    string text = "";
    bool oversized = false;
    try
    {
      res = await _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
      (text, oversized) = await ReadBoundedBodyAsync(res, ct).ConfigureAwait(false);
    }
    catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
    {
      if (res is not null) try { res.Dispose(); } catch { }
      sw.Stop();
      RecordFull(callId, ModelPolicy.Voice, "voice-transcribe", 0, 0, 0, sw.ElapsedMilliseconds, false, 0,
        "failed", null, null, UsageAccounting.BasisVoice,
        "failed: provider transport failure after dispatch: " + ex.GetType().Name + "; cost unknown", boardId, meetingId);
      throw new ProviderException(502, "provider transport failure: " + ex.GetType().Name);
    }
    using (res)
    {
    if (oversized)
    {
      sw.Stop();
      RecordFull(callId, ModelPolicy.Voice, "voice-transcribe", 0, 0, 0, sw.ElapsedMilliseconds, false, 0,
        "failed", null, null, UsageAccounting.BasisVoice,
        "failed: provider body oversized at bound; cost unknown", boardId, meetingId);
      throw new ProviderException(502, RedactedError(502) + "; oversized body truncated at bound");
    }
    if (!res!.IsSuccessStatusCode)
    {
      sw.Stop();
      var code = (int)res.StatusCode;
      if (code == 429)
      {
        RecordFull(callId, ModelPolicy.Voice, "voice-transcribe", 0, 0, 0, sw.ElapsedMilliseconds, false, 0,
          "failed", null, 0m, UsageAccounting.BasisVoice,
          "failed: provider HTTP 429 rate-limited; nonbillable per speech pricing; cost 0", boardId, meetingId);
      }
      else if (code >= 400 && code < 500)
      {
        RecordFull(callId, ModelPolicy.Voice, "voice-transcribe", 0, 0, 0, sw.ElapsedMilliseconds, false, 0,
          "failed", null, 0m, UsageAccounting.BasisVoice,
          "failed: provider HTTP " + code + " rejected before transcription; nonbillable; cost 0", boardId, meetingId);
      }
      else
      {
        RecordFull(callId, ModelPolicy.Voice, "voice-transcribe", 0, 0, 0, sw.ElapsedMilliseconds, false, 0,
          "failed", null, null, UsageAccounting.BasisVoice,
          "failed: provider HTTP " + code + "; cost unknown", boardId, meetingId);
      }
      throw new ProviderException(code, RedactedError(code));
    }
    } // using res disposal on all ASR paths
    sw.Stop();
    JsonDocument doc;
    try { doc = JsonDocument.Parse(text); }
    catch (JsonException ex)
    {
      RecordFull(callId, ModelPolicy.Voice, "voice-transcribe", 0, 0, 0, sw.ElapsedMilliseconds, false, 0,
        "unknown", null, null, UsageAccounting.BasisVoice,
        "malformed provider JSON: " + ex.Message + "; cost unknown", boardId, meetingId);
      throw new ProviderException(502, RedactedError(502));
    }
    using (doc)
    {
      var root = doc.RootElement;
      var transcript = "";
      try
      {
        if (root.TryGetProperty("transcript", out var t) && t.ValueKind == JsonValueKind.String) transcript = t.GetString() ?? "";
        if (string.IsNullOrWhiteSpace(transcript) && root.TryGetProperty("text", out var tx) && tx.ValueKind == JsonValueKind.String) transcript = tx.GetString() ?? "";
        if (string.IsNullOrWhiteSpace(transcript) && root.TryGetProperty("turns", out var turns) && turns.ValueKind == JsonValueKind.Array)
        {
          var parts = new List<string>();
          foreach (var x in turns.EnumerateArray())
          {
            if (x.ValueKind != JsonValueKind.Object) continue;
            if (x.TryGetProperty("transcript", out var tt) && tt.ValueKind == JsonValueKind.String)
            {
              var s = tt.GetString() ?? "";
              if (!string.IsNullOrWhiteSpace(s)) parts.Add(s);
            }
          }
          transcript = string.Join(" ", parts);
        }
      }
      catch { }
      int? ms = null;
      try
      {
        if (root.TryGetProperty("audioDurationMs", out var msv0) && msv0.ValueKind == JsonValueKind.Number && msv0.TryGetInt32(out var ival0)) ms = ival0;
        else if (root.TryGetProperty("audioProcessedMs", out var msv) && msv.ValueKind == JsonValueKind.Number && msv.TryGetInt32(out var ival)) ms = ival;
        else if (root.TryGetProperty("audio_processed_ms", out var msv2) && msv2.ValueKind == JsonValueKind.Number && msv2.TryGetInt32(out var ival2)) ms = ival2;
        else if (root.TryGetProperty("durationMs", out var msv3) && msv3.ValueKind == JsonValueKind.Number && msv3.TryGetInt32(out var ival3)) ms = ival3;
      }
      catch { ms = null; }
      var cost = UsagePricing.VoiceCost(ms);
      var status = cost.HasValue ? "succeeded" : "unknown";
      string note;
      if (ms.HasValue)
      {
        var secs = ms.Value / 1000;
        note = secs + "s audio (floor); cost " + FormatCost(cost);
      }
      else
      {
        note = "audio duration unobserved; cost unknown (never 0)";
      }
      RecordFull(callId, ModelPolicy.Voice, "voice-transcribe", 0, 0, 0, sw.ElapsedMilliseconds, false, 0,
        status, null, cost, UsageAccounting.BasisVoice, note, boardId, meetingId);
      return (transcript, cost);
    }
  }

  public async Task<List<byte[]>> GenerateImagesAsync(string prompt, int n,
    CancellationToken ct = default, bool ownerOverride = false,
    Guid? boardId = null, Guid? meetingId = null)
  {
    ThrowIfCapped(ownerOverride);
    EnsureAvailable();
    ThrowIfPrecancelled(ct);
    var callId = Guid.NewGuid();
    var sw = System.Diagnostics.Stopwatch.StartNew();
    JsonDocument doc;
    try
    {
      doc = await PostJson("/images/generations", new
      {
        model = ModelPolicy.Image,
        prompt = Truncate(prompt, 4000),
        n = Math.Clamp(n, 1, 4),
        response_format = "b64_json",
      }, ct);
    }
    catch (ProviderException pex)
    {
      sw.Stop();
      var imgPid = TryExtractProviderId(pex.FullBody ?? "");
      RecordFull(callId, ModelPolicy.Image, "image-generate", 0, 0, 0, sw.ElapsedMilliseconds, false, 0,
        "failed", imgPid, null, UsageAccounting.BasisImage,
        "failed: provider HTTP " + pex.Status + "; cost unknown; id " + (imgPid ?? "none"), boardId, meetingId);
      throw;
    }
    catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
    {
      sw.Stop();
      RecordFull(callId, ModelPolicy.Image, "image-generate", 0, 0, 0, sw.ElapsedMilliseconds, false, 0,
        "failed", null, null, UsageAccounting.BasisImage,
        "failed: provider transport failure after dispatch: " + ex.GetType().Name + "; cost unknown", boardId, meetingId);
      throw new ProviderException(502, "provider transport failure: " + ex.GetType().Name);
    }
    using (doc)
    {
      sw.Stop();
      string? prePid = null;
      try
      {
        var root = doc.RootElement;
        if (root.ValueKind != JsonValueKind.Object) throw new InvalidOperationException("non-object envelope");
        try { if (root.TryGetProperty("id", out var ridPre) && ridPre.ValueKind == JsonValueKind.String) prePid = ridPre.GetString(); } catch { }
        if (!root.TryGetProperty("data", out var data))
        {
          RecordFull(callId, ModelPolicy.Image, "image-generate", 0, 0, 0, sw.ElapsedMilliseconds, false, 0,
            "unknown", prePid, null, UsageAccounting.BasisImage,
            "unknown: data property missing; cost unknown; id " + (prePid ?? "none"), boardId, meetingId);
          throw new ProviderException(502, RedactedError(502));
        }
        if (data.ValueKind != JsonValueKind.Array)
        {
          RecordFull(callId, ModelPolicy.Image, "image-generate", 0, 0, 0, sw.ElapsedMilliseconds, false, 0,
            "unknown", prePid, null, UsageAccounting.BasisImage,
            "unknown: data is not an array; cost unknown; id " + (prePid ?? "none"), boardId, meetingId);
          throw new ProviderException(502, RedactedError(502));
        }
        string? pid = prePid;
        var images = new List<byte[]>();
        var returned = 0;
        var undecodable = 0;
        var urlOnly = 0;
        foreach (var item in data.EnumerateArray())
        {
          if (item.ValueKind != JsonValueKind.Object) { undecodable++; continue; }
          if (item.TryGetProperty("b64_json", out var b) && b.ValueKind == JsonValueKind.String && b.GetString() is { } s && !string.IsNullOrWhiteSpace(s))
          {
            try
            {
              var decoded = Convert.FromBase64String(s);
              if (!IsVerifiableImage(decoded)) { undecodable++; }
              else { images.Add(decoded); returned++; }
            }
            catch (FormatException) { undecodable++; }
          }
          else if (item.TryGetProperty("url", out var u) && u.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(u.GetString()))
          {
            var us = u.GetString() ?? "";
            if (IsValidProviderUrl(us))
            { returned++; urlOnly++; }
            else { undecodable++; }
          }
          else { undecodable++; }
        }
        var requested = Math.Clamp(n, 1, 4);
        if (returned == 0 && undecodable == 0)
        {
          RecordFull(callId, ModelPolicy.Image, "image-generate", 0, 0, 0, sw.ElapsedMilliseconds, false, 0,
            "succeeded", pid, 0m, UsageAccounting.BasisImage,
            "0 images returned (requested " + requested + "); explicit empty data is known 0", boardId, meetingId);
          return images;
        }
        if (undecodable > 0)
        {
          RecordFull(callId, ModelPolicy.Image, "image-generate", 0, 0, 0, sw.ElapsedMilliseconds, false, 0,
            "failed", pid, null, UsageAccounting.BasisImage,
            "failed: " + undecodable + " entries undecodable/invalid; " + returned + " verifiable returned; billable total unobservable; cost unknown", boardId, meetingId);
          throw new ProviderException(502, RedactedError(502));
        }
        var cost = UsagePricing.ImageCost(returned);
        if (urlOnly > 0)
        {
          RecordFull(callId, ModelPolicy.Image, "image-generate", 0, 0, 0, sw.ElapsedMilliseconds, false, 0,
            "failed", pid, cost, UsageAccounting.BasisImage,
            "failed: partial local delivery; " + returned + " URL billable units with " + urlOnly + " URL-only; " + images.Count + " local bytes; cost " + cost.ToString("F2") + " preserved; no external download", boardId, meetingId);
          throw new ProviderException(502, RedactedError(502));
        }
        RecordFull(callId, ModelPolicy.Image, "image-generate", 0, 0, 0, sw.ElapsedMilliseconds, false, 0,
          "succeeded", pid, cost, UsageAccounting.BasisImage,
          returned + " images returned (requested " + requested + "); bytes " + images.Count + "; cost " + cost.ToString("F2"), boardId, meetingId);
        return images;
      }
      catch (ProviderException) { throw; }
      catch (UsageStorageException) { throw; }
      catch (Exception ex) when (ex is JsonException or KeyNotFoundException or InvalidOperationException or FormatException)
      {
        RecordFull(callId, ModelPolicy.Image, "image-generate", 0, 0, 0, sw.ElapsedMilliseconds, false, 0,
          "unknown", prePid, null, UsageAccounting.BasisImage + "; envelope unparseable",
          "unknown: malformed provider envelope (" + ex.GetType().Name + "); cost unknown", boardId, meetingId);
        throw new ProviderException(502, RedactedError(502));
      }
    }
  }
}
