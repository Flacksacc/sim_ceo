using Microsoft.EntityFrameworkCore;
using SimCEO.Postgres;
using SimCEO.Api.Data;
using SimCEO.Api.Domain;

// In-process COMMIT-failure probe: writes inside Transact, then forces the
// backend commit to throw via the code-only PgFaults seam (no HTTP, no env).
// Asserts: the exception surfaces, the rows are durably absent (rollback),
// IsTransacting is false, and the gate is reusable afterwards.
var cs = System.Environment.GetEnvironmentVariable("QA_PGCS")
  ?? "Host=127.0.0.1;Port=15437;Database=simceo;Username=simceo;Password=simceo-dev-only";
var options = new DbContextOptionsBuilder<PostgresDb>().UseNpgsql(cs).Options;
using var db = new PostgresDb(options);
var backend = new PostgresBackend(db);
var failures = new System.Collections.Generic.List<string>();
void Check(bool ok, string name, string detail)
{
  System.Console.WriteLine((ok ? "PASS " : "FAIL ") + name + " :: " + detail);
  if (!ok) failures.Add(name);
}
var marker = "commitfault-" + Guid.NewGuid().ToString("N");
Check(!backend.IsTransacting, "initial-clean", "IsTransacting=" + backend.IsTransacting);
PgFaults.FailBeforeCommit = () => false;
var before = backend.All<Board>().Count;
PgFaults.FailBeforeCommit = () => true;
var threw = "";
try
{
  backend.Transact(() =>
  {
    backend.Upsert(new Board { Id = Guid.NewGuid(), Name = marker, CreatedAt = DateTime.UtcNow });
  });
}
catch (Exception ex) { threw = ex.GetType().Name + ": " + ex.Message; }
Check(threw.StartsWith("InvalidOperationException"), "commit-throws", threw);
Check(!backend.IsTransacting, "gate-clean-after-fault", "IsTransacting=" + backend.IsTransacting);
var leaked = backend.All<Board>().Any(b => b.Name == marker);
Check(!leaked, "rollback-no-partial-row", "leaked=" + leaked);
PgFaults.FailBeforeCommit = () => false;
var okId = Guid.NewGuid();
try
{
  backend.Transact(() => { backend.Upsert(new Board { Id = okId, Name = marker + "-ok", CreatedAt = DateTime.UtcNow }); });
  Check(true, "gate-reusable", "second transact committed");
}
catch (Exception ex) { Check(false, "gate-reusable", ex.GetType().Name + ": " + ex.Message); }
var present = backend.All<Board>().Any(b => b.Id == okId);
Check(present, "post-fault-write-visible", "present=" + present);
try { backend.Transact(() => { backend.Remove<Board>(okId); }); } catch { }
PgFaults.FailBeforeCommit = null;
System.Console.WriteLine(failures.Count == 0 ? "PROBE RESULT: PASS" : "PROBE RESULT: FAIL (" + failures.Count + ")");
return failures.Count == 0 ? 0 : 1;
