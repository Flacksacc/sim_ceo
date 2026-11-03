// Owned-PG helper for essentials legs (Muse-owned). All operations target the
// OWNED container simceo-integration-qa-pg (full id 14bcfcf7...) via
// `docker exec` argv arrays only (no shell strings), bounded timeouts,
// windowsHide. Exclusive essentials_* DBs only; prior/other DBs are never
// touched, never dropped, never listed for deletion.
import { execFileSync } from "node:child_process";

export const OWN_CONTAINER = "simceo-integration-qa-pg";
export const OWN_FULL_ID = "14bcfcf7a243e5bc73385da4d24a33475b6eab0b04b8185e1d1534c13d1a1891";
export const OWN_USER = "simceo";

function docker(args, timeoutMs = 60000) {
  return execFileSync("docker", args, { windowsHide: true, timeout: timeoutMs, stdio: "pipe" }).toString();
}

export function verifyContainer() {
  const raw = docker(["inspect", OWN_CONTAINER], 30000);
  const obj = JSON.parse(raw)[0];
  const id = String(obj.Id || "");
  if (id !== OWN_FULL_ID) throw new Error("container id mismatch: " + id.slice(0, 24));
  if (String(obj.Config && obj.Config.Image) !== "postgres:16-alpine") throw new Error("container image mismatch");
  if (!obj.State || obj.State.Running !== true) throw new Error("owned container is not running");
  return { id };
}

export function psql(db, sql, timeoutMs = 60000) {
  return docker(["exec", OWN_CONTAINER, "psql", "-U", OWN_USER, "-d", db, "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", sql], timeoutMs).trim();
}

export function psqlJson(db, sql, timeoutMs = 120000) {
  const out = docker(["exec", OWN_CONTAINER, "psql", "-U", OWN_USER, "-d", db, "-v", "ON_ERROR_STOP=1", "-t", "-A", "-F", "\t", "-c", sql], timeoutMs);
  return out;
}

// Full ordered table dump as canonical text: every row, every column, ordered
// by the table primary identity. Byte comparison across restarts/upgrades.
export function dumpTable(db, table, orderBy = "1") {
  const cols = psql(db, "SELECT string_agg(column_name, '|' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='" + table + "';");
  if (!cols) throw new Error("no columns for table " + table);
  const names = cols.split("|");
  const sel = names.map((c) => "COALESCE(" + c + "::text, '<NULL>')").join(" || chr(31) || ");
  const q = "SELECT " + sel + " FROM \"" + table + "\" ORDER BY " + orderBy + ";";
  return docker(["exec", OWN_CONTAINER, "psql", "-U", OWN_USER, "-d", db, "-v", "ON_ERROR_STOP=1", "-t", "-A", "-F", "", "-c", q], 180000);
}

