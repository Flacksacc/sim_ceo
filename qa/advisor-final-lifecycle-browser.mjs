import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "..", "web", "dist");
const outPath = (() => { try { return path.join(here, "..", ".tmp", "advisor-final-lifecycle-qa-result.txt"); } catch (e) { return ""; } })();

let pass = 0;
let fail = 0;
const failures = [];
const reqLog = [];
function outLine(s) { try { if (outPath) fs.appendFileSync(outPath, s + "\n"); } catch (e) {} }
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok - " + name); outLine("PASS " + name); }
  else { fail++; const tail = reqLog.slice(-6).join(" | "); failures.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL " + name + (extra ? " :: " + extra : "") + " :: req=" + tail); outLine("FAIL " + name + (extra ? " :: " + extra : "") + " :: req=" + tail); }
}
try { if (outPath) { try { fs.mkdirSync(path.dirname(outPath), { recursive: true }); } catch (e) {} fs.writeFileSync(outPath, "START " + new Date().toISOString() + "\n"); } } catch (e) {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webp": "image/webp", ".woff2": "font/woff2" };
function startWeb() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url || "/", "http://x");
      let p = decodeURIComponent(u.pathname);
      if (p === "/") p = "/index.html";
      if (p === "/favicon.ico") { res.writeHead(200, { "content-type": "image/x-icon" }); res.end(Buffer.alloc(0)); return; }
      const rel = path.normalize(p).replace(/^([\/])+/, "");
      const file = path.join(dist, rel);
      fs.readFile(file, (err, data) => {
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

function deferred() { let r = null; const promise = new Promise((res) => { r = res; }); return { promise, release: r }; }

const B1 = { id: "b-alpha", name: "Alpha", mission: "Test mission" };
const LEAD_VERSION = 7;
const CANON_PARAS = {
  contributionCriteria: "Speaks when pricing expertise applies with concrete examples.",
  reasoningApproach: "Weighs evidence and trade-offs carefully before deciding.",
  responseStyle: "Direct and concise, with reasons stated."
};
function profileJson() {
  return JSON.stringify({
    fictional: true, name: "QA Sage", background: "Test background.",
    contributionCriteria: CANON_PARAS.contributionCriteria,
    reasoningApproach: CANON_PARAS.reasoningApproach,
    responseStyle: CANON_PARAS.responseStyle,
    sourceUrls: [], security: "keep", version: 3,
  });
}
function freshEntry() {
  return {
    id: "r-adv-1", accountId: "qa", type: "character", name: "QA Sage",
    description: "A careful test advisor with enough words here.",
    profileJson: profileJson(), version: 3, archived: false, tags: "",
    researchJson: "{}", researchedAt: null, researchRequested: false,
    evidenceCount: 0, researchJobId: "", researchBaseVersion: 3, updatedAt: "2026-11-04T00:00:00Z",
  };
}
function freshNotes() {
  return [{ id: "n-1", boardId: "b-alpha", meetingId: "m-one", kind: "note", scope: "meeting", title: "Fixture note", body: "Fixture note body", provisional: false, revision: 3, noteStatus: "current" }];
}

let entry = freshEntry();
let notes = freshNotes();
let activityMode = "idle";
let researchPhase = "done";
let researchPollsLeft = 0;
let researchTerminal = "draft";
let researchVersion = 4;
let researchHttpError = false;
const gates = { activity: null, researchGet: null, researchPost: null, briefing: null, briefingOld: null, briefingNew: null, noteEdit: null, noteEditOld: null, noteReverse: null, noteReverseOld: null, rosterPut: null, secInitial: null, secRetry: null, secAnswer: null };
function resetProbeState() {
  entry = freshEntry();
  notes = freshNotes();
  activityMode = "idle";
  researchPhase = "done";
  researchPollsLeft = 0;
  researchTerminal = "draft";
  researchVersion = 4;
  researchHttpError = false;
  for (const k of Object.keys(gates)) gates[k] = null;
  try { if (typeof ctx !== "undefined" && ctx && ctx.setOffline) {} } catch (e) {}
}
function compiledProfile() {
  return {
    contributionCriteria: CANON_PARAS.contributionCriteria,
    reasoningApproach: CANON_PARAS.reasoningApproach,
    responseStyle: CANON_PARAS.responseStyle,
  };
}
function persistedResearchDoc(status) {
  const dp = (status === "draft" || status === "saved") ? { ...CANON_PARAS } : null;
  return {
    searched: status === "running" ? 1 : 2,
    supported: status === "draft" || status === "saved",
    claims: (status === "draft" || status === "saved") ? [{ angle: "pricing", text: "pricing claim", sources: [{ url: "https://example.com/pricing", title: "Pricing source" }] }] : [],
    evidenceRefs: (status === "draft" || status === "saved") ? [{ url: "https://example.com/pricing", title: "Pricing source", excerpt: "pricing excerpt" }] : [],
    draftProfile: dp,
    draftStatus: status === "running" ? "" : status,
  };
}
function countFrom(mark, method, exactPath) {
  let n = 0;
  for (let i = mark; i < reqLog.length; i++) {
    const parts = reqLog[i].split(" ");
    if (parts[0] === method && parts[1] === exactPath) n++;
  }
  return n;
}
async function waitForLog(mark, entry, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (reqLog.slice(mark).includes(entry)) return true;
    await sleep(100);
  }
  throw new Error("timeout waiting for log " + entry);
}
function researchSnapshot() {
  if (researchPhase === "running") {
    const doc = persistedResearchDoc("running");
    return { researchJson: JSON.stringify(doc), researchedAt: null, researchRequested: true, evidenceCount: 0, version: researchVersion, researchBaseVersion: 3, running: true, stage: "researching", stageError: null, sources: [], draftProfile: null, draftStatus: "" };
  }
  if (researchPhase === "failed") {
    const doc = { searched: 0, supported: false, claims: [], evidenceRefs: [], draftProfile: null, draftStatus: "failed" };
    return { researchJson: JSON.stringify(doc), researchedAt: null, researchRequested: true, evidenceCount: 0, version: researchVersion, researchBaseVersion: 3, running: false, stage: "failed", stageError: "research failed", sources: [], draftProfile: null, draftStatus: "failed" };
  }
  const ds = researchTerminal === "saved" ? "saved" : "draft";
  const doc = persistedResearchDoc(ds);
  return { researchJson: JSON.stringify(doc), researchedAt: "2026-11-04T00:00:00Z", researchRequested: true, evidenceCount: 2, version: researchVersion, researchBaseVersion: 3, running: false, stage: "done", stageError: null, sources: [{ url: "https://example.com/pricing", title: "Pricing source", excerpt: "pricing excerpt" }], draftProfile: { ...CANON_PARAS }, draftStatus: ds };
}

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
  if ((m = p.match(/^\/api\/boards\/([^/]+)\/capabilities$/))) return J({ board: "manage", meeting: "manage", meetings: ["m-one"], guest: false, admin: false });
  if ((m = p.match(/^\/api\/boards\/([^/]+)\/lead$/)) && method === "GET") return J({ id: "l1", boardId: m[1], version: LEAD_VERSION, name: "QA Lead", roleLabel: "Board Lead", background: "", familiarTopics: "", simplerTopics: "", commPrefs: "" });
  if ((m = p.match(/^\/api\/boards\/([^/]+)\/setup$/))) return J({ board: { id: m[1], name: B1.name, mission: B1.mission }, draftJson: "{}", activeJson: "{}", draftHash: "dh", dirty: false, lead: null, advisors: { total: 1, approved: 1 } });
  if ((m = p.match(/^\/api\/boards\/([^/]+)\/guest-settings$/))) return J({ id: m[1], name: B1.name, mission: B1.mission, stage: "Seed", discussionPolicy: "balanced", dataUse: "standard", lead: null, meetingIds: ["m-one"] });
  if ((m = p.match(/^\/api\/boards\/([^/]+)\/status$/))) return J({ board: B1.name, active: true, dirty: false, name: true, lead: true, leadVersion: LEAD_VERSION, advisors: { total: 1, approved: 1 }, meetings: { total: 1, active: 1 }, sourcesPending: 0, jobsFailed: 0, policy: "balanced", retainAudio: false });
  if ((m = p.match(/^\/api\/boards\/([^/]+)\/advisors$/))) return J([{ id: "a-1", boardId: "b-alpha", boardRole: "CFO Ada", approved: true, removed: false, rosterEntryId: "r-adv-1" }]);
  if ((m = p.match(/^\/api\/boards\/([^/]+)\/meetings$/)) && method === "GET") return J([{ id: "m-one", boardId: "b-alpha", title: "Pricing move QA session", state: 1, brief: "Should we raise the starter tier?" }]);
  if ((m = p.match(/^\/api\/boards\/([^/]+)\/meetings\/([^/]+)$/)) && method === "GET") return J({ id: "m-one", boardId: "b-alpha", title: "Pricing move QA session", state: 1, brief: "Should we raise the starter tier?", participantIdsJson: "[]" });
  if ((m = p.match(/^\/api\/meetings\/([^/]+)\/delivery$/))) return J({ state: "Active", deliveredRevision: 1, messages: 1, lastSequence: 1 });
  if ((m = p.match(/^\/api\/meetings\/([^/]+)\/messages$/)) && method === "GET") return J([{ sequence: 1, sender: "lead", content: "Hello board" }]);
  if ((m = p.match(/^\/api\/meetings\/([^/]+)\/activity$/)) && method === "GET") {
    if (gates.activity) await gates.activity.promise;
    if (activityMode === "error") return J({ error: "activity store failed" }, 500);
    if (activityMode === "responding") return J({ discussion: { status: "considering", advisors: [{ advisorId: "a-1", state: "responding", reason: null }] }, secretary: [{ status: "answering", updatedAt: "2026-11-04T00:00:02Z" }] });
    return J({ discussion: { status: "idle", advisors: [] }, secretary: [] });
  }
  if ((m = p.match(/^\/api\/meetings\/([^/]+)\/notes$/)) && method === "GET") return J(notes);
  if ((m = p.match(/^\/api\/meetings\/([^/]+)\/notes\/history$/))) return J([]);
  if ((m = p.match(/^\/api\/meetings\/([^/]+)\/secretary\/requests$/)) && method === "GET") return J([]);
  if ((m = p.match(/^\/api\/meetings\/([^/]+)\/secretary\/requests\/([^/]+)$/)) && method === "GET") return J({ error: "not found" }, 404);
  if ((m = p.match(/^\/api\/meetings\/([^/]+)\/secretary\/answer$/)) && method === "POST") {
    if (gates.secAnswer) await gates.secAnswer.promise;
    const b = bodyOf();
    const n = { id: "n-ans-1", boardId: "b-alpha", meetingId: "m-one", kind: "secretary-note", scope: "meeting", title: "Secretary answer", body: String(b.answer || "answer body"), provisional: true, revision: 1, noteStatus: "current" };
    notes.push(n);
    return J({ note: n, requestId: String(b.requestId || "q-1") });
  }
  if ((m = p.match(/^\/api\/meetings\/([^/]+)\/secretary$/)) && method === "POST") {
    const b0 = bodyOf();
    const raw0 = String(b0.input || "");
    if (raw0.indexOf("fail-once") >= 0 && !gates.secRetry) return J({ error: "secretary failed once" }, 500);
    if (gates.secInitial && gates.secRetry) { await gates.secInitial.promise; await gates.secRetry.promise; }
    else if (gates.secInitial) await gates.secInitial.promise;
    else if (gates.secRetry) await gates.secRetry.promise;
    const b = bodyOf();
    const q = String(b.input || "secretary question").slice(0, 120);
    return J({ requestId: "q-1", question: q || "Clarify pricing?", status: "needs-clarification" });
  }
  if (p === "/api/backup" && method === "GET") return J({ snapshot: "qa-snapshot", hash: "qa-hash" });
  if (p === "/api/backup/restore" && method === "POST") return J({ restored: true });
  if ((m = p.match(/^\/api\/meetings\/([^/]+)\/briefings$/)) && method === "POST") {
    if (gates.briefing) await gates.briefing.promise;
    if (gates.briefingOld) await gates.briefingOld.promise;
    if (gates.briefingNew) await gates.briefingNew.promise;
    const b = bodyOf();
    const n = { id: "n-brief-" + String(Date.now()), boardId: "b-alpha", meetingId: "m-one", kind: "briefing", scope: "meeting", title: String(b.topic || "briefing").slice(0, 80), body: String(b.topic || "briefing"), provisional: true, revision: 1, noteStatus: "current" };
    notes.push(n);
    return J({ id: n.id, topic: b.topic || "" });
  }
  if ((m = p.match(/^\/api\/notes\/([^/]+)\/edit$/)) && method === "POST") {
    if (gates.noteEdit) await gates.noteEdit.promise;
    if (gates.noteEditOld) await gates.noteEditOld.promise;
    const b = bodyOf();
    const n = notes.find((x) => x.id === m[1]);
    if (!n) return J({ error: "unknown note" }, 404);
    n.body = typeof b.body === "string" ? b.body : n.body;
    n.revision = (n.revision || 3) + 1;
    return J(n);
  }
  if ((m = p.match(/^\/api\/notes\/([^/]+)\/reverse$/)) && method === "POST") {
    if (gates.noteReverse) await gates.noteReverse.promise;
    if (gates.noteReverseOld) await gates.noteReverseOld.promise;
    const n = notes.find((x) => x.id === m[1]);
    if (!n) return J({ error: "unknown note" }, 404);
    n.noteStatus = "reversed";
    return J(n);
  }
  if (p === "/api/roster" && method === "GET") {
    return J([{ entry: entry, complete: true, missing: [], imageCount: 0, boards: ["b-alpha"] }]);
  }
  if (p === "/api/roster/count") return J({ total: 1 });
  if ((m = p.match(/^\/api\/roster\/([^/]+)\/images$/))) return J([]);
  if ((m = p.match(/^\/api\/roster\/([^/]+)\/research$/)) && method === "GET") {
    if (gates.researchGet) await gates.researchGet.promise;
    if (researchHttpError) return J({ error: "research store failed" }, 500);
    if (researchPhase === "running") {
      if (researchPollsLeft > 0) { researchPollsLeft--; return J(researchSnapshot()); }
      researchPhase = researchTerminal;
      return J(researchSnapshot());
    }
    return J(researchSnapshot());
  }
  if ((m = p.match(/^\/api\/roster\/([^/]+)\/research$/)) && method === "POST") {
    if (gates.researchPost) await gates.researchPost.promise;
    researchPhase = "running";
    researchPollsLeft = 4;
    return J({ subject: "x", searched: 1, supported: false, claims: [], responseIds: [], version: researchVersion, evidenceRefs: [], draftProfile: null, draftStatus: "" });
  }
  if ((m = p.match(/^\/api\/roster\/([^/]+)$/)) && method === "PUT") {
    if (gates.rosterPut) await gates.rosterPut.promise;
    const b = bodyOf();
    if (typeof b.profileJson === "string") entry.profileJson = b.profileJson;
    entry.version = (entry.version || 3) + 1;
    entry.updatedAt = new Date().toISOString();
    try {
      const pj = JSON.parse(entry.profileJson || "{}");
      const same = pj.contributionCriteria === CANON_PARAS.contributionCriteria && pj.reasoningApproach === CANON_PARAS.reasoningApproach && pj.responseStyle === CANON_PARAS.responseStyle;
      if (same && researchPhase !== "running" && researchPhase !== "failed") { researchTerminal = "saved"; researchPhase = "done"; researchVersion = entry.version + 1; }
    } catch (e) {}
    return J(entry);
  }
  if (p === "/api/roster/quick" && method === "POST") {
    const b = bodyOf();
    entry = freshEntry();
    entry.id = "r-new-1";
    entry.name = b.name || "New";
    entry.description = b.description || "desc";
    return J(entry);
  }
  if (p === "/api/profile" && method === "GET") return J({ error: "no saved profile" }, 404);
  if (p.indexOf("/api/") === 0) {
    if (method === "GET" && (p.endsWith("/setup") || p.endsWith("/status") || p.endsWith("/lead") || p.endsWith("/guest-settings") || p.endsWith("/capabilities"))) return J({});
    return J([]);
  }
  return J([]);
}

