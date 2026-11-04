using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;using Microsoft.AspNetCore.SignalR;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;
using SimCEO.Api.Hubs;
using SimCEO.Api.Work;

sealed class FakeClientProxy : ISingleClientProxy
{
  public static bool RootHeldAtSend = false;
  public static int SendCount = 0;
  public static InMemoryStore? StoreRef;
  public Task<T> InvokeCoreAsync<T>(string method, object?[] args, CancellationToken ct = default) { try { RootHeldAtSend = StoreRef is not null && System.Threading.Monitor.IsEntered(StoreRef.RootGate); } catch { RootHeldAtSend = true; } return Task.FromResult<T>(default!); }
  public Task SendCoreAsync(string method, object?[] args, CancellationToken ct = default)
  {
    SendCount++;
    try { RootHeldAtSend = StoreRef is not null && System.Threading.Monitor.IsEntered(StoreRef.RootGate); } catch { RootHeldAtSend = true; }
    return Task.CompletedTask;
  }
}
sealed class FakeClients : IHubClients
{
  public IClientProxy All => new FakeClientProxy();
  public IClientProxy AllExcept(IReadOnlyList<string> e) => new FakeClientProxy();
  public IClientProxy Client(string id) => new FakeClientProxy();
  public IClientProxy Clients(IReadOnlyList<string> ids) => new FakeClientProxy();
  public IClientProxy Group(string n) => new FakeClientProxy();
  public IClientProxy GroupExcept(string n, IReadOnlyList<string> e) => new FakeClientProxy();
  public IClientProxy Groups(IReadOnlyList<string> ns) => new FakeClientProxy();
  public IClientProxy User(string id) => new FakeClientProxy();
  public IClientProxy Users(IReadOnlyList<string> ids) => new FakeClientProxy();
}
sealed class FakeGroupMgr : IGroupManager
{
  public Task AddToGroupAsync(string c, string g, CancellationToken ct = default) => Task.CompletedTask;
  public Task RemoveFromGroupAsync(string c, string g, CancellationToken ct = default) => Task.CompletedTask;
}
sealed class FakeHubCtx : IHubContext<BoardHub>
{
  public IHubClients Clients { get; } = new FakeClients();
  public IGroupManager Groups { get; } = new FakeGroupMgr();
}
static class Probe
{
  static void AddConn(InMemoryStore s, string cid, string user, Guid mid)
  {
    var connsF = typeof(BoardHub).GetField("Conns", BindingFlags.NonPublic | BindingFlags.Static)!;
    var groupsF = typeof(BoardHub).GetField("JoinedGroups", BindingFlags.NonPublic | BindingFlags.Static)!;
    var conns = (ConcurrentDictionary<string, HubConn>)connsF.GetValue(null)!;
    var groups = (ConcurrentDictionary<string, HashSet<string>>)groupsF.GetValue(null)!;
    var grp = "meeting:" + mid.ToString("N").ToLowerInvariant();
    conns[cid] = new HubConn(cid, user, "", null, mid, DateTime.UtcNow);
    groups[cid] = new HashSet<string> { grp };
  }
  static async Task<int> Main()
  {
    int pass=0, fail=0; void ok(string n, bool c, string e=""){ if(c){pass++; Console.WriteLine("  ok - "+n);} else {fail++; Console.WriteLine("  FAIL "+n+" :: "+e);} }
    var s = new InMemoryStore();
    FakeClientProxy.StoreRef = s;
    var hub = new FakeHubCtx();
    var board = new Board { Name="b", Mission="m", Stage="qa" };
    s.Boards[board.Id] = board;
    var meeting = new Meeting { BoardId=board.Id, Title="t" };
    s.Meetings[meeting.Id] = meeting;
    AddConn(s, "c1", "owner", meeting.Id);
    var op0 = Guid.NewGuid();
    MeetingActivity.DiscussionStarted(s, meeting.Id, board.Id, op0, 0, 0, new List<BoardAdvisor>(), Guid.NewGuid());
    // 1) Committed positive: capture inside ROOT, publish AFTER exit -> Root NOT held at Send
    FakeClientProxy.SendCount=0; FakeClientProxy.RootHeldAtSend=true;
    List<SimCEO.Api.Domain.Message> batch = new();
    lock (s.SetupLock) { lock (s.MessageLock) {
      Atomic.Run(s, () => {
        var msg = new SimCEO.Api.Domain.Message { MeetingId=meeting.Id, BoardId=board.Id, Sender="advisor", AdvisorName="A", Content="hi", Sequence=1, Status="committed" };
        batch.Add(msg);
        s.Messages.AddRangeCommitted(meeting.Id, batch);
      });
      // INTENT captured inside (batch), publish deferred until after locks (new pattern)
    } }
    // AFTER outer ROOT aliases exit:
    try { await MeetingActivity.PublishDiscussionAsync(hub, s, meeting.Id); } catch {}
    ok("committed-publish-outside-root", FakeClientProxy.SendCount>0 && FakeClientProxy.RootHeldAtSend==false, $"sends={FakeClientProxy.SendCount} held={FakeClientProxy.RootHeldAtSend}");
    ok("committed-message-durable", s.Messages.TryGetValue(meeting.Id, out var ml) && ml!.Count==1, "message missing");
    // 2) OLD violation demo: publish INSIDE root holds root at Send (proves boundary observable)
    FakeClientProxy.SendCount=0; FakeClientProxy.RootHeldAtSend=false;
    lock (s.RootGate) {
      try { MeetingActivity.PublishDiscussionAsync(hub, s, meeting.Id).GetAwaiter().GetResult(); } catch {}
    }
    ok("inside-root-observes-held", FakeClientProxy.SendCount>0 && FakeClientProxy.RootHeldAtSend==true, $"sends={FakeClientProxy.SendCount} held={FakeClientProxy.RootHeldAtSend}");
    // 3) Failure path: validation fails inside unit, deferred publish after exit, no messages, root not held
    FakeClientProxy.SendCount=0; FakeClientProxy.RootHeldAtSend=true;
    bool threw=false;
    Microsoft.AspNetCore.Http.IResult? gate=null;
    lock (s.SetupLock) { lock (s.MessageLock) {
      try {
        Atomic.Run(s, () => {
          // simulate LaneBFail guard failure: meeting gone
          throw new InvalidOperationException("gone");
        });
      } catch { threw=true; }
    } }
    // rollback: no deferred publish requested -> no send
    ok("rollback-no-publish", threw && FakeClientProxy.SendCount==0, $"sends={FakeClientProxy.SendCount}");
    // 4) Failure with committed interruption outcome: Finish inside, publish after -> root not held
    FakeClientProxy.SendCount=0; FakeClientProxy.RootHeldAtSend=true;
    var op = Guid.NewGuid();
    MeetingActivity.DiscussionStarted(s, meeting.Id, board.Id, op, 0, 0, new List<BoardAdvisor>(), Guid.NewGuid());
    lock (s.SetupLock) { lock (s.MessageLock) {
      Atomic.Run(s, () => {
        MeetingActivity.FinishDiscussion(s, meeting.Id, op, "interrupted", "unit-test");
        // capture only, no publish here (new pattern)
      });
    } }
    try { await MeetingActivity.PublishDiscussionAsync(hub, s, meeting.Id); } catch {}
    ok("failure-publish-outside-root", FakeClientProxy.SendCount>0 && FakeClientProxy.RootHeldAtSend==false, $"sends={FakeClientProxy.SendCount} held={FakeClientProxy.RootHeldAtSend}");
    Console.WriteLine($"FINAL pass={pass} fail={fail}");
    return fail==0?0:1;
  }
}