export function tableList(db) {
  const out = psql(db, "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1;");
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

export function rowCount(db, table) {
  return Number(psql(db, "SELECT count(*) FROM \"" + table + "\";").trim());
}

// Restore a preserved .dump into an EXCLUSIVELY new DB (refuse existing).
// Never touches the preserved source DB. Temp container path is unique per
// call and always removed (verified gone); both copy and restore failures
// are retained alongside cleanup failures.
export function restoreDumpToNewDb(dumpHostPath, newDb, fs) {
  if (!/^essentials_[a-z0-9_]+$/.test(newDb)) throw new Error("refusing: db name must match essentials_* : " + newDb);
  const dblist = docker(["exec", OWN_CONTAINER, "psql", "-U", OWN_USER, "-d", "postgres", "-tAc", "SELECT datname FROM pg_database WHERE datistemplate=false;"], 60000);
  const dbs = dblist.split(/\s+/).map((s) => s.trim()).filter(Boolean);
  if (dbs.includes(newDb)) throw new Error("refusing: target DB already exists (never reuse/wipe): " + newDb);
  docker(["exec", OWN_CONTAINER, "createdb", "-U", OWN_USER, newDb], 60000);
  const stamp = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  const dest = "/tmp/ess-restore-" + stamp + ".dump";
  let copyErr = null, restoreErr = null, cleanupErr = null;
  try {
    docker(["exec", OWN_CONTAINER, "test", "!", "-e", dest], 30000);
  } catch {
    throw new Error("refusing: temp dump path already exists in owned container: " + dest);
  }
  try {
    docker(["cp", dumpHostPath, OWN_CONTAINER + ":" + dest], 180000);
  } catch (e) { copyErr = String((e && e.message) || e).split("\n")[0]; }
  if (copyErr === null) {
    try {
      docker(["exec", OWN_CONTAINER, "pg_restore", "-U", OWN_USER, "-d", newDb, dest], 300000);
    } catch (e) { restoreErr = String((e && e.message) || e).split("\n")[0]; }
  }
  try {
    docker(["exec", OWN_CONTAINER, "rm", "-f", dest], 60000);
    docker(["exec", OWN_CONTAINER, "test", "!", "-e", dest], 30000);
  } catch (e) { cleanupErr = String((e && e.message) || e).split("\n")[0]; }
  if (copyErr !== null) {
    if (cleanupErr !== null) throw new Error("copy FAILED and cleanup FAILED: copy=[" + copyErr + "] cleanup=[" + cleanupErr + "]");
    throw new Error("copy FAILED (temp cleaned): " + copyErr);
  }
  if (restoreErr !== null) {
    if (cleanupErr !== null) throw new Error("restore FAILED and cleanup FAILED: restore=[" + restoreErr + "] cleanup=[" + cleanupErr + "]");
    throw new Error("restore FAILED (temp cleaned): " + restoreErr);
  }
  if (cleanupErr !== null) throw new Error("temp dump copy was NOT removed: " + dest + " :: " + cleanupErr);
  void fs;
  return { newDb };
}

// QA-owned fault seam (no server change, no shipping switch): install/drop a
// real PostgreSQL trigger that fails writes/commits on a table. Mirrors the
// proven StorageFaultTrigger pattern.
export function triggerInstall(db, { table = "Notes", mode = "commit" } = {}) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error("bad table");
  psql(db, "CREATE OR REPLACE FUNCTION qa_fail_notes() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'qa injected publication failure'; END; $$ LANGUAGE plpgsql;");
  if (mode === "write") {
    psql(db, "DROP TRIGGER IF EXISTS qa_fail_pub ON \"" + table + "\";");
    psql(db, "CREATE TRIGGER qa_fail_pub BEFORE INSERT ON \"" + table + "\" FOR EACH ROW EXECUTE FUNCTION qa_fail_notes();");
  } else if (mode === "commit") {
    psql(db, "DROP TRIGGER IF EXISTS qa_fail_pub ON \"" + table + "\";");
    psql(db, "DROP TRIGGER IF EXISTS qa_fail_commit ON \"" + table + "\";");
    psql(db, "CREATE CONSTRAINT TRIGGER qa_fail_commit AFTER INSERT ON \"" + table + "\" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qa_fail_notes();");
  } else throw new Error("unknown trigger mode " + mode);
  return { installed: mode, table };
}

export function triggerDrop(db, { table = "Notes" } = {}) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error("bad table");
  psql(db, "DROP TRIGGER IF EXISTS qa_fail_pub ON \"" + table + "\";");
  psql(db, "DROP TRIGGER IF EXISTS qa_fail_commit ON \"" + table + "\";");
  psql(db, "DROP FUNCTION IF EXISTS qa_fail_notes();");
  return { dropped: true, table };
}
// Full canonical fingerprint of one table: every column, every row, one
// deterministic string ordered by full-row text. Byte comparison across
// restarts/upgrades. NULL is explicit; chr(31) separates columns.
export function fingerprintTable(db, table) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) throw new Error("bad table " + table);
  const cols = psql(db, "SELECT string_agg(quote_ident(column_name), ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='" + table + "';");
  if (!cols) throw new Error("no columns for table " + table);
  const names = cols.split(",");
  const sel = names.map((c) => "COALESCE(" + c + "::text, '<NULL>')").join(" || chr(31) || ");
  // Unambiguous wire format: chr(31) separates FIELDS (SQL-level),
  // \\x1e separates RECORDS (psql -R). Embedded newlines in text columns
  // (note bodies, JSON) must never split rows.
  const q = "SELECT (" + sel + ") AS r FROM \"" + table + "\" ORDER BY 1;";
  return docker(["exec", OWN_CONTAINER, "psql", "-U", OWN_USER, "-d", db, "-v", "ON_ERROR_STOP=1", "-t", "-A", "-R", "\x1e", "-c", q], 180000);
}

export function fingerprintDb(db) {
  const tables = tableList(db);
  const fp = {};
  for (const t of tables) fp[t] = { rows: rowCount(db, t), sha: null, sample: "" };
  return { tables, fp };
}