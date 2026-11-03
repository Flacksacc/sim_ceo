using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;
using SimCEO.Api.Work;

// Standalone Phase-6 storage-failure probe (replaces the deleted shipping
// HTTP QA fault route). It wires a code-only IPgBackend seam that mirrors
// PostgresBackend.Transact semantics (stage inside the unit, single commit
// at the end, rollback + tracking-clear + rethrow on failure) and drives
// the REAL review/policy helpers through the REAL Atomic unit:
//   1. armed commit failure during approve  -> throws, zero state change
//      (pending review, no head, no event, meeting generation unchanged),
//      verified through FRESH reads (no stale tracked objects);
//   2. armed commit failure during policy   -> throws, board policy bytes
//      unchanged, no policy events;
//   3. simulated restart (fresh store over the SAME backend) still shows
//      the exact failed-state absence;
//   4. disarmed approve + policy persist correctly afterward (head, event,
//      policy bytes, meeting invalidation) and survive a second restart.
// Exit code is nonzero on any failure. Result lines go to
// .tmp/source-governance-probe-result.txt and stdout.

sealed class ProbeCommitException : Exception
{
  public ProbeCommitException(string message) : base(message) { }
}

sealed class FailBackend : IPgBackend
{
  private readonly object _gate = new();
  private Dictionary<string, object> _live = new();
  private Dictionary<Guid, List<Message>> _msgs = new();
  private int _depth;
  public bool FailCommit { get; set; }
  public bool IsTransacting { get { lock (_gate) return _depth > 0; } }
  private static string Key<T>(Guid id) => typeof(T).FullName + ":" + id.ToString("N");
  private static readonly JsonSerializerOptions JsonOpts = new(JsonSerializerDefaults.Web);

  private string Snap()
  {
    var snap = new Dictionary<string, string>(_live.Count);
    foreach (var kv in _live) snap[kv.Key] = JsonSerializer.Serialize(kv.Value, kv.Value.GetType(), JsonOpts);
    return JsonSerializer.Serialize(snap, JsonOpts);
  }
  private string SnapMsgs() => JsonSerializer.Serialize(_msgs, JsonOpts);

  public void Transact(Action op) { Transact(() => { op(); return true; }); }
  public T Transact<T>(Func<T> op)
  {
    lock (_gate)
    {
      if (_depth > 0) return op();
      var snap = Snap();
      var snapMsgs = SnapMsgs();
      _depth = 1;
      try
      {
        var result = op();
        if (FailCommit) throw new ProbeCommitException("probe commit failure: deferred write rejected");
        return result;
      }
      catch
      {
        var raw = JsonSerializer.Deserialize<Dictionary<string, string>>(snap, JsonOpts)!;
        var restored = new Dictionary<string, object>(raw.Count);
        foreach (var kv in raw)
        {
          var tname = kv.Key.Split(":")[0];
          var t = Type.GetType(tname) ?? AppDomain.CurrentDomain.GetAssemblies()
            .SelectMany(a => { try { return a.GetTypes(); } catch { return Array.Empty<Type>(); } })
            .FirstOrDefault(x => x.FullName == tname);
          if (t is null) throw new InvalidOperationException("probe cannot resolve " + tname);
          restored[kv.Key] = JsonSerializer.Deserialize(kv.Value, t, JsonOpts)!;
        }
        _live = restored;
        _msgs = JsonSerializer.Deserialize<Dictionary<Guid, List<Message>>>(snapMsgs, JsonOpts)!;
        throw;
      }
      finally { _depth = 0; }
    }
  }

