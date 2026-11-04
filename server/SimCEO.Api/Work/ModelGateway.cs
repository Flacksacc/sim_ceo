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
  private readonly HttpClient _httpClient;
  // Instance-scoped whole-operation deadline override for QA fault injection.
  // Instance state only: setting it on one gateway never affects other
  // gateway instances (no process-static cross-instance pollution). Default
  // whole-operation deadline remains 120s (WholeOperationTimeout).
  public TimeSpan? WholeOperationTimeoutOverride { get; set; }

  public ModelGateway(InMemoryStore store)
  {
    _store = store;
    _evidence = new PublicEvidenceFetcher();
    _httpClient = _http;
  }
  public ModelGateway(InMemoryStore store, HttpClient httpClient)
  {
    _store = store;
    _evidence = new PublicEvidenceFetcher();
    _httpClient = httpClient ?? _http;
  }

  public ModelGateway(InMemoryStore store, PublicEvidenceFetcher evidence)
  {
    _store = store;
    _evidence = evidence; _httpClient = _http;
  }

  private static string Base =>
    Environment.GetEnvironmentVariable("META_API_BASE") is { Length: > 0 } b
      ? b.Trim().TrimEnd('/') : "https://api.meta.ai/v1";

  private string EffectiveKey
  {
    get
    {
      var o = PolicyStore.ReadApiKey(_store);
      return !string.IsNullOrWhiteSpace(o) ? o
        : Environment.GetEnvironmentVariable("META_API_KEY") ?? string.Empty;
    }
  }

  public void EnsureAvailable()
  {
    if (string.IsNullOrWhiteSpace(EffectiveKey)) throw new ProviderNotConfiguredException();
  }

  public static (decimal known, int unknownCalls) MonthSpend(InMemoryStore store)
  {
    var now = DateTime.UtcNow;
    // Coherent read: snapshot under the root gate so a concurrent ledger
    // rollback (drain-and-refill) cannot hand us a partial month.
    List<Domain.UsageRow> rows;
    lock (store.RootGate) { rows = store.Usage.Where(u => u.At.Year == now.Year && u.At.Month == now.Month).ToList(); }
    return (rows.Where(u => u.Cost.HasValue).Sum(u => u.Cost!.Value),
      rows.Count(u => !u.Cost.HasValue));
  }

  public void ThrowIfCapped(bool ownerOverride)
  {
    if (ownerOverride) return;
    var (capN, mode) = PolicyStore.ReadSpend(_store);
    if (mode != "block" || capN is not decimal cap) return;
    var (known, _) = MonthSpend(_store);
    if (known >= cap) throw new CapExceededException(cap, known);
  }

  private static string Truncate(string s, int maxChars) =>
    s.Length <= maxChars ? s : s[..maxChars];

  // Single shared construction of the exact chat-completions message pair
  // for secretary-style calls. Both the sender and the prompt-hash
  // computation must use this; no divergent formula. The hash covers the
  // actual delivered canonical ORDERED role/content message array (developer
  // first, user second) only, never headers or keys. Total content budget
  // includes BOTH developer and user text.
  public static (string Developer, string UserContent) BuildSecretaryPayload(string purpose, string prompt, int inputBudget, bool truncatePrompt)
  {
    var dev = DeveloperInstructionFor(purpose);
    // Total budget covers developer instruction + user packet (not user alone).
    int totalChars = (prompt ?? "").Length + dev.Length;
    if (!truncatePrompt && totalChars > inputBudget * 4)
      throw new ProviderException(502, "Secretary prompt exceeds budget; essential context cannot fit.");
    string user = truncatePrompt ? Truncate(prompt, System.Math.Max(0, inputBudget * 4 - dev.Length))
      : prompt;
    // Re-check total after truncation path (truncate could still exceed if dev alone is huge).
    if ((user ?? "").Length + dev.Length > inputBudget * 4 + 1000 && !truncatePrompt)
      throw new ProviderException(502, "Secretary prompt exceeds budget; essential context cannot fit.");
    return (dev, user);
  }
  // Shared user-packet budget: packet builders size USER text against
  // inputBudget*4 MINUS the developer instruction the gateway always sends,
  // so an accepted packet can never trip the gateway total below. Single
  // root formula; no per-caller margins.
  public static int UserCharBudget(string purpose, int inputBudget)
    => inputBudget * 4 - DeveloperInstructionFor(purpose).Length;
  // Canonical ORDERED role/content array used by the ACTUAL sender. Hash is of this array, not a delimiter string.
  public static object[] BuildDeliveredMessages(string developer, string userContent) =>
    new object[] { new { role = "developer", content = developer }, new { role = "user", content = userContent } };
  public static string HashDeliveredPrompt(string developer, string userContent)
  {
    var arr = BuildDeliveredMessages(developer, userContent);
    return Hashing.HashOf(System.Text.Json.JsonSerializer.Serialize(arr));
  }
  public static string HashDeliveredMessages(object[] messages) =>
    Hashing.HashOf(System.Text.Json.JsonSerializer.Serialize(messages));

  // Bounded reasoning: thinking tokens count against the output budget
  // (reasoning effort minimal/low/medium/high; max_completion_tokens includes
  // reasoning). Simple classification (model-test, bid) uses minimal;
  // interview, research, drafts and chat use low. No unbounded effort and no
  // automatic infinite retry.
  private static string ReasoningEffortFor(string purpose) => purpose switch
  {
    "model-test" => "minimal",
    "advisor-bid" => "minimal",
    "advisor-select" => "low",
    _ => "low",
  };

  // Sufficient output room: reasoning + final answer must fit in one call.
  // Minimal tasks need at least 512 total tokens (16-token probes starve
  // reasoning and yield null/empty content with finish length). Low tasks
  // need at least 2048. Callers keep their own limits; this only enforces a
  // floor so bounded effort still leaves room for the final answer.
  private static int EnsureOutputBudget(string purpose, int requested)
  {
    var floor = purpose == "advisor-research" ? 4096 : ReasoningEffortFor(purpose) == "minimal" ? 512 : 2048;
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
    "advisor-reply" => AdvisorDialogue.Guidance + " Write from the validated assessment when provided; preserve its justified judgment and practical next step. Never expose its JSON. If you add nothing, reply with exactly ABSTAIN.",
    "advisor-assess" => AdvisorAssessment.Instructions,
    "roster-chat" => AdvisorDialogue.Guidance + " Write from the validated assessment when provided; preserve its justified judgment and practical next step. Never expose its JSON.",
    "audition" => AdvisorDialogue.Guidance + " Write from the validated assessment when provided; preserve its justified judgment and practical next step. Never expose its JSON.",
    "advisor-select" => "Return only the requested JSON selection from the eligible candidate IDs. Follow the CEO's explicit advisor requests and requested output. Do not answer as an advisor.",
    "advisor-research" => "Return at most eight concise claims, one per line, in the requested evidence format, as the final answer. Use one or two supporting references per claim. Do not reply with progress commentary.",
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

  // Code-only ledger-append fault seams for rollback proofs (in-process QA
  // only). FailNextAppend fails BEFORE any row write (proves fault mapping
  // without erasing concurrent pairs; it cannot by itself prove partial-pair
  // rollback). FailAfterFirstAppend fails BETWEEN the two appends, proving
  // the unit rolls back a genuine partial pair. Never HTTP routes or
  // environment.
  internal static Func<bool>? FailNextAppend;
  internal static Func<bool>? FailAfterFirstAppend;

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
    // Pair atomicity under ONE shared boundary: capture, both appends, and
    // any rollback all happen inside the same store-bound unit (holding the
    // root gate), so a concurrent pair can neither slip between capture and
    // append nor be erased by this unit rollback. PG mode commits both rows
    // in one backend transaction (no memory snapshot needed). Ledgers stay
    // EXCLUDED from domain-unit snapshots (Ops billing boundary): a failing
    // domain unit preserves an already-billed pair, and a failing pair
    // append never touches domain rows.
    try
    {
      Atomic.Run(_store, () =>
      {
        List<Domain.UsageRow>? usageSnap = null;
        List<ModelCall>? callsSnap = null;
        if (SimCEO.Api.Data.Pg.Backend is null)
        {
          usageSnap = _store.Usage.CaptureLive();
          callsSnap = _store.ModelCalls.CaptureLive();
        }
        try
        {
          if (FailNextAppend?.Invoke() == true) throw new InvalidOperationException("injected ledger append fault (before any write)");
          _store.ModelCalls.Add(call);
          if (FailAfterFirstAppend?.Invoke() == true) throw new InvalidOperationException("injected ledger append fault (after first append)");
          _store.Usage.Add(row);
        }
        catch (Exception appendEx)
        {
          if (usageSnap is not null)
          {
            try
            {
              _store.Usage.RestoreLive(usageSnap);
              if (callsSnap is not null) _store.ModelCalls.RestoreLive(callsSnap);
            }
            catch (Exception rex) { throw new AggregateException("usage ledger append failed and ledger rollback is uncertain", appendEx, rex); }
          }
          throw new UsageStorageException("usage ledger append failed; provider result not recorded", appendEx);
        }
      });
    }
    catch (UsageStorageException) { throw; }
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
  // Verifiable supported raster: bounded structural container validation.
  // PNG: signature, IHDR (sane dimensions), >=1 non-empty IDAT with valid
  // CRCs, IEND. JPEG: SOI, SOF0/SOF2 (sane dimensions), SOS with payload,
  // EOI. WebP: RIFF size, WEBP tag, VP8/VP8L/VP8X payload with sane canvas.
  // Magic-only/truncated/garbage payloads fail. Bounded: no decompression,
  // all offsets length-checked. Max 12-bit..16384px per side.
  private static readonly uint[] CrcTable = BuildCrcTable();
  private static uint[] BuildCrcTable()
  {
    var table = new uint[256];
    for (uint i = 0; i < 256; i++)
    {
      var c = i;
      for (var k = 0; k < 8; k++) c = (c & 1) != 0 ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
      table[i] = c;
    }
    return table;
  }
  private static uint Crc32(byte[] buf, int off, int len)
  {
    var c = 0xFFFFFFFFu;
    for (var i = 0; i < len; i++) c = CrcTable[(c ^ buf[off + i]) & 0xFF] ^ (c >> 8);
    return c ^ 0xFFFFFFFFu;
  }
  private static int ReadI32BE(byte[] b, int o) =>
    (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
  private static int ReadU16BE(byte[] b, int o) => (b[o] << 8) | b[o + 1];
  private static bool SaneImageDims(long w, long h) =>
    w >= 1 && h >= 1 && w <= 16384 && h <= 16384 && w * h <= 100_000_000L;
  private static bool IsVerifiableImage(byte[] bytes)
  {
    try
    {
      if (bytes == null || bytes.Length < 16) return false;
      if (ImageValidation.IsPngStrict(bytes)) return true;
      if (ImageValidation.IsJpegStrict(bytes)) return true;
      if (ImageValidation.IsWebPStrict(bytes)) return true;
      return false;
    }
    catch { return false; }
  }
  private static bool IsPng(byte[] b)
  {
    try
    {
      if (b.Length < 8 || b[0] != 0x89 || b[1] != 0x50 || b[2] != 0x4E || b[3] != 0x47
        || b[4] != 0x0D || b[5] != 0x0A || b[6] != 0x1A || b[7] != 0x0A) return false;
      var o = 8;
      var seenIhdr = false;
      var seenIdat = false;
      var idatBytes = 0L;
      while (true)
      {
        if (o + 8 > b.Length) return false;
        var len = (long)(uint)ReadI32BE(b, o);
        if (len < 0 || len > b.Length) return false;
        if (o + 8 + len + 4 > b.Length) return false;
        var type = "" + (char)b[o + 4] + (char)b[o + 5] + (char)b[o + 6] + (char)b[o + 7];
        var want = Crc32(b, o + 4, (int)(4 + len));
        var got = (uint)ReadI32BE(b, (int)(o + 8 + len));
        if (want != got) return false;
        if (!seenIhdr)
        {
          if (type != "IHDR") return false;
          if (len != 13) return false;
          var w = (long)(uint)ReadI32BE(b, o + 8);
          var h = (long)(uint)ReadI32BE(b, o + 12);
          if (!SaneImageDims(w, h)) return false;
          var depth = b[o + 16];
          var ctype = b[o + 17];
          if (!(depth == 1 || depth == 2 || depth == 4 || depth == 8 || depth == 16)) return false;
          if (!(ctype == 0 || ctype == 2 || ctype == 3 || ctype == 4 || ctype == 6)) return false;
          seenIhdr = true;
        }
        else if (type == "IDAT")
        {
          if (len == 0) return false;
          idatBytes += len;
        }
        else if (type == "IEND") return seenIdat && idatBytes > 0;
        if (type == "IDAT") seenIdat = true;
        o += 8 + (int)len + 4;
        if (o >= b.Length) return false;
      }
    }
    catch { return false; }
  }
  private static bool IsJpeg(byte[] b)
  {
    try
    {
      if (b.Length < 4 || b[0] != 0xFF || b[1] != 0xD8 || b[2] != 0xFF) return false;
      var o = 2;
      var seenSof = false;
      var seenSos = false;
      long sosData = 0;
      while (o + 4 <= b.Length)
      {
        if (b[o] != 0xFF) return false;
        var marker = b[o + 1];
        if (marker == 0xD8 || marker == 0xD9)
        {
          if (marker == 0xD9) return seenSof && seenSos && sosData > 0;
          o += 2;
          continue;
        }
        if (marker == 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { o += 2; continue; }
        if (o + 4 > b.Length) return false;
        var segLen = ReadU16BE(b, o + 2);
        if (segLen < 2 || o + 2 + segLen > b.Length) return false;
        if (marker == 0xC0 || marker == 0xC2)
        {
          if (segLen < 7) return false;
          var h = ReadU16BE(b, o + 5);
          var w = ReadU16BE(b, o + 7);
          if (!SaneImageDims(w, h)) return false;
          seenSof = true;
        }
        else if (marker == 0xDA)
        {
          var scan = o + 2 + segLen;
          if (scan + 3 > b.Length) return false;
          var found = -1;
          var k = scan;
          while (k + 1 < b.Length)
          {
            if (b[k] == 0xFF)
            {
              if (b[k + 1] == 0x00) { k += 2; continue; }
              if (b[k + 1] == 0xD9) { found = k; break; }
              if (b[k + 1] == 0xD0 || (b[k + 1] >= 0xD0 && b[k + 1] <= 0xD7) || b[k + 1] == 0x01) { k += 2; continue; }
              break;
            }
            k++;
          }
          if (found < 0 || found + 2 != b.Length) return false;
          sosData = found - scan;
          if (sosData < 1) return false;
          seenSos = true;
          return seenSof && seenSos && sosData > 0;
        }
        o += 2 + segLen;
      }
      return false;
    }
    catch { return false; }
  }
  private static bool IsWebP(byte[] b)
  {
    try
    {
      if (b.Length < 12 || b[0] != 0x52 || b[1] != 0x49 || b[2] != 0x46 || b[3] != 0x46) return false;
      var riff = (long)(uint)(b[4] | (b[5] << 8) | (b[6] << 16) | (b[7] << 24));
      if (riff != b.Length - 8) return false;
      if (b[8] != 0x57 || b[9] != 0x45 || b[10] != 0x42 || b[11] != 0x50) return false;
      if (b.Length < 12 + 8) return false;
      var ck = "" + (char)b[12] + (char)b[13] + (char)b[14] + (char)b[15];
      var ckSize = (long)(uint)(b[16] | (b[17] << 8) | (b[18] << 16) | (b[19] << 24));
      if (ckSize < 0 || 20 + ckSize > b.Length) return false;
      if (ck == "VP8 ")
      {
        if (ckSize < 10) return false;
        if (!(b[20] == 0x9D && b[21] == 0x01 && b[22] == 0x2A)) return false;
        var w = (b[26] | ((b[27] & 0x3F) << 8)) & 0x3FFF;
        var h = (b[28] | ((b[29] & 0x3F) << 8)) & 0x3FFF;
        if (!SaneImageDims(w, h)) return false;
        return ckSize > 10;
      }
      if (ck == "VP8L")
      {
        if (ckSize < 5 || b[20] != 0x2F) return false;
        var v = (uint)(b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24));
        var w = (int)(v & 0x3FFF) + 1;
        var h = (int)((v >> 14) & 0x3FFF) + 1;
        if (!SaneImageDims(w, h)) return false;
        return ckSize > 5;
      }
      if (ck == "VP8X")
      {
        if (ckSize < 10) return false;
        var w = (b[26] | (b[27] << 8) | (b[28] << 16)) + 1;
        var h = (b[29] | (b[30] << 8) | (b[31] << 16)) + 1;
        if (!SaneImageDims(w, h)) return false;
        return true;
      }
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
  // Observed search count regardless of completeness: counts valid
  // web_search_call entries even when other entries render the complete
  // total unobservable. Never throws.
  private static int CountObservedSearches(JsonElement root)
  {
    try
    {
      if (!root.TryGetProperty("output", out var outputEl)) return 0;
      if (outputEl.ValueKind != JsonValueKind.Array) return 0;
      var n = 0;
      foreach (var item in outputEl.EnumerateArray())
      {
        try
        {
          if (item.ValueKind != JsonValueKind.Object) continue;
          if (item.TryGetProperty("type", out var tv) && tv.ValueKind == JsonValueKind.String
            && string.Equals(tv.GetString(), "web_search_call", StringComparison.Ordinal)) n++;
        }
        catch { }
      }
      return n;
    }
    catch { return 0; }
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

  // Endpoint/status-appropriate bounded transport budgets (bytes).
  // Error metadata: small fixed bound for every endpoint on non-2xx.
  // Text success (chat/responses/asr): covers configured max output tokens,
  // search-result hydration, and transcript payloads.
  // Image success: 1-4 actual supported images at PerImageByteCap plus
  // base64 (~4/3) and JSON overhead. Nothing is unbounded.
  private const int ErrorBoundBytes = 131072;
  private const int TextBoundBytes = 4 * 1024 * 1024;
  private const int ImageBoundBytes = 48 * 1024 * 1024;
  private const int PerImageByteCap = 8 * 1024 * 1024;
  private static readonly TimeSpan WholeOperationTimeout = TimeSpan.FromSeconds(120);
  private static string RedactedError(int status) =>
    $"provider HTTP {status}; billing preserved in ledger; no upstream content retained";
  private sealed class OversizedBodyException(string prefix, long consumed) : Exception("response body exceeded bound")
  {
    public string Prefix { get; } = prefix;
    public long Consumed { get; } = consumed;
  }
  // Bounded streamed consumption with a bounded overflow probe.
  // Reads at most boundBytes + one chunk; on overflow stops reading, cancels
  // further producer transfer via disposal, and reports oversized with the
  // exact consumed count. No background buffering or unobserved reads.
  private async Task<(string boundedBody, bool oversized, long consumed)> ReadBoundedBodyAsync(HttpResponseMessage res, int boundBytes, CancellationToken token)
  {
    long consumed = 0;
    try
    {
      using var stream = await res.Content.ReadAsStreamAsync(token).ConfigureAwait(false);
      var buf = new byte[8192];
      using var ms = new MemoryStream();
      int read;
      while ((read = await stream.ReadAsync(buf, 0, buf.Length, token).ConfigureAwait(false)) > 0)
      {
        consumed += read;
        if (ms.Length + read > boundBytes)
        {
          var room = boundBytes - (int)ms.Length;
          if (room > 0) ms.Write(buf, 0, room);
          return (Encoding.UTF8.GetString(ms.ToArray()), true, consumed);
        }
        ms.Write(buf, 0, read);
      }
      return (Encoding.UTF8.GetString(ms.ToArray()), false, consumed);
    }
    catch (OperationCanceledException) { throw; }
    catch (IOException) { throw; }
    catch (HttpRequestException) { throw; }
  }
  private static int BoundFor(string path, int statusCode) =>
    statusCode is < 200 or >= 300 ? ErrorBoundBytes
    : string.Equals(path, "/images/generations", StringComparison.Ordinal) ? ImageBoundBytes
    : TextBoundBytes;
  // boundKey pins the ACTUAL dispatched connection: when supplied, the
  // Authorization header uses exactly this captured key instead of
  // re-resolving EffectiveKey at dispatch time. This binds the tested key to
  // the actual request (A->B-before-header->A can never claim A tested when B
  // was dispatched). The bound key is request-scoped (a per-test immutable
  // string), never a process-wide cached config, and is never logged.
  private async Task<JsonDocument> PostJson(string path, object body, CancellationToken ct, string? boundKey = null)
  {
    using var opCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
    opCts.CancelAfter(WholeOperationTimeoutOverride ?? WholeOperationTimeout);
    var op = opCts.Token;
    using var req = new HttpRequestMessage(HttpMethod.Post, $"{Base}{path}");
    req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", boundKey ?? EffectiveKey);
    req.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
    using var res = await _httpClient.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, op).ConfigureAwait(false);
    var bound = BoundFor(path, (int)res.StatusCode);
    var (bounded, oversized, consumedBody) = await ReadBoundedBodyAsync(res, bound, op).ConfigureAwait(false);
    if (oversized)
      throw new OversizedBodyException(bounded, consumedBody);
    if (!res.IsSuccessStatusCode)
      throw new ProviderException((int)res.StatusCode, RedactedError((int)res.StatusCode), bounded);
    try { return JsonDocument.Parse(string.IsNullOrWhiteSpace(bounded) ? "{}" : bounded); }
    catch (JsonException) { throw new ProviderException(502, RedactedError(502), bounded); }
  }

  private void RecordStreamFailure(Guid callId, string model, string purpose, long elapsed, Exception error,
    Guid? boardId, Guid? meetingId, string reason)
  {
    var known = error.Data["streamUsage"] is string billing && TryParseErrorBillingFull(billing, out _, out _, out _, out _, out _);
    int input = 0, cached = 0, output = 0; string? id = null;
    if (known) TryParseErrorBillingFull((string)error.Data["streamUsage"]!, out input, out cached, out output, out id, out _);
    RecordFull(callId, model, purpose, input, cached, output, elapsed, false, 0, "failed", id,
      known ? UsagePricing.ChatCost(model, input, cached, output) : null, UsageAccounting.BasisTokens,
      reason + (known ? "; billed usage preserved" : "; cost unknown"), boardId, meetingId);
  }

  private sealed class BoundedProviderStream(Stream inner) : Stream
  {
    private long consumed;
    private int Count(int read) { consumed += read; if (consumed > TextBoundBytes) throw new OversizedBodyException("", consumed); return read; }
    public override bool CanRead => true;
    public override bool CanSeek => false;
    public override bool CanWrite => false;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => consumed; set => throw new NotSupportedException(); }
    public override int Read(byte[] buffer, int offset, int count) => Count(inner.Read(buffer, offset, count));
    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken token = default) => Count(await inner.ReadAsync(buffer, token));
    public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken token) => ReadAsync(buffer.AsMemory(offset, count), token).AsTask();
    public override void Flush() { }
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
  }

  private async Task<JsonDocument> PostChatStream(string model, string developer, string prompt, int outputTokens,
    string effort, Func<string, Task> onDelta, CancellationToken ct, string? boundKey)
  {
    using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
    timeout.CancelAfter(WholeOperationTimeoutOverride ?? WholeOperationTimeout);
    var token = timeout.Token;
    using var request = new HttpRequestMessage(HttpMethod.Post, $"{Base}/chat/completions");
    request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", boundKey ?? EffectiveKey);
    request.Content = new StringContent(JsonSerializer.Serialize(new { model, messages = BuildDeliveredMessages(developer, prompt),
      max_completion_tokens = Math.Clamp(outputTokens, 16, 16000), reasoning_effort = effort, stream = true,
      stream_options = new { include_usage = true } }), Encoding.UTF8, "application/json");
    using var response = await _httpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token);
    if (!response.IsSuccessStatusCode || response.Content.Headers.ContentType?.MediaType != "text/event-stream")
    {
      var (body, oversized, consumed) = await ReadBoundedBodyAsync(response, BoundFor("/chat/completions", (int)response.StatusCode), token);
      if (oversized) throw new OversizedBodyException(body, consumed);
      if (!response.IsSuccessStatusCode) throw new ProviderException((int)response.StatusCode, RedactedError((int)response.StatusCode), body);
      var fallback = JsonDocument.Parse(body);
      // Some compatible providers return a completed JSON envelope despite the
      // stream request. Keep that envelope's accounting/finish validation intact.
      return fallback;
    }
    using var input = await response.Content.ReadAsStreamAsync(token);
    using var boundedInput = new BoundedProviderStream(input);
    using var reader = new StreamReader(boundedInput, Encoding.UTF8, true, 4096, leaveOpen: true);
    var line = new StringBuilder(); var data = new StringBuilder(); var content = new StringBuilder();
    string? id = null; string? finish = null; JsonElement? usage = null;
    bool done = false; int consumedChars = 0;
    async Task Frame()
    {
      if (data.Length == 0) return;
      var value = data.ToString().Trim(); data.Clear();
      if (value == "[DONE]") { done = true; return; }
      using var chunk = JsonDocument.Parse(value);
      var root = chunk.RootElement;
      if (root.ValueKind != JsonValueKind.Object) throw new JsonException("Invalid provider stream event.");
      if (root.TryGetProperty("error", out _)) throw new ProviderException(502, "Provider stream failed.", value);
      if (root.TryGetProperty("id", out var identifier) && identifier.ValueKind == JsonValueKind.String) id ??= identifier.GetString();
      if (root.TryGetProperty("usage", out var bill) && bill.ValueKind == JsonValueKind.Object && TryReadUsageCached(root, out _, out _, out _)) usage = bill.Clone();
      if (!root.TryGetProperty("choices", out var choices) || choices.ValueKind != JsonValueKind.Array) return;
      foreach (var choice in choices.EnumerateArray())
      {
        if (choice.ValueKind != JsonValueKind.Object) throw new JsonException("Invalid provider stream choice.");
        if (choice.TryGetProperty("index", out var index)) {
          if (index.ValueKind != JsonValueKind.Number || !index.TryGetInt32(out var number)) throw new JsonException("Invalid provider stream choice index.");
          if (number != 0) continue;
        }
        if (choice.TryGetProperty("finish_reason", out var reason) && reason.ValueKind == JsonValueKind.String) finish = reason.GetString();
        if (choice.TryGetProperty("delta", out var delta) && delta.ValueKind == JsonValueKind.Object && delta.TryGetProperty("content", out var text) && text.ValueKind == JsonValueKind.String)
        {
          var added = text.GetString() ?? "";
          if (content.Length + added.Length > TextBoundBytes) throw new OversizedBodyException("", consumedChars);
          content.Append(added);
          if (added.Length > 0) await onDelta(added).WaitAsync(token);
        }
      }
    }
    async Task Line()
    {
      var value = line.ToString().TrimEnd('\r'); line.Clear();
      if (value.Length == 0) await Frame();
      else if (value.StartsWith("data:", StringComparison.Ordinal)) { if (data.Length > 0) data.Append('\n'); data.Append(value[5..].TrimStart(' ')); }
      if (data.Length > ErrorBoundBytes) throw new OversizedBodyException("", consumedChars);
    }
    var buffer = new char[4096]; int read;
    try
    {
    while (!done && (read = await reader.ReadAsync(buffer.AsMemory(), token)) > 0)
    {
      consumedChars += read;
      if (consumedChars > TextBoundBytes) throw new OversizedBodyException("", consumedChars);
      for (var i = 0; i < read && !done; i++)
      {
        if (buffer[i] == '\n') await Line(); else line.Append(buffer[i]);
        if (line.Length > ErrorBoundBytes) throw new OversizedBodyException("", consumedChars);
      }
    }
    if (!done) throw new IOException("Provider stream ended before completion.");
    }
    catch (Exception ex) { if (usage.HasValue) ex.Data["streamUsage"] = JsonSerializer.Serialize(new { id, usage }); throw; }
    return JsonDocument.Parse(JsonSerializer.Serialize(new { id, usage, choices = new[] { new { index = 0,
      finish_reason = finish ?? "incomplete", message = new { role = "assistant", content = content.ToString() } } } }));
  }

  public async Task<string> CompleteAsync(string model, string purpose, string prompt,
    int inputBudget, int outputBudget, CancellationToken ct = default, bool ownerOverride = false,
    Guid? boardId = null, Guid? meetingId = null, bool truncatePrompt = true, string? boundKey = null,
    Func<string, Task>? onDelta = null)
  {
    ThrowIfCapped(ownerOverride);
    if (boundKey is not null)
    {
      if (string.IsNullOrWhiteSpace(boundKey)) throw new ProviderNotConfiguredException();
    }
    else EnsureAvailable();
    ThrowIfPrecancelled(ct);
    var effort = ReasoningEffortFor(purpose);
    var ensured = EnsureOutputBudget(purpose, outputBudget);
    var (dev, userContent) = BuildSecretaryPayload(purpose, prompt, inputBudget, truncatePrompt);
    var callId = Guid.NewGuid();
    var sw = System.Diagnostics.Stopwatch.StartNew();
    JsonDocument doc;
    try
    {
      if (onDelta is not null)
        doc = await PostChatStream(model, dev, userContent, ensured, effort, onDelta, ct, boundKey);
      else doc = await PostJson("/chat/completions", new
      {
        model,
        messages = BuildDeliveredMessages(dev, userContent),
        max_completion_tokens = Math.Clamp(ensured, 16, 16000),
        reasoning_effort = effort,
        stream = false,
      }, ct, boundKey);
    }
    catch (OversizedBodyException obex)
    {
      sw.Stop();
      if (obex.Data["streamUsage"] is string) { RecordStreamFailure(callId, model, purpose, sw.ElapsedMilliseconds, obex, boardId, meetingId, "failed: oversized stream"); throw new ProviderException(502, RedactedError(502)); }
      var basisOver = UsagePricing.PriceForOrNull(model) is not null ? UsageAccounting.BasisTokens : UsageAccounting.BasisTokens + "; unknown model";
      var prePid = TryExtractProviderId(obex.Prefix);
      int preIn = 0, preCached = 0, preOut = 0;
      try { if (TryParseErrorBilling(obex.Prefix, out var oi, out var oc, out var oo, out _)) { preIn = oi; preCached = oc; preOut = oo; } } catch { }
      RecordFull(callId, model, purpose, preIn, preCached, preOut, sw.ElapsedMilliseconds, false, 0,
        "failed", prePid, null, basisOver,
        "failed: response oversized at bound (consumed " + obex.Consumed + "); total unknown; id " + (prePid ?? "none"), boardId, meetingId);
      throw new ProviderException(502, RedactedError(502) + "; oversized body truncated at bound", "");
    }
    catch (ProviderException pex)
    {
      sw.Stop();
      var knownErr = UsagePricing.PriceForOrNull(model) is not null;
      var basisErr = knownErr ? UsageAccounting.BasisTokens : UsageAccounting.BasisTokens + "; unknown model";
      var fullErr = pex.Data["streamUsage"] as string ?? pex.FullBody ?? pex.Body;
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
    catch (OperationCanceledException ocex)
    {
      sw.Stop();
      RecordStreamFailure(callId, model, purpose, sw.ElapsedMilliseconds, ocex, boardId, meetingId, "cancelled: provider call cancelled after dispatch");
      throw;
    }
    catch (Exception ex) when (ex is IOException or HttpRequestException or JsonException)
    {
      sw.Stop();
      RecordStreamFailure(callId, model, purpose, sw.ElapsedMilliseconds, ex, boardId, meetingId, "failed: provider transport failure");
      throw new ProviderException(502, "provider transport failure: " + ex.GetType().Name);
    }
    catch (Exception ex)
    {
      sw.Stop();
      RecordStreamFailure(callId, model, purpose, sw.ElapsedMilliseconds, ex, boardId, meetingId, "failed: response delivery interrupted");
      throw;
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
              "truncated: non-completed finish (not stop)", boardId, meetingId);
          }
          else
          {
            RecordFull(callId, model, purpose, 0, 0, 0, sw.ElapsedMilliseconds, false, 0,
              "unknown", pid, null, basis,
              "unknown: non-completed finish (not stop); usage missing; cost unknown", boardId, meetingId);
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

  // Optional fetch metadata (compatible): provider snippets stay Fetched=false/Origin=provider-search or unfetched;
  // successful PublicEvidenceFetcher hydration sets Fetched=true/Origin=application-fetch and flows through
  // gateway + CharacterResearch + ai-draft inventory + claim refs. No gateway rewrite.
  public sealed record Citation(string Url, string Title, string Excerpt, bool Fetched = false, string Origin = "");
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
    catch (OversizedBodyException obex)
    {
      sw.Stop();
      var basisOver = UsagePricing.PriceForOrNull(model) is not null ? UsageAccounting.BasisSearch : UsageAccounting.BasisSearch + "; unknown model";
      var prePid = TryExtractProviderId(obex.Prefix);
      int preIn = 0, preCached = 0, preOut = 0, preObs = 0;
      try
      {
        using var odoc = System.Text.Json.JsonDocument.Parse(string.IsNullOrWhiteSpace(obex.Prefix) ? "{}" : obex.Prefix);
        if (odoc.RootElement.ValueKind == JsonValueKind.Object)
        {
          if (UsagePricing.TryReadUsage(odoc.RootElement, out var oi, out var oc, out var oo)) { preIn = oi; preCached = oc; preOut = oo; }
          preObs = CountObservedSearches(odoc.RootElement);
        }
      }
      catch { }
      RecordFull(callId, model, purpose, preIn, preCached, preOut, sw.ElapsedMilliseconds, preObs > 0, preObs,
        "failed", prePid, null, basisOver,
        "failed: response oversized at bound (consumed " + obex.Consumed + "); total unknown; searches " + preObs + " observed; id " + (prePid ?? "none"), boardId, meetingId);
      throw new ProviderException(502, RedactedError(502) + "; oversized body truncated at bound", "");
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
        // Observed searches are preserved even when the complete total is not.
        var obs = eSearchesRaw >= 0;
        int eObserved = 0;
        try
        {
          using var odoc = System.Text.Json.JsonDocument.Parse(string.IsNullOrWhiteSpace(fullErr) ? "{}" : fullErr);
          if (odoc.RootElement.ValueKind == JsonValueKind.Object) eObserved = CountObservedSearches(odoc.RootElement);
        }
        catch { eObserved = obs ? eSearchesRaw : 0; }
        var eSearches = obs ? eSearchesRaw : eObserved;
        var eRan = eSearches > 0;
        decimal? eCost = obs ? UsagePricing.GroundedCost(model, eIn, eCached, eOut, eSearches) : null;
        RecordFull(callId, model, purpose, eIn, eCached, eOut, sw.ElapsedMilliseconds, eRan, eSearches,
          "failed", ePid, eCost, basisErr,
          "failed: provider HTTP " + pex.Status + "; tokens preserved id " + (ePid ?? "none") + "; searches " + eSearches + (obs ? "" : " observed") + "; total " + (eCost.HasValue ? "known" : "unknown"), boardId, meetingId);
      }
      else
      {
        var onlyPid = TryExtractProviderId(fullErr);
        int obsCount = 0;
        try
        {
          using var odoc2 = System.Text.Json.JsonDocument.Parse(string.IsNullOrWhiteSpace(fullErr) ? "{}" : fullErr);
          if (odoc2.RootElement.ValueKind == JsonValueKind.Object) obsCount = CountObservedSearches(odoc2.RootElement);
        }
        catch { obsCount = 0; }
        var ranS = obsCount > 0;
        RecordFull(callId, model, purpose, 0, 0, 0, sw.ElapsedMilliseconds, ranS, obsCount,
          "failed", onlyPid, null, basisErr,
          "failed: provider HTTP " + pex.Status + "; cost unknown; searches " + obsCount + " observed", boardId, meetingId);
      }
      throw;
    }
    catch (OperationCanceledException ocex)
    {
      // Cancellation classification is preserved, never wrapped as a 502:
      // callers distinguish bounded-deadline expiry from client abort.
      sw.Stop();
      RecordFull(callId, model, purpose, 0, 0, 0, sw.ElapsedMilliseconds, false, 0,
        "failed", null, null, UsageAccounting.BasisSearch,
        "cancelled: provider call cancelled after dispatch: " + ocex.GetType().Name + "; cost unknown", boardId, meetingId);
      throw;
    }
    catch (Exception ex) when (ex is IOException or HttpRequestException or JsonException)
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
                  { var snip = GetSearchSnippet(hit); citations.Add(new Citation(u, t, snip, false, string.IsNullOrWhiteSpace(snip) ? "unfetched" : "provider-search")); }
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
                    citations.Add(new Citation(GetStr(a, "url"), GetStr(a, "title"), "", false, "unfetched"));
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
            var ran0 = searches > 0;
            RecordFull(callId, model, purpose, uIn, uCached, uOut, sw.ElapsedMilliseconds, ran0, searches,
              "incomplete", responseId0, cc0, basisG,
              "incomplete: non-completed research; searches " + (searchObservable ? searches.ToString() : "unobservable") + "; total " + (cc0.HasValue ? "known" : "unknown"), boardId, meetingId);
          }
          else
          {
            var ran0u = searches > 0;
            RecordFull(callId, model, purpose, 0, 0, 0, sw.ElapsedMilliseconds, ran0u, searches,
              "unknown", responseId0, null, basisG,
              "unknown: non-completed research; usage missing; searches " + (searchObservable ? searches.ToString() : "unobservable"), boardId, meetingId);
          }
          throw new ProviderException(502, reason == "max_output_tokens"
            ? "Research ran out of response space before finishing. Try a more focused description or try again."
            : "The research provider did not finish its answer. Try again.");
        }
        if (!hasOutput)
        {
          if (hasUsage)
          {
            RecordFull(callId, model, purpose, uIn, uCached, uOut, sw.ElapsedMilliseconds, false, 0,
              "truncated", responseId0, null, basisG,
              "truncated: output missing; total unknown", boardId, meetingId);
          }
          else
          {
            RecordFull(callId, model, purpose, 0, 0, 0, sw.ElapsedMilliseconds, false, 0,
              "unknown", responseId0, null, basisG,
              "unknown: output missing; usage missing", boardId, meetingId);
          }
          throw new ProviderException(502, RedactedError(502));
        }
        string? responseId = responseId0;
        if (!hasUsage)
        {
          var ranU = searches > 0;
          RecordFull(callId, model, purpose, 0, 0, 0, sw.ElapsedMilliseconds, ranU, searches,
            "unknown", responseId0, null, basisG,
            "unknown: usage missing; searches " + (searchObservable ? searches.ToString() : "unobservable"), boardId, meetingId);
          throw new ProviderException(502, RedactedError(502));
        }
        var finalText = text.ToString().Trim();
        if (finalText.Length == 0)
        {
          decimal? cc2 = searchObservable ? UsagePricing.GroundedCost(model, uIn, uCached, uOut, searches) : null;
          var ranP = searches > 0;
          RecordFull(callId, model, purpose, uIn, uCached, uOut, sw.ElapsedMilliseconds, ranP, searches,
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
            var hydrated = await _evidence.HydrateAsync(citations, prompt, ct, forResearch: purpose == "advisor-research").ConfigureAwait(false);
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
        decimal? cost = searchObservable ? UsagePricing.GroundedCost(model, uIn, uCached, uOut, searches) : null;
        var excerptCount = 0;
        foreach (var cc in citations) if (!string.IsNullOrWhiteSpace(cc.Excerpt)) excerptCount++;
        var note = "response " + responseId + "; status completed; effort " + effort + "; searches " + searches + (searchObservable ? "" : " observed") + "; excerpts " + excerptCount + "; total " + (cost.HasValue ? "known" : "unknown");
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
    if (!VoiceAudio.TryValidate(audio, contentType, fileName,
        out var wavError, out _, out var wavType, out var wavName))
      throw new VoiceAudioException(wavError);
    contentType = wavType;
    fileName = wavName;
    ThrowIfCapped(ownerOverride);
    EnsureAvailable();
    ThrowIfPrecancelled(ct);
    var callId = Guid.NewGuid();
    var sw = System.Diagnostics.Stopwatch.StartNew();
    using var form = new MultipartFormDataContent();
    var requestJson = JsonSerializer.Serialize(new
    {
      model = ModelPolicy.Voice,
      audioEncoding = "WAV",
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
    string text = ""; long asrConsumed = 0;
    bool oversized = false;
    using var opCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
    opCts.CancelAfter(WholeOperationTimeoutOverride ?? WholeOperationTimeout);
    var op = opCts.Token;
    try
    {
      res = await _httpClient.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, op).ConfigureAwait(false);
      var asrBound = res.IsSuccessStatusCode ? TextBoundBytes : ErrorBoundBytes;
      (text, oversized, asrConsumed) = await ReadBoundedBodyAsync(res, asrBound, op).ConfigureAwait(false);
    }
    catch (OperationCanceledException ocex)
    {
      if (res is not null) try { res.Dispose(); } catch { }
      sw.Stop();
      RecordFull(callId, ModelPolicy.Voice, "voice-transcribe", 0, 0, 0, sw.ElapsedMilliseconds, false, 0,
        "failed", null, null, UsageAccounting.BasisVoice,
        "cancelled: provider call cancelled after dispatch: " + ocex.GetType().Name + "; cost unknown", boardId, meetingId);
      throw;
    }
    catch (Exception ex) when (ex is IOException or HttpRequestException)
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
        "failed: provider body oversized at bound (consumed " + asrConsumed + "); cost unknown", boardId, meetingId);
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
    catch (JsonException)
    {
      RecordFull(callId, ModelPolicy.Voice, "voice-transcribe", 0, 0, 0, sw.ElapsedMilliseconds, false, 0,
        "unknown", null, null, UsageAccounting.BasisVoice,
        "malformed provider JSON; cost unknown", boardId, meetingId);
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
      // Preserve an observable provider id when the ASR envelope carries one;
      // absence stays null (both ledgers record it via RecordFull).
      string? asrPid = null;
      try
      {
        if (root.TryGetProperty("id", out var asrId) && asrId.ValueKind == JsonValueKind.String) asrPid = asrId.GetString();
      }
      catch { asrPid = null; }
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
        status, asrPid, cost, UsageAccounting.BasisVoice, note, boardId, meetingId);
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
    catch (OversizedBodyException obex)
    {
      sw.Stop();
      var prePid = TryExtractProviderId(obex.Prefix);
      RecordFull(callId, ModelPolicy.Image, "image-generate", 0, 0, 0, sw.ElapsedMilliseconds, false, 0,
        "failed", prePid, null, UsageAccounting.BasisImage,
        "failed: response oversized at bound (consumed " + obex.Consumed + "); total unknown; id " + (prePid ?? "none"), boardId, meetingId);
      throw new ProviderException(502, RedactedError(502) + "; oversized body truncated at bound", "");
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
    catch (OperationCanceledException ocex)
    {
      sw.Stop();
      RecordFull(callId, ModelPolicy.Image, "image-generate", 0, 0, 0, sw.ElapsedMilliseconds, false, 0,
        "failed", null, null, UsageAccounting.BasisImage,
        "cancelled: provider call cancelled after dispatch: " + ocex.GetType().Name + "; cost unknown", boardId, meetingId);
      throw;
    }
    catch (Exception ex) when (ex is IOException or HttpRequestException or JsonException)
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
              if (decoded.Length > PerImageByteCap || !IsVerifiableImage(decoded)) { undecodable++; }
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
          throw new ProviderException(502, RedactedError(502) + "; local delivery unsupported for URL payloads; billed units retained");
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
