using System.Net;
using System.Text;
using System.Text.Json;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;
using SimCEO.Api.Work;

static class UsageProbe
{
  const string Prefix = "http://127.0.0.1:5203/";
  static int Seq = 0;
  static int Main(string[] args) => RunAsync(args).GetAwaiter().GetResult();
  static int ChatHits = 0;
  static int ImageHits = 0;
  static string AsrMode = "absent";


  static async Task<int> RunAsync(string[] args)
  {
    var listener = new HttpListener();
    listener.Prefixes.Add(Prefix);
    try { listener.Start(); }
    catch (Exception ex)
    {
      Console.Error.WriteLine("PROBE FAIL: listener start: " + ex.Message);
      return 1;
    }
    var cts = new CancellationTokenSource();
    var serve = Task.Run(async () =>
    {
      while (listener.IsListening && !cts.Token.IsCancellationRequested)
      {
        HttpListenerContext ctx;
        try { ctx = await listener.GetContextAsync(); }
        catch { break; }
        string body = "";
        try
        {
          using var sr = new StreamReader(ctx.Request.InputStream, ctx.Request.ContentEncoding ?? Encoding.UTF8);
          body = await sr.ReadToEndAsync();
        }
        catch { }
        var (status, payload) = HandleWithStatus(ctx.Request.Url?.AbsolutePath ?? "", body);
        byte[] bytes = Encoding.UTF8.GetBytes(payload);
        try
        {
          ctx.Response.StatusCode = status;
          ctx.Response.ContentType = "application/json";
          ctx.Response.ContentLength64 = bytes.Length;
          await ctx.Response.OutputStream.WriteAsync(bytes, 0, bytes.Length);
        }
        catch { }
        finally { try { ctx.Response.OutputStream.Close(); } catch { } }
      }
    });
    Environment.SetEnvironmentVariable("META_API_BASE", "http://127.0.0.1:5203");
    Environment.SetEnvironmentVariable("META_API_KEY", "dummy-probe-key");
    int pass = 0; int fail = 0;
    var lines = new List<string>();
    void Check(string name, bool cond, string detail)
    {
      if (cond) { pass++; lines.Add("PASS " + name); Console.WriteLine("PASS " + name); }
      else { fail++; lines.Add("FAIL " + name + " :: " + detail); Console.WriteLine("FAIL " + name + " :: " + detail); }
    }
    try
    {
      var store = new InMemoryStore();
      var gw = new ModelGateway(store);
      string text = await gw.CompleteAsync("unknown-xyz-123", "model-test", "Reply with exactly: OK probe-one", 100, 512);
      Check("unknown-text-ok", text == "OK", "text=" + text);
      Check("unknown-ledger-once", store.ModelCalls.Count() == 1 && store.Usage.Count() == 1, "mc=" + store.ModelCalls.Count() + " u=" + store.Usage.Count());
      var call = store.ModelCalls.First();
      var row = store.Usage.First();
      Check("unknown-cost-null", call.Cost == null && row.Cost == null, "cost=" + (call.Cost == null ? "null" : call.Cost.ToString()) + "/" + (row.Cost == null ? "null" : row.Cost.ToString()));
      Check("unknown-status-succeeded", call.Status == "succeeded" && row.Status == "succeeded", call.Status + "/" + row.Status);
      Check("unknown-ids-match", call.Id == row.Id, call.Id.ToString() + " vs " + row.Id.ToString());
      Check("unknown-model-recorded", call.Model == "unknown-xyz-123" && row.Model == "unknown-xyz-123", call.Model);
      Check("unknown-no-spark-fallback", row.CostBasis != null && row.CostBasis.Contains("unknown model"), row.CostBasis ?? "null");
    }
    catch (Exception ex) { Check("unknown-no-throw", false, ex.GetType().Name + ": " + ex.Message); }
    try
    {
      var store = new InMemoryStore();
      var gw = new ModelGateway(store);
      string text = await gw.CompleteAsync("muse-spark-1.3", "model-test", "QA-CACHED probe-two", 100, 512);
      Check("cached-text-ok", text == "OK", "text=" + text);
      var row = store.Usage.First();
      Check("cached-tokens", row.InputTokens == 100 && row.CachedInputTokens == 40 && row.OutputTokens == 50, row.InputTokens + "/" + row.CachedInputTokens + "/" + row.OutputTokens);
      decimal expected = 60m / 1000000m * 1.25m + 40m / 1000000m * 0.15m + 50m / 1000000m * 4.25m;
      Check("cached-cost", row.Cost != null && row.Cost.Value == expected, "got=" + (row.Cost == null ? "null" : row.Cost.Value.ToString()) + " want=" + expected.ToString());
    }
    catch (Exception ex) { Check("cached-no-throw", false, ex.GetType().Name + ": " + ex.Message); }
    try
    {
      var store = new InMemoryStore();
      var gw = new ModelGateway(store);
      bool threw = false;
      try { await gw.CompleteAsync("muse-spark-1.3", "model-test", "QA-TRUNCATE probe-three", 100, 512); }
      catch (ProviderException) { threw = true; }
      Check("trunc-throws", threw, "no ProviderException");
      Check("trunc-ledger-once", store.ModelCalls.Count() == 1 && store.Usage.Count() == 1, "mc=" + store.ModelCalls.Count());
      var row = store.Usage.First();
      Check("trunc-status", row.Status == "truncated", row.Status);
      Check("trunc-billed", row.Cost != null && row.Cost.Value > 0, row.Cost == null ? "null" : row.Cost.Value.ToString());
    }
    catch (Exception ex) { Check("trunc-harness", false, ex.GetType().Name + ": " + ex.Message); }
    try
    {
      AsrMode = "official";
      var store = new InMemoryStore();
      var gw = new ModelGateway(store);
      var r = await gw.TranscribeAsync(new byte[] { 1, 2, 3 }, "audio/webm", "mic.webm", CancellationToken.None);
      Check("asr-official-text", r.transcript == "qa probe transcript", r.transcript);
      Check("asr-official-ledger-once", store.ModelCalls.Count() == 1 && store.Usage.Count() == 1, "mc=" + store.ModelCalls.Count());
      var row = store.Usage.First();
      decimal wantOfficial = 8m / 3600m * 0.18m;
      Check("asr-official-cost", row.Cost != null && row.Cost.Value == wantOfficial, row.Cost == null ? "null" : row.Cost.Value.ToString());
      Check("asr-official-status", row.Status == "succeeded", row.Status);
      Check("asr-official-ids", row.Id == store.ModelCalls.First().Id, "ids differ");
    }
    catch (Exception ex) { Check("asr-official-harness", false, ex.GetType().Name + ": " + ex.Message); }
    try
    {
      AsrMode = "absent";
      var store = new InMemoryStore();
      var gw = new ModelGateway(store);
      var r = await gw.TranscribeAsync(new byte[] { 1, 2, 3 }, "audio/webm", "mic.webm", CancellationToken.None);
      Check("asr-missing-text", r.transcript == "qa probe transcript", r.transcript);
      Check("asr-missing-ledger-once", store.ModelCalls.Count() == 1 && store.Usage.Count() == 1, "mc=" + store.ModelCalls.Count());
      var row = store.Usage.First();
      Check("asr-missing-unknown", row.Cost == null && row.Status == "unknown", (row.Cost == null ? "null" : row.Cost.Value.ToString()) + "/" + row.Status);
    }
    catch (Exception ex) { Check("asr-missing-harness", false, ex.GetType().Name + ": " + ex.Message); }
    try
    {
      AsrMode = "subsecond";
      var store = new InMemoryStore();
      var gw = new ModelGateway(store);
      var r = await gw.TranscribeAsync(new byte[] { 1, 2, 3 }, "audio/webm", "mic.webm", CancellationToken.None);
      var row = store.Usage.First();
      Check("asr-subsecond-known-zero", row.Cost != null && row.Cost.Value == 0m && row.Status == "succeeded", (row.Cost == null ? "null" : row.Cost.Value.ToString()) + "/" + row.Status);
      Check("asr-subsecond-ledger-once", store.ModelCalls.Count() == 1 && store.Usage.Count() == 1, "mc=" + store.ModelCalls.Count());
    }
    catch (Exception ex) { Check("asr-subsecond-harness", false, ex.GetType().Name + ": " + ex.Message); }
    try
    {
      AsrMode = "processed";
      var store = new InMemoryStore();
      var gw = new ModelGateway(store);
      var r = await gw.TranscribeAsync(new byte[] { 1, 2, 3 }, "audio/webm", "mic.webm", CancellationToken.None);
      var row = store.Usage.First();
      decimal wantLegacy = 5m / 3600m * 0.18m;
      Check("asr-legacy-cost", row.Cost != null && row.Cost.Value == wantLegacy, row.Cost == null ? "null" : row.Cost.Value.ToString());
      Check("asr-legacy-status", row.Status == "succeeded", row.Status);
    }
    catch (Exception ex) { Check("asr-legacy-harness", false, ex.GetType().Name + ": " + ex.Message); }
    try
    {
      var cts2 = new CancellationTokenSource();
      cts2.Cancel();
      var store = new InMemoryStore();
      var gw = new ModelGateway(store);
      int hitsBefore = ChatHits;
      bool threwCancel = false;
      try { await gw.CompleteAsync("muse-spark-1.3", "model-test", "Reply with exactly: OK pre-cancelled", 100, 512, cts2.Token); }
      catch (OperationCanceledException) { threwCancel = true; }
      Check("precancel-throws", threwCancel, "no OperationCanceledException");
      Check("precancel-zero-events", store.ModelCalls.Count() == 0 && store.Usage.Count() == 0, "mc=" + store.ModelCalls.Count() + " u=" + store.Usage.Count());
      Check("precancel-no-dispatch", ChatHits == hitsBefore, "hits delta=" + (ChatHits - hitsBefore));
    }
    catch (Exception ex) { Check("precancel-harness", false, ex.GetType().Name + ": " + ex.Message); }
    {
      var savedKey = Environment.GetEnvironmentVariable("META_API_KEY");
      Environment.SetEnvironmentVariable("META_API_KEY", null);
      var store = new InMemoryStore();
      var gw = new ModelGateway(store);
      bool threwKey = false;
      try { await gw.CompleteAsync("muse-spark-1.3", "model-test", "Reply with exactly: OK no-key", 100, 512); }
      catch (ProviderNotConfiguredException) { threwKey = true; }
      catch (Exception ex) { Check("nokey-harness", false, ex.GetType().Name + ": " + ex.Message); threwKey = true; }
      Check("nokey-throws", threwKey, "no ProviderNotConfiguredException");
      Check("nokey-zero-events", store.ModelCalls.Count() == 0 && store.Usage.Count() == 0, "mc=" + store.ModelCalls.Count() + " u=" + store.Usage.Count());
      Environment.SetEnvironmentVariable("META_API_KEY", savedKey);
    }
    {
      var store = new InMemoryStore();
      var gw = new ModelGateway(store);
      bool threwM = false;
      try { await gw.GenerateImagesAsync("QA-IMG-MALFORMED probe", 2); }
      catch (ProviderException) { threwM = true; }
      Check("img-malformed-throws", threwM, "no ProviderException");
      Check("img-malformed-once", store.ModelCalls.Count() == 1 && store.Usage.Count() == 1, "mc=" + store.ModelCalls.Count());
      var mrow = store.Usage.First();
      Check("img-malformed-unknown", mrow.Cost == null && mrow.Status == "failed", (mrow.Cost == null ? "null" : mrow.Cost.Value.ToString()) + "/" + mrow.Status);
    }
    {
      var store = new InMemoryStore();
      var gw = new ModelGateway(store);
      var imgs = await gw.GenerateImagesAsync("QA-IMG-EMPTY probe", 2);
      Check("img-empty-zero", imgs.Count == 0, "images=" + imgs.Count);
      var erow = store.Usage.First();
      Check("img-empty-known-zero", erow.Cost != null && erow.Cost.Value == 0m && erow.Status == "succeeded", (erow.Cost == null ? "null" : erow.Cost.Value.ToString()) + "/" + erow.Status);
    }
    {
      var store = new InMemoryStore();
      var gw = new ModelGateway(store);
      bool threwMix = false;
      try { await gw.GenerateImagesAsync("QA-IMG-MIXED probe", 4); } catch (ProviderException) { threwMix = true; }
      Check("img-mixed-throws", threwMix, "mixed must fail, not succeed");
      Check("img-mixed-once", store.ModelCalls.Count() == 1 && store.Usage.Count() == 1, "mc=" + store.ModelCalls.Count());
      var xrow = store.Usage.First();
      Check("img-mixed-unknown-total", xrow.Cost == null && (xrow.Status == "failed" || xrow.Status == "unknown"), (xrow.Cost == null ? "null" : xrow.Cost.Value.ToString()) + "/" + xrow.Status);
    }
    {
      var store = new InMemoryStore();
      var gw = new ModelGateway(store);
      var imgs = await gw.GenerateImagesAsync("QA-IMG-PARTIAL probe", 4);
      Check("img-partial-one", imgs.Count == 1, "images=" + imgs.Count);
      var prow = store.Usage.First();
      Check("img-partial-cost", prow.Cost != null && prow.Cost.Value == 0.01m, prow.Cost == null ? "null" : prow.Cost.Value.ToString());
    }
    {
      var store = new InMemoryStore();
      var gw = new ModelGateway(store);
      bool threwUrl = false;
      string urlMsg = "";
      try { await gw.GenerateImagesAsync("QA-IMG-URL probe", 2); } catch (ProviderException ex) { threwUrl = true; urlMsg = ex.Message; }
      Check("img-url-delivery-fails", threwUrl && !urlMsg.Contains("https://qa.example"), "URL-only must fail local delivery with redacted error, not succeed empty");
      Check("img-url-once", store.ModelCalls.Count() == 1 && store.Usage.Count() == 1, "mc=" + store.ModelCalls.Count());
      var urow = store.Usage.First();
      Check("img-url-known-cost", urow.Cost != null && urow.Cost.Value == 0.01m && urow.Status == "failed", (urow.Cost == null ? "null" : urow.Cost.Value.ToString()) + "/" + urow.Status);
    }
    {
      var store = new InMemoryStore();
      var gw = new ModelGateway(store);
      bool threwN = false;
      try { await gw.GenerateImagesAsync("QA-IMG-NODATA probe", 2); }
      catch (ProviderException) { threwN = true; }
      Check("img-nodata-throws", threwN, "no ProviderException");
      var nrow = store.Usage.First();
      Check("img-nodata-unknown", nrow.Cost == null && nrow.Status == "unknown", (nrow.Cost == null ? "null" : nrow.Cost.Value.ToString()) + "/" + nrow.Status);
    }
    // Long error body: trailing usage/ID parsed before truncation
    {
      var store = new InMemoryStore();
      var gw = new ModelGateway(store);
      bool threw = false;
      try { await gw.CompleteAsync("muse-spark-1.3", "model-test", "Reply with exactly: OK QA-HTTP500-LONG probe", 100, 512); }
      catch (ProviderException) { threw = true; }
      Check("long-throws", threw, "no ProviderException");
      Check("long-once", store.ModelCalls.Count() == 1 && store.Usage.Count() == 1, "mc=" + store.ModelCalls.Count());
      var row = store.Usage.First();
      decimal wantLong = 120m / 1000000m * 1.25m + 16m / 1000000m * 4.25m;
      Check("long-billed", row.Cost != null && row.Cost.Value == wantLong && row.Status == "failed", (row.Cost == null ? "null" : row.Cost.Value.ToString()) + "/" + row.Status);
      Check("long-id", row.ProviderCallId == "qa-long-billed-1", row.ProviderCallId ?? "null");
    }
    // ID-only error: observable id preserved with unknown TOTAL
    {
      var store = new InMemoryStore();
      var gw = new ModelGateway(store);
      bool threw = false;
      try { await gw.CompleteAsync("muse-spark-1.3", "model-test", "Reply with exactly: OK QA-HTTP500-IDONLY probe", 100, 512); }
      catch (ProviderException) { threw = true; }
      Check("idonly-throws", threw, "no ProviderException");
      var row = store.Usage.First();
      Check("idonly-unknown", row.Cost == null && row.Status == "failed" && row.ProviderCallId == "qa-only-id-9", (row.Cost == null ? "null" : row.Cost.Value.ToString()) + "/" + row.Status + "/" + (row.ProviderCallId ?? "null"));
    }
    // Invalid usage values are unknown, never negative or clamped
    foreach (var tag in new[] { "QA-USAGE-NEG", "QA-USAGE-CACHEOVER", "QA-USAGE-BADTYPE" })
    {
      var store = new InMemoryStore();
      var gw = new ModelGateway(store);
      string itext = "";
      bool threw = false;
      try { itext = await gw.CompleteAsync("muse-spark-1.3", "model-test", "Reply with exactly: OK " + tag + " probe", 100, 512); }
      catch (ProviderException) { threw = true; }
      Check("invalid-" + tag + "-success-unknown", !threw && itext == "OK", "threw=" + threw + " text=" + itext);
      var row = store.Usage.First();
      Check("invalid-" + tag + "-unknown", row.Cost == null && row.Status == "succeeded" && (row.Cost == null || row.Cost.Value >= 0), (row.Cost == null ? "null" : row.Cost.Value.ToString()) + "/" + row.Status);
    }
    // Failed grounded response with observable search bills tokens + search
    {
      var store = new InMemoryStore();
      var gw = new ModelGateway(store);
      bool threw = false;
      try { await gw.CompleteGroundedAsync("muse-spark-1.3", "advisor-research", "probe QA-RESEARCHERR-SEARCH prompt", 100, 512); }
      catch (ProviderException) { threw = true; }
      Check("resp-search-throws", threw, "no ProviderException");
      var row = store.Usage.First();
      decimal want = 40m / 1000000m * 1.25m + 10m / 1000000m * 4.25m + 1m / 1000m * 2.50m;
      Check("resp-search-billed", row.Cost != null && row.Cost.Value == want && row.SearchCalls == 1 && row.RanSearch, (row.Cost == null ? "null" : row.Cost.Value.ToString()) + "/s=" + row.SearchCalls);
      Check("resp-search-id", row.ProviderCallId == "qa-resp-failed-search-1", row.ProviderCallId ?? "null");
    }
    // Chat alias conflicts: valid content + invalid/conflicting usage => success with unknown cost
    foreach (var tag in new[] { "QA-USAGE-CONFLICT", "QA-USAGE-CACHED-CONFLICT", "QA-USAGE-BROKEN-DETAILS" })
    {
      var store = new InMemoryStore();
      var gw = new ModelGateway(store);
      string txt = "";
      bool threw = false;
      try { txt = await gw.CompleteAsync("muse-spark-1.3", "model-test", "Reply with exactly: OK " + tag + " probe", 100, 512); }
      catch (ProviderException) { threw = true; }
      Check("alias-" + tag + "-success", !threw && txt == "OK", "threw=" + threw + " text=" + txt);
      var rrow = store.Usage.First();
      Check("alias-" + tag + "-unknown", rrow.Cost == null && rrow.Status == "succeeded", (rrow.Cost == null ? "null" : rrow.Cost.Value.ToString()) + "/" + rrow.Status);
    }
    // Chat canary: redacted outward, billing preserved, ledger clean
    {
      var store = new InMemoryStore();
      var gw = new ModelGateway(store);
      string emsg = "";
      bool threw = false;
      try { await gw.CompleteAsync("muse-spark-1.3", "model-test", "Reply with exactly: OK QA-HTTP500-CANARY probe", 100, 512); }
      catch (ProviderException ex) { threw = true; emsg = ex.Message; }
      Check("chat-canary-throws", threw, "no throw");
      Check("chat-canary-redacted", !emsg.Contains("QA-CANARY"), emsg.Substring(0, Math.Min(200, emsg.Length)));
      var rrow = store.Usage.First();
      Check("chat-canary-ledger-clean", !JsonSerializer.Serialize(rrow).Contains("QA-CANARY"), "canary in ledger");
      Check("chat-canary-id", rrow.ProviderCallId == "qa-canary-1", rrow.ProviderCallId ?? "null");
    }
    // Chat oversized: one unknown pair, safe error
    {
      var store = new InMemoryStore();
      var gw = new ModelGateway(store);
      bool threw = false;
      try { await gw.CompleteAsync("muse-spark-1.3", "model-test", "Reply with exactly: OK QA-HTTP500-OVERSIZED probe", 100, 512); }
      catch (ProviderException) { threw = true; }
      Check("chat-oversized-throws", threw, "no throw");
      Check("chat-oversized-once", store.ModelCalls.Count() == 1 && store.Usage.Count() == 1, "counts");
      Check("chat-oversized-unknown", store.Usage.First().Cost == null, "cost known");
    }
    // Grounded observability: empty proves 0, null/malformed unobservable
    {
      var store = new InMemoryStore();
      var gw = new ModelGateway(store);
      bool threw = false;
      try { await gw.CompleteGroundedAsync("muse-spark-1.3", "advisor-research", "probe QA-RESEARCHERR-EMPTY-OUTPUT prompt", 100, 512); }
      catch (ProviderException) { threw = true; }
      var rrow = store.Usage.First();
      Check("resp-empty-known", threw && rrow.Cost != null && rrow.SearchCalls == 0, (rrow.Cost == null ? "null" : rrow.Cost.Value.ToString()) + "/s=" + rrow.SearchCalls);
    }
    {
      var store = new InMemoryStore();
      var gw = new ModelGateway(store);
      bool threw = false;
      try { await gw.CompleteGroundedAsync("muse-spark-1.3", "advisor-research", "probe QA-RESEARCHERR-NULL-OUTPUT prompt", 100, 512); }
      catch (ProviderException) { threw = true; }
      Check("resp-null-unknown", threw && store.Usage.First().Cost == null, "cost known");
    }
    {
      var store = new InMemoryStore();
      var gw = new ModelGateway(store);
      bool threw = false;
      try { await gw.CompleteGroundedAsync("muse-spark-1.3", "advisor-research", "probe QA-RESEARCHERR-MALFORMED-OUTPUT prompt", 100, 512); }
      catch (ProviderException) { threw = true; }
      Check("resp-mal-unknown", threw && store.Usage.First().Cost == null, "cost known");
    }
    // Images: hello/badurl/pngurl/idonly + canary-less redaction is API-level
    {
      var store = new InMemoryStore();
      var gw = new ModelGateway(store);
      bool threw = false;
      try { await gw.GenerateImagesAsync("QA-IMG-HELLO probe", 1); } catch (ProviderException) { threw = true; }
      var rrow = store.Usage.First();
      Check("img-hello-unknown", threw && rrow.Cost == null && rrow.ProviderCallId == "qa-img-hello-1", (rrow.Cost == null ? "null" : rrow.Cost.Value.ToString()) + "/" + (rrow.ProviderCallId ?? "null"));
    }
    {
      var store = new InMemoryStore();
      var gw = new ModelGateway(store);
      bool threw = false;
      try { await gw.GenerateImagesAsync("QA-IMG-BADURL probe", 1); } catch (ProviderException) { threw = true; }
      var rrow = store.Usage.First();
      Check("img-badurl-unknown", threw && rrow.Cost == null && rrow.ProviderCallId == "qa-img-badurl-1", (rrow.ProviderCallId ?? "null"));
    }
    {
      var store = new InMemoryStore();
      var gw = new ModelGateway(store);
      bool threw = false;
      try { await gw.GenerateImagesAsync("QA-IMG-PNGURL probe", 2); } catch (ProviderException ex) { threw = ex.Message.Length > 0; }
      var rrow = store.Usage.First();
      Check("img-pngurl-delivery-fail", threw && rrow.Cost != null && rrow.Cost.Value == 0.02m && rrow.Status == "failed", (rrow.Cost == null ? "null" : rrow.Cost.Value.ToString()) + "/" + rrow.Status);
    }
    {
      var store = new InMemoryStore();
      var gw = new ModelGateway(store);
      bool threw = false;
      try { await gw.GenerateImagesAsync("QA-IMG-IDONLY probe", 1); } catch (ProviderException) { threw = true; }
      Check("img-idonly-id", threw && store.Usage.First().ProviderCallId == "qa-img-failed-7", store.Usage.First().ProviderCallId ?? "null");
    }
    // Mixed malformed output preserves observed search with null total (all paths)
    foreach (var tag in new[] { "QA-RESP-MIXED-AFTER", "QA-RESP-MIXED-BEFORE" })
    {
      var store = new InMemoryStore();
      var gw = new ModelGateway(store);
      string mtext = "";
      bool threw = false;
      try { var gr = await gw.CompleteGroundedAsync("muse-spark-1.3", "advisor-research", "probe " + tag + " prompt", 100, 512); mtext = gr.Text; }
      catch (ProviderException) { threw = true; }
      Check("mix-" + tag + "-success", !threw && mtext.Contains("QA line one"), "threw=" + threw + " text=" + mtext);
      var row = store.Usage.First();
      Check("mix-" + tag + "-observed-null", row.Cost == null && row.SearchCalls == 1 && row.RanSearch && row.Status == "succeeded", (row.Cost == null ? "null" : row.Cost.Value.ToString()) + "/s=" + row.SearchCalls + "/" + row.Status);
    }
    {
      var store = new InMemoryStore();
      var gw = new ModelGateway(store);
      bool threw = false;
      try { await gw.CompleteGroundedAsync("muse-spark-1.3", "advisor-research", "probe QA-RESP-INCOMPLETE-MIXED prompt", 100, 512); }
      catch (ProviderException) { threw = true; }
      var row = store.Usage.First();
      Check("mix-inc-observed-null", threw && row.Cost == null && row.SearchCalls == 1 && row.RanSearch && row.Status == "incomplete", (row.Cost == null ? "null" : row.Cost.Value.ToString()) + "/s=" + row.SearchCalls + "/" + row.Status);
    }
    {
      var store = new InMemoryStore();
      var gw = new ModelGateway(store);
      bool threw = false;
      try { await gw.CompleteGroundedAsync("muse-spark-1.3", "advisor-research", "probe QA-RESEARCHERR-MIXED prompt", 100, 512); }
      catch (ProviderException) { threw = true; }
      var row = store.Usage.First();
      Check("mix-err-observed-null", threw && row.Cost == null && row.SearchCalls == 1 && row.RanSearch && row.ProviderCallId == "qa-resp-errmix-1", (row.ProviderCallId ?? "null") + "/s=" + row.SearchCalls);
    }
    {
      var store = new InMemoryStore();
      var gw = new ModelGateway(store);
      bool threw = false;
      try { await gw.CompleteGroundedAsync("muse-spark-1.3", "advisor-research", "probe QA-RESEARCHERR-PREFIX-OVER prompt", 100, 512); }
      catch (ProviderException) { threw = true; }
      var row = store.Usage.First();
      Check("prefix-over-unknown", threw && row.Cost == null && row.SearchCalls == 1 && row.RanSearch && row.ProviderCallId == "qa-resp-prefix-1", (row.ProviderCallId ?? "null") + "/s=" + row.SearchCalls);
    }
    // Realistic large images succeed with known cost and real bytes
    {
      var store = new InMemoryStore();
      var gw = new ModelGateway(store);
      var imgs = await gw.GenerateImagesAsync("QA-IMG-BIGPNG probe", 1);
      Check("img-bigpng-ok", imgs.Count == 1 && imgs[0].Length > 131072, "count=" + imgs.Count);
      var row = store.Usage.First();
      Check("img-bigpng-known", row.Cost != null && row.Cost.Value == 0.01m && row.Status == "succeeded", (row.Cost == null ? "null" : row.Cost.Value.ToString()));
    }
    {
      var store = new InMemoryStore();
      var gw = new ModelGateway(store);
      var imgs = await gw.GenerateImagesAsync("QA-IMG-BIGJPEG probe", 1);
      Check("img-bigjpg-ok", imgs.Count == 1 && imgs[0].Length > 1000, "count=" + imgs.Count);
      var row = store.Usage.First();
      Check("img-bigjpg-known", row.Cost != null && row.Cost.Value == 0.01m && row.Status == "succeeded", (row.Cost == null ? "null" : row.Cost.Value.ToString()));
    }
    // Signature-only / truncated / bad-dims rejected with IDs
    foreach (var tag in new[] { "QA-IMG-SIGONLY-PNG", "QA-IMG-TRUNC", "QA-IMG-BADDIMS" })
    {
      var store = new InMemoryStore();
      var gw = new ModelGateway(store);
      bool threw = false;
      try { await gw.GenerateImagesAsync(tag + " probe", 1); } catch (ProviderException) { threw = true; }
      var row = store.Usage.First();
      Check("imgneg-" + tag + "-unknown", threw && row.Cost == null, "cost known");
    }
    {
      var store = new InMemoryStore();
      var gw = new ModelGateway(store);
      bool threw = false;
      try { await gw.GenerateImagesAsync("QA-IMG-OVER probe", 1); } catch (ProviderException ex) { threw = ex.Message.Contains("oversized"); }
      Check("img-over-safe", threw, "no oversized failure");
      Check("img-over-unknown", store.Usage.First().Cost == null, "cost known");
    }
    // ASR malformed JSON: canary-free ledger and error
    {
      AsrMode = "badjson";
      var store = new InMemoryStore();
      var gw = new ModelGateway(store);
      string em = "";
      bool threw = false;
      try { await gw.TranscribeAsync(new byte[] { 1, 2, 3 }, "audio/webm", "mic.webm", CancellationToken.None); }
      catch (ProviderException ex) { threw = true; em = ex.Message; }
      Check("asr-badjson-throws", threw, "no throw");
      Check("asr-badjson-redacted", !em.Contains("QA-CANARY"), em.Substring(0, Math.Min(200, em.Length)));
      Check("asr-badjson-ledger-clean", !JsonSerializer.Serialize(store.Usage.First()).Contains("QA-CANARY"), "canary in ledger");
      AsrMode = "absent";
    }
    // Duplicate/null billing names: unknown with successful text delivery
    foreach (var tag in new[] { "QA-USAGE-DUP-PROMPT", "QA-USAGE-DUP-CACHED", "QA-USAGE-NULL-DETAILS", "QA-USAGE-NULL-INPUT-DETAILS" })
    {
      var store = new InMemoryStore();
      var gw = new ModelGateway(store);
      string txt = "";
      bool threw = false;
      try { txt = await gw.CompleteAsync("muse-spark-1.3", "model-test", "Reply with exactly: OK " + tag + " probe", 100, 512); }
      catch (ProviderException) { threw = true; }
      var row = store.Usage.First();
      Check("dup2-" + tag + "-unknown", !threw && txt == "OK" && row.Cost == null && row.Status == "succeeded", "threw=" + threw);
    }
    if (args.Contains("--pg"))
    {
      string pgCs = Environment.GetEnvironmentVariable("QA_PG_CS") ?? "Host=127.0.0.1;Port=5106;Database=simceo;Username=simceo;Password=simceo-dev-only";
      IPgBackend? realBackend = null;
      try
      {
        if (!SimCEO.Postgres.PgBoot.TryWire(pgCs, out var werr)) throw new InvalidOperationException("pg wire failed: " + werr);
        realBackend = Pg.Backend;
        Check("pg-wire", realBackend is not null, werr);
      }
      catch (Exception ex) { Check("pg-wire", false, ex.GetType().Name + ": " + ex.Message); }
      if (realBackend is not null)
      {
        System.Collections.Generic.HashSet<Guid> PgIdsU() => new System.Collections.Generic.HashSet<Guid>(realBackend.All<UsageRow>().Select(r => r.Id));
        System.Collections.Generic.HashSet<Guid> PgIdsC() => new System.Collections.Generic.HashSet<Guid>(realBackend.All<ModelCall>().Select(c => c.Id));
        Guid pgBid = Guid.NewGuid(); Guid pgMid = Guid.NewGuid();
        var uBeforeA = PgIdsU();
        var cBeforeA = PgIdsC();
        var pgStore = new InMemoryStore();
        var pgGw = new ModelGateway(pgStore);
        string pgText = await pgGw.CompleteAsync("muse-spark-1.3", "model-test", "Reply with exactly: OK pg-atomic", 100, 512, CancellationToken.None, false, pgBid, pgMid);
        Check("pg-atomic-text", pgText == "OK", pgText);
        var newU = realBackend.All<UsageRow>().Where(r => !uBeforeA.Contains(r.Id)).ToList();
        var newC = realBackend.All<ModelCall>().Where(c => !cBeforeA.Contains(c.Id)).ToList();
        Check("pg-atomic-once-each", newU.Count == 1 && newC.Count == 1, "u=" + newU.Count + " c=" + newC.Count);
        Check("pg-atomic-pair", newU.Count == 1 && newC.Count == 1 && newU[0].Id == newC[0].Id, "ids differ");
        var dbRow = newU.Count == 1 ? newU[0] : null;
        Check("pg-atomic-fields", dbRow is not null && dbRow.Cost == pgStore.Usage.FirstOrDefault(r => r.Id == dbRow.Id)?.Cost && dbRow.Status == "succeeded" && dbRow.Model == "muse-spark-1.3" && dbRow.Kind == "model-test" && dbRow.BoardId == pgBid && dbRow.MeetingId == pgMid && dbRow.InputTokens == 10 && dbRow.OutputTokens == 10, "field mismatch");
        var fail1 = new FailBackend(realBackend) { FailOnUpsert = 1 };
        Pg.Backend = fail1;
        int hitsBefore = ChatHits;
        var uIdsBefore1 = PgIdsU();
        var cIdsBefore1 = PgIdsC();
        bool threwStore1 = false;
        try { await new ModelGateway(new InMemoryStore()).CompleteAsync("muse-spark-1.3", "model-test", "Reply with exactly: OK pg-fail1", 100, 512); }
        catch (UsageStorageException) { threwStore1 = true; }
        catch (Exception ex) { Check("pg-fail1-type", false, ex.GetType().Name); threwStore1 = true; }
        Check("pg-fail1-storage", threwStore1, "no UsageStorageException");
        Check("pg-fail1-attempts", fail1.Upserts == 1, "upserts=" + fail1.Upserts + " want 1 (no retry/second finalization)");
        Check("pg-fail1-no-new-usage", PgIdsU().SetEquals(uIdsBefore1), "usage ids changed");
        Check("pg-fail1-no-new-calls", PgIdsC().SetEquals(cIdsBefore1), "call ids changed");
        Check("pg-fail1-no-second-record", realBackend.All<UsageRow>().Count == uIdsBefore1.Count && realBackend.All<ModelCall>().Count == cIdsBefore1.Count, "second record leaked");
        Check("pg-fail1-dispatched-once", ChatHits == hitsBefore + 1, "hits delta=" + (ChatHits - hitsBefore));
        var fail2 = new FailBackend(realBackend) { FailOnUpsert = 2 };
        Pg.Backend = fail2;
        var uIdsBefore2 = PgIdsU();
        var cIdsBefore2 = PgIdsC();
        bool threwStore2 = false;
        try { await new ModelGateway(new InMemoryStore()).CompleteAsync("muse-spark-1.3", "model-test", "Reply with exactly: OK pg-fail2", 100, 512); }
        catch (UsageStorageException) { threwStore2 = true; }
        catch (Exception ex) { Check("pg-fail2-type", false, ex.GetType().Name); threwStore2 = true; }
        Check("pg-fail2-storage", threwStore2, "no UsageStorageException");
        Check("pg-fail2-attempts", fail2.Upserts == 2, "upserts=" + fail2.Upserts + " want 2 (one pair, no second attempt)");
        Check("pg-fail2-no-new-usage", PgIdsU().SetEquals(uIdsBefore2), "usage ids changed");
        Check("pg-fail2-no-new-calls", PgIdsC().SetEquals(cIdsBefore2), "call ids changed");
        Check("pg-fail2-rolled-back", realBackend.All<UsageRow>().Count == uIdsBefore2.Count && realBackend.All<ModelCall>().Count == cIdsBefore2.Count, "db changed");
        Pg.Backend = realBackend;
        // Context usable BEFORE the real deferred COMMIT test (mutation allowed here; none after).
        {
          var uBeforeOk = PgIdsU();
          var okStore = new InMemoryStore();
          var okGw = new ModelGateway(okStore);
          string okText = await okGw.CompleteAsync("muse-spark-1.3", "model-test", "Reply with exactly: OK pg-before-commit", 100, 512);
          var okNew = realBackend.All<UsageRow>().Where(r => !uBeforeOk.Contains(r.Id)).ToList();
          Check("pg-context-usable", okText == "OK" && okNew.Count == 1, okText + " new=" + okNew.Count);
        }
        // REAL deferred COMMIT failure through actual ModelGateway RecordFull: one pair, one attempt, exact IDs, no ghosts.
        // Deferred constraint trigger fires at COMMIT (after successful SaveChanges), proving rollback of both rows.
        // This is the LAST mutating-adjacent PG test: after it, only reads + evidence + trigger cleanup run in-process;
        // the actual API-process restart and absence/preservation verification happen outside this process.
        Guid commitSentinel = Guid.NewGuid();
        try
        {
          using var trigConn = new Npgsql.NpgsqlConnection(pgCs);
          await trigConn.OpenAsync();
          var sentinelLit = commitSentinel.ToString();
          using (var cmd = new Npgsql.NpgsqlCommand("CREATE OR REPLACE FUNCTION qa_fail_commit() RETURNS trigger AS $$ BEGIN IF NEW.\"BoardId\" = '" + sentinelLit + "' THEN RAISE EXCEPTION 'qa injected commit failure at COMMIT'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;", trigConn))
            await cmd.ExecuteNonQueryAsync();
          using (var cmd2 = new Npgsql.NpgsqlCommand("DROP TRIGGER IF EXISTS qa_usage_commit_fail ON \"UsageRows\";", trigConn))
            await cmd2.ExecuteNonQueryAsync();
          using (var cmd3 = new Npgsql.NpgsqlCommand("CREATE CONSTRAINT TRIGGER qa_usage_commit_fail AFTER INSERT ON \"UsageRows\" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qa_fail_commit();", trigConn))
            await cmd3.ExecuteNonQueryAsync();
        }
        catch (Exception ex) { Check("pg-commit-trigger-setup", false, ex.GetType().Name + ": " + ex.Message); }
        var uIdsBeforeC = PgIdsU();
        var cIdsBeforeC = PgIdsC();
        int hitsBeforeC = ChatHits;
        string snapU = "";
        string snapC = "";
        try
        {
          var allU = realBackend.All<UsageRow>().OrderBy(r => r.Id).ToList();
          var allC = realBackend.All<ModelCall>().OrderBy(c => c.Id).ToList();
          snapU = JsonSerializer.Serialize(allU.Select(r => new { r.Id, r.Kind, r.Model, r.InputTokens, r.OutputTokens, r.CachedInputTokens, r.SearchCalls, r.LatencyMs, r.RanSearch, r.Status, r.ProviderCallId, r.Cost, r.CostBasis, r.BoardId, r.MeetingId, r.At, r.Note }));
          snapC = JsonSerializer.Serialize(allC.Select(c => new { c.Id, c.Model, c.Purpose, c.InputTokens, c.OutputTokens, c.CachedInputTokens, c.LatencyMs, c.RanSearch, c.SearchCalls, c.ProviderCallId, c.Status, c.Cost, c.CostBasis, c.BoardId, c.MeetingId, c.SearchNote, c.At }));
        }
        catch (Exception ex) { Check("pg-commit-snapshot", false, ex.GetType().Name + ": " + ex.Message); }
        var recordCommit = new FailBackend(realBackend) { FailOnUpsert = -1 };
        Pg.Backend = recordCommit;
        bool threwCommit = false;
        bool isStorageErr = false;
        string commitSqlState = "";
        string commitTrigger = "";
        string commitStage = "";
        try
        {
          var commitStore = new InMemoryStore();
          var commitGw = new ModelGateway(commitStore);
          await commitGw.CompleteAsync("muse-spark-1.3", "model-test", "Reply with exactly: OK pg-commit-real", 100, 512, CancellationToken.None, false, commitSentinel, null);
        }
        catch (UsageStorageException ex)
        {
          threwCommit = true; isStorageErr = true;
          for (var e = (Exception?)ex; e != null; e = e.InnerException)
          {
            if (e is Npgsql.PostgresException pg)
            {
              commitSqlState = pg.SqlState ?? "";
              var m = pg.Message ?? "";
              if (m.Contains("qa_usage_commit_fail") || m.Contains("qa injected commit failure")) commitTrigger = "qa_usage_commit_fail";
            }
          }
          commitStage = commitSqlState == "P0001" && commitTrigger == "qa_usage_commit_fail" ? "commit" : "unknown";
        }
        catch (Exception ex) { Check("pg-commit-type", false, ex.GetType().Name + ": " + ex.Message); threwCommit = true; }
        Pg.Backend = realBackend;
        Check("pg-commit-fails", threwCommit && isStorageErr, "no UsageStorageException from deferred COMMIT");
        Check("pg-commit-typed-cause", commitSqlState == "P0001" && commitTrigger == "qa_usage_commit_fail", "sqlState=" + commitSqlState + " trigger=" + commitTrigger);
        Check("pg-commit-stage", commitStage == "commit", "stage=" + commitStage + " (want deferred-COMMIT, not SaveChanges)");
        Check("pg-commit-attempts", recordCommit.Upserts == 2, "upserts=" + recordCommit.Upserts + " want 2 (one pair, no retry/second finalization)");
        var attemptedIds = recordCommit.Attempted.Select(a => a.Id).Distinct().ToList();
        Check("pg-commit-attempted-pair", recordCommit.Attempted.Count == 2 && attemptedIds.Count == 1 && attemptedIds[0] != Guid.Empty, "attempts=" + string.Join(",", recordCommit.Attempted.Select(a => a.Table + ":" + a.Id)));
        Check("pg-commit-single-dispatch", ChatHits == hitsBeforeC + 1, "hits delta=" + (ChatHits - hitsBeforeC) + " want exactly 1");
        var uIdsAfterC = PgIdsU();
        var cIdsAfterC = PgIdsC();
        Check("pg-commit-no-new-usage", uIdsAfterC.SetEquals(uIdsBeforeC), "usage ids changed");
        Check("pg-commit-no-new-calls", cIdsAfterC.SetEquals(cIdsBeforeC), "call ids changed");
        Check("pg-commit-no-ghost", uIdsAfterC.Count == uIdsBeforeC.Count && cIdsAfterC.Count == cIdsBeforeC.Count, "ghost rows visible");
        // raw SQL absence by the exact attempted pair ID (parameterized), both tables
        try
        {
          using var rawConn = new Npgsql.NpgsqlConnection(pgCs);
          await rawConn.OpenAsync();
          int cu = -1, cm = -1;
          using (var rawCmd = new Npgsql.NpgsqlCommand("SELECT count(*) FROM \"UsageRows\" WHERE \"Id\" = @id", rawConn))
          {
            rawCmd.Parameters.AddWithValue("id", attemptedIds.Count == 1 ? attemptedIds[0] : Guid.Empty);
            cu = Convert.ToInt32(await rawCmd.ExecuteScalarAsync());
          }
          using (var rawCmd2 = new Npgsql.NpgsqlCommand("SELECT count(*) FROM \"ModelCalls\" WHERE \"Id\" = @id", rawConn))
          {
            rawCmd2.Parameters.AddWithValue("id", attemptedIds.Count == 1 ? attemptedIds[0] : Guid.Empty);
            cm = Convert.ToInt32(await rawCmd2.ExecuteScalarAsync());
          }
          Check("pg-commit-raw-absent", cu == 0 && cm == 0, "usage=" + cu + " calls=" + cm + " id=" + (attemptedIds.Count == 1 ? attemptedIds[0].ToString() : "none"));
        }
        catch (Exception ex) { Check("pg-commit-raw-absent", false, ex.GetType().Name + ": " + ex.Message); }
        // evidence for the out-of-process actual-restart verification (no rewire here)
        try
        {
          var ev = new { attemptedIds = attemptedIds.Select(g => g.ToString()).ToList(), sqlState = commitSqlState, trigger = commitTrigger, stage = commitStage, usageRows = snapU, modelCalls = snapC, usageCount = uIdsAfterC.Count, callCount = cIdsAfterC.Count, chatHits = ChatHits };
          System.IO.Directory.CreateDirectory(".tmp/phase9");
          System.IO.File.WriteAllText(".tmp/phase9/commit-proof.json", JsonSerializer.Serialize(ev));
          Check("pg-commit-evidence", attemptedIds.Count == 1 && snapU.Length > 2 && snapC.Length > 2, "evidence incomplete");
        }
        catch (Exception ex) { Check("pg-commit-evidence", false, ex.GetType().Name + ": " + ex.Message); }
        try
        {
          using var dropConn = new Npgsql.NpgsqlConnection(pgCs);
          await dropConn.OpenAsync();
          using var dropCmd = new Npgsql.NpgsqlCommand("DROP TRIGGER IF EXISTS qa_usage_commit_fail ON \"UsageRows\"; DROP FUNCTION IF EXISTS qa_fail_commit();", dropConn);
          await dropCmd.ExecuteNonQueryAsync();
          Check("pg-commit-trigger-cleanup", true, "");
        }
        catch (Exception ex) { Check("pg-commit-trigger-cleanup", false, ex.GetType().Name + ": " + ex.Message); }
        // original backend still usable (read-only check; no mutation after the COMMIT test)
        try
        {
          var rcU = realBackend.All<UsageRow>().Count;
          var rcC = realBackend.All<ModelCall>().Count;
          Check("pg-original-usable", rcU == uIdsAfterC.Count && rcC == cIdsAfterC.Count, "counts " + rcU + "/" + rcC);
        }
        catch (Exception ex) { Check("pg-original-usable", false, ex.GetType().Name + ": " + ex.Message); }
        // PG ledger read failure must surface, not return successful empty.
        {
          var failing = new FailReadBackend(realBackend);
          Pg.Backend = failing;
          bool threwRead = false;
          try { var _ = new InMemoryStore().Usage.Count(); }
          catch { threwRead = true; }
          Check("pg-read-fails", threwRead, "enumeration did not throw");
          Pg.Backend = realBackend;
        }

      }
    }
    try { cts.Cancel(); listener.Stop(); listener.Close(); } catch { }
    try { await serve.WaitAsync(TimeSpan.FromSeconds(3)); } catch { }
    string resultPath = ".tmp/phase9/usage-probe-result.txt";
    try
    {
      var sb = new StringBuilder();
      sb.AppendLine("usage gateway probe (real ModelGateway vs loopback 127.0.0.1:5203)");
      foreach (var l in lines) sb.AppendLine(l);
      sb.AppendLine("PROBE pass=" + pass + " fail=" + fail);
      System.IO.Directory.CreateDirectory(".tmp/phase9");
      System.IO.File.WriteAllText(resultPath, sb.ToString());
      Console.WriteLine("PROBE pass=" + pass + " fail=" + fail);
      Console.WriteLine("result: " + resultPath);
    }
    catch (Exception ex) { Console.Error.WriteLine("cannot write result: " + ex.Message); }
    return fail == 0 ? 0 : 1;
  }

