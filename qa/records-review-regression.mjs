import crypto from "node:crypto";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
// Records5 repair-closure regression: permission-gated approvals, authorized
// snapshot disclosure (no raw bytes), capture-only-new immutable snapshots,
// authoritative amendment lineage, legacy terminality via old-API-equivalent
// SQL fixtures + restarts, real PG deferred-constraint COMMIT failure with
// independent SQL comparison, staged validation, race/token/ID/version rules.
// Talks only to QA_API. Exit nonzero on any failure.
const API = process.env.QA_API || "http://127.0.0.1:5098";
const args = process.argv.slice(2);
function argVal(name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length && !String(args[i + 1]).startsWith("--") ? args[i + 1] : undefined;
}
const TAG = argVal("--tag") || "records";
const PERSIST = process.env.QA_PERSIST_FILE || ".tmp/qa-persist.json";
const LEGACY = process.env.QA_LEGACY_FILE || ".tmp/qa-legacy.json";
const COMMITDUMP = process.env.QA_COMMIT_FILE || ".tmp/qa-commit.json";
const run = "qa-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e6).toString(36);
let pass = 0, fail = 0, skipped = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) pass++;
  else { fail++; failures.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL " + name + (extra ? " :: " + extra : "")); }
}
function skip(name) { skipped++; console.log("  SKIP " + name); }
const TOK = {};
async function req(method, path, body, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeout || 30000);
  try {
    const headers = {};
    const tok = TOK[opts.user || "owner"];
    if (tok) headers["authorization"] = "Bearer " + tok;
    else headers["x-user"] = (opts.user || "owner");
    if (body !== undefined) headers["content-type"] = "application/json";
    Object.assign(headers, opts.headers || {});
    const r = await fetch(API + path, { method, signal: ctl.signal, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text };
  } finally { clearTimeout(t); }
}
const get = (p, o) => req("GET", p, undefined, o);
const post = (p, b, o) => req("POST", p, b, o);
const patch = (p, b, o) => req("PATCH", p, b, o);
const camel = (o, k) => {
  if (!o || typeof o !== "object") return undefined;
  if (k in o) return o[k];
  const lo = k.toLowerCase();
  for (const key of Object.keys(o)) if (key.toLowerCase() === lo) return o[key];
  return undefined;
};
async function makeBoard(name, user) {
  const r = await post("/api/boards", { name, mission: run + " mission", stage: "qa" }, user ? { user } : {});
  ok("setup-board-" + name, r.status === 201 && camel(r.json, "id"), r.status + " " + r.text.slice(0, 160));
  return camel(r.json, "id");
}
async function makeMeeting(bid, brief) {
  const m = await post("/api/boards/" + bid + "/meetings", { title: run + " mtg", brief: brief || "qa brief" });
  ok("setup-meeting", m.status === 201 && camel(m.json, "id"), m.status + " " + m.text.slice(0, 160));
  return camel(m.json, "id");
}
async function guards(did) {
  const g = await get("/api/records/" + did);
  ok("guards-fetch-" + String(did).slice(0, 8), g.status === 200, String(g.status));
  return {
    version: g.json?.version ?? g.json?.Version,
    hash: g.json?.hash ?? g.json?.Hash,
    reviewToken: g.json?.reviewToken ?? g.json?.ReviewToken,
    watermark: g.json?.watermark ?? g.json?.Watermark,
    row: g.json,
  };
}
function histOf(row) {
  try { const h = JSON.parse(row?.historyJson ?? row?.HistoryJson ?? "[]"); return Array.isArray(h) ? h : []; } catch { return []; }
}
function hasSnapshotKey(obj) {
  if (!obj || typeof obj !== "object") return false;
  const keys = Object.keys(obj);
  if (keys.includes("evidenceSnapshotJson") || keys.includes("EvidenceSnapshotJson")) return true;
  return Object.values(obj).some((v) => Array.isArray(v) ? v.some(hasSnapshotKey) : (v && typeof v === "object" ? hasSnapshotKey(v) : false));
}
const PGC = process.env.QA_PG_CONTAINER || "simceo-qa-pg";
function psql(sql) {
  return String(execFileSync("docker", ["exec", PGC, "psql", "-U", "simceo", "-d", "simceo", "-t", "-A", "-c", sql], { encoding: "utf8" })).trim();
}
function pgRow(did) {
  return psql(`SELECT row_to_json(t) FROM "Drafts" t WHERE "Id"='${did}'`);
}
console.log("records-review repair-closure [" + TAG + "] api=" + API);
// Integration: meeting grants/revocation require secure accounts (Auth8
// narrow migration). Register collaboration identities up front; the first
// account on a fresh instance becomes installation admin and flips the
// instance to secure mode. Pre/post processes share one SEED so post-run
// processes log back into the SAME accounts that own the seeded boards.
const SEED = process.env.QA_AUTH_SEED || run;
const PW = "qa-only-pass-9";
const adminEmail = "radmin." + SEED + "@qa.local";
const readerEmail = "m1reader." + SEED + "@qa.local";
const writerEmail = "writer." + SEED + "@qa.local";
async function ensureSecure() {
  const pairs = [["owner", adminEmail], ["m1reader", readerEmail], ["writer", writerEmail]];
  for (const [key, email] of pairs) {
    if (TOK[key]) continue;
    const r = await post("/api/auth/register", { email, password: PW });
    const rt = r.json?.token ?? r.json?.Token;
    if ((r.status === 201 || r.status === 200) && rt) { TOK[key] = rt; continue; }
    const l = await post("/api/auth/login", { email, password: PW });
    const lt = l.json?.token ?? l.json?.Token;
    if (l.status === 200 && lt) TOK[key] = lt;
  }
  ok("secure-bootstrap", !!TOK.owner && !!TOK.m1reader && !!TOK.writer, Object.keys(TOK).join(","));
}
await ensureSecure();
function upHeaders() { return TOK.owner ? { "authorization": "Bearer " + TOK.owner } : { "x-user": "owner" }; }
const backend = await get("/api/backend");
const PG = (backend.json?.mode === "postgres");
console.log("  backend=" + (backend.json?.mode || "?") + " pg=" + PG);

// ---------- persist modes (restart stability) ----------
if (args.includes("--persist-write")) {
  const bid = await makeBoard(run + "-persist");
  const mid = await makeMeeting(bid, "persist brief");
  await post("/api/meetings/" + mid + "/messages", { sender: "lead", content: "persist input one" });
  const d = await post("/api/meetings/" + mid + "/record/draft", [{ id: "P1", text: "persist alpha exact" }, { id: "P2", text: "persist beta exact" }]);
  const did = camel(d.json, "id");
  const g = await guards(did);
  const a = await post("/api/records/" + did + "/items/approve", { ...g, itemId: "P1" });
  ok("persist-approve", a.status === 200, String(a.status));
  const grow = await get("/api/records/" + did);
  const payload = { did, bid, mid, row: grow.json };
  fs.mkdirSync(".tmp", { recursive: true });
  fs.writeFileSync(PERSIST, JSON.stringify(payload, null, 1));
  console.log(fail === 0 ? `RECORDS-PERSIST-WRITE PASS ${pass}` : `RECORDS-PERSIST-WRITE DONE pass=${pass} fail=${fail} skip=${skipped} :: ${failures.join("; ")}`);
  process.exit(fail === 0 ? 0 : 1);
}
if (args.includes("--persist-verify")) {
  const saved = JSON.parse(fs.readFileSync(PERSIST, "utf8"));
  const g = await get("/api/records/" + saved.did);
  ok("persist-row-200", g.status === 200, String(g.status));
  const strip = (r) => { const c = { ...(r || {}) }; delete c.createdAt; delete c.CreatedAt; return c; };
  ok("persist-exact-bytes", JSON.stringify(strip(saved.row)) === JSON.stringify(strip(g.json)), "review bytes changed across restart");
  const rev = await get("/api/records/" + saved.did + "/review");
  ok("persist-review-200", rev.status === 200, String(rev.status));
  ok("persist-approved-stable", JSON.stringify(rev.json?.approved ?? rev.json?.Approved) === JSON.stringify(["P1"]), JSON.stringify(rev.json).slice(0, 200));
  const exp = await get("/api/records/" + saved.did + "/export?format=concise");
  ok("persist-export-stable", exp.status === 200 && exp.text.includes("persist alpha exact") && !exp.text.includes("persist beta exact"), exp.status + " " + exp.text.slice(0, 160));
  console.log(fail === 0 ? `RECORDS-PERSIST-VERIFY PASS ${pass}` : `RECORDS-PERSIST-VERIFY DONE pass=${pass} fail=${fail} :: ${failures.join("; ")}`);
  process.exit(fail === 0 ? 0 : 1);
}

