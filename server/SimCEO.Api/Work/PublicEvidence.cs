using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;
using AngleSharp.Dom;
using AngleSharp.Html.Parser;

namespace SimCEO.Api.Work;

// Bounded PUBLIC source retrieval for grounded research hydration.
// Only fills missing excerpts when a completed grounded call cited http(s)
// URLs but the provider supplied no snippet. Never fabricates from model
// prose/progress; a failed fetch leaves excerpt empty + unsupported.
// Security: model URLs are untrusted. Production rejects userinfo,
// non-http(s), unsupported ports, localhost/single-label/link-local/
// loopback/ULA/multicast/unspecified/reserved networks; resolves DNS before
// connect and rejects if ANY resolved address is not public; pins the TCP
// connection to a validated IP via SocketsHttpHandler.ConnectCallback while
// TLS validates the original hostname normally. No auto-redirects; max 2
// manual redirects with full revalidation every hop; never forwards
// Authorization/Cookie/credentials. No test bypass via API/env flag: probe
// injection is constructor-only (code), never reachable from HTTP or env.
// Whole-URL deadline: one linked 5s cancellation source covers DNS,
// redirects, headers, body and extraction. Partial/timed-out bodies fail
// closed (no partial excerpt). HTML parsing uses AngleSharp (no loaders,
// no script execution, no external fetch) with bounded traversal.
public sealed class PublicEvidenceFetcher
{
  public const int MaxUrlsPerCall = 3;
  public const int MaxBytesPerBody = 256 * 1024;
  public static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(5);
  public const int MaxRedirects = 2;
  public const int MaxConcurrency = 2;
  public const int MaxExcerptChars = 320;

  private readonly HttpMessageHandler? _testHandler;
  private readonly Func<string, CancellationToken, Task<IPAddress[]>> _dns;

  // Production: secure defaults, real DNS, per-hop pinned SocketsHttpHandler.
  public PublicEvidenceFetcher()
  {
    _testHandler = null;
    _dns = (h, ct) => Dns.GetHostAddressesAsync(h, ct);
  }

  // Probe-only: injected bounded HTTP fixture + DNS fixture. Never exposed
  // via HTTP endpoints or env flags; production ModelGateway uses default ctor.
  public PublicEvidenceFetcher(HttpMessageHandler testHandler, Func<string, CancellationToken, Task<IPAddress[]>>? dnsResolver = null)
  {
    _testHandler = testHandler ?? throw new ArgumentNullException(nameof(testHandler));
    _dns = dnsResolver ?? ((h, ct) => Dns.GetHostAddressesAsync(h, ct));
  }

  public async Task<List<ModelGateway.Citation>> HydrateAsync(
    IReadOnlyList<ModelGateway.Citation> citations, string subject, CancellationToken ct)
  {
    var original = citations.ToList();
    if (original.Count == 0) return original;
    var need = new List<string>();
    var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    foreach (var c in original)
    {
      if (!string.IsNullOrWhiteSpace(c.Excerpt)) continue;
      var u = (c.Url ?? "").Trim();
      if (u.Length == 0) continue;
      if (!u.StartsWith("http://", StringComparison.OrdinalIgnoreCase) &&
          !u.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) continue;
      if (!seen.Add(u)) continue;
      if (need.Count >= MaxUrlsPerCall) break;
      need.Add(u);
    }
    if (need.Count == 0) return original;
    var cache = new Dictionary<string, (string Title, string Excerpt)>(StringComparer.OrdinalIgnoreCase);
    using var gate = new SemaphoreSlim(MaxConcurrency, MaxConcurrency);
    var tasks = need.Select(async url =>
    {
      await gate.WaitAsync(ct).ConfigureAwait(false);
      try { return (Url: url, Fetched: await FetchOneAsync(url, subject, ct).ConfigureAwait(false)); }
      finally { gate.Release(); }
    }).ToList();
    var results = await Task.WhenAll(tasks).ConfigureAwait(false);
    foreach (var r in results) cache[r.Url] = r.Fetched;
    var hydrated = new List<ModelGateway.Citation>(original.Count);
    foreach (var c in original)
    {
      if (!string.IsNullOrWhiteSpace(c.Excerpt)) { hydrated.Add(c); continue; }
      var u = (c.Url ?? "").Trim();
      if (u.Length == 0 || !cache.TryGetValue(u, out var f) || string.IsNullOrWhiteSpace(f.Excerpt))
      { hydrated.Add(c); continue; }
      var title = string.IsNullOrWhiteSpace(c.Title) ? f.Title : c.Title;
      hydrated.Add(new ModelGateway.Citation(c.Url ?? "", title ?? "", f.Excerpt ?? ""));
    }
    return hydrated;
  }

