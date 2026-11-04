using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using SimCEO.Api.Domain;

namespace SimCEO.Api.Work;

// Character-based advisor behavior contract (backend owner).
// Users supply name + description, optional background + a few web URLs.
// Research compiles THREE short editable paragraphs stored under exact keys:
//   contributionCriteria, reasoningApproach, responseStyle
// These are operational instructions, not biography. Canonical saved versions
// drive meeting advisor selection/bidding AND every meeting answer, plus
// roster chat and audition. Legacy profiles without the exact keys resolve
// through a deterministic mapping (flagged LegacyMapped) so existing
// advisors keep working; mapping never rewrites stored human rows.
//
// Prompt rule: every ACCEPTED paragraph is delivered in FULL. Accepted means
// validated at save (each <= MaxAcceptedParagraphChars, whole profile JSON
// <= MaxProfileJsonChars). Oversize input is rejected with an actionable
// error, never silently truncated. Trimming applies to secondary context
// (sources, records, transcript tail) first, never to behavior or the
// essential question.
public static class CharacterBehavior
{
  public const string KeyContribution = "contributionCriteria";
  public const string KeyReasoning = "reasoningApproach";
  public const string KeyResponse = "responseStyle";

  // Max accepted size per researched/saved paragraph. Research output or a
  // save exceeding this is rejected explicitly (compile failure / 400),
  // never silently cut: a lost abstention rule would change behavior.
  public const int MaxAcceptedParagraphChars = 2000;
  // Whole-profile bound for new writes (existing stored rows are untouched).
  public const int MaxProfileJsonChars = 20000;
  public const int MaxBackgroundChars = 4000;
  public const int MaxFocusChars = 2000;
  // Essential question budgets: full user question + latest lead message,
  // tail-preserved when long. The run prompt and the posted lead message
  // are BOTH essential (a bare "continue" prompt carries no question).
  public const int MaxQuestionEssentialChars = 4000;
  public const int MaxBidQuestionChars = 2000;
  public const int MaxLeadMessageChars = 4000;
  // Input token budgets: USER-char budgets derived via ModelGateway.UserCharBudget
  // (tokens*4 minus the developer instruction the gateway always sends), sized
  // so max validated essentials fit: 3x2000 behavior + question + full seed
  // description/background (4k+4k) + headers. Chat covers question(4k) + seed
  // context; bids cover question(2k) + lead message(4k) + seed context.
  public const int ChatInputTokens = 8000;
  public const int BidInputTokens = 6000;
  // Excerpt embedded in seed paragraphs: the FULL user text always stays in
  // the structured description/background fields (and research inputs); the
  // seed paragraph points at it with a bounded quote instead of silently
  // cutting decisive behavior.
  public const int MaxSeedQuoteChars = 200;
  // User-supplied research URLs: a few only, validated before any fetch.
  public const int MaxSourceUrls = 5;
  public const int MaxSourceUrlChars = 2000;
  // Env override exists ONLY for isolated QA (still capped at 180s).
  public static TimeSpan ResearchDeadline
  {
    get
    {
      var raw = Environment.GetEnvironmentVariable("SIMCEO_RESEARCH_DEADLINE_SEC");
      if (int.TryParse(raw, out var secs) && secs > 0)
        return TimeSpan.FromSeconds(Math.Min(secs, 180));
      return TimeSpan.FromSeconds(150);
    }
  }

  public sealed record BehaviorParagraphs(
    string ContributionCriteria, string ReasoningApproach, string ResponseStyle, bool LegacyMapped);

  // Persisted research inputs, stored SEPARATELY from replaceable research
  // results so failure/reload/retry keeps full seed inputs. Full background
  // (up to MaxBackgroundChars) and all URLs are preserved, never capped.
  public sealed record ResearchInputs(string Background, List<string> SourceUrls, string Focus)
  {
    public ResearchInputs() : this("", new List<string>(), "") { }
  }

