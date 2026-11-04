using System.Net;
using SimCEO.Api.Work;

static class Probe
{
  static int pass = 0;
  static int fail = 0;
  static void Ok(string name, bool cond, string extra = "")
  {
    if (cond) { pass++; Console.WriteLine("PASS " + name); }
    else { fail++; Console.WriteLine("FAIL " + name + (extra == "" ? "" : " :: " + extra)); }
  }
  sealed class FakeHandler : HttpMessageHandler
  {
    public Func<HttpRequestMessage, HttpResponseMessage> Responder = _ => new HttpResponseMessage(HttpStatusCode.NotFound);
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
      ct.ThrowIfCancellationRequested();
      var res = Responder(request);
      res.RequestMessage = request;
      return Task.FromResult(res);
    }
  }
  static HttpResponseMessage Html(string title, string sentence)
  {
    var html = "<html><head><title>" + title + "</title></head><body><article><p>" + sentence + "</p><p>Extra harbor port logistics detail for relevance.</p></article></body></html>";
    return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(html, System.Text.Encoding.UTF8, "text/html") };
  }
  static Dictionary<string, List<PoolPassage>> PoolFromHydrated(ModelGateway.Citation h)
  {
    var d = new Dictionary<string, List<PoolPassage>>(StringComparer.Ordinal);
    d[h.Url] = new List<PoolPassage> { new PoolPassage(h.Title ?? "", h.Excerpt ?? "", h.Fetched, h.Origin ?? "") };
    return d;
  }
  static int Main() => RunAsync().GetAwaiter().GetResult();
  static async Task<int> RunAsync()
  {
    var subject = "harbor port risk crew coordination logistics dredging expansion scheduling";
    IPAddress pub = IPAddress.Parse("93.184.216.34");
    Task<IPAddress[]> DnsFor(string host, CancellationToken ct) => Task.FromResult(new[] { pub });
    var fake = new FakeHandler();
    fake.Responder = req =>
    {
      var path = req.RequestUri?.AbsolutePath ?? "/";
      var query = req.RequestUri?.Query ?? "";
      if (path == "/Case") return Html("Case doc", "Harbor Case passage about port risk management and logistics.");
      if (path == "/case") return Html("case doc", "Harbor case passage about crew coordination and scheduling.");
      if (path == "/p" && query == "?A=1") return Html("query up", "Query uppercase passage about harbor logistics and dredging risk.");
      if (path == "/p" && query == "?a=1") return Html("query low", "Query lowercase passage about crew scheduling and expansion coordination.");
      if (path == "/page" && string.IsNullOrEmpty(query)) return Html("slashless", "Slashless passage about harbor dredging and port risk.");
      if (path == "/page/") return Html("slashed", "Slashed passage about port expansion and crew logistics.");
      if (path == "/good-doc") return Html("Good doc", "Fetched passage about harbors and ports with logistics detail.");
      return new HttpResponseMessage(HttpStatusCode.NotFound);
    };
    var sidEmpty = new Dictionary<string, string>(StringComparer.Ordinal);
    {
      var f = new PublicEvidenceFetcher(fake, DnsFor);
      var cites = new List<ModelGateway.Citation>
      {
        new("https://example.com/Case", "", ""),
        new("https://example.com/case", "", ""),
      };
      var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
      var eUpper = o[0].Excerpt ?? "";
      var eLower = o[1].Excerpt ?? "";
      Ok("strict-path-both-hydrated", !string.IsNullOrWhiteSpace(eUpper) && !string.IsNullOrWhiteSpace(eLower), "up=" + eUpper.Length + " low=" + eLower.Length);
      Ok("strict-path-no-conflate", !string.Equals(eUpper, eLower, StringComparison.Ordinal), "shared excerpt");
      Ok("strict-path-fetch-flags", o[0].Fetched && o[1].Fetched && o[0].Origin == "application-fetch" && o[1].Origin == "application-fetch", "flags wrong");
      var poolUp = PoolFromHydrated(o[0]);
      var qUp = (eUpper ?? "").Substring(0, Math.Min(40, (eUpper ?? "").Length));
      var good = ClaimEvidenceMapper.MapOne("FACT | Port risk claim || EVIDENCE: https://example.com/Case :: \"" + qUp + "\"", poolUp, sidEmpty);
      var bad = ClaimEvidenceMapper.MapOne("FACT | Port risk claim || EVIDENCE: https://example.com/case :: \"" + qUp + "\"", poolUp, sidEmpty);
      Ok("strict-path-map-exact-only", good.Verified && !bad.Verified, "good=" + good.Verified + " bad=" + bad.Verified);
      Ok("strict-path-retained-url", good.Verified && good.Refs[0].Url == "https://example.com/Case", "ref=" + (good.Verified ? good.Refs[0].Url : "?"));
    }
    {
      var f = new PublicEvidenceFetcher(fake, DnsFor);
      var cites = new List<ModelGateway.Citation>
      {
        new("https://example.com/p?A=1", "", ""),
        new("https://example.com/p?a=1", "", ""),
      };
      var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
      Ok("strict-query-both-hydrated", !string.IsNullOrWhiteSpace(o[0].Excerpt) && !string.IsNullOrWhiteSpace(o[1].Excerpt), "empty");
      Ok("strict-query-distinct", !string.Equals(o[0].Excerpt, o[1].Excerpt, StringComparison.Ordinal), "shared");
    }
    {
      var f = new PublicEvidenceFetcher(fake, DnsFor);
      var cites = new List<ModelGateway.Citation>
      {
        new("https://example.com/page", "", ""),
        new("https://example.com/page/", "", ""),
      };
      var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
      Ok("strict-slash-both-hydrated", !string.IsNullOrWhiteSpace(o[0].Excerpt) && !string.IsNullOrWhiteSpace(o[1].Excerpt), "empty");
      Ok("strict-slash-distinct", !string.Equals(o[0].Excerpt, o[1].Excerpt, StringComparison.Ordinal), "conflated");
    }
    {
      var f = new PublicEvidenceFetcher(fake, DnsFor);
      var cites = new List<ModelGateway.Citation> { new("https://example.com/owner-doc", "", "") };
      var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
      Ok("failed-owner-stays-empty", string.IsNullOrWhiteSpace(o[0].Excerpt) && !o[0].Fetched, "ex=" + (o[0].Excerpt ?? ""));
      var pool = new Dictionary<string, List<PoolPassage>>(StringComparer.Ordinal);
      pool["https://example.com/owner-doc"] = new List<PoolPassage> { new PoolPassage("Owner doc", "Provider snippet about harbors and ports.", false, "provider-search") };
      var vc = ClaimEvidenceMapper.MapOne("FACT | Harbor claim || EVIDENCE: https://example.com/owner-doc :: \"snippet about harbors and ports\"", pool, sidEmpty);
      Ok("failed-owner-snippet-verified", vc.Verified, "v=" + vc.Verified);
      Ok("failed-owner-snippet-unfetched", vc.Verified && !vc.Refs[0].Fetched && vc.Refs[0].Origin == "provider-search", "origin wrong");
      var need = ClaimEvidenceMapper.CollectUnfetchedUrls(new[] { "FACT | Harbor claim || EVIDENCE: https://example.com/owner-doc :: \"snippet about harbors and ports\"" }, pool, sidEmpty);
      Ok("failed-owner-still-needs-fetch", need.Count == 1, "need=" + string.Join(",", need));
    }
    {
      var f = new PublicEvidenceFetcher(fake, DnsFor);
      var cites = new List<ModelGateway.Citation> { new("https://example.com/good-doc", "", "") };
      var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
      var h = o[0];
      Ok("actual-fetch-nonempty", !string.IsNullOrWhiteSpace(h.Excerpt), "empty");
      Ok("actual-fetch-true-origin", h.Fetched && h.Origin == "application-fetch", "f=" + h.Fetched + " o=" + h.Origin);
      var pool = PoolFromHydrated(h);
      var quote = (h.Excerpt ?? "").Substring(0, Math.Min(40, (h.Excerpt ?? "").Length));
      var line = "FACT | Harbor port claim || EVIDENCE: https://example.com/good-doc :: \"" + quote + "\"";
      var vc = ClaimEvidenceMapper.MapOne(line, pool, sidEmpty);
      Ok("actual-fetch-maps-honest", vc.Verified && vc.Refs[0].Fetched && vc.Refs[0].Origin == "application-fetch", "map wrong");
      var need = ClaimEvidenceMapper.CollectUnfetchedUrls(new[] { line }, pool, sidEmpty);
      Ok("actual-fetch-no-reref", need.Count == 0, "need=" + string.Join(",", need));
    }
    {
      var f = new PublicEvidenceFetcher(fake, DnsFor);
      var cites = new List<ModelGateway.Citation> { new("https://example.com/good-doc", "", "") };
      var o = await f.HydrateAsync(cites, subject, CancellationToken.None);
      var h = o[0];
      var pool = new Dictionary<string, List<PoolPassage>>(StringComparer.Ordinal);
      pool["https://example.com/good-doc"] = new List<PoolPassage>
      {
        new PoolPassage(h.Title ?? "", h.Excerpt ?? "", h.Fetched, h.Origin ?? ""),
        new PoolPassage("Good doc", "Second provider passage about crew coordination and scheduling.", false, "provider-search"),
      };
      var q1 = (h.Excerpt ?? "").Substring(0, Math.Min(30, (h.Excerpt ?? "").Length));
      var lines = new[]
      {
        "FACT | Port risk claim || EVIDENCE: https://example.com/good-doc :: \"" + q1 + "\"",
        "INTERPRETATION | Crew read || EVIDENCE: https://example.com/good-doc :: \"passage about crew coordination\"",
      };
      var mapped = ClaimEvidenceMapper.MapAll(lines, pool, sidEmpty);
      Ok("same-url-both-verified", mapped.Count == 2 && mapped.All(v => v.Verified), "count=" + mapped.Count);
      bool originsOk = mapped.Count == 2 && mapped[0].Refs[0].Fetched && !mapped[1].Refs[0].Fetched && mapped[1].Refs[0].Origin == "provider-search";
      Ok("same-url-distinct-origins", originsOk, "origins wrong");
    }
    {
      var dupUrl = "https://example.com/dup-doc";
      var dupCites = new List<ModelGateway.Citation>
      {
        new(dupUrl, "Alpha provider title", "Alpha provider snippet about harbors and ports.", false, "provider-search"),
        new(dupUrl, "Beta hydrated title", "Fetched Beta passage about harbors and ports with logistics detail.", true, "application-fetch"),
      };
      var hit = ClaimEvidenceMapper.SelectPreferredCitation(dupCites, dupUrl);
      Ok("dup-helper-prefers-fetched", hit is not null && hit.Fetched && hit.Origin == "application-fetch", "helper picked wrong");
      Ok("dup-helper-beta-content", hit is not null && hit.Title == "Beta hydrated title" && (hit.Excerpt ?? "").Contains("Fetched Beta passage"), "title/excerpt wrong");
      var legacyFirst = dupCites.FirstOrDefault(c => ClaimEvidenceMapper.UrlsMatch(c.Url ?? "", dupUrl));
      Ok("dup-helper-legacy-would-lose", legacyFirst is not null && !legacyFirst.Fetched, "legacy assumption changed");
      var dupPool = new Dictionary<string, List<PoolPassage>>(StringComparer.Ordinal);
      dupPool[dupUrl] = new List<PoolPassage>
      {
        new("Alpha provider title", "Alpha provider snippet about harbors and ports.", false, "provider-search"),
        new("Beta hydrated title", "Fetched Beta passage about harbors and ports with logistics detail.", true, "application-fetch"),
      };
      Ok("dup-helper-pool-retains-both", dupPool[dupUrl].Count == 2, "pool lost passage");
      var dupLines = new[]
      {
        "FACT | Harbor claim || EVIDENCE: https://example.com/dup-doc :: \"Alpha provider snippet about harbors and ports.\"",
        "INTERPRETATION | Port read || EVIDENCE: https://example.com/dup-doc :: \"Fetched Beta passage about harbors and ports\"",
      };
      var dupMapped = ClaimEvidenceMapper.MapAll(dupLines, dupPool, sidEmpty);
      bool dupOk = dupMapped.Count == 2 && dupMapped.All(v => v.Verified) && !dupMapped[0].Refs[0].Fetched && dupMapped[0].Refs[0].Origin == "provider-search" && dupMapped[1].Refs[0].Fetched && dupMapped[1].Refs[0].Origin == "application-fetch";
      Ok("dup-helper-claim-origins", dupOk, "claim origins wrong");
    }
    {
      int evidenceHits = 0;
      var dupFake = new FakeHandler();
      dupFake.Responder = req =>
      {
        var host = req.RequestUri?.Host ?? "";
        if (string.Equals(host, "example.com", StringComparison.OrdinalIgnoreCase))
        {
          evidenceHits++;
          return Html("Dup doc", "Fetched Beta passage about harbors and ports with logistics detail.");
        }
        return new HttpResponseMessage(HttpStatusCode.NotFound);
      };
      int port;
      using (var tcp = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0)) { tcp.Start(); port = ((System.Net.IPEndPoint)tcp.LocalEndpoint).Port; tcp.Stop(); }
      var listener = new HttpListener();
      listener.Prefixes.Add("http://127.0.0.1:" + port + "/");
      listener.Start();
      string dupUrl2 = "https://example.com/dup-doc";
      string envelope = "{\"id\":\"resp-dup-1\",\"status\":\"completed\",\"usage\":{\"input_tokens\":100,\"output_tokens\":50},\"output\":[{\"type\":\"web_search_call\",\"results\":[{\"url\":\"" + dupUrl2 + "\",\"title\":\"Alpha provider title\",\"snippet\":\"Alpha provider snippet about harbors and ports.\"}]},{\"type\":\"message\",\"content\":[{\"text\":\"research done\",\"annotations\":[{\"type\":\"url_citation\",\"url\":\"" + dupUrl2 + "\",\"title\":\"Beta hydrated title\"}]}]}]}";
      byte[] envelopeBytes = System.Text.Encoding.UTF8.GetBytes(envelope);
      var served = new TaskCompletionSource<bool>();
      var listenTask = Task.Run(async () =>
      {
        try
        {
          var ctx = await listener.GetContextAsync().ConfigureAwait(false);
          try
          {
            using (var sr = new System.IO.StreamReader(ctx.Request.InputStream, System.Text.Encoding.UTF8)) { await sr.ReadToEndAsync().ConfigureAwait(false); }
            if (ctx.Request.HttpMethod == "POST" && (ctx.Request.Url?.AbsolutePath ?? "") == "/responses")
            {
              ctx.Response.StatusCode = 200;
              ctx.Response.ContentType = "application/json";
              ctx.Response.ContentLength64 = envelopeBytes.Length;
              await ctx.Response.OutputStream.WriteAsync(envelopeBytes, 0, envelopeBytes.Length).ConfigureAwait(false);
            }
            else { ctx.Response.StatusCode = 404; }
          }
          finally { try { ctx.Response.OutputStream.Close(); ctx.Response.Close(); } catch { } served.TrySetResult(true); }
        }
        catch (Exception ex) { served.TrySetException(ex); }
      });
      string? oldBase = Environment.GetEnvironmentVariable("META_API_BASE");
      string? oldKey = Environment.GetEnvironmentVariable("META_API_KEY");
      try
      {
        Environment.SetEnvironmentVariable("META_API_BASE", "http://127.0.0.1:" + port);
        Environment.SetEnvironmentVariable("META_API_KEY", "test-dummy-key");
        var store = new SimCEO.Api.Data.InMemoryStore();
        var evidence = new PublicEvidenceFetcher(dupFake, DnsFor);
        var gw = new ModelGateway(store, evidence);
        var gr = await gw.CompleteGroundedAsync("muse-spark-1.3-contributor", "advisor-research", subject, 2048, 2048, CancellationToken.None, ownerOverride: true).ConfigureAwait(false);
        await served.Task.WaitAsync(TimeSpan.FromSeconds(10)).ConfigureAwait(false);
        try { await listenTask.WaitAsync(TimeSpan.FromSeconds(10)).ConfigureAwait(false); } catch { }
        Ok("dup-gw-citation-count", gr.Citations.Count == 2, "count=" + gr.Citations.Count);
        bool orderOk = gr.Citations.Count == 2 && string.Equals(gr.Citations[0].Url, dupUrl2, StringComparison.Ordinal) && string.Equals(gr.Citations[1].Url, dupUrl2, StringComparison.Ordinal);
        Ok("dup-gw-same-url-order", orderOk, "order wrong");
        bool provOk = gr.Citations.Count == 2 && !gr.Citations[0].Fetched && gr.Citations[0].Origin == "provider-search" && !string.IsNullOrWhiteSpace(gr.Citations[0].Excerpt);
        Ok("dup-gw-alpha-provider", provOk, "alpha wrong f=" + (gr.Citations.Count > 0 ? gr.Citations[0].Fetched.ToString() : "?"));
        bool hydOk = gr.Citations.Count == 2 && gr.Citations[1].Fetched && gr.Citations[1].Origin == "application-fetch" && !string.IsNullOrWhiteSpace(gr.Citations[1].Excerpt);
        Ok("dup-gw-beta-hydrated", hydOk, "beta wrong");
        Ok("dup-gw-actual-fetch-count", evidenceHits >= 1, "hits=" + evidenceHits);
        var poolMulti = new Dictionary<string, List<PoolPassage>>(StringComparer.Ordinal);
        foreach (var cite in gr.Citations.Where(c => !string.IsNullOrWhiteSpace(c.Url)))
        {
          if (string.IsNullOrWhiteSpace(cite.Excerpt)) continue;
          string akey = cite.Url.Trim();
          foreach (var k in new List<string>(poolMulti.Keys)) { if (ClaimEvidenceMapper.UrlsMatch(k, akey)) { akey = k; break; } }
          if (!poolMulti.TryGetValue(akey, out var alist)) { alist = new List<PoolPassage>(); poolMulti[akey] = alist; }
          bool cf = cite.Fetched;
          string co = (cite.Origin ?? "").Trim();
          if (cf && string.IsNullOrWhiteSpace(co)) co = "application-fetch";
          if (!cf) co = "provider-search";
          alist.Add(new PoolPassage(cite.Title ?? "", cite.Excerpt ?? "", cf, co));
        }
        string poolKey = "";
        foreach (var k in poolMulti.Keys) { if (ClaimEvidenceMapper.UrlsMatch(k, dupUrl2)) { poolKey = k; break; } }
        Ok("dup-gw-pool-retains-both", poolKey != "" && poolMulti[poolKey].Count == 2, "pool=" + (poolKey == "" ? "missing" : poolMulti[poolKey].Count.ToString()));
        var invHit = ClaimEvidenceMapper.SelectPreferredCitation(gr.Citations, dupUrl2);


        Ok("dup-gw-inventory-prefers-fetched", invHit is not null && invHit.Fetched && invHit.Origin == "application-fetch" && (invHit.Excerpt ?? "") == (gr.Citations[1].Excerpt ?? "") && !string.IsNullOrWhiteSpace(invHit.Excerpt) && (invHit.Excerpt ?? "") != (gr.Citations[0].Excerpt ?? ""), "inv wrong");
        string qAlpha = (gr.Citations[0].Excerpt ?? "").Trim();
        string qBeta = (gr.Citations[1].Excerpt ?? "").Trim();
        if (qAlpha.Length > 60) qAlpha = qAlpha.Substring(0, 60);
        if (qBeta.Length > 60) qBeta = qBeta.Substring(0, 60);
        var claimLines = new[] { "FACT | Harbor claim || EVIDENCE: " + dupUrl2 + " :: \"" + qAlpha + "\"", "INTERPRETATION | Port read || EVIDENCE: " + dupUrl2 + " :: \"" + qBeta + "\"" };
        var mapped = ClaimEvidenceMapper.MapAll(claimLines, poolMulti, sidEmpty);
        bool claimOk = mapped.Count == 2 && mapped.All(v => v.Verified) && !mapped[0].Refs[0].Fetched && mapped[0].Refs[0].Origin == "provider-search" && mapped[1].Refs[0].Fetched && mapped[1].Refs[0].Origin == "application-fetch";
        Ok("dup-gw-claim-origins", claimOk, "claims wrong count=" + mapped.Count);
      }
      finally
      {
        Environment.SetEnvironmentVariable("META_API_BASE", oldBase);
        Environment.SetEnvironmentVariable("META_API_KEY", oldKey);
        try { listener.Stop(); } catch { }
        try { listener.Close(); } catch { }
      }
    }
    Console.WriteLine(pass + " passed, " + fail + " failed");
    return fail == 0 ? 0 : 1;
  }
}
