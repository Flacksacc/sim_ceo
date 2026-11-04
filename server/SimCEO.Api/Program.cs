using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.SignalR;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;
using SimCEO.Api.Hubs;
using SimCEO.Api;
using SimCEO.Api.Work;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSignalR();
builder.Services.AddSingleton<InMemoryStore>();
// Phase7 Wiki keyring: stable private directory (WIKI_KEYRING_DIR overrides for isolated QA).
{
  var keyDir = Environment.GetEnvironmentVariable("WIKI_KEYRING_DIR");
  if (string.IsNullOrWhiteSpace(keyDir))
    keyDir = Path.Combine(AppContext.BaseDirectory, "data", "wiki-keyring");
  try { Directory.CreateDirectory(keyDir!); } catch { }
  var dp = builder.Services.AddDataProtection().PersistKeysToFileSystem(new DirectoryInfo(keyDir!)).SetApplicationName("simceo-wiki");
  try
  {
    if (OperatingSystem.IsWindows())
      dp.ProtectKeysWithDpapi();
  }
  catch { }
}
builder.Services.AddSingleton<SimCEO.Api.Work.IWikiClock, SimCEO.Api.Work.SystemWikiClock>();
builder.Services.AddSingleton<SimCEO.Api.Work.WikiCredentialStore>();
builder.Services.AddSingleton<SimCEO.Api.Work.WikiSyncService>();
builder.Services.AddHostedService<SimCEO.Api.Work.WikiSyncHostedService>();
builder.Services.AddCors(o => o.AddDefaultPolicy(p => p.AllowAnyHeader().AllowAnyMethod().AllowCredentials().SetIsOriginAllowed(_ => true)));
builder.Services.AddAntiforgery();

builder.Logging.ClearProviders();
builder.Logging.AddConsole();
// Suppress hosting request-start logs: they echo the raw URL incl. hub access_token query.
// Hub tokens stay isolated to the hub transport path; no code logs URLs or tokens.
builder.Logging.AddFilter("Microsoft.AspNetCore", LogLevel.Warning);
var app = builder.Build();
app.UseCors();
app.UseAntiforgery();
// Common auth gate. Public credential routes never reject on stale bearer so
// expired credentials cannot block re-authentication. Security-state failure -> 503.
app.Use(async (ctx, next) =>
{
  if (ctx.Request.Path.StartsWithSegments("/api"))
  {
    var store = ctx.RequestServices.GetRequiredService<InMemoryStore>();
    var path = ctx.Request.Path.Value ?? "";
    bool pub = path.StartsWith("/api/auth/register") || path.StartsWith("/api/auth/login")
      || path.StartsWith("/api/auth/me") || path.StartsWith("/api/auth/status")
      || path.StartsWith("/api/presets") || path.StartsWith("/api/backend")
      || (path.Contains("/invites/") && path.EndsWith("/public"));
    if (!pub && PeopleOps.HasInvalidToken(store, ctx.Request))
    {
      ctx.Response.StatusCode = 401;
      await ctx.Response.WriteAsJsonAsync(new { error = "Invalid or expired session token." });
      return;
    }
    bool secure;
    try { secure = PeopleOps.IsSecure(store); }
    catch
    {
      ctx.Response.StatusCode = 503;
      await ctx.Response.WriteAsJsonAsync(new { error = "Security state unavailable." });
      return;
    }
    if (!pub && secure)
    {
      bool ok = false;
      try { ok = AuthOps.TrySession(store, ctx.Request, out _); }
      catch
      {
        ctx.Response.StatusCode = 503;
        await ctx.Response.WriteAsJsonAsync(new { error = "Session store unavailable." });
        return;
      }
      if (!ok)
      {
        ctx.Response.StatusCode = 401;
        await ctx.Response.WriteAsJsonAsync(new { error = "Authentication required." });
        return;
      }
    }
    if (!pub)
    {
      // Fail closed: never continue serving when migration cannot complete.
      try { SecurityOps.EnsureMigrated(store); }
      catch
      {
        ctx.Response.StatusCode = 503;
        await ctx.Response.WriteAsJsonAsync(new { error = "Security state unavailable." });
        return;
      }
    }
  }
  await next();
});
// NOTE: no query-string mutation here. Browser hub transport authenticates via access_token
// query; clearing it breaks SignalR authentication. Request-start log suppression above keeps
// tokens out of hosting logs.
try
{
  var hubCtx = app.Services.GetRequiredService<Microsoft.AspNetCore.SignalR.IHubContext<SimCEO.Api.Hubs.BoardHub>>();
  SimCEO.Api.Hubs.BoardHub.Wire(hubCtx, app.Services);
}
catch { }app.UseDefaultFiles();
app.UseStaticFiles();
app.MapFallbackToFile("index.html");
if (app.Environment.IsDevelopment()) { }



var pgStore = app.Services.GetRequiredService<InMemoryStore>();
string? pgCs = null;
if (Environment.GetEnvironmentVariable("USE_POSTGRES") == "1")
{
  pgCs = builder.Configuration.GetConnectionString("App");
  if (string.IsNullOrWhiteSpace(pgCs))
  {
    Console.Error.WriteLine("POSTGRES FATAL: USE_POSTGRES=1 but no connection string configured (ConnectionStrings:App). Refusing in-memory fallback.");
    Environment.Exit(1);
  }
  else
  {
    try
    {
      var asm = System.Reflection.Assembly.LoadFrom(
        Path.Combine(AppContext.BaseDirectory, "SimCEO.Postgres.dll"));
      var boot = asm.GetType("SimCEO.Postgres.PgBoot");
      var argv = new object?[] { pgCs, "" };
      var ok = boot is not null && (bool)boot.GetMethod("TryWire")!.Invoke(null, argv)!;
      if (!ok)
      {
        Console.Error.WriteLine($"POSTGRES FATAL: {argv[1]}");
        Environment.Exit(1);
      }
      Console.WriteLine("POSTGRES: connected.");
      var recovered = SimCEO.Api.Work.SecretaryRecovery.RecoverInterrupted(pgStore);
      var recoveredJobs = SimCEO.Api.Work.JobWorker.RecoverInterrupted(pgStore);
      var recoveredActivity = SimCEO.Api.Work.MeetingActivity.RecoverInterrupted();
      Console.WriteLine($"POSTGRES: secretary recovery marked {recovered} interrupted request(s).");
      Console.WriteLine($"POSTGRES: job recovery marked {recoveredJobs} interrupted job(s).");
      Console.WriteLine($"POSTGRES: activity recovery marked {recoveredActivity} interrupted operation(s).");
    }
    catch (Exception ex)
    {
      var inner = ex.InnerException;
      while (inner?.InnerException is not null) inner = inner.InnerException;
      Console.Error.WriteLine($"POSTGRES FATAL: backend unavailable ({ex.GetType().Name}: {inner?.Message ?? ex.Message}). Refusing in-memory fallback.");
      Environment.Exit(1);
    }
  }
}

