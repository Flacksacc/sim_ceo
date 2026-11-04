// QA-ONLY natural-expiry sweep probe. Own Kestrel host on loopback 15344,
// owned InMemoryStore (memory backend only), ACTUAL AuthEndpoints + PeopleEndpoints
// + SignalR BoardHub with the REAL 30s expiry sweep from BoardHub.Wire.
// QA-only forwarding IHubContext<BoardHub>/IGroupManager decorator records START of
// actual RemoveFromGroupAsync for the EXACT guest connection BEFORE calling the real
// method; pre-sweep publisher-guard proof requires zero recorded removals before AND
// after post-expiry PublishMeeting/PublishPrivateMeeting + observation. Client Closed
// callback alone is NOT accepted as the boundary.
// Timer is the actual 30s timer from Wire; Wire is called AFTER setup/pre-expiry
// positives (inspected: Wire only sets static Ctx/Services and starts the 30s timer;
// Join/Publish use per-call hub/store plus static Conns/JoinedGroups, so delayed Wire
// is safe and keeps slow setup out of the sweep window). Same QA-owned Session row
// ExpiresAt shortened to 8s real wallclock. Never disable/restart clock/sweep.
// One TOTAL 75s stopwatch+CTS covers host startup (inside try) plus every HTTP/hub
// start/invoke/publish/observation/close/Dispose/app shutdown; timeouts fail and never
// re-await the same hung task unbounded; faults observed; listener proof preserved.
// No production changes. No clock seam, no SQL, no PG, no logout/revoke faked expiry.
// Source and build by Muse. Network execution by PRIMARY after review.
using System.Collections.Concurrent;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using SimCEO.Api;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;
using SimCEO.Api.Hubs;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

const int Port = 15344;
const string Host = "http://127.0.0.1:15344";
const double OverallSeconds = 75;
const double ShortLivedSeconds = 8;

var failures = new List<string>();
var sw = System.Diagnostics.Stopwatch.StartNew();
using var totalCts = new CancellationTokenSource(TimeSpan.FromSeconds(OverallSeconds));
TimeSpan Rem() => TimeSpan.FromSeconds(Math.Max(0, OverallSeconds - sw.Elapsed.TotalSeconds));
void Check(bool ok, string name, string detail)
{
  Console.WriteLine((ok ? "PASS " : "FAIL ") + name + " :: " + detail);
  if (!ok) failures.Add(name);
}
static async Task<(bool completed, Exception? fault)> AwaitBounded(Task task, TimeSpan budget, CancellationToken totalToken)
{
  if (budget <= TimeSpan.Zero) return (false, null);
  try
  {
    using var linked = CancellationTokenSource.CreateLinkedTokenSource(totalToken);
    linked.CancelAfter(budget);
    var delay = Task.Delay(Timeout.InfiniteTimeSpan, linked.Token);
    var done = await Task.WhenAny(task, delay);
    if (ReferenceEquals(done, task))
    {
      try { await task; return (true, null); }
      catch (Exception ex) { return (true, ex); }
    }
    _ = task.ContinueWith(t => { var _ = t.Exception; }, TaskContinuationOptions.OnlyOnFaulted);
    return (false, null);
  }
  catch (OperationCanceledException)
  {
    _ = task.ContinueWith(t => { var _ = t.Exception; }, TaskContinuationOptions.OnlyOnFaulted);
    return (false, null);
  }
}
async Task<T> WithBudgetOf<T>(Task<T> task, TimeSpan cap, string timeoutCase)
{
  var rem = Rem();
  if (rem <= TimeSpan.Zero) { Check(false, timeoutCase, "total deadline already exceeded at " + sw.Elapsed.TotalSeconds.ToString("F1") + "s; hung task not awaited"); throw new TimeoutException(timeoutCase); }
  var budget = rem < cap ? rem : cap;
  var (completed, fault) = await AwaitBounded(task, budget, totalCts.Token);
  if (!completed) { Check(false, timeoutCase, "did not complete within " + budget.TotalSeconds.ToString("F1") + "s (elapsed " + sw.Elapsed.TotalSeconds.ToString("F1") + "s); hung task not re-awaited"); throw new TimeoutException(timeoutCase); }
  if (fault is OperationCanceledException oce) { Check(false, timeoutCase, "cancelled (total deadline) :: " + oce.Message); throw new TimeoutException(timeoutCase, oce); }
  if (fault is not null) throw fault;
  return await task;
}
async Task WithBudget(Task task, TimeSpan cap, string timeoutCase)
{
  var rem = Rem();
  if (rem <= TimeSpan.Zero) { Check(false, timeoutCase, "total deadline already exceeded at " + sw.Elapsed.TotalSeconds.ToString("F1") + "s; hung task not awaited"); throw new TimeoutException(timeoutCase); }
  var budget = rem < cap ? rem : cap;
  var (completed, fault) = await AwaitBounded(task, budget, totalCts.Token);
  if (!completed) { Check(false, timeoutCase, "did not complete within " + budget.TotalSeconds.ToString("F1") + "s (elapsed " + sw.Elapsed.TotalSeconds.ToString("F1") + "s); hung task not re-awaited"); throw new TimeoutException(timeoutCase); }
  if (fault is OperationCanceledException oce) { Check(false, timeoutCase, "cancelled (total deadline) :: " + oce.Message); throw new TimeoutException(timeoutCase, oce); }
  if (fault is not null) throw fault;
  await task;
}
static async Task<bool> LoopbackOpenAsync()
{
  try
  {
    using var c = new TcpClient();
    var connect = c.ConnectAsync("127.0.0.1", Port);
    var done = await Task.WhenAny(connect, Task.Delay(1500));
    if (!ReferenceEquals(done, connect)) return false;
    await connect;
    return c.Connected;
  }
  catch { return false; }
}
static async Task<(int status, string text)> SendAsync(HttpClient http, string method, string path, object? body, string? token, CancellationToken ct)
{
  using var req = new HttpRequestMessage(new HttpMethod(method), path);
  if (token is not null) req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
  if (body is not null) req.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
  using var res = await http.SendAsync(req, ct);
  return ((int)res.StatusCode, await res.Content.ReadAsStringAsync(ct));
}
static string Prop(string json, string name)
{
  try { using var doc = JsonDocument.Parse(json); return doc.RootElement.TryGetProperty(name, out var v) ? (v.GetString() ?? "") : ""; }
  catch { return ""; }
}
static bool TryAuthFalse(string json)
{
  try
  {
    using var doc = JsonDocument.Parse(json);
    return doc.RootElement.TryGetProperty("authenticated", out var v)
      && v.ValueKind == JsonValueKind.False;
  }
  catch { return false; }
}

