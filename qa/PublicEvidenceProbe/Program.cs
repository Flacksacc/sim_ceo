using System.Net;
using System.Text;
using System.Diagnostics;
using System.Reflection;
using System.Threading;
using SimCEO.Api.Data;
using SimCEO.Api.Work;

static class Probe
{
  static int pass = 0;
  static int fail = 0;
  static readonly List<string> lines = new();
  static readonly List<string> runtimes = new();

  static void Ok(string name, bool cond, string extra = "")
  {
    if (cond) { pass++; lines.Add("PASS " + name); Console.WriteLine("PASS " + name); }
    else { fail++; lines.Add("FAIL " + name + (extra == "" ? "" : " :: " + extra)); Console.WriteLine("FAIL " + name + (extra == "" ? "" : " :: " + extra)); }
  }

  sealed class FakeHandler : HttpMessageHandler
  {
    public readonly List<HttpRequestMessage> Seen = new();
    public readonly Dictionary<string, int> CallsByPath = new(StringComparer.OrdinalIgnoreCase);
    public int Peak = 0;
    int cur = 0;
    public Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>> ResponderAsync = (_, __) => Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
      int c = Interlocked.Increment(ref cur);
      lock (Seen) { if (c > Peak) Peak = c; Seen.Add(CloneMsg(request)); var p = request.RequestUri?.AbsolutePath ?? "/"; CallsByPath[p] = CallsByPath.TryGetValue(p, out var n) ? n + 1 : 1; }
      try
      {
        ct.ThrowIfCancellationRequested();
        var res = await ResponderAsync(request, ct).ConfigureAwait(false);
        res.RequestMessage = request;
        return res;
      }
      finally { Interlocked.Decrement(ref cur); }
    }

