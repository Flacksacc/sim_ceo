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
public sealed record ValidatedRef(string Url, string Title, string Quote, string Excerpt);
public sealed record ValidatedClaim(string Text, string Kind, bool Verified, List<ValidatedRef> Refs);

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
    var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
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

  private static bool TryLookupPool(string url, IReadOnlyDictionary<string, (string Title, string Excerpt)> pool, out string canonicalUrl, out string title, out string excerpt)
  {
    canonicalUrl = "";
    title = "";
    excerpt = "";
    if (string.IsNullOrWhiteSpace(url)) return false;
    var u = url.Trim();
    if (pool.TryGetValue(u, out var hit))
    {
      canonicalUrl = u;
      title = hit.Title ?? "";
      excerpt = hit.Excerpt ?? "";
      return true;
    }
    var trimmed = u.TrimEnd('/');
    foreach (var kv in pool)
    {
      if (string.Equals(kv.Key.TrimEnd('/'), trimmed, StringComparison.OrdinalIgnoreCase))
      {
        canonicalUrl = kv.Key;
        title = kv.Value.Title ?? "";
        excerpt = kv.Value.Excerpt ?? "";
        return true;
      }
    }
    return false;
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

  public static ValidatedClaim MapOne(string line, IReadOnlyDictionary<string, (string Title, string Excerpt)> pool, IReadOnlyDictionary<string, string> sidMap)
  {
    var (kind, text, rawRefs) = ParseClaimLine(line);
    if (string.IsNullOrWhiteSpace(text)) return new ValidatedClaim("", "unverified", false, new List<ValidatedRef>());
    if (string.Equals(kind, "unverified", StringComparison.OrdinalIgnoreCase))
      return new ValidatedClaim(text, "unverified", false, new List<ValidatedRef>());
    var refs = new List<ValidatedRef>();
    var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    foreach (var (urlOrSid, quote) in rawRefs)
    {
      if (!TryResolveUrl(urlOrSid, sidMap, out var url)) continue;
      if (!TryLookupPool(url, pool, out var canon, out var title, out var excerpt)) continue;
      if (string.IsNullOrWhiteSpace(excerpt)) continue;
      var nExcerpt = Normalize(excerpt);
      var nQuote = Normalize(quote);
      if (nQuote.Length < MinQuoteChars) continue;
      if (nExcerpt.Length < MinExcerptChars) continue;
      if (!nExcerpt.Contains(nQuote, StringComparison.Ordinal)) continue;
      if (!seen.Add(canon)) continue;
      refs.Add(new ValidatedRef(canon, title ?? "", StripOuterQuotes(quote).Trim(), excerpt));
    }
    if (refs.Count == 0)
      return new ValidatedClaim(text, kind, false, new List<ValidatedRef>());
    return new ValidatedClaim(text, kind, true, refs);
  }

  public static List<ValidatedClaim> MapAll(IEnumerable<string> lines, IReadOnlyDictionary<string, (string Title, string Excerpt)> pool, IReadOnlyDictionary<string, string> sidMap)
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

  // Candidate web URLs referenced by raw lines that lack verified excerpts.
  // Used for ONE bounded post-dossier fetch round (no extra LLM call, no walk).
  public static List<string> CollectUnfetchedUrls(IEnumerable<string> lines, IReadOnlyDictionary<string, (string Title, string Excerpt)> pool, IReadOnlyDictionary<string, string> sidMap)
  {
    var needed = new List<string>();
    var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    foreach (var line in lines)
    {
      var (_, _, rawRefs) = ParseClaimLine(line);
      foreach (var (urlOrSid, _) in rawRefs)
      {
        if (!TryResolveUrl(urlOrSid, sidMap, out var url)) continue;
        if (!seen.Add(url)) continue;
        if (TryLookupPool(url, pool, out _, out _, out var ex) && !string.IsNullOrWhiteSpace(ex)) continue;
        if (!(url.StartsWith("http://", StringComparison.OrdinalIgnoreCase) || url.StartsWith("https://", StringComparison.OrdinalIgnoreCase))) continue;
        needed.Add(url);
      }
    }
    return needed;
  }
}