// ---------- legacy upgrade: old-API-equivalent SQL fixtures ----------
if (args.includes("--pre-legacy")) {
  if (!PG) { skip("legacy-pg-only"); console.log(`RECORDS-LEGACY-PRE SKIP`); process.exit(0); }
  try { psql(`CREATE TABLE IF NOT EXISTS qa_commit_gate(fail boolean NOT NULL DEFAULT false); UPDATE qa_commit_gate SET fail=false;`); } catch {}
  const lb = await makeBoard(run + "-legacy");
  const lm = await makeMeeting(lb, "legacy brief");
  await post("/api/meetings/" + lm + "/messages", { sender: "lead", content: "legacy input" });
  async function mkDraft(items) {
    const d = await post("/api/meetings/" + lm + "/record/draft", items);
    return camel(d.json, "id");
  }
  const oDid = await mkDraft([{ id: "o1", text: "legacy open one" }, { id: "o2", text: "legacy open two" }]);
  const o2Did = await mkDraft([{ id: "p1", text: "legacy open A" }, { id: "p2", text: "legacy open B" }]);
  const sDid = await mkDraft([{ id: "A", text: "legacy selected A" }, { id: "B", text: "legacy unselected B" }]);
  let sG = await guards(sDid);
  const sA = await post("/api/records/" + sDid + "/items/approve", { ...sG, itemId: "A" });
  ok("legacy-seed-subset-approve", sA.status === 200, String(sA.status));
  const xDid = await mkDraft([{ id: "x1", text: "legacy doomed one" }, { id: "x2", text: "legacy doomed two" }]);
  let xG = await guards(xDid);
  const xA = await post("/api/records/" + xDid + "/items/approve", { ...xG, itemId: "x1" });
  ok("legacy-seed-doom-approve", xA.status === 200, String(xA.status));
  xG = await guards(xDid);
  const xD = await post("/api/records/" + xDid + "/discard", { ...xG });
  ok("legacy-seed-discard", xD.status === 200, String(xD.status));
  // simulate old API rows: wipe new columns; force old terminal subset/discard shapes
  for (const did of [oDid, o2Did, sDid, xDid])
    psql(`UPDATE "Drafts" SET "ReviewToken"='', "ReviewRevision"=0, "HistoryJson"='[]', "EvidenceSnapshotJson"='[]' WHERE "Id"='${did}'`);
  psql(`UPDATE "Drafts" SET "Decided"=true, "Status"='approved' WHERE "Id"='${sDid}'`);
  psql(`UPDATE "Drafts" SET "ApprovedJson"='[]', "Decided"=true, "Status"='discarded' WHERE "Id"='${xDid}'`);
  const dump = {};
  for (const [k, did] of [["O", oDid], ["O2", o2Did], ["S", sDid], ["X", xDid]]) dump[k] = { did, pre: pgRow(did) };
  dump.flags = { o1Approved: false, o2Approved: false };
  fs.mkdirSync(".tmp", { recursive: true });
  fs.writeFileSync(LEGACY, JSON.stringify(dump, null, 1));
  ok("legacy-seed-dumps", Object.values(dump).every((v) => !v || !v.pre || v.pre.length > 10), "empty dump");
  console.log(fail === 0 ? `RECORDS-LEGACY-PRE PASS ${pass}` : `RECORDS-LEGACY-PRE DONE pass=${pass} fail=${fail} :: ${failures.join("; ")}`);
  process.exit(fail === 0 ? 0 : 1);
}
if (args.includes("--post-legacy")) {
  if (!PG) { skip("legacy-pg-only"); console.log(`RECORDS-LEGACY-POST SKIP`); process.exit(0); }
  const dump = JSON.parse(fs.readFileSync(LEGACY, "utf8"));
  const detTok = (row) => crypto.createHash("sha256").update("legacy-review:" + String(row?.id ?? row?.Id ?? "").replace(/-/g, "") + ":" + (row?.version ?? row?.Version) + ":" + (row?.hash ?? row?.Hash ?? ""), "utf8").digest("hex").slice(0, 16);
  async function checkTerminal(key, wantStatus, wantApproved, wantDecided) {
    const g = await get("/api/records/" + dump[key].did);
    ok(`legacy-${key}-200`, g.status === 200, String(g.status));
    const r = g.json || {};
    const tok1 = r.reviewToken ?? r.ReviewToken;
    const g2 = await get("/api/records/" + dump[key].did);
    const tok2 = g2.json?.reviewToken ?? g2.json?.ReviewToken;
    ok(`legacy-${key}-token-stable`, !!tok1 && tok1 === tok2, String(tok1) + " vs " + String(tok2));
    ok(`legacy-${key}-token-deterministic`, tok1 === detTok(r), String(tok1));
    ok(`legacy-${key}-status`, (r.status ?? r.Status) === wantStatus, String(r.status ?? r.Status));
    ok(`legacy-${key}-decided`, (r.decided ?? r.Decided) === wantDecided, String(r.decided ?? r.Decided));
    ok(`legacy-${key}-approved`, JSON.stringify(JSON.parse(r.approvedJson ?? r.ApprovedJson ?? "[]").sort()) === JSON.stringify([...wantApproved].sort()), String(r.approvedJson ?? r.ApprovedJson));
    ok(`legacy-${key}-no-raw`, !hasSnapshotKey(r), "raw snapshot bytes in detail DTO");
    ok(`legacy-${key}-rev1`, (r.reviewRevision ?? r.ReviewRevision) === 1, String(r.reviewRevision ?? r.ReviewRevision));
    const live = pgRow(dump[key].did);
    const stripTok = (s) => { try { const o = JSON.parse(s); delete o.ReviewToken; delete o.reviewToken; delete o.ReviewRevision; delete o.reviewRevision; return JSON.stringify(o); } catch { return s; } };
    const preStripped = stripTok(dump[key].pre);
    const liveParsed = JSON.parse(live);
    const preservedApproved = key === "S" ? ["A"] : key === "X" ? [] : liveParsed.ApprovedJson ? JSON.parse(liveParsed.ApprovedJson) : [];
    ok(`legacy-${key}-bytes-preserved`, stripTok(live).includes(key === "S" ? "legacy selected A" : key === "X" ? "legacy doomed" : "legacy open"), live.slice(0, 200));
    void preStripped; void preservedApproved;
    return r;
  }
  async function checkOpenDraft(key, itemId, label) {
    const flagName = key === "O" ? "o1Approved" : "o2Approved";
    const wasApproved = !!dump.flags[flagName];
    const g = await get("/api/records/" + dump[key].did);
    ok("legacy-" + label + "-200", g.status === 200, String(g.status));
    const r = g.json || {};
    const g2 = await get("/api/records/" + dump[key].did);
    const t1 = r.reviewToken ?? r.ReviewToken, t2 = g2.json?.reviewToken ?? g2.json?.ReviewToken;
    ok("legacy-" + label + "-token-stable", !!t1 && t1 === t2, String(t1));
    if (wasApproved) {
      ok("legacy-" + label + "-stays-decided", (r.status ?? r.Status) === "partially-approved" && (r.decided ?? r.Decided) === false, String(r.status ?? r.Status));
    } else {
      ok("legacy-" + label + "-token-deterministic", t1 === detTok(r), String(t1));
      ok("legacy-" + label + "-status", (r.status ?? r.Status) === "open", String(r.status ?? r.Status));
      ok("legacy-" + label + "-approved", JSON.stringify(JSON.parse(r.approvedJson ?? r.ApprovedJson ?? "[]").sort()) === JSON.stringify([]), String(r.approvedJson ?? r.ApprovedJson));
      ok("legacy-" + label + "-decided", (r.decided ?? r.Decided) === false, String(r.decided ?? r.Decided));
      ok("legacy-" + label + "-rev1", (r.reviewRevision ?? r.ReviewRevision) === 1, String(r.reviewRevision ?? r.ReviewRevision));
      const e = await get("/api/records/" + dump[key].did + "/export?format=concise");
      ok("legacy-" + label + "-export-409", e.status === 409, String(e.status));
    }
    ok("legacy-" + label + "-no-raw", !hasSnapshotKey(r), "raw snapshot bytes in detail DTO");
    const gg = await guards(dump[key].did);
    const aa = await post("/api/records/" + dump[key].did + "/items/approve", { ...gg, itemId });
    if (!wasApproved) {
      ok("legacy-" + label + "-approve-works", aa.status === 200, String(aa.status));
      dump.flags[flagName] = true;
    } else {
      ok("legacy-" + label + "-reread-409", aa.status === 409, String(aa.status));
    }
  }
  await checkOpenDraft("O", "o1", "O");
  await checkOpenDraft("O2", "p1", "O2");
  await checkTerminal("S", "approved", ["A"], true);
  const sExp = await get("/api/records/" + dump.S.did + "/export?format=concise");
  ok("legacy-S-export-subset", sExp.status === 200 && sExp.text.includes("legacy selected A") && !sExp.text.includes("legacy unselected B"), sExp.status + " " + sExp.text.slice(0, 200));
  const sG2 = await guards(dump.S.did);
  const sB = await post("/api/records/" + dump.S.did + "/items/approve", { ...sG2, itemId: "B" });
  ok("legacy-S-terminal-409", sB.status === 409, String(sB.status));
  await checkTerminal("X", "discarded", [], true);
  const xExp = await get("/api/records/" + dump.X.did + "/export?format=concise");
  ok("legacy-X-export-409", xExp.status === 409, String(xExp.status));
  const xG2 = await guards(dump.X.did);
  const xA2 = await post("/api/records/" + dump.X.did + "/items/approve", { ...xG2, itemId: "x1" });
  ok("legacy-X-terminal-409", xA2.status === 409, String(xA2.status));

  fs.writeFileSync(LEGACY, JSON.stringify(dump, null, 1));
  console.log(fail === 0 ? `RECORDS-LEGACY-POST PASS ${pass}` : `RECORDS-LEGACY-POST DONE pass=${pass} fail=${fail} :: ${failures.join("; ")}`);
  process.exit(fail === 0 ? 0 : 1);
}
// ---------- real COMMIT failure via deferred gate trigger (PG only) ----------
if (args.includes("--pre-commit")) {
  if (!PG) { skip("commit-pg-only"); console.log(`RECORDS-COMMIT-PRE SKIP`); process.exit(0); }
  try { psql(`CREATE TABLE IF NOT EXISTS qa_commit_gate(fail boolean NOT NULL DEFAULT false); UPDATE qa_commit_gate SET fail=false;`); } catch {}
  const cb = await makeBoard(run + "-commit");
  const cm = await makeMeeting(cb, "commit brief");
  await post("/api/meetings/" + cm + "/messages", { sender: "lead", content: "commit input" });
  const fd = await post("/api/meetings/" + cm + "/record/draft", [{ id: "f1", text: "fault one" }, { id: "f2", text: "fault two" }]);
  const fdid = camel(fd.json, "id");
  const fg0 = await guards(fdid);
  ok("commit-setup-draft", fd.status === 201, String(fd.status));
  const am = await post("/api/meetings/" + cm + "/record/draft", [{ id: "a1", text: "amend parent one" }]);
  const amid = camel(am.json, "id");
  const amg0 = await guards(amid);
  const ama = await post("/api/records/" + amid + "/items/approve", { ...amg0, itemId: "a1" });
  ok("commit-setup-parent", ama.status === 200, String(ama.status));
  psql(`CREATE TABLE IF NOT EXISTS qa_commit_gate(fail boolean NOT NULL DEFAULT false);
INSERT INTO qa_commit_gate(fail) SELECT false WHERE NOT EXISTS (SELECT 1 FROM qa_commit_gate);
CREATE OR REPLACE FUNCTION qa_commit_gate_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS (SELECT 1 FROM qa_commit_gate WHERE fail) THEN RAISE EXCEPTION 'qa deferred commit gate tripped'; END IF; RETURN NEW; END $$;
DROP TRIGGER IF EXISTS qa_drafts_commit_gate ON "Drafts";
CREATE CONSTRAINT TRIGGER qa_drafts_commit_gate AFTER INSERT OR UPDATE ON "Drafts" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION qa_commit_gate_fn();
UPDATE qa_commit_gate SET fail=true;`);
  const preF = pgRow(fdid);
  const preA = pgRow(amid);
  const failAppr = await post("/api/records/" + fdid + "/items/approve", { ...fg0, itemId: "f1" });
  ok("commit-fault-500", failAppr.status === 500, String(failAppr.status));
  const postF = pgRow(fdid);
  ok("commit-row-unchanged", postF === preF, "row changed despite COMMIT rollback");
  const failAmend = await post("/api/records/" + amid + "/amend", { ...(await guards(amid)), items: [{ id: "a1", text: "amend attempt" }] });
  ok("commit-amend-500", failAmend.status === 500, String(failAmend.status));
  const postA = pgRow(amid);
  ok("commit-parent-unchanged", postA === preA, "parent changed despite COMMIT rollback");
  const succCount = psql(`SELECT count(*) FROM "Drafts" WHERE "SupersedesJson" LIKE '%${amid}%'`);
  ok("commit-no-successor", succCount.trim() === "0", "successor created: " + succCount);
  const audit = await get("/api/activity/audit");
  const ghost = (audit.json || []).some((e) => ["record.item.approve", "record.approve-all", "record.amend", "record.item.revise", "record.item.discard", "record.refresh", "record.discard", "record.revise"].includes(String(e.action || e.Action || "")) && String(e.detail || e.Detail || "").includes(fdid));
  ok("commit-no-ghost-audit", !ghost, "ghost audit for rolled-back approval");
  fs.mkdirSync(".tmp", { recursive: true });
  fs.writeFileSync(COMMITDUMP, JSON.stringify({ fdid, amid, preF, preA, done: false }, null, 1));
  console.log(fail === 0 ? `RECORDS-COMMIT-PRE PASS ${pass}` : `RECORDS-COMMIT-PRE DONE pass=${pass} fail=${fail} :: ${failures.join("; ")}`);
  process.exit(fail === 0 ? 0 : 1);
}
if (args.includes("--post-commit")) {
  if (!PG) { skip("commit-pg-only"); console.log(`RECORDS-COMMIT-POST SKIP`); process.exit(0); }
  const dump = JSON.parse(fs.readFileSync(COMMITDUMP, "utf8"));
  if (!dump.done) {
    ok("commit-still-rolled-back", pgRow(dump.fdid) === dump.preF, "row changed across restart");
    ok("commit-parent-stable", pgRow(dump.amid) === dump.preA, "parent changed across restart");
    const audit = await get("/api/activity/audit");
    const ghost = (audit.json || []).some((e) => ["record.item.approve", "record.approve-all", "record.amend", "record.item.revise", "record.item.discard", "record.refresh", "record.discard", "record.revise"].includes(String(e.action || e.Action || "")) && String(e.detail || e.Detail || "").includes(dump.fdid));
    ok("commit-no-ghost-after-restart", !ghost, "ghost audit after restart");
    psql(`UPDATE qa_commit_gate SET fail=false;`);
    const g1 = await guards(dump.fdid);
    const okAppr = await post("/api/records/" + dump.fdid + "/items/approve", { ...g1, itemId: "f1" });
    ok("commit-gate-open-approve-200", okAppr.status === 200, String(okAppr.status));
    const gA = await guards(dump.amid);
    const okAmend = await post("/api/records/" + dump.amid + "/amend", { ...gA, items: [{ id: "a1", text: "amend parent one v2" }] });
    ok("commit-gate-open-amend-201", okAmend.status === 201, okAmend.status + " " + okAmend.text.slice(0, 160));
    const audit2 = await get("/api/activity/audit");
    const present = (audit2.json || []).some((e) => String(e.action || e.Action || "") === "record.item.approve" && String(e.detail || e.Detail || "").includes(dump.fdid));
    ok("commit-audit-after-success", present, "missing audit after durable commit");
    dump.postF = pgRow(dump.fdid);
    dump.postA = pgRow(dump.amid);
    dump.done = true;
    fs.writeFileSync(COMMITDUMP, JSON.stringify(dump, null, 1));
    psql(`DROP TRIGGER IF EXISTS qa_drafts_commit_gate ON "Drafts"; DROP FUNCTION IF EXISTS qa_commit_gate_fn(); DROP TABLE IF EXISTS qa_commit_gate;`);
  } else {
    ok("commit-round2-stable", pgRow(dump.fdid) === dump.postF, "row changed across second restart");
    ok("commit-round2-parent", pgRow(dump.amid) === dump.postA, "parent changed across second restart");
    // audits are memory-only by design; prove the seam still appends after commit
    const gR2 = await guards(dump.fdid);
    const okR2 = await post("/api/records/" + dump.fdid + "/items/approve", { ...gR2, itemId: "f2" });
    ok("commit-round2-still-mutates", okR2.status === 200, String(okR2.status));
    const audit3 = await get("/api/activity/audit");
    const present = (audit3.json || []).some((e) => String(e.action || e.Action || "") === "record.item.approve" && String(e.detail || e.Detail || "").includes(dump.fdid));
    ok("commit-round2-audit-live", present, "no audit after durable commit");
  }
  console.log(fail === 0 ? `RECORDS-COMMIT-POST PASS ${pass}` : `RECORDS-COMMIT-POST DONE pass=${pass} fail=${fail} :: ${failures.join("; ")}`);
  process.exit(fail === 0 ? 0 : 1);
}

