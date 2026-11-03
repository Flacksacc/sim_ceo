using System.Net;
using System.Text;
using System.Text.Json;

namespace SimCEO.Api.Work;

// Pinned official Wiki.js v2.5.314 protocol (read-only).
// Docs: https://github.com/requarks/wiki-docs-v2/blob/master/dev/api.md
//   POST {origin}/graphql with Bearer token; variables supported.
// Pinned schema:
//   https://github.com/requarks/wiki/v2.5.314/blob/main/server/graph/schemas/page.graphql
// Pinned resolver:
//   https://github.com/requarks/wiki/v2.5.314/blob/main/server/graph/resolvers/page.js
// The connector emits ONLY these two fixed queries; never any mutation.
//   pages.list(limit, orderBy:PATH, orderByDirection:ASC, tags, locale) -> PageListItem
//     { id path locale title tags }  (list tags are plain strings)
//   pages.single(id) -> Page
//     { id path locale title content contentType updatedAt tags { tag } }
//     (single tags are objects with .tag, unlike list tags)
// Fixed enum literals orderBy:PATH / orderByDirection:ASC are used (never a
// String-typed orderBy variable): Wiki.js declares PageOrderBy enum
// (ID/PATH/TITLE/UPDATED/CREATED); a String variable would fail schema
// validation against the real server. The fixture SDL validator enforces this.
// content requires read:source in addition to read:pages. The historical v2.5.314
// single resolver can ALSO demand manage:pages/delete:pages even for reads, so
// a token with only read scopes may get 403 on single; surface that as an
// actionable permission failure and document the upstream limitation:
// https://github.com/requarks/wiki/discussions/6672
// No Wiki.js v3 REST claim is made here.
public static class WikiQueries
{
  // NOTE: orderBy/orderByDirection are emitted as enum LITERALS (PATH/ASC),
  // not String variables, per the pinned v2.5.314 SDL (PageOrderBy enum).
  public const string List = "query WikiList($limit: Int $tags: [String!] $locale: String) { pages { list(limit: $limit orderBy: PATH orderByDirection: ASC tags: $tags locale: $locale) { id path locale title tags } } }";
  public const string Single = "query WikiSingle($id: Int!) { pages { single(id: $id) { id path locale title content contentType updatedAt tags { tag } } } }";
}

public sealed record WikiListItem(int Id, string Path, string Locale, string Title, List<string> Tags);
public sealed record WikiPage(int Id, string Path, string Locale, string Title, string Content, string ContentType, string UpdatedAt, List<string> Tags);

public sealed class WikiGraphQlException : Exception
{
  public int StatusCode { get; }
  public string Kind { get; }
  // Upstream HTTP status when relevant (e.g. 401/403 from Wiki); mapped to a
  // safe connector status at the sync boundary (never app 401/403).
  public int UpstreamStatus { get; }
  public WikiGraphQlException(string kind, int status, string message, int upstream = 0) : base(message) { Kind = kind; StatusCode = status; UpstreamStatus = upstream; }
  // Never echo provider bodies/tokens: fixed short prefix only.
  public static string Sanitize(string? raw, int max = 120)
  {
    var t = (raw ?? "").Trim();
    if (t.Length == 0) return "Wiki request failed.";
    t = WikiUrl.ScrubSecrets(t);
    t = t.Replace("\r", " ").Replace("\n", " ");
    if (t.Length > max) t = t.Substring(0, max);
    return t;
  }
}

// Bounded read-only GraphQL transport. Redirects disabled (no credential
// forwarding), no ambient proxy/cookies/default auth. Credential is sent only
// to the configured origin/base /graphql endpoint.
//
// Ownership: each client instance owns its HttpClient and underlying handler.
// The optional test handler factory must supply a per-attempt owned handler
// (or null for the default isolated handler); disposing the client disposes
// both. Every sync attempt must dispose its client on all paths.
public sealed class WikiGraphQlClient : IDisposable
{
  public const int ListLimitSentinel = 101; // supported maximum 100 + 1 sentinel; fail closed when exceeded
  public const int MaxBytesPerPage = 256 * 1024; // per-page content bound (documented fixed bound)
  public const int MaxBytesPerResponse = 1024 * 1024; // per-response HTTP body bound (documented fixed bound)
  public const int MaxAggregateBytes = 8 * 1024 * 1024; // whole-sync aggregate incl. catalog+content
  public static readonly TimeSpan PerFetchTimeout = TimeSpan.FromSeconds(8);