  public T? Find<T>(Guid id) where T : class
  {
    lock (_gate) return _live.TryGetValue(Key<T>(id), out var v) ? (T)v : null;
  }
  public List<T> All<T>() where T : class
  {
    lock (_gate)
    {
      var p = typeof(T).FullName + ":";
      return _live.Where(kv => kv.Key.StartsWith(p, StringComparison.Ordinal)).Select(kv => (T)kv.Value).ToList();
    }
  }
  public void Upsert<T>(T entity) where T : class
  {
    lock (_gate)
    {
      var id = (Guid)typeof(T).GetProperty("Id")!.GetValue(entity)!;
      _live[Key<T>(id)] = entity;
    }
  }
  public bool Remove<T>(Guid id) where T : class
  {
    lock (_gate) return _live.Remove(Key<T>(id));
  }
  public void Clear<T>() where T : class
  {
    lock (_gate)
    {
      var p = typeof(T).FullName + ":";
      foreach (var k in _live.Keys.Where(k => k.StartsWith(p, StringComparison.Ordinal)).ToList()) _live.Remove(k);
    }
  }
  public void AddMessage(Message m) { lock (_gate) { if (!_msgs.TryGetValue(m.MeetingId, out var l)) _msgs[m.MeetingId] = l = new(); l.Add(m); } }
  public void AddMessages(IEnumerable<Message> ms) { lock (_gate) { foreach (var m in ms) AddMessage(m); } }
  public List<Message> MeetingMessages(Guid meetingId) { lock (_gate) return _msgs.TryGetValue(meetingId, out var l) ? l.ToList() : new(); }
  public List<Guid> MessageMeetings() { lock (_gate) return _msgs.Keys.ToList(); }
  public void RemoveMeetingMessages(Guid meetingId) { lock (_gate) _msgs.Remove(meetingId); }
  public void ClearMessages() { lock (_gate) _msgs.Clear(); }
  public void Save() { }
}

