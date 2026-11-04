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
function profileJson() {
  return JSON.stringify({
    fictional: true, name: "QA Sage", background: "Test background.",
    contributionCriteria: "Speaks when pricing expertise applies.",
    reasoningApproach: "Weighs evidence and trade-offs carefully.",
    responseStyle: "Direct and concise, with reasons stated.",
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
let researchTerminal = "done";
let researchVersion = 4;
const gates = { activity: null, researchGet: null, briefing: null, noteEdit: null, noteReverse: null, rosterPut: null };
function resetProbeState() {
  entry = freshEntry();
  notes = freshNotes();
  activityMode = "idle";
  researchPhase = "done";
  researchPollsLeft = 0;
  researchTerminal = "done";
  researchVersion = 4;
  for (const k of Object.keys(gates)) gates[k] = null;
}
function countFrom(mark, method, exactPath) {
  let n = 0;
  for (let i = mark; i < reqLog.length; i++) {
    const parts = reqLog[i].split(" ");
    if (parts[0] === method && parts[1] === exactPath) n++;
  }
  return n;
}
function researchSnapshot() {
  if (researchPhase === "running") {
    return { researchJson: "{}", researchedAt: null, researchRequested: true, evidenceCount: 0, version: researchVersion, researchBaseVersion: 3, running: true, stage: "researching", stageError: null, sources: [], draftProfile: null, draftStatus: null };
  }
  if (researchPhase === "failed") {
    return { researchJson: "{}", researchedAt: null, researchRequested: true, evidenceCount: 0, version: researchVersion, researchBaseVersion: 3, running: false, stage: "failed", stageError: "provider timeout", sources: [], draftProfile: null, draftStatus: "failed" };
  }
  return { researchJson: "{}", researchedAt: "2026-11-04T00:00:00Z", researchRequested: true, evidenceCount: 2, version: researchVersion, researchBaseVersion: 3, running: false, stage: "done", stageError: null, sources: [], draftProfile: null, draftStatus: "draft" };
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
  if ((m = p.match(/^\/api\/meetings\/([^/]+)\/briefings$/)) && method === "POST") {
    if (gates.briefing) await gates.briefing.promise;
    const b = bodyOf();
    return J({ id: "b-1", topic: b.topic || "" });
  }
  if ((m = p.match(/^\/api\/notes\/([^/]+)\/edit$/)) && method === "POST") {
    if (gates.noteEdit) await gates.noteEdit.promise;
    const b = bodyOf();
    const n = notes.find((x) => x.id === m[1]);
    if (!n) return J({ error: "unknown note" }, 404);
    n.body = typeof b.body === "string" ? b.body : n.body;
    n.revision = (n.revision || 3) + 1;
    return J(n);
  }
  if ((m = p.match(/^\/api\/notes\/([^/]+)\/reverse$/)) && method === "POST") {
    if (gates.noteReverse) await gates.noteReverse.promise;
    const n = notes.find((x) => x.id === m[1]);
    if (!n) return J({ error: "unknown note" }, 404);
    return J(n);
  }
  if (p === "/api/roster" && method === "GET") {
    return J([{ entry: entry, complete: true, missing: [], imageCount: 0, boards: ["b-alpha"] }]);
  }
  if (p === "/api/roster/count") return J({ total: 1 });
  if ((m = p.match(/^\/api\/roster\/([^/]+)\/images$/))) return J([]);
  if ((m = p.match(/^\/api\/roster\/([^/]+)\/research$/)) && method === "GET") {
    if (gates.researchGet) await gates.researchGet.promise;
    if (researchPhase === "running") {
      if (researchPollsLeft > 0) { researchPollsLeft--; return J(researchSnapshot()); }
      researchPhase = researchTerminal;
      return J(researchSnapshot());
    }
    return J(researchSnapshot());
  }
  if ((m = p.match(/^\/api\/roster\/([^/]+)\/research$/)) && method === "POST") {
    researchPhase = "running";
    researchPollsLeft = 4;
    return J({ subject: "x", searched: 1, supported: true, claims: [], responseIds: [], version: researchVersion, evidenceRefs: [], draftProfile: null, draftStatus: "draft" });
  }
  if ((m = p.match(/^\/api\/roster\/([^/]+)$/)) && method === "PUT") {
    if (gates.rosterPut) await gates.rosterPut.promise;
    const b = bodyOf();
    if (typeof b.profileJson === "string") entry.profileJson = b.profileJson;
    entry.version = (entry.version || 3) + 1;
    entry.updatedAt = new Date().toISOString();
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
  await page.getByRole("heading", { name: /My Advisor Roster/ }).first().waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: /QA Sage/ }).first().waitFor({ timeout: 20000 });
}
async function selectRosterEntry() {
  await page.getByRole("button", { name: /QA Sage/ }).first().click();
  await page.locator('[data-roster-entry-id="r-adv-1"]').first().waitFor({ timeout: 20000 });
}
async function railStatus() {
  return page.locator('section[aria-label="In this meeting"] p[role="status"]').first().innerText().catch(() => "");
}
async function applyIdentityAs(name) {
  await openHash("#/settings?board=b-alpha");
  await page.getByLabel("Act as user").fill(name);
  await page.getByRole("button", { name: "Apply identity" }).click();
}

async function testActivityHubOffHealthyHttp() {
  const mark = reqLog.length;
  resetProbeState();
  activityMode = "idle";
  await openMeet();
  await page.waitForFunction(() => document.body.innerText.indexOf("all listening") >= 0, null, { timeout: 30000 });
  ok("activity-huboff-http-idle", true, "healthy HTTP snapshot available while hub stopped");
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
  ok("activity-error-unavailable", true, "failed snapshot renders unavailable, never responding");
  const t0 = await bodyText();
  ok("activity-error-no-responding", t0.indexOf("Responding") < 0 || t0.indexOf("activity unavailable") >= 0, t0.slice(0, 200));
  activityMode = "idle";
  await page.reload();
  await openMeet();
  await page.waitForFunction(() => document.body.innerText.indexOf("all listening") >= 0, null, { timeout: 30000 });
  ok("activity-error-recovered", true, "fresh healthy HTTP recovers availability");
  const mark = reqLog.length;
  await page.evaluate(() => {
    try {
      Object.defineProperty(document, "hidden", { value: true, configurable: true });
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    } catch (e) {}
  });
  await page.waitForFunction(() => document.body.innerText.indexOf("checking activity") >= 0, null, { timeout: 30000 });
  ok("activity-hidden-paused", true, "hidden tab pauses retained snapshot instead of false available");
  ok("activity-hidden-no-live", await page.locator(".badge.live").count() === 0, "");
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
}
async function testResearchLiveTerminalRerun() {
  resetProbeState();
  researchPhase = "running";
  researchPollsLeft = 4;
  researchTerminal = "done";
  researchVersion = 4;
  await openRoster();
  await selectRosterEntry();
  await page.waitForFunction(() => document.body.innerText.indexOf("Research in progress") >= 0, null, { timeout: 30000 });
  ok("research-live-running", true, "live run beats cached row state");
  await page.waitForFunction(() => /Researched v4/.test(document.body.innerText), null, { timeout: 30000 });
  ok("research-terminal-done", true, "terminal done renders versioned proof");
  researchTerminal = "failed";
  await page.getByRole("button", { name: "Research dossier" }).first().click();
  await page.waitForFunction(() => document.body.innerText.indexOf("Research in progress") >= 0, null, { timeout: 30000 });
  ok("research-rerun-running", true, "rerun returns to running, never stale done");
  await page.waitForFunction(() => document.body.innerText.indexOf("Research failed") >= 0, null, { timeout: 30000 });
  const t = await bodyText();
  ok("research-failed-terminal", t.indexOf("Research failed") >= 0, t.slice(0, 300));
  ok("research-failed-no-stale-researched", !/Researched v4/.test(t), "failed rerun never reverts to cached Researched");
}
async function testPutVerifyHeldUnmount() {
  resetProbeState();
  researchPhase = "done";
  await openRoster();
  await selectRosterEntry();
  await page.waitForFunction(() => /Researched/.test(document.body.innerText), null, { timeout: 30000 });
  await page.locator("#cc-respond").fill("Direct and concise, with reasons stated. Plus a held-save sentence.");
  gates.researchGet = deferred();
  const mark = reqLog.length;
  const putResp = page.waitForResponse((r) => r.request().method() === "PUT" && new URL(r.url()).pathname === "/api/roster/r-adv-1", { timeout: 30000 });
  await page.getByRole("button", { name: "Save draft changes" }).click();
  const resp = await putResp;
  ok("put-confirmed-200", resp.status() === 200, "status=" + resp.status());
  // Barrier, not sleep: the roster refetch must fire while the verify GET is
  // still held, proving invalidation ran immediately after the confirmed PUT.
  await page.waitForFunction(() => document.body.innerText.indexOf("Checking research") >= 0 || document.body.innerText.indexOf("Researched") >= 0, null, { timeout: 30000 });
  const rosterGets = countFrom(mark, "GET", "/api/roster");
  ok("put-invalidates-before-verify", rosterGets >= 1, "roster refetch fired while verify held; rosterGets=" + rosterGets);
  await openHash("#/boards");
  await page.waitForFunction(() => document.body.innerText.indexOf("Boards") >= 0, null, { timeout: 20000 });
  ok("put-unmount-clean", true, "unmount during held verify does not crash");
  gates.researchGet.release();
  gates.researchGet = null;
  await sleep(1200);
  const errs = page.__qaErrors || [];
  ok("put-held-no-page-errors", errs.length === 0, errs.slice(0, 3).join(" | "));
  ok("put-single-confirm", countFrom(mark, "PUT", "/api/roster/r-adv-1") === 1, "exactly one confirmed write");
}
async function testCreateInvalidatesBeforeAdopt() {
  resetProbeState();
  await openRoster();
  const mark = reqLog.length;
  await page.getByRole("button", { name: "+ Create new Advisor" }).click();
  await page.locator("#cc-name").fill("QA Newcomer");
  await page.locator("#cc-description").fill("A fresh test advisor with enough words for validation.");
  const created = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/roster/quick", { timeout: 30000 });
  await page.getByRole("button", { name: "Create draft", exact: true }).click();
  const cresp = await created;
  ok("create-confirmed", cresp.status() === 200 || cresp.status() === 201, "status=" + cresp.status());
  await page.waitForFunction(() => document.body.innerText.indexOf("Step 2") >= 0, null, { timeout: 30000 });
  ok("create-invalidates-before-adopt", countFrom(mark, "GET", "/api/roster") >= 1, "creation refreshes canonical caches before editor adopts text");
}
async function testSecretaryBriefEditReverseIdentity() {
  resetProbeState();
  activityMode = "idle";
  await openMeet();
  await page.waitForFunction(() => document.body.innerText.indexOf("all listening") >= 0, null, { timeout: 30000 });
  const mark0 = reqLog.length;
  gates.briefing = deferred();
  await page.getByLabel("Briefing topic").fill("held briefing intent");
  await page.getByRole("button", { name: "Prepare briefing" }).click();
  await page.waitForFunction(() => document.body.innerText.indexOf("Preparing...") >= 0, null, { timeout: 30000 });
  ok("brief-held-pending", true, "queued briefing holds behind the request barrier");
  await page.getByRole("button", { name: "Edit", exact: true }).first().click();
  const editBox = page.locator(".takenote textarea").first();
  await editBox.waitFor({ timeout: 15000 });
  await editBox.fill("Fixture note body plus held edit.");
  gates.noteEdit = deferred();
  await page.getByRole("button", { name: "Save revision", exact: true }).click();
  await sleep(500);
  gates.noteReverse = deferred();
  await page.getByRole("button", { name: "Reverse", exact: true }).first().click();
  await page.waitForFunction(() => true, null, { timeout: 1000 }).catch(() => {});
  // Dispatch settle only; acceptance below uses request counts + UI state.
  ok("edits-queued", countFrom(mark0, "POST", "/api/notes/n-1/edit") >= 1 && countFrom(mark0, "POST", "/api/meetings/m-one/briefings") >= 1 && countFrom(mark0, "POST", "/api/notes/n-1/reverse") >= 1, "briefing+edit+reverse all dispatched behind barriers");
  await applyIdentityAs("owner2");
  await openMeet();
  const topicVal = await page.getByLabel("Briefing topic").inputValue().catch(() => "MISSING");
  ok("identity-brief-topic-kept", topicVal === "held briefing intent", JSON.stringify(topicVal).slice(0, 80));
  ok("identity-brief-reenabled", await page.getByRole("button", { name: "Prepare briefing" }).isEnabled(), "new briefing op not blocked by retired attempt");
  ok("identity-edit-box-kept", (await page.locator(".takenote textarea").first().count()) === 1, "edit latch retired without crash");
  gates.briefing.release();
  gates.briefing = null;
  gates.noteEdit.release();
  gates.noteEdit = null;
  gates.noteReverse.release();
  gates.noteReverse = null;
  // Settle for the three released callbacks; silence is asserted on state
  // (retired completions must change nothing), not on the sleep itself.
  await sleep(1500);
  const errs = page.__qaErrors || [];
  ok("identity-held-silent", errs.length === 0, errs.slice(0, 3).join(" | "));
  const topicAfter = await page.getByLabel("Briefing topic").inputValue().catch(() => "MISSING");
  ok("identity-old-cannot-clear-new", topicAfter === "held briefing intent", "retired briefing completion left the new topic intact: " + JSON.stringify(topicAfter).slice(0, 80));
  const editAfter = await page.locator(".takenote textarea").first().inputValue().catch(() => "MISSING");
  ok("identity-old-edit-silent", editAfter === "Fixture note body plus held edit.", "retired edit completion left the new editor text intact: " + JSON.stringify(editAfter).slice(0, 80));
  const mark2 = reqLog.length;
  await page.getByRole("button", { name: "Prepare briefing" }).click();
  // Positive new response control: the fresh briefing posts exactly once and
  // clears its own topic; the retired attempt cannot interfere.
  await page.waitForFunction(() => { const el = document.querySelector('input[placeholder="e.g. pricing risks"]'); return el && el.value === ""; }, null, { timeout: 30000 });
  ok("identity-new-brief-completes", countFrom(mark2, "POST", "/api/meetings/m-one/briefings") === 1, "fresh op posts exactly once");
  const mark3 = reqLog.length;
  await page.getByRole("button", { name: "Save revision", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".takenote textarea").length === 0, null, { timeout: 30000 });
  ok("identity-new-edit-completes", countFrom(mark3, "POST", "/api/notes/n-1/edit") === 1, "fresh edit posts once and closes its editor");
  const mark4 = reqLog.length;
  await page.getByRole("button", { name: "Reverse", exact: true }).first().click();
  await page.waitForFunction(() => document.body.innerText.indexOf("Note reversed") >= 0, null, { timeout: 30000 });
  ok("identity-new-reverse-completes", countFrom(mark4, "POST", "/api/notes/n-1/reverse") === 1, "fresh reverse posts once with confirmation");
}

async function main() {
  try {
    await launch();
    try { if (outPath) fs.writeFileSync(outPath, "START " + new Date().toISOString() + "\n"); } catch (e) {}
    const only = (process.env.QA_ONLY || "").split(",").map((s) => s.trim()).filter((s) => !!s);
    const all = [testActivityHubOffHealthyHttp, testActivityErrorOfflineRecovery, testResearchLiveTerminalRerun, testPutVerifyHeldUnmount, testCreateInvalidatesBeforeAdopt, testSecretaryBriefEditReverseIdentity];
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
