// QA-ONLY natural-expiry sweep probe. Own Kestrel host on loopback 15344,
// owned InMemoryStore (memory backend only), ACTUAL AuthEndpoints + PeopleEndpoints
// + SignalR BoardHub with the REAL 30s expiry sweep from BoardHub.Wire.
// No production changes. No clock seam, no SQL, no PG, no logout or revoke to
// fake expiry: the QA-owned guest Session keeps its row and token while only
// ExpiresAt is shortened, then real wallclock passes it and the actual sweep
// plus the actual per-recipient publisher guards do the rest.
// Honest scope: sessions are MEMORY ONLY with 14 day issued lifetime. This proves
// natural wallclock expiry of a shortened QA session, not 14 days elapsed.
// Source and build by Muse. Network execution by PRIMARY after review.
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
void Check(bool ok, string name, string detail)
{
  Console.WriteLine((ok ? "PASS " : "FAIL ") + name + " :: " + detail);
  if (!ok) failures.Add(name);
}
bool WithinBudget() => sw.Elapsed.TotalSeconds < OverallSeconds;

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
var hubCtx = app.Services.GetRequiredService<IHubContext<BoardHub>>();
BoardHub.Wire(hubCtx, app.Services);
await app.StartAsync();
Check(true, "host-started", "loopback Kestrel with actual Auth, People, BoardHub routes");
using var http = new HttpClient { BaseAddress = new Uri(Host + "/"), Timeout = TimeSpan.FromSeconds(15) };
static async Task<(int status, string text)> SendAsync(HttpClient http, string method, string path, object? body, string? token)
{
  using var req = new HttpRequestMessage(new HttpMethod(method), path);
  if (token is not null) req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
  if (body is not null) req.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
  using var res = await http.SendAsync(req);
  return ((int)res.StatusCode, await res.Content.ReadAsStringAsync());
}
static string Prop(string json, string name)
{
  try { using var doc = JsonDocument.Parse(json); return doc.RootElement.TryGetProperty(name, out var v) ? (v.GetString() ?? "") : ""; }
  catch { return ""; }
}

