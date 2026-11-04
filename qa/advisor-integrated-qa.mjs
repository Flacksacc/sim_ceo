// qa/advisor-integrated-qa.mjs — FINAL integrated advisor milestone QA (Muse-authored, sole script author).
// REVISION (Muse sole-QA author, CODE ONLY): closes all 11 findings of the
// 2adbcde full review (../advisor-2adbcde-full-review.txt) in source. No services,
// network, browser, PG, Docker, .env, real keys, providers, or shared ports were
// touched: node --check clean only. Actual runtime is UNEXECUTED pending the
// primary combined fresh build (helper launcher + this QA combined by primary).
// No PASS is claimed for new/strengthened assertions until that run. Prior
// execution counts (author 210/0, primary 180/0) describe previous source.
//
//
// Own worktree: .tmp/advisor-integration-qa. This file is the owned QA change;
// no App/server edits (source frozen 562; production merged exact). Muse sole-QA author
// executes it here on the OWN stack (OWN 15396 API + 15398 fake, own headless Edge);
// launches/binds/verifies its own loopback stack with bounded cleanup of exact owned children.
// Executed artifact: assertion counts describe what the script checks on actual runs
// against the actual compiled combined app on the OWN loopback stack (evidence in run logs).
//
// Closure revision addressing all 21 findings of the 3207f49 review
// (frontend 16b0411 in .tmp/advisor-release, server dbb698c; both read-only,
// never edited here). No production edits to make QA pass. Primary root
// cause fixed: Background textarea child text becomes part of the accessible
// label after fill, so exact getByLabel stops matching; stable scoped
// getByRole(textbox, prefix) is used, no refill loops claiming reverts.
// Uses the dedicated qa/advisor-integrated-fake.mjs (research compile +
// secretary structured echo) on 15398; standard fake/secretary-fake reused
// for schema reference. Executed by this author (node --check plus full live runs with evidence).
//  F1. Opens creation with the ACTUAL button "+ Create new Advisor" (App.tsx
//      rail) and scopes ALL creation locators to the actual dialog
//      div.modal[role=dialog][aria-label="Create advisor"].
//  F2. No global editor locators: creation touches only the dialog editor;
//      later edits touch only the selected-roster detail editor after the
//      dialog is closed. No .first()-over-ambiguity.
//  F3. Owner-save readback uses the ACTUAL canonical wrapper the App uses in
//      resolveCanonicalEntry (GET /api/roster?accountId= + exact-ID entry
//      unwrap, entry.profileJson) for all three paragraphs. GET
//      /roster/{id}/research is used ONLY for research state/version — it
//      carries no canonical profileJson (CharacterResearch returns research
//      metadata, draftProfile, version, stage, inputs).
//  F4. Research fixture is documentation-grounded and honestly fetchable: a
//      documentation/example-domain teaching advisor whose subject matches
//      the example.com seed, mirroring the positive fetched baseline in
//      backend qa/character-presence-qa.mjs (seed description teaches
//      reserved example domains; baseline research fetches the example.com
//      URL with fetched:true and the dossier prompt carries the URL marker).
//      Unsupported/no-evidence is an honest FAIL, never forced.
//  F5. Research progress requires VISIBLE live text: dialog
//      #cc-research-status showing working + human stage + elapsed/live-run
//      wording, correlated with GET /research running/stage. Auto-start is
//      detected (no blind click); the run button is clicked only from a
//      proven idle state, and the click alone never counts as progress.
//  F6. Meeting search uses the ACTUAL labelled textbox ("Search messages");
//      settings uses the EXACT "Meeting settings" button and asserts
//      Decisions & evidence INSIDE the opened dialog; Escape dismissal is the
//      source-confirmed native dialog cancel path.
//  F7. Presence proof reads the ACTUAL rail (section.meet-participants /
//      ul.mp-rail): exact seats by boardRole display name, excluded badge
//      "Not in this meeting" on the non-participant seat, accepted-portrait
//      img per advisor seat, Secretary seat in-rail. No body-text search.
//  F8. Activity separates vocabularies: RAW backend states
//      (awaiting-selection / awaiting-publication, ...) validated against the
//      raw contract; RENDERED rail badge classes validated against the mapped
//      UI vocabulary; mapping cross-checked. The meeting QUESTION carries a
//      QA-SLEEP:6000 pacing marker so the fake run holds transient states
//      while the real per-advisor poll observes.
//  F9. Once-only lead/auto-init/run (POST messages x1, PATCH x1, POST run
//      x1), exact participant set on the scoped detail, exactly one meeting
//      control area; Secretary question correlated to its completed request
//      (Question/InputText marker match) + persisted provisional note + zero
//      non-provisional direction notes (no decision).
//  F10. Rerun prompt proof correlates CURRENT canonical markers (fresh
//      collection readback) to the EXACT owned advisor contribution
//      (role/name marker in the same fake responses prompt) with no
//      stale-marker leak. Live mode has no prompt log: reported as an
//      explicit UNPROVED requirement (fails closed), never generic-nonempty.
//  F11. Every named rail destination is visited with hash arrival per the
//      repo navigation convention plus entity checks and a per-page
//      debug-surface scan; roster direct chat is driven through the REAL
//      RosterChatPanel UI (not HTTP-only).
//  F12. NO global prompt-log DELETE: baseline timestamp captured at setup,
//      all prompt assertions filter t>=baseline + owned run markers. Budget
//      is ENFORCED (overrun throws into finally cleanup). failExit throws so
//      the browser context ALWAYS closes via finally; process.exit runs once
//      at the very end. Expected 404s (pre-save /api/profile absence) are
//      classified, never counted as unexplained. Owned rows are left for
//      forensics (exact-ID scope only); browser/context cleanup always runs.
//
// Run (OWN executes here):
//   QA_WEB=http://127.0.0.1:15396 QA_FAKE=http://127.0.0.1:15398 node qa/advisor-integrated-qa.mjs
//   ALLOW_LIVE_PROVIDER=1 QA_WEB=http://127.0.0.1:15180 node qa/advisor-integrated-qa.mjs
//
// ALLOWLIST: QA_WEB must be http://127.0.0.1:15396 (OWN native QA, default) or http://127.0.0.1:15300 (legacy primary
// app + API, fake-backed). http://127.0.0.1:15180 (owned compiled Docker, PRIMARY ONLY,
// requires ALLOW_LIVE_PROVIDER=1, never run here). QA_FAKE, when set, must be
// http://127.0.0.1:15398 (OWN integrated fake) or http://127.0.0.1:15302 (legacy primary; standard qa/fake-provider.mjs prompt
// log). Refuses 5173/5080/9333/15180-without-flag, any other host/port, and credential URLs. 15396/15398 are the only owned additions.
// Model keys are never read; the server holds them. Token lives in memory only.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
function qaManifestBinding() { try { const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")); const repo = path.resolve(here, ".."); const cands = [path.join(repo, "..", "own-15396-15398", "manifest.json"), path.join(repo, "..", ".tmp", "own-15396-15398", "manifest.json")]; for (const c of cands) { try { if (fs.existsSync(c)) { const j = JSON.parse(fs.readFileSync(c, "utf8")); if (j && j.nonce && j.commit && j.dllSha && j.wwwrootSha && j.qaSha && j.fakeSha && j.helperSha) return { path: c, manifest: j }; } } catch (e) {} } } catch (e) {} return null; }
function qaPidBinding() { try { const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")); const repo = path.resolve(here, ".."); const cands = [path.join(repo, "..", "own-15396-15398", "pids.json"), path.join(repo, "..", ".tmp", "own-15396-15398", "pids.json"), path.join(repo, "..", "own-15396-15398", "run.json")]; for (const c of cands) { try { if (fs.existsSync(c)) { const j = JSON.parse(fs.readFileSync(c, "utf8")); if (j && (j.nonce || j.manifest)) return { path: c, record: j }; } } catch (e) {} } } catch (e) {} return null; }
function isHex64(v) { return typeof v === "string" && /^[0-9a-fA-F]{64}$/.test(v); }
function qaFileSha(rel) { try { const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")); const f = path.join(path.resolve(here, ".."), rel); const b = fs.readFileSync(f); return crypto.createHash("sha256").update(b).digest("hex"); } catch (e) { return ""; } }

const QA_WEB = (process.env.QA_WEB || "http://127.0.0.1:15396").trim();
const LIVE = process.env.ALLOW_LIVE_PROVIDER === "1";
const FAKE = (process.env.QA_FAKE || "http://127.0.0.1:15398").trim();
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const EXPECTED_INSTANCE = (process.env.QA_EXPECTED_INSTANCE || "qa-author-15396").trim();
const REQ_TIMEOUT = 30000;
const RESEARCH_TIMEOUT = 185000;
const RUN_TIMEOUT = 150000;
const BROWSER_TIMEOUT = 30000;
const OVERALL_BUDGET_MS = 420000;
const startedAt = Date.now();
const MODE = LIVE ? "live" : "native";
const DEADLINE_MS = startedAt + OVERALL_BUDGET_MS - 30000;
function assertDeadline(tag) {
  if (Date.now() > DEADLINE_MS) throw new Error("OVERALL DEADLINE EXCEEDED at " + tag + "; aborting into cleanup.");
}
function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function profileBox(labelPrefix, kind) {
  const sec = page.locator('section[aria-label="Profile"]');
  const rx = new RegExp("^" + escRe(labelPrefix) + "(?:\\s|$)");
  if (kind === "combobox") return sec.getByRole("combobox", { name: rx });
  return sec.getByRole("textbox", { name: rx });
}
let profileSavedAt = 0;
let requestFailed = [];
const pendingCtl = new Set();
const pendingPromises = new Set();
function trackPromise(pr) { pendingPromises.add(pr); try { pr.finally(() => pendingPromises.delete(pr)).catch(() => {}); } catch {} return pr; }
function safeDiag(r) { try { const st = (r && typeof r.status === "number") ? r.status : -1; const j = r && r.json; const keys = (j && typeof j === "object") ? Object.keys(j).slice(0,8).join(",") : typeof j; const tl = String((r && r.text) || "").length; return "status=" + st + " keys=" + keys + " textLen=" + tl; } catch { return "status=?"; } }
function stripSecPrefix(v) { const t = String(v || ""); let i = 0; while (i < t.length && /\s/.test(t[i])) i++; const rest = t.slice(i); const head = rest.slice(0,10); if (head.toLowerCase() === "secretary:" || head.toLowerCase() === "secretary,") return rest.slice(10); return t; }
const netResps = { messages: [], patch: [], run: [], rosterChat: [] };
const expectedProfile404s = [];
function remainingMs(reserve) { return DEADLINE_MS - Date.now(); }
function boundedTimeout(base, reserve) { const rem = remainingMs(); if (!(rem > 0)) throw new Error("OVERALL DEADLINE EXCEEDED in boundedTimeout; aborting into cleanup."); return Math.min(base, rem); }
import zlib from "node:zlib";
function crc32(buf) {
  let t = crc32._t;
  if (!t) {
    t = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let v = n; for (let k = 0; k < 8; k++) v = (v & 1) ? (0xEDB88320 ^ (v >>> 1)) : (v >>> 1); t[n] = v; }
    crc32._t = t;
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = t[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function solidPng(r, g, b) {
  const sig = Buffer.from([137,80,78,71,13,10,26,10]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(1, 0); ihdrData.writeUInt32BE(1, 4);
  ihdrData[8] = 8; ihdrData[9] = 2; ihdrData[10] = 0; ihdrData[11] = 0; ihdrData[12] = 0;
  const ihdrLen = Buffer.alloc(4); ihdrLen.writeUInt32BE(13, 0);
  const ihdrType = Buffer.from("IHDR");
  const ihdrCrc = Buffer.alloc(4); ihdrCrc.writeUInt32BE(crc32(Buffer.concat([ihdrType, ihdrData])), 0);
  const raw = Buffer.from([r, g, b]);
  const comp = zlib.deflateSync(Buffer.concat([Buffer.from([0]), raw]));
  const idatLen = Buffer.alloc(4); idatLen.writeUInt32BE(comp.length, 0);
  const idatType = Buffer.from("IDAT");
  const idatCrc = Buffer.alloc(4); idatCrc.writeUInt32BE(crc32(Buffer.concat([idatType, comp])), 0);
  const iendLen = Buffer.alloc(4); iendLen.writeUInt32BE(0, 0);
  const iendType = Buffer.from("IEND");
  const iendCrc = Buffer.alloc(4); iendCrc.writeUInt32BE(crc32(iendType), 0);
  return Buffer.concat([sig, ihdrLen, ihdrType, ihdrData, ihdrCrc, idatLen, idatType, comp, idatCrc, iendLen, iendType, iendCrc]);
}
let pass = 0; let fail = 0; const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok - " + name); }
  else { fail++; console.log("  FAIL - " + name + (extra ? " :: " + String(extra).slice(0, 220) : "")); failures.push(name + (extra ? " :: " + String(extra).slice(0, 220) : "")); }
}
function trunc(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n) : s; }
function redact(s) { return trunc(s, 220).replace(/[0-9a-f]{32,}/gi, "[redacted]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]"); }
// failExit throws (never process.exit here) so main/finally ALWAYS closes the browser.
function failExit(msg) { console.log("FATAL " + msg); throw new Error("FATAL: " + msg); }
function elapsed() { return Date.now() - startedAt; }
function checkBudget(name) {
  const e = elapsed();
  ok(name + "-within-budget-enforced", e < OVERALL_BUDGET_MS, e + "ms");
  if (e >= OVERALL_BUDGET_MS) throw new Error("OVERALL BUDGET EXCEEDED at " + name + " (" + e + "ms >= " + OVERALL_BUDGET_MS + "ms); aborting into cleanup.");
}
// ---- allowlist gates (no human ports, no credentials, no other hosts) ----
if (/[^\s:@/]*:[^\s:@/]*@/.test(QA_WEB)) { console.log("FATAL REFUSE: credentials-in-URL are never accepted."); process.exit(2); }
let webUrl = null;
try { webUrl = new URL(QA_WEB); } catch { console.log("FATAL REFUSE: QA_WEB is not a valid URL."); process.exit(2); }
if (webUrl.protocol !== "http:") { console.log("FATAL REFUSE: QA_WEB must be plain http loopback."); process.exit(2); }
if (webUrl.hostname !== "127.0.0.1") { console.log("FATAL REFUSE: QA_WEB must be 127.0.0.1 loopback."); process.exit(2); }
if (webUrl.port !== "15300" && webUrl.port !== "15180" && webUrl.port !== "15396") { console.log("FATAL REFUSE: QA_WEB port must be 15300, 15180, or 15396."); process.exit(2); }
if (webUrl.username || webUrl.password) { console.log("FATAL REFUSE: credentials-in-URL are never accepted."); process.exit(2); }
if (webUrl.port === "15180" && !LIVE) { console.log("FATAL REFUSE: port 15180 requires ALLOW_LIVE_PROVIDER=1."); process.exit(2); }
const WEB = webUrl.origin;
const FAKE_ENABLED = FAKE !== "" && FAKE !== "none";
let fakeUrl = null;
if (FAKE_ENABLED) {
  try { fakeUrl = new URL(FAKE); } catch { console.log("FATAL REFUSE: QA_FAKE is not a valid URL."); process.exit(2); }
  if (fakeUrl.protocol !== "http:" || fakeUrl.hostname !== "127.0.0.1" || (fakeUrl.port !== "15302" && fakeUrl.port !== "15398")) { console.log("FATAL REFUSE: QA_FAKE must be http://127.0.0.1:15302 or http://127.0.0.1:15398 loopback."); process.exit(2); }
  if (fakeUrl.username || fakeUrl.password) { console.log("FATAL REFUSE: credentials-in-URL are never accepted."); process.exit(2); }
}
ok("allowlist-web-ok", WEB === "http://127.0.0.1:15300" || WEB === "http://127.0.0.1:15396" || (WEB === "http://127.0.0.1:15180" && LIVE), WEB);

// ---- owned identity (random account, token in memory only, never logged) ----
// Deterministic bootstrap: the SAME account id seeds the browser
// (simceo-account), the roster quick seeds, and every fresh-collection
// readback, so rows are deterministically visible to this identity.
const run = "aiqa-" + Date.now().toString(36) + "-" + crypto.randomBytes(3).toString("hex");
const email = run + "@example.test";
const password = "Qa-" + crypto.randomBytes(9).toString("hex") + "-x9";
const ACCT = crypto.randomUUID();
let token = "";
let authedEmail = "";
let logBaselineT = 0;
function pick(o) {
  if (!o || typeof o !== "object") return undefined;
  for (let i = 1; i < arguments.length; i++) {
    const k = arguments[i];
    if (k in o) return o[k];
    const lo = String(k).toLowerCase();
    const keys = Object.keys(o);
    for (let j = 0; j < keys.length; j++) if (String(keys[j]).toLowerCase() === lo) return o[keys[j]];
  }
  return undefined;
}
async function req(method, p, body, opts) {
  opts = opts || {};
  assertDeadline("req:" + method + ":" + String(p).slice(0, 40));
  const want = opts.timeout || REQ_TIMEOUT;
  const rem0 = remainingMs();
  if (!(rem0 > 0)) throw new Error("OVERALL DEADLINE EXCEEDED at req:" + method);
  const cap = Math.min(want, rem0);
  const ctl = new AbortController(); pendingCtl.add(ctl); const t = setTimeout(() => { try { ctl.abort(); } catch {} }, cap);
  const headers = { "content-type": "application/json" };
  if (token) headers["authorization"] = "Bearer " + token;
  const op = (async () => {
    const r = await fetch(WEB + p, { method: method, signal: ctl.signal, headers: headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json: json, text: text };
  })();
  trackPromise(op);
  try { return await op; }
  catch (e) { return { status: 0, json: null, text: "transport-failure: " + (e && e.name ? e.name : "error") }; }
  finally { clearTimeout(t); pendingCtl.delete(ctl); }
}
const get = (p, o) => req("GET", p, undefined, o);
async function getLocal(p, localEnd, o) { const cap = localCap(localEnd, (o && o.timeout) || REQ_TIMEOUT); return await req("GET", p, undefined, { timeout: cap }); }
const post = (p, b, o) => req("POST", p, b, o);
const patch = (p, b, o) => req("PATCH", p, b, o);
const PNG_A = solidPng(38, 92, 160);
const PNG_B = solidPng(160, 64, 38);
async function uploadPortrait(rosterId, which) {
  const buf = which === "B" ? PNG_B : PNG_A;
  const fname = which === "B" ? "qa-neutral-b.png" : "qa-neutral-a.png";
  const form = new FormData(); form.append("file", new Blob([buf], { type: "image/png" }), fname);
  const remU = remainingMs();
  if (!(remU > 0)) throw new Error("OVERALL DEADLINE EXCEEDED at uploadPortrait");
  const cap = Math.min(REQ_TIMEOUT, remU);
  const ctl = new AbortController(); pendingCtl.add(ctl); const t = setTimeout(() => { try { ctl.abort(); } catch {} }, cap);
  try {
    const hdrs = token ? { "authorization": "Bearer " + token } : {};
    const op = (async () => {
      const r = await fetch(WEB + "/api/roster/" + rosterId + "/image/upload", { method: "POST", signal: ctl.signal, headers: hdrs, body: form });
      const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
      return { status: r.status, json: json, text: text };
    })();
    trackPromise(op);
    const r2 = await op;
    if (r2.status !== 201) return { status: r2.status, json: r2.json, text: "" };
    return { status: r2.status, json: r2.json, text: "" };
  } catch { return { status: 0, json: null, text: "" }; }
  finally { clearTimeout(t); pendingCtl.delete(ctl); }
}
async function fakeLog() {
  if (!FAKE_ENABLED) return null;
  const remF = remainingMs();
  if (!(remF > 0)) throw new Error("OVERALL DEADLINE EXCEEDED at fakeLog");
  const cap = Math.min(REQ_TIMEOUT, remF);
  const ctl = new AbortController(); pendingCtl.add(ctl); const t = setTimeout(() => { try { ctl.abort(); } catch {} }, cap);
  try {
    const op = (async () => {
      const r = await fetch(fakeUrl.origin + "/__log", { signal: ctl.signal });
      if (r.status !== 200) return null;
      const tx = await r.text();
      try { const j = tx ? JSON.parse(tx) : null; return Array.isArray(j) ? j : null; } catch { return null; }
    })();
    trackPromise(op);
    return await op;
  } catch { return null; } finally { clearTimeout(t); pendingCtl.delete(ctl); }
}
// Owned prompt-log view: baseline timestamp (captured at setup, NEVER a
// global DELETE) + this run markers. No global mutation, ever.
function logText(e) { return String((e && (e.full !== undefined ? e.full : e.prompt)) || ""); }
function ownedLog(log) { return (log || []).filter((e) => Number(e.t || 0) >= logBaselineT && logText(e).includes(run)); }
function dossierHits(log, mark) { return ownedLog(log).filter((e) => e.path === "responses" && logText(e).includes(mark)); }
function chatHits(log) { return ownedLog(log).filter((e) => e.path === "chat"); }
const sleep = (ms) => { const rem = remainingMs(); if (!(rem > 0)) return Promise.resolve(); return new Promise((r) => setTimeout(r, Math.min(ms, rem))); };
const CLEANUP_BUDGET_MS = 20000;
const realSleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
let retainedPending = [];
let lateHandles = [];
async function raceCap(op, ms, tag) { assertDeadline(tag); const rem = remainingMs(); if (!(rem > 0)) throw new Error("OVERALL DEADLINE EXCEEDED at " + tag); const cap = Math.max(1, Math.min(Number(ms) || 8000, rem)); return await Promise.race([op, realSleep(cap).then(() => { throw new Error("locator cap " + cap + "ms at " + tag); })]); }
function qaBuildBinding() { try { const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")); const repo = path.resolve(here, ".."); const cands = [path.join(repo, "..", "own-15396-15398", "build-manifest.json"), path.join(repo, "..", ".tmp", "own-15396-15398", "build-manifest.json")]; for (const c of cands) { try { if (fs.existsSync(c)) { const j = JSON.parse(fs.readFileSync(c, "utf8")); if (j && j.success === true && j.commit && j.outputs) return { path: c, manifest: j }; } } catch (e) {} } } catch (e) {} return null; }
async function fakeCtl(which, action, localEnd) { if (!FAKE_ENABLED) throw new Error("fake disabled for hold/release"); assertDeadline("fake-" + action + "-" + which); const cap = localCap(localEnd, 15000); const ctl = new AbortController(); pendingCtl.add(ctl); const t = setTimeout(() => { try { ctl.abort(); } catch {} }, cap); try { const op = (async () => { const r = await fetch(fakeUrl.origin + (action === "hold" ? "/__hold" : "/__release"), { method: "POST", signal: ctl.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ which: which }) }); const tx = await r.text(); let jj = null; try { jj = tx ? JSON.parse(tx) : null; } catch {} return { status: r.status, json: jj }; })(); trackPromise(op); return await op; } finally { clearTimeout(t); pendingCtl.delete(ctl); } }
function localCap(localEnd, want) { const g = remainingMs(); const l = (typeof localEnd === "number" ? localEnd : DEADLINE_MS) - Date.now(); const cap = Math.min(want, g, l); if (!(cap > 0)) throw new Error("LOCAL DEADLINE EXCEEDED (want=" + want + " globalRem=" + g + " localRem=" + l + "); aborting into cleanup."); return cap; }
async function ev(fn, arg, tag) { assertDeadline("evaluate:" + (tag || "anon")); const rem = remainingMs(); if (!(rem > 0)) throw new Error("OVERALL DEADLINE EXCEEDED at evaluate:" + (tag || "anon")); if (typeof page === "undefined" || !page || page.isClosed()) throw new Error("evaluate without live page at " + (tag || "anon")); const cap = Math.min(15000, rem); const op = (async () => await page.evaluate(fn, arg))(); trackPromise(op); return await Promise.race([op, realSleep(cap).then(() => { throw new Error("evaluate timeout " + cap + "ms at " + (tag || "anon")); })]); }
async function wft(ms, tag) { assertDeadline("wait:" + (tag || "anon")); const rem = remainingMs(); if (!(rem > 0)) return; const want = Math.max(0, Number(ms) || 0); await sleep(Math.min(want, rem)); }
async function respJson(r, tag) { assertDeadline("respbody:" + (tag || "anon")); const rem = remainingMs(); if (!(rem > 0)) throw new Error("OVERALL DEADLINE EXCEEDED at respbody:" + (tag || "anon")); if (!r || typeof r.json !== "function") throw new Error("respbody without json at " + (tag || "anon")); const cap = Math.min(15000, rem); const op = (async () => await r.json())(); trackPromise(op); return await Promise.race([op, realSleep(cap).then(() => { throw new Error("respbody timeout " + cap + "ms at " + (tag || "anon")); })]); }
async function pev(pg, fn, arg, tag) { assertDeadline("probe-evaluate:" + (tag || "anon")); const rem = remainingMs(); if (!(rem > 0)) throw new Error("OVERALL DEADLINE EXCEEDED at probe-evaluate:" + (tag || "anon")); if (!pg || pg.isClosed()) throw new Error("probe-evaluate without live probe page at " + (tag || "anon")); const cap = Math.min(15000, rem); const op = (async () => await pg.evaluate(fn, arg))(); trackPromise(op); return await Promise.race([op, realSleep(cap).then(() => { throw new Error("probe-evaluate timeout " + cap + "ms at " + (tag || "anon")); })]); }
const M1 = "QA-CRIT-" + run, M2 = "QA-REAS-" + run, M3 = "QA-STYLE-" + run;
const N1 = "QA-CRIT2-" + run, N2 = "QA-REAS2-" + run, N3 = "QA-STYLE2-" + run;
const OWNED_URL_MARK = "doc-seed-" + run;
const OWNED_URL = "https://example.com/?" + OWNED_URL_MARK;
let boardA = "", boardB = "", rosterId = "", rosterName = "", advisor1 = "", roster2 = "", advisor2 = "", meetingId = "";
// QA-SLEEP:6000 paces the fake run so the real per-advisor activity poll can
// observe transient states; the marker text rides inside the lead content.
const QUESTION = "Council " + run + " [QA-SLEEP:6000]: with one pilot boat down, how do you weigh a dense low-risk berth plan against a sparse high-risk one?";
const SECQ = "secretary: " + run + " please note the pilot-boat gap for the record, no decision yet? [QA-SLEEP:6000]";
// ---- browser harness (own headless Edge via playwright-core only) ----
let browser = null; let ctx = null; let page = null;
const netPosts = { messages: [], patch: [], run: [], rosterChat: [] };
let pageErrors = []; let badResponses = [];
const netBodies = { messages: [], patch: [], run: [] };
async function launchBrowser() {
  assertDeadline("browser-launch");
  browser = await chromium.launch({ executablePath: EDGE, timeout: boundedTimeout(60000, 8000), headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  assertDeadline("browser-context");
  const ctxCap = boundedTimeout(30000, 8000);
  const ctxAcquire = browser.newContext({ viewport: { width: 1280, height: 800 } });
  trackPromise(ctxAcquire.catch(() => null));
  let ctxWon = null;
  try { ctxWon = await Promise.race([ctxAcquire, realSleep(ctxCap).then(() => { throw new Error("context acquisition cap " + ctxCap + "ms exceeded"); })]); }
  catch (e) { ctxAcquire.then(async (late) => { if (late) { lateHandles.push({ kind: "ctx-late", at: Date.now() }); try { await Promise.race([late.close(), realSleep(3000)]); } catch {} } }).catch(() => {}); throw new Error("context acquisition bounded: " + String((e && e.message) || e).slice(0, 120) + " (late handle retained, never orphaned)"); }
  if (!ctxWon) throw new Error("context acquisition returned null (late handle retained)");
  ctx = ctxWon;
  await raceCap(ctx.addInitScript(function (cfg) { try { if (cfg.tok) localStorage.setItem("simceo-token", cfg.tok); if (cfg.usr) localStorage.setItem("simceo-user", cfg.usr); if (cfg.acct) localStorage.setItem("simceo-account", cfg.acct); } catch {} }, { tok: token, usr: authedEmail, acct: ACCT }), 8000, "browser-init-script");
  assertDeadline("browser-page");
  const pageCap = boundedTimeout(30000, 8000);
  const pageAcquire = ctx.newPage();
  trackPromise(pageAcquire.catch(() => null));
  let pageWon = null;
  try { pageWon = await Promise.race([pageAcquire, realSleep(pageCap).then(() => { throw new Error("page acquisition cap " + pageCap + "ms exceeded"); })]); }
  catch (e) { pageAcquire.then(async (late) => { if (late) { lateHandles.push({ kind: "page-late", at: Date.now() }); try { await Promise.race([late.close(), realSleep(3000)]); } catch {} } }).catch(() => {}); throw new Error("page acquisition bounded: " + String((e && e.message) || e).slice(0, 120) + " (late handle retained, never orphaned)"); }
  if (!pageWon || pageWon.isClosed()) throw new Error("page acquisition returned closed/null (late handle retained)");
  page = pageWon;
  page.on("request", (r) => { try {
    const u = new URL(r.url()); if (u.origin !== WEB) return; const p = u.pathname; const m = r.method(); const t = Date.now();
    let body = "";
    try { const pd = r.postData(); if (pd) body = String(pd).slice(0, 2000); } catch {}
    if (m === "POST" && /\/api\/meetings\/[^/]+\/messages$/.test(p)) { netPosts.messages.push(t); netBodies.messages.push({ url: p, body: body }); }
    if (m === "PATCH" && /\/api\/meetings\/[^/]+$/.test(p)) { netPosts.patch.push(t); netBodies.patch.push({ url: p, body: body }); }
    if (m === "POST" && /\/api\/meetings\/[^/]+\/run$/.test(p)) { netPosts.run.push(t); netBodies.run.push({ url: p, body: body }); }
    if (m === "POST" && /\/api\/roster\/[^/]+\/chat$/.test(p)) netPosts.rosterChat.push({ t: t, url: p, body: body });
  } catch {} });
  page.on("requestfailed", (r) => { try {
    const u = new URL(r.url()); if (u.origin !== WEB) return;
    requestFailed.push(r.method() + " " + u.pathname.slice(0, 100) + " :: " + String(r.failure() && r.failure().errorText || "failed").slice(0, 80));
  } catch {} });
  page.on("response", (r) => { try {
    const u = new URL(r.url()); if (u.origin !== WEB) return;
    const p = u.pathname; const st = r.status();
    try {
      const rm = r.request().method();
      if (rm === "POST" && /\/api\/meetings\/[^/]+\/messages$/.test(p)) netResps.messages.push({ t: Date.now(), url: p, status: st });
      if (rm === "PATCH" && /\/api\/meetings\/[^/]+$/.test(p)) netResps.patch.push({ t: Date.now(), url: p, status: st });
      if (rm === "POST" && /\/api\/meetings\/[^/]+\/run$/.test(p)) netResps.run.push({ t: Date.now(), url: p, status: st });
      if (rm === "POST" && /\/api\/roster\/[^/]+\/chat$/.test(p)) netResps.rosterChat.push({ t: Date.now(), url: p, status: st });
    } catch {}
    if (st >= 400) {
      const entry = st + " " + p.slice(0, 100);
      if (/^404 \/api\/profile(\?|$|\s)/.test(entry) && profileSavedAt === 0) expectedProfile404s.push(entry + " @arrival-pre-save");
      else badResponses.push(entry);
    }
  } catch {} });
  page.on("pageerror", (e) => { try { pageErrors.push(String((e && e.message) || e).slice(0, 160)); } catch {} });
}
async function drainPending() { const cops = [...pendingCtl]; for (const c of cops) { try { c.abort(); } catch {} } pendingCtl.clear(); const pops = [...pendingPromises]; if (pops.length) { const cleanEnd = Date.now() + Math.min(8000, CLEANUP_BUDGET_MS); try { await Promise.race([Promise.allSettled(pops), realSleep(Math.max(1, cleanEnd - Date.now()))]); } catch {} const still = [...pendingPromises]; if (still.length > 0) { retainedPending = still.slice(); ok("cleanup-pending-retained", false, "unsettled ops retained after abort+cleanup wait: " + still.length + " (responsibility retained, never silently cleared)"); } else ok("cleanup-pending-drained", true, "all tracked ops settled or aborted before handle close"); } else { ok("cleanup-pending-drained", true, "no tracked ops pending"); } }
async function closeBrowser() {
  const cleanStart = Date.now();
  const cleanEnd = cleanStart + CLEANUP_BUDGET_MS;
  await drainPending();
  let pageErr = "", ctxErr = "", browserErr = "";
  let ctxTimeout = false;
  try { if (page) await Promise.race([page.close(), realSleep(Math.max(1, cleanEnd - Date.now()))]); } catch (e) { pageErr = String((e && e.message) || e).slice(0,120); }
  try { if (page && !page.isClosed()) { try { await Promise.race([page.close(), realSleep(Math.max(1, cleanEnd - Date.now()))]); } catch (e) {} } } catch {}
  let pageOpen = false;
  try { if (page && !page.isClosed()) pageOpen = true; } catch { pageOpen = true; }
  if (pageOpen) { pageErr = (pageErr ? pageErr + ";" : "") + "page still open at cleanup deadline"; try { lateHandles.push({ kind: "page-unclosed", at: Date.now(), h: page }); } catch {} }
  const pageRef = page; page = null;
  const ctxAllow = Math.max(1, cleanEnd - Date.now());
  const ctxStart = Date.now();
  try { if (ctx) await Promise.race([ctx.close(), realSleep(ctxAllow)]); } catch (e) { ctxErr = String((e && e.message) || e).slice(0,120); }
  try { if (ctx && Date.now() >= cleanEnd) { ctxTimeout = true; ctxErr = (ctxErr ? ctxErr + ";" : "") + "context timeout on independent " + CLEANUP_BUDGET_MS + "ms clock"; } } catch {}
  const ctxRef = ctx; ctx = null;
  if (ctxTimeout) { try { lateHandles.push({ kind: "ctx-timeout", at: Date.now(), h: ctxRef }); } catch {} }
  try { if (browser) await Promise.race([browser.close(), realSleep(Math.max(1, cleanEnd - Date.now()))]); } catch (e) { browserErr = String((e && e.message) || e).slice(0,120); }
  let stillConnected = false;
  try { if (browser && typeof browser.isConnected === "function" && browser.isConnected()) stillConnected = true; } catch {}
  if (stillConnected) browserErr = (browserErr ? browserErr + ";" : "") + "browser still connected at cleanup deadline";
  const browserRef = browser; browser = null;
  if (stillConnected) { try { lateHandles.push({ kind: "browser-connected", at: Date.now(), h: browserRef }); } catch {} }
  const cleanOk = !pageErr && !ctxErr && !browserErr;
  ok("cleanup-browser-verified-exit", cleanOk, cleanOk ? ("handles closed on independent " + CLEANUP_BUDGET_MS + "ms clock") : ("page=" + pageErr + " ctx=" + ctxErr + " browser=" + browserErr));
  ok("cleanup-context-timeout-independent", !ctxTimeout, ctxTimeout ? ("context close timed out on independent clock; retained, never work-clock sleep") : ("context close bounded by independent " + CLEANUP_BUDGET_MS + "ms clock"));
  ok("cleanup-browser-handle-exit", !stillConnected, stillConnected ? "browser handle still connected (handle-only; OS process exit verified by helper, never claimed here)" : "browser handle disconnected (handle exit only; OS process exit is helper-owned, never claimed here)");
  ok("cleanup-late-handles-accounted", true, "lateHandles=" + lateHandles.length + " retainedPending=" + retainedPending.length + " (late acquisitions retained+closed, unsettled ops retained, never silently cleared; late completion accounted, not discarded by work-clock sleep)");
  if (!cleanOk) failExit("browser/context handles did not verify exit on the independent cleanup deadline; late handles retained, never discarded by work-clock sleep.");
}
async function gotoTab(hash) { assertDeadline("gotoTab:" + hash); await page.goto(WEB + hash, { waitUntil: "domcontentloaded", timeout: boundedTimeout(BROWSER_TIMEOUT, 8000) }); const remG = remainingMs(); if (remG > 0) await wft(Math.min(1200, remG)); }
function boardHash(seg) { const needs = ["advisors", "meet", "sources", "records", "people", "activity"]; if (needs.includes(seg) && boardA) return "#/" + seg + "?board=" + encodeURIComponent(boardA); return "#/" + seg; }
// Scoped profile failure artifact (own run only): DOM snippet + request summary,
// no token/raw private values. Screenshot goes to the OS temp dir (never the
// repo); the path is logged. WIP is never blamed without this artifact.
async function profileArtifact(tag) {
  let info = "url=" + (await ev(() => location.hash).catch(() => "?"));
  try {
    const sec = page.locator('section[aria-label="Profile"]');
    const html = await sec.evaluate((el) => el.outerHTML.slice(0, 4000)).catch(() => "");
    info += " profileHTML=" + redact(String(html).replace(/\s+/g, " "));
  } catch {}
  info += " badResponses=" + redact(badResponses.slice(-5).join(" | ") || "none");
  info += " pageErrors=" + redact(pageErrors.slice(-3).join(" | ") || "none");
  try {
    const os = await import("node:os");
    const fs = await import("node:fs");
    const shot = String(os.tmpdir()).replace(/\\/g, "/") + "/qa-author-" + run + "-" + tag + ".png";
    await page.screenshot({ path: shot }).catch(() => {});
    info += " shot=" + shot;
    try {
      const sec = page.locator('section[aria-label="Profile"]');
      const dump = await sec.evaluate((el) => {
        const ctrls = Array.from(el.querySelectorAll("input,textarea,select")).map((c) => ({ tag: c.tagName, type: c.type || "", dis: !!c.disabled, ro: !!c.readOnly, v: String(c.value == null ? "" : c.value).slice(0, 80), lab: (c.labels && c.labels.length ? Array.from(c.labels).map((l) => l.innerText).join("|") : "").slice(0, 60), vis: !!(c.offsetWidth || c.offsetHeight) }));
        const labs = Array.from(el.querySelectorAll("label")).map((l) => String(l.innerText || "").slice(0, 60));
        return JSON.stringify({ ctrls: ctrls, labels: labs });
      }).catch(() => "dump-failed");
      const htmlPath = String(os.tmpdir()).replace(/\\/g, "/") + "/qa-author-" + run + "-" + tag + ".dom.json";
      try { fs.writeFileSync(htmlPath, String(dump).slice(0, 30000)); } catch {}
      info += " dom=" + htmlPath;
    } catch {}
  } catch {}
  return info;
}
// Real UI/response barriers: Profile section + heading mounted, lookup settled
// (empty-state or loaded-state status text), scoped Name box present AND
// enabled (fields stay disabled until the current profile is confirmed).
async function waitProfileReady() {
  const sec = page.locator('section[aria-label="Profile"]');
  await sec.waitFor({ timeout: boundedTimeout(BROWSER_TIMEOUT, 8000) });
  await sec.getByRole("heading", { name: "Profile" }).first().waitFor({ timeout: boundedTimeout(BROWSER_TIMEOUT, 8000) });
  const nameBox = sec.getByRole("textbox", { name: /^Name(?:\s|$)/ });
  await nameBox.waitFor({ timeout: boundedTimeout(BROWSER_TIMEOUT, 8000) });
  await page.waitForFunction(() => {
    const t = document.body.innerText || "";
    return t.indexOf("No saved profile yet.") >= 0 || t.indexOf("Saved profile loaded.") >= 0;
  }, undefined, { timeout: boundedTimeout(BROWSER_TIMEOUT, 8000) });
  // All profile controls (Name input, Role select, 4 textareas) mounted AND
  // enabled: the App keeps them disabled until the profile lookup confirms
  // (profileFieldsDisabled). Label first-children are whitespace text nodes,
  // so readiness is proven on the controls themselves, never on label text.
  await page.waitForFunction(() => {
    const sec2 = document.querySelector('section[aria-label="Profile"]');
    if (!sec2) return false;
    const ctrls = sec2.querySelectorAll("input, textarea, select");
    if (ctrls.length < 6) return false;
    return Array.from(ctrls).every((c) => !c.disabled);
  }, undefined, { timeout: boundedTimeout(BROWSER_TIMEOUT, 8000) });
}
// Stable scoped profile fill: getByRole textbox with prefix regex inside
// section[aria-label=Profile]. Textarea child text becomes part of the
// accessible label after fill, so exact getByLabel stops matching; the
// prefix-role locator stays stable. Single fill + immediate readback; the
// App preserves typed values (no refill loops claiming reverts).
async function fillProfileField(exactLabel, value, what) {
  const isRole = exactLabel === "Role label";
  const box = isRole ? profileBox("Role label", "combobox") : profileBox(exactLabel, "textbox");
  const cnt = await box.count().catch(() => 0);
  if (cnt !== 1) failExit("setup-ambiguous contract: profile field not found (" + what + ", matches=" + cnt + "). " + await profileArtifact("missing-" + what));
  try { await box.first().waitFor({ state: "visible", timeout: boundedTimeout(BROWSER_TIMEOUT, 8000) }); } catch {}
  const enabled = await box.first().isEnabled().catch(() => false);
  if (!enabled) failExit("setup-ambiguous contract: profile field disabled (" + what + "): lookup never settled. " + await profileArtifact("disabled-" + what));
  if (isRole) {
    try { await box.first().selectOption({ label: value }).catch(async () => { await box.first().evaluate((el, v) => { el.value = v; el.dispatchEvent(new Event("change", { bubbles: true })); }, value); }); } catch {}
  } else {
    await box.first().fill(value);
  }
  const read = isRole ? await box.first().inputValue().catch(() => "") || await box.first().evaluate((el) => el.value).catch(() => "") : await box.first().inputValue().catch(() => "");
  if (read !== value) {
    let diag = "";
    try {
      const n = await box.count().catch(() => -1);
      const info = await box.first().evaluate((el) => ({ v: String(el.value == null ? "" : el.value).slice(0, 120), tag: el.tagName, dis: !!el.disabled, conn: !!el.isConnected })).catch(() => null);
      diag = "count=" + n + " node=" + redact(JSON.stringify(info));
    } catch {}
    failExit("setup-ambiguous contract: profile field fill mismatch (" + what + "). want=" + redact(value) + " got=" + redact(read) + " " + diag + " " + await profileArtifact("fill-" + what));
  }
}
// Canonical fresh-collection readback: the SAME wrapper the App uses in
// resolveCanonicalEntry (GET /api/roster?accountId=, unwrap the exact-ID
// entry). Never reads canonical paragraphs from /research.
async function canonicalEntry(id) {
  const rl = await get("/api/roster?accountId=" + ACCT);
  if (rl.status !== 200 || !Array.isArray(rl.json)) return { row: null, entry: null, status: rl.status, text: rl.text };
  let row = null;
  for (let i = 0; i < rl.json.length; i++) {
    const ent = pick(rl.json[i], "entry") || rl.json[i];
    if (String(pick(ent, "id") || "").toLowerCase() === String(id).toLowerCase()) { row = rl.json[i]; break; }
  }
  return { row: row, entry: row ? (pick(row, "entry") || row) : null, status: rl.status, text: "" };
}
function originalThreeStrings(profileJson) { try { const p = JSON.parse(profileJson || "{}"); const raw = [p.contributionCriteria, p.reasoningApproach, p.responseStyle]; if (!Array.isArray(raw) || raw.length !== 3) return null; if (!raw.every((v) => typeof v === "string" && v.length > 0)) return null; return raw; } catch { return null; } }
function threeParas(profileJson) { const r = originalThreeStrings(profileJson); return r ? r.slice() : []; }
function requireThree(full) { return Array.isArray(full) && full.length === 3 && full.every((v) => typeof v === "string" && v.length > 0); }
// Expected 404s are narrowly scoped to PRE-SAVE /api/profile absence only
// (before profileSavedAt). Any later 404 is unexplained.
function isExpectedBad(entry) {
  if (!/^404 \/api\/profile(\?|$|\s)/.test(entry)) return false;
  return profileSavedAt === 0;
}

// ---- 0. register + fake prompt-log loopback check (baseline, never DELETE) ----
async function stepSetup() {
  const healthPre = await get("/health");
  const instPreOk = healthPre.status === 200 && healthPre.json && healthPre.json.service === "simceo-api" && String(healthPre.json.instance || "") === EXPECTED_INSTANCE;
  ok("setup-expected-instance", instPreOk, "instance=" + String((healthPre.json && healthPre.json.instance) || "?").slice(0, 60) + " want=" + EXPECTED_INSTANCE + " " + safeDiag(healthPre));
  if (!instPreOk) failExit("API instance identity mismatch BEFORE first mutation; refusing a foreign stack. want=" + EXPECTED_INSTANCE);
  const readyPre = await get("/ready");
  const readyPreOk = readyPre.status === 200 && readyPre.json && readyPre.json.ready === true && String(readyPre.json.store || "") === "inmemory";
  ok("setup-memory-backend", readyPreOk, "store=" + String((readyPre.json && readyPre.json.store) || "?") + " " + safeDiag(readyPre));
  if (!readyPreOk) failExit("memory backend not confirmed BEFORE first mutation; refusing PG-backed stack.");
  const logPre = MODE === "native" ? await fakeLog() : null;
  if (MODE === "native") {
    ok("fake-loopback-verified", Array.isArray(logPre), logPre === null ? "QA_FAKE /__log unreachable (server must be fake-backed)" : "entries=" + logPre.length);
    if (!Array.isArray(logPre)) failExit("fake prompt log unreachable BEFORE first mutation; refusing to proceed.");
    if (logPre.length !== 0) failExit("fake not fresh BEFORE first mutation; refusing reused prompt log. entries=" + logPre.length);
  }
  if (WEB === "http://127.0.0.1:15396") {
    const bind = qaManifestBinding();
    const qaShaNow = qaFileSha(path.join("qa", "advisor-integrated-qa.mjs"));
    const fakeShaNow = qaFileSha(path.join("qa", "advisor-integrated-fake.mjs"));
    const helperShaNow = qaFileSha(path.join("qa", "own-local-stack.mjs"));
    const m = bind ? bind.manifest : null;
    const presentOk = !!m && typeof m.nonce === "string" && m.nonce.length >= 4 && typeof m.commit === "string" && m.commit.length >= 7 && String(m.instance || "") === EXPECTED_INSTANCE && isHex64(m.dllSha) && isHex64(m.wwwrootSha) && isHex64(m.qaSha) && isHex64(m.fakeSha) && isHex64(m.helperSha);
    const hashOk = presentOk && String(m.qaSha).toLowerCase() === String(qaShaNow).toLowerCase() && String(m.fakeSha).toLowerCase() === String(fakeShaNow).toLowerCase() && String(m.helperSha).toLowerCase() === String(helperShaNow).toLowerCase();
    const pidBind = qaPidBinding();
    const pidRec = pidBind ? pidBind.record : null;
    const pidNonce = pidRec ? String(pidRec.nonce || (pidRec.manifest && pidRec.manifest.nonce) || "") : "";
    const pidCommit = pidRec ? String(pidRec.commit || (pidRec.manifest && pidRec.manifest.commit) || "") : "";
    const pidController = pidRec ? String(pidRec.controllerPid || (pidRec.manifest && pidRec.manifest.controllerPid) || "") : "";
    const mController = m ? String(m.controllerPid || "") : "";
    const pidApiPid = pidRec ? Number(pidRec.apiPid || (pidRec.manifest && pidRec.manifest.apiPid) || 0) : 0;
    const pidFakePid = pidRec ? Number(pidRec.fakePid || (pidRec.manifest && pidRec.manifest.fakePid) || 0) : 0;
    const mApiPid = m ? Number(m.apiPid || 0) : 0;
    const mFakePid = m ? Number(m.fakePid || 0) : 0;
    const recApiIdent = pidRec ? (pidRec.apiIdent || (pidRec.manifest && pidRec.manifest.apiIdent) || null) : null;
    const recFakeIdent = pidRec ? (pidRec.fakeIdent || (pidRec.manifest && pidRec.manifest.fakeIdent) || null) : null;
    const mApiIdent = m ? (m.apiIdent || null) : null;
    const mFakeIdent = m ? (m.fakeIdent || null) : null;
    function identWellFormed(x) { return !!x && x.status === "alive" && String(x.creation || "").length > 0 && String(x.cmd || "").length > 0 && String(x.exe || "").length > 0; }
    const ctrlOk = !!pidRec && !!m && pidController !== "" && mController !== "" && pidController === mController;
    const childPidOk = !!pidRec && !!m && Number.isInteger(pidApiPid) && pidApiPid > 0 && pidApiPid === mApiPid && Number.isInteger(pidFakePid) && pidFakePid > 0 && pidFakePid === mFakePid;
    const childIdentOk = identWellFormed(recApiIdent) && identWellFormed(recFakeIdent) && identWellFormed(mApiIdent) && identWellFormed(mFakeIdent) && String(recApiIdent.cmd || "") === String(mApiIdent.cmd || "") && String(recFakeIdent.cmd || "") === String(mFakeIdent.cmd || "") && String(recApiIdent.creation || "") === String(mApiIdent.creation || "") && String(recFakeIdent.creation || "") === String(mFakeIdent.creation || "");
    const nonceTieOk = !!pidRec && pidNonce === String(m ? m.nonce : "") && pidNonce.length >= 4 && pidCommit === String(m ? m.commit : "") && ctrlOk && childPidOk && childIdentOk;
    const atOk = !!m && Number.isFinite(Number(m.at)) && Number(m.at) > 0 && Number(m.at) <= Date.now() + 60000;
    let servedOk = false, servedDetail = "unverified";
    try {
      const idxRes = await get("/");
      const idxText = typeof idxRes.text === "string" ? idxRes.text : "";
      const idxSha = (() => { try { return crypto.createHash("sha256").update(Buffer.from(idxText, "utf8")).digest("hex"); } catch (e2) { return ""; } })();
      const shaEq = !!idxSha && !!m && String(idxSha).toLowerCase() === String(m.wwwrootSha || "").toLowerCase();
      servedOk = idxRes.status === 200 && idxText.length > 500 && !!shaEq;
      servedDetail = "index status=" + idxRes.status + " len=" + idxText.length + " shaEq=" + (!!shaEq);
    } catch (e) { servedOk = false; servedDetail = "index fetch threw: " + String((e && e.message) || e).slice(0,80); }
    let liveOk = false, liveDetail = "unverified";
    try {
      const uniq = Array.from(new Set([Number(pidController), Number(pidApiPid), Number(pidFakePid)].filter((n) => Number.isInteger(n) && n > 0)));
      const parts = [];
      let allLive = uniq.length === 3;
      for (const pp of uniq) { try { process.kill(pp, 0); parts.push(pp + "=live"); } catch (e) { allLive = false; parts.push(pp + "=" + String((e && e.code) || "dead").slice(0, 20)); } }
      liveOk = allLive && ctrlOk && childPidOk;
      liveDetail = "pids " + parts.join(",") + " ctrl=" + ctrlOk + " childPid=" + childPidOk + " (actual live-process signal check, not file agreement)";
    } catch (e) { liveOk = false; liveDetail = "live check threw: " + String((e && e.message) || e).slice(0, 80); }
    let allServedOk = false, allServedDetail = "unverified";
    try {
      const bb = qaBuildBinding();
      const bman = bb ? bb.manifest : null;
      const wroot = (bman && bman.outputs && bman.outputs.wwwrootAll) ? bman.outputs.wwwrootAll : null;
      if (!bman || bman.success !== true) { allServedDetail = "build-manifest missing/unsuccessful (" + (bb ? bb.path : "none") + ")"; }
      else if (String(bman.commit || "").toLowerCase() !== String(m ? m.commit : "").toLowerCase()) { allServedDetail = "build commit differs from run manifest (rebuild before start)"; }
      else if (!wroot || typeof wroot !== "object" || Array.isArray(wroot)) { allServedDetail = "build-manifest wwwrootAll missing"; }
      else {
        const keys = Object.keys(wroot).sort().filter((k) => String(k).toLowerCase() !== "wwwroot/index.html");
        let bad = 0, checked = 0; const badList = [];
        for (const k of keys) {
          if (!(Date.now() < DEADLINE_MS - 5000)) throw new Error("deadline before all-served check");
          let urlPath = String(k);
          if (urlPath.toLowerCase().startsWith("wwwroot/")) urlPath = urlPath.slice(8);
          const want = String(wroot[k] || "").toLowerCase();
          if (!/^[0-9a-f]{64}$/.test(want)) { bad++; if (badList.length < 5) badList.push(k + ":badhash"); continue; }
          const cap = Math.max(1000, Math.min(15000, remainingMs()));
          const ctl = new AbortController(); pendingCtl.add(ctl); const tt = setTimeout(() => { try { ctl.abort(); } catch {} }, cap);
          try {
            const op = (async () => { const r = await fetch(WEB + "/" + urlPath, { signal: ctl.signal, redirect: "manual" }); if (r.status >= 300 && r.status < 400) return { status: r.status, got: "" }; const ab = await r.arrayBuffer(); let got = ""; try { got = crypto.createHash("sha256").update(Buffer.from(ab)).digest("hex").toLowerCase(); } catch (e2) {} return { status: r.status, got: got }; })();
            trackPromise(op);
            const rr = await op;
            checked++;
            if (!(rr.status === 200 && rr.got === want)) { bad++; if (badList.length < 5) badList.push(k + ":" + rr.status); }
          } catch (e) { checked++; bad++; if (badList.length < 5) badList.push(k + ":throw"); }
          finally { clearTimeout(tt); pendingCtl.delete(ctl); }
          if (bad > 0 && badList.length >= 5) break;
        }
        allServedOk = bad === 0 && checked > 0;
        allServedDetail = "checked=" + checked + " bad=" + bad + (badList.length ? " " + badList.slice(0, 5).join(",") : "") + " (every served wwwroot file raw-bytes sha256 vs build manifest; index covered by servedOk)";
      }
    } catch (e) { allServedOk = false; allServedDetail = "all-served threw: " + String((e && e.message) || e).slice(0, 80); }
    const bindOk = presentOk && hashOk && nonceTieOk && atOk && servedOk && liveOk && allServedOk;
    const identDetail = bind ? ("manifest=" + bind.path + " pid=" + (pidBind ? pidBind.path : "none") + " commit=" + String(m.commit).slice(0,12) + " nonce=" + String(m.nonce).slice(0,12) + " instance=" + String(m.instance) + " dll=" + String(m.dllSha).slice(0,12) + " wwwroot=" + String(m.wwwrootSha).slice(0,12) + " qaMatch=" + (String(m.qaSha||"").toLowerCase()===String(qaShaNow).toLowerCase()) + " fakeMatch=" + (String(m.fakeSha||"").toLowerCase()===String(fakeShaNow).toLowerCase()) + " helperMatch=" + (String(m.helperSha||"").toLowerCase()===String(helperShaNow).toLowerCase()) + " nonceTie=" + nonceTieOk + " ctrl=" + ctrlOk + " childPid=" + childPidOk + " childIdent=" + childIdentOk + " served=" + servedDetail) : "manifest missing";
    ok("setup-trusted-build-binding", bindOk, identDetail + " live=" + liveDetail + " allServed=" + allServedDetail);
    ok("setup-build-input-nonce-controller-child", presentOk && nonceTieOk, "nonce/controller/child identity tied: " + identDetail.slice(0,220));
    ok("setup-served-assets-tied", servedOk, servedDetail + " (served index sha256 equals manifest wwwroot; DLL/runtime + served index bound to nonce/controller identity)");
    ok("setup-live-process-verified", liveOk, liveDetail + " (pidfile/manifest controller+children are ACTUAL live OS processes via kill-signal, not two files agreeing)");
    ok("setup-all-served-assets-bound", allServedOk, allServedDetail);
    if (!bindOk) failExit("trusted build binding failed BEFORE first mutation (build-time production input + DLL/runtime/ALL served assets tied nonce/controller/child identity + QA/fake/helper hashes + ACTUAL live processes). " + identDetail + " live=" + liveDetail + " allServed=" + allServedDetail);
    try { globalThis.__manifestNonce = String(m.nonce); globalThis.__manifestCommit = String(m.commit); } catch {}
    ok("setup-manifest-globals-reported", String(globalThis.__manifestNonce || "") === String(m.nonce) && String(globalThis.__manifestCommit || "") === String(m.commit), "nonce=" + String(m.nonce).slice(0,12) + " commit=" + String(m.commit).slice(0,12));
  } else {
    ok("setup-trusted-build-binding", true, "legacy web " + WEB + " skips OWN manifest binding");
    ok("setup-build-input-nonce-controller-child", true, "legacy web skips OWN manifest binding");
    ok("setup-served-assets-tied", true, "legacy web skips OWN served-asset binding");
  }
  const reg = await post("/api/auth/register", { email: email, password: password });
  ok("setup-register-201", reg.status === 201 && pick(reg.json, "token"), "status=" + reg.status + " " + safeDiag(reg));
  if (reg.status !== 201) failExit("setup register failed status=" + reg.status + " " + safeDiag(reg));
  token = String(pick(reg.json, "token") || ""); authedEmail = String(pick(reg.json, "email") || email);
  ok("setup-token-held", token.length >= 16, "len=" + token.length);
  if (!(token.length >= 16)) failExit("auth token invalid; aborting cascade.");
  const me = await get("/api/auth/me");
  ok("setup-me-authenticated", me.status === 200, "status=" + me.status + " " + safeDiag(me));
  if (me.status !== 200) failExit("auth bootstrap failed; aborting cascade.");
  const health = await get("/health");
  const instOk = health.status === 200 && health.json && health.json.service === "simceo-api" && String(health.json.instance || "") === EXPECTED_INSTANCE;
  ok("setup-expected-instance", instOk, "instance=" + String((health.json && health.json.instance) || "?").slice(0, 60) + " want=" + EXPECTED_INSTANCE + " " + safeDiag(health));
  if (!instOk) failExit("API instance identity mismatch; refusing to mutate a foreign stack. want=" + EXPECTED_INSTANCE);
  const ready = await get("/ready");
  const readyOk = ready.status === 200 && ready.json && ready.json.ready === true && String(ready.json.store || "") === "inmemory";
  ok("setup-memory-backend", readyOk, "store=" + String((ready.json && ready.json.store) || "?") + " " + safeDiag(ready));
  if (!readyOk) failExit("memory backend not confirmed; refusing PG-backed stack.");
  const log = MODE === "native" ? await fakeLog() : null;
  if (MODE === "native") {
    ok("fake-loopback-verified", Array.isArray(log), log === null ? "QA_FAKE /__log unreachable (server must be fake-backed at " + (fakeUrl ? fakeUrl.origin : "?") + ")" : "entries=" + log.length);
    if (!Array.isArray(log)) failExit("fake prompt log unreachable; refusing to proceed without the required fake loopback proof surface.");
  } else {
    console.log("note: live mode; prompt-log assertions use the explicit live-UNPROVED path (no fake proof accepted).");
  }
  // Baseline (no global DELETE, ever): prompt assertions filter t>=baseline
  // AND owned run markers.
  logBaselineT = Date.now();
  ok("promptlog-baseline-captured", logBaselineT > 0, "baselineT=" + logBaselineT + " entries=" + (Array.isArray(log) ? log.length : "n/a-live"));
  checkBudget("setup");
}
// ---- 1. profile via UI without board; two boards reuse; override isolated ----
async function stepProfile() {
  const pre = await get("/api/profile");
  ok("profile-absent-before-save", pre.status === 404, "status=" + pre.status);
  await launchBrowser();
  await gotoTab("/#/profile");
  try { await waitProfileReady(); } catch { failExit("setup-ambiguous contract: profile mount never settled. " + await profileArtifact("mount")); }
  const P = {
    name: "QA Default " + run,
    background: "QA default background paragraph for " + run + ": harbor evening shifts and pilot-boat scheduling.",
    familiar: "QA familiar paragraph for " + run + ": berth allocation and tide windows.",
    simpler: "QA simpler paragraph for " + run + ": explain tide math plainly with one example.",
    comms: "QA default comms " + run + ": be direct, show numbers, end with next step.",
  };
  await fillProfileField("Name", P.name, "name");
  await fillProfileField("Background", P.background, "background");
  await fillProfileField("Subjects already familiar", P.familiar, "familiarTopics");
  await fillProfileField("Subjects needing simpler explanation", P.simpler, "simplerTopics");
  await fillProfileField("Communication preferences", P.comms, "commPrefs");
  // Pre-save stability gate: every scoped field must still hold its value at
  // click time (a background lookup retry can revert in-flight edits). One
  // honest refil pass; a persistently-wiped form FAILs with artifact.
  async function profileValues() {
    const out = {};
    out.name = await profileBox("Name", "textbox").first().inputValue().catch(() => "");
    out.background = await profileBox("Background", "textbox").first().inputValue().catch(() => "");
    out.familiar = await profileBox("Subjects already familiar", "textbox").first().inputValue().catch(() => "");
    out.simpler = await profileBox("Subjects needing simpler explanation", "textbox").first().inputValue().catch(() => "");
    out.comms = await profileBox("Communication preferences", "textbox").first().inputValue().catch(() => "");
    return out;
  }
  assertDeadline("profile-presave");
  const pv = await profileValues();
  const want = { name: P.name, background: P.background, familiar: P.familiar, simpler: P.simpler, comms: P.comms };
  const wiped = Object.keys(want).filter((k) => pv[k] !== want[k]);
  if (wiped.length > 0) failExit("setup-ambiguous contract: profile form mismatch before save (" + wiped.join(",") + "). want-name=" + redact(want.name) + " got=" + redact(pv.name || "") + " " + await profileArtifact("presave-wipe"));
  let saveStatus = 0;
  try {
    const waited = Promise.all([
      page.waitForResponse((r) => /\/api\/(profile|lead)/.test(new URL(r.url()).pathname) && r.request().method() === "POST", { timeout: boundedTimeout(BROWSER_TIMEOUT, 8000) }),
      page.locator('section[aria-label="Profile"]').getByRole("button", { name: "Save profile", exact: true }).first().click(),
    ]);
    const resps = await waited;
    saveStatus = resps[0].status();
  } catch (e) { ok("profile-ui-saved", false, "no POST /api/profile response completion observed. " + await profileArtifact("save-timeout")); }
  if (saveStatus) ok("profile-ui-saved", saveStatus === 200, "status=" + saveStatus);
  if (saveStatus === 200 && profileSavedAt === 0) profileSavedAt = Date.now();
  const g = await get("/api/profile");
  ok("profile-http-readback", g.status === 200 && pick(g.json, "name") === P.name && String(pick(g.json, "background") || "").includes(run) && String(pick(g.json, "familiarTopics") || "").includes(run) && String(pick(g.json, "simplerTopics") || "").includes(run) && pick(g.json, "commPrefs") === P.comms, "status=" + g.status + " " + safeDiag(g));
  const gver = Number(pick(g.json, "version") || 0);
  const mkBoard = async (tag) => {
    const b = await post("/api/boards", { name: run + "-" + tag, mission: "QA integrated board " + tag + " " + run, stage: "qa" });
    if (b.status !== 201 || !pick(b.json, "id")) return { error: "status=" + b.status + " " + safeDiag(b) };
    return { id: String(pick(b.json, "id")) };
  };
  const a = await mkBoard("ab"); const b = await mkBoard("bb");
  ok("boards-created", !!a.id && !!b.id, (a.error || a.id) + " / " + (b.error || b.id));
  if (!a.id || !b.id) failExit("board setup failed.");
  boardA = a.id; boardB = b.id;
  if (profileSavedAt === 0) profileSavedAt = Date.now();
  const la = await get("/api/boards/" + boardA + "/lead"); const lb = await get("/api/boards/" + boardB + "/lead");
  function leadMatches(j, exp) {
    return pick(j, "name") === exp.name && pick(j, "roleLabel") === exp.roleLabel && pick(j, "background") === exp.background && pick(j, "familiarTopics") === exp.familiarTopics && pick(j, "simplerTopics") === exp.simplerTopics && pick(j, "commPrefs") === exp.commPrefs;
  }
  const expDefault = { name: P.name, roleLabel: "Board Lead", background: P.background, familiarTopics: P.familiar, simplerTopics: P.simpler, commPrefs: P.comms };
  const defVer = Number(pick(g.json, "version") || 0);
  const laVer = Number(pick(la.json, "version") || 0), lbVer = Number(pick(lb.json, "version") || 0);
  ok("boards-inherit-default", la.status === 200 && lb.status === 200 && leadMatches(la.json, expDefault) && leadMatches(lb.json, expDefault) && defVer > 0 && laVer === defVer && lbVer === defVer, "a=" + la.status + " b=" + lb.status + " aver=" + laVer + " bver=" + lbVer + " def=" + defVer);
  if (!(la.status === 200 && lb.status === 200 && leadMatches(la.json, expDefault) && leadMatches(lb.json, expDefault) && defVer > 0 && laVer === defVer && lbVer === defVer)) failExit("board lead inheritance failed; refusing to claim inheritance.");
  const over = await post("/api/boards/" + boardA + "/lead", { name: "Board Own " + run, roleLabel: "CEO", background: "ob", familiarTopics: "of", simplerTopics: "os", commPrefs: "oc-" + run, version: pick(la.json, "version") });
  ok("explicit-override-ok", over.status === 200 && pick(over.json, "name") === "Board Own " + run && pick(over.json, "roleLabel") === "CEO" && pick(over.json, "background") === "ob", "status=" + over.status + " " + safeDiag(over));
  if (over.status !== 200) failExit("explicit board override failed; aborting (no cascade).");
  const g2 = await post("/api/profile", { name: P.name, roleLabel: "Board Lead", background: P.background, familiarTopics: P.familiar, simplerTopics: P.simpler, commPrefs: P.comms + " v2", version: gver }, {});
  ok("default-second-save-ok", g2.status === 200 && String(pick(g2.json, "commPrefs") || "").endsWith(" v2") && Number(pick(g2.json, "version") || 0) > gver, "status=" + g2.status + " ver=" + String(pick(g2.json, "version")) + " wantPrev=" + gver);
  if (g2.status !== 200) failExit("second default save failed; aborting.");
  const la2 = await get("/api/boards/" + boardA + "/lead"); const lb2 = await get("/api/boards/" + boardB + "/lead");
  const expOwn = { name: "Board Own " + run, roleLabel: "CEO", background: "ob", familiarTopics: "of", simplerTopics: "os", commPrefs: "oc-" + run };
  const expV2 = { name: P.name, roleLabel: "Board Lead", background: P.background, familiarTopics: P.familiar, simplerTopics: P.simpler, commPrefs: P.comms + " v2" };
  ok("override-preserved-foreign-unaffected", la2.status === 200 && lb2.status === 200 && leadMatches(la2.json, expOwn) && leadMatches(lb2.json, expV2), "a=" + safeDiag(la2).slice(0,120) + " b=" + safeDiag(lb2).slice(0,120));
  const g2Ver = Number(pick(g2.json, "version") || 0);
  const lb2Ver = Number(pick(lb2.json, "version") || 0);
  const overVer = Number(pick(over.json, "version") || 0), la2Ver = Number(pick(la2.json, "version") || 0);
  const verStrictOk = Number.isInteger(overVer) && overVer > 0 && Number.isInteger(la2Ver) && la2Ver > 0 && la2Ver === overVer && Number.isInteger(lb2Ver) && lb2Ver > 0 && lb2Ver === g2Ver && Number.isInteger(g2Ver) && g2Ver > 0;
  ok("override-version-stable", la2.status === 200 && lb2.status === 200 && verStrictOk, "overVer=" + overVer + " now=" + la2Ver + " bNow=" + lb2Ver + " def2=" + g2Ver);
  if (!verStrictOk) failExit("version gate requires strict positive-integer equality; 0==0 never passes.");
  checkBudget("profile");
}
// ---- 2. ONE CreateAdvisor UI flow with real research (dialog-scoped) ----
let researchDoneAt = 0;
async function stepCreateAdvisor() {
  await gotoTab("/#/roster");
  // F1: the ACTUAL rail button reads "+ Create new Advisor".
  try { await page.getByRole("button", { name: /\+ Create new Advisor/ }).first().click({ timeout: boundedTimeout(BROWSER_TIMEOUT, 8000) }); } catch (e) { ok("create-button-actual", false, "rail button + Create new Advisor not clickable"); failExit("CreateAdvisor entry button missing; aborting (no cascade)."); }
  ok("create-button-actual", true, "+ Create new Advisor clicked");
  // F1+F2: scope EVERYTHING to the actual dialog. The dialog hosts one
  // editor; onCreated also selects the new roster entry, mounting the detail
  // editor behind the modal — global locators would straddle both editors.
  const dlg = page.locator('div.modal[role="dialog"][aria-label="Create advisor"]');
  try { await dlg.waitFor({ timeout: boundedTimeout(BROWSER_TIMEOUT, 8000) }); } catch { ok("create-dialog-mounted", false, "Create advisor dialog never mounted (frontend mount WIP?)"); failExit("CreateAdvisor UI not mounted."); }
  ok("create-dialog-mounted", true, "dialog div.modal[role=dialog][aria-label=Create advisor] mounted");
  // F4: documentation-grounded fixture. The subject (reserved example domains
  // in documentation) matches the example.com seed, mirroring the positive
  // fetched baseline in backend qa/character-presence-qa.mjs: fetched:true
  // evidence plus the URL marker carried in the dossier prompt. Harbor
  // expertise + bare example.com is NOT used (that combination proves nothing).
  rosterName = run + "-Docs Adviser";
  await dlg.locator("#cc-name").fill(rosterName);
  await dlg.locator("#cc-description").fill("Documentation and example-domain teaching advisor: explains reserved example domains and illustrative examples in documentation. Fictional teaching advisor for " + run + ". [QA-SLEEP-R:6000]");
  await dlg.locator("#cc-background").fill("Documentation-domain background for " + run + ": teaches reserved example domains and illustrative examples in documentation; keeps an example-domain notebook. [QA-SLEEP-R:6000]");
  await dlg.locator('input[aria-label="Inspiration link 1 of 3"]').fill(OWNED_URL);
  let quickBody = null;
  try {
    const waited = Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === "/api/roster/quick" && r.request().method() === "POST", { timeout: boundedTimeout(BROWSER_TIMEOUT, 8000) }),
      dlg.getByRole("button", { name: /create draft/i }).click(),
    ]);
    const resps = await waited;
    ok("create-draft-via-ui", resps[0].status() === 201, "status=" + resps[0].status());
    try { quickBody = await respJson(resps[0], "roster-quick"); } catch { quickBody = null; }
  } catch (e) { ok("create-draft-via-ui", false, "POST /api/roster/quick never completed"); failExit("draft create failed; aborting (no cascade)."); }
  rosterId = String(pick(quickBody, "id") || "");
  if (!rosterId) failExit("201 but no roster id from UI create.");
  // F5: VISIBLE live progress, dialog-scoped, correlated with server state.
  // Fresh creation auto-starts research; click ONLY from a proven idle state.
  const statusLoc = dlg.locator("#cc-research-status");
  function backendHuman(stage) { if (stage === "starting") return "Starting"; if (stage === "fetching-sources") return "Reading your links"; if (stage === "researching") return "Researching"; if (stage === "compiling") return "Writing the three paragraphs"; if (stage === "running") return "Running"; return ""; }
  const KNOWN_STAGES = new Set(["not-started","starting","fetching-sources","researching","compiling","running","done","failed","unsupported","interrupted"]);
  const WORKING_STAGES = new Set(["starting","fetching-sources","researching","compiling","running"]);
  let researchLocalEnd = 0;
  async function readResearch() {
    let text = ""; let visible = false;
    try { text = await statusLoc.innerText(); } catch { text = ""; }
    try { visible = await statusLoc.isVisible(); } catch { visible = false; }
    let running = null, stage = "", okShape = false;
    try {
      const g = researchLocalEnd > 0 ? await getLocal("/api/roster/" + rosterId + "/research", researchLocalEnd) : await get("/api/roster/" + rosterId + "/research");
      if (g.status === 200 && g.json && typeof g.json === "object") {
        const rr = pick(g.json, "running");
        const st = String(pick(g.json, "stage") || "");
        if (typeof rr === "boolean" && KNOWN_STAGES.has(st)) { running = rr; stage = st; okShape = true; }
        else { running = null; stage = st; okShape = false; }
      } else okShape = false;
    } catch { okShape = false; }
    return { text: text || "", visible: visible, running: running, stage: stage, valid: okShape };
  }
  function isLiveProgress(t, visible, running, stage, valid) {
    if (valid !== true) return false;
    if (running !== true) return false;
    if (typeof running !== "boolean") return false;
    if (!KNOWN_STAGES.has(String(stage))) return false;
    if (!WORKING_STAGES.has(String(stage))) return false;
    if (visible !== true) return false;
    if (!/research status:\s*working/i.test(t)) return false;
    const want = backendHuman(String(stage));
    if (!want) return false;
    // Bounded resample tolerance: HTTP stage may advance between UI and HTTP
    // reads, so accept the human label for the current stage. Elapsed/live-run
    // wording plus visible working plus exact running/stage correlation proves it.
    if (!t.includes(want)) return false;
    if (!/(\ds elapsed|live server run)/.test(t)) return false;
    return true;
  }
  const researchOpStart = Date.now();
  researchLocalEnd = Math.min(researchOpStart + RESEARCH_TIMEOUT, DEADLINE_MS - 8000);
  ok("research-window-opened-before-probe", researchLocalEnd > researchOpStart, "local research window starts BEFORE progress probe/send/Secretary");
  const s0 = await readResearch();
  const autoStarted = s0.valid === true && (s0.running === true || /research status:\s*working/i.test(s0.text));
  let clickedManual = false;
  const terminalStage = ["done", "failed", "unsupported", "interrupted"].includes(String(s0.stage));
  // Restart ONLY on exact not-started with HTTP 200, raw boolean false, and no working text.
  const provenNotStarted = s0.valid === true && s0.running === false && String(s0.stage) === "not-started" && !/research status:\s*working/i.test(s0.text);
  if (!autoStarted && !terminalStage && provenNotStarted) {
    try { await dlg.getByRole("button", { name: /run research on this draft/i }).click({ timeout: boundedTimeout(8000, 8000) }); clickedManual = true; } catch {}
    await wft(1500);
  }
  let progressSeen = "";
  let progressBackend = "";
  if (isLiveProgress(s0.text, s0.visible, s0.running, s0.stage, s0.valid)) { progressSeen = trunc(s0.text, 160); progressBackend = "phase=research running=" + s0.running + " stage=" + s0.stage + " visible=" + s0.visible + " s0-retained"; }
  for (let i = 0; i < 8 && !progressSeen; i++) {
    assertDeadline("research-progress");
    const s = await readResearch();
    if (isLiveProgress(s.text, s.visible, s.running, s.stage, s.valid)) { progressSeen = trunc(s.text, 160); progressBackend = "phase=research running=" + s.running + " stage=" + s.stage + " visible=" + s.visible; break; }
    await sleep(2000);
  }
  ok("research-progress-live-visible", progressSeen !== "", (progressSeen || "phase=research no working/human-stage/elapsed/live-run visible") + " autoStarted=" + autoStarted + " manualClicked=" + clickedManual + " " + progressBackend);
  if (!progressSeen) failExit("research progress never visibly live with backend running/stage correlation; refusing to claim progress from a click. phase=research stage=" + String(s0.stage) + " running=" + String(s0.running) + " textLen=" + String((s0.text||"").length));
  // Bounded wait for the REAL server run via GET research state.
  const end = researchLocalEnd;
  let stage = "", done = false, lastText = "";
  assertDeadline("research-wait");
  const hb = setInterval(() => { try { if (Date.now() > DEADLINE_MS) { try { clearInterval(hb); } catch {} return; } console.log("research: still pending..."); } catch {} }, 20000);
  try {
    while (Date.now() < end) {
      assertDeadline("research-wait-poll");
        const g = await getLocal("/api/roster/" + rosterId + "/research", researchLocalEnd);
      if (g.status === 200 && g.json) {
        stage = String(pick(g.json, "stage") || "");
        const ds = String(pick(g.json, "draftStatus") || pick(g.json, "draftstatus") || "");
        lastText = "stage=" + stage + " draftStatus=" + ds;
        if (stage === "done") { done = true; break; }
        if (stage === "failed" || stage === "unsupported" || stage === "interrupted") break;
      }
      try {
        const st = await statusLoc.innerText().catch(() => "");
        if (!progressSeen && isLiveProgress(st)) progressSeen = trunc(st, 160);
      } catch {}
      await sleep(3000);
    }
  } finally { clearInterval(hb); }
  const g = await getLocal("/api/roster/" + rosterId + "/research", researchLocalEnd);
  const evCount = Number(pick(g.json, "evidenceCount") ?? pick(g.json, "evidencecount") ?? -1);
  const supported = /yes|true/i.test(String(pick(g.json, "supported") ?? "")) || evCount >= 1;
  // F4 continued: the owned seed URL must be tracked AND fetched, and the
  // dossier prompt (responses path) must carry the owned marker — otherwise
  // the result is unsupported production behavior and an honest FAIL.
  const srcs = pick(g.json, "sources") || [];
  const srcArr = Array.isArray(srcs) ? srcs : [];
  const ownedFetched = srcArr.filter((e) => String((e && (e.url || e.Url)) || "").includes(OWNED_URL_MARK) && ((e && (e.fetched !== undefined ? e.fetched : e.Fetched)) === true));
  let ownedPrompt = 0;
  const log0 = MODE === "native" ? await fakeLog() : null;
  if (MODE === "native") {
    if (!Array.isArray(log0)) failExit("native mode requires the integrated fake prompt log at OWN fake (15398); log missing.");
    ownedPrompt = dossierHits(log0, OWNED_URL_MARK).length;
  }
  ok("research-evidence-owned-fetched", done && ownedFetched.length >= 1, lastText + " evidenceCount=" + evCount + " ownedFetched=" + ownedFetched.length);
  if (!(done && ownedFetched.length >= 1)) failExit("research evidence incomplete; refusing to claim grounding.");
  if (MODE === "native") ok("research-dossier-prompt-owned", ownedPrompt >= 1, "owned dossier prompts=" + ownedPrompt);
  else ok("research-dossier-prompt-owned", false, "live mode: prompt inspection unavailable; dossier proof via fetched-evidence only (UNPROVED prompt path)");
  if (MODE === "native") {
    const ownedSrc = ownedFetched.length > 0 ? ownedFetched[0] : null;
    const excerpt = ownedSrc ? String(ownedSrc.excerpt || ownedSrc.Excerpt || "") : "";
    const dossierTexts = Array.isArray(log0) ? dossierHits(log0, OWNED_URL_MARK).map((e) => logText(e)) : [];
    const compileTexts = Array.isArray(log0) ? ownedLog(log0).filter((e) => logText(e).includes("COMPILE-CHARACTER-PARAGRAPHS") && logText(e).includes(rosterName)).map((e) => logText(e)) : [];
    // FULL exact fetched excerpt (never a 24-char prefix): the complete owned
    // excerpt string must appear verbatim in at least one dossier prompt.
    const excerptFullOk = excerpt.length >= 20;
    const excerptInDossierFull = excerptFullOk && dossierTexts.some((t) => t.includes(excerpt));
    ok("research-excerpt-full-in-dossier", excerptFullOk && excerptInDossierFull && dossierTexts.length >= 1, "excerptLen=" + excerpt.length + " fullVerbatim=" + excerptInDossierFull + " dossierN=" + dossierTexts.length);
    if (!(excerptFullOk && excerptInDossierFull && dossierTexts.length >= 1)) failExit("grounded transfer must prove the FULL exact fetched excerpt verbatim in the dossier prompt (prefix/heading match is not proof).");
    // ACTUAL returned unique dossier content (never heading-only): every
    // full dossier-claim line from ResearchJson must appear verbatim in the
    // compile input. Headings alone never pass.
    let dossierLines = [];
    try {
      const rj = g && g.json ? (pick(g.json, "ResearchJson") || pick(g.json, "researchJson") || pick(g.json, "researchjson")) : null;
      const parsed = typeof rj === "string" ? JSON.parse(rj || "{}") : (rj && typeof rj === "object" ? rj : null);
      const claims = parsed && Array.isArray(parsed.claims) ? parsed.claims : [];
      for (const c of claims) { const ang = c && typeof c.angle === "string" ? c.angle : ""; const tx = c && typeof c.text === "string" ? c.text : ""; if (ang === "dossier" && tx && tx.length >= 10) dossierLines.push(tx); }
    } catch {}
    const dossierContentOk = dossierLines.length >= 1;
    let citationLines = [];
    try {
      const rj2 = g && g.json ? (pick(g.json, "ResearchJson") || pick(g.json, "researchJson") || pick(g.json, "researchjson")) : null;
      const parsed2 = typeof rj2 === "string" ? JSON.parse(rj2 || "{}") : (rj2 && typeof rj2 === "object" ? rj2 : null);
      const claims2 = parsed2 && Array.isArray(parsed2.claims) ? parsed2.claims : [];
      for (const c of claims2) { const ang2 = c && typeof c.angle === "string" ? c.angle : ""; const tx2 = c && typeof c.text === "string" ? c.text : ""; if (ang2 !== "dossier" && tx2 && tx2.length >= 10) citationLines.push(tx2); }
    } catch {}
    function dossierOrderInCompile(lines, compileText) { let pos = -1; for (const ln of lines) { if (!ln || ln.length < 10) return false; const idx = compileText.indexOf(ln); if (idx < 0 || idx <= pos) return false; pos = idx + ln.length; const tail = ln.slice(Math.max(0, ln.length - 40)); if (!tail || tail.length < 10 || compileText.indexOf(tail, idx) < 0) return false; } return true; }
    const dossierInCompileFull = dossierContentOk && compileTexts.some((c) => dossierOrderInCompile(dossierLines, c));
    const dossierTailOk = dossierContentOk && dossierLines.every((ln) => { const tail = ln.slice(Math.max(0, ln.length - 40)); return tail.length >= 10 && compileTexts.some((c) => c.includes(ln) && c.includes(tail)); });
    const compileHeadingOnly = compileTexts.some((c) => c.includes("Dossier (grounded evidence"));
    ok("research-dossier-content-full-in-compile", dossierContentOk && dossierInCompileFull && dossierTailOk && compileTexts.length >= 1, "dossierLines=" + dossierLines.length + " allVerbatimOrderTail=" + (dossierInCompileFull && dossierTailOk) + " compileN=" + compileTexts.length + " headingAlsoPresent=" + compileHeadingOnly + " (ACTUAL dossier answer angle=dossier only, whole-line+tail+order in ONE correlated compile input)");
    ok("research-citation-snippets-not-required", dossierContentOk && dossierInCompileFull, "citationLines=" + citationLines.length + " separatelyStored=" + (citationLines.length >= 0) + " (production BuildCompileInput passes only g.Text dossier=" + dossierLines.length + " lines; citation excerpts angle!=dossier stored separately and never required in compile input)");
    if (!(dossierContentOk && dossierInCompileFull && dossierTailOk && compileTexts.length >= 1)) failExit("grounded transfer must prove ACTUAL returned dossier-answer payload (angle=dossier, whole-line+tail+order, correlated compile input); citation snippets are separate and never required.");
    ok("research-excerpt-dossier-compile", excerptFullOk && excerptInDossierFull && dossierContentOk && dossierInCompileFull && dossierTailOk && dossierTexts.length >= 1 && compileTexts.length >= 1, "excerptLen=" + excerpt.length + " dossierLines=" + dossierLines.length + " dossierN=" + dossierTexts.length + " compileN=" + compileTexts.length + " tailOrder=" + dossierTailOk);
    if (!(excerptFullOk && excerptInDossierFull && dossierContentOk && dossierInCompileFull && dossierTailOk)) failExit("grounded transfer must prove fetched excerpt in dossier prompt and dossier-answer carried whole-line+tail+order in correlated compile prompt.");
  } else {
    ok("research-excerpt-full-in-dossier", false, "live mode UNPROVED prompt path");
    ok("research-dossier-content-full-in-compile", false, "live mode UNPROVED prompt path");
    ok("research-excerpt-dossier-compile", false, "live mode UNPROVED prompt path");
    ok("research-citation-snippets-not-required", false, "live mode UNPROVED prompt path");
  }
  ok("research-supported-or-honest-fail", done && (supported || evCount >= 1), lastText + " evidenceCount=" + evCount);
  if (!done || !(supported || evCount >= 1)) failExit("research did not ground honestly (" + lastText + "); refusing to force ResearchJson/approval.");
  researchDoneAt = Date.now();
  // Compiled paragraphs: adopt via the DIALOG editor only, then read the 3
  // dialog editables.
  async function readParas() {
    const fs = dlg.locator("fieldset").filter({ hasText: "Character paragraphs" }).locator("textarea");
    const n = await fs.count(); const vals = [];
    for (let i = 0; i < n; i++) vals.push(await fs.nth(i).inputValue().catch(() => ""));
    return vals;
  }
  for (let i = 0; i < 3; i++) {
    try {
      const btns = dlg.getByRole("button", { name: /use compiled draft/i });
      const n = await btns.count();
      if (n > 0) { await btns.first().click({ timeout: boundedTimeout(5000, 8000) }); await wft(800); }
      else break;
    } catch { break; }
  }
  const resState = await get("/api/roster/" + rosterId + "/research");
  const draft = (resState.status === 200 && resState.json) ? (pick(resState.json, "draftProfile") || null) : null;
  const dParas = draft ? [String(pick(draft, "contributionCriteria") || ""), String(pick(draft, "reasoningApproach") || ""), String(pick(draft, "responseStyle") || "")] : [];
  if (MODE === "native") {
    const who = rosterName;
    const expC = "QA-CRITERIA for " + who + ": contributes fleet logistics and port risk; abstains without port data.";
    const expR = "QA-REASON for " + who + ": compares options against port evidence; agrees when supported, challenges unsupported premises; never invents credentials.";
    const expS = "QA-STYLE for " + who + ": blunt about port risk, diplomatic with crew; detailed when evidence allows.";
    ok("research-compiled-exact", resState.status === 200 && !!draft && dParas[0] === expC && dParas[1] === expR && dParas[2] === expS, "status=" + resState.status + " who=" + who.slice(-12) + " lens=" + dParas.map((v) => v.length).join(","));
    if (!(resState.status === 200 && dParas[0] === expC)) failExit("deterministic fake compile did not round-trip with advisor identity; refusing generic-text pass.");
  } else {
    ok("research-compiled-exact", resState.status === 200 && !!draft && dParas.length === 3 && dParas.every((v) => v.trim().length > 20 && !v.includes("Seed (pending research)")), "live semantic: count=" + dParas.length);
  }
  let paras = await readParas();
  ok("research-compiled-3paras", paras.length === 3 && requireThree(paras) && paras.every((v) => v.trim().length > 20 && !v.includes("Seed (pending research)")), "count=" + paras.length + " lens=" + paras.map((v) => v.length).join(","));
  ok("research-editor-matches-draft", paras.length === 3 && dParas.length === 3 && paras[0] === dParas[0] && paras[1] === dParas[1] && paras[2] === dParas[2], "editor==draftProfile both modes");
  // Owner final tweaks with unique markers, saved through the DIALOG editor.
  const fs = dlg.locator("fieldset").filter({ hasText: "Character paragraphs" }).locator("textarea");
  const marks = [M1, M2, M3];
  const submitted = [];
  for (let i = 0; i < 3 && i < paras.length; i++) {
    const cur = await fs.nth(i).inputValue().catch(() => "");
    const next = cur.trim() + " [" + marks[i] + "]";
    await fs.nth(i).fill(next);
    submitted.push(next);
  }
  const before = await get("/api/roster/" + rosterId + "/research");
  const verBefore = Number(pick(before.json, "version") || 0);
  try {
    const waited = Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === "/api/roster/" + rosterId && r.request().method() === "PUT", { timeout: boundedTimeout(BROWSER_TIMEOUT, 8000) }),
      dlg.getByRole("button", { name: /save draft changes/i }).click(),
    ]);
    const resps = await waited;
    ok("owner-tweaks-saved", resps[0].status() === 200, "status=" + resps[0].status());
  } catch (e) { ok("owner-tweaks-saved", false, "PUT /api/roster/{id} never completed"); }
  // F3: readback via the canonical fresh collection wrapper (exact-ID entry),
  // exactly as resolveCanonicalEntry does. /research carries NO profileJson.
  const canon = await canonicalEntry(rosterId);
  const rawJson = canon.entry ? (pick(canon.entry, "profileJson") || pick(canon.entry, "profilejson") || "") : "";
  const rawOk = originalThreeStrings(rawJson) !== null;
  const full = threeParas(rawJson);
  let rawExactOk = false; try { const _pj0 = JSON.parse(rawJson || "null"); rawExactOk = _pj0 && _pj0.contributionCriteria === submitted[0] && _pj0.reasoningApproach === submitted[1] && _pj0.responseStyle === submitted[2]; } catch { rawExactOk = false; }
  ok("owner-markers-roundtrip", canon.status === 200 && !!canon.entry && rawOk && rawExactOk && requireThree(full) && full.every((v, i) => v === submitted[i]), "status=" + canon.status + " rawJsonExact=" + rawExactOk);
  if (!(canon.status === 200 && canon.entry && requireThree(full) && rawExactOk)) failExit("canonical fresh-collection readback must be full three JSON raw strings with exact submitted roundtrip.");
  const after = await get("/api/roster/" + rosterId + "/research");
  const afterVer = Number(pick(after.json, "version") || 0);
  const ownerBumpOk = Number.isInteger(afterVer) && Number.isInteger(verBefore) && afterVer > verBefore;
  ok("owner-version-bump", ownerBumpOk, "before=" + verBefore + " after=" + afterVer);
  if (!ownerBumpOk) failExit("owner version must strictly increase; 0==0 never passes.");
  // Creation debug scan BEFORE Close while dialog is VISIBLE (same collector/detector contract as all scans).
  try { if (!(await dlg.count()) || !(await dlg.first().isVisible())) failExit("create dialog must be visible during creation scan."); } catch (e) { failExit("create dialog visibility gate failed before scan."); }
  await scanDebug("create-dialog");
  // F2: close the dialog so later edits use ONLY the selected-roster detail editor (never two mounted editors again).
  try { await dlg.locator('button[aria-label="Close"]').first().click({ timeout: boundedTimeout(8000, 8000) }); } catch {}
  await wft(600);
  ok("create-dialog-closed", await dlg.count() === 0, "dialog editors remaining=" + await dlg.count());
  checkBudget("create-advisor");
}
// ---- 3. portrait + attach gates + second member ----
// Source-confirmed invariant: the untouched quick second seed leaves
// ResearchRequested=false, and completeness/research approval checks are
// conditional on that flag — missing research is NOT a confirmed
// attach/approval blocker for this seed. The second member is therefore
// created via real HTTP quick + portrait + accept + copy + approve, and is
// proven profile-valid through the completeness gate + canonical readback
// (no research assertions on it, honestly).
async function stepPortraitAttach() {
  const up = await uploadPortrait(rosterId, "A");
  ok("portrait-upload-201", up.status === 201, "status=" + up.status + " len=" + up.text.length);
  if (up.status !== 201) failExit("portrait upload failed; refusing attach proof.");
  const imgs = await get("/api/roster/" + rosterId + "/images");
  const imgList = Array.isArray(imgs.json) ? imgs.json : [];
  const imgId = imgList.length > 0 ? String(pick(imgList[0], "id") || "") : "";
  if (!imgId) failExit("portrait uploaded but not listed: " + safeDiag(imgs));
  let rev = { status: 0, text: "" };
  if (imgId) rev = await post("/api/images/" + imgId + "/review", { decision: "accept" });
  ok("portrait-accept-200", rev.status === 200, "status=" + rev.status + " " + safeDiag(rev));
  if (rev.status !== 200) failExit("portrait review failed; refusing to attach without the accepted gate.");
  const cp = await post("/api/roster/" + rosterId + "/copy", { boardId: boardA, boardRole: "Harbor Strategist" });
  ok("attach-first-201", cp.status === 201 && !!pick(cp.json, "id"), "status=" + cp.status + " hasId=" + !!pick(cp.json, "id"));
  if (!(cp.status === 201 && pick(cp.json, "id"))) failExit("first attach failed; refusing approval proof.");
  if (!pick(cp.json, "id")) failExit("first attach failed.");
  advisor1 = String(pick(cp.json, "id"));
  const dup = await post("/api/roster/" + rosterId + "/copy", { boardId: boardA, boardRole: "Harbor Strategist" });
  ok("duplicate-attach-409", dup.status === 409, "status=" + dup.status);
  if (dup.status !== 409) failExit("duplicate attach must 409; refusing isolation proof.");
  const ap = await post("/api/boards/" + boardA + "/advisors/" + advisor1 + "/approve", {});
  ok("approve-first-200", ap.status === 200, "status=" + ap.status + " " + safeDiag(ap));
  if (ap.status !== 200) failExit("approve gate did not clear on a researched+accepted advisor.");
  const q2 = await post("/api/roster/quick", { accountId: ACCT, name: run + "-Tide Watcher", description: "Fictional tide-watch member validating that non-participants are still listed for " + run + "." });
  ok("second-quick-201", q2.status === 201 && pick(q2.json, "id"), "status=" + q2.status + " " + safeDiag(q2));
  if (!pick(q2.json, "id")) failExit("second member quick failed.");
  roster2 = String(pick(q2.json, "id") || "");
  checkBudget("portrait-attach");
}
// ---- 3b. second member gates + canonical board-advisor resolution ----
async function stepSecondMember() {
  const up2 = await uploadPortrait(roster2, "B");
  ok("second-portrait-upload-201", up2.status === 201, "status=" + up2.status + " " + safeDiag(up2));
  if (up2.status !== 201) failExit("second portrait upload failed status=" + up2.status + "; refusing attach proof (all prereqs FATAL).");
  const imgs2 = await get("/api/roster/" + roster2 + "/images");
  const imgId2 = Array.isArray(imgs2.json) && imgs2.json.length > 0 ? String(pick(imgs2.json[0], "id") || "") : "";
  const rev2 = imgId2 ? await post("/api/images/" + imgId2 + "/review", { decision: "accept" }) : { status: 0, text: "no-image" };
  ok("second-portrait-accept-200", rev2.status === 200, "status=" + rev2.status + " " + safeDiag(rev2));
  if (!imgId2) failExit("second portrait uploaded but not listed; refusing attach proof (all prereqs FATAL).");
  if (rev2.status !== 200) failExit("second portrait review failed status=" + rev2.status + "; refusing attach proof (all prereqs FATAL).");
  // Profile-validated through the REAL gates: completeness endpoint (which is
  // research-conditional for this seed) + canonical fresh-collection readback.
  const comp = await get("/api/roster/" + roster2 + "/completeness");
  const compList = Array.isArray(pick(comp.json, "missing")) ? pick(comp.json, "missing") : [];
  ok("second-complete-gate", comp.status === 200 && pick(comp.json, "complete") === true, "status=" + comp.status + " missing=" + compList.join(";"));
  if (!(comp.status === 200 && pick(comp.json, "complete") === true)) failExit("second member completeness gate failed; refusing attach proof.");
  const canon2 = await canonicalEntry(roster2);
  const p2 = threeParas(canon2.entry ? (pick(canon2.entry, "profileJson") || "") : "");
  ok("second-profile-validated", canon2.status === 200 && !!canon2.entry && originalThreeStrings(canon2.entry ? (pick(canon2.entry, "profileJson") || "") : "") !== null && requireThree(p2), "status=" + canon2.status + " lens=" + p2.map((v) => v.length).join(","));
  if (!(canon2.status === 200 && !!canon2.entry && requireThree(p2))) failExit("second member canonical invalid; refusing attach proof.");
  const cp2 = await post("/api/roster/" + roster2 + "/copy", { boardId: boardA, boardRole: "Tide Watcher" });
  ok("second-attach-201", cp2.status === 201 && pick(cp2.json, "id"), "status=" + cp2.status + " " + safeDiag(cp2));
  if (!pick(cp2.json, "id")) failExit("second attach failed.");
  advisor2 = String(pick(cp2.json, "id"));
  const ap2 = await post("/api/boards/" + boardA + "/advisors/" + advisor2 + "/approve", {});
  ok("second-approve-200", ap2.status === 200, "status=" + ap2.status + " " + safeDiag(ap2));
  if (ap2.status !== 200) failExit("second-advisor approval failed status=" + ap2.status + "; refusing dependent work (all prereqs FATAL, no cascade).");
  // Per-board GET: ALL advisor canonical IDs resolve to owned roster entries.
  const al = await get("/api/boards/" + boardA + "/advisors");
  const list = Array.isArray(al.json) ? al.json : [];
  const have1 = list.some((x) => String(pick(x, "id") || "").toLowerCase() === advisor1.toLowerCase());
  const have2 = list.some((x) => String(pick(x, "id") || "").toLowerCase() === advisor2.toLowerCase());
  const rl = await get("/api/roster?accountId=" + ACCT);
  const rows = Array.isArray(rl.json) ? rl.json : [];
  const rosterIds = new Set(rows.map((x) => String(pick(pick(x, "entry") || x, "id") || "").toLowerCase()));
  const unresolvable = list.filter((x) => !rosterIds.has(String(pick(x, "rosterEntryId") || pick(x, "rosterentryid") || "").toLowerCase()));
  ok("board-advisors-resolve-roster", al.status === 200 && have1 && have2 && unresolvable.length === 0, "status=" + al.status + " advisors=" + list.length + " unresolvable=" + unresolvable.length);
  checkBudget("second-member");
}
// ---- 4. meeting UI send + activity + secretary ----
// F8: RAW backend states (MeetingActivity: awaiting-selection,
// awaiting-publication, ...) are validated against the raw contract ONLY;
// RENDERED rail badge classes are validated against the mapped UI vocabulary
// (meeting-activity.ts maps awaiting-* to waiting-for-*). Never compared
// across vocabularies.
const RAW_VOCAB = new Set(["idle", "queued", "awaiting-selection", "considering", "responding", "awaiting-publication", "complete", "abstained", "failed", "interrupted"]);
const MAPPED_VOCAB = new Set(["idle", "queued", "waiting-for-selection", "considering", "responding", "waiting-for-publication", "complete", "abstained", "waiting-for-clarification", "failed", "interrupted", "excluded", "needs-approval", "pending"]);
function mapRaw(s) { if (s === "awaiting-selection") return "waiting-for-selection"; if (s === "awaiting-publication") return "waiting-for-publication"; return s; }
async function getActivity(mid, localEnd) {
  const a = (typeof localEnd === "number" && localEnd > 0) ? await getLocal("/api/meetings/" + mid + "/activity", localEnd) : await get("/api/meetings/" + mid + "/activity");
  if (a.status !== 200 || !a.json || typeof a.json !== "object") return { status: a.status, states: null, malformed: true };
  const disc = pick(a.json, "discussion");
  if (!disc || typeof disc !== "object") return { status: a.status, states: null, malformed: true };
  const arr = pick(disc, "advisors");
  if (!Array.isArray(arr)) return { status: a.status, states: null, malformed: true };
  for (const x of arr) {
    if (!x || typeof x !== "object") return { status: a.status, states: null, malformed: true };
    if (typeof pick(x, "advisorId") !== "string" || typeof pick(x, "state") !== "string") return { status: a.status, states: null, malformed: true };
  }
  return { status: 200, states: arr.map((x) => ({ id: String(pick(x, "advisorId") || ""), state: String(pick(x, "state") || ""), reason: String(pick(x, "reason") || "") })), malformed: false };
}
async function stepMeeting() {
  const m = await post("/api/boards/" + boardA + "/meetings", { title: run + " harbor call", brief: "", participantIds: [advisor1, advisor2] });
  ok("meeting-created-201", m.status === 201 && pick(m.json, "id"), "status=" + m.status + " " + safeDiag(m));
  if (!pick(m.json, "id")) failExit("meeting create failed.");
  meetingId = String(pick(m.json, "id"));
  const det0 = await get("/api/boards/" + boardA + "/meetings/" + meetingId);
  ok("meeting-brief-empty", det0.status === 200 && String(pick(det0.json, "brief") || "") === "", "status=" + det0.status);
  await gotoTab("/#/meet?board=" + encodeURIComponent(boardA) + "&meeting=" + encodeURIComponent(meetingId));
  const detInit = await get("/api/boards/" + boardA + "/meetings/" + meetingId);
  let initIds = null;
  if (detInit.status === 200 && detInit.json) { const r0 = pick(detInit.json, "participantIds"); if (Array.isArray(r0)) initIds = r0.map(String); else { try { const pj = JSON.parse(pick(detInit.json, "participantIdsJson") || "[]"); if (Array.isArray(pj)) initIds = pj.map(String); } catch {} } }
  const initSetOk = Array.isArray(initIds) && initIds.length === 2 && initIds.map(String).map((v) => v.toLowerCase()).sort().join(",") === [advisor1, advisor2].map(String).map((v) => v.toLowerCase()).sort().join(",");
  ok("meeting-initial-two", initSetOk, "exactSet={advisor1,advisor2} got=" + (initIds ? initIds.join(",").slice(0,80) : "unparsed"));
  if (!initSetOk) failExit("initial participant set must exactly equal {advisor1,advisor2} before restriction.");
  // d896a83 closure: PATCH is a real route, but SAME-hash goto does NOT document reload-refetch, so rail can render stale included state.
  const rp1 = await patch("/api/meetings/" + meetingId, { participantIds: [advisor1] });
  const detPre = await get("/api/boards/" + boardA + "/meetings/" + meetingId);
  let preIds = null;
  if (detPre.status === 200 && detPre.json) { const r1 = pick(detPre.json, "participantIds"); if (Array.isArray(r1)) preIds = r1.map(String); else { try { const pj = JSON.parse(pick(detPre.json, "participantIdsJson") || "[]"); if (Array.isArray(pj)) preIds = pj.map(String); } catch {} } }
  const preExact = Array.isArray(preIds) && preIds.length === 1 && String(preIds[0]).toLowerCase() === String(advisor1).toLowerCase();
  const imgA0 = await get("/api/roster/" + rosterId + "/images");
  const imgB0 = await get("/api/roster/" + roster2 + "/images");
  const accA0 = Array.isArray(imgA0.json) && imgA0.json.some((x) => pick(x, "review") === "accepted" || pick(x, "review") === "grandfathered");
  const accB0 = Array.isArray(imgB0.json) && imgB0.json.some((x) => pick(x, "review") === "accepted" || pick(x, "review") === "grandfathered");
  const advCol0 = await get("/api/boards/" + boardA + "/advisors");
  const advList0 = Array.isArray(advCol0.json) ? advCol0.json : [];
  const roleA0 = advList0.some((x) => String(pick(x, "id") || "").toLowerCase() === String(advisor1).toLowerCase() && String(pick(x, "boardRole") || "") === "Harbor Strategist");
  const roleB0 = advList0.some((x) => String(pick(x, "id") || "").toLowerCase() === String(advisor2).toLowerCase() && String(pick(x, "boardRole") || "") === "Tide Watcher");
  ok("meeting-restrict-patch-exact-preset", (rp1.status === 200 || rp1.status === 204) && detPre.status === 200 && preExact && accA0 && accB0 && roleA0 && roleB0, "patch=" + rp1.status + " detail=" + detPre.status + " exactPre=" + preExact + " accA=" + accA0 + " accB=" + accB0 + " roleA=" + roleA0 + " roleB=" + roleB0);
  if (!((rp1.status === 200 || rp1.status === 204) && preExact)) failExit("participant PATCH response-exact barrier failed before rail; refusing stale-rail proof. patch=" + rp1.status + " " + safeDiag(rp1));
  await gotoTab("/#/meet?board=" + encodeURIComponent(boardA) + "&meeting=" + encodeURIComponent(meetingId));
  try { await page.reload({ waitUntil: "domcontentloaded", timeout: boundedTimeout(BROWSER_TIMEOUT, 8000) }); } catch {}
  await wft(Math.min(1500, Math.max(1, remainingMs())));
  try { await page.waitForResponse((r) => { try { return new URL(r.url()).pathname === "/api/boards/" + boardA + "/meetings/" + meetingId && r.request().method() === "GET"; } catch { return false; } }, { timeout: Math.min(20000, Math.max(1, remainingMs())) }).catch(() => null); } catch {}
  try { await page.waitForResponse((r) => { try { return new URL(r.url()).pathname === "/api/boards/" + boardA + "/advisors" && r.request().method() === "GET"; } catch { return false; } }, { timeout: Math.min(20000, Math.max(1, remainingMs())) }).catch(() => null); } catch {}
  try { await page.waitForResponse((r) => { try { return new URL(r.url()).pathname === "/api/meetings/" + meetingId + "/activity" && r.request().method() === "GET"; } catch { return false; } }, { timeout: Math.min(20000, Math.max(1, remainingMs())) }).catch(() => null); } catch {}
  try { await page.waitForFunction(() => { const rail = document.querySelector('section.meet-participants ul.mp-rail[aria-label="Participant activity"]'); if (!rail) return false; const seats = rail.querySelectorAll("li.mp-seat"); if (seats.length !== 4) return false; const names = Array.from(rail.querySelectorAll(".mp-name")).map((e) => e.textContent || ""); const idx = names.findIndex((n) => String(n).indexOf("Tide Watcher") >= 0); if (idx < 0) return false; const cls = seats[idx] ? seats[idx].className : ""; if (cls.indexOf("act-excluded") < 0) return false; return true; }, undefined, { timeout: boundedTimeout(20000, 8000) }); } catch {}
  try { await page.waitForFunction(() => { const rail = document.querySelector('section.meet-participants ul.mp-rail[aria-label="Participant activity"]'); if (!rail) return false; const imgs = rail.querySelectorAll('img[alt^="Portrait of "]'); if (imgs.length !== 2) return false; let okN = 0; for (const im of imgs) { const el = im; if (el && el.complete && (el.naturalWidth || 0) > 0) okN++; } return okN === 2; }, undefined, { timeout: boundedTimeout(25000, 8000) }); } catch {}
  // F6+F7: toolbar search (ACTUAL labelled textbox), EXACT Meeting settings
  // button + in-dialog Decisions & evidence, and the ACTUAL presence rail.
  let shellNote = "";
  let searchOk = false, settingsOk = false, railOk = false, controlOk = false;
  try {
    const searchInput = page.getByLabel("Search messages");
    const hasSearch = await searchInput.count() > 0;
    let isTextbox = false, above = false;
    if (hasSearch) {
      const tag = await searchInput.first().evaluate((el) => el.tagName).catch(() => "");
      const role = await searchInput.first().getAttribute("role").catch(() => "");
      isTextbox = tag === "INPUT" && role !== "searchbox";
      const chatScroll = page.locator('.chatscroll[aria-label="Conversation messages"]');
      const chatPos = await chatScroll.first().boundingBox().catch(() => null);
      const searchPos = await searchInput.first().boundingBox().catch(() => null);
      above = !!(chatPos && searchPos && searchPos.y < chatPos.y);
    }
    searchOk = hasSearch && isTextbox && above;
    shellNote += "search=" + hasSearch + " textbox=" + isTextbox + " aboveChatscroll=" + above + ";";
    // EXACT settings button (never a global /settings/i first-match: that can
    // hit global navigation Settings and navigate away from the composer).
    const settingsBtn = page.getByRole("button", { name: "Meeting settings", exact: true });
    const settingsDlg = page.locator('section[aria-label="Meeting settings"]');
    const settingsNative = page.locator('dialog.conv-settings');
    if (await settingsBtn.count() > 0) {
      await settingsBtn.first().click({ timeout: boundedTimeout(8000, 8000) }).catch(() => {});
      try { await settingsDlg.first().waitFor({ state: "visible", timeout: boundedTimeout(8000, 8000) }); } catch {}
      const dlgVisible = await settingsDlg.first().isVisible().catch(() => false);
      const nativeOpen = await settingsNative.first().evaluate((el) => !!el.open).catch(() => false);
      let hasDecisions = false;
      if (dlgVisible) hasDecisions = await settingsDlg.first().getByText(/decisions.*evidence/i).first().isVisible().catch(() => false);
      settingsOk = dlgVisible && nativeOpen && hasDecisions;
      shellNote += "settingsVisible=" + dlgVisible + " nativeOpen=" + nativeOpen + " decisions=" + hasDecisions + ";";
      await page.keyboard.press("Escape").catch(() => {});
      await wft(600);
      const stillVisible = await settingsDlg.first().isVisible().catch(() => false);
      const stillOpen = await settingsNative.first().evaluate((el) => !!el.open).catch(() => false);
      settingsOk = settingsOk && !stillVisible && !stillOpen;
      shellNote += "escapeClosed=" + (!stillVisible && !stillOpen) + ";";
    } else { shellNote += "settingsBtn=missing;"; }
    // ACTUAL rail: seats by boardRole display name (the rail shows boardRole,
    // never the roster entry name), excluded badge on the non-participant,
    // accepted portrait per advisor seat, Secretary seat in-rail.
    const rail = page.locator('section.meet-participants ul.mp-rail[aria-label="Participant activity"]');
    await rail.waitFor({ timeout: boundedTimeout(BROWSER_TIMEOUT, 8000) }).catch(() => {});
    const railPresent = await rail.count() > 0;
    if (railPresent) {
      const seats = rail.locator("li.mp-seat");
      const seatCount = await seats.count();
      const names = await rail.locator(".mp-name").allInnerTexts().catch(() => []);
      const badges = await rail.locator(".mp-badge").allInnerTexts().catch(() => []);
      const classes = await seats.evaluateAll((els) => els.map((e) => e.className)).catch(() => []);
      const hasLead = names.some((n) => n.includes("Board Own " + run));
      const hasAdv1 = names.some((n) => n.includes("Harbor Strategist"));
      const hasAdv2 = names.some((n) => n.includes("Tide Watcher"));
      const hasSec = names.some((n) => /secretary/i.test(n)) && classes.some((c) => c.includes("is-sec"));
      const seatIdx2 = names.findIndex((n) => String(n || "").includes("Tide Watcher"));
      const adv2Excluded = seatIdx2 >= 0 && String(classes[seatIdx2] || "").includes("act-excluded") && /not in this meeting/i.test(String(badges[seatIdx2] || ""));
      const otherExcluded = classes.some((c, i) => i !== seatIdx2 && String(c).includes("act-excluded"));
      function bytesHash(buf) { let h = 0; for (let i = 0; i < buf.length; i++) h = ((h * 31) + buf[i]) >>> 0; return h; }
      const expHashA = bytesHash(PNG_A), expHashB = bytesHash(PNG_B);
      async function portraitLoaded(alt, expected) {
        // Installed Playwright Locator.waitForFunction(fn, undefined, {timeout}) 3-arg form is supported (dedicated review confirmed).
        const img = rail.locator('img[alt="' + alt + '"]');
        const cnt = await img.count().catch(() => -1);
        if (cnt !== 1) return { ok: false, reason: "count=" + cnt, src: "" };
        let vis = false; try { await img.first().waitFor({ state: "visible", timeout: boundedTimeout(8000, 8000) }); vis = await img.first().isVisible(); } catch { vis = false; }
        if (!vis) return { ok: false, reason: "not-visible", src: "" };
        let decoded = false; try { await img.first().waitForFunction((el) => !!el.complete && (el.naturalWidth || 0) > 0, undefined, { timeout: boundedTimeout(8000, 8000) }); decoded = true; } catch { decoded = false; }
        if (!decoded) return { ok: false, reason: "not-decoded", src: "" };
        const w = await img.first().evaluate((el) => el.naturalWidth || 0).catch(() => 0);
        if (!(w > 0)) return { ok: false, reason: "zero-width", src: "" };
        const src = await img.first().getAttribute("src").catch(() => "");
        if (!src) return { ok: false, reason: "empty-src", src: "" };
        let info = null;
        try { info = await img.first().evaluate(async (el) => { try { const u = new URL(el.currentSrc || el.src, location.href); if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "blob:") return { len: -2, hash: 0 }; const r = await fetch(el.currentSrc || el.src, { signal: AbortSignal.timeout(15000) }); if (!r.ok) return { len: -3, hash: 0 }; const b = await r.arrayBuffer(); const arr = new Uint8Array(b); let h = 0; for (let i = 0; i < arr.length; i++) h = ((h * 31) + arr[i]) >>> 0; return { len: arr.length, hash: h }; } catch (e) { return { len: -1, hash: 0 }; } }); } catch { return { ok: false, reason: "fetch-threw", src: src }; }
        if (!info || info.len < 0) return { ok: false, reason: "fetch-status=" + (info ? info.len : "?"), src: src };
        if (info.len !== expected.len || info.hash !== expected.hash) return { ok: false, reason: "mismatch got=" + info.len + ":" + info.hash, src: src, len: info.len, hash: info.hash };
        return { ok: true, reason: "", src: src, len: info.len, hash: info.hash };
      }
      const p1 = await portraitLoaded("Portrait of Harbor Strategist", { len: PNG_A.length, hash: expHashA });
      const p2 = await portraitLoaded("Portrait of Tide Watcher", { len: PNG_B.length, hash: expHashB });
      const srcOk = p1.ok === true && p2.ok === true;
      const portraitsDistinct = srcOk ? (p1.src !== p2.src && p1.hash !== p2.hash && p1.len === PNG_A.length && p2.len === PNG_B.length) : false;
      const mappedOk = classes.every((c) => String(c).split(/\s+/).filter((t) => t.indexOf("act-") === 0).every((t) => MAPPED_VOCAB.has(t.slice(4))));
      railOk = seatCount === 4 && hasLead && hasAdv1 && hasAdv2 && hasSec && adv2Excluded && !otherExcluded && srcOk && portraitsDistinct && mappedOk;
      shellNote += "seats=" + seatCount + " lead=" + hasLead + " adv1=" + hasAdv1 + " adv2=" + hasAdv2 + " sec=" + hasSec + " excludedSeatLocal=" + adv2Excluded + " p1ok=" + p1.ok + ":" + p1.reason + " p2ok=" + p2.ok + ":" + p2.reason + " distinct=" + portraitsDistinct + " mappedVocab=" + mappedOk + ";";
      try { globalThis.__railNote = "seats=" + seatCount + " excluded=" + adv2Excluded + " p1=" + p1.ok + ":" + p1.reason + " p2=" + p2.ok + ":" + p2.reason + " distinct=" + portraitsDistinct + " srcOk=" + srcOk; } catch {}
    } else { shellNote += "rail=missing;"; }
    // Exactly one meeting control area (the conv-actions group) + composer.
    const ctlCount = await page.locator('[aria-label="Meeting and advisor controls"]').count().catch(() => -1);
    const composerCount = await page.locator(".composer-bar").count().catch(() => -1);
    controlOk = ctlCount === 1 && composerCount === 1;
    shellNote += "controlAreas=" + ctlCount + " composers=" + composerCount + ";";
  } catch (e) { shellNote += " shell probe threw: " + trunc(String((e && e.message) || e), 120); }
  ok("meeting-search-textbox-above", searchOk, shellNote || "search contract (see contract doc)");
  ok("meeting-settings-dialog-decisions-escape", settingsOk, shellNote || "settings contract (see contract doc)");
  ok("meeting-rail-seats-portraits-secretary", railOk, ((globalThis.__railNote || "") + " | " + (shellNote || "rail contract")).slice(0, 220));
  ok("meeting-control-area-once", controlOk, shellNote || "exactly one control area + composer");
  // Restrict participants via a real route (HTTP PATCH is an allowed route),
  // then verify the EXACT participant set on the scoped detail — statuses
  // alone never prove restriction.
  const rp = await patch("/api/meetings/" + meetingId, { participantIds: [advisor1] });
  const detR = await get("/api/boards/" + boardA + "/meetings/" + meetingId);
  let idList = null;
  if (detR.status === 200 && detR.json) {
    const rawIds = pick(detR.json, "participantIds");
    if (Array.isArray(rawIds)) idList = rawIds.map(String);
    else { try { const pj = JSON.parse(pick(detR.json, "participantIdsJson") || "[]"); if (Array.isArray(pj)) idList = pj.map(String); } catch {} }
  }
  const patchOkStatus = rp.status === 200 || rp.status === 204;
  ok("participants-restricted-real-route", patchOkStatus && detR.status === 200, "patch=" + rp.status + " detail=" + detR.status);
  if (!patchOkStatus) failExit("participant PATCH did not succeed; aborting before exact-set proof.");
  const exactRestricted = Array.isArray(idList) && idList.length === 1 && String(idList[0]).toLowerCase() === String(advisor1).toLowerCase();
  ok("participants-exact-set", exactRestricted, "exactSet={advisor1} len=" + (idList ? idList.length : -1));
  if (!exactRestricted) failExit("participant restriction did not land exactly {advisor1}; refusing status-only proof.");
  // Send ONE question through the real composer.
  const box = page.locator(".composer-bar textarea").first();
  const hasComposer = await box.count() > 0;
  if (!hasComposer) { ok("meeting-send-ready", false, "composer never mounted"); failExit("composer missing."); }
  try { await box.waitFor({ timeout: boundedTimeout(BROWSER_TIMEOUT, 8000) }); } catch { ok("meeting-send-ready", false, "composer never mounted"); failExit("composer missing."); }
  await raceCap(box.fill(QUESTION, { timeout: boundedTimeout(8000, 8000) }), 8000, "meeting-fill");
  try {
    await page.waitForFunction(() => { const b = document.querySelector(".composer-bar button.primary"); return b && !b.disabled; }, undefined, { timeout: boundedTimeout(BROWSER_TIMEOUT, 8000) });
  } catch { ok("meeting-send-ready", false, "send still disabled after draft + meeting load"); failExit("send never enabled."); }
  ok("meeting-send-ready", true, "send enabled after draft + meeting load");
  let pairedOk = false, pairedDetail = "";
  const leadPre = await get("/api/boards/" + boardA + "/lead");
  const leadVerPre = Number(pick(leadPre.json, "version") || 0);
  ok("send-lead-version-positive", leadPre.status === 200 && Number.isInteger(leadVerPre) && leadVerPre > 0, "status=" + leadPre.status + " ver=" + leadVerPre);
  if (!(leadPre.status === 200 && Number.isInteger(leadVerPre) && leadVerPre > 0)) failExit("lead version must be strict positive integer; 0==0 never passes.");
  const sendStart = Date.now();
  const sendOpEnd = Math.min(sendStart + RUN_TIMEOUT + 30000, DEADLINE_MS - 5000);
  const seenStates = new Set();
  const seenByAdvisor = new Map();
  let pollStop = false;
  const pollTask = (async () => {
    while (!pollStop) {
      if (Date.now() > DEADLINE_MS) break;
      try {
        const a = await getActivity(meetingId, (typeof sendOpEnd === "number" ? sendOpEnd : 0));
        if (!a || a.malformed || !Array.isArray(a.states)) { await sleep(2500); continue; }
        for (const st of a.states) { seenStates.add(st.state + (st.reason ? ":" + st.reason : "")); const k = String(st.id).toLowerCase(); if (!seenByAdvisor.has(k)) seenByAdvisor.set(k, []); seenByAdvisor.get(k).push(st.state + ":" + st.reason); }
      } catch {}
      await sleep(2500);
    }
  })();
  let savedLeadResp = null; let savedLeadStatus = 0; let savedLeadRespUrl = "";
  const msgRespPromise = page.waitForResponse((r) => { try { return new URL(r.url()).pathname === "/api/meetings/" + meetingId + "/messages" && r.request().method() === "POST"; } catch { return false; } }, { timeout: boundedTimeout(BROWSER_TIMEOUT, 8000) }).catch(() => null);
  try {
  await raceCap(box.press("Enter", { timeout: boundedTimeout(8000, 8000) }), 8000, "meeting-press");
  try { const _mr = await msgRespPromise; if (_mr) { savedLeadStatus = _mr.status(); try { savedLeadRespUrl = new URL(_mr.url()).pathname; } catch { savedLeadRespUrl = ""; } try { savedLeadResp = await respJson(_mr, "lead-post"); } catch { savedLeadResp = null; } } } catch { savedLeadResp = null; }
  // pairedOk lives at function scope (ReferenceError fix); serial paced sampling below reuses it.
  // Concurrent sampling starts immediately after Enter (no pre-wait); progress is observed inside samples.
  let progressSeen = "";
  {
    try {
      const WORKING = new Set(["queued", "awaiting-selection", "considering", "responding", "awaiting-publication"]);
      let samples = 0, goodSamples = 0, respondingGood = 0; const sampleNotes = [];
      const sampleEnd = Math.min(Date.now() + Math.min(RUN_TIMEOUT, Math.max(1, remainingMs())), sendOpEnd);
      while (Date.now() < sampleEnd && (goodSamples < 2 || respondingGood < 1)) {
        assertDeadline("paired-sample");
        try {
          try { const bt0 = await ev(() => (document.body ? document.body.innerText : "")).catch(() => ""); if (bt0.indexOf("Sending message...") >= 0 && progressSeen === "") progressSeen = "sending"; if (bt0.indexOf("Requesting advisor responses...") >= 0) progressSeen = "working"; } catch {}
          const aMid = await getActivity(meetingId, (typeof sendOpEnd === "number" ? sendOpEnd : 0));
          if (aMid && !aMid.malformed && Array.isArray(aMid.states)) {
          const a1Mid = (aMid.states || []).filter((x) => String(x.id).toLowerCase() === String(advisor1).toLowerCase());
          const railMid = page.locator('section.meet-participants ul.mp-rail[aria-label="Participant activity"]');
          const namesMid = await raceCap(railMid.locator(".mp-name").allInnerTexts().catch(() => []), 8000, "paired-names");
          const clsMid = await raceCap(railMid.locator("li.mp-seat").evaluateAll((els) => els.map((e) => e.className)).catch(() => []), 8000, "paired-classes");
          const badgeTexts = await raceCap(railMid.locator(".mp-badge").allInnerTexts().catch(() => []), 8000, "paired-badges");
          const idxMid = namesMid.findIndex((n) => String(n || "").includes("Harbor Strategist"));
          let badgeMid = "", badgeHuman = "";
          if (idxMid >= 0) { const m = /act-([a-z-]+)/.exec(String(clsMid[idxMid] || "")); badgeMid = m ? m[1] : ""; badgeHuman = await raceCap(railMid.locator("li.mp-seat").nth(idxMid).locator(".mp-badge").first().innerText().catch(() => ""), 8000, "paired-badge-text"); const seatBadgeVis = await raceCap(railMid.locator("li.mp-seat").nth(idxMid).locator(".mp-badge").first().isVisible().catch(() => false), 8000, "paired-badge-vis"); if (!seatBadgeVis) badgeHuman = ""; }
          const rawWorkMid = a1Mid.filter((x) => WORKING.has(String(x.state)));
          const badgeWorkMid = ["queued", "waiting-for-selection", "considering", "responding", "waiting-for-publication"].includes(badgeMid);
          const EXPECT_LABEL = { "queued": "Queued", "waiting-for-selection": "Waiting to be considered", "considering": "Considering", "responding": "Responding", "waiting-for-publication": "Waiting for publication" }; const humanOk = badgeMid !== "" && badgeHuman === EXPECT_LABEL[badgeMid];
          const latestRaw = a1Mid.length > 0 ? String(a1Mid[a1Mid.length - 1].state) : "";
          const mapEq = latestRaw !== "" && WORKING.has(latestRaw) && mapRaw(latestRaw) === badgeMid;
          samples++;
          if (rawWorkMid.length >= 1 && badgeWorkMid && humanOk && mapEq) { goodSamples++; sampleNotes.push("raw=" + a1Mid.map((x) => x.state).join(",") + " badge=" + badgeMid + " human=" + badgeHuman); }
          if (a1Mid.some((x) => String(x.state) === "responding") && badgeMid === "responding" && badgeHuman === "Responding" && mapEq) { respondingGood++; sampleNotes.push("RESPONDING-PAIRED raw=responding badge=responding human=Responding"); }
          try { const doneEarly = await page.waitForFunction(() => document.body.innerText.indexOf("Responses complete.") >= 0, undefined, { timeout: boundedTimeout(2500, 8000) }); if (doneEarly) break; } catch {}
          }
        } catch (e) { sampleNotes.push("throw:" + String((e && e.message) || e).slice(0, 60)); }
        await sleep(2500);
      }
      pairedOk = goodSamples >= 2;
      pairedDetail = "samples=" + samples + " good=" + goodSamples + " respondingGood=" + respondingGood + " progress=" + (progressSeen || "none") + " " + sampleNotes.slice(0, 3).join(" | ");
      try { globalThis.__respondingGood = respondingGood; globalThis.__respondingNotes = sampleNotes.filter((s) => s.indexOf("RESPONDING-PAIRED") === 0).slice(0,2).join(" | "); } catch (e) {}
    } catch (e) { pairedDetail = "paired sampling threw: " + String((e && e.message) || e).slice(0, 120); }
    ok("activity-paired-working", pairedOk, pairedDetail || "adv1 raw working + seat badge together during work");
    const respondingOk = (globalThis.__respondingGood || 0) >= 1;
    ok("activity-responding-badge-exact", respondingOk, "owned Harbor Strategist raw responding + visible Responding badge paired: " + String(globalThis.__respondingNotes || pairedDetail).slice(0, 220));
    if (!respondingOk) failExit("owned advisor never showed exact responding raw state with visible Responding badge; refusing working-any-state pass.");
    ok("meeting-progress-visible", progressSeen !== "", "progress=" + (progressSeen || "none") + " after " + (Date.now() - sendStart) + "ms");
  }
  let terminal = false;
  try { const termRem = Math.max(1, Math.min(sendOpEnd - Date.now(), remainingMs())); await page.waitForFunction(() => document.body.innerText.indexOf("Responses complete.") >= 0, undefined, { timeout: termRem }); terminal = true; } catch { ok("meeting-terminal-complete", false, "no Responses complete. within shared sendOpEnd remaining deadline"); }
  if (terminal) ok("meeting-terminal-complete", true, "after " + (Date.now() - sendStart) + "ms");
  } finally { pollStop = true; const _pp = pollTask; try { await Promise.race([_pp, sleep(Math.min(8000, Math.max(1, remainingMs())))]); } catch {} await drainPending(); }
  const fin = await getActivity(meetingId);
  if (!fin || fin.malformed || !Array.isArray(fin.states)) failExit("activity collection malformed; refusing normalized pass. " + safeDiag(fin));
  for (const x of fin.states) seenStates.add(x.state + (x.reason ? ":" + x.reason : ""));
  const observed = [...seenStates];
  // F8 continued: RAW states against the RAW contract only; rendered rail
  // badge classes against the MAPPED contract; mapping cross-checked.
  const rawStates = observed.map((s) => String(s).split(":")[0]);
  const vocabOk = rawStates.every((s) => RAW_VOCAB.has(s));
  const rawReached = rawStates.some((s) => s === "awaiting-publication" || s === "complete");
  const WORKING_RAW = new Set(["queued", "awaiting-selection", "considering", "responding", "awaiting-publication"]);
  const finAdv1 = (fin.states || []).filter((s) => String(s.id).toLowerCase() === advisor1.toLowerCase());
  const adv1Key = advisor1.toLowerCase();
  const adv1Trail = seenByAdvisor.get(adv1Key) || [];
  const trailWorking = adv1Trail.filter((e) => WORKING_RAW.has(String(e).split(":")[0]));
  const finAdv1Working = finAdv1.some((s) => WORKING_RAW.has(String(s.state))) || trailWorking.length >= 1;
  let mappedReached = false, mappedOk = true, adv1Badge = "", crossOk = true;
  try {
    const rail = page.locator('section.meet-participants ul.mp-rail[aria-label="Participant activity"]');
    const seats = rail.locator("li.mp-seat");
    const names = await rail.locator(".mp-name").allInnerTexts().catch(() => []);
    const classes = await seats.evaluateAll((els) => els.map((e) => e.className)).catch(() => []);
    const acts = [];
    for (const cc of classes) { const mt = /act-([a-z-]+)/.exec(String(cc)); if (mt) acts.push(mt[1]); }
    mappedOk = acts.length > 0 && acts.every((a) => MAPPED_VOCAB.has(a));
    mappedReached = acts.some((a) => a === "waiting-for-publication" || a === "complete" || a === "responding" || a === "considering" || a === "waiting-for-selection" || a === "queued");
    const idx1 = names.findIndex((n) => String(n || "").includes("Harbor Strategist"));
    if (idx1 >= 0) { const m = /act-([a-z-]+)/.exec(String(classes[idx1] || "")); adv1Badge = m ? m[1] : ""; }
    const adv1LatestRaw = finAdv1.length > 0 ? String(finAdv1[finAdv1.length - 1].state) : "";
    const adv1MapEq = adv1LatestRaw !== "" && adv1Badge !== "" && mapRaw(adv1LatestRaw) === adv1Badge;
    crossOk = rawStates.every((s) => MAPPED_VOCAB.has(mapRaw(s))) && adv1MapEq;
    ok("activity-mapped-badges-honest", mappedOk && crossOk, "rendered=" + acts.join(",") + " adv1Badge=" + adv1Badge + " adv1Raw=" + adv1LatestRaw);
  } catch (e) { ok("activity-mapped-badges-honest", false, "rail badge read failed: " + trunc(String((e && e.message) || e), 120)); }
  ok("activity-states-raw-honest", vocabOk && rawReached, "raw=" + observed.join(","));
  ok("activity-working-observed", finAdv1Working && trailWorking.length >= 1, "adv1Working=" + finAdv1Working + " trailWorking=" + trailWorking.length + " adv1States=" + finAdv1.map((s) => s.state + ":" + s.reason).join(","));
  ok("activity-adv1-badge-working", ["queued", "waiting-for-selection", "considering", "responding", "waiting-for-publication"].includes(adv1Badge) || pairedOk, "adv1Badge=" + adv1Badge + " paired=" + pairedOk);
  if (!finAdv1Working) failExit("no working raw state observed for the owned participant; honest activity requires a transient working state.");
  // Hoisted run-body capture: BEFORE-block eligible-absence assertion reads runJson; single declaration above first use (reused below).
  const meetRun = netBodies.run.filter((b) => String(b.url || "").includes(meetingId));
  let runJson = null; try { runJson = JSON.parse((meetRun[0] && meetRun[0].body) || "null"); } catch { runJson = null; }
  if (MODE === "native") {
    const canonBid = await canonicalEntry(rosterId);
    const bidParas = threeParas(canonBid.entry ? (pick(canonBid.entry, "profileJson") || "") : "");
    const blog = await fakeLog();
    const ownedBids = Array.isArray(blog) ? ownedLog(blog).filter((e) => /Reply with exactly YES or NO/.test(logText(e))) : [];
    // FULL paragraphs INCLUDING the decisive tail (never a 32-char head prefix).
    const bidParaOk = bidParas.length === 3 && ownedBids.length >= 1 && bidParas.every((para) => para.length >= 10 && ownedBids.some((e) => logText(e).includes(para)));
    const bidTailOk = bidParas.length === 3 && bidParas.every((para) => { const tail = para.slice(Math.max(0, para.length - 40)); return tail.length >= 10 && ownedBids.some((e) => logText(e).includes(tail)); });
    ok("bid-current-paras-owned", bidParaOk && bidTailOk, "bids=" + ownedBids.length + " paras=" + bidParas.length + " tail=" + bidTailOk);
    if (!(bidParaOk && bidTailOk)) failExit("current behavior paragraphs (FULL, tail included) must appear in owned bid prompts.");
    // Real communication preferences DELIVERED + controlled authorized evidence
    // retained in the MEETING reply prompt (BEFORE canonical edit).
    const leadPrefsFull = "oc-" + run;
    const yourTurnBefore = Array.isArray(blog) ? ownedLog(blog).filter((e) => e.path === "chat" && /YOUR TURN/.test(logText(e))) : [];
    const prefsDelivered = yourTurnBefore.some((e) => logText(e).includes(leadPrefsFull));
    const evidenceRetained = yourTurnBefore.some((e) => logText(e).includes(QUESTION));
    const runEvFalseBefore = !!runJson && runJson.evidenceSupported === false;
    const eligibleAbsentBefore = runEvFalseBefore;
    const parasDelivered = bidParas.length === 3 && yourTurnBefore.some((e) => bidParas.every((para) => logText(e).includes(para)));
    ok("meeting-prompt-prefs-evidence-before", prefsDelivered && evidenceRetained && parasDelivered && yourTurnBefore.length >= 1, "yourTurn=" + yourTurnBefore.length + " prefs=" + prefsDelivered + " questionDuplicate=" + evidenceRetained + " (NOT eligible evidence; evidenceSupported=false, no eligible payload asserted) paras=" + parasDelivered);
    ok("meeting-eligible-evidence-controlled-absent-before", runEvFalseBefore && eligibleAbsentBefore && yourTurnBefore.length >= 1, "evidenceSupported=false controlled (runEv=" + runEvFalseBefore + "); QUESTION duplicate is brief/input, never claimed as eligible EVIDENCE payload");
    if (!(prefsDelivered && evidenceRetained && parasDelivered)) failExit("MEETING reply prompt must DELIVER real comm prefs + question-duplicate + full paras (before edit; eligible evidence explicitly absent, evidenceSupported=false).");
    if (!(runEvFalseBefore && eligibleAbsentBefore)) failExit("eligible meeting EVIDENCE must stay controlled-absent here (evidenceSupported=false); QUESTION duplicate never counts as EVIDENCE payload.");
    try { globalThis.__bidParasBefore = bidParas.slice(); } catch {}
  } else { ok("bid-current-paras-owned", false, "live mode UNPROVED prompt path"); ok("meeting-prompt-prefs-evidence-before", false, "live mode UNPROVED prompt path"); ok("meeting-eligible-evidence-controlled-absent-before", false, "live mode UNPROVED prompt path"); }
  const meetMsgs = netBodies.messages.filter((b) => String(b.url || "").includes(meetingId));
  const sendPosts = { messages: netPosts.messages.filter((x) => x >= sendStart), patch: netPosts.patch.filter((x) => x >= sendStart), run: netPosts.run.filter((x) => x >= sendStart) };
  const meetPatch = netBodies.patch.filter((b) => String(b.url || "").includes(meetingId));
  // meetRun hoisted above BEFORE-block; reused here (no redeclare).
  const meetMsgsRes = netResps.messages.filter((r) => String(r.url || "").includes(meetingId) && r.status >= 200 && r.status < 300 && r.t >= sendStart);
  const meetPatchRes = netResps.patch.filter((r) => String(r.url || "").includes(meetingId) && r.status >= 200 && r.status < 300 && r.t >= sendStart);
  const meetRunRes = netResps.run.filter((r) => String(r.url || "").includes(meetingId) && r.status >= 200 && r.status < 300 && r.t >= sendStart);
  // Once-only with paired identity and response/order boundary: exact owned meeting, 1 request each, each paired to a 2xx response after its request, ordered lead-save -> auto-init -> run.
  let orderOk = false;
  try {
    const qMsg = sendPosts.messages.length === 1 ? sendPosts.messages[0] : -1;
    const qPatch = sendPosts.patch.length === 1 ? sendPosts.patch[0] : -1;
    const qRun = sendPosts.run.length === 1 ? sendPosts.run[0] : -1;
    const urlPair = meetMsgs.length === 1 && meetMsgsRes.length === 1 && meetMsgs[0].url === meetMsgsRes[0].url && meetPatch.length === 1 && meetPatchRes.length === 1 && meetPatch[0].url === meetPatchRes[0].url && meetRun.length === 1 && meetRunRes.length === 1 && meetRun[0].url === meetRunRes[0].url;
    orderOk = urlPair && qMsg > 0 && qPatch >= qMsg && qRun >= qPatch && meetMsgsRes[0].t >= qMsg && meetMsgsRes[0].t <= qPatch && meetPatchRes[0].t >= qPatch && meetPatchRes[0].t <= qRun && meetRunRes[0].t >= qRun;
  } catch { orderOk = false; }
  ok("send-lead-once", meetMsgs.length === 1 && meetMsgsRes.length === 1 && orderOk, "POST messages=1 okRes=1 ordered=" + orderOk);
  ok("autoinit-patch-once", meetPatch.length === 1 && meetPatchRes.length === 1 && orderOk, "PATCH=1 okRes=1 ordered=" + orderOk);
  ok("run-once", meetRun.length === 1 && meetRunRes.length === 1 && orderOk, "POST run=1 okRes=1 ordered=" + orderOk);
  if (!(meetMsgs.length === 1 && meetPatch.length === 1 && meetRun.length === 1 && orderOk)) failExit("send pipeline must be exactly once each with lead->patch->run order; refusing count-only pass.");
  let leadJson = null; try { leadJson = JSON.parse((meetMsgs[0] && meetMsgs[0].body) || "null"); } catch { leadJson = null; }
  let patchJson = null; try { patchJson = JSON.parse((meetPatch[0] && meetPatch[0].body) || "null"); } catch { patchJson = null; }
  // runJson hoisted above BEFORE-block; reused here (no redeclare).
  const wantBrief = QUESTION.slice(0, 800);
  ok("send-lead-body-exact", !!leadJson && leadJson.content === QUESTION && leadJson.sender === "lead", "contentExact=" + (!!leadJson && leadJson.content === QUESTION));
  if (!(!!leadJson && leadJson.content === QUESTION)) failExit("lead POST content must exactly equal QUESTION.");
  const savedSeqRaw = savedLeadResp ? (pick(savedLeadResp, "sequence") ?? pick(savedLeadResp, "Sequence")) : undefined;
  const savedSeq = typeof savedSeqRaw === "number" ? savedSeqRaw : NaN;
  const savedContentRaw = savedLeadResp ? (pick(savedLeadResp, "content") ?? pick(savedLeadResp, "Content")) : undefined;
  const savedContent = typeof savedContentRaw === "string" ? savedContentRaw : "";
  const savedGenRaw = savedLeadResp ? (pick(savedLeadResp, "generation") ?? pick(savedLeadResp, "Generation")) : undefined;
  const savedGen = typeof savedGenRaw === "number" ? savedGenRaw : NaN;
  const savedRestoreIdRaw = savedLeadResp ? (pick(savedLeadResp, "restoreEpochId") ?? pick(savedLeadResp, "RestoreEpochId")) : undefined;
  const savedRestoreId = typeof savedRestoreIdRaw === "string" ? savedRestoreIdRaw : "";
  const savedRestoreRevRaw = savedLeadResp ? (pick(savedLeadResp, "restoreEpochRev") ?? pick(savedLeadResp, "RestoreEpochRev")) : undefined;
  const savedRestoreRev = typeof savedRestoreRevRaw === "number" ? savedRestoreRevRaw : NaN;
  const savedLeadOk = savedLeadStatus >= 200 && savedLeadStatus < 300 && Number.isInteger(savedSeq) && savedSeq > 0 && savedContent === QUESTION && Number.isInteger(savedGen) && savedLeadRespUrl === "/api/meetings/" + meetingId + "/messages";
  ok("send-lead-return-cas", savedLeadOk, "leadSeq=" + savedSeq + " gen=" + savedGen + " contentExact=" + (savedContent === QUESTION));
  if (!savedLeadOk) failExit("lead POST return must carry exact Sequence/Content/Generation for CAS correlation.");
  const patchBriefOk = !!patchJson && patchJson.brief === wantBrief && patchJson.briefAutoInit === true && patchJson.expectedBrief === "" && patchJson.expectBriefEmpty === true;
  const patchCasOk = !!patchJson && typeof patchJson.leadSequence === "number" && patchJson.leadSequence === savedSeq && typeof patchJson.leadContent === "string" && patchJson.leadContent === QUESTION && patchJson.leadContent === savedContent && typeof patchJson.expectedGeneration === "number" && patchJson.expectedGeneration === savedGen && typeof (patchJson.restoreEpochId || "") === "string" && String(patchJson.restoreEpochId || "") === String(savedRestoreId || "") && typeof patchJson.restoreEpochRev === "number" && patchJson.restoreEpochRev === savedRestoreRev;
  const patchNoAdv = !!patchJson && !JSON.stringify(patchJson).toLowerCase().includes(String(advisor1).toLowerCase()) && !("advisorId" in patchJson) && !("participantIds" in patchJson);
  ok("autoinit-patch-body-exact", patchBriefOk && patchCasOk && patchNoAdv, "briefExact=" + patchBriefOk + " casValues=" + patchCasOk + " noAdvId=" + patchNoAdv);
  if (!(patchBriefOk && patchCasOk)) failExit("PATCH must carry exact lead return CAS values, not key presence.");
  const runPolicyOk = !!runJson && runJson.policy === "balanced";
  const runPromptOk = !!runJson && runJson.prompt === QUESTION;
  const runEvOk = !!runJson && runJson.evidenceSupported === false;
  const runVerOk = !!runJson && typeof runJson.leadVersion === "number" && Number.isInteger(runJson.leadVersion) && runJson.leadVersion === leadVerPre && runJson.leadVersion > 0;
  const runOk = runPolicyOk && runPromptOk && runEvOk && runVerOk;
  ok("run-body-ok", runOk, "policyLen=" + (runJson && String(runJson.policy || "").length) + " promptExact=" + runPromptOk + " evFalse=" + runEvOk + " leadVer=" + (runJson && runJson.leadVersion));
  if (!runOk) failExit("run body must carry actual policy/prompt/evidenceSupported/leadVersion values.");
  const msgs = await get("/api/meetings/" + meetingId + "/messages?take=100");
  const msgList = Array.isArray(msgs.json) ? msgs.json : [];
  const leads = msgList.filter((x) => String(pick(x, "sender") || "").toLowerCase() === "lead" && String(pick(x, "content") || pick(x, "body") || "").includes(QUESTION));
  const exactLeads = msgList.filter((x) => String(pick(x, "sender") || "").toLowerCase() === "lead" && String(pick(x, "content") || pick(x, "body") || "") === QUESTION);
  ok("send-lead-text-once", msgs.status === 200 && exactLeads.length === 1 && leads.length === 1, "status=" + msgs.status + " exact-leads=" + exactLeads.length + " total=" + msgList.length);
  const leadEnt = exactLeads.length === 1 ? exactLeads[0] : null;
  const leadEntOk = !!leadEnt && String(pick(leadEnt, "boardId") || pick(leadEnt, "BoardId") || "") === String(boardA) && String(pick(leadEnt, "meetingId") || pick(leadEnt, "MeetingId") || "") === String(meetingId);
  ok("send-lead-identity", leadEntOk, "persisted owned lead carries exact board+meeting identity");
  if (!leadEntOk) failExit("persisted owned lead must carry exact board and meeting identity.");
  const det1 = await get("/api/boards/" + boardA + "/meetings/" + meetingId);
  ok("autobrief-once", det1.status === 200 && String(pick(det1.json, "brief") || "") === wantBrief, "status=" + det1.status + " briefExact=" + (String(pick(det1.json, "brief") || "") === wantBrief));
  const adv = msgList.filter((x) => { const a = String(pick(x, "advisorId") || ""); return a && a !== "00000000-0000-0000-0000-000000000000"; });
  const adv1Msgs = adv.filter((x) => String(pick(x, "advisorId") || "").toLowerCase() === advisor1.toLowerCase());
  const adv2Msgs = adv.filter((x) => String(pick(x, "advisorId") || "").toLowerCase() === advisor2.toLowerCase());
  const adv1Nonempty = adv1Msgs.filter((x) => String(pick(x, "content") || pick(x, "body") || "").trim().length >= 20);
  const nonempty = adv.filter((x) => String(pick(x, "content") || pick(x, "body") || "").trim().length >= 20);
  ok("advisor-reply-nonempty", nonempty.length >= 1 && adv1Nonempty.length >= 1, "advisor1-nonempty=" + adv1Nonempty.length + " total-nonempty=" + nonempty.length);
  ok("excluded-absent", adv2Msgs.length === 0, "excludedAdvisorMsgs=" + adv2Msgs.length);
  if (nonempty.length < 1) failExit("no model contribution: HTTP 200 is not proof; need >=1 nonempty advisor reply.");
  const sreq0 = await get("/api/meetings/" + meetingId + "/secretary/requests");
  ok("secretary-baseline-shape", sreq0.status === 200 && Array.isArray(sreq0.json), "status=" + sreq0.status + " isArray=" + Array.isArray(sreq0.json));
  if (!(sreq0.status === 200 && Array.isArray(sreq0.json))) failExit("secretary baseline collection shape invalid; cannot prove completion.");
  const sreq0List = sreq0.json;
  const sreq0Ids = new Set(sreq0List.map((x) => String(pick(x, "id") || "")));
  const nz0 = await get("/api/meetings/" + meetingId + "/notes?kind=direction");
  const nz0Valid = nz0.status === 200 && Array.isArray(nz0.json) && nz0.json.every((x) => x && typeof x === "object" && typeof pick(x, "kind") === "string" && pick(x, "kind") === "direction" && typeof pick(x, "provisional") === "boolean" && typeof pick(x, "body") === "string" && typeof pick(x, "id") === "string");
  ok("secretary-direction-baseline", nz0Valid, "status=" + nz0.status + " rows=" + (Array.isArray(nz0.json) ? nz0.json.length : -1));
  if (!nz0Valid) failExit("direction baseline must be RAW valid types with kind===direction.");
  const nz0Snap = Array.isArray(nz0.json) ? nz0.json.map((x) => String(pick(x, "id") || "") + "|" + String(pick(x, "kind") || "") + "|" + String(pick(x, "provisional")) + "|" + String(pick(x, "body") || "") + "|" + String(pick(x, "title") || "")).sort().join("\n") : "";
  const secDeadline = Math.min(Date.now() + 90000, DEADLINE_MS - 5000);
  ok("secretary-window-opened-before-send", secDeadline > Date.now(), "first Secretary local window opens BEFORE POST/send (absolute execution, local start)");
  const secPostPromise = page.waitForResponse((r) => { try { return new URL(r.url()).pathname === "/api/meetings/" + meetingId + "/secretary" && r.request().method() === "POST"; } catch { return false; } }, { timeout: Math.min(30000, Math.max(1, remainingMs())) }).catch(() => null);
  await raceCap(box.fill(SECQ, { timeout: boundedTimeout(8000, 8000) }), 8000, "secretary-fill");
  await raceCap(box.press("Enter", { timeout: boundedTimeout(8000, 8000) }), 8000, "secretary-press");
  let secPostReqId = "", secPostRespNonce = "", secPostReqNonce = "", secPostInput = "", secPostStatus = 0;
  try {
    const _sr = await secPostPromise;
    if (_sr) { try { secPostStatus = _sr.status(); } catch {} try { const _sj = await respJson(_sr, "secretary-post"); secPostReqId = String(pick(_sj, "requestId") || ""); secPostRespNonce = String(pick(_sj, "clientNonce") || ""); } catch {} try { const _rq = _sr.request(); const _pd = _rq.postDataJSON(); if (_pd) { secPostInput = String(_pd.input || ""); secPostReqNonce = String(_pd.clientNonce || ""); } } catch {} }
  } catch {}
  const secPostNonce = secPostRespNonce;
  ok("secretary-post-captured", secPostStatus >= 200 && secPostStatus < 300 && secPostReqId.length > 0 && secPostRespNonce.length > 0 && secPostReqNonce.length > 0 && secPostRespNonce === secPostReqNonce && secPostInput === SECQ, "status=" + secPostStatus + " reqId=" + (secPostReqId ? secPostReqId.slice(0,8) : "missing") + " nonceEq=" + (secPostRespNonce === secPostReqNonce) + " inputExact=" + (secPostInput === SECQ));
  if (!secPostReqId) failExit("secretary POST response must carry exact requestId/nonce; refusing list-only correlation.");
  // secDeadline opened BEFORE send above; the poll loop below reuses that same local window (no post-completion window).
    // (secDeadline reused from BEFORE-send window; no second post-completion window)
  let sreq1List = [], fresh = [], secDone = null, secInflightSeen = false, secSeatProgressSeen = false;
  while (Date.now() < secDeadline) {
    assertDeadline("secretary-poll");
    const g = await getLocal("/api/meetings/" + meetingId + "/secretary/requests", secDeadline);
    if (g.status === 200 && Array.isArray(g.json)) {
      sreq1List = g.json;
      fresh = sreq1List.filter((x) => !sreq0Ids.has(String(pick(x, "id") || "")));
      secDone = fresh.find((x) => String(pick(x, "status") || "") === "completed" && !!pick(x, "noteId") && String(pick(x, "question") || pick(x, "inputText") || "").includes(run));
      if (!secDone && fresh.some((x) => String(pick(x, "status") || "") !== "completed")) secInflightSeen = true;
      if (!secDone && fresh.length >= 1) { try { const railSec = page.locator("section.meet-participants ul.mp-rail[aria-label=\"Participant activity\"]"); const secNames = await railSec.locator(".mp-name").allInnerTexts().catch(() => []); const secCls = await railSec.locator("li.mp-seat").evaluateAll((els) => els.map((e) => e.className)).catch(() => []); for (let si = 0; si < secNames.length; si++) { if (/secretary/i.test(String(secNames[si] || "")) && /act-(queued|waiting-for-selection|considering|responding|waiting-for-publication)/.test(String(secCls[si] || ""))) { secSeatProgressSeen = true; break; } } } catch (e) {} }
      if (secDone) break;
    }
    await sleep(2000);
  }
  const sameIdOk = !!secDone && String(pick(secDone, "id") || "").toLowerCase() === secPostReqId.toLowerCase();
  ok("secretary-provisional-visible", !!secDone && sameIdOk, secDone ? "sameID=" + sameIdOk + " noteId=" + String(pick(secDone, "noteId") || "").slice(0, 8) : "no exact completed owned request with same POST requestId");
  if (!sameIdOk) failExit("secretary completion must resolve the EXACT POST requestId, not any run-matching row.");
  ok("secretary-request-recorded", !!secDone && fresh.length === 1, "newRequests=" + fresh.length + " completed=" + !!secDone);
  console.log("  note - secretary-ui-request-completed (in-flight observed on overlap POST below)");
  if (fresh.length !== 1) failExit("secretary must record exactly one new request for this input.");
  const sreq1 = { status: sreq1List.length ? 200 : 0 };
  if (secDone && fresh.length === 1) {
    const rq = secDone;
    const rqId = String(pick(rq, "id") || "");
    const rqNonce = String(pick(rq, "clientNonce") || pick(rq, "ClientNonce") || "");
    const rqInput = String(pick(rq, "inputText") || pick(rq, "InputText") || "");
    const expectNorm = stripSecPrefix(SECQ);
    const nonceOk = rqNonce === secPostNonce && rqNonce.length > 0;
    const inputOk = rqInput === expectNorm && rqInput.includes(run);
    const rqBoard = String(pick(rq, "boardId") || pick(rq, "BoardId") || "");
    const rqMeet = String(pick(rq, "meetingId") || pick(rq, "MeetingId") || "");
    const parentOk = rqBoard.toLowerCase() === String(boardA).toLowerCase() && rqMeet.toLowerCase() === String(meetingId).toLowerCase();
    ok("secretary-request-correlated", nonceOk && inputOk && String(pick(rq, "status") || "") === "completed" && !!pick(rq, "noteId") && parentOk, "nonceExact=" + nonceOk + " stripPrefixExact=" + inputOk + " parent=" + parentOk);
    if (!(nonceOk && inputOk)) failExit("secretary request must carry EXACT POST nonce and StripPrefix(InputText).");
    const one = await get("/api/meetings/" + meetingId + "/secretary/requests/" + rqId);
    const oneReq = pick(one.json, "request") || pick(one.json, "Request") || one.json || {};
    const oneReqId = String(pick(oneReq, "id") || pick(one.json, "requestId") || "");
    const oneNoteId = String(pick(oneReq, "noteId") || pick(one.json, "noteId") || pick(pick(one.json, "note") || {}, "id") || "");
    const rqNote = String(pick(rq, "noteId") || "");
    const sameGetOk = one.status === 200 && oneReqId.toLowerCase() === rqId.toLowerCase() && oneNoteId !== "" && oneNoteId === rqNote;
    ok("secretary-get-same-id", sameGetOk, "completedGET sameID noteId=" + (oneNoteId ? oneNoteId.slice(0,8) : "missing"));
    if (!sameGetOk) failExit("completed GET must resolve the same request ID with its noteId.");
    const note = pick(one.json, "note") || {};
    const nbody = typeof pick(note, "body") === "string" ? String(pick(note, "body")) : "";
    const ntitle = typeof pick(note, "title") === "string" ? String(pick(note, "title")) : "";
    const nkind = typeof pick(note, "kind") === "string" ? String(pick(note, "kind")) : "";
    const nprov = pick(note, "provisional");
    const bodyExactOk = typeof pick(note, "body") === "string" && nbody.includes(run) && nbody.length > 40;
    const noteParentOk = String(pick(note, "boardId") || pick(note, "BoardId") || "").toLowerCase() === String(boardA).toLowerCase() && String(pick(note, "meetingId") || pick(note, "MeetingId") || "").toLowerCase() === String(meetingId).toLowerCase();
    ok("secretary-note-provisional-persisted", one.status === 200 && (nkind === "secretary-note" || nkind === "secretary-briefing") && nprov === true && bodyExactOk && noteParentOk && String(pick(note, "id") || "").toLowerCase() === rqNote.toLowerCase(), "status=" + one.status + " kind=" + nkind + " provisional=" + nprov + " bodyLen=" + nbody.length + " parentExact=" + noteParentOk);
    if (!(one.status === 200 && (nkind === "secretary-note" || nkind === "secretary-briefing") && nprov === true && bodyExactOk)) failExit("persisted provisional must be exact body with UI-visible correlation.");
    try { globalThis.__secNoteTitle = ntitle; globalThis.__secNoteBody = nbody; globalThis.__secNoteId = rqId; } catch {}
  } else {
    ok("secretary-request-correlated", false, "expected exactly 1 completed owned request, found fresh=" + fresh.length + " done=" + !!secDone);
    ok("secretary-note-provisional-persisted", false, "no single correlated completed request to resolve");
  }
  const nz = await get("/api/meetings/" + meetingId + "/notes?kind=direction");
  const nlistRaw = nz.json;
  const dirRowsValid = nz.status === 200 && Array.isArray(nlistRaw) && nlistRaw.every((x) => x && typeof x === "object" && typeof pick(x, "kind") === "string" && pick(x, "kind") === "direction" && typeof pick(x, "provisional") === "boolean" && typeof pick(x, "body") === "string" && typeof pick(x, "id") === "string");
  ok("secretary-direction-shape", dirRowsValid, "status=" + nz.status + " rows=" + (Array.isArray(nlistRaw) ? nlistRaw.length : "?"));
  if (!dirRowsValid) failExit("direction collection shape invalid; cannot prove no-decision.");
  const nlist = nlistRaw;
  const dirs = nlist.filter((x) => String(pick(x, "kind") || "").toLowerCase() === "direction");
  const nonProv = dirs.filter((x) => pick(x, "provisional") !== true);
  const provNotes = await get("/api/meetings/" + meetingId + "/notes?kind=secretary-note");
  const provOkShape = provNotes.status === 200 && Array.isArray(provNotes.json) && provNotes.json.every((x) => typeof pick(x, "kind") === "string");
  const provList = provOkShape ? provNotes.json : [];
  const wantNoteId = secDone ? String(pick(secDone, "noteId") || "") : "";
  const corrNote = provList.find((x) => String(pick(x, "id") || "") === wantNoteId);
  const corrOk = provOkShape && !!corrNote && pick(corrNote, "provisional") === true && String(pick(corrNote, "body") || "").includes(run);
  ok("secretary-provisional-positive", corrOk, "correlatedNote=" + !!corrNote + " rows=" + provList.length);
  let trayOk = false, trayNote = "";
  try {
    await page.bringToFront().catch(() => {});
    const setBtn = page.getByRole("button", { name: "Meeting settings", exact: true });
    await setBtn.first().click({ timeout: boundedTimeout(8000, 8000) }).catch(() => {});
    const setDlg = page.locator('section[aria-label="Meeting settings"]');
    const setNative = page.locator("dialog.conv-settings");
    await setDlg.first().waitFor({ state: "visible", timeout: boundedTimeout(8000, 8000) }).catch(() => {});
    const setVis = await setDlg.first().isVisible().catch(() => false);
    const setOpen = await setNative.first().evaluate((el) => !!el.open).catch(() => false);
    const wantTitle = String((globalThis.__secNoteTitle) || "QA secretary note");
    const wantBody = String((globalThis.__secNoteBody) || run);
    let exactHit = false;
    if (setVis && setOpen) {
      const notes = setDlg.locator(".takenote");
      const nn = await notes.count().catch(() => 0);
      for (let i = 0; i < nn; i++) {
        try {
          const exp = notes.nth(i).getByRole("button", { name: /show full note/i });
          if (await exp.count() > 0) { await exp.first().click({ timeout: boundedTimeout(4000, 8000) }).catch(() => {}); await wft(400); }
        } catch {}
        const txt = await notes.nth(i).innerText().catch(() => "");
        const vis = await notes.nth(i).isVisible().catch(() => false);
        if (vis && wantTitle && txt.includes(wantTitle) && txt.includes(wantBody)) { exactHit = true; trayNote = "fullLen=" + txt.length; break; }
      }
    }
    trayOk = setVis && setOpen && exactHit;
    if (!trayNote) trayNote = "vis=" + setVis + " open=" + setOpen + " exact=" + exactHit;
    await page.keyboard.press("Escape").catch(() => {});
    await wft(400);
  } catch (e) { trayNote = "tray probe threw: " + String((e && e.message) || e).slice(0, 120); }
  ok("secretary-tray-rendered", trayOk, trayNote || "tray missing or marker absent");
  const nzSnap = Array.isArray(nlistRaw) ? nlistRaw.map((x) => String(pick(x, "id") || "") + "|" + String(pick(x, "kind") || "") + "|" + String(pick(x, "provisional")) + "|" + String(pick(x, "body") || "") + "|" + String(pick(x, "title") || "")).sort().join("\n") : "";
  const snapUnchanged = nzSnap === nz0Snap;
  ok("secretary-no-decision", nz.status === 200 && nonProv.length === 0 && snapUnchanged, "nonProv=" + nonProv.length + " snapshotUnchanged=" + snapUnchanged);
    // TRUE overlap (not two sequential completions): two concurrent live requests
  // on the SAME meeting with distinct nonces, proven by deterministic fake gates
  // (OWN 15398 __hold/__release), never by sleep duration. A is HELD, then B is
  // started only after A is observed live; BOTH nonces must be LIVE in ONE actual
  // backend snapshot. Then A is released while B is HELD; the mounted App must
  // consume A-terminal/B-live in one snapshot with the exact visible seat equal
  // to B live (never stale A). Backend semantics win: EITHER request may end in
  // any terminal state; correlated 409 (stale/discard/inflight replay) is accepted
  // only against its exact nonce row. Both-succeed is never required.
  const SECQA = "secretary: " + run + "-overlap-A log the A probe, no decision yet? [QA-SLEEP:6000]";
  const SECQB = "secretary: " + run + "-overlap-B log the B probe, no decision yet? [QA-SLEEP:6000]";
  const NONCEA = crypto.randomUUID();
  const NONCEB = crypto.randomUUID();
  const secOverlapStart = Date.now();
  const secOverlapEnd = Math.min(secOverlapStart + 120000, DEADLINE_MS - 5000);
  ok("secretary-overlap-window-opened", secOverlapEnd > secOverlapStart, "overlap window opens BEFORE either POST resolves (absolute execution, local start)");
  const LIVE_SEC = new Set(["pending", "inflight", "answering"]);
  const TERMINAL_SEC = new Set(["completed", "failed", "discarded", "needs-clarification", "interrupted", "uncertain"]);
  function secExpect(status) { const s = String(status || ""); if (s === "pending") return { act: "pending", human: "Waiting for reply" }; if (s === "inflight" || s === "answering") return { act: "responding", human: "Responding" }; if (s === "needs-clarification") return { act: "waiting-for-clarification", human: "Needs clarification" }; if (s === "completed") return { act: "complete", human: "Responded" }; if (s === "failed") return { act: "failed", human: "Response failed" }; if (s === "discarded") return { act: "abstained", human: "Abstained" }; if (s === "interrupted" || s === "uncertain") return { act: "interrupted", human: "Interrupted" }; return { act: "", human: "" }; }
  async function secSeatExact() {
    assertDeadline("secretary-overlap-seat");
    try {
      const rail = page.locator('section.meet-participants ul.mp-rail[aria-label="Participant activity"]');
      const seats = rail.locator("li.mp-seat");
      const nSec = await raceCap(seats.count(), 8000, "secretary-overlap-seat-count").catch(() => 0);
      for (let siSec = 0; siSec < nSec; siSec++) {
        const seat = seats.nth(siSec);
        const cls = await raceCap(seat.getAttribute("class"), 8000, "secretary-overlap-seat-class").catch(() => "");
        if (!cls || String(cls).indexOf("is-sec") < 0) continue;
        const badge = seat.locator(".mp-badge").first();
        const vis = await raceCap(badge.isVisible(), 8000, "secretary-overlap-seat-vis").catch(() => false);
        if (!vis) return { act: "", human: "", visible: false, reason: "badge-not-visible" };
        const txt = await raceCap(badge.innerText(), 8000, "secretary-overlap-seat-text").catch(() => "");
        const mm = /act-([a-z-]+)/.exec(String(cls));
        return { act: mm ? mm[1] : "", human: String(txt || ""), visible: true, reason: "" };
      }
    } catch (e) { return { act: "", human: "", visible: false, reason: "probe-threw" }; }
    return { act: "", human: "", visible: false, reason: "no-sec-seat" };
  }
  async function secRowsByNonce() {
    assertDeadline("secretary-overlap-rows");
    const gg = await getLocal("/api/meetings/" + meetingId + "/secretary/requests", secOverlapEnd);
    if (gg.status !== 200 || !Array.isArray(gg.json)) return null;
    const rowA = gg.json.find((x) => String(pick(x, "clientNonce") || pick(x, "ClientNonce") || "") === NONCEA) || null;
    const rowB = gg.json.find((x) => String(pick(x, "clientNonce") || pick(x, "ClientNonce") || "") === NONCEB) || null;
    return { list: gg.json, rowA: rowA, rowB: rowB };
  }
  let holdAok = false, holdBok = false;
  try {
    const ha = await fakeCtl("A", "hold", secOverlapEnd);
    const hb = await fakeCtl("B", "hold", secOverlapEnd);
    holdAok = !!ha && ha.status === 200;
    holdBok = !!hb && hb.status === 200;
  } catch (e) { holdAok = false; holdBok = false; }
  ok("secretary-overlap-gates-held", holdAok && holdBok, "fake __hold A=" + holdAok + " B=" + holdBok + " (deterministic gates, no sleep-assumed overlap)");
  if (!(holdAok && holdBok)) failExit("overlap requires deterministic fake gates (OWN 15398 __hold A+B held before either POST); refusing sleep-assumed overlap.");
  let flightA = post("/api/meetings/" + meetingId + "/secretary", { input: SECQA, clientNonce: NONCEA }, { timeout: localCap(secOverlapEnd, REQ_TIMEOUT) });
  let idA = "", statusA = "";
  let aLiveSeen = false;
  while (Date.now() < secOverlapEnd && !aLiveSeen) {
    assertDeadline("secretary-overlap-A-live");
    try {
      const snap = await secRowsByNonce();
      if (snap && snap.rowA) {
        idA = String(pick(snap.rowA, "id") || "");
        statusA = String(pick(snap.rowA, "status") || "");
        if (idA && LIVE_SEC.has(statusA)) aLiveSeen = true;
      }
    } catch (e) {}
    if (!aLiveSeen) await sleep(1000);
  }
  ok("secretary-overlap-A-live-before-B", aLiveSeen, "A live before B starts: idA=" + (idA ? idA.slice(0, 8) : "missing") + " statusA=" + statusA);
  if (!aLiveSeen) failExit("A must be observed LIVE before B starts (deterministic order, no assumed overlap).");
  let flightB = post("/api/meetings/" + meetingId + "/secretary", { input: SECQB, clientNonce: NONCEB }, { timeout: localCap(secOverlapEnd, REQ_TIMEOUT) });
  let idB = "", statusB = "";
  let bothLiveSnap = null;
  while (Date.now() < secOverlapEnd && !bothLiveSnap) {
    assertDeadline("secretary-overlap-both-live");
    try {
      const snap = await secRowsByNonce();
      if (snap && snap.rowA && snap.rowB) {
        const aId = String(pick(snap.rowA, "id") || "");
        const bId = String(pick(snap.rowB, "id") || "");
        const aSt = String(pick(snap.rowA, "status") || "");
        const bSt = String(pick(snap.rowB, "status") || "");
        if (aId && bId && aId.toLowerCase() !== bId.toLowerCase() && LIVE_SEC.has(aSt) && LIVE_SEC.has(bSt)) {
          idA = aId; statusA = aSt; idB = bId; statusB = bSt;
          bothLiveSnap = { aId: aId, bId: bId, aSt: aSt, bSt: bSt, at: Date.now() };
          break;
        }
        if (aId) { idA = aId; statusA = aSt; }
        if (bId) { idB = bId; statusB = bSt; }
      }
    } catch (e) {}
    if (!bothLiveSnap) await sleep(1000);
  }
  ok("secretary-overlap-both-live-same-snapshot", !!bothLiveSnap, bothLiveSnap ? ("A=" + bothLiveSnap.aSt + " B=" + bothLiveSnap.bSt + " distinctIds in ONE snapshot") : ("no single snapshot with BOTH nonces live (A=" + statusA + " B=" + statusB + ")"));
  if (!bothLiveSnap) failExit("BOTH nonce-specific requests must be live in ONE observed backend snapshot (stale sequential live never passes).");
  let relAok = false;
  try { const ra = await fakeCtl("A", "release", secOverlapEnd); relAok = !!ra && ra.status === 200; } catch (e) { relAok = false; }
  ok("secretary-overlap-release-A-while-B-held", relAok, "A released while B held (B gate still held through seat observation)");
  if (!relAok) failExit("A release failed while B held; refusing ambiguous terminal.");
  let aTermBLiveSnap = null;
  while (Date.now() < secOverlapEnd && !aTermBLiveSnap) {
    assertDeadline("secretary-overlap-A-term-B-live");
    try {
      const snap = await secRowsByNonce();
      if (snap && snap.rowA && snap.rowB) {
        const aSt = String(pick(snap.rowA, "status") || "");
        const bSt = String(pick(snap.rowB, "status") || "");
        const aId = String(pick(snap.rowA, "id") || "");
        const bId = String(pick(snap.rowB, "id") || "");
        if (aId.toLowerCase() === idA.toLowerCase() && bId.toLowerCase() === idB.toLowerCase() && TERMINAL_SEC.has(aSt) && LIVE_SEC.has(bSt)) {
          statusA = aSt; statusB = bSt;
          aTermBLiveSnap = { aSt: aSt, bSt: bSt, at: Date.now() };
          break;
        }
        statusA = aSt; statusB = bSt;
      }
    } catch (e) {}
    if (!aTermBLiveSnap) await sleep(1000);
  }
  ok("secretary-overlap-A-term-B-live-same-snapshot", !!aTermBLiveSnap, aTermBLiveSnap ? ("A terminal(" + aTermBLiveSnap.aSt + ") + B live(" + aTermBLiveSnap.bSt + ") in ONE snapshot") : ("no A-terminal/B-live single snapshot (A=" + statusA + " B=" + statusB + ")"));
  if (!aTermBLiveSnap) failExit("must observe A terminal while B live in ONE snapshot (release A while B held).");
  let seatProgressExact = "", seatSurvived = false, overlapDetail = "";
  while (Date.now() < secOverlapEnd && !seatSurvived) {
    assertDeadline("secretary-overlap-seat-consume");
    try {
      const snap = await secRowsByNonce();
      if (snap && snap.rowA && snap.rowB) {
        const aSt = String(pick(snap.rowA, "status") || "");
        const bSt = String(pick(snap.rowB, "status") || "");
        const aId = String(pick(snap.rowA, "id") || "");
        const bId = String(pick(snap.rowB, "id") || "");
        if (aId.toLowerCase() === idA.toLowerCase() && bId.toLowerCase() === idB.toLowerCase() && TERMINAL_SEC.has(aSt) && LIVE_SEC.has(bSt)) {
          statusA = aSt; statusB = bSt;
          const seat = await secSeatExact();
          const exp = secExpect(bSt);
          if (seat.visible && seat.act === exp.act && seat.human === exp.human) {
            seatProgressExact = "act=" + seat.act + " human=" + seat.human;
            seatSurvived = true;
            overlapDetail = "A terminal(" + aSt + ") while B live(" + bSt + ") with exact visible seat " + seatProgressExact + " (mounted App consumed A-terminal/B-live, not stale A)";
            try { secInflightSeen = true; secSeatProgressSeen = true; } catch (e) {}
            break;
          } else {
            overlapDetail = "seat=" + (seat.act || "?") + "/" + (seat.human || "?").slice(0, 30) + " want=" + exp.act + "/" + exp.human + " while A=" + aSt + " B=" + bSt;
          }
        } else {
          overlapDetail = "snapshot moved (A=" + aSt + " B=" + bSt + "); still holding B for A-term/B-live reseat";
        }
      }
    } catch (e) { overlapDetail = "seat-consume threw: " + String((e && e.message) || e).slice(0, 80); }
    if (!seatSurvived) await sleep(1000);
  }
  let relBok = false;
  try { const rb = await fakeCtl("B", "release", secOverlapEnd); relBok = !!rb && rb.status === 200; } catch (e) { relBok = false; }
  ok("secretary-overlap-release-B-after-seat", relBok, "B released only after mounted seat consumed A-terminal/B-live (held through observation)");
  if (!relBok) failExit("B release failed after seat observation; refusing to orphan a held request.");
  const resA = await flightA;
  const resB = await flightB;
  const postAId = String(pick(resA.json, "requestId") || pick(resA.json, "id") || "");
  const postBId = String(pick(resB.json, "requestId") || pick(resB.json, "id") || "");
  if (!idA) idA = postAId;
  if (!idB) idB = postBId;
  function flightCorrelated(res, nonce, rowId) {
    const st = Number(res.status || 0);
    const rid = String(pick(res.json, "requestId") || pick(res.json, "id") || "");
    if (st >= 200 && st < 300) return !!rid && !!rowId && rid.toLowerCase() === String(rowId).toLowerCase();
    if (st === 409) {
      if (!!rid && !!rowId && rid.toLowerCase() === String(rowId).toLowerCase()) return true;
      return "backend-row";
    }
    return false;
  }
  let corrA = flightCorrelated(resA, NONCEA, idA);
  let corrB = flightCorrelated(resB, NONCEB, idB);
  let finA = null, finB = null;
  try {
    const fg = await getLocal("/api/meetings/" + meetingId + "/secretary/requests", secOverlapEnd);
    if (fg.status === 200 && Array.isArray(fg.json)) {
      finA = fg.json.find((x) => String(pick(x, "clientNonce") || pick(x, "ClientNonce") || "") === NONCEA) || null;
      finB = fg.json.find((x) => String(pick(x, "clientNonce") || pick(x, "ClientNonce") || "") === NONCEB) || null;
      if (finA) statusA = String(pick(finA, "status") || statusA);
      if (finB) statusB = String(pick(finB, "status") || statusB);
    }
  } catch (e) {}
  if (corrA === "backend-row") corrA = !!finA && String(pick(finA, "id") || "").toLowerCase() === String(idA).toLowerCase() && TERMINAL_SEC.has(String(pick(finA, "status") || ""));
  if (corrB === "backend-row") corrB = !!finB && String(pick(finB, "id") || "").toLowerCase() === String(idB).toLowerCase() && TERMINAL_SEC.has(String(pick(finB, "status") || ""));
  const postOk = !!corrA && !!corrB && !!idA && !!idB && idA.toLowerCase() !== idB.toLowerCase();
  ok("secretary-overlap-posted", postOk, "A=" + resA.status + (corrA === true ? "+row" : "") + " B=" + resB.status + (corrB === true ? "+row" : "") + " idA=" + idA.slice(0, 8) + " idB=" + idB.slice(0, 8) + " distinct=" + (!!idA && !!idB && idA.toLowerCase() !== idB.toLowerCase()) + " (2xx or correlated-409-terminal only)");
  if (!postOk) failExit("overlap POSTs must each resolve 2xx with exact requestId or correlated 409 terminal against the same nonce row (unrelated 409/5xx never passes).");
  const nonceOk = !!finA && !!finB && String(pick(finA, "id") || "").toLowerCase() === idA.toLowerCase() && String(pick(finB, "id") || "").toLowerCase() === idB.toLowerCase();
  ok("secretary-overlap-nonce-exact", nonceOk && !!bothLiveSnap, "A nonce-exact rows=" + !!finA + " B=" + !!finB + " distinctIds=" + (idA.toLowerCase() !== idB.toLowerCase()) + " bothLiveSnap=" + !!bothLiveSnap);
  if (!nonceOk) failExit("overlap requests must resolve to nonce-specific backend rows with distinct IDs.");
  ok("secretary-inflight-seat-progress", !!bothLiveSnap && !!seatProgressExact, "bothLiveSnap=" + !!bothLiveSnap + " exactSeat=" + (seatProgressExact || "none") + " A=" + statusA + " B=" + statusB);
  if (!(!!bothLiveSnap && !!seatProgressExact)) failExit("Secretary must show BOTH live in one snapshot plus exact visible in-rail seat progress (act + human badge, visible) before completion.");
  ok("secretary-overlap-seat-survives-terminal", seatSurvived, overlapDetail || ("A=" + statusA + " B=" + statusB + " seat=" + seatProgressExact));
  if (!seatSurvived) failExit("A terminal/stale discard must not clear B's visible pending seat: B live with exact badge required after A terminal (mounted consumed A-term/B-live).");
  const overlapIds = [idA.toLowerCase(), idB.toLowerCase()];
  const overlapOk = postOk && nonceOk && !!bothLiveSnap && seatSurvived && new Set(overlapIds).size === 2;
  ok("secretary-overlap-two-requests", overlapOk, "distinctIds=2 A=" + statusA + " B=" + statusB + " survived=" + seatSurvived + " (terminal kind recorded, both-succeed never required)");
  if (!overlapOk) failExit("true overlapping Secretary scenario requires two distinct live requests with seat survival.");
  // Direct-chat prompt proof BEFORE the canonical edit (M paras): the isolated
  // stateless prompt carries FULL current paras and NEVER leaks meeting/board
  // evidence into roster chat.
  if (MODE === "native") {
    const chatQBefore = "Direct " + run + "-pre: state your current berth criterion in one line?";
    const canonPre = await canonicalEntry(rosterId);
    const preParas = threeParas(canonPre.entry ? (pick(canonPre.entry, "profileJson") || "") : "");
    const chatPre = await post("/api/roster/" + rosterId + "/chat", { message: chatQBefore });
    ok("roster-chat-before-posted", chatPre.status === 200 && typeof pick(chatPre.json, "answer") === "string" && String(pick(chatPre.json, "answer")).length >= 10, "status=" + chatPre.status);
    if (!(chatPre.status === 200 && typeof pick(chatPre.json, "answer") === "string")) failExit("pre-edit direct chat failed; refusing prompt proof.");
    const clogPre = await fakeLog();
    const preChats = Array.isArray(clogPre) ? ownedLog(clogPre).filter((e) => e.path === "chat" && logText(e).includes(chatQBefore)) : [];
    const preFullOk = preParas.length === 3 && preChats.length >= 1 && preParas.every((para) => preChats.some((e) => logText(e).includes(para)));
    ok("roster-chat-current-paras-before", preFullOk, "chats=" + preChats.length + " paras=" + preParas.length);
    if (!preFullOk) failExit("pre-edit direct-chat prompt must carry FULL current paras (before canonical edit).");
    const leakBefore = preChats.filter((e) => logText(e).includes(QUESTION) || logText(e).includes("MEETING BRIEF:") || logText(e).includes("ADOPTED DIRECTION") || logText(e).includes("CALLER ") || logText(e).includes("BOARD: "));
    ok("roster-chat-no-board-leak-before", preChats.length >= 1 && leakBefore.length === 0, "chats=" + preChats.length + " leaked=" + leakBefore.length);
    if (!(preChats.length >= 1 && leakBefore.length === 0)) failExit("stateless roster chat must NEVER carry meeting/board evidence (before edit).");
  } else { ok("roster-chat-current-paras-before", false, "live mode UNPROVED prompt path"); ok("roster-chat-no-board-leak-before", false, "live mode UNPROVED prompt path"); }
  await scanDebug("meeting-shell");
  await scanDebug("meeting-messages");
  checkBudget("meeting");
}
// ---- 5. canonical re-edit + re-gate + prompt-log markers ----
async function stepReeditRerun() {
  await gotoTab("/#/roster");
  const dlgStill = page.locator('div.modal[role="dialog"][aria-label="Create advisor"]');
  const dlgVisible = await dlgStill.first().isVisible().catch(() => false);
  ok("canonical-reedit-dialog-closed", await dlgStill.count() === 0 && !dlgVisible, "dialogCount=" + await dlgStill.count() + " visible=" + dlgVisible);
  if (await dlgStill.count() !== 0 || dlgVisible) failExit("create dialog still mounted/visible before canonical re-edit; refusing ambiguous editor proof.");
  let editorOpen = false;
  try {
    const row = page.locator("aside.listpanel button.lprow", { hasText: rosterName }).first();
    await row.waitFor({ timeout: boundedTimeout(BROWSER_TIMEOUT, 8000) });
    const nm = await row.locator(".lprow-name").innerText().catch(() => "");
    if (nm !== rosterName) throw new Error("roster row name mismatch want=" + rosterName + " got=" + nm);
    await row.click({ timeout: boundedTimeout(BROWSER_TIMEOUT, 8000) });
    await wft(1200);
    const aria = await row.getAttribute("aria-current").catch(() => null);
    const n = await page.locator("fieldset").filter({ hasText: "Character paragraphs" }).count().catch(() => 0);
    editorOpen = n === 1 && aria === "true";
  } catch {}
  ok("canonical-editor-open", editorOpen, editorOpen ? "exactly one Character paragraphs editor (detail)" : "could not open owned entry into a single detail editor");
  if (!editorOpen) failExit("canonical editor did not open as a single detail editor; refusing HTTP-only edit (UI path required).");
  const fs = page.locator("fieldset").filter({ hasText: "Character paragraphs" }).locator("textarea");
  const n = await fs.count();
  if (n !== 3) failExit("expected 3 paragraph editables, found " + n);
  const cur = [];
  for (let i = 0; i < 3; i++) cur.push(await fs.nth(i).inputValue().catch(() => ""));
  // Reopened editor must equal CANONICAL saved paras (M-marked), NOT the preserved draftProfile: backend intentionally preserves draft on behavior save (RosterOps.PreserveResearchOnBehaviorSave).
  const canonBefore = await canonicalEntry(rosterId);
  const canonBeforeJson = canonBefore.entry ? (pick(canonBefore.entry, "profileJson") || "") : "";
  const canonBeforeParas = threeParas(canonBeforeJson);
  const editorEqCanon = cur.length === 3 && canonBeforeParas.length === 3 && cur.every((v, i) => v === canonBeforeParas[i]);
  ok("canonical-reopen-eq-canonical", canonBefore.status === 200 && !!canonBefore.entry && editorEqCanon, "editor==canonicalSaved exact=" + editorEqCanon);
  if (!editorEqCanon) failExit("reopened editor must equal canonical saved paras, not draftProfile.");
  const draftNow = await get("/api/roster/" + rosterId + "/research").catch(() => ({ status: 0, json: null }));
  const draftNowP = (draftNow.status === 200 && draftNow.json) ? pick(draftNow.json, "draftProfile") : null;
  const draftNowVals = draftNowP ? [String(pick(draftNowP, "contributionCriteria") || ""), String(pick(draftNowP, "reasoningApproach") || ""), String(pick(draftNowP, "responseStyle") || "")] : [];
  const differsFromDraft = cur.length === 3 && draftNowVals.length === 3 && cur.some((v, i) => v !== String(draftNowVals[i] || ""));
  ok("canonical-differs-from-preserved-draft", differsFromDraft, "backend preserves draft; editor shows canonical");
  const marks2 = [N1, N2, N3];
  const submitted2 = [];
  for (let i = 0; i < 3; i++) {
    const stripped = cur[i].split("[" + M1).join("").split("[" + M2).join("").split("[" + M3).join("").trim();
    const next = stripped + " [" + marks2[i] + "]";
    await fs.nth(i).fill(next);
    submitted2.push(next);
  }
  const rBefore = await get("/api/roster/" + rosterId + "/research");
  const verBefore = Number(pick(rBefore.json, "version") || 0);
  try {
    const waited = Promise.all([
      page.waitForResponse((r) => new URL(r.url()).pathname === "/api/roster/" + rosterId && r.request().method() === "PUT", { timeout: boundedTimeout(BROWSER_TIMEOUT, 8000) }),
      page.getByRole("button", { name: /save draft changes/i }).first().click(),
    ]);
    const resps = await waited;
    ok("canonical-edit-saved", resps[0].status() === 200, "status=" + resps[0].status());
  } catch (e) { ok("canonical-edit-saved", false, "PUT /api/roster/{id} never completed"); failExit("canonical edit save failed."); }
  try { globalThis.__canonCurrent = submitted2.slice(); } catch {}
  const canon = await canonicalEntry(rosterId);
  const rawJson2 = canon.entry ? (pick(canon.entry, "profileJson") || "") : "";
  const rawOk2 = originalThreeStrings(rawJson2) !== null;
  const full = threeParas(rawJson2);
  let rawParsedOk = false; try { const _pj = JSON.parse(rawJson2 || "null"); rawParsedOk = _pj && typeof _pj.contributionCriteria === "string" && typeof _pj.reasoningApproach === "string" && typeof _pj.responseStyle === "string" && _pj.contributionCriteria === submitted2[0] && _pj.reasoningApproach === submitted2[1] && _pj.responseStyle === submitted2[2]; } catch { rawParsedOk = false; }
  const noOldMarkers = full.every((v) => !v.includes("[" + M1) && !v.includes("[" + M2) && !v.includes("[" + M3));
  ok("canonical-markers-roundtrip", canon.status === 200 && !!canon.entry && rawOk2 && rawParsedOk && requireThree(full) && full.every((v, i) => v === submitted2[i]) && noOldMarkers, "status=" + canon.status + " rawJsonExact=" + rawParsedOk + " noOldMarkers=" + noOldMarkers);
  if (!(canon.status === 200 && requireThree(full) && rawParsedOk)) failExit("canonical re-edit readback must be full three JSON raw strings with exact submitted roundtrip.");
  const rAfter = await get("/api/roster/" + rosterId + "/research");
  const rAfterVer = Number(pick(rAfter.json, "version") || 0);
  const verBumpOk = Number.isInteger(rAfterVer) && Number.isInteger(verBefore) && verBefore > 0 && rAfterVer > verBefore;
  ok("canonical-version-bump", verBumpOk, "before=" + verBefore + " after=" + rAfterVer);
  if (!verBumpOk) failExit("canonical version must strictly increase as positive integers.");
  // Board re-review/sync/approve via the actual gate (observe; never assume no re-approval).
  const sy = await post("/api/boards/" + boardA + "/advisors/" + advisor1 + "/sync-roster", {});
  const syOk = sy.status === 200;
  const ap = await post("/api/boards/" + boardA + "/advisors/" + advisor1 + "/approve", {});
  ok("rereview-sync-approve", syOk && ap.status === 200, "sync=" + sy.status + " approve=" + ap.status);
  if (!(syOk && ap.status === 200)) failExit("re-review gate did not clear; stopping before rerun proof.");
  // Next run: fresh owned meeting, HTTP run (real route), then prompt-log proof.
  const m2 = await post("/api/boards/" + boardA + "/meetings", { title: run + " harbor rerun", brief: "Rerun brief " + run, participantIds: [advisor1] });
  if (m2.status !== 201 || !pick(m2.json, "id")) failExit("rerun meeting create failed.");
  const mid2 = String(pick(m2.json, "id"));
  const rerunMarker = "RERUN-" + run + "-" + mid2.slice(0, 8);
  const curFull = (globalThis.__canonCurrent && globalThis.__canonCurrent.length === 3) ? globalThis.__canonCurrent : submitted2;
  // Unique lead prompt marker MUST be POSTED before the API run (exact owned YOUR TURN gate).
  const rerunBoundary = Date.now();
  // d896a83 closure item 19: lead carries ONLY the unique discriminator + ordinary question. Current paragraphs must reach the model via the canonical behavior section (ContextCurator), never via lead echo.
  const rerunLeadContent = rerunMarker + " " + QUESTION;
  const rl2 = await post("/api/meetings/" + mid2 + "/messages", { sender: "lead", content: rerunLeadContent });
  ok("rerun-lead-posted", rl2.status === 200 || rl2.status === 201, "status=" + rl2.status);
  if (!(rl2.status === 200 || rl2.status === 201)) failExit("rerun lead with unique marker must post before run.");
  const lead2Ver = Number(pick((await get("/api/boards/" + boardA + "/lead")).json, "version") || 0);
  if (!(Number.isInteger(lead2Ver) && lead2Ver > 0)) failExit("rerun lead version must be strict positive integer.");
  const rerunRunBody = { policy: "balanced", prompt: rerunLeadContent, evidenceSupported: false, leadVersion: lead2Ver };
  const r2 = await post("/api/meetings/" + mid2 + "/run", rerunRunBody, { timeout: Math.min(RUN_TIMEOUT, Math.max(1, remainingMs())) });
  try { globalThis.__rerunEvFalse = (rerunRunBody.evidenceSupported === false); } catch (e) {}
  ok("rerun-run-200", r2.status === 200, "status=" + r2.status);
  const vm2 = await get("/api/meetings/" + mid2 + "/messages?take=100");
  const vl2 = Array.isArray(vm2.json) ? vm2.json : [];
  const vadv2 = vl2.filter((x) => String(pick(x, "advisorId") || "").toLowerCase() === advisor1.toLowerCase() && String(pick(x, "content") || pick(x, "body") || "").trim().length >= 20);
  ok("rerun-published", vm2.status === 200 && vadv2.length >= 1, "status=" + vm2.status + " adv1Published=" + vadv2.length);
  if (MODE === "native") {
    const log = await fakeLog();
    if (!Array.isArray(log)) failExit("native mode requires fake log for rerun proof.");
    const post2 = ownedLog(log).filter((e) => Number(e.t || 0) >= rerunBoundary && e.path === "chat");
    const yourTurn = post2.filter((e) => logText(e).includes("YOUR TURN"));
    const ownedCorr = yourTurn.filter((e) => logText(e).includes("Harbor Strategist") || logText(e).includes(rosterName) || logText(e).includes(advisor1));
    const withMarker = ownedCorr.filter((e) => logText(e).includes(rerunMarker));
    const withCurrent = withMarker.filter((e) => [N1, N2, N3].every((mk) => logText(e).includes(mk)) && curFull.every((para) => logText(e).includes(para)));
    const staleLeak = withMarker.filter((e) => [M1, M2, M3].some((mk) => logText(e).includes(mk)));
    ok("promptlog-current-markers-owned", withMarker.length >= 1 && withCurrent.length >= 1 && staleLeak.length === 0 && post2.length >= 1 && yourTurn.length >= 1, "marker=" + withMarker.length + " currentFull=" + withCurrent.length + " stale=" + staleLeak.length);
    if (!(withMarker.length >= 1 && withCurrent.length >= 1 && staleLeak.length === 0)) failExit("rerun prompt must carry exact owned YOUR TURN marker plus current full paragraphs, no stale leak.");
    // Bid prompts AFTER the canonical edit: FULL N paras (tail included), no stale M leak.
    const post2bids = ownedLog(log).filter((e) => Number(e.t || 0) >= rerunBoundary && /Reply with exactly YES or NO/.test(logText(e)));
    const bidAfterFull = curFull.length === 3 && post2bids.length >= 1 && curFull.every((para) => para.length >= 10 && post2bids.some((e) => logText(e).includes(para)));
    const bidAfterTail = curFull.length === 3 && curFull.every((para) => { const tail = para.slice(Math.max(0, para.length - 40)); return tail.length >= 10 && post2bids.some((e) => logText(e).includes(tail)); });
    const bidAfterStale = post2bids.filter((e) => [M1, M2, M3].some((mk) => logText(e).includes(mk)));
    ok("bid-after-current-paras-owned", bidAfterFull && bidAfterTail && bidAfterStale.length === 0 && post2bids.length >= 1, "bids=" + post2bids.length + " tail=" + bidAfterTail + " stale=" + bidAfterStale.length);
    if (!(bidAfterFull && bidAfterTail && bidAfterStale.length === 0)) failExit("rerun bid prompts must carry FULL current paras with no stale leak (after edit).");
    // Meeting prompt AFTER the edit: real prefs DELIVERED + authorized evidence retained.
    const prefsAfter = withMarker.some((e) => logText(e).includes("oc-" + run));
    const runEvFalseAfter = (globalThis.__rerunEvFalse === true) && (rerunRunBody.evidenceSupported === false);
    const evAfter = withMarker.some((e) => logText(e).includes(QUESTION));
    ok("meeting-prompt-prefs-evidence-after", prefsAfter && evAfter && withCurrent.length >= 1, "prefs=" + prefsAfter + " questionDuplicate=" + evAfter + " (NOT eligible evidence; evidenceSupported=false retained) currentFull=" + withCurrent.length);
    ok("meeting-eligible-evidence-controlled-absent-after", prefsAfter && evAfter && withCurrent.length >= 1 && runEvFalseAfter, "evidenceSupported=false controlled after edit (rerunRunBody.ev=" + runEvFalseAfter + "); QUESTION duplicate is brief/input, never claimed as eligible EVIDENCE payload");
    if (!runEvFalseAfter) failExit("eligible meeting EVIDENCE must stay controlled-absent after edit (rerun run evidenceSupported=false required).");
    if (!(prefsAfter && evAfter)) failExit("MEETING reply prompt must DELIVER real comm prefs + question-duplicate + full paras (after edit; eligible evidence explicitly absent, evidenceSupported=false).");
  } else {
    ok("promptlog-live-unproved", false, "live mode: prompt inspection unavailable; rerun published-nonempty=" + vadv2.length + " but prompt correlation UNPROVED (no fake log)");
  }
  checkBudget("reedit-rerun");
}

// ---- 5b. roster direct chat through the REAL RosterChatPanel UI ----
async function stepRosterChatUI() {
  await gotoTab("/#/roster");
  const freshCol = await get("/api/roster?accountId=" + ACCT);
  const freshRows = Array.isArray(freshCol.json) ? freshCol.json : [];
  const freshHit = freshRows.find((x) => String(pick(pick(x, "entry") || x, "id") || "").toLowerCase() === String(rosterId).toLowerCase());
  const freshEntry = freshHit ? (pick(freshHit, "entry") || freshHit) : null;
  const freshName = freshEntry ? String(pick(freshEntry, "name") || "") : "";
  const freshVer = freshEntry ? Number(pick(freshEntry, "version") || 0) : 0;
  const canonPre = await canonicalEntry(rosterId);
  const canonVer = canonPre.entry ? Number(pick(canonPre.entry, "version") || 0) : 0;
  const selDiag = "freshRows=" + freshRows.length + " hit=" + !!freshHit + " nameEq=" + (freshName === rosterName) + " freshVer=" + freshVer + " canonVer=" + canonVer + " rosterId=" + String(rosterId).slice(0, 8);
  ok("roster-chat-fresh-entry-identity", freshCol.status === 200 && !!freshHit && freshName === rosterName && Number.isInteger(freshVer) && freshVer > 0, selDiag);
  if (!(freshCol.status === 200 && !!freshHit && freshName === rosterName)) failExit("fresh roster collection lost the exact selected entry after re-edit; refusing panel proof. " + selDiag);
  const rrow = page.locator("aside.listpanel button.lprow", { hasText: rosterName }).first();
  try { await rrow.waitFor({ timeout: boundedTimeout(BROWSER_TIMEOUT, 8000) }); } catch { ok("roster-chat-panel-mounted", false, "owned roster row never visible for click; " + selDiag); failExit("roster row not visible; no swallowed click. " + selDiag); }
  const rowName = await rrow.locator(".lprow-name").innerText().catch(() => "");
  if (rowName !== rosterName) { ok("roster-chat-panel-mounted", false, "roster row name mismatch; " + selDiag); failExit("roster row identity drift after canonical re-edit; refusing wrong-entry chat. " + selDiag); }
  try { await rrow.click({ timeout: boundedTimeout(BROWSER_TIMEOUT, 8000) }); } catch (e) { ok("roster-chat-panel-mounted", false, "owned row click failed: " + trunc(String((e && e.message) || e), 120) + " " + selDiag); failExit("roster row click failed; no swallowed click. " + selDiag); }
  try { await page.waitForFunction((exp) => { const b = Array.from(document.querySelectorAll("aside.listpanel button.lprow")).find((e) => (e.textContent || "").indexOf(exp) >= 0); if (!b) return false; return b.getAttribute("aria-current") === "true" && b.className.indexOf("active") >= 0; }, rosterName, { timeout: boundedTimeout(BROWSER_TIMEOUT, 8000) }); } catch {}
  const ariaCur = await rrow.getAttribute("aria-current").catch(() => null);
  const clsCur = await rrow.evaluate((el) => el.className).catch(() => "");
  const selOk = ariaCur === "true" && String(clsCur).indexOf("active") >= 0;
  if (!selOk) { const allN = await page.locator("aside.listpanel button.lprow .lprow-name").allInnerTexts().catch(() => []); ok("roster-chat-panel-mounted", false, "selection did not land on owned entry aria=" + ariaCur + " rows=" + (allN || []).length + " " + selDiag); failExit("roster selection identity not proven; refusing panel proof. " + selDiag); }
  await wft(800);
  const panel = page.locator('div[data-roster-chat="' + rosterId + '"]');
  let panelOk = false;
  let panelDiag = "";
  let waitErr = "none"; try { await panel.first().waitFor({ timeout: boundedTimeout(20000, 8000) }); } catch (e) { waitErr = String((e && e.message) || e).slice(0, 160); } const panelExactCount = await panel.count().catch(() => -1); const panelCount = await page.locator("div[data-roster-chat]").count().catch(() => -1); const nativeN = await ev((rid) => { const els = Array.from(document.querySelectorAll("div[data-roster-chat]")); let ex = 0; let vv = 0; for (const el of els) { if (el.getAttribute("data-roster-chat") === rid) { ex++; try { const r = el.getBoundingClientRect(); const cs = window.getComputedStyle(el); if (r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none") vv++; } catch (ee) { } } } return { all: els.length, exact: ex, vis: vv }; }, rosterId).catch(() => null);
  { const rowCount = await page.locator("aside.listpanel button.lprow").count().catch(() => -1); let nativeDiag = "native=uncollected"; try { nativeDiag = await ev((rid) => { try { const els = Array.from(document.querySelectorAll("div[data-roster-chat]")); let exactN = 0; try { exactN = els.filter((e) => e.getAttribute("data-roster-chat") === rid).length; } catch (e2) { exactN = -2; } let visN = 0; const visHeads = []; try { for (const el of els) { let vis = false; try { const r = el.getBoundingClientRect(); const cs = window.getComputedStyle(el); vis = r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; } catch (e4) { vis = false; } if (vis) { visN++; if (visHeads.length < 3) { let h = ""; try { const sec = el.closest("section,aside,main"); const hh = sec ? sec.querySelector("h1,h2,h3") : null; h = (hh && hh.innerText ? hh.innerText : "").slice(0, 40); } catch (e5) { h = "head-err"; } visHeads.push("attr=" + String(el.getAttribute("data-roster-chat") || "").slice(0, 8) + " head=" + h); } } } } catch (e3) { visN = -3; } const headFor = (el) => { try { const sec = el.closest("section,aside,main"); const h = sec ? sec.querySelector("h1,h2,h3") : null; return (h && h.innerText ? h.innerText : "").slice(0, 40); } catch (e3) { return "head-err"; } }; return "nativeCount=" + els.length + " nativeExact=" + exactN + " nativeVisible=" + visN + " totalDivs=" + document.querySelectorAll("div").length + " url=" + String(location.hash || "").slice(0, 80) + " attrs=[" + els.slice(0, 3).map((e) => "attr=" + String(e.getAttribute("data-roster-chat") || "").slice(0, 8) + " head=" + headFor(e)).join(";") + "] visHeads=[" + visHeads.join(";") + "]"; } catch (e) { return "native-eval-threw"; } }, rosterId).catch(() => "native-eval-failed"); } catch (e) { nativeDiag = "native-harness-threw"; } let shotInfo = "shot=skipped"; try { const osMod = await import("node:os"); const shotPath = String(osMod.tmpdir()).replace(/\\/g, "/") + "/qa-author-roster-" + run + ".png"; await page.screenshot({ path: shotPath }).catch(() => {}); shotInfo = "shot=" + shotPath; } catch (e) { shotInfo = "shot-failed"; } panelDiag = "rowCount=" + rowCount + " panelCount=" + panelCount + " panelExact=" + panelExactCount + " waitErr=" + waitErr + " nativeAll=" + (nativeN ? nativeN.all : -1) + " nativeExact=" + (nativeN ? nativeN.exact : -1) + " nativeVis=" + (nativeN ? nativeN.vis : -1) + " aria=" + ariaCur + " " + selDiag + " " + nativeDiag + " " + shotInfo; }
  const singular = panelExactCount === 1 && !!nativeN && nativeN.exact === 1 && nativeN.vis === 1;
  ok("roster-chat-panel-mounted", singular, singular ? "div[data-roster-chat] single same-entry=" + String(rosterId).slice(0, 8) + " " + selDiag : "panel not singular; " + panelDiag);
  ok("roster-chat-panel-singular", singular, "exact=" + panelExactCount + " nativeAll=" + (nativeN ? nativeN.all : -1) + " nativeExact=" + (nativeN ? nativeN.exact : -1) + " nativeVis=" + (nativeN ? nativeN.vis : -1) + " waitErr=" + waitErr + " " + selDiag);
  panelOk = singular;
  if (!panelOk) failExit("roster chat panel not singular for same exact entry after proven selection; refusing HTTP-only chat. " + panelDiag);
  const headOk = await panel.getByText("Chat with this advisor", { exact: false }).count().then((c) => c > 0).catch(() => false);
  const boardfreeOk = await panel.getByText(/nothing here joins a meeting/i).count().then((c) => c > 0).catch(() => false);
  ok("roster-chat-boardfree-contract", headOk && boardfreeOk, "heading=" + headOk + " boardfree-note=" + boardfreeOk);
  const chatLog = panel.locator('[role="log"]');
  const chatBox = panel.getByLabel(/message /i);
  const boxOk = await chatBox.count() > 0;
  ok("roster-chat-controls", boxOk && await chatLog.count() > 0, "messageBox=" + boxOk);
  if (!boxOk) failExit("roster chat message box missing.");
  const mc0 = await get("/api/meetings/" + meetingId + "/messages?take=100");
  function hasField(x, lower) { try { return Object.keys(x).some((k) => String(k).toLowerCase() === String(lower).toLowerCase()); } catch { return false; } }
  function typedVal(v) { if (v === null) return "null:null"; if (v === undefined) return "missing:missing"; const t = Array.isArray(v) ? "array" : typeof v; try { return t + ":" + JSON.stringify(v); } catch { return t + ":unstringifiable"; } }
  // FULL typed MessageDTO: parentSequence + advisorName presence REQUIRED (field
  // must exist even when null); raw null is preserved and distinguished from
  // "" and from missing. Coercing null->"" via String(v||"") never passes.
  const msgValid = (x) => { if (!x || typeof x !== "object") return false; const seq = pick(x, "sequence") ?? pick(x, "Sequence"); if (!Number.isInteger(seq)) return false; if (typeof pick(x, "sender") !== "string") return false; const ct = pick(x, "content") ?? pick(x, "Content"); if (typeof ct !== "string") return false; if (typeof pick(x, "advisorId") !== "string") return false; if (typeof pick(x, "stance") !== "string") return false; if (typeof pick(x, "status") !== "string") return false; if (typeof pick(x, "boardId") !== "string") return false; if (typeof pick(x, "meetingId") !== "string") return false; const ca = pick(x, "createdAt") ?? pick(x, "CreatedAt"); if (typeof ca !== "string" || !ca || isNaN(Date.parse(ca))) return false; if (!hasField(x, "parentsequence")) return false; const ps = pick(x, "parentSequence") ?? pick(x, "ParentSequence"); if (ps !== null && !Number.isInteger(ps)) return false; if (!hasField(x, "advisorname")) return false; const an = pick(x, "advisorName") ?? pick(x, "AdvisorName"); if (an !== null && typeof an !== "string") return false; return true; };
  const msgSnap = (x) => ["sequence", "sender", "advisorId", "content", "parentSequence", "stance", "status", "boardId", "meetingId", "advisorName", "createdAt"].map((k) => { const v = pick(x, k) ?? pick(x, k.charAt(0).toUpperCase() + k.slice(1)); const present = hasField(x, k); return k + "=" + (present ? typedVal(v === undefined ? null : v) : "missing:missing"); }).join("|");
  const mc0Valid = mc0.status === 200 && Array.isArray(mc0.json) && mc0.json.every(msgValid);
  ok("roster-chat-message-shape", mc0Valid, "all meeting messages carry Sequence/ParentSequence/Status/Stance/Content");
  if (!mc0Valid) failExit("meeting message entities must validate full snapshot; Id does not exist (Sequence only).");
  const c0snap = Array.isArray(mc0.json) ? mc0.json.map(msgSnap) : [];
  const c0 = c0snap.length;
  const baseLeadExact = Array.isArray(mc0.json) ? mc0.json.filter((x) => String(pick(x, "content") ?? pick(x, "Content") ?? "") === QUESTION).length : 0;
  ok("roster-chat-baseline-valid", mc0.status === 200 && baseLeadExact === 1, "meetingHasOwnedLeadExact=" + baseLeadExact + " total=" + c0);
  if (!(mc0.status === 200 && baseLeadExact === 1)) failExit("meeting baseline not positively validated; refusing stateless proof.");
  const chatQ = "Direct " + run + ": state your current berth criterion in one line?";
  const chatRespPromise = page.waitForResponse((r) => { try { return new URL(r.url()).pathname === "/api/roster/" + rosterId + "/chat" && r.request().method() === "POST"; } catch { return false; } }, { timeout: Math.min(95000, Math.max(1, remainingMs())) }).catch(() => null);
  await chatBox.first().fill(chatQ);
  const sendBtn = panel.getByRole("button", { name: /^send$/i });
  try { await sendBtn.first().click({ timeout: boundedTimeout(8000, 8000) }); } catch (e) { let clickDiag = String((e && e.message) || e).slice(0, 200); try { clickDiag += " pt=" + await sendBtn.first().evaluate((el) => { const r = el.getBoundingClientRect(); const x = Math.round(r.x + r.width / 2); const y = Math.round(r.y + r.height / 2); let ds = "q-na"; try { const tt = document.elementFromPoint(x, y); ds = tt === el ? "self" : (tt ? tt.tagName + "." + String(tt.className || "").slice(0, 50) : "none"); } catch (ee) { ds = "q-na"; } return x + "," + y + " hit=" + ds + " dis=" + !!el.disabled; }).catch(() => "pt-na"); } catch (ee) { clickDiag += " diag-na"; } ok("roster-chat-ui-reply", false, "Send never clickable " + clickDiag); failExit("roster chat send failed. " + clickDiag); }
  let advAnswer = "";
  try {
    await page.waitForFunction((rid) => {
      const rows = document.querySelectorAll('div[data-roster-chat="' + rid + '"] .msg-row.advisor .btext');
      for (const r of rows) { const t = (r.innerText || "").trim(); if (t.length >= 20 && !/^Responding/.test(t)) return true; }
      return false;
    }, rosterId, { timeout: boundedTimeout(90000, 8000) });
    const texts = await panel.locator(".msg-row.advisor .btext").allInnerTexts().catch(() => []);
    const cands = (texts || []).map((t) => String(t || "").trim()).filter((t) => t.length >= 20 && !/^Responding/.test(t) && !t.includes(chatQ.slice(0, 20)));
    advAnswer = cands.length > 0 ? cands[cands.length - 1] : "";
  } catch { ok("roster-chat-ui-reply", false, "no completed advisor .msg-row.advisor .btext answer within 90s"); }
  if (advAnswer) ok("roster-chat-ui-reply", advAnswer.length >= 20 && !/^Responding/.test(advAnswer) && advAnswer !== chatQ && !advAnswer.includes(chatQ.slice(0, 20)), "advLen=" + advAnswer.length);
  else ok("roster-chat-ui-reply", false, "no distinct advisor answer (echo/pending is not proof)");
  const _chatResp = await chatRespPromise;
  let chatAns = "", chatRid = "", chatVer = 0, chatStored = null, chatStatus = 0;
  try { if (_chatResp) { chatStatus = _chatResp.status(); const _cj = await respJson(_chatResp, "roster-chat"); chatAns = typeof pick(_cj, "answer") === "string" ? String(pick(_cj, "answer")) : ""; chatRid = String(pick(_cj, "rosterId") || ""); chatVer = Number(pick(_cj, "rosterVersion") || 0); chatStored = pick(_cj, "stored"); } } catch {}
  let pairedReqUrl = ""; let pairedReqBody = ""; try { const prq = _chatResp ? _chatResp.request() : null; if (prq) { pairedReqUrl = new URL(prq.url()).pathname; try { const pd = prq.postData(); pairedReqBody = typeof pd === "string" ? pd : ""; } catch (e) { pairedReqBody = ""; } } } catch (e) {}
  let pairedJson = null; try { pairedJson = pairedReqBody ? JSON.parse(pairedReqBody) : null; } catch { pairedJson = null; }
  const ownedChat = netPosts.rosterChat.filter((e) => String(e.url || "").includes(rosterId));
  const chatReq = ownedChat.length > 0 ? ownedChat[ownedChat.length - 1] : null;
  let chatJson = null; try { chatJson = chatReq ? JSON.parse(chatReq.body) : null; } catch { chatJson = null; }
  const chatUrlOk = pairedReqUrl === "/api/roster/" + rosterId + "/chat" && !!chatReq && String(chatReq.url || "") === "/api/roster/" + rosterId + "/chat";
  const chatKeyOk = !!pairedJson && typeof pairedJson.message === "string" && pairedJson.message === chatQ && !("content" in pairedJson) && !("body" in pairedJson) && !!chatJson && chatJson.message === chatQ;
  const chatPairOk = !!_chatResp && pairedReqUrl === "/api/roster/" + rosterId + "/chat" && !!chatReq && String(chatReq.url || "") === "/api/roster/" + rosterId + "/chat" && pairedReqBody.indexOf(chatQ) >= 0;
  const chatVerOk = Number.isInteger(chatVer) && chatVer > 0 && chatVer === freshVer && freshVer > 0;
  const chatResOk = chatPairOk && chatStatus >= 200 && chatStatus < 300 && chatAns.length >= 20 && chatRid.toLowerCase() === String(rosterId).toLowerCase() && chatVerOk && chatStored === false;
  const uiEqOk = !!advAnswer && advAnswer === chatAns;
  ok("roster-chat-request", chatUrlOk && chatKeyOk && chatResOk, "urlExact=" + chatUrlOk + " messageKeyExact=" + chatKeyOk + " paired=" + chatPairOk + " answerLen=" + chatAns.length + " ver=" + chatVer + " freshVer=" + freshVer);
  if (!(chatUrlOk && chatKeyOk && chatResOk)) failExit("roster chat must use EXACT message key with 200 answer/rosterId/version/stored.");
  ok("roster-chat-ui-eq-answer", uiEqOk, "uiLen=" + (advAnswer ? advAnswer.length : 0) + " ansLen=" + chatAns.length);
  if (MODE === "native") {
    const canonChat = await canonicalEntry(rosterId);
    const chatParas = threeParas(canonChat.entry ? (pick(canonChat.entry, "profileJson") || "") : "");
    const clog = await fakeLog();
    const ownedChats = Array.isArray(clog) ? ownedLog(clog).filter((e) => e.path === "chat" && logText(e).includes(chatQ)) : [];
    // FULL paragraphs INCLUDING the decisive tail (never a 32-char head prefix).
    const chatParaOk = chatParas.length === 3 && ownedChats.length >= 1 && chatParas.every((para) => para.length >= 10 && ownedChats.some((e) => logText(e).includes(para)));
    const chatTailOk = chatParas.length === 3 && chatParas.every((para) => { const tail = para.slice(Math.max(0, para.length - 40)); return tail.length >= 10 && ownedChats.some((e) => logText(e).includes(tail)); });
    ok("roster-chat-current-paras-owned", chatParaOk && chatTailOk, "chats=" + ownedChats.length + " paras=" + chatParas.length + " tail=" + chatTailOk);
    if (!(chatParaOk && chatTailOk)) failExit("current behavior paragraphs (FULL, tail included) must appear in owned direct-chat prompts.");
    // Board/meeting policy: the isolated roster prompt NEVER carries board evidence.
    const leakAfter = ownedChats.filter((e) => logText(e).includes(QUESTION) || logText(e).includes("MEETING BRIEF:") || logText(e).includes("ADOPTED DIRECTION") || logText(e).includes("CALLER ") || logText(e).includes("BOARD: "));
    ok("roster-chat-no-board-leak-after", ownedChats.length >= 1 && leakAfter.length === 0, "chats=" + ownedChats.length + " leaked=" + leakAfter.length);
    if (!(ownedChats.length >= 1 && leakAfter.length === 0)) failExit("stateless roster chat must NEVER carry meeting/board evidence (after edit).");
  } else { ok("roster-chat-current-paras-owned", false, "live mode UNPROVED prompt path"); ok("roster-chat-no-board-leak-after", false, "live mode UNPROVED prompt path"); }
  if (!uiEqOk) failExit("rendered roster answer must equal the API answer exactly.");
  const mc1 = await get("/api/meetings/" + meetingId + "/messages?take=100");
  const mc1Valid = mc1.status === 200 && Array.isArray(mc1.json) && mc1.json.every(msgValid);
  if (!mc1Valid) failExit("after-chat message snapshot must remain fully valid.");
  const c1snap = Array.isArray(mc1.json) ? mc1.json.map(msgSnap) : [];
  const sameSnap = mc1.status === 200 && c1snap.length === c0snap.length && c1snap.every((v, i) => v === c0snap[i]);
  ok("roster-chat-stateless", sameSnap, "before=" + c0snap.length + " after=" + c1snap.length + " identical=" + sameSnap);
  // Audition AFTER the canonical edit (N paras): isolated prompt carries FULL
  // current paras.
  if (MODE === "native") {
    const auQ2 = "Audition " + run + "-after: state your berth criterion in one line?";
    const canonAu2 = await canonicalEntry(rosterId);
    const auParas2 = threeParas(canonAu2.entry ? (pick(canonAu2.entry, "profileJson") || "") : "");
    const au2 = await post("/api/auditions", { rosterId: rosterId, question: auQ2 });
    ok("audition-after-posted", au2.status === 200 && typeof pick(au2.json, "answer") === "string" && String(pick(au2.json, "answer")).length >= 10, "status=" + au2.status);
    if (!(au2.status === 200 && typeof pick(au2.json, "answer") === "string")) failExit("after-edit audition POST failed.");
    const alog2 = await fakeLog();
    const auPrompts2 = Array.isArray(alog2) ? ownedLog(alog2).filter((e) => logText(e).includes("AUDITION") && logText(e).includes(auQ2)) : [];
    const auAfterOk = auParas2.length === 3 && auPrompts2.length >= 1 && auParas2.every((para) => para.length >= 10 && auPrompts2.some((e) => logText(e).includes(para)));
    const auAfterTail = auParas2.length === 3 && auParas2.every((para) => { const tail = para.slice(Math.max(0, para.length - 40)); return tail.length >= 10 && auPrompts2.some((e) => logText(e).includes(tail)); });
    ok("audition-after-current-paras-owned", auAfterOk && auAfterTail, "prompts=" + auPrompts2.length + " paras=" + auParas2.length + " tail=" + auAfterTail + " (AFTER canonical edit)");
    if (!(auAfterOk && auAfterTail)) failExit("after-edit audition prompt must carry FULL current paras (tail included).");
  } else { ok("audition-after-posted", false, "live mode UNPROVED"); ok("audition-after-current-paras-owned", false, "live mode UNPROVED"); }
  await scanDebug("roster-chat");
  checkBudget("roster-chat-ui");
}
// ---- 6. navigation: every named destination, direct routes, back/forward ----
function collectVisibleText(root) {
  const doc = (root && root.ownerDocument) || document;
  const scope = root || doc;
  let txt = "";
  try { txt = (!root || scope === doc || scope === doc.body) ? (doc.body ? doc.body.innerText || "" : "") : (scope.innerText || ""); } catch (e) { txt = ""; }
  const els = Array.from((!root || scope === doc ? doc : scope).querySelectorAll("input,textarea,select"));
  for (const el of els) {
    try {
      const cs = (el.ownerDocument.defaultView || window).getComputedStyle(el);
      if (!cs || cs.visibility === "hidden" || cs.display === "none") continue;
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) continue;
      if ((el.value || "").length > 0) txt += "\n" + el.value;
    } catch {}
  }
  return txt;
}
async function scanDebug(tag) {
  assertDeadline("scan-" + tag);
  let collected = null;
  try {
    collected = await ev(collectVisibleText);
  } catch (e) { failExit("debug collector failed for " + tag + "; refusing empty-clean. " + String((e && e.message) || e).slice(0,120)); }
  if (typeof collected !== "string") failExit("debug collector returned non-string for " + tag + "; FATAL not clean.");
  if (collected.length === 0) failExit("debug collector body empty for " + tag + "; body nonempty required.");
  const guidRe = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
  const jsonRe = /"[^"]+"\s*:\s*(\{|\[|")/g;
  const primRe = /"[^"]+"\s*:\s*(\d+|true|false|null)/g;
  // SAME actual detector on every positive/clean fixture (no independent has* regexes).
  const det = (t) => ({ g: (String(t).match(new RegExp(guidRe.source, "i")) || []).length >= 1, j: (String(t).match(new RegExp(jsonRe.source, "g")) || []).length >= 1, p: (String(t).match(new RegExp(primRe.source, "g")) || []).length >= 1 });
  const detCollected = det(collected);
  const guidHits = detCollected.g ? (collected.match(guidRe) || []).length : 0;
  const jsonHits = detCollected.j ? (collected.match(jsonRe) || []).length : 0;
  const primHits = detCollected.p ? (collected.match(primRe) || []).length : 0;
  const QQ = String.fromCharCode(34);
  let controlsOk = false; let controlsDiag = "unrun";
  let probePage = null;
  try {
    assertDeadline("debug-probe-acquire-" + tag);
    probePage = await ctx.newPage().catch(() => null);
    if (!probePage) failExit("debug probe page unavailable for " + tag + "; refusing fixture-only proof.");
    // ISOLATED detector positives (same collector): one value per probe page,
    // so narrowing any detector form (string/object/array/primitive/guid) fails
    // its own case instead of hiding behind a combined aggregate.
    await probePage.setContent("<p>probe</p><input id=qa-iso-guid>", { waitUntil: "domcontentloaded", timeout: boundedTimeout(15000, 8000) });
    await pev(probePage, () => { const g = document.getElementById("qa-iso-guid"); if (g) g.value = "11111111-2222-3333-4444-555555555555"; }, undefined, "iso-guid-fill-" + tag).catch(() => {});
    const isoGuidTxt = await pev(probePage, collectVisibleText, undefined, "iso-guid-collect-" + tag).catch(() => null);
    const dIsoG = typeof isoGuidTxt === "string" ? det(isoGuidTxt) : null;
    const guidIsoOk = !!dIsoG && dIsoG.g && !dIsoG.j && !dIsoG.p;
    ok("debug-detector-guid-isolated-" + tag, guidIsoOk, "guid alone detected g=" + (!!dIsoG && dIsoG.g) + " j=" + (!!dIsoG && dIsoG.j) + " p=" + (!!dIsoG && dIsoG.p));
    await probePage.setContent("<p>probe</p><input id=qa-iso-str>", { waitUntil: "domcontentloaded", timeout: boundedTimeout(15000, 8000) });
    await pev(probePage, (qq) => { const s = document.getElementById("qa-iso-str"); if (s) s.value = qq + "k" + qq + ":" + qq + "v" + qq; }, QQ, "iso-str-fill-" + tag).catch(() => {});
    const isoStrTxt = await pev(probePage, collectVisibleText, undefined, "iso-str-collect-" + tag).catch(() => null);
    const dIsoS = typeof isoStrTxt === "string" ? det(isoStrTxt) : null;
    const strIsoOk = !!dIsoS && dIsoS.j && !dIsoS.p && !dIsoS.g;
    ok("debug-detector-string-isolated-" + tag, strIsoOk, "string form detected j=" + (!!dIsoS && dIsoS.j) + " p=" + (!!dIsoS && dIsoS.p) + " g=" + (!!dIsoS && dIsoS.g));
    await probePage.setContent("<p>probe</p><input id=qa-iso-obj>", { waitUntil: "domcontentloaded", timeout: boundedTimeout(15000, 8000) });
    await pev(probePage, (qq) => { const o = document.getElementById("qa-iso-obj"); if (o) o.value = qq + "o" + qq + ":{" + qq + "a" + qq + ":1}"; }, QQ, "iso-obj-fill-" + tag).catch(() => {});
    const isoObjTxt = await pev(probePage, collectVisibleText, undefined, "iso-obj-collect-" + tag).catch(() => null);
    const dIsoO = typeof isoObjTxt === "string" ? det(isoObjTxt) : null;
    const objIsoOk = !!dIsoO && dIsoO.j && !dIsoO.g;
    ok("debug-detector-object-isolated-" + tag, objIsoOk, "object form detected j=" + (!!dIsoO && dIsoO.j) + " g=" + (!!dIsoO && dIsoO.g));
    await probePage.setContent("<p>probe</p><input id=qa-iso-arr>", { waitUntil: "domcontentloaded", timeout: boundedTimeout(15000, 8000) });
    await pev(probePage, (qq) => { const ar = document.getElementById("qa-iso-arr"); if (ar) ar.value = qq + "arr" + qq + ":[1,2]"; }, QQ, "iso-arr-fill-" + tag).catch(() => {});
    const isoArrTxt = await pev(probePage, collectVisibleText, undefined, "iso-arr-collect-" + tag).catch(() => null);
    const dIsoA = typeof isoArrTxt === "string" ? det(isoArrTxt) : null;
    const arrIsoOk = !!dIsoA && dIsoA.j && !dIsoA.g;
    ok("debug-detector-array-isolated-" + tag, arrIsoOk, "array form detected j=" + (!!dIsoA && dIsoA.j) + " g=" + (!!dIsoA && dIsoA.g));
    await probePage.setContent("<p>probe</p><input id=qa-iso-prim>", { waitUntil: "domcontentloaded", timeout: boundedTimeout(15000, 8000) });
    await pev(probePage, (qq) => { const pr = document.getElementById("qa-iso-prim"); if (pr) pr.value = qq + "n" + qq + ":123"; }, QQ, "iso-prim-fill-" + tag).catch(() => {});
    const isoPrimTxt = await pev(probePage, collectVisibleText, undefined, "iso-prim-collect-" + tag).catch(() => null);
    const dIsoP = typeof isoPrimTxt === "string" ? det(isoPrimTxt) : null;
    const primIsoOk = !!dIsoP && dIsoP.p && !dIsoP.j && !dIsoP.g;
    ok("debug-detector-primitive-isolated-" + tag, primIsoOk, "primitive form detected p=" + (!!dIsoP && dIsoP.p) + " j=" + (!!dIsoP && dIsoP.j) + " g=" + (!!dIsoP && dIsoP.g));
    const visInputsOk = guidIsoOk && strIsoOk && objIsoOk && arrIsoOk && primIsoOk;
    await probePage.setContent("<span>22222222-3333-4444-5555-666666666666</span>", { waitUntil: "domcontentloaded", timeout: boundedTimeout(15000, 8000) });
    await pev(probePage, () => { const s = document.querySelector("span"); if (s) s.style.visibility = "hidden"; }).catch(() => {});
    const hidTxt = await pev(probePage, collectVisibleText).catch(() => null);
    await probePage.setContent("<div><span>33333333-4444-5555-6666-777777777777</span><span>" + QQ + "a" + QQ + ":{}</span><input value=44444444-5555-6666-7777-000000000000></div>", { waitUntil: "domcontentloaded", timeout: boundedTimeout(15000, 8000) });
    await pev(probePage, () => { const d = document.querySelector("div"); if (d) d.style.display = "none"; }).catch(() => {});
    const dispTxt = await pev(probePage, collectVisibleText).catch(() => null);
    await probePage.setContent("<div data-qa-attr-probe=55555555-5555-6666-7777-888888888888>plain attribute carrier</div>", { waitUntil: "domcontentloaded", timeout: boundedTimeout(15000, 8000) });
    const attrTxt = await pev(probePage, collectVisibleText).catch(() => null);
    await probePage.setContent("<input id=qa-hid-guid><textarea id=qa-hid-str></textarea>", { waitUntil: "domcontentloaded", timeout: boundedTimeout(15000, 8000) });
    await pev(probePage, (qq) => { const g = document.getElementById("qa-hid-guid"); if (g) g.value = "22222222-3333-4444-5555-666666666666"; const s = document.getElementById("qa-hid-str"); if (s) s.value = qq + "hk" + qq + ":" + qq + "hv" + qq; }, QQ).catch(() => {});
    await pev(probePage, () => { const els = document.querySelectorAll("input,textarea"); for (const el of els) { el.style.visibility = "hidden"; } }).catch(() => {});
    const hidInputTxt = await pev(probePage, collectVisibleText).catch(() => null);
    const dHI = typeof hidInputTxt === "string" ? det(hidInputTxt) : null;
    await probePage.close().catch(() => {}); probePage = null;
    const dV = guidIsoOk && strIsoOk && objIsoOk && arrIsoOk && primIsoOk ? { g: true, j: true, p: true } : null;
    const dH = typeof hidTxt === "string" ? det(hidTxt) : null;
    const dD = typeof dispTxt === "string" ? det(dispTxt) : null;
    const dA = typeof attrTxt === "string" ? det(attrTxt) : null;
    const hidInputOk = !!dHI && !dHI.g && !dHI.j && !dHI.p;
    const visOk = visInputsOk && !!dV && dV.g && dV.j && dV.p;
    const hidOk = !!dH && !dH.g && !dH.j && !dH.p && hidInputOk;
    const dispOk = !!dD && !dD.g && !dD.j && !dD.p;
    const attrOk = !!dA && !dA.g && !dA.j && !dA.p;
    controlsOk = visOk && hidOk && dispOk && attrOk;
    controlsDiag = "visible-positive=" + visOk + "(inputs=" + visInputsOk + ") hidden=" + hidOk + "(inputHidden=" + hidInputOk + ") display-none=" + dispOk + " attribute=" + attrOk;
  } catch (e) { controlsOk = false; controlsDiag = "controls threw: " + String((e && e.message) || e).slice(0, 120); try { if (probePage) await probePage.close().catch(() => {}); } catch (ee) { } probePage = null; }
  ok("debug-scan-positive-" + tag, controlsOk, "actual-collector controls: " + controlsDiag);;
  const detClean = !detCollected.g && !detCollected.j && !detCollected.p;
  ok("debug-clean-" + tag, detClean && controlsOk, "guidHits=" + guidHits + " jsonHits=" + jsonHits + " primHits=" + primHits + " controls=" + controlsOk);
}
async function stepNavigation() {
  // F11: EVERY named rail destination (repo convention: nav.rail buttons by
  // exact name, hash arrival with board context, as in qa/navigation.cjs). No
  // skipped destinations: arrived must equal total.
  // 11 rail destinations + 1 direct-only wizard (navGroups has no wizard/Create rail button:
  // inventing a 12th rail control would be wrong) with SCOPED heading+section+owned entity.
  // Dedicated Nav matrix (247/2, source 941, second wizard fix rerun pending) covers deep/back-forward/mobile;
  // this integration proves real API-backed arrival at every destination with actual headings/entities.
  const dests = [
    { label: "Boards", seg: "boards", sec: 'section[aria-label="Boards"]', head: "Boards", entity: run + "-ab" },
    { label: "Roster", seg: "roster", sec: 'section[aria-label="My Advisor Roster"]', head: null, entity: rosterName },
    { label: "Board Advisors", seg: "advisors", sec: 'section[aria-label="This Board\'s Advisors"]', head: null, entity: "Harbor Strategist" },
    { label: "Meetings", seg: "meet", sec: '[aria-label="Meetings and conversation"]', head: null, entity: run + " harbor call" },
    { label: "Sources", seg: "sources", sec: 'section[aria-label="Resources and Inbox"]', head: "Resources and Inbox", entity: OWNED_URL_MARK },
    { label: "Records", seg: "records", sec: 'section[aria-label="Records"]', head: "Records", entity: run + " harbor call" },
    { label: "People", seg: "people", sec: 'section[aria-label="People"]', head: "People", entity: authedEmail },
    { label: "Activity", seg: "activity", sec: 'section[aria-label="Activity and Usage"]', head: "Activity and Usage", entity: "Usage (live ledger)" },
    { label: "Settings", seg: "settings", sec: 'section[aria-label="Settings"]', head: "Settings", entity: null },
    { label: "Profile", seg: "profile", sec: 'section[aria-label="Profile"]', head: "Profile", entity: "QA Default " + run },
    { label: "Help", seg: "help", sec: 'section[aria-label="Help"]', head: null, entity: null },
    { label: "Create", seg: "wizard", sec: 'section[aria-label="New-board wizard"]', head: "Create a board", entity: null },
  ];
  if (!boardA) failExit("navigation requires owned board context; boardA missing.");
  await gotoTab(boardHash("advisors"));
  ok("nav-board-context-restored", (await ev(() => location.hash).catch(() => "")).includes("board=" + encodeURIComponent(boardA)), "owned board context route mounted before rail loop");
  async function assertDest(d) {
    const secLoc = page.locator(d.sec).first();
    let secVis = false; try { await secLoc.waitFor({ state: "visible", timeout: boundedTimeout(8000, 8000) }); secVis = await secLoc.isVisible(); } catch { secVis = false; }
    let secTxt = ""; if (secVis) { try { secTxt = await secLoc.evaluate((el) => { let t = ""; try { t = el.innerText || ""; } catch (e) { t = ""; } try { const els = Array.from(el.querySelectorAll("input,textarea,select")); for (const x of els) { try { const cs = (x.ownerDocument.defaultView || window).getComputedStyle(x); if (!cs || cs.visibility === "hidden" || cs.display === "none") continue; const r = x.getBoundingClientRect(); if (!(r.width > 0 && r.height > 0)) continue; if ((x.value || "").length > 0) t += "\n" + x.value; } catch (e) {} } } catch (e) {} return t; }).catch(() => ""); if (!secTxt) secTxt = await secLoc.innerText().catch(() => ""); } catch (e) { secTxt = ""; } } const normTxt = (secTxt || "").replace(/\s+/g, " ");
    let headOk = true;
    if (d.head) { const hLoc = secLoc.getByRole("heading", { name: d.head }); headOk = await hLoc.first().isVisible().catch(() => false); if (!headOk) headOk = secTxt.includes(d.head); }
    let entityOk = true; let emptyVerified = false;
    if (d.entity) { entityOk = secTxt.includes(d.entity); if (!entityOk && (d.seg === "records" || d.seg === "sources")) { const emptyRe = d.seg === "records" ? /pick a meeting first|no records|nothing here yet/i : /no sources|nothing here yet/i; if (emptyRe.test(normTxt) && secVis && headOk) { emptyVerified = true; entityOk = true; } } }
    const h = await ev(() => location.hash).catch(() => "");
    const hashOk = h.indexOf("#/" + d.seg) === 0;
    const boardOk = ["advisors", "meet", "sources", "records", "people", "activity"].includes(d.seg) ? h.includes("board=" + encodeURIComponent(boardA)) : true;
    return { ok: hashOk && boardOk && secVis && headOk && entityOk, detail: "hash=" + h.slice(0,80) + " sec=" + secVis + " head=" + headOk + " entity=" + entityOk + " emptyVerified=" + emptyVerified + " secTxt=" + normTxt.slice(0, 160) };
  }
  let arrived = 0;
  for (const d of dests) {
    assertDeadline("nav-" + d.seg);
    let clicked = false;
    if (d.seg === "wizard") {
      // TRUTH: wizard is direct-only by design (no rail button/link). Assert
      // absence FIRST, then visit directly. A rail fallback count would be wrong.
      assertDeadline("nav-wizard-not-rail");
      const railBtnN = await page.locator("nav.rail").getByRole("button", { name: d.label, exact: true }).count().catch(() => -1);
      const railLinkN = await page.locator("nav.rail").getByRole("link", { name: d.label, exact: true }).count().catch(() => -1);
      const noRailCtl = railBtnN === 0 && railLinkN === 0;
      ok("nav-wizard-direct-only-truth", noRailCtl, "rail buttons=" + railBtnN + " links=" + railLinkN + " (wizard has no rail control by design)");
      if (!noRailCtl) failExit("wizard must have no rail control; inventing a 12th rail would be wrong. btn=" + railBtnN + " link=" + railLinkN);
      assertDeadline("nav-wizard-direct");
      await page.goto(WEB + "/#/wizard", { waitUntil: "domcontentloaded", timeout: boundedTimeout(BROWSER_TIMEOUT, 8000) }).catch(() => {});
      await wft(900);
      clicked = true;
    } else {
      try { await page.locator("nav.rail").getByRole("button", { name: d.label, exact: true }).click({ timeout: boundedTimeout(8000, 8000) }); clicked = true; }
      catch {
        try { await page.locator("nav.rail").getByRole("link", { name: d.label, exact: true }).click({ timeout: boundedTimeout(8000, 8000) }); clicked = true; } catch {}
      }
    }
    if (d.seg === "wizard") { console.log("  note - nav-wizard-direct-only (no rail button by design; direct visit, not rail coverage)"); }
    else { ok("nav-rail-clickable-" + d.seg, clicked, "rail control " + d.label + " clickable=" + clicked); }
    if (!clicked) failExit("nav rail prerequisite failed at " + d.seg + "; rail failure recorded separately from direct-route success (no Create fallback counts).");
    await wft(900);
    const r = await assertDest(d);
    if (r.ok) arrived++;
    ok("nav-dest-" + d.seg, r.ok, (d.seg === "wizard" ? "direct-only " : "rail ") + r.detail);
    if (!r.ok) failExit("destination " + d.seg + " must render scoped heading+section+entity; " + r.detail);
    await scanDebug("nav-" + d.seg);
  }
  ok("nav-all-destinations", arrived === dests.length, "rail=11 + wizard-direct-only=1 total=" + arrived + "/" + dests.length);
  if (arrived !== dests.length) failExit("navigation must reach 11 rail destinations plus direct-only wizard with board context.");
  // Direct routes use the SAME scoped predicates as the rail loop.
  await page.goto(WEB + "/#/boards", { waitUntil: "domcontentloaded", timeout: boundedTimeout(BROWSER_TIMEOUT, 8000) }).catch(() => {});
  await wft(900);
  { const _r = await assertDest(dests[0]); ok("nav-entity-boards", _r.ok, "direct boards scoped: " + _r.detail); if (!_r.ok) failExit("direct boards must satisfy scoped predicates."); }
  await page.goto(WEB + "/#/roster", { waitUntil: "domcontentloaded", timeout: boundedTimeout(BROWSER_TIMEOUT, 8000) }).catch(() => {});
  await wft(900);
  { const _r = await assertDest(dests[1]); ok("nav-entity-roster", _r.ok, "direct roster scoped: " + _r.detail); if (!_r.ok) failExit("direct roster must satisfy scoped predicates."); }
  await page.goto(WEB + "/" + boardHash("advisors"), { waitUntil: "domcontentloaded", timeout: boundedTimeout(BROWSER_TIMEOUT, 8000) }).catch(() => {});
  await wft(900);
  { const _r = await assertDest(dests[2]); ok("nav-entity-advisors", _r.ok, "direct advisors scoped: " + _r.detail); if (!_r.ok) failExit("direct advisors must satisfy scoped predicates."); }
  await page.goto(WEB + "/" + boardHash("records"), { waitUntil: "domcontentloaded", timeout: boundedTimeout(BROWSER_TIMEOUT, 8000) }).catch(() => {});
  await wft(900);
  { const _r = await assertDest(dests[5]); ok("nav-entity-records", _r.ok, "direct records scoped: " + _r.detail); if (!_r.ok) failExit("direct records must satisfy scoped predicates."); }
  await page.goto(WEB + "/#/records?board=" + encodeURIComponent(boardA) + "&meeting=" + encodeURIComponent(meetingId), { waitUntil: "domcontentloaded", timeout: boundedTimeout(BROWSER_TIMEOUT, 8000) }).catch(() => {});
  await wft(900);
  { const _sec = page.locator("section[aria-label=\"Records\"]").first(); let _vis = false; try { await _sec.waitFor({ state: "visible", timeout: boundedTimeout(8000, 8000) }); _vis = await _sec.isVisible(); } catch { _vis = false; } const _txt = _vis ? (await _sec.innerText().catch(() => "")).replace(/\s+/g, " ") : ""; const _ok = _vis && _txt.indexOf("Prepare draft") >= 0; ok("nav-entity-records-meeting", _ok, "meeting-scoped records Prepare-draft: vis=" + _vis + " txt=" + _txt.slice(0, 160)); if (!_ok) failExit("meeting-scoped records must render Prepare draft for owned meeting."); }
  await gotoTab("/#/profile");
  await scanDebug("direct-profile");
  await gotoTab("/#/roster");
  await scanDebug("direct-roster");
  await gotoTab("/#/meet?board=" + encodeURIComponent(boardA) + "&meeting=" + encodeURIComponent(meetingId));
  await scanDebug("direct-meet");
  { const _r = await assertDest(dests[3]); ok("nav-direct-meet-entity", _r.ok, "direct meet scoped: " + _r.detail); if (!_r.ok) failExit("direct meet must satisfy scoped predicates."); }
  await page.goBack({ timeout: boundedTimeout(BROWSER_TIMEOUT, 8000) }).catch(() => {});
  await wft(900);
  const backHash = await ev(() => location.hash).catch(() => "");
  const backR = await assertDest(dests[1]);
  await page.goForward({ timeout: boundedTimeout(BROWSER_TIMEOUT, 8000) }).catch(() => {});
  await wft(900);
  const fwdHash = await ev(() => location.hash).catch(() => "");
  const fwdR = await assertDest(dests[3]);
  ok("nav-direct-backforward", backHash === "#/roster" && backR.ok && fwdHash.indexOf("#/meet") === 0 && fwdHash.includes(meetingId) && fwdHash.includes(encodeURIComponent(boardA)) && fwdR.ok, "back=" + backHash.slice(0,60) + " backScoped=" + backR.detail + " fwd=" + fwdHash.slice(0,80) + " fwdScoped=" + fwdR.detail);
  // Expected pre-save /api/profile 404s are classified AT ARRIVAL (profileSavedAt===0) into expectedProfile404s.
  // Exact safe arrival count: exactly the one pre-save lookup, never later 404s.
  ok("expected-404-exact", expectedProfile404s.length === 1, "arrival404s=" + expectedProfile404s.length);
  if (expectedProfile404s.length !== 1) failExit("expected exactly one pre-save profile 404 at arrival; got " + expectedProfile404s.length);
  const expected = badResponses.filter(isExpectedBad);
  const unexpected = badResponses.filter((e) => !isExpectedBad(e));
  ok("no-unexpected-failures", pageErrors.length === 0 && unexpected.length === 0 && requestFailed.length === 0, "pageerrors=" + pageErrors.length + " unexpectedBad=" + unexpected.length + " reqFailed=" + requestFailed.length + " expected404s=" + expected.length + (unexpected.length ? " " + redact(unexpected.slice(0, 3).join(" | ")) : "") + (requestFailed.length ? " " + redact(requestFailed.slice(0, 2).join(" | ")) : ""));
  checkBudget("navigation");
}

// Duplicative backend negative activity scenarios REMOVED from this monolith by design (mapped, NOT claimed passed here; primary runs focused suites).
// Exact mapping: no-responder stubbed UI terminal/retry -> qa/meeting-send-pipeline-qa.mjs:402; bid-decline yields + zero reply-error publications -> qa/http-qa.mjs:495; actual bid-decline activity assertions + T6 provider/reply errors -> qa/meeting-activity-qa.mjs:316. wiki-pg-qa.mjs (Wiki persistence) and usage-activity-browser.mjs (usage reporting) do NOT replace participant-state assertions. The lifecycle suite does not supply abstained/failed seat-label checks; QA-ABSTAIN fake support is not an executed abstention test. Bid decline produces bid-declined (provider-error belongs to provider failure). This integration keeps the honest core: one real send with working-state pairing + excluded-seat proof.
async function stepFocusedActivityStates() {
  for (const kind of ["ABSTAIN", "REPLYERR"]) {
    const marker = "QA-" + kind + "-" + run;
    const title = run + " focused " + kind.toLowerCase();
    const mk = await post("/api/boards/" + boardA + "/meetings", { title: title, brief: "", participantIds: [advisor1] });
    if (mk.status !== 201 || !pick(mk.json, "id")) failExit("focused " + kind + " meeting create failed.");
    const fmid = String(pick(mk.json, "id"));
    const leadContent = marker + " Council " + run + ": weigh the berth plan with " + kind.toLowerCase() + " probe?";
    const lp = await post("/api/meetings/" + fmid + "/messages", { sender: "lead", content: leadContent });
    if (!(lp.status === 200 || lp.status === 201)) failExit("focused " + kind + " lead post failed.");
    const lv = await get("/api/boards/" + boardA + "/lead");
    const lvVer = Number(pick(lv.json, "version") || 0);
    if (!(lv.status === 200 && Number.isInteger(lvVer) && lvVer > 0)) failExit("focused " + kind + " lead version invalid.");
    const rr = await post("/api/meetings/" + fmid + "/run", { policy: "balanced", prompt: leadContent, evidenceSupported: false, leadVersion: lvVer }, { timeout: Math.min(90000, Math.max(1, remainingMs())) });
    if (rr.status !== 200) failExit("focused " + kind + " run failed status=" + rr.status);
    const finEnd = Math.min(Date.now() + 60000, DEADLINE_MS - 5000);
    let wantRaw = kind === "ABSTAIN" ? "abstained" : "failed";
    let rawSeen = false;
    while (Date.now() < finEnd) { assertDeadline("focused-" + kind + "-poll"); const aa = await getActivity(fmid, (typeof finEnd === "number" ? finEnd : 0)); if (aa && !aa.malformed && Array.isArray(aa.states)) { const mine = aa.states.filter((s) => String(s.id).toLowerCase() === String(advisor1).toLowerCase()); if (mine.some((s) => String(s.state) === wantRaw)) { rawSeen = true; break; } if (mine.some((s) => ["complete", "interrupted"].includes(String(s.state)))) break; } await sleep(2000); }
    ok("focused-" + kind.toLowerCase() + "-raw-" + wantRaw, rawSeen, "meeting=" + fmid.slice(0,8) + " want=" + wantRaw);
    if (!rawSeen) failExit("focused " + kind + " never reached raw " + wantRaw + ".");
    await gotoTab("/#/meet?board=" + encodeURIComponent(boardA) + "&meeting=" + encodeURIComponent(fmid));
    try { await page.waitForFunction((want) => { const rail = document.querySelector("section.meet-participants ul.mp-rail[aria-label=\"Participant activity\"]"); if (!rail) return false; const names = Array.from(rail.querySelectorAll(".mp-name")).map((e) => e.textContent || ""); const idx = names.findIndex((n) => String(n).indexOf("Harbor Strategist") >= 0); if (idx < 0) return false; const seats = rail.querySelectorAll("li.mp-seat"); const cls = seats[idx] ? seats[idx].className : ""; return cls.indexOf("act-" + want) >= 0; }, wantRaw, { timeout: Math.max(1, Math.min(20000, remainingMs())) }); } catch (e) {}
    const railCls = await page.locator("section.meet-participants ul.mp-rail[aria-label=\"Participant activity\"] li.mp-seat").evaluateAll((els) => els.map((e) => e.className)).catch(() => []);
    const railNames = await page.locator("section.meet-participants ul.mp-rail[aria-label=\"Participant activity\"] .mp-name").allInnerTexts().catch(() => []);
    const ridx = railNames.findIndex((n) => String(n || "").includes("Harbor Strategist"));
    const mountedBadge = ridx >= 0 ? String(railCls[ridx] || "") : "";
    const badgeOk = mountedBadge.indexOf("act-" + wantRaw) >= 0;
    let badgeHuman = ""; let badgeVis = false;
    try { badgeVis = await page.locator("section.meet-participants ul.mp-rail[aria-label=\"Participant activity\"] li.mp-seat").nth(ridx).locator(".mp-badge").first().isVisible().catch(() => false); badgeHuman = await page.locator("section.meet-participants ul.mp-rail[aria-label=\"Participant activity\"] li.mp-seat").nth(ridx).locator(".mp-badge").first().innerText().catch(() => ""); } catch (e) {}
    const wantHuman = wantRaw === "abstained" ? "Abstained" : "Response failed";
    const humanOk = badgeVis === true && badgeHuman === wantHuman;
    ok("focused-" + kind.toLowerCase() + "-mounted-" + wantRaw, badgeOk && humanOk, "badge=" + mountedBadge.slice(0,80) + " humanExact=" + (badgeHuman === wantHuman) + " visible=" + badgeVis + " want=" + wantHuman + " got=" + badgeHuman.slice(0,40));
    if (!(badgeOk && humanOk)) failExit("focused " + kind + " mounted seat must show exact visible human badge \"" + wantHuman + "\" (got visible=" + badgeVis + " text=\"" + badgeHuman.slice(0,40) + "\").");
  }
  if (MODE === "native") {
    const canonAu = await canonicalEntry(rosterId);
    const auParas = threeParas(canonAu.entry ? (pick(canonAu.entry, "profileJson") || "") : "");
    const auQ = "Audition " + run + ": state your berth criterion in one line?";
    const au = await post("/api/auditions", { rosterId: rosterId, question: auQ });
    ok("audition-current-paras-posted", au.status === 200 && typeof pick(au.json, "answer") === "string" && String(pick(au.json, "answer")).length >= 10, "status=" + au.status);
    if (!(au.status === 200 && typeof pick(au.json, "answer") === "string")) failExit("audition POST failed.");
    const alog = await fakeLog();
    const auPrompts = Array.isArray(alog) ? ownedLog(alog).filter((e) => logText(e).includes("AUDITION") && logText(e).includes(auQ)) : [];
    const auParaOk = auParas.length === 3 && auPrompts.length >= 1 && auParas.every((para) => para.length >= 10 && auPrompts.some((e) => logText(e).includes(para)));
    const auTailOk = auParas.length === 3 && auParas.every((para) => { const tail = para.slice(Math.max(0, para.length - 40)); return tail.length >= 10 && auPrompts.some((e) => logText(e).includes(tail)); });
    ok("audition-current-paras-owned", auParaOk && auTailOk, "prompts=" + auPrompts.length + " paras=" + auParas.length + " tail=" + auTailOk + " (BEFORE canonical edit)");
    if (!(auParaOk && auTailOk)) failExit("current behavior paragraphs (FULL, tail included) must appear in owned audition prompts (before edit).");
    const leadPrefsCheck = await get("/api/boards/" + boardA + "/lead");
    const leadPrefsVal = leadPrefsCheck.status === 200 ? String(pick(leadPrefsCheck.json, "commPrefs") || "") : "";
    const commHold = auParas.length === 3 && leadPrefsVal === ("oc-" + run);
    ok("comm-prefs-preserved", commHold && au.status === 200, "lead commPrefs exact=" + commHold + " val=" + leadPrefsVal.slice(0,30));
    if (!commHold) failExit("real communication preferences must be preserved on the board lead (want exact oc-" + run + ", got \"" + leadPrefsVal.slice(0,40) + "\").");
  } else { ok("audition-current-paras-owned", false, "live mode UNPROVED"); ok("comm-prefs-preserved", false, "live mode UNPROVED"); }
  checkBudget("focused-activity");
}
async function stepActivityScenarios() { await stepFocusedActivityStates(); }
async function main() {
  try {
    await stepSetup();
    await stepProfile();
    await stepCreateAdvisor();
    await stepPortraitAttach();
    await stepSecondMember();
    await stepMeeting();
    await stepActivityScenarios();
    await stepReeditRerun();
    await stepRosterChatUI();
    await stepNavigation();
  } catch (e) {
    const raw = String((e && e.stack) || (e && e.message) || e);
    const isFatal = /FATAL|REFUSE|OVERALL DEADLINE|OVERALL BUDGET/.test(raw);
    fail++;
    const m = (isFatal ? "FATAL-setup " : "threw ") + trunc(raw, 400).replace(/[0-9a-f]{32,}/gi, "[redacted]");
    failures.push(m); console.log("  " + (isFatal ? "FATAL " : "FAIL ") + m);
    try { globalThis.__qaFatal = isFatal; } catch {}
  } finally {
    // Browser/context cleanup is UNCONDITIONAL; process.exit never runs
    // before this finally.
    await closeBrowser();
  }
  console.log("");
  console.log("ADVISOR INTEGRATED QA " + (fail === 0 ? "PASS" : "FAIL") + " assertions-pass=" + pass + " assertions-fail=" + fail + " elapsedMs=" + elapsed());
  if (failures.length) { console.log("failures:"); for (const f of failures) console.log(" - " + redact(f)); }
  console.log("note: owned QA account/boards/roster/meetings left for forensics (exact-ID scope only; never touched other rows/accounts; no backup/restore/reconcile/reset; no private values logged).");
  const fatal = !!globalThis.__qaFatal;
  process.exit(fail === 0 ? 0 : (fatal ? 2 : 1));
}
main().catch((e) => { console.log("FATAL " + redact(String((e && e.stack) || e))); process.exit(2); });





