// LostAckAdoption (Muse-authored, QA-owned, no production edits).
//
// Dedicated QA-only in-process wrapper around the REAL PostgresBackend:
// the actual EF commit succeeds, then a QA-owned interceptor throws a
// transport-level lost-acknowledgement ONCE for the Secretary publication
// unit. The ACTUAL Secretary handler (real MapSecretary mapping, real
// reconcile path) must adopt the committed request/owner on retry with the
// same nonce: no second provider dispatch, no second owner, no second ledger
// pair. A reservation fault or an immediate trigger failure is NOT this:
// those roll back deterministically, while here the commit SUCCEEDED and the
// client observed a transport break (TimeoutException -> IsTransportBreak).
//
// Wiring notes (all real code, hosted in-process):
// - Schema via the REAL PgBoot.TryWire (idempotent DDL, frozen ae server).
// - Backend instance is harness-owned: REAL PostgresBackend over REAL
//   PostgresDb with a QA-owned DbTransactionInterceptor added. No HTTP/env/
//   header hook arms the fault; the driver passes --conn/--art/--nonce as
//   process argv and the harness arms its own static flag after observing the
//   live reservation. The backend-owned PgFaults static is never touched.
// - Setup rows (board/meeting/lead/advisor/image) are written through the
//   REAL store write-through + REAL LeadSetup.SaveLead. Every behavior under
//   test runs through real HTTP + the real handler + the real backend.
// - The interceptor fires ONLY for a commit whose stack is inside the actual
//   SecretaryEndpoints publication unit and NOT inside any ledger/billing
//   frame (RecordFull/UsageAccounting/ModelGateway), so the reservation
//   commit and the billed-pair commit pass through untouched. Targeting is
//   self-verified: after the 502 the harness proves the note+history+request
//   rows are REALLY in Postgres and the retry adopts them.
using System.Data.Common;
using System.Diagnostics;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Hosting;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using SimCEO.Api;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;
using SimCEO.Api.Work;
using SimCEO.Postgres;

