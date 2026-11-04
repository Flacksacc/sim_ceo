using System.Text;
using System.Text.Json;

namespace SimCEO.Api.Work;

// Pure local per-claim evidence linker (production callable, no HTTP/env/clock).
// Fixes the Take(3)-onto-every-claim provenance defect: retained refs must be
// linked to THAT claim via an explicit per-claim quote that appears verbatim
// (whitespace-normalized) in that source's retrieved passage. Titles, search
// questions, unfetched URLs, unknown URLs, and quote mismatches never ground.
// Unsupported/unmapped claims stay as explicit unverified notes with no refs.
// Quote linkage proves provenance only, never automatic claim truth; semantic
// review still verifies entailment on actual samples.
//
// Origin honesty (P1): provenance (quote present in a retrieved passage) is
// distinct from application fetch success. Provider search snippets may carry
// provenance but must never be recorded as fetched. Only passages actually
// retrieved via PublicEvidenceFetcher (owner batch or bounded post-dossier
// hydration) count as fetched. Pool retains MULTIPLE passages per URI so a
// provider snippet is not discarded when an owner excerpt already exists.
// URI identity (P2): strict URI-aware matching. Scheme/host case-insensitive
// (DNS), default-port normalized, path/query case-SENSITIVE, trailing slash
// significant (except bare root). /Case vs /case, differing query case, and
// /page vs /page/ are distinct resources and never share excerpts.
public sealed record ValidatedRef(string Url, string Title, string Quote, string Excerpt, bool Fetched = false, string Origin = "");
public sealed record ValidatedClaim(string Text, string Kind, bool Verified, List<ValidatedRef> Refs);
public sealed record PoolPassage(string Title, string Excerpt, bool Fetched, string Origin);

public static class ClaimEvidenceMapper
{
  public const int MinQuoteChars = 8;
  public const int MinExcerptChars = 8;

  public static string Normalize(string s)
  {
    if (string.IsNullOrEmpty(s)) return "";
    var sb = new StringBuilder(s.Length);
    bool inWs = false;
    foreach (var c in s)
    {
      if (char.IsWhiteSpace(c))
      {
        if (!inWs) { sb.Append(' '); inWs = true; }
      }
      else { sb.Append(c); inWs = false; }
    }
    return sb.ToString().Trim();
  }

  public static string StripOuterQuotes(string s)
  {
    var t = (s ?? "").Trim();
    if (t.Length >= 2)
    {
      if ((t.StartsWith("\"") && t.EndsWith("\"")) || (t.StartsWith("'") && t.EndsWith("'")))
        return t.Substring(1, t.Length - 2).Trim();
    }
    return t;
  }

  // SID index for owner-fetched evidence: S1..Sn in reqUrls order.
  public static Dictionary<string, string> BuildSidMap(IReadOnlyList<string> ownerUrls)
  {
    // SID keys (S1..Sn) are case-sensitive identifiers; URL values compare strictly via UrlsMatch. Ordinal storage.
    var map = new Dictionary<string, string>(StringComparer.Ordinal);
    for (var i = 0; i < ownerUrls.Count; i++)
    {
      var u = (ownerUrls[i] ?? "").Trim();
      if (u.Length == 0) continue;
      map["S" + (i + 1)] = u;
    }
    return map;
  }