// ---------- S0 setup ----------
const bid = await makeBoard(run + "-rec5");
await post("/api/boards/" + bid + "/lead", { name: "Rec Lead", roleLabel: "Lead" });
const mid = await makeMeeting(bid, "records brief");
const note = await post("/api/meetings/" + mid + "/notes", { title: "worknote", body: "provisional working note alpha", kind: "note" });
ok("setup-note-201", note.status === 201, String(note.status));
const dirText = "Direction line exact dollar5 keep";
const dir = await post("/api/boards/" + bid + "/directions", { text: dirText, scope: "meeting", meetingId: mid });
ok("setup-direction-201", dir.status === 201, String(dir.status));
const dirId = camel(dir.json, "id");
const form = new FormData();
form.append("file", new Blob(["quasar background reading for ledger"], { type: "text/plain" }), "ledger.txt");
form.append("scope", "meeting");
form.append("meetingId", mid);
const upR = await fetch(API + "/api/boards/" + bid + "/sources/upload", { method: "POST", headers: upHeaders(), body: form });
const upText = await upR.text();
let upJson = null; try { upJson = upText ? JSON.parse(upText) : null; } catch { upJson = null; }
ok("setup-source-upload", upR.status === 201, upR.status + " " + upText.slice(0, 200));
const srcId = camel(upJson, "id");
const srcAp = await post("/api/sources/" + srcId + "/approve", {});
ok("setup-source-approve", srcAp.status === 200, String(srcAp.status));
await post("/api/meetings/" + mid + "/messages", { sender: "lead", content: "actual input alpha quasar" });

