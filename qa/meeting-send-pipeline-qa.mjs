// qa/meeting-send-pipeline-qa.mjs - isolated board Send/progress pipeline QA (Muse-authored).
// Owns only in-process servers: static web/dist on an ephemeral 127.0.0.1 port plus
// Playwright route stubs for /api/*. No shared ports (no 5173/5080/9333), no Docker,
// no env writes. Held gates prove exactly-once chaining, frozen intent,
// response-only retry, rapid-Enter guard, and the no-responder terminal state.
// Reuses ./fixtures.cjs shapes (B1/M1) and its fixtureHandler as the fallback.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
const reqCjs = createRequire(import.meta.url);
const fx = reqCjs("./fixtures.cjs");
const B1 = fx.B1;
const M1 = fx.M1;
const API_MARK = "http://127.0.0.1:9";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const LEAD_VERSION = 7;
let pass = 0;
let fail = 0;
const failures = [];
function outPath() { try { return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".tmp", "meeting-send-pipeline-qa-result.txt"); } catch (e) { return ""; } }
function outLine(s) { try { const p = outPath(); if (p) fs.appendFileSync(p, s + "\n"); } catch (e) {} }
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok - " + name); outLine("PASS " + name); }
  else { fail++; const tail = reqLog.slice(-6).join(" | "); failures.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL - " + name + (extra ? " :: " + extra : "") + " :: req=" + tail); outLine("FAIL " + name + (extra ? " :: " + extra : "") + " :: req=" + tail); }
}
try { const p0 = outPath(); if (p0) fs.writeFileSync(p0, "START " + new Date().toISOString() + "\n"); } catch (e) {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "web", "dist"); let spaFallbacks = [];
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webp": "image/webp", ".woff2": "font/woff2" };
function startWeb() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url || "/", "http://x");
      let p = decodeURIComponent(u.pathname);
      if (p === "/") p = "/index.html"; if (p === "/favicon.ico") { res.writeHead(200, { "content-type": "image/x-icon" }); res.end(Buffer.alloc(0)); return; }
      const rel = path.normalize(p).replace(/^([\/])+/, "");
      const file = path.join(dist, rel);
      fs.readFile(file, (err, data) => { if (err) { try { spaFallbacks.push(p); } catch (e) {} }
        if (err) {
          fs.readFile(path.join(dist, "index.html"), (e2, d2) => {
            if (e2) { res.writeHead(404); res.end("no"); return; }
            res.writeHead(200, { "content-type": "text/html" });
            res.end(d2);
          });
          return;
        }
        res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
        res.end(data);
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}
function freshMessages() {
  return {
    "m-one": [
      { sequence: 1, sender: "lead", content: "Hello board" },
      { sequence: 2, sender: "advisor", advisorName: "CFO Ada", content: "Raise it." }
    ],
    "m-two": [{ sequence: 1, sender: "lead", content: "Second hello" }],
    "m-empty": []
  };
}
function freshMeetings() {
  return {
    "m-one": { id: "m-one", boardId: "b-alpha", title: "Pricing move QA session", state: 1, brief: "Should we raise the starter tier?" },
    "m-two": { id: "m-two", boardId: "b-alpha", title: "Second session notes", state: 1, brief: "Follow-up notes" }, "m-empty": { id: "m-empty", boardId: "b-alpha", title: "Empty brief session", state: 0, brief: "" }
  };
}
let messages = freshMessages();
let meetings = freshMeetings();
let reqLog = [];
let runCalls = 0;
let lastRunBody = null;
let runBehavior = "success"; let failMessages = null; let capsOverride = null; let leadVersionStub = 7; let secretaryBehavior = "success"; let secretaryBodies = [];
let patchBehavior = "success"; let lastPatchBody = null; let patchCalls = 0; let lastMessagesBody = null;
let gates = { messages: null, run: null, secretary: null, patch: null };
function deferred() { let r = null; const promise = new Promise((res) => { r = res; }); return { promise, release: r }; }
function resetProbeState() { messages = freshMessages(); meetings = freshMeetings(); runCalls = 0; lastRunBody = null; runBehavior = "success"; failMessages = null; capsOverride = null; leadVersionStub = 7; secretaryBehavior = "success"; secretaryBodies = []; patchBehavior = "success"; lastPatchBody = null; patchCalls = 0; lastMessagesBody = null; gates = { messages: null, run: null, secretary: null, patch: null }; }
const fixtureFallback = fx.fixtureHandler(reqLog, []);
async function apiStub(route) {
  const req = route.request();
  const u = new URL(req.url());
  const p = u.pathname;
  const method = req.method();
  reqLog.push(method + " " + p);
  const J = (v, s) => route.fulfill({ status: s || 200, contentType: "application/json", body: JSON.stringify(v) });
  const bodyOf = () => { try { return JSON.parse(req.postData() || "{}"); } catch (e) { return {}; } };
  let m = null;
  if (p === "/api/auth/me") return J({ user: "qa-owner", authenticated: true });
  if (p === "/api/auth/status") return J({ authRequired: false, hasAccounts: true, accountCount: 1, admin: "" });
  if (p === "/api/me/memberships") return J([]);
  if (p === "/api/boards" && method === "GET") return J([{ id: B1.id, name: B1.name, mission: B1.mission }]);
  if ((m = p.match(/^\/api\/boards\/([^/]+)$/)) && method === "GET") return J({ id: m[1], name: B1.name, mission: B1.mission });
  if ((m = p.match(/^\/api\/boards\/([^/]+)\/capabilities$/))) { if (capsOverride) return J(capsOverride); return J({ board: "manage", meeting: "manage", meetings: ["m-one", "m-two", "m-empty"], guest: false, admin: false }); }
  if ((m = p.match(/^\/api\/boards\/([^/]+)\/lead$/)) && method === "GET") return J({ id: "l1", boardId: m[1], version: leadVersionStub, name: "QA Lead", roleLabel: "Board Lead", background: "", familiarTopics: "", simplerTopics: "", commPrefs: "" });
  if ((m = p.match(/^\/api\/boards\/([^/]+)\/setup$/))) return J({ board: { id: m[1], name: B1.name, mission: B1.mission, stage: "Seed", activeConfig: true, leadProfileVersion: leadVersionStub, retainAudio: false, discussionPolicy: "balanced", dataUse: "standard" }, draftJson: "{}", activeJson: "{}", draftHash: "dh", dirty: false, lead: null, advisors: { total: 1, approved: 1 } });
  if ((m = p.match(/^\/api\/boards\/([^/]+)\/guest-settings$/))) return J({ id: m[1], name: B1.name, mission: B1.mission, stage: "Seed", discussionPolicy: "balanced", dataUse: "standard", lead: null, meetingIds: ["m-one", "m-two", "m-empty"] }); if ((m = p.match(/^\/api\/boards\/([^/]+)\/status$/))) return J({ board: B1.name, active: true, dirty: false, name: true, lead: true, leadVersion: LEAD_VERSION, advisors: { total: 1, approved: 1 }, meetings: { total: 2, active: 2 }, sourcesPending: 0, jobsFailed: 0, policy: "balanced", retainAudio: false });
  if ((m = p.match(/^\/api\/boards\/([^/]+)\/advisors$/))) return J([{ id: "a-1", boardId: "b-alpha", boardRole: "CFO Ada", approved: true, removed: false }]);
  if ((m = p.match(/^\/api\/boards\/([^/]+)\/meetings$/)) && method === "GET") return J([meetings["m-one"], meetings["m-two"], meetings["m-empty"]].filter((x) => !!x));
  if ((m = p.match(/^\/api\/boards\/([^/]+)\/meetings\/([^/]+)$/)) && method === "GET") { const mt = meetings[m[2]]; if (!mt || mt.boardId !== m[1]) return J({ error: "unknown meeting" }, 404); return J(mt); }
  if ((m = p.match(/^\/api\/meetings\/([^/]+)\/delivery$/))) { const list = messages[m[1]] || []; const last = list.length ? list[list.length - 1].sequence : 0; return J({ state: "Active", deliveredRevision: last, messages: list.length, lastSequence: last }); }
  if ((m = p.match(/^\/api\/meetings\/([^/]+)\/messages$/)) && method === "GET") return J(messages[m[1]] || []);
  if ((m = p.match(/^\/api\/meetings\/([^/]+)\/messages$/)) && method === "POST") {
    if (failMessages === "once-abort") { failMessages = null; await route.abort("failed"); return; } if (failMessages === "commit-then-abort") { failMessages = null; const bb = bodyOf(); const ll = messages[m[1]] || (messages[m[1]] = []); const sq = (ll.length ? ll[ll.length - 1].sequence : 0) + 1; ll.push({ sequence: sq, sender: "lead", content: bb.content || "", parentSequence: bb.parentSequence ?? null, advisorId: "", advisorName: null, status: "committed" }); await route.abort("failed"); return; } if (failMessages === "once-500") { failMessages = null; return J({ error: "store failed" }, 500); } if (failMessages === "once-500-denied") { failMessages = null; return J({ error: "Post-commit effect failed: access denied" }, 500); } if (failMessages === "commit-then-500-denied") { failMessages = null; const bb2 = bodyOf(); const ll2 = messages[m[1]] || (messages[m[1]] = []); const sq2 = (ll2.length ? ll2[ll2.length - 1].sequence : 0) + 1; ll2.push({ sequence: sq2, sender: "lead", content: bb2.content || "", parentSequence: bb2.parentSequence ?? null, advisorId: "", advisorName: null, status: "committed" }); return J({ error: "Post-commit effect failed: access denied" }, 500); } if (failMessages === "once-403-denied") { failMessages = null; return J({ error: "Access revoked or not granted for this scope." }, 403); } if (gates.messages) await gates.messages.promise;
    const b = bodyOf(); lastMessagesBody = b;
    const list = messages[m[1]] || (messages[m[1]] = []);
    const seq = (list.length ? list[list.length - 1].sequence : 0) + 1;
    const msg = { sequence: seq, sender: "lead", content: b.content || "", parentSequence: b.parentSequence ?? null, advisorId: "", advisorName: null, status: "committed" };
    list.push(msg);
    return J(msg, 201);
  }
  if ((m = p.match(/^\/api\/meetings\/([^/]+)$/)) && method === "PATCH") {
    if (gates.patch) await gates.patch.promise;
    const b = bodyOf(); lastPatchBody = b; patchCalls++;
    if (patchBehavior === "fail500-once") { patchBehavior = "success"; return J({ error: "brief store failed" }, 500); }
    if (patchBehavior === "fail409-brief-once") { patchBehavior = "success"; return J({ error: "Brief was already set by a newer message; auto-init discarded. Retry responses." }, 409); }
    const mt = meetings[m[1]];
    if (mt && typeof b.brief === "string") {
      const isAuto = b.briefAutoInit === true || b.autoInit === true;
      if (isAuto) {
        const proposed = b.brief || "";
        const cur = mt.brief || "";
        let expected = null;
        if (typeof b.expectedBrief === "string") expected = b.expectedBrief;
        if (expected !== null) { if (cur !== expected && cur !== proposed) return J({ error: "Brief was already set by a newer message; auto-init discarded. Retry responses." }, 409); }
        else { if (cur.trim() !== "" && cur !== proposed) return J({ error: "Brief was already set by a newer message; auto-init discarded. Retry responses." }, 409); }
        if (b.leadSequence !== undefined && b.leadSequence !== null) {
          const lst = messages[m[1]] || [];
          let latest = null;
          for (const mm of lst) { if (mm.sender === "lead" && (latest === null || mm.sequence > latest)) latest = mm.sequence; }
          if (latest !== b.leadSequence) return J({ error: "Lead message was superseded by a newer message; auto-init discarded. Retry responses." }, 409);
        }
        if (b.leadContent !== undefined && b.leadContent !== null) {
          const lst2 = messages[m[1]] || [];
          let latestMsg = null;
          for (const mm of lst2) { if (mm.sender === "lead" && (!latestMsg || mm.sequence > latestMsg.sequence)) latestMsg = mm; }
          if (!latestMsg || (latestMsg.content || "") !== b.leadContent) return J({ error: "Lead message was superseded by a newer message; auto-init discarded. Retry responses." }, 409);
        }
        if (cur.trim() === "") mt.brief = proposed;
        return J(mt || {});
      }
      mt.brief = b.brief;
    }
    return J(mt || {});
  }
  if ((m = p.match(/^\/api\/meetings\/([^/]+)\/run$/)) && method === "POST") {
    runCalls++;
    if (gates.run) await gates.run.promise;
    const b = bodyOf();
    lastRunBody = b; try { fs.appendFileSync(".tmp/qa-runs.log", "RUN " + m[1] + " prompt=" + JSON.stringify((b.prompt || "").slice(0, 40)) + " leadVersion=" + b.leadVersion + "\n"); } catch (e) {}
    if (runBehavior === "fail409-once") { runBehavior = "success"; return J({ error: "No advisors available for discussion.", fixes: ["Approve at least one advisor on this board before running discussion."], yielded: [] }, 409); }
    if (runBehavior === "fail502-once") { runBehavior = "success"; return J({ error: "provider failure" }, 502); }
    if (runBehavior === "fail500-denied-once") { runBehavior = "success"; return J({ error: "Post-commit effect failed: access denied" }, 500); }
    if (runBehavior === "strict-version" && b.leadVersion !== leadVersionStub) return J({ error: "Lead profile changed; refresh and retry with the current version." }, 409); if (runBehavior === "conflict-once") { runBehavior = "success"; return J({ error: "Lead profile changed; refresh and retry with the current version." }, 409); } if (runBehavior === "empty-once") { runBehavior = "success"; return J({ published: [], yielded: [{ advisor: "CFO Ada", reason: "bid-declined" }], abstained: ["CFO Ada"], overflow: null }); }
    const list = messages[m[1]] || (messages[m[1]] = []);
    const seq = (list.length ? listHC(list) : 0) + 1;
    list.push({ sequence: seq, sender: "advisor", advisorName: "CFO Ada", content: "Fixture reply: noted." });
    return J({ published: [{ sequence: seq }], yielded: [], abstained: [], overflow: null });
  }
  if ((m = p.match(/^\/api\/meetings\/([^/]+)\/secretary$/)) && method === "POST") { if (gates.secretary) await gates.secretary.promise; try { secretaryBodies.push(JSON.parse(req.postData() || "{}")); } catch (e) {} if (secretaryBehavior === "fail500-once") { secretaryBehavior = "success"; return J({ error: "secretary failed" }, 500); } return J({ requestId: "req-1", status: "completed", note: "Secretary note saved as provisional." }); }
  if ((m = p.match(/^\/api\/meetings\/([^/]+)\/secretary\/requests$/))) return J([]);
  if (p === "/api/presets") return J([]);
  if (p === "/api/commands") return J([]);
  if (p === "/api/spending") return J({ month: "2026-11", monthlyCapUsd: null, mode: "warn", knownSpendUsd: 0, unknownCostCalls: 0, overCap: false, enforced: false, note: "fixture" });
  if (p === "/api/model/status") return J({ configured: false, source: "", model: "muse-spark-1.3", chatOverride: "", keyHint: "", lastTestAt: null, lastTestOk: false, lastTestError: "" });
  if (p === "/api/usage" || p.indexOf("/api/usage?") === 0) return J([]);
  if (p === "/api/models/calls" || p.indexOf("/api/models/calls?") === 0) return J([]);
  if (p === "/api/activity/jobs" || p === "/api/activity/audit") return J([]);
  if (p.indexOf("/api/boards/") === 0 && p.indexOf("/recall") > 0) return J([]);
  if (p.indexOf("/api/meetings/") === 0 && (p.endsWith("/notes") || p.endsWith("/records") || p.indexOf("/notes/history") > 0 || p.indexOf("/secretary/requests/") > 0 || p.endsWith("/voice"))) return J([]);
  if ((m = p.match(/^\/api\/meetings\/([^/]+)\/messages\/search$/))) return J([]);
  return fixtureFallback(route);
}
function listHC(list) { return list.length ? list[list.length - 1].sequence : 0; }
const COMPOSER_LABEL = "Message. Press Enter to send, Shift and Enter for a new line.";
let hubNoise = []; let browser = null;
let ctx = null;
let page = null;
let webSrv = null;
let webBase = "";
async function launch() {
  webSrv = await startWeb();
  const addr = webSrv.address();
  webBase = "http://127.0.0.1:" + addr.port + "/";
  browser = await chromium.launch({ executablePath: EDGE, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => { try { pageErrors.push(String(e).slice(0, 300)); } catch (x) {} });
  page.on("console", (msg) => { try { const t = String(msg.text()); if (t.indexOf("Failed to complete negotiation") >= 0 || t.indexOf("Failed to start the connection") >= 0 || t.indexOf("net::ERR_FAILED") >= 0 || t.indexOf("net::ERR_CONNECTION_REFUSED") >= 0 || t.indexOf("status of 409") >= 0 || t.indexOf("status of 502") >= 0 || t.indexOf("status of 500") >= 0 || t.indexOf("status of 403") >= 0 || t.indexOf("status of 401") >= 0) { hubNoise.push(t.slice(0, 140)); return; } if (msg.type() === "error") pageErrors.push(t.slice(0, 200)); } catch (x) {} });
  page.on("response", (r) => { try { if (r.status() >= 400) outLine("HTTP" + r.status() + " " + r.url().slice(0, 160)); } catch (x) {} });
  page.__qaErrors = pageErrors;
  await page.route("**/hubs/**", (r) => r.abort("connectionrefused")); await page.route("**/api/**", apiStub);
}
async function closeAll() {
  try { if (page) await page.close(); } catch (x) {}
  try { if (ctx) await ctx.close(); } catch (x) {}
  try { if (browser) await browser.close(); } catch (x) {}
  try { if (webSrv) await new Promise((r) => webSrv.close(r)); } catch (x) {}
}
function countFrom(mark, method, sub) {
  let n = 0;
  for (let i = mark; i < reqLog.length; i++) { if (reqLog[i].indexOf(method + " ") === 0 && reqLog[i].indexOf(sub) >= 0) n++; }
  return n;
}
async function gotoHash(hash) {
  const target = webBase + hash;
  let cur = "";
  try { cur = await page.evaluate(() => window.location.href); } catch (e) { cur = ""; }
  if (!cur || cur.split("#")[0] !== target.split("#")[0]) { await page.goto(target); }
  else if (cur !== target) { await page.evaluate((h) => { window.location.hash = h; }, hash); }
}
async function openMeeting(mid, titleText) {
  await gotoHash("#/meet?board=b-alpha&meeting=" + mid);
  await page.waitForSelector("textarea[aria-label=\"" + COMPOSER_LABEL + "\"]", { timeout: 20000 });
  await page.getByRole("heading", { name: titleText || "Pricing move QA session", exact: true }).first().waitFor({ timeout: 20000 });
}
async function snap(tag) {
  try {
    const sts = await page.locator("div[role=status]").allInnerTexts().catch(() => []);
    const dis = await sendButton().isDisabled().catch(() => "na");
    const dv = await composer().inputValue().catch(() => "?");
    outLine("SNAP " + tag + " dis=" + dis + " draft=" + JSON.stringify(String(dv).slice(0, 40)) + " status=" + JSON.stringify(sts).slice(0, 300));
  } catch (e) { try { outLine("SNAP " + tag + " ERR " + String(e).slice(0, 120)); } catch (x) {} }
}
function composer() { return page.locator(".composer-bar textarea").first(); }
function sendButton() { return page.locator(".composer-bar button.primary").first(); }
async function bodyText() { return page.evaluate(() => document.body.innerText); }
async function testSendChainsRunOnce() {
  const mark = reqLog.length;
  resetProbeState();
  await openMeeting("m-one");
  const box = composer();
  await box.fill("Board hello pipeline check");
  await box.press("Enter");
  await page.waitForFunction((t) => document.body.innerText.indexOf(t) >= 0, "Responses complete.", { timeout: 30000 });
  ok("send-progress-complete", true);
  const nMsg = countFrom(mark, "POST", "/api/meetings/m-one/messages");
  const nRun = countFrom(mark, "POST", "/api/meetings/m-one/run");
  ok("send-posts-lead-once", nMsg === 1, "messages=" + nMsg);
  ok("send-chains-run-once", nRun === 1, "run=" + nRun);
  ok("run-frozen-prompt", lastRunBody && lastRunBody.prompt === "Board hello pipeline check", JSON.stringify(lastRunBody));
  ok("run-frozen-lead-version", lastRunBody && lastRunBody.leadVersion === LEAD_VERSION, JSON.stringify(lastRunBody));
  const t = await bodyText();
  ok("send-progress-shown", t.indexOf("Requesting advisor responses...") >= 0 || t.indexOf("Responses complete.") >= 0, t.slice(0, 200));
  await page.waitForFunction((t) => document.body.innerText.indexOf(t) >= 0, "Fixture reply: noted.", { timeout: 30000 }); ok("send-advisor-reply-visible", (await bodyText()).indexOf("Fixture reply: noted.") >= 0, "");
  const btn = sendButton();
  await box.fill("follow-up ping"); ok("send-reenabled", await btn.isEnabled(), "");
}
async function testSecretaryRouting() {
  const mark = reqLog.length;
  runBehavior = "success";
  await openMeeting("m-one");
  const sel = page.locator(".composer-bar select").first();
  await sel.selectOption("secretary");
  const box = composer();
  await box.fill("Secretary: file the fixture note");
  await sendButton().click();
  await page.waitForFunction(() => { const el = document.querySelector(".composer-bar textarea"); return el && el.value === ""; }, null, { timeout: 30000 });
  await sleep(1500);
  const nSec = countFrom(mark, "POST", "/api/meetings/m-one/secretary");
  const nMsg = countFrom(mark, "POST", "/api/meetings/m-one/messages");
  const nRun = countFrom(mark, "POST", "/api/meetings/m-one/run");
  ok("secretary-direct-route", nSec >= 1, "secretary=" + nSec);
  ok("secretary-no-lead-post", nMsg === 0, "messages=" + nMsg);
  ok("secretary-no-run", nRun === 0, "run=" + nRun);
}
async function testRunFailureRetryNoRepost() {
  const mark = reqLog.length;
  resetProbeState();
  runBehavior = "fail409-once";
  await page.reload();
  await openMeeting("m-one", "Pricing move QA session");
  const box = composer();
  await box.fill("Lead for retry check");
  await box.press("Enter");
  await page.waitForFunction((t) => document.body.innerText.indexOf(t) >= 0, "Advisor responses failed", { timeout: 30000 });
  const nMsg = countFrom(mark, "POST", "/api/meetings/m-one/messages");
  const nRun = countFrom(mark, "POST", "/api/meetings/m-one/run");
  ok("fail409-lead-posted-once", nMsg === 1, "messages=" + nMsg);
  ok("fail409-run-attempted-once", nRun === 1, "run=" + nRun);
  const card = page.locator("div[role=\"alert\"]");
  const cardText = await card.first().innerText();
  ok("fail409-mapped-message", cardText.indexOf("No approved advisors") >= 0, cardText.slice(0, 200));
  ok("fail409-no-raw-status", cardText.indexOf("409") < 0, cardText.slice(0, 200));
  ok("fail409-no-raw-json", cardText.indexOf("fixes") < 0 && cardText.indexOf("{\"error") < 0, cardText.slice(0, 200));
  gates.run = deferred();
  await page.getByRole("button", { name: "Retry responses (same lead)" }).first().click();
  await page.waitForFunction((t) => document.body.innerText.indexOf(t) >= 0, "Requesting advisor responses...", { timeout: 30000 });
  await box.fill("x");
  ok("fail409-held-dupe-blocked", await sendButton().isDisabled(), "");
  gates.run.release();
  gates.run = null;
  await page.waitForFunction((t) => document.body.innerText.indexOf(t) >= 0, "Responses complete.", { timeout: 30000 });
  ok("fail409-retry-ran-once-more", countFrom(mark, "POST", "/api/meetings/m-one/run") === 2, "run=" + countFrom(mark, "POST", "/api/meetings/m-one/run"));
  ok("fail409-retry-no-repost", countFrom(mark, "POST", "/api/meetings/m-one/messages") === 1, "messages=" + countFrom(mark, "POST", "/api/meetings/m-one/messages"));
}
async function testProvider502Mapped() {
  const mark = reqLog.length;
  resetProbeState();
  runBehavior = "fail502-once";
  await page.reload();
  await openMeeting("m-one", "Pricing move QA session");
  const box = composer();
  await box.fill("Lead for provider outage check");
  await box.press("Enter");
  await page.waitForFunction((t) => document.body.innerText.indexOf(t) >= 0, "Advisor responses failed", { timeout: 30000 });
  const cardText = await page.locator("div[role=\"alert\"]").first().innerText();
  ok("fail502-mapped-message", cardText.indexOf("Advisor service is unavailable") >= 0, cardText.slice(0, 200));
  ok("fail502-no-raw-status", cardText.indexOf("502") < 0, cardText.slice(0, 200));
}
async function testLeadPostFailureHonest() {
  let mark = reqLog.length;
  resetProbeState();
  failMessages = "once-500";
  await page.reload();
  await openMeeting("m-one", "Pricing move QA session");
  const box = composer();
  await box.fill("Lead that fails to save");
  await box.press("Enter");
  await page.waitForFunction((t) => document.body.innerText.indexOf(t) >= 0, "Could not confirm", { timeout: 30000 });
  const t = await bodyText();
  ok("leadfail-uncertain-message", t.indexOf("Could not confirm") >= 0 && t.indexOf("resend only if it does not appear") >= 0, t.slice(0, 300));
  ok("leadfail-no-saved-claim", t.indexOf("The lead message is saved") < 0, t.slice(0, 300));
  ok("leadfail-no-retry-card", t.indexOf("Retry responses (same lead)") < 0, t.slice(0, 300));
  ok("leadfail-draft-preserved", (await box.inputValue()) === "Lead that fails to save", "");
  failMessages = null;
  await box.press("Enter");
  await page.waitForFunction((t) => document.body.innerText.indexOf(t) >= 0, "Responses complete.", { timeout: 30000 });
  ok("leadfail-resend-works", countFrom(mark, "POST", "/api/meetings/m-one/messages") === 2, "messages=" + countFrom(mark, "POST", "/api/meetings/m-one/messages"));
  mark = reqLog.length;
  resetProbeState();
  failMessages = "once-abort";
  await page.reload();
  await openMeeting("m-one", "Pricing move QA session");
  const box2 = composer();
  await box2.fill("Lead with uncertain delivery");
  await box2.press("Enter");
  await page.waitForFunction((t) => document.body.innerText.indexOf(t) >= 0, "Could not confirm", { timeout: 30000 });
  const t2 = await bodyText();
  ok("leadfail-uncertain-message", t2.indexOf("Check the conversation") >= 0 && t2.indexOf("do not resend") >= 0, t2.slice(0, 300));
  ok("leadfail-no-autoresend", countFrom(mark, "POST", "/api/meetings/m-one/messages") === 1, "messages=" + countFrom(mark, "POST", "/api/meetings/m-one/messages"));
  failMessages = null;
}
async function testRapidEnterGuard() {
  const mark = reqLog.length;
  resetProbeState();
  await page.reload();
  await openMeeting("m-one", "Pricing move QA session");
  const box = composer();
  await box.fill("Rapid guard check");
  await box.press("Enter");
  await box.press("Enter");
  await page.waitForFunction((t) => document.body.innerText.indexOf(t) >= 0, "Responses complete.", { timeout: 30000 });
  ok("rapid-single-lead", countFrom(mark, "POST", "/api/meetings/m-one/messages") === 1, "messages=" + countFrom(mark, "POST", "/api/meetings/m-one/messages"));
  ok("rapid-single-run", countFrom(mark, "POST", "/api/meetings/m-one/run") === 1, "run=" + countFrom(mark, "POST", "/api/meetings/m-one/run"));
  const mark2 = reqLog.length;
  resetProbeState();
  await page.reload();
  await openMeeting("m-one", "Pricing move QA session");
  const box2 = composer();
  await box2.fill("Same tick double enter");
  await page.evaluate(() => { const el = document.querySelector(".composer-bar textarea"); const init = { key: "Enter", bubbles: true, cancelable: true }; el.dispatchEvent(new KeyboardEvent("keydown", init)); el.dispatchEvent(new KeyboardEvent("keydown", init)); });
  await page.waitForFunction((t) => document.body.innerText.indexOf(t) >= 0, "Responses complete.", { timeout: 30000 });
  ok("sametick-single-lead", countFrom(mark2, "POST", "/api/meetings/m-one/messages") === 1, "messages=" + countFrom(mark2, "POST", "/api/meetings/m-one/messages"));
  ok("sametick-single-run", countFrom(mark2, "POST", "/api/meetings/m-one/run") === 1, "run=" + countFrom(mark2, "POST", "/api/meetings/m-one/run"));
}
async function testHeldRunNavigationFrozen() {
  const mark = reqLog.length;
  resetProbeState();
  gates.run = deferred();
  await page.reload();
  await openMeeting("m-one", "Pricing move QA session");
  const box = composer();
  await box.fill("Held navigation lead");
  await box.press("Enter");
  await page.waitForFunction((t) => document.body.innerText.indexOf(t) >= 0, "Requesting advisor responses...", { timeout: 30000 });
  await box.press("End");
  await box.type(" plus newer typing");
  await page.evaluate((h) => { window.location.hash = h; }, "#/meet?board=b-alpha&meeting=m-two");
  await page.waitForFunction((t) => document.body.innerText.indexOf(t) >= 0, "Second session notes", { timeout: 20000 });
  await sleep(400);
  const mTwoDraft = await composer().inputValue();
  ok("heldnav-new-meeting-clean-draft", mTwoDraft === "", JSON.stringify(mTwoDraft).slice(0, 120));
  gates.run.release();
  gates.run = null;
  await sleep(1200);
  const t = await bodyText();
  ok("heldnav-no-stale-complete", t.indexOf("Responses complete.") < 0, t.slice(0, 300));
  ok("heldnav-no-stale-status", t.indexOf("Requesting advisor responses...") < 0, t.slice(0, 300));
  await composer().fill("fresh note"); ok("heldnav-send-enabled", await sendButton().isEnabled(), "");
  ok("heldnav-server-applied-right-meeting", (messages["m-one"] || []).length === 4 && (messages["m-two"] || []).length === 1, "m-one=" + (messages["m-one"] || []).length + " m-two=" + (messages["m-two"] || []).length);
}
async function testNoRespondersTerminal() {
  const mark = reqLog.length;
  resetProbeState();
  runBehavior = "empty-once";
  await page.reload();
  await openMeeting("m-one", "Pricing move QA session");
  const box = composer();
  await box.fill("Quiet board lead");
  await box.press("Enter");
  await page.waitForFunction((t) => document.body.innerText.indexOf(t) >= 0, "No advisors contributed", { timeout: 30000 });
  ok("noresp-terminal-message", true, "");
  ok("noresp-lead-once", countFrom(mark, "POST", "/api/meetings/m-one/messages") === 1, "messages=" + countFrom(mark, "POST", "/api/meetings/m-one/messages"));
  await page.getByRole("button", { name: "Retry responses (same lead)" }).first().click();
  await page.waitForFunction((t) => document.body.innerText.indexOf(t) >= 0, "Responses complete.", { timeout: 30000 });
  ok("noresp-retry-runs-again", countFrom(mark, "POST", "/api/meetings/m-one/run") === 2, "run=" + countFrom(mark, "POST", "/api/meetings/m-one/run"));
  ok("noresp-retry-no-repost", countFrom(mark, "POST", "/api/meetings/m-one/messages") === 1, "messages=" + countFrom(mark, "POST", "/api/meetings/m-one/messages"));
}
async function testIdentityRetirement() {
  const mark = reqLog.length;
  resetProbeState();
  gates.run = deferred();
  await page.reload();
  await openMeeting("m-one", "Pricing move QA session");
  const box = composer();
  await box.fill("Identity rotation lead");
  await box.press("Enter");
  await page.waitForFunction((t) => document.body.innerText.indexOf(t) >= 0, "Requesting advisor responses...", { timeout: 30000 });
  await page.evaluate(() => { window.__simceoEpoch = (window.__simceoEpoch || 0) + 1; });
  gates.run.release();
  gates.run = null;
  await sleep(1200);
  const t = await bodyText();
  ok("identity-no-stuck-complete", t.indexOf("Responses complete.") < 0, t.slice(0, 300));
  ok("identity-no-stuck-working", t.indexOf("Requesting advisor responses...") < 0, t.slice(0, 300));
  await composer().fill("fresh note"); ok("identity-send-enabled", await sendButton().isEnabled(), "");
  ok("identity-single-lead", countFrom(mark, "POST", "/api/meetings/m-one/messages") === 1, "messages=" + countFrom(mark, "POST", "/api/meetings/m-one/messages"));
}
async function testVersionConflictPin() {
  const mark = reqLog.length;
  resetProbeState();
  runBehavior = "strict-version";
  gates.run = deferred();
  await page.reload();
  await openMeeting("m-one", "Pricing move QA session");
  ok("version-v7-ready", countFrom(mark, "GET", "/api/boards/b-alpha/lead") >= 1, "");
  const box = composer();
  await box.fill("Version conflict lead");
  await box.press("Enter");
  await page.waitForFunction((t) => document.body.innerText.indexOf(t) >= 0, "Requesting advisor responses...", { timeout: 30000 });
  leadVersionStub = 8;
  gates.run.release();
  gates.run = null;
  await page.waitForFunction((t) => document.body.innerText.indexOf(t) >= 0, "Advisor responses failed", { timeout: 30000 });
  ok("version-frozen-rejected", lastRunBody && lastRunBody.leadVersion === 7, JSON.stringify(lastRunBody));
  ok("version-refreshed", countFrom(mark, "GET", "/api/boards/b-alpha/lead") >= 2, "");
  const cardText = await page.locator("div[role=\"alert\"]").first().innerText();
  ok("version-conflict-message", cardText.indexOf("Lead profile changed") >= 0, cardText.slice(0, 200));
  const pinBtn = page.getByRole("button", { name: /Retry with current lead profile/ }).first();
  await pinBtn.waitFor({ timeout: 10000 });
  ok("version-pin-offered", true, "");
  const pinLabel = await pinBtn.innerText();
  ok("version-pin-label", pinLabel.indexOf("(v8)") >= 0, pinLabel);
  await pinBtn.click();
  await page.waitForFunction((t) => document.body.innerText.indexOf(t) >= 0, "Responses complete.", { timeout: 30000 });
  ok("version-pinned-run", lastRunBody && lastRunBody.leadVersion === 8, JSON.stringify(lastRunBody));
  ok("version-prompt-retained", lastRunBody && lastRunBody.prompt === "Version conflict lead", JSON.stringify(lastRunBody));
  ok("version-no-repost", countFrom(mark, "POST", "/api/meetings/m-one/messages") === 1, "messages=" + countFrom(mark, "POST", "/api/meetings/m-one/messages"));
}
async function testContributorBriefGate() {
  const mark = reqLog.length;
  resetProbeState();
  capsOverride = { board: "contribute", meeting: null, meetings: ["m-one", "m-two", "m-empty"], guest: false, admin: false };
  await page.reload();
  await openMeeting("m-empty", "Empty brief session");
  const box = composer();
  await box.fill("Contributor brief lead");
  await box.press("Enter");
  await page.waitForFunction((t) => document.body.innerText.indexOf(t) >= 0, "Responses complete.", { timeout: 30000 });
  ok("contrib-brief-patched", countFrom(mark, "PATCH", "/api/meetings/m-empty") === 1, "patch=" + countFrom(mark, "PATCH", "/api/meetings/m-empty"));
  ok("contrib-run-once", countFrom(mark, "POST", "/api/meetings/m-empty/run") === 1, "run=" + countFrom(mark, "POST", "/api/meetings/m-empty/run"));
  ok("contrib-lead-once", countFrom(mark, "POST", "/api/meetings/m-empty/messages") === 1, "messages=" + countFrom(mark, "POST", "/api/meetings/m-empty/messages"));
}
async function testDiscussGuestNoPatch() {
  const mark = reqLog.length;
  resetProbeState();
  capsOverride = { board: "none", meeting: "discuss", meetings: ["m-empty"], guest: true, admin: false };
  await page.reload();
  await openMeeting("m-empty", "Empty brief session");
  const box = composer();
  await box.fill("Discuss guest lead");
  await box.press("Enter");
  await page.waitForFunction((t) => document.body.innerText.indexOf(t) >= 0, "Advisor responses failed", { timeout: 30000 });
  const cardText = await page.locator("div[role=\"alert\"]").first().innerText();
  ok("guest-brief-guidance", cardText.indexOf("Add a brief") >= 0, cardText.slice(0, 200));
  ok("guest-no-patch", countFrom(mark, "PATCH", "/api/meetings/m-empty") === 0, "patch=" + countFrom(mark, "PATCH", "/api/meetings/m-empty"));
  ok("guest-no-run", countFrom(mark, "POST", "/api/meetings/m-empty/run") === 0, "run=" + countFrom(mark, "POST", "/api/meetings/m-empty/run"));
  ok("guest-lead-posted", countFrom(mark, "POST", "/api/meetings/m-empty/messages") === 1, "messages=" + countFrom(mark, "POST", "/api/meetings/m-empty/messages"));
}
async function testSecretaryRetryVisible() {
  const mark = reqLog.length;
  resetProbeState();
  secretaryBehavior = "fail500-once";
  await page.reload();
  await openMeeting("m-one", "Pricing move QA session");
  const sel = page.locator(".composer-bar select").first();
  await sel.selectOption("secretary");
  const box = composer();
  await box.fill("Secretary: retry visibility note");
  await sendButton().click();
  await gotoHash("#/meet?board=b-alpha&meeting=m-one&mtab=takeaways");
  await page.waitForFunction((t) => document.body.innerText.indexOf(t) >= 0, "Secretary error", { timeout: 30000 });
  const retryBtn = page.getByRole("button", { name: "Retry secretary (same envelope)" }).first();
  await retryBtn.waitFor({ timeout: 15000 });
  ok("secretary-retry-control", true, "");
  gates.secretary = deferred();
  await retryBtn.click();
  await page.getByText("Secretary working...").first().waitFor({ timeout: 10000 });
  ok("secretary-retry-progress", true, "");
  gates.secretary.release();
  gates.secretary = null;
  await sleep(1000);
  const t = await bodyText();
  ok("secretary-retry-done", t.indexOf("Secretary error") < 0 && t.indexOf("Secretary working...") < 0, t.slice(0, 300));
  ok("secretary-retry-twice", countFrom(mark, "POST", "/api/meetings/m-one/secretary") === 2, "secretary=" + countFrom(mark, "POST", "/api/meetings/m-one/secretary")); ok("secretary-same-envelope", secretaryBodies.length === 2 && secretaryBodies[0].clientNonce && secretaryBodies[0].clientNonce === secretaryBodies[1].clientNonce, JSON.stringify(secretaryBodies.map((b) => b.clientNonce)));
  ok("secretary-no-lead-post", countFrom(mark, "POST", "/api/meetings/m-one/messages") === 0, "messages=" + countFrom(mark, "POST", "/api/meetings/m-one/messages"));
}
async function testHeldPatchSingleRun() {
  const mark = reqLog.length;
  resetProbeState();
  capsOverride = { board: "contribute", meeting: null, meetings: ["m-one", "m-two", "m-empty"], guest: false, admin: false };
  gates.patch = deferred();
  await page.reload();
  await openMeeting("m-empty", "Empty brief session");
  const box = composer();
  await box.fill("Held patch lead");
  await box.press("Enter");
  await page.waitForFunction((t) => document.body.innerText.indexOf(t) >= 0, "Requesting advisor responses...", { timeout: 30000 });
  await sleep(500);
  ok("heldpatch-no-run-yet", countFrom(mark, "POST", "/api/meetings/m-empty/run") === 0, "run=" + countFrom(mark, "POST", "/api/meetings/m-empty/run"));
  await box.fill("Held patch lead plus dupe");
  await box.press("Enter");
  await sleep(500);
  ok("heldpatch-no-dupe-lead", countFrom(mark, "POST", "/api/meetings/m-empty/messages") === 1, "messages=" + countFrom(mark, "POST", "/api/meetings/m-empty/messages"));
  gates.patch.release();
  gates.patch = null;
  await page.waitForFunction((t) => document.body.innerText.indexOf(t) >= 0, "Responses complete.", { timeout: 30000 });
  ok("heldpatch-single-run", countFrom(mark, "POST", "/api/meetings/m-empty/run") === 1, "run=" + countFrom(mark, "POST", "/api/meetings/m-empty/run"));
}
async function testApplyIdentityRetirement() {
  const mark = reqLog.length;
  resetProbeState();
  gates.run = deferred();
  await page.reload();
  await openMeeting("m-one", "Pricing move QA session");
  const box = composer();
  await box.fill("Identity apply lead");
  await box.press("Enter");
  await page.waitForFunction((t) => document.body.innerText.indexOf(t) >= 0, "Requesting advisor responses...", { timeout: 30000 });
  await page.goto(webBase + "#/people?board=b-alpha");
  await page.getByRole("heading", { name: "Act as (demo identity for grant checks)", exact: true }).waitFor({ timeout: 15000 });
  await page.getByLabel("Act as user").fill("owner");
  await page.getByRole("button", { name: "Apply identity" }).click();
  await sleep(800);
  await page.goto(webBase + "#/meet?board=b-alpha&meeting=m-one");
  await page.getByRole("heading", { name: "Pricing move QA session", exact: true }).waitFor({ timeout: 20000 });
  gates.run.release();
  gates.run = null;
  await sleep(1200);
  const t = await bodyText();
  ok("apply-no-stale-complete", t.indexOf("Responses complete.") < 0, t.slice(0, 300));
  ok("apply-no-stuck-working", t.indexOf("Requesting advisor responses...") < 0, t.slice(0, 300));
  await composer().fill("fresh note");
  ok("apply-send-enabled", await sendButton().isEnabled(), "");
  ok("apply-single-lead", countFrom(mark, "POST", "/api/meetings/m-one/messages") === 1, "messages=" + countFrom(mark, "POST", "/api/meetings/m-one/messages"));
}
async function testLateABANewOp() {
function step(s) { try { outLine("STEP-ABA " + s); } catch (e) {} }
  const mark = reqLog.length;
  resetProbeState();
  gates.run = deferred();
  await page.reload();
  await openMeeting("m-one", "Pricing move QA session");
  const box = composer();
  await box.fill("ABA first lead");
  await box.press("Enter"); step("aba-sent-1");
  await page.waitForFunction((t) => document.body.innerText.indexOf(t) >= 0, "Requesting advisor responses...", { timeout: 30000 }); step("aba-working-1"); await snap("aba-working-1");
  await page.evaluate((h) => { window.location.hash = h; }, "#/meet?board=b-alpha&meeting=m-two");
  await page.getByRole("heading", { name: "Second session notes", exact: true }).waitFor({ timeout: 20000 }); step("aba-on-m2"); await snap("aba-on-m2");
  await page.evaluate((h) => { window.location.hash = h; }, "#/meet?board=b-alpha&meeting=m-one");
  await page.getByRole("heading", { name: "Pricing move QA session", exact: true }).waitFor({ timeout: 20000 }); step("aba-back-m1"); await snap("aba-back-m1");
  const box2 = composer();
  await box2.fill("ABA second lead");
  await box2.press("Enter"); step("aba-sent-2"); await snap("aba-sent-2");
  await sleep(800);
  ok("aba-guard-blocks-during-flight", countFrom(mark, "POST", "/api/meetings/m-one/messages") === 1, "messages=" + countFrom(mark, "POST", "/api/meetings/m-one/messages"));
  ok("aba-draft-preserved", (await composer().inputValue()) === "ABA second lead", "");
  gates.run.release();
  gates.run = null;
  await sleep(1200);
  ok("aba-stale-ignored", (await bodyText()).indexOf("Responses complete.") < 0, "");
  await composer().press("Enter");
  await page.waitForFunction((t) => document.body.innerText.indexOf(t) >= 0, "Responses complete.", { timeout: 30000 });
  ok("aba-two-leads", countFrom(mark, "POST", "/api/meetings/m-one/messages") === 2, "messages=" + countFrom(mark, "POST", "/api/meetings/m-one/messages"));
  ok("aba-two-runs", countFrom(mark, "POST", "/api/meetings/m-one/run") === 2, "run=" + countFrom(mark, "POST", "/api/meetings/m-one/run"));
}
async function testLeadUncertainNoAutorepost() {
  const mark = reqLog.length;
  resetProbeState();
  failMessages = "commit-then-abort";
  await page.reload();
  await openMeeting("m-one", "Pricing move QA session");
  const box = composer();
  await box.fill("Uncertain delivery lead");
  await box.press("Enter");
  await page.waitForFunction((t) => document.body.innerText.indexOf(t) >= 0, "Could not confirm", { timeout: 30000 });
  const t = await bodyText();
  ok("uncertain-message", t.indexOf("Check the conversation") >= 0 && t.indexOf("do not resend") >= 0, t.slice(0, 300));
  ok("uncertain-no-retry-card", t.indexOf("Retry responses (same lead)") < 0, t.slice(0, 300));
  ok("uncertain-single-attempt", countFrom(mark, "POST", "/api/meetings/m-one/messages") === 1, "messages=" + countFrom(mark, "POST", "/api/meetings/m-one/messages"));
  await sleep(1000);
  ok("uncertain-no-autorepost", countFrom(mark, "POST", "/api/meetings/m-one/messages") === 1, "messages=" + countFrom(mark, "POST", "/api/meetings/m-one/messages"));
  failMessages = null;
  await page.reload();
  await openMeeting("m-one", "Pricing move QA session");
  ok("uncertain-reconciled", (await bodyText()).indexOf("Uncertain delivery lead") >= 0, "");
}
async function testSendDeniedRequires4xx() {
  const mark = reqLog.length;
  resetProbeState();
  failMessages = "commit-then-500-denied";
  await page.reload();
  await openMeeting("m-one", "Pricing move QA session");
  const box = composer();
  await box.fill("Denied 500 lead");
  await box.press("Enter");
  await page.waitForFunction((t) => document.body.innerText.indexOf(t) >= 0, "Could not confirm", { timeout: 30000 });
  const t1 = await bodyText();
  ok("denied500-uncertain", t1.indexOf("Could not confirm") >= 0 && t1.indexOf("resend only if it does not appear") >= 0, t1.slice(0, 300));
  ok("denied500-no-definitive", t1.indexOf("Reopen it from Boards, then resend") < 0, t1.slice(0, 300));
  ok("denied500-single", countFrom(mark, "POST", "/api/meetings/m-one/messages") === 1, "messages=" + countFrom(mark, "POST", "/api/meetings/m-one/messages"));
  await sleep(800);
  ok("denied500-no-autorepost", countFrom(mark, "POST", "/api/meetings/m-one/messages") === 1, "messages=" + countFrom(mark, "POST", "/api/meetings/m-one/messages"));
  failMessages = null;
  await page.reload();
  await openMeeting("m-one", "Pricing move QA session");
  ok("denied500-reconciled", (await bodyText()).indexOf("Denied 500 lead") >= 0, "");
  const mark2 = reqLog.length;
  resetProbeState();
  failMessages = "once-403-denied";
  await page.reload();
  await openMeeting("m-one", "Pricing move QA session");
  const box2 = composer();
  await box2.fill("Denied 403 lead");
  await box2.press("Enter");
  await page.waitForFunction((t) => document.body.innerText.indexOf(t) >= 0, "Access changed", { timeout: 30000 });
  const t2 = await bodyText();
  ok("denied403-definitive", t2.indexOf("Reopen it from Boards, then resend") >= 0, t2.slice(0, 300));
  ok("denied403-single", countFrom(mark2, "POST", "/api/meetings/m-one/messages") === 1, "messages=" + countFrom(mark2, "POST", "/api/meetings/m-one/messages"));
  failMessages = null;
  const mark3 = reqLog.length;
  resetProbeState();
  runBehavior = "fail500-denied-once";
  await page.reload();
  await openMeeting("m-one", "Pricing move QA session");
  const box3 = composer();
  await box3.fill("Run denied 500 lead");
  await box3.press("Enter");
  await page.waitForFunction((t) => document.body.innerText.indexOf(t) >= 0, "Advisor responses failed", { timeout: 30000 });
  const card = page.locator("div[role=alert]").first();
  const cardText = await card.innerText();
  ok("run500-saved", cardText.indexOf("lead message is saved") >= 0, cardText.slice(0, 300));
  ok("run500-no-access", cardText.indexOf("Access changed") < 0, cardText.slice(0, 300));
  ok("run500-lead-once", countFrom(mark3, "POST", "/api/meetings/m-one/messages") === 1, "messages=" + countFrom(mark3, "POST", "/api/meetings/m-one/messages"));
  ok("run500-run-once", countFrom(mark3, "POST", "/api/meetings/m-one/run") === 1, "run=" + countFrom(mark3, "POST", "/api/meetings/m-one/run"));
}
async function testHeldPatchOverlapNewSurvives() {
  const mark = reqLog.length;
  resetProbeState();
  capsOverride = { board: "contribute", meeting: null, meetings: ["m-one", "m-two", "m-empty"], guest: false, admin: false };
  gates.patch = deferred();
  gates.run = deferred();
  await page.reload();
  await openMeeting("m-empty", "Empty brief session");
  const box = composer();
  await box.fill("Overlap first lead");
  await box.press("Enter");
  await page.waitForFunction((t) => document.body.innerText.indexOf(t) >= 0, "Requesting advisor responses...", { timeout: 30000 });
  await sleep(400);
  ok("overlap-no-run-yet", countFrom(mark, "POST", "/api/meetings/m-empty/run") === 0, "run=" + countFrom(mark, "POST", "/api/meetings/m-empty/run"));
  await page.evaluate((h) => { window.location.hash = h; }, "#/people?board=b-alpha&meeting=m-empty");
  await page.getByRole("heading", { name: "Act as (demo identity for grant checks)", exact: true }).waitFor({ timeout: 15000 });
  await page.getByLabel("Act as user").fill("owner");
  await page.getByRole("button", { name: "Apply identity" }).click();
  await sleep(800);
  await page.evaluate((h) => { window.location.hash = h; }, "#/meet?board=b-alpha&meeting=m-empty");
  await page.getByRole("heading", { name: "Empty brief session", exact: true }).waitFor({ timeout: 20000 });
  await composer().fill("Overlap second lead");
  await composer().press("Enter");
  await sleep(800);
  ok("overlap-two-leads", countFrom(mark, "POST", "/api/meetings/m-empty/messages") === 2, "messages=" + countFrom(mark, "POST", "/api/meetings/m-empty/messages"));
  gates.patch.release();
  gates.patch = null;
  await sleep(1000);
  const tmid = await bodyText();
  ok("overlap-new-working", tmid.indexOf("Requesting advisor responses...") >= 0, tmid.slice(0, 300));
  ok("overlap-no-complete-yet", tmid.indexOf("Responses complete.") < 0, tmid.slice(0, 300));
  ok("overlap-no-run-yet2", countFrom(mark, "POST", "/api/meetings/m-empty/run") === 1, "run=" + countFrom(mark, "POST", "/api/meetings/m-empty/run"));
  ok("overlap-brief-new", (meetings["m-empty"] && meetings["m-empty"].brief === "Overlap second lead"), "brief=" + JSON.stringify(meetings["m-empty"] && meetings["m-empty"].brief));
  gates.run.release();
  gates.run = null;
  await page.waitForFunction((t) => document.body.innerText.indexOf(t) >= 0, "Responses complete.", { timeout: 30000 });
  ok("overlap-new-completes", true, "");
  ok("overlap-single-run", countFrom(mark, "POST", "/api/meetings/m-empty/run") === 1, "run=" + countFrom(mark, "POST", "/api/meetings/m-empty/run"));
  ok("overlap-two-leads-final", countFrom(mark, "POST", "/api/meetings/m-empty/messages") === 2, "messages=" + countFrom(mark, "POST", "/api/meetings/m-empty/messages"));
}
async function testPatchFailureReplyFrozen() {
  const mark = reqLog.length;
  resetProbeState();
  await page.reload();
  await openMeeting("m-one", "Pricing move QA session");
  const replyBtn = page.getByRole("button", { name: "Reply in thread" }).nth(1);
  await replyBtn.waitFor({ timeout: 15000 });
  await replyBtn.click();
  await sleep(300);
  const box = composer();
  await box.fill("Reply frost lead");
  await box.press("Enter");
  await page.waitForFunction((t) => document.body.innerText.indexOf(t) >= 0, "Responses complete.", { timeout: 30000 });
  ok("reply-lead-once", countFrom(mark, "POST", "/api/meetings/m-one/messages") === 1, "messages=" + countFrom(mark, "POST", "/api/meetings/m-one/messages"));
  ok("reply-parent", lastMessagesBody && lastMessagesBody.parentSequence === 2, JSON.stringify(lastMessagesBody));
  ok("reply-prompt-frozen", lastRunBody && lastRunBody.prompt === "Reply frost lead", JSON.stringify(lastRunBody));
  ok("reply-run-once", countFrom(mark, "POST", "/api/meetings/m-one/run") === 1, "run=" + countFrom(mark, "POST", "/api/meetings/m-one/run"));
  const mark2 = reqLog.length;
  resetProbeState();
  capsOverride = { board: "contribute", meeting: null, meetings: ["m-one", "m-two", "m-empty"], guest: false, admin: false };
  patchBehavior = "fail500-once";
  await page.reload();
  await openMeeting("m-empty", "Empty brief session");
  const box2 = composer();
  await box2.fill("Patch fail lead");
  await box2.press("Enter");
  await page.waitForFunction((t) => document.body.innerText.indexOf(t) >= 0, "Advisor responses failed", { timeout: 30000 });
  const cardText = await page.locator("div[role=alert]").first().innerText();
  ok("patchfail-terminal", cardText.indexOf("brief") >= 0 || cardText.indexOf("Brief") >= 0 || cardText.indexOf("responses") >= 0, cardText.slice(0, 300));
  ok("patchfail-lead-once", countFrom(mark2, "POST", "/api/meetings/m-empty/messages") === 1, "messages=" + countFrom(mark2, "POST", "/api/meetings/m-empty/messages"));
  ok("patchfail-no-run", countFrom(mark2, "POST", "/api/meetings/m-empty/run") === 0, "run=" + countFrom(mark2, "POST", "/api/meetings/m-empty/run"));
  gates.patch = deferred();
  const retryBtn = page.getByRole("button", { name: "Retry responses (same lead)" }).first();
  await retryBtn.waitFor({ timeout: 15000 });
  await retryBtn.click();
  await page.waitForFunction((t) => document.body.innerText.indexOf(t) >= 0, "Requesting advisor responses...", { timeout: 30000 });
  await sleep(600);
  ok("patchretry-no-run-yet", countFrom(mark2, "POST", "/api/meetings/m-empty/run") === 0, "run=" + countFrom(mark2, "POST", "/api/meetings/m-empty/run"));
  ok("patchretry-no-repost", countFrom(mark2, "POST", "/api/meetings/m-empty/messages") === 1, "messages=" + countFrom(mark2, "POST", "/api/meetings/m-empty/messages"));
  gates.patch.release();
  gates.patch = null;
  await page.waitForFunction((t) => document.body.innerText.indexOf(t) >= 0, "Responses complete.", { timeout: 30000 });
  ok("patchretry-run-once", countFrom(mark2, "POST", "/api/meetings/m-empty/run") === 1, "run=" + countFrom(mark2, "POST", "/api/meetings/m-empty/run"));
  ok("patchretry-prompt-frozen", lastRunBody && lastRunBody.prompt === "Patch fail lead", JSON.stringify(lastRunBody));
  ok("patchretry-still-once", countFrom(mark2, "POST", "/api/meetings/m-empty/messages") === 1, "messages=" + countFrom(mark2, "POST", "/api/meetings/m-empty/messages"));
}
async function main() {
  try {
    await launch();
    const only = (process.env.QA_ONLY || "").split(",").map((s) => s.trim()).filter((s) => !!s);
    const all = [testSendChainsRunOnce, testSecretaryRouting, testRunFailureRetryNoRepost, testProvider502Mapped, testLeadPostFailureHonest, testRapidEnterGuard, testHeldRunNavigationFrozen, testNoRespondersTerminal, testIdentityRetirement, testVersionConflictPin, testContributorBriefGate, testDiscussGuestNoPatch, testHeldPatchSingleRun, testApplyIdentityRetirement, testLateABANewOp, testLeadUncertainNoAutorepost, testSecretaryRetryVisible, testSendDeniedRequires4xx, testHeldPatchOverlapNewSurvives, testPatchFailureReplyFrozen];
    const tests = only.length ? all.filter((t) => only.indexOf(t.name) >= 0) : all;
    for (const t of tests) {
      try { await t(); } catch (e) { fail++; const m = t.name + " threw " + String((e && e.message) || e).slice(0, 600); failures.push(m); console.log("  FAIL " + m); outLine("FAIL " + m); try { outLine("PAGE-TAIL " + (await bodyText()).slice(-2500)); } catch (e2) {} }
    }
    const errs = page.__qaErrors || [];
    ok("no-page-errors", errs.length === 0, errs.slice(0, 5).join(" | ")); const badFallbacks = spaFallbacks.filter((p) => p !== "/favicon.ico"); ok("no-unexpected-404", badFallbacks.length === 0, badFallbacks.slice(0, 5).join(" | "));
  } finally {
    await closeAll();
  }
  console.log("PASS=" + pass + " FAIL=" + fail); outLine("PASS=" + pass + " FAIL=" + fail);
  if (failures.length) { console.log("FAILURES: " + failures.join(" ; ")); outLine("FAILURES: " + failures.join(" ; ")); }
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.log("FATAL " + String((e && e.stack) || e).slice(0, 500)); process.exit(2); });
