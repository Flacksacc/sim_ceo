// qa/meeting-send-stack-smoke.mjs - REAL-STACK board Send smoke (Muse-authored).
// Proves compiled Send UI -> REAL messages POST -> REAL optional brief PATCH ->
// REAL run -> actual nonempty advisor reply on an owned isolated stack.
// No App/server/ops-config changes. No stubbed /api routes. Existing stub86 stays distinct.
// ALLOW_LIST: only http://127.0.0.1:15180 or :15181 loopback. Refuses 5173/5080,
// any non-allowlist host, and credentials-in-URL. Server holds the model key;
// this script never reads env keys, private config, or Docker, and never calls
// models directly. Token stays in memory and is never logged.
// Own data only: random QA account/board/lead/meeting/advisor with neutral
// fictional fixture portrait; never alters existing boards/rosters/accounts.
// Run (primary provides owned compiled stack URL; primary executes):
//   ALLOW_LIVE_PROVIDER=1 QA_WEB=http://127.0.0.1:15180 node qa/meeting-send-stack-smoke.mjs
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
const here = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = path.join(here, "..", ".tmp");
const QA_WEB = (process.env.QA_WEB || "").trim();
const LIVE = process.env.ALLOW_LIVE_PROVIDER === "1";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const COMPOSER_LABEL = "Message. Press Enter to send, Shift and Enter for a new line.";
const REQ_TIMEOUT = 30000;
const RESEARCH_TIMEOUT = 185000;
const RUN_TIMEOUT = 150000;
const BROWSER_TIMEOUT = 30000;
const OVERALL_BUDGET_MS = 420000;
const startedAt = Date.now();
let pass = 0; let fail = 0; const failures = [];
function outPath() { try { return path.join(tmpDir, "meeting-send-stack-smoke-result.txt"); } catch { return ""; } }
function outLine(s) { try { fs.mkdirSync(tmpDir, { recursive: true }); fs.appendFileSync(outPath(), s + "\n"); } catch {} }
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok - " + name); outLine("PASS " + name); }
  else { fail++; console.log("  FAIL - " + name + (extra ? " :: " + extra : "")); outLine("FAIL " + name + (extra ? " :: " + extra : "")); failures.push(name + (extra ? " :: " + extra : "")); }
}
function trunc(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n) : s; }
function redact(s) { return trunc(s, 220).replace(/[0-9a-f]{32,}/gi, "[redacted]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]"); }
function failExit(msg) { console.log("FATAL " + msg); try { outLine("FATAL " + msg); } catch {} process.exit(2); }
try { fs.mkdirSync(tmpDir, { recursive: true }); fs.writeFileSync(outPath(), "START " + new Date().toISOString() + " qa-web-present=" + (QA_WEB ? "yes" : "no") + "\n"); } catch {}
if (!LIVE) failExit("REFUSE: set ALLOW_LIVE_PROVIDER=1 to execute the bounded live Send smoke.");
if (!QA_WEB) failExit("REFUSE: QA_WEB is required (primary-provided owned isolated compiled stack URL).");
if (/[^\s:@\/]*:[^\s:@\/]*@/.test(QA_WEB)) failExit("REFUSE: credentials-in-URL are never accepted.");
let webUrl = null;
try { webUrl = new URL(QA_WEB); } catch { failExit("REFUSE: QA_WEB is not a valid URL."); }
if (webUrl.protocol !== "http:") failExit("REFUSE: QA_WEB must be plain http loopback.");
if (webUrl.hostname !== "127.0.0.1") failExit("REFUSE: QA_WEB must be 127.0.0.1 loopback.");
if (webUrl.port !== "15180" && webUrl.port !== "15181") failExit("REFUSE: QA_WEB port must be 15180 or 15181.");
if (webUrl.username || webUrl.password) failExit("REFUSE: credentials-in-URL are never accepted.");
const WEB = webUrl.origin;
for (const bad of [":5173", ":5080"]) { if (WEB.includes(bad)) failExit("REFUSE port " + bad + ": never use human/dev ports."); }
const run = "qa-send-" + Date.now().toString(36) + "-" + crypto.randomBytes(3).toString("hex");
const email = run + "@example.test";
const password = "Qa-" + crypto.randomBytes(9).toString("hex") + "-x9";
let token = "";
let authedEmail = "";
async function req(method, p, body, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeout || REQ_TIMEOUT);
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
function pick(o, ...keys) {
  if (!o || typeof o !== "object") return undefined;
  for (const k of keys) { if (k in o) return o[k]; const lo = String(k).toLowerCase(); for (const key of Object.keys(o)) if (key.toLowerCase() === lo) return o[key]; }
  return undefined;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const elapsed = () => Date.now() - startedAt;
function checkBudget(name) { ok(name + "-within-budget", elapsed() < OVERALL_BUDGET_MS, elapsed() + "ms"); }
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
async function uploadPortrait(rosterId) {
  const form = new FormData();
  form.append("file", new Blob([PNG], { type: "image/png" }), "qa-smoke.png");
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), REQ_TIMEOUT);
  try {
    const r = await fetch(WEB + "/api/roster/" + rosterId + "/image/upload", { method: "POST", signal: ctl.signal, headers: token ? { "authorization": "Bearer " + token } : {}, body: form });
    const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    return { status: r.status, json, text };
  } catch (e) { return { status: 0, json: null, text: "transport-failure" }; }
  finally { clearTimeout(t); }
}
let boardId = ""; let meetingId = ""; let advisorId = ""; let rosterId = "";
const QUESTION = "Smoke " + run + ": when staffing is tight, how do you weigh a dense low-risk option against a sparse high-risk one?";
async function apiSetup() {
  console.log("setup: register own QA account (token in memory, never logged)");
  const reg = await post("/api/auth/register", { email, password });
  ok("setup-register-201", reg.status === 201 && pick(reg.json, "token"), "status=" + reg.status + " " + redact(reg.text));
  if (reg.status !== 201) failExit("setup register failed status=" + reg.status + " " + redact(reg.text));
  token = String(pick(reg.json, "token") || ""); authedEmail = String(pick(reg.json, "email") || email);
  ok("setup-token-held", token.length >= 16, "len=" + token.length);
  const me = await get("/api/auth/me");
  ok("setup-me-authenticated", me.status === 200 && pick(me.json, "authenticated") === true, "status=" + me.status + " " + redact(me.text));
  console.log("setup: own board + default lead profile");
  const b = await post("/api/boards", { name: run + "-send-board", mission: "QA send-smoke board for " + run, stage: "qa" });
  ok("setup-board-201", b.status === 201 && pick(b.json, "id"), "status=" + b.status + " " + redact(b.text));
  if (!pick(b.json, "id")) failExit("board create failed " + redact(b.text));
  boardId = String(pick(b.json, "id"));
  const lead = await post("/api/boards/" + boardId + "/lead", { name: "QA Lead", roleLabel: "Board Lead", background: "QA fixture background", familiarTopics: "general reasoning", simplerTopics: "simple tradeoffs", commPrefs: "Be clear and direct." });
  ok("setup-lead-200", lead.status === 200, "status=" + lead.status + " " + redact(lead.text));
  checkBudget("setup-board-lead");
}
async function apiAdvisor() {
  console.log("setup: own fictional advisor (quick + bounded research, neutral fixture portrait)");
  const qf = await post("/api/roster/quick", { accountId: crypto.randomUUID(), name: run + "-hopper-strategist", description: "Fictional technical decision advisor inspired by Grace Hopper systems thinking for weighing engineering tradeoffs for " + run });
  ok("setup-quick-201", qf.status === 201 && pick(qf.json, "id"), "status=" + qf.status + " " + redact(qf.text));
  if (!pick(qf.json, "id")) failExit("roster quick failed " + redact(qf.text));
  rosterId = String(pick(qf.json, "id"));
  console.log("research: bounded live research (185s transport timeout; production deadline unchanged, honest fail on provider/unsupported)");
  let res;
  const researchHeartbeat = setInterval(() => console.log("research: still pending..."), 20000);
  try {
    res = await post("/api/roster/" + rosterId + "/research", { focus: "Grace Hopper-inspired technical decision making: compiler and systems tradeoffs, risk surfacing, and limits for a fictional advisor" }, { timeout: RESEARCH_TIMEOUT });
  } finally {
    clearInterval(researchHeartbeat);
  }
  if (res.status === 402 || res.status === 502 || res.status === 503) failExit("research provider unavailable status=" + res.status + " (honest fail; not forcing approval)");
  ok("setup-research-200", res.status === 200, "status=" + res.status);
  if (res.status !== 200) failExit("research failed status=" + res.status);
  const supported = pick(res.json, "supported");
  const claims = pick(res.json, "claims") || [];
  ok("setup-research-supported", supported === true && Array.isArray(claims) && claims.length > 0, "supported=" + JSON.stringify(supported) + " claims=" + (Array.isArray(claims) ? claims.length : typeof claims));
  if (!(supported === true)) failExit("research unsupported; refusing to force-approve.");
  const up = await uploadPortrait(rosterId);
  ok("setup-portrait-upload-201", up.status === 201, "status=" + up.status + " " + redact(up.text));
  const imgs = await get("/api/roster/" + rosterId + "/images");
  const imgId = Array.isArray(imgs.json) && imgs.json.length > 0 ? String(pick(imgs.json[0], "id") || "") : "";
  ok("setup-image-listed", !!imgId, redact(imgs.text));
  if (imgId) {
    const rev = await post("/api/images/" + imgId + "/review", { decision: "accept" });
    ok("setup-portrait-accept-200", rev.status === 200, "status=" + rev.status + " " + redact(rev.text));
  } else { ok("setup-portrait-accept-200", false, "no image id"); }
  const cp = await post("/api/roster/" + rosterId + "/copy", { boardId, boardRole: "Systems Strategist" });
  ok("setup-copy-201", cp.status === 201 && pick(cp.json, "id"), "status=" + cp.status + " " + redact(cp.text));
  if (!pick(cp.json, "id")) failExit("roster copy failed " + redact(cp.text));
  advisorId = String(pick(cp.json, "id"));
  const ap = await post("/api/boards/" + boardId + "/advisors/" + advisorId + "/approve", {});
  ok("setup-approve-200", ap.status === 200, "status=" + ap.status + " " + redact(ap.text));
  checkBudget("setup-advisor");
}
async function apiMeeting() {
  console.log("setup: own meeting with EMPTY brief (proves auto-PATCH contribute gate)");
  const m = await post("/api/boards/" + boardId + "/meetings", { title: run + " send smoke", brief: "", participantIds: [advisorId] });
  ok("setup-meeting-201", m.status === 201 && pick(m.json, "id"), "status=" + m.status + " " + redact(m.text));
  if (!pick(m.json, "id")) failExit("meeting create failed " + redact(m.text));
  meetingId = String(pick(m.json, "id"));
  const det = await get("/api/boards/" + boardId + "/meetings/" + meetingId);
  const brief0 = det.json ? String(pick(det.json, "brief") || "") : "?";
  ok("setup-brief-empty", det.status === 200 && brief0 === "", "status=" + det.status + " brief=" + JSON.stringify(brief0).slice(0, 80));
  checkBudget("setup-meeting");
}
async function browserSend() {
  console.log("browser: owned headless Edge only (no CDP/shared), no /api stubs");
  let browser = null; let ctx = null; let page = null;
  const counts = { messages: [], patch: [], run: [] };
  const stamps = { sendStart: 0, progressAt: 0, terminalAt: 0 };
  let progressSeen = ""; let terminalSeen = "";
  try {
    browser = await chromium.launch({ executablePath: EDGE, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript(({ tok, usr }) => { try { if (tok) localStorage.setItem("simceo-token", tok); if (usr) localStorage.setItem("simceo-user", usr); } catch {} }, { tok: token, usr: authedEmail });
    page = await ctx.newPage();
    page.on("request", (r) => { try { const u = new URL(r.url()); if (u.origin !== WEB) return; const p = u.pathname; const m = r.method(); const t = Date.now(); if (m === "POST" && /\/api\/meetings\/[^/]+\/messages$/.test(p)) counts.messages.push({ t, s: 0 }); if (m === "PATCH" && /\/api\/meetings\/[^/]+$/.test(p)) counts.patch.push({ t, s: 0 }); if (m === "POST" && /\/api\/meetings\/[^/]+\/run$/.test(p)) counts.run.push({ t, s: 0 }); } catch {} });
    page.on("response", (r) => { try { const u = new URL(r.url()); if (u.origin !== WEB) return; const p = u.pathname; if (r.status() >= 400) console.log("HTTP" + r.status() + " " + p.slice(0, 120)); } catch {} });
    page.on("pageerror", (e) => { try { console.log("pageerror " + String((e && e.message) || e).slice(0, 160)); } catch {} });
    const target = WEB + "/#/meet?board=" + encodeURIComponent(boardId) + "&meeting=" + encodeURIComponent(meetingId);
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: BROWSER_TIMEOUT });
    await page.waitForSelector("textarea[aria-label=\"" + COMPOSER_LABEL + "\"]", { timeout: BROWSER_TIMEOUT });
    console.log("browser: composer ready; sending one short generic question");
    const box = page.locator(".composer-bar textarea").first();
    const sendBtn = page.locator(".composer-bar button.primary").first();
    await box.fill(QUESTION);
    stamps.sendStart = Date.now();
    await box.press("Enter");
    try { await page.waitForFunction((t) => document.body.innerText.indexOf(t) >= 0, "Sending message...", { timeout: 8000 }); progressSeen = "sending"; } catch {}
    if (!progressSeen) {
      try { await page.waitForFunction((t) => document.body.innerText.indexOf(t) >= 0, "Requesting advisor responses...", { timeout: BROWSER_TIMEOUT }); progressSeen = "working"; } catch (e) { ok("browser-progress-visible", false, "no sending/working status"); }
    }
    if (progressSeen) { stamps.progressAt = Date.now(); ok("browser-progress-visible", true, progressSeen + " after " + (stamps.progressAt - stamps.sendStart) + "ms"); }
    try { await page.waitForFunction((t) => document.body.innerText.indexOf(t) >= 0, "Responses complete.", { timeout: RUN_TIMEOUT }); terminalSeen = "complete"; stamps.terminalAt = Date.now(); } catch (e) { ok("browser-terminal-complete", false, "no Responses complete. within " + RUN_TIMEOUT + "ms"); }
    if (terminalSeen) ok("browser-terminal-complete", true, "after " + (stamps.terminalAt - stamps.sendStart) + "ms");
    try { const shot = path.join(tmpDir, run + "-send-smoke.png"); await page.screenshot({ path: shot }); ok("browser-screenshot", true, shot); } catch (e) { ok("browser-screenshot", false, "screenshot failed"); }
    const bodyText = await page.evaluate(() => document.body.innerText);
    ok("browser-no-blind-resend", bodyText.indexOf("Could not confirm") < 0 || bodyText.indexOf("Responses complete.") >= 0, trunc(bodyText, 200));
    return { counts, stamps, progressSeen, terminalSeen };
  } finally {
    try { if (page) await page.close(); } catch {}
    try { if (ctx) await ctx.close(); } catch {}
    try { if (browser) await browser.close(); } catch {}
  }
}
async function verify(counts) {
  console.log("verify: actual GET messages + exact single lead/run, terminal last");
  const nMsg = counts.messages.length; const nPatch = counts.patch.length; const nRun = counts.run.length;
  ok("verify-lead-once", nMsg === 1, "messages=" + nMsg);
  ok("verify-autopatch-once", nPatch === 1, "patch=" + nPatch);
  ok("verify-run-once", nRun === 1, "run=" + nRun);
  const msgs = await get("/api/meetings/" + meetingId + "/messages?take=100");
  ok("verify-messages-200", msgs.status === 200 && Array.isArray(msgs.json), "status=" + msgs.status + " " + redact(msgs.text));
  const list = Array.isArray(msgs.json) ? msgs.json : [];
  const leads = list.filter((m) => String(pick(m, "sender") || "").toLowerCase() === "lead" && String(pick(m, "content") || pick(m, "body") || "").indexOf(QUESTION.slice(0, 24)) >= 0);
  ok("verify-lead-text-once", leads.length === 1, "matching-leads=" + leads.length + " total=" + list.length);
  const adv = list.filter((m) => { const a = String(pick(m, "advisorId") || ""); const s = String(pick(m, "sender") || "").toLowerCase(); return (a && a !== "00000000-0000-0000-0000-000000000000") || s === "advisor"; });
  const nonempty = adv.filter((m) => String(pick(m, "content") || pick(m, "body") || "").trim().length >= 20);
  ok("verify-advisor-reply", nonempty.length >= 1, "advisor-nonempty=" + nonempty.length + " advisor-total=" + adv.length);
  if (nonempty.length < 1) failExit("no model contribution: API 200 is not proof; need >=1 nonempty advisor reply.");
  const det = await get("/api/boards/" + boardId + "/meetings/" + meetingId);
  ok("verify-brief-autofilled", det.status === 200 && String(pick(det.json, "brief") || "").length > 0, "status=" + det.status + " briefLen=" + String(pick((det.json || {}), "brief") || "").length);
  console.log("ids: board=" + boardId + " meeting=" + meetingId + " advisor=" + advisorId + " roster=" + rosterId);
  console.log("note: owned QA board left for forensics (exact-ID cleanup only, never alters other boards/rosters/accounts).");
  checkBudget("verify");
}
async function main() {
  try {
    await apiSetup();
    await apiAdvisor();
    await apiMeeting();
    const r = await browserSend();
    await verify(r.counts);
  } catch (e) {
    fail++; const m = "threw " + String((e && e.stack) || (e && e.message) || e).slice(0, 500).replace(/[0-9a-f]{32,}/gi, "[redacted]");
    failures.push(m); console.log("  FAIL " + m); try { outLine("FAIL " + m); } catch {}
  }
  console.log("");
  console.log("SEND STACK SMOKE " + (fail === 0 ? "PASS" : "FAIL") + " pass=" + pass + " fail=" + fail + " elapsedMs=" + elapsed());
  try { outLine("SEND STACK SMOKE " + (fail === 0 ? "PASS" : "FAIL") + " pass=" + pass + " fail=" + fail); } catch {}
  if (failures.length) { console.log("failures:"); for (const f of failures) console.log(" - " + redact(f)); }
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.log("FATAL " + redact(String((e && e.stack) || e))); process.exit(2); });
