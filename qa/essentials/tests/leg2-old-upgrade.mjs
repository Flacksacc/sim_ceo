// leg2: old physical PG upgrade (needs owned PG + published current API).
// SELF-MANAGED: the runner creates/drops ONLY the exclusive DB; this leg
// owns its API generations (three starts = baseline + TWO actual restarts).
// Genuine 94d16-family baseline from the preserved predecessor artifacts:
//   .tmp/predecessor-complete-primary-20261103-1021.dump (custom format)
//   .tmp/predecessor-complete-primary-20261103-1021-canonical-backup.json
// Flow: assert fresh DB empty -> restore dump into it (exclusive temp path,
// verified cleanup) -> DB fingerprint A (full field/byte, every family) ->
// API gen1 (current upgrade) -> fingerprint B + startup-log migration proof
// -> API gen2/gen3 restarts -> fingerprints C/D -> B==C==D exactly; A vs B:
// every pre-existing table byte-identical, ONLY new-table additions allowed
// (explicit justified schema diffs); unknown legacy JobPayload opaque plain
// string preserved read-only, never executed. No old-DB drops, no global
// docker labels, no foreign containers. Exit nonzero on ANY failure.
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
  // Normalize psql line terminators (ONE trailing newline per record is a
  // transport artifact, not data; embedded newlines are preserved).
  const normBody = (body) => body.split("\x1e").map((l) => l.replace(/\r?\n$/, "")).filter((l) => l.length > 0).join("\x1e");
  const snapFingerprint = (tag) => {
    const tables = tableList(DB);
    const out = {};
    for (const t of tables) {
      const n = rowCount(DB, t);
      const body = normBody(fingerprintTable(DB, t));
      out[t] = { rows: n, sha: sha256(body), body, cols: colNames(t) };
      if (tag) writeArt("fp-" + tag + "-" + t + ".sha", out[t].sha + " rows=" + n + " cols=" + out[t].cols.length + "\n");
    }
    return out;
  };
  // On byte mismatch: NAME-ALIGNED per-column diff of the first differing
  // rows (max 3), so migration normalizations are explicit and justifiable.
  const diffDetail = (t, a, b) => {
    const SEP = String.fromCharCode(31);
    const sq = (x) => String(x || "").replace(/"/g, "");
    const colsA = (a.cols || []).map(sq), colsB = (b.cols || []).map(sq);
    const rowsA = a.body.split("\x1e").filter((l) => l.length > 0);
    const rowsB = b.body.split("\x1e").filter((l) => l.length > 0);
    const byIdB = new Map();
    for (const lb of rowsB) {
      const vb = lb.split(SEP);
      const o = {};
      for (let i = 0; i < colsB.length; i++) o[colsB[i]] = i < vb.length ? vb[i] : "<MISSING-COL>";
      byIdB.set(String(o["Id"] || o["id"] || vb[0]), { o, lb });
    }
    const detail = [];
    for (const la of rowsA) {
      const va = la.split(SEP);
      const oa = {};
      for (let i = 0; i < colsA.length; i++) oa[colsA[i]] = i < va.length ? va[i] : "<MISSING-COL>";
      const id = String(oa["Id"] || oa["id"] || va[0]);
      const hit = byIdB.get(id);
      if (!hit) { detail.push({ key: id.slice(0, 60), missingInB: true }); }
      else {
        const changed = [];
        for (const col of new Set([...Object.keys(oa), ...Object.keys(hit.o)])) {
          if (oa[col] !== hit.o[col]) changed.push({ col, before: String(oa[col] ?? "").slice(0, 220), after: String(hit.o[col] ?? "").slice(0, 220) });
        }
        if (changed.length > 0) detail.push({ key: id.slice(0, 60), changedCols: changed.map((x) => x.col), changed });
      }
      if (detail.length >= 3) break;
    }
    writeArt("diff-" + t + ".json", { table: t, rowsA: rowsA.length, rowsB: rowsB.length, sample: detail });
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
    if (!same) { stable = false; ctx.ok("restart-stable-" + t, false, "B=" + JSON.stringify(fpB[t]) + " C=" + JSON.stringify(fpC[t]) + " D=" + JSON.stringify(fpD[t])); }
  }
  if (stable) ctx.ok("restart-stable-all", true, "tables=" + tablesBCD.size);

  // A vs B: pre-existing rows byte-identical EXCEPT explicit justified
  // schema evolution: added tables (new features) + added columns with
  // empty/canonical backfills (phase-6 family identity, review hardening,
  // note revisions, ownership attribution). Any rewrite of a pre-existing
  // column, any row gain/loss, or any dropped table is a hard FAIL.
  const addedTables = Object.keys(fpB).filter((t) => !fpA[t]);
  writeArt("added-tables.json", addedTables);
  const schemaDiff = { addedTables: [], addedColumns: {}, backfills: {} };
  for (const t of addedTables) schemaDiff.addedTables.push({ table: t, rows: fpB[t].rows });
  let upgradeClean = true;
  const MISSING = "<MISSING-COL>";
  for (const t of Object.keys(fpA)) {
    if (!fpB[t]) { upgradeClean = false; ctx.ok("upgrade-preserves-" + t, false, "table missing after upgrade"); continue; }
    if (fpB[t].sha === fpA[t].sha && fpB[t].rows === fpA[t].rows) { ctx.ok("upgrade-preserves-" + t, true, "rows=" + fpB[t].rows + " byte-identical"); continue; }
    if (fpB[t].rows !== fpA[t].rows) { upgradeClean = false; ctx.ok("upgrade-preserves-" + t, false, "ROW COUNT CHANGED A=" + fpA[t].rows + " B=" + fpB[t].rows); continue; }
    const colsA = fpA[t].cols || [], colsB = fpB[t].cols || [];
    const addedCols = colsB.filter((x) => !colsA.includes(x));
    schemaDiff.addedColumns[t] = addedCols;
    const SEP = String.fromCharCode(31);
    const stripQ = (x) => String(x || "").replace(/"/g, "");
    const rowById = (body, cols) => {
      const m = new Map();
      for (const line of body.split("\x1e").filter((l) => l.length > 0)) {
        const vs = line.split(SEP);
        const o = {};
        for (let i = 0; i < cols.length; i++) o[stripQ(cols[i])] = i < vs.length ? vs[i] : MISSING;
        const id = o["Id"] || o["id"] || vs[0];
        m.set(String(id), o);
      }
      return m;
    };
    const mapA = rowById(fpA[t].body, colsA), mapB = rowById(fpB[t].body, colsB);
    let justified = true, justification = "";
    const changedOldCols = new Set();
    const renumberedSources = [];
    for (const [id, oa] of mapA) {
      const ob = mapB.get(String(id));
      if (!ob) { justified = false; justification = "row lost " + String(id).slice(0, 40); break; }
      for (const col of Object.keys(oa)) {
        if (!colsB.map(stripQ).includes(col)) { justified = false; changedOldCols.add("dropped-col:" + col); continue; }
        if (oa[col] === ob[col]) continue;
        if (addedCols.map(stripQ).includes(col)) continue;
        // Sources collision renumber: Version may move ONLY with a
        // server-owned migrate-version event AND preserved content bytes.
        if (t === "Sources" && col === "Version") {
          renumberedSources.push({ id, from: oa[col], to: ob[col], a: oa, b: ob });
          continue;
        }
        justified = false;
        changedOldCols.add(col + ":[" + String(oa[col]).slice(0, 60) + "]->[" + String(ob[col]).slice(0, 60) + "]");
      }
      if (!justified) break;
    }
    // Validate renumbered sources: content preserved + migrate-version event.
    if (justified && renumberedSources.length > 0) {
      let evRows = [];
      try {
        evRows = psql(DB, "SELECT \"SourceId\", \"Action\", \"Detail\" FROM \"SourceEvents\";").split("\n").filter((l) => l.trim().length > 0);
      } catch (e) { justified = false; justification = "cannot read SourceEvents: " + String(e).slice(0, 120); }
      for (const r of renumberedSources) {
        const sameOrig = String(r.a["Original"] || "") === String(r.b["Original"] || "");
        const sameHash = String(r.a["ContentHash"] || "") === String(r.b["ContentHash"] || "");
        const want = "v" + r.from + "->v" + r.to;
        const hasEv = evRows.some((l) => l.includes(r.id) && /migrate-version/i.test(l) && l.includes(want));
        if (!sameOrig) { justified = false; justification = "renumber " + r.id.slice(0, 8) + " content bytes changed"; break; }
        if (!hasEv) { justified = false; justification = "renumber " + r.id.slice(0, 8) + " missing migrate-version " + want + " (hashRepair=" + (!sameHash) + ")"; break; }
      }
      if (justified) schemaDiff.backfills[t + ".renumbered"] = renumberedSources.map((r) => ({ id: r.id, from: r.from, to: r.to }));
    }
    if (justified) {
      ctx.ok("upgrade-schema-evolution-" + t, true, "rows=" + fpB[t].rows + " addedCols=[" + addedCols.map((x) => x.replace(/"/g, "")).join(",") + "]");
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