if (args.Contains("--selftest"))
{
  var failures = new List<string>();
  var store = new InMemoryStore();
  var board = new Board { Id = Guid.NewGuid(), Name = "T1", CreatedAt = DateTime.UtcNow };
  store.Boards[board.Id] = board;
  var rosterId = Guid.NewGuid();
  store.Roster[rosterId] = new RosterEntry { Id = rosterId, AccountId = Guid.NewGuid(), Name = "R" };
  for (var i = 0; i < 10; i++)
    store.Advisors[Guid.NewGuid()] = new BoardAdvisor { Id = Guid.NewGuid(), BoardId = board.Id, RosterEntryId = Guid.NewGuid() };
  if (store.Advisors.Values.Count(a => a.BoardId == board.Id && !a.Removed) != 10) failures.Add("advisor-count!=10");
  var eleventhBlocked = store.Advisors.Values.Count(a => a.BoardId == board.Id && !a.Removed) >= 10;
  if (!eleventhBlocked) failures.Add("eleventh-add-not-blocked");
  var meeting = new Meeting { Id = Guid.NewGuid(), BoardId = board.Id };
  store.Meetings[meeting.Id] = meeting;
  store.Messages[meeting.Id] = MessageList.Detached(meeting.Id, new List<Message>());
  for (var i = 1; i <= 3; i++)
  {
    var list = store.Messages[meeting.Id];
    list.Add(new Message { MeetingId = meeting.Id, BoardId = board.Id, Sequence = (list.Count == 0 ? 0 : list.Max(m => m.Sequence)) + 1, Sender = "lead", Content = $"m{i}" });
  }
  meeting.DeliveredRevision = 3;
  if (!store.Messages[meeting.Id].Select(m => m.Sequence).SequenceEqual(new long[] { 1, 2, 3 })) failures.Add("sequence");
  var canon = """[{"id":"a1","text":"t"}]""";
  var draft = new RecordDraft { BoardId = board.Id, MeetingId = meeting.Id, Watermark = meeting.DeliveredRevision, ItemsJson = canon, Hash = Hashing.HashOf(canon), LegacyReview = false };
  store.Drafts[draft.Id] = draft;
  if (!string.Equals(store.Drafts[draft.Id].Hash, Hashing.HashOf(canon), StringComparison.OrdinalIgnoreCase)) failures.Add("hash");
  if (store.Drafts[draft.Id].Watermark != 3) failures.Add("watermark");
  var pol = SimCEO.Api.Work.DiscussionPolicy.SelectRounds("focused",
    Enumerable.Range(0, 8).Select(i => new BoardAdvisor { BoardRole = "R" + i }).ToList(), _ => 1.0);
  if (pol.Count != 2 || pol[0].Count != 3 || pol[1].Count != 2) failures.Add("focused-policy");
  var bal = SimCEO.Api.Work.DiscussionPolicy.SelectRounds("balanced",
    Enumerable.Range(0, 12).Select(i => new BoardAdvisor { BoardRole = "R" + i }).ToList(), _ => 1.0);
  if (bal.SelectMany(r => r).Count() != 10) failures.Add("balanced-cap");
  var many = Enumerable.Range(0, 8).Select(i => new BoardAdvisor { BoardRole = "R" + i }).ToList();
  var fr = SimCEO.Api.Work.DiscussionPolicy.SelectRounds("focused", many, _ => 1.0);
  var fsel = new HashSet<Guid>(fr.SelectMany(r => r).Select(a => a.Id));
  var fomitted = many.Where(a => !fsel.Contains(a.Id)).ToList();
  if (fr.SelectMany(r => r).Count() != 5 || fomitted.Count != 3) failures.Add("focused-overflow");
  var (tok, _) = SimCEO.Api.Work.ContextBudget.DraftPacket(8000, false, null);
  var (tok2, why) = SimCEO.Api.Work.ContextBudget.DraftPacket(11000, true, "missing fact: revenue");
  if (tok != 8000 || tok2 != 11000 || why is null) failures.Add("budgets");
  var chalNone = SimCEO.Api.Work.DiscussionPolicy.AssignChallenge(
    new List<BoardAdvisor> { new() { BoardRole = "A" } }, false, _ => 1.0);
  if (chalNone is not null) failures.Add("challenge-manufactured");
  var (lead1, err1, st1) = LeadSetup.SaveLead(store, board.Id, new LeadProfile { Name = "Ada", RoleLabel = "CEO" });
  if (lead1 is null || err1 is not null || st1 != 200 || lead1.Version != 1 || board.LeadProfileVersion != 1) failures.Add("lead-save-v1");
  var (lead2, _, _) = LeadSetup.SaveLead(store, board.Id, new LeadProfile { Version = 1, Name = "Ada Lovelace" });
  if (lead2 is null || lead2.Version != 2) failures.Add("lead-save-v2");
  var (stale2, staleErr2, staleSt2) = LeadSetup.SaveLead(store, board.Id, new LeadProfile { Version = 1, Name = "Stale" });
  if (stale2 is not null || staleSt2 != 409 || staleErr2 is null) failures.Add("lead-stale-not-rejected");
  foreach (var bl in store.LeadProfiles.Values.Where(l => l.BoardId == board.Id).ToList()) bl.UpdatedAt = DateTime.UtcNow.AddHours(-1);
  var (g1, ge1, gs1) = LeadSetup.SaveLead(store, Guid.Empty, new LeadProfile { Name = "G" });
  if (g1 is null || ge1 is not null || gs1 != 200 || g1.Version != 1 || g1.BoardId != Guid.Empty) failures.Add("lead-global-v1");
  if (g1 is null || LeadSetup.ResolveLead(store)?.Id != g1.Id) failures.Add("lead-resolve-global");
  var (noBoard, _, noBoardSt) = LeadSetup.Activate(store, board.Id, null);
  if (noBoard is not null) failures.Add("activate-without-advisor-should-fail");
  _ = noBoardSt;
  var actEntry = new RosterEntry { Id = Guid.NewGuid(), AccountId = Guid.NewGuid(), Name = "Selftest", Description = "selftest advisor entry", ProfileJson = "a sufficiently long selftest profile json", Version = 1, UpdatedAt = DateTime.UtcNow };
  store.Roster[actEntry.Id] = actEntry;
  store.Images[Guid.NewGuid()] = new AdvisorImage { RosterEntryId = actEntry.Id, Kind = "upload", Review = "accepted", Provenance = "selftest", ContentType = "image/png", Data = new byte[] { 9 } };
  var actAdv = store.Advisors.Values.First(a => a.BoardId == board.Id);
  actAdv.RosterEntryId = actEntry.Id;
  actAdv.RosterVersion = actEntry.Version;
  actAdv.BoardRole = "Selftest Role";
  actAdv.Approved = true;
  // Re-fetch the fixture row: the failed units above (stale lead save,
  // null-hash activate) roll the store back to cloned rows, so the original
  // `board` reference is detached. Set the draft on, hash from, and assert
  // the LIVE stored row plus the returned row.
  store.Boards.TryGetValue(board.Id, out var livePreAct);
  if (livePreAct is not null) livePreAct.DraftJson = """{"name":"T1"}""";
  var (activated, actErr, actSt) = LeadSetup.Activate(store, board.Id, Hashing.HashOf(LeadSetup.CanonicalDraftJson(store, livePreAct ?? board)));
  store.Boards.TryGetValue(board.Id, out var livePostAct);
  if (activated is null || actErr is not null || actSt != 200 || livePostAct is null || !livePostAct.ActiveConfig || !activated.ActiveConfig) failures.Add("activate");
  var (rehash, rehashErr, rehashSt) = LeadSetup.Activate(store, board.Id, "deadbeefdeadbeef");
  if (rehash is not null || rehashSt != 409 || rehashErr is null) failures.Add("activate-hash-not-checked");
  var board2 = new Board { Id = Guid.NewGuid(), Name = "T2", CreatedAt = DateTime.UtcNow };
  store.Boards[board2.Id] = board2;
  var rEntry = new RosterEntry { Id = Guid.NewGuid(), AccountId = Guid.NewGuid(), Name = "CopyMe", Description = "selftest strategist", ProfileJson = "{\"selftest\":\"complete profile for copy gate\"}", Version = 3 };
  store.Roster[rEntry.Id] = rEntry;
  store.Images[Guid.NewGuid()] = new AdvisorImage { RosterEntryId = rEntry.Id, Kind = "upload", Review = "accepted", Provenance = "selftest", ContentType = "image/png", Data = new byte[] { 1 } };
  var (copy1, copyErr1, copySt1) = RosterOps.TryCopy(store, rEntry.Id, board2.Id, "Strategist");
  if (copy1 is null || copyErr1 is not null || copySt1 != 200 || copy1.RosterVersion != 3) failures.Add("roster-copy");
  var (copyDup, _, copyDupSt) = RosterOps.TryCopy(store, rEntry.Id, board2.Id, "Strategist");
  if (copyDup is not null || copyDupSt != 409) failures.Add("roster-copy-dup");
  for (var i = 1; i < 10; i++)
    store.Advisors[Guid.NewGuid()] = new BoardAdvisor { Id = Guid.NewGuid(), BoardId = board2.Id, RosterEntryId = Guid.NewGuid() };
  var rEntry2 = new RosterEntry { Id = Guid.NewGuid(), AccountId = Guid.NewGuid(), Name = "Eleventh" };
  store.Roster[rEntry2.Id] = rEntry2;
  var (copyX, copyErrX, copyStX) = RosterOps.TryCopy(store, rEntry2.Id, board2.Id, "Extra");
  if (copyX is not null || copyStX != 409 || copyErrX is null) failures.Add("roster-copy-cap");
  var export = RecordsOps.BuildExport("""[{"id":"a","text":"Do X","detail":"because","status":"adopted","scope":"board"},{"id":"b","text":"Skip"}]""", """["a"]""", detailed: true);
  if (!export.Contains("[a]") || !export.Contains("because") || export.Contains("Skip")) failures.Add("record-export");
  if (PeopleOps.AccessFor(store, board2.Id, null, "stranger") != "open") failures.Add("grants-default-open");
  var gkey = Guid.NewGuid();
  store.Grants[gkey] = new Grant { Id = gkey, BoardId = board2.Id, UserKey = "stranger", Access = "read" };
  if (PeopleOps.AccessFor(store, board2.Id, null, "stranger") != "read") failures.Add("grant-read");
  var req = new DefaultHttpContext().Request;
  req.Headers["X-User"] = "stranger";
  if (!PeopleOps.Can(store, req, board2.Id, null, "read")) failures.Add("grant-can-read");
  if (PeopleOps.Can(store, req, board2.Id, null, "contribute")) failures.Add("grant-cannot-write");
  store.Grants.TryRemove(gkey, out _);
  var ikey = Guid.NewGuid();
  store.Invites[ikey] = new Invite { Id = ikey, BoardId = board2.Id, Email = "g@x", UserKey = "stranger", State = "revoked" };
  if (PeopleOps.AccessFor(store, board2.Id, null, "stranger") != "none") failures.Add("revoke-persists");
  store.Spend.Mode = "block";
  store.Spend.MonthlyCapUsd = 0;
  var gwCheck = new SimCEO.Api.Work.ModelGateway(store);
  try { gwCheck.ThrowIfCapped(false); failures.Add("spend-block-missed"); }
  catch (SimCEO.Api.Work.CapExceededException) { }
  try { gwCheck.ThrowIfCapped(true); }
  catch (SimCEO.Api.Work.CapExceededException) { failures.Add("spend-owner-blocked"); }
  store.Spend.Mode = "warn";
  store.Spend.MonthlyCapUsd = null;
  store.Usage.Add(new UsageRow { Kind = "p", Model = "m", InputTokens = 1, Cost = null, At = DateTime.UtcNow });
  var (knownSpend, unknownSpend) = SimCEO.Api.Work.ModelGateway.MonthSpend(store);
  if (knownSpend != 0 || unknownSpend < 1) failures.Add("spend-ledger");
  if (ModelPolicy.SparkFor(store, board2.Id) != ModelPolicy.SparkContributor) failures.Add("model-default-contributor");
  board2.DataUse = "standard";
  if (ModelPolicy.SparkFor(store, board2.Id) != ModelPolicy.SparkStandard) failures.Add("model-standard-optout");
  if (ModelPolicy.PriceFor(ModelPolicy.SparkContributor).InPerM >= ModelPolicy.PriceFor(ModelPolicy.SparkStandard).InPerM) failures.Add("model-cheap-check");
  var badLogin = SimCEO.Api.AuthOps.Login(store, "nobody@x.test", "wrongpassword123");
  if (badLogin.session is not null || badLogin.status != 401) failures.Add("auth-reject");
  var weakHash = SimCEO.Api.AuthOps.HashPassword("0123456789ab", SimCEO.Api.AuthOps.NewSalt());
  if (weakHash.Length != 64 || weakHash == SimCEO.Api.AuthOps.HashPassword("0123456789ab", SimCEO.Api.AuthOps.NewSalt())) failures.Add("auth-hash");
  if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("META_API_KEY")))
  {
    var guardReq = new DefaultHttpContext().Request;
    if (PeopleOps.Guard(gwCheck, guardReq) is null) failures.Add("provider-guard-missing");
  }
  var evOk = SimCEO.Api.Work.EvidenceRef.Parse(JsonDocument.Parse("{\"kind\":\"source\",\"ref\":\"abc\",\"version\":2}").RootElement);
  if (evOk is null || evOk.Kind != "source" || evOk.Ref != "abc" || evOk.Version != 2) failures.Add("evidence-ref");
  var evBad = SimCEO.Api.Work.EvidenceRef.Parse(JsonDocument.Parse("{\"kind\":\"nope\",\"ref\":\"x\"}").RootElement);
  if (evBad is not null) failures.Add("evidence-ref-invalid-kind");
  var evList = SimCEO.Api.Work.EvidenceRef.ParseList(JsonDocument.Parse("{\"evidence\":[{\"kind\":\"record\",\"ref\":\"r1\"}]}").RootElement, "evidence");
  if (evList.Count != 1 || evList[0].Kind != "record") failures.Add("evidence-ref-list");
  var evNull = SimCEO.Api.Work.EvidenceRef.Parse(JsonDocument.Parse("{\"kind\":\"source\",\"ref\":\"abc\",\"version\":null}").RootElement);
  if (evNull is null || evNull.Kind != "source" || evNull.Ref != "abc" || evNull.Version is not null) failures.Add("evidence-ref-null-version");
  var noteForRound = new Note { Id = Guid.NewGuid(), BoardId = Guid.NewGuid(), MeetingId = Guid.NewGuid(), Kind = "direction", Title = "t", Body = "b", Scope = "board" };
  var noteJson = SimCEO.Api.Work.EvidenceRef.ToJsonList(new[] { SimCEO.Api.Work.EvidenceRef.ForNote(noteForRound) });
  var noteBack = SimCEO.Api.Work.EvidenceRef.Parse(JsonDocument.Parse(noteJson).RootElement.EnumerateArray().First());
  if (noteBack is null || noteBack.Kind != "direction" || noteBack.Ref != noteForRound.Id.ToString() || noteBack.Version is not null) failures.Add("evidence-ref-note-roundtrip");
  var noteNumVer = SimCEO.Api.Work.EvidenceRef.Parse(JsonDocument.Parse("{\"kind\":\"note\",\"ref\":\"" + noteForRound.Id.ToString() + "\",\"version\":3}").RootElement);
  if (noteNumVer is null || !noteNumVer.Version.HasValue) failures.Add("evidence-ref-note-version-parses");
  var board3 = new Board { Id = Guid.NewGuid(), Name = "T3", CreatedAt = DateTime.UtcNow };
  store.Boards[board3.Id] = board3;
  var dupEntry = new RosterEntry { Id = Guid.NewGuid(), AccountId = Guid.NewGuid(), Name = "DupMe", Description = "dup role strategist", ProfileJson = "{\"selftest\":\"complete profile for dup-role gate\"}", Version = 1 };
  store.Roster[dupEntry.Id] = dupEntry;
  store.Images[Guid.NewGuid()] = new AdvisorImage { RosterEntryId = dupEntry.Id, Kind = "upload", Review = "accepted", Provenance = "selftest", ContentType = "image/png", Data = new byte[] { 2 } };
  var (dup1, _, dupSt1) = RosterOps.TryCopy(store, dupEntry.Id, board3.Id, "Strategist");
  if (dup1 is null || dupSt1 != 200) failures.Add("dup-role-first-copy");
  var dupEntry2 = new RosterEntry { Id = Guid.NewGuid(), AccountId = Guid.NewGuid(), Name = "DupMe2", Description = "dup role analyst", ProfileJson = "{\"selftest\":\"complete profile for same role 2\"}", Version = 1 };
  store.Roster[dupEntry2.Id] = dupEntry2;
  store.Images[Guid.NewGuid()] = new AdvisorImage { RosterEntryId = dupEntry2.Id, Kind = "upload", Review = "accepted", Provenance = "selftest", ContentType = "image/png", Data = new byte[] { 3 } };
  var (dup2, dupErr2, dupSt2) = RosterOps.TryCopy(store, dupEntry2.Id, board3.Id, "strategist");
  if (dup2 is null || dupSt2 != 200 || dupErr2 is not null || dup2.Id == dup1!.Id) failures.Add("same-role-allowed");
  var gate2 = RosterOps.ApprovalGate(store, dup2!);
  if (gate2 is not null) failures.Add("approval-gate-clean");
  var refExport = RecordsOps.BuildExport("""[{"id":"a","text":"Do X","refs":[{"kind":"source","ref":"s1"}]}]""", """["a"]""", detailed: true);
  if (!refExport.Contains("refs: source:s1")) failures.Add("record-export-refs");
  using (var dv = JsonDocument.Parse("[{\"id\":\"a\",\"text\":\"x\"}]"))
    if (!RecordsOps.ValidateDraftItems(dv.RootElement, out _)) failures.Add("draft-items-valid");
  using (var dd = JsonDocument.Parse("[{\"id\":\"a\",\"text\":\"x\"},{\"id\":\"a\",\"text\":\"y\"}]"))
    if (RecordsOps.ValidateDraftItems(dd.RootElement, out _)) failures.Add("draft-items-dup");
  using (var de = JsonDocument.Parse("[{\"id\":\"a\",\"text\":\"\"}]"))
    if (RecordsOps.ValidateDraftItems(de.RootElement, out _)) failures.Add("draft-items-empty-text");
  var isoA = new Board { Id = Guid.NewGuid(), Name = "IsoA", CreatedAt = DateTime.UtcNow };
  store.Boards[isoA.Id] = isoA;
  var isoB = new Board { Id = Guid.NewGuid(), Name = "IsoB", CreatedAt = DateTime.UtcNow };
  store.Boards[isoB.Id] = isoB;
  var (isoA1, _, _) = LeadSetup.SaveLead(store, isoA.Id, new LeadProfile { Name = "LeadA" });
  var (isoB1, _, _) = LeadSetup.SaveLead(store, isoB.Id, new LeadProfile { Name = "LeadB" });
  var (isoA2, _, _) = LeadSetup.SaveLead(store, isoA.Id, new LeadProfile { Version = isoA1!.Version, Name = "LeadA v2" });
  if (isoA2 is null || isoA2.Version != 2) failures.Add("lead-iso-edit");
  if ((LeadSetup.ResolveLeadFor(store, isoB.Id)?.Version ?? 0) != 1) failures.Add("lead-iso-scope");
  // Legacy roster visibility hotfix: blank-OwnerKey rows resolve to the
  // unambiguous linked-board owner, live AND historically removed links, so
  // removing the last live member link cannot delete account ownership.
  // Explicit OwnerKey stays authoritative; distinct owners stay ambiguous.
  {
    HttpRequest DemoReq(string? user)
    {
      var ctx = new DefaultHttpContext();
      if (!string.IsNullOrEmpty(user)) ctx.Request.Headers["X-User"] = user;
      return ctx.Request;
    }
    var legBoard = new Board { Id = Guid.NewGuid(), Name = "LegBoard", OwnerKey = "owner", CreatedAt = DateTime.UtcNow };
    store.Boards[legBoard.Id] = legBoard;
    var legBoard2 = new Board { Id = Guid.NewGuid(), Name = "LegBoard2", OwnerKey = "owner", CreatedAt = DateTime.UtcNow };
    store.Boards[legBoard2.Id] = legBoard2;
    var ambBoard = new Board { Id = Guid.NewGuid(), Name = "AmbBoard", OwnerKey = "other", CreatedAt = DateTime.UtcNow };
    store.Boards[ambBoard.Id] = ambBoard;
    var histAcct = Guid.NewGuid();
    var legEntry = new RosterEntry { Id = Guid.NewGuid(), AccountId = histAcct, OwnerKey = "", Name = "Leg Legacy", Description = "legacy entry", ProfileJson = "{leg-legacy-profile-with-length}", Version = 1, UpdatedAt = DateTime.UtcNow };
    store.Roster[legEntry.Id] = legEntry;
    var legAdv = new BoardAdvisor { Id = Guid.NewGuid(), BoardId = legBoard.Id, RosterEntryId = legEntry.Id, RosterVersion = 1, BoardRole = "Leg Seat", CreatedAt = DateTime.UtcNow };
    store.Advisors[legAdv.Id] = legAdv;
    var legRemoved = new BoardAdvisor { Id = Guid.NewGuid(), BoardId = legBoard2.Id, RosterEntryId = legEntry.Id, RosterVersion = 1, BoardRole = "Old Seat", Removed = true, CreatedAt = DateTime.UtcNow };
    store.Advisors[legRemoved.Id] = legRemoved;
    var rndAcct = Guid.NewGuid();
    var demoReq = DemoReq(null);
    if (legEntry.AccountId == rndAcct) failures.Add("leg-acct-distinct");
    if (RosterLegacyAccess.EffectiveOwnerKey(store, legEntry) != "owner") failures.Add("leg-effective-owner");
    if (!RosterLegacyAccess.CallerMatchesEffectiveOwner(store, demoReq, legEntry)) failures.Add("leg-caller-owner");
    if (!RosterOps.CanWriteRoster(store, demoReq, legEntry)) failures.Add("leg-demo-owner-write");
    if (!RosterEndpoints.CanReadRoster(store, demoReq, legEntry)) failures.Add("leg-demo-owner-read");
    legAdv.Removed = true;
    if (RosterLegacyAccess.EffectiveOwnerKey(store, legEntry) != "owner") failures.Add("leg-historical-owner");
    if (!RosterOps.CanWriteRoster(store, demoReq, legEntry)) failures.Add("leg-historical-write");
    if (!RosterEndpoints.CanReadRoster(store, demoReq, legEntry)) failures.Add("leg-historical-read");
    legAdv.Removed = false;
    var expEntry = new RosterEntry { Id = Guid.NewGuid(), AccountId = histAcct, OwnerKey = "explicit", Name = "Exp", Description = "explicit entry", ProfileJson = "{exp-explicit-profile-with-length}", Version = 1, UpdatedAt = DateTime.UtcNow };
    store.Roster[expEntry.Id] = expEntry;
    store.Advisors[Guid.NewGuid()] = new BoardAdvisor { Id = Guid.NewGuid(), BoardId = ambBoard.Id, RosterEntryId = expEntry.Id, RosterVersion = 1, BoardRole = "Exp Seat", CreatedAt = DateTime.UtcNow };
    if (RosterLegacyAccess.EffectiveOwnerKey(store, expEntry) != "explicit") failures.Add("leg-explicit-priority");
    if (RosterOps.CanWriteRoster(store, DemoReq("stranger-x"), expEntry)) failures.Add("leg-explicit-stranger-denied");
    var ambEntry = new RosterEntry { Id = Guid.NewGuid(), AccountId = histAcct, OwnerKey = "", Name = "Amb", Description = "ambiguous entry", ProfileJson = "{amb-ambiguous-profile-with-length}", Version = 1, UpdatedAt = DateTime.UtcNow };
    store.Roster[ambEntry.Id] = ambEntry;
    store.Advisors[Guid.NewGuid()] = new BoardAdvisor { Id = Guid.NewGuid(), BoardId = legBoard.Id, RosterEntryId = ambEntry.Id, RosterVersion = 1, BoardRole = "Amb A", CreatedAt = DateTime.UtcNow };
    store.Advisors[Guid.NewGuid()] = new BoardAdvisor { Id = Guid.NewGuid(), BoardId = ambBoard.Id, RosterEntryId = ambEntry.Id, RosterVersion = 1, BoardRole = "Amb B", CreatedAt = DateTime.UtcNow };
    if (RosterLegacyAccess.EffectiveOwnerKey(store, ambEntry) is not null) failures.Add("leg-ambiguous-null");
    store.Security[Guid.NewGuid()] = new SecurityState { AuthRequired = true };
    var ownerAcct = new global::SimCEO.Api.Account { Id = Guid.NewGuid(), Email = "se-owner@x.test", Salt = "s", Hash = "h", CreatedAt = DateTime.UtcNow };
    store.Accounts[ownerAcct.Id] = ownerAcct;
    store.Sessions["leg-sec-owner"] = new global::SimCEO.Api.Session { Token = "leg-sec-owner", AccountId = ownerAcct.Id, Email = "se-owner@x.test", ExpiresAt = DateTime.UtcNow.AddHours(1) };
    store.Sessions["leg-sec-bob"] = new global::SimCEO.Api.Session { Token = "leg-sec-bob", AccountId = Guid.NewGuid(), Email = "se-bob@x.test", ExpiresAt = DateTime.UtcNow.AddHours(1) };
    var secBoard = new Board { Id = Guid.NewGuid(), Name = "SecBoard", OwnerKey = "se-owner@x.test", CreatedAt = DateTime.UtcNow };
    store.Boards[secBoard.Id] = secBoard;
    var secEntry = new RosterEntry { Id = Guid.NewGuid(), AccountId = Guid.NewGuid(), OwnerKey = "", Name = "Sec Legacy", Description = "secure legacy entry", ProfileJson = "{sec-legacy-profile-with-length}", Version = 1, UpdatedAt = DateTime.UtcNow };
    store.Roster[secEntry.Id] = secEntry;
    store.Advisors[Guid.NewGuid()] = new BoardAdvisor { Id = Guid.NewGuid(), BoardId = secBoard.Id, RosterEntryId = secEntry.Id, RosterVersion = 1, BoardRole = "Sec Seat", CreatedAt = DateTime.UtcNow };
    HttpRequest SecReq(string tok)
    {
      var sctx = new DefaultHttpContext();
      sctx.Request.Headers["Authorization"] = "Bearer " + tok;
      return sctx.Request;
    }
    if (!PeopleOps.IsSecure(store)) failures.Add("leg-sec-mode-on");
    if (RosterLegacyAccess.EffectiveOwnerKey(store, secEntry) != "se-owner@x.test") failures.Add("leg-sec-effective-owner");
    if (!RosterOps.CanWriteRoster(store, SecReq("leg-sec-owner"), secEntry)) failures.Add("leg-sec-owner-write");
    if (RosterOps.CanWriteRoster(store, SecReq("leg-sec-bob"), secEntry)) failures.Add("leg-sec-stranger-write-denied");
    if (!RosterEndpoints.CanReadRoster(store, SecReq("leg-sec-owner"), secEntry)) failures.Add("leg-sec-owner-read");
    if (RosterEndpoints.CanReadRoster(store, SecReq("leg-sec-bob"), secEntry)) failures.Add("leg-sec-stranger-read-denied");
  }
  // Roster reconciliation store fixture (isolated, no HTTP, no human data).
  // Covers orphan classes unreachable through guarded HTTP paths (restore/import
  // lineage checks rightly refuse to CREATE dangling links): stale re-pin, duplicate
  // removal with history re-point, missing-link RECOVERY (reconstruct canonical entry
  // under the stable id; advisors preserved, never detached), shared missing ref
  // across boards (one entry), distinct empty links (never grouped), owner-mismatch
  // refusal, archived flag-only, plan determinism, hash-guard refusal, replay.
  {
    var rb = new Board { Id = Guid.NewGuid(), Name = "ReconBoard", OwnerKey = "owner", CreatedAt = DateTime.UtcNow };
    store.Boards[rb.Id] = rb;
    var rb2 = new Board { Id = Guid.NewGuid(), Name = "ReconBoard2", OwnerKey = "owner", CreatedAt = DateTime.UtcNow };
    store.Boards[rb2.Id] = rb2;
    var rbX = new Board { Id = Guid.NewGuid(), Name = "ReconForeign", OwnerKey = "external-owner", CreatedAt = DateTime.UtcNow };
    store.Boards[rbX.Id] = rbX;
    var re = new RosterEntry { Id = Guid.NewGuid(), AccountId = Guid.NewGuid(), OwnerKey = "owner", Name = "SelfRecon", Description = "selftest reconciliation entry", ProfileJson = "{selftest:ok}", Version = 5, UpdatedAt = DateTime.UtcNow };
    store.Roster[re.Id] = re;
    store.Images[Guid.NewGuid()] = new AdvisorImage { RosterEntryId = re.Id, Kind = "upload", Review = "accepted", Provenance = "selftest", ContentType = "image/png", Data = new byte[] { 7 } };
    var staleAdv = new BoardAdvisor { Id = Guid.NewGuid(), BoardId = rb.Id, RosterEntryId = re.Id, RosterVersion = 3, BoardRole = "Stale", Approved = true, CreatedAt = DateTime.UtcNow };
    store.Advisors[staleAdv.Id] = staleAdv;
    var re2 = new RosterEntry { Id = Guid.NewGuid(), AccountId = Guid.NewGuid(), OwnerKey = "owner", Name = "SelfReconDup", Description = "selftest duplicate-link entry", ProfileJson = "{dup:ok}", Version = 2, UpdatedAt = DateTime.UtcNow };
    store.Roster[re2.Id] = re2;
    store.Images[Guid.NewGuid()] = new AdvisorImage { RosterEntryId = re2.Id, Kind = "upload", Review = "accepted", Provenance = "selftest", ContentType = "image/png", Data = new byte[] { 8 } };
    var dupOld = new BoardAdvisor { Id = Guid.NewGuid(), BoardId = rb.Id, RosterEntryId = re2.Id, RosterVersion = 2, BoardRole = "Dup", CreatedAt = DateTime.UtcNow.AddMinutes(-5) };
    var dupNew = new BoardAdvisor { Id = Guid.NewGuid(), BoardId = rb.Id, RosterEntryId = re2.Id, RosterVersion = 2, BoardRole = "Dup", CreatedAt = DateTime.UtcNow };
    store.Advisors[dupOld.Id] = dupOld;
    store.Advisors[dupNew.Id] = dupNew;
    var mm = new Meeting { Id = Guid.NewGuid(), BoardId = rb.Id };
    store.Meetings[mm.Id] = mm;
    store.Messages[mm.Id] = MessageList.Detached(mm.Id, new List<Message> { new Message { BoardId = rb.Id, MeetingId = mm.Id, Sequence = 1, AdvisorId = dupNew.Id, Sender = "advisor", AdvisorName = "Dup", Content = "legacy reply", Status = "committed", CreatedAt = DateTime.UtcNow } });
    var sharedMissing = Guid.NewGuid();
    var missA = new BoardAdvisor { Id = Guid.NewGuid(), BoardId = rb.Id, RosterEntryId = sharedMissing, RosterVersion = 1, BoardRole = "Shared Sage", Approved = true, CreatedAt = DateTime.UtcNow.AddMinutes(-2) };
    var missB = new BoardAdvisor { Id = Guid.NewGuid(), BoardId = rb2.Id, RosterEntryId = sharedMissing, RosterVersion = 1, BoardRole = "Shared Sage", CreatedAt = DateTime.UtcNow };
    store.Advisors[missA.Id] = missA;
    store.Advisors[missB.Id] = missB;
    var missImg = new AdvisorImage { RosterEntryId = null, BoardAdvisorId = missB.Id, Kind = "upload", Review = "pending", Provenance = "legacy:board-local", ContentType = "image/png", Data = new byte[] { 9 } };
    store.Images[missImg.Id] = missImg;
    var emptyA = new BoardAdvisor { Id = Guid.NewGuid(), BoardId = rb.Id, RosterEntryId = Guid.Empty, BoardRole = "NoLink One", CreatedAt = DateTime.UtcNow };
    var emptyB = new BoardAdvisor { Id = Guid.NewGuid(), BoardId = rb.Id, RosterEntryId = Guid.Empty, BoardRole = "NoLink Two", CreatedAt = DateTime.UtcNow };
    var rb3 = new Board { Id = Guid.NewGuid(), Name = "ReconBoard3", OwnerKey = "owner", CreatedAt = DateTime.UtcNow };
    store.Boards[rb3.Id] = rb3;
    var emptyE = new BoardAdvisor { Id = Guid.NewGuid(), BoardId = rb3.Id, RosterEntryId = Guid.Empty, BoardRole = "NoLink Scoped3", CreatedAt = DateTime.UtcNow };
    store.Advisors[emptyE.Id] = emptyE;
    var rbO = new Board { Id = Guid.NewGuid(), Name = "ReconOwnerless", OwnerKey = "", CreatedAt = DateTime.UtcNow };
    store.Boards[rbO.Id] = rbO;
    var emptyC = new BoardAdvisor { Id = Guid.NewGuid(), BoardId = rbO.Id, RosterEntryId = Guid.Empty, BoardRole = "NoLink Ownerless", CreatedAt = DateTime.UtcNow };
    var emptyD = new BoardAdvisor { Id = Guid.NewGuid(), BoardId = rb2.Id, RosterEntryId = Guid.Empty, BoardRole = "NoLink Scoped", CreatedAt = DateTime.UtcNow };
    store.Advisors[emptyD.Id] = emptyD;
    store.Advisors[emptyC.Id] = emptyC;
    store.Advisors[emptyA.Id] = emptyA;
    store.Advisors[emptyB.Id] = emptyB;
    var foreignMissing = Guid.NewGuid();
    var missF = new BoardAdvisor { Id = Guid.NewGuid(), BoardId = rbX.Id, RosterEntryId = foreignMissing, RosterVersion = 1, BoardRole = "Foreign Sage", CreatedAt = DateTime.UtcNow };
    var missF2 = new BoardAdvisor { Id = Guid.NewGuid(), BoardId = rb.Id, RosterEntryId = foreignMissing, RosterVersion = 1, BoardRole = "Foreign Sage", CreatedAt = DateTime.UtcNow };
    store.Advisors[missF2.Id] = missF2;
    store.Advisors[missF.Id] = missF;
    var archEntry = new RosterEntry { Id = Guid.NewGuid(), AccountId = Guid.NewGuid(), OwnerKey = "owner", Name = "Arch", Description = "archived entry", ProfileJson = "{selftest:archived}", Version = 1, Archived = true, UpdatedAt = DateTime.UtcNow };
    store.Roster[archEntry.Id] = archEntry;
    var archLink = new BoardAdvisor { Id = Guid.NewGuid(), BoardId = rb.Id, RosterEntryId = archEntry.Id, RosterVersion = 1, BoardRole = "Arch", CreatedAt = DateTime.UtcNow };
    store.Advisors[archLink.Id] = archLink;
    var plan0 = RosterReconciliation.Plan(store, "selftest-key", null);
    bool Mine(Guid b) => b == rb.Id || b == rb2.Id || b == rbX.Id || b == rbO.Id || b == rb3.Id;
    var mine0 = plan0.Orphans.Where(o => Mine(o.BoardId)).ToList();
    if (mine0.Count(o => o.Reason == "stale-version") != 1) failures.Add("recon-scan-stale");
    if (mine0.Count(o => o.Reason == "duplicate-link") != 1) failures.Add("recon-scan-dup");
    if (mine0.Count(o => o.Reason == "missing-roster") != 4) failures.Add("recon-scan-missing");
    if (mine0.Count(o => o.Reason == "empty-link") != 5) failures.Add("recon-scan-empty");
    if (mine0.Count(o => o.Reason == "archived-roster") != 1) failures.Add("recon-scan-archived");
    if (RosterReconciliation.Plan(store, "selftest-key", null).PlanHash != plan0.PlanHash) failures.Add("recon-plan-deterministic");
    var badApply = RosterReconcileApply.Apply(store, "wrong-hash", "selftest-key", null, out _, out var badCode);
    if (badApply.Ok || badCode != 409) failures.Add("recon-apply-hash-guard");
    var emptyDId = RosterLegacyAccess.StableEmptyLinkId(rb2.Id, emptyD.Id);
    var scopePlan = RosterReconciliation.Plan(store, "selftest-scope", rb2.Id);
    if (scopePlan.Orphans.Count(o => o.Reason == "empty-link") != 1) failures.Add("recon-scope-scan");
    // Cross-board sharing: PGMISS-style shared targets must refuse scoped repair with an
    // explicit global-required reason instead of silently leaving the other board behind.
    var scopeRefused = RosterReconcileApply.Apply(store, scopePlan.PlanHash, "selftest-scope", rb2.Id, out var scopeRefErr, out var scopeRefCode);
    if (scopeRefused.Ok || scopeRefCode != 409 || !(scopeRefErr ?? "").Contains("global")) failures.Add("recon-scope-refuses-shared:" + scopeRefErr);
    if (store.Roster.ContainsKey(sharedMissing)) failures.Add("recon-scope-no-partial-entry");
    if (!store.Advisors.TryGetValue(missB.Id, out var missBUntouched) || missBUntouched.Removed || missBUntouched.RosterEntryId != sharedMissing || missBUntouched.RosterVersion != 1) failures.Add("recon-scope-outofscope-approval");
    if (!store.Images.TryGetValue(missImg.Id, out var missImgUntouched) || missImgUntouched.RosterEntryId.HasValue) failures.Add("recon-scope-outofscope-image");
    if (!store.Advisors.TryGetValue(emptyD.Id, out var emptyDUntouched) || emptyDUntouched.RosterEntryId != Guid.Empty) failures.Add("recon-scope-nothing-applied");
    var scopePlanAfter = RosterReconciliation.Plan(store, "selftest-scope", rb2.Id);
    if (!scopePlanAfter.Orphans.Any(o => o.Reason == "missing-roster" && o.RosterEntryId == sharedMissing)) failures.Add("recon-scope-still-reports-shared");
    var globalAfterScope = RosterReconciliation.Plan(store, "selftest-scope", null);
    if (!globalAfterScope.Orphans.Any(o => o.Reason == "missing-roster" && o.RosterEntryId == sharedMissing)) failures.Add("recon-scope-global-still-reports-shared");
    var scopeSharedActs = scopePlan.Actions.Where(a => a.RosterEntryId == sharedMissing).ToList();
    if (!scopeSharedActs.Any(a => a.Kind == "RequiresGlobalScope")) failures.Add("recon-scope-plan-marks-global");
    if (!scopeSharedActs.All(a => (a.Summary ?? "").Contains("global"))) failures.Add("recon-scope-plan-message");
    // Contained scope (single board, no cross-board sharing) still applies cleanly.
    var emptyEId = RosterLegacyAccess.StableEmptyLinkId(rb3.Id, emptyE.Id);
    var scopePlan3 = RosterReconciliation.Plan(store, "selftest-scope3", rb3.Id);
    if (scopePlan3.Orphans.Count(o => o.Reason == "empty-link") != 1) failures.Add("recon-scope3-scan");
    var scopeApplied3 = RosterReconcileApply.Apply(store, scopePlan3.PlanHash, "selftest-scope3", rb3.Id, out var scopeErr3, out _);
    if (!scopeApplied3.Ok) failures.Add("recon-scope3-apply:" + scopeErr3);
    if (!scopeApplied3.Applied.Any(s => s.StartsWith("recover-empty:"))) failures.Add("recon-scope3-no-recover-empty");
    if (!store.Roster.TryGetValue(emptyEId, out var emptyERec) || emptyERec is null || emptyERec.Name != "NoLink Scoped3") failures.Add("recon-scope3-entry");
    if (!store.Advisors.TryGetValue(emptyE.Id, out var emptyEAfter) || emptyEAfter.Removed || emptyEAfter.RosterEntryId != emptyEId || emptyEAfter.Approved) failures.Add("recon-scope3-relink");
    if (!store.Advisors.TryGetValue(emptyA.Id, out var emptyAUntouched) || emptyAUntouched.RosterEntryId != Guid.Empty) failures.Add("recon-scope-untouched");
    var plan1 = RosterReconciliation.Plan(store, "selftest-key", null);
    if (plan1.PlanHash == plan0.PlanHash) failures.Add("recon-plan-hash-moves");
    var appliedOnce = RosterReconcileApply.Apply(store, plan1.PlanHash, "selftest-key", null, out var applyErr, out _);
    if (!appliedOnce.Ok) failures.Add("recon-apply:" + applyErr);
    if (!appliedOnce.Applied.Any(s => s.StartsWith("recover-empty:"))) failures.Add("recon-apply-no-recover-empty");
    if (!appliedOnce.Applied.Any(s => s.StartsWith("recover-empty:"))) failures.Add("recon-apply-no-recover-empty");
    if (!store.Advisors.TryGetValue(staleAdv.Id, out var staleAfter) || staleAfter.RosterVersion != 5 || staleAfter.Approved) failures.Add("recon-repin");
    if (!store.Advisors.TryGetValue(dupNew.Id, out var dupNewAfter) || !dupNewAfter.Removed) failures.Add("recon-dedupe-removed");
    if (!store.Advisors.TryGetValue(dupOld.Id, out var dupOldAfter) || dupOldAfter.Removed) failures.Add("recon-dedupe-survivor");
    if (!store.Messages.TryGetValue(mm.Id, out var mlist) || !mlist.Any(m => m.AdvisorId == dupOld.Id && m.Content == "legacy reply")) failures.Add("recon-history-repoint");
    if (!store.Roster.TryGetValue(sharedMissing, out var recovered) || recovered is null) failures.Add("recon-recover-created");
    else
    {
      if (recovered.OwnerKey != "owner") failures.Add("recon-recover-owner");
      if (recovered.Name != "Shared Sage") failures.Add("recon-recover-name:" + recovered.Name);
      if (!(recovered.Tags ?? "").Contains("recovered")) failures.Add("recon-recover-tag");
      if (!(recovered.ProfileJson ?? "").Contains("No credentials")) failures.Add("recon-recover-honest");
      if (recovered.AccountId == Guid.Empty) failures.Add("recon-recover-account");
      var (recComplete, recMissing) = RosterOps.Completeness(store, sharedMissing);
      if (recComplete) failures.Add("recon-recovered-not-complete");
      if (!recMissing.Any(m => m.Contains("recovered placeholder"))) failures.Add("recon-recovered-missing-actionable");
      var (recDataComplete, _) = RosterOps.DataCompleteness(store, sharedMissing);
      if (recDataComplete) failures.Add("recon-recovered-data-not-complete");
      recovered.Tags = "";
      var (recFixed, _) = RosterOps.Completeness(store, sharedMissing);
      if (!recFixed) failures.Add("recon-recovered-tagstrip-complete");
      recovered.Tags = "recovered";
    }
    if (!store.Advisors.TryGetValue(missA.Id, out var missAAfter) || missAAfter.Removed || missAAfter.RosterVersion != 1 || missAAfter.BoardRole != "Shared Sage") failures.Add("recon-membership-kept-A");
    if (!store.Advisors.TryGetValue(missB.Id, out var missBAfter) || missBAfter.Removed || missBAfter.RosterVersion != 1 || missBAfter.Approved) failures.Add("recon-membership-kept-B");
    if (!store.Advisors.TryGetValue(missF2.Id, out var missF2After) || missF2After.Removed) failures.Add("recon-foreign-preserved-2");
    if (!store.Images.TryGetValue(missImg.Id, out var missImgAfter) || missImgAfter.RosterEntryId != sharedMissing) failures.Add("recon-image-relink");
    if (!store.Advisors.TryGetValue(emptyA.Id, out var emptyAAfter) || emptyAAfter.Removed) failures.Add("recon-empty-preserved-A");
    if (!store.Advisors.TryGetValue(emptyB.Id, out var emptyBAfter) || emptyBAfter.Removed) failures.Add("recon-empty-preserved-B");
    if (store.Roster.ContainsKey(foreignMissing)) failures.Add("recon-foreign-no-entry");
    if (!store.Advisors.TryGetValue(missF.Id, out var missFAfter) || missFAfter.Removed) failures.Add("recon-foreign-preserved");
    if (!appliedOnce.Flagged.Any(s => s.Contains("owner-mismatch"))) failures.Add("recon-foreign-flagged");
    if (!appliedOnce.Flagged.Any(s => s.StartsWith("empty-link:") && s.Contains(emptyC.Id.ToString("N")))) failures.Add("recon-empty-flagged");
    var emptyAId = RosterLegacyAccess.StableEmptyLinkId(rb.Id, emptyA.Id);
    var emptyBId = RosterLegacyAccess.StableEmptyLinkId(rb.Id, emptyB.Id);
    if (!store.Roster.TryGetValue(emptyAId, out var emptyARec) || emptyARec is null || emptyARec.Name != "NoLink One" || !(emptyARec.Tags ?? "").Contains("recovered")) failures.Add("recon-empty-recover-A");
    if (!store.Roster.TryGetValue(emptyBId, out var emptyBRec) || emptyBRec is null || emptyBRec.Name != "NoLink Two") failures.Add("recon-empty-recover-B");
    if (emptyAId == emptyBId) failures.Add("recon-empty-distinct");
    if (!store.Advisors.TryGetValue(emptyA.Id, out var emptyAAfter2) || emptyAAfter2.Removed || emptyAAfter2.RosterEntryId != emptyAId || emptyAAfter2.RosterVersion != 1 || emptyAAfter2.Approved) failures.Add("recon-empty-relink-A");
    if (!store.Advisors.TryGetValue(emptyB.Id, out var emptyBAfter2) || emptyBAfter2.Removed || emptyBAfter2.RosterEntryId != emptyBId) failures.Add("recon-empty-relink-B");
    if (!store.Advisors.TryGetValue(archLink.Id, out var archAfter) || archAfter.Removed) failures.Add("recon-archived-flag-only");
    var cleanPlan = RosterReconciliation.Plan(store, "selftest-key", null);
    var mineClean = cleanPlan.Orphans.Where(o => o.BoardId == rb.Id || o.BoardId == rb2.Id || o.BoardId == rbX.Id || o.BoardId == rbO.Id).ToList();
    if (mineClean.Any(o => o.Reason == "stale-version" || o.Reason == "duplicate-link")) failures.Add("recon-plan-clean");
    if (mineClean.Any(o => o.Reason == "missing-roster" && o.RosterEntryId != foreignMissing)) failures.Add("recon-plan-clean-missing");
    if (!store.Advisors.TryGetValue(emptyC.Id, out var emptyCAfter) || emptyCAfter.Removed || emptyCAfter.RosterEntryId != Guid.Empty) failures.Add("recon-empty-ownerless-preserved");
    var emptyClean = mineClean.Where(o => o.Reason == "empty-link").ToList();
    if (emptyClean.Count != 1 || emptyClean[0].AdvisorId != emptyC.Id) failures.Add("recon-plan-clean-empty");
    var replayed = RosterReconcileApply.Apply(store, plan1.PlanHash, "selftest-key", null, out var replayErr, out _);
    if (!replayed.Ok) failures.Add("recon-replay:" + replayErr);
    // Finding 5 regression: a NEW recoverable empty link after a clean replay must NOT
    // replay-ok; the changed actionable state forces 409/re-plan.
    var emptyNew = new BoardAdvisor { Id = Guid.NewGuid(), BoardId = rb.Id, RosterEntryId = Guid.Empty, BoardRole = "NoLink Late", CreatedAt = DateTime.UtcNow };
    store.Advisors[emptyNew.Id] = emptyNew;
    var replayStale = RosterReconcileApply.Apply(store, plan1.PlanHash, "selftest-key", null, out var replayStaleErr, out var replayStaleCode);
    if (replayStale.Ok || replayStaleCode != 409) failures.Add("recon-replay-new-empty:" + replayStaleErr);
    store.Advisors.TryRemove(emptyNew.Id, out _);
    var emptyNew2 = new BoardAdvisor { Id = Guid.NewGuid(), BoardId = rb.Id, RosterEntryId = Guid.Empty, BoardRole = "NoLink Late Target", CreatedAt = DateTime.UtcNow };
    store.Advisors[emptyNew2.Id] = emptyNew2;
    var preMade = RosterLegacyAccess.StableEmptyLinkId(rb.Id, emptyNew2.Id);
    store.Roster[preMade] = new RosterEntry { Id = preMade, AccountId = Guid.NewGuid(), OwnerKey = "owner", Name = "NoLink Late Target", Description = "pre-existing deterministic target with length", ProfileJson = "{pre:made-profile-with-length}", Version = 1, UpdatedAt = DateTime.UtcNow };
    var replayPreMade = RosterReconcileApply.Apply(store, plan1.PlanHash, "selftest-key", null, out var replayPreMadeErr, out var replayPreMadeCode);
    if (replayPreMade.Ok || replayPreMadeCode != 409) failures.Add("recon-replay-existing-empty-target:" + replayPreMadeErr);
    store.Roster.TryRemove(preMade, out _);
    store.Advisors.TryRemove(emptyNew2.Id, out _);
    // Typed-hash repros: roster-owner change under a duplicate, count-preserving
    // history-row replacement, and unknown historical ownership on duplicates.
    {
      var pbD = new Board { Id = Guid.NewGuid(), Name = "PerturbDup", OwnerKey = "owner", CreatedAt = DateTime.UtcNow };
      store.Boards[pbD.Id] = pbD;
      var peD = new RosterEntry { Id = Guid.NewGuid(), AccountId = Guid.NewGuid(), OwnerKey = "owner", Name = "Perturb Dup Own", Description = "perturbation dup owner entry", ProfileJson = "{perturb:dup-owner-ok}", Version = 1, UpdatedAt = DateTime.UtcNow };
      store.Roster[peD.Id] = peD;
      var pdo = new BoardAdvisor { Id = Guid.NewGuid(), BoardId = pbD.Id, RosterEntryId = peD.Id, RosterVersion = 1, BoardRole = "Perturb Dup", CreatedAt = DateTime.UtcNow.AddMinutes(-3) };
      var pdn = new BoardAdvisor { Id = Guid.NewGuid(), BoardId = pbD.Id, RosterEntryId = peD.Id, RosterVersion = 1, BoardRole = "Perturb Dup", CreatedAt = DateTime.UtcNow };
      store.Advisors[pdo.Id] = pdo;
      store.Advisors[pdn.Id] = pdn;
      var pmm = new Meeting { Id = Guid.NewGuid(), BoardId = pbD.Id };
      store.Meetings[pmm.Id] = pmm;
      store.Messages[pmm.Id] = MessageList.Detached(pmm.Id, new List<Message> { new Message { BoardId = pbD.Id, MeetingId = pmm.Id, Sequence = 1, AdvisorId = pdn.Id, Sender = "advisor", AdvisorName = "Perturb Dup", Content = "perturb dup reply", Status = "committed", CreatedAt = DateTime.UtcNow } });
      var pimgX = new AdvisorImage { Id = Guid.NewGuid(), BoardAdvisorId = pdn.Id, RosterEntryId = null, Kind = "upload", Review = "accepted", Provenance = "perturb:x", ContentType = "image/png", Data = new byte[] { 11 } };
      store.Images[pimgX.Id] = pimgX;
      pmm.ParticipantIdsJson = System.Text.Json.JsonSerializer.Serialize(new[] { pdn.Id });
      string DupHash() => RosterReconciliation.Plan(store, "perturb-dup", null).PlanHash;
      var dh0 = DupHash();
      peD.OwnerKey = "external-owner";
      if (DupHash() == dh0) failures.Add("perturb-dup-owner-static");
      var dhPlan = RosterReconciliation.Plan(store, "perturb-dup", null);
      if (dhPlan.Actions.Any(a => a.Kind == "RemoveDuplicateLink" && a.RosterEntryId == peD.Id)) failures.Add("perturb-dup-owner-still-removes");
      if (!dhPlan.Actions.Any(a => a.Kind == "FlagForOwnerReview" && a.AdvisorId == pdn.Id)) failures.Add("perturb-dup-owner-no-flag");
      var dhStale = RosterReconcileApply.Apply(store, dh0, "perturb-dup", null, out _, out var dhCode);
      if (dhStale.Ok || dhCode != 409) failures.Add("perturb-dup-owner-accepted");
      peD.OwnerKey = "owner";
      if (DupHash() != dh0) failures.Add("perturb-dup-owner-restore-drift");
      var dhMsg = store.Messages[pmm.Id].First(m => m.AdvisorId == pdn.Id);
      var dhSeq = dhMsg.Sequence;
      dhMsg.Sequence = dhSeq + 1;
      if (DupHash() == dh0) failures.Add("perturb-dup-row-static");
      var dhMsgStale = RosterReconcileApply.Apply(store, dh0, "perturb-dup", null, out _, out var dhMsgCode);
      if (dhMsgStale.Ok || dhMsgCode != 409) failures.Add("perturb-dup-row-accepted");
      dhMsg.Sequence = dhSeq;
      if (DupHash() != dh0) failures.Add("perturb-dup-row-restore-drift");
      store.Images.TryRemove(pimgX.Id, out _);
      var pimgY = new AdvisorImage { Id = Guid.NewGuid(), BoardAdvisorId = pdn.Id, RosterEntryId = null, Kind = "upload", Review = "accepted", Provenance = "perturb:y", ContentType = "image/png", Data = new byte[] { 12 } };
      store.Images[pimgY.Id] = pimgY;
      if (DupHash() == dh0) failures.Add("perturb-dup-img-static");
      var dhImgStale = RosterReconcileApply.Apply(store, dh0, "perturb-dup", null, out _, out var dhImgCode);
      if (dhImgStale.Ok || dhImgCode != 409) failures.Add("perturb-dup-img-accepted");
      store.Images.TryRemove(pimgY.Id, out _);
      store.Images[pimgX.Id] = pimgX;
      if (DupHash() != dh0) failures.Add("perturb-dup-img-restore-drift");
      var dhParts = pmm.ParticipantIdsJson;
      pmm.ParticipantIdsJson = System.Text.Json.JsonSerializer.Serialize(new[] { pdo.Id });
      if (DupHash() == dh0) failures.Add("perturb-dup-parts-static");
      var dhPartsStale = RosterReconcileApply.Apply(store, dh0, "perturb-dup", null, out _, out var dhPartsCode);
      if (dhPartsStale.Ok || dhPartsCode != 409) failures.Add("perturb-dup-parts-accepted");
      pmm.ParticipantIdsJson = dhParts;
      if (DupHash() != dh0) failures.Add("perturb-dup-parts-restore-drift");
      peD.Description = "D;name=Alice"; peD.Name = "Bob";
      var dhDelim1 = DupHash();
      if (dhDelim1 == dh0) failures.Add("perturb-dup-delim-static");
      peD.Description = "D"; peD.Name = "Alice;name=Bob";
      if (DupHash() == dhDelim1) failures.Add("perturb-dup-delim-collision");
      var dhDelimStale = RosterReconcileApply.Apply(store, dhDelim1, "perturb-dup", null, out _, out var dhDelimCode);
      if (dhDelimStale.Ok || dhDelimCode != 409) failures.Add("perturb-dup-delim-accepted");
      peD.Description = "perturbation dup owner entry"; peD.Name = "Perturb Dup Own";
      if (DupHash() != dh0) failures.Add("perturb-dup-delim-restore-drift");
      var rbU = new Board { Id = Guid.NewGuid(), Name = "PerturbUnknown", OwnerKey = "", CreatedAt = DateTime.UtcNow };
      store.Boards[rbU.Id] = rbU;
      var uMiss = Guid.NewGuid();
      var rU0 = new BoardAdvisor { Id = Guid.NewGuid(), BoardId = Guid.NewGuid(), RosterEntryId = uMiss, RosterVersion = 1, BoardRole = "Unknown Gone", Removed = true, CreatedAt = DateTime.UtcNow.AddMinutes(-9) };
      store.Advisors[rU0.Id] = rU0;
      var rU1 = new BoardAdvisor { Id = Guid.NewGuid(), BoardId = rbU.Id, RosterEntryId = uMiss, RosterVersion = 1, BoardRole = "Unknown Dup", CreatedAt = DateTime.UtcNow.AddMinutes(-2) };
      var rU2 = new BoardAdvisor { Id = Guid.NewGuid(), BoardId = rbU.Id, RosterEntryId = uMiss, RosterVersion = 1, BoardRole = "Unknown Dup", CreatedAt = DateTime.UtcNow };
      store.Advisors[rU1.Id] = rU1;
      store.Advisors[rU2.Id] = rU2;
      var umm = new Meeting { Id = Guid.NewGuid(), BoardId = rbU.Id };
      store.Meetings[umm.Id] = umm;
      store.Messages[umm.Id] = MessageList.Detached(umm.Id, new List<Message> { new Message { BoardId = rbU.Id, MeetingId = umm.Id, Sequence = 1, AdvisorId = rU2.Id, Sender = "advisor", AdvisorName = "Unknown Dup", Content = "unknown dup reply", Status = "committed", CreatedAt = DateTime.UtcNow } });
      var uPlan = RosterReconciliation.Plan(store, "perturb-unknown", rbU.Id);
      if (uPlan.Actions.Any(a => a.Kind == "RemoveDuplicateLink")) failures.Add("perturb-unknown-plans-removal");
      if (!uPlan.Actions.Any(a => a.Kind == "FlagForOwnerReview" && a.AdvisorId == rU2.Id)) failures.Add("perturb-unknown-no-flag");
      var uApplied = RosterReconcileApply.Apply(store, uPlan.PlanHash, "perturb-unknown", rbU.Id, out var uErr, out _);
      if (!uApplied.Ok) failures.Add("perturb-unknown-apply:" + uErr);
      if (uApplied.Applied.Any(s => s.StartsWith("dedupe:"))) failures.Add("perturb-unknown-mutated");
      if (uApplied.Applied.Any(s => s.StartsWith("recover:"))) failures.Add("perturb-unknown-recovered");
      if (!store.Advisors.TryGetValue(rU2.Id, out var rU2After) || rU2After.Removed) failures.Add("perturb-unknown-removed");
      if (!store.Messages.TryGetValue(umm.Id, out var uml) || !uml.Any(m => m.AdvisorId == rU2.Id && m.Content == "unknown dup reply")) failures.Add("perturb-unknown-history-moved");
      store.Messages[umm.Id] = MessageList.Detached(umm.Id, new List<Message>());
      store.Meetings.TryRemove(umm.Id, out _);
      store.Advisors.TryRemove(rU0.Id, out _);
      store.Advisors.TryRemove(rU1.Id, out _);
      store.Advisors.TryRemove(rU2.Id, out _);
      store.Boards.TryRemove(rbU.Id, out _);
      store.Messages[pmm.Id] = MessageList.Detached(pmm.Id, new List<Message>());
      store.Meetings.TryRemove(pmm.Id, out _);
      store.Images.TryRemove(pimgX.Id, out _);
      store.Advisors.TryRemove(pdo.Id, out _);
      store.Advisors.TryRemove(pdn.Id, out _);
      store.Roster.TryRemove(peD.Id, out _);
      store.Boards.TryRemove(pbD.Id, out _);
    }
    // Existing deterministic empty-link target: owner/archive/version changes
    // move the hash; the dry-run describes relink (not create v1); apply never
    // attaches a foreign or archived target.
    {
      var emptyT = new BoardAdvisor { Id = Guid.NewGuid(), BoardId = rb.Id, RosterEntryId = Guid.Empty, BoardRole = "NoLink Target", CreatedAt = DateTime.UtcNow };
      store.Advisors[emptyT.Id] = emptyT;
      var preT = RosterLegacyAccess.StableEmptyLinkId(rb.Id, emptyT.Id);
      store.Roster[preT] = new RosterEntry { Id = preT, AccountId = Guid.NewGuid(), OwnerKey = "owner", Name = "NoLink Target", Description = "pre-existing deterministic target", ProfileJson = "{pre:target-profile-with-length}", Version = 3, UpdatedAt = DateTime.UtcNow };
      string TargetHash() => RosterReconciliation.Plan(store, "perturb-target", null).PlanHash;
      var th0 = TargetHash();
      var thPlan = RosterReconciliation.Plan(store, "perturb-target", null);
      if (!thPlan.Actions.Any(a => a.Kind == "RecoverEmptyLink" && a.AdvisorId == emptyT.Id && (a.Summary ?? "").Contains("EXISTING"))) failures.Add("perturb-target-no-relink-desc");
      store.Roster.TryGetValue(preT, out var thEntry);
      thEntry!.OwnerKey = "foreign-owner";
      if (TargetHash() == th0) failures.Add("perturb-target-owner-static");
      var thPlanF = RosterReconciliation.Plan(store, "perturb-target", null);
      if (thPlanF.Actions.Any(a => a.Kind == "RecoverEmptyLink" && a.AdvisorId == emptyT.Id)) failures.Add("perturb-target-foreign-still-recovers");
      if (!thPlanF.Actions.Any(a => a.Kind == "FlagForOwnerReview" && a.AdvisorId == emptyT.Id)) failures.Add("perturb-target-foreign-no-flag");
      var thApplyF = RosterReconcileApply.Apply(store, thPlanF.PlanHash, "perturb-target", null, out var thErrF, out _);
      if (!thApplyF.Ok) failures.Add("perturb-target-foreign-apply:" + thErrF);
      if (thApplyF.Applied.Any(s => s.Contains("relink") || s.Contains("recover-empty"))) failures.Add("perturb-target-foreign-attached");
      if (!store.Advisors.TryGetValue(emptyT.Id, out var emptyTAfterF) || emptyTAfterF.RosterEntryId != Guid.Empty) failures.Add("perturb-target-foreign-linked");
      thEntry.OwnerKey = "owner";
      thEntry.Archived = true;
      if (TargetHash() == th0) failures.Add("perturb-target-archive-static");
      var thPlanA = RosterReconciliation.Plan(store, "perturb-target", null);
      if (!thPlanA.Actions.Any(a => a.Kind == "FlagForOwnerReview" && a.AdvisorId == emptyT.Id)) failures.Add("perturb-target-archive-no-flag");
      thEntry.Archived = false;
      thEntry.Version = 4;
      if (TargetHash() == th0) failures.Add("perturb-target-version-static");
      var thStale = RosterReconcileApply.Apply(store, th0, "perturb-target", null, out _, out var thCode);
      if (thStale.Ok || thCode != 409) failures.Add("perturb-target-version-accepted");
      thEntry.Version = 3;
      if (TargetHash() != th0) failures.Add("perturb-target-restore-drift");
      store.Roster.TryRemove(preT, out _);
      store.Advisors.TryRemove(emptyT.Id, out _);
    }
  }
  // Plan-hash perturbation fixture: every mutation input (roles, board owner,
  // account, image provenance, board name) is bound into the hash, so an author
  // change between review and apply forces 409/re-plan instead of a stale repair.
  {
    var pb = new Board { Id = Guid.NewGuid(), Name = "PerturbBoard", OwnerKey = "owner", CreatedAt = DateTime.UtcNow };
    store.Boards[pb.Id] = pb;
    var pb2 = new Board { Id = Guid.NewGuid(), Name = "PerturbBoard2", OwnerKey = "owner", CreatedAt = DateTime.UtcNow };
    store.Boards[pb2.Id] = pb2;
    var pMiss = Guid.NewGuid();
    var pma = new BoardAdvisor { Id = Guid.NewGuid(), BoardId = pb.Id, RosterEntryId = pMiss, RosterVersion = 1, BoardRole = "Perturb Sage", CreatedAt = DateTime.UtcNow };
    var pmb = new BoardAdvisor { Id = Guid.NewGuid(), BoardId = pb2.Id, RosterEntryId = pMiss, RosterVersion = 1, BoardRole = "Perturb Sage", CreatedAt = DateTime.UtcNow };
    store.Advisors[pma.Id] = pma;
    store.Advisors[pmb.Id] = pmb;
    var pimg = new AdvisorImage { Id = Guid.NewGuid(), BoardAdvisorId = pmb.Id, RosterEntryId = null, Kind = "upload", Review = "pending", Provenance = "legacy:board-local", ContentType = "image/png", Data = new byte[] { 9 } };
    store.Images[pimg.Id] = pimg;
    var pe = new RosterEntry { Id = Guid.NewGuid(), AccountId = Guid.NewGuid(), OwnerKey = "owner", Name = "Perturb Stale", Description = "perturbation stale entry", ProfileJson = "{perturb:stale-profile-ok}", Version = 2, UpdatedAt = DateTime.UtcNow };
    store.Roster[pe.Id] = pe;
    var pstale = new BoardAdvisor { Id = Guid.NewGuid(), BoardId = pb.Id, RosterEntryId = pe.Id, RosterVersion = 1, BoardRole = "Perturb Stale Seat", Approved = true, CreatedAt = DateTime.UtcNow };
    store.Advisors[pstale.Id] = pstale;
    var pd = new RosterEntry { Id = Guid.NewGuid(), AccountId = Guid.NewGuid(), OwnerKey = "owner", Name = "Perturb Dup", Description = "perturbation dup entry", ProfileJson = "{perturb:dup-profile-ok}", Version = 1, UpdatedAt = DateTime.UtcNow };
    store.Roster[pd.Id] = pd;
    var pdo = new BoardAdvisor { Id = Guid.NewGuid(), BoardId = pb.Id, RosterEntryId = pd.Id, RosterVersion = 1, BoardRole = "Perturb Dup", CreatedAt = DateTime.UtcNow.AddMinutes(-3) };
    var pdn = new BoardAdvisor { Id = Guid.NewGuid(), BoardId = pb.Id, RosterEntryId = pd.Id, RosterVersion = 1, BoardRole = "Perturb Dup", CreatedAt = DateTime.UtcNow };
    store.Advisors[pdo.Id] = pdo;
    store.Advisors[pdn.Id] = pdn;
    var pen = new BoardAdvisor { Id = Guid.NewGuid(), BoardId = pb.Id, RosterEntryId = Guid.Empty, BoardRole = "Perturb Empty", CreatedAt = DateTime.UtcNow };
    store.Advisors[pen.Id] = pen;
    var pimg2 = new AdvisorImage { Id = Guid.NewGuid(), BoardAdvisorId = pen.Id, RosterEntryId = null, Kind = "upload", Review = "pending", Provenance = "legacy:empty-local", ContentType = "image/png", Data = new byte[] { 10 } };
    store.Images[pimg2.Id] = pimg2;
    string PerturbHash() => RosterReconciliation.Plan(store, "perturb", null).PlanHash;
    var ph0 = PerturbHash();
    void PerturbCheck(string name, Action mutate, Action restore)
    {
      mutate();
      if (PerturbHash() == ph0) failures.Add("perturb-hash-static:" + name);
      var stale = RosterReconcileApply.Apply(store, ph0, "perturb", null, out _, out var pcode);
      if (stale.Ok || pcode != 409) failures.Add("perturb-old-plan-accepted:" + name);
      restore();
      if (PerturbHash() != ph0) failures.Add("perturb-restore-drift:" + name);
    }
    PerturbCheck("role", () => { pma.BoardRole = "Perturb Sage Renamed"; }, () => { pma.BoardRole = "Perturb Sage"; });
    PerturbCheck("board-owner", () => { pb2.OwnerKey = "someone-else"; }, () => { pb2.OwnerKey = "owner"; });
    var pacc = new global::SimCEO.Api.Account { Id = Guid.NewGuid(), Email = "owner", Salt = "", Hash = "", CreatedAt = DateTime.UtcNow };
    PerturbCheck("account", () => { store.Accounts[pacc.Id] = pacc; }, () => { store.Accounts.TryRemove(pacc.Id, out _); });
    PerturbCheck("provenance", () => { pimg.Provenance = "legacy:board-local-changed"; }, () => { pimg.Provenance = "legacy:board-local"; });
    PerturbCheck("board-name", () => { pb.Name = "PerturbBoard Renamed"; }, () => { pb.Name = "PerturbBoard"; });
    PerturbCheck("stale-role", () => { pstale.BoardRole = "Perturb Stale Seat 2"; }, () => { pstale.BoardRole = "Perturb Stale Seat"; });
    PerturbCheck("dup-roles", () => { pdn.BoardRole = "Perturb Dup 2"; }, () => { pdn.BoardRole = "Perturb Dup"; });
    foreach (var aid in new[] { pma.Id, pmb.Id, pstale.Id, pdo.Id, pdn.Id, pen.Id }) store.Advisors.TryRemove(aid, out _);
    foreach (var iid in new[] { pimg.Id, pimg2.Id }) store.Images.TryRemove(iid, out _);
    foreach (var rid in new[] { pe.Id, pd.Id }) store.Roster.TryRemove(rid, out _);
    foreach (var bid in new[] { pb.Id, pb2.Id }) store.Boards.TryRemove(bid, out _);
  }
  // Secure-mode ownership fixture: legacy blank-owner entry on an unambiguously
  // owned board. Owner writes via effective ownership (no grant needed);
  // strangers are denied read and write (secure defaults deny).
  {
    var secBoard = new Board { Id = Guid.NewGuid(), Name = "SecBoard", OwnerKey = "owner@x.test", CreatedAt = DateTime.UtcNow };
    store.Boards[secBoard.Id] = secBoard;
    var secEntry = new RosterEntry { Id = Guid.NewGuid(), AccountId = Guid.NewGuid(), OwnerKey = "", Name = "Sec Legacy", Description = "secure legacy entry", ProfileJson = "{sec:legacy-profile-with-length}", Version = 1, UpdatedAt = DateTime.UtcNow };
    store.Roster[secEntry.Id] = secEntry;
    var secAdv = new BoardAdvisor { Id = Guid.NewGuid(), BoardId = secBoard.Id, RosterEntryId = secEntry.Id, RosterVersion = 1, BoardRole = "Sec Seat", CreatedAt = DateTime.UtcNow };
    store.Advisors[secAdv.Id] = secAdv;
    store.Security[Guid.NewGuid()] = new SecurityState { AuthRequired = true };
    var ownerAcct = new global::SimCEO.Api.Account { Id = Guid.NewGuid(), Email = "owner@x.test", Salt = "", Hash = "", CreatedAt = DateTime.UtcNow };
    store.Accounts[ownerAcct.Id] = ownerAcct;
    store.Sessions["sec-owner"] = new global::SimCEO.Api.Session { Token = "sec-owner", AccountId = ownerAcct.Id, Email = "owner@x.test", ExpiresAt = DateTime.UtcNow.AddHours(1) };
    store.Sessions["sec-bob"] = new global::SimCEO.Api.Session { Token = "sec-bob", AccountId = Guid.NewGuid(), Email = "bob@x.test", ExpiresAt = DateTime.UtcNow.AddHours(1) };
    HttpRequest SecReq(string tok)
    {
      var ctx = new DefaultHttpContext();
      ctx.Request.Headers["Authorization"] = "Bearer " + tok;
      return ctx.Request;
    }
    if (!PeopleOps.IsSecure(store)) failures.Add("sec-mode-on");
    if (RosterLegacyAccess.EffectiveOwnerKey(store, secEntry) != "owner@x.test") failures.Add("sec-effective-owner");
    if (!RosterOps.CanWriteRoster(store, SecReq("sec-owner"), secEntry)) failures.Add("sec-owner-write");
    if (RosterOps.CanWriteRoster(store, SecReq("sec-bob"), secEntry)) failures.Add("sec-stranger-write-denied");
    if (!RosterEndpoints.CanReadRoster(store, SecReq("sec-owner"), secEntry)) failures.Add("sec-owner-read");
    if (RosterEndpoints.CanReadRoster(store, SecReq("sec-bob"), secEntry)) failures.Add("sec-stranger-read-denied");
    var secHist = new RosterEntry { Id = Guid.NewGuid(), AccountId = Guid.NewGuid(), OwnerKey = "", Name = "Sec Historical", Description = "secure removed-only legacy entry", ProfileJson = "{sec:historical-profile-length}", Version = 1, UpdatedAt = DateTime.UtcNow };
    store.Roster[secHist.Id] = secHist;
    var secHAdv = new BoardAdvisor { Id = Guid.NewGuid(), BoardId = secBoard.Id, RosterEntryId = secHist.Id, RosterVersion = 1, BoardRole = "Sec Gone", Removed = true, CreatedAt = DateTime.UtcNow };
    store.Advisors[secHAdv.Id] = secHAdv;
    if (!RosterEndpoints.CanReadRoster(store, SecReq("sec-owner"), secHist)) failures.Add("sec-removed-history-read");
    if (RosterEndpoints.CanReadRoster(store, SecReq("sec-bob"), secHist)) failures.Add("sec-removed-history-stranger");
    if (!RosterOps.CanWriteRoster(store, SecReq("sec-owner"), secHist)) failures.Add("sec-removed-history-write");
    if (!RosterLegacyAccess.OwnerMatches(store, secHist, "owner@x.test")) failures.Add("sec-removed-history-match");
    if (RosterLegacyAccess.OwnerMatches(store, secHist, "bob@x.test")) failures.Add("sec-removed-history-mismatch");
  }
    Console.WriteLine(failures.Count == 0 ? "SELFTEST PASS: advisor-cap, sequence, record-hash, policy, budgets, challenge, lead-version, setup-activate, roster-copy, same-role, approval-gate, record-export, record-export-refs, evidence-ref, grants, spend-cap, model-policy, provider-guard" : "SELFTEST FAIL: " + string.Join(";", failures));
  Environment.Exit(failures.Count == 0 ? 0 : 1);
}
if (args.Contains("--selftest-pg"))
{
  var pgFailures = new List<string>();
  var pgArgs = args.ToList();
  var pgPhase = pgArgs.Count > pgArgs.IndexOf("--selftest-pg") + 1 ? pgArgs[pgArgs.IndexOf("--selftest-pg") + 1] : "seed";
  var pgPriorHash = pgArgs.Count > pgArgs.IndexOf("--selftest-pg") + 2 ? pgArgs[pgArgs.IndexOf("--selftest-pg") + 2] : "";
  var pgConn = Environment.GetEnvironmentVariable("SIMCEO_PG_CONN") ?? "";
  if (string.IsNullOrWhiteSpace(pgConn)) { Console.WriteLine("PGSELFTEST FAIL: SIMCEO_PG_CONN is required."); Environment.Exit(2); }
  try
  {
    var asm = System.Reflection.Assembly.LoadFrom(Path.Combine(AppContext.BaseDirectory, "SimCEO.Postgres.dll"));
    var boot = asm.GetType("SimCEO.Postgres.PgBoot");
    var argv = new object?[] { pgConn, "" };
    if (!(bool)boot!.GetMethod("TryWire")!.Invoke(null, argv)!) throw new InvalidOperationException("wire: " + argv[1]);
  }
  catch (Exception ex) { Console.WriteLine("PGSELFTEST FAIL wire: " + ex.GetBaseException().Message); Environment.Exit(2); }
  var pstore = new InMemoryStore();
  var PGB = Guid.Parse("11111111-1111-1111-1111-111111111111");
  var PGB2 = Guid.Parse("22222222-2222-2222-2222-222222222222");
  var PGBX = Guid.Parse("33333333-3333-3333-3333-333333333333");
  var PGE = Guid.Parse("44444444-4444-4444-4444-444444444444");
  var PGSTALE = Guid.Parse("55555555-5555-5555-5555-555555555555");
  var PGD = Guid.Parse("66666666-6666-6666-6666-666666666666");
  var PGDUPOLD = Guid.Parse("77777777-7777-7777-7777-777777777777");
  var PGDUPNEW = Guid.Parse("88888888-8888-8888-8888-888888888888");
  var PGMTG = Guid.Parse("99999999-9999-9999-9999-999999999999");
  var PGMISS = Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
  var PGMA = Guid.Parse("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  var PGMB = Guid.Parse("cccccccc-cccc-cccc-cccc-cccccccccccc");
  var PGMIMG = Guid.Parse("dddddddd-dddd-dddd-dddd-dddddddddddd");
  var PGEA = Guid.Parse("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee");
  var PGEB = Guid.Parse("ffffffff-ffff-ffff-ffff-ffffffffffff");
  var PGF = Guid.Parse("12345678-1234-1234-1234-123456789012");
  var PGFF = Guid.Parse("23456789-2345-2345-2345-234567890123");
  var PGFF2 = Guid.Parse("34567890-3456-3456-3456-345678901234");
  var PGARCH = Guid.Parse("87654321-8765-8765-8765-876543218765");
  var PGARCHL = Guid.Parse("98765432-9876-9876-9876-987654329876");
  var PGBO = Guid.Parse("aaaa1111-2222-3333-4444-555555555555");
  var PGB3 = Guid.Parse("dddd1111-2222-3333-4444-555555555555");
  var PGENE = Guid.Parse("eeee3333-4444-5555-6666-777777777777");
  var PGEC = Guid.Parse("bbbb2222-3333-4444-5555-666666666666");
  var PGEX = Guid.Parse("eeee5555-5555-5555-5555-555555555555");
  var PGBU = Guid.Parse("eeee1111-2222-3333-4444-555555555555");
  var PGBUD0 = Guid.Parse("eeee2222-2222-2222-2222-222222222222");
  var PGBUD1 = Guid.Parse("eeee3333-3333-3333-3333-333333333333");
  var PGBUD2 = Guid.Parse("eeee4444-4444-4444-4444-444444444444");
  var PGBUMM = Guid.Parse("eeee6666-6666-6666-6666-666666666666");
  var PGUMISS = Guid.Parse("eeee7777-7777-7777-7777-777777777777");
  if (pgPhase == "seed")
  {
    pstore.Boards[PGB] = new Board { Id = PGB, Name = "PG Board", OwnerKey = "owner", CreatedAt = DateTime.UtcNow };
    pstore.Boards[PGB2] = new Board { Id = PGB2, Name = "PG Board 2", OwnerKey = "owner", CreatedAt = DateTime.UtcNow };
    pstore.Boards[PGBX] = new Board { Id = PGBX, Name = "PG Foreign", OwnerKey = "external-owner", CreatedAt = DateTime.UtcNow };
    pstore.Boards[PGBO] = new Board { Id = PGBO, Name = "PG Ownerless", OwnerKey = "", CreatedAt = DateTime.UtcNow };
    pstore.Boards[PGB3] = new Board { Id = PGB3, Name = "PG Board 3", OwnerKey = "owner", CreatedAt = DateTime.UtcNow };
    pstore.Advisors[PGENE] = new BoardAdvisor { Id = PGENE, BoardId = PGB3, RosterEntryId = Guid.Empty, BoardRole = "PG NoLink Scoped3", CreatedAt = DateTime.UtcNow };
    pstore.Roster[PGE] = new RosterEntry { Id = PGE, AccountId = Guid.NewGuid(), OwnerKey = "owner", Name = "PG Advisor", Description = "pg selftest entry", ProfileJson = "{pg:selftest-profile-for-behavior}", Version = 3, UpdatedAt = DateTime.UtcNow };
    pstore.Images[Guid.NewGuid()] = new AdvisorImage { RosterEntryId = PGE, Kind = "upload", Review = "accepted", Provenance = "selftest", ContentType = "image/png", Data = new byte[] { 7 } };
    pstore.Advisors[PGSTALE] = new BoardAdvisor { Id = PGSTALE, BoardId = PGB, RosterEntryId = PGE, RosterVersion = 1, BoardRole = "PG Stale", CreatedAt = DateTime.UtcNow };
    pstore.Roster[PGD] = new RosterEntry { Id = PGD, AccountId = Guid.NewGuid(), OwnerKey = "owner", Name = "PG Dup", Description = "pg dup entry", ProfileJson = "{pg:dup-profile}", Version = 1, UpdatedAt = DateTime.UtcNow };
    pstore.Advisors[PGDUPOLD] = new BoardAdvisor { Id = PGDUPOLD, BoardId = PGB, RosterEntryId = PGD, RosterVersion = 1, BoardRole = "PG Dup", CreatedAt = DateTime.UtcNow.AddMinutes(-5) };
    pstore.Advisors[PGDUPNEW] = new BoardAdvisor { Id = PGDUPNEW, BoardId = PGB, RosterEntryId = PGD, RosterVersion = 1, BoardRole = "PG Dup", CreatedAt = DateTime.UtcNow };
    pstore.Meetings[PGMTG] = new Meeting { Id = PGMTG, BoardId = PGB };
    pstore.Messages[PGMTG] = MessageList.Detached(PGMTG, new List<Message> { new Message { BoardId = PGB, MeetingId = PGMTG, Sequence = 1, AdvisorId = PGDUPNEW, Sender = "advisor", AdvisorName = "PG Dup", Content = "pg legacy reply", Status = "committed", CreatedAt = DateTime.UtcNow } });
    pstore.Advisors[PGMA] = new BoardAdvisor { Id = PGMA, BoardId = PGB, RosterEntryId = PGMISS, RosterVersion = 1, BoardRole = "PG Sage", CreatedAt = DateTime.UtcNow };
    pstore.Advisors[PGMB] = new BoardAdvisor { Id = PGMB, BoardId = PGB2, RosterEntryId = PGMISS, RosterVersion = 1, BoardRole = "PG Sage", CreatedAt = DateTime.UtcNow };
    pstore.Images[PGMIMG] = new AdvisorImage { Id = PGMIMG, RosterEntryId = null, BoardAdvisorId = PGMB, Kind = "upload", Review = "pending", Provenance = "legacy:board-local", ContentType = "image/png", Data = new byte[] { 9 } };
    pstore.Advisors[PGEA] = new BoardAdvisor { Id = PGEA, BoardId = PGB, RosterEntryId = Guid.Empty, BoardRole = "PG NoLink A", CreatedAt = DateTime.UtcNow };
    pstore.Advisors[PGEB] = new BoardAdvisor { Id = PGEB, BoardId = PGB, RosterEntryId = Guid.Empty, BoardRole = "PG NoLink B", CreatedAt = DateTime.UtcNow };
    pstore.Advisors[PGEC] = new BoardAdvisor { Id = PGEC, BoardId = PGBO, RosterEntryId = Guid.Empty, BoardRole = "PG NoLink Ownerless", CreatedAt = DateTime.UtcNow };
    var PGED = Guid.Parse("cccc3333-4444-5555-6666-777777777777");
    pstore.Advisors[PGED] = new BoardAdvisor { Id = PGED, BoardId = PGB2, RosterEntryId = Guid.Empty, BoardRole = "PG NoLink Scoped", CreatedAt = DateTime.UtcNow };
    pstore.Advisors[PGFF] = new BoardAdvisor { Id = PGFF, BoardId = PGBX, RosterEntryId = PGF, RosterVersion = 1, BoardRole = "PG Foreign", CreatedAt = DateTime.UtcNow };
    pstore.Advisors[PGFF2] = new BoardAdvisor { Id = PGFF2, BoardId = PGB, RosterEntryId = PGF, RosterVersion = 1, BoardRole = "PG Foreign", CreatedAt = DateTime.UtcNow };
    pstore.Roster[PGARCH] = new RosterEntry { Id = PGARCH, AccountId = Guid.NewGuid(), OwnerKey = "owner", Name = "PG Arch", Description = "pg archived", ProfileJson = "{pg:archived}", Version = 1, Archived = true, UpdatedAt = DateTime.UtcNow };
    pstore.Advisors[PGARCHL] = new BoardAdvisor { Id = PGARCHL, BoardId = PGB, RosterEntryId = PGARCH, RosterVersion = 1, BoardRole = "PG Arch", CreatedAt = DateTime.UtcNow };
    try
    {
      var plan = RosterReconciliation.Plan(pstore, "pg-seed-key", null);
      var mine = plan.Orphans.Where(o => o.BoardId == PGB || o.BoardId == PGB2 || o.BoardId == PGBX || o.BoardId == PGBO).ToList();
      if (mine.Count(o => o.Reason == "stale-version") != 1) pgFailures.Add("pg-scan-stale");
      if (mine.Count(o => o.Reason == "duplicate-link") != 1) pgFailures.Add("pg-scan-dup");
      if (mine.Count(o => o.Reason == "missing-roster") != 4) pgFailures.Add("pg-scan-missing");
      if (mine.Count(o => o.Reason == "empty-link") != 4) pgFailures.Add("pg-scan-empty");
      var scopePlan = RosterReconciliation.Plan(pstore, "pg-seed-scope", PGB2);
      if (scopePlan.Orphans.Count(o => o.Reason == "empty-link") != 1) pgFailures.Add("pg-scope-scan");
      var scopeRefused = RosterReconcileApply.Apply(pstore, scopePlan.PlanHash, "pg-seed-scope", PGB2, out var scopeRefErr, out var scopeRefCode);
      if (scopeRefused.Ok || scopeRefCode != 409 || !(scopeRefErr ?? "").Contains("global")) pgFailures.Add("pg-scope-refuses-shared:" + scopeRefErr);
      if (pstore.Roster.ContainsKey(PGMISS)) pgFailures.Add("pg-scope-no-partial-entry");
      if (!pstore.Advisors.TryGetValue(PGMB, out var pgmbUntouched) || pgmbUntouched.Removed || pgmbUntouched.RosterEntryId != PGMISS || pgmbUntouched.RosterVersion != 1) pgFailures.Add("pg-scope-outofscope-approval");
      if (!pstore.Images.TryGetValue(PGMIMG, out var pgmimgUntouched) || pgmimgUntouched.RosterEntryId.HasValue) pgFailures.Add("pg-scope-outofscope-image");
      if (!pstore.Advisors.TryGetValue(PGED, out var pgedUntouched) || pgedUntouched.RosterEntryId != Guid.Empty) pgFailures.Add("pg-scope-nothing-applied");
      var scopePlanAfter = RosterReconciliation.Plan(pstore, "pg-seed-scope", PGB2);
      if (!scopePlanAfter.Orphans.Any(o => o.Reason == "missing-roster" && o.RosterEntryId == PGMISS)) pgFailures.Add("pg-scope-still-reports-shared");
      var scopePlanGlobal = RosterReconciliation.Plan(pstore, "pg-seed-scope", null);
      if (!scopePlanGlobal.Orphans.Any(o => o.Reason == "missing-roster" && o.RosterEntryId == PGMISS)) pgFailures.Add("pg-scope-global-still-reports-shared");
      if (!scopePlan.Actions.Any(a => a.Kind == "RequiresGlobalScope" && a.RosterEntryId == PGMISS)) pgFailures.Add("pg-scope-plan-marks-global");
      var pgEmpty3 = RosterLegacyAccess.StableEmptyLinkId(PGB3, PGENE);
      var scopePlan3 = RosterReconciliation.Plan(pstore, "pg-seed-scope3", PGB3);
      if (scopePlan3.Orphans.Count(o => o.Reason == "empty-link") != 1) pgFailures.Add("pg-scope3-scan");
      var scopeApplied3 = RosterReconcileApply.Apply(pstore, scopePlan3.PlanHash, "pg-seed-scope3", PGB3, out var scopeErr3, out _);
      if (!scopeApplied3.Ok) pgFailures.Add("pg-scope3-apply:" + scopeErr3);
      if (!scopeApplied3.Applied.Any(s => s.StartsWith("recover-empty:"))) pgFailures.Add("pg-scope3-no-recover-empty");
      if (!pstore.Roster.TryGetValue(pgEmpty3, out var pge3) || pge3 is null || pge3.Name != "PG NoLink Scoped3") pgFailures.Add("pg-scope3-entry");
      if (!pstore.Advisors.TryGetValue(PGENE, out var pge3Adv) || pge3Adv.Removed || pge3Adv.RosterEntryId != pgEmpty3) pgFailures.Add("pg-scope3-relink");
      if (!pstore.Advisors.TryGetValue(PGEA, out var pgeaUntouched) || pgeaUntouched.RosterEntryId != Guid.Empty) pgFailures.Add("pg-scope-untouched");
      pstore.Advisors[PGEX] = new BoardAdvisor { Id = PGEX, BoardId = PGB, RosterEntryId = Guid.Empty, BoardRole = "PG NoLink Target", CreatedAt = DateTime.UtcNow };
      var pgext = RosterLegacyAccess.StableEmptyLinkId(PGB, PGEX);
      pstore.Roster[pgext] = new RosterEntry { Id = pgext, AccountId = Guid.NewGuid(), OwnerKey = "owner", Name = "PG NoLink Target", Description = "pg pre-existing deterministic target", ProfileJson = "{pg:target-profile-ok}", Version = 2, UpdatedAt = DateTime.UtcNow };
      pstore.Boards[PGBU] = new Board { Id = PGBU, Name = "PG Unknown Board", OwnerKey = "", CreatedAt = DateTime.UtcNow };
      pstore.Advisors[PGBUD0] = new BoardAdvisor { Id = PGBUD0, BoardId = Guid.NewGuid(), RosterEntryId = PGUMISS, RosterVersion = 1, BoardRole = "PG Gone", Removed = true, CreatedAt = DateTime.UtcNow };
      pstore.Advisors[PGBUD1] = new BoardAdvisor { Id = PGBUD1, BoardId = PGBU, RosterEntryId = PGUMISS, RosterVersion = 1, BoardRole = "PG Unknown", CreatedAt = DateTime.UtcNow.AddMinutes(-2) };
      pstore.Advisors[PGBUD2] = new BoardAdvisor { Id = PGBUD2, BoardId = PGBU, RosterEntryId = PGUMISS, RosterVersion = 1, BoardRole = "PG Unknown", CreatedAt = DateTime.UtcNow };
      pstore.Meetings[PGBUMM] = new Meeting { Id = PGBUMM, BoardId = PGBU };
      pstore.Messages[PGBUMM] = MessageList.Detached(PGBUMM, new List<Message> { new Message { BoardId = PGBU, MeetingId = PGBUMM, Sequence = 1, AdvisorId = PGBUD2, Sender = "advisor", AdvisorName = "PG Unknown", Content = "pg unknown reply", Status = "committed", CreatedAt = DateTime.UtcNow } });
      string PgDupHash() => RosterReconciliation.Plan(pstore, "pg-perturb-dup", null).PlanHash;
      var pgh0 = PgDupHash();
      pstore.Roster.TryGetValue(PGD, out var pgdEntry);
      var pgdOwner = pgdEntry is null ? "" : pgdEntry.OwnerKey;
      if (pgdEntry is not null) { pgdEntry.OwnerKey = "external-owner"; pstore.Roster[pgdEntry.Id] = pgdEntry; }
      if (PgDupHash() == pgh0) pgFailures.Add("pg-dup-owner-static");
      var pghPlan = RosterReconciliation.Plan(pstore, "pg-perturb-dup", null);
      if (pghPlan.Actions.Any(a => a.Kind == "RemoveDuplicateLink" && a.RosterEntryId == PGD)) pgFailures.Add("pg-dup-owner-still-removes");
      if (!pghPlan.Actions.Any(a => a.Kind == "FlagForOwnerReview" && a.AdvisorId == PGDUPNEW)) pgFailures.Add("pg-dup-owner-no-flag");
      var pghStale = RosterReconcileApply.Apply(pstore, pgh0, "pg-perturb-dup", null, out _, out var pghCode);
      if (pghStale.Ok || pghCode != 409) pgFailures.Add("pg-dup-owner-accepted");
      if (pgdEntry is not null) { pgdEntry.OwnerKey = pgdOwner; pstore.Roster[pgdEntry.Id] = pgdEntry; }
      if (PgDupHash() != pgh0) pgFailures.Add("pg-dup-owner-restore-drift");
      var pgMsg0 = pstore.Messages[PGMTG].First(m => m.AdvisorId == PGDUPNEW);
      var pgSeq = pgMsg0.Sequence;
      System.Func<long, List<Message>> pgMsgRows = (seq) => new List<Message> { new Message { BoardId = PGB, MeetingId = PGMTG, Sequence = seq, AdvisorId = PGDUPNEW, Sender = pgMsg0.Sender, AdvisorName = pgMsg0.AdvisorName, Content = pgMsg0.Content, ParentSequence = pgMsg0.ParentSequence, Stance = pgMsg0.Stance, Status = pgMsg0.Status, CreatedAt = pgMsg0.CreatedAt } };
      pstore.Messages[PGMTG] = MessageList.Detached(PGMTG, pgMsgRows(pgSeq + 1));
      if (PgDupHash() == pgh0) pgFailures.Add("pg-dup-row-static");
      var pgMsgStale = RosterReconcileApply.Apply(pstore, pgh0, "pg-perturb-dup", null, out _, out var pgMsgCode);
      if (pgMsgStale.Ok || pgMsgCode != 409) pgFailures.Add("pg-dup-row-accepted");
      pstore.Messages[PGMTG] = MessageList.Detached(PGMTG, pgMsgRows(pgSeq));
      if (PgDupHash() != pgh0) pgFailures.Add("pg-dup-row-restore-drift");
      var pgMtg0 = pstore.Meetings[PGMTG];
      System.Func<string, Meeting> pgMtgRows = (parts) => new Meeting { Id = PGMTG, BoardId = pgMtg0.BoardId, Title = pgMtg0.Title, State = pgMtg0.State, Brief = pgMtg0.Brief, ParticipantIdsJson = parts, DeliveredRevision = pgMtg0.DeliveredRevision, Generation = pgMtg0.Generation, CreatedAt = pgMtg0.CreatedAt };
      pstore.Meetings[PGMTG] = pgMtgRows(System.Text.Json.JsonSerializer.Serialize(new[] { PGDUPNEW }));
      var pgh0p = PgDupHash();
      if (pgh0p == pgh0) pgFailures.Add("pg-dup-parts-baseline-static");
      pstore.Meetings[PGMTG] = pgMtgRows(System.Text.Json.JsonSerializer.Serialize(new[] { PGDUPOLD }));
      if (PgDupHash() == pgh0p) pgFailures.Add("pg-dup-parts-swap-static");
      var pgPartsStale = RosterReconcileApply.Apply(pstore, pgh0p, "pg-perturb-dup", null, out _, out var pgPartsCode);
      if (pgPartsStale.Ok || pgPartsCode != 409) pgFailures.Add("pg-dup-parts-accepted");
      pstore.Meetings[PGMTG] = pgMtgRows(System.Text.Json.JsonSerializer.Serialize(new[] { PGDUPNEW }));
      if (PgDupHash() != pgh0p) pgFailures.Add("pg-dup-parts-restore-drift");
      var pgh0d = PgDupHash();
      if (pgdEntry is not null) { pgdEntry.Description = "D;name=Alice"; pgdEntry.Name = "Bob"; pstore.Roster[pgdEntry.Id] = pgdEntry; }
      var pgDelim1 = PgDupHash();
      if (pgDelim1 == pgh0d) pgFailures.Add("pg-dup-delim-static");
      if (pgdEntry is not null) { pgdEntry.Description = "D"; pgdEntry.Name = "Alice;name=Bob"; pstore.Roster[pgdEntry.Id] = pgdEntry; }
      if (PgDupHash() == pgDelim1) pgFailures.Add("pg-dup-delim-collision");
      var pgDelimStale = RosterReconcileApply.Apply(pstore, pgDelim1, "pg-perturb-dup", null, out _, out var pgDelimCode);
      if (pgDelimStale.Ok || pgDelimCode != 409) pgFailures.Add("pg-dup-delim-accepted");
      if (pgdEntry is not null) { pgdEntry.Description = "pg dup entry"; pgdEntry.Name = "PG Dup"; pstore.Roster[pgdEntry.Id] = pgdEntry; }
      if (PgDupHash() != pgh0d) pgFailures.Add("pg-dup-delim-restore-drift");
      string PgTargetHash() => RosterReconciliation.Plan(pstore, "pg-perturb-target", null).PlanHash;
      var pgt0 = PgTargetHash();
      var pgtPlan = RosterReconciliation.Plan(pstore, "pg-perturb-target", null);
      if (!pgtPlan.Actions.Any(a => a.Kind == "RecoverEmptyLink" && a.AdvisorId == PGEX && (a.Summary ?? "").Contains("EXISTING"))) pgFailures.Add("pg-target-no-relink-desc");
      pstore.Roster.TryGetValue(pgext, out var pgtEntry);
      var pgtOwner = pgtEntry is null ? "" : pgtEntry.OwnerKey;
      if (pgtEntry is not null) { pgtEntry.OwnerKey = "foreign-owner"; pstore.Roster[pgtEntry.Id] = pgtEntry; }
      if (PgTargetHash() == pgt0) pgFailures.Add("pg-target-owner-static");
      var pgtPlanF = RosterReconciliation.Plan(pstore, "pg-perturb-target", null);
      if (pgtPlanF.Actions.Any(a => a.Kind == "RecoverEmptyLink" && a.AdvisorId == PGEX)) pgFailures.Add("pg-target-foreign-still-recovers");
      if (!pgtPlanF.Actions.Any(a => a.Kind == "FlagForOwnerReview" && a.AdvisorId == PGEX)) pgFailures.Add("pg-target-foreign-no-flag");
      var pgtOldApply = RosterReconcileApply.Apply(pstore, pgt0, "pg-perturb-target", null, out _, out var pgtOldCode);
      if (pgtOldApply.Ok || pgtOldCode != 409) pgFailures.Add("pg-target-old-accepted");
      if (pgtEntry is not null) { pgtEntry.OwnerKey = pgtOwner; pstore.Roster[pgtEntry.Id] = pgtEntry; }
      if (PgTargetHash() != pgt0) pgFailures.Add("pg-target-restore-drift");
      if (pgtEntry is not null) { pgtEntry.Archived = true; pstore.Roster[pgtEntry.Id] = pgtEntry; }
      if (PgTargetHash() == pgt0) pgFailures.Add("pg-target-archive-static");
      var pgtPlanA = RosterReconciliation.Plan(pstore, "pg-perturb-target", null);
      if (!pgtPlanA.Actions.Any(a => a.Kind == "FlagForOwnerReview" && a.AdvisorId == PGEX)) pgFailures.Add("pg-target-archive-no-flag");
      if (pgtEntry is not null) { pgtEntry.Archived = false; pstore.Roster[pgtEntry.Id] = pgtEntry; }
      if (PgTargetHash() != pgt0) pgFailures.Add("pg-target-archive-drift");
      var pgtVer = pgtEntry is null ? 0 : pgtEntry.Version;
      if (pgtEntry is not null) { pgtEntry.Version = pgtVer + 1; pstore.Roster[pgtEntry.Id] = pgtEntry; }
      if (PgTargetHash() == pgt0) pgFailures.Add("pg-target-version-static");
      var pgtVerApply = RosterReconcileApply.Apply(pstore, pgt0, "pg-perturb-target", null, out _, out var pgtVerCode);
      if (pgtVerApply.Ok || pgtVerCode != 409) pgFailures.Add("pg-target-version-accepted");
      if (pgtEntry is not null) { pgtEntry.Version = pgtVer; pstore.Roster[pgtEntry.Id] = pgtEntry; }
      if (PgTargetHash() != pgt0) pgFailures.Add("pg-target-version-drift");
      if (pgtEntry is not null) { pgtEntry.OwnerKey = pgtOwner; pstore.Roster[pgtEntry.Id] = pgtEntry; }
      if (PgTargetHash() != pgt0) pgFailures.Add("pg-target-foreign-drift");
      var pgUScope = RosterReconciliation.Plan(pstore, "pg-perturb-unknown", PGBU);
      if (pgUScope.Actions.Any(a => a.Kind == "RemoveDuplicateLink")) pgFailures.Add("pg-unknown-plans-removal");
      if (!pgUScope.Actions.Any(a => a.Kind == "FlagForOwnerReview" && a.AdvisorId == PGBUD2)) pgFailures.Add("pg-unknown-no-flag");
      var pgUApplied = RosterReconcileApply.Apply(pstore, pgUScope.PlanHash, "pg-perturb-unknown", PGBU, out var pgUErr, out _);
      if (!pgUApplied.Ok) pgFailures.Add("pg-unknown-apply:" + pgUErr);
      if (pgUApplied.Applied.Any(s => s.StartsWith("dedupe:") || s.StartsWith("recover:"))) pgFailures.Add("pg-unknown-mutated");
      if (!pstore.Advisors.TryGetValue(PGBUD2, out var pgUD2) || pgUD2.Removed) pgFailures.Add("pg-unknown-removed");
      if (!pstore.Messages.TryGetValue(PGBUMM, out var pgUM) || !pgUM.Any(m => m.AdvisorId == PGBUD2 && m.Content == "pg unknown reply")) pgFailures.Add("pg-unknown-history-moved");
      plan = RosterReconciliation.Plan(pstore, "pg-seed-key", null);
      if (mine.Count(o => o.Reason == "archived-roster") != 1) pgFailures.Add("pg-scan-archived");
      var applied = RosterReconcileApply.Apply(pstore, plan.PlanHash, "pg-seed-key", null, out var applyErr, out _);
      if (!applied.Ok) pgFailures.Add("pg-apply:" + applyErr);
      if (!applied.Applied.Any(s => s.StartsWith("recover-empty:"))) pgFailures.Add("pg-apply-no-recover-empty");
      if (!pstore.Roster.TryGetValue(PGMISS, out var rec) || rec is null || rec.Name != "PG Sage" || !(rec.Tags ?? "").Contains("recovered")) pgFailures.Add("pg-recover-entry");
      if (!pstore.Advisors.TryGetValue(PGMA, out var ma) || ma.Removed || ma.RosterVersion != 1 || ma.Approved) pgFailures.Add("pg-membership-A");
      if (!pstore.Advisors.TryGetValue(PGMB, out var mb) || mb.Removed || mb.RosterVersion != 1) pgFailures.Add("pg-membership-B");
      if (!pstore.Images.TryGetValue(PGMIMG, out var mim) || mim.RosterEntryId != PGMISS) pgFailures.Add("pg-image-relink");
      if (ma is not null && SimCEO.Api.RosterOps.ApprovalGate(pstore, ma) != "recovered-incomplete") pgFailures.Add("pg-gate-recovered-blocked");
      var (pgRecComplete, pgRecMissing) = SimCEO.Api.RosterOps.Completeness(pstore, PGMISS);
      if (pgRecComplete) pgFailures.Add("pg-recovered-not-complete");
      if (!pgRecMissing.Any(m => m.Contains("recovered placeholder"))) pgFailures.Add("pg-recovered-missing-actionable");
      rec.Tags = "";
      pstore.Roster[rec.Id] = rec;
      if (ma is not null && SimCEO.Api.RosterOps.ApprovalGate(pstore, ma) == "recovered-incomplete") pgFailures.Add("pg-gate-tag-clear-unblocks");
      var (pgRecFixed, _) = SimCEO.Api.RosterOps.Completeness(pstore, PGMISS);
      if (!pgRecFixed) pgFailures.Add("pg-recovered-tagstrip-complete");
      rec.Tags = "recovered";
      pstore.Roster[rec.Id] = rec;
      var pgEmptyA = RosterLegacyAccess.StableEmptyLinkId(PGB, PGEA);
      var pgEmptyB = RosterLegacyAccess.StableEmptyLinkId(PGB, PGEB);
      if (!applied.Applied.Any(s => s.StartsWith("recover-empty:"))) pgFailures.Add("pg-apply-no-recover-empty");
      if (pgEmptyA == pgEmptyB) pgFailures.Add("pg-empty-distinct");
      if (!pstore.Roster.TryGetValue(pgEmptyA, out var pgea) || pgea is null || pgea.Name != "PG NoLink A") pgFailures.Add("pg-empty-recover-A");
      if (!pstore.Roster.TryGetValue(pgEmptyB, out var pgeb) || pgeb is null || pgeb.Name != "PG NoLink B") pgFailures.Add("pg-empty-recover-B");
      if (!pstore.Advisors.TryGetValue(PGEA, out var pea) || pea.Removed || pea.RosterEntryId != pgEmptyA || pea.Approved) pgFailures.Add("pg-empty-relink-A");
      if (!pstore.Advisors.TryGetValue(PGEB, out var peb) || peb.Removed || peb.RosterEntryId != pgEmptyB) pgFailures.Add("pg-empty-relink-B");
      if (!pstore.Advisors.TryGetValue(PGEC, out var pec) || pec.Removed || pec.RosterEntryId != Guid.Empty) pgFailures.Add("pg-empty-ownerless-preserved");
      if (!applied.Flagged.Any(s => s.StartsWith("empty-link:") && s.Contains(PGEC.ToString("N")))) pgFailures.Add("pg-empty-ownerless-flagged");
      if (pstore.Roster.ContainsKey(PGF)) pgFailures.Add("pg-foreign-no-entry");
      if (!pstore.Messages.TryGetValue(PGMTG, out var ml) || !ml.Any(m => m.AdvisorId == PGDUPOLD)) pgFailures.Add("pg-history-repoint");
      var pgMutPlan = RosterReconciliation.Plan(pstore, "pg-mut-key", null);
      pstore.Roster.TryGetValue(PGE, out var pgMutEntry);
      var pgMutDesc = pgMutEntry is null ? "" : pgMutEntry.Description;
      var pgMutVer = pgMutEntry is null ? 0 : pgMutEntry.Version;
      if (pgMutEntry is not null) { pgMutEntry.Description = "PG mutation-after-plan bump with sufficient length."; pgMutEntry.Version += 1; pstore.Roster[pgMutEntry.Id] = pgMutEntry; }
      var pgMutApply = RosterReconcileApply.Apply(pstore, pgMutPlan.PlanHash, "pg-mut-key", null, out _, out var pgMutCode);
      if (pgMutApply.Ok || pgMutCode != 409) pgFailures.Add("pg-mutated-plan-accepted");
      if (pgMutEntry is not null) { pgMutEntry.Description = pgMutDesc; pgMutEntry.Version = pgMutVer; pstore.Roster[pgMutEntry.Id] = pgMutEntry; }
      var pgReApply = RosterReconcileApply.Apply(pstore, plan.PlanHash, "pg-seed-key", null, out var pgReErr, out _);
      if (!pgReApply.Ok) pgFailures.Add("pg-reapply-idempotent:" + pgReErr);
      var pgEx2 = new BoardAdvisor { Id = Guid.NewGuid(), BoardId = PGB, RosterEntryId = Guid.Empty, BoardRole = "PG NoLink Foreign", CreatedAt = DateTime.UtcNow };
      pstore.Advisors[pgEx2.Id] = pgEx2;
      var pgExt2 = RosterLegacyAccess.StableEmptyLinkId(PGB, pgEx2.Id);
      pstore.Roster[pgExt2] = new RosterEntry { Id = pgExt2, AccountId = Guid.NewGuid(), OwnerKey = "foreign-owner", Name = "PG Foreign Target", Description = "pg foreign deterministic target", ProfileJson = "{pg:foreign-target-ok}", Version = 1, UpdatedAt = DateTime.UtcNow };
      var pgPlanF2 = RosterReconciliation.Plan(pstore, "pg-perturb-target2", null);
      if (pgPlanF2.Actions.Any(a => a.Kind == "RecoverEmptyLink" && a.AdvisorId == pgEx2.Id)) pgFailures.Add("pg-target2-still-recovers");
      if (!pgPlanF2.Actions.Any(a => a.Kind == "FlagForOwnerReview" && a.AdvisorId == pgEx2.Id)) pgFailures.Add("pg-target2-no-flag");
      var pgApplyF2 = RosterReconcileApply.Apply(pstore, pgPlanF2.PlanHash, "pg-perturb-target2", null, out var pgErrF2, out _);
      if (!pgApplyF2.Ok) pgFailures.Add("pg-target2-apply:" + pgErrF2);
      if (pgApplyF2.Applied.Any(s => s.Contains(pgEx2.Id.ToString("N")[..8]))) pgFailures.Add("pg-target2-attached");
      if (!pstore.Advisors.TryGetValue(pgEx2.Id, out var pgEx2After) || pgEx2After.RosterEntryId != Guid.Empty) pgFailures.Add("pg-target2-linked");
      pstore.Advisors.TryRemove(pgEx2.Id, out _);
      pstore.Roster.TryRemove(pgExt2, out _);
      if (pgFailures.Count == 0) Console.WriteLine("PGSEED OK planHash=" + plan.PlanHash);
    }
    catch (Exception ex) { pgFailures.Add("pg-seed-ex:" + ex.GetBaseException().Message); }
  }
  else if (pgPhase == "verify")
  {
    try
    {
      if (!pstore.Roster.TryGetValue(PGMISS, out var rec) || rec is null || rec.Name != "PG Sage") pgFailures.Add("pg-persist-entry");
      if (!pstore.Advisors.TryGetValue(PGMA, out var ma) || ma.Removed || ma.RosterVersion != 1 || ma.BoardRole != "PG Sage") pgFailures.Add("pg-persist-link-A");
      if (!pstore.Advisors.TryGetValue(PGMB, out var mb) || mb.Removed) pgFailures.Add("pg-persist-link-B");
      if (!pstore.Messages.TryGetValue(PGMTG, out var ml) || !ml.Any(m => m.AdvisorId == PGDUPOLD && m.Content == "pg legacy reply")) pgFailures.Add("pg-persist-history");
      if (!pstore.Images.TryGetValue(PGMIMG, out var mim) || mim.RosterEntryId != PGMISS) pgFailures.Add("pg-persist-image");
      if (pstore.Roster.ContainsKey(PGF)) pgFailures.Add("pg-persist-foreign");
      if (!pstore.Jobs.Values.Any(j => j.Kind == "roster-reconcile" && (j.IdempotencyKey ?? "").StartsWith("reconcile:pg-seed-key:", StringComparison.Ordinal))) pgFailures.Add("pg-persist-marker");
      var plan = RosterReconciliation.Plan(pstore, "pg-seed-key", null);
      var mine = plan.Orphans.Where(o => o.BoardId == PGB || o.BoardId == PGB2 || o.BoardId == PGBX || o.BoardId == PGBO).ToList();
      if (mine.Any(o => o.Reason == "stale-version" || o.Reason == "duplicate-link")) pgFailures.Add("pg-verify-dirty");
      var pgEmptyA = RosterLegacyAccess.StableEmptyLinkId(PGB, PGEA);
      if (!pstore.Roster.TryGetValue(pgEmptyA, out var pgvEA) || pgvEA is null || pgvEA.Name != "PG NoLink A") pgFailures.Add("pg-persist-empty-A");
      if (!pstore.Advisors.TryGetValue(PGEA, out var pgvLA) || pgvLA.RosterEntryId != pgEmptyA) pgFailures.Add("pg-persist-emptylink-A");
      var pgvEXT = RosterLegacyAccess.StableEmptyLinkId(PGB, PGEX);
      if (!pstore.Advisors.TryGetValue(PGEX, out var pgvEX) || pgvEX.Removed || pgvEX.RosterEntryId != pgvEXT) pgFailures.Add("pg-persist-emptylink-target");
      if (!pstore.Roster.TryGetValue(pgvEXT, out var pgvER) || pgvER is null || pgvER.Archived) pgFailures.Add("pg-persist-target-entry");
      if (!pstore.Advisors.TryGetValue(PGBUD2, out var pgvUD) || pgvUD.Removed) pgFailures.Add("pg-persist-unknown-dup");
      if (!pstore.Messages.TryGetValue(PGBUMM, out var pgvUM) || !pgvUM.Any(m => m.AdvisorId == PGBUD2 && m.Content == "pg unknown reply")) pgFailures.Add("pg-persist-unknown-history");
      var emptyMine = mine.Where(o => o.Reason == "empty-link").ToList();
      if (emptyMine.Count != 1 || emptyMine[0].AdvisorId != PGEC) pgFailures.Add("pg-verify-empty-left");
      if (mine.Any(o => o.Reason == "missing-roster" && o.RosterEntryId != PGF)) pgFailures.Add("pg-verify-missing-left");
      var replayed = RosterReconcileApply.Apply(pstore, pgPriorHash, "pg-seed-key", null, out var replayErr, out _);
      if (!replayed.Ok) pgFailures.Add("pg-replay:" + replayErr);
      if (pgFailures.Count == 0) Console.WriteLine("PGVERIFY OK");
    }
    catch (Exception ex) { pgFailures.Add("pg-verify-ex:" + ex.GetBaseException().Message); }
  }
  else pgFailures.Add("unknown pg phase");
  Console.WriteLine(pgFailures.Count == 0 ? "PGSELFTEST PASS" : "PGSELFTEST FAIL: " + string.Join(";", pgFailures));
  Environment.Exit(pgFailures.Count == 0 ? 0 : 1);
}

app.MapGet("/health", () => Results.Ok(new { ok = true, service = "simceo-api", time = DateTime.UtcNow, instance = Environment.GetEnvironmentVariable("SIMCEO_INSTANCE") ?? "dev" }));
app.MapGet("/ready", (InMemoryStore s) =>
{
  // Live backend probe: a cached startup string cannot report a mid-run DB
  // outage. In PG mode every readiness check issues one tiny SELECT; any
  // backend failure fails closed 503 while /health stays 200 (process alive).
  if (Pg.Backend is null)
    return string.IsNullOrEmpty(s.PgError)
      ? Results.Ok(new { ready = true, store = "inmemory" })
      : Results.Json(new { ready = false, store = "unavailable", error = s.PgError }, statusCode: 503);
  try { Pg.Backend.All<SecurityState>(); }
  catch (Exception ex)
  {
    return Results.Json(new { ready = false, store = "unavailable", error = "backend unreachable: " + ex.GetType().Name }, statusCode: 503);
  }
  try { PolicyStore.ReadSpend(s); }
  catch (Exception ex)
  {
    return Results.Json(new { ready = false, store = "unavailable", error = "policy store unreachable: " + ex.GetType().Name }, statusCode: 503);
  }
  return Results.Ok(new { ready = true, store = "postgres" });
});
app.MapGet("/api/backend", (InMemoryStore s) => Results.Ok(new
{
  mode = Pg.Backend is null ? "memory" : "postgres",
  error = s.PgError,
}));
// Redacted installation diagnostics: counts, epochs and availability only.
// No keys, tokens, session material, connection strings, provider content,
// private drafts, or roster internals are ever exposed here.
app.MapGet("/api/admin/diag", (InMemoryStore s, HttpRequest req) =>
{
  if (PeopleOps.BadToken(s, req) is { } badDiag) return badDiag;
  try
  {
    if (PeopleOps.IsSecure(s))
    {
      if (!AuthOps.TrySession(s, req, out var du)) return Results.Json(new { error = "Authentication required." }, statusCode: 401);
      var adm = PeopleOps.AdminEmail(s);
      if (string.IsNullOrWhiteSpace(adm) || !string.Equals(adm, du, StringComparison.OrdinalIgnoreCase)) return PeopleOps.Denied();
    }
    else if (!PeopleOps.IsOwner(req)) return PeopleOps.Denied();
  }
  catch (InvalidOperationException) { return Results.Json(new { error = "Security state unavailable." }, statusCode: 503); }
  bool backendOk = true;
  string backendNote = "memory";
  if (Pg.Backend is not null)
  {
    try { Pg.Backend.All<SecurityState>(); backendNote = "postgres"; }
    catch (Exception ex) { backendOk = false; backendNote = "unavailable:" + ex.GetType().Name; }
  }
  try
  {
    int dBoards, dMeetings, dDrafts, dSources, dNotes, dJobs, dJobsFailed, dSec, dWiki, dUsage, dCalls;
    string dSpendMode; bool dHasCap; string dApiKey, dChat; DateTime? dTestAt; bool dTestOk;
    lock (s.RootGate)
    {
      dBoards = s.Boards.Values.Count();
      dMeetings = s.Meetings.Values.Count();
      dDrafts = s.Drafts.Values.Count();
      dSources = s.Sources.Values.Count();
      dNotes = s.Notes.Values.Count();
      dJobs = s.Jobs.Values.Count();
      dJobsFailed = s.Jobs.Values.Count(j => j.State == "failed");
      dSec = s.SecretaryRequests.Values.Count();
      dWiki = s.WikiResources.Values.Count();
      dUsage = s.Usage.Count();
      dCalls = s.ModelCalls.Count();
      var dsp = PolicyStore.ReadSpend(s);
      dSpendMode = dsp.mode; dHasCap = dsp.cap.HasValue;
      dApiKey = PolicyStore.ReadApiKey(s); dChat = PolicyStore.ReadChatModel(s);
      dTestAt = s.ModelLastTestAt; dTestOk = s.ModelLastTestOk;
    }
    return Results.Ok(new
    {
      backendOk,
      backend = backendNote,
      restoreEpochRev = s.RestoreEpochRev,
      sourceEpoch = s.SourceEpoch,
      hasRestoreIdentity = s.RestoreEpochId != Guid.Empty,
      counts = new
      {
        boards = dBoards,
        meetings = dMeetings,
        drafts = dDrafts,
        sources = dSources,
        notes = dNotes,
        jobs = dJobs,
        jobsFailed = dJobsFailed,
        secretaryRequests = dSec,
        wikiResources = dWiki,
        usageRows = dUsage,
        modelCalls = dCalls,
      },
      spend = new { mode = dSpendMode, hasMonthlyCap = dHasCap },
      model = new { hasKeyOverride = !string.IsNullOrWhiteSpace(dApiKey), chatOverride = string.IsNullOrWhiteSpace(dChat) ? "default" : "custom", lastTestOk = dTestOk, lastTestAt = dTestAt },
      security = new { secure = PeopleOps.IsSecure(s), hasAdmin = !string.IsNullOrWhiteSpace(PeopleOps.AdminEmail(s)) },
    });
  }
  catch (Exception ex) { return Results.Json(new { error = "Diagnostics unavailable: " + ex.GetType().Name }, statusCode: 503); }
});
app.MapHub<BoardHub>("/hubs/board");

static (string mission, string stage, string policy) EffectiveGuestView(InMemoryStore s, SimCEO.Api.Domain.Board b)
{
  // Canonical activated effective view: blank activated fields stay blank and
  // never resurrect draft/live text (Auth R13). Single source of truth is
  // LeadSetup.EffectiveView; this helper only normalizes the policy default.
  var ev = LeadSetup.EffectiveView(s, b);
  return (ev.mission, ev.stage, string.IsNullOrWhiteSpace(ev.policy) ? "balanced" : ev.policy);
}

// Scoped board DTO for non-managing readers: effective mission/stage/policy
// only. DraftJson/ActiveJson/OwnerKey/lead internals stay manager-only.
static object ScopedBoardView(InMemoryStore s, SimCEO.Api.Domain.Board b)
{
  var (em, es, ep) = EffectiveGuestView(s, b);
  return new { id = b.Id, name = b.Name, mission = em, stage = es, discussionPolicy = ep, archived = b.Archived, createdAt = b.CreatedAt };
}

static List<object> BoardsFor(InMemoryStore s, HttpRequest req, bool includeArchived)
{
  var query = s.Boards.Values.AsEnumerable();
  if (!includeArchived) query = query.Where(b => !b.Archived);
  var all = query.OrderByDescending(b => b.CreatedAt).ToList();
  if (!PeopleOps.IsSecure(s)) return all.Take(100).Cast<object>().ToList();
  if (!AuthOps.TrySession(s, req, out var user)) return new List<object>();
  var admin = PeopleOps.AdminEmail(s);
  if (!string.IsNullOrWhiteSpace(admin) && string.Equals(admin, user, StringComparison.OrdinalIgnoreCase)) return all.Take(100).Cast<object>().ToList();
  var out_ = new List<object>();
  foreach (var b in all)
  {
    if (!string.IsNullOrWhiteSpace(b.OwnerKey) && string.Equals(b.OwnerKey, user, StringComparison.OrdinalIgnoreCase)) { out_.Add(b); continue; }
    if (PeopleOps.Can(s, req, b.Id, null, "manage")) { out_.Add(b); continue; }
    // Board-level grant visibility reuses fresh current authorization
    // (Can/read): a deleted or revoked grant — or any grant the current
    // revocation state no longer honors — never surfaces a private board.
    // Raw grant-row existence alone is not visibility.
    if (PeopleOps.Can(s, req, b.Id, null, "read")) { out_.Add(ScopedBoardView(s, b)); continue; }
    // Meeting-only guests: minimal scrubbed DTO only (no DraftJson/ActiveJson/OwnerKey/lead internals).
    var mids = PeopleOps.GuestMeetingIds(s, user, b.Id);
    if (mids.Count > 0) { var (lm, ls, lp) = EffectiveGuestView(s, b); out_.Add(new { id = b.Id, name = b.Name, mission = lm, stage = ls, discussionPolicy = lp, archived = b.Archived, guest = true, meetingIds = mids }); continue; }
  }
  return out_.Take(100).ToList();
}

app.MapGet("/api/boards", (InMemoryStore s, HttpRequest req, bool? includeArchived) => Results.Ok(BoardsFor(s, req, includeArchived == true)));

app.MapPost("/api/boards", (InMemoryStore s, HttpRequest req, Board input) =>
{
  if (PeopleOps.BadToken(s, req) is { } badBc) return badBc;
  // Secure installations require a session to create boards; the open demo
  // allows local creation. Ownership is recorded for later enforcement.
  if (PeopleOps.IsSecure(s) && !AuthOps.TrySession(s, req, out _))
    return Results.Json(new { error = "Authentication required." }, statusCode: 401);
  input.Id = Guid.NewGuid();
  IResult gateErrBc = null;
  Atomic.Run(s, () =>
  {
    if (PeopleOps.IsSecure(s) && !AuthOps.TrySession(s, req, out _)) { gateErrBc = Results.Json(new { error = "Authentication required." }, statusCode: 401); return; }
    var owner = AuthOps.TrySession(s, req, out var em) ? em : PeopleOps.UserOf(s, req);
    input.OwnerKey = owner;
  input.AccessEnforced = false;
  input.CreatedAt = DateTime.UtcNow;
  input.ActiveConfig = false;
  input.ActiveJson = "{}";
  input.LeadProfileVersion = 0;
    s.Boards[input.Id] = input;
    Atomic.Audit(s, new AuditEvent { BoardId = input.Id, Action = "board.create", Detail = JsonSerializer.Serialize(new { input.Name }) });
  });
  if (gateErrBc is not null) return gateErrBc;
  return Results.Created($"/api/boards/{input.Id}", input);
});

app.MapGet("/api/boards/{id:guid}", (InMemoryStore s, HttpRequest req, Guid id) =>
{
  if (!s.Boards.TryGetValue(id, out var b)) return Results.NotFound();
  if (PeopleOps.BadToken(s, req) is { } bad) return bad;
  if (PeopleOps.IsSecure(s) && !AuthOps.TrySession(s, req, out _))
    return Results.Json(new { error = "Authentication required." }, statusCode: 401);
  if (PeopleOps.Can(s, req, id, null, "manage")) return Results.Ok(b);
  if (PeopleOps.Can(s, req, id, null, "read")) return Results.Ok(ScopedBoardView(s, b));
  var user = PeopleOps.UserOf(s, req);
  var meetings = PeopleOps.GuestMeetingIds(s, user, id);
  if (meetings.Count > 0)
  {
    var (gm, gs, gp) = EffectiveGuestView(s, b);
    LeadProfile? lead = null;
    try { lead = LeadSetup.ResolveLeadForStrict(s, id); } catch { }
    return Results.Ok(new { id = b.Id, name = b.Name, mission = gm, stage = gs, guest = true, meetingIds = meetings, discussionPolicy = gp, lead = lead is null ? null : new { lead.Name, lead.RoleLabel } });
  }
  return PeopleOps.Denied();
});

app.MapGet("/api/roster", (InMemoryStore s, HttpRequest req, Guid accountId, string? q, string? type, string? tag, Guid? boardId) =>
{
  if (PeopleOps.BadToken(s, req) is { } badR) return badR;
  if (PeopleOps.IsSecure(s) && !AuthOps.TrySession(s, req, out _)) return Results.Json(new { error = "Authentication required." }, statusCode: 401);
  var me = PeopleOps.UserOf(s, req);
  var admin = PeopleOps.AdminEmail(s);
  var isAdmin = !string.IsNullOrWhiteSpace(admin) && string.Equals(admin, me, StringComparison.OrdinalIgnoreCase);
  IEnumerable<RosterEntry> list0 = s.Roster.Values.Where(r => !r.Archived);
  // Meeting-only guests see only their own templates here; their discussion needs are served
  // by the approved-participant board-advisors projection, not the template collection.
  if (PeopleOps.IsSecure(s) && !isAdmin)
    list0 = list0.Where(r => RosterLegacyAccess.OwnerMatches(s, r, me)
      || s.Advisors.Values.Any(a => a.RosterEntryId == r.Id && !a.Removed && PeopleOps.Can(s, req, a.BoardId, null, "read")));
  else if (!PeopleOps.IsSecure(s) && accountId != Guid.Empty)
    list0 = list0.Where(r => r.AccountId == accountId
      // Canonical visibility (demo mode): a random browser-local account filter must not
      // hide existing attached entries. Attached-to-a-readable-board and unambiguous
      // legacy-owner entries stay visible; unattached foreign entries stay hidden.
      || s.Advisors.Values.Any(a => a.RosterEntryId == r.Id && !a.Removed && PeopleOps.Can(s, req, a.BoardId, null, "read"))
      || RosterLegacyAccess.OwnerMatches(s, r, me));
  var list = list0;
  if (!string.IsNullOrWhiteSpace(q))
    list = list.Where(r => r.Name.Contains(q, StringComparison.OrdinalIgnoreCase)
      || r.ProfileJson.Contains(q, StringComparison.OrdinalIgnoreCase));
  if (!string.IsNullOrWhiteSpace(type) && Enum.TryParse<AdvisorType>(type, true, out var t))
    list = list.Where(r => r.Type == t);
  if (!string.IsNullOrWhiteSpace(tag))
    list = list.Where(r => r.Tags.Contains(tag, StringComparison.OrdinalIgnoreCase));
  if (boardId.HasValue)
    list = list.Where(r => s.Advisors.Values.Any(a => a.BoardId == boardId.Value && a.RosterEntryId == r.Id && !a.Removed));
  return Results.Ok(list.OrderByDescending(r => r.UpdatedAt).Take(200)
    .Select(r => { var (ok, missing) = RosterOps.Completeness(s, r.Id);
      var __readBoards = RosterOps.BoardsFor(s, r.Id);
      try { __readBoards = s.Advisors.Values.Where(a => a.RosterEntryId == r.Id && !a.Removed && PeopleOps.Can(s, req, a.BoardId, null, "read"))
        .Select(a => new { boardId = a.BoardId, board = s.Boards.TryGetValue(a.BoardId, out var __bb) ? __bb.Name : "?", role = a.BoardRole, approved = a.Approved }).ToList<object>(); } catch {}
      var __isFull = isAdmin || RosterLegacyAccess.OwnerMatches(s, r, me)
        || s.Advisors.Values.Any(a => a.RosterEntryId == r.Id && !a.Removed && PeopleOps.Can(s, req, a.BoardId, null, "read"));
      object __entry = __isFull ? r : new { r.Id, r.Name, r.Description, r.Version, r.UpdatedAt };
      var __imgs = __isFull ? s.Images.Values.Count(i => i.RosterEntryId == r.Id) : s.Images.Values.Count(i => i.RosterEntryId == r.Id && i.Review == "accepted");
      return new { entry = __entry, boards = __readBoards, imageCount = __imgs, complete = ok, missing }; }));
});

app.MapGet("/api/roster/count", (InMemoryStore s, HttpRequest req, Guid accountId) =>
{
  if (PeopleOps.BadToken(s, req) is { } badRc) return badRc;
  if (PeopleOps.IsSecure(s) && !AuthOps.TrySession(s, req, out _)) return Results.Json(new { error = "Authentication required." }, statusCode: 401);
  var me = PeopleOps.UserOf(s, req);
  var admin = PeopleOps.AdminEmail(s);
  var isAdmin = !string.IsNullOrWhiteSpace(admin) && string.Equals(admin, me, StringComparison.OrdinalIgnoreCase);
  var q = s.Roster.Values.Where(r => !r.Archived);
  if (PeopleOps.IsSecure(s) && !isAdmin) q = q.Where(r => RosterLegacyAccess.OwnerMatches(s, r, me)
    || s.Advisors.Values.Any(a => a.RosterEntryId == r.Id && !a.Removed && PeopleOps.Can(s, req, a.BoardId, null, "read")));
  else if (!PeopleOps.IsSecure(s) && accountId != Guid.Empty) q = q.Where(r => r.AccountId == accountId
    || s.Advisors.Values.Any(a => a.RosterEntryId == r.Id && !a.Removed && PeopleOps.Can(s, req, a.BoardId, null, "read"))
    || RosterLegacyAccess.OwnerMatches(s, r, me));
  return Results.Ok(new { total = q.Count() });
});

app.MapPost("/api/roster", (InMemoryStore s, HttpRequest req, RosterEntry input) =>
{
  if (PeopleOps.BadToken(s, req) is { } badRaw) return badRaw;
  if (PeopleOps.IsSecure(s) && !AuthOps.TrySession(s, req, out _)) return Results.Json(new { error = "Authentication required." }, statusCode: 401);
  input.Id = Guid.NewGuid();
  if (string.IsNullOrWhiteSpace(input.Name)) return Results.BadRequest("Name is required.");
  if (string.IsNullOrWhiteSpace(input.Description)) return Results.BadRequest("Description is required.");
  if (string.IsNullOrWhiteSpace(input.ProfileJson) || input.ProfileJson.Trim().Length < 20) return Results.BadRequest("Profile is required (describe background, strengths, and limits).");
  if (input.Name.Trim().Length > 120) return Results.BadRequest("Name must be 120 chars or fewer.");
  if (input.Description.Trim().Length > CharacterBehavior.MaxBackgroundChars) return Results.BadRequest("Description must be 4000 chars or fewer.");
  // Always enforce shared profile bounds, including legacy-shaped JSON without
  // behavior keys (the validator permits legacy objects while enforcing the
  // universal 20k JSON / 4k background limits). Plain-text legacy profiles
  // (non-JSON) remain accepted within the 20k bound to preserve compat, so
  // oversize can never be accepted here and rejected later at chat/audition.
  try
  {
    using var legacyDoc = JsonDocument.Parse(input.ProfileJson);
    if (legacyDoc.RootElement.ValueKind == JsonValueKind.Object)
    {
      var (lvok, lverr, _) = CharacterBehavior.ValidateSavedProfile(input.ProfileJson);
      if (!lvok) return Results.BadRequest(lverr);
    }
    else if (input.ProfileJson.Length > CharacterBehavior.MaxProfileJsonChars)
      return Results.BadRequest("Profile must be " + CharacterBehavior.MaxProfileJsonChars + " chars or fewer (got " + input.ProfileJson.Length + "). Shorten paragraphs instead of embedding documents.");
  }
  catch (JsonException)
  {
    if (input.ProfileJson.Length > CharacterBehavior.MaxProfileJsonChars)
      return Results.BadRequest("Profile must be " + CharacterBehavior.MaxProfileJsonChars + " chars or fewer (got " + input.ProfileJson.Length + "). Shorten paragraphs instead of embedding documents.");
  }
  IResult gateErrRoster = null;
  Atomic.Run(s, () =>
  {
    if (PeopleOps.IsSecure(s) && !AuthOps.TrySession(s, req, out _)) { gateErrRoster = Results.Json(new { error = "Authentication required." }, statusCode: 401); return; }
    input.OwnerKey = PeopleOps.UserOf(s, req);
    input.Version = 1;
    input.UpdatedAt = DateTime.UtcNow;
    input.ResearchRequested = false;
    input.ResearchedAt = null;
    input.EvidenceCount = 0;
    input.ResearchJson = "{}";
    s.Roster[input.Id] = input;
  });
  if (gateErrRoster is not null) return gateErrRoster;
  return Results.Created($"/api/roster/{input.Id}", input);
});
app.MapGet("/api/boards/{boardId:guid}/advisors", (InMemoryStore s, HttpRequest req, Guid boardId) =>
{
  if (PeopleOps.BadToken(s, req) is { } badA) return badA;
  if (PeopleOps.IsSecure(s) && !AuthOps.TrySession(s, req, out _)) return Results.Json(new { error = "Authentication required." }, statusCode: 401);
  if (!s.Boards.ContainsKey(boardId)) return Results.NotFound();
  if (PeopleOps.Can(s, req, boardId, null, "read"))
    // Canonical read projection: every attached advisor renders the CURRENT roster entry.
    // Roster edits (name/profile/research/version) are reflected here immediately; stale pins
    // surface explicitly so boards never render a forked copy. Additive fields only.
    return Results.Ok(s.Advisors.Values.Where(a => a.BoardId == boardId && !a.Removed).Select(a =>
    {
      var view = SimCEO.Api.Work.RosterIntegrity.ResolveCanonicalView(s, a);
      return new
      {
        a.Id, a.BoardId, a.RosterEntryId, a.RosterVersion, a.BoardRole, a.Approved, a.Removed, a.ImageProvenance, a.CreatedAt,
        rosterName = view is null ? (string?)null : view.Name,
        rosterVersionCurrent = view is null ? (int?)null : view.CurrentVersion,
        stale = view is null || view.Stale,
        unlinked = view is null,
        behaviorFingerprint = view is null ? ("missing:" + a.RosterEntryId) : view.BehaviorFingerprint,
      };
    }).ToList());
  var user = PeopleOps.UserOf(s, req);
  var meetings = PeopleOps.GuestMeetingIds(s, user, boardId);
  if (meetings.Count == 0) return PeopleOps.Denied();
  var parts = new HashSet<Guid>();
  foreach (var mid in meetings)
    if (s.Meetings.TryGetValue(mid, out var mm))
      try { using var d = System.Text.Json.JsonDocument.Parse(string.IsNullOrWhiteSpace(mm.ParticipantIdsJson) ? "[]" : mm.ParticipantIdsJson); foreach (var e in d.RootElement.EnumerateArray()) if (e.ValueKind == System.Text.Json.JsonValueKind.String && Guid.TryParse(e.GetString(), out var g)) parts.Add(g); } catch { }
  var list = s.Advisors.Values.Where(a => a.BoardId == boardId && !a.Removed && a.Approved);
  if (parts.Count > 0) list = list.Where(a => parts.Contains(a.Id));
  return Results.Ok(list.Select(a => new { id = a.Id, boardId = a.BoardId, boardRole = a.BoardRole, approved = a.Approved, rosterEntryId = a.RosterEntryId }).ToList());
});

app.MapPost("/api/boards/{boardId:guid}/advisors", (InMemoryStore s, HttpRequest req, Guid boardId, JsonElement body) =>
{
  if (PeopleOps.BadToken(s, req) is { } badAttach) return badAttach;
  if (!s.Boards.ContainsKey(boardId)) return Results.NotFound("Board not found.");
  if (PeopleOps.Check(s, req, boardId, null, "manage") is { } deniedA) return deniedA;
  var rosterId = body.TryGetProperty("rosterEntryId", out var re) && re.ValueKind == JsonValueKind.String
    && Guid.TryParse(re.GetString(), out var rg) ? rg : Guid.Empty;
  if (rosterId == Guid.Empty) return Results.BadRequest("Advisors must be created in the roster first: supply a rosterEntryId.");
  if (!s.Roster.TryGetValue(rosterId, out var __src) || __src.Archived) return Results.NotFound("Roster entry not found.");
  bool __canSrcAttach = false;
  { var __me2 = PeopleOps.UserOf(s, req); var __adm2 = PeopleOps.AdminEmail(s); var __isAdm2 = !string.IsNullOrWhiteSpace(__adm2) && string.Equals(__adm2, __me2, StringComparison.OrdinalIgnoreCase);
    __canSrcAttach = __isAdm2 || string.Equals(__src.OwnerKey ?? "", __me2, StringComparison.OrdinalIgnoreCase)
      || string.Equals(RosterLegacyAccess.EffectiveOwnerKey(s, __src) ?? "", __me2, StringComparison.OrdinalIgnoreCase)
      || s.Advisors.Values.Any(a => a.RosterEntryId == rosterId && !a.Removed && PeopleOps.Can(s, req, a.BoardId, null, "read"));
    if (!__canSrcAttach) return PeopleOps.Denied(); }
  var role = body.TryGetProperty("boardRole", out var br) ? (br.GetString() ?? "") : "";
  var (copy, error, status) = RosterOps.TryCopy(s, rosterId, boardId, role, callerCanReadRoster: __canSrcAttach, canAttachBoard: true);
  return copy is not null ? Results.Created($"/api/boards/{boardId}/advisors/{copy.Id}", copy)
    : status == 409 ? Results.Conflict(error ?? "Attach rejected.") : Results.Json(new { error }, statusCode: status);
});

app.MapDelete("/api/boards/{boardId:guid}/advisors/{advisorId:guid}", (InMemoryStore s, HttpRequest req, Guid boardId, Guid advisorId) =>
{
  if (PeopleOps.BadToken(s, req) is { } badDelAdv) return badDelAdv;
  if (!PeopleOps.Can(s, req, boardId, null, "manage")) return PeopleOps.Denied();
  if (!s.Advisors.TryGetValue(advisorId, out var a) || a.BoardId != boardId) return Results.NotFound();
  var advId = a.Id;
  try
  {
    Atomic.Run(s, () =>
    {
      if (!s.Advisors.TryGetValue(advId, out var cur) || cur.BoardId != boardId) throw new InvalidOperationException("Advisor is gone.");
      if (!PeopleOps.Can(s, req, boardId, null, "manage")) throw new UnauthorizedAccessException("Access revoked or not granted for this scope.");
      cur.Removed = true;
    });
  }
  catch (UnauthorizedAccessException) { return PeopleOps.Denied(); }
  catch (InvalidOperationException) { return Results.NotFound(); }
  catch (Exception ex) { return Results.Json(new { error = "Advisor removal failed; no state changed: " + ex.Message }, statusCode: 500); }
  return Results.NoContent();
});

app.MapPost("/api/boards/{boardId:guid}/advisors/{advisorId:guid}/approve", (InMemoryStore s, HttpRequest req, Guid boardId, Guid advisorId) =>
{
  if (!PeopleOps.Can(s, req, boardId, null, "manage")) return PeopleOps.Denied();
  if (!s.Advisors.TryGetValue(advisorId, out var a) || a.BoardId != boardId || a.Removed) return Results.NotFound();
  var gate = RosterOps.ApprovalGate(s, a);
  if (gate is not null) return Results.Json(new { error = gate switch
  {
    "stale-version" => "Roster changed since this copy; update from roster, review, then approve.",
    "research-pending" => "Research is still running for this advisor.",
    "research-failed" => "Research failed for this advisor; rerun research, then review and approve.",
    "research-interrupted" => "Research was interrupted for this advisor; rerun research, then review and approve.",
    "research-unsupported" => "Research completed without grounded evidence; rerun research with better inputs to ground it before approval.",
    "no-evidence" => "No supporting evidence yet; run research again or add sources first.",
    "portrait-pending" => "An accepted portrait is required before approving (upload one, then accept it).",
    "archived-entry" => "Roster entry is archived.",
    "recovered-incomplete" => "Recovered entry is an incomplete placeholder: complete the profile (or run research to evidence) before approving.",
    _ => "Advisor is not eligible for approval.",
  } }, statusCode: 409);
  // ONE durable unit: recheck CURRENT authority + eligibility inside the commit so a
  // concurrent revocation cannot approve; storage failure returns 500, not false Ok.
  try
  {
    lock (s.SetupLock)
    {
      Atomic.Run(s, () =>
      {
        if (PeopleOps.Check(s, req, boardId, null, "manage") is not null) throw new UnauthorizedAccessException("Access revoked or not granted for this scope.");
        if (!s.Advisors.TryGetValue(advisorId, out var a2) || a2.BoardId != boardId || a2.Removed) throw new InvalidOperationException("Advisor is gone.");
        var gate2 = RosterOps.ApprovalGate(s, a2);
        if (gate2 is not null) throw new InvalidOperationException("gate:" + gate2);
        a2.Approved = true;
      });
    }
  }
  catch (UnauthorizedAccessException) { return PeopleOps.Denied(); }
  catch (InvalidOperationException iox) when (iox.Message == "Advisor is gone.") { return Results.NotFound(); }
  catch (InvalidOperationException iox) when (iox.Message.StartsWith("gate:")) { return Results.Json(new { error = "Advisor became ineligible (" + iox.Message["gate:".Length..] + "); review, then approve." }, statusCode: 409); }
  catch (Exception ex) { return Results.Json(new { error = "Approval could not be stored: " + ex.Message }, statusCode: 500); }
  if (!s.Advisors.TryGetValue(advisorId, out var done)) return Results.NotFound();
  Atomic.Audit(s, new AuditEvent { BoardId = boardId, Action = "advisor.approve", Detail = JsonSerializer.Serialize(new { advisor = advisorId, role = done.BoardRole }) });
  return Results.Ok(done);
});

app.MapGet("/api/boards/{boardId:guid}/meetings", (InMemoryStore s, HttpRequest req, Guid boardId, string? q, string? state) =>
{
  if (PeopleOps.BadToken(s, req) is { } badM) return badM;
  if (PeopleOps.IsSecure(s) && !AuthOps.TrySession(s, req, out _)) return Results.Json(new { error = "Authentication required." }, statusCode: 401);
  if (!s.Boards.ContainsKey(boardId)) return Results.NotFound();
  IEnumerable<Meeting> list;
  if (PeopleOps.Can(s, req, boardId, null, "read"))
    list = s.Meetings.Values.Where(m => m.BoardId == boardId);
  else
  {
    var user = PeopleOps.UserOf(s, req);
    var allowed = PeopleOps.GuestMeetingIds(s, user, boardId);
    if (allowed.Count == 0) return PeopleOps.Denied();
    list = s.Meetings.Values.Where(m => m.BoardId == boardId && allowed.Contains(m.Id));
  }
  if (!string.IsNullOrWhiteSpace(q))
    list = list.Where(m => m.Title.Contains(q, StringComparison.OrdinalIgnoreCase)
      || m.Brief.Contains(q, StringComparison.OrdinalIgnoreCase));
  if (!string.IsNullOrWhiteSpace(state) && Enum.TryParse<MeetingState>(state, true, out var st))
    list = list.Where(m => m.State == st);
  return Results.Ok(list.OrderByDescending(m => m.CreatedAt).Take(200));
});

app.MapPost("/api/boards/{boardId:guid}/meetings", (InMemoryStore s, HttpRequest req, Guid boardId, JsonElement body) =>
{
  if (PeopleOps.BadToken(s, req) is { } badMc) return badMc;
  if (PeopleOps.Check(s, req, boardId, null, "manage") is { } deniedMc) return deniedMc;
  var input = new Meeting
  {
    Id = Guid.NewGuid(), BoardId = boardId,
    Title = body.TryGetProperty("title", out var t) && t.ValueKind == JsonValueKind.String ? (t.GetString() ?? "Meeting") : "Meeting",
    Brief = body.TryGetProperty("brief", out var bb) && bb.ValueKind == JsonValueKind.String ? (bb.GetString() ?? "") : "",
    State = MeetingState.AwaitingBrief, CreatedAt = DateTime.UtcNow,
  };
  if (body.TryGetProperty("participantIds", out var pp) && pp.ValueKind == JsonValueKind.Array)
  {
    var ids = new List<Guid>();
    foreach (var e in pp.EnumerateArray())
      if (e.ValueKind == JsonValueKind.String && Guid.TryParse(e.GetString(), out var g)
        && s.Advisors.TryGetValue(g, out var pa) && pa.BoardId == boardId && !pa.Removed) ids.Add(g);
    input.ParticipantIdsJson = JsonSerializer.Serialize(ids);
  }
  input.CreatedAt = DateTime.UtcNow;
  var newMeeting = input;
  try
  {
    Atomic.Run(s, () =>
    {
      if (!s.Boards.ContainsKey(boardId)) throw new InvalidOperationException("Board is gone.");
      if (PeopleOps.Check(s, req, boardId, null, "manage") is not null) throw new UnauthorizedAccessException("Access revoked or not granted for this scope.");
      s.Meetings[newMeeting.Id] = newMeeting;
      s.Messages[newMeeting.Id] = MessageList.Detached(newMeeting.Id, new List<Message>());
    });
  }
  catch (UnauthorizedAccessException) { return PeopleOps.Denied(); }
  catch (InvalidOperationException) { return Results.NotFound(); }
  catch (Exception ex) { return Results.Json(new { error = "Meeting creation failed; no state changed: " + ex.Message }, statusCode: 500); }
  return Results.Created($"/api/meetings/{input.Id}", input);
});

app.MapGet("/api/meetings/{meetingId:guid}/messages", (InMemoryStore s, HttpRequest req, Guid meetingId, long? after, int take = 60) =>
{
  take = Math.Clamp(take, 1, 100);
  try
  {
    return Atomic.Run(s, () =>
    {
      if (PeopleOps.HasInvalidToken(s, req)) return Results.Json(new { error = "Invalid or expired session token." }, statusCode: 401);
      string curUser;
      try
      {
        if (PeopleOps.IsSecure(s))
        {
          if (!AuthOps.TrySession(s, req, out var su) || string.IsNullOrWhiteSpace(su)) return Results.Json(new { error = "Authentication required." }, statusCode: 401);
          curUser = su;
        }
        else { curUser = AuthOps.TrySession(s, req, out var eu) ? eu : PeopleOps.UserOf(s, req); }
      }
      catch (InvalidOperationException) { return Results.Json(new { error = "Security state unavailable." }, statusCode: 503); }
      if (!s.Meetings.TryGetValue(meetingId, out var cur) || cur == null) return Results.NotFound("meeting");
      var bid = cur.BoardId;
      Guid restoreBefore;
      try { restoreBefore = s.RestoreEpochId; } catch { return Results.Json(new { error = "Storage unavailable." }, statusCode: 503); }
      string access;
      try { access = PeopleOps.AccessFor(s, bid, meetingId, curUser); } catch { return Results.Json(new { error = "Storage unavailable." }, statusCode: 503); }
      if (access == "none" || (access == "open" && PeopleOps.IsSecure(s))) return PeopleOps.Denied();
      try
      {
        var existing = s.Memberships.Values.FirstOrDefault(m => m.BoardId == bid && m.MeetingId == meetingId && string.Equals(m.UserKey, curUser, StringComparison.OrdinalIgnoreCase));
        if (existing != null && existing.Active) { }
        else if (existing != null && !existing.Active)
        {
          if (PeopleOps.HasIndependentAuthority(s, bid, curUser)) { }
          else return PeopleOps.Denied();
        }
        else if (existing == null)
        {
          var nm = new Membership { BoardId = bid, MeetingId = meetingId, UserKey = curUser, Active = true, JoinedAt = DateTime.UtcNow };
          s.Memberships[nm.Id] = nm;
        }
      }
      catch { return Results.Json(new { error = "Storage unavailable." }, statusCode: 503); }
      try
      {
        if (s.RestoreEpochId != restoreBefore) return Results.Conflict("Domain was restored during join");
        if (!s.Meetings.TryGetValue(meetingId, out var cur2) || cur2 == null || cur2.BoardId != bid) return Results.NotFound("meeting");
      }
      catch { return Results.Json(new { error = "Storage unavailable." }, statusCode: 503); }
      List<Message> copy;
      try
      {
        if (!s.Messages.TryGetValue(meetingId, out var list) || list == null) return Results.Ok(Array.Empty<Message>());
        var q = list.AsEnumerable();
        if (after.HasValue) q = q.Where(m => m.Sequence > after.Value);
        else q = q.OrderByDescending(m => m.Sequence).Take(take).OrderBy(m => m.Sequence);
        copy = q.OrderBy(m => m.Sequence).Take(take).Select(m => new Message { BoardId = m.BoardId, MeetingId = m.MeetingId, Sequence = m.Sequence, AdvisorId = m.AdvisorId, Sender = m.Sender, AdvisorName = m.AdvisorName, Content = m.Content, ParentSequence = m.ParentSequence, Stance = m.Stance, Status = m.Status, CreatedAt = m.CreatedAt }).ToList();
      }
      catch { return Results.Json(new { error = "Storage unavailable." }, statusCode: 503); }
      return Results.Ok(copy);
    });
  }
  catch (InvalidOperationException ex) { return Results.Json(new { error = "Storage unavailable: " + ex.Message }, statusCode: 503); }
  catch (Exception ex) { return Results.Json(new { error = "Message read failed: " + ex.Message }, statusCode: 500); }
});


app.MapPost("/api/meetings/{meetingId:guid}/messages", async (InMemoryStore s, IHubContext<BoardHub> hub, HttpRequest req, Guid meetingId, Message input) =>
{
  if (!s.Meetings.TryGetValue(meetingId, out var meeting)) return Results.NotFound("meeting");
  if (PeopleOps.Check(s, req, meeting.BoardId, meetingId, "discuss") is { } deniedMsg) return deniedMsg;
  // Durable membership on successful ordinary discuss entry (implicit).
  var ensuredPost = PeopleOps.EnsureMeetingMembership(s, req, meeting.BoardId, meetingId, explicitJoin: false);
  if (ensuredPost.Error is not null) return ensuredPost.Error;
  IResult? msgGate = null;
  long savedGenMsg = 0;
  Guid savedRestoreIdMsg = Guid.Empty;
  long savedRestoreRevMsg = 0;
  lock (s.MessageLock)
  {
    Atomic.Run(s, () =>
    {
    // Fresh fetch + authority inside the backend unit: a detached pre-lock
    // meeting row must never source the mutation after an intervening
    // rollback clears the tracker.
    if (!s.Meetings.TryGetValue(meetingId, out var curM)) { msgGate = Results.NotFound("meeting"); return; }
    if (PeopleOps.BadToken(s, req) is { } badMsg2) { msgGate = badMsg2; return; }
    var freshUser = "";
    if (PeopleOps.IsSecure(s))
    {
      if (!AuthOps.TrySession(s, req, out var mu)) { msgGate = Results.Json(new { error = "Authentication required." }, statusCode: 401); return; }
      freshUser = mu;
    }
    else freshUser = PeopleOps.UserOf(s, req);
    var freshHave = PeopleOps.AccessFor(s, curM.BoardId, meetingId, freshUser);
    if (freshHave != "discuss" && freshHave != "contribute" && freshHave != "manage") { msgGate = PeopleOps.Denied(); return; }
    var list = s.Messages.GetOrAdd(meetingId, _ => new List<Message>());
    input.MeetingId = meetingId;
    input.BoardId = curM.BoardId;
    input.Sender = "lead";
    input.AdvisorId = Guid.Empty;
    input.AdvisorName = null;
    input.Status = "committed";
    if (input.ParentSequence.HasValue && !list.Any(m => m.Sequence == input.ParentSequence.Value))
      input.ParentSequence = null;
    input.Stance = MessageTags.CanonicalStance(input.Stance);
    input.Content = (input.Content ?? "").Trim();
    input.Sequence = (list.Count == 0 ? 0 : list.Max(m => m.Sequence)) + 1;
    input.CreatedAt = DateTime.UtcNow;
    input.Status = "committed";
    list.Add(input);
    curM.DeliveredRevision = input.Sequence;
    if (string.Equals(input.Sender, "lead", StringComparison.OrdinalIgnoreCase))
      curM.Generation++;
    savedGenMsg = curM.Generation;
    savedRestoreIdMsg = s.RestoreEpochId;
    savedRestoreRevMsg = s.RestoreEpochRev;
    s.Meetings.Flush();
    });
  }
  if (msgGate is not null) return msgGate;
  await SimCEO.Api.Hubs.BoardHub.PublishMeeting(hub, s, meetingId, "message", new { input.MeetingId, input.Sequence, input.Sender, input.Content }, "read");
  return Results.Created($"/api/meetings/{meetingId}/messages/{input.Sequence}", new { input.BoardId, input.MeetingId, input.Sequence, input.AdvisorId, input.Sender, input.AdvisorName, input.Content, input.ParentSequence, input.Stance, input.Status, input.CreatedAt, generation = savedGenMsg, restoreEpochId = savedRestoreIdMsg, restoreEpochRev = savedRestoreRevMsg });
});

app.MapPost("/api/meetings/{meetingId:guid}/record/draft", (InMemoryStore s, HttpRequest req, Guid meetingId, JsonElement items) =>
{
  if (!s.Meetings.TryGetValue(meetingId, out var meeting)) return Results.NotFound();
  if (PeopleOps.BadToken(s, req) is { } badRecDraft) return badRecDraft;
  if (PeopleOps.Check(s, req, meeting.BoardId, meetingId, "contribute") is { } deniedRecDraft) return deniedRecDraft;
  if (!RecordsOps.ValidateDraftItems(items, out var draftErr))
    return Results.Json(new { error = draftErr }, statusCode: 422);
  var canon = items.GetRawText();
  var draft = new RecordDraft
  {
    BoardId = meeting.BoardId, MeetingId = meetingId,
    Version = 1, Watermark = meeting.DeliveredRevision,
    ItemsJson = canon, Hash = Hashing.HashOf(canon),
    ApprovedJson = "[]", DiscardedJson = "[]",
    ReviewRevision = 1, ReviewToken = RecordsOps.NewReviewToken(),
    HistoryJson = "[]", LegacyReview = false,
  };
  RecordsOps.AppendHistory(draft, "create", "", "", canon, PeopleOps.UserOf(s, req));
  AuditEvent? pendingCreateAudit = null;
  IResult created = Results.Conflict("unreachable");
  lock (s.MessageLock)
  {
    if (!s.Meetings.TryGetValue(meetingId, out var curDraftMtg)) return Results.NotFound();
    try
    {
      created = Atomic.Run(s, () =>
      {
        if (!s.Meetings.TryGetValue(meetingId, out var curMtg2) || curMtg2 is null) return Results.NotFound();
        if (PeopleOps.Check(s, req, curMtg2.BoardId, meetingId, "contribute") is { } deniedRecDraftIn) return deniedRecDraftIn;
        if (!RecordsOps.ValidateDraftItems(items, out var recreateErr))
          return Results.Json(new { error = recreateErr }, statusCode: 422);
        draft.BoardId = curMtg2.BoardId;
        draft.Watermark = curMtg2.DeliveredRevision;
        draft.EvidenceSnapshotJson = "[]";
        s.Drafts[draft.Id] = draft;
        s.Drafts.Flush();
        pendingCreateAudit = new AuditEvent { BoardId = draft.BoardId, Action = "record.create", Detail = JsonSerializer.Serialize(new { draft = draft.Id, version = draft.Version }) };
        return Results.Created($"/api/meetings/{meetingId}/record/{draft.Id}", RecordsOps.SafeDraft(draft));
      });
    }
    catch (Exception ex) { return CommitOutcome.MapCommitFailure(ex, "Record creation") ?? (ex is InvalidOperationException iox ? CommitOutcome.StorageFault("Record creation", iox) : Results.Json(new { error = "Record creation failed before commit; no state changed." }, statusCode: 500)); }
    if (pendingCreateAudit is not null) Atomic.Audit(s, pendingCreateAudit);
    return created;
  }
});

app.MapPost("/api/meetings/{meetingId:guid}/record/from-direction", (InMemoryStore s, HttpRequest req, Guid meetingId, JsonElement body) =>
{
  if (!s.Meetings.TryGetValue(meetingId, out var meeting)) return Results.NotFound("meeting");
  if (PeopleOps.BadToken(s, req) is { } badFromDir) return badFromDir;
  if (!PeopleOps.Can(s, req, meeting.BoardId, meetingId, "contribute")) return PeopleOps.Denied();
  var noteId = Guid.Empty;
  var noteSupplied = false;
  if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("noteId", out var nv))
  {
    if (nv.ValueKind == JsonValueKind.String && Guid.TryParse(nv.GetString(), out var parsedNote)) { noteId = parsedNote; noteSupplied = true; }
    else if (nv.ValueKind == JsonValueKind.Object && nv.TryGetProperty("id", out var ni) && ni.ValueKind == JsonValueKind.String && Guid.TryParse(ni.GetString(), out var parsedRef)) { noteId = parsedRef; noteSupplied = true; }
  }
  if (!noteSupplied) return Results.BadRequest("noteId is required.");
  if (!s.Notes.TryGetValue(noteId, out var note)) return Results.NotFound("direction note not found.");
  if (!string.Equals(note.Kind, "direction", StringComparison.OrdinalIgnoreCase)) return Results.Json(new { error = "Only adopted direction notes can be recorded." }, statusCode: 422);
  if (note.BoardId != meeting.BoardId) return Results.Conflict("Direction belongs to another board.");
  if (string.IsNullOrWhiteSpace(note.Scope)) return Results.Json(new { error = "Direction scope is empty; re-adopt with meeting or board scope." }, statusCode: 422);
  if (note.Scope is not ("meeting" or "board")) return Results.Json(new { error = "Direction scope must be meeting or board." }, statusCode: 422);
  if (note.Scope == "meeting" && note.MeetingId != Guid.Empty && note.MeetingId != meetingId)
    return Results.Conflict("Direction belongs to another meeting.");
  if (string.IsNullOrWhiteSpace(note.Body)) return Results.Json(new { error = "Direction text is empty." }, statusCode: 422);
  var itemId = "dir-" + note.Id.ToString("N").Substring(0, 8);
  var items = new[] { new { id = itemId, text = note.Body, scope = note.Scope, refs = new[] { new { kind = "direction", @ref = note.Id.ToString() } } } };
  var itemsJson = JsonSerializer.Serialize(items, new JsonSerializerOptions(JsonSerializerDefaults.Web));
  using var check = JsonDocument.Parse(itemsJson);
  if (!RecordsOps.ValidateDraftItems(check.RootElement, out var fromDirErr))
    return Results.Json(new { error = fromDirErr }, statusCode: 422);
  var draft = new RecordDraft
  {
    BoardId = meeting.BoardId, MeetingId = meetingId,
    Version = 1, Watermark = meeting.DeliveredRevision,
    ItemsJson = itemsJson, Hash = Hashing.HashOf(itemsJson),
    ApprovedJson = "[]", DiscardedJson = "[]",
    ReviewRevision = 1, ReviewToken = RecordsOps.NewReviewToken(),
    HistoryJson = "[]", LegacyReview = false,
  };
  RecordsOps.AppendHistory(draft, "create", "", "", itemsJson, PeopleOps.UserOf(s, req));
  AuditEvent? pendingDirAudit = null;
  IResult createdDir = Results.Conflict("unreachable");
  lock (s.MessageLock)
  {
    if (!s.Meetings.TryGetValue(meetingId, out var curDirMtg)) return Results.NotFound("meeting");
    try
    {
      createdDir = Atomic.Run(s, () =>
      {
        if (!s.Meetings.TryGetValue(meetingId, out var curDirMtg2) || curDirMtg2 is null) return Results.NotFound("meeting");
        if (!PeopleOps.Can(s, req, curDirMtg2.BoardId, meetingId, "contribute")) return PeopleOps.Denied();
        if (!s.Notes.TryGetValue(noteId, out var reNote) || reNote is null) return Results.NotFound("direction note not found.");
        if (!string.Equals(reNote.Kind, "direction", StringComparison.OrdinalIgnoreCase)) return Results.Json(new { error = "Only adopted direction notes can be recorded." }, statusCode: 422);
        if (reNote.BoardId != curDirMtg2.BoardId) return Results.Conflict("Direction belongs to another board.");
        if (string.IsNullOrWhiteSpace(reNote.Scope)) return Results.Json(new { error = "Direction scope is empty; re-adopt with meeting or board scope." }, statusCode: 422);
        if (reNote.Scope is not ("meeting" or "board")) return Results.Json(new { error = "Direction scope must be meeting or board." }, statusCode: 422);
        if (reNote.Scope == "meeting" && reNote.MeetingId != Guid.Empty && reNote.MeetingId != meetingId)
          return Results.Conflict("Direction belongs to another meeting.");
        if (string.IsNullOrWhiteSpace(reNote.Body)) return Results.Json(new { error = "Direction text is empty." }, statusCode: 422);
        if (!string.Equals(reNote.Body, note.Body, StringComparison.Ordinal)) return Results.Conflict("Direction changed during preparation; retry deliberately.");
        draft.BoardId = curDirMtg2.BoardId;
        draft.Watermark = curDirMtg2.DeliveredRevision;
        draft.EvidenceSnapshotJson = "[]";
        s.Drafts[draft.Id] = draft;
        s.Drafts.Flush();
        pendingDirAudit = new AuditEvent { BoardId = draft.BoardId, Action = "record.from-direction", Detail = JsonSerializer.Serialize(new { draft = draft.Id, note = reNote.Id, item = itemId, watermark = draft.Watermark }) };
        return Results.Created($"/api/meetings/{meetingId}/record/{draft.Id}", RecordsOps.SafeDraft(draft));
      });
    }
    catch (Exception ex) { return CommitOutcome.MapCommitFailure(ex, "Record creation from direction") ?? (ex is InvalidOperationException iox ? CommitOutcome.StorageFault("Record creation from direction", iox) : Results.Json(new { error = "Record creation failed before commit; no state changed." }, statusCode: 500)); }
    if (pendingDirAudit is not null) Atomic.Audit(s, pendingDirAudit);
    return createdDir;
  }
});

