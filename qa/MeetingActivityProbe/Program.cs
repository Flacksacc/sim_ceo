// qa/MeetingActivityProbe - deterministic in-process barriers for MeetingActivity.
// Own alt output only (never bin/); no services, ports, or processes.
// Covers interleavings HTTP cannot hold: stale-exit vs newer continuation,
// uncertain-on-live-exit (the storage-read-failure branch shape), missing-row
// removal, terminal adoption, single-principal capture with expired sessions,
// and a lock-ordering hammer (no nested RootGate/entry acquisition anywhere).
using Microsoft.AspNetCore.Http;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;
using SimCEO.Api.Work;

var failures = new List<string>();
void Check(bool ok, string name, string detail)
{
  Console.WriteLine((ok ? "PASS " : "FAIL ") + name + " :: " + detail);
  if (!ok) failures.Add(name);
}
string SnapStatus(InMemoryStore s, Guid mid, string nonce)
{
  try
  {
    var snap = MeetingActivity.GetSnapshot(s, mid, "a@example.com");
    var t = snap.GetType();
    var sec = (System.Collections.IEnumerable?)t.GetProperty("secretary")?.GetValue(snap);
    if (sec is null) return "no-secretary-key";
    foreach (var o in sec)
    {
      var ot = o.GetType();
      var cn = ot.GetProperty("clientNonce")?.GetValue(o) as string;
      if (cn == nonce) return ot.GetProperty("status")?.GetValue(o) as string ?? "no-status";
    }
    return "missing";
  }
  catch (Exception ex) { return "throw:" + ex.GetType().Name; }
}

var board = Guid.NewGuid();
var meeting = Guid.NewGuid();
var reqId = Guid.NewGuid();
var aOld = Guid.NewGuid();
var aNew = Guid.NewGuid();
const string nonce = "probe-nonce-1";

// ---- T1 stale exit must not touch newer continuation mirror ----
{
  var s = new InMemoryStore();
  s.Meetings[meeting] = new Meeting { Id = meeting, BoardId = board, State = MeetingState.Active, Generation = 5 };
  s.SecretaryRequests[reqId] = new SecretaryRequest { Id = reqId, BoardId = board, MeetingId = meeting, ClientNonce = nonce, Status = "needs-clarification", AttemptId = aOld, AnswerAttemptId = aNew, Generation = 6 };
  var epoch = s.RestoreEpochId;
  MeetingActivity.SecretaryStarted(s, meeting, board, reqId, aOld, "a@example.com", nonce, 6, epoch, "inflight", "initial");
  MeetingActivity.SecretaryStarted(s, meeting, board, reqId, aNew, "a@example.com", nonce, 6, epoch, "answering", "continuation");
  MeetingActivity.SyncSecretaryExit(s, null!, meeting, reqId, aOld);
  Check(SnapStatus(s, meeting, nonce) == "answering", "stale-exit-preserves-newer", "status=" + SnapStatus(s, meeting, nonce));
}

// ---- T2 exit with live row + own attempt -> uncertain (no busy forever) ----
{
  var s = new InMemoryStore();
  s.Meetings[meeting] = new Meeting { Id = meeting, BoardId = board, State = MeetingState.Active, Generation = 5 };
  s.SecretaryRequests[reqId] = new SecretaryRequest { Id = reqId, BoardId = board, MeetingId = meeting, ClientNonce = "probe-nonce-2", Status = "inflight", AttemptId = aOld, Generation = 6 };
  MeetingActivity.SecretaryStarted(s, meeting, board, reqId, aOld, "a@example.com", "probe-nonce-2", 6, s.RestoreEpochId, "inflight", "initial");
  MeetingActivity.SyncSecretaryExit(s, null!, meeting, reqId, aOld);
  Check(SnapStatus(s, meeting, "probe-nonce-2") == "uncertain", "live-exit-becomes-uncertain", "status=" + SnapStatus(s, meeting, "probe-nonce-2"));
}

// ---- T3 missing row removes orphan mirror ----
{
  var s = new InMemoryStore();
  s.Meetings[meeting] = new Meeting { Id = meeting, BoardId = board, State = MeetingState.Active, Generation = 5 };
  MeetingActivity.SecretaryStarted(s, meeting, board, reqId, aOld, "a@example.com", "probe-nonce-3", 6, s.RestoreEpochId, "inflight", "initial");
  MeetingActivity.SyncSecretaryExit(s, null!, meeting, reqId, aOld);
  Check(SnapStatus(s, meeting, "probe-nonce-3") == "missing", "missing-row-removes-mirror", "status=" + SnapStatus(s, meeting, "probe-nonce-3"));
}

// ---- T4 terminal row adopted ----
{
  var s = new InMemoryStore();
  s.Meetings[meeting] = new Meeting { Id = meeting, BoardId = board, State = MeetingState.Active, Generation = 5 };
  s.SecretaryRequests[reqId] = new SecretaryRequest { Id = reqId, BoardId = board, MeetingId = meeting, ClientNonce = "probe-nonce-4", Status = "completed", AttemptId = aOld, Generation = 6 };
  MeetingActivity.SecretaryStarted(s, meeting, board, reqId, aOld, "a@example.com", "probe-nonce-4", 6, s.RestoreEpochId, "inflight", "initial");
  MeetingActivity.SyncSecretaryExit(s, null!, meeting, reqId, aOld);
  Check(SnapStatus(s, meeting, "probe-nonce-4") == "completed", "terminal-row-adopted", "status=" + SnapStatus(s, meeting, "probe-nonce-4"));
}