HubConnection? guest = null;
HubConnection? owner = null;
int bootCode = 0;
try
{
  string run = "qx-" + DateTime.UtcNow.ToString("yyyyMMddHHmmss") + "-" + Guid.NewGuid().ToString("N").Substring(0, 6);
  string pw = "TestPassword123!";
  string ownerEmail = run + "-owner@example.com";
  string guestEmail = run + "-guest@example.com";
  var reg1 = await SendAsync(http, "POST", "api/auth/register", new { email = ownerEmail, password = pw }, null);
  string ownerTok = Prop(reg1.text, "token");
  Check(reg1.status == 201 && ownerTok.Length > 10, "register-owner", "status=" + reg1.status);
  var reg2 = await SendAsync(http, "POST", "api/auth/register", new { email = guestEmail, password = pw }, null);
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
  var grant = await SendAsync(http, "POST", "api/boards/" + boardId + "/grants", new { userKey = guestEmail, access = "discuss", meetingId = meetingId }, ownerTok);
  Check(grant.status == 201, "grant-guest-discuss", "actual People grant route status=" + grant.status);
  var join = await SendAsync(http, "POST", "api/meetings/" + meetingId + "/join", new { noop = true }, guestTok);
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
  await owner.StartAsync();
  await guest.StartAsync();
  Check(owner.State == HubConnectionState.Connected && guest.State == HubConnectionState.Connected, "signalr-connected", "both hub connections live");
  try { await guest.InvokeAsync("JoinMeeting", meetingId.ToString()); Check(true, "guest-join-meeting-hub", "actual JoinMeeting accepted"); }
  catch (Exception ex) { Check(false, "guest-join-meeting-hub", ex.GetType().Name + " :: " + ex.Message); }
  try { await owner.InvokeAsync("JoinMeeting", meetingId.ToString()); Check(true, "owner-join-meeting-hub", "actual JoinMeeting accepted"); }
  catch (Exception ex) { Check(false, "owner-join-meeting-hub", ex.GetType().Name + " :: " + ex.Message); }
  bool Has(List<string> sink, string method, int from = 0)
  {
    lock (sigGate) { return sink.Skip(from).Any(e => e.StartsWith(method + "|", StringComparison.Ordinal) && e.Contains(run, StringComparison.Ordinal)); }
  }
  await BoardHub.PublishMeeting(hubCtx, store, meetingId, "qaM1", new { marker = "M1", nonce = run });
  await BoardHub.PublishPrivateMeeting(hubCtx, store, meetingId, guestEmail, "qaPrivG", new { marker = "P1", nonce = run });
  await BoardHub.PublishPrivateMeeting(hubCtx, store, meetingId, ownerEmail, "qaPrivO", new { marker = "P2", nonce = run });
  await Task.Delay(2000);
  Check(Has(ownerGot, "qaM1") && Has(guestGot, "qaM1"), "positive-publish-meeting-both", "actual PublishMeeting reached owner and guest");
  Check(Has(guestGot, "qaPrivG") && !Has(ownerGot, "qaPrivG"), "positive-private-guest-only", "guest private marker stayed private");
  Check(Has(ownerGot, "qaPrivO") && !Has(guestGot, "qaPrivO"), "positive-private-owner-only", "owner private marker stayed private");
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
    if (!WithinBudget()) break;
    await Task.Delay(250);
  }
  Check(DateTime.UtcNow > guestExp, "fixture-expiry-reached", "real wallclock passed the shortened ExpiresAt");
  int gMark;
  lock (sigGate) { gMark = guestGot.Count; }
  await BoardHub.PublishMeeting(hubCtx, store, meetingId, "qaM2", new { marker = "M2", nonce = run });
  await BoardHub.PublishPrivateMeeting(hubCtx, store, meetingId, guestEmail, "qaPrivG2", new { marker = "P3", nonce = run });
  await Task.Delay(2000);
  Check(Has(ownerGot, "qaM2"), "expired-presweep-owner-positive", "owner control marker still delivered");
  Check(!Has(guestGot, "qaM2", gMark), "expired-presweep-guest-zero", "zero guest markers from PublishMeeting");
  Check(!Has(guestGot, "qaPrivG2", gMark), "expired-presweep-private-guest-zero", "zero guest markers from PublishPrivateMeeting");
  Check(!guestClosed.Task.IsCompleted, "presweep-sweep-not-yet", "pre-sweep publish completed before any sweep close");
  while (!(guestRevoked.Task.IsCompleted && guestClosed.Task.IsCompleted) && WithinBudget()) await Task.Delay(250);
  Check(guestRevoked.Task.IsCompleted, "sweep-access-revoked-event", "guest got access-revoked from actual 30s sweep");
  Check(guestClosed.Task.IsCompleted, "sweep-guest-connection-closed", "guest hub connection closed by server");
  Check(!ownerClosed.Task.IsCompleted, "sweep-owner-continues", "owner connection still open");
  await BoardHub.PublishMeeting(hubCtx, store, meetingId, "qaM3", new { marker = "M3", nonce = run });
  await Task.Delay(1500);
  Check(Has(ownerGot, "qaM3"), "postsweep-owner-positive", "owner still receives after sweep");
  Check(!Has(guestGot, "qaM3"), "postsweep-guest-zero", "guest receives nothing after sweep");
  var msg = await SendAsync(http, "GET", "api/meetings/" + meetingId + "/messages", null, guestTok);
  Check(msg.status == 401, "postsweep-rest-401", "protected People route rejects expired session, status=" + msg.status);
  var me = await SendAsync(http, "GET", "api/auth/me", null, guestTok);
  Check(me.status == 200 && me.text.Contains("authenticated", StringComparison.OrdinalIgnoreCase) && me.text.Contains("false", StringComparison.Ordinal), "postsweep-authme-unauthenticated", "auth/me 200 with authenticated false");
  var own = await SendAsync(http, "GET", "api/meetings/" + meetingId + "/messages", null, ownerTok);
  Check(own.status == 200, "postsweep-owner-rest-200", "owner still authorized, status=" + own.status);
  Check(store.Sessions.ContainsKey(guestTok), "expired-row-still-present", "expired session row retained, not deleted");
  Check(!BoardHub.IsTokenRevoked(guestTok), "no-revoke-path-used", "RevokedTokens untouched; no logout or revoke faked expiry");
}
catch (Exception ex)
{
  Check(false, "probe-threw", ex.GetType().Name + " :: " + ex.Message);
}
finally
{
  try { if (guest is not null) await guest.StopAsync(); } catch { }
  try { if (owner is not null) await owner.StopAsync(); } catch { }
  try { if (guest is not null) await guest.DisposeAsync(); } catch { }
  try { if (owner is not null) await owner.DisposeAsync(); } catch { }
  try { await app.StopAsync(); } catch { }
  http.Dispose();
  await Task.Delay(1000);
  if (await LoopbackOpenAsync())
  {
    Console.WriteLine("FAIL listener-cleanup :: 127.0.0.1:" + Port + " still answers after StopAsync.");
    bootCode = 2;
  }
}
if (!WithinBudget()) Check(false, "budget-75s", "shared overall bound exceeded, elapsed=" + sw.Elapsed.TotalSeconds);
Console.WriteLine(failures.Count == 0 ? "PROBE RESULT: PASS" : "PROBE RESULT: FAIL (" + failures.Count + ")");
if (bootCode != 0) return bootCode;
return failures.Count == 0 ? 0 : 1;