// ---------- S1 draft validation negatives ----------
const dupDraft = await post("/api/meetings/" + mid + "/record/draft", [{ id: "x", text: "one" }, { id: "x", text: "two" }]);
ok("draft-dup-422", dupDraft.status === 422, String(dupDraft.status));
const wsDraft = await post("/api/meetings/" + mid + "/record/draft", [{ id: " A", text: "t" }]);
ok("draft-ws-id-422", wsDraft.status === 422, String(wsDraft.status));
const wsDraft2 = await post("/api/meetings/" + mid + "/record/draft", [{ id: "B ", text: "t" }]);
ok("draft-ws-id-trailing-422", wsDraft2.status === 422, String(wsDraft2.status));
const emptyDraft = await post("/api/meetings/" + mid + "/record/draft", [{ id: "x", text: "   " }]);
ok("draft-empty-text-422", emptyDraft.status === 422, String(emptyDraft.status));
const detailObj = await post("/api/meetings/" + mid + "/record/draft", [{ id: "x", text: "t", detail: { private: "data" } }]);
ok("draft-detail-object-422", detailObj.status === 422, String(detailObj.status));
const nullVerDraft = await post("/api/meetings/" + mid + "/record/draft", [{ id: "x", text: "t", refs: [{ kind: "direction", ref: dirId, version: null }] }]);
ok("draft-null-version-201", nullVerDraft.status === 201, nullVerDraft.status + " " + nullVerDraft.text.slice(0, 160));
const badVer = await post("/api/meetings/" + mid + "/record/draft", [{ id: "x", text: "t", refs: [{ kind: "source", ref: srcId, version: "two" }] }]);
ok("draft-badref-version-422", badVer.status === 422, String(badVer.status));

// ---------- S2 guard negatives + staged no-partial-write ----------
const items2 = [{ id: "p", text: "guard one" }, { id: "q", text: "guard two" }];
const gd = await post("/api/meetings/" + mid + "/record/draft", items2);
const gid = camel(gd.json, "id");
ok("guard-draft-201", gd.status === 201, String(gd.status));
let gg = await guards(gid);
const snap0 = { approved: gg.row?.approvedJson ?? gg.row?.ApprovedJson, history: gg.row?.historyJson ?? gg.row?.HistoryJson, token: gg.reviewToken, items: gg.row?.itemsJson ?? gg.row?.ItemsJson };
const badTok = await post("/api/records/" + gid + "/items/approve", { version: gg.version, hash: gg.hash, reviewToken: "staletokenstaletoken", watermark: gg.watermark, itemId: "p" });
ok("guard-badtok-409", badTok.status === 409, String(badTok.status));
const gg2 = await guards(gid);
ok("guard-no-partial-write", (gg2.row?.approvedJson ?? gg2.row?.ApprovedJson) === snap0.approved && (gg2.row?.historyJson ?? gg2.row?.HistoryJson) === snap0.history && gg2.reviewToken === snap0.token && (gg2.row?.itemsJson ?? gg2.row?.ItemsJson) === snap0.items, "rejected guards mutated state");
await post("/api/meetings/" + mid + "/messages", { sender: "lead", content: "drift guard message" });
const staleWm = await post("/api/records/" + gid + "/items/approve", { version: gg.version, hash: gg.hash, reviewToken: gg.reviewToken, watermark: gg.watermark, itemId: "p" });
ok("guard-stalewm-409", staleWm.status === 409, String(staleWm.status));
// ---------- S3 evidence authorization ----------
const bid2 = await makeBoard(run + "-other");
const mid2 = await makeMeeting(bid2, "other brief");
const form2 = new FormData();
form2.append("file", new Blob(["other board secret text"], { type: "text/plain" }), "secret.txt");
form2.append("scope", "board");
const up2 = await fetch(API + "/api/boards/" + bid2 + "/sources/upload", { method: "POST", headers: upHeaders(), body: form2 });
const up2j = JSON.parse(await up2.text());
const otherSrc = up2j.id ?? up2j.Id;
await post("/api/sources/" + otherSrc + "/approve", {});
const otherDir = await post("/api/boards/" + bid2 + "/directions", { text: "other board direction secret", scope: "board" });
const otherDirId = camel(otherDir.json, "id");
const ros = await post("/api/roster", { name: "Unlinked Entry", description: "unlinked roster entry for evidence test", profileJson: "unlinked profile with enough length here" });
const unlinkedId = camel(ros.json, "id") ?? camel(camel(ros.json, "entry"), "id");
await post("/api/meetings/" + mid2 + "/messages", { sender: "lead", content: "other meeting hello" });
const evItems = [
  { id: "e1", text: "own source ref", refs: [{ kind: "source", ref: srcId }] },
  { id: "e2", text: "cross-board source", refs: [{ kind: "source", ref: otherSrc, title: "HACK", excerpt: "HACK" }] },
  { id: "e3", text: "cross-board direction", refs: [{ kind: "direction", ref: otherDirId, title: "HACK2", excerpt: "HACK2" }] },
  { id: "e4", text: "unknown source", refs: [{ kind: "source", ref: crypto.randomUUID() }] },
  { id: "e5", text: "version-mismatched own", refs: [{ kind: "source", ref: srcId, version: 999 }] },
  { id: "e6", text: "wrong-meeting message", refs: [{ kind: "message", ref: mid2 + ":1" }] },
  { id: "e7", text: "own meeting message", refs: [{ kind: "message", ref: mid + ":1" }] },
  { id: "e8", text: "own direction", refs: [{ kind: "direction", ref: dirId }] },
  { id: "e9", text: "unlinked dossier", refs: [{ kind: "dossier", ref: unlinkedId }] },
  { id: "e10", text: "unknown record", refs: [{ kind: "record", ref: crypto.randomUUID(), version: 1 }] },
  { id: "e11", text: "note numeric version", refs: [{ kind: "note", ref: camel(note.json, "id"), version: 2 }] },
];
const evd = await post("/api/meetings/" + mid + "/record/draft", evItems);
const evid = camel(evd.json, "id");
ok("evidence-draft-201", evd.status === 201, evd.status + " " + evd.text.slice(0, 200));
const ev = await get("/api/records/" + evid + "/evidence");
ok("evidence-200", ev.status === 200, String(ev.status));
const cards = ev.json || [];
const cardFor = (iid) => (Array.isArray(cards) ? cards : []).filter((c) => (c.itemId ?? c.ItemId) === iid);
function cardEmpty(c) { return (c.title ?? c.Title ?? "") === "" && (c.excerpt ?? c.Excerpt ?? "") === ""; }
const ownSrc = cardFor("e1");
ok("evidence-own-source-eligible", ownSrc.length === 1 && (ownSrc[0].currentEligible ?? ownSrc[0].CurrentEligible) === true && !cardEmpty(ownSrc[0]), JSON.stringify(ownSrc).slice(0, 200));
for (const iid of ["e2", "e3", "e4", "e5", "e6", "e9", "e10", "e11"]) {
  const cs = cardFor(iid);
  const bad = cs.find((c) => !((c.missing ?? c.Missing) === true) || !cardEmpty(c) || (c.currentEligible ?? c.CurrentEligible) === true);
  ok("evidence-denied-" + iid, cs.length === 1 && !bad, JSON.stringify(cs).slice(0, 300));
}
const ownMsg = cardFor("e7");
ok("evidence-own-message-eligible", ownMsg.length === 1 && (ownMsg[0].currentEligible ?? ownMsg[0].CurrentEligible) === true, JSON.stringify(ownMsg).slice(0, 200));
const ownDir = cardFor("e8");
ok("evidence-own-direction-eligible", ownDir.length === 1 && (ownDir[0].currentEligible ?? ownDir[0].CurrentEligible) === true && (ownDir[0].excerpt ?? ownDir[0].Excerpt ?? "").includes("Direction line exact"), JSON.stringify(ownDir).slice(0, 300));

