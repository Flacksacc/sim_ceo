// leg2: old physical PG upgrade (needs owned PG + published current API).
// SELF-MANAGED: the runner creates/drops ONLY the exclusive DB; this leg
// owns its API generations (three starts = baseline + TWO actual restarts).
// Genuine 94d16-family baseline from the preserved predecessor artifacts:
//   .tmp/predecessor-complete-primary-20261103-1021.dump (custom format)
//   .tmp/predecessor-complete-primary-20261103-1021-canonical-backup.json
// Flow: assert fresh DB empty -> restore dump into it (exclusive temp path,
// verified cleanup) -> narrow FRAMING fixture (NULL vs literal "<NULL>" vs
// empty, CR/LF/RS/US/control bytes, unicode, trailing spaces; change
// detection; determinism; dropped afterwards) -> DB fingerprint A (full
// field/byte, every family, Postgres-native JSON, NO client trimming or
// unescaped separator framing) -> API gen1 (current upgrade) ->
// fingerprint B + startup-log migration proof -> API gen2/gen3 restarts ->
// fingerprints C/D -> B==C==D exactly; A vs B: every pre-existing table
// byte-identical, ONLY new-table additions allowed (explicit justified
// schema diffs); unknown legacy JobPayload opaque plain string preserved
// read-only, never executed. No old-DB drops, no global docker labels, no
// foreign containers. Exit nonzero on ANY failure.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { makeCtx } from "../helpers/essentials-http.mjs";
import { verifyContainer, tableList, rowCount, fingerprintTable, psql } from "../helpers/essentials-pg.mjs";
import { startOwned, stopOwned, tailOf, waitForHttpOk } from "../helpers/essentials-proc.mjs";

const ctx = makeCtx("leg2");
const ART = process.env.ESS_QA_ARTIFACT_DIR || ".";
const run = "ess2-" + Date.now().toString(36);
const MAIN_TMP = "C:/Users/War/scrach/sim_ceo/.tmp";
const DUMP = process.env.ESS_QA_OLD_DUMP || path.join(MAIN_TMP, "predecessor-complete-primary-20261103-1021.dump");
const CANON = path.join(MAIN_TMP, "predecessor-complete-primary-20261103-1021-canonical-backup.json");
const EXPECT_DUMP_BYTES = 133514;
const EXPECT_DUMP_SHA = ""; // preserved dump has no independently published full sha in result evidence; integrity = byte count + pg_restore internal checksums + family counts vs canonical backup
const EXPECT_CANON_BYTES = 1682326;
const DB = process.env.ESS_QA_DB || "";
const CONN = process.env.ESS_QA_PG_CONN || "";
const API_DLL = process.env.ESS_QA_API_DLL || "";
const PUBDIR = process.env.ESS_QA_PUBLISH_DIR || ".";
const API = process.env.QA_API || "http://127.0.0.1:5142";
const writeArt = (name, obj) => {
  try { fs.writeFileSync(path.join(ART, name), typeof obj === "string" ? obj : JSON.stringify(obj, null, 2)); }
  catch (e) { ctx.ok("artifact-" + name, false, String(e).slice(0, 160)); }
};
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
// Canonical value encoding for name-aligned comparison: JSON.stringify is
// injective per JSON value (null -> "null", strings stay quoted, numbers
// bare), so NULL vs "<NULL>" vs "" vs 0 can never collide.
const normVal = (v) => JSON.stringify(v);
const stripQ = (x) => String(x || "").replace(/^"|"$/g, "");
const keyOf = (o) => String(o["Id"] ?? o["id"] ?? o["ID"] ?? Object.values(o)[0]);
function docker(args, timeoutMs = 60000) {
  return execFileSync("docker", args, { windowsHide: true, timeout: timeoutMs, stdio: "pipe" }).toString();
}

let apiHandles = [];
async function stopAllApis() {
  const errs = [];
  for (const h of apiHandles.splice(0)) {
    const r = await stopOwned(h.h, h.label, h.out, h.err);
    if (!r.ok) errs.push(r.note);
  }
  return errs;
}