// ---- T5 single-principal capture: live session wins, expired denies ----
{
  var s = new InMemoryStore();
  s.Security[Guid.NewGuid()] = new SecurityState { AuthRequired = true, AdminEmail = "a@example.com" };
  s.Sessions["live-tok"] = new SimCEO.Api.Session { Token = "live-tok", Email = "a@example.com", ExpiresAt = DateTime.UtcNow.AddHours(1) };
  s.Sessions["dead-tok"] = new SimCEO.Api.Session { Token = "dead-tok", Email = "a@example.com", ExpiresAt = DateTime.UtcNow.AddMinutes(-5) };
  s.Boards[board] = new Board { Id = board, OwnerKey = "owner@example.com" };
  s.Grants[Guid.NewGuid()] = new Grant { BoardId = board, MeetingId = null, UserKey = "a@example.com", Access = "contribute" };
  DefaultHttpContext Live() { var h = new DefaultHttpContext(); h.Request.Headers["Authorization"] = "Bearer live-tok"; h.Request.Headers["X-User"] = "evil@example.com"; return h; }
  DefaultHttpContext Dead() { var h = new DefaultHttpContext(); h.Request.Headers["Authorization"] = "Bearer dead-tok"; h.Request.Headers["X-User"] = "evil@example.com"; return h; }
  var okLive = SimCEO.Api.Work.SecretaryEndpoints.TryCaptureContributor(s, Live().Request, board, meeting, out var whoLive, out _);
  Check(okLive && whoLive == "a@example.com", "live-session-beats-spoof", "who=" + whoLive);
  var okDead = SimCEO.Api.Work.SecretaryEndpoints.TryCaptureContributor(s, Dead().Request, board, meeting, out var whoDead, out var denyDead);
  Check(!okDead && string.IsNullOrEmpty(whoDead) && denyDead is not null, "expired-session-denies-no-fallback", "who=" + whoDead);
}

// ---- T6 insecure X-User attribution ----
{
  var s = new InMemoryStore();
  var h = new DefaultHttpContext();
  h.Request.Headers["X-User"] = "bob@example.com";
  var okOpen = SimCEO.Api.Work.SecretaryEndpoints.TryCaptureContributor(s, h.Request, Guid.NewGuid(), null, out var whoOpen, out _);
  Check(okOpen && whoOpen == "bob@example.com", "insecure-xuser-attribution", "who=" + whoOpen);
}

// ---- T7 lock-ordering hammer: reconcile/snapshot/set/finish/exit/publish ----
{
  var s = new InMemoryStore();
  var b2 = Guid.NewGuid();
  var m2 = Guid.NewGuid();
  var r2 = Guid.NewGuid();
  var advOk = Guid.NewGuid();
  var advBad = Guid.NewGuid();
  var img = Guid.NewGuid();
  s.Boards[b2] = new Board { Id = b2, OwnerKey = "o@example.com" };
  s.Meetings[m2] = new Meeting { Id = m2, BoardId = b2, State = MeetingState.Active, Generation = 5 };
  s.Roster[r2] = new RosterEntry { Id = r2, Archived = false, Version = 1 };
  s.Images[img] = new AdvisorImage { Id = img, RosterEntryId = r2, Review = "accepted" };
  s.Advisors[advOk] = new BoardAdvisor { Id = advOk, BoardId = b2, RosterEntryId = r2, RosterVersion = 1, BoardRole = "Ok", Approved = true, ImageProvenance = img.ToString() };
  s.Advisors[advBad] = new BoardAdvisor { Id = advBad, BoardId = b2, RosterEntryId = Guid.NewGuid(), BoardRole = "Bad", Approved = true };
  var op = Guid.NewGuid();
  var req2 = Guid.NewGuid();
  s.SecretaryRequests[req2] = new SecretaryRequest { Id = req2, BoardId = b2, MeetingId = m2, ClientNonce = "hammer", Status = "inflight", AttemptId = op, Generation = 5 };
  MeetingActivity.DiscussionStarted(s, m2, b2, op, 5, 0, new[] { s.Advisors[advOk], s.Advisors[advBad] }, s.RestoreEpochId);
  MeetingActivity.SecretaryStarted(s, m2, b2, req2, op, "o@example.com", "hammer", 5, s.RestoreEpochId, "inflight", "initial");
  var states = new[] { "queued", "considering", "responding" };
  var tasks = new List<Task>();
  for (var w = 0; w < 6; w++)
  {
    var ww = w;
    tasks.Add(Task.Run(() =>
    {
      for (var k = 0; k < 1500; k++)
      {
        switch (ww % 6)
        {
          case 0: MeetingActivity.ReconcileDiscussion(s, m2); break;
          case 1: MeetingActivity.GetSnapshot(s, m2, "o@example.com"); break;
          case 2: MeetingActivity.SetAdvisor(m2, op, advOk, "Ok", states[k % 3], null); break;
          case 3: MeetingActivity.FinishIfRunning(s, m2, Guid.NewGuid(), "interrupted", "hammer"); break;
          case 4: MeetingActivity.SyncSecretaryExit(s, null!, m2, req2, ww % 2 == 0 ? op : Guid.NewGuid()); break;
          default: MeetingActivity.PublishDiscussionAsync(null!, s, m2).GetAwaiter().GetResult(); break;
        }
      }
    }));
  }
  var done = Task.WhenAll(tasks).Wait(TimeSpan.FromSeconds(30));
  Check(done, "hammer-no-deadlock", "6x1500 mixed ops completed without hang");
}

Console.WriteLine($"\nprobe: {(failures.Count == 0 ? "ALL PASS" : failures.Count + " FAILED")}");
foreach (var f in failures) Console.WriteLine("FAILED: " + f);
return failures.Count == 0 ? 0 : 1;