  private async Task<(string Title, string Excerpt)> FetchOneAsync(string url, string subject, CancellationToken ct)
  {
    using var urlCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
    urlCts.CancelAfter(RequestTimeout);
    var bct = urlCts.Token;
    try
    {
      Uri current;
      try { current = new Uri(url, UriKind.Absolute); }
      catch { return ("", ""); }
      for (var hop = 0; hop <= MaxRedirects; hop++)
      {
        bct.ThrowIfCancellationRequested();
        if (!IsStructureAllowed(current, out _)) return ("", "");
        IPAddress[] ips;
        try { ips = await ResolvePublicAsync(current.Host, bct).ConfigureAwait(false); }
        catch (OperationCanceledException) { return ("", ""); }
        if (ips is null || ips.Length == 0) return ("", "");
        HttpClient client;
        SocketsHttpHandler? owned = null;
        if (_testHandler is not null)
        {
          client = new HttpClient(_testHandler, disposeHandler: false) { Timeout = Timeout.InfiniteTimeSpan };
        }
        else
        {
          owned = CreatePinnedHandler(ips);
          client = new HttpClient(owned) { Timeout = Timeout.InfiniteTimeSpan };
        }
        try
        {
          using var req = new HttpRequestMessage(HttpMethod.Get, current);
          req.Headers.UserAgent.ParseAdd("SimCEO-PublicEvidence/1.0");
          req.Headers.Accept.ParseAdd("text/html");
          req.Headers.Accept.ParseAdd("text/plain;q=0.9");
          // Never attach Authorization/Cookie/credentials; redirect hops reuse
          // a fresh request with no forwarded headers.
          using var res = await client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, bct).ConfigureAwait(false);
          var status = (int)res.StatusCode;
          if (status is 301 or 302 or 303 or 307 or 308)
          {
            var loc = res.Headers.Location?.ToString();
            if (string.IsNullOrWhiteSpace(loc) || hop == MaxRedirects) return ("", "");
            Uri next;
            try { next = new Uri(current, loc); }
            catch { return ("", ""); }
            current = next;
            continue;
          }
          if (!res.IsSuccessStatusCode) return ("", "");
          var media = res.Content.Headers.ContentType?.MediaType ?? "text/html";
          if (!media.StartsWith("text/", StringComparison.OrdinalIgnoreCase) &&
              !string.Equals(media, "application/xhtml+xml", StringComparison.OrdinalIgnoreCase) &&
              !string.Equals(media, "application/xml", StringComparison.OrdinalIgnoreCase))
            return ("", "");
          byte[] bytes;
          try { bytes = await ReadBoundedAsync(res.Content, MaxBytesPerBody, bct).ConfigureAwait(false); }
          catch (OperationCanceledException) { return ("", ""); }
          if (bytes.Length == 0) return ("", "");
          string body;
          try { body = Encoding.UTF8.GetString(bytes); }
          catch { return ("", ""); }
          bct.ThrowIfCancellationRequested();
          (string Title, string Excerpt) parsed;
          try { parsed = await ExtractExcerptAsync(body, subject, bct).ConfigureAwait(false); }
          catch (OperationCanceledException) { return ("", ""); }
          if (string.IsNullOrWhiteSpace(parsed.Excerpt)) return ("", "");
          return parsed;
        }
        catch (OperationCanceledException) { return ("", ""); }
        catch (HttpRequestException) { return ("", ""); }
        catch (IOException) { return ("", ""); }
        catch (InvalidOperationException) { return ("", ""); }
        finally { client.Dispose(); owned?.Dispose(); }
      }
      return ("", "");
    }
    catch (OperationCanceledException) { return ("", ""); }
    catch { return ("", ""); }
  }

  private SocketsHttpHandler CreatePinnedHandler(IPAddress[] validated)
  {
    var pinned = validated.ToArray();
    var h = new SocketsHttpHandler
    {
      AllowAutoRedirect = false,
      AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate | DecompressionMethods.Brotli,
      UseCookies = false,
      Credentials = null,
      UseProxy = false,
      Proxy = null,
      PooledConnectionLifetime = TimeSpan.FromMinutes(1),
    };
    h.ConnectCallback = async (ctx, ct) =>
    {
      var port = ctx.DnsEndPoint.Port;
      Exception? last = null;
      foreach (var ip in pinned)
      {
        var sock = new Socket(ip.AddressFamily, SocketType.Stream, ProtocolType.Tcp);
        try
        {
          await sock.ConnectAsync(ip, port, ct).ConfigureAwait(false);
          return (Stream)new NetworkStream(sock, ownsSocket: true);
        }
        catch (OperationCanceledException) { try { sock.Dispose(); } catch { } throw; }
        catch (Exception ex) { try { sock.Dispose(); } catch { } last = ex; }
      }
      throw last ?? new HttpRequestException("no validated endpoint reachable");
    };
    return h;
  }

  private async Task<IPAddress[]> ResolvePublicAsync(string host, CancellationToken ct)
  {
    IPAddress[] addrs;
    try { addrs = await _dns(host, ct).ConfigureAwait(false); }
    catch { return Array.Empty<IPAddress>(); }
    if (addrs is null || addrs.Length == 0) return Array.Empty<IPAddress>();
    foreach (var a in addrs)
    {
      var ip = a;
      if (ip.IsIPv4MappedToIPv6) { try { ip = ip.MapToIPv4(); } catch { return Array.Empty<IPAddress>(); } }
      if (!IsPublicIp(ip)) return Array.Empty<IPAddress>();
    }
    return addrs;
  }

  public static bool IsStructureAllowed(Uri uri, out string reason)
  {
    reason = "";
    if (!string.Equals(uri.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase) &&
        !string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
    { reason = "scheme"; return false; }
    if (!string.IsNullOrEmpty(uri.UserInfo)) { reason = "userinfo"; return false; }
    var host = uri.Host.Trim().TrimEnd('.');
    if (host.Length == 0) { reason = "host"; return false; }
    if (string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase)) { reason = "localhost"; return false; }
    if (!host.Contains('.') && !host.Contains(':')) { reason = "singlelabel"; return false; }
    var lower = host.ToLowerInvariant();
    if (lower.EndsWith(".localhost") || lower.EndsWith(".local") || lower.EndsWith(".internal") ||
        lower.EndsWith(".lan") || lower.EndsWith(".home") || lower.EndsWith(".corp") ||
        lower.EndsWith(".test") || lower.EndsWith(".example") || lower.EndsWith(".invalid"))
    { reason = "local-suffix"; return false; }
    var port = uri.Port;
    if (port != 80 && port != 443) { reason = "port"; return false; }
    if (IPAddress.TryParse(host, out var lit))
    {
      var v = lit;
      if (v.IsIPv4MappedToIPv6) { try { v = v.MapToIPv4(); } catch { } }
      if (!IsPublicIp(v)) { reason = "literal-private"; return false; }
      return true;
    }
    var t = host.Trim();
    try
    {
      var rxTimeout = TimeSpan.FromMilliseconds(200);
      if (Regex.IsMatch(t, "^[0-9]+$", RegexOptions.None, rxTimeout)) { reason = "numeric-host"; return false; }
      if (Regex.IsMatch(t, "^0[xX][0-9a-fA-F.]+$", RegexOptions.None, rxTimeout)) { reason = "numeric-host"; return false; }
    }
    catch (RegexMatchTimeoutException) { reason = "numeric-host"; return false; }
    if (t.Contains("0x", StringComparison.OrdinalIgnoreCase))
    {
      try
      {
        var rxTimeout2 = TimeSpan.FromMilliseconds(200);
        if (Regex.IsMatch(t, "^[0-9a-zA-Z.]+$", RegexOptions.None, rxTimeout2) && !Regex.IsMatch(t, "[a-zA-Z]{2,}", RegexOptions.None, rxTimeout2))
        { reason = "numeric-host"; return false; }
      }
      catch (RegexMatchTimeoutException) { reason = "numeric-host"; return false; }
    }
    return true;
  }

  public static bool IsPublicIp(IPAddress ip)
  {
    if (IPAddress.IsLoopback(ip)) return false;
    if (ip.Equals(IPAddress.Any) || ip.Equals(IPAddress.IPv6Any)) return false;
    if (ip.IsIPv4MappedToIPv6)
    {
      try { ip = ip.MapToIPv4(); }
      catch { return false; }
    }
    if (ip.AddressFamily == AddressFamily.InterNetworkV6)
    {
      if (ip.IsIPv6Multicast) return false;
      if (ip.IsIPv6LinkLocal) return false;
      if (ip.IsIPv6SiteLocal) return false;
      var b = ip.GetAddressBytes();
      if (b.Length != 16) return false;
      bool allZero = true;
      for (int i = 0; i < 16; i++) if (b[i] != 0) { allZero = false; break; }
      if (allZero) return false;
      bool isLoopback = b[15] == 1;
      for (int i = 0; i < 15; i++) if (b[i] != 0) { isLoopback = false; break; }
      if (isLoopback) return false;
      bool first12Zero = true;
      for (int i = 0; i < 12; i++) if (b[i] != 0) { first12Zero = false; break; }
      if (first12Zero) return false;
      if (b[0] == 0x00 && b[1] == 0x64 && b[2] == 0xFF && b[3] == 0x9B) return false;
      if (b[0] == 0x01 && b[1] == 0x00)
      {
        bool restZero = true;
        for (int i = 2; i < 8; i++) if (b[i] != 0) { restZero = false; break; }
        if (restZero) return false;
      }
      if ((b[0] & 0xE0) != 0x20) return false;
      if (b[0] == 0x20 && b[1] == 0x01 && b[2] == 0x0D && b[3] == 0xB8) return false;
      // IANA 2001::/23 special-protocol space (Teredo, PCP, Benchmarking, AMT, AS112-v4, ORCHID, ORCHIDv2, Drone, etc.).
      // Correct prefix: hextet1 == 0x2001 and hextet2 <= 0x01FF. Covers 2001:5::1, 2001:1a::1 (ORCHID 2001:10::/28 range 0x0010-0x001F), 2001:2a::1 (2001:20::/28 range 0x0020-0x002F).
      // Conservative whole-/23 block: ordinary web sources (e.g., 2001:4860::/32) have hextet2 >= 0x0200 and are unaffected.
      if (b[0] == 0x20 && b[1] == 0x01 && b[2] <= 0x01)
      {
        int hextet2 = (b[2] << 8) | b[3];
        if (hextet2 <= 0x01FF) return false;
      }
      if (b[0] == 0x20 && b[1] == 0x02) return false;
      if (b[0] == 0x26 && b[1] == 0x20 && b[2] == 0x04 && b[3] == 0x4F && b[4] == 0x80 && b[5] == 0x00) return false;
      // IANA documentation 3fff::/20 = 3fff:0000::-3fff:0fff:: (b0==0x3F,b1==0xFF,(b2&0xF0)==0x00).
      // Conservative: also block 3fff:1000::-3fff:1fff:: boundary (b2 0x10-0x1F) to avoid nibble-boundary misclassification;
      // no legitimate public evidence sources expected in 3fff::/16; required public IPs unaffected. Documented over-block.
      if (b[0] == 0x3F && b[1] == 0xFF && b[2] < 0x20) return false;
      if ((b[0] & 0xFE) == 0xFC) return false;
      if (b[0] == 0xFE && (b[1] & 0xC0) == 0x80) return false;
      if (b[0] == 0xFE && (b[1] & 0xC0) == 0xC0) return false;
      return true;
    }
    if (ip.AddressFamily != AddressFamily.InterNetwork) return false;
    var v4 = ip.GetAddressBytes();
    var a0 = v4[0]; var a1 = v4[1]; var a2 = v4[2];
    if (v4[0] == 0 && v4[1] == 0 && v4[2] == 0 && v4[3] == 0) return false;
    if (a0 == 0) return false;
    if (a0 == 10) return false;
    if (a0 == 127) return false;
    if (a0 == 169 && a1 == 254) return false;
    if (a0 == 172 && a1 >= 16 && a1 <= 31) return false;
    if (a0 == 192 && a1 == 168) return false;
    if (a0 == 192 && a1 == 0 && a2 == 0) return false;
    if (a0 == 192 && a1 == 0 && a2 == 2) return false;
    if (a0 == 192 && a1 == 88 && a2 == 99) return false;
    if (a0 == 192 && a1 == 18) return false;
    if (a0 == 198 && a1 == 18) return false;
    if (a0 == 198 && a1 == 19) return false;
    if (a0 == 198 && a1 == 51 && a2 == 100) return false;
    if (a0 == 203 && a1 == 0 && a2 == 113) return false;
    if (a0 == 100 && a1 >= 64 && a1 <= 127) return false;
    if (a0 >= 224 && a0 <= 239) return false;
    if (a0 >= 240) return false;
    if (a0 == 255 && a1 == 255 && v4[2] == 255 && v4[3] == 255) return false;
    return true;
  }

  public static async Task<byte[]> ReadBoundedAsync(HttpContent content, int maxBytes, CancellationToken ct)
  {
    ct.ThrowIfCancellationRequested();
    using var stream = await content.ReadAsStreamAsync(ct).ConfigureAwait(false);
    using var ms = new MemoryStream();
    var buf = new byte[8192];
    var total = 0;
    while (true)
    {
      int n;
      try { n = await stream.ReadAsync(buf.AsMemory(0, buf.Length), ct).ConfigureAwait(false); }
      catch (OperationCanceledException) { throw; }
      catch { return Array.Empty<byte>(); }
      if (n <= 0) break;
      ct.ThrowIfCancellationRequested();
      var room = maxBytes - total;
      if (room <= 0) break;
      var take = Math.Min(n, room);
      ms.Write(buf, 0, take);
      total += take;
      if (total >= maxBytes) break;
    }
    ct.ThrowIfCancellationRequested();
    return ms.ToArray();
  }

  internal static (string Title, string Excerpt) ExtractExcerpt(string body, string subject)
  {
    try { return ExtractExcerptAsync(body, subject, CancellationToken.None).GetAwaiter().GetResult(); }
    catch (OperationCanceledException) { return ("", ""); }
    catch { return ("", ""); }
  }

  internal static async Task<(string Title, string Excerpt)> ExtractExcerptAsync(string body, string subject, CancellationToken ct)
  {
    if (string.IsNullOrWhiteSpace(body)) return ("", "");
    using var budgetCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
    budgetCts.CancelAfter(TimeSpan.FromSeconds(3));
    ct = budgetCts.Token;
    ct.ThrowIfCancellationRequested();
    ct.ThrowIfCancellationRequested();
    string title = "";
    string visible;
    try
    {
      var parser = new HtmlParser();
      using var doc = await parser.ParseDocumentAsync(body, ct).ConfigureAwait(false);
      ct.ThrowIfCancellationRequested();
      try { title = (doc.Title ?? "").Trim(); } catch { title = ""; }
      if (title.Length > 200) title = title.Substring(0, 200).Trim();
      var bodyEl = doc.Body;
      if (bodyEl is null) return (title, "");
      INode? anc = bodyEl.Parent;
      while (anc is not null)
      {
        if (anc is IElement ancEl && IsHiddenElement(ancEl)) return (title, "");
        anc = anc.Parent;
      }
      var sb = new StringBuilder(8192);
      var stack = new Stack<(INode Node, bool Hidden)>();
      stack.Push((bodyEl, IsHiddenElement(bodyEl)));
      int visited = 0;
      while (stack.Count > 0)
      {
        if ((visited++ % 256) == 0) ct.ThrowIfCancellationRequested();
        if (visited > 60000) return (title, "");
        if (sb.Length > 200000) return (title, "");
        var (node, hidden) = stack.Pop();
        if (hidden) continue;
        if (node is IElement el)
        {
          var tag = el.TagName;
          if (tag == "SCRIPT" || tag == "STYLE" || tag == "NOSCRIPT" || tag == "TEMPLATE" ||
              tag == "NAV" || tag == "HEADER" || tag == "FOOTER" || tag == "ASIDE" ||
              tag == "TITLE" || tag == "HEAD" || tag == "BASE" || tag == "LINK" || tag == "META")
            continue;
          bool nowHidden = IsHiddenElement(el);
          if (nowHidden) continue;
          if (IsChallengeContainer(el)) continue;
          var children = el.ChildNodes;
          for (int i = children.Length - 1; i >= 0; i--)
            stack.Push((children[i], false));
        }
        else if (node.NodeType == NodeType.Text)
        {
          var t = node.TextContent;
          if (!string.IsNullOrWhiteSpace(t))
          {
            sb.Append(t);
            sb.Append(' ');
          }
        }
      }
      visible = CollapseWhitespace(sb.ToString());
    }
    catch (OperationCanceledException) { throw; }
    catch { return (title, ""); }
    if (visible.Length < 20) return (title, "");
    var tokens = GetSalientTokens(subject);
    if (tokens.Length == 0) return (title, "");
    var sentences = SplitSentences(visible, ct);
    if (sentences.Count == 0)
    {
      return (title, "");
    }
    var candidates = new List<string>(sentences.Count);
    foreach (var s in sentences)
    {
      ct.ThrowIfCancellationRequested();
      if (s.Length < 20) continue;
      if (IsChallengeSentence(s)) continue;
      candidates.Add(s);
    }
    if (candidates.Count == 0) return (title, "");
    string? best = null;
    var bestScore = -1;
    foreach (var s in candidates)
    {
      ct.ThrowIfCancellationRequested();
      var low = s.ToLowerInvariant();
      var score = 0;
      foreach (var k in tokens) if (low.Contains(k)) score++;
      if (score > bestScore || (score == bestScore && best is not null && s.Length < best.Length))
      { bestScore = score; best = s; }
    }
    if (bestScore <= 0 || best is null) return (title, "");
    var excerpt = best;
    if (excerpt.Length > MaxExcerptChars)
    {
      var trunc = excerpt.Substring(0, MaxExcerptChars).Trim();
      var sp = trunc.LastIndexOf(' ');
      if (sp > 200) trunc = trunc.Substring(0, sp).Trim();
      excerpt = trunc;
    }
    {
      var low = excerpt.ToLowerInvariant();
      bool any = false;
      foreach (var k in tokens) if (low.Contains(k)) { any = true; break; }
      if (!any) return (title, "");
    }
    if (excerpt.Length < 20) return (title, "");
    if (!visible.Contains(excerpt, StringComparison.Ordinal)) return (title, "");
    return (title, excerpt);
  }

  private static bool IsHiddenElement(IElement el)
  {
    try
    {
      if (el.HasAttribute("hidden")) return true;
      var ah = el.GetAttribute("aria-hidden");
      if (ah is not null && ah.Trim().Equals("true", StringComparison.OrdinalIgnoreCase)) return true;
      var style = el.GetAttribute("style");
      if (!string.IsNullOrEmpty(style))
      {
        var s = NormalizeStyleValue(style);
        if (s.Contains("display:none")) return true;
        if (s.Contains("visibility:hidden")) return true;
        if (s.Contains("visibility:collapse")) return true;
      }
    }
    catch { }
    return false;
  }

  private static string NormalizeStyleValue(string s)
  {
    if (string.IsNullOrEmpty(s)) return "";
    var sb = new StringBuilder(s.Length);
    int i = 0;
    while (i < s.Length)
    {
      char c = s[i];
      if (c == (char)47 && i + 1 < s.Length && s[i + 1] == (char)42)
      {
        int close = s.IndexOf("*/", i + 2, StringComparison.Ordinal);
        if (close < 0) break;
        i = close + 2;
        continue;
      }
      if (c == (char)32 || c == (char)9 || c == (char)10 || c == (char)12 || c == (char)13) { i++; continue; }
      sb.Append(char.ToLowerInvariant(c));
      i++;
    }
    return sb.ToString();
  }


  private static bool IsChallengeContainer(IElement el)
  {
    try
    {
      var cls = (el.ClassName ?? "") + " " + (el.Id ?? "");
      if (string.IsNullOrWhiteSpace(cls)) return false;
      var low = cls.ToLowerInvariant();
      if (low.Contains("paywall")) return true;
      if (low.Contains("captcha")) return true;
      if (low.Contains("cookie-consent")) return true;
      if (low.Contains("cookie-banner")) return true;
      if (low.Contains("challenge-wall")) return true;
    }
    catch { }
    return false;
  }

  private static readonly HashSet<string> Stopwords = new(StringComparer.OrdinalIgnoreCase)
  {
    "advisor", "advisors", "dossier", "dossiers", "research", "factual",
    "report", "reports", "analysis", "analyses", "overview", "overviews",
    "summary", "summaries", "briefing", "briefings", "boardroom", "board",
    "meeting", "meetings", "strategy", "strategist", "strategists", "strategies",
    "interview", "interviews", "roster", "rosters", "discussion", "discussions",
    "evidence", "excerpt", "excerpts", "citation", "citations", "subject",
    "subjects", "query", "queries", "prompt", "prompts", "instruction",
    "instructions", "task", "tasks", "grounded", "support", "supported",
    "supports", "claim", "claims", "answer", "answers", "final", "snippet",
    "snippets", "provider", "providers", "model", "models", "progress",
    "prose", "factuals", "detailed", "comprehensive", "thorough"
  };

  private static string[] GetSalientTokens(string? subject)
  {
    if (string.IsNullOrWhiteSpace(subject)) return Array.Empty<string>();
    var list = new List<string>();
    var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    var sb = new StringBuilder();
    void Flush()
    {
      if (sb.Length >= 4)
      {
        var w = sb.ToString().ToLowerInvariant();
        if (!Stopwords.Contains(w) && seen.Add(w)) list.Add(w);
      }
      sb.Clear();
    }
    var low = subject.ToLowerInvariant();
    foreach (var c in low)
    {
      if (c >= 'a' && c <= 'z') sb.Append(c);
      else Flush();
    }
    Flush();
    if (list.Count > 12) list = list.Take(12).ToList();
    return list.ToArray();
  }

  private static bool IsChallengeSentence(string s)
  {
    var low = s.ToLowerInvariant();
    if (low.Contains("subscribe to continue")) return true;
    if (low.Contains("premium article")) return true;
    if (low.Contains("continue reading") && (low.Contains("subscribe") || low.Contains("sign in") || low.Contains("log in") || low.Contains("premium"))) return true;
    if (low.Contains("sign in to continue")) return true;
    if (low.Contains("log in to continue")) return true;
    if (low.Contains("captcha")) return true;
    if (low.Contains("enable javascript")) return true;
    if (low.Contains("javascript") && low.Contains("continue")) return true;
    if (low.Contains("access denied")) return true;
    if (low.Contains("paywall")) return true;
    if (low.Contains("we use cookies")) return true;
    if (low.Contains("accept cookies")) return true;
    if (low.Contains("cookie consent")) return true;
    if (low.Contains("cookie policy")) return true;
    if (low.Contains("please log in")) return true;
    if (low.Contains("please sign in")) return true;
    if (low.Contains("page not found")) return true;
    if (low.Contains("something went wrong")) return true;
    if (low.Contains("404") && low.Contains("not found")) return true;
    return false;
  }

  private static string CollapseWhitespace(string s)
  {
    if (string.IsNullOrEmpty(s)) return "";
    var sb = new StringBuilder(s.Length);
    bool inWs = false;
    foreach (var c in s)
    {
      if (char.IsWhiteSpace(c)) { if (!inWs) { sb.Append(' '); inWs = true; } }
      else { sb.Append(c); inWs = false; }
    }
    return sb.ToString().Trim();
  }

  private static List<string> SplitSentences(string text, CancellationToken ct)
  {
    var result = new List<string>();
    var sb = new StringBuilder();
    for (int i = 0; i < text.Length; i++)
    {
      if ((i % 4096) == 0) ct.ThrowIfCancellationRequested();
      var c = text[i];
      sb.Append(c);
      if (c == '.' || c == '!' || c == '?')
      {
        if (i + 1 >= text.Length || char.IsWhiteSpace(text[i + 1]))
        {
          var s = sb.ToString().Trim();
          if (s.Length >= 20) result.Add(s);
          if (result.Count > 2000) break;
          sb.Clear();
        }
      }
      if (sb.Length > 6000)
      {
        var s = sb.ToString().Trim();
        if (s.Length >= 20) result.Add(s);
        sb.Clear();
        if (result.Count > 2000) break;
      }
    }
    var tail = sb.ToString().Trim();
    if (tail.Length >= 20) result.Add(tail);
    return result;
  }
}

