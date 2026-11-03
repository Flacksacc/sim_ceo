using System.Text.Json;
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
builder.Services.AddCors(o => o.AddDefaultPolicy(p => p.AllowAnyHeader().AllowAnyMethod().AllowCredentials().SetIsOriginAllowed(_ => true)));
builder.Services.AddAntiforgery();

builder.Logging.ClearProviders();
builder.Logging.AddConsole();
var app = builder.Build();
app.UseCors();
app.UseAntiforgery();
// Common invalid-bearer gate.
app.Use(async (ctx, next) =>
{
  if (ctx.Request.Path.StartsWithSegments("/api"))
  {
    var store = ctx.RequestServices.GetRequiredService<InMemoryStore>();
    if (PeopleOps.HasInvalidToken(store, ctx.Request))
    {
      ctx.Response.StatusCode = 401;
      await ctx.Response.WriteAsJsonAsync(new { error = "Invalid or expired session token." });
      return;
    }
  }
  await next();
});
app.UseDefaultFiles();
app.UseStaticFiles();
app.MapFallbackToFile("index.html");
if (app.Environment.IsDevelopment()) { }



var pgStore = app.Services.GetRequiredService<InMemoryStore>();
if (Environment.GetEnvironmentVariable("USE_POSTGRES") == "1")
{
  var cs = builder.Configuration.GetConnectionString("App");
  if (string.IsNullOrWhiteSpace(cs))
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
      var argv = new object?[] { cs, "" };
      var ok = boot is not null && (bool)boot.GetMethod("TryWire")!.Invoke(null, argv)!;
      if (!ok)
      {
        Console.Error.WriteLine($"POSTGRES FATAL: {argv[1]}");
        Environment.Exit(1);
      }
      Console.WriteLine("POSTGRES: connected.");
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
  var draft = new RecordDraft { BoardId = board.Id, MeetingId = meeting.Id, Watermark = meeting.DeliveredRevision, ItemsJson = canon, Hash = Hashing.HashOf(canon) };
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
  board.DraftJson = """{"name":"T1"}""";
  var (activated, actErr, actSt) = LeadSetup.Activate(store, board.Id, Hashing.HashOf(LeadSetup.CanonicalDraftJson(store, board)));
  if (activated is null || actErr is not null || actSt != 200 || !board.ActiveConfig) failures.Add("activate");
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
    Console.WriteLine(failures.Count == 0 ? "SELFTEST PASS: advisor-cap, sequence, record-hash, policy, budgets, challenge, lead-version, setup-activate, roster-copy, same-role, approval-gate, record-export, record-export-refs, evidence-ref, grants, spend-cap, model-policy, provider-guard" : "SELFTEST FAIL: " + string.Join(";", failures));
  Environment.Exit(failures.Count == 0 ? 0 : 1);
}

app.MapGet("/health", () => Results.Ok(new { ok = true, service = "simceo-api", time = DateTime.UtcNow }));
app.MapGet("/ready", (InMemoryStore s) => string.IsNullOrEmpty(s.PgError) ? Results.Ok(new { ready = true, store = Pg.Backend is null ? "inmemory" : "postgres" }) : Results.Json(new { ready = false, store = "unavailable", error = s.PgError }, statusCode: 503));
app.MapGet("/api/backend", (InMemoryStore s) => Results.Ok(new
{
  mode = Pg.Backend is null ? "memory" : "postgres",
  error = s.PgError,
}));
app.MapHub<BoardHub>("/hubs/board");

app.MapGet("/api/boards", (InMemoryStore s) => Results.Ok(s.Boards.Values.Where(b => !b.Archived).OrderByDescending(b => b.CreatedAt).Take(100)));

app.MapPost("/api/boards", (InMemoryStore s, Board input) =>
{
  input.Id = Guid.NewGuid();
  input.CreatedAt = DateTime.UtcNow;
  input.ActiveConfig = false;
  input.ActiveJson = "{}";
  input.LeadProfileVersion = 0;
  s.Boards[input.Id] = input;
  s.Audit.Add(new AuditEvent { BoardId = input.Id, Action = "board.create", Detail = JsonSerializer.Serialize(new { input.Name }) });
  return Results.Created($"/api/boards/{input.Id}", input);
});

app.MapGet("/api/boards/{id:guid}", (InMemoryStore s, Guid id) =>
  s.Boards.TryGetValue(id, out var b) ? Results.Ok(b) : Results.NotFound());

app.MapGet("/api/roster", (InMemoryStore s, Guid accountId, string? q, string? type, string? tag, Guid? boardId) =>
{
  var list = s.Roster.Values.Where(r => r.AccountId == accountId && !r.Archived);
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
    .Select(r => { var (ok, missing) = RosterOps.Completeness(s, r.Id); return new { entry = r, boards = RosterOps.BoardsFor(s, r.Id), imageCount = s.Images.Values.Count(i => i.RosterEntryId == r.Id), complete = ok, missing }; }));
});