  public static bool TryResolveUrl(string raw, IReadOnlyDictionary<string, string> sidMap, out string url)
  {
    url = "";
    var t = (raw ?? "").Trim();
    if (t.Length == 0) return false;
    t = t.Trim().Trim('[', ']', '<', '>', '"', (char)39, (char)32, (char)9);
    if (t.Length == 0) return false;
    if (sidMap.TryGetValue(t, out var mapped))
    {
      url = mapped;
      return true;
    }
    if (t.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || t.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
    {
      url = t.Trim();
      return true;
    }
    return false;
  }

  // Strict URI-aware identity. Host/scheme case-insensitive, default ports
  // equivalent, path/query case-SENSITIVE, trailing slash significant except
  // bare root ("https://h" == "https://h/"). Returns false for non-http(s).
  public static bool TryParseHttpUri(string s, out Uri uri)
  {
    uri = null!;
    try
    {
      var u = new Uri((s ?? "").Trim(), UriKind.Absolute);
      if (!string.Equals(u.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase)
        && !string.Equals(u.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
        return false;
      uri = u;
      return true;
    }
    catch { return false; }
  }

  public static bool UrlsMatch(string a, string b)
  {
    var sa = (a ?? "").Trim();
    var sb = (b ?? "").Trim();
    if (string.Equals(sa, sb, StringComparison.Ordinal)) return true;
    if (!TryParseHttpUri(sa, out var ua) || !TryParseHttpUri(sb, out var ub)) return false;
    if (!string.Equals(ua.Scheme, ub.Scheme, StringComparison.OrdinalIgnoreCase)) return false;
    if (!string.Equals(ua.Host, ub.Host, StringComparison.OrdinalIgnoreCase)) return false;
    var paDefault = ua.IsDefaultPort;
    var pbDefault = ub.IsDefaultPort;
    if (paDefault != pbDefault) return false;
    if (!paDefault && ua.Port != ub.Port) return false;
    var pa = ua.AbsolutePath ?? "";
    var pb = ub.AbsolutePath ?? "";
    var paRoot = pa == "" || pa == "/";
    var pbRoot = pb == "" || pb == "/";
    if (paRoot && pbRoot) pa = pb = "/";
    if (!string.Equals(pa, pb, StringComparison.Ordinal)) return false;
    if (!string.Equals(ua.Query ?? "", ub.Query ?? "", StringComparison.Ordinal)) return false;
    return true;
  }

  private static bool TryLookupPool(string url, IReadOnlyDictionary<string, (string Title, string Excerpt)> pool, out string canonicalUrl, out string title, out string excerpt)
  {
    canonicalUrl = "";
    title = "";
    excerpt = "";
    if (string.IsNullOrWhiteSpace(url)) return false;
    var u = url.Trim();
    foreach (var kv in pool)
    {
      if (UrlsMatch(kv.Key, u))
      {
        canonicalUrl = kv.Key;
        title = kv.Value.Title ?? "";
        excerpt = kv.Value.Excerpt ?? "";
        return true;
      }
    }
    return false;
  }

  private static bool TryLookupMulti(string url, IReadOnlyDictionary<string, List<PoolPassage>> pool, out string canonicalUrl, out List<PoolPassage> passages)
  {
    canonicalUrl = "";
    passages = new List<PoolPassage>();
    if (string.IsNullOrWhiteSpace(url)) return false;
    var u = url.Trim();
    foreach (var kv in pool)
    {
      if (UrlsMatch(kv.Key, u))
      {
        canonicalUrl = kv.Key;
        passages = kv.Value;
        return true;
      }
    }
    return false;
  }

  public static Dictionary<string, List<PoolPassage>> ToMultiPool(IReadOnlyDictionary<string, (string Title, string Excerpt)> legacy, string originIfExcerpt = "provider-search")
  {
    var multi = new Dictionary<string, List<PoolPassage>>(StringComparer.Ordinal);
    foreach (var kv in legacy)
    {
      var list = new List<PoolPassage>();
      if (!string.IsNullOrWhiteSpace(kv.Value.Excerpt))
        list.Add(new PoolPassage(kv.Value.Title ?? "", kv.Value.Excerpt ?? "", false, originIfExcerpt));
      multi[kv.Key] = list;
    }
    return multi;
  }

  // Parse one dossier line. Supports JSON, pipe, and legacy plain formats.
  public static (string Kind, string Text, List<(string UrlOrSid, string Quote)> RawRefs) ParseClaimLine(string line)
  {
    var raw = (line ?? "").Trim();
    if (raw.Length == 0) return ("unverified", "", new List<(string, string)>());
    if (raw.StartsWith("{") && raw.EndsWith("}"))
    {
      try
      {
        using var doc = JsonDocument.Parse(raw);
        var root = doc.RootElement;
        if (root.ValueKind == JsonValueKind.Object)
        {
          var text = "";
          var kind = "unverified";
          if (root.TryGetProperty("text", out var tv) && tv.ValueKind == JsonValueKind.String) text = (tv.GetString() ?? "").Trim();
          if (root.TryGetProperty("kind", out var kv) && kv.ValueKind == JsonValueKind.String)
          {
            var k = (kv.GetString() ?? "").Trim().ToLowerInvariant();
            if (k is "fact" or "verified") kind = "fact";
            else if (k is "interpretation" or "inference" or "opinion") kind = "interpretation";
            else kind = "unverified";
          }
          var refs = new List<(string, string)>();
          JsonElement arr = default;
          bool hasArr = false;
          if (root.TryGetProperty("refs", out var rv) && rv.ValueKind == JsonValueKind.Array) { arr = rv; hasArr = true; }
          else if (root.TryGetProperty("sources", out var sv) && sv.ValueKind == JsonValueKind.Array) { arr = sv; hasArr = true; }
          else if (root.TryGetProperty("evidence", out var ev) && ev.ValueKind == JsonValueKind.Array) { arr = ev; hasArr = true; }
          if (hasArr)
          {
            foreach (var item in arr.EnumerateArray())
            {
              if (item.ValueKind != JsonValueKind.Object) continue;
              var u = "";
              var q = "";
              if (item.TryGetProperty("url", out var uv) && uv.ValueKind == JsonValueKind.String) u = uv.GetString() ?? "";
              if (item.TryGetProperty("ref", out var rf) && rf.ValueKind == JsonValueKind.String && string.IsNullOrWhiteSpace(u)) u = rf.GetString() ?? "";
              if (item.TryGetProperty("quote", out var qv) && qv.ValueKind == JsonValueKind.String) q = qv.GetString() ?? "";
              else if (item.TryGetProperty("excerpt", out var xv) && xv.ValueKind == JsonValueKind.String) q = xv.GetString() ?? "";
              else if (item.TryGetProperty("passage", out var pv) && pv.ValueKind == JsonValueKind.String) q = pv.GetString() ?? "";
              if (!string.IsNullOrWhiteSpace(u) && !string.IsNullOrWhiteSpace(q))
                refs.Add((u.Trim(), StripOuterQuotes(q)));
              else if (!string.IsNullOrWhiteSpace(u))
                refs.Add((u.Trim(), ""));
            }
          }
          if (!string.IsNullOrWhiteSpace(text))
            return (kind, StripLegacyPrefix(text), refs);
        }
      }
      catch (JsonException) { }
    }
    string left;
    string right = "";
    var pipeIdx = raw.IndexOf("||", StringComparison.Ordinal);
    if (pipeIdx >= 0)
    {
      left = raw.Substring(0, pipeIdx).Trim();
      right = raw.Substring(pipeIdx + 2).Trim();
    }
    else left = raw;
    string kind2;
    string text2;
    var barIdx = left.IndexOf('|');
    if (barIdx >= 0)
    {
      var kindPart = left.Substring(0, barIdx).Trim().ToUpperInvariant();
      text2 = left.Substring(barIdx + 1).Trim();
      if (kindPart is "FACT" or "VERIFIED") kind2 = "fact";
      else if (kindPart is "INTERPRETATION" or "INFERENCE" or "OPINION") kind2 = "interpretation";
      else if (kindPart is "UNVERIFIED" or "UNSUPPORTED") kind2 = "unverified";
      else { kind2 = "unverified"; text2 = left.Trim(); }
    }
    else
    {
      if (left.StartsWith("VERIFIED:", StringComparison.OrdinalIgnoreCase))
      {
        kind2 = "fact";
        text2 = left.Substring("VERIFIED:".Length).Trim();
      }
      else if (left.StartsWith("FACT:", StringComparison.OrdinalIgnoreCase))
      {
        kind2 = "fact";
        text2 = left.Substring("FACT:".Length).Trim();
      }
      else if (left.StartsWith("INTERPRETATION:", StringComparison.OrdinalIgnoreCase))
      {
        kind2 = "interpretation";
        text2 = left.Substring("INTERPRETATION:".Length).Trim();
      }
      else
      {
        kind2 = "unverified";
        text2 = left.Trim();
      }
    }
    text2 = StripLegacyPrefix(text2);
    var rawRefs = new List<(string, string)>();
    if (!string.IsNullOrWhiteSpace(right))
    {
      var evIdx = right.IndexOf("EVIDENCE:", StringComparison.OrdinalIgnoreCase);
      var evPart = evIdx >= 0 ? right.Substring(evIdx + "EVIDENCE:".Length).Trim() : right.Trim();
      if (evPart.Length > 0)
      {
        foreach (var seg in evPart.Split(new[] { ";;" }, StringSplitOptions.RemoveEmptyEntries))
        {
          var s = seg.Trim();
          if (s.Length == 0) continue;
          var dcIdx = s.IndexOf("::", StringComparison.Ordinal);
          if (dcIdx < 0)
          {
            rawRefs.Add((s.Trim(), ""));
            continue;
          }
          var uPart = s.Substring(0, dcIdx).Trim().Trim('[', ']', '<', '>', '"', (char)39, (char)32, (char)9);
          var qPart = StripOuterQuotes(s.Substring(dcIdx + 2).Trim());
          rawRefs.Add((uPart, qPart));
        }
      }
    }
    return (kind2, text2, rawRefs);
  }

  private static string StripLegacyPrefix(string text)
  {
    var t = (text ?? "").Trim();
    if (t.StartsWith("VERIFIED:", StringComparison.OrdinalIgnoreCase)) return t.Substring("VERIFIED:".Length).Trim();
    if (t.StartsWith("INTERPRETATION:", StringComparison.OrdinalIgnoreCase)) return t.Substring("INTERPRETATION:".Length).Trim();
    if (t.StartsWith("FACT:", StringComparison.OrdinalIgnoreCase)) return t.Substring("FACT:".Length).Trim();
    if (t.StartsWith("UNVERIFIED:", StringComparison.OrdinalIgnoreCase)) return t.Substring("UNVERIFIED:".Length).Trim();
    return t;
  }

  private static ValidatedClaim MapOneCore(string line, IReadOnlyDictionary<string, string> sidMap, Func<string, (string canonicalUrl, List<PoolPassage>? passages)> lookup)
  {
    var (kind, text, rawRefs) = ParseClaimLine(line);
    if (string.IsNullOrWhiteSpace(text)) return new ValidatedClaim("", "unverified", false, new List<ValidatedRef>());
    if (string.Equals(kind, "unverified", StringComparison.OrdinalIgnoreCase))
      return new ValidatedClaim(text, "unverified", false, new List<ValidatedRef>());
    var refs = new List<ValidatedRef>();
    var seen = new List<string>();
    foreach (var (urlOrSid, quote) in rawRefs)
    {
      if (!TryResolveUrl(urlOrSid, sidMap, out var resolved)) continue;
      var (retainedUrl, passages) = lookup(resolved);
      if (passages is null || passages.Count == 0) continue;
      if (string.IsNullOrWhiteSpace(retainedUrl)) retainedUrl = resolved;
      var nQuote = Normalize(quote);
      if (nQuote.Length < MinQuoteChars) continue;
      PoolPassage? match = null;
      foreach (var passage in passages)
      {
        if (string.IsNullOrWhiteSpace(passage.Excerpt)) continue;
        var nExcerpt = Normalize(passage.Excerpt);
        if (nExcerpt.Length < MinExcerptChars) continue;
        if (!nExcerpt.Contains(nQuote, StringComparison.Ordinal)) continue;
        match = passage;
        if (passage.Fetched) break;
      }
      if (match is null) continue;
      // Return the retained pool URL (canonical key), not the model-resolved spelling.
      var canon = retainedUrl;
      bool dup = false;
      foreach (var s in seen) { if (UrlsMatch(s, canon)) { dup = true; break; } }
      if (dup) continue;
      seen.Add(canon);
      string retainedTitle = match.Title ?? "";
      refs.Add(new ValidatedRef(canon, retainedTitle, StripOuterQuotes(quote).Trim(), match.Excerpt ?? "", match.Fetched, match.Origin ?? ""));
    }
    if (refs.Count == 0)
      return new ValidatedClaim(text, kind, false, new List<ValidatedRef>());
    return new ValidatedClaim(text, kind, true, refs);
  }

  public static ValidatedClaim MapOne(string line, IReadOnlyDictionary<string, (string Title, string Excerpt)> pool, IReadOnlyDictionary<string, string> sidMap)
  {
    var multi = ToMultiPool(pool);
    return MapOne(line, (IReadOnlyDictionary<string, List<PoolPassage>>)multi, sidMap);
  }

  public static ValidatedClaim MapOne(string line, IReadOnlyDictionary<string, List<PoolPassage>> pool, IReadOnlyDictionary<string, string> sidMap)
  {
    return MapOneCore(line, sidMap,
      (string resolved) =>
      {
        if (TryLookupMulti(resolved, pool, out var canon, out var passages)) return (canon, passages);
        return ("", null);
      });
  }

  public static List<ValidatedClaim> MapAll(IEnumerable<string> lines, IReadOnlyDictionary<string, (string Title, string Excerpt)> pool, IReadOnlyDictionary<string, string> sidMap)
  {
    var multi = ToMultiPool(pool);
    return MapAll(lines, (IReadOnlyDictionary<string, List<PoolPassage>>)multi, sidMap);
  }

  public static List<ValidatedClaim> MapAll(IEnumerable<string> lines, IReadOnlyDictionary<string, List<PoolPassage>> pool, IReadOnlyDictionary<string, string> sidMap)
  {
    var result = new List<ValidatedClaim>();
    foreach (var line in lines)
    {
      var t = (line ?? "").Trim();
      if (t.Length == 0) continue;
      var vc = MapOne(t, pool, sidMap);
      if (string.IsNullOrWhiteSpace(vc.Text)) continue;
      result.Add(vc);
      if (result.Count >= 12) break;
    }
    return result;
  }

  // Legacy candidate-URL helper: snippet presence only. Production MUST use
  // the Fetched-aware overload below so provider snippets without a real
  // fetch are still hydrated instead of being mistaken for fetches.
  public static List<string> CollectUnfetchedUrls(IEnumerable<string> lines, IReadOnlyDictionary<string, (string Title, string Excerpt)> pool, IReadOnlyDictionary<string, string> sidMap)
  {
    var multi = ToMultiPool(pool);
    return CollectUnfetchedUrls(lines, (IReadOnlyDictionary<string, List<PoolPassage>>)multi, sidMap);
  }

  // Honest candidate-URL helper: a URL needs fetching when NO passage for it
  // was actually fetched (Fetched=true with nonempty excerpt). Provider-only
  // snippets, empty excerpts, unknown URLs, and strict-identity misses all
  // count as unfetched.
  public static List<string> CollectUnfetchedUrls(IEnumerable<string> lines, IReadOnlyDictionary<string, List<PoolPassage>> pool, IReadOnlyDictionary<string, string> sidMap)
  {
    var needed = new List<string>();
    foreach (var line in lines)
    {
      var (_, _, rawRefs) = ParseClaimLine(line);
      foreach (var (urlOrSid, _) in rawRefs)
      {
        if (!TryResolveUrl(urlOrSid, sidMap, out var url)) continue;
        if (!(url.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || url.StartsWith("https://", StringComparison.OrdinalIgnoreCase))) continue;
        bool already = false;
        foreach (var n in needed) { if (UrlsMatch(n, url)) { already = true; break; } }
        if (already) continue;
        bool fetched = false;
        if (TryLookupMulti(url, pool, out _, out var passages))
        {
          foreach (var passage in passages)
          {
            if (passage.Fetched && !string.IsNullOrWhiteSpace(passage.Excerpt)) { fetched = true; break; }
          }
        }
        if (fetched) continue;
        needed.Add(url);
      }
    }
    return needed;
  }
}