  private readonly HttpClient _http;
  private readonly string _origin;
  private long _responseBytes;

  public WikiGraphQlClient(string origin, string? bearerToken, HttpMessageHandler? testHandler = null)
  {
    _origin = origin.TrimEnd('/');
    HttpMessageHandler chain = testHandler ?? new SocketsHttpHandler
    {
      AllowAutoRedirect = false,
      UseProxy = false,
      UseCookies = false,
      AutomaticDecompression = DecompressionMethods.None,
    };
    _http = new HttpClient(chain, disposeHandler: true) { Timeout = Timeout.InfiniteTimeSpan };
    if (!string.IsNullOrEmpty(bearerToken))
      _http.DefaultRequestHeaders.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", bearerToken);
  }

  public string Origin => _origin;
  public string Endpoint => _origin + "/graphql";
  public long TotalResponseBytes => Interlocked.Read(ref _responseBytes);

  public void Dispose() => _http.Dispose();

  private static async Task<string> ReadBoundedAsync(HttpContent content, int maxBytes, CancellationToken ct)
  {
    var len = content.Headers.ContentLength;
    if (len.HasValue && len.Value > maxBytes)
      throw new WikiGraphQlException("oversize", 502, "Wiki response exceeds the 1 MiB per-response bound; narrow the resource rules.");
    using var stream = await content.ReadAsStreamAsync(ct).ConfigureAwait(false);
    using var ms = new MemoryStream();
    var buf = new byte[8192];
    var total = 0;
    int n;
    try
    {
      while ((n = await stream.ReadAsync(buf, 0, buf.Length, ct).ConfigureAwait(false)) > 0)
      {
        total += n;
        if (total > maxBytes)
          throw new WikiGraphQlException("oversize", 502, "Wiki response exceeds the 1 MiB per-response bound; narrow the resource rules.");
        ms.Write(buf, 0, n);
      }
    }
    catch (OperationCanceledException)
    {
      throw new WikiGraphQlException("timeout", 504, "Wiki fetch timed out (body/whole-operation deadline of 8s per fetch).");
    }
    return Encoding.UTF8.GetString(ms.ToArray());
  }