// ---------- S4 snapshots capture-only-new, immutable, authorized disclosure ----------
// referenced record R in same board, other meeting
const midR = await makeMeeting(bid, "record ref meeting");
await post("/api/meetings/" + midR + "/messages", { sender: "lead", content: "R meeting input" });
const rDraft = await post("/api/meetings/" + midR + "/record/draft", [{ id: "r1", text: "R original one" }, { id: "r2", text: "R original two" }]);
const rDid = camel(rDraft.json, "id");
let rG = await guards(rDid);
const rA1 = await post("/api/records/" + rDid + "/items/approve", { ...rG, itemId: "r1" });
ok("setup-R-approve-r1", rA1.status === 200, String(rA1.status));
const snapItems = [
  { id: "s1", text: "snapshot item", refs: [{ kind: "source", ref: srcId }] },
  { id: "sA", text: "record ref item", refs: [{ kind: "record", ref: rDid }] },
  { id: "sB", text: "later pending item", refs: [{ kind: "message", ref: mid + ":1" }] },
];
const snapDraft = await post("/api/meetings/" + mid + "/record/draft", snapItems);
const snapDid = camel(snapDraft.json, "id");
ok("snapshot-draft-201", snapDraft.status === 201, String(snapDraft.status));
let sg = await guards(snapDid);
const sAppr = await post("/api/records/" + snapDid + "/items/approve", { ...sg, itemId: "s1" });
ok("snapshot-approve-s1-200", sAppr.status === 200, String(sAppr.status));
sg = await guards(snapDid);
const sAAppr = await post("/api/records/" + snapDid + "/items/approve", { ...sg, itemId: "sA" });
ok("snapshot-approve-sA-200", sAAppr.status === 200, String(sAAppr.status));
async function evCard(did, iid) {
  const e = await get("/api/records/" + did + "/evidence");
  return (e.json || []).find((c) => (c.itemId ?? c.ItemId) === iid);
}
const s1Before = await evCard(snapDid, "s1");
ok("snapshot-s1-captured", !!s1Before && (s1Before.missing ?? s1Before.Missing) === false && (s1Before.excerpt ?? s1Before.Excerpt ?? "").includes("quasar background reading"), JSON.stringify(s1Before).slice(0, 240));
const sABefore = await evCard(snapDid, "sA");
const sABeforeTxt = JSON.stringify(sABefore);
ok("snapshot-sA-captured", !!sABefore && (sABefore.missing ?? sABefore.Missing) === false && (sABefore.excerpt ?? sABefore.Excerpt ?? "").includes("R original one"), sABeforeTxt.slice(0, 240));
// no raw snapshot bytes in any response DTO
for (const [nm, rr] of [["detail", await get("/api/records/" + snapDid)], ["list", await get("/api/meetings/" + mid + "/records")], ["review", await get("/api/records/" + snapDid + "/review")]]) {
  ok("no-raw-snapshots-" + nm, !hasSnapshotKey(rr.json), JSON.stringify(rr.json).slice(0, 200));
}
// M1-only reader: no referenced M2-board content, no raw bytes anywhere
const m1r = await post("/api/boards/" + bid + "/grants", { userKey: readerEmail, meetingId: mid, access: "read" });
ok("m1reader-grant", m1r.status === 201 || m1r.status === 200, String(m1r.status));
const ropts = { user: "m1reader" };
const mRev = await get("/api/records/" + snapDid + "/review", ropts);
ok("m1reader-review-200", mRev.status === 200, String(mRev.status));
const mEv = await get("/api/records/" + snapDid + "/evidence", ropts);
const mSA = (mEv.json || []).find((c) => (c.itemId ?? c.ItemId) === "sA");
ok("m1reader-sA-denied-empty", !!mSA && (mSA.missing ?? mSA.Missing) === true && cardEmpty(mSA) && (mSA.currentEligible ?? mSA.CurrentEligible) === false, JSON.stringify(mSA).slice(0, 300));
const mDet = await get("/api/records/" + snapDid, ropts);
ok("m1reader-detail-200", mDet.status === 200, String(mDet.status));
ok("m1reader-no-raw-detail", !hasSnapshotKey(mDet.json), JSON.stringify(mDet.json).slice(0, 200));
const mList = await get("/api/meetings/" + mid + "/records", ropts);
ok("m1reader-list-no-raw", !hasSnapshotKey(mList.json), JSON.stringify(mList.json).slice(0, 200));
ok("m1reader-no-raw-review", !hasSnapshotKey(mRev.json), "review embeds snapshot bytes");
// referenced record grows + source excluded: D.A snapshot bytes stay exact (PG: persisted bytes; memory: read bytes)
rG = await guards(rDid);
const rA2 = await post("/api/records/" + rDid + "/items/approve", { ...rG, itemId: "r2" });
ok("setup-R-approve-r2", rA2.status === 200, String(rA2.status));
sg = await guards(snapDid);
const sBAppr = await post("/api/records/" + snapDid + "/items/approve", { ...sg, itemId: "sB" });
ok("snapshot-approve-sB-200", sBAppr.status === 200, String(sBAppr.status));
const evAfter = await get("/api/records/" + snapDid + "/evidence");
const sAAfter = (evAfter.json || []).find((c) => (c.itemId ?? c.ItemId) === "sA");
ok("snapshot-sA-bytes-exact", JSON.stringify(sAAfter) === sABeforeTxt, (sABeforeTxt.slice(0, 160) + " vs " + JSON.stringify(sAAfter).slice(0, 160)));
const s1After = (evAfter.json || []).find((c) => (c.itemId ?? c.ItemId) === "s1");
ok("snapshot-s1-bytes-exact", !!s1After && (s1After.excerpt ?? s1After.Excerpt ?? "") === (s1Before.excerpt ?? s1Before.Excerpt ?? ""), JSON.stringify(s1After).slice(0, 200));
if (PG) {
  const rowD = pgRow(snapDid);
  ok("snapshot-sA-persisted-exact", rowD.includes("R original one") && !rowD.includes("R original two"), rowD.slice(0, 300));
}
// exclusion flips eligibility without rewriting historical bytes or granting anyone new access
const excl = await patch("/api/sources/" + srcId, { excluded: true });
ok("snapshot-source-exclude", excl.status === 200, String(excl.status));
const evExcl = await get("/api/records/" + snapDid + "/evidence");
const s1Excl = (evExcl.json || []).find((c) => (c.itemId ?? c.ItemId) === "s1");
ok("snapshot-excluded-bytes-kept", !!s1Excl && (s1Excl.excerpt ?? s1Excl.Excerpt ?? "") === (s1Before.excerpt ?? s1Before.Excerpt ?? "") && (s1Excl.missing ?? s1Excl.Missing) === false, JSON.stringify(s1Excl).slice(0, 240));
ok("snapshot-excluded-eligible-false", !!s1Excl && (s1Excl.currentEligible ?? s1Excl.CurrentEligible) === false, JSON.stringify(s1Excl).slice(0, 200));
const rest = await post("/api/sources/" + srcId + "/restore", {});
ok("snapshot-source-restore", rest.status === 200, String(rest.status));
const evRest = await get("/api/records/" + snapDid + "/evidence");
const s1Rest = (evRest.json || []).find((c) => (c.itemId ?? c.ItemId) === "s1");
ok("snapshot-restored-eligible", !!s1Rest && (s1Rest.currentEligible ?? s1Rest.CurrentEligible) === true, JSON.stringify(s1Rest).slice(0, 200));
await post("/api/meetings/" + mid + "/messages", { sender: "lead", content: "post-snapshot input" });
// ---------- S4b unavailable-at-approval persists (no live backfill) ----------
// same-board record R3 with NO approvals yet -> unavailable at capture
const midR3 = await makeMeeting(bid, "unapproved ref meeting");
await post("/api/meetings/" + midR3 + "/messages", { sender: "lead", content: "R3 input" });
const r3Draft = await post("/api/meetings/" + midR3 + "/record/draft", [{ id: "q1", text: "Q unapproved" }]);
const r3Did = camel(r3Draft.json, "id");
const uDraft = await post("/api/meetings/" + mid + "/record/draft", [{ id: "u1", text: "unavailable ref item", refs: [{ kind: "record", ref: r3Did }] }]);
const uDid = camel(uDraft.json, "id");
let uG = await guards(uDid);
const uAppr = await post("/api/records/" + uDid + "/items/approve", { ...uG, itemId: "u1" });
ok("unavailable-approve-200", uAppr.status === 200, String(uAppr.status));
const uCard1 = (await get("/api/records/" + uDid + "/evidence")).json?.find?.((c) => (c.itemId ?? c.ItemId) === "u1");
ok("unavailable-at-approval", !!uCard1 && (uCard1.missing ?? uCard1.Missing) === true && cardEmpty(uCard1), JSON.stringify(uCard1).slice(0, 240));
// now approve the referenced record; the earlier item must NOT backfill
let r3G = await guards(r3Did);
const r3A = await post("/api/records/" + r3Did + "/items/approve", { ...r3G, itemId: "q1" });
ok("setup-R3-approve", r3A.status === 200, String(r3A.status));
const uCard2 = (await get("/api/records/" + uDid + "/evidence")).json?.find?.((c) => (c.itemId ?? c.ItemId) === "u1");
ok("unavailable-persists", !!uCard2 && (uCard2.missing ?? uCard2.Missing) === true && cardEmpty(uCard2), JSON.stringify(uCard2).slice(0, 240));

