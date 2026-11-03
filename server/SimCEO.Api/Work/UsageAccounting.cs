using System.Text.Json;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;

namespace SimCEO.Api.Work;

// Phase 9 usage accounting: explicit scopes, honest unknown costs, one
// ledger + one usage event per ACTUAL provider call. Pricing pinned to the
// official Meta docs checked 2026-11-02; costs are ESTIMATES, not invoices.
public static class UsageAccounting
{
  public const string PricingCheckedDate = "2026-11-02";
  public const string PricingDocs = "https://dev.meta.ai/docs/pricing-rate-limits";
  public const string SearchDocs = "https://dev.meta.ai/docs/search-grounding";
  public const string SpeechDocs = "https://dev.meta.ai/docs/speech-to-text";
  public const string ImageDocs = "https://dev.meta.ai/docs/image-generation";

  public const string BasisTokens = "est:https://dev.meta.ai/docs/pricing-rate-limits@2026-11-02; estimate not invoice; units as provider reports them";
  public const string BasisSearch = "est:https://dev.meta.ai/docs/pricing-rate-limits+https://dev.meta.ai/docs/search-grounding@2026-11-02; search 2.50/1000 queries in addition to tokens; estimate not invoice";
  public const string BasisImage = "est:https://dev.meta.ai/docs/image-generation@2026-11-02; 0.01 per SUCCESSFULLY RETURNED image (not requested); estimate not invoice";
  public const string BasisVoice = "est:https://dev.meta.ai/docs/speech-to-text@2026-11-02; 0.18/hour on FLOOR(whole billed seconds); duration source: official file audioDurationMs first, compatible event audioProcessedMs/audio_processed_ms/durationMs retained; absent duration => unknown (never 0); subsecond floors to known 0; HTTP 429 and pre-transcript rejection nonbillable known 0; estimate not invoice";

  // Purposes that are easy to miss in the UI. They are all visible by
  // default; the UI labels them so hidden work is not mistaken for free.
  public static readonly HashSet<string> HiddenPurposes = new(StringComparer.OrdinalIgnoreCase)
  {
    "advisor-bid", "advisor-research", "advisor-profile",
    "wizard-guide", "wizard-interview",
    "secretary", "briefing",
    "audition", "advisor-chat",
    "model-test",
  };

  public static bool IsHiddenPurpose(string purpose) =>
    HiddenPurposes.Contains(purpose ?? "");

  public static string ScopeLabel(Guid? boardId, Guid? meetingId) =>
    meetingId.HasValue ? "meeting" : boardId.HasValue ? "board" : "installation";

  // Allocation label for display. "Unallocated" = legitimately
  // installation-level (research/setup/audition/model-test/roster image).
  // "Missing" = scope ids were supplied but do not resolve (stale/deleted
  // board or meeting, or meeting/board mismatch). Never silently drop rows.
  public static string AllocationFor(Guid? boardId, Guid? meetingId, InMemoryStore s)
  {
    if (meetingId.HasValue)
    {
      if (!s.Meetings.TryGetValue(meetingId.Value, out var mtg)) return "Missing";
      if (boardId.HasValue && mtg.BoardId != boardId.Value) return "Missing";
      if (!s.Boards.ContainsKey(mtg.BoardId)) return "Missing";
      return "Allocated";
    }
    if (boardId.HasValue)
      return s.Boards.ContainsKey(boardId.Value) ? "Allocated" : "Missing";
    return "Unallocated";
  }

  public static (Guid? boardId, Guid? meetingId) ValidatedScope(Guid? boardId, Guid? meetingId, InMemoryStore s)
  {
    // Validate but preserve ids for audit: callers pass what they know;
    // display marks Missing explicitly. Never infer an ambiguous roster
    // board here (roster image/research without a board stays Unallocated).
    if (meetingId.HasValue && s.Meetings.TryGetValue(meetingId.Value, out var mtg))
    {
      if (boardId.HasValue && mtg.BoardId != boardId.Value)
        return (boardId, meetingId); // mismatch -> Missing label upstream
      return (mtg.BoardId, meetingId);
    }
    return (boardId, meetingId);
  }

  public static object PricingBasisMeta() => new
  {
    checkedDate = PricingCheckedDate,
    pricing = PricingDocs,
    searchGrounding = SearchDocs,
    speechToText = SpeechDocs,
    imageGeneration = ImageDocs,
    note = "Costs are ESTIMATES from the pinned basis above, not provider invoices. Unknown models or unobservable units are unknown (Cost null), never fabricated zero. Known 0 is recorded only when actually known (e.g. 0 returned images billed 0).",
    storage = (object?)null,
  };

