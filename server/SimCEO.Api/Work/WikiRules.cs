using System.Text.Json;

namespace SimCEO.Api.Work;

// Phase7 Wiki.js 2.x rule engine. Case handling is documented here and in the
// protocol doc: paths are case-SENSITIVE (Wiki.js paths like /Docs/Guide vs
// /docs/guide are distinct); locale is exact case-sensitive; tags are exact
// case-sensitive. Only two pattern forms exist: exact paths and prefix/**
// patterns. Blank allowlist denies all; exclusions win over allowlist.
public static class WikiRules
{
  public const int MaxRuleEntries = 200;

  // Normalizes a Wiki path to a canonical "/a/b/c" form (leading slash, no
  // trailing slash except root). Returns null when the path is ambiguous or
  // hostile: backslashes, dot-segments, encoded separators/dot-segments,
  // double-encoding escapes, userinfo/query/fragment remnants, or empty.
  public static string? NormalizePath(string? raw)
  {
    if (string.IsNullOrWhiteSpace(raw)) return null;
    var t = raw.Trim();
    // Reject obvious hostile/ambiguous inputs before any decoding.
    if (t.Contains("\\")) return null;
    if (t.Contains("\0")) return null;
    var lower = t.ToLowerInvariant();
    // Encoded separators / dot-segment escapes / null bytes / double-encoding: fail closed.
    // %2f=/ %5c=\ %00=nul %25=% (double-encoding) %2e=. (encoded dot-segment)
    // %3f=? %23=# (encoded query/fragment delimiters)
    if (lower.Contains("%2f") || lower.Contains("%5c") || lower.Contains("%00") || lower.Contains("%25")
      || lower.Contains("%2e") || lower.Contains("%3f") || lower.Contains("%23")) return null;
    // Fragments/queries must never reach path matching (caller strips URLs first).
    if (t.Contains("?") || t.Contains("#")) return null;
    if (!t.StartsWith("/")) t = "/" + t;
    // Reject dot-segments, double slashes, trailing dot segments.
    var segs = t.Split("/");
    // segs[0] is "" from leading slash.
    for (var i = 1; i < segs.Length; i++)
    {
      var s = segs[i];
      if (s.Length == 0)
      {
        // Allow exactly one trailing slash ("/a/b/"); any interior "//" is ambiguous.
        if (i != segs.Length - 1) return null;
        continue;
      }
      if (s == "." || s == "..") return null;
      if (s.Contains("\\")) return null;
    }
    var norm = "/" + string.Join("/", segs.Skip(1).Where(s => s.Length > 0));
    if (norm.Length == 0) norm = "/";
    if (norm.Length > 500) return null;
    return norm;
  }

  // Deliberate root-wide allowance: "**" or "/**" means every path.
  // Blank/whitespace means deny-all (""). Malformed inner => "" (deny).
  public static string NormalizePattern(string? raw)
  {
    if (string.IsNullOrWhiteSpace(raw)) return "";
    var t = raw.Trim();
    if (t == "**") return "/**";
    var isPrefix = t.EndsWith("/**", StringComparison.Ordinal);
    if (!isPrefix)
    {
      var n = NormalizePath(t);
      return n ?? "";
    }
    var inner = t.Substring(0, t.Length - 3);
    if (string.IsNullOrWhiteSpace(inner) || inner.Trim() == "/") return "/**";
    var ni = NormalizePath(inner);
    if (ni is null) return "";
    return ni == "/" ? "/**" : ni + "/**";
  }

  public static bool MatchesPattern(string normalizedPath, string pattern)
  {
    var p = (pattern ?? "").Trim();
    if (p.Length == 0) return false;
    if (p.EndsWith("/**", StringComparison.Ordinal))
    {
      var prefix = p.Substring(0, p.Length - 3);
      if (prefix == "" || prefix == "/") return true;
      if (string.Equals(normalizedPath, prefix, StringComparison.Ordinal)) return true;
      return normalizedPath.StartsWith(prefix + "/", StringComparison.Ordinal);
    }
    return string.Equals(normalizedPath, p, StringComparison.Ordinal);
  }

  // Parses WITHOUT silent truncation; callers validate size before mutation.
  public static List<string> ParseList(string? json)
  {
    try
    {
      var v = JsonSerializer.Deserialize<List<string>>(string.IsNullOrWhiteSpace(json) ? "[]" : json);
      return (v ?? new()).Select(x => (x ?? "").Trim()).Where(x => x.Length > 0).ToList();
    }
    catch { return new List<string>(); }
  }

  // Persists exactly; never silently drops restrictions (validation rejects oversize first).
  public static string ToJson(IEnumerable<string> items)
    => JsonSerializer.Serialize(items.Select(x => (x ?? "").Trim()).Where(x => x.Length > 0).ToList());