static class Probe
{
  static int _pass, _fail;
  static readonly List<string> Failures = new();
  static readonly string Out = ".tmp/source-governance-probe-result.txt";
  static void Ok(string name, bool cond, string extra = "")
  {
    if (cond) { _pass++; Console.WriteLine("PASS " + name); }
    else { _fail++; Failures.Add(name + (extra == "" ? "" : " :: " + extra)); Console.WriteLine("FAIL " + name + (extra == "" ? "" : " :: " + extra)); }
  }
  static string Sha(string s) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(s))).ToLowerInvariant();
  static HttpRequest OwnerReq() => new DefaultHttpContext().Request;

  static Guid SeedBoard(InMemoryStore s, out Guid meetingId)
  {
    var b = new Board { Name = "probe-board", SourcePolicyMode = "allowAll", BlockedTypes = "" };
    s.Boards[b.Id] = b;
    s.Boards.Flush();
    var m = new Meeting { BoardId = b.Id, Title = "probe-m", State = MeetingState.Active, Generation = 0 };
    s.Meetings[m.Id] = m;
    s.Meetings.Flush();
    meetingId = m.Id;
    return b.Id;
  }
  static Guid SeedPending(InMemoryStore s, Guid boardId, string file, string body)
  {
    var d = new SourceDoc
    {
      BoardId = boardId, FileName = file, Origin = "upload", Scope = "board",
      ContentHash = Sha(body), Version = 1, ReviewState = "pending",
      IndexState = "completed", IndexGeneration = 1,
      ExtractionJson = "{\"status\":\"ok\",\"md_content\":\"# t\\n\\nbody\"}",
    };
    d.FamilyKey = SourceGovernance.FamilyKeyFor(boardId, "board", null, "upload", file);
    s.Sources[d.Id] = d;
    s.Sources.Flush();
    return d.Id;
  }

  public static int Run()
  {
    System.IO.Directory.CreateDirectory(".tmp");
    System.IO.File.WriteAllText(Out, "START probe " + DateTime.UtcNow.ToString("o") + "\n");
    var backend = new FailBackend();
    Pg.Backend = backend;
    try
    {
      var s = new InMemoryStore();
      var req = OwnerReq();
      var bid = SeedBoard(s, out var mid);
      var pid = SeedPending(s, bid, "probe.txt", "probe body v1");

      // ---- 1. armed approve: commit failure throws, zero state change ----
      backend.FailCommit = true;
      var threw = false;
      try { SourceGovernance.TryApproveById(s, req, pid); }
      catch (ProbeCommitException) { threw = true; }
      Ok("approve-commit-throws", threw);
      s.Sources.TryGetValue(pid, out var fresh);
      Ok("approve-still-pending", fresh is not null && fresh.ReviewState == "pending" && !fresh.Approved,
        fresh is null ? "missing" : fresh.ReviewState + "/" + fresh.Approved);
      Ok("approve-no-head", !s.SourceHeads.Values.Any(h => h.BoardId == bid),
        "heads=" + s.SourceHeads.Values.Count);
      Ok("approve-no-event", !s.SourceEvents.Values.Any(e => e.SourceId == pid),
        "events=" + s.SourceEvents.Values.Count(e => e.SourceId == pid));
      s.Meetings.TryGetValue(mid, out var fm);
      Ok("approve-gen-unchanged", fm is not null && fm.Generation == 0,
        fm is null ? "missing" : "gen=" + fm.Generation);

      // ---- 2. armed policy: commit failure throws, policy bytes unchanged ----
      threw = false;
      try { SourceGovernance.ApplySourcePolicy(s, req, bid, "exe, zip", "wikiOnly"); }
      catch (ProbeCommitException) { threw = true; }
      Ok("policy-commit-throws", threw);
      s.Boards.TryGetValue(bid, out var fb);
      Ok("policy-bytes-unchanged", fb is not null && fb.SourcePolicyMode == "allowAll" && fb.BlockedTypes == "",
        fb is null ? "missing" : fb.SourcePolicyMode + "/" + fb.BlockedTypes);
      Ok("policy-no-event", !s.SourceEvents.Values.Any(e => e.BoardId == bid && e.Action == "policy"),
        "policyEvents=" + s.SourceEvents.Values.Count(e => e.BoardId == bid && e.Action == "policy"));

      // ---- 3. simulated restart: fresh store over SAME backend, absence holds ----
      var s2 = new InMemoryStore();
      s2.Sources.TryGetValue(pid, out var rf);
      Ok("restart-still-pending", rf is not null && rf.ReviewState == "pending" && !rf.Approved,
        rf is null ? "missing" : rf.ReviewState);
      Ok("restart-no-head", !s2.SourceHeads.Values.Any(h => h.BoardId == bid));
      s2.Boards.TryGetValue(bid, out var rb);
      Ok("restart-policy-unchanged", rb is not null && rb.SourcePolicyMode == "allowAll");

      // ---- 4. disarm: approve + policy persist correctly afterward ----
      backend.FailCommit = false;
      var (ok, err, status) = SourceGovernance.TryApproveById(s2, OwnerReq(), pid);
      Ok("approve-after-200", ok && status == 200, status + "/" + err);
      s2.Sources.TryGetValue(pid, out var af);
      Ok("approve-after-state", af is not null && af.ReviewState == "approved" && af.Approved);
      var head = s2.SourceHeads.Values.FirstOrDefault(h => h.BoardId == bid);
      Ok("approve-after-head", head is not null && head.HeadVersion == 1 && head.HeadSourceId == pid,
        head is null ? "missing" : "v" + head.HeadVersion);
      Ok("approve-after-event", s2.SourceEvents.Values.Any(e => e.SourceId == pid && e.Action == "approve"));
      var (pok, perr, pstatus, blocked, mode) = SourceGovernance.ApplySourcePolicy(s2, OwnerReq(), bid, "exe, zip", "wikiOnly");
      Ok("policy-after-200", pok && pstatus == 200, pstatus + "/" + perr);
      s2.Boards.TryGetValue(bid, out var ab);
      Ok("policy-after-bytes", ab is not null && ab.SourcePolicyMode == "wikiOnly" && ab.BlockedTypes == "exe, zip",
        ab is null ? "missing" : ab.SourcePolicyMode + "/" + ab.BlockedTypes);
      Ok("policy-after-event", s2.SourceEvents.Values.Any(e => e.BoardId == bid && e.Action == "policy"));

      // ---- 5. second restart: success survives ----
      var s3 = new InMemoryStore();
      s3.Sources.TryGetValue(pid, out var sf);
      Ok("restart2-approved-survives", sf is not null && sf.ReviewState == "approved" && sf.Approved);
      var h3 = s3.SourceHeads.Values.FirstOrDefault(h => h.BoardId == bid);
      Ok("restart2-head-survives", h3 is not null && h3.HeadVersion == 1 && h3.HeadSourceId == pid);
    }
    finally { Pg.Backend = null; }
    System.IO.File.AppendAllText(Out, "DONE pass=" + _pass + " fail=" + _fail + "\n" + string.Join("\n", Failures) + "\n");
    Console.WriteLine("PROBE pass=" + _pass + " fail=" + _fail);
    return _fail == 0 ? 0 : 1;
  }
}

static class Program
{
  static int Main() => Probe.Run();
}