  static string Handle(string path, string body)
  {
    if (path.EndsWith("/asr/transcribe"))
    {
      Seq++;
      if (AsrMode == "official") return "{ \"transcript\": \"qa probe transcript\", \"audioDurationMs\": 8240 }";
      if (AsrMode == "subsecond") return "{ \"transcript\": \"qa probe transcript\", \"audioDurationMs\": 500 }";
      if (AsrMode == "processed") return "{ \"transcript\": \"qa probe transcript\", \"audioProcessedMs\": 5000 }";
      if (AsrMode == "badjson") return "{\"a\":truQA-CANARY-ASR}";
      return "{ \"transcript\": \"qa probe transcript\" }";
    }
    if (path.EndsWith("/images/generations"))
    {
      Seq++;
      ImageHits++;
      string iprompt = "";
      try
      {
        using var idoc = JsonDocument.Parse(string.IsNullOrWhiteSpace(body) ? "{}" : body);
        if (idoc.RootElement.ValueKind == JsonValueKind.Object && idoc.RootElement.TryGetProperty("prompt", out var ipp) && ipp.ValueKind == JsonValueKind.String) iprompt = ipp.GetString() ?? "";
      }
      catch { }
      const string one = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
      const string hello = "aGVsbG8=";
      if (iprompt.Contains("QA-IMG-HELLO")) return "{ \"id\": \"qa-img-hello-1\", \"data\": [ { \"b64_json\": \"" + hello + "\" } ] }|200";
      if (iprompt.Contains("QA-IMG-BADURL")) return "{ \"id\": \"qa-img-badurl-1\", \"data\": [ { \"url\": \"https://\" } ] }|200";
      if (iprompt.Contains("QA-IMG-IDONLY")) return "{ \"error\": \"qa img failure\", \"id\": \"qa-img-failed-7\" }|500";
      if (iprompt.Contains("QA-IMG-PNGURL")) return "{ \"id\": \"qa-img-pngurl-1\", \"data\": [ { \"b64_json\": \"" + one + "\" }, { \"url\": \"https://qa.example/img-valid.png\" } ] }|200";
    if (iprompt.Contains("QA-IMG-BIGPNG")) { var bp = ProbeBigPng(); return "{ \"id\": \"qa-img-bigpng-1\", \"data\": [ { \"b64_json\": \"" + bp + "\" } ] }|200"; }
    if (iprompt.Contains("QA-IMG-BIGJPEG")) { var bj = ProbeBigJpeg(); return "{ \"id\": \"qa-img-bigjpg-1\", \"data\": [ { \"b64_json\": \"" + bj + "\" } ] }|200"; }
    if (iprompt.Contains("QA-IMG-SIGONLY-PNG")) return "{ \"id\": \"qa-img-sig-1\", \"data\": [ { \"b64_json\": \"iVBORw0KGgoAAAAAAAAAAAAA\" } ] }|200";
    if (iprompt.Contains("QA-IMG-TRUNC")) { var tb = Convert.FromBase64String(one); var ts = new byte[40]; Array.Copy(tb, ts, 40); return "{ \"id\": \"qa-img-trunc-1\", \"data\": [ { \"b64_json\": \"" + Convert.ToBase64String(ts) + "\" } ] }|200"; }
    if (iprompt.Contains("QA-IMG-BADDIMS")) { var bd = ProbeBadDimsPng(one); return "{ \"id\": \"qa-img-baddims-1\", \"data\": [ { \"b64_json\": \"" + bd + "\" } ] }|200"; }
    if (iprompt.Contains("QA-IMG-OVER")) { var ob = ProbeBigPng(); var big = new System.Text.StringBuilder(); for (int k = 0; k < 100; k++) big.Append(ob); return "{ \"id\": \"qa-img-over-1\", \"data\": [ { \"b64_json\": \"" + big.ToString() + "\" } ] }|200"; }
      if (iprompt.Contains("QA-IMG-MALFORMED")) return "{ \"data\": [ { \"b64_json\": \"%%%\" } ] }";
      if (iprompt.Contains("QA-IMG-EMPTY")) return "{ \"data\": [] }";
      if (iprompt.Contains("QA-IMG-MIXED")) return "{ \"data\": [ { \"b64_json\": \"" + one + "\" }, { \"b64_json\": \"%%%\" }, { \"url\": \"https://qa.example/img3.png\" } ] }";
      if (iprompt.Contains("QA-IMG-NODATA")) return "{ \"note\": \"no data property\" }";
      if (iprompt.Contains("QA-IMG-URL")) return "{ \"data\": [ { \"url\": \"https://qa.example/img9.png\" } ] }";
      if (iprompt.Contains("QA-IMG-PARTIAL")) return "{ \"data\": [ { \"b64_json\": \"" + one + "\" } ] }";
      int want = 1;
      try
      {
        using var ndoc = JsonDocument.Parse(string.IsNullOrWhiteSpace(body) ? "{}" : body);
        if (ndoc.RootElement.ValueKind == JsonValueKind.Object && ndoc.RootElement.TryGetProperty("n", out var nn) && nn.ValueKind == JsonValueKind.Number && nn.TryGetInt32(out var nv)) want = Math.Clamp(nv, 1, 4);
      }
      catch { }
      var arr = new System.Text.StringBuilder("{ \"data\": [");
      for (int k = 0; k < want; k++) { if (k > 0) arr.Append(", "); arr.Append("{ \"b64_json\": \"" + one + "\" }"); }
      arr.Append("] }");
      return arr.ToString();
    }
    if (path.EndsWith("/responses"))
    {
      string rinput = "";
      try
      {
        using var rdoc = JsonDocument.Parse(string.IsNullOrWhiteSpace(body) ? "{}" : body);
        if (rdoc.RootElement.ValueKind == JsonValueKind.Object && rdoc.RootElement.TryGetProperty("input", out var rin) && rin.ValueKind == JsonValueKind.String) rinput = rin.GetString() ?? "";
      }
      catch { }
      Seq++;
      if (rinput.Contains("QA-RESEARCHERR-SEARCH"))
        return "{ \"error\": \"qa billed research failure with search\", \"id\": \"qa-resp-failed-search-1\", \"usage\": { \"input_tokens\": 40, \"output_tokens\": 10 }, \"output\": [ { \"type\": \"web_search_call\", \"results\": [] } ] }|500";
      if (rinput.Contains("QA-RESEARCHERR-IDONLY"))
        return "{ \"error\": \"qa id-only research failure\", \"id\": \"qa-resp-only-id-7\" }|500";
      if (rinput.Contains("QA-RESEARCHERR-LONG"))
      {
        var rpad = new string((char)121, 2000);
        return "{ \"error\": \"qa long research failure " + rpad + "\", \"id\": \"qa-resp-long-1\", \"usage\": { \"input_tokens\": 30, \"output_tokens\": 5 }, \"output\": [ { \"type\": \"web_search_call\", \"results\": [] } ] }|500";
      }
              if (rinput.Contains("QA-RESP-MIXED-AFTER"))
    {
      Seq++;
      return "{ \"id\": \"qa-resp-mixafter-" + Seq + "\", \"status\": \"completed\", \"usage\": { \"input_tokens\": 20, \"output_tokens\": 20 }, \"output\": [{ \"type\": \"web_search_call\", \"results\": [] }, \"bad\", { \"type\": \"message\", \"phase\": \"final_answer\", \"content\": [{ \"type\": \"output_text\", \"text\": \"QA line one.\" }] }] }|200";
    }
    if (rinput.Contains("QA-RESP-MIXED-BEFORE"))
    {
      Seq++;
      return "{ \"id\": \"qa-resp-mixbefore-" + Seq + "\", \"status\": \"completed\", \"usage\": { \"input_tokens\": 20, \"output_tokens\": 20 }, \"output\": [\"bad\", { \"type\": \"web_search_call\", \"results\": [] }, { \"type\": \"message\", \"phase\": \"final_answer\", \"content\": [{ \"type\": \"output_text\", \"text\": \"QA line one.\" }] }] }|200";
    }
    if (rinput.Contains("QA-RESP-INCOMPLETE-MIXED"))
    {
      Seq++;
      return "{ \"id\": \"qa-resp-incmix-" + Seq + "\", \"status\": \"incomplete\", \"incomplete_details\": { \"reason\": \"max_output_tokens\" }, \"usage\": { \"input_tokens\": 30, \"output_tokens\": 5 }, \"output\": [{ \"type\": \"web_search_call\", \"results\": [] }, \"bad\"] }|200";
    }
    if (rinput.Contains("QA-RESEARCHERR-MIXED"))
      return "{ \"error\": \"qa mixed failure\", \"id\": \"qa-resp-errmix-1\", \"usage\": { \"input_tokens\": 40, \"output_tokens\": 10 }, \"output\": [{ \"type\": \"web_search_call\", \"results\": [] }, \"bad\"] }|500";
    if (rinput.Contains("QA-RESEARCHERR-PREFIX-OVER"))
    {
      var prefix = "{ \"error\": \"qa prefix\", \"id\": \"qa-resp-prefix-1\", \"usage\": { \"input_tokens\": 40, \"output_tokens\": 10 }, \"output\": [{ \"type\": \"web_search_call\", \"results\": [] }] }";
      var pad = new string((char)32, 200000);
      return prefix + pad + "|500";
    }
    if (rinput.Contains("QA-RESEARCHERR-EMPTY-OUTPUT"))
        return "{ \"error\": \"qa empty-output failure\", \"id\": \"qa-resp-empty-1\", \"usage\": { \"input_tokens\": 40, \"output_tokens\": 10 }, \"output\": [] }|500";
      if (rinput.Contains("QA-RESEARCHERR-NULL-OUTPUT"))
        return "{ \"error\": \"qa null-output failure\", \"id\": \"qa-resp-null-1\", \"usage\": { \"input_tokens\": 40, \"output_tokens\": 10 }, \"output\": null }|500";
      if (rinput.Contains("QA-RESEARCHERR-MALFORMED-OUTPUT"))
        return "{ \"error\": \"qa malformed-output failure\", \"id\": \"qa-resp-mal-1\", \"usage\": { \"input_tokens\": 40, \"output_tokens\": 10 }, \"output\": [\"not-an-object\"] }|500";
      if (rinput.Contains("QA-RESEARCHERR-CANARY"))
      {
        var canary = "QA-CANARY-PROMPT-abc123 QA-CANARY-KEY-sk-test-xyz";
        var pad = new string((char)114, 600);
        return "{ \"error\": \"qa canary research " + canary + " " + pad + "\", \"id\": \"qa-resp-canary-1\", \"usage\": { \"input_tokens\": 40, \"output_tokens\": 10 }, \"output\": [{ \"type\": \"web_search_call\", \"results\": [] }] }|500";
      }
      if (rinput.Contains("QA-RESEARCHERR-OVERSIZED"))
      {
        var pad = new string((char)122, 200000);
        return "{ \"error\": \"qa oversized research " + pad + "\", \"id\": \"qa-resp-oversized-1\", \"usage\": { \"input_tokens\": 40, \"output_tokens\": 10 } }|500";
      }
    if (rinput.Contains("QA-RESEARCHERR-USAGE"))
        return "{ \"error\": \"qa billed research failure\", \"id\": \"qa-resp-failed-1\", \"usage\": { \"input_tokens\": 40, \"output_tokens\": 10 } }|500";
      if (rinput.Contains("QA-RESEARCHERR"))
        return "{ \"error\": \"qa research failure\" }|500";
      if (rinput.Contains("QA-RESP-EMPTY-OUTPUT-200")) { Seq++; return "{ \"id\": \"qa-resp-empty200-" + Seq + "\", \"status\": \"completed\", \"output\": [], \"usage\": { \"input_tokens\": 20, \"output_tokens\": 20 } }|200"; }
      if (rinput.Contains("QA-RESP-MALFORMED-OUTPUT-200")) { Seq++; return "{ \"id\": \"qa-resp-mal200-" + Seq + "\", \"status\": \"completed\", \"output\": [\"bad\"], \"usage\": { \"input_tokens\": 20, \"output_tokens\": 20 } }|200"; }
      if (rinput.Contains("QA-RESP-MALFORMED-OUTPUT-200"))
      {
        Seq++;
        return "{ \"id\": \"qa-resp-mal200-" + Seq + "\", \"status\": \"completed\", \"output\": [\"bad\"], \"usage\": { \"input_tokens\": 20, \"output_tokens\": 20 } }|200";
      }
      var routput = "[ { \"type\": \"web_search_call\", \"results\": [ { \"url\": \"https://qa.example/s1\", \"title\": \"QA source one\", \"snippet\": \"QA excerpt one.\" } ] }, { \"type\": \"message\", \"phase\": \"final_answer\", \"content\": [ { \"type\": \"output_text\", \"text\": \"QA grounded claim line one.\" } ] } ]";
      return "{ \"id\": \"qa-resp-" + Seq + "\", \"status\": \"completed\", \"output\": " + routput + ", \"usage\": { \"input_tokens\": 20, \"output_tokens\": 20 } }|200";
    }
    if (path.EndsWith("/chat/completions")) ChatHits++;
    string prompt = "";
    try
    {
      using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(body) ? "{}" : body);
      var root = doc.RootElement;
      if (root.TryGetProperty("messages", out var msgs) && msgs.ValueKind == JsonValueKind.Array)
      {
        var sb = new StringBuilder();
        foreach (var m in msgs.EnumerateArray())
        {
          if (m.ValueKind != JsonValueKind.Object) continue;
          if (m.TryGetProperty("content", out var c) && c.ValueKind == JsonValueKind.String) sb.Append(c.GetString());
        }
        prompt = sb.ToString();
      }
    }
    catch { }
    // HTTP-error fixtures: long trailing usage, id-only (parse before truncation)
    if (prompt.Contains("QA-HTTP500-LONG"))
    {
      var pad = new string((char)120, 2000);
      return "{ \"error\": \"qa long failure " + pad + "\", \"id\": \"qa-long-billed-1\", \"usage\": { \"prompt_tokens\": 120, \"completion_tokens\": 16 } }|500";
    }
    if (prompt.Contains("QA-HTTP500-IDONLY"))
    {
      return "{ \"error\": \"qa id-only failure\", \"id\": \"qa-only-id-9\" }|500";
    }
    if (prompt.Contains("QA-HTTP500-PREFIX-OVER"))
    {
      var prefix = "{ \"error\": \"qa prefix\", \"id\": \"qa-prefix-1\", \"usage\": { \"prompt_tokens\": 120, \"completion_tokens\": 16 } }";
      var pad = new string((char)32, 200000);
      return prefix + pad + "|500";
    }
    if (prompt.Contains("QA-HTTP500-CANARY"))
    {
      var canary = "QA-CANARY-PROMPT-abc123 QA-CANARY-KEY-sk-test-xyz";
      var pad = new string((char)113, 600);
      return "{ \"error\": \"qa canary failure " + canary + " " + pad + "\", \"id\": \"qa-canary-1\", \"usage\": { \"prompt_tokens\": 120, \"completion_tokens\": 16 } }|500";
    }
    if (prompt.Contains("QA-HTTP500-OVERSIZED"))
    {
      var pad = new string((char)122, 200000);
      return "{ \"error\": \"qa oversized " + pad + "\", \"id\": \"qa-oversized-1\", \"usage\": { \"prompt_tokens\": 10, \"completion_tokens\": 10 } }|500";
    }
    if (prompt.Contains("QA-HTTP500-USAGE"))
    {
      Seq++;
      return "{ \"error\": \"qa billed failure\", \"id\": \"qa-failed-billed-1\", \"usage\": { \"prompt_tokens\": 100, \"completion_tokens\": 50 } }|500";
    }
    if (prompt.Contains("QA-HTTP500"))
    {
      return "{ \"error\": \"qa chat failure\" }|500";
    }
    Seq++;
    if (prompt.Contains("QA-USAGE-CONFLICT"))
    {
      return "{ \"id\": \"qa-probe-" + Seq + "\", \"choices\": [ { \"message\": { \"role\": \"assistant\", \"content\": \"OK\" }, \"finish_reason\": \"stop\" } ], \"usage\": { \"prompt_tokens\": 100, \"input_tokens\": 90, \"completion_tokens\": 10 } }|200";
    }
    if (prompt.Contains("QA-USAGE-CACHED-CONFLICT"))
    {
      return "{ \"id\": \"qa-probe-" + Seq + "\", \"choices\": [ { \"message\": { \"role\": \"assistant\", \"content\": \"OK\" }, \"finish_reason\": \"stop\" } ], \"usage\": { \"prompt_tokens\": 100, \"completion_tokens\": 10, \"prompt_tokens_details\": { \"cached_tokens\": 20 }, \"cached_input_tokens\": -1 } }|200";
    }
    if (prompt.Contains("QA-USAGE-BROKEN-DETAILS"))
    {
      return "{ \"id\": \"qa-probe-" + Seq + "\", \"choices\": [ { \"message\": { \"role\": \"assistant\", \"content\": \"OK\" }, \"finish_reason\": \"stop\" } ], \"usage\": { \"prompt_tokens\": 100, \"completion_tokens\": 10, \"prompt_tokens_details\": \"broken\", \"cached_tokens\": 20 } }|200";
    }
    if (prompt.Contains("QA-USAGE-CACHED-CONFLICT"))
    {
      return "{ \"id\": \"qa-probe-" + Seq + "\", \"choices\": [ { \"message\": { \"role\": \"assistant\", \"content\": \"OK\" }, \"finish_reason\": \"stop\" } ], \"usage\": { \"prompt_tokens\": 100, \"completion_tokens\": 10, \"prompt_tokens_details\": { \"cached_tokens\": 20 }, \"cached_input_tokens\": -1 } }|200";
    }
    if (prompt.Contains("QA-USAGE-BROKEN-DETAILS"))
    {
      return "{ \"id\": \"qa-probe-" + Seq + "\", \"choices\": [ { \"message\": { \"role\": \"assistant\", \"content\": \"OK\" }, \"finish_reason\": \"stop\" } ], \"usage\": { \"prompt_tokens\": 100, \"completion_tokens\": 10, \"prompt_tokens_details\": \"broken\", \"cached_tokens\": 20 } }|200";
    }
    if (prompt.Contains("QA-USAGE-DUP-PROMPT"))
      return "{ \"id\": \"qa-probe-dup-1\", \"choices\": [ { \"message\": { \"role\": \"assistant\", \"content\": \"OK\" }, \"finish_reason\": \"stop\" } ], \"usage\": { \"prompt_tokens\": -1, \"prompt_tokens\": 100, \"completion_tokens\": 10 } }|200";
    if (prompt.Contains("QA-USAGE-DUP-CACHED"))
      return "{ \"id\": \"qa-probe-dup-2\", \"choices\": [ { \"message\": { \"role\": \"assistant\", \"content\": \"OK\" }, \"finish_reason\": \"stop\" } ], \"usage\": { \"prompt_tokens\": 100, \"completion_tokens\": 10, \"cached_tokens\": -1, \"cached_tokens\": 20 } }|200";
    if (prompt.Contains("QA-USAGE-NULL-DETAILS"))
      return "{ \"id\": \"qa-probe-null-1\", \"choices\": [ { \"message\": { \"role\": \"assistant\", \"content\": \"OK\" }, \"finish_reason\": \"stop\" } ], \"usage\": { \"prompt_tokens\": 100, \"completion_tokens\": 10, \"prompt_tokens_details\": null, \"cached_tokens\": 20 } }|200";
    if (prompt.Contains("QA-USAGE-NULL-INPUT-DETAILS"))
      return "{ \"id\": \"qa-probe-null-2\", \"choices\": [ { \"message\": { \"role\": \"assistant\", \"content\": \"OK\" }, \"finish_reason\": \"stop\" } ], \"usage\": { \"prompt_tokens\": 100, \"completion_tokens\": 10, \"input_tokens_details\": null } }|200";
    if (prompt.Contains("QA-HTTP500-PREFIX-OVER"))
    {
      var prefix = "{ \"error\": \"qa prefix\", \"id\": \"qa-prefix-1\", \"usage\": { \"prompt_tokens\": 120, \"completion_tokens\": 16 } }";
      var pad = new string((char)32, 200000);
      return prefix + pad + "|500";
    }
    if (prompt.Contains("QA-USAGE-NEG"))
    {
      return "{ \"id\": \"qa-probe-" + Seq + "\", \"choices\": [ { \"message\": { \"role\": \"assistant\", \"content\": \"OK\" }, \"finish_reason\": \"stop\" } ], \"usage\": { \"prompt_tokens\": -5, \"completion_tokens\": 10 } }|200";
    }
    if (prompt.Contains("QA-USAGE-CACHEOVER"))
    {
      return "{ \"id\": \"qa-probe-" + Seq + "\", \"choices\": [ { \"message\": { \"role\": \"assistant\", \"content\": \"OK\" }, \"finish_reason\": \"stop\" } ], \"usage\": { \"prompt_tokens\": 100, \"completion_tokens\": 10, \"prompt_tokens_details\": { \"cached_tokens\": 200 } } }|200";
    }
    if (prompt.Contains("QA-USAGE-BADTYPE"))
    {
      return "{ \"id\": \"qa-probe-" + Seq + "\", \"choices\": [ { \"message\": { \"role\": \"assistant\", \"content\": \"OK\" }, \"finish_reason\": \"stop\" } ], \"usage\": { \"prompt_tokens\": \"100\", \"completion_tokens\": 10 } }|200";
    }
    bool cached = prompt.Contains("QA-CACHED");
    bool trunc = prompt.Contains("QA-TRUNCATE");
    string usage = cached
      ? " , \"usage\": { \"prompt_tokens\": 100, \"completion_tokens\": 50, \"prompt_tokens_details\": { \"cached_tokens\": 40 } }" 
      : " , \"usage\": { \"prompt_tokens\": 10, \"completion_tokens\": 10 }";
    string finish = trunc ? "length" : "stop";
    return "{ \"id\": \"qa-probe-" + Seq + "\", \"choices\": [ { \"message\": { \"role\": \"assistant\", \"content\": \"OK\" }, \"finish_reason\": \"" + finish + "\" } ]" + usage + " }|200";
  }

  static (int status, string payload) HandleWithStatus(string path, string body)
  {
    var raw = Handle(path, body);
    var idx = raw.LastIndexOf((char)124);
    if (idx >= 0 && idx > raw.Length - 6)
    {
      var suffix = raw.Substring(idx + 1);
      if (int.TryParse(suffix, out var st)) return (st, raw.Substring(0, idx));
    }
    return (200, raw);
  }
  static uint[] ProbeCrcTable()
  {
    var table = new uint[256];
    for (uint i = 0; i < 256; i++) { var c = i; for (var k = 0; k < 8; k++) c = (c & 1) != 0 ? (0xEDB88320u ^ (c >> 1)) : (c >> 1); table[i] = c; }
    return table;
  }
  static uint ProbeCrc(byte[] buf, int off, int len)
  {
    var table = ProbeCrcTable();
    var c = 0xFFFFFFFFu;
    for (var i = 0; i < len; i++) c = table[(c ^ buf[off + i]) & 0xFF] ^ (c >> 8);
    return c ^ 0xFFFFFFFFu;
  }
  static uint ProbeAdler(byte[] data)
  {
    uint a = 1, b = 0;
    foreach (var x in data) { a = (a + x) % 65521; b = (b + a) % 65521; }
    return (b << 16) | a;
  }
  static void ProbePutU32(System.Collections.Generic.List<byte> l, uint v) { l.Add((byte)(v >> 24)); l.Add((byte)(v >> 16)); l.Add((byte)(v >> 8)); l.Add((byte)v); }
  static void ProbeChunk(System.Collections.Generic.List<byte> l, string type, byte[] data)
  {
    ProbePutU32(l, (uint)data.Length);
    foreach (var c in type) l.Add((byte)c);
    l.AddRange(data);
    var body = System.Text.Encoding.ASCII.GetBytes(type);
    var all = new byte[body.Length + data.Length];
    Array.Copy(body, all, body.Length);
    Array.Copy(data, 0, all, body.Length, data.Length);
    ProbePutU32(l, ProbeCrc(all, 0, all.Length));
  }
  static string ProbeBigPng()
  {
    const int W = 512, H = 256;
    var raw = new System.Collections.Generic.List<byte>();
    for (int y = 0; y < H; y++) { raw.Add(0); for (int x = 0; x < W; x++) { raw.Add((byte)((x + y) & 255)); raw.Add((byte)((x * 2) & 255)); raw.Add((byte)((y * 3) & 255)); } }
    var rb = raw.ToArray();
    var z = new System.Collections.Generic.List<byte> { 0x78, 0x01 };
    int off = 0;
    while (off < rb.Length)
    {
      int n = System.Math.Min(65535, rb.Length - off);
      bool last = off + n >= rb.Length;
      z.Add((byte)(last ? 1 : 0)); z.Add((byte)(n & 255)); z.Add((byte)((n >> 8) & 255)); z.Add((byte)(~n & 255)); z.Add((byte)((~n >> 8) & 255));
      for (int i = 0; i < n; i++) z.Add(rb[off + i]);
      off += n;
    }
    var ad = ProbeAdler(rb);
    z.Add((byte)(ad >> 24)); z.Add((byte)(ad >> 16)); z.Add((byte)(ad >> 8)); z.Add((byte)ad);
    var ihdr = new byte[13];
    ihdr[0] = (byte)((W >> 24) & 255); ihdr[1] = (byte)((W >> 16) & 255); ihdr[2] = (byte)((W >> 8) & 255); ihdr[3] = (byte)(W & 255);
    ihdr[4] = (byte)((H >> 24) & 255); ihdr[5] = (byte)((H >> 16) & 255); ihdr[6] = (byte)((H >> 8) & 255); ihdr[7] = (byte)(H & 255);
    ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    var png = new System.Collections.Generic.List<byte> { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A };
    ProbeChunk(png, "IHDR", ihdr);
    ProbeChunk(png, "IDAT", z.ToArray());
    ProbeChunk(png, "IEND", new byte[0]);
    return Convert.ToBase64String(png.ToArray());
  }
  static string ProbeBadDimsPng(string oneB64)
  {
    var raw = Convert.FromBase64String(oneB64);
    raw[16] = 0; raw[17] = 0; raw[18] = 0; raw[19] = 0;
    var body = new byte[4 + 13];
    body[0] = (byte)'I'; body[1] = (byte)'H'; body[2] = (byte)'D'; body[3] = (byte)'R';
    Array.Copy(raw, 16, body, 4, 13);
    var nc = ProbeCrc(body, 0, body.Length);
    raw[29] = (byte)(nc >> 24); raw[30] = (byte)(nc >> 16); raw[31] = (byte)(nc >> 8); raw[32] = (byte)nc;
    return Convert.ToBase64String(raw);
  }
  static string ProbeBigJpeg()
  {
    var l = new System.Collections.Generic.List<byte> { 0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00 };
    for (int c = 0; c < 2; c++) { l.AddRange(new byte[] { 0xFF, 0xFE, 0xFF, 0xFD }); for (int i = 0; i < 65531; i++) l.Add((byte)(65 + c)); }
    l.AddRange(new byte[] { 0xFF, 0xDB, 0x00, 0x43, 0x00 });
    for (int i = 0; i < 64; i++) l.Add(8);
    l.AddRange(new byte[] { 0xFF, 0xC0, 0x00, 0x0B, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00 });
    l.AddRange(new byte[] { 0xFF, 0xC4, 0x00, 0x14, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 });
    l.AddRange(new byte[] { 0xFF, 0xC4, 0x00, 0x14, 0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 });
    l.AddRange(new byte[] { 0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00, 0x2B, 0xFF, 0xD9 });
    return Convert.ToBase64String(l.ToArray());
  }
}