  private async Task<(JsonElement data, int byteCount)> PostAsync(string query, object variables, CancellationToken ct)
  {
    using var opCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
    opCts.CancelAfter(PerFetchTimeout);
    var oct = opCts.Token;
    var body = JsonSerializer.Serialize(new { query, variables });
    using var req = new HttpRequestMessage(HttpMethod.Post, Endpoint);
    req.Content = new StringContent(body, Encoding.UTF8, "application/json");
    HttpResponseMessage resp;
    try { resp = await _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, oct).ConfigureAwait(false); }
    catch (OperationCanceledException) { throw new WikiGraphQlException("timeout", 504, "Wiki fetch timed out (8s per-fetch deadline)."); }
    catch (Exception) { throw new WikiGraphQlException("network", 502, "Wiki request failed (network)."); }
    using (resp) { return await ReadBoundedResponseAsync(resp, oct, ct).ConfigureAwait(false); }
  }

  private async Task<(JsonElement data, int byteCount)> ReadBoundedResponseAsync(HttpResponseMessage resp, CancellationToken oct, CancellationToken ct)
  {
    // Redirects are never followed for credentialed GraphQL (no token forwarding).
    if ((int)resp.StatusCode is 301 or 302 or 303 or 307 or 308)
      throw new WikiGraphQlException("redirect", 502, "Wiki endpoint redirected; redirects are disabled for credentialed requests and the token was not forwarded.");
    string text;
    try { text = await ReadBoundedAsync(resp.Content, MaxBytesPerResponse, oct).ConfigureAwait(false); }
    catch (WikiGraphQlException) { throw; }
    catch (OperationCanceledException) { throw new WikiGraphQlException("timeout", 504, "Wiki fetch timed out (body/whole-operation deadline)."); }
    catch (Exception) { throw new WikiGraphQlException("network", 502, "Wiki request failed (body)."); }
    var bytes = Encoding.UTF8.GetByteCount(text);
    Interlocked.Add(ref _responseBytes, bytes);
    if (ct.IsCancellationRequested) throw new WikiGraphQlException("timeout", 504, "Wiki fetch cancelled (whole-operation deadline).");
    if (oct.IsCancellationRequested) throw new WikiGraphQlException("timeout", 504, "Wiki fetch timed out (whole-operation deadline).");
    if (resp.StatusCode == HttpStatusCode.Forbidden)
      throw new WikiGraphQlException("permission", 502, "Wiki connector permission denied (upstream 403: the v2.5.314 single resolver can require manage:pages/delete:pages even for reads; grant the token sufficient scope on that Wiki version).", 403);
    if (resp.StatusCode == HttpStatusCode.Unauthorized)
      throw new WikiGraphQlException("auth", 502, "Wiki connector authentication failed (upstream 401: reconfigure the resource credential).", 401);
    if (!resp.IsSuccessStatusCode)
      throw new WikiGraphQlException("http", 502, "Wiki connector request failed (upstream HTTP " + (int)resp.StatusCode + ").", (int)resp.StatusCode);
    JsonDocument doc;
    try { doc = JsonDocument.Parse(text); }
    catch { throw new WikiGraphQlException("malformed", 502, "Wiki returned malformed GraphQL JSON."); }
    using (doc)
    {
      var root = doc.RootElement.Clone();
      if (root.TryGetProperty("errors", out var errs) && errs.ValueKind == JsonValueKind.Array && errs.GetArrayLength() > 0)
        throw new WikiGraphQlException("graphql", 502, "Wiki GraphQL query failed.");
      if (!root.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object)
        throw new WikiGraphQlException("malformed", 502, "Wiki returned malformed GraphQL JSON (missing data).");
      return (data.Clone(), bytes);
    }
  }

  public async Task<List<WikiListItem>> ListPagesAsync(List<string> tags, string locale, CancellationToken ct)
  {
    object vars = new Dictionary<string, object?>
    {
      ["limit"] = ListLimitSentinel,
      ["tags"] = tags,
      ["locale"] = string.IsNullOrWhiteSpace(locale) ? null : locale.Trim(),
    };
    var (data, _) = await PostAsync(WikiQueries.List, vars, ct).ConfigureAwait(false);
    if (!data.TryGetProperty("pages", out var pages) || !pages.TryGetProperty("list", out var list) || list.ValueKind != JsonValueKind.Array)
      throw new WikiGraphQlException("malformed", 502, "Wiki returned malformed pages.list shape.");
    var out_ = new List<WikiListItem>();
    foreach (var el in list.EnumerateArray())
    {
      if (el.ValueKind != JsonValueKind.Object) throw new WikiGraphQlException("malformed", 502, "Wiki returned malformed pages.list shape.");
      if (!el.TryGetProperty("id", out var idEl) || idEl.ValueKind != JsonValueKind.Number || !idEl.TryGetInt32(out var id))
        throw new WikiGraphQlException("malformed", 502, "Wiki returned malformed pages.list shape (id).");
      var path = el.TryGetProperty("path", out var p) && p.ValueKind == JsonValueKind.String ? (p.GetString() ?? "") : "";
      var loc = el.TryGetProperty("locale", out var l) && l.ValueKind == JsonValueKind.String ? (l.GetString() ?? "") : "";
      var title = el.TryGetProperty("title", out var t) && t.ValueKind == JsonValueKind.String ? (t.GetString() ?? "") : "";
      if (string.IsNullOrWhiteSpace(path)) throw new WikiGraphQlException("malformed", 502, "Wiki returned malformed pages.list shape (path).");
      var tagsOut = new List<string>();
      if (el.TryGetProperty("tags", out var tg))
      {
        if (tg.ValueKind != JsonValueKind.Array) throw new WikiGraphQlException("malformed", 502, "Wiki returned malformed pages.list shape (tags).");
        foreach (var x in tg.EnumerateArray())
        {
          if (x.ValueKind != JsonValueKind.String) throw new WikiGraphQlException("malformed", 502, "Wiki returned malformed pages.list shape (tags must be strings).");
          tagsOut.Add(x.GetString() ?? "");
        }
      }
      out_.Add(new WikiListItem(id, path, loc, title, tagsOut));
    }
    return out_;
  }

  public async Task<(WikiPage page, int byteCount)> SinglePageAsync(int id, CancellationToken ct)
  {
    var (data, bytes) = await PostAsync(WikiQueries.Single, new Dictionary<string, object?> { ["id"] = id }, ct).ConfigureAwait(false);
    if (!data.TryGetProperty("pages", out var p2) || !p2.TryGetProperty("single", out var s) || s.ValueKind != JsonValueKind.Object)
      throw new WikiGraphQlException("malformed", 502, "Wiki returned malformed pages.single shape.");
    string ReqStr(string name)
    {
      if (!s.TryGetProperty(name, out var e) || e.ValueKind != JsonValueKind.String)
        throw new WikiGraphQlException("malformed", 502, "Wiki returned malformed pages.single shape (" + name + " must be a string).");
      return e.GetString() ?? "";
    }
    if (!s.TryGetProperty("id", out var idEl) || idEl.ValueKind != JsonValueKind.Number || !idEl.TryGetInt32(out var sid))
      throw new WikiGraphQlException("malformed", 502, "Wiki returned malformed pages.single shape (id).");
    // Strict identity: requested ID must match returned ID.
    if (sid != id)
      throw new WikiGraphQlException("malformed", 502, "Wiki returned mismatched page identity (requested " + id + " got " + sid + "); sync failed closed.");
    var path = ReqStr("path");
    var locale = ReqStr("locale");
    var title = ReqStr("title");
    // content is REQUIRED: missing/null/empty is malformed and fails the whole attempt
    // (an unindexable selected page must not silently become an empty usable page).
    if (!s.TryGetProperty("content", out var cEl) || cEl.ValueKind != JsonValueKind.String)
      throw new WikiGraphQlException("malformed", 502, "Wiki returned malformed pages.single shape (content is required).");
    var content = cEl.GetString() ?? "";
    var contentType = s.TryGetProperty("contentType", out var ctEl) && ctEl.ValueKind == JsonValueKind.String ? (ctEl.GetString() ?? "") : "";
    var updatedAt = s.TryGetProperty("updatedAt", out var uEl) && uEl.ValueKind == JsonValueKind.String ? (uEl.GetString() ?? "") : "";
    var tagsOut = new List<string>();
    if (!s.TryGetProperty("tags", out var tg) || tg.ValueKind != JsonValueKind.Array)
      throw new WikiGraphQlException("malformed", 502, "Wiki returned malformed pages.single shape (tags must be [{tag}] objects).");
    foreach (var x in tg.EnumerateArray())
    {
      // Strict official shape: single.tags are OBJECTS with .tag; bare strings rejected.
      if (x.ValueKind != JsonValueKind.Object || !x.TryGetProperty("tag", out var tv) || tv.ValueKind != JsonValueKind.String)
        throw new WikiGraphQlException("malformed", 502, "Wiki returned malformed pages.single shape (tags must be objects with string tag).");
      tagsOut.Add(tv.GetString() ?? "");
    }
    if (string.IsNullOrWhiteSpace(path)) throw new WikiGraphQlException("malformed", 502, "Wiki returned malformed pages.single shape (path).");
    if (content.Length == 0)
      throw new WikiGraphQlException("malformed", 502, "Wiki returned empty content for page " + sid + "; sync failed closed.");
    // No per-page content bound here by design: oversized content must still
    // be counted toward the whole-sync aggregate and pass the fresh rule
    // recheck first (rejected singles count toward the bound but never
    // commit). WikiSync enforces the 256 KiB per-page bound AFTER the recheck;
    // the 1 MiB per-response HTTP body bound above still caps transport (F13).
    return (new WikiPage(sid, path, locale, title, content, contentType, updatedAt, tagsOut), bytes);
  }
}