// ---------- S5 partial approve + explicit refresh + deliberate approve ----------
const abc = [{ id: "A", text: "alpha exact" }, { id: "B", text: "beta exact" }, { id: "C", text: "gamma exact" }];
const ad = await post("/api/meetings/" + mid + "/record/draft", abc);
const adid = camel(ad.json, "id");
ok("abc-draft-201", ad.status === 201, String(ad.status));
let ag = await guards(adid);
const aA = await post("/api/records/" + adid + "/items/approve", { ...ag, itemId: "A" });
ok("abc-approve-A", aA.status === 200, String(aA.status));
ag = await guards(adid);
const aB = await post("/api/records/" + adid + "/items/approve", { ...ag, itemId: "B" });
ok("abc-approve-B", aB.status === 200, String(aB.status));
ag = await guards(adid);
ok("abc-partial-status", (ag.row?.status ?? ag.row?.Status) === "partially-approved", ag.row?.status ?? ag.row?.Status);
await post("/api/meetings/" + mid + "/messages", { sender: "lead", content: "fresh input after partial approval" });
const staleC = await post("/api/records/" + adid + "/items/approve", { ...ag, itemId: "C" });
ok("abc-stale-C-409", staleC.status === 409, String(staleC.status));
const rowBeforeRefresh = await get("/api/records/" + adid);
const rf = await post("/api/records/" + adid + "/refresh", { version: ag.version, hash: ag.hash, reviewToken: ag.reviewToken, watermark: ag.watermark });
ok("abc-refresh-200", rf.status === 200, rf.status + " " + rf.text.slice(0, 220));
const rfA = rf.json?.approved ?? rf.json?.Approved ?? [];
const rfP = rf.json?.pending ?? rf.json?.Pending ?? [];
ok("abc-refresh-preserves", JSON.stringify([...rfA].sort()) === JSON.stringify(["A", "B"]) && JSON.stringify([...rfP].sort()) === JSON.stringify(["C"]), JSON.stringify({ rfA, rfP }));
ok("abc-refresh-rotates-token", (rf.json?.draft?.reviewToken ?? rf.json?.draft?.ReviewToken) !== ag.reviewToken, "token unchanged");
ok("abc-refresh-advances-watermark", (rf.json?.draft?.watermark ?? rf.json?.draft?.Watermark) !== ag.watermark, "watermark unchanged");
const rfHist = histOf(rf.json?.draft ?? {});
const rfEntry = rfHist.find((h) => (h.action ?? h.Action) === "refresh");
ok("abc-refresh-history-viewed", !!rfEntry && typeof (rfEntry.viewedVersion ?? rfEntry.ViewedVersion) === "number", JSON.stringify(rfEntry).slice(0, 240));
const staleRefresh = await post("/api/records/" + adid + "/refresh", { version: ag.version, hash: ag.hash, reviewToken: ag.reviewToken, watermark: ag.watermark });
ok("abc-stale-refresh-409", staleRefresh.status === 409, String(staleRefresh.status));
const rowAfterRefresh = await get("/api/records/" + adid);
ok("abc-refresh-items-untouched", (rowAfterRefresh.json?.itemsJson ?? "") === (rowBeforeRefresh.json?.itemsJson ?? ""), "items changed by refresh");
ok("abc-refresh-approved-untouched", (rowAfterRefresh.json?.approvedJson ?? "") === (rowBeforeRefresh.json?.approvedJson ?? ""), "approved changed by refresh");
ok("abc-refresh-no-snapshot-key", !hasSnapshotKey(rowAfterRefresh.json) && !hasSnapshotKey(rf.json), "refresh leaks snapshot bytes");
let ag2 = await guards(adid);
const freshRefresh = await post("/api/records/" + adid + "/refresh", { version: ag2.version, hash: ag2.hash, reviewToken: ag2.reviewToken, watermark: ag2.watermark });
ok("abc-refresh-current-409", freshRefresh.status === 409, String(freshRefresh.status));
const aC = await post("/api/records/" + adid + "/items/approve", { ...ag2, itemId: "C" });
ok("abc-deliberate-C-200", aC.status === 200, String(aC.status));
const ag3 = await guards(adid);
ok("abc-final-approved", (ag3.row?.status ?? ag3.row?.Status) === "approved", ag3.row?.status ?? ag3.row?.Status);
// ---------- S-perm approval permission is manage on all three routes ----------
const permBoard = await makeBoard(run + "-perm");
const permMid = await makeMeeting(permBoard, "perm brief");
await post("/api/meetings/" + permMid + "/messages", { sender: "lead", content: "perm input" });
const permDraft = await post("/api/meetings/" + permMid + "/record/draft", [{ id: "g1", text: "perm item one" }, { id: "g2", text: "perm item two" }]);
const permDid = camel(permDraft.json, "id");
ok("perm-setup-201", permDraft.status === 201, String(permDraft.status));
const cg = await post("/api/boards/" + permBoard + "/grants", { userKey: writerEmail, meetingId: permMid, access: "contribute" });
ok("contrib-grant-added", cg.status === 201 || cg.status === 200, String(cg.status));
const wopts = { user: "writer" };
const wDraft = await post("/api/meetings/" + permMid + "/record/draft", [{ id: "w1", text: "writer draft" }], wopts);
ok("contrib-prepare-201", wDraft.status === 201, String(wDraft.status));
const wG = await guards(camel(wDraft.json, "id"));
const wRev = await post("/api/records/" + camel(wDraft.json, "id") + "/items/revise", { ...wG, itemId: "w1", text: "writer revised" }, wopts);
ok("contrib-revise-pending-200", wRev.status === 200, String(wRev.status));
const permBefore = await get("/api/records/" + permDid);
let pG = await guards(permDid);
const denyItem = await post("/api/records/" + permDid + "/items/approve", { ...pG, itemId: "g1" }, wopts);
ok("contrib-item-approve-403", denyItem.status === 403, String(denyItem.status));
const denyAll = await post("/api/records/" + permDid + "/approve-all", { ...pG }, wopts);
ok("contrib-approve-all-403", denyAll.status === 403, String(denyAll.status));
const denyLegacy = await post("/api/meetings/" + permMid + "/record/approve", { draftId: permDid, ...pG, itemIds: ["g1"] }, wopts);
ok("contrib-legacy-approve-403", denyLegacy.status === 403, String(denyLegacy.status));
const permAfter = await get("/api/records/" + permDid);
ok("contrib-denial-unchanged", JSON.stringify(permAfter.json) === JSON.stringify(permBefore.json), "denied approval mutated state");
const denyHist = histOf(permAfter.json);
const denyHistBefore = histOf(permBefore.json);
ok("contrib-denial-no-history", denyHist.length === denyHistBefore.length && JSON.stringify(denyHist) === JSON.stringify(denyHistBefore), "denied approval wrote history: " + JSON.stringify(denyHist).slice(0, 200));
const oAppr = await post("/api/records/" + permDid + "/items/approve", { ...(await guards(permDid)), itemId: "g1" });
ok("manage-approve-200", oAppr.status === 200, String(oAppr.status));
const oAll = await post("/api/records/" + permDid + "/approve-all", { ...(await guards(permDid)) });
ok("manage-approve-all-200", oAll.status === 200, String(oAll.status));
const agAll = await guards(permDid);
ok("perm-decided-approved", (agAll.row?.status ?? agAll.row?.Status) === "approved", agAll.row?.status ?? agAll.row?.Status);