app.MapExtended();
app.MapNavigation();

app.MapPost("/api/meetings/{meetingId:guid}/record/approve", (InMemoryStore s, HttpRequest req, Guid meetingId, JsonElement body) =>
{
  Guid draftId = Guid.Empty;
  try
  {
    if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("draftId", out var dv))
    {
      if (dv.ValueKind == JsonValueKind.String) Guid.TryParse(dv.GetString(), out draftId);
    }
  }
  catch { }
  if (draftId == Guid.Empty) return Results.BadRequest("draftId is required.");
  var itemIds = new List<string>();
  if (body.ValueKind == JsonValueKind.Object && body.TryGetProperty("itemIds", out var arr) && arr.ValueKind == JsonValueKind.Array)
    foreach (var e in arr.EnumerateArray())
      itemIds.Add(e.ValueKind == JsonValueKind.String ? (e.GetString() ?? "") : "");
  AuditEvent? pendingApproveAudit = null;
  IResult approveResult;
  lock (s.MessageLock)
  {
    try
    {
      approveResult = Atomic.Run(s, () =>
      {
        if (!s.Drafts.TryGetValue(draftId, out var draft) || draft is null || draft.MeetingId != meetingId)
          return Results.Conflict("Stale or already-decided draft.");
        if (!s.Meetings.TryGetValue(meetingId, out var mtg) || mtg is null)
          return Results.Conflict("Meeting moved on; refresh review.");
        if (PeopleOps.Check(s, req, draft.BoardId, meetingId, "manage") is { } deniedApIn) return deniedApIn;
        if (string.Equals(draft.Status, "superseded", StringComparison.OrdinalIgnoreCase))
          return Results.Json(new { error = "Review is superseded by a newer version; use the successor." }, statusCode: 409);
        if (draft.Decided)
          return Results.Conflict("Stale or already-decided draft.");
        if (!RecordsOps.StrictStateCheck(s, draft, out var serr))
          return Results.Json(new { error = serr }, statusCode: 422);
        if (!RecordsOps.CheckGuard(body, draft, mtg, out var gs, out var ge))
          return Results.Json(new { error = ge }, statusCode: gs);
    Dictionary<string, int> counts;
    JsonDocument itemsDoc;
    try { itemsDoc = JsonDocument.Parse(string.IsNullOrWhiteSpace(draft.ItemsJson) ? "[]" : draft.ItemsJson); }
    catch (JsonException) { return Results.Conflict("Draft items unreadable; revise instead."); }
    using (itemsDoc)
    {
      counts = new Dictionary<string, int>(StringComparer.Ordinal);
      if (itemsDoc.RootElement.ValueKind == JsonValueKind.Array)
        foreach (var el in itemsDoc.RootElement.EnumerateArray())
        {
          var id = el.ValueKind == JsonValueKind.Object && el.TryGetProperty("id", out var iv) ? (iv.GetString() ?? "") : "";
          if (string.IsNullOrWhiteSpace(id)) continue;
          counts[id] = counts.TryGetValue(id, out var c0) ? c0 + 1 : 1;
        }
      if (!RecordsOps.ValidateDraftItems(itemsDoc.RootElement, out var legacyErr))
        return Results.Json(new { error = legacyErr }, statusCode: 422);
      if (itemIds.Count == 0 || itemIds.Any(x => string.IsNullOrWhiteSpace(x)))
        return Results.BadRequest("No items selected.");
      if (itemIds.Distinct(StringComparer.Ordinal).Count() != itemIds.Count || itemIds.Any(x => !counts.TryGetValue(x!, out var cc) || cc != 1))
        return Results.Json(new { error = "Selected items must be unique draft IDs matching exactly one non-empty item each." }, statusCode: 422);
      RecordsOps.TryStrictIdList(draft.ApprovedJson, out var alreadyList, out _);
      RecordsOps.TryStrictIdList(draft.DiscardedJson, out var goneList, out _);
      var already = new HashSet<string>(alreadyList, StringComparer.Ordinal);
      var gone = new HashSet<string>(goneList, StringComparer.Ordinal);
      if (itemIds.Any(x => already.Contains(x!) || gone.Contains(x!)))
        return Results.Conflict("One or more selected items are already decided; refresh review.");
      if (!RecordsOps.CheckApprovalAuthority(s, draft, out var authErrLegacy))
        return Results.Json(new { error = authErrLegacy }, statusCode: 409);
      var actor = PeopleOps.UserOf(s, req);
      var av = draft.Version; var ah = draft.Hash; var aw = draft.Watermark; var at = draft.ReviewToken;
      {
        var ap = new HashSet<string>(already, StringComparer.Ordinal);
        foreach (var x in itemIds) ap.Add(x!);
        var newLegacyToken = RecordsOps.NewReviewToken();
        var stagedLegacy = draft.HistoryJson;
        var map2 = RecordsOps.ItemMap(draft.ItemsJson, out _);
        foreach (var x in itemIds)
        {
          if (!RecordsOps.TryBuildHistoryJson(stagedLegacy, "approve", x, "", map2.TryGetValue(x!, out var it) ? RecordsOps.ItemText(it) : "", actor, av, ah, aw, at, draft.ReviewRevision + 1, newLegacyToken, out var stagedLegacyNext, out var hherr))
            return Results.Json(new { error = hherr }, statusCode: 422);
          stagedLegacy = stagedLegacyNext;
        }
        var acards = RecordsOps.ResolveEvidenceAuthorized(s, req, draft);
        if (!RecordsOps.TryBuildSnapshots(draft.EvidenceSnapshotJson, map2, acards, itemIds.Where(x => x is not null).Select(x => x!), draft.ReviewRevision + 1, out var newSnapsLegacy, out var snerr,
          refId => Guid.TryParse(refId, out var og3) && s.Sources.TryGetValue(og3, out var odoc3) && odoc3 is not null ? SourceGovernance.OriginalVersionOf(s, odoc3) : (int?)null))
          return Results.Json(new { error = snerr }, statusCode: 422);
        draft.ApprovedJson = RecordsOps.ToIdList(ap.OrderBy(v => v, StringComparer.Ordinal));
        draft.HistoryJson = stagedLegacy;
        draft.EvidenceSnapshotJson = newSnapsLegacy;
        draft.ReviewRevision++;
        draft.ReviewToken = newLegacyToken;
        RecordsOps.RefreshDecided(draft);
        s.Drafts.Flush();
        pendingApproveAudit = new AuditEvent { BoardId = draft.BoardId, Action = "record.approve", Detail = JsonSerializer.Serialize(new { draftId, itemIds }) };
          return Results.Ok(new { approved = itemIds, draft = draft.Id, version = draft.Version, reviewToken = draft.ReviewToken, reviewRevision = draft.ReviewRevision, status = draft.Status, pending = RecordsOps.PendingIds(draft) });
        }
      }
      });
    }
    catch (Exception) { return Results.Json(new { error = "Record mutation failed before commit; no state changed." }, statusCode: 500); }
  }
  if (pendingApproveAudit is not null) Atomic.Audit(s, pendingApproveAudit);
  return approveResult;
});