  public static object ScopeSummary(IEnumerable<UsageRow> rows, InMemoryStore s) =>
    new
    {
      total = rows.Count(),
      knownCostUsd = rows.Where(r => r.Cost.HasValue).Sum(r => r.Cost!.Value),
      unknownCostCalls = rows.Count(r => !r.Cost.HasValue),
      allocated = rows.Count(r => AllocationFor(r.BoardId, r.MeetingId, s) == "Allocated"),
      unallocated = rows.Count(r => AllocationFor(r.BoardId, r.MeetingId, s) == "Unallocated"),
      missing = rows.Count(r => AllocationFor(r.BoardId, r.MeetingId, s) == "Missing"),
    };
}

// Official token pricing (USD per 1M), pinned 2026-11-02. Unknown models
// return null (unknown cost) and must NEVER fall back to Spark pricing.
public static class UsagePricing
{
  public sealed record TokenPrice(decimal InPerM, decimal OutPerM, decimal CachedPerM);

  private static readonly Dictionary<string, TokenPrice> Known = new(StringComparer.OrdinalIgnoreCase)
  {
    ["muse-spark-1.3"] = new(1.25m, 4.25m, 0.15m),
    ["muse-spark-1.2"] = new(1.25m, 4.25m, 0.15m),
    ["muse-spark-1.1"] = new(1.25m, 4.25m, 0.15m),
    ["muse-spark-1.3-contributor"] = new(0.10m, 0.20m, 0.002m),
    ["muse-spark-1.2-contributor"] = new(0.10m, 0.20m, 0.002m),
    ["muse-wonder-1.0"] = new(4.00m, 20.00m, 0.20m),
  };

  public static TokenPrice? PriceForOrNull(string model) =>
    string.IsNullOrWhiteSpace(model) ? null
    : Known.TryGetValue(model.Trim(), out var p) ? p : null;

  public static bool IsKnownTokenModel(string model) => PriceForOrNull(model) is not null;

  // Cached subset billed at the cached rate; remainder at input rate.
  // Reasoning tokens are already inside reported output; never double charge.
  public static decimal? ChatCost(string model, int inTok, int cachedTok, int outTok)
  {
    var p = PriceForOrNull(model);
    if (p is null) return null;
    if (inTok < 0 || outTok < 0 || cachedTok < 0 || cachedTok > inTok) return null;
    var cached = cachedTok;
    var fresh = inTok - cached;
    return fresh / 1_000_000m * p.InPerM + cached / 1_000_000m * p.CachedPerM + outTok / 1_000_000m * p.OutPerM;
  }

  public static decimal? GroundedCost(string model, int inTok, int cachedTok, int outTok, int searchCalls)
  {
    if (searchCalls < 0) return null;
    var tok = ChatCost(model, inTok, cachedTok, outTok);
    if (tok is null) return null;
    return tok + searchCalls / 1000m * ModelPolicy.SearchPer1k;
  }

  // Per SUCCESSFULLY RETURNED image, not requested n.
  public static decimal ImageCost(int returnedCount) =>
    Math.Max(0, returnedCount) * ModelPolicy.ImagePerImage;

  // FLOOR(whole processed seconds) at 0.18/hour. Null ms => unknown (null),
  // never fabricated zero. Knows 0 only when ms is present and floors to 0
  // only if... actually floor(0.4s)=0s bills 0: that is a known 0.
  public static decimal? VoiceCost(int? audioProcessedMs)
  {
    if (audioProcessedMs is null) return null;
    if (audioProcessedMs.Value < 0) return null;
    var seconds = audioProcessedMs.Value / 1000; // integer floor
    return seconds / 3600m * ModelPolicy.VoicePerHour;
  }