  public static ResearchInputs ParseInputs(string? json)
  {
    try
    {
      using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(json) ? "{}" : json);
      var root = doc.RootElement;
      var bg = root.ValueKind == JsonValueKind.Object && root.TryGetProperty("background", out var b)
        && b.ValueKind == JsonValueKind.String ? (b.GetString() ?? "") : "";
      var fo = root.ValueKind == JsonValueKind.Object && root.TryGetProperty("focus", out var f)
        && f.ValueKind == JsonValueKind.String ? (f.GetString() ?? "") : "";
      var urls = new List<string>();
      if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty("sourceUrls", out var u)
          && u.ValueKind == JsonValueKind.Array)
        foreach (var e in u.EnumerateArray())
          if (e.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(e.GetString()))
            urls.Add(e.GetString()!.Trim());
      return new ResearchInputs(bg, urls, fo);
    }
    catch (JsonException) { return new ResearchInputs(); }
  }

  public static string SerializeInputs(string background, List<string> urls, string focus = "") =>
    JsonSerializer.Serialize(new
    {
      background = background ?? "",
      sourceUrls = urls ?? new List<string>(),
      focus = focus ?? "",
    });

  private static string Str(JsonElement root, string key)
  {
    try
    {
      if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty(key, out var v)
          && v.ValueKind == JsonValueKind.String)
        return (v.GetString() ?? "").Trim();
    }
    catch { }
    return "";
  }

  private static List<string> StrList(JsonElement root, string key)
  {
    var list = new List<string>();
    try
    {
      if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty(key, out var v)
          && v.ValueKind == JsonValueKind.Array)
        foreach (var e in v.EnumerateArray())
        {
          var t = e.ValueKind == JsonValueKind.String ? (e.GetString() ?? "") : e.GetRawText();
          if (!string.IsNullOrWhiteSpace(t)) list.Add(t.Trim());
        }
    }
    catch { }
    return list;
  }

  private static string JoinOr(List<string> items, string fallback)
  {
    var clean = items.Where(x => !string.IsNullOrWhiteSpace(x)).Take(6).ToList();
    return clean.Count > 0 ? string.Join("; ", clean) : fallback;
  }

  // Resolve the 3 behavior paragraphs from any stored profile JSON, IN FULL.
  // Exact keys win; otherwise deterministically map legacy capability
  // fields. Never throws; never invents a persona for empty profiles
  // (falls back to an abstention-safe stance, flagged legacy).
  public static BehaviorParagraphs Resolve(string? profileJson)
  {
    JsonDocument? doc = null;
    try { doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(profileJson) ? "{}" : profileJson); }
    catch (JsonException) { doc = null; }
    if (doc is not null)
    {
      using (doc)
      {
        var root = doc.RootElement;
        var c = Str(root, KeyContribution);
        var r = Str(root, KeyReasoning);
        var s = Str(root, KeyResponse);
        if (!string.IsNullOrWhiteSpace(c) && !string.IsNullOrWhiteSpace(r) && !string.IsNullOrWhiteSpace(s))
          return new BehaviorParagraphs(c, r, s, false);
        // Partial new keys: keep what the user saved, map only the gaps.
        var mapped = MapLegacy(root);
        if (!string.IsNullOrWhiteSpace(c) || !string.IsNullOrWhiteSpace(r) || !string.IsNullOrWhiteSpace(s))
          return new BehaviorParagraphs(
            string.IsNullOrWhiteSpace(c) ? mapped.ContributionCriteria : c,
            string.IsNullOrWhiteSpace(r) ? mapped.ReasoningApproach : r,
            string.IsNullOrWhiteSpace(s) ? mapped.ResponseStyle : s,
            true);
        if (root.ValueKind == JsonValueKind.Object)
        {
          var legacy = MapLegacy(root);
          if (!string.IsNullOrWhiteSpace(legacy.ContributionCriteria)
              || !string.IsNullOrWhiteSpace(legacy.ReasoningApproach)
              || !string.IsNullOrWhiteSpace(legacy.ResponseStyle))
            return legacy;
        }
      }
    }
    return new BehaviorParagraphs(
      "Seed profile pending research: contribute only where the owner description clearly applies; otherwise abstain and say what evidence would be needed.",
      "Reason from the owner description and approved meeting evidence only; do not invent credentials, employment, degrees, or endorsements; challenge unsupported premises within that scope.",
      "Direct and concise; context determines bluntness versus diplomacy; cite the evidence used and stay inside the stated specialty.",
      true);
  }

  private static BehaviorParagraphs MapLegacy(JsonElement root)
  {
    var name = Str(root, "name");
    var role = Str(root, "role");
    var problem = Str(root, "problem");
    var background = Str(root, "background");
    var strengths = StrList(root, "strengths");
    var canHandle = StrList(root, "canHandle");
    var methods = StrList(root, "methods");
    var evidenceNeeded = StrList(root, "evidenceNeeded");
    var limits = StrList(root, "limits");
    var triggers = StrList(root, "challengeTriggers");
    var collaboration = Str(root, "collaboration");
    var who = string.IsNullOrWhiteSpace(name) ? "this advisor" :
      (!string.IsNullOrWhiteSpace(role) ? name + " (" + role + ")" : name);
    var scopeBits = new List<string>();
    scopeBits.AddRange(canHandle);
    scopeBits.AddRange(strengths.Take(3));
    if (!string.IsNullOrWhiteSpace(problem)) scopeBits.Add(problem);
    var c = "Contributes as " + who + " on: " + JoinOr(scopeBits, "topics in the owner description")
      + ". Defers outside that scope and abstains when required facts are missing."
      + (limits.Count > 0 ? " Limits: " + JoinOr(limits, "") + "." : "");
    var rbits = new List<string>();
    rbits.AddRange(methods);
    if (evidenceNeeded.Count > 0) rbits.Add("requires: " + JoinOr(evidenceNeeded, ""));
    if (triggers.Count > 0) rbits.Add("challenges: " + JoinOr(triggers, ""));
    var r = "Reasons from " + (!string.IsNullOrWhiteSpace(background) ? "the researched background and " : "")
      + "approved meeting evidence using " + JoinOr(rbits, "structured comparison and assumption checks")
      + ". Agrees when evidence supports the point; disagrees or challenges when it does not, within specialty; never fabricates credentials, employment, degrees, licenses, or endorsements.";
    var s = (!string.IsNullOrWhiteSpace(collaboration) ? collaboration.Trim() : "Direct and concise")
      + "; tone follows the character and context (blunt about risks the character would call out, diplomatic where the character would preserve the relationship); detailed when evidence allows, brief otherwise.";
    if (string.IsNullOrWhiteSpace(background) && strengths.Count == 0 && methods.Count == 0
        && canHandle.Count == 0 && string.IsNullOrWhiteSpace(collaboration)
        && string.IsNullOrWhiteSpace(role) && string.IsNullOrWhiteSpace(problem))
      return new BehaviorParagraphs("", "", "", true);
    return new BehaviorParagraphs(c, r, s, true);
  }

  // Essential behavior section for prompts. Version-pinned and stale-flagged
  // so old-version output is traceable and discardable. Paragraphs are
  // emitted IN FULL (accepted sizes are validated at save); callers trim
  // secondary context first, never this section.
  public static string BehaviorSection(string? profileJson, string advisorName, int currentVersion, int pinnedVersion, string boardRole)
  {
    var b = Resolve(profileJson);
    var stale = pinnedVersion != currentVersion;
    var sb = new StringBuilder();
    sb.Append("CHARACTER (canonical roster v").Append(currentVersion)
      .Append(", pinned v").Append(pinnedVersion);
    if (stale) sb.Append(" STALE");
    sb.AppendLine("): " + advisorName);
    sb.AppendLine("Contribution criteria: " + b.ContributionCriteria);
    sb.AppendLine("Reasoning approach: " + b.ReasoningApproach);
    sb.AppendLine("Response style: " + b.ResponseStyle);
    if (b.LegacyMapped)
      sb.AppendLine("(legacy-mapped behavior: stored profile predates researched paragraphs; mapped from stored capability fields, not a new persona)");
    if (!string.IsNullOrWhiteSpace(boardRole))
      sb.AppendLine("BOARD ROLE (board-specific, not canonical): " + boardRole.Trim());
    return sb.ToString();
  }

  // Essential question block: the actual run question/reply target is
  // essential context alongside behavior. Short questions pass through whole;
  // long ones keep the decisive END (head + omission marker + tail).
  public static string EssentialQuestion(string prompt, int max = MaxQuestionEssentialChars)
  {
    var q = (prompt ?? "").Trim();
    if (q.Length <= max) return q;
    const int head = 500;
    var omitted = q.Length - max;
    var tailLen = max - head - 60;
    if (tailLen < 500) tailLen = 500;
    var tail = q.Length > tailLen ? q.Substring(q.Length - tailLen) : q;
    var headText = q.Substring(0, Math.Min(head, q.Length));
    return headText + "\n[... " + omitted + " chars of the request omitted; decisive end preserved ...]\n" + tail;
  }

  // Validated essential-packet assembly shared by bid/reply/chat/audition/compile.
  // Essential sections (behavior paragraphs, current question, grounded dossier)
  // are reserved FIRST and always delivered whole; droppable lines (transcript
  // history, source excerpts, owner background/description overflow) fill the
  // remaining budget newest-first and are dropped oldest-first. Returns null
  // when even the essential content exceeds the budget, so callers explicitly
  // reject oversize input instead of blindly truncating decisive behavior.
  public static string? FitEssentialFirst(string essentialPrefix, List<string> droppableLines, int budgetChars)
  {
    if (essentialPrefix.Length > budgetChars) return null;
    var kept = new List<string>();
    var nl = Environment.NewLine.Length;
    var len = essentialPrefix.Length;
    for (var i = droppableLines.Count - 1; i >= 0; i--)
    {
      var line = droppableLines[i] ?? "";
      if (len + line.Length + nl > budgetChars) break;
      kept.Add(line);
      len += line.Length + nl;
    }
    kept.Reverse();
    var sb = new StringBuilder(essentialPrefix);
    foreach (var line in kept) sb.AppendLine(line);
    return sb.ToString();
  }

  // Validate a profile JSON a user wants to SAVE. Unknown properties are
  // preserved (backcompat); the 3 behavior keys, when present, must EACH be
  // present, non-empty and within the accepted size so prompts can carry
  // them whole. Returns an actionable 400-style error, never a silent cut.
  public static (bool ok, string? error, BehaviorParagraphs? paragraphs) ValidateSavedProfile(string profileJson)
  {
    if (profileJson.Length > MaxProfileJsonChars)
      return (false, "Profile must be " + MaxProfileJsonChars + " chars or fewer (got " + profileJson.Length + "). Shorten paragraphs instead of embedding documents.", null);
    JsonElement root;
    try
    {
      using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(profileJson) ? "{}" : profileJson);
      root = doc.RootElement.Clone();
    }
    catch (JsonException) { return (false, "Profile must be a JSON object.", null); }
    if (root.ValueKind != JsonValueKind.Object) return (false, "Profile must be a JSON object.", null);
    var bg = Str(root, "background");
    if (!string.IsNullOrWhiteSpace(bg) && bg.Length > MaxBackgroundChars)
      return (false, "background is " + bg.Length + " chars; keep the roster background under " + MaxBackgroundChars + ".", null);
    var hasAny = root.TryGetProperty(KeyContribution, out _)
      || root.TryGetProperty(KeyReasoning, out _) || root.TryGetProperty(KeyResponse, out _);
    if (!hasAny) return (true, null, null);
    var c = Str(root, KeyContribution);
    var r = Str(root, KeyReasoning);
    var s = Str(root, KeyResponse);
    if (string.IsNullOrWhiteSpace(c)) return (false, KeyContribution + " must be a non-empty paragraph when saving character behavior.", null);
    if (string.IsNullOrWhiteSpace(r)) return (false, KeyReasoning + " must be a non-empty paragraph when saving character behavior.", null);
    if (string.IsNullOrWhiteSpace(s)) return (false, KeyResponse + " must be a non-empty paragraph when saving character behavior.", null);
    if (c.Length > MaxAcceptedParagraphChars) return (false, KeyContribution + " is " + c.Length + " chars; keep each behavior paragraph under " + MaxAcceptedParagraphChars + ". Shorten it (decisive conditions first) and save again.", null);
    if (r.Length > MaxAcceptedParagraphChars) return (false, KeyReasoning + " is " + r.Length + " chars; keep each behavior paragraph under " + MaxAcceptedParagraphChars + ". Shorten it (decisive conditions first) and save again.", null);
    if (s.Length > MaxAcceptedParagraphChars) return (false, KeyResponse + " is " + s.Length + " chars; keep each behavior paragraph under " + MaxAcceptedParagraphChars + ". Shorten it (decisive conditions first) and save again.", null);
    return (true, null, new BehaviorParagraphs(c, r, s, false));
  }

  // Inline-draft profiles (auditions): must be a JSON object or a JSON-encoded
  // object string. Malformed text, arrays and other shapes are rejected before
  // any provider call. Canonical behavior (any of the 3 keys) enforces the same
  // save-time bounds; legacy objects without behavior keys keep the deterministic
  // legacy mapping.
  public static (bool ok, string? error) ValidateInlineProfile(string? profileJson)
  {
    if (string.IsNullOrWhiteSpace(profileJson))
      return (false, "profileJson must be a JSON object or a JSON-encoded object string.");
    JsonElement root;
    try
    {
      using var doc = JsonDocument.Parse(profileJson);
      root = doc.RootElement.Clone();
    }
    catch (JsonException) { return (false, "profileJson must be a JSON object or a JSON-encoded object string."); }
    if (root.ValueKind != JsonValueKind.Object)
      return (false, "profileJson must be a JSON object or a JSON-encoded object string.");
    var hasAny = root.TryGetProperty(KeyContribution, out _)
      || root.TryGetProperty(KeyReasoning, out _) || root.TryGetProperty(KeyResponse, out _);
    if (!hasAny) return (true, null);
    var (ok, err, _) = ValidateSavedProfile(profileJson);
    return (ok, err);
  }

  public static string ProfileBackground(string? profileJson)
  {
    try
    {
      using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(profileJson) ? "{}" : profileJson);
      var root = doc.RootElement;
      if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty("background", out var b)
        && b.ValueKind == JsonValueKind.String)
        return (b.GetString() ?? "").Trim();
    }
    catch (JsonException) { }
    return "";
  }

  // Full owner seed context for essential packets. Seed or legacy-mapped profiles
  // carry operational instructions in the entry description and profile background
  // that the paragraphs only quote; researched profiles already compiled them into
  // the 3 short paragraphs, so nothing is appended for those. Dedup: text already
  // present in full in the behavior section is not repeated.
  public static string SeedContextSection(string? behaviorText, string? profileJson, string? description)
  {
    var desc = (description ?? "").Trim();
    var bg = ProfileBackground(profileJson);
    var isSeed = false;
    var hasBehavior = false;
    try
    {
      using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(profileJson) ? "{}" : profileJson);
      var root = doc.RootElement;
      if (root.ValueKind == JsonValueKind.Object)
      {
        if (root.TryGetProperty("characterSeed", out var cs) && cs.ValueKind == JsonValueKind.True) isSeed = true;
        if (root.TryGetProperty("researched", out var rs) && rs.ValueKind == JsonValueKind.False) isSeed = true;
        var c = Str(root, KeyContribution);
        var r = Str(root, KeyReasoning);
        var s = Str(root, KeyResponse);
        hasBehavior = !string.IsNullOrWhiteSpace(c) && !string.IsNullOrWhiteSpace(r) && !string.IsNullOrWhiteSpace(s);
      }
    }
    catch (JsonException) { }
    if (hasBehavior && !isSeed) return "";
    var behav = behaviorText ?? "";
    var sb = new StringBuilder();
    if (!string.IsNullOrWhiteSpace(desc) && !behav.Contains(desc, StringComparison.Ordinal))
      sb.Append("Owner description (full, essential - operational seed text): ").AppendLine(desc);
    if (!string.IsNullOrWhiteSpace(bg) && !behav.Contains(bg, StringComparison.Ordinal))
      sb.Append("Owner background (full, essential - operational seed text): ").AppendLine(bg);
    return sb.ToString();
  }

  // Seed profile for quick creation: user text verbatim, no invented persona.
  // The FULL description/background always stay in the structured description
  // and background fields (and research inputs); the seed contribution paragraph
  // points at them with a bounded quote so a long description can never create
  // an invalid oversized paragraph (structured safe-input separation).
  public static string SeedExcerpt(string description)
  {
    var d = (description ?? "").Trim();
    if (d.Length <= MaxSeedQuoteChars) return d;
    return d.Substring(0, MaxSeedQuoteChars) + "[...see full description field...]";
  }

  public static string SeedProfileJson(string name, string description, string? background)
  {
    var bg = string.IsNullOrWhiteSpace(background) ? description.Trim() : background.Trim();
    return JsonSerializer.Serialize(new
    {
      fictional = true,
      name = name.Trim(),
      background = bg,
      characterSeed = true,
      researched = false,
      contributionCriteria = "Seed (pending research) for " + name.Trim() + ": contributes where the owner description applies (" + SeedExcerpt(description)
        + "); abstains where evidence is missing or the topic is outside that seed. Replace with researched criteria after research + explicit save.",
      reasoningApproach = "Seed (pending research): reason only from the owner description and approved meeting evidence; do not invent credentials, employment, degrees, licenses, or endorsements; challenge unsupported premises within that scope.",
      responseStyle = "Seed (pending research): direct and concise; let the described character and context determine bluntness versus diplomacy; cite evidence used and stay inside the stated specialty.",
      strengths = new[] { "practical tradeoffs", "risk surfacing", "structured comparison" },
      methods = new[] { "assumption check", "options comparison", "next-step proposal" },
      evidenceNeeded = new[] { "approved board sources", "board-lead brief" },
      limits = new[] { "defers outside specialty", "abstains without evidence", "never overrides board instructions", "never claims real employment, degrees, licenses, endorsements" },
      collaboration = "direct, concise, cites evidence",
    });
  }

  // Parse the compile model call into the 3 exact keys. Rejects non-JSON,
  // missing/empty paragraphs, or oversize paragraphs (caller treats as an
  // explicit compile failure with the returned reason, never silent cuts).
  public static bool TryParseCompiledParagraphs(string text, out BehaviorParagraphs paragraphs, out string? lengthError)
  {
    paragraphs = new BehaviorParagraphs("", "", "", false);
    lengthError = null;
    var t = (text ?? "").Trim();
    if (t.StartsWith("```"))
    {
      var nl = t.IndexOf("\n");
      var end = t.LastIndexOf("```");
      if (nl >= 0 && end > nl) t = t.Substring(nl + 1, end - nl - 1).Trim();
    }
    try
    {
      using var doc = JsonDocument.Parse(t);
      if (doc.RootElement.ValueKind != JsonValueKind.Object) return false;
      var c = Str(doc.RootElement, KeyContribution);
      var r = Str(doc.RootElement, KeyReasoning);
      var s = Str(doc.RootElement, KeyResponse);
      if (string.IsNullOrWhiteSpace(c) || string.IsNullOrWhiteSpace(r) || string.IsNullOrWhiteSpace(s))
        return false;
      foreach (var (key, val) in new[] { (KeyContribution, c), (KeyReasoning, r), (KeyResponse, s) })
        if (val.Length > MaxAcceptedParagraphChars)
        {
          lengthError = key + " compiled at " + val.Length + " chars (max " + MaxAcceptedParagraphChars + "); compile rejected so no behavior is silently cut.";
          return false;
        }
      paragraphs = new BehaviorParagraphs(c, r, s, false);
      return true;
    }
    catch (JsonException) { return false; }
  }

  // Validate optional user-supplied research URLs. Returns 400-style error or
  // the deduped URL list. Never throws on attacker-shaped input. Structural
  // validation only (the safe server fetcher enforces SSRF protection,
  // including private-address rejection, at fetch time).
  public static (bool ok, string? error, List<string> urls) ValidateSourceUrls(JsonElement body)
  {
    var urls = new List<string>();
    if (body.ValueKind != JsonValueKind.Object) return (true, null, urls);
    if (!body.TryGetProperty("sourceUrls", out var arr)) return (true, null, urls);
    if (arr.ValueKind == JsonValueKind.Null || arr.ValueKind == JsonValueKind.Undefined)
      return (true, null, urls);
    if (arr.ValueKind != JsonValueKind.Array)
      return (false, "sourceUrls must be an array of up to " + MaxSourceUrls + " http(s) URLs.", urls);
    // Strict identity for source-input dedup: Ordinal storage + strict scan via EvidenceUri (ClaimEvidenceMapper.UrlsMatch).
    var seen = new List<string>();
    foreach (var e in arr.EnumerateArray())
    {
      if (e.ValueKind != JsonValueKind.String)
        return (false, "sourceUrls must be an array of up to " + MaxSourceUrls + " http(s) URLs.", urls);
      var u = (e.GetString() ?? "").Trim();
      if (u.Length == 0 || u.Length > MaxSourceUrlChars)
        return (false, "Each source URL must be 1-" + MaxSourceUrlChars + " chars.", urls);
      if (!Uri.TryCreate(u, UriKind.Absolute, out var uri)
          || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)
          || string.IsNullOrWhiteSpace(uri.Host)
          || !string.IsNullOrEmpty(uri.UserInfo))
        return (false, "Each source URL must be a valid public http(s) URL without credentials.", urls);
      var norm = uri.AbsoluteUri;
      if (!SimCEO.Api.Work.EvidenceUri.ContainsStrict(seen, norm) && !SimCEO.Api.Work.EvidenceUri.ContainsStrict(urls, norm)) { seen.Add(norm); urls.Add(norm); }
      if (urls.Count > MaxSourceUrls)
        return (false, "Up to " + MaxSourceUrls + " source URLs allowed.", urls);
    }
    return (true, null, urls);
  }

  // Live research progress (memory-only; transient by design, never a
  // completion claim). Lets the UI poll real stage + sources while the
  // bounded POST is in flight instead of showing fake percentages.
  public sealed record ResearchProgress(string Stage, List<object> Sources, string? Error, DateTime UpdatedAt);
  private static readonly ConcurrentDictionary<string, ResearchProgress> LiveProgress = new();

  public static void SetProgress(string jobId, string stage, List<object>? sources = null, string? error = null)
  {
    if (string.IsNullOrEmpty(jobId)) return;
    LiveProgress[jobId] = new ResearchProgress(stage, sources ?? new List<object>(), error, DateTime.UtcNow);
  }

  public static ResearchProgress? GetProgress(string jobId)
  {
    if (string.IsNullOrEmpty(jobId)) return null;
    return LiveProgress.TryGetValue(jobId, out var p) ? p : null;
  }

  public static void ClearProgress(string jobId)
  {
    if (!string.IsNullOrEmpty(jobId)) LiveProgress.TryRemove(jobId, out _);
  }

  public static bool IsLive(string? jobId) =>
    !string.IsNullOrEmpty(jobId) && RosterOps.IsLiveResearchJob(jobId);
}