// Phase 6 deterministic migration: runs after the backend is wired and
// before the API serves, so strict head-gated eligibility never depends on
// a list/review/context GET happening first. The migration is idempotent
// and convergent; any failure is fatal — the API refuses to serve rather
// than serve a half-migrated graph.
try
{
  SourceGovernance.Bootstrap(pgStore);
}
catch (Exception mex)
{
  Console.Error.WriteLine($"MIGRATION FATAL: source-governance migration failed ({mex.GetType().Name}: {mex.Message}). Refusing to serve.");
  Environment.Exit(1);
}
// Unique identity constraints are enforced ONLY after the migration above
// has canonicalized families and resolved legacy collisions. Creating them
// earlier would fail on reachable legacy shapes.
if (pgCs is not null)
{
  try
  {
    var asm2 = System.Reflection.Assembly.LoadFrom(
      Path.Combine(AppContext.BaseDirectory, "SimCEO.Postgres.dll"));
    var boot2 = asm2.GetType("SimCEO.Postgres.PgBoot");
    var argv2 = new object?[] { pgCs, "" };
    var ok2 = boot2 is not null && (bool)boot2.GetMethod("EnsureUniqueIndexes")!.Invoke(null, argv2)!;
    if (!ok2)
    {
      Console.Error.WriteLine($"POSTGRES FATAL: {argv2[1]}");
      Environment.Exit(1);
    }
    Console.WriteLine("POSTGRES: unique source indexes enforced.");
  }
  catch (Exception ex2)
  {
    Console.Error.WriteLine($"POSTGRES FATAL: unique-index enforcement unavailable ({ex2.GetType().Name}). Refusing to serve without constraints.");
    Environment.Exit(1);
  }
}

app.Run();