sealed class FailReadBackend : SimCEO.Api.Data.IPgBackend
{
  public SimCEO.Api.Data.IPgBackend Inner;
  public FailReadBackend(SimCEO.Api.Data.IPgBackend inner) { Inner = inner; }
  public T? Find<T>(Guid id) where T : class => throw new InvalidOperationException("qa injected read failure");
  public List<T> All<T>() where T : class => throw new InvalidOperationException("qa injected read failure");
  public void Upsert<T>(T entity) where T : class => Inner.Upsert(entity);
  public bool Remove<T>(Guid id) where T : class => Inner.Remove<T>(id);
  public void Clear<T>() where T : class => Inner.Clear<T>();
  public void AddMessage(SimCEO.Api.Domain.Message m) => Inner.AddMessage(m);
  public void AddMessages(IEnumerable<SimCEO.Api.Domain.Message> ms) => Inner.AddMessages(ms);
  public List<SimCEO.Api.Domain.Message> MeetingMessages(Guid meetingId) => Inner.MeetingMessages(meetingId);
  public List<Guid> MessageMeetings() => Inner.MessageMeetings();
  public void RemoveMeetingMessages(Guid meetingId) => Inner.RemoveMeetingMessages(meetingId);
  public void ClearMessages() => Inner.ClearMessages();
  public void Save() => Inner.Save();
  public bool IsTransacting => Inner.IsTransacting;
  public void Transact(Action op) => Inner.Transact(op);
  public T Transact<T>(Func<T> op) => Inner.Transact(op);
}