try {
  ctx.ok("env-db", !!DB && /^essentials_[a-z0-9_]+$/.test(DB), "ESS_QA_DB=" + DB);
  ctx.ok("env-conn", !!CONN, "ESS_QA_PG_CONN missing");
  ctx.ok("env-api-dll", !!API_DLL && fs.existsSync(API_DLL), "ESS_QA_API_DLL=" + API_DLL);
  if (!DB || !CONN || !API_DLL) throw new Error("leg2 env missing");

  verifyContainer();
  ctx.ok("container-verified", true, "owned 14bcfcf7 running");

  // --- preserved baseline artifacts (read-only, never mutated) ---
  ctx.ok("dump-present", fs.existsSync(DUMP), DUMP);
  const dumpBytes = fs.readFileSync(DUMP);
  ctx.ok("dump-bytes", dumpBytes.length === EXPECT_DUMP_BYTES, "bytes=" + dumpBytes.length);
  const dumpSha = sha256(dumpBytes);
  ctx.ok("dump-sha-recorded", /^[0-9a-f]{64}$/.test(dumpSha), "sha=" + dumpSha);
  console.log("  info dump-sha256=" + dumpSha);
  ctx.ok("canon-present", fs.existsSync(CANON), CANON);
  const canonStat = fs.statSync(CANON);
  ctx.ok("canon-bytes", canonStat.size === EXPECT_CANON_BYTES, "bytes=" + canonStat.size);
  const canonDoc = JSON.parse(fs.readFileSync(CANON, "utf8"));
  const canonSnap = typeof canonDoc.snapshot === "string" ? JSON.parse(canonDoc.snapshot) : canonDoc.snapshot || canonDoc;
  ctx.ok("canon-shape", !!canonSnap && (canonSnap.version === 4 || !!canonSnap.boards), "version=" + canonSnap.version);
  writeArt("baseline-refs.json", { dump: DUMP, dumpBytes: dumpBytes.length, dumpSha, canonBytes: canonStat.size, canonHash: canonDoc.hash || "", snapshotVersion: canonSnap.version || null });

  // --- fresh DB must be empty before restore ---
  const preTables = tableList(DB).filter((t) => !t.startsWith("pg_") && t !== "spatial_ref_sys");
  ctx.ok("db-empty-before-restore", preTables.length === 0, "tables=" + preTables.join(",").slice(0, 200));

  // --- restore dump into the EXCLUSIVE db (never the preserved source) ---
  {
    const stamp = Date.now().toString(36) + "-" + crypto.randomUUID().slice(0, 8);
    const dest = "/tmp/ess-restore-" + stamp + ".dump";
    let copyErr = null, restoreErr = null, cleanupErr = null;
    try { docker(["exec", "simceo-integration-qa-pg", "test", "!", "-e", dest], 30000); }
    catch { throw new Error("refusing: temp dump path exists in owned container: " + dest); }
    try { docker(["cp", DUMP, "simceo-integration-qa-pg:" + dest], 180000); }
    catch (e) { copyErr = String((e && e.message) || e).split("\n")[0]; }
    if (copyErr === null) {
      try { docker(["exec", "simceo-integration-qa-pg", "pg_restore", "-U", "simceo", "-d", DB, dest], 300000); }
      catch (e) { restoreErr = String((e && e.message) || e).split("\n")[0]; }
    }
    try {
      docker(["exec", "simceo-integration-qa-pg", "rm", "-f", dest], 60000);
      docker(["exec", "simceo-integration-qa-pg", "test", "!", "-e", dest], 30000);
    } catch (e) { cleanupErr = String((e && e.message) || e).split("\n")[0]; }
    if (copyErr !== null) {
      if (cleanupErr !== null) { ctx.ok("restore-copy", false, "copy=[" + copyErr.slice(0, 200) + "] cleanup=[" + cleanupErr.slice(0, 200) + "]"); throw new Error("restore copy failed"); }
      ctx.ok("restore-copy", false, copyErr.slice(0, 300)); throw new Error("restore copy failed");
    }
    if (restoreErr !== null) {
      if (cleanupErr !== null) { ctx.ok("restore-pg", false, "restore=[" + restoreErr.slice(0, 200) + "] cleanup=[" + cleanupErr.slice(0, 200) + "]"); throw new Error("pg_restore failed"); }
      ctx.ok("restore-pg", false, restoreErr.slice(0, 300)); throw new Error("pg_restore failed");
    }
    if (cleanupErr !== null) { ctx.ok("restore-cleanup", false, cleanupErr.slice(0, 200)); throw new Error("temp dump not removed"); }
    ctx.ok("restore-ok", true, "dump restored into " + DB);
  }

  const colNames = (t) => psql(DB, "SELECT string_agg(quote_ident(column_name), ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema='public' AND table_name='" + t + "';").split(",");
  // Postgres-native JSON fingerprint: exact JSON text Postgres emitted, one
  // entry per table with parsed rows for name-aligned analysis. No Split,
  // Trim, Replace or separator framing is applied to any field value.
  const snapFingerprint = (tag) => {
    const tables = tableList(DB);
    const out = {};
    for (const t of tables) {
      const n = rowCount(DB, t);
      const raw = fingerprintTable(DB, t);
      let parsed = null;
      try { parsed = JSON.parse(raw); }
      catch (e) { ctx.ok("fingerprint-json-" + t, false, "not JSON: " + String(e).slice(0, 120)); throw new Error("fingerprint not JSON for " + t); }
      ctx.ok("fingerprint-json-" + t, Array.isArray(parsed), "rows=" + (Array.isArray(parsed) ? parsed.length : "?"));
      if (!Array.isArray(parsed)) throw new Error("fingerprint not array for " + t);
      ctx.ok("fingerprint-count-" + t, parsed.length === n, "count=" + n + " json=" + parsed.length);
      out[t] = { rows: n, sha: sha256(raw), json: raw, parsed, cols: colNames(t) };
      if (tag) writeArt("fp-" + tag + "-" + t + ".sha", out[t].sha + " rows=" + n + " cols=" + out[t].cols.length + "\n");
    }
    return out;
  };
  // --- narrow discriminating framing fixture: proves the comparator is byte
  // proof (not a weak hash over lossy framing). Runs BEFORE fingerprint A on
  // a dedicated probe table, then DROPPED so upgrade fingerprints stay clean.
  // Cases: SQL NULL vs the literal text "<NULL>" vs empty string, a real
  // CR/LF pair, RS chr(30), US chr(31), trailing spaces, tab, non-ASCII
  // unicode -- plus determinism and real-change detection.
  {
    psql(DB, "CREATE TABLE \"qa_framing_probe\" (\"Id\" integer PRIMARY KEY, \"T\" text);");
    psql(DB, "INSERT INTO \"qa_framing_probe\" (\"Id\", \"T\") VALUES (1, NULL), (2, '<NULL>'), (3, 'a' || chr(13) || chr(10) || 'b' || chr(30) || chr(31) || 'c  '), (4, 'caf' || chr(233) || ' ' || chr(20013) || chr(25991) || chr(9));");
    const raw1 = fingerprintTable(DB, "qa_framing_probe");
    let p1 = null;
    try { p1 = JSON.parse(raw1); } catch (e) { ctx.ok("framing-json", false, String(e).slice(0, 120)); throw new Error("framing fingerprint not JSON"); }
    ctx.ok("framing-rows", Array.isArray(p1) && p1.length === 4, "rows=" + (Array.isArray(p1) ? p1.length : "?"));
    const byId1 = new Map((p1 || []).map((r) => [Number(r["Id"] ?? r["id"]), r]));
    const r1 = byId1.get(1) || {}, r2 = byId1.get(2) || {}, r3 = byId1.get(3) || {}, r4 = byId1.get(4) || {};
    ctx.ok("framing-null-is-null", ("T" in r1) && r1["T"] === null, "id1=" + normVal(r1["T"]));
    ctx.ok("framing-literal-distinct", r2["T"] === "<NULL>", "id2=" + normVal(r2["T"]));
    ctx.ok("framing-controls-preserved", r3["T"] === "a\r\nb\x1e\x1fc  ", "id3=" + normVal(r3["T"]));
    ctx.ok("framing-unicode-tab", r4["T"] === "caf\u00e9 \u4e2d\u6587\t", "id4=" + normVal(r4["T"]));
    writeArt("framing.json", { sha: sha256(raw1), rows: p1 });
    ctx.ok("framing-deterministic", fingerprintTable(DB, "qa_framing_probe") === raw1, "same bytes twice");
    // Real change detection: append one byte to the control-char row.
    psql(DB, "UPDATE \"qa_framing_probe\" SET \"T\" = \"T\" || 'X' WHERE \"Id\" = 3;");
    const raw2 = fingerprintTable(DB, "qa_framing_probe");
    ctx.ok("framing-change-detected", sha256(raw2) !== sha256(raw1), "sha moved on 1-byte change");
    const p2 = JSON.parse(raw2);
    const byId2 = new Map(p2.map((r) => [Number(r["Id"] ?? r["id"]), r]));
    ctx.ok("framing-change-exact-row", (byId2.get(3) || {})["T"] === "a\r\nb\x1e\x1fc  X", "id3=" + normVal((byId2.get(3) || {})["T"]));
    ctx.ok("framing-change-others-intact", normVal((byId2.get(1) || {})["T"]) === "null" && (byId2.get(2) || {})["T"] === "<NULL>" && (byId2.get(4) || {})["T"] === "caf\u00e9 \u4e2d\u6587\t", "other rows byte-identical");
    // NULL -> 'x' and literal -> empty stay distinct from each other and NULL.
    psql(DB, "UPDATE \"qa_framing_probe\" SET \"T\" = 'x' WHERE \"Id\" = 1;");
    psql(DB, "UPDATE \"qa_framing_probe\" SET \"T\" = '' WHERE \"Id\" = 2;");
    const p3 = JSON.parse(fingerprintTable(DB, "qa_framing_probe"));
    const byId3 = new Map(p3.map((r) => [Number(r["Id"] ?? r["id"]), r]));
    ctx.ok("framing-null-to-value", (byId3.get(1) || {})["T"] === "x", "id1=" + normVal((byId3.get(1) || {})["T"]));
    ctx.ok("framing-empty-distinct", (byId3.get(2) || {})["T"] === "" && (byId3.get(2) || {})["T"] !== null, "id2=" + normVal((byId3.get(2) || {})["T"]));
    psql(DB, "DROP TABLE \"qa_framing_probe\";");
    ctx.ok("framing-probe-dropped", !tableList(DB).includes("qa_framing_probe"), "probe removed before fingerprint A");
  }
    // numeric probe: bigint past JS safe integer + large numeric stay exact as raw PG JSON lexemes.
  // Raw text is compared (never JSON.parse numbers, which would round); change detection included.
  {
    psql(DB, "CREATE TABLE qa_numeric_probe (id integer PRIMARY KEY, bi bigint, nm numeric)");
    psql(DB, "INSERT INTO qa_numeric_probe (id, bi, nm) VALUES (1, 9007199254740993, 12345678901234567890.123456789)");
    const rawN = fingerprintTable(DB, "qa_numeric_probe");
    ctx.ok("numeric-raw-bigint", rawN.includes("9007199254740993"), "bigint lexeme exact");
    ctx.ok("numeric-raw-decimal", rawN.includes("12345678901234567890.123456789"), "numeric lexeme exact");
    writeArt("numeric-probe.json", { sha: sha256(rawN) });
    ctx.ok("numeric-deterministic", fingerprintTable(DB, "qa_numeric_probe") === rawN, "same bytes twice");
    psql(DB, "UPDATE qa_numeric_probe SET bi = 9007199254740994 WHERE id = 1");
    const rawN2 = fingerprintTable(DB, "qa_numeric_probe");
    ctx.ok("numeric-change-detected", sha256(rawN2) !== sha256(rawN), "sha moves on one digit change");
    psql(DB, "DROP TABLE qa_numeric_probe");
    ctx.ok("numeric-probe-dropped", true, "probe removed before fingerprint A");
  }
// On byte mismatch: NAME-ALIGNED per-column diff of the first differing
  // rows (max 3) over PARSED JSON values, so migration normalizations are
  // explicit and justifiable. Values compare with null-vs-string-safe
  // encoding (JSON.stringify), never with lossy text splits.
  const diffDetail = (t, a, b) => {
    const colsB = (b.cols || []).map(stripQ);
    const byIdB = new Map();
    for (const o of (b.parsed || [])) byIdB.set(keyOf(o), o);
    const detail = [];
    for (const oa of (a.parsed || [])) {
      const id = keyOf(oa);
      const ob = byIdB.get(id);
      if (!ob) { detail.push({ key: id.slice(0, 60), missingInB: true }); }
      else {
        const changed = [];
        for (const col of new Set([...Object.keys(oa), ...Object.keys(ob)])) {
          if (normVal(oa[col]) !== normVal(ob[col])) changed.push({ col, before: normVal(oa[col]).slice(0, 220), after: normVal(ob[col]).slice(0, 220) });
        }
        if (changed.length > 0) detail.push({ key: id.slice(0, 60), changedCols: changed.map((x) => x.col), changed });
      }
      if (detail.length >= 3) break;
    }
    void colsB;
    writeArt("diff-" + t + ".json", { table: t, rowsA: (a.parsed || []).length, rowsB: (b.parsed || []).length, sample: detail });
    return detail.map((d) => (d.changedCols || []).join(",")).join("|").slice(0, 300);
  };
  // --- fingerprint A: pre-upgrade, every family, full field/byte ---
  const fpA = snapFingerprint("A");
  writeArt("fingerprint-A.json", fpA);
  const jobsTable = Object.keys(fpA).find((t) => /^jobs$/i.test(t)) || "Jobs";
  const voiceTable = Object.keys(fpA).find((t) => /^voiceturns$/i.test(t)) || "VoiceTurns";
  const authTable = Object.keys(fpA).find((t) => /authaccounts|accounts/i.test(t)) || "AuthAccounts";
  ctx.ok("old-jobs-present", (fpA[jobsTable] || { rows: -1 }).rows === 46, jobsTable + "=" + (fpA[jobsTable] || {}).rows);
  ctx.ok("old-voice-present", (fpA[voiceTable] || { rows: -1 }).rows === 46, voiceTable + "=" + (fpA[voiceTable] || {}).rows);
  ctx.ok("old-auth-preserved", (fpA[authTable] || { rows: -1 }).rows === 23, authTable + "=" + (fpA[authTable] || {}).rows);
  // Canonical backup family counts (preserved evidence cross-check).
  const famCount = (v) => (Array.isArray(v) ? v.length : (v && typeof v === "object" ? Object.keys(v).length : 0));
  ctx.ok("canon-boards-79", famCount(canonSnap.boards) === 79, "boards=" + famCount(canonSnap.boards));

  // --- unknown legacy JobPayload: opaque plain string, read-only ---
  let payloadBefore = "";
  {
    const cols = docker(["exec", "simceo-integration-qa-pg", "psql", "-U", "simceo", "-d", DB, "-t", "-A", "-c", "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='" + jobsTable + "';"], 60000).split("\n").map((s) => s.trim()).filter(Boolean);
    ctx.ok("jobs-has-payload", cols.some((c) => /payload/i.test(c)), cols.join(",").slice(0, 200));
    const payCol = cols.find((c) => /payload/i.test(c)) || "payload";
    const idemCol = cols.find((c) => /idempot/i.test(c)) || cols[0];
    const rows = docker(["exec", "simceo-integration-qa-pg", "psql", "-U", "simceo", "-d", DB, "-t", "-A", "-F", "\t", "-c", "SELECT \"" + idemCol + "\", \"" + payCol + "\" FROM \"" + jobsTable + "\" ORDER BY 1;"], 60000).split("\n").filter((l) => l.trim());
    const fix = rows.find((l) => l.includes("pfx-primary202611031021-job-1")) || "";
    ctx.ok("fixture-job-present", !!fix, "rows=" + rows.length);
    payloadBefore = fix.split("\t")[1] || "";
    ctx.ok("payload-opaque-plain-string", payloadBefore.includes("boardId") && !/executed|running/i.test(fix.split("\t")[0]), payloadBefore.slice(0, 160));
    writeArt("job-payload-before.txt", payloadBefore + "\n");
  }

  // --- three API generations (baseline + TWO actual restarts) ---
  const startApi = async (gen) => {
    const out = path.join(ART, "api-gen" + gen + ".log"), err = path.join(ART, "api-gen" + gen + ".err.log");
    const h = startOwned({
      file: "dotnet", args: [API_DLL], cwd: PUBDIR,
      env: { ASPNETCORE_URLS: API, USE_POSTGRES: "1", CONNECTIONSTRINGS__APP: CONN, META_API_BASE: "http://127.0.0.1:5242", META_API_KEY: "qa-dummy" },
      outFile: out, errFile: err,
    });
    apiHandles.push({ h, label: "api-gen" + gen, out, err });
    const r = await waitForHttpOk(API + "/ready", { timeoutMs: 120000 });
    if (!r.ok) { ctx.ok("api-gen" + gen + "-ready", false, r.last); throw new Error("api gen" + gen + " /ready never 200: " + r.last); }
    ctx.ok("api-gen" + gen + "-ready", true, "gen" + gen);
    const b = await (await fetch(API + "/api/backend")).json().catch(() => null);
    ctx.ok("api-gen" + gen + "-postgres", b && b.mode === "postgres", JSON.stringify(b).slice(0, 160));
    return h;
  };
  const stopGen = async (gen) => {
    const h = apiHandles.pop();
    if (!h) return;
    const res = await stopOwned(h.h, h.label, h.out, h.err);
    if (!res.ok) { ctx.ok(h.label + "-stop", false, res.note); throw new Error(h.label + " stop failed: " + res.note); }
    ctx.ok(h.label + "-stopped-eof", true, res.note);
  };

  await startApi(1);
  const fpB = snapFingerprint("B");
  writeArt("fingerprint-B.json", fpB);
  await stopGen(1);
  await startApi(2);
  const fpC = snapFingerprint("C");
  writeArt("fingerprint-C.json", fpC);
  await stopGen(2);
  await startApi(3);
  const fpD = snapFingerprint("D");
  writeArt("fingerprint-D.json", fpD);
  await stopGen(3);

  // Startup migration proof from gen logs (upgrade ran, no fatal).
  for (const gen of [1, 2, 3]) {
    const log = fs.readFileSync(path.join(ART, "api-gen" + gen + ".log"), "utf8");
    const err = fs.readFileSync(path.join(ART, "api-gen" + gen + ".err.log"), "utf8");
    ctx.ok("gen" + gen + "-pg-connected", /POSTGRES: connected\./.test(log), tailOf("x", 1) && log.slice(-400));
    ctx.ok("gen" + gen + "-no-fatal", !/FATAL|MIGRATION FATAL/.test(log + err), (log + "\n" + err).slice(-300));
  }

  // B==C==D exactly (restart stability, every table incl. new ones).
  const tablesBCD = new Set([...Object.keys(fpB), ...Object.keys(fpC), ...Object.keys(fpD)]);
  let stable = true;
  for (const t of tablesBCD) {
    const same = fpB[t] && fpC[t] && fpD[t] && fpB[t].sha === fpC[t].sha && fpB[t].sha === fpD[t].sha && fpB[t].rows === fpC[t].rows && fpB[t].rows === fpD[t].rows;
    if (!same) { stable = false; ctx.ok("restart-stable-" + t, false, "shaB=" + (fpB[t] || {}).sha + " shaC=" + (fpC[t] || {}).sha + " shaD=" + (fpD[t] || {}).sha + " rows=" + (fpB[t] || {}).rows + "/" + (fpC[t] || {}).rows + "/" + (fpD[t] || {}).rows); }
  }
  if (stable) ctx.ok("restart-stable-all", true, "tables=" + tablesBCD.size);

  // A vs B: pre-existing rows byte-identical EXCEPT explicit justified
  // schema evolution: added tables (new features) + added columns whose
  // backfill is a UNIFORM server default across all pre-existing rows (any
  // data-dependent per-row rewrite is a hard FAIL); source collision
  // renumbers only with content preserved + server-owned migrate-version
  // event. Any rewrite of a pre-existing value, any row gain/loss, or any
  // dropped table is a hard FAIL.
  const addedTables = Object.keys(fpB).filter((t) => !fpA[t]);
  writeArt("added-tables.json", addedTables);
  const schemaDiff = { addedTables: [], addedColumns: {}, backfills: {} };
  for (const t of addedTables) schemaDiff.addedTables.push({ table: t, rows: fpB[t].rows });
  let upgradeClean = true;
  for (const t of Object.keys(fpA)) {
    if (!fpB[t]) { upgradeClean = false; ctx.ok("upgrade-preserves-" + t, false, "table missing after upgrade"); continue; }
    if (fpB[t].sha === fpA[t].sha && fpB[t].rows === fpA[t].rows) { ctx.ok("upgrade-preserves-" + t, true, "rows=" + fpB[t].rows + " byte-identical"); continue; }
    if (fpB[t].rows !== fpA[t].rows) { upgradeClean = false; ctx.ok("upgrade-preserves-" + t, false, "ROW COUNT CHANGED A=" + fpA[t].rows + " B=" + fpB[t].rows); continue; }
    const colsA = (fpA[t].cols || []).map(stripQ), colsB = (fpB[t].cols || []).map(stripQ);
    const addedCols = colsB.filter((x) => !colsA.includes(x));
    schemaDiff.addedColumns[t] = addedCols;
    const mapA = new Map((fpA[t].parsed || []).map((o) => [keyOf(o), o]));
    const mapB = new Map((fpB[t].parsed || []).map((o) => [keyOf(o), o]));
    // Uniform-default backfill proof for every added column: the same
    // server default on EVERY pre-existing row, recorded for review.
    const backfillVals = {};
    for (const c of addedCols) backfillVals[c] = new Set();
    for (const ob of mapB.values()) {
      for (const c of addedCols) {
        if (c in ob) backfillVals[c].add(normVal(ob[c]));
      }
    }
    let justified = true, justification = "";
    const changedOldCols = new Set();
    const renumberedSources = [];
    for (const [id, oa] of mapA) {
      const ob = mapB.get(String(id));
      if (!ob) { justified = false; justification = "row lost " + String(id).slice(0, 40); break; }
      for (const col of Object.keys(oa)) {
        if (!colsB.includes(col)) { justified = false; changedOldCols.add("dropped-col:" + col); continue; }
        if (normVal(oa[col]) === normVal(ob[col])) continue;
        if (addedCols.includes(col)) continue;
        // Sources collision renumber: Version may move ONLY with a
        // server-owned migrate-version event AND preserved content bytes.
        if (t === "Sources" && col === "Version") {
          renumberedSources.push({ id, from: oa[col], to: ob[col], a: oa, b: ob });
          continue;
        }
        justified = false;
        changedOldCols.add(col + ":[" + normVal(oa[col]).slice(0, 60) + "]->[" + normVal(ob[col]).slice(0, 60) + "]");
      }
      if (!justified) break;
    }
    if (justified) {
      for (const c of addedCols) {
        const distinct = Array.from(backfillVals[c] || []);
        if (distinct.length === 1) { schemaDiff.backfills[t + "." + c] = distinct[0]; continue; }
        // Justified per-row derivations (documented server migrations, each
        // VERIFIED per row -- never a shape-only pass):
        if (t === "Notes" && c === "RootId") {
          // Chain-root norm: rows whose RootId was empty adopt their own Id.
          let okR = true;
          for (const ob of mapB.values()) { if (normVal(ob[c]) !== normVal(ob["Id"] ?? ob["id"])) { okR = false; break; } }
          if (okR) { schemaDiff.backfills[t + "." + c] = "own-id"; continue; }
          justified = false; justification = "RootId backfill is not own-id for every row"; break;
        }
        if (t === "Sources" && c === "ReviewState") {
          // Faithful projection of the row's OWN pre-existing Approved flag.
          let okR = true;
          for (const [id, ob] of mapB) {
            const oa = mapA.get(String(id));
            const want = (oa && oa["Approved"] === true) ? "approved" : "pending";
            if (normVal(ob[c]) !== normVal(want)) { okR = false; break; }
          }
          if (okR) { schemaDiff.backfills[t + "." + c] = "approved-flag-projection"; continue; }
          justified = false; justification = "ReviewState backfill mismatches own Approved flag"; break;
        }
        if (t === "Sources" && c === "FamilyKey") {
          // Canonical family identity FamilyKeyFor(board,scope,meeting,
          // origin,file) recomputed per row from the row's OWN columns.
          const normFn = (name) => { let s = String(name ?? "").trim(); const ix = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\")); if (ix >= 0) s = s.slice(ix + 1); return s.trim().toLowerCase(); };
          let okR = true, checked = 0;
          for (const [id, ob] of mapB) {
            const oa = mapA.get(String(id));
            if (!oa) { okR = false; break; }
            const isWiki = String(oa["Origin"] ?? "").trim().toLowerCase() === "wiki";
            if (isWiki) {
              if (normVal(ob[c]) !== normVal("")) { okR = false; justification = "wiki FamilyKey must stay default on " + String(id).slice(0, 8); break; }
              checked++; continue;
            }
            const bid = String(oa["BoardId"] ?? oa["boardId"]).replace(/-/g, "").toLowerCase();
            const sc = (oa["Scope"] ?? oa["scope"]) === "meeting" ? "meeting" : "board";
            const midRaw = oa["MeetingId"] ?? oa["meetingId"];
            const mid = (sc === "meeting" && midRaw != null) ? String(midRaw).replace(/-/g, "").toLowerCase() : "-";
            const orgRaw = String(oa["Origin"] ?? oa["origin"] ?? "");
            const org = /^\s*$/.test(orgRaw) ? "upload" : orgRaw.trim().toLowerCase();
            const want = bid + "|" + sc + "|" + mid + "|" + org + "|" + normFn(oa["FileName"] ?? oa["fileName"]);
            if (normVal(ob[c]) !== normVal(want)) { okR = false; justification = "FamilyKey mismatch on " + String(id).slice(0, 8); break; }
            checked++;
          }
          if (okR && checked > 0) { schemaDiff.backfills[t + "." + c] = "canonical-family-key x" + checked; continue; }
          if (!okR) { justified = false; break; }
          justified = false; justification = "no rows checked for FamilyKey"; break;
        }
        if (t === "Drafts" && c === "ReviewToken") {
          // Deterministic legacy derivation HashOf("legacy-review:"+idN+":"+
          // version+":"+hash) -- recomputed per row and compared exactly.
          let okR = true, checked = 0;
          for (const [id, ob] of mapB) {
            const oa = mapA.get(String(id));
            if (!oa) { okR = false; break; }
            const oid = String(oa["Id"] ?? oa["id"]);
            const idN = oid.replace(/-/g, "").toLowerCase();
            const want = sha256("legacy-review:" + idN + ":" + String(oa["Version"] ?? oa["version"]) + ":" + String(oa["Hash"] ?? oa["hash"] ?? "")).slice(0, 16);
            if (normVal(ob[c]) !== normVal(want)) { okR = false; justification = "ReviewToken mismatch on " + oid.slice(0, 8); break; }
            checked++;
          }
          if (okR && checked > 0) { schemaDiff.backfills[t + "." + c] = "legacy-review-hash x" + checked; continue; }
          if (!okR) { justified = false; break; }
          justified = false; justification = "no rows checked for ReviewToken"; break;
        }
        justified = false; justification = "added-col " + c + " has " + distinct.length + " distinct backfills (not a uniform server default): " + distinct.slice(0, 3).join(" | ").slice(0, 200); break;
      }
    }
    // Validate renumbered sources: content preserved + migrate-version event.
    if (justified && renumberedSources.length > 0) {
      let evRows = [];
      try {
        evRows = psql(DB, "SELECT \"SourceId\", \"Action\", \"Detail\" FROM \"SourceEvents\";").split("\n").filter((l) => l.trim().length > 0);
      } catch (e) { justified = false; justification = "cannot read SourceEvents: " + String(e).slice(0, 120); }
      for (const r of renumberedSources) {
        const sameOrig = normVal(r.a["Original"]) === normVal(r.b["Original"]);
        const sameHash = normVal(r.a["ContentHash"]) === normVal(r.b["ContentHash"]);
        const want = "v" + String(r.from) + "->v" + String(r.to);
        const hasEv = evRows.some((l) => l.includes(r.id) && /migrate-version/i.test(l) && l.includes(want));
        if (!sameOrig) { justified = false; justification = "renumber " + r.id.slice(0, 8) + " content bytes changed"; break; }
        if (!hasEv) { justified = false; justification = "renumber " + r.id.slice(0, 8) + " missing migrate-version " + want + " (hashRepair=" + (!sameHash) + ")"; break; }
      }
      if (justified) schemaDiff.backfills[t + ".renumbered"] = renumberedSources.map((r) => ({ id: r.id, from: r.from, to: r.to }));
    }
    if (justified) {
      ctx.ok("upgrade-schema-evolution-" + t, true, "rows=" + fpB[t].rows + " addedCols=[" + addedCols.join(",") + "]");
      try {
        const detail = diffDetail(t, fpA[t], fpB[t]);
        schemaDiff.backfills[t] = detail;
      } catch (e) { schemaDiff.backfills[t] = "detail-failed:" + String(e).slice(0, 120); }
    } else {
      upgradeClean = false;
      ctx.ok("upgrade-preserves-" + t, false, "PRE-EXISTING DATA REWRITTEN: " + (justification || Array.from(changedOldCols).join(";").slice(0, 300)));
    }
  }
  if (upgradeClean) ctx.ok("upgrade-preserves-all-old", true, "old tables=" + Object.keys(fpA).length + " added=" + addedTables.length);
  ctx.ok("upgrade-adds-tables", addedTables.length > 0, "added=" + addedTables.join(",").slice(0, 300));
  writeArt("schema-diff.json", schemaDiff);
  // Job payload still verbatim + never executed across all gens.
  {
    const cols = docker(["exec", "simceo-integration-qa-pg", "psql", "-U", "simceo", "-d", DB, "-t", "-A", "-c", "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='" + jobsTable + "';"], 60000).split("\n").map((s) => s.trim()).filter(Boolean);
    const payCol = cols.find((c) => /payload/i.test(c)) || "payload";
    const idemCol = cols.find((c) => /idempot/i.test(c)) || cols[0];
    const stateCol = cols.find((c) => /state/i.test(c)) || cols[0];
    const rows = docker(["exec", "simceo-integration-qa-pg", "psql", "-U", "simceo", "-d", DB, "-t", "-A", "-F", "\t", "-c", "SELECT \"" + idemCol + "\", \"" + payCol + "\", \"" + stateCol + "\" FROM \"" + jobsTable + "\" ORDER BY 1;"], 60000).split("\n").filter((l) => l.trim());
    const fix = rows.find((l) => l.includes("pfx-primary202611031021-job-1")) || "";
    const payloadAfter = fix.split("\t")[1] || "";
    ctx.ok("payload-verbatim-after-upgrade", payloadAfter === payloadBefore, "before=" + payloadBefore.length + " after=" + payloadAfter.length);
    ctx.ok("job-never-executed", /pending|failed|interrupted/.test(fix.split("\t")[2] || "") && !/running|completed|executing/.test(fix.split("\t")[2] || ""), (fix.split("\t")[2] || "").slice(0, 120));
    writeArt("job-payload-after.txt", payloadAfter + "\n");
  }
} catch (e) {
  ctx.ok("leg2-fatal", false, String((e && e.message) || e).slice(0, 400));
} finally {
  const errs = await stopAllApis();
  for (const m of errs) ctx.ok("leg2-api-cleanup", false, m);
  if (errs.length === 0 && apiHandles.length === 0) ctx.ok("leg2-children-cleaned", true, "all API generations stopped, stdio EOF observed");
}

process.exit(ctx.verdict());
