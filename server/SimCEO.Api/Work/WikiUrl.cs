using System.Text.Json;

namespace SimCEO.Api.Work;

// URL + credential-origin binding. Allows explicitly configured LAN/local
// HTTP(S) Wiki as well as public HTTPS (private-infrastructure use case).
// Rejects userinfo, query, fragment, invalid schemes, and arbitrary
// environment-variable references (provider-key exfiltration).
// Credential is bound to the normalized origin; a BaseUrl change clears the
// stored credential and disables the resource until reconfiguration.
public static class WikiUrl
{
  public static (string? origin, string? error) NormalizeBaseUrl(string? raw)
  {
    var t = (raw ?? "").Trim();
    if (t.Length == 0) return (null, "Base URL is required.");
    // No environment-variable references of any form.
    if (t.Contains("$(") || t.Contains("${") || t.IndexOf("$ENV", StringComparison.OrdinalIgnoreCase) >= 0 || t.Contains("%"))
      return (null, "Base URL must be a literal http(s) URL; environment-variable references are not allowed.");
    if (!Uri.TryCreate(t, UriKind.Absolute, out var u)) return (null, "Base URL must be an absolute http(s) URL.");
    if (u.Scheme != Uri.UriSchemeHttp && u.Scheme != Uri.UriSchemeHttps) return (null, "Base URL must use http or https.");
    if (!string.IsNullOrEmpty(u.UserInfo)) return (null, "Base URL must not contain userinfo.");
    if (!string.IsNullOrEmpty(u.Query) || !string.IsNullOrEmpty(u.Fragment)) return (null, "Base URL must not contain query or fragment; configure the origin only.");
    if (u.Host.Length == 0) return (null, "Base URL host is required.");
    var port = u.IsDefaultPort ? "" : ":" + u.Port;
    var origin = u.Scheme.ToLowerInvariant() + "://" + u.Host.ToLowerInvariant() + port;
    if (origin.Length > 300) return (null, "Base URL is too long.");
    return (origin, null);
  }

  public static string Redact(string? s) => string.IsNullOrWhiteSpace(s) ? "" : "***";

  // Fail-closed safe error: never copy arbitrary exception/provider text
  // (which may echo an Authorization bearer token) into DTO/audit/log.
  public static string SafeError(Exception ex)
  {
    if (ex is WikiGraphQlException wx) return wx.Message;
    if (ex is OperationCanceledException) return "Wiki sync timed out (whole-operation deadline).";
    return "Wiki sync failed.";
  }

  public static bool LooksLikeSecret(string? s)
  {
    if (string.IsNullOrEmpty(s)) return false;
    var t = s.Trim();
    if (t.Length >= 8 && t.Any(char.IsLetterOrDigit) && (t.Contains("-") || t.Contains("_") || t.Length >= 16)) return true;
    return false;
  }

  // Redact any bearer-like token fragments from a free-form string.
  public static string ScrubSecrets(string? s)
  {
    if (string.IsNullOrEmpty(s)) return "";
    var t = s;
    // Bearer xxx
    var idx = 0;
    while (true)
    {
      var b = t.IndexOf("bearer", idx, StringComparison.OrdinalIgnoreCase);
      if (b < 0) break;
      var e = b + 6;
      while (e < t.Length && (t[e] == (char)32 || t[e] == (char)58)) e++;
      var s2 = e;
      while (s2 < t.Length && !char.IsWhiteSpace(t[s2]) && t[s2] != (char)34 && t[s2] != (char)39 && t[s2] != (char)125) s2++;
      if (s2 > e) t = t.Substring(0, e) + "***" + t.Substring(s2);
      idx = e + 3;
      if (idx >= t.Length) break;
    }
    return t;
  }
}