  // Strict billing validation: invalid/negative units are unknown cost, never
  // clamped into a fabricated known bill. Missing optional cached subset means 0.
  // Any present usage field with an invalid type or negative value, or
  // cached > input, rejects the whole usage as unobservable (returns false).
  private static bool TryGetNonNegativeInt(JsonElement obj, string name, out int value, out bool present)
  {
    value = 0; present = false;
    if (!obj.TryGetProperty(name, out var el)) return true;
    present = true;
    if (el.ValueKind != JsonValueKind.Number || !el.TryGetInt32(out value) || value < 0) return false;
    return true;
  }
  private static readonly HashSet<string> RecognizedBillingNames = new(StringComparer.Ordinal)
  {
    "prompt_tokens", "input_tokens", "completion_tokens", "output_tokens",
    "cached_tokens", "cached_input_tokens", "prompt_tokens_details", "input_tokens_details",
  };
  // Duplicate recognized billing fields at the same object level are invalid:
  // System.Text.Json exposes one occurrence, so hidden duplicates must reject.
  private static bool HasDuplicateBillingNames(JsonElement usage)
  {
    try
    {
      var raw = usage.GetRawText();
      using var doc = JsonDocument.Parse(raw);
      void Walk(JsonElement el)
      {
        if (el.ValueKind != JsonValueKind.Object) return;
        var local = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var prop in el.EnumerateObject())
        {
          if (RecognizedBillingNames.Contains(prop.Name))
          {
            local.TryGetValue(prop.Name, out var c);
            local[prop.Name] = c + 1;
            if (local[prop.Name] > 1) throw new InvalidOperationException("duplicate billing field: " + prop.Name);
          }
          if (prop.Value.ValueKind == JsonValueKind.Object
            && (prop.NameEquals("prompt_tokens_details") || prop.NameEquals("input_tokens_details")))
            Walk(prop.Value);
        }
      }
      Walk(doc.RootElement);
      return false;
    }
    catch (InvalidOperationException) { return true; }
    catch { return false; }
  }
  public static bool TryReadUsage(JsonElement root, out int inTok, out int cachedTok, out int outTok)
  {
    inTok = 0; cachedTok = 0; outTok = 0;
    try
    {
      if (!root.TryGetProperty("usage", out var u) || u.ValueKind != JsonValueKind.Object) return false;
      // Validate EVERY present recognized input alias; valid one must not hide an invalid other.
      bool hasPrompt = u.TryGetProperty("prompt_tokens", out var pt);
      bool hasInput = u.TryGetProperty("input_tokens", out var it);
      int? promptVal = null, inputVal = null;
      if (hasPrompt)
      {
        if (pt.ValueKind != JsonValueKind.Number || !pt.TryGetInt32(out var pi) || pi < 0) return false;
        promptVal = pi;
      }
      if (hasInput)
      {
        if (it.ValueKind != JsonValueKind.Number || !it.TryGetInt32(out var ii) || ii < 0) return false;
        inputVal = ii;
      }
      if (promptVal.HasValue && inputVal.HasValue)
      {
        if (promptVal.Value != inputVal.Value) return false;
        inTok = promptVal.Value;
      }
      else if (promptVal.HasValue) inTok = promptVal.Value;
      else if (inputVal.HasValue) inTok = inputVal.Value;
      else return false;
      // Validate EVERY present recognized output alias.
      bool hasCompletion = u.TryGetProperty("completion_tokens", out var c2);
      bool hasOutput = u.TryGetProperty("output_tokens", out var ot);
      int? compVal = null, outVal = null;
      if (hasCompletion)
      {
        if (c2.ValueKind != JsonValueKind.Number || !c2.TryGetInt32(out var co) || co < 0) return false;
        compVal = co;
      }
      if (hasOutput)
      {
        if (ot.ValueKind != JsonValueKind.Number || !ot.TryGetInt32(out var oo) || oo < 0) return false;
        outVal = oo;
      }
      if (compVal.HasValue && outVal.HasValue)
      {
        if (compVal.Value != outVal.Value) return false;
        outTok = compVal.Value;
      }
      else if (compVal.HasValue) outTok = compVal.Value;
      else if (outVal.HasValue) outTok = outVal.Value;
      else return false;
      // Validate EVERY present cached alias/shape; any invalid present field rejects.
      var cachedVals = new System.Collections.Generic.List<int>();
      bool hasPtd = u.TryGetProperty("prompt_tokens_details", out var ptd);
      if (hasPtd)
      {
        if (ptd.ValueKind == JsonValueKind.Null || ptd.ValueKind == JsonValueKind.Undefined) return false;
        else if (ptd.ValueKind != JsonValueKind.Object) return false;
        else if (ptd.TryGetProperty("cached_tokens", out var ct))
        {
          if (ct.ValueKind != JsonValueKind.Number || !ct.TryGetInt32(out var cti) || cti < 0) return false;
          cachedVals.Add(cti);
        }
      }
      bool hasItd = u.TryGetProperty("input_tokens_details", out var itd);
      if (hasItd)
      {
        if (itd.ValueKind == JsonValueKind.Null || itd.ValueKind == JsonValueKind.Undefined) return false;
        else if (itd.ValueKind != JsonValueKind.Object) return false;
        else if (itd.TryGetProperty("cached_tokens", out var ct2))
        {
          if (ct2.ValueKind != JsonValueKind.Number || !ct2.TryGetInt32(out var cti2) || cti2 < 0) return false;
          cachedVals.Add(cti2);
        }
      }
      if (u.TryGetProperty("cached_tokens", out var ct3))
      {
        if (ct3.ValueKind != JsonValueKind.Number || !ct3.TryGetInt32(out var cti3) || cti3 < 0) return false;
        cachedVals.Add(cti3);
      }
      if (u.TryGetProperty("cached_input_tokens", out var ct4))
      {
        if (ct4.ValueKind != JsonValueKind.Number || !ct4.TryGetInt32(out var cti4) || cti4 < 0) return false;
        cachedVals.Add(cti4);
      }
      if (HasDuplicateBillingNames(u)) return false;
      if (cachedVals.Count == 0) cachedTok = 0;
      else
      {
        for (int i = 1; i < cachedVals.Count; i++) if (cachedVals[i] != cachedVals[0]) return false;
        cachedTok = cachedVals[0];
      }
      if (cachedTok < 0 || cachedTok > inTok) return false;
      if (inTok < 0 || outTok < 0) return false;
      return true;
    }
    catch { return false; }
  }
}