  // Strict whole-collection parser: the value must be a JSON array and EVERY
  // entry must be a non-blank string. A single non-string/null/blank entry
  // rejects the entire collection; restrictions are never silently dropped (F11).
  public static bool TryParseStrictList(JsonElement arrayEl, out List<string> values, out string error)
  {
    values = new(); error = "";
    if (arrayEl.ValueKind != JsonValueKind.Array) { error = "must be an array of strings."; return false; }
    foreach (var x in arrayEl.EnumerateArray())
    {
      if (x.ValueKind != JsonValueKind.String) { error = "must be an array of strings; non-string entries reject the whole collection."; return false; }
      var s = (x.GetString() ?? "").Trim();
      if (s.Length == 0) { error = "must not contain blank entries."; return false; }
      values.Add(s);
    }
    return true;
  }

  public static (bool ok, string? error) ValidateRuleLists(List<string> allow, List<string> excl, List<string> tags)
  {
    if (allow.Count > MaxRuleEntries) return (false, "Allowlist exceeds 200 entries; narrow the rules instead of truncating restrictions.");
    if (excl.Count > MaxRuleEntries) return (false, "Exclusions exceed 200 entries; narrow the rules instead of truncating restrictions.");
    if (tags.Count > MaxRuleEntries) return (false, "Required tags exceed 200 entries.");
    foreach (var p in allow.Concat(excl))
    {
      var t = (p ?? "").Trim();
      if (t.Length == 0) return (false, "Rule pattern must not be blank.");
      if (t.Length > 500) return (false, "Rule pattern '" + t + "' is too long.");
      if (NormalizePattern(t).Length == 0)
        return (false, "Rule pattern '" + t + "' is ambiguous (dot-segments, backslashes, or encoded separators are rejected).");
    }
    foreach (var tg in tags)
    {
      var t = (tg ?? "").Trim();
      if (t.Length == 0) return (false, "Required tag must not be blank.");
      if (t.Length > 200) return (false, "Required tag is too long.");
    }
    return (true, null);
  }

  // Blank allowlist denies all. Exclusions win. Both lists use exact or prefix/**.
  // Patterns are matched on their NORMALIZED form actually used by matching.
  public static bool PathAllowed(string normalizedPath, List<string> allowlist, List<string> exclusions)
  {
    var allow = allowlist.Select(NormalizePattern).Where(p => p.Length > 0).ToList();
    var excl = exclusions.Select(NormalizePattern).Where(p => p.Length > 0).ToList();
    foreach (var e in excl) if (MatchesPattern(normalizedPath, e)) return false;
    if (allow.Count == 0) return false;
    foreach (var a in allow) if (MatchesPattern(normalizedPath, a)) return true;
    return false;
  }

  public static bool LocaleAllowed(string pageLocale, string requiredLocale)
  {
    var req = (requiredLocale ?? "").Trim();
    if (req.Length == 0) return true;
    return string.Equals((pageLocale ?? "").Trim(), req, StringComparison.Ordinal);
  }

  public static bool TagsAllowed(List<string> pageTags, List<string> requiredTags)
  {
    var req = (requiredTags ?? new()).Select(x => (x ?? "").Trim()).Where(x => x.Length > 0).ToList();
    if (req.Count == 0) return true;
    var set = new HashSet<string>((pageTags ?? new()).Select(x => (x ?? "").Trim()), StringComparer.Ordinal);
    foreach (var r in req) if (!set.Contains(r)) return false;
    return true;
  }

  public static bool PageAllowed(string normalizedPath, string pageLocale, List<string> pageTags,
    List<string> allowlist, List<string> exclusions, string requiredLocale, List<string> requiredTags)
    => PathAllowed(normalizedPath, allowlist, exclusions)
      && LocaleAllowed(pageLocale, requiredLocale)
      && TagsAllowed(pageTags, requiredTags);

  // Wiki family identity: board|scope|meeting|wiki|resource|locale|path. Never
  // collides with upload families (which end with a bare file name) because of
  // the explicit "wiki" origin segment plus resource id.
  public static string FamilyKeyFor(Guid boardId, string scope, Guid? meetingId, Guid resourceId, string locale, string normalizedPath)
  {
    var sc = scope == "meeting" ? "meeting" : "board";
    var mid = sc == "meeting" && meetingId.HasValue ? meetingId.Value.ToString("N") : "-";
    var loc = string.IsNullOrWhiteSpace(locale) ? "-" : locale.Trim();
    return boardId.ToString("N") + "|" + sc + "|" + mid + "|wiki|" + resourceId.ToString("N") + "|" + loc + "|" + normalizedPath;
  }

  public static string MembershipKey(string locale, string normalizedPath)
    => (string.IsNullOrWhiteSpace(locale) ? "-" : locale.Trim()) + "|" + normalizedPath;
}