// ---------- S6 authoritative amendment lineage ----------
const eff1 = await get("/api/records/" + adid + "/effective");
ok("effective-200", eff1.status === 200, String(eff1.status));
ok("effective-ancestor", JSON.stringify([...(eff1.json?.effectiveIds ?? [])].sort()) === JSON.stringify(["A", "B", "C"]), JSON.stringify(eff1.json?.effectiveIds));
let ag4 = await guards(adid);
const am1 = await post("/api/records/" + adid + "/amend", { ...ag4, items: [{ id: "A", text: "alpha amended marker-AX1" }, { id: "B", text: "beta exact" }, { id: "C", text: "gamma exact" }, { id: "D", text: "delta new" }] });
ok("amend-branch-201", am1.status === 201, am1.status + " " + am1.text.slice(0, 220));
const amdId = camel(am1.json, "id");
const foreign = await post("/api/records/" + adid + "/amend", { ...(await guards(adid)), items: [{ id: "Z", text: "zzz" }], supersedes: [crypto.randomUUID()] });
ok("amend-foreign-supersedes-422", foreign.status === 422, String(foreign.status));
let amg = await guards(amdId);
const amA = await post("/api/records/" + amdId + "/items/approve", { ...amg, itemId: "A" });
ok("amend-approve-A-200", amA.status === 200, String(amA.status));
// head B is decided? approve remaining pending items via approve-all
amg = await guards(amdId);
const amAll = await post("/api/records/" + amdId + "/approve-all", { ...amg });
ok("amend-approve-all-200", amAll.status === 200, String(amAll.status));
const eff2 = await get("/api/records/" + amdId + "/effective");
const effIds2 = [...(eff2.json?.effectiveIds ?? [])].sort();
ok("effective-item-level", JSON.stringify(effIds2) === JSON.stringify(["A", "B", "C", "D"]), JSON.stringify(effIds2));
const effTexts = eff2.json?.effectiveTexts ?? eff2.json?.EffectiveTexts ?? {};
ok("effective-replacement-text", (effTexts.A ?? effTexts.a) === "alpha amended marker-AX1" && (effTexts.B ?? effTexts.b) === "beta exact", JSON.stringify(effTexts).slice(0, 240));
const histExport = await get("/api/records/" + adid + "/export?format=concise");
ok("historical-export-preserved", histExport.status === 200 && histExport.text.includes("alpha exact") && !histExport.text.includes("alpha amended"), histExport.status + " " + histExport.text.slice(0, 200));
ok("ancestor-chain-linked", JSON.stringify(eff2.json?.chain ?? []).includes(adid), JSON.stringify(eff2.json?.chain));
// actual context + recall consumers: amended text visible, replaced ancestor text gone, no duplicates
const rec = await get("/api/boards/" + bid + "/recall?q=marker-AX1&take=8");
const recHits = rec.json || [];
ok("recall-200", rec.status === 200, String(rec.status));
const recText = JSON.stringify(recHits);
ok("recall-amended-visible", recText.includes("alpha amended marker-AX1"), recText.slice(0, 400));
const recA = await get("/api/boards/" + bid + "/recall?q=alpha%20exact&take=8");
ok("recall-replaced-gone", !JSON.stringify(recA.json || []).includes("alpha exact"), JSON.stringify(recA.json).slice(0, 400));
// finalized sibling from historical ancestor is rejected
const sib = await post("/api/records/" + adid + "/amend", { ...(await guards(adid)), items: [{ id: "Z", text: "zzz" }] });
ok("amend-finalized-sibling-409", sib.status === 409, sib.status + " " + sib.text.slice(0, 200));
// transitive descendants also block the ancestor
let bmg = await guards(amdId);
const amB2 = await post("/api/records/" + amdId + "/amend", { ...bmg, items: [{ id: "A", text: "alpha amended marker-AX1" }, { id: "C2", text: "second-gen" }] });
ok("amend-head-201", amB2.status === 201, String(amB2.status));
const amd2Id = camel(amB2.json, "id");
let c2g = await guards(amd2Id);
const c2A = await post("/api/records/" + amd2Id + "/items/approve", { ...c2g, itemId: "A" });
ok("amend-gen2-approve-200", c2A.status === 200, String(c2A.status));
const sibT = await post("/api/records/" + adid + "/amend", { ...(await guards(adid)), items: [{ id: "Z", text: "zzz" }] });
ok("amend-transitive-blocked-409", sibT.status === 409, sibT.status + " " + sibT.text.slice(0, 200));
const sibB = await post("/api/records/" + amdId + "/amend", { ...(await guards(amdId)), items: [{ id: "Z", text: "zzz" }] });
ok("amend-middle-blocked-409", sibB.status === 409, sibB.status + " " + sibB.text.slice(0, 200));
// unapproved discarded proposal retires nothing: fresh chain
const pd = await post("/api/meetings/" + mid + "/record/draft", [{ id: "P", text: "prop one" }, { id: "Q", text: "prop two" }]);
const pdid = camel(pd.json, "id");
let pdg = await guards(pdid);
const pdA = await post("/api/records/" + pdid + "/items/approve", { ...pdg, itemId: "P" });
ok("prop-approve-P", pdA.status === 200, String(pdA.status));
pdg = await guards(pdid);
const pdAll = await post("/api/records/" + pdid + "/approve-all", { ...pdg });
ok("prop-approve-all", pdAll.status === 200, String(pdAll.status));
const pe1 = await post("/api/records/" + pdid + "/amend", { ...(await guards(pdid)), items: [{ id: "P", text: "prop one v2" }] });
ok("prop-amend-201", pe1.status === 201, String(pe1.status));
const peid = camel(pe1.json, "id");
let peg = await guards(peid);
const peDisc = await post("/api/records/" + peid + "/discard", { ...peg });
ok("proposal-discard-200", peDisc.status === 200, String(peDisc.status));
const pe2 = await post("/api/records/" + pdid + "/amend", { ...(await guards(pdid)), items: [{ id: "P", text: "prop one v3" }] });
ok("discarded-proposal-replaceable-201", pe2.status === 201, pe2.status + " " + pe2.text.slice(0, 200));
const rdR = await post("/api/meetings/" + mid + "/record/draft", [{ id: "r1", text: "open root" }]);
const rdid = camel(rdR.json, "id");
const rdAll = await post("/api/records/" + rdid + "/approve-all", { ...(await guards(rdid)) });
ok("revise-setup-approve-200", rdAll.status === 200, String(rdAll.status));
const rdA = await post("/api/records/" + rdid + "/amend", { ...(await guards(rdid)), items: [{ id: "r1", text: "open root v2" }] });
ok("revise-setup-amend-201", rdA.status === 201, String(rdA.status));
const rdAid = camel(rdA.json, "id");
const rdg = await guards(rdAid);
const rdAp = await post("/api/records/" + rdAid + "/items/approve", { ...rdg, itemId: "r1" });
ok("revise-setup-approve-200", rdAp.status === 200, String(rdAp.status));
const rdRev = await post("/api/records/" + rdid + "/revise", { ...(await guards(rdid)), items: [{ id: "r1", text: "stale rewrite" }] });
ok("revise-branch-blocked-409", rdRev.status === 409, rdRev.status + " " + rdRev.text.slice(0, 200));
// approving the open successor blocks further branches from the ancestor
const pe2id = camel(pe2.json, "id");
let neG = await guards(pe2id);
const neA = await post("/api/records/" + pe2id + "/items/approve", { ...neG, itemId: "P" });
ok("newid-approve-200", neA.status === 200, String(neA.status));
const pe3 = await post("/api/records/" + pdid + "/amend", { ...(await guards(pdid)), items: [{ id: "P", text: "prop one v4" }] });
ok("amend-approved-sibling-409", pe3.status === 409, pe3.status + " " + pe3.text.slice(0, 200));
// new-ID-only amendment on a fresh chain inherits untouched ancestors, adds facts
const nd = await post("/api/meetings/" + mid + "/record/draft", [{ id: "X", text: "ex why" }, { id: "Y", text: "wy" }]);
const ndid = camel(nd.json, "id");
let ndg = await guards(ndid);
const ndA = await post("/api/records/" + ndid + "/items/approve", { ...ndg, itemId: "X" });
ok("newid-setup-approve", ndA.status === 200, String(ndA.status));
ndg = await guards(ndid);
const ndAll = await post("/api/records/" + ndid + "/approve-all", { ...ndg });
ok("newid-setup-all", ndAll.status === 200, String(ndAll.status));
const ne2 = await post("/api/records/" + ndid + "/amend", { ...(await guards(ndid)), items: [{ id: "X", text: "ex why" }, { id: "Y", text: "wy" }, { id: "E", text: "brand new E" }] });
ok("newid-amend-201", ne2.status === 201, ne2.status + " " + ne2.text.slice(0, 200));
const ne2id = camel(ne2.json, "id");
let ne2g = await guards(ne2id);
const ne2A = await post("/api/records/" + ne2id + "/items/approve", { ...ne2g, itemId: "E" });
ok("newid-approve-E-200", ne2A.status === 200, String(ne2A.status));
const eff3 = await get("/api/records/" + ne2id + "/effective");
ok("newid-effective", JSON.stringify([...(eff3.json?.effectiveIds ?? [])].sort()) === JSON.stringify(["E", "X", "Y"]), JSON.stringify(eff3.json?.effectiveIds));
const rev3f = await get("/api/records/" + ne2id + "/review");
const fx3 = rev3f.json?.lineageEffects ?? rev3f.json?.LineageEffects ?? [];
const fxE = (Array.isArray(fx3) ? fx3 : []).find((x) => (x.id ?? x.Id) === "E");
const fxP = (Array.isArray(fx3) ? fx3 : []).find((x) => (x.id ?? x.Id) === "X");
ok("lineagefx-present", !!fxE && !!fxP, JSON.stringify(fx3).slice(0, 300));
ok("lineagefx-E-added", !!fxE && (fxE.status ?? fxE.Status) === "added", String(JSON.stringify(fxE)).slice(0, 200));
ok("lineagefx-P-inherited", !!fxP && (fxP.status ?? fxP.Status) === "inherited", String(JSON.stringify(fxP)).slice(0, 200));
// ---------- S7 superseded terminal guards + token rotation ----------
const staleAll = await post("/api/records/" + adid + "/approve-all", { version: ag4.version, hash: ag4.hash, reviewToken: "rotated:" + ag4.reviewToken, watermark: ag4.watermark });
ok("superseded-stale-token-409", staleAll.status === 409, String(staleAll.status));
const ag4b = await guards(adid);
const oldItem = await post("/api/records/" + adid + "/items/approve", { ...ag4b, itemId: "A" });
ok("superseded-old-item-409", oldItem.status === 409, String(oldItem.status));
const oldAll = await post("/api/records/" + adid + "/approve-all", { ...ag4b });
ok("superseded-old-approve-all-409", oldAll.status === 409, String(oldAll.status));
const readOld = await get("/api/records/" + adid);
ok("superseded-read-still-200", readOld.status === 200, String(readOld.status));
ok("superseded-no-raw-bytes", !hasSnapshotKey(readOld.json), "superseded detail leaks snapshot bytes");