app.MapGet("/api/roster/count", (InMemoryStore s, Guid accountId) =>
  Results.Ok(new { total = s.Roster.Values.Count(r => r.AccountId == accountId && !r.Archived) }));

app.MapPost("/api/roster", (InMemoryStore s, HttpRequest req, RosterEntry input) =>
{
  if (PeopleOps.BadToken(s, req) is { } badRaw) return badRaw;
  input.Id = Guid.NewGuid();
  input.OwnerKey = PeopleOps.UserOf(s, req);
  input.Version = 1;
  input.UpdatedAt = DateTime.UtcNow;
  input.ResearchRequested = false;
  input.ResearchedAt = null;
  input.EvidenceCount = 0;
  input.ResearchJson = "{}";
  if (string.IsNullOrWhiteSpace(input.Name)) return Results.BadRequest("Name is required.");
  if (string.IsNullOrWhiteSpace(input.Description)) return Results.BadRequest("Description is required.");
  if (string.IsNullOrWhiteSpace(input.ProfileJson) || input.ProfileJson.Trim().Length < 20) return Results.BadRequest("Profile is required (describe background, strengths, and limits).");
  s.Roster[input.Id] = input;
  return Results.Created($"/api/roster/{input.Id}", input);
});

app.MapGet("/api/boards/{boardId:guid}/advisors", (InMemoryStore s, Guid boardId) =>
  Results.Ok(s.Advisors.Values.Where(a => a.BoardId == boardId && !a.Removed).ToList()));

app.MapPost("/api/boards/{boardId:guid}/advisors", (InMemoryStore s, HttpRequest req, Guid boardId, JsonElement body) =>
{
  if (PeopleOps.BadToken(s, req) is { } badAttach) return badAttach;
  if (!s.Boards.ContainsKey(boardId)) return Results.NotFound("Board not found.");
  if (!PeopleOps.Can(s, req, boardId, null, "manage")) return PeopleOps.Denied();
  var rosterId = body.TryGetProperty("rosterEntryId", out var re) && re.ValueKind == JsonValueKind.String
    && Guid.TryParse(re.GetString(), out var rg) ? rg : Guid.Empty;
  if (rosterId == Guid.Empty) return Results.BadRequest("Advisors must be created in the roster first: supply a rosterEntryId.");
  var role = body.TryGetProperty("boardRole", out var br) ? (br.GetString() ?? "") : "";
  var (copy, error, status) = RosterOps.TryCopy(s, rosterId, boardId, role);
  return copy is not null ? Results.Created($"/api/boards/{boardId}/advisors/{copy.Id}", copy)
    : status == 409 ? Results.Conflict(error ?? "Attach rejected.") : Results.Json(new { error }, statusCode: status);
});

app.MapDelete("/api/boards/{boardId:guid}/advisors/{advisorId:guid}", (InMemoryStore s, HttpRequest req, Guid boardId, Guid advisorId) =>
{
  if (PeopleOps.BadToken(s, req) is { } badDelAdv) return badDelAdv;
  if (!PeopleOps.Can(s, req, boardId, null, "manage")) return PeopleOps.Denied();
  if (!s.Advisors.TryGetValue(advisorId, out var a) || a.BoardId != boardId) return Results.NotFound();
  a.Removed = true;
  s.Advisors.Flush();
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
    "no-evidence" => "No supporting evidence yet; run research again or add sources first.",
    "portrait-pending" => "An accepted portrait is required before approving (upload one, then accept it).",
    "archived-entry" => "Roster entry is archived.",
    _ => "Advisor is not eligible for approval.",
  } }, statusCode: 409);
  a.Approved = true;
  s.Advisors.Flush();
  s.Audit.Add(new AuditEvent { BoardId = boardId, Action = "advisor.approve", Detail = JsonSerializer.Serialize(new { advisor = advisorId, role = a.BoardRole }) });
  return Results.Ok(a);
});

app.MapGet("/api/boards/{boardId:guid}/meetings", (InMemoryStore s, Guid boardId, string? q, string? state) =>
{
  var list = s.Meetings.Values.Where(m => m.BoardId == boardId);
  if (!string.IsNullOrWhiteSpace(q))
    list = list.Where(m => m.Title.Contains(q, StringComparison.OrdinalIgnoreCase)
      || m.Brief.Contains(q, StringComparison.OrdinalIgnoreCase));
  if (!string.IsNullOrWhiteSpace(state) && Enum.TryParse<MeetingState>(state, true, out var st))
    list = list.Where(m => m.State == st);
  return Results.Ok(list.OrderByDescending(m => m.CreatedAt).Take(200));
});

app.MapPost("/api/boards/{boardId:guid}/meetings", (InMemoryStore s, Guid boardId, JsonElement body) =>
{
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
  s.Meetings[input.Id] = input;
  s.Messages[input.Id] = MessageList.Detached(input.Id, new List<Message>());
  return Results.Created($"/api/meetings/{input.Id}", input);
});