// Bounded PUBLIC raster retrieval reusing the pinned-transport safety pattern:
// single DNS resolution with ALL-addresses-public enforcement (incl. IPv4-mapped
// IPv6 normalization), pinned TCP connect (no second DNS), whole-operation
// deadline covering DNS + headers + body, no redirects, no auth/cookies/proxy,
// streamed size cap, raster magic-byte validation, redacted errors.
public sealed class PublicImageFetcher
{
  public const int MaxImageBytes = 5 * 1024 * 1024;
  public static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(10);

  public static async Task<(byte[]? Data, string? ContentType)> FetchRasterAsync(string url, CancellationToken ct = default)
  {
    Uri uri;
    try { uri = new Uri(url, UriKind.Absolute); }
    catch { return (null, null); }
    if (!PublicEvidenceFetcher.IsStructureAllowed(uri, out _)) return (null, null);
    using var urlCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
    urlCts.CancelAfter(RequestTimeout);
    var bct = urlCts.Token;
    try
    {
      // Single resolution; EVERY resolved address must be public (mapped normalized).
      System.Net.IPAddress[] addrs;
      try { addrs = await System.Net.Dns.GetHostAddressesAsync(uri.Host, bct).ConfigureAwait(false); }
      catch { return (null, null); }
      if (addrs is null || addrs.Length == 0) return (null, null);
      var pinned = new System.Collections.Generic.List<System.Net.IPAddress>();
      foreach (var a in addrs)
      {
        var ip = a;
        if (ip.IsIPv4MappedToIPv6) { try { ip = ip.MapToIPv4(); } catch { return (null, null); } }
        if (!PublicEvidenceFetcher.IsPublicIp(ip)) return (null, null);
        pinned.Add(ip);
      }
      var handler = new System.Net.Http.SocketsHttpHandler
      {
        AllowAutoRedirect = false,
        AutomaticDecompression = System.Net.DecompressionMethods.GZip | System.Net.DecompressionMethods.Deflate,
        UseCookies = false,
        Credentials = null,
        UseProxy = false,
        Proxy = null,
      };
      handler.ConnectCallback = async (ctx, ctk) =>
      {
        var port = ctx.DnsEndPoint.Port;
        Exception? last = null;
        foreach (var ip in pinned)
        {
          var sock = new System.Net.Sockets.Socket(ip.AddressFamily, System.Net.Sockets.SocketType.Stream, System.Net.Sockets.ProtocolType.Tcp);
          try
          {
            await sock.ConnectAsync(ip, port, ctk).ConfigureAwait(false);
            return (System.IO.Stream)new System.Net.Sockets.NetworkStream(sock, ownsSocket: true);
          }
          catch (OperationCanceledException) { try { sock.Dispose(); } catch { } throw; }
          catch (Exception ex) { try { sock.Dispose(); } catch { } last = ex; }
        }
        throw last ?? new HttpRequestException("no validated endpoint reachable");
      };
      using var client = new HttpClient(handler) { Timeout = Timeout.InfiniteTimeSpan };
      using var req = new HttpRequestMessage(HttpMethod.Get, uri);
      req.Headers.UserAgent.ParseAdd("SimCEO-PublicImage/1.0");
      using var res = await client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, bct).ConfigureAwait(false);
      var status = (int)res.StatusCode;
      if (status is >= 300 and < 400) return (null, null); // redirects rejected, never followed
      if (!res.IsSuccessStatusCode) return (null, null);
      var media = res.Content.Headers.ContentType?.MediaType ?? "";
      if (!media.StartsWith("image/", StringComparison.OrdinalIgnoreCase)) return (null, null);
      byte[] bytes;
      try { bytes = await PublicEvidenceFetcher.ReadBoundedAsync(res.Content, MaxImageBytes, bct).ConfigureAwait(false); }
      catch { return (null, null); }
      if (bytes.Length == 0 || bytes.Length > MaxImageBytes) return (null, null);
      if (!HasRasterMagic(bytes)) return (null, null);
      return (bytes, media);
    }
    catch { return (null, null); }
  }

  public static bool HasRasterMagic(byte[] b)
  {
    try
    {
      if (b.Length >= 8 && b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47) return true; // PNG
      if (b.Length >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF) return true; // JPEG
      if (b.Length >= 6 && b[0] == 0x47 && b[1] == 0x49 && b[2] == 0x46 && b[3] == 0x38) return true; // GIF
      if (b.Length >= 12 && b[0] == 0x52 && b[1] == 0x49 && b[2] == 0x46 && b[3] == 0x46
        && b[8] == 0x57 && b[9] == 0x45 && b[10] == 0x42 && b[11] == 0x50) return true; // WEBP
      if (b.Length >= 2 && b[0] == 0x42 && b[1] == 0x4D) return true; // BMP
      return false;
    }
    catch { return false; }
  }
}
