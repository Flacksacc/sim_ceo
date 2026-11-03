using Microsoft.EntityFrameworkCore;
using SimCEO.Postgres;

// Owned-DB fault seam for QA: installs/drops real PostgreSQL failure
// triggers. No application HTTP/env/header controls. Usage (PG only):
//   dotnet qa/StorageFaultTrigger/bin/Debug/net10.0/StorageFaultTrigger.dll install-write-fail|install-commit-fail|drop
// Connection string comes from PGCS env (falls back to the secretary QA database).
var cs = Environment.GetEnvironmentVariable("PGCS")
  ?? "Host=127.0.0.1;Port=15440;Database=simceo;Username=simceo;Password=simceo-dev-only";
var mode = args.Length > 0 ? args[0].Trim().ToLowerInvariant() : "";
var options = new DbContextOptionsBuilder<PostgresDb>().UseNpgsql(cs).Options;
using var db = new PostgresDb(options);
try
{
  switch (mode)
  {
    case "install-write-fail":
      db.Database.ExecuteSqlRaw("CREATE OR REPLACE FUNCTION qa_fail_notes() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION \'qa injected publication failure\'; END; $$ LANGUAGE plpgsql");
      db.Database.ExecuteSqlRaw("DROP TRIGGER IF EXISTS qa_fail_pub ON \"Notes\"");
      db.Database.ExecuteSqlRaw("CREATE TRIGGER qa_fail_pub BEFORE INSERT ON \"Notes\" FOR EACH ROW EXECUTE FUNCTION qa_fail_notes()");
      Console.WriteLine("TRIGGER RESULT: write-fail installed");
      break;
    case "install-commit-fail":
      db.Database.ExecuteSqlRaw("CREATE OR REPLACE FUNCTION qa_fail_notes() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION \'qa injected commit failure\'; END; $$ LANGUAGE plpgsql");
      db.Database.ExecuteSqlRaw("DROP TRIGGER IF EXISTS qa_fail_pub ON \"Notes\"");
      db.Database.ExecuteSqlRaw("DROP TRIGGER IF EXISTS qa_fail_commit ON \"Notes\"");
      db.Database.ExecuteSqlRaw("CREATE CONSTRAINT TRIGGER qa_fail_commit AFTER INSERT ON \"Notes\" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qa_fail_notes()");
      Console.WriteLine("TRIGGER RESULT: commit-fail installed");
      break;
    case "drop":
      db.Database.ExecuteSqlRaw("DROP TRIGGER IF EXISTS qa_fail_pub ON \"Notes\"");
      db.Database.ExecuteSqlRaw("DROP TRIGGER IF EXISTS qa_fail_commit ON \"Notes\"");
      db.Database.ExecuteSqlRaw("DROP FUNCTION IF EXISTS qa_fail_notes()");
      Console.WriteLine("TRIGGER RESULT: dropped");
      break;
    default:
      Console.Error.WriteLine("usage: StorageFaultTrigger install-write-fail|install-commit-fail|drop");
      return 2;
  }
  return 0;
}
catch (Exception ex)
{
  Console.Error.WriteLine("TRIGGER RESULT: FAIL " + ex.GetType().Name + " " + ex.Message);
  return 1;
}