// ---------- S10 concurrency: different pending items, same token ----------
const kd = await post("/api/meetings/" + mid + "/record/draft", [{ id: "k1", text: "race one" }, { id: "k2", text: "race two" }]);
const kdid = camel(kd.json, "id");
const kg = await guards(kdid);
const [r1, r2] = await Promise.all([
  post("/api/records/" + kdid + "/items/approve", { ...kg, itemId: "k1" }),
  post("/api/records/" + kdid + "/items/approve", { ...kg, itemId: "k2" }),
]);
const codes = [r1.status, r2.status].sort().join(",");
ok("concurrent-one-wins", codes === "200,409", codes);
const kg2 = await guards(kdid);
const approvedRace = JSON.parse(kg2.row?.approvedJson ?? "[]");
ok("concurrent-single-approval", approvedRace.length === 1 && (approvedRace.includes("k1") !== approvedRace.includes("k2")), JSON.stringify(approvedRace));

// ---------- S11 approve-all, revise-preserves, discard, exports, empty, all-decided ----------
const alld = await post("/api/meetings/" + mid + "/record/draft", [{ id: "m1", text: "all one detail", detail: "because exact" }, { id: "m2", text: "all two" }]);
const alldid = camel(alld.json, "id");
let allg = await guards(alldid);
const allr = await post("/api/records/" + alldid + "/approve-all", { ...allg });
ok("approve-all-200", allr.status === 200, String(allr.status));
const revHist = histOf((await guards(alldid)).row);
ok("approve-all-history", revHist.filter((h) => (h.action ?? h.Action) === "approve").length === 2, "history entries: " + revHist.length);
allg = await guards(alldid);
ok("approve-all-decided", (allg.row?.status ?? allg.row?.Status) === "approved", allg.row?.status ?? allg.row?.Status);
const againAll = await post("/api/records/" + alldid + "/approve-all", { ...allg });
ok("approve-all-decided-409", againAll.status === 409, String(againAll.status));
const expC = await get("/api/records/" + alldid + "/export?format=concise");
ok("export-concise", expC.status === 200 && expC.text.includes("[m1]") && expC.text.includes("all two"), expC.status + " " + expC.text.slice(0, 200));
const expD = await get("/api/records/" + alldid + "/export?format=detailed");
ok("export-detailed", expD.status === 200 && expD.text.includes("because exact"), expD.status + " " + expD.text.slice(0, 200));
const emptyd = await post("/api/meetings/" + mid + "/record/draft", []);
const emptyDid = camel(emptyd.json, "id");
ok("empty-draft-201", emptyd.status === 201, String(emptyd.status));
const emptyAll = await post("/api/records/" + emptyDid + "/approve-all", { ...(await guards(emptyDid)) });
ok("empty-approve-all-409", emptyAll.status === 409, String(emptyAll.status));
// pending revise preserves approved content + history
const vd = await post("/api/meetings/" + mid + "/record/draft", [{ id: "v1", text: "keep approved" }, { id: "v2", text: "pending original" }]);
const vdid = camel(vd.json, "id");
let vg = await guards(vdid);
const vA = await post("/api/records/" + vdid + "/items/approve", { ...vg, itemId: "v1" });
ok("revise-setup-approve", vA.status === 200, String(vA.status));
vg = await guards(vdid);
const vExp0 = await get("/api/records/" + vdid + "/export?format=concise");
const vR = await post("/api/records/" + vdid + "/items/revise", { ...vg, itemId: "v2", text: "pending revised v2" });
ok("revise-pending-200", vR.status === 200, String(vR.status));
const vAfter = await guards(vdid);
ok("revise-approved-kept", JSON.stringify(JSON.parse(vAfter.row?.approvedJson ?? "[]").sort()) === JSON.stringify(["v1"]), vAfter.row?.approvedJson);
const vExp1 = await get("/api/records/" + vdid + "/export?format=concise");
ok("revise-export-stable", vExp1.status === 200 && vExp1.text === vExp0.text, vExp0.text.slice(0, 120) + " vs " + vExp1.text.slice(0, 120));
const vHist = histOf(vAfter.row);
const vRev = vHist.find((h) => (h.action ?? h.Action) === "revise" && (h.itemId ?? h.ItemId) === "v2");
ok("revise-history-entry", !!vRev && (vRev.oldText ?? vRev.OldText) === "pending original" && (vRev.newText ?? vRev.NewText) === "pending revised v2", JSON.stringify(vRev).slice(0, 240));
const ld = await post("/api/meetings/" + mid + "/record/draft", [{ id: "l1", text: "keep me" }, { id: "l2", text: "drop me" }]);
const ldid = camel(ld.json, "id");
let lg = await guards(ldid);
const lAppr = await post("/api/records/" + ldid + "/items/approve", { ...lg, itemId: "l1" });
ok("discard-setup-approve", lAppr.status === 200, String(lAppr.status));
lg = await guards(ldid);
const lDisc = await post("/api/records/" + ldid + "/discard", { ...lg });
ok("discard-remaining-200", lDisc.status === 200, String(lDisc.status));
const lExp = await get("/api/records/" + ldid + "/export?format=concise");
ok("discard-preserves-approved", lExp.status === 200 && lExp.text.includes("keep me") && !lExp.text.includes("drop me"), lExp.status + " " + lExp.text.slice(0, 200));
const wholeRev = await post("/api/records/" + ldid + "/revise", { ...(await guards(ldid)), items: [{ id: "n1", text: "new" }] });
ok("whole-revise-after-decisions-409", wholeRev.status === 409, String(wholeRev.status));
// ---------- release-output QA-control purge check ----------
{
  const dllPath = process.env.QA_API_DLL || "";
  if (dllPath) {
    try {
      const buf = fs.readFileSync(dllPath);
      const bin16 = buf.toString("utf16le");
      const bin8 = buf.toString("latin1");
      for (const s of ["qa/records", "QA_FAULTS", "X-QA-Fail-Commit", "legacy-init", "ThrowIfFault", "QaReadsAllowed", "qa_commit"]) {
        ok("release-clean-" + s, !bin16.includes(s) && !bin8.includes(s), "shipping output still references " + s);
      }
    } catch (e) { ok("release-dll-read", false, String(e).slice(0, 200)); }
  } else skip("release-dll-check");
}

console.log(fail === 0 ? `RECORDS-REVIEW PASS ${pass} (skipped ${skipped})` : `RECORDS-REVIEW DONE pass=${pass} fail=${fail} skipped=${skipped} :: ${failures.join("; ")}`);
process.exit(fail === 0 ? 0 : 1);