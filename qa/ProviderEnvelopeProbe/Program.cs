using System.Net;
using System.Text;
using System.Text.Json;
using SimCEO.Api.Data;
using SimCEO.Api.Work;

static class Probe
{
  const string Prefix = "http://127.0.0.1:5202/";
  static readonly object Gate = new();
  static string NextJson = "";
  static string LastPath = "";
  static string LastBody = "";
  static int EvidenceHttpFakeCalls = 0;
  static int EvidenceDnsFakeCalls = 0;

  // Deterministic no-network evidence retriever via existing code-only
  // constructor seam. Never touches DNS or sockets: DNS fixture returns
  // empty (fail-closed) without calling Dns.GetHostAddressesAsync, and the
  // HTTP fixture returns in-memory 404 without any socket. Production
  // ModelGateway default ctor (real PublicEvidenceFetcher) is never used
  // here; separate PublicEvidenceProbe owns retrieval testing.
  sealed class NoNetworkHandler : HttpMessageHandler
  {
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
      System.Threading.Interlocked.Increment(ref EvidenceHttpFakeCalls);
      var res = new HttpResponseMessage(HttpStatusCode.NotFound);
      res.Content = new StringContent("");
      return Task.FromResult(res);
    }
  }

  static Task<IPAddress[]> NoNetworkDns(string host, CancellationToken ct)
  {
    System.Threading.Interlocked.Increment(ref EvidenceDnsFakeCalls);
    return Task.FromResult(Array.Empty<IPAddress>());
  }

  static ModelGateway NewIsolatedGateway(InMemoryStore store)
    => new ModelGateway(store, new PublicEvidenceFetcher(new NoNetworkHandler(), NoNetworkDns));

  sealed record Expect(
    string Kind, bool Pass, bool Metered,
    string? Text, bool? Grounded, string? Excerpt,
    string? ErrContains, int InTok, int OutTok, int Searches);

  static int Main(string[] args) => RunAsync().GetAwaiter().GetResult();

  static async Task<int> RunAsync()
  {
    var listener = new HttpListener();
    listener.Prefixes.Add(Prefix);
    try { listener.Start(); }
    catch (HttpListenerException ex)
    {
      Console.Error.WriteLine("PROBE FAIL: loopback 127.0.0.1:5202 unavailable: " + ex.Message + ". Refusing to touch other processes/ports.");
      return 1;
    }
    catch (Exception ex)
    {
      Console.Error.WriteLine("PROBE FAIL: listener start error: " + ex.GetType().Name + ": " + ex.Message);
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
        string path = ctx.Request.Url?.AbsolutePath ?? "";
        string body = "";
        try
        {
          using var sr = new StreamReader(ctx.Request.InputStream, ctx.Request.ContentEncoding ?? Encoding.UTF8);
          body = await sr.ReadToEndAsync();
        }
        catch { }
        string payload;
        lock (Gate) { LastPath = path; LastBody = body; payload = NextJson; }
        byte[] bytes = Encoding.UTF8.GetBytes(payload);
        try
        {
          ctx.Response.StatusCode = 200;
          ctx.Response.ContentType = "application/json";
          ctx.Response.ContentLength64 = bytes.Length;
          await ctx.Response.OutputStream.WriteAsync(bytes, 0, bytes.Length);
        }
        catch { }
        finally { try { ctx.Response.OutputStream.Close(); } catch { } }
      }
    });

    Environment.SetEnvironmentVariable("META_API_BASE", "http://127.0.0.1:5202");
    Environment.SetEnvironmentVariable("META_API_KEY", "dummy-probe-key");

    string fixturesPath = FindFixtures();
    if (fixturesPath == "")
    {
      Console.Error.WriteLine("PROBE FAIL: fixtures file not found.");
      try { cts.Cancel(); listener.Stop(); } catch { }
      return 1;
    }
    JsonDocument fx;
    try { fx = JsonDocument.Parse(File.ReadAllText(fixturesPath)); }
    catch (Exception ex)
    {
      Console.Error.WriteLine("PROBE FAIL: cannot parse fixtures: " + ex.Message);
      try { cts.Cancel(); listener.Stop(); } catch { }
      return 1;
    }

    var expects = new Dictionary<string, Expect>(StringComparer.Ordinal)
    {
      ["chat-null-content-finish-length"] = new Expect("chat", false, true, null, null, null, "finish_reason", 120, 16, 0),
      ["chat-empty-choices"] = new Expect("chat", false, true, null, null, null, "choices array empty", 10, 0, 0),
      ["chat-empty-content-stop"] = new Expect("chat", false, true, null, null, null, "content empty", 100, 16, 0),
      ["chat-valid-stop-ok"] = new Expect("chat", true, true, "OK", null, null, null, 100, 159, 0),
      ["responses-incomplete-commentary-search-resp_6ae8fd438488ff5989594abb"] = new Expect("responses", false, true, null, null, null, "non-completed research", 4000, 1024, 0),
      ["responses-completed-final-snippet-pass"] = new Expect("responses", true, true, "Grace Hopper: US Navy rear admiral; COBOL and compiler pioneer.", true, "Grace Hopper was a US Navy rear admiral and computer pioneer.", null, 4000, 640, 1),
      ["responses-completed-final-no-excerpt-unsupported"] = new Expect("responses", true, true, "Some claim without evidence.", false, null, null, 100, 200, 1),
      ["responses-progress-only-no-final"] = new Expect("responses", false, true, null, null, null, "progress-only", 50, 60, 1),
    };

    int pass = 0, fail = 0;
    var lines = new List<string>();
    string[] order = new[]
    {
      "chat-null-content-finish-length",
      "chat-empty-choices",
      "chat-empty-content-stop",
      "chat-valid-stop-ok",
      "responses-incomplete-commentary-search-resp_6ae8fd438488ff5989594abb",
      "responses-completed-final-snippet-pass",
      "responses-completed-final-no-excerpt-unsupported",
      "responses-progress-only-no-final",
    };
    var byId = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
    foreach (var c in fx.RootElement.GetProperty("cases").EnumerateArray())
      byId[c.GetProperty("id").GetString() ?? ""] = c;

    foreach (var id in order)
    {
      if (!byId.TryGetValue(id, out var c))
      {
        fail++;
        lines.Add("FAIL " + id + " :: fixture case missing");
        Console.WriteLine("FAIL " + id + " :: fixture case missing");
        continue;
      }
      var exp = expects[id];
      string kind = c.GetProperty("kind").GetString() ?? "";
      string fixtureJson = c.GetProperty("doc").GetRawText();
      var store = new InMemoryStore();
      lock (Gate) { NextJson = fixtureJson; LastPath = ""; LastBody = ""; }
      string detail = "";
      bool ok = false;
      await Task.Yield();
      try
      {
        if (kind == "chat")
        {
          var r = await RunChatCase(id, exp, fixtureJson, store);
          ok = r.Item1; detail = r.Item2;
        }
        else
        {
          var r = await RunGroundedCase(id, exp, c.GetProperty("doc"), fixtureJson, store);
          ok = r.Item1; detail = r.Item2;
        }
      }
      catch (Exception ex)
      {
        detail = "harness error " + ex.GetType().Name + ": " + ex.Message;
        ok = false;
      }
      if (ok) { pass++; lines.Add("PASS " + id + " (real C# gateway)"); Console.WriteLine("PASS " + id + " (real C# gateway)"); }
      else { fail++; lines.Add("FAIL " + id + " :: " + detail); Console.WriteLine("FAIL " + id + " :: " + detail); }
    }

    string root = FindRepoRoot();
    string resultPath = string.IsNullOrEmpty(root)
      ? Path.Combine(Directory.GetCurrentDirectory(), ".tmp", "muse-provider-probe-result.txt")
      : Path.Combine(root, ".tmp", "muse-provider-probe-result.txt");
    try
    {
      Directory.CreateDirectory(Path.GetDirectoryName(resultPath) ?? ".");
      var sb = new StringBuilder();
      sb.AppendLine("muse real-C# provider probe: production ModelGateway CompleteAsync/CompleteGroundedAsync vs observed fixtures");
      sb.AppendLine("fixtures: " + fixturesPath);
      sb.AppendLine("listener: http://127.0.0.1:5202 (own HttpListener, no other ports touched)");
      foreach (var l in lines) sb.AppendLine(l);
      sb.AppendLine("EVIDENCE-ISOLATION isolated-gateway-only=true production-ctor-unused=true");
      sb.AppendLine("EVIDENCE-ISOLATION evidenceDnsFakeCalls=" + EvidenceDnsFakeCalls + " evidenceHttpFakeCalls=" + EvidenceHttpFakeCalls + " externalSockets=0 (only loopback 127.0.0.1:5202 provider listener)");
      sb.AppendLine("REAL-PROBE pass=" + pass + " fail=" + fail);
      File.WriteAllText(resultPath, sb.ToString());
      Console.WriteLine("REAL-PROBE pass=" + pass + " fail=" + fail);
      Console.WriteLine("EVIDENCE-ISOLATION evidenceDnsFakeCalls=" + EvidenceDnsFakeCalls + " evidenceHttpFakeCalls=" + EvidenceHttpFakeCalls + " externalSockets=0 (only loopback 127.0.0.1:5202)");
      Console.WriteLine("result: " + resultPath);
    }
    catch (Exception ex)
    {
      Console.Error.WriteLine("PROBE FAIL: cannot write result: " + ex.Message);
    }
    try { cts.Cancel(); listener.Stop(); listener.Close(); } catch { }
    try { await serve.WaitAsync(TimeSpan.FromSeconds(3)); } catch { }
    return fail == 0 ? 0 : 1;
  }

  static async Task<Tuple<bool, string>> RunChatCase(string id, Expect exp, string fixtureJson, InMemoryStore store)
  {
    string detail = "";
    const string model = "muse-spark-1.3";
    const string purpose = "model-test";
    var gw = NewIsolatedGateway(store);
    try
    {
      string text = await gw.CompleteAsync(model, purpose, "probe prompt for " + id, 1000, 16, CancellationToken.None);
      if (!exp.Pass) { detail = "expected ProviderException but gateway returned text=" + Trunc(text); return Tuple.Create(false, detail); }
      if (text != exp.Text) { detail = "text mismatch got=" + Trunc(text) + " want=" + Trunc(exp.Text ?? ""); return Tuple.Create(false, detail); }
      string reqErr = CheckChatRequest(GetLastPath(), GetLastBody(), model);
      if (reqErr != "") { detail = "request: " + reqErr; return Tuple.Create(false, detail); }
      if (text.Contains("chain of thought", StringComparison.OrdinalIgnoreCase)) { detail = "CoT leak in text"; return Tuple.Create(false, detail); }
      bool led = CheckLedger(store, exp, out string ld);
      return Tuple.Create(led, ld);
    }
    catch (ProviderException pex)
    {
      if (exp.Pass) { detail = "unexpected ProviderException " + pex.Status + ": " + Trunc(pex.Message); return Tuple.Create(false, detail); }
      if (string.IsNullOrEmpty(exp.ErrContains) || !pex.Message.Contains(exp.ErrContains, StringComparison.OrdinalIgnoreCase))
      { detail = "error=" + Trunc(pex.Message) + " missing=" + exp.ErrContains; return Tuple.Create(false, detail); }
      string reqErr = CheckChatRequest(GetLastPath(), GetLastBody(), model);
      if (reqErr != "") { detail = "request: " + reqErr; return Tuple.Create(false, detail); }
      bool led = CheckLedger(store, exp, out string ld);
      return Tuple.Create(led, ld);
    }
  }

  static async Task<Tuple<bool, string>> RunGroundedCase(string id, Expect exp, JsonElement docEl, string fixtureJson, InMemoryStore store)
  {
    string detail = "";
    const string model = "muse-spark-1.3";
    const string purpose = "advisor-research";
    var gw = NewIsolatedGateway(store);
    try
    {
      var res = await gw.CompleteGroundedAsync(model, purpose, "probe research prompt for " + id, 1000, 16, CancellationToken.None);
      if (!exp.Pass) { detail = "expected ProviderException but gateway returned text=" + Trunc(res.Text); return Tuple.Create(false, detail); }
      if (exp.Text != null && res.Text != exp.Text) { detail = "text mismatch got=" + Trunc(res.Text) + " want=" + Trunc(exp.Text); return Tuple.Create(false, detail); }
      string reqErr = CheckResponsesRequest(GetLastPath(), GetLastBody(), model);
      if (reqErr != "") { detail = "request: " + reqErr; return Tuple.Create(false, detail); }
      if (exp.Grounded.HasValue && res.RanSearch != exp.Grounded.Value)
      { detail = "grounded flag got=" + res.RanSearch + " want=" + exp.Grounded.Value; return Tuple.Create(false, detail); }
      if (res.InTokens != exp.InTok || res.OutTokens != exp.OutTok)
      { detail = "result tokens " + res.InTokens + "/" + res.OutTokens + " want " + exp.InTok + "/" + exp.OutTok; return Tuple.Create(false, detail); }
      if (res.SearchCalls != exp.Searches)
      { detail = "SearchCalls got=" + res.SearchCalls + " want=" + exp.Searches; return Tuple.Create(false, detail); }
      if (res.Text.Contains("chain of thought", StringComparison.OrdinalIgnoreCase))
      { detail = "CoT leak in grounded text"; return Tuple.Create(false, detail); }
      var pool = SnippetPool(docEl);
      foreach (var cit in res.Citations)
      {
        if (!string.IsNullOrEmpty(cit.Excerpt) && !pool.Contains(cit.Excerpt))
        { detail = "fabricated excerpt not in search results: " + Trunc(cit.Excerpt); return Tuple.Create(false, detail); }
      }
      if (exp.Excerpt != null)
      {
        bool found = res.Citations.Any(x => x.Excerpt == exp.Excerpt);
        if (!found) { detail = "expected excerpt missing from gateway citations"; return Tuple.Create(false, detail); }
      }
      else if (exp.Grounded == false)
      {
        if (res.Citations.Any(x => !string.IsNullOrWhiteSpace(x.Excerpt) && !string.IsNullOrEmpty(x.Url)))
        { detail = "unexpected grounded excerpt in unsupported case"; return Tuple.Create(false, detail); }
      }
      bool led = CheckLedger(store, exp, out string ld);
      return Tuple.Create(led, ld);
    }
    catch (ProviderException pex)
    {
      if (exp.Pass) { detail = "unexpected ProviderException " + pex.Status + ": " + Trunc(pex.Message); return Tuple.Create(false, detail); }
      if (string.IsNullOrEmpty(exp.ErrContains) || !pex.Message.Contains(exp.ErrContains, StringComparison.OrdinalIgnoreCase))
      { detail = "error=" + Trunc(pex.Message) + " missing=" + exp.ErrContains; return Tuple.Create(false, detail); }
      string reqErr = CheckResponsesRequest(GetLastPath(), GetLastBody(), model);
      if (reqErr != "") { detail = "request: " + reqErr; return Tuple.Create(false, detail); }
      bool led = CheckLedger(store, exp, out string ld);
      return Tuple.Create(led, ld);
    }
  }

  static bool CheckLedger(InMemoryStore store, Expect exp, out string detail)
  {
    detail = "";
    int mc = store.ModelCalls.Count();
    int uc = store.Usage.Count();
    if (exp.Metered)
    {
      if (mc != 1 || uc != 1) { detail = "ledger count ModelCalls=" + mc + " Usage=" + uc + " want exactly 1/1 (duplicate or missing write)"; return false; }
      var call = store.ModelCalls.First();
      var usage = store.Usage.First();
      if (call.InputTokens != exp.InTok || call.OutputTokens != exp.OutTok)
      { detail = "ModelCall tokens " + call.InputTokens + "/" + call.OutputTokens + " want " + exp.InTok + "/" + exp.OutTok; return false; }
      if (usage.InputTokens != exp.InTok)
      { detail = "Usage InputTokens " + usage.InputTokens + " want " + exp.InTok; return false; }
      if (usage.Cost == null)
      { detail = "Usage Cost null (unbilled despite metered fixture)"; return false; }
      return true;
    }
    if (mc != 0 || uc != 0) { detail = "unmetered ledger ModelCalls=" + mc + " Usage=" + uc + " want 0/0"; return false; }
    return true;
  }

  static string CheckChatRequest(string path, string body, string wantModel)
  {
    if (path != "/chat/completions") return "path " + path + " want /chat/completions";
    if (string.IsNullOrWhiteSpace(body)) return "empty request body";
    JsonDocument d;
    try { d = JsonDocument.Parse(body); }
    catch (Exception ex) { return "request not JSON: " + ex.Message; }
    using (d)
    {
      var r = d.RootElement;
      if (GetS(r, "model") != wantModel) return "model got=" + GetS(r, "model") + " want=" + wantModel;
      if (GetS(r, "reasoning_effort") != "minimal") return "reasoning_effort got=" + GetS(r, "reasoning_effort") + " want=minimal";
      if (!r.TryGetProperty("max_completion_tokens", out var mct) || mct.ValueKind != JsonValueKind.Number || !mct.TryGetInt32(out var mctv) || mctv < 512)
        return "max_completion_tokens missing or below bounded floor 512";
      if (mctv > 16000) return "unbounded budget >16000";
      if (r.TryGetProperty("max_tokens", out var mt) && (mt.ValueKind != JsonValueKind.Number || !mt.TryGetInt32(out var mtv2) || mtv2 < 16 || mtv2 > 16000))
        return "max_tokens out of bounds";
      if (!r.TryGetProperty("stream", out var st) || st.ValueKind != JsonValueKind.False) return "stream must be false";
      if (!r.TryGetProperty("messages", out var ms) || ms.ValueKind != JsonValueKind.Array || ms.GetArrayLength() != 2)
        return "messages must be [developer,user]";
      var m0 = ms[0]; var m1 = ms[1];
      if (GetS(m0, "role") != "developer") return "messages[0].role must be developer";
      if (GetS(m1, "role") != "user") return "messages[1].role must be user";
      if (!GetS(m1, "content").Contains("probe prompt", StringComparison.Ordinal)) return "user content missing probe prompt (params not passed)";
      return "";
    }
  }

  static string CheckResponsesRequest(string path, string body, string wantModel)
  {
    if (path != "/responses") return "path " + path + " want /responses";
    if (string.IsNullOrWhiteSpace(body)) return "empty request body";
    JsonDocument d;
    try { d = JsonDocument.Parse(body); }
    catch (Exception ex) { return "request not JSON: " + ex.Message; }
    using (d)
    {
      var r = d.RootElement;
      if (GetS(r, "model") != wantModel) return "model got=" + GetS(r, "model") + " want=" + wantModel;
      string topEffort = GetS(r, "reasoning_effort");
      string nested = "";
      try { if (r.TryGetProperty("reasoning", out var rn) && rn.ValueKind == JsonValueKind.Object) nested = GetS(rn, "effort"); } catch { }
      if (topEffort != "low" && nested != "low") return "reasoning effort missing low (top=" + topEffort + " nested=" + nested + ")";
      if (!r.TryGetProperty("max_output_tokens", out var mo) || mo.ValueKind != JsonValueKind.Number || !mo.TryGetInt32(out var mov) || mov < 2048)
        return "max_output_tokens missing or below bounded floor 2048";
      if (mov > 16000) return "unbounded max_output_tokens >16000";
      if (!r.TryGetProperty("tools", out var tools) || tools.ValueKind != JsonValueKind.Array || tools.GetArrayLength() == 0)
        return "tools missing web_search";
      bool hasSearch = false;
      foreach (var t in tools.EnumerateArray())
        if (GetS(t, "type") == "web_search") hasSearch = true;
      if (!hasSearch) return "tools missing web_search";
      if (!r.TryGetProperty("include", out var inc) || inc.ValueKind != JsonValueKind.Array) return "include missing";
      bool hasInc = false;
      foreach (var v in inc.EnumerateArray())
        if (v.ValueKind == JsonValueKind.String && (v.GetString() ?? "").Contains("web_search_call")) hasInc = true;
      if (!hasInc) return "include missing web_search_call.results";
      string input = GetS(r, "input");
      if (!input.Contains("probe research prompt", StringComparison.Ordinal)) return "input missing probe prompt (params not passed)";
      return "";
    }
  }

  static List<string> SnippetPool(JsonElement docEl)
  {
    var pool = new List<string>();
    try
    {
      if (docEl.TryGetProperty("output", out var output) && output.ValueKind == JsonValueKind.Array)
      {
        foreach (var item in output.EnumerateArray())
        {
          if (item.ValueKind != JsonValueKind.Object) continue;
          if (GetS(item, "type") != "web_search_call") continue;
          if (!item.TryGetProperty("results", out var res) || res.ValueKind != JsonValueKind.Array) continue;
          foreach (var hit in res.EnumerateArray())
          {
            if (hit.ValueKind != JsonValueKind.Object) continue;
            foreach (var k in new[] { "snippet", "SNIPPET", "Snippet", "text", "content", "excerpt" })
            {
              try
              {
                if (hit.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.String)
                {
                  var s = v.GetString() ?? "";
                  if (s != "") pool.Add(s);
                }
              }
              catch { }
            }
          }
        }
      }
    }
    catch { }
    return pool;
  }

  static string GetS(JsonElement el, string name)
  {
    try { return el.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : ""; }
    catch { return ""; }
  }
  static string GetLastPath() { lock (Gate) return LastPath; }
  static string GetLastBody() { lock (Gate) return LastBody; }
  static string Trunc(string s, int n = 200) => s.Length <= n ? s : s.Substring(0, n) + "...";

  static string FindFixtures()
  {
    var candidates = new List<string>();
    string here = AppContext.BaseDirectory;
    string cwd = Directory.GetCurrentDirectory();
    foreach (var start in new[] { here, cwd })
    {
      string d = start;
      for (int i = 0; i < 10; i++)
      {
        candidates.Add(Path.Combine(d, "qa", "provider-envelope-regression.fixtures.json"));
        candidates.Add(Path.Combine(d, "provider-envelope-regression.fixtures.json"));
        var parent = Directory.GetParent(d);
        if (parent == null) break;
        d = parent.FullName;
      }
    }
    foreach (var p in candidates) if (File.Exists(p)) return p;
    return "";
  }

  static string FindRepoRoot()
  {
    string d = Directory.GetCurrentDirectory();
    for (int i = 0; i < 10; i++)
    {
      if (File.Exists(Path.Combine(d, "SimCEO.sln"))) return d;
      if (File.Exists(Path.Combine(d, "qa", "provider-envelope-regression.fixtures.json"))) return d;
      var parent = Directory.GetParent(d);
      if (parent == null) break;
      d = parent.FullName;
    }
    d = AppContext.BaseDirectory;
    for (int i = 0; i < 12; i++)
    {
      if (File.Exists(Path.Combine(d, "SimCEO.sln"))) return d;
      if (File.Exists(Path.Combine(d, "qa", "provider-envelope-regression.fixtures.json"))) return d;
      var parent = Directory.GetParent(d);
      if (parent == null) break;
      d = parent.FullName;
    }
    return "";
  }
}
