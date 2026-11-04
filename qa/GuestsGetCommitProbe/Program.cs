using SimCEO.Api;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;
var failures = new System.Collections.Generic.List<string>();
void Check(bool ok, string name, string detail)
{
  System.Console.WriteLine((ok ? "PASS " : "FAIL ") + name + " :: " + detail);
  if (!ok) failures.Add(name);
}
var store = new InMemoryStore();
var boardId = System.Guid.NewGuid();
var meetingId = System.Guid.NewGuid();
var user = "qa-guest@example.com";
Atomic.Run(store, () =>
{
  store.Boards[boardId] = new Board { Id = boardId, Name = "qa-board" };
  store.Meetings[meetingId] = new Meeting { Id = meetingId, BoardId = boardId, Title = "qa-meeting" };
  store.Messages[meetingId] = MessageList.Detached(meetingId, new System.Collections.Generic.List<Message>());
});
Check(store.Boards.ContainsKey(boardId), "seed-board", "board present");
Check(store.Meetings.ContainsKey(meetingId), "seed-meeting", "meeting present");
int memBefore = store.Memberships.Count;
int msgBefore = 0;
try { msgBefore = store.Messages[meetingId].Count; } catch { msgBefore = 0; }
MemFaults.FailCapture = () => true;
bool threw = false;
try
{
  Atomic.Run(store, () =>
  {
    var nm = new Membership { BoardId = boardId, MeetingId = meetingId, UserKey = user, Active = true, JoinedAt = System.DateTime.UtcNow };
    store.Memberships[nm.Id] = nm;
    var list = store.Messages.GetOrAdd(meetingId, _ => new System.Collections.Generic.List<Message>());
    list.Add(new Message { BoardId = boardId, MeetingId = meetingId, Sequence = 1, Sender = "lead", Content = "qa", Status = "committed", CreatedAt = System.DateTime.UtcNow });
  });
}
catch (System.InvalidOperationException) { threw = true; }
finally { MemFaults.FailCapture = null; }
Check(threw, "getshape-capture-fault-throws", "threw=" + threw);
Check(store.Memberships.Count == memBefore, "getshape-no-partial-membership", "before=" + memBefore + " after=" + store.Memberships.Count);
int msgAfter = 0;
try { msgAfter = store.Messages[meetingId].Count; } catch { msgAfter = 0; }
Check(msgAfter == msgBefore, "getshape-no-partial-message", "before=" + msgBefore + " after=" + msgAfter);
bool okAfter = false;
try
{
  Atomic.Run(store, () =>
  {
    var nm2 = new Membership { BoardId = boardId, MeetingId = meetingId, UserKey = user, Active = true, JoinedAt = System.DateTime.UtcNow };
    store.Memberships[nm2.Id] = nm2;
  });
  okAfter = true;
}
catch (System.Exception ex) { Check(false, "gate-reusable", ex.GetType().Name); }
Check(okAfter, "gate-reusable", "second unit committed");
System.Console.WriteLine("LIMITATION full GET handler commit failure with HttpRequest and 503 no-data is not proven here; this probe covers Atomic membership plus message shape rollback only and does not claim handler level proof.");
System.Console.WriteLine(failures.Count == 0 ? "PROBE RESULT: PASS" : "PROBE RESULT: FAIL (" + failures.Count + ")");
return failures.Count == 0 ? 0 : 1;
