using Microsoft.EntityFrameworkCore;
using SimCEO.Postgres;

// Durable begin-failure probe: points Npgsql at a known-closed loopback
// port so BeginTransaction throws. Each Transact call must throw BEFORE
// running the supplied mutation, and IsTransacting must be false after
// EACH attempt. On the broken helper the second call wrongly runs the
// mutation outside a transaction (poisoned _depth), failing this probe.
const string cs = "Host=127.0.0.1;Port=54399;Database=simceo_probe_no_db;Username=probe;Password=probe-no-secret;Timeout=1;Command Timeout=1";
var options = new DbContextOptionsBuilder<PostgresDb>().UseNpgsql(cs).Options;
using var db = new PostgresDb(options);
var backend = new PostgresBackend(db);

var failures = new List<string>();
void Check(bool ok, string name, string detail)
{
  Console.WriteLine((ok ? "PASS " : "FAIL ") + name + " :: " + detail);
  if (!ok) failures.Add(name);
}

Check(!backend.IsTransacting, "initial-state", "IsTransacting=" + backend.IsTransacting);

for (var attempt = 1; attempt <= 2; attempt++)
{
  var ran = false;
  string outcome;
  try
  {
    backend.Transact(() => { ran = true; });
    outcome = "returned-normally";
  }
  catch (Exception ex)
  {
    outcome = "threw " + ex.GetType().Name;
  }
  var trans = backend.IsTransacting;
  Check(outcome.StartsWith("threw"), "attempt" + attempt + "-throws",
    "outcome=" + outcome + " (mutation must not run; begin must fail)");
  Check(!ran, "attempt" + attempt + "-mutation-skipped", "ranMutation=" + ran);
  Check(!trans, "attempt" + attempt + "-clean-state", "IsTransacting=" + trans);
}

Console.WriteLine(failures.Count == 0 ? "PROBE RESULT: PASS" : "PROBE RESULT: FAIL (" + failures.Count + ")");
return failures.Count == 0 ? 0 : 1;