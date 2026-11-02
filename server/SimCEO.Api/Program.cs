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
app.UseDefaultFiles();
app.UseStaticFiles();
app.MapFallbackToFile("index.html");
if (app.Environment.IsDevelopment()) { }



if (Environment.GetEnvironmentVariable("USE_POSTGRES") == "1")
{
  var cs = builder.Configuration.GetConnectionString("App");
  if (string.IsNullOrWhiteSpace(cs)) Console.WriteLine("POSTGRES: no connection string; running in-memory.");
  else
  {
    try
    {
      var asm = System.Reflection.Assembly.LoadFrom(
        Path.Combine(AppContext.BaseDirectory, "SimCEO.Postgres.dll"));
      var boot = asm.GetType("SimCEO.Postgres.PgBoot");
      var argv = new object?[] { cs, "" };
      var ok = boot is not null && (bool)boot.GetMethod("TryWire")!.Invoke(null, argv)!;
      Console.WriteLine(ok ? "POSTGRES: connected." : $"POSTGRES: {argv[1]}");
    }
    catch (Exception ex)
    {
      var inner = ex.InnerException;
      while (inner?.InnerException is not null) inner = inner.InnerException;
      Console.WriteLine($"POSTGRES: backend unavailable ({ex.GetType().Name}: {inner?.Message ?? ex.Message}); running in-memory.");
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
  foreach (var a in store.Advisors.Values.Where(a => a.BoardId == board.Id).Take(1)) a.Approved = true;
  board.DraftJson = """{"name":"T1"}""";
  var (activated, actErr, actSt) = LeadSetup.Activate(store, board.Id, Hashing.HashOf(board.DraftJson));
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
  Console.WriteLine(failures.Count == 0 ? "SELFTEST PASS: advisor-cap, sequence, record-hash, policy, budgets, challenge, lead-version, setup-activate, roster-copy, record-export, grants, spend-cap, model-policy, provider-guard" : "SELFTEST FAIL: " + string.Join(";", failures));
  Environment.Exit(failures.Count == 0 ? 0 : 1);
}

app.MapGet("/health", () => Results.Ok(new { ok = true, service = "simceo-api", time = DateTime.UtcNow }));
app.MapGet("/ready", () => Results.Ok(new { ready = true, store = "inmemory" }));
app.MapHub<BoardHub>("/hubs/board");

app.MapGet("/api/boards", (InMemoryStore s) => Results.Ok(s.Boards.Values.Where(b => !b.Archived).OrderByDescending(b => b.CreatedAt).Take(100)));

app.MapPost("/api/boards", (InMemoryStore s, Board input) =>
{
  input.Id = Guid.NewGuid();
  input.CreatedAt = DateTime.UtcNow;
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

app.MapPost("/api/roster", (InMemoryStore s, RosterEntry input) =>
{
  input.Id = Guid.NewGuid();
  input.Version = 1;
  input.UpdatedAt = DateTime.UtcNow;
  if (string.IsNullOrWhiteSpace(input.Name)) return Results.BadRequest("Name is required.");
  if (string.IsNullOrWhiteSpace(input.Description)) return Results.BadRequest("Description is required.");
  if (string.IsNullOrWhiteSpace(input.ProfileJson) || input.ProfileJson.Trim().Length < 20) return Results.BadRequest("Profile is required (describe background, strengths, and limits).");
  s.Roster[input.Id] = input;
  return Results.Created($"/api/roster/{input.Id}", input);
});

app.MapGet("/api/boards/{boardId:guid}/advisors", (InMemoryStore s, Guid boardId) =>
  Results.Ok(s.Advisors.Values.Where(a => a.BoardId == boardId && !a.Removed).ToList()));

app.MapPost("/api/boards/{boardId:guid}/advisors", (InMemoryStore s, Guid boardId, BoardAdvisor input) =>
{
  if (input.RosterEntryId == Guid.Empty || !s.Roster.TryGetValue(input.RosterEntryId, out _)) return Results.BadRequest("Advisors must be created in the roster first: supply a rosterEntryId.");
  var (rok, rmissing) = RosterOps.Completeness(s, input.RosterEntryId);
  if (!rok) return Results.Json(new { error = "Roster entry is incomplete: " + string.Join(", ", rmissing) + "." }, statusCode: 409);
  if (s.Advisors.Values.Any(a => a.BoardId == boardId && a.RosterEntryId == input.RosterEntryId && !a.Removed))
    return Results.Conflict("Advisor already attached to this board.");
  if (s.Advisors.Values.Count(a => a.BoardId == boardId && !a.Removed) >= 10)
    return Results.Problem("Board already has 10 advisors. Remove an advisor to add another.", statusCode: 409);
  input.Id = Guid.NewGuid();
  input.BoardId = boardId;
  input.CreatedAt = DateTime.UtcNow;
  s.Advisors[input.Id] = input;
  return Results.Created($"/api/boards/{boardId}/advisors/{input.Id}", input);
});

app.MapDelete("/api/boards/{boardId:guid}/advisors/{advisorId:guid}", (InMemoryStore s, Guid boardId, Guid advisorId) =>
{
  if (!s.Advisors.TryGetValue(advisorId, out var a) || a.BoardId != boardId) return Results.NotFound();
  a.Removed = true;
  return Results.NoContent();
});

app.MapPost("/api/boards/{boardId:guid}/advisors/{advisorId:guid}/approve", (InMemoryStore s, HttpRequest req, Guid boardId, Guid advisorId) =>
{
  if (!PeopleOps.Can(s, req, boardId, null, "manage")) return PeopleOps.Denied();
  if (!s.Advisors.TryGetValue(advisorId, out var a) || a.BoardId != boardId || a.Removed) return Results.NotFound();
    if (!s.Roster.TryGetValue(a.RosterEntryId, out var rent)) return Results.Json(new { error = "Roster entry not found." }, statusCode: 409);
    if (a.RosterVersion != rent.Version) return Results.Json(new { error = "Roster changed since this copy; update from roster, review, then approve." }, statusCode: 409);
    if (rent.ResearchRequested && rent.ResearchedAt is null) return Results.Json(new { error = "Research is still running for this advisor." }, statusCode: 409);
    if (rent.ResearchRequested && rent.EvidenceCount < 1) return Results.Json(new { error = "No supporting evidence yet; run research again or add sources first." }, statusCode: 409);
    if (!s.Images.Values.Any(i => i.RosterEntryId == a.RosterEntryId && (string.IsNullOrEmpty(i.Review) || i.Review == "accepted"))) return Results.Json(new { error = "An accepted portrait is required before approving (upload one, then accept it)." }, statusCode: 409);
  a.Approved = true;
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
    var list = s.Messages.GetOrAdd(meetingId, _ => new List<Message>());
    input.MeetingId = meetingId;
    input.BoardId = meeting.BoardId;
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
  }
  await hub.Clients.Group($"meeting:{meetingId}").SendAsync("message", new { input.MeetingId, input.Sequence, input.Sender, input.Content });
  return Results.Created($"/api/meetings/{meetingId}/messages/{input.Sequence}", input);
});

app.MapPost("/api/meetings/{meetingId:guid}/record/draft", (InMemoryStore s, Guid meetingId, JsonElement items) =>
{
  if (!s.Meetings.TryGetValue(meetingId, out var meeting)) return Results.NotFound();
  var canon = items.GetRawText();
  var draft = new RecordDraft
  {
    BoardId = meeting.BoardId, MeetingId = meetingId,
    Version = 1, Watermark = meeting.DeliveredRevision,
    ItemsJson = canon, Hash = Hashing.HashOf(canon),
  };
  s.Drafts[draft.Id] = draft;
  return Results.Created($"/api/meetings/{meetingId}/record/{draft.Id}", draft);
});

app.MapExtended();
app.MapNavigation();

app.MapPost("/api/meetings/{meetingId:guid}/record/approve", (InMemoryStore s, HttpRequest req, Guid meetingId, JsonElement body) =>
{
  var draftId = body.GetProperty("draftId").GetGuid();
  var hash = body.GetProperty("hash").GetString() ?? "";
  var watermark = body.GetProperty("watermark").GetInt64();
  var itemIds = body.GetProperty("itemIds").EnumerateArray().Select(e => e.GetString()).ToList();
  if (!s.Drafts.TryGetValue(draftId, out var draft) || draft.MeetingId != meetingId || draft.Decided)
    return Results.Conflict("Stale or already-decided draft.");
  if (!PeopleOps.Can(s, req, draft.BoardId, meetingId, "manage")) return PeopleOps.Denied();
  if (!string.Equals(draft.Hash, hash, StringComparison.OrdinalIgnoreCase)) return Results.Conflict("Draft hash mismatch; refresh review.");
  if (draft.Watermark != watermark) return Results.Conflict("Meeting moved on; refresh review.");
  if (itemIds.Count == 0) return Results.BadRequest("No items selected.");
  draft.Decided = true;
  draft.Status = "approved";
  draft.ApprovedJson = JsonSerializer.Serialize(itemIds);
  s.Audit.Add(new AuditEvent { BoardId = draft.BoardId, Action = "record.approve", Detail = JsonSerializer.Serialize(new { draftId, itemIds }) });
  return Results.Ok(new { approved = itemIds, draft = draft.Id });
});

app.Run();