    static HttpRequestMessage CloneMsg(HttpRequestMessage r, bool dummy = true)
    {
      var c = new HttpRequestMessage(r.Method, r.RequestUri);
      foreach (var h in r.Headers) c.Headers.TryAddWithoutValidation(h.Key, h.Value);
      return c;
    }
  }

  sealed class StallStream : Stream
  {
    readonly byte[] prefix; int pos = 0; readonly int stallMs;
    public StallStream(byte[] prefix, int stallMs) { this.prefix = prefix; this.stallMs = stallMs; }
    public override bool CanRead => true;
    public override bool CanSeek => false;
    public override bool CanWrite => false;
    public override long Length => throw new NotSupportedException();
    public override long Position { get => pos; set => throw new NotSupportedException(); }
    public override void Flush() { }
    public override int Read(byte[] buffer, int offset, int count) => ReadAsync(buffer, offset, count).GetAwaiter().GetResult();
    public override async Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken ct)
    {
      if (pos < prefix.Length)
      {
        int n = Math.Min(count, prefix.Length - pos);
        Array.Copy(prefix, pos, buffer, offset, n);
        pos += n;
        return n;
      }
      await Task.Delay(stallMs, ct).ConfigureAwait(false);
      return 0;
    }
    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default)
    {
      if (pos < prefix.Length)
      {
        int n = Math.Min(buffer.Length, prefix.Length - pos);
        prefix.AsSpan(pos, n).CopyTo(buffer.Span);
        pos += n;
        return n;
      }
      await Task.Delay(stallMs, ct).ConfigureAwait(false);
      return 0;
    }
    public override long Seek(long o, SeekOrigin org) => throw new NotSupportedException();
    public override void SetLength(long v) => throw new NotSupportedException();
    public override void Write(byte[] b, int o, int c) => throw new NotSupportedException();
  }

  sealed class StallContent : HttpContent
  {
    readonly byte[] prefix; readonly int stallMs;
    public StallContent(byte[] prefix, int stallMs) { this.prefix = prefix; this.stallMs = stallMs; }
    protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context) => Task.CompletedTask;
    protected override bool TryComputeLength(out long length) { length = -1; return false; }
    protected override Task<Stream> CreateContentReadStreamAsync() => Task.FromResult<Stream>(new StallStream(prefix, stallMs));
  }

  static int Main(string[] args) => RunAsync().GetAwaiter().GetResult();

  static async Task<int> RunAsync()
  {
    var articleHtml = "<html><head><title>Example Grocer Logistics Report</title></head><body>"
      + "<nav>Home Menu Search Login Boilerplate Links</nav>"
      + "<script>secret-token-xyz should never appear in excerpt</script>"
      + "<style>.hidden { display:none } secret-style-abc</style>"
      + "<!-- secret-comment-def should never appear -->"
      + "<article><h1>Regional grocer delivery costs</h1>"
      + "<p>Regional grocers cut last-mile delivery costs with denser routes, balanced warehouse staffing, and cold-chain reliability. This sentence carries the logistics tradeoff keywords for relevance.</p>"
      + "<p>Second paragraph with extra detail about route density and staffing tradeoffs for regional grocers.</p>"
      + "</article></body></html>";
    var subject = "regional grocer last-mile delivery costs logistics route density warehouse staffing cold-chain";

    IPAddress pub = IPAddress.Parse("93.184.216.34");
    IPAddress priv10 = IPAddress.Parse("10.0.0.5");
    Task<IPAddress[]> DnsFor(string host, CancellationToken ct)
    {
      var h = (host ?? "").ToLowerInvariant();
      if (h == "example.com") return Task.FromResult(new[] { pub });
      if (h == "mixed.example.com") return Task.FromResult(new[] { pub, priv10 });
      if (h == "private.example.com") return Task.FromResult(new[] { priv10 });
      return Task.FromResult(new[] { pub });
    }

    // 1: visible-text real excerpt (single URL)
    {
      var fake = new FakeHandler();
      fake.ResponderAsync = (req, ct) =>
      {
        var p = req.RequestUri?.AbsolutePath ?? "/";
        if (p == "/article") return Task.FromResult(Html(articleHtml));
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
      };
      var f = new PublicEvidenceFetcher(fake, DnsFor);
      var cites = new List<ModelGateway.Citation> { new("https://example.com/article", "Orig Title", "") };
      var out1 = await f.HydrateAsync(cites, subject, CancellationToken.None);
      var ex = out1[0].Excerpt ?? "";
      Ok("visible-text-excerpt-nonempty", ex.Trim().Length >= 20, "len=" + ex.Length);
      Ok("visible-text-leaks-none", !ex.Contains("secret-token-xyz") && !ex.Contains("secret-style-abc") && !ex.Contains("secret-comment-def") && !ex.Contains("Boilerplate"), ex.Substring(0, Math.Min(200, ex.Length)));
      Ok("visible-text-relevant-keywords", ex.ToLowerInvariant().Contains("grocer") || ex.ToLowerInvariant().Contains("delivery") || ex.ToLowerInvariant().Contains("logistics"), ex.Substring(0, Math.Min(200, ex.Length)));
      Ok("visible-text-bound-320", ex.Length <= 320, "len=" + ex.Length);
      Ok("visible-text-no-html", !ex.Contains("<") && !ex.Contains(">") && !ex.Contains("  "), "has-tags");
      Ok("title-preserved-when-present", out1[0].Title == "Orig Title", "title=" + out1[0].Title);
      Ok("url-preserved", out1[0].Url == "https://example.com/article", out1[0].Url);
    }

    // A long punctuation-free infobox must not push the useful paragraph
    // beyond the excerpt cap, as happened with the real Holmes owner page.
    {
      const string quote = "Sherlock Holmes is a fictional detective created by British author Arthur Conan Doyle.";
      var fake = new FakeHandler();
      var html = "<html><body><table><tr><td>Sherlock Holmes metadata " + new string('x', 600)
        + "</td></tr></table><p>" + quote + "</p></body></html>";
      fake.ResponderAsync = (_, _) => Task.FromResult(Html(html));
      var f = new PublicEvidenceFetcher(fake, DnsFor);
      var hydrated = await f.HydrateAsync(new List<ModelGateway.Citation> { new("https://example.com/holmes", "", "") }, "Sherlock Holmes fictional detective Arthur Conan Doyle", CancellationToken.None);
      var passage = hydrated[0].Excerpt ?? "";
      Ok("paragraph-after-infobox-retained", passage.Contains(quote), passage);
      Ok("paragraph-no-infobox-prefix", !passage.Contains("metadata") && passage.Length <= 320, "len=" + passage.Length);
      var pool = new Dictionary<string, (string Title, string Excerpt)> { ["https://example.com/holmes"] = ("Holmes", passage) };
      var claim = ClaimEvidenceMapper.MapOne("FACT | Doyle created Holmes || EVIDENCE: S1 :: \"" + quote + "\"", pool, new Dictionary<string, string> { ["S1"] = "https://example.com/holmes" });
      Ok("paragraph-quote-verifies-claim", claim.Verified, "verified=" + claim.Verified);
    }

    // 2: empty body and 404 stay empty (2 URLs, within budget)
    {
      var fake = new FakeHandler();
      fake.ResponderAsync = (req, ct) =>
      {
        var p = req.RequestUri?.AbsolutePath ?? "/";
        if (p == "/empty") return Task.FromResult(Html(""));
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
      };
      var f = new PublicEvidenceFetcher(fake, DnsFor);
      var cites = new List<ModelGateway.Citation>
      {
        new("https://example.com/empty", "E", ""),
        new("https://example.com/missing", "M", ""),
      };
      var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
      Ok("empty-body-stays-empty", string.IsNullOrWhiteSpace(o[0].Excerpt), "ex=" + (o[0].Excerpt ?? ""));
      Ok("notfound-stays-empty", string.IsNullOrWhiteSpace(o[1].Excerpt), "ex=" + (o[1].Excerpt ?? ""));
    }

    // 3: provider excerpt present => no fetch
    {
      var fake = new FakeHandler();
      var calls = 0;
      fake.ResponderAsync = (req, ct) => { calls++; return Task.FromResult(Html(articleHtml)); };
      var f = new PublicEvidenceFetcher(fake, DnsFor);
      var cites = new List<ModelGateway.Citation> { new("https://example.com/article", "T", "Provider supplied snippet already present.") };
      var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
      Ok("provider-excerpt-preserved", o[0].Excerpt == "Provider supplied snippet already present.", o[0].Excerpt);
      Ok("provider-excerpt-no-fetch", calls == 0 && fake.Seen.Count == 0, "calls=" + calls);
    }

    // 4: redirect to private blocked (single URL)
    {
      var fake = new FakeHandler();
      fake.ResponderAsync = (req, ct) =>
      {
        var p = req.RequestUri?.AbsolutePath ?? "/";
        if (p == "/redirect-private") return Task.FromResult(Redirect("https://192.168.1.10/secret"));
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
      };
      var f = new PublicEvidenceFetcher(fake, DnsFor);
      var cites = new List<ModelGateway.Citation> { new("https://example.com/redirect-private", "R", "") };
      var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
      Ok("redirect-private-blocked-empty", string.IsNullOrWhiteSpace(o[0].Excerpt), "ex=" + (o[0].Excerpt ?? ""));
      var sawPrivate = false;
      lock (fake.Seen) { foreach (HttpRequestMessage r in fake.Seen) if (((string)(r.RequestUri?.Host ?? "")).Contains("192.168")) sawPrivate = true; }
      Ok("redirect-private-never-fetched", !sawPrivate, "private-host-requested");
    }

    // 5: good redirect succeeds (single URL)
    {
      var fake = new FakeHandler();
      fake.ResponderAsync = (req, ct) =>
      {
        var p = req.RequestUri?.AbsolutePath ?? "/";
        if (p == "/redirect-good") return Task.FromResult(Redirect("https://example.com/article"));
        if (p == "/article") return Task.FromResult(Html(articleHtml));
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
      };
      var f = new PublicEvidenceFetcher(fake, DnsFor);
      var cites = new List<ModelGateway.Citation> { new("https://example.com/redirect-good", "", "") };
      var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
      Ok("redirect-good-hydrated", !string.IsNullOrWhiteSpace(o[0].Excerpt) && o[0].Excerpt.Length <= 320, "ex-len=" + (o[0].Excerpt ?? "").Length);
      Ok("redirect-good-title-from-page", !string.IsNullOrWhiteSpace(o[0].Title), "title=" + (o[0].Title ?? ""));
    }

    // 6: redirect chain exceeds max 2 => empty (single URL)
    {
      var fake = new FakeHandler();
      fake.ResponderAsync = (req, ct) =>
      {
        var p = req.RequestUri?.AbsolutePath ?? "/";
        if (p == "/chain-a") return Task.FromResult(Redirect("https://example.com/chain-b"));
        if (p == "/chain-b") return Task.FromResult(Redirect("https://example.com/chain-c"));
        if (p == "/chain-c") return Task.FromResult(Redirect("https://example.com/article"));
        if (p == "/article") return Task.FromResult(Html(articleHtml));
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
      };
      var f = new PublicEvidenceFetcher(fake, DnsFor);
      var cites = new List<ModelGateway.Citation> { new("https://example.com/chain-a", "C", "") };
      var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
      Ok("redirect-chain-bound-empty", string.IsNullOrWhiteSpace(o[0].Excerpt), "ex=" + (o[0].Excerpt ?? ""));
    }

    // 7: mixed DNS (one private answer) blocked before fetch (single URL)
    {
      var fake = new FakeHandler();
      var called = 0;
      fake.ResponderAsync = (req, ct) => { called++; return Task.FromResult(Html(articleHtml)); };
      var f = new PublicEvidenceFetcher(fake, DnsFor);
      var cites = new List<ModelGateway.Citation> { new("https://mixed.example.com/article", "M", "") };
      var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
      Ok("mixed-dns-private-blocked-empty", string.IsNullOrWhiteSpace(o[0].Excerpt), "ex=" + (o[0].Excerpt ?? ""));
      Ok("mixed-dns-no-fetch", called == 0, "calls=" + called);
    }

    // 8a: literal privates blocked, 3 URLs only (no mask)
    {
      var fake = new FakeHandler();
      var called = 0;
      fake.ResponderAsync = (req, ct) => { called++; return Task.FromResult(Html(articleHtml)); };
      var f = new PublicEvidenceFetcher(fake, DnsFor);
      var cites = new List<ModelGateway.Citation>
      {
        new("http://127.0.0.1/secret", "L", ""),
        new("http://10.0.0.1/x", "P", ""),
        new("http://[::1]/x", "V6", ""),
      };
      var o = await f.HydrateAsync(cites, "grocer logistics", CancellationToken.None);
      var allEmpty = true;
      foreach (var c in o) if (!string.IsNullOrWhiteSpace(c.Excerpt)) allEmpty = false;
      Ok("literal-private-blocked-3", allEmpty, "some-excerpt-filled");
      Ok("literal-private-no-fetch", called == 0, "calls=" + called);
    }

    // 8b: userinfo + port + scheme blocked, 3 URLs only (separate call, no mask)
    {
      var fake = new FakeHandler();
      var called = 0;
      fake.ResponderAsync = (req, ct) => { called++; return Task.FromResult(Html(articleHtml)); };
      var f = new PublicEvidenceFetcher(fake, DnsFor);
      var cites = new List<ModelGateway.Citation>
      {
        new("https://user:pass@example.com/article", "C", ""),
        new("https://example.com:8443/article", "Port", ""),
        new("ftp://example.com/article", "F", ""),
      };
      var o = await f.HydrateAsync(cites, "grocer logistics", CancellationToken.None);
      var allEmpty = true;
      foreach (var c in o) if (!string.IsNullOrWhiteSpace(c.Excerpt)) allEmpty = false;
      Ok("cred-port-scheme-blocked-3", allEmpty, "some-excerpt-filled");
      Ok("cred-port-scheme-no-fetch", called == 0, "calls=" + called);
    }

    // 9: byte bound (large body truncated, excerpt still bounded) (single URL)
    {
      var fake = new FakeHandler();
      var big = "<html><head><title>Big Report</title></head><body><article><p>Regional grocers cut last-mile delivery costs with denser routes, balanced warehouse staffing, and cold-chain reliability.</p><p>" + new string((char)77, 300 * 1024) + "</p></article></body></html>";
      fake.ResponderAsync = (req, ct) => Task.FromResult(Html(big));
      var f = new PublicEvidenceFetcher(fake, DnsFor);
      var cites = new List<ModelGateway.Citation> { new("https://example.com/article", "B", "") };
      var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
      var ex = o[0].Excerpt ?? "";
      Ok("byte-bound-excerpt-320", ex.Length <= 320 && ex.Length >= 20, "len=" + ex.Length);
    }
    // 10: bounds constants (5s, 256KiB, 2 redirects, concurrency 2, 3 urls, 320 chars)
    {
      Ok("bound-request-timeout-5s", PublicEvidenceFetcher.RequestTimeout == TimeSpan.FromSeconds(5), PublicEvidenceFetcher.RequestTimeout.ToString());
      Ok("bound-max-bytes-256kib", PublicEvidenceFetcher.MaxBytesPerBody == 256 * 1024, PublicEvidenceFetcher.MaxBytesPerBody.ToString());
      Ok("bound-max-redirects-2", PublicEvidenceFetcher.MaxRedirects == 2, PublicEvidenceFetcher.MaxRedirects.ToString());
      Ok("bound-max-concurrency-2", PublicEvidenceFetcher.MaxConcurrency == 2, PublicEvidenceFetcher.MaxConcurrency.ToString());
      Ok("bound-max-urls-3", PublicEvidenceFetcher.MaxUrlsPerCall == 3, PublicEvidenceFetcher.MaxUrlsPerCall.ToString());
      Ok("bound-max-excerpt-320", PublicEvidenceFetcher.MaxExcerptChars == 320, PublicEvidenceFetcher.MaxExcerptChars.ToString());
    }

    // 11: no Authorization/Cookie forwarding (single redirect URL)
    {
      var fake = new FakeHandler();
      fake.ResponderAsync = (req, ct) =>
      {
        var p = req.RequestUri?.AbsolutePath ?? "/";
        if (p == "/redirect-good") return Task.FromResult(Redirect("https://example.com/article"));
        if (p == "/article") return Task.FromResult(Html(articleHtml));
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound));
      };
      var f = new PublicEvidenceFetcher(fake, DnsFor);
      var cites = new List<ModelGateway.Citation> { new("https://example.com/redirect-good", "", "") };
      await f.HydrateAsync(cites, subject, CancellationToken.None);
      var leak = false;
      lock (fake.Seen)
      {
        foreach (HttpRequestMessage r in fake.Seen)
        {
          foreach (var h in r.Headers) if (h.Key.Equals("Authorization", StringComparison.OrdinalIgnoreCase) || h.Key.Equals("Cookie", StringComparison.OrdinalIgnoreCase)) leak = true;
          if (r.Headers.Authorization != null) leak = true;
        }
      }
      Ok("no-auth-cookie-forwarding", !leak && fake.Seen.Count >= 2, "seen=" + fake.Seen.Count);
    }

    // 12: max 3 unique fetches per call (5 URLs proves cap)
    {
      var fake = new FakeHandler();
      fake.ResponderAsync = (req, ct) => Task.FromResult(Html(articleHtml));
      var f = new PublicEvidenceFetcher(fake, DnsFor);
      var cites = new List<ModelGateway.Citation>
      {
        new("https://example.com/a1", "", ""),
        new("https://example.com/a2", "", ""),
        new("https://example.com/a3", "", ""),
        new("https://example.com/a4", "", ""),
        new("https://example.com/a5", "", ""),
      };
      await f.HydrateAsync(cites, subject, CancellationToken.None);
      int distinct;
      lock (fake.CallsByPath) { distinct = fake.CallsByPath.Count; }
      Ok("max-3-unique-fetches", distinct <= 3, "distinct=" + distinct);
      runtimes.Add("max-urls-actual-count=" + distinct);
    }

    // 13: duplicate URLs share cache (one network hit)
    {
      var fake = new FakeHandler();
      fake.ResponderAsync = (req, ct) => Task.FromResult(Html(articleHtml));
      var f = new PublicEvidenceFetcher(fake, DnsFor);
      var cites = new List<ModelGateway.Citation>
      {
        new("https://example.com/article", "", ""),
        new("https://example.com/article", "", ""),
      };
      var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
      int hits;
      lock (fake.CallsByPath) { hits = fake.CallsByPath.TryGetValue("/article", out var n) ? n : 0; }
      Ok("duplicate-cache-single-hit", hits == 1, "hits=" + hits);
      Ok("duplicate-both-hydrated", !string.IsNullOrWhiteSpace(o[0].Excerpt) && o[0].Excerpt == o[1].Excerpt, "mismatch");
    }

    // 14: production defaults cannot reach local fixtures; no env bypass (single URL)
    {
      Environment.SetEnvironmentVariable("PUBLIC_EVIDENCE_BYPASS", "1");
      var prod = new PublicEvidenceFetcher();
      var cites = new List<ModelGateway.Citation> { new("http://127.0.0.1:5202/local", "L", "") };
      var o = await prod.HydrateAsync(cites, subject, CancellationToken.None);
      Ok("production-local-blocked", string.IsNullOrWhiteSpace(o[0].Excerpt), "ex=" + (o[0].Excerpt ?? ""));
      Environment.SetEnvironmentVariable("PUBLIC_EVIDENCE_BYPASS", null);
      Ok("no-env-bypass-means-blocked", true);
    }

    // 15: decimal-literal bypass blocked (single URL)
    {
      var fake = new FakeHandler();
      var called = 0;
      fake.ResponderAsync = (req, ct) => { called++; return Task.FromResult(Html(articleHtml)); };
      var f = new PublicEvidenceFetcher(fake, DnsFor);
      var cites = new List<ModelGateway.Citation> { new("http://2130706433/", "D", "") };
      var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
      Ok("decimal-literal-blocked", string.IsNullOrWhiteSpace(o[0].Excerpt) && called == 0, "calls=" + called);
    }

    // 16: slow DNS 5.6s cancelled by whole-URL 5s deadline (single URL, real cancelable)
    {
      var fake = new FakeHandler();
      var called = 0;
      fake.ResponderAsync = (req, ct) => { called++; return Task.FromResult(Html(articleHtml)); };
      Func<string, CancellationToken, Task<IPAddress[]>> slowDns = async (h, ct2) =>
      {
        await Task.Delay(5600, ct2).ConfigureAwait(false);
        return new[] { pub };
      };
      var f = new PublicEvidenceFetcher(fake, slowDns);
      var cites = new List<ModelGateway.Citation> { new("https://example.com/slow-dns", "", "") };
      var sw = Stopwatch.StartNew();
      var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
      sw.Stop();
      Ok("dns-stall-bounded-empty", string.IsNullOrWhiteSpace(o[0].Excerpt), "ex=" + (o[0].Excerpt ?? ""));
      Ok("dns-stall-no-fetch", called == 0, "calls=" + called);
      Ok("dns-stall-walltime-under-5600", sw.ElapsedMilliseconds < 5600, "ms=" + sw.ElapsedMilliseconds);
      runtimes.Add("dns-stall-ms=" + sw.ElapsedMilliseconds);
    }

    // 17: stalled body after immediate headers must NOT emit partial (single URL)
    {
      var fake = new FakeHandler();
      var prefix = Encoding.UTF8.GetBytes("<html><head><title>T</title></head><body><p>Regional grocer logistics partial prefix that should never be emitted as success. ");
      fake.ResponderAsync = (req, ct) =>
      {
        var res = new HttpResponseMessage(HttpStatusCode.OK);
        res.Content = new StallContent(prefix, 5600);
        res.Content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("text/html");
        return Task.FromResult(res);
      };
      var f = new PublicEvidenceFetcher(fake, DnsFor);
      var cites = new List<ModelGateway.Citation> { new("https://example.com/stalled-body", "", "") };
      var sw = Stopwatch.StartNew();
      var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
      sw.Stop();
      Ok("stalled-body-no-partial-empty", string.IsNullOrWhiteSpace(o[0].Excerpt), "ex=" + (o[0].Excerpt ?? "").Substring(0, Math.Min(80, (o[0].Excerpt ?? "").Length)));
      Ok("stalled-body-walltime-under-5600", sw.ElapsedMilliseconds < 5600, "ms=" + sw.ElapsedMilliseconds);
      runtimes.Add("stalled-body-ms=" + sw.ElapsedMilliseconds);
    }

    // 18: accumulated redirect deadline (3 hops x 2s = 6s must cancel at 5s) (single URL)
    {
      var fake = new FakeHandler();
      fake.ResponderAsync = async (req, ct) =>
      {
        await Task.Delay(2000, ct).ConfigureAwait(false);
        var p = req.RequestUri?.AbsolutePath ?? "/";
        if (p == "/accum-a") return Redirect("https://example.com/accum-b");
        if (p == "/accum-b") return Redirect("https://example.com/article");
        if (p == "/article") return Html(articleHtml);
        return new HttpResponseMessage(HttpStatusCode.NotFound);
      };
      var f = new PublicEvidenceFetcher(fake, DnsFor);
      var cites = new List<ModelGateway.Citation> { new("https://example.com/accum-a", "", "") };
      var sw = Stopwatch.StartNew();
      var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
      sw.Stop();
      Ok("accumulated-redirect-deadline-empty", string.IsNullOrWhiteSpace(o[0].Excerpt), "ex=" + (o[0].Excerpt ?? ""));
      Ok("accumulated-walltime-under-6000", sw.ElapsedMilliseconds < 6000, "ms=" + sw.ElapsedMilliseconds);
      runtimes.Add("accumulated-ms=" + sw.ElapsedMilliseconds);
    }
    // 19: hostile 256KiB script-repeat has bounded CPU and no excerpt (single URL)
    {
      var hostile = new StringBuilder(262144);
      for (int i = 0; i < 32768; i++) hostile.Append("<script>");
      var html = hostile.ToString();
      var fake = new FakeHandler();
      fake.ResponderAsync = (req, ct) => Task.FromResult(Html(html));
      var f = new PublicEvidenceFetcher(fake, DnsFor);
      var cites = new List<ModelGateway.Citation> { new("https://example.com/hostile-script", "", "") };
      var sw = Stopwatch.StartNew();
      var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
      sw.Stop();
      Ok("hostile-script-empty", string.IsNullOrWhiteSpace(o[0].Excerpt), "len=" + (o[0].Excerpt ?? "").Length);
      Ok("hostile-script-walltime-under-5000", sw.ElapsedMilliseconds < 5000, "ms=" + sw.ElapsedMilliseconds);
      runtimes.Add("hostile-script-ms=" + sw.ElapsedMilliseconds);
    }

    // 20: hostile 256KiB nav-repeat has bounded CPU and no excerpt (single URL)
    {
      var hostile = new StringBuilder(262140);
      for (int i = 0; i < 52428; i++) hostile.Append("<nav>");
      var html = hostile.ToString();
      var fake = new FakeHandler();
      fake.ResponderAsync = (req, ct) => Task.FromResult(Html(html));
      var f = new PublicEvidenceFetcher(fake, DnsFor);
      var cites = new List<ModelGateway.Citation> { new("https://example.com/hostile-nav", "", "") };
      var sw = Stopwatch.StartNew();
      var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
      sw.Stop();
      Ok("hostile-nav-empty", string.IsNullOrWhiteSpace(o[0].Excerpt), "len=" + (o[0].Excerpt ?? "").Length);
      Ok("hostile-nav-walltime-under-5000", sw.ElapsedMilliseconds < 5000, "ms=" + sw.ElapsedMilliseconds);
      runtimes.Add("hostile-nav-ms=" + sw.ElapsedMilliseconds);
    }

    // 21a-e: each unsafe IPv6 rejected via Hydrate (each own single URL)
    {
      var bads = new[] { "64:ff9b:1::a00:1", "2002:a00:1::1", "2001:2::1", "::2", "4000::1" };
      foreach (var bad in bads)
      {
        var fake = new FakeHandler();
        var called = 0;
        fake.ResponderAsync = (req, ct) => { called++; return Task.FromResult(Html(articleHtml)); };
        var bip = IPAddress.Parse(bad);
        Func<string, CancellationToken, Task<IPAddress[]>> badDns = (h, ct2) => Task.FromResult(new[] { bip });
        var f = new PublicEvidenceFetcher(fake, badDns);
        var cites = new List<ModelGateway.Citation> { new("https://example.com/article", "", "") };
        var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
        var key = bad.Replace(":", "-").Replace("a00-1", "a001");
        Ok("ipv6-blocked-" + key, string.IsNullOrWhiteSpace(o[0].Excerpt) && called == 0, "calls=" + called + " ex=" + (o[0].Excerpt ?? ""));
      }
    }

    // 22: mixed public + NAT64 blocked, no fetch (single URL)
    {
      var fake = new FakeHandler();
      var called = 0;
      fake.ResponderAsync = (req, ct) => { called++; return Task.FromResult(Html(articleHtml)); };
      var nat = IPAddress.Parse("64:ff9b:1::a00:1");
      Func<string, CancellationToken, Task<IPAddress[]>> mixDns = (h, ct2) => Task.FromResult(new[] { pub, nat });
      var f = new PublicEvidenceFetcher(fake, mixDns);
      var cites = new List<ModelGateway.Citation> { new("https://example.com/article", "", "") };
      var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
      Ok("ipv6-mixed-nat64-blocked-empty", string.IsNullOrWhiteSpace(o[0].Excerpt), "ex=" + (o[0].Excerpt ?? ""));
      Ok("ipv6-mixed-nat64-no-fetch", called == 0, "calls=" + called);
    }

    // 23: production handler UseProxy=false via reflection
    {
      var prod = new PublicEvidenceFetcher();
      var mi = typeof(PublicEvidenceFetcher).GetMethod("CreatePinnedHandler", BindingFlags.NonPublic | BindingFlags.Instance);
      var handler = (SocketsHttpHandler?)mi?.Invoke(prod, new object[] { new[] { pub } });
      Ok("prod-handler-created", handler != null, "null-handler");
      Ok("prod-useproxy-false", handler != null && handler.UseProxy == false, "UseProxy=" + (handler == null ? "null" : handler.UseProxy.ToString()));
      handler?.Dispose();
    }

    // 24a: hidden attribute excluded (single URL)
    {
      var fake = new FakeHandler();
      var html = "<html><head><title>H</title></head><body><p hidden>Regional grocer logistics costs have fallen by ninety percent.</p><p>Welcome to our website and customer portal.</p></body></html>";
      fake.ResponderAsync = (req, ct) => Task.FromResult(Html(html));
      var f = new PublicEvidenceFetcher(fake, DnsFor);
      var cites = new List<ModelGateway.Citation> { new("https://example.com/article", "", "") };
      var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
      var ex = o[0].Excerpt ?? "";
      Ok("hidden-attr-excluded", !ex.Contains("ninety percent"), "ex=" + ex);
    }

    // 24b: aria-hidden excluded (single URL)
    {
      var fake = new FakeHandler();
      var html = "<html><head><title>H</title></head><body><div aria-hidden=\"true\">Regional grocer logistics costs have fallen by ninety percent.</div><p>Welcome to our website and customer portal.</p></body></html>";
      fake.ResponderAsync = (req, ct) => Task.FromResult(Html(html));
      var f = new PublicEvidenceFetcher(fake, DnsFor);
      var cites = new List<ModelGateway.Citation> { new("https://example.com/article", "", "") };
      var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
      var ex = o[0].Excerpt ?? "";
      Ok("aria-hidden-excluded", !ex.Contains("ninety percent") && string.IsNullOrWhiteSpace(ex), "ex=" + ex);
    }

    // 24c: inline display:none excluded (single URL)
    {
      var fake = new FakeHandler();
      var html = "<html><head><title>H</title></head><body><p style=\"display:none\">Regional grocer logistics costs have fallen by ninety percent.</p><p>Welcome to our website and customer portal.</p></body></html>";
      fake.ResponderAsync = (req, ct) => Task.FromResult(Html(html));
      var f = new PublicEvidenceFetcher(fake, DnsFor);
      var cites = new List<ModelGateway.Citation> { new("https://example.com/article", "", "") };
      var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
      var ex = o[0].Excerpt ?? "";
      Ok("inline-style-hidden-excluded", !ex.Contains("ninety percent") && string.IsNullOrWhiteSpace(ex), "ex=" + ex);
    }

    // 25: title-only must not become evidence (single URL)
    {
      var fake = new FakeHandler();
      var html = "<html><head><title>Regional grocer logistics costs fell ninety percent.</title></head><body>Please log in to continue reading.</body></html>";
      fake.ResponderAsync = (req, ct) => Task.FromResult(Html(html));
      var f = new PublicEvidenceFetcher(fake, DnsFor);
      var cites = new List<ModelGateway.Citation> { new("https://example.com/article", "", "") };
      var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
      Ok("title-only-not-evidence", string.IsNullOrWhiteSpace(o[0].Excerpt), "ex=" + (o[0].Excerpt ?? ""));
      Ok("title-only-original-preserved", string.IsNullOrEmpty(o[0].Title), "title=" + (o[0].Title ?? ""));
    }

    // 26: paywall body blocked (single URL)
    {
      var fake = new FakeHandler();
      fake.ResponderAsync = (req, ct) => Task.FromResult(Html("<html><body>Subscribe to continue reading this premium article.</body></html>"));
      var f = new PublicEvidenceFetcher(fake, DnsFor);
      var cites = new List<ModelGateway.Citation> { new("https://example.com/article", "", "") };
      var o = await f.HydrateAsync(cites, "regional grocer logistics costs", CancellationToken.None);
      Ok("paywall-blocked-empty", string.IsNullOrWhiteSpace(o[0].Excerpt), "ex=" + (o[0].Excerpt ?? ""));
    }

    // 27: captcha body blocked (single URL)
    {
      var fake = new FakeHandler();
      fake.ResponderAsync = (req, ct) => Task.FromResult(Html("<html><body>Please enable JavaScript and complete the CAPTCHA to continue.</body></html>"));
      var f = new PublicEvidenceFetcher(fake, DnsFor);
      var cites = new List<ModelGateway.Citation> { new("https://example.com/article", "", "") };
      var o = await f.HydrateAsync(cites, "regional grocer logistics costs", CancellationToken.None);
      Ok("captcha-blocked-empty", string.IsNullOrWhiteSpace(o[0].Excerpt), "ex=" + (o[0].Excerpt ?? ""));
    }

    // 28: unrelated body blocked, no zero-relevance fallback (single URL)
    {
      var fake = new FakeHandler();
      fake.ResponderAsync = (req, ct) => Task.FromResult(Html("<html><body><p>The quick brown fox jumps over the lazy dog while weather patterns drift across the valley.</p></body></html>"));
      var f = new PublicEvidenceFetcher(fake, DnsFor);
      var cites = new List<ModelGateway.Citation> { new("https://example.com/article", "", "") };
      var o = await f.HydrateAsync(cites, "regional grocer logistics costs", CancellationToken.None);
      Ok("unrelated-blocked-empty", string.IsNullOrWhiteSpace(o[0].Excerpt), "ex=" + (o[0].Excerpt ?? ""));
    }

    // 28b: generic instruction words must not satisfy relevance (single URL)
    {
      var fake = new FakeHandler();
      fake.ResponderAsync = (req, ct) => Task.FromResult(Html("<html><body><p>This advisor dossier research factual report provides a comprehensive overview for the boardroom meeting.</p></body></html>"));
      var f = new PublicEvidenceFetcher(fake, DnsFor);
      var cites = new List<ModelGateway.Citation> { new("https://example.com/article", "", "") };
      var o = await f.HydrateAsync(cites, "advisor dossier research factual briefing", CancellationToken.None);
      Ok("generic-words-not-relevant", string.IsNullOrWhiteSpace(o[0].Excerpt), "ex=" + (o[0].Excerpt ?? ""));
    }

    // 29: relevant text only at long-sentence TAIL beyond 320 must not accept prefix (single URL)
    {
      var fake = new FakeHandler();
      var filler = new string((char)120, 400);
      var html = "<html><body><p>" + filler + " regional grocer logistics tail keywords at the very end of this long sentence.</p></body></html>";
      fake.ResponderAsync = (req, ct) => Task.FromResult(Html(html));
      var f = new PublicEvidenceFetcher(fake, DnsFor);
      var cites = new List<ModelGateway.Citation> { new("https://example.com/article", "", "") };
      var o = await f.HydrateAsync(cites, "regional grocer logistics", CancellationToken.None);
      Ok("tail-only-not-accepted-as-prefix", string.IsNullOrWhiteSpace(o[0].Excerpt), "ex=" + (o[0].Excerpt ?? ""));
    }

    // 30: concurrency peak is exactly 2 with 3 URLs (bounded queues)
    {
      var fake = new FakeHandler();
      fake.ResponderAsync = async (req, ct) => { await Task.Delay(300, ct).ConfigureAwait(false); return Html(articleHtml); };
      var f = new PublicEvidenceFetcher(fake, DnsFor);
      var cites = new List<ModelGateway.Citation>
      {
        new("https://example.com/c1", "", ""),
        new("https://example.com/c2", "", ""),
        new("https://example.com/c3", "", ""),
      };
      await f.HydrateAsync(cites, subject, CancellationToken.None);
      Ok("concurrency-peak-is-2", fake.Peak == 2, "peak=" + fake.Peak);
      runtimes.Add("concurrency-peak=" + fake.Peak);
    }

    // 31: prefix follow-up: each reserved IPv6 singly via Hydrate (each own single URL)
    {
      var privs = new[] { "3fff::1", "3fff:0fff::1", "3fff:1000::1", "2001:5::1", "2001:1a::1", "2001:2a::1" };
      foreach (var bad in privs)
      {
        var fake = new FakeHandler();
        var called = 0;
        fake.ResponderAsync = (req, ct) => { called++; return Task.FromResult(Html(articleHtml)); };
        var bip = IPAddress.Parse(bad);
        Func<string, CancellationToken, Task<IPAddress[]>> badDns = (h, ct2) => Task.FromResult(new[] { bip });
        var f = new PublicEvidenceFetcher(fake, badDns);
        var cites = new List<ModelGateway.Citation> { new("https://example.com/article", "", "") };
        var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
        var key = bad.Replace(":", "-");
        Ok("prefix-blocked-" + key, string.IsNullOrWhiteSpace(o[0].Excerpt) && called == 0, "calls=" + called + " ex=" + (o[0].Excerpt ?? ""));
      }
    }

    // 32: prefix follow-up: mixed public + each private, no fetch (each own single URL)
    {
      var privs = new[] { "3fff::1", "3fff:0fff::1", "3fff:1000::1", "2001:5::1", "2001:1a::1", "2001:2a::1" };
      foreach (var bad in privs)
      {
        var fake = new FakeHandler();
        var called = 0;
        fake.ResponderAsync = (req, ct) => { called++; return Task.FromResult(Html(articleHtml)); };
        var bip = IPAddress.Parse(bad);
        Func<string, CancellationToken, Task<IPAddress[]>> mixDns = (h, ct2) => Task.FromResult(new[] { pub, bip });
        var f = new PublicEvidenceFetcher(fake, mixDns);
        var cites = new List<ModelGateway.Citation> { new("https://example.com/article", "", "") };
        var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
        var key = bad.Replace(":", "-");
        Ok("prefix-mixed-blocked-" + key, string.IsNullOrWhiteSpace(o[0].Excerpt) && called == 0, "calls=" + called);
      }
    }

    // 33: required public IPs still allowed (each own single URL) + ordinary global v4
    {
      var goods = new[] { "2001:4860:4860::8888", "2606:4700:4700::1111" };
      foreach (var g in goods)
      {
        var fake = new FakeHandler();
        fake.ResponderAsync = (req, ct) => Task.FromResult(Html(articleHtml));
        var gip = IPAddress.Parse(g);
        Func<string, CancellationToken, Task<IPAddress[]>> goodDns = (h, ct2) => Task.FromResult(new[] { gip });
        var f = new PublicEvidenceFetcher(fake, goodDns);
        var cites = new List<ModelGateway.Citation> { new("https://example.com/article", "", "") };
        var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
        var key = g.Replace(":", "-");
        Ok("prefix-public-allowed-" + key, !string.IsNullOrWhiteSpace(o[0].Excerpt), "ex-empty");
      }
      {
        var fake = new FakeHandler();
        fake.ResponderAsync = (req, ct) => Task.FromResult(Html(articleHtml));
        var f = new PublicEvidenceFetcher(fake, DnsFor);
        var cites = new List<ModelGateway.Citation> { new("https://example.com/article", "", "") };
        var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
        Ok("prefix-public-allowed-v4", !string.IsNullOrWhiteSpace(o[0].Excerpt), "ex-empty");
      }
    }

    // 34: malformed BODY title must not become evidence (reviewer reproducer, single URL)
    {
      var fake = new FakeHandler();
      var html = "<html><body><title>Regional grocer logistics costs fell ninety percent.</title><p>Please log in to continue reading.</p></body></html>";
      fake.ResponderAsync = (req, ct) => Task.FromResult(Html(html));
      var f = new PublicEvidenceFetcher(fake, DnsFor);
      var cites = new List<ModelGateway.Citation> { new("https://example.com/article", "Orig", "") };
      var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
      Ok("body-title-not-evidence", string.IsNullOrWhiteSpace(o[0].Excerpt), "ex=" + (o[0].Excerpt ?? ""));
      Ok("body-title-original-preserved", o[0].Title == "Orig", "title=" + (o[0].Title ?? ""));
    }

    // 35: malformed title excluded while genuine body prose still hydrates (single URL)
    {
      var fake = new FakeHandler();
      var html = "<html><body><title>Regional grocer logistics costs fell ninety percent.</title><article><p>Regional grocers cut last-mile delivery costs with denser routes, balanced warehouse staffing, and cold-chain reliability.</p></article></body></html>";
      fake.ResponderAsync = (req, ct) => Task.FromResult(Html(html));
      var f = new PublicEvidenceFetcher(fake, DnsFor);
      var cites = new List<ModelGateway.Citation> { new("https://example.com/article", "", "") };
      var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
      var ex = o[0].Excerpt ?? "";
      Ok("body-title-excluded-body-hydrated", ex.Length >= 20 && !ex.Contains("ninety percent"), "ex=" + ex);
    }

    // 36: CSS-comment hidden variants incl. ancestors (each own single URL)
    {
      var variants = new[] {
        "v-comment-empty|display:/**/none",
        "v-comment-spaced|display: /**/ none",
        "v-comment-colon|display/*a*/:/*b*/none",
        "v-comment-multi|display/*a*//*b*/:none",
        "v-comment-vis|visibility:/*a*/hidden",
        "v-comment-collapse|visibility:/*c*/collapse",
      };
      foreach (var v in variants)
      {
        var parts = v.Split((char)124);
        var style = parts[1];
        var fake = new FakeHandler();
        var html = "<html><body><p style=\"" + style + "\">Regional grocer logistics costs have fallen by ninety percent.</p><p>Welcome to our website and customer portal.</p></body></html>";
        fake.ResponderAsync = (req, ct) => Task.FromResult(Html(html));
        var f = new PublicEvidenceFetcher(fake, DnsFor);
        var cites = new List<ModelGateway.Citation> { new("https://example.com/article", "", "") };
        var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
        Ok("hidden-comment-" + parts[0], string.IsNullOrWhiteSpace(o[0].Excerpt), "ex=" + (o[0].Excerpt ?? ""));
      }
      {
        var fake = new FakeHandler();
        var html = "<html><body><div style=\"display:/*x*/none\"><p>Regional grocer logistics costs have fallen by ninety percent.</p></div><p>Welcome to our website and customer portal.</p></body></html>";
        fake.ResponderAsync = (req, ct) => Task.FromResult(Html(html));
        var f = new PublicEvidenceFetcher(fake, DnsFor);
        var cites = new List<ModelGateway.Citation> { new("https://example.com/article", "", "") };
        var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
        Ok("hidden-comment-ancestor-display", string.IsNullOrWhiteSpace(o[0].Excerpt), "ex=" + (o[0].Excerpt ?? ""));
      }
      {
        var fake = new FakeHandler();
        var html = "<html><body><div style=\"visibility:/*a*/hidden\"><p>Regional grocer logistics costs have fallen by ninety percent.</p></div><p>Welcome to our website and customer portal.</p></body></html>";
        fake.ResponderAsync = (req, ct) => Task.FromResult(Html(html));
        var f = new PublicEvidenceFetcher(fake, DnsFor);
        var cites = new List<ModelGateway.Citation> { new("https://example.com/article", "", "") };
        var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
        Ok("hidden-comment-ancestor-visibility", string.IsNullOrWhiteSpace(o[0].Excerpt), "ex=" + (o[0].Excerpt ?? ""));
      }
      {
        var fake = new FakeHandler();
        var html = "<html><body><div aria-hidden=\"true\"><p>Regional grocer logistics costs have fallen by ninety percent.</p></div><p>Welcome to our website and customer portal.</p></body></html>";
        fake.ResponderAsync = (req, ct) => Task.FromResult(Html(html));
        var f = new PublicEvidenceFetcher(fake, DnsFor);
        var cites = new List<ModelGateway.Citation> { new("https://example.com/article", "", "") };
        var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
        Ok("hidden-ancestor-aria", string.IsNullOrWhiteSpace(o[0].Excerpt), "ex=" + (o[0].Excerpt ?? ""));
      }
    }




    // 37: comment/whitespace normalization fail-closed + controls (each own single URL)
    {
      {
        var fake = new FakeHandler();
        var pad = string.Concat(System.Linq.Enumerable.Repeat("/**/", 10002));
        var html = "<html><body><p style=\"" + pad + "display:none\">Regional grocer logistics costs have fallen by ninety percent.</p><p>Welcome to our website and customer portal.</p></body></html>";
        fake.ResponderAsync = (req, ct) => Task.FromResult(Html(html));
        var f = new PublicEvidenceFetcher(fake, DnsFor);
        var cites = new List<ModelGateway.Citation> { new("https://example.com/article", "", "") };
        var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
        Ok("hidden-many-comments-stays-hidden", string.IsNullOrWhiteSpace(o[0].Excerpt), "ex=" + (o[0].Excerpt ?? ""));
      }
      {
        var fake = new FakeHandler();
        var html = "<html><body><p style=\"display:\fnone\">Regional grocer logistics costs have fallen by ninety percent.</p><p>Welcome to our website and customer portal.</p></body></html>";
        fake.ResponderAsync = (req, ct) => Task.FromResult(Html(html));
        var f = new PublicEvidenceFetcher(fake, DnsFor);
        var cites = new List<ModelGateway.Citation> { new("https://example.com/article", "", "") };
        var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
        Ok("hidden-formfeed-whitespace", string.IsNullOrWhiteSpace(o[0].Excerpt), "ex=" + (o[0].Excerpt ?? ""));
      }
      {
        var fake = new FakeHandler();
        var html = "<html><body><article><p style=\"color:/*x*/red\">Regional grocers cut last-mile delivery costs with denser routes, balanced warehouse staffing, and cold-chain reliability.</p></article></body></html>";
        fake.ResponderAsync = (req, ct) => Task.FromResult(Html(html));
        var f = new PublicEvidenceFetcher(fake, DnsFor);
        var cites = new List<ModelGateway.Citation> { new("https://example.com/article", "", "") };
        var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
        var ex = o[0].Excerpt ?? "";
        Ok("visible-commented-nonhiding-style", ex.Length >= 20, "ex=" + ex);
      }
      {
        var fake = new FakeHandler();
        fake.ResponderAsync = (req, ct) => Task.FromResult(Html(articleHtml));
        var f = new PublicEvidenceFetcher(fake, DnsFor);
        var cites = new List<ModelGateway.Citation> { new("https://example.com/article", "", "") };
        var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
        Ok("visible-body-control", !string.IsNullOrWhiteSpace(o[0].Excerpt), "ex-empty");
      }
    }

    // 38: hidden HTML root ancestors must suppress excerpts (each own single URL)
    {
      {
        var fake = new FakeHandler();
        var html = "<html hidden><body><p>Regional grocer logistics costs have fallen by ninety percent.</p></body></html>";
        fake.ResponderAsync = (req, ct) => Task.FromResult(Html(html));
        var f = new PublicEvidenceFetcher(fake, DnsFor);
        var cites = new List<ModelGateway.Citation> { new("https://example.com/article", "", "") };
        var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
        Ok("hidden-root-html-attr", string.IsNullOrWhiteSpace(o[0].Excerpt), "ex=" + (o[0].Excerpt ?? ""));
      }
      {
        var fake = new FakeHandler();
        var html = "<html style=\"display:none\"><body><p>Regional grocer logistics costs have fallen by ninety percent.</p></body></html>";
        fake.ResponderAsync = (req, ct) => Task.FromResult(Html(html));
        var f = new PublicEvidenceFetcher(fake, DnsFor);
        var cites = new List<ModelGateway.Citation> { new("https://example.com/article", "", "") };
        var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
        Ok("hidden-root-html-style-plain", string.IsNullOrWhiteSpace(o[0].Excerpt), "ex=" + (o[0].Excerpt ?? ""));
      }
      {
        var fake = new FakeHandler();
        var html = "<html style=\"display:/**/none\"><body><p>Regional grocer logistics costs have fallen by ninety percent.</p></body></html>";
        fake.ResponderAsync = (req, ct) => Task.FromResult(Html(html));
        var f = new PublicEvidenceFetcher(fake, DnsFor);
        var cites = new List<ModelGateway.Citation> { new("https://example.com/article", "", "") };
        var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
        Ok("hidden-root-html-style-commented", string.IsNullOrWhiteSpace(o[0].Excerpt), "ex=" + (o[0].Excerpt ?? ""));
      }
      {
        var fake = new FakeHandler();
        var html = "<html style=\"visibility:hidden\"><body><p>Regional grocer logistics costs have fallen by ninety percent.</p></body></html>";
        fake.ResponderAsync = (req, ct) => Task.FromResult(Html(html));
        var f = new PublicEvidenceFetcher(fake, DnsFor);
        var cites = new List<ModelGateway.Citation> { new("https://example.com/article", "", "") };
        var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
        Ok("hidden-root-html-visibility", string.IsNullOrWhiteSpace(o[0].Excerpt), "ex=" + (o[0].Excerpt ?? ""));
      }
      {
        var fake = new FakeHandler();
        var html = "<html aria-hidden=\"true\"><body><p>Regional grocer logistics costs have fallen by ninety percent.</p></body></html>";
        fake.ResponderAsync = (req, ct) => Task.FromResult(Html(html));
        var f = new PublicEvidenceFetcher(fake, DnsFor);
        var cites = new List<ModelGateway.Citation> { new("https://example.com/article", "", "") };
        var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
        Ok("hidden-root-html-aria", string.IsNullOrWhiteSpace(o[0].Excerpt), "ex=" + (o[0].Excerpt ?? ""));
      }
      {
        var fake = new FakeHandler();
        var html = "<html><body hidden><p>Regional grocer logistics costs have fallen by ninety percent.</p></body></html>";
        fake.ResponderAsync = (req, ct) => Task.FromResult(Html(html));
        var f = new PublicEvidenceFetcher(fake, DnsFor);
        var cites = new List<ModelGateway.Citation> { new("https://example.com/article", "", "") };
        var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
        Ok("hidden-body-control", string.IsNullOrWhiteSpace(o[0].Excerpt), "ex=" + (o[0].Excerpt ?? ""));
      }
      {
        var fake = new FakeHandler();
        var html = "<html><body><article><p>Regional grocers cut last-mile delivery costs with denser routes, balanced warehouse staffing, and cold-chain reliability.</p></article></body></html>";
        fake.ResponderAsync = (req, ct) => Task.FromResult(Html(html));
        var f = new PublicEvidenceFetcher(fake, DnsFor);
        var cites = new List<ModelGateway.Citation> { new("https://example.com/article", "", "") };
        var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
        var ex = o[0].Excerpt ?? "";
        Ok("visible-root-control", ex.Length >= 20, "ex=" + ex);
      }
    }

    string root = FindRepoRoot();
    string resultPath = string.IsNullOrEmpty(root)
      ? System.IO.Path.Combine(Directory.GetCurrentDirectory(), ".tmp", "muse-public-evidence-result.txt")
      : System.IO.Path.Combine(root, ".tmp", "muse-public-evidence-result.txt");
    try
    {
      Directory.CreateDirectory(System.IO.Path.GetDirectoryName(resultPath) ?? ".");
      var sb = new StringBuilder();
      sb.AppendLine("muse public-evidence probe: actual PublicEvidenceFetcher with injected bounded HTTP/DNS fixtures");
      foreach (var l in lines) sb.AppendLine(l);
      foreach (var r in runtimes) sb.AppendLine("RUNTIME " + r);
      sb.AppendLine("PROBE pass=" + pass + " fail=" + fail);
      File.WriteAllText(resultPath, sb.ToString());
      Console.WriteLine("PROBE pass=" + pass + " fail=" + fail);
      Console.WriteLine("result: " + resultPath);
    }
    catch (Exception ex) { Console.Error.WriteLine("PROBE FAIL cannot write result: " + ex.Message); }
    return fail == 0 ? 0 : 1;
  }

  static HttpResponseMessage Html(string body)
  {
    var bytes = Encoding.UTF8.GetBytes(body);
    var res = new HttpResponseMessage(HttpStatusCode.OK);
    res.Content = new ByteArrayContent(bytes);
    res.Content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("text/html");
    return res;
  }

  static HttpResponseMessage Redirect(string location)
  {
    var res = new HttpResponseMessage(HttpStatusCode.Found);
    res.Headers.Location = new Uri(location, UriKind.Absolute);
    res.Content = new ByteArrayContent(Array.Empty<byte>());
    return res;
  }

  static string FindRepoRoot()
  {
    string d = Directory.GetCurrentDirectory();
    for (int i = 0; i < 10; i++)
    {
      if (File.Exists(System.IO.Path.Combine(d, "SimCEO.sln"))) return d;
      var parent = Directory.GetParent(d);
      if (parent == null) break;
      d = parent.FullName;
    }
    d = AppContext.BaseDirectory;
    for (int i = 0; i < 12; i++)
    {
      if (File.Exists(System.IO.Path.Combine(d, "SimCEO.sln"))) return d;
      var parent = Directory.GetParent(d);
      if (parent == null) break;
      d = parent.FullName;
    }
    return "";
  }
}
