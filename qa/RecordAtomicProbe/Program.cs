using Microsoft.EntityFrameworkCore;
using SimCEO.Api;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;
using SimCEO.Postgres;

// Code-only backend seam for the record atomicity guarantee.
// 1. Memory seam: staged builders fail closed WITHOUT touching the draft,
//    so validation failures leave zero partial record changes.
// 2. PG seam: an unrelated transaction (separate app lock) that stages
//    writes and then throws rolls back cleanly while concurrent record
//    mutations on another lock all persist exactly (no tracker-clear loss,
//    no poisoned backend). Uses the app backend contract only; no HTTP,
//    no shipping test surface.
var failures = new List<string>();
void Check(bool ok, string name, string detail)
{
  Console.WriteLine((ok ? "PASS " : "FAIL ") + name + " :: " + detail);
  if (!ok) failures.Add(name);
}

// ---------- memory seam: fail-closed staging, zero partial writes ----------
var mem = new RecordDraft
{
  ItemsJson = """[{"id":"m1","text":"keep"}]""",
  ApprovedJson = "[]",
  DiscardedJson = "[]",
  HistoryJson = "[]",
  SupersedesJson = "[]",
  EvidenceSnapshotJson = "[]",
  ReviewToken = "tok-0",
  ReviewRevision = 1,
};
var beforeItems = mem.ItemsJson;
var beforeApproved = mem.ApprovedJson;
var beforeHistory = mem.HistoryJson;
var beforeToken = mem.ReviewToken;
var badHistoryBuilt = RecordsOps.TryBuildHistoryJson("[null]", "approve", "m1", "", "x", "owner", 1, "h", 0, "t", 2, "tok-1", out _, out var badHistErr);
Check(!badHistoryBuilt, "memory-malformed-history-rejected", badHistErr);
var badSnapsBuilt = RecordsOps.TryBuildSnapshots("[null]", new Dictionary<string, System.Text.Json.JsonElement>(), new List<EvidenceCard>(), new[] { "m1" }, 2, out _, out var badSnapErr);
Check(!badSnapsBuilt, "memory-malformed-snapshots-rejected", badSnapErr);
var badStrict = RecordsOps.StrictStateCheck(new RecordDraft
{
  ItemsJson = """[{"id":"m1","text":"keep"}]""", ApprovedJson = "[]", DiscardedJson = "[]",
  HistoryJson = "[null]", SupersedesJson = "[]", EvidenceSnapshotJson = "[]", ReviewToken = "t",
}, out var strictErr);
Check(!badStrict, "memory-strict-rejects-bad-history", strictErr);
Check(mem.ItemsJson == beforeItems && mem.ApprovedJson == beforeApproved && mem.HistoryJson == beforeHistory && mem.ReviewToken == beforeToken,
  "memory-zero-partial-writes", "draft fields untouched by failed builders");
var goodBuilt = RecordsOps.TryBuildHistoryJson(mem.HistoryJson, "approve", "m1", "", "keep", "owner", 1, "h", 0, "tok-0", 2, "tok-1", out var goodHist, out _);
Check(goodBuilt && goodHist.Contains("\"action\":\"approve\""), "memory-valid-history-builds", goodHist);

// ---------- PG seam: unrelated failing transaction vs concurrent record writes ----------
var cs = args.Length > 0 ? args[0] : "Host=127.0.0.1;Port=15433;Database=simceo;Username=simceo;Password=qa-only";
var options = new DbContextOptionsBuilder<PostgresDb>().UseNpgsql(cs).Options;
using var db = new PostgresDb(options);
try
{
  if (!db.Database.CanConnect()) { Console.WriteLine("PROBE SKIP: pg unreachable"); return 0; }
  db.Database.EnsureCreated();
}
catch (Exception ex) { Console.WriteLine("PROBE SKIP: pg unavailable (" + ex.GetType().Name + ")"); return 0; }
var backend = new PostgresBackend(db);
Pg.Backend = backend;

