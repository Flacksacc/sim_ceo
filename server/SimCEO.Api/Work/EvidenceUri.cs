namespace SimCEO.Api.Work;

// Shared strict HTTP URI identity for the advisor evidence pipeline.
// Scheme/host case-insensitive (DNS), default ports equivalent, path/query
// case-SENSITIVE, trailing slash significant except bare root. Single root
// so source-input dedup, fetch/cache, pool lookup, prompt excerpt lookup,
// inventory, and claim-ref emission all agree. No case-insensitive full-URL
// dictionaries remain in this pipeline; Ordinal storage plus strict scan.
public static class EvidenceUri
{
  public static bool StrictEquals(string a, string b)
  {
    return ClaimEvidenceMapper.UrlsMatch(a, b);
  }

  public static string? FindKey(System.Collections.Generic.IEnumerable<string> keys, string url)
  {
    var u = (url ?? "").Trim();
    if (u.Length == 0) return null;
    foreach (var k in keys)
    {
      if (ClaimEvidenceMapper.UrlsMatch(k, u)) return k;
    }
    return null;
  }

  public static bool ContainsStrict(System.Collections.Generic.IEnumerable<string> list, string url)
  {
    return FindKey(list, url) is not null;
  }

  public static bool TryGetStrict<T>(System.Collections.Generic.IReadOnlyDictionary<string, T> dict, string url, out string canonicalKey, out T value)
  {
    canonicalKey = "";
    value = default!;
    var u = (url ?? "").Trim();
    if (u.Length == 0) return false;
    foreach (var kv in dict)
    {
      if (ClaimEvidenceMapper.UrlsMatch(kv.Key, u))
      {
        canonicalKey = kv.Key;
        value = kv.Value;
        return true;
      }
    }
    return false;
  }

  public static void AddDistinct(System.Collections.Generic.List<string> list, string url)
  {
    var t = (url ?? "").Trim();
    if (t.Length == 0) return;
    if (!ContainsStrict(list, t)) list.Add(t);
  }
}