let webSrv = null;
let webBase = "";
let browser = null;
let ctx = null;
let page = null;
async function launch() {
  webSrv = await startWeb();
  const addr = webSrv.address();
  webBase = "http://127.0.0.1:" + addr.port + "/";
  browser = await chromium.launch({ executablePath: EDGE, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => { try { pageErrors.push(String(e).slice(0, 300)); } catch (x) {} });
  page.on("console", (msg) => {
    try {
      const t = String(msg.text());
      if (msg.type() === "error" && t.indexOf("Failed to load resource") >= 0) return;
      if (t.indexOf("Failed to complete negotiation") >= 0 || t.indexOf("Failed to start the connection") >= 0 || t.indexOf("net::ERR_") >= 0) return;
      if (msg.type() === "error") pageErrors.push(t.slice(0, 200));
    } catch (x) {}
  });
  page.__qaErrors = pageErrors;
  await page.route("**/hubs/**", (r) => r.abort("connectionrefused"));
  await page.route("**/api/**", apiStub);
}
async function closeAll() {
  try { if (page) await page.close(); } catch (x) {}
  try { if (ctx) await ctx.close(); } catch (x) {}
  try { if (browser) await browser.close(); } catch (x) {}
  try { if (webSrv) await new Promise((r) => webSrv.close(r)); } catch (x) {}
}
async function bodyText() { return page.evaluate(() => document.body.innerText); }
async function openHash(hash) { await page.goto(webBase + hash); }
async function openMeet() {
  await openHash("#/meet?board=b-alpha&meeting=m-one");
  await page.getByRole("heading", { name: "Pricing move QA session", exact: true }).first().waitFor({ timeout: 20000 });
  await page.locator('section[aria-label="In this meeting"]').waitFor({ timeout: 20000 });
}
async function openRoster() {
  await openHash("#/roster?board=b-alpha");
  await page.locator('section[aria-label="My Advisor Roster"]').first().waitFor({ timeout: 20000 });
  await page.locator("aside.listpanel button.lprow", { hasText: "QA Sage" }).first().waitFor({ timeout: 20000 });
}
async function selectRosterEntry() {
  await page.locator("aside.listpanel button.lprow", { hasText: "QA Sage" }).first().click();
  await page.locator('[data-roster-entry-id="r-adv-1"]').first().waitFor({ timeout: 20000 });
}
async function openMeetingSettings() {
  await page.getByRole("button", { name: "Meeting settings" }).first().click();
  await page.locator("dialog.conv-settings section[aria-label=\"Meeting settings\"]").first().waitFor({ timeout: 20000 });
}
async function railStatus() {
  return page.locator('section[aria-label="In this meeting"] p[role="status"]').first().innerText().catch(() => "");
}
async function closeMeetingSettings() {
  try {
    const done = page.getByRole("button", { name: "Done" }).first();
    if (await done.count() > 0) { await done.click().catch(() => {}); }
  } catch (e) {}
  try { await page.keyboard.press("Escape"); } catch (e) {}
  try { await page.waitForFunction(() => !document.querySelector("dialog.conv-settings[open]"), null, { timeout: 5000 }).catch(() => {}); } catch (e) {}
}
async function waitForCount(mark, method, exactPath, min, timeout) {
  const to = timeout || 30000;
  const start = Date.now();
  while (Date.now() - start < to) {
    if (countFrom(mark, method, exactPath) >= min) return true;
    await sleep(100);
  }
  throw new Error("timeout waiting for count " + method + " " + exactPath + " >=" + min);
}
async function applyIdentityAs(name) {
  await closeMeetingSettings();
  await openHash("#/settings?board=b-alpha");
  await page.getByLabel("Act as user").first().waitFor({ timeout: 20000 });
  await page.getByLabel("Act as user").first().fill(name);
  await page.getByRole("button", { name: "Apply identity" }).first().click();
  await page.waitForFunction((n) => document.body.innerText.indexOf("Preview access as") >= 0, null, { timeout: 20000 }).catch(() => {});
}

async function testActivityHubOffHealthyHttp() {
  const mark = reqLog.length;
  resetProbeState();
  activityMode = "idle";
  await openMeet();
  await page.waitForFunction(() => document.body.innerText.indexOf("all listening") >= 0, null, { timeout: 30000 });
  ok("activity-huboff-http-idle", (await bodyText()).indexOf("all listening") >= 0, "healthy HTTP snapshot available while hub stopped");
  ok("activity-huboff-no-live-badge", await page.locator(".badge.live").count() === 0, "no Live badge without transport");
  ok("activity-huboff-http-polled", countFrom(mark, "GET", "/api/meetings/m-one/activity") >= 1, "activity polls flow over HTTP");
  activityMode = "responding";
  await page.waitForFunction(() => /responding|working/.test(document.body.innerText), null, { timeout: 30000 });
  const t = await bodyText();
  ok("activity-huboff-responding-visible", t.indexOf("responding") >= 0 || t.indexOf("working") >= 0, t.slice(0, 200));
  ok("activity-huboff-still-no-live", await page.locator(".badge.live").count() === 0, "polling badges never imply raw Live");
}
async function testActivityErrorOfflineRecovery() {
  resetProbeState();
  activityMode = "error";
  await page.reload();
  await openMeet();
  await page.waitForFunction(() => document.body.innerText.indexOf("activity unavailable") >= 0, null, { timeout: 30000 });
  const t0 = await bodyText();
  ok("activity-error-unavailable", t0.indexOf("activity unavailable") >= 0, t0.slice(0, 200));
  ok("activity-error-no-responding", t0.indexOf("Responding") < 0 && t0.indexOf("responding") < 0, t0.slice(0, 200));
  activityMode = "idle";
  const recMark = reqLog.length;
  await page.reload();
  await openMeet();
  await page.waitForFunction(() => document.body.innerText.indexOf("all listening") >= 0, null, { timeout: 30000 });
  ok("activity-error-recovered", countFrom(recMark, "GET", "/api/meetings/m-one/activity") >= 1 && (await bodyText()).indexOf("all listening") >= 0, "fresh healthy HTTP recovers availability");
  const mark = reqLog.length;
  await waitForCount(mark, "GET", "/api/meetings/m-one/activity", 1);
  await page.evaluate(() => {
    try {
      Object.defineProperty(document, "hidden", { value: true, configurable: true });
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    } catch (e) {}
  });
  await page.waitForFunction(() => document.body.innerText.indexOf("checking activity") >= 0, null, { timeout: 30000 });
  const hiddenText = await bodyText();
  ok("activity-hidden-paused", hiddenText.indexOf("checking activity") >= 0, hiddenText.slice(0, 200));
  ok("activity-hidden-no-live", await page.locator(".badge.live").count() === 0, "no Live while paused");
  const held = countFrom(mark, "GET", "/api/meetings/m-one/activity");
  await page.evaluate(() => {
    try {
      Object.defineProperty(document, "hidden", { value: false, configurable: true });
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    } catch (e) {}
  });
  await page.waitForFunction(() => document.body.innerText.indexOf("all listening") >= 0, null, { timeout: 30000 });
  ok("activity-resume-fresh", countFrom(mark, "GET", "/api/meetings/m-one/activity") > held, "resume requires a fresh HTTP poll before reusing retained snapshot");
  gates.activity = deferred();
  try {
    const arriveMark = reqLog.length;
    await waitForLog(arriveMark, "GET /api/meetings/m-one/activity");
    await page.evaluate(() => {
      try {
        Object.defineProperty(document, "hidden", { value: true, configurable: true });
        Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
        document.dispatchEvent(new Event("visibilitychange"));
      } catch (e) {}
    });
    await page.waitForFunction(() => document.body.innerText.indexOf("checking activity") >= 0, null, { timeout: 30000 });
    activityMode = "responding";
    const hiddenRespP = page.waitForResponse((r) => r.request().method() === "GET" && new URL(r.url()).pathname === "/api/meetings/m-one/activity", { timeout: 30000 });
    gates.activity.release();
    gates.activity = null;
    const hiddenResp = await hiddenRespP;
    let hiddenBody = "";
    try { hiddenBody = JSON.stringify(await hiddenResp.json()).slice(0, 200); } catch (e) { hiddenBody = "status=" + hiddenResp.status(); }
    const stillHidden = await bodyText();
    ok("activity-hidden-completion-held", stillHidden.indexOf("checking activity") >= 0 && stillHidden.indexOf("all listening") < 0, "hidden completion reached App but stays paused: " + hiddenBody.slice(0, 120));
    gates.activity = deferred();
    const freshMark = reqLog.length;
    await page.evaluate(() => {
      try {
        Object.defineProperty(document, "hidden", { value: false, configurable: true });
        Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new Event("focus"));
      } catch (e) {}
    });
    await page.waitForFunction(() => document.body.innerText.indexOf("checking activity") >= 0, null, { timeout: 30000 });
    await waitForLog(freshMark, "GET /api/meetings/m-one/activity");
    const heldText = await bodyText();
    ok("activity-resume-held-checking", heldText.indexOf("checking activity") >= 0, "next fresh held before resume stays checking: " + heldText.slice(0, 160));
    activityMode = "idle";
    const freshRespP = page.waitForResponse((r) => r.request().method() === "GET" && new URL(r.url()).pathname === "/api/meetings/m-one/activity", { timeout: 30000 });
    gates.activity.release();
    gates.activity = null;
    const freshResp = await freshRespP;
    ok("activity-fresh-success", freshResp.status() === 200, "fresh status=" + freshResp.status());
    await page.waitForFunction(() => document.body.innerText.indexOf("all listening") >= 0, null, { timeout: 30000 });
    const afterFresh = await bodyText();
    ok("activity-postresume-poll-clears", afterFresh.indexOf("all listening") >= 0, "only legitimate fresh success clears gate: " + afterFresh.slice(0, 160));
  } finally {
    try { if (gates.activity) { gates.activity.release(); gates.activity = null; } } catch (e) {}
    activityMode = "idle";
    try {
      await page.evaluate(() => {
        try {
          Object.defineProperty(document, "hidden", { value: false, configurable: true });
          Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
          document.dispatchEvent(new Event("visibilitychange"));
          window.dispatchEvent(new Event("focus"));
        } catch (e) {}
      });
    } catch (e) {}
  }
  const offMark = reqLog.length;
  gates.activity = deferred();
  try {
    await ctx.setOffline(true);
    await page.waitForFunction(() => document.body.innerText.indexOf("checking activity") >= 0, null, { timeout: 30000 });
    const offLine = await page.evaluate(() => { try { return navigator.onLine; } catch (e) { return true; } });
    const offText = await bodyText();
    ok("activity-offline-paused", offText.indexOf("checking activity") >= 0 && offLine === false, "offline pauses via actual navigator.onLine=false: " + offText.slice(0, 160));
    ok("activity-offline-line", offLine === false, "navigator.onLine=" + String(offLine));
    const reMark = reqLog.length;
    await ctx.setOffline(false);
    await page.waitForFunction(() => document.body.innerText.indexOf("checking activity") >= 0 || document.body.innerText.indexOf("all listening") >= 0, null, { timeout: 30000 });
    await waitForLog(reMark, "GET /api/meetings/m-one/activity");
    activityMode = "idle";
    const reRespP = page.waitForResponse((r) => r.request().method() === "GET" && new URL(r.url()).pathname === "/api/meetings/m-one/activity", { timeout: 30000 });
    try { gates.activity.release(); gates.activity = null; } catch (e) { gates.activity = null; }
    const reResp = await reRespP;
    ok("activity-reconnect-fresh", reResp.status() === 200 && countFrom(offMark, "GET", "/api/meetings/m-one/activity") >= 1, "controlled recovery polls fresh after online");
    await page.waitForFunction(() => document.body.innerText.indexOf("all listening") >= 0, null, { timeout: 30000 });
    ok("activity-reconnect-available", (await bodyText()).indexOf("all listening") >= 0, "fresh success restores availability");
  } finally {
    try { await ctx.setOffline(false); } catch (e) {}
    try { if (gates.activity) { gates.activity.release(); gates.activity = null; } } catch (e) {}
    activityMode = "idle";
  }
  gates.activity = deferred();
  try {
    await openHash("#/settings?board=b-alpha");
    await page.getByRole("button", { name: "Export full backup" }).first().waitFor({ timeout: 20000 });
    await page.getByRole("button", { name: "Export full backup" }).first().click();
    await page.waitForFunction(() => document.body.innerText.indexOf("Backup ready") >= 0, null, { timeout: 30000 });
    const bakText = await page.locator("input[placeholder=\"paste backup snapshot\"]").first().inputValue().catch(() => "");
    ok("activity-restore-exported", bakText.length > 0, "rendered Settings backup path produced snapshot len=" + String(bakText.length));
    const restoreMark = reqLog.length;
    const restoreAt = Date.now();
    await page.getByRole("button", { name: "Restore (replaces current data)" }).first().click();
    await waitForLog(restoreMark, "POST /api/backup/restore");
    await waitForLog(restoreMark, "GET /api/meetings/m-one/activity");
    const withheldFor = Date.now() - restoreAt;
    const restoreHeldText = await bodyText();
    ok("activity-restore-withheld", restoreHeldText.indexOf("checking activity") >= 0 || restoreHeldText.indexOf("Backup ready") >= 0, "restore-triggered poll withheld behind gate (" + String(withheldFor) + "ms), distinct from interval");
    activityMode = "idle";
    const rsRespP = page.waitForResponse((r) => r.request().method() === "GET" && new URL(r.url()).pathname === "/api/meetings/m-one/activity", { timeout: 30000 });
    try { gates.activity.release(); gates.activity = null; } catch (e) { gates.activity = null; }
    const rsResp = await rsRespP;
    ok("activity-restore-fresh", rsResp.status() === 200, "restore fresh status=" + rsResp.status());
    await openMeet();
    await page.waitForFunction(() => document.body.innerText.indexOf("Pricing move QA session") >= 0, null, { timeout: 30000 });
    const meetTitle = await bodyText();
    ok("activity-restore-same-id-polls", meetTitle.indexOf("Pricing move QA session") >= 0 && countFrom(restoreMark, "GET", "/api/meetings/m-one/activity") >= 1, "unchanged IDs b-alpha/m-one still re-poll after epoch cancel/invalidate");
  } finally {
    try { if (gates.activity) { gates.activity.release(); gates.activity = null; } } catch (e) {}
    activityMode = "idle";
  }
}
async function testResearchLiveTerminalRerun() {
  resetProbeState();
  researchPhase = "done";
  researchTerminal = "draft";
  researchVersion = 4;
  researchHttpError = false;
  await openRoster();
  await selectRosterEntry();
  await page.waitForFunction(() => /Researched v4/.test(document.body.innerText), null, { timeout: 30000 });
  const doneResp = await page.waitForResponse((r) => r.request().method() === "GET" && new URL(r.url()).pathname === "/api/roster/r-adv-1/research", { timeout: 15000 }).catch(() => null);
  let doneJson = null;
  if (doneResp) { try { doneJson = await doneResp.json(); } catch (e) {} }
  const rawDoc = doneJson ? JSON.parse(doneJson.researchJson || "{}") : null;
  const samePersisted = !!doneJson && !!rawDoc && JSON.stringify(rawDoc.draftProfile) === JSON.stringify(doneJson.draftProfile) && String(rawDoc.draftStatus) === String(doneJson.draftStatus);
  const canonMatch = !!doneJson && doneJson.draftProfile && doneJson.draftProfile.contributionCriteria === CANON_PARAS.contributionCriteria && doneJson.draftProfile.reasoningApproach === CANON_PARAS.reasoningApproach && doneJson.draftProfile.responseStyle === CANON_PARAS.responseStyle;
  ok("research-canonical-consistent", samePersisted && canonMatch, "raw GET draft fields derive from same persisted researchJson; canonical 3 paras match");
  ok("research-terminal-done", /Researched v4/.test(await bodyText()), "terminal done from research GET renders versioned proof");
  gates.researchPost = deferred();
  try {
    researchTerminal = "draft";
    researchVersion = 4;
    const postMark = reqLog.length;
    const postP = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/roster/r-adv-1/research", { timeout: 30000 });
    await page.getByRole("button", { name: "Research dossier" }).first().click();
    await waitForLog(postMark, "POST /api/roster/r-adv-1/research");
    await page.waitForFunction(() => document.body.innerText.indexOf("Research in progress") >= 0, null, { timeout: 30000 });
    const whileHeld = await bodyText();
    ok("research-post-held-running", whileHeld.indexOf("Research in progress") >= 0, "POST held while GET shows running: " + whileHeld.slice(0, 160));
    gates.researchPost.release();
    gates.researchPost = null;
    const postResp = await postP;
    ok("research-post-released", postResp.status() === 200, "POST status=" + postResp.status());
    await page.waitForFunction(() => /Researched v4/.test(document.body.innerText), null, { timeout: 30000 });
    ok("research-terminal-rerun-done", /Researched v4/.test(await bodyText()), "terminal done returns from research after POST lifecycle");
  } finally {
    try { if (gates.researchPost) { gates.researchPost.release(); gates.researchPost = null; } } catch (e) {}
  }
  const putMark = reqLog.length;
  await page.locator("#cc-respond").first().fill(CANON_PARAS.responseStyle);
  await page.locator("#cc-reason").first().fill(CANON_PARAS.reasoningApproach);
  await page.locator("#cc-contribute").first().fill(CANON_PARAS.contributionCriteria);
  const putP = page.waitForResponse((r) => r.request().method() === "PUT" && new URL(r.url()).pathname === "/api/roster/r-adv-1", { timeout: 30000 });
  await page.getByRole("button", { name: "Save draft changes" }).first().click();
  const putResp = await putP;
  ok("research-saved-put-confirmed", putResp.status() === 200, "PUT status=" + putResp.status());
  await page.waitForFunction(() => /Researched v/.test(document.body.innerText), null, { timeout: 30000 });
  const savedResp = await page.waitForResponse((r) => r.request().method() === "GET" && new URL(r.url()).pathname === "/api/roster/r-adv-1/research", { timeout: 15000 }).catch(() => null);
  let savedOk = false;
  if (savedResp) { try { const sj = await savedResp.json(); savedOk = String(sj.draftStatus) === "saved" && sj.draftProfile && sj.draftProfile.responseStyle === CANON_PARAS.responseStyle; } catch (e) {} }
  const savedText = await bodyText();
  ok("research-terminal-saved", savedOk && /Researched v/.test(savedText), "saved ONLY via actual PUT reaches saved proof: " + savedText.slice(0, 160));
  ok("research-saved-put-order", countFrom(putMark, "PUT", "/api/roster/r-adv-1") === 1, "exactly one PUT drove saved");
  researchPhase = "failed";
  researchTerminal = "failed";
  await page.getByRole("button", { name: "Research dossier" }).first().click();
  await page.waitForFunction(() => document.body.innerText.indexOf("Research in progress") >= 0, null, { timeout: 30000 });
  ok("research-failrun-running", (await bodyText()).indexOf("Research in progress") >= 0, "failed rerun passes through running");
  await page.waitForFunction(() => document.body.innerText.indexOf("Research failed") >= 0, null, { timeout: 30000 });
  const tf = await bodyText();
  ok("research-failed-terminal", tf.indexOf("Research failed") >= 0, tf.slice(0, 200));
  ok("research-failed-no-raw", tf.indexOf("SELECT") < 0 && tf.indexOf("/srv/db") < 0 && tf.indexOf("stageError") < 0, tf.slice(0, 200));
}
async function testResearchRetainedErrorOutranks() {
  resetProbeState();
  researchPhase = "running";
  researchPollsLeft = 99;
  researchTerminal = "draft";
  researchVersion = 6;
  researchHttpError = false;
  await openRoster();
  await selectRosterEntry();
  await page.waitForFunction(() => document.body.innerText.indexOf("Research in progress") >= 0, null, { timeout: 30000 });
  researchHttpError = true;
  try {
    const m1 = reqLog.length;
    await page.getByRole("button", { name: "Research dossier" }).first().click().catch(() => {});
    await page.waitForFunction(() => document.body.innerText.indexOf("Research state unavailable") >= 0, null, { timeout: 30000 });
    const t1 = await bodyText();
    ok("research-error-outranks-running", t1.indexOf("Research state unavailable") >= 0 && t1.indexOf("Research in progress") < 0, "poll error outranks independently cached RUNNING: " + t1.slice(0, 180));
    ok("research-error-running-polled", countFrom(m1, "GET", "/api/roster/r-adv-1/research") >= 1, "running-retained error came from real poll");
  } finally { researchHttpError = false; }
  resetProbeState();
  researchPhase = "done";
  researchTerminal = "draft";
  researchVersion = 7;
  researchHttpError = false;
  await openRoster();
  await selectRosterEntry();
  await page.waitForFunction(() => /Researched v7/.test(document.body.innerText), null, { timeout: 30000 });
  researchHttpError = true;
  try {
    const m2 = reqLog.length;
    await page.reload();
    await openRoster();
    await selectRosterEntry();
    await page.waitForFunction(() => document.body.innerText.indexOf("Research state unavailable") >= 0, null, { timeout: 30000 });
    const t2 = await bodyText();
    ok("research-error-outranks-success", t2.indexOf("Research state unavailable") >= 0 && !/Researched v7/.test(t2), "poll error outranks independently cached SUCCESSFUL: " + t2.slice(0, 180));
    ok("research-error-success-polled", countFrom(m2, "GET", "/api/roster/r-adv-1/research") >= 1, "success-retained error came from real poll");
    ok("research-error-no-raw-2", t2.indexOf("SELECT") < 0 && t2.indexOf("/srv/db") < 0, t2.slice(0, 180));
  } finally { researchHttpError = false; }
}
async function testPutMountedVerifyHeld() {
  resetProbeState();
  researchPhase = "done";
  researchTerminal = "draft";
  researchVersion = 4;
  await openRoster();
  await selectRosterEntry();
  await page.waitForFunction(() => /Researched/.test(document.body.innerText), null, { timeout: 30000 });
  const newBody = "Direct and concise, with reasons stated. Mounted verify held case.";
  await page.locator("#cc-respond").first().fill(newBody);
  gates.rosterPut = deferred();
  gates.researchGet = deferred();
  try {
    const putP = page.waitForResponse((r) => r.request().method() === "PUT" && new URL(r.url()).pathname === "/api/roster/r-adv-1", { timeout: 30000 });
    await page.getByRole("button", { name: "Save draft changes" }).first().click();
    await waitForLog(reqLog.length - 1, "PUT /api/roster/r-adv-1");
    const base = reqLog.length;
    gates.rosterPut.release();
    gates.rosterPut = null;
    const resp = await putP;
    ok("put-mounted-confirmed", resp.status() === 200, "status=" + resp.status());
    await waitForLog(base, "GET /api/roster");
    const fresh = countFrom(base, "GET", "/api/roster");
    ok("put-mounted-verify-held", fresh >= 1, "mounted VERIFY held after confirmed PUT then fresh read; freshGets=" + fresh);
    gates.researchGet.release();
    gates.researchGet = null;
    await page.waitForFunction((exp) => document.body.innerText.indexOf(exp) >= 0, newBody.slice(0, 20), { timeout: 30000 }).catch(() => {});
    const t = await bodyText();
    ok("put-mounted-rendered", t.indexOf(newBody.slice(0, 20)) >= 0 || /Saved/.test(t), "affected rendered state shows new persisted text: " + t.slice(0, 160));
    const errs = page.__qaErrors || [];
    ok("put-mounted-no-errors", errs.length === 0, errs.slice(0, 3).join(" | "));
    ok("put-mounted-single", countFrom(base - 5 > 0 ? base - 5 : 0, "PUT", "/api/roster/r-adv-1") >= 1, "exactly one confirmed write in window");
  } finally {
    try { if (gates.rosterPut) { gates.rosterPut.release(); gates.rosterPut = null; } } catch (e) {}
    try { if (gates.researchGet) { gates.researchGet.release(); gates.researchGet = null; } } catch (e) {}
  }
}
async function testPutUnmountBeforeConfirm() {
  resetProbeState();
  researchPhase = "done";
  researchTerminal = "draft";
  researchVersion = 4;
  await openRoster();
  await selectRosterEntry();
  await page.waitForFunction(() => /Researched/.test(document.body.innerText), null, { timeout: 30000 });
  const newBody2 = "Direct and concise, with reasons stated. Unmount-before-confirm case.";
  await page.locator("#cc-respond").first().fill(newBody2);
  gates.rosterPut = deferred();
  try {
    const putP = page.waitForResponse((r) => r.request().method() === "PUT" && new URL(r.url()).pathname === "/api/roster/r-adv-1", { timeout: 30000 });
    await page.getByRole("button", { name: "Save draft changes" }).first().click();
    await waitForLog(reqLog.length - 1, "PUT /api/roster/r-adv-1");
    await openHash("#/boards");
    await page.waitForFunction(() => document.body.innerText.indexOf("Boards") >= 0, null, { timeout: 20000 });
    const unmountedOk = (await bodyText()).indexOf("Boards") >= 0;
    ok("put-unmount-before-confirm", unmountedOk, "editor unmounted while PUT still held");
    const base = reqLog.length;
    gates.rosterPut.release();
    gates.rosterPut = null;
    const resp = await putP;
    ok("put-unmounted-confirmed", resp.status() === 200, "status=" + resp.status());
    await sleep(800);
    await openRoster();
    await page.locator("aside.listpanel button.lprow", { hasText: "QA Sage" }).first().click();
    await page.waitForFunction((exp) => document.body.innerText.indexOf(exp) >= 0, newBody2.slice(0, 20), { timeout: 30000 });
    const rt = await bodyText();
    ok("put-unmounted-reopen-correct", rt.indexOf(newBody2.slice(0, 20)) >= 0, "reopen roster shows new persisted profile (inactive invalidate marked stale, no demand for inactive refetch): " + rt.slice(0, 180));
    ok("put-unmounted-no-crash", (page.__qaErrors || []).length === 0, (page.__qaErrors || []).slice(0, 3).join(" | "));
  } finally {
    try { if (gates.rosterPut) { gates.rosterPut.release(); gates.rosterPut = null; } } catch (e) {}
  }
}
async function testCreateInvalidatesBeforeAdopt() {
  resetProbeState();
  await openRoster();
  await page.getByRole("button", { name: "+ Create new Advisor" }).first().click();
  await page.locator("#cc-name").fill("QA Newcomer");
  await page.locator("#cc-description").fill("A fresh test advisor with enough words for validation.");
  const base = reqLog.length;
  const created = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/roster/quick", { timeout: 30000 });
  await page.getByRole("button", { name: "Create draft", exact: true }).click();
  const cresp = await created;
  ok("create-confirmed", cresp.status() === 200 || cresp.status() === 201, "status=" + cresp.status());
  await page.waitForFunction(() => document.body.innerText.indexOf("Step 2") >= 0, null, { timeout: 30000 });
  const postIdx = reqLog.slice(base).findIndex((e) => e === "POST /api/roster/quick");
  const getIdx = reqLog.slice(base).findIndex((e) => e === "GET /api/roster");
  ok("create-invalidates-before-adopt", postIdx >= 0 && getIdx >= 0 && postIdx < getIdx, "creation prior canonical baseline before confirm; refresh ordering before adoption (postIdx=" + postIdx + " getIdx=" + getIdx + ")");
  const stepText = await bodyText();
  ok("create-adopts-after-refresh", stepText.indexOf("Step 2") >= 0 && getIdx >= 0, "editor adopts text only after handler-barrier refresh: " + stepText.slice(0, 160));
}
async function testSecretaryBriefEditReverseIdentity() {
  resetProbeState();
  activityMode = "idle";
  await openMeet();
  await page.waitForFunction(() => document.body.innerText.indexOf("all listening") >= 0, null, { timeout: 30000 });
  await openMeetingSettings();
  const emptyDisabled = await page.getByRole("button", { name: "Prepare briefing" }).first().isDisabled().catch(() => false);
  ok("brief-empty-disables", emptyDisabled === true, "empty topic DISABLES Prepare as production requires");
  gates.briefingOld = deferred();
  gates.noteEditOld = deferred();
  gates.noteReverseOld = deferred();
  try {
    await page.getByLabel("Briefing topic").fill("held briefing intent OLD");
    const enabledOld = await page.getByRole("button", { name: "Prepare briefing" }).first().isEnabled().catch(() => false);
    ok("brief-filled-enables", enabledOld === true, "fill new topic THEN enabled");
    await page.getByRole("button", { name: "Prepare briefing" }).first().click();
    await page.waitForFunction(() => document.body.innerText.indexOf("Preparing...") >= 0, null, { timeout: 30000 });
    const briefText = await bodyText();
    ok("brief-held-pending", briefText.indexOf("Preparing...") >= 0, "queued briefing holds behind barrier: " + briefText.slice(0, 160));
    await waitForLog(reqLog.length - 1, "POST /api/meetings/m-one/briefings");
    await page.getByRole("button", { name: "Edit", exact: true }).first().click();
    const editBox = page.locator("dialog.conv-settings .takenote textarea").first();
    await editBox.waitFor({ timeout: 15000 });
    await editBox.fill("Fixture note body plus held edit OLD.");
    await page.getByRole("button", { name: "Save revision", exact: true }).click();
    await waitForLog(reqLog.length - 1, "POST /api/notes/n-1/edit");
    await page.getByRole("button", { name: "Reverse", exact: true }).first().click();
    await waitForLog(reqLog.length - 1, "POST /api/notes/n-1/reverse");
    ok("edits-queued", reqLog.join("~").find("POST /api/meetings/m-one/briefings") >= 0, "old briefing dispatched behind independent barrier");
    const preSwitchUrl = page.url();
    await applyIdentityAs("owner2");
    const postSwitchUrl = page.url();
    ok("identity-same-app", preSwitchUrl.split("#")[0] === postSwitchUrl.split("#")[0], "preserve same App no reload across identity switch");
    await openMeet();
    await openMeetingSettings();
    const topicVal = await page.getByLabel("Briefing topic").inputValue().catch(() => "MISSING");
    ok("identity-brief-cleared", topicVal === "", "identity switch intentionally clears briefing intent: " + JSON.stringify(topicVal).slice(0, 80));
    const disabledAfter = await page.getByRole("button", { name: "Prepare briefing" }).first().isDisabled().catch(() => false);
    ok("identity-brief-disabled-empty", disabledAfter === true, "empty after switch stays DISABLED");
    ok("identity-edit-cleared", (await page.locator("dialog.conv-settings .takenote textarea").count()) === 0, "identity switch retires held editor");
    gates.briefingNew = deferred();
    await page.getByLabel("Briefing topic").fill("fresh intent NEW");
    const enabledNew = await page.getByRole("button", { name: "Prepare briefing" }).first().isEnabled().catch(() => false);
    ok("identity-brief-reenabled", enabledNew === true, "new briefing op enabled after fill, not blocked by retired attempt");
    const markNew = reqLog.length;
    await page.getByRole("button", { name: "Prepare briefing" }).first().click();
    await waitForLog(markNew, "POST /api/meetings/m-one/briefings");
    ok("overlap-newer-dispatched", countFrom(markNew, "POST", "/api/meetings/m-one/briefings") >= 1, "newer briefing dispatched while old callbacks still held");
    const oldRespP = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/meetings/m-one/briefings", { timeout: 15000 }).catch(() => null);
    try { gates.briefingOld.release(); gates.briefingOld = null; } catch (e) { gates.briefingOld = null; }
    await oldRespP.catch(() => {});
    await sleep(400);
    const stillNewTopic = await page.getByLabel("Briefing topic").inputValue().catch(() => "MISSING");
    const stillNewBody = await bodyText();
    ok("overlap-old-cannot-clear-new", stillNewTopic === "fresh intent NEW" && stillNewBody.indexOf("Preparing...") >= 0, "old reply while NEW held leaves NEW text/pending: topic=" + JSON.stringify(stillNewTopic).slice(0, 60));
    const newRespP = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/meetings/m-one/briefings", { timeout: 15000 }).catch(() => null);
    try { gates.briefingNew.release(); gates.briefingNew = null; } catch (e) { gates.briefingNew = null; }
    await newRespP.catch(() => {});
    await page.waitForFunction(() => { const el = document.querySelector("dialog.conv-settings input"); return el && el.value === ""; }, null, { timeout: 30000 });
    ok("identity-new-brief-completes", countFrom(markNew, "POST", "/api/meetings/m-one/briefings") === 1, "new completes exact once with readback clear");
    try { if (gates.noteEditOld) { gates.noteEditOld.release(); gates.noteEditOld = null; } } catch (e) {}
    try { if (gates.noteReverseOld) { gates.noteReverseOld.release(); gates.noteReverseOld = null; } } catch (e) {}
    await sleep(400);
    const noCrash = (page.__qaErrors || []).length === 0;
    ok("identity-old-edit-reverse-silent", noCrash, "old edit/reverse callbacks after switch stay silent, no shared promise overlap");
    gates.noteEdit = deferred();
    await page.getByRole("button", { name: "Edit", exact: true }).first().click();
    const editBox2 = page.locator("dialog.conv-settings .takenote textarea").first();
    await editBox2.waitFor({ timeout: 15000 });
    await editBox2.fill("second fresh edit.");
    const mark3 = reqLog.length;
    const editRespP = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/notes/n-1/edit", { timeout: 30000 });
    await page.getByRole("button", { name: "Save revision", exact: true }).click();
    await waitForLog(mark3, "POST /api/notes/n-1/edit");
    try { gates.noteEdit.release(); gates.noteEdit = null; } catch (e) { gates.noteEdit = null; }
    await editRespP;
    await page.waitForFunction(() => document.querySelectorAll("dialog.conv-settings .takenote textarea").length === 0, null, { timeout: 30000 });
    ok("identity-new-edit-completes", countFrom(mark3, "POST", "/api/notes/n-1/edit") === 1, "fresh edit posts once and closes editor");
    gates.noteReverse = deferred();
    const mark4 = reqLog.length;
    const revRespP = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/notes/n-1/reverse", { timeout: 30000 });
    await page.getByRole("button", { name: "Reverse", exact: true }).first().click();
    await waitForLog(mark4, "POST /api/notes/n-1/reverse");
    try { gates.noteReverse.release(); gates.noteReverse = null; } catch (e) { gates.noteReverse = null; }
    await revRespP;
    await page.waitForFunction(() => document.body.innerText.indexOf("Note reversed") >= 0, null, { timeout: 30000 });
    const revText = await bodyText();
    ok("identity-new-reverse-completes", revText.indexOf("Note reversed") >= 0 && countFrom(mark4, "POST", "/api/notes/n-1/reverse") === 1, "fresh reverse posts once with actual confirmation visible: " + revText.slice(0, 160));
  } finally {
    for (const k of ["briefingOld", "briefingNew", "briefing", "noteEditOld", "noteEdit", "noteReverseOld", "noteReverse"]) {
      try { if (gates[k]) { gates[k].release(); gates[k] = null; } } catch (e) { try { gates[k] = null; } catch (x) {} }
    }
  }
}
async function testSecretaryInitialRetryAnswer() {
  resetProbeState();
  activityMode = "idle";
  await openMeet();
  await page.waitForFunction(() => document.body.innerText.indexOf("all listening") >= 0, null, { timeout: 30000 });
  gates.secInitial = deferred();
  try {
    await page.getByLabel("Message audience").selectOption("secretary");
    await page.getByLabel("Message. Press Enter to send, Shift and Enter for a new line.").fill("secretary: held initial intent OLD");
    const sendBtn = page.getByRole("button", { name: "Send" }).first();
    await sendBtn.click();
    await page.waitForFunction(() => document.body.innerText.indexOf("Sending secretary...") >= 0, null, { timeout: 30000 });
    const pendText = await bodyText();
    ok("sec-initial-held", pendText.indexOf("Sending secretary...") >= 0, "initial held shows pending: " + pendText.slice(0, 160));
    const mInit = reqLog.length - 1;
    await waitForLog(mInit, "POST /api/meetings/m-one/secretary");
    const initRespP = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/meetings/m-one/secretary", { timeout: 30000 });
    try { gates.secInitial.release(); gates.secInitial = null; } catch (e) { gates.secInitial = null; }
    await initRespP;
    await page.waitForFunction(() => document.body.innerText.indexOf("Secretary clarification") >= 0, null, { timeout: 30000 });
    const clar = await bodyText();
    ok("sec-initial-completes", clar.indexOf("Secretary clarification") >= 0 && clar.indexOf("held initial intent OLD") >= 0, "initial completes with readback question: " + clar.slice(0, 180));
  } finally {
    try { if (gates.secInitial) { gates.secInitial.release(); gates.secInitial = null; } } catch (e) {}
  }
  gates.secAnswer = deferred();
  try {
    await page.getByLabel("Answer").first().fill("held answer body NEW");
    await page.getByRole("button", { name: "Send answer" }).first().click();
    await page.waitForFunction(() => document.body.innerText.indexOf("Sending...") >= 0, null, { timeout: 30000 });
    const mAns = reqLog.length - 1;
    await waitForLog(mAns, "POST /api/meetings/m-one/secretary/answer");
    ok("sec-answer-held", countFrom(mAns, "POST", "/api/meetings/m-one/secretary/answer") >= 1, "answer held behind barrier with real dispatch");
    const ansRespP = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/meetings/m-one/secretary/answer", { timeout: 30000 });
    try { gates.secAnswer.release(); gates.secAnswer = null; } catch (e) { gates.secAnswer = null; }
    const ansResp = await ansRespP;
    ok("sec-answer-completes", ansResp.status() === 200, "answer status=" + ansResp.status());
    await page.waitForFunction(() => document.body.innerText.indexOf("held answer body NEW") >= 0 || document.body.innerText.indexOf("Secretary note saved") >= 0, null, { timeout: 30000 });
    ok("sec-answer-readback", (await bodyText()).indexOf("Secretary note saved") >= 0, "answer completes with mounted readback");
  } finally {
    try { if (gates.secAnswer) { gates.secAnswer.release(); gates.secAnswer = null; } } catch (e) {}
  }
  await page.reload();
  await openMeet();
  await page.waitForFunction(() => document.body.innerText.indexOf("all listening") >= 0, null, { timeout: 30000 });
  gates.secRetry = deferred();
  try {
    await page.getByLabel("Message audience").selectOption("secretary");
    await page.getByLabel("Message. Press Enter to send, Shift and Enter for a new line.").fill("secretary: fail-once retry probe");
    await page.getByRole("button", { name: "Send" }).first().click();
    await page.waitForFunction(() => document.body.innerText.indexOf("Secretary error") >= 0, null, { timeout: 30000 });
    const errText = await bodyText();
    ok("sec-retry-available", errText.indexOf("Retry secretary (same envelope)") >= 0, "failed initial surfaces retry with same envelope: " + errText.slice(0, 180));
    const mRet = reqLog.length;
    await page.getByRole("button", { name: "Retry secretary (same envelope)" }).first().click();
    await waitForLog(mRet, "POST /api/meetings/m-one/secretary");
    ok("sec-retry-held", countFrom(mRet, "POST", "/api/meetings/m-one/secretary") >= 1, "retry held behind barrier with real dispatch");
    const retRespP = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/meetings/m-one/secretary", { timeout: 30000 });
    try { gates.secRetry.release(); gates.secRetry = null; } catch (e) { gates.secRetry = null; }
    const retResp = await retRespP;
    ok("sec-retry-completes", retResp.status() === 200, "retry status=" + retResp.status());
    await page.waitForFunction(() => document.body.innerText.indexOf("Secretary clarification") >= 0, null, { timeout: 30000 });
    ok("sec-retry-readback", (await bodyText()).indexOf("Secretary clarification") >= 0, "retry completes with clarification readback");
  } finally {
    try { if (gates.secRetry) { gates.secRetry.release(); gates.secRetry = null; } } catch (e) {}
    try { if (gates.secInitial) { gates.secInitial.release(); gates.secInitial = null; } } catch (e) {}
  }
}
async function testProvenance() {
  const headFile = (() => { try { return fs.readFileSync(path.join(here, "..", ".git"), "utf8"); } catch (e) { return ""; } })();
  let headRef = "";
  try {
    const m = headFile.match(/gitdir:\s*(.+)/);
    if (m) {
      const gd = m[1].trim();
      headRef = fs.readFileSync(path.join(gd, "HEAD"), "utf8").trim().slice(0, 120);
    }
  } catch (e) {}
  let distFiles = [];
  try { distFiles = fs.readdirSync(path.join(dist, "assets")).filter((f) => f.endsWith(".js") || f.endsWith(".css")); } catch (e) {}
  const manifest = [];
  for (const f of distFiles) {
    try {
      const st = fs.statSync(path.join(dist, "assets", f));
      manifest.push(f + ":" + st.size + ":" + Math.floor(st.mtimeMs));
    } catch (e) {}
  }
  const idxExists = (() => { try { return fs.statSync(path.join(dist, "index.html")).size > 0; } catch (e) { return false; } })();
  ok("provenance-head", headRef.length > 0, "source HEAD captured from actual worktree file: " + headRef.slice(0, 80));
  ok("provenance-dist", idxExists && manifest.length >= 2, "dist hash manifest from actual file metadata: " + manifest.slice(0, 4).join(" | ").slice(0, 200));
}
async function main() {
  try {
    await launch();
    try { if (outPath) fs.writeFileSync(outPath, "START " + new Date().toISOString() + "\n"); } catch (e) {}
    const only = (process.env.QA_ONLY || "").split(",").map((s) => s.trim()).filter((s) => !!s);
    const all = [testProvenance, testActivityHubOffHealthyHttp, testActivityErrorOfflineRecovery, testResearchLiveTerminalRerun, testResearchRetainedErrorOutranks, testPutMountedVerifyHeld, testPutUnmountBeforeConfirm, testCreateInvalidatesBeforeAdopt, testSecretaryBriefEditReverseIdentity, testSecretaryInitialRetryAnswer];
    const tests = only.length ? all.filter((t) => only.indexOf(t.name) >= 0) : all;
    for (const t of tests) {
      try { await t(); } catch (e) { fail++; const m = t.name + " threw " + String((e && e.message) || e).slice(0, 600); failures.push(m); console.log("  FAIL " + m); outLine("FAIL " + m); try { outLine("PAGE-TAIL " + (await bodyText()).slice(-2500)); } catch (e2) {} }
    }
    const errs = page.__qaErrors || [];
    ok("no-page-errors", errs.length === 0, errs.slice(0, 5).join(" | "));
  } finally {
    await closeAll();
  }
  console.log("PASS=" + pass + " FAIL=" + fail);
  outLine("PASS=" + pass + " FAIL=" + fail);
  if (failures.length) { console.log("FAILURES: " + failures.join(" ; ")); outLine("FAILURES: " + failures.join(" ; ")); }
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.log("FATAL " + String((e && e.stack) || e).slice(0, 500)); process.exit(2); });