public sealed class LostAckOnce : DbTransactionInterceptor
{
  public static volatile bool Armed;
  static void TraceFrames()
  {
    if (Environment.GetEnvironmentVariable("LOSTACK_TRACE") != "1") return;
    try
    {
      Console.WriteLine("LOSTACK-TRACE commit-stack armed=" + Armed);
      foreach (var f in new StackTrace(false).GetFrames() ?? Array.Empty<StackFrame>())
      {
        var fn = f.GetMethod()?.DeclaringType?.FullName ?? "?";
        Console.WriteLine("LOSTACK-FRAME " + fn);
      }
      Console.WriteLine("LOSTACK-TRACE end-stack");
    }
    catch { }
  }
  static readonly string[] BlockFrames = { "RecordFull", "UsageAccounting", "UsageStorage", "ModelGateway", "ModelPolicy" };
  // Async continuations resume on the completing thread, so the physical
  // stack below the first async-plumbing frame holds GHOST antecedents
  // (e.g. ModelGateway+CompleteAsync/PostJson/HttpClient from the already
  // finished provider call). Only the synchronous prefix -- interceptor up
  // to the first async-plumbing frame -- describes the committing unit.
  static readonly string[] StopFrames = { "ExecutionContext", "StateMachineBox", "AwaitTaskContinuation", "ThreadPool", "IOCompletion", "SocketAsyncEventArgs", "AsyncMethodBuilder" };
  static bool ShouldFire()
  {
    if (!Armed) return false;
    var frames = new StackTrace(false).GetFrames();
    if (frames is null) return false;
    var hasSecretary = false;
    foreach (var f in frames)
    {
      var m = f.GetMethod(); if (m is null) continue;
      var dt = m.DeclaringType; if (dt is null) continue;
      var fn = dt.FullName ?? "";
      foreach (var s in StopFrames) if (fn.Contains(s)) return hasSecretary;
      foreach (var b in BlockFrames) if (fn.Contains(b)) return false;
      if (fn.Contains("SecretaryEndpoints")) hasSecretary = true;
    }
    return hasSecretary;
  }
  public override void TransactionCommitted(DbTransaction transaction, TransactionEndEventData eventData)
  {
    TraceFrames();
    if (ShouldFire()) { Armed = false; throw new TimeoutException("qa lost ack after REAL commit succeeded"); }
  }
  public override Task TransactionCommittedAsync(DbTransaction transaction, TransactionEndEventData eventData, CancellationToken cancellationToken = default)
  {
    TraceFrames();
    if (ShouldFire()) { Armed = false; throw new TimeoutException("qa lost ack after REAL commit succeeded"); }
    return Task.CompletedTask;
  }
}
public static class Harness
{
  static string Arg(string[] args, string name)
  {
    for (var i = 0; i + 1 < args.Length; i++) if (args[i] == name) return args[i + 1];
    return "";
  }
  static int pass = 0, fail = 0;
  static readonly List<string> failures = new();
  static void Ok(string name, bool cond, string extra = "")
  {
    if (cond) { pass++; Console.WriteLine("  ok " + name); }
    else { fail++; var m = name + (string.IsNullOrEmpty(extra) ? "" : " :: " + extra); failures.Add(m); Console.WriteLine("  FAIL " + m); }
  }
  static string DbNameOf(string cs)
  {
    foreach (var part in cs.Split(";")) { var kv = part.Split("=", 2); if (kv.Length == 2 && kv[0].Trim().Equals("Database", StringComparison.OrdinalIgnoreCase)) return kv[1].Trim(); }
    return "?";
  }
  static string? Str(JsonElement el, params string[] names)
  {
    if (el.ValueKind != JsonValueKind.Object) return null;
    foreach (var n in names) if (el.TryGetProperty(n, out var v)) return v.ValueKind == JsonValueKind.Null ? null : (v.ValueKind == JsonValueKind.String ? v.GetString() : v.ToString());
    foreach (var p in el.EnumerateObject()) foreach (var n in names) if (string.Equals(p.Name, n, StringComparison.OrdinalIgnoreCase)) return p.Value.ValueKind == JsonValueKind.Null ? null : (p.Value.ValueKind == JsonValueKind.String ? p.Value.GetString() : p.Value.ToString());
    return null;
  }
  static Dictionary<string, string> ById(string json)
  {
    var d = new Dictionary<string, string>();
    using var doc = JsonDocument.Parse(json);
    if (doc.RootElement.ValueKind != JsonValueKind.Array) return d;
    foreach (var row in doc.RootElement.EnumerateArray())
    {
      var id = Str(row, "id", "Id");
      if (!string.IsNullOrEmpty(id)) d[id!] = row.GetRawText();
    }
    return d;
  }
  public static async Task<int> Main(string[] args)
  {
    var conn = Arg(args, "--conn");
    var art = Arg(args, "--art");
    var nonce = Arg(args, "--nonce");
    var tag = Arg(args, "--tag");
    var sleepMs = int.TryParse(Arg(args, "--sleep"), out var sm) ? sm : 8000;
    var fakeBase = (Environment.GetEnvironmentVariable("META_API_BASE") ?? "").Trim().TrimEnd('/').ToString();
    Ok("args-present", !string.IsNullOrEmpty(conn) && !string.IsNullOrEmpty(art) && !string.IsNullOrEmpty(nonce), "conn=" + (string.IsNullOrEmpty(conn) ? "<missing>" : "present(len=" + conn.Length + ")") + " art=" + art);
    Ok("fake-env-present", fakeBase.StartsWith("http"), "META_API_BASE set=" + (!string.IsNullOrEmpty(fakeBase)));
    Ok("key-env-present", !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("META_API_KEY")), "META_API_KEY present (value never logged)");
    if (fail > 0) return 2;
    Directory.CreateDirectory(art);
    Console.WriteLine("  info db=" + DbNameOf(conn) + " nonce=" + nonce + " tag=" + tag);
    // 1. REAL schema + REAL boot, then harness-owned intercepted backend.
    if (!PgBoot.TryWire(conn, out var bootErr)) { Ok("pg-trywire", false, bootErr); return 2; }
    Ok("pg-trywire", true, "real DDL applied, db=" + DbNameOf(conn));
    var optb = new DbContextOptionsBuilder<PostgresDb>();
    optb.UseNpgsql(conn);
    optb.AddInterceptors(new LostAckOnce());
    Pg.Backend = new PostgresBackend(new PostgresDb(optb.Options));
    Ok("intercepted-backend-wired", Pg.Backend is PostgresBackend, "REAL PostgresBackend + QA-only post-commit interceptor");
    var store = new InMemoryStore();
    var recA = SecretaryRecovery.RecoverInterrupted(store);
    var recB = JobWorker.RecoverInterrupted(store);
    Ok("recover-interrupted", recA == 0 && recB == 0, "secretary=" + recA + " jobs=" + recB);
    // 2. Setup through REAL store write-through + REAL SaveLead.
    var boardId = Guid.NewGuid(); var meetingId = Guid.NewGuid();
    store.Boards[boardId] = new Board { Id = boardId, Name = "lostack-" + tag, Mission = "lostack mission " + tag, Stage = "forming" };
    store.Meetings[meetingId] = new Meeting { Id = meetingId, BoardId = boardId, Title = "lostack meeting " + tag, Brief = "lostack", State = MeetingState.Active };
    var (savedLead, leadErr, leadSt) = LeadSetup.SaveLead(store, boardId, new LeadProfile { BoardId = boardId, Name = "QA Lead", RoleLabel = "Chief", Background = "bg", FamiliarTopics = "fam", SimplerTopics = "sim", CommPrefs = "direct" });
    Ok("setup-lead", leadSt == 200 && savedLead is not null, "st=" + leadSt + " err=" + leadErr);
    var rent = new RosterEntry { Id = Guid.NewGuid(), AccountId = Guid.Empty, Type = AdvisorType.FictionalCharacter, Name = "lostack-adv", Description = "advisor helping with lostack strategy work", ProfileJson = "{}", Version = 1 };
    store.Roster[rent.Id] = rent;
    var img = new AdvisorImage { Id = Guid.NewGuid(), RosterEntryId = rent.Id, Kind = "upload", Review = "accepted", Provenance = "qa", ContentType = "image/png", Data = new byte[] { 9 } };
    store.Images[img.Id] = img;
    var adv = new BoardAdvisor { Id = Guid.NewGuid(), BoardId = boardId, RosterEntryId = rent.Id, RosterVersion = rent.Version, BoardRole = "Strategist", Approved = true };
    store.Advisors[adv.Id] = adv;
    Ok("setup-advisor", true, "approved advisor with accepted portrait (real write-through)");
    // 3. Host the ACTUAL endpoint mappings in-process (no auth middleware:
    // fresh store is non-secure; owner header is openly authorized).
    var builder = WebApplication.CreateBuilder(new string[0]);
    builder.Services.AddSingleton(store);
    builder.Services.AddSignalR();
    // Mirror of Program.cs Phase7 keyring + wiki service wiring (REAL
    // registrations). Isolated QA keyring: the driver sets WIKI_KEYRING_DIR
    // under the per-run ART dir (the exact override Program.cs provides for
    // isolated QA). WikiSyncHostedService is intentionally NOT hosted: no
    // background sync work runs inside this QA harness.
    {
      var keyDir = Environment.GetEnvironmentVariable("WIKI_KEYRING_DIR");
      if (string.IsNullOrWhiteSpace(keyDir)) keyDir = Path.Combine(AppContext.BaseDirectory, "data", "wiki-keyring");
      Directory.CreateDirectory(keyDir!);
      var dp = builder.Services.AddDataProtection().PersistKeysToFileSystem(new DirectoryInfo(keyDir!)).SetApplicationName("simceo-wiki");
      try { if (OperatingSystem.IsWindows()) dp.ProtectKeysWithDpapi(); } catch { }
    }
    builder.Services.AddSingleton<IWikiClock, SystemWikiClock>();
    builder.Services.AddSingleton<WikiCredentialStore>();
    builder.Services.AddSingleton<WikiSyncService>();
    builder.Logging.ClearProviders();
    builder.Logging.AddConsole();
    builder.Logging.AddFilter("Microsoft.AspNetCore", LogLevel.Warning);
    builder.WebHost.UseUrls("http://127.0.0.1:0");
    var app = builder.Build();
    // ONE real chain: MapExtended wires every actual endpoint group (Secretary,
    // MeetingExtras, Records, Sources, People, Ops, Roster, Wiki) exactly as production.
    // Never map a group twice: duplicate registrations throw AmbiguousMatch.
    SimCEOEndpoints.MapExtended(app);
    await app.StartAsync();
    var listen = app.Urls.Select(u => u.Replace("[::]", "127.0.0.1")).First(u => u.Contains("127.0.0.1"));
    Console.WriteLine("LISTEN=" + listen);
    var http = new HttpClient { Timeout = TimeSpan.FromSeconds(120) };
    http.DefaultRequestHeaders.Add("x-user", "owner");
    async Task<(int status, string text)> PostJson(string path, object body)
    {
      var r = await http.PostAsync(listen + path, JsonContent.Create(body));
      return ((int)r.StatusCode, await r.Content.ReadAsStringAsync());
    }
    async Task<(int status, string text)> GetJson(string path)
    {
      var r = await http.GetAsync(listen + path);
      return ((int)r.StatusCode, await r.Content.ReadAsStringAsync());
    }
    async Task<string> FakeCounts()
    {
      var r = await http.GetAsync(fakeBase + "/__counts");
      return await r.Content.ReadAsStringAsync();
    }
    try
    {
      var input = "lostack probe " + tag + " with SECRETARY-NOTE QA-SLEEP:" + sleepMs;
      var (cs0, calls0t) = await GetJson("/api/models/calls?limit=200&meetingId=" + meetingId);
      var (us0, usage0t) = await GetJson("/api/usage?limit=500&meetingId=" + meetingId);
      Ok("ledgers-baseline-array", cs0 == 200 && us0 == 200, "calls=" + cs0 + " usage=" + us0);
      var calls0 = ById(calls0t); var usage0 = ById(usage0t);
      var fc0 = await FakeCounts();
      var (ns0, notes0t) = await GetJson("/api/meetings/" + meetingId + "/notes");
      Ok("notes-baseline-array", ns0 == 200, "status=" + ns0);
      var notes0 = ById(notes0t);
      // Fire the request; the provider holds QA-SLEEP ms inside the fake.
      var postTask = http.PostAsync(listen + "/api/meetings/" + meetingId + "/secretary", JsonContent.Create(new { input, clientNonce = nonce }));
      // Wait for the live reservation (inflight row), THEN arm lost-ACK.
      // Reservation + billed-pair commits pass through unarmed; only the
      // publication unit (SecretaryEndpoints stack, no ledger frames) fires.
      string? resvId = null;
      for (var i = 0; i < 200 && resvId is null; i++)
      {
        await Task.Delay(100);
        try
        {
          var (rs, rt) = await GetJson("/api/meetings/" + meetingId + "/secretary/requests");
          if (rs != 200) continue;
          using var doc = JsonDocument.Parse(rt);
          if (doc.RootElement.ValueKind != JsonValueKind.Array) continue;
          foreach (var row in doc.RootElement.EnumerateArray())
          {
            if (Str(row, "clientNonce", "ClientNonce") == nonce) { resvId = Str(row, "id", "Id"); break; }
          }
        }
        catch { }
      }
      Ok("reservation-visible-before-arm", resvId is not null, "req=" + (resvId ?? "<none>"));
      if (resvId is null) { try { postTask.Dispose(); } catch { } return 1; }
      LostAckOnce.Armed = true;
      var resp = await postTask;
      var body = await resp.Content.ReadAsStringAsync();
      Ok("lostack-first-502", (int)resp.StatusCode == 502, "status=" + (int)resp.StatusCode + " " + body[..Math.Min(200, body.Length)]);
      Ok("lostack-uncertain-text", body.Contains("uncertain", StringComparison.OrdinalIgnoreCase) && body.Contains("Retry with the same nonce"), body[..Math.Min(160, body.Length)]);
      // The commit REALLY happened: adoptable completed row + note + history.
      var (rs1, rt1) = await GetJson("/api/meetings/" + meetingId + "/secretary/requests");
      Ok("requests-readable", rs1 == 200, "status=" + rs1);
      string? reqId = null, reqStatus = null, reqNote = null, reqBoard = null;
      using (var doc = JsonDocument.Parse(rt1))
        foreach (var row in doc.RootElement.EnumerateArray())
          if (Str(row, "clientNonce", "ClientNonce") == nonce) { reqId = Str(row, "id", "Id"); reqStatus = Str(row, "status", "Status"); reqNote = Str(row, "noteId", "NoteId"); reqBoard = Str(row, "boardId", "BoardId"); }
      Ok("lostack-row-completed", reqStatus == "completed", "status=" + reqStatus + " req=" + reqId);
      Ok("lostack-row-owner", reqBoard == boardId.ToString(), "board=" + reqBoard);
      Ok("lostack-row-note-bound", !string.IsNullOrEmpty(reqNote) && reqNote != "00000000-0000-0000-0000-000000000000", "note=" + reqNote);
      if (!string.IsNullOrEmpty(reqId))
      {
        var (rd, rdt) = await GetJson("/api/meetings/" + meetingId + "/secretary/requests/" + reqId);
        Ok("lostack-detail-200", rd == 200, "status=" + rd);
        using (var doc = JsonDocument.Parse(rdt))
        {
          var hasNote = doc.RootElement.TryGetProperty("note", out var n) && n.ValueKind != JsonValueKind.Null;
          if (!hasNote) foreach (var p in doc.RootElement.EnumerateObject()) if (string.Equals(p.Name, "note", StringComparison.OrdinalIgnoreCase) && p.Value.ValueKind != JsonValueKind.Null) hasNote = true;
          Ok("lostack-detail-note", hasNote, rdt[..Math.Min(200, rdt.Length)]);
        }
      }
      var (ns1, notes1t) = await GetJson("/api/meetings/" + meetingId + "/notes");
      var notes1 = ById(notes1t);
      Ok("lostack-single-note-committed", ns1 == 200 && notes1.Count == notes0.Count + 1 && !string.IsNullOrEmpty(reqNote) && notes1.ContainsKey(reqNote!), "notes " + notes0.Count + "->" + notes1.Count);
      // Retry with the SAME nonce ADOPTS: 200 replay, same request + note,
      // NO second provider dispatch, NO second owner, NO second ledger pair.
      var fc1 = await FakeCounts();
      var (st2, bt2) = await PostJson("/api/meetings/" + meetingId + "/secretary", new { input, clientNonce = nonce });
      Ok("lostack-retry-200", st2 == 200 || st2 == 201, "status=" + st2 + " " + bt2[..Math.Min(200, bt2.Length)]);
      string? reReq = null; var replay = false;
      try
      {
        using var doc = JsonDocument.Parse(bt2);
        reReq = Str(doc.RootElement, "requestId", "RequestId", "requestid");
        var rp = Str(doc.RootElement, "replay", "Replay");
        replay = string.Equals(rp, "True", StringComparison.OrdinalIgnoreCase);
      }
      catch { }
      Ok("lostack-retry-adopts-same", replay && reReq == reqId, "replay=" + replay + " req=" + reReq);
      var fc2 = await FakeCounts();
      Ok("lostack-no-second-provider", fc2 == fc1, "counts stable=" + (fc2 == fc1));
      var (cs2, calls2t) = await GetJson("/api/models/calls?limit=200&meetingId=" + meetingId);
      var (us2, usage2t) = await GetJson("/api/usage?limit=500&meetingId=" + meetingId);
      var calls2 = ById(calls2t); var usage2 = ById(usage2t);
      var newCallIds = calls2.Keys.Where(k => !calls0.ContainsKey(k)).ToList();
      var newUsageIds = usage2.Keys.Where(k => !usage0.ContainsKey(k)).ToList();
      Ok("lostack-one-pair-total", newCallIds.Count == 1 && newUsageIds.Count == 1 && newCallIds[0] == newUsageIds[0], "calls+" + newCallIds.Count + " usage+" + newUsageIds.Count);
      var pairIntact = true;
      foreach (var id in calls0.Keys) if (!calls2.TryGetValue(id, out var cur) || cur != calls0[id]) pairIntact = false;
      foreach (var id in usage0.Keys) if (!usage2.TryGetValue(id, out var cur) || cur != usage0[id]) pairIntact = false;
      Ok("lostack-prior-rows-intact", pairIntact, "baseline calls=" + calls0.Count + " usage=" + usage0.Count);
      if (newCallIds.Count == 1)
      {
        using var doc = JsonDocument.Parse(calls2[newCallIds[0]]);
        Ok("lostack-pair-succeeded", Str(doc.RootElement, "status", "Status") == "succeeded", "status=" + Str(doc.RootElement, "status", "Status"));
        Ok("lostack-pair-scope", Str(doc.RootElement, "meetingId", "MeetingId") == meetingId.ToString(), "mid set");
        Ok("lostack-pair-purpose", Str(doc.RootElement, "purpose", "Purpose") == "secretary", "purpose=" + Str(doc.RootElement, "purpose", "Purpose"));
      }
      var (ns2, notes2t) = await GetJson("/api/meetings/" + meetingId + "/notes");
      var notes2 = ById(notes2t);
      Ok("lostack-retry-no-new-note", ns2 == 200 && notes2.Count == notes1.Count, "notes " + notes1.Count + "->" + notes2.Count);
      // Overlapping retries after adoption: BOTH bind the same completed
      // request; still no provider or ledger growth.
      var tA = http.PostAsync(listen + "/api/meetings/" + meetingId + "/secretary", JsonContent.Create(new { input, clientNonce = nonce }));
      var tB = http.PostAsync(listen + "/api/meetings/" + meetingId + "/secretary", JsonContent.Create(new { input, clientNonce = nonce }));
      var rAB = await Task.WhenAll(tA, tB);
      var bAB = new List<string>();
      foreach (var r in rAB) bAB.Add(await r.Content.ReadAsStringAsync());
      var bothOk = rAB.All(r => (int)r.StatusCode == 200 || (int)r.StatusCode == 201);
      Ok("lostack-overlap-both-bind", bothOk, "A=" + (int)rAB[0].StatusCode + " B=" + (int)rAB[1].StatusCode);
      var sameReq = true;
      foreach (var b in bAB) { try { using var doc = JsonDocument.Parse(b); if (Str(doc.RootElement, "requestId", "RequestId") != reqId) sameReq = false; } catch { sameReq = false; } }
      Ok("lostack-overlap-same-owner", sameReq, "both adopted " + reqId);
      var fc3 = await FakeCounts();
      Ok("lostack-overlap-no-provider", fc3 == fc1, "stable=" + (fc3 == fc1));
      File.WriteAllText(Path.Combine(art, "lostack-result.json"), JsonSerializer.Serialize(new { reqId, noteId = reqNote, pair = newCallIds.FirstOrDefault(), providerStable = fc3 == fc1, pass, fail, failures }, new JsonSerializerOptions { WriteIndented = true }));
    }
    finally
    {
      LostAckOnce.Armed = false;
      try { await app.StopAsync(); } catch { }
      http.Dispose();
    }
    Console.WriteLine(fail == 0 ? ("LOSTACK PASS pass=" + pass) : ("LOSTACK FAIL pass=" + pass + " fail=" + fail));
    foreach (var f in failures) Console.WriteLine(" - " + f);
    return fail == 0 ? 0 : 1;
  }
}