if (await LoopbackOpenAsync())
{
  Console.WriteLine("FAIL preflight-port-occupied :: 127.0.0.1:" + Port + " answered before host start.");
  return 2;
}
if (Pg.Backend is not null)
{
  Console.WriteLine("FAIL memory-backend-not-null :: Pg.Backend is wired; memory backend required.");
  return 2;
}

var store = new InMemoryStore();
var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = Array.Empty<string>(), ApplicationName = "GuestsExpirySweepProbe" });
builder.WebHost.ConfigureKestrel(o => o.Listen(System.Net.IPAddress.Loopback, Port));
builder.Services.AddSingleton(store);
builder.Services.AddSignalR();
builder.Logging.ClearProviders();
builder.Logging.AddConsole();
var app = builder.Build();
app.MapAuth();
app.MapPeople();
app.MapHub<BoardHub>("/hubs/board");
var innerCtx = app.Services.GetRequiredService<IHubContext<BoardHub>>();
var tracker = new RecordingGroupManager(innerCtx.Groups);
var fwdCtx = new ForwardingHubContext(innerCtx, tracker);
var hubCtx = innerCtx;
HubConnection? guest = null;
HubConnection? owner = null;
int bootCode = 0;
try
{
  await WithBudget(app.StartAsync(totalCts.Token), TimeSpan.FromSeconds(15), "host-started-bounded");
  Check(true, "host-started", "loopback Kestrel with actual Auth, People, BoardHub routes (Wire deferred until after positives)");
  using var http = new HttpClient { BaseAddress = new Uri(Host + "/"), Timeout = TimeSpan.FromSeconds(15) };
  async Task<(int status, string text)> SendBounded(string method, string path, object? body, string? token, string timeoutCase)
    => await WithBudgetOf(SendAsync(http, method, path, body, token, totalCts.Token), TimeSpan.FromSeconds(15), timeoutCase);
  string run = "qx-" + DateTime.UtcNow.ToString("yyyyMMddHHmmss") + "-" + Guid.NewGuid().ToString("N").Substring(0, 6);
  string pw = "TestPassword123!";
  string ownerEmail = run + "-owner@example.com";
  string guestEmail = run + "-guest@example.com";
  var reg1 = await SendBounded("POST", "api/auth/register", new { email = ownerEmail, password = pw }, null, "register-owner-bounded");
  string ownerTok = Prop(reg1.text, "token");
  Check(reg1.status == 201 && ownerTok.Length > 10, "register-owner", "status=" + reg1.status);
  var reg2 = await SendBounded("POST", "api/auth/register", new { email = guestEmail, password = pw }, null, "register-guest-bounded");
  string guestTok = Prop(reg2.text, "token");
  Check(reg2.status == 201 && guestTok.Length > 10, "register-guest", "status=" + reg2.status);
  var ownerSess = store.Sessions[ownerTok];
  var guestSess = store.Sessions[guestTok];
  Check(Math.Abs((ownerSess.ExpiresAt - ownerSess.CreatedAt).TotalDays - 14) < 0.1, "issued-lifetime-owner-14d", "actual Session row lifetime days=" + (ownerSess.ExpiresAt - ownerSess.CreatedAt).TotalDays);
  Check(Math.Abs((guestSess.ExpiresAt - guestSess.CreatedAt).TotalDays - 14) < 0.1, "issued-lifetime-guest-14d", "actual Session row lifetime days=" + (guestSess.ExpiresAt - guestSess.CreatedAt).TotalDays);
  Check(guestSess.ExpiresAt > DateTime.UtcNow, "issued-expiry-future", "guest session starts live");
  var boardId = Guid.NewGuid();
  var meetingId = Guid.NewGuid();
  Atomic.Run(store, () =>
  {
    store.Boards[boardId] = new Board { Id = boardId, Name = run + "-board", OwnerKey = ownerEmail, CreatedAt = DateTime.UtcNow };
    store.Meetings[meetingId] = new Meeting { Id = meetingId, BoardId = boardId, Title = run + "-meeting", Brief = "qa", State = MeetingState.AwaitingBrief, CreatedAt = DateTime.UtcNow };
    store.Messages[meetingId] = MessageList.Detached(meetingId, new List<Message>());
  });
  Check(store.Boards.ContainsKey(boardId) && store.Meetings.ContainsKey(meetingId), "seed-board-meeting", "actual domain rows present");
  var grant = await SendBounded("POST", "api/boards/" + boardId + "/grants", new { userKey = guestEmail, access = "discuss", meetingId = meetingId }, ownerTok, "grant-guest-discuss-bounded");
  Check(grant.status == 201, "grant-guest-discuss", "actual People grant route status=" + grant.status);
  var join = await SendBounded("POST", "api/meetings/" + meetingId + "/join", new { noop = true }, guestTok, "guest-join-bounded");
  Check(join.status == 200, "guest-join", "actual People join route status=" + join.status);
  var sigGate = new object();
  var ownerGot = new List<string>();
  var guestGot = new List<string>();
  void Watch(HubConnection c, List<string> sink, string method)
  {
    c.On<JsonElement>(method, el => { lock (sigGate) { sink.Add(method + "|" + el.GetRawText()); } });
  }
  string[] methods = new[] { "qaM1", "qaPrivG", "qaPrivO", "qaM2", "qaPrivG2", "qaM3" };
  owner = new HubConnectionBuilder().WithUrl(Host + "/hubs/board", o => { o.AccessTokenProvider = () => Task.FromResult<string?>(ownerTok); }).Build();
  guest = new HubConnectionBuilder().WithUrl(Host + "/hubs/board", o => { o.AccessTokenProvider = () => Task.FromResult<string?>(guestTok); }).Build();
  foreach (var m in methods) { Watch(owner, ownerGot, m); Watch(guest, guestGot, m); }
  var guestRevoked = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
  var guestClosed = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
  var ownerClosed = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
  guest.On<JsonElement>("access-revoked", _ => { guestRevoked.TrySetResult(true); });
  guest.Closed += _ => { guestClosed.TrySetResult(true); return Task.CompletedTask; };
  owner.Closed += _ => { ownerClosed.TrySetResult(true); return Task.CompletedTask; };
  await WithBudget(owner.StartAsync(totalCts.Token), TimeSpan.FromSeconds(15), "signalr-owner-start-bounded");
  await WithBudget(guest.StartAsync(totalCts.Token), TimeSpan.FromSeconds(15), "signalr-guest-start-bounded");
  Check(owner.State == HubConnectionState.Connected && guest.State == HubConnectionState.Connected, "signalr-connected", "both hub connections live");
  try { await WithBudget(guest.InvokeAsync("JoinMeeting", meetingId.ToString(), totalCts.Token), TimeSpan.FromSeconds(15), "guest-join-meeting-hub-bounded"); Check(true, "guest-join-meeting-hub", "actual JoinMeeting accepted"); }
  catch (Exception ex) { Check(false, "guest-join-meeting-hub", ex.GetType().Name + " :: " + ex.Message); }
  try { await WithBudget(owner.InvokeAsync("JoinMeeting", meetingId.ToString(), totalCts.Token), TimeSpan.FromSeconds(15), "owner-join-meeting-hub-bounded"); Check(true, "owner-join-meeting-hub", "actual JoinMeeting accepted"); }
  catch (Exception ex) { Check(false, "owner-join-meeting-hub", ex.GetType().Name + " :: " + ex.Message); }
  bool Has(List<string> sink, string method, int from = 0)
  {
    lock (sigGate) { return sink.Skip(from).Any(e => e.StartsWith(method + "|", StringComparison.Ordinal) && e.Contains(run, StringComparison.Ordinal)); }
  }
  await WithBudget(BoardHub.PublishMeeting(hubCtx, store, meetingId, "qaM1", new { marker = "M1", nonce = run }), TimeSpan.FromSeconds(15), "positive-publish-meeting-bounded");
  await WithBudget(BoardHub.PublishPrivateMeeting(hubCtx, store, meetingId, guestEmail, "qaPrivG", new { marker = "P1", nonce = run }), TimeSpan.FromSeconds(15), "positive-private-guest-bounded");
  await WithBudget(BoardHub.PublishPrivateMeeting(hubCtx, store, meetingId, ownerEmail, "qaPrivO", new { marker = "P2", nonce = run }), TimeSpan.FromSeconds(15), "positive-private-owner-bounded");
  await WithBudget(Task.Delay(2000, totalCts.Token), TimeSpan.FromSeconds(10), "positive-observe-bounded");
  Check(Has(ownerGot, "qaM1") && Has(guestGot, "qaM1"), "positive-publish-meeting-both", "actual PublishMeeting reached owner and guest");
  Check(Has(guestGot, "qaPrivG") && !Has(ownerGot, "qaPrivG"), "positive-private-guest-only", "guest private marker stayed private");
  Check(Has(ownerGot, "qaPrivO") && !Has(guestGot, "qaPrivO"), "positive-private-owner-only", "owner private marker stayed private");
  string capPath = "api/boards/" + boardId + "/capabilities?meetingId=" + meetingId;
  var capGuestPre = await SendBounded("GET", capPath, null, guestTok, "positive-rest-guest-200-bounded");
  Check(capGuestPre.status == 200, "positive-rest-guest-200", "actual MapPeople capabilities guest pre-expiry, status=" + capGuestPre.status);
  var capOwnerPre = await SendBounded("GET", capPath, null, ownerTok, "positive-rest-owner-200-bounded");
  Check(capOwnerPre.status == 200, "positive-rest-owner-200", "actual MapPeople capabilities owner pre-expiry, status=" + capOwnerPre.status);
  bool preRestOk = capGuestPre.status == 200 && capOwnerPre.status == 200;
  BoardHub.Wire(fwdCtx, app.Services);
  Check(true, "sweep-wired-after-prepositive", "actual 30s sweep started AFTER positives; delayed Wire keeps setup out of sweep window; no clock seam, no manual restart");
  DateTime guestExp;
  lock (store.RootGate)
  {
    var s = store.Sessions[guestTok];
    s.ExpiresAt = DateTime.UtcNow.AddSeconds(ShortLivedSeconds);
    guestExp = s.ExpiresAt;
  }
  Check(store.Sessions.ContainsKey(guestTok), "fixture-row-retained", "session row and token still present after shorten");
  while (DateTime.UtcNow <= guestExp.AddMilliseconds(500))
  {
    if (Rem() <= TimeSpan.Zero || totalCts.Token.IsCancellationRequested) break;
    await Task.Delay(250, totalCts.Token);
  }
  Check(DateTime.UtcNow > guestExp, "fixture-expiry-reached", "real wallclock passed the shortened ExpiresAt");
  string? guestConnId = guest.ConnectionId;
  string expectedGroup = "meeting:" + meetingId.ToString("N").ToLowerInvariant();
  int GuestRemovalStarts()
  {
    try { return tracker.RemovalStarts.Count(e => string.Equals(e.ConnectionId, guestConnId, StringComparison.Ordinal)); }
    catch { return -1; }
  }
  int GuestExpectedGroupRemovals()
  {
    try { return tracker.RemovalStarts.Count(e => string.Equals(e.ConnectionId, guestConnId, StringComparison.Ordinal) && string.Equals(e.Group, expectedGroup, StringComparison.OrdinalIgnoreCase)); }
    catch { return -1; }
  }
  int remBefore = GuestRemovalStarts();
  int remBeforeExact = GuestExpectedGroupRemovals();
  Check(remBefore == 0 && remBeforeExact == 0, "presweep-removal-zero-before", "actual RemoveFromGroupAsync starts for guest conn=" + guestConnId + " group=" + expectedGroup + ": total=" + remBefore + " exact=" + remBeforeExact + "; revoked=" + guestRevoked.Task.IsCompleted);
  bool presweepBoundaryOk = remBefore == 0 && remBeforeExact == 0 && !guestRevoked.Task.IsCompleted;
  if (!presweepBoundaryOk)
  {
    Check(false, "expired-presweep-owner-positive", "skipped: removals already began before pre-sweep publish; publisher guard not proven");
    Check(false, "expired-presweep-guest-zero", "pre-sweep boundary violated: real server removal already started; zero deliveries would not prove publisher guard");
    Check(false, "expired-presweep-private-guest-zero", "pre-sweep boundary violated: real server removal already started; publisher guard not proven");
  }
  else
  {
    int gMark;
    lock (sigGate) { gMark = guestGot.Count; }
    await WithBudget(BoardHub.PublishMeeting(hubCtx, store, meetingId, "qaM2", new { marker = "M2", nonce = run }), TimeSpan.FromSeconds(15), "presweep-publish-meeting-bounded");
    await WithBudget(BoardHub.PublishPrivateMeeting(hubCtx, store, meetingId, guestEmail, "qaPrivG2", new { marker = "P3", nonce = run }), TimeSpan.FromSeconds(15), "presweep-publish-private-bounded");
    await WithBudget(Task.Delay(2000, totalCts.Token), TimeSpan.FromSeconds(10), "presweep-observe-bounded");
    Check(Has(ownerGot, "qaM2"), "expired-presweep-owner-positive", "owner control marker still delivered");
    Check(!Has(guestGot, "qaM2", gMark), "expired-presweep-guest-zero", "zero guest markers from PublishMeeting");
    Check(!Has(guestGot, "qaPrivG2", gMark), "expired-presweep-private-guest-zero", "zero guest markers from PublishPrivateMeeting");
  }
  int remAfter = GuestRemovalStarts();
  int remAfterExact = GuestExpectedGroupRemovals();
  Check(remAfter == 0 && remAfterExact == 0, "presweep-removal-zero-after", "actual RemoveFromGroupAsync starts after pre-sweep publish+observe: total=" + remAfter + " exact=" + remAfterExact + " for guest conn=" + guestConnId);
  Check(!guestRevoked.Task.IsCompleted, "presweep-revoked-zero", "zero access-revoked before sweep");
  Check(!guestClosed.Task.IsCompleted, "presweep-sweep-not-yet", "client Closed still false (informational only; boundary is removal-zero-before/after, not this callback)");
  while (!(guestRevoked.Task.IsCompleted && guestClosed.Task.IsCompleted) && Rem() > TimeSpan.Zero && !totalCts.Token.IsCancellationRequested) await Task.Delay(250, totalCts.Token);
  Check(guestRevoked.Task.IsCompleted, "sweep-access-revoked-event", "guest got access-revoked from actual 30s sweep");
  Check(guestClosed.Task.IsCompleted, "sweep-guest-connection-closed", "guest hub connection closed by server");
  Check(!ownerClosed.Task.IsCompleted, "sweep-owner-continues", "owner connection still open");
  await WithBudget(BoardHub.PublishMeeting(hubCtx, store, meetingId, "qaM3", new { marker = "M3", nonce = run }), TimeSpan.FromSeconds(15), "postsweep-publish-bounded");
  await WithBudget(Task.Delay(1500, totalCts.Token), TimeSpan.FromSeconds(10), "postsweep-observe-bounded");
  Check(Has(ownerGot, "qaM3"), "postsweep-owner-positive", "owner still receives after sweep");
  Check(!Has(guestGot, "qaM3"), "postsweep-guest-zero", "guest receives nothing after sweep");
  if (!preRestOk)
  {
    Check(false, "postsweep-rest-401", "skipped-prereq positive-rest-guest-200/owner-200 failed");
    Check(false, "postsweep-authme-unauthenticated", "skipped-prereq positive-rest-guest-200/owner-200 failed");
    Check(false, "postsweep-owner-rest-200", "skipped-prereq positive-rest-guest-200/owner-200 failed");
  }
  else
  {
    var capGuestPost = await SendBounded("GET", capPath, null, guestTok, "postsweep-rest-401-bounded");
    Check(capGuestPost.status == 401, "postsweep-rest-401", "SAME MapPeople capabilities route rejects expired session, status=" + capGuestPost.status);
    var me = await SendBounded("GET", "api/auth/me", null, guestTok, "postsweep-authme-bounded");
    Check(me.status == 200 && TryAuthFalse(me.text), "postsweep-authme-unauthenticated", "auth/me 200 with authenticated===false strict JSON");
    var capOwnerPost = await SendBounded("GET", capPath, null, ownerTok, "postsweep-owner-rest-bounded");
    Check(capOwnerPost.status == 200, "postsweep-owner-rest-200", "SAME route owner still authorized, status=" + capOwnerPost.status);
  }
  Check(store.Sessions.ContainsKey(guestTok), "expired-row-still-present", "expired session row retained, not deleted");
  Check(!BoardHub.IsTokenRevoked(guestTok), "no-revoke-path-used", "RevokedTokens untouched; no logout or revoke faked expiry");
  http.Dispose();
}
catch (OperationCanceledException oce)
{
  Check(false, "budget-75s", "TOTAL deadline exceeded/cancelled at " + sw.Elapsed.TotalSeconds.ToString("F1") + "s :: " + oce.Message);
}
catch (TimeoutException tex)
{
  if (!failures.Contains(tex.Message)) Check(false, "budget-75s", "bounded wait timed out at " + sw.Elapsed.TotalSeconds.ToString("F1") + "s :: " + tex.Message);
}
catch (Exception ex)
{
  Check(false, "probe-threw", ex.GetType().Name + " :: " + ex.Message);
}
finally
{
  async Task<bool> StopBounded(HubConnection c, string name)
  {
    try
    {
      var budget = Rem() < TimeSpan.FromSeconds(5) ? Rem() : TimeSpan.FromSeconds(5);
      if (budget <= TimeSpan.Zero) { Check(false, name, "no TOTAL budget left; hung Stop not awaited"); return false; }
      var (completed, fault) = await AwaitBounded(c.StopAsync(totalCts.Token), budget, totalCts.Token);
      if (!completed) { Check(false, name, "StopAsync hung beyond " + budget.TotalSeconds.ToString("F1") + "s; NOT re-awaiting same task unbounded"); return false; }
      if (fault is not null) { Check(false, name, "StopAsync faulted: " + fault.GetType().Name + " :: " + fault.Message); return false; }
      return true;
    }
    catch (Exception ex) { Check(false, name, "StopAsync threw: " + ex.GetType().Name + " :: " + ex.Message); return false; }
  }
  async Task DisposeBounded(HubConnection c, string name)
  {
    try
    {
      var budget = Rem() < TimeSpan.FromSeconds(5) ? Rem() : TimeSpan.FromSeconds(5);
      if (budget <= TimeSpan.Zero) { Check(false, name, "no TOTAL budget left; Dispose unclosed (hung Stop not re-awaited)"); return; }
      var (completed, fault) = await AwaitBounded(c.DisposeAsync().AsTask(), budget, totalCts.Token);
      if (!completed) { Check(false, name, "DisposeAsync hung beyond " + budget.TotalSeconds.ToString("F1") + "s; connection left unclosed"); return; }
      if (fault is not null) { Check(false, name, "DisposeAsync faulted: " + fault.GetType().Name + " :: " + fault.Message); return; }
    }
    catch (Exception ex) { Check(false, name, "Dispose threw: " + ex.GetType().Name + " :: " + ex.Message); }
  }
  bool guestStopOk = true; bool ownerStopOk = true;
  try { if (guest is not null) guestStopOk = await StopBounded(guest, "cleanup-guest-stop-bounded"); } catch { guestStopOk = false; }
  try { if (owner is not null) ownerStopOk = await StopBounded(owner, "cleanup-owner-stop-bounded"); } catch { ownerStopOk = false; }
  try { if (guest is not null) await DisposeBounded(guest, "cleanup-guest-dispose-bounded"); } catch { }
  try { if (owner is not null) await DisposeBounded(owner, "cleanup-owner-dispose-bounded"); } catch { }
  if (!guestStopOk) Check(false, "cleanup-guest-unclosed-or-hung", "guest Stop did not complete cleanly; Dispose was separately bounded (same hung task never re-awaited unbounded)");
  if (!ownerStopOk) Check(false, "cleanup-owner-unclosed-or-hung", "owner Stop did not complete cleanly; Dispose was separately bounded");
  try
  {
    var budget = Rem() < TimeSpan.FromSeconds(8) ? Rem() : TimeSpan.FromSeconds(8);
    if (budget <= TimeSpan.Zero) { Check(false, "cleanup-app-stop-bounded", "no TOTAL budget left for app StopAsync"); }
    else
    {
      var (completed, fault) = await AwaitBounded(app.StopAsync(totalCts.Token), budget, totalCts.Token);
      if (!completed) Check(false, "cleanup-app-stop-bounded", "app StopAsync hung beyond " + budget.TotalSeconds.ToString("F1") + "s");
      else if (fault is not null) Check(false, "cleanup-app-stop-bounded", "app StopAsync faulted: " + fault.GetType().Name + " :: " + fault.Message);
    }
  }
  catch (Exception ex) { Check(false, "cleanup-app-stop-bounded", "app StopAsync threw: " + ex.GetType().Name + " :: " + ex.Message); }
  await Task.Delay(1000);
  if (await LoopbackOpenAsync())
  {
    Console.WriteLine("FAIL listener-cleanup :: 127.0.0.1:" + Port + " still answers after StopAsync.");
    bootCode = 2;
  }
}
if (sw.Elapsed.TotalSeconds >= OverallSeconds) Check(false, "budget-75s", "shared TOTAL bound exceeded, elapsed=" + sw.Elapsed.TotalSeconds.ToString("F1"));
Console.WriteLine(failures.Count == 0 ? "PROBE RESULT: PASS" : "PROBE RESULT: FAIL (" + failures.Count + ")");
if (bootCode != 0) return bootCode;
return failures.Count == 0 ? 0 : 1;

sealed class RecordingGroupManager : IGroupManager
{
  private readonly IGroupManager _inner;
  public readonly ConcurrentQueue<(string ConnectionId, string Group, DateTime AtUtc)> RemovalStarts = new();
  public RecordingGroupManager(IGroupManager inner) { _inner = inner; }
  public Task AddToGroupAsync(string connectionId, string groupName, CancellationToken cancellationToken = default)
    => _inner.AddToGroupAsync(connectionId, groupName, cancellationToken);
  public Task RemoveFromGroupAsync(string connectionId, string groupName, CancellationToken cancellationToken = default)
  {
    try { RemovalStarts.Enqueue((connectionId, groupName, DateTime.UtcNow)); } catch { }
    return _inner.RemoveFromGroupAsync(connectionId, groupName, cancellationToken);
  }
}
sealed class ForwardingHubContext : IHubContext<BoardHub>
{
  private readonly IHubContext<BoardHub> _inner;
  private readonly RecordingGroupManager _tracker;
  public ForwardingHubContext(IHubContext<BoardHub> inner, RecordingGroupManager tracker) { _inner = inner; _tracker = tracker; }
  public IHubClients Clients => _inner.Clients;
  public IGroupManager Groups => _tracker;
}