sealed class FailBackend : SimCEO.Api.Data.IPgBackend
{
  public SimCEO.Api.Data.IPgBackend Inner;
  public int Upserts;
  public int FailOnUpsert;
  public System.Collections.Generic.List<(string Table, Guid Id)> Attempted = new();
  public FailBackend(SimCEO.Api.Data.IPgBackend inner) { Inner = inner; }
  static Guid RowId<T>(T entity)
  {
    try
    {
      var p = typeof(T).GetProperty("Id");
      if (p != null && p.GetValue(entity) is Guid g) return g;
    }
    catch { }
    return Guid.Empty;
  }
  public T? Find<T>(Guid id) where T : class => Inner.Find<T>(id);
  public List<T> All<T>() where T : class => Inner.All<T>();
  public void Upsert<T>(T entity) where T : class { Upserts++; try { var gid = RowId(entity); if (gid != Guid.Empty) Attempted.Add((typeof(T).Name, gid)); } catch { } if (FailOnUpsert == Upserts) throw new InvalidOperationException("qa injected storage failure on append " + Upserts); Inner.Upsert(entity); }
  public bool Remove<T>(Guid id) where T : class => Inner.Remove<T>(id);
  public void Clear<T>() where T : class => Inner.Clear<T>();
  public void AddMessage(SimCEO.Api.Domain.Message m) => Inner.AddMessage(m);
  public void AddMessages(IEnumerable<SimCEO.Api.Domain.Message> ms) => Inner.AddMessages(ms);
  public List<SimCEO.Api.Domain.Message> MeetingMessages(Guid meetingId) => Inner.MeetingMessages(meetingId);
  public List<Guid> MessageMeetings() => Inner.MessageMeetings();
  public void RemoveMeetingMessages(Guid meetingId) => Inner.RemoveMeetingMessages(meetingId);
  public void ClearMessages() => Inner.ClearMessages();
  public void Save() => Inner.Save();
  public bool IsTransacting => Inner.IsTransacting;
  public void Transact(Action op) => Inner.Transact(op);
  public T Transact<T>(Func<T> op) => Inner.Transact(op);
}