app.MapGet("/api/meetings/{meetingId:guid}/messages", (InMemoryStore s, HttpRequest req, Guid meetingId, long? after, int take = 60) =>
{
  take = Math.Clamp(take, 1, 100);
  if (!s.Meetings.TryGetValue(meetingId, out var mtg)) return Results.NotFound("meeting");
  if (!PeopleOps.Can(s, req, mtg.BoardId, meetingId, "read")) return PeopleOps.Denied();
  if (!s.Messages.TryGetValue(meetingId, out var list)) return Results.Ok(Array.Empty<Message>());
  lock (s.MessageLock)
  {
    var q = list.AsEnumerable();
    if (after.HasValue) q = q.Where(m => m.Sequence > after.Value);
    else q = q.OrderByDescending(m => m.Sequence).Take(take).OrderBy(m => m.Sequence);
    return Results.Ok(q.OrderBy(m => m.Sequence).Take(take).ToList());
  }
});

app.MapPost("/api/meetings/{meetingId:guid}/messages", async (InMemoryStore s, IHubContext<BoardHub> hub, HttpRequest req, Guid meetingId, Message input) =>
{
  if (!s.Meetings.TryGetValue(meetingId, out var meeting)) return Results.NotFound("meeting");
  if (!PeopleOps.Can(s, req, meeting.BoardId, meetingId, "contribute")) return PeopleOps.Denied();
  lock (s.MessageLock)
  {
    Atomic.Run(() =>
    {
    var list = s.Messages.GetOrAdd(meetingId, _ => new List<Message>());
    input.MeetingId = meetingId;
    input.BoardId = meeting.BoardId;
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
    meeting.DeliveredRevision = input.Sequence;
    if (string.Equals(input.Sender, "lead", StringComparison.OrdinalIgnoreCase))
      meeting.Generation++;
    s.Meetings.Flush();
    });
  }
  await hub.Clients.Group($"meeting:{meetingId}").SendAsync("message", new { input.MeetingId, input.Sequence, input.Sender, input.Content });
  return Results.Created($"/api/meetings/{meetingId}/messages/{input.Sequence}", input);
});

app.MapPost("/api/meetings/{meetingId:guid}/record/draft", (InMemoryStore s, HttpRequest req, Guid meetingId, JsonElement items) =>
{
  if (!s.Meetings.TryGetValue(meetingId, out var meeting)) return Results.NotFound();
  if (PeopleOps.BadToken(s, req) is { } badRecDraft) return badRecDraft;
  if (!PeopleOps.Can(s, req, meeting.BoardId, meetingId, "contribute")) return PeopleOps.Denied();
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
    HistoryJson = "[]",
  };
  RecordsOps.AppendHistory(draft, "create", "", "", canon, PeopleOps.UserOf(s, req));
  AuditEvent? pendingCreateAudit = null;
  IResult created = Results.Conflict("unreachable");
  lock (s.MessageLock)
  {
    if (!s.Meetings.TryGetValue(meetingId, out var curDraftMtg)) return Results.NotFound();
    try
    {
      created = Atomic.Run(() =>
      {
        if (!s.Meetings.TryGetValue(meetingId, out var curMtg2) || curMtg2 is null) return Results.NotFound();
        if (!PeopleOps.Can(s, req, curMtg2.BoardId, meetingId, "contribute")) return PeopleOps.Denied();
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
    catch (Exception) { return Results.Json(new { error = "Record creation failed before commit; no state changed." }, statusCode: 500); }
    if (pendingCreateAudit is not null) s.Audit.Add(pendingCreateAudit);
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
    HistoryJson = "[]",
  };
  RecordsOps.AppendHistory(draft, "create", "", "", itemsJson, PeopleOps.UserOf(s, req));
  AuditEvent? pendingDirAudit = null;
  IResult createdDir = Results.Conflict("unreachable");
  lock (s.MessageLock)
  {
    if (!s.Meetings.TryGetValue(meetingId, out var curDirMtg)) return Results.NotFound("meeting");
    try
    {
      createdDir = Atomic.Run(() =>
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
    catch (Exception) { return Results.Json(new { error = "Record creation failed before commit; no state changed." }, statusCode: 500); }
    if (pendingDirAudit is not null) s.Audit.Add(pendingDirAudit);
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
      approveResult = Atomic.Run(() =>
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
        if (!RecordsOps.StrictStateCheck(draft, out var serr))
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
        if (!RecordsOps.TryBuildSnapshots(draft.EvidenceSnapshotJson, map2, acards, itemIds.Where(x => x is not null).Select(x => x!), draft.ReviewRevision + 1, out var newSnapsLegacy, out var snerr))
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
  if (pendingApproveAudit is not null) s.Audit.Add(pendingApproveAudit);
  return approveResult;
});
app.Run();