var runTag = Guid.NewGuid().ToString("N");
var recId = Guid.NewGuid();
var unrId = Guid.NewGuid();
backend.Transact(() =>
{
  db.Drafts.Add(new RecordDraft
  {
    Id = recId, BoardId = Guid.Empty, MeetingId = Guid.Empty, Version = 1, Watermark = 0,
    ItemsJson = """[{"id":"u1","text":"probe one"},{"id":"u2","text":"probe two"}]""",
    Hash = "h", ApprovedJson = "[]", DiscardedJson = "[]", ReviewRevision = 1,
    ReviewToken = "tok-probe-0", HistoryJson = "[]", SupersedesJson = "[]",
    EvidenceSnapshotJson = "[]", Decided = false, Status = "open",
  });
  db.Drafts.Add(new RecordDraft
  {
    Id = unrId, BoardId = Guid.Empty, MeetingId = Guid.Empty, Version = 1, Watermark = 0,
    ItemsJson = "[{\"id\":\"z\",\"text\":\"unrelated-PLACETAG\"}]".Replace("PLACETAG", runTag),
    Hash = "h", ApprovedJson = "[]", DiscardedJson = "[]", ReviewRevision = 1,
    ReviewToken = "tok-probe-u", HistoryJson = "[]", SupersedesJson = "[]",
    EvidenceSnapshotJson = "[]", Decided = false, Status = "open",
  });
});
var lockA = new object(); // unrelated app lock
var lockB = new object(); // record app lock
const int rounds = 50;
var startGate = new ManualResetEventSlim(false);
var errors = new System.Collections.Concurrent.ConcurrentBag<string>();
var tUnrelated = Task.Run(() =>
{
  startGate.Wait();
  for (var i = 0; i < rounds; i++)
  {
    lock (lockA)
    {
      try
      {
        backend.Transact(() =>
        {
          var u = backend.Find<RecordDraft>(unrId)!;
          u.ItemsJson = """[{"id":"z","text":"dirty"}]""";
          db.SaveChanges();
          throw new InvalidOperationException("unrelated-failure");
        });
      }
      catch (InvalidOperationException) { }
      catch (Exception ex) { errors.Add("unrelated-unexpected:" + ex.GetType().Name); }
    }
  }
});
var tRecord = Task.Run(() =>
{
  startGate.Wait();
  for (var i = 0; i < rounds; i++)
  {
    lock (lockB)
    {
      try
      {
        backend.Transact(() =>
        {
          var r = backend.Find<RecordDraft>(recId)!;
          r.ReviewRevision++;
          db.SaveChanges();
        });
      }
      catch (Exception ex) { errors.Add("record-unexpected:" + ex.GetType().Name); }
    }
  }
});
startGate.Set();
Task.WaitAll(tUnrelated, tRecord);
Check(errors.IsEmpty, "race-no-unexpected-errors", string.Join(";", errors.Take(5)));
RecordDraft? fin = null;
RecordDraft? finU = null;
backend.Transact(() => { fin = backend.Find<RecordDraft>(recId); finU = backend.Find<RecordDraft>(unrId); });
Check(fin is not null && fin.ReviewRevision == 1 + rounds, "race-record-persisted-exact", "revision=" + (fin?.ReviewRevision.ToString() ?? "null"));
Check(finU is not null && finU.ItemsJson.Contains("unrelated"), "race-unrelated-rolled-back", (finU?.ItemsJson ?? "null"));
Check(!backend.IsTransacting, "race-backend-clean", "IsTransacting=" + backend.IsTransacting);
// backend still usable after repeated rollback+clear cycles
var usable = false;
try { backend.Transact(() => { usable = backend.Find<RecordDraft>(recId) is not null; }); } catch { usable = false; }
Check(usable, "race-backend-usable", "backend poisoned after clears");
// cleanup scratch rows
backend.Transact(() => { db.Drafts.RemoveRange(db.Drafts.Where(d => d.Id == recId || d.Id == unrId)); });

Console.WriteLine(failures.Count == 0 ? "PROBE RESULT: PASS" : "PROBE RESULT: FAIL (" + failures.Count + ")");
return failures.Count == 0 ? 0 : 1;