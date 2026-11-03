import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
const args = process.argv.slice(2);
function arg(n, dflt) { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : dflt; }
const API = arg("--api", "http://127.0.0.1:5140");
const SUITE = arg("--suite", "full");
const EXPECT = arg("--expect", "200");
const ART = arg("--art", "");
const ADMIN = arg("--admin", "ess-backend-qa@example.com");
const ADMINPW = arg("--adminpw", "qa-password-12345-harness");
const USER2 = "ess-backend-qa2@example.com";
const fails = [];
function line(p, c, d) { console.log((c ? "PASS " : "FAIL ") + p + " :: " + (d === undefined ? "" : d)); if (!c) fails.push(p); }
function req(method, path, body, token) {
  return new Promise((resolve) => {
    const u = new URL(API + path);
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const h = {};
    if (data) h["Content-Type"] = "application/json";
    if (token) h["authorization"] = "Bearer " + token;
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: method, headers: h }, (res) => {
      const bu = [];
      res.on("data", (c) => bu.push(c));
      res.on("end", () => {
        const t = Buffer.concat(bu).toString("utf8");
        let j = null;
        try { j = JSON.parse(t); } catch (e) { }
        resolve({ status: res.statusCode, json: j, text: t });
      });
    });
    r.on("error", (e) => resolve({ status: 0, json: null, text: "ERR:" + e.message }));
    if (data) r.write(data);
    r.end();
  });
}
function sha(s) { if (typeof s !== "string") return ""; return crypto.createHash("sha256").update(s, "utf8").digest("hex"); }
function pick(o, a, b) { if (!o) return undefined; if (o[a] !== undefined) return o[a]; return o[b]; }
async function auth(email, pw) {
  let r = await req("POST", "/api/auth/register", { email: email, password: pw });
  if (r.status === 409) r = await req("POST", "/api/auth/login", { email: email, password: pw });
  return r;
}
function art(name, obj) {
  if (!ART) return;
  try { fs.writeFileSync(ART + "/" + name, JSON.stringify(obj, null, 1)); } catch (e) { }
}
async function suiteFull() {
  const h = await req("GET", "/health");
  line("health-200", h.status === 200, h.status);
  const r = await req("GET", "/ready");
  line("ready-200", r.status === 200 && r.json && r.json.store === "postgres", r.status + " " + (r.json ? r.json.store : "?"));
  const be = await req("GET", "/api/backend");
  line("backend-mode", be.status === 200 && be.json, JSON.stringify(be.json));
  art("backend-identity.json", be.json || {});
  const reg = await auth(ADMIN, ADMINPW);
  line("admin-auth", (reg.status === 200 || reg.status === 201) && reg.json && !!reg.json.token, reg.status);
  const T = reg.json ? reg.json.token : null;
  if (!T) { console.log("FATAL no admin token"); process.exit(1); }
  const dg = await req("GET", "/api/admin/diag", undefined, T);
  const dgt = JSON.stringify(dg.json || {});
  line("diag-admin-200", dg.status === 200 && dg.json && dg.json.backendOk === true, dg.status);
  line("diag-redacted", dg.status === 200 && dgt.indexOf("qa-only") < 0 && dgt.indexOf("Password") < 0 && dgt.indexOf("token") < 0 && dgt.indexOf("Password=") < 0, "redact-scan");
  const dgA = await req("GET", "/api/admin/diag");
  line("diag-anon-401", dgA.status === 401, dgA.status);
  const reg2 = await auth(USER2, ADMINPW);
  const T2 = reg2.json ? reg2.json.token : null;
  const dg2 = await req("GET", "/api/admin/diag", undefined, T2);
  line("diag-nonadmin-403", dg2.status === 403, dg2.status);
  const wb = await req("POST", "/api/boards", { name: "ess-backend-work", mission: "m", stage: "s" }, T);
  line("board-work-201", wb.status === 201, wb.status);
  const bid = pick(wb.json, "id", "Id");
  const arc = await req("POST", "/api/boards", { name: "ess-backend-archived", mission: "m", stage: "s" }, T);
  const aid = pick(arc.json, "id", "Id");
  line("board-arch-create", arc.status === 201, arc.status);
  const pa = await req("PATCH", "/api/boards/" + aid, { archived: true }, T);
  line("board-archive-200", pa.status === 200, pa.status);
  const listD = await req("GET", "/api/boards", undefined, T);
  const defIds = (listD.json || []).map((b) => pick(b, "id", "Id"));
  line("archive-default-excluded", !defIds.includes(aid) && defIds.includes(bid), "n=" + defIds.length);
  const listA = await req("GET", "/api/boards?includeArchived=true", undefined, T);
  const allIds = (listA.json || []).map((b) => pick(b, "id", "Id"));
  const archRow = (listA.json || []).find((b) => pick(b, "id", "Id") === aid);
  line("archive-query-included", allIds.includes(aid) && allIds.includes(bid), "n=" + allIds.length);
  line("archive-scoped-dto", !!archRow && pick(archRow, "archived", "Archived") === true, JSON.stringify(archRow).substring(0, 160));
  const listA2 = await req("GET", "/api/boards?includeArchived=true", undefined, T2);
  const all2 = (listA2.json || []).map((b) => pick(b, "id", "Id"));
  line("archive-stranger-blind", !all2.includes(aid) && !all2.includes(bid), "n=" + all2.length);
  const rst = await req("PATCH", "/api/boards/" + aid, { archived: false }, T);
  line("archive-restore-200", rst.status === 200, rst.status);
  const l1 = await req("POST", "/api/boards/" + bid + "/lead", { name: "QA Lead", roleLabel: "Board Lead", version: 0 }, T);
  line("lead-save-200", l1.status === 200 && pick(l1.json, "version", "Version") === 1, l1.status);
  const lo = await req("POST", "/api/auth/logout", {}, T);
  line("logout-200", lo.status === 200, lo.status);
  const lExp = await req("POST", "/api/boards/" + bid + "/lead", { name: "QA Lead", roleLabel: "Board Lead", version: 1 }, T);
  line("lead-held-expiry-401", lExp.status === 401, lExp.status);
  const lDenied = await req("POST", "/api/boards/" + bid + "/lead", { name: "X", roleLabel: "Y", version: 1 }, T2);
  line("lead-live-denied-403", lDenied.status === 403, lDenied.status);
  const re = await auth(ADMIN, ADMINPW);
  const T3 = re.json ? re.json.token : T;
  const sp0 = await req("GET", "/api/spending", undefined, T3);
  const sp0cap = sp0.json ? pick(sp0.json, "monthlyCapUsd", "MonthlyCapUsd") : "?";
  const spBad1 = await req("PUT", "/api/spending", { mode: 5 }, T3);
  line("spend-badmode-type-400", spBad1.status === 400, spBad1.status);
  const spBad2 = await req("PUT", "/api/spending", { mode: "blockk" }, T3);
  line("spend-unknown-mode-400", spBad2.status === 400, spBad2.status);
  const spBad3 = await req("PUT", "/api/spending", { monthlyCapUsd: "lots" }, T3);
  line("spend-badcap-400", spBad3.status === 400, spBad3.status);
  const sp1 = await req("GET", "/api/spending", undefined, T3);
  line("spend-rejected-unchanged", JSON.stringify(sp1.json) === JSON.stringify(sp0.json), "before=" + JSON.stringify(sp0cap));
  const spOk = await req("PUT", "/api/spending", { monthlyCapUsd: 123.45, mode: "warn" }, T3);
  line("spend-admin-200", spOk.status === 200 && pick(spOk.json, "monthlyCapUsd", "MonthlyCapUsd") === 123.45, spOk.status);
  const spNull = await req("PUT", "/api/spending", { monthlyCapUsd: null }, T3);
  line("spend-null-clears", spNull.status === 200, spNull.status);
  const ms1 = await req("PUT", "/api/model/settings", { chatModel: 42 }, T3);
  line("model-badtype-400", ms1.status === 400, ms1.status);
  const ms2 = await req("PUT", "/api/model/settings", { chatModel: "nope-model" }, T3);
  line("model-unknown-400", ms2.status === 400, ms2.status);
  const ms3 = await req("PUT", "/api/model/settings", { chatModel: "muse-spark-1.3" }, T3);
  line("model-settings-200", ms3.status === 200, ms3.status);
  const mst = await req("GET", "/api/model/status", undefined, T3);
  line("model-status-durable", mst.status === 200 && pick(mst.json, "chatOverride", "chatOverride") === "muse-spark-1.3", mst.status);
  art("spend-policy.json", spOk.json || {});
  const mt = await req("POST", "/api/boards/" + bid + "/meetings", { title: "smoke meeting" }, T3);
  line("meeting-create", mt.status === 200 || mt.status === 201, mt.status);
  const mtg = pick(mt.json, "id", "Id");
  const mc0 = await req("GET", "/api/models/calls?purpose=model-test&limit=200", undefined, T3);
  const rows0 = mc0.json && mc0.json.rows ? mc0.json.rows : (mc0.json || []);
  const n0 = rows0.length;
  const u0r = await req("GET", "/api/usage?summary=true&limit=200", undefined, T3);
  const u0 = u0r.json && u0r.json.rows ? u0r.json.rows.length : 0;
  const conc = await Promise.all(Array.from({ length: 8 }, () => req("POST", "/api/model/test", {}, T3)));
  const concOk = conc.filter((x) => x.status === 200 || x.status === 502 || x.status === 503).length;
  line("conc-test-all-honest", concOk === 8, conc.map((x) => x.status).join(","));
  const mc1 = await req("GET", "/api/models/calls?purpose=model-test&limit=200", undefined, T3);
  const rows1 = mc1.json && mc1.json.rows ? mc1.json.rows : (mc1.json || []);
  const u1r = await req("GET", "/api/usage?summary=true&limit=200", undefined, T3);
  const u1 = u1r.json && u1r.json.rows ? u1r.json.rows.length : 0;
  const idSet = new Set(rows1.map((x) => pick(x, "id", "Id")));
  const pairOk = rows1.length === n0 + 8 && u1 === u0 + 8;
  line("conc-billed-exactly-8-pairs", pairOk, "calls " + n0 + "->" + rows1.length + " usage " + u0 + "->" + u1);
  art("ledger-conc.json", { before: { calls: n0, usage: u0 }, after: { calls: rows1.length, usage: u1 } });
  const bk = await req("GET", "/api/backup", undefined, T3);
  if (bk.status !== 200 || !bk.json || typeof bk.json.snapshot !== "string") {
    line("backup-export-200", false, bk.status);
    console.log("SMOKE-FULL-FAIL " + fails.length + " :: " + fails.join(","));
    process.exit(1);
  }
  line("backup-export-200", true, bk.status);
  const snap = bk.json.snapshot;
  line("backup-hash-exact", sha(snap) === bk.json.hash, "hash-match");
  art("export-full.json", { bytes: snap.length, hash: bk.json.hash });
  const badRoot = await req("POST", "/api/backup/restore", { snapshot: "[1,2]", hash: sha("[1,2]") }, T3);
  line("restore-arrayroot-400", badRoot.status === 400, badRoot.status);
  const badVer = JSON.parse(snap);
  badVer.version = "4";
  const badVerS = JSON.stringify(badVer);
  const bv = await req("POST", "/api/backup/restore", { snapshot: badVerS, hash: sha(badVerS) }, T3);
  line("restore-wrongtype-version-400", bv.status === 400, bv.status);
  const own = await req("POST", "/api/backup/restore", { snapshot: snap, hash: bk.json.hash }, T3);
  line("restore-own-200", own.status === 200, own.status + " " + JSON.stringify(own.json));
  const bg = await req("GET", "/api/boards/" + bid, undefined, T3);
  line("restore-owner-preserved", bg.status === 200 && pick(bg.json, "ownerKey", "OwnerKey") === ADMIN, bg.status);
  const bk2 = await req("GET", "/api/backup", undefined, T3);
  const snap2 = bk2.json ? bk2.json.snapshot : "";
  const norm = (s) => { try { const o = JSON.parse(s); delete o.at; (o.meetings || []).forEach((m) => { const k = m.Generation !== undefined ? "Generation" : "generation"; if (m[k] !== undefined) m[k] = 0; }); return JSON.stringify(o); } catch (e) { return ""; } };
  line("restore-roundtrip-bytes", typeof snap2 === "string" && sha(norm(snap2)) === sha(norm(snap)), "len " + (snap2 || "").length);
  const intr = JSON.parse(snap);
  const bi = (intr.boards || []);
  if (bi.length > 0) { bi[0].OwnerKey = "intruder@example.com"; bi[0].ownerKey = "intruder@example.com"; bi[0].AccessEnforced = true; bi[0].accessEnforced = true; }
  const unkId = "11111111-2222-4333-8444-555555555555";
  intr.jobs = (intr.jobs || []).concat([{ id: unkId, kind: "mystery-legacy", state: "pending", payload: "", attempts: 0, error: "", idempotencyKey: "unk-1", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }]);
  const intrS = JSON.stringify(intr);
  const ir = await req("POST", "/api/backup/restore", { snapshot: intrS, hash: sha(intrS) }, T3);
  line("restore-intruder-owner-ignored", ir.status === 200, ir.status);
  const bg2 = await req("GET", "/api/boards/" + bid, undefined, T3);
  line("restore-owner-still-admin", bg2.status === 200 && pick(bg2.json, "ownerKey", "OwnerKey") === ADMIN, bg2.status);
  const uj = await req("GET", "/api/jobs/" + unkId, undefined, T3);
  line("unknownkind-job-readable", uj.status === 200, uj.status);
  const ux = await req("POST", "/api/jobs/" + unkId + "/execute", {}, T3);
  line("unknownkind-execute-422", ux.status === 422, ux.status);
  console.log(fails.length === 0 ? "SMOKE-FULL-PASS" : "SMOKE-FULL-FAIL " + fails.length + " :: " + fails.join(","));
  process.exit(fails.length === 0 ? 0 : 1);
}
async function suiteUpg() {
  const st = await req("GET", "/api/auth/status");
  const fixtureAdmin = st.json && st.json.admin ? st.json.admin : "";
  line("upg-status-200", st.status === 200, st.status);
  line("upg-fixture-admin-known", typeof fixtureAdmin === "string" && fixtureAdmin.indexOf("@") > 0, fixtureAdmin);
  const FADMINPW = arg("--fixturepw", "qa-dummy-password-123");
  const lg = await req("POST", "/api/auth/login", { email: fixtureAdmin, password: FADMINPW });
  line("upg-fixture-admin-login", (lg.status === 200) && lg.json && !!lg.json.token, lg.status);
  const T = lg.json ? lg.json.token : null;
  if (!T) { console.log("FATAL no fixture admin token"); process.exit(1); }
  const r = await req("GET", "/ready");
  line("upg-ready-200", r.status === 200 && r.json && r.json.store === "postgres", r.status);
  const dg = await req("GET", "/api/admin/diag", undefined, T);
  line("upg-diag-admin-200", dg.status === 200 && dg.json && dg.json.backendOk === true, dg.status);
  const dgt = JSON.stringify(dg.json || {});
  line("upg-diag-redacted", dg.status === 200 && dgt.indexOf("qa-only") < 0 && dgt.indexOf("Password") < 0 && dgt.indexOf("token") < 0, "redact-scan");
  const dgA = await req("GET", "/api/admin/diag");
  line("upg-diag-anon-401", dgA.status === 401, dgA.status);
  const bk = await req("GET", "/api/backup", undefined, T);
  if (bk.status !== 200 || !bk.json || typeof bk.json.snapshot !== "string") {
    line("upg-backup-export-200", false, bk.status);
    console.log("SMOKE-UPG-FAIL " + fails.length);
    process.exit(1);
  }
  line("upg-backup-export-200", true, bk.status);
  const snap = bk.json.snapshot;
  line("upg-backup-hash-exact", sha(snap) === bk.json.hash, "hash-match");
  let parsed = null;
  try { parsed = JSON.parse(snap); } catch (e) { }
  const counts = parsed ? { boards: (parsed.boards || []).length, meetings: (parsed.meetings || []).length, messages: Object.values(parsed.messages || {}).reduce((a, m) => a + m.length, 0), notes: (parsed.notes || []).length, roster: (parsed.roster || []).length, advisors: (parsed.advisors || []).length, images: (parsed.images || []).length, version: parsed.version } : {};
  line("upg-export-shape", !!parsed && parsed.version === 4, JSON.stringify(counts));
  art("upg-export.json", { bytes: snap.length, hash: bk.json.hash, counts: counts });
  const own = await req("POST", "/api/backup/restore", { snapshot: snap, hash: bk.json.hash }, T);
  line("upg-restore-own-200", own.status === 200, own.status + " " + (own.text || "").substring(0, 300));
  const bk2 = await req("GET", "/api/backup", undefined, T);
  const snap2 = bk2.json ? bk2.json.snapshot : "";
  const norm = (s) => { try { const o = JSON.parse(s); delete o.at; (o.meetings || []).forEach((m) => { const k = m.Generation !== undefined ? "Generation" : "generation"; if (m[k] !== undefined) m[k] = 0; }); return JSON.stringify(o); } catch (e) { return ""; } };
  line("upg-restore-roundtrip-bytes", typeof snap2 === "string" && sha(norm(snap2)) === sha(norm(snap)), "len " + (snap2 || "").length);
  console.log(fails.length === 0 ? "SMOKE-UPG-PASS" : "SMOKE-UPG-FAIL " + fails.length + " :: " + fails.join(","));
  process.exit(fails.length === 0 ? 0 : 1);
}
async function suiteConc() {
  const reg = await auth(ADMIN, ADMINPW);
  const T = reg.json ? reg.json.token : null;
  if (!T) { console.log("FATAL no admin token"); process.exit(1); }
  const mc0 = await req("GET", "/api/models/calls?limit=200", undefined, T);
  const rows0 = mc0.json && mc0.json.rows ? mc0.json.rows : (mc0.json || []);
  const n0 = rows0.length;
  const ids0 = new Set(rows0.map((x) => pick(x, "id", "Id")));
  const u0r = await req("GET", "/api/usage?summary=true&limit=200", undefined, T);
  const u0 = u0r.json && u0r.json.rows ? u0r.json.rows.length : 0;
  const conc = await Promise.all(Array.from({ length: 8 }, () => req("POST", "/api/model/test", {}, T)));
  const concOk = conc.filter((x) => x.status === 200 || x.status === 502 || x.status === 503).length;
  line("conc-all-honest", concOk === 8, conc.map((x) => x.status).join(","));
  const mc1 = await req("GET", "/api/models/calls?limit=200", undefined, T);
  const rows1 = mc1.json && mc1.json.rows ? mc1.json.rows : (mc1.json || []);
  const u1r = await req("GET", "/api/usage?summary=true&limit=200", undefined, T);
  const u1 = u1r.json && u1r.json.rows ? u1r.json.rows.length : 0;
  const newRows = rows1.filter((x) => !ids0.has(pick(x, "id", "Id")));
  line("conc-exactly-8-pairs", rows1.length === n0 + 8 && u1 === u0 + 8 && newRows.length === 8, "calls " + n0 + "->" + rows1.length + " usage " + u0 + "->" + u1);
  const matched = newRows.filter((x) => rows1.some((y) => pick(y, "id", "Id") === pick(x, "id", "Id"))).length;
  line("conc-prior-intact", rows0.every((x) => rows1.some((y) => pick(y, "id", "Id") === pick(x, "id", "Id"))), "prior rows present");
  art("ledger-conc.json", { before: { calls: n0, usage: u0 }, after: { calls: rows1.length, usage: u1 } });
  console.log(fails.length === 0 ? "SMOKE-CONC-PASS" : "SMOKE-CONC-FAIL " + fails.length + " :: " + fails.join(","));
  process.exit(fails.length === 0 ? 0 : 1);
}
async function suiteSpendfault() {
  const reg = await auth(ADMIN, ADMINPW);
  const T = reg.json ? reg.json.token : null;
  if (!T) { console.log("FATAL no admin token"); process.exit(1); }
  const cap = parseFloat(arg("--cap", "424242"));
  const mode = arg("--mode", "block");
  if (EXPECT === "500") {
    const put = await req("PUT", "/api/spending", { monthlyCapUsd: cap, mode: mode }, T);
    line("spendfault-write-500", put.status === 500, put.status);
  } else {
    const cc = arg("--checkcap", "");
    if (cc !== "") {
      const pre = await req("GET", "/api/spending", undefined, T);
      const preCap = pre.json ? pick(pre.json, "monthlyCapUsd", "MonthlyCapUsd") : "?";
      const preMode = pre.json ? pick(pre.json, "mode", "Mode") : "?";
      line("spendfault-prestate-intact", pre.status === 200 && preCap === parseFloat(cc) && preMode === arg("--checkmode", "block"), pre.status + " cap=" + preCap + " mode=" + preMode);
    }
    const put = await req("PUT", "/api/spending", { monthlyCapUsd: cap, mode: mode }, T);
    line("spendfault-write-200", put.status === 200, put.status);
    const after = await req("GET", "/api/spending", undefined, T);
    line("spendfault-persisted", after.status === 200 && pick(after.json, "monthlyCapUsd", "MonthlyCapUsd") === cap && pick(after.json, "mode", "Mode") === mode, after.status);
  }
  console.log(fails.length === 0 ? "SMOKE-SPFAULT-PASS" : "SMOKE-SPFAULT-FAIL " + fails.length);
  process.exit(fails.length === 0 ? 0 : 1);
}
async function suiteRestorefault() {
  const reg = await auth(ADMIN, ADMINPW);
  const T = reg.json ? reg.json.token : null;
  if (!T) { console.log("FATAL no admin token"); process.exit(1); }
  const s0file = arg("--s0file", "");
  if (EXPECT === "setup") {
    const wb = await req("POST", "/api/boards", { name: "fault-marker", mission: "m", stage: "s" }, T);
    line("rfault-board-201", wb.status === 201, wb.status);
    const bid = pick(wb.json, "id", "Id");
    const mt = await req("POST", "/api/boards/" + bid + "/meetings", { title: "fault meeting" }, T);
    const mid = pick(mt.json, "id", "Id");
    const nt = await req("POST", "/api/meetings/" + mid + "/notes", { title: "fault note", body: "fault body text", kind: "note" }, T);
    line("rfault-note-201", nt.status === 201, nt.status);
    const bk = await req("GET", "/api/backup", undefined, T);
    const snap = bk.json ? bk.json.snapshot : null;
    line("rfault-export-200", bk.status === 200 && typeof snap === "string", bk.status);
    if (typeof snap === "string" && s0file) { try { fs.writeFileSync(s0file, JSON.stringify({ snapshot: snap, hash: bk.json.hash, bid: bid })); } catch (e) { } }
    const own = await req("POST", "/api/backup/restore", { snapshot: snap, hash: bk.json.hash }, T);
    line("rfault-restore-200", own.status === 200, own.status);
    const bk2 = await req("GET", "/api/backup", undefined, T);
    const snap2 = bk2.json ? bk2.json.snapshot : "";
    const norm = (s) => { try { const o = JSON.parse(s); delete o.at; (o.meetings || []).forEach((m) => { const k = m.Generation !== undefined ? "Generation" : "generation"; if (m[k] !== undefined) m[k] = 0; }); return JSON.stringify(o); } catch (e) { return ""; } };
    line("rfault-roundtrip-bytes", typeof snap2 === "string" && sha(norm(snap2)) === sha(norm(snap)), "len " + (snap2 || "").length);
    art("restorefault-summary.json", { bytes: (snap || "").length, hash: sha(snap || "") });
  } else if (EXPECT === "500") {
    let s0 = null;
    try { s0 = JSON.parse(fs.readFileSync(s0file, "utf8")); } catch (e) { }
    if (!s0) { line("rfault-s0-loaded", false, "no s0 file"); process.exit(1); }
    const bad = await req("POST", "/api/backup/restore", { snapshot: s0.snapshot, hash: s0.hash }, T);
    line("rfault-restore-500-honest", bad.status === 500, bad.status + " " + (bad.text || "").substring(0, 120));
    const boards = await req("GET", "/api/boards", undefined, T);
    const ids = (boards.json || []).map((b) => pick(b, "id", "Id"));
    line("rfault-rollback-boards-intact", boards.status === 200 && ids.includes(s0.bid), "boards=" + ids.length);
  } else {
    let s0 = null;
    try { s0 = JSON.parse(fs.readFileSync(s0file, "utf8")); } catch (e) { }
    if (!s0) { line("rfault-s0-loaded", false, "no s0 file"); process.exit(1); }
    const good = await req("POST", "/api/backup/restore", { snapshot: s0.snapshot, hash: s0.hash }, T);
    line("rfault-retry-200", good.status === 200, good.status + " " + (good.text || "").substring(0, 300));
    const bk = await req("GET", "/api/backup", undefined, T);
    const snap = bk.json ? bk.json.snapshot : "";
    const norm = (s) => { try { const o = JSON.parse(s); delete o.at; (o.meetings || []).forEach((m) => { const k = m.Generation !== undefined ? "Generation" : "generation"; if (m[k] !== undefined) m[k] = 0; }); return JSON.stringify(o); } catch (e) { return ""; } };
    line("rfault-retry-bytes", typeof snap === "string" && snap !== "" && sha(norm(snap)) === sha(norm(s0.snapshot)), "export=" + bk.status + " len " + (snap || "").length);
  }
  console.log(fails.length === 0 ? "SMOKE-RFAULT-PASS" : "SMOKE-RFAULT-FAIL " + fails.length + " :: " + fails.join(","));
  process.exit(fails.length === 0 ? 0 : 1);
}
async function suiteRestartcheck() {
  const reg = await auth(ADMIN, ADMINPW);
  const T = reg.json ? reg.json.token : null;
  if (!T) { console.log("FATAL no admin token"); process.exit(1); }
  const mst = await req("GET", "/api/model/status", undefined, T);
  line("restart-model-durable", mst.status === 200 && pick(mst.json, "chatOverride", "chatOverride") === "muse-spark-1.3", mst.status);
  const sp = await req("GET", "/api/spending", undefined, T);
  line("restart-spend-readable", sp.status === 200, sp.status);
  art("restart-policy.json", { model: mst.json || {}, spending: sp.json || {} });
  console.log(fails.length === 0 ? "SMOKE-RSTART-PASS" : "SMOKE-RSTART-FAIL " + fails.length);
  process.exit(fails.length === 0 ? 0 : 1);
}
async function main() {
  if (SUITE === "full") return suiteFull();
  if (SUITE === "upg") return suiteUpg();
  if (SUITE === "conc") return suiteConc();
  if (SUITE === "spendfault") return suiteSpendfault();
  if (SUITE === "restorefault") return suiteRestorefault();
  if (SUITE === "restartcheck") return suiteRestartcheck();
  console.log("unknown suite " + SUITE);
  process.exit(1);
}
main();
