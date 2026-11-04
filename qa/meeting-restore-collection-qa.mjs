// qa/meeting-restore-collection-qa.mjs - REAL restore + collection-type regression (Muse-authored).
// Proves: actual /api/backup/restore preserves rows, stale pre-restore auto-init
// discards with the honest restore 409, valid post-restore writes still succeed,
// and malformed guards after restore return 409 (never 500 InvalidCast from a
// staged-replacement rollback leaving plain List<Message> behind MessageList).
// Owns only new QA board/meetings/leads on primary-provided real backend (QA_API).
// No stubs, no provider/run, no Docker, no env keys, no foreign service, no skip:
// backup/restore unavailable is a hard FAIL (fail-closed, no fallback path).
// Run: QA_API=http://127.0.0.1:15201 node qa/meeting-restore-collection-qa.mjs
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = path.join(here, "..", ".tmp");
const QA_API = (process.env.QA_API || "").trim();
let pass = 0; let fail = 0; const failures = [];
function outPath() { try { return path.join(tmpDir, "meeting-restore-collection-qa-result.txt"); } catch { return ""; } }
function outLine(s) { try { fs.mkdirSync(tmpDir, { recursive: true }); fs.appendFileSync(outPath(), s + "\n"); } catch {} }
function ok(name, cond, extra) { if (cond) { pass++; console.log("  ok - " + name); outLine("PASS " + name); } else { fail++; console.log("  FAIL - " + name + (extra ? " :: " + extra : "")); outLine("FAIL " + name + (extra ? " :: " + extra : "")); failures.push(name + (extra ? " :: " + extra : "")); } }
function trunc(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n) : ""; }
function redact(s) { return trunc(s, 300).replace(/[0-9a-f]{32,}/gi, "[redacted]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]"); }
function failExit(msg) { console.log("FATAL " + msg); try { outLine("FATAL " + msg); } catch {} process.exit(2); }
try { fs.mkdirSync(tmpDir, { recursive: true }); fs.writeFileSync(outPath(), "START " + new Date().toISOString() + "\n"); } catch {}
if (!QA_API) failExit("REFUSE: QA_API is required (primary-provided owned isolated real backend URL).");
let apiUrl = null;
try { apiUrl = new URL(QA_API); } catch { failExit("REFUSE: QA_API is not a valid URL."); }
if (apiUrl.protocol !== "http:") failExit("REFUSE: QA_API must be plain http loopback.");
if (apiUrl.hostname !== "127.0.0.1") failExit("REFUSE: QA_API must be 127.0.0.1 loopback.");
const WEB = apiUrl.origin;
for (const bad of [":5173", ":5080", ":9333"]) { if (WEB.includes(bad)) failExit("REFUSE port " + bad + ": never use human/dev ports."); }
const run = "qa-rs-" + Date.now().toString(36) + "-" + crypto.randomBytes(3).toString("hex");
const email = run + "@example.test";
const password = "Qa-" + crypto.randomBytes(9).toString("hex") + "-x9";
let token = "";
async function req(method, p, body, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeout || 30000);
  const headers = { "content-type": "application/json" };
  if (token) headers["authorization"] = "Bearer " + token;
  try {
    const r = await fetch(WEB + p, { method, signal: ctl.signal, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text };
  } catch (e) { return { status: 0, json: null, text: "transport-failure: " + (e && e.name ? e.name : "error") }; }
  finally { clearTimeout(t); }
}
const get = (p, o) => req("GET", p, undefined, o);
const post = (p, b, o) => req("POST", p, b, o);
const patch = (p, b, o) => req("PATCH", p, b, o);
function pick(o, ...keys) { if (!o || typeof o !== "object") return undefined; for (const k of keys) { if (k in o) return o[k]; const lo = String(k).toLowerCase(); for (const key of Object.keys(o)) if (key.toLowerCase() === lo) return o[key]; } return undefined; }
function metaOf(label, l) {
  const seq = pick(l.json, "sequence");
  const content = pick(l.json, "content", "Content");
  const gen = pick(l.json, "generation", "Generation");
  const rid = pick(l.json, "restoreEpochId", "RestoreEpochId");
  const rrev = pick(l.json, "restoreEpochRev", "RestoreEpochRev");
  ok(label + "-meta-seq", typeof seq === "number", "seq=" + JSON.stringify(seq));
  ok(label + "-meta-content", typeof content === "string" && content.length > 0, "content=" + redact(l.text).slice(0, 120));
  ok(label + "-meta-gen", typeof gen === "number", "gen=" + JSON.stringify(gen));
  ok(label + "-meta-rid", typeof rid === "string" && rid.length > 0, "rid=" + JSON.stringify(rid));
  ok(label + "-meta-rrev", typeof rrev === "number", "rrev=" + JSON.stringify(rrev));
  if (typeof seq !== "number" || typeof content !== "string" || !content || typeof gen !== "number" || typeof rid !== "string" || !rid || typeof rrev !== "number") failExit(label + " metadata incomplete; refusing to null-drop guards");
  return { seq, content, gen, rid, rrev };
}
function autoBody(mm, extra) {
  const b = { brief: mm.content.slice(0, 800), briefAutoInit: true, expectedBrief: "", expectBriefEmpty: true, leadSequence: mm.seq, leadContent: mm.content, expectedGeneration: mm.gen, restoreEpochId: mm.rid, restoreEpochRev: mm.rrev };
  if (extra) for (const k of Object.keys(extra)) { if (extra[k] === undefined) delete b[k]; else b[k] = extra[k]; }
  return b;
}
function errCat(r) { return String((r.json && r.json.error) || r.text || "").toLowerCase(); }
function noCast(r) { return !/unable to cast/i.test(String((r.json && r.json.error) || r.text || "")); }
async function main() {
  console.log("setup: register own QA account (token in memory, never logged)");
  const reg = await post("/api/auth/register", { email, password });
  ok("setup-register", reg.status === 201 && pick(reg.json, "token"), "status=" + reg.status + " " + redact(reg.text));
  if (reg.status !== 201) failExit("register failed " + redact(reg.text));
  token = String(pick(reg.json, "token") || "");
  const b = await post("/api/boards", { name: run + "-board", mission: "restore collection regression", stage: "qa" });
  ok("setup-board", b.status === 201 && pick(b.json, "id"), "status=" + b.status + " " + redact(b.text));
  if (!pick(b.json, "id")) failExit("board failed " + redact(b.text));
  const boardId = String(pick(b.json, "id"));
  console.log("caseR1: real restore preserves row, stale guard is restore-409");
  const m1 = await post("/api/boards/" + boardId + "/meetings", { title: run + "-R1", brief: "", participantIds: [] });
  ok("R1-meeting", m1.status === 201 && pick(m1.json, "id"), "status=" + m1.status + " " + redact(m1.text));
  if (!pick(m1.json, "id")) failExit("meeting create failed " + redact(m1.text));
  const mid1 = String(pick(m1.json, "id"));
  const l1 = await post("/api/meetings/" + mid1 + "/messages", { sender: "lead", content: "R1 lead " + run, parentSequence: null });
  ok("R1-lead", (l1.status === 201 || l1.status === 200) && pick(l1.json, "sequence"), "status=" + l1.status + " " + redact(l1.text));
  const mm1 = metaOf("R1", l1);
  const g0 = await get("/api/boards/" + boardId + "/meetings/" + mid1);
  const n0r = await get("/api/meetings/" + mid1 + "/messages?take=50");
  const n0 = Array.isArray(n0r.json) ? n0r.json.length : -1;
  const bk = await get("/api/backup");
  ok("R-backup-200", bk.status === 200 && bk.json && pick(bk.json, "snapshot") && pick(bk.json, "hash"), "status=" + bk.status + " " + redact(bk.text).slice(0, 120));
  if (!(bk.status === 200 && bk.json && pick(bk.json, "snapshot") && pick(bk.json, "hash"))) failExit("backup export unavailable; refusing fallback (real restore required)");
  const rs = await post("/api/backup/restore", { snapshot: pick(bk.json, "snapshot"), hash: pick(bk.json, "hash") });
  ok("R-restore-200", rs.status === 200, "status=" + rs.status + " " + redact(rs.text).slice(0, 200));
  if (rs.status !== 200) failExit("actual restore failed " + redact(rs.text).slice(0, 300));
  const gr = await get("/api/boards/" + boardId + "/meetings/" + mid1);
  const nr = await get("/api/meetings/" + mid1 + "/messages?take=50");
  const nrc = Array.isArray(nr.json) ? nr.json.length : -1;
  ok("R-row-same", gr.status === 200 && String(pick(gr.json, "brief") ?? "") === String(pick(g0.json, "brief") ?? "") && nrc === n0, "brief=" + JSON.stringify(pick(gr.json, "brief")) + " n=" + nrc + "/" + n0);
  const stale = await patch("/api/meetings/" + mid1, autoBody(mm1));
  ok("R-stale-409", stale.status === 409, "status=" + stale.status + " " + redact(stale.text));
  ok("R-stale-cat", errCat(stale).includes("restored"), "body=" + redact(stale.text).slice(0, 200));
  ok("R-stale-nocast", noCast(stale), "body=" + redact(stale.text).slice(0, 200));
  console.log("caseR2: valid post-restore write succeeds after rollback (collection intact)");
  const l2 = await post("/api/meetings/" + mid1 + "/messages", { sender: "lead", content: "R2 lead " + run, parentSequence: null });
  ok("R2-lead", (l2.status === 201 || l2.status === 200) && pick(l2.json, "sequence") !== mm1.seq, "status=" + l2.status + " " + redact(l2.text));
  const mm2 = metaOf("R2", l2);
  ok("R2-fresh-epoch", mm2.rid !== mm1.rid || mm2.rrev !== mm1.rrev, "rid same=" + (mm2.rid === mm1.rid) + " rrev=" + mm1.rrev + "->" + mm2.rrev);
  const p2 = await patch("/api/meetings/" + mid1, autoBody(mm2));
  ok("R2-valid-200", p2.status === 200, "status=" + p2.status + " " + redact(p2.text));
  ok("R2-valid-nocast", noCast(p2), "body=" + redact(p2.text).slice(0, 200));
  const g2 = await get("/api/boards/" + boardId + "/meetings/" + mid1);
  ok("R2-valid-brief", g2.status === 200 && String(pick(g2.json, "brief") ?? "") === mm2.content, "brief=" + redact(g2.text).slice(0, 160));
  console.log("caseR3: malformed guards after restore return 409 (never 500 cast)");
  const m3 = await post("/api/boards/" + boardId + "/meetings", { title: run + "-R3", brief: "", participantIds: [] });
  ok("R3-meeting", m3.status === 201 && pick(m3.json, "id"), "status=" + m3.status + " " + redact(m3.text));
  if (!pick(m3.json, "id")) failExit("R3 meeting create failed " + redact(m3.text));
  const mid3 = String(pick(m3.json, "id"));
  const l3 = await post("/api/meetings/" + mid3 + "/messages", { sender: "lead", content: "R3 lead " + run, parentSequence: null });
  ok("R3-lead", (l3.status === 201 || l3.status === 200) && pick(l3.json, "sequence"), "status=" + l3.status + " " + redact(l3.text));
  const mm3 = metaOf("R3", l3);
  const miss = await patch("/api/meetings/" + mid3, { brief: mm3.content.slice(0, 800), briefAutoInit: true, expectedBrief: "", expectBriefEmpty: true });
  ok("R3-missing-409", miss.status === 409, "status=" + miss.status + " " + redact(miss.text));
  ok("R3-missing-nocast", noCast(miss), "body=" + redact(miss.text).slice(0, 200));
  const mal = await patch("/api/meetings/" + mid3, autoBody(mm3, { leadSequence: "bad" }));
  ok("R3-malformed-409", mal.status === 409, "status=" + mal.status + " " + redact(mal.text));
  ok("R3-malformed-nocast", noCast(mal), "body=" + redact(mal.text).slice(0, 200));
  const g3 = await get("/api/boards/" + boardId + "/meetings/" + mid3);
  ok("R3-blank-intact", g3.status === 200 && String(pick(g3.json, "brief") ?? "") === "", "brief=" + JSON.stringify(pick(g3.json, "brief")));
}
try { await main(); } catch (e) { fail++; const m = "threw " + String((e && e.message) || e).slice(0, 400); failures.push(m); console.log("  FAIL " + m); try { outLine("FAIL " + m); } catch {} }
console.log("PASS=" + pass + " FAIL=" + fail); try { outLine("PASS=" + pass + " FAIL=" + fail); } catch {}
if (failures.length) { console.log("FAILURES: " + failures.join(" ; ")); try { outLine("FAILURES: " + failures.join(" ; ")); } catch {} }
process.exit(fail ? 1 : 0);
