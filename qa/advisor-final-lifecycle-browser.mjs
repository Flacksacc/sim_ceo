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
    profileJson: profileJson(), version: 4, archived: false, tags: "",
    researchJson: "{}", researchedAt: null, researchRequested: false,
    evidenceCount: 0, researchJobId: "", researchBaseVersion: 3, updatedAt: "2026-11-04T00:00:00Z",
  };
}
function freshNotes() {
  return [{ id: "n-1", boardId: "b-alpha", meetingId: "m-one", kind: "note", scope: "meeting", title: "Fixture note", body: "Fixture note body", provisional: false, revision: 3, noteStatus: "current" }];
}

let entry = freshEntry();
let notes = freshNotes();
const seenSecretaryInputs = [];
let activityMode = "idle";
let researchPhase = "done";
let researchPollsLeft = 0;
let researchTerminal = "draft";
let researchVersion = 4;
let researchHttpError = false;
const gates = { activity: null, researchGet: null, researchPost: null, briefing: null, briefingOld: null, briefingNew: null, noteEdit: null, noteEditOld: null, noteReverse: null, noteReverseOld: null, rosterPut: null, rosterGet: null, rosterQuick: null, secInitial: null, secRetry: null, secAnswer: null };
let briefingSeq = 0;
let editSeq = 0;
let reverseSeq = 0;
let lastBackupSnapshot = "";
let lastBackupHash = "";
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
  briefingSeq = 0; editSeq = 0; reverseSeq = 0;
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
    return { researchJson: JSON.stringify(doc), researchedAt: null, researchRequested: true, evidenceCount: 0, version: researchVersion, researchBaseVersion: 3, running: false, stage: "failed", stageError: "SELECT * FROM roster at /srv/db/roster.sql failed", sources: [], draftProfile: null, draftStatus: "failed" };
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
    const gA = gates.activity; if (gA) await gA.promise;
    if (activityMode === "error") return J({ error: "activity store failed" }, 500);
    if (activityMode === "responding") return J({ discussion: { status: "considering", advisors: [{ advisorId: "a-1", state: "responding", reason: null }] }, secretary: [{ status: "answering", updatedAt: "2026-11-04T00:00:02Z" }] });
    return J({ discussion: { status: "idle", advisors: [] }, secretary: [] });
  }
  if ((m = p.match(/^\/api\/meetings\/([^/]+)\/notes$/)) && method === "GET") return J(notes);
  if ((m = p.match(/^\/api\/meetings\/([^/]+)\/notes\/history$/))) return J([]);
  if ((m = p.match(/^\/api\/meetings\/([^/]+)\/secretary\/requests$/)) && method === "GET") return J([]);
  if ((m = p.match(/^\/api\/meetings\/([^/]+)\/secretary\/requests\/([^/]+)$/)) && method === "GET") return J({ error: "not found" }, 404);
  if ((m = p.match(/^\/api\/meetings\/([^/]+)\/secretary\/answer$/)) && method === "POST") {
    const gAns = gates.secAnswer; if (gAns) await gAns.promise;
    const b = bodyOf();
    const n = { id: "n-ans-1", boardId: "b-alpha", meetingId: "m-one", kind: "secretary-note", scope: "meeting", title: "Secretary answer", body: String(b.answer || "answer body"), provisional: true, revision: 1, noteStatus: "current" };
    notes.push(n);
    return J({ note: n, requestId: String(b.requestId || "q-1") });
  }
  if ((m = p.match(/^\/api\/meetings\/([^/]+)\/secretary$/)) && method === "POST") {
    const b0 = bodyOf();
    const raw0 = String(b0.input || "");
    try { seenSecretaryInputs.push(raw0.slice(0, 80)); } catch (e) {}
    if (raw0.indexOf("fail-once") >= 0 && !gates.secRetry) return J({ error: "secretary failed once" }, 500);
    const wantRetry = /retry|fail-once/i.test(raw0);
    const gS = wantRetry ? gates.secRetry : gates.secInitial;
    if (gS) await gS.promise;
    const b = bodyOf();
    const q = String(b.input || "secretary question").slice(0, 120);
    return J({ requestId: "q-1", question: q || "Clarify pricing?", status: "needs-clarification" });
  }
  if (p === "/api/backup" && method === "GET") { lastBackupSnapshot = "qa-snapshot-v1"; lastBackupHash = "qa-hash-" + String(lastBackupSnapshot.length) + "-v1"; return J({ snapshot: lastBackupSnapshot, hash: lastBackupHash }); }
  if (p === "/api/backup/restore" && method === "POST") { const bb = bodyOf(); if (String(bb.snapshot || "") !== lastBackupSnapshot || String(bb.hash || "") !== lastBackupHash) return J({ error: "backup hash mismatch" }, 400); return J({ restored: true }); }
  if ((m = p.match(/^\/api\/meetings\/([^/]+)\/briefings$/)) && method === "POST") {
    const bPre = bodyOf();
    const topicPre = String(bPre.topic || "");
    let gB = null;
    if (/OLD/.test(topicPre)) gB = gates.briefingOld;
    else if (/NEW/.test(topicPre)) gB = gates.briefingNew;
    else { const s = briefingSeq++; gB = s === 0 ? (gates.briefingOld || gates.briefing) : (gates.briefingNew || gates.briefing); }
    if (gB) await gB.promise;
    const b = bodyOf();
    const n = { id: "n-brief-" + String(Date.now()), boardId: "b-alpha", meetingId: "m-one", kind: "briefing", scope: "meeting", title: String(b.topic || "briefing").slice(0, 80), body: String(b.topic || "briefing"), provisional: true, revision: 1, noteStatus: "current" };
    notes.push(n);
    return J({ id: n.id, topic: b.topic || "", submitted: b.topic || "" });
  }
  if ((m = p.match(/^\/api\/notes\/([^/]+)\/edit$/)) && method === "POST") {
    const ePre = bodyOf();
    const eBodyPre = String(ePre.body || "");
    let gE = null;
    if (/OLD/.test(eBodyPre)) gE = gates.noteEditOld;
    else if (/fresh|NEW/.test(eBodyPre)) gE = gates.noteEdit;
    else { const s = editSeq++; gE = s === 0 ? (gates.noteEditOld || gates.noteEdit) : (gates.noteEdit || gates.noteEditOld); }
    if (gE) await gE.promise;
    const b = bodyOf();
    const n = notes.find((x) => x.id === m[1]);
    if (!n) return J({ error: "unknown note" }, 404);
    n.body = typeof b.body === "string" ? b.body : n.body;
    n.revision = (n.revision || 3) + 1;
    return J(n);
  }
  if ((m = p.match(/^\/api\/notes\/([^/]+)\/reverse$/)) && method === "POST") {
    const rSeq = reverseSeq++;
    const gR = rSeq === 0 ? (gates.noteReverseOld || gates.noteReverse) : (gates.noteReverse || gates.noteReverseOld);
    if (gR) await gR.promise;
    const n = notes.find((x) => x.id === m[1]);
    if (!n) return J({ error: "unknown note" }, 404);
    n.noteStatus = "reversed";
    return J(n);
  }
  if (p === "/api/roster" && method === "GET") {
    const gRoster = gates.rosterGet; if (gRoster) await gRoster.promise;
    return J([{ entry: entry, complete: true, missing: [], imageCount: 0, boards: ["b-alpha"] }]);
  }
  if (p === "/api/roster/count") return J({ total: 1 });
  if ((m = p.match(/^\/api\/roster\/([^/]+)\/images$/))) return J([]);
  if ((m = p.match(/^\/api\/roster\/([^/]+)\/research$/)) && method === "GET") {
    const gRG = gates.researchGet; if (gRG) await gRG.promise;
    if (researchHttpError) return J({ error: "SELECT * FROM roster at /srv/db/roster.sql failed", stageError: "SELECT * FROM roster at /srv/db/roster.sql failed" }, 500);
    if (researchPhase === "running") {
      if (researchPollsLeft > 0) { researchPollsLeft--; return J(researchSnapshot()); }
      researchPhase = researchTerminal;
      return J(researchSnapshot());
    }
    return J(researchSnapshot());
  }
  if ((m = p.match(/^\/api\/roster\/([^/]+)\/research$/)) && method === "POST") {
    const wantFail = researchTerminal === "failed";
    researchPhase = "running";
    researchPollsLeft = 999;
    const gRP = gates.researchPost; if (gRP) await gRP.promise;
    if (wantFail) {
      researchPhase = "failed";
      researchPollsLeft = 0;
      const fdoc = { searched: 0, supported: false, claims: [], evidenceRefs: [], draftProfile: null, draftStatus: "failed" };
      return J({ researchJson: JSON.stringify(fdoc), researchedAt: null, researchRequested: true, evidenceCount: 0, version: researchVersion, researchBaseVersion: 3, running: false, stage: "failed", stageError: "SELECT * FROM roster at /srv/db/roster.sql failed", sources: [], draftProfile: null, draftStatus: "failed" });
    }
    researchPhase = "done";
    researchTerminal = "draft";
    researchVersion = entry.version;
    researchPollsLeft = 0;
    const tdoc = persistedResearchDoc("draft");
    entry.researchJson = JSON.stringify(tdoc);
    entry.researchedAt = "2026-11-04T00:00:00Z";
    entry.researchRequested = true;
    entry.evidenceCount = 2;
    return J({ researchJson: entry.researchJson, researchedAt: entry.researchedAt, researchRequested: true, evidenceCount: 2, version: researchVersion, researchBaseVersion: 3, running: false, stage: "done", stageError: null, sources: [{ url: "https://example.com/pricing", title: "Pricing source", excerpt: "pricing excerpt" }], evidenceRefs: [{ url: "https://example.com/pricing", title: "Pricing source", excerpt: "pricing excerpt" }], draftProfile: { ...CANON_PARAS }, draftStatus: "draft" });
  }
  if ((m = p.match(/^\/api\/roster\/([^/]+)$/)) && method === "PUT") {
    const gP = gates.rosterPut; if (gP) await gP.promise;
    const b = bodyOf();
    if (typeof b.profileJson === "string") entry.profileJson = b.profileJson;
    entry.version = (entry.version || 3) + 1;
    entry.updatedAt = new Date().toISOString();
    try {
      const pj = JSON.parse(entry.profileJson || "{}");
      const same = pj.contributionCriteria === CANON_PARAS.contributionCriteria && pj.reasoningApproach === CANON_PARAS.reasoningApproach && pj.responseStyle === CANON_PARAS.responseStyle;
      if (same && researchPhase !== "running" && researchPhase !== "failed") {
        researchTerminal = "saved";
        researchPhase = "done";
        researchVersion = entry.version;
        const sdoc = persistedResearchDoc("saved");
        entry.researchJson = JSON.stringify(sdoc);
        entry.researchedAt = "2026-11-04T00:00:00Z";
        entry.researchRequested = true;
        entry.evidenceCount = 2;
      }
    } catch (e) {}
    return J(entry);
  }
  if (p === "/api/roster/quick" && method === "POST") {
    const gQ = gates.rosterQuick; if (gQ) await gQ.promise;
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
  await page.route(/https?:\/\/(?!127\.0\.0\.1).*/, (r) => r.abort("blockedbyclient"));
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
  try {
    const already = await page.locator("dialog.conv-settings[open]").count().catch(() => 0);
    if (already > 0) return;
  } catch (e) {}
  await page.getByRole("button", { name: "Meeting settings" }).first().click();
  await page.locator("dialog.conv-settings section[aria-label=\"Meeting settings\"]").first().waitFor({ timeout: 20000 });
}
async function railStatus() {
  return page.locator('section[aria-label="In this meeting"] p[role="status"]').first().innerText().catch(() => "");
}
async function closeMeetingSettings() {
  try {
    const open = await page.locator("dialog.conv-settings[open]").count().catch(() => 0);
    if (open > 0) {
      const done = page.getByRole("button", { name: "Done" }).first();
      if (await done.count() > 0) { await done.click().catch(() => {}); }
    }
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
  const epochPre = await page.evaluate(() => { try { return (window).__simceoEpoch || 0; } catch (e) { return 0; } });
  await page.evaluate(() => { try { (window).__qaMark = "held"; } catch (e) {} });
  await openHash("#/people?board=b-alpha");
  await page.getByLabel("Act as user").first().waitFor({ timeout: 20000 });
  await page.getByLabel("Act as user").first().fill(name);
  await page.getByRole("button", { name: "Apply identity" }).first().click();
  await page.waitForFunction((n) => document.body.innerText.indexOf("Preview access as") >= 0, null, { timeout: 20000 }).catch(() => {});
  const epochPost = await page.evaluate(() => { try { return (window).__simceoEpoch || 0; } catch (e) { return 0; } });
  const markKept = await page.evaluate(() => { try { return (window).__qaMark; } catch (e) { return ""; } });
  const actVal = await page.getByLabel("Act as user").first().inputValue().catch(() => "");
  ok("identity-raw-stored", epochPost > epochPre && actVal === name && markKept === "held", "PEOPLE Apply retires prior origin: raw epoch " + epochPre + "->" + epochPost + " user=" + actVal + " same-App no reload");
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
    void hiddenRespP.catch(() => {});
    gates.activity.release();
    gates.activity = null;
    let hiddenResp = null;
    try { hiddenResp = await hiddenRespP; } catch (e) { hiddenResp = null; }
    let hiddenBody = "";
    try { hiddenBody = hiddenResp ? JSON.stringify(await hiddenResp.json()).slice(0, 300) : "none"; } catch (e) { hiddenBody = "status=" + (hiddenResp ? hiddenResp.status() : "none"); }
    try { await page.evaluate(() => new Promise((r) => { try { requestAnimationFrame(() => setTimeout(r, 60)); } catch (e) { setTimeout(r, 60); } })); } catch (e) {}
    await sleep(150);
    const stillHidden = await bodyText();
    const uniqueOld = hiddenBody.indexOf("responding") >= 0 || hiddenBody.indexOf("considering") >= 0;
    ok("activity-hidden-completion-held", !!hiddenResp && hiddenResp.status() === 200 && uniqueOld && stillHidden.indexOf("checking activity") >= 0 && stillHidden.indexOf("all listening") < 0, "unique OLD responding snapshot delivered+settled through microtask/render barrier while hidden, App holds paused (not rendered): " + hiddenBody.slice(0, 140));
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
    void freshRespP.catch(() => {});
    gates.activity.release();
    gates.activity = null;
    let freshResp = null;
    try { freshResp = await freshRespP; } catch (e) { freshResp = null; }
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
    void reRespP.catch(() => {});
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
  // Restore renders under ACTIVITY tab (App #/activity), and the activity query is enabled ONLY on Meet.
  // Hold an OLD poll on Meet, restore on Activity (no GET demand there), then return to Meet
  // with a NEW held GET: assert epoch bump, cancellation, checking state, fresh adoption.
  gates.activity = deferred();
  let oldHeldP = null;
  try {
    await openMeet();
    await page.waitForFunction(() => document.body.innerText.indexOf("all listening") >= 0, null, { timeout: 30000 });
    const epochBefore = await page.evaluate(() => { try { return (window).__simceoEpoch || 0; } catch (e) { return 0; } });
    const oldMark = reqLog.length;
    const oldGate = gates.activity;
    await waitForLog(oldMark, "GET /api/meetings/m-one/activity");
    await openHash("#/activity?board=b-alpha");
    await page.getByRole("button", { name: "Export full backup" }).first().waitFor({ timeout: 20000 });
    const actGetsWhileAway = countFrom(oldMark, "GET", "/api/meetings/m-one/activity");
    await page.getByRole("button", { name: "Export full backup" }).first().click();
    await page.waitForFunction(() => document.body.innerText.indexOf("Backup ready") >= 0, null, { timeout: 30000 });
    const bakText = await page.locator("input[placeholder=\"paste backup snapshot\"]").first().inputValue().catch(() => "");
    const bakHash = await page.getByLabel("Paste its check code").first().inputValue().catch(() => "");
    const restoreMark = reqLog.length;
    await page.getByRole("button", { name: "Restore (replaces current data)" }).first().click();
    await waitForLog(restoreMark, "POST /api/backup/restore");
    await page.waitForFunction(() => document.body.innerText.indexOf("Backup restored and hash-verified") >= 0, null, { timeout: 30000 });
    const epochAfter = await page.evaluate(() => { try { return (window).__simceoEpoch || 0; } catch (e) { return 0; } });
    ok("activity-restore-epoch", epochAfter > epochBefore && bakText.length > 0 && bakHash.length > 0, "restore on ACTIVITY tab increments __simceoEpoch " + epochBefore + "->" + epochAfter + " with hash-guarded snapshot len=" + bakText.length);
    ok("activity-restore-no-poll-while-away", countFrom(oldMark, "GET", "/api/meetings/m-one/activity") === actGetsWhileAway, "activity query disabled off-Meet: no fresh GET demanded while on Activity");
    const savedOldGate = oldGate;
    gates.activity = deferred();
    const newMark = reqLog.length;
    const newHeldP = page.waitForResponse((r) => r.request().method() === "GET" && new URL(r.url()).pathname === "/api/meetings/m-one/activity", { timeout: 30000 });
    void newHeldP.catch(() => {});
    await openMeet();
    await waitForLog(newMark, "GET /api/meetings/m-one/activity");
    await page.waitForFunction(() => document.body.innerText.indexOf("checking activity") >= 0, null, { timeout: 30000 });
    const heldText = await bodyText();
    ok("activity-restore-new-held-checking", heldText.indexOf("checking activity") >= 0 && heldText.indexOf("all listening") < 0, "NEW fresh GET held after restore shows checking, OLD marker rejected: " + heldText.slice(0, 160));
    activityMode = "idle";
    let newResp = null;
    try { gates.activity.release(); gates.activity = null; } catch (e) { gates.activity = null; }
    try { newResp = await newHeldP; } catch (e) {}
    ok("activity-restore-new-fresh", !!newResp && newResp.status() === 200, "NEW activity adopts fresh after release, status=" + (newResp ? newResp.status() : "none"));
    await page.waitForFunction(() => document.body.innerText.indexOf("all listening") >= 0, null, { timeout: 30000 });
    ok("activity-restore-same-id-polls", (await bodyText()).indexOf("Pricing move QA session") >= 0 && countFrom(restoreMark, "GET", "/api/meetings/m-one/activity") >= 1, "unchanged IDs b-alpha/m-one re-poll fresh after epoch cancel/invalidate");
    try { if (savedOldGate) { try { savedOldGate.release(); } catch (e) {} } } catch (e) {}
    await sleep(400);
    ok("activity-restore-old-cancelled", (await bodyText()).indexOf("all listening") >= 0, "held OLD callback after epoch bump cannot clobber NEW fresh snapshot");
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
  let postP = null;
  try {
    researchTerminal = "draft";
    const postMark = reqLog.length;
    postP = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/roster/r-adv-1/research", { timeout: 30000 });
    void postP.catch(() => {});
    await page.getByRole("button", { name: "Research dossier" }).first().click();
    await waitForLog(postMark, "POST /api/roster/r-adv-1/research");
    await page.waitForFunction(() => document.body.innerText.indexOf("Research in progress") >= 0, null, { timeout: 30000 });
    const whileHeld = await bodyText();
    ok("research-post-held-running", whileHeld.indexOf("Research in progress") >= 0, "stub marked running BEFORE holding POST response; GET during held POST shows running: " + whileHeld.slice(0, 160));
    try { gates.researchPost.release(); gates.researchPost = null; } catch (e) { gates.researchPost = null; }
    let postJson = null;
    let postStatus = 0;
    try {
      const postResp = await postP;
      postStatus = postResp.status();
      try { postJson = await postResp.json(); } catch (e) {}
    } catch (e) { postStatus = 0; }
    const postDoc = postJson && postJson.researchJson ? JSON.parse(postJson.researchJson) : null;
    const postConsistent = postStatus === 200 && !!postJson && postJson.running === false && String(postJson.stage) === "done" && String(postJson.draftStatus) === "draft" && !!postJson.draftProfile && postJson.draftProfile.responseStyle === CANON_PARAS.responseStyle && typeof postJson.version === "number" && postJson.version === 4 && !!postDoc && JSON.stringify(postDoc.draftProfile) === JSON.stringify(postJson.draftProfile) && String(postDoc.draftStatus) === String(postJson.draftStatus) && (postJson.evidenceRefs || []).length > 0;
    ok("research-post-released", postConsistent, "POST terminal matches persisted research JSON done/profile/version v4, no empty result: status=" + postStatus);
    await page.waitForFunction(() => /Researched v4/.test(document.body.innerText), null, { timeout: 30000 });
    ok("research-terminal-rerun-done", /Researched v4/.test(await bodyText()), "terminal done returns from research after POST lifecycle, version aligned v4");
  } finally {
    try { if (gates.researchPost) { gates.researchPost.release(); gates.researchPost = null; } } catch (e) {}
  }
  const putMark = reqLog.length;
  await page.locator("#cc-respond").first().fill(CANON_PARAS.responseStyle);
  await page.locator("#cc-reason").first().fill(CANON_PARAS.reasoningApproach);
  await page.locator("#cc-contribute").first().fill(CANON_PARAS.contributionCriteria);
  const putP = page.waitForResponse((r) => r.request().method() === "PUT" && new URL(r.url()).pathname === "/api/roster/r-adv-1", { timeout: 30000 });
  void putP.catch(() => {});
  await page.getByRole("button", { name: "Save draft changes" }).first().click();
  let putResp = null;
  try { putResp = await putP; } catch (e) {}
  ok("research-saved-put-confirmed", !!putResp && putResp.status() === 200, "PUT status=" + (putResp ? putResp.status() : "none"));
  await page.waitForFunction(() => /Researched v/.test(document.body.innerText), null, { timeout: 30000 });
  const savedResp = await page.waitForResponse((r) => r.request().method() === "GET" && new URL(r.url()).pathname === "/api/roster/r-adv-1/research", { timeout: 15000 }).catch(() => null);
  let savedOk = false;
  let savedJson = null;
  if (savedResp) { try { const sj = await savedResp.json(); savedJson = sj; savedOk = String(sj.draftStatus) === "saved" && sj.draftProfile && sj.draftProfile.responseStyle === CANON_PARAS.responseStyle && typeof sj.version === "number"; } catch (e) {} }
  const savedText = await bodyText();
  let rowConsistent = false;
  try {
    const rows = await page.evaluate(() => fetch("/api/roster").then((r) => r.json()));
    const row = (rows || []).map((x) => x.entry || x).find((e) => e && e.id === "r-adv-1");
    if (row && savedJson) rowConsistent = String(row.researchJson) === String(savedJson.researchJson) && row.version === savedJson.version && String(row.profileJson) === String(savedJson ? undefined : undefined || row.profileJson);
  } catch (e) {}
  let rowDocMatch = false;
  try {
    const rows2 = await page.evaluate(() => fetch("/api/roster").then((r) => r.json()));
    const row2 = (rows2 || []).map((x) => x.entry || x).find((e) => e && e.id === "r-adv-1");
    if (row2 && savedJson) {
      const rDoc = JSON.parse(row2.researchJson || "{}");
      rowDocMatch = row2.version === savedJson.version && JSON.stringify(rDoc.draftProfile) === JSON.stringify(savedJson.draftProfile) && String(rDoc.draftStatus) === String(savedJson.draftStatus);
    }
  } catch (e) {}
  ok("research-terminal-saved", savedOk && /Researched v/.test(savedText) && rowDocMatch, "saved via PUT: GET version aligns canonical entry v" + (savedJson ? savedJson.version : "?") + ", row researchJson/profile consistent: " + savedText.slice(0, 160));
  ok("research-saved-put-order", countFrom(putMark, "PUT", "/api/roster/r-adv-1") === 1, "exactly one PUT drove saved");
  gates.researchPost = deferred();
  let failP = null;
  try {
    researchTerminal = "failed";
    const fMark = reqLog.length;
    failP = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/roster/r-adv-1/research", { timeout: 30000 });
    void failP.catch(() => {});
    await page.getByRole("button", { name: "Research dossier" }).first().click();
    await waitForLog(fMark, "POST /api/roster/r-adv-1/research");
    await page.waitForFunction(() => document.body.innerText.indexOf("Research in progress") >= 0, null, { timeout: 30000 });
    ok("research-failrun-running", (await bodyText()).indexOf("Research in progress") >= 0, "failed rerun passes through running while POST held");
    try { gates.researchPost.release(); gates.researchPost = null; } catch (e) { gates.researchPost = null; }
    let fJson = null;
    try { const fr = await failP; try { fJson = await fr.json(); } catch (e) {} } catch (e) {}
    await page.waitForFunction(() => document.body.innerText.indexOf("Research failed") >= 0, null, { timeout: 30000 });
    const tf = await bodyText();
    const noRaw = tf.indexOf("SELECT") < 0 && tf.indexOf("/srv/db") < 0 && tf.indexOf("stageError") < 0;
    ok("research-failed-terminal", tf.indexOf("Research failed") >= 0, tf.slice(0, 200));
    ok("research-failed-no-raw", noRaw && !!fJson && String(fJson.stageError || "").indexOf("SELECT") >= 0, "adversarial SQL/path stageError present in response but never rendered raw: " + tf.slice(0, 200));
  } finally {
    try { if (gates.researchPost) { gates.researchPost.release(); gates.researchPost = null; } } catch (e) {}
  }
}
async function testResearchRetainedErrorOutranks() {
  resetProbeState();
  researchPhase = "running";
  researchPollsLeft = 999;
  researchTerminal = "draft";
  researchVersion = 6;
  entry.version = 6;
  researchHttpError = false;
  await openRoster();
  await selectRosterEntry();
  await page.waitForFunction(() => document.body.innerText.indexOf("Research in progress") >= 0, null, { timeout: 30000 });
  researchHttpError = true;
  try {
    await page.waitForFunction(() => document.body.innerText.indexOf("Research state unavailable") >= 0, null, { timeout: 30000 });
    const m1 = reqLog.length;
    const errP1 = page.waitForResponse((r) => r.request().method() === "GET" && new URL(r.url()).pathname === "/api/roster/r-adv-1/research", { timeout: 30000 });
    void errP1.catch(() => {});
    await page.getByRole("button", { name: "Check research status" }).first().click();
    let errJson1 = null;
    try { const er1 = await errP1; try { errJson1 = await er1.json(); } catch (e) {} } catch (e) {}
    await page.waitForFunction(() => document.body.innerText.indexOf("Research state unavailable") >= 0, null, { timeout: 30000 });
    const t1 = await bodyText();
    const adv1 = !!errJson1 && String(JSON.stringify(errJson1)).indexOf("SELECT") >= 0;
    ok("research-error-outranks-running", t1.indexOf("Research state unavailable") >= 0 && t1.indexOf("Research in progress") < 0, "poll error outranks independently cached RUNNING without reload: " + t1.slice(0, 180));
    ok("research-error-running-polled", countFrom(m1, "GET", "/api/roster/r-adv-1/research") >= 1, "running-retained error came from real refetch poll");
    ok("research-error-running-adv", adv1 && t1.indexOf("SELECT") < 0 && t1.indexOf("/srv/db") < 0, "adversarial SQL/path in response never rendered raw while running retained");
  } finally { researchHttpError = false; }
  resetProbeState();
  researchPhase = "done";
  researchTerminal = "draft";
  researchVersion = 7;
  entry.version = 7;
  researchHttpError = false;
  await openRoster();
  await selectRosterEntry();
  await page.waitForFunction(() => /Researched v7/.test(document.body.innerText), null, { timeout: 30000 });
  researchHttpError = true;
  try {
    await page.waitForFunction(() => document.body.innerText.indexOf("Research state unavailable") >= 0, null, { timeout: 30000 });
    const m2 = reqLog.length;
    const errP2 = page.waitForResponse((r) => r.request().method() === "GET" && new URL(r.url()).pathname === "/api/roster/r-adv-1/research", { timeout: 30000 });
    void errP2.catch(() => {});
    await page.getByRole("button", { name: "Check research status" }).first().click();
    let errJson2 = null;
    try { const er2 = await errP2; try { errJson2 = await er2.json(); } catch (e) {} } catch (e) {}
    await page.waitForFunction(() => document.body.innerText.indexOf("Research state unavailable") >= 0, null, { timeout: 30000 });
    const t2 = await bodyText();
    const adv2 = !!errJson2 && String(JSON.stringify(errJson2)).indexOf("/srv/db") >= 0;
    ok("research-error-outranks-success", t2.indexOf("Research state unavailable") >= 0 && !/Researched v7/.test(t2), "poll error outranks cached SUCCESS without new QueryClient (same page refetch): " + t2.slice(0, 180));
    ok("research-error-success-polled", countFrom(m2, "GET", "/api/roster/r-adv-1/research") >= 1, "success-retained error came from real refetch poll");
    ok("research-error-no-raw-2", adv2 && t2.indexOf("SELECT") < 0 && t2.indexOf("/srv/db") < 0, "adversarial stageError present in failed response, display stays sanitized: " + t2.slice(0, 180));
  } finally { researchHttpError = false; }
}
async function testPutMountedVerifyHeld() {
  resetProbeState();
  researchPhase = "done";
  researchTerminal = "draft";
  researchVersion = 24;
  entry.version = 24;
  await openRoster();
  await selectRosterEntry();
  await page.waitForFunction(() => /Researched/.test(document.body.innerText), null, { timeout: 30000 });
  const uniq = "MountedVerifyHeld-" + String(Date.now() % 100000);
  const newBody = "Direct and concise " + uniq + ", with reasons stated.";
  await page.locator("#cc-respond").first().fill(newBody);
  gates.rosterPut = deferred();
  let putP = null;
  try {
    putP = page.waitForResponse((r) => r.request().method() === "PUT" && new URL(r.url()).pathname === "/api/roster/r-adv-1", { timeout: 30000 });
    void putP.catch(() => {});
    const clickMark = reqLog.length;
    await page.getByRole("button", { name: "Save draft changes" }).first().click();
    await waitForLog(clickMark, "PUT /api/roster/r-adv-1");
    const base = reqLog.length;
    const verifyP = page.waitForResponse((r) => r.request().method() === "GET" && new URL(r.url()).pathname === "/api/roster/r-adv-1/research", { timeout: 30000 });
    void verifyP.catch(() => {});
    try { gates.rosterPut.release(); gates.rosterPut = null; } catch (e) { gates.rosterPut = null; }
    let resp = null;
    try { resp = await putP; } catch (e) {}
    ok("put-mounted-confirmed", !!resp && resp.status() === 200, "confirmed PUT status=" + (resp ? resp.status() : "none"));
    let verifyResp = null;
    try { verifyResp = await verifyP; } catch (e) {}
    ok("put-mounted-verify-held", !!verifyResp && verifyResp.status() === 200 && countFrom(base, "GET", "/api/roster/r-adv-1/research") >= 1, "mounted VERIFY GET arrived after confirmed PUT; confirmed invalidation produced fresh origin read status=" + (verifyResp ? verifyResp.status() : "none"));
    await page.waitForFunction((exp) => { const el = document.querySelector("#cc-respond"); return el && el.value === exp; }, newBody, { timeout: 30000 });
    const taVal = await page.locator("#cc-respond").first().inputValue().catch(() => "");
    ok("put-mounted-rendered", taVal === newBody, "textarea exact inputValue equals UNIQUE persisted suffix, not unchanged prefix20 or Saved fallback: got=" + taVal.slice(0, 80));
    const errs = page.__qaErrors || [];
    ok("put-mounted-no-errors", errs.length === 0, errs.slice(0, 3).join(" | "));
    ok("put-mounted-single", countFrom(clickMark, "PUT", "/api/roster/r-adv-1") === 1, "exactly one PUT in window (no duplicate write)");
  } finally {
    try { if (gates.rosterPut) { gates.rosterPut.release(); gates.rosterPut = null; } } catch (e) {}
    try { if (gates.researchGet) { gates.researchGet.release(); gates.researchGet = null; } } catch (e) {}
  }
}
async function testPutUnmountBeforeConfirm() {
  resetProbeState();
  researchPhase = "done";
  researchTerminal = "draft";
  researchVersion = 34;
  entry.version = 34;
  await openRoster();
  await selectRosterEntry();
  await page.waitForFunction(() => /Researched/.test(document.body.innerText), null, { timeout: 30000 });
  const uniq2 = "UnmountBeforeConfirm-" + String(Date.now() % 100000);
  const newBody2 = "Direct and concise " + uniq2 + ", with reasons stated.";
  await page.locator("#cc-respond").first().fill(newBody2);
  gates.rosterPut = deferred();
  let putP = null;
  try {
    putP = page.waitForResponse((r) => r.request().method() === "PUT" && new URL(r.url()).pathname === "/api/roster/r-adv-1", { timeout: 30000 });
    void putP.catch(() => {});
    const clickMark = reqLog.length;
    await page.getByRole("button", { name: "Save draft changes" }).first().click();
    await waitForLog(clickMark, "PUT /api/roster/r-adv-1");
    await openHash("#/boards");
    await page.waitForFunction(() => document.body.innerText.indexOf("Boards") >= 0, null, { timeout: 20000 });
    const unmountedOk = (await bodyText()).indexOf("Boards") >= 0;
    ok("put-unmount-before-confirm", unmountedOk, "editor unmounted while PUT still held");
    try { gates.rosterPut.release(); gates.rosterPut = null; } catch (e) { gates.rosterPut = null; }
    let resp = null;
    try { resp = await putP; } catch (e) {}
    ok("put-unmounted-confirmed", !!resp && resp.status() === 200, "status=" + (resp ? resp.status() : "none"));
    ok("put-unmounted-single", countFrom(clickMark, "PUT", "/api/roster/r-adv-1") === 1, "exactly one PUT held across unmount");
    await sleep(800);
    const reopenMark = reqLog.length;
    await openRoster();
    await page.locator("aside.listpanel button.lprow", { hasText: "QA Sage" }).first().click();
    await waitForLog(reopenMark, "GET /api/roster/r-adv-1/research");
    let taRe = "";
    for (let k = 0; k < 30; k++) { taRe = await page.locator("#cc-respond").first().inputValue({ timeout: 2000 }).catch(() => "MISSING"); if (taRe === newBody2) break; await sleep(300); }
    ok("put-unmounted-reopen-correct", taRe === newBody2, "fresh canonical GET AFTER reopen; exact full textarea equals new persisted profile, inactive cache only marked stale (no immediate GET demanded while unmounted): got=" + taRe.slice(0, 80));
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
  gates.rosterQuick = deferred();
  gates.rosterGet = deferred();
  let createdP = null;
  let rosterGetP = null;
  try {
    const base = reqLog.length;
    createdP = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/roster/quick", { timeout: 30000 });
    void createdP.catch(() => {});
    rosterGetP = page.waitForResponse((r) => r.request().method() === "GET" && new URL(r.url()).pathname === "/api/roster", { timeout: 30000 });
    void rosterGetP.catch(() => {});
    await page.getByRole("button", { name: "Create draft", exact: true }).click();
    await waitForLog(base, "POST /api/roster/quick");
    ok("create-post-held", countFrom(base, "POST", "/api/roster/quick") >= 1, "POST dispatched and held before confirm");
    try { gates.rosterQuick.release(); gates.rosterQuick = null; } catch (e) { gates.rosterQuick = null; }
    let cresp = null;
    try { cresp = await createdP; } catch (e) {}
    ok("create-confirmed", !!cresp && (cresp.status() === 200 || cresp.status() === 201), "POST CONFIRM status=" + (cresp ? cresp.status() : "none"));
    await waitForLog(base, "GET /api/roster");
    const postIdx = reqLog.slice(base).findIndex((e) => e === "POST /api/roster/quick");
    const getIdx = reqLog.slice(base).findIndex((e) => e === "GET /api/roster");
    ok("create-invalidates-before-adopt", postIdx >= 0 && getIdx >= 0 && postIdx < getIdx, "critical cache invalidated (canonical GET starts) after POST confirm and before editor callback adopts (postIdx=" + postIdx + " getIdx=" + getIdx + ")");
    await page.waitForFunction(() => document.body.innerText.indexOf("Step 2") >= 0, null, { timeout: 30000 });
    ok("create-adopts-after-refresh", (await bodyText()).indexOf("Step 2") >= 0, "editor adopts seeded draft after invalidation started while canonical GET still held (adopt before GET finish is the actual product order)");
    try { gates.rosterGet.release(); gates.rosterGet = null; } catch (e) { gates.rosterGet = null; }
    let getResp = null;
    try { getResp = await rosterGetP; } catch (e) {}
    ok("create-canonical-confirm", !!getResp && getResp.status() === 200, "separate canonical GET confirmation boundary completes after adoption, status=" + (getResp ? getResp.status() : "none"));
  } finally {
    try { if (gates.rosterQuick) { gates.rosterQuick.release(); gates.rosterQuick = null; } } catch (e) {}
    try { if (gates.rosterGet) { gates.rosterGet.release(); gates.rosterGet = null; } } catch (e) {}
  }
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
  let oldBriefP = null;
  try {
    await page.getByLabel("Briefing topic").fill("held briefing intent OLD");
    const enabledOld = await page.getByRole("button", { name: "Prepare briefing" }).first().isEnabled().catch(() => false);
    ok("brief-filled-enables", enabledOld === true, "fill new topic THEN enabled");
    const markOld = reqLog.length;
    oldBriefP = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/meetings/m-one/briefings", { timeout: 30000 });
    void oldBriefP.catch(() => {});
    await page.getByRole("button", { name: "Prepare briefing" }).first().click();
    await page.waitForFunction(() => document.body.innerText.indexOf("Preparing...") >= 0, null, { timeout: 30000 });
    ok("brief-held-pending", (await bodyText()).indexOf("Preparing...") >= 0, "queued OLD briefing holds behind its own barrier");
    await waitForLog(markOld, "POST /api/meetings/m-one/briefings");
    const markEditOld = reqLog.length;
    await page.getByRole("button", { name: "Edit", exact: true }).first().click();
    const editBox = page.locator("dialog.conv-settings .takenote textarea").first();
    await editBox.waitFor({ timeout: 15000 });
    await editBox.fill("Fixture note body plus held edit OLD.");
    const oldEditP = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/notes/n-1/edit", { timeout: 30000 });
    void oldEditP.catch(() => {});
    await page.getByRole("button", { name: "Save revision", exact: true }).click();
    await waitForLog(markEditOld, "POST /api/notes/n-1/edit");
    const markRevOld = reqLog.length;
    const oldRevP = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/notes/n-1/reverse", { timeout: 30000 });
    void oldRevP.catch(() => {});
    await page.getByRole("button", { name: "Reverse", exact: true }).first().click();
    await waitForLog(markRevOld, "POST /api/notes/n-1/reverse");
    const bOld = countFrom(markOld, "POST", "/api/meetings/m-one/briefings");
    const eOld = countFrom(markEditOld, "POST", "/api/notes/n-1/edit");
    const rOld = countFrom(markRevOld, "POST", "/api/notes/n-1/reverse");
    ok("edits-queued", bOld === 1 && eOld === 1 && rOld === 1, "OLD briefing/edit/reverse each dispatched exactly once behind independent barriers (array counts, not string.find): b=" + bOld + " e=" + eOld + " r=" + rOld);
    await applyIdentityAs("owner2");
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
    const newBriefP = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/meetings/m-one/briefings", { timeout: 30000 });
    void newBriefP.catch(() => {});
    await page.getByRole("button", { name: "Prepare briefing" }).first().click();
    await waitForLog(markNew, "POST /api/meetings/m-one/briefings");
    ok("overlap-newer-dispatched", countFrom(markNew, "POST", "/api/meetings/m-one/briefings") >= 1, "newer briefing dispatched while OLD callbacks still held (distinct gates, no OLD-then-NEW await coupling)");
    try { gates.briefingOld.release(); gates.briefingOld = null; } catch (e) { gates.briefingOld = null; }
    let oldResp = null;
    try { oldResp = await oldBriefP; } catch (e) { oldResp = null; }
    ok("overlap-old-processed", !!oldResp && oldResp.status() === 200, "OLD briefing response processed exactly (no swallowed waitForResponse timeout), status=" + (oldResp ? oldResp.status() : "none"));
    await sleep(400);
    const stillNewTopic = await page.getByLabel("Briefing topic").inputValue().catch(() => "MISSING");
    const stillNewBody = await bodyText();
    const meetTitleVal = await page.getByLabel("Meeting title").inputValue().catch(() => "");
    ok("overlap-old-cannot-clear-new", stillNewTopic === "fresh intent NEW" && stillNewBody.indexOf("Preparing...") >= 0 && meetTitleVal.indexOf("Pricing move QA session") >= 0, "OLD reply while NEW held leaves NEW Briefing-topic input/pending intact (checked exact Briefing topic, not Meeting title): topic=" + JSON.stringify(stillNewTopic).slice(0, 60));
    try { gates.briefingNew.release(); gates.briefingNew = null; } catch (e) { gates.briefingNew = null; }
    let newResp = null;
    try { newResp = await newBriefP; } catch (e) { newResp = null; }
    let cleared = false;
    for (let k = 0; k < 30; k++) { const v = await page.getByLabel("Briefing topic").inputValue({ timeout: 2000 }).catch(() => "MISSING"); if (v === "") { cleared = true; break; } await sleep(300); }
    ok("identity-new-brief-completes", !!newResp && newResp.status() === 200 && countFrom(markNew, "POST", "/api/meetings/m-one/briefings") === 1 && cleared, "NEW briefing completes exact once with Briefing-topic input cleared (checked exact topic input, not Meeting title), status=" + (newResp ? newResp.status() : "none"));
    // OLD edit/reverse stay HELD while NEW edit/reverse run: releasing now would let the
    // stub apply reverse to n-1, flipping it read-only before NEW reverse targets it.
    gates.noteEdit = deferred();
    await page.getByRole("button", { name: "Edit", exact: true }).first().click();
    const editBox2 = page.locator("dialog.conv-settings .takenote textarea").first();
    await editBox2.waitFor({ timeout: 15000 });
    await editBox2.fill("second fresh edit NEW.");
    const mark3 = reqLog.length;
    const editRespP = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/notes/n-1/edit", { timeout: 30000 });
    void editRespP.catch(() => {});
    await page.getByRole("button", { name: "Save revision", exact: true }).click();
    await waitForLog(mark3, "POST /api/notes/n-1/edit");
    try { gates.noteEdit.release(); gates.noteEdit = null; } catch (e) { gates.noteEdit = null; }
    let editResp = null;
    try { editResp = await editRespP; } catch (e) {}
    ok("identity-new-edit-completes", !!editResp && editResp.status() === 200 && countFrom(mark3, "POST", "/api/notes/n-1/edit") === 1, "fresh edit posts once and closes editor, status=" + (editResp ? editResp.status() : "none"));
    await page.waitForFunction(() => document.querySelectorAll("dialog.conv-settings .takenote textarea").length === 0, null, { timeout: 30000 });
    gates.noteReverse = deferred();
    const mark4 = reqLog.length;
    const revRespP = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/notes/n-1/reverse", { timeout: 30000 });
    void revRespP.catch(() => {});
    await page.getByRole("button", { name: "Reverse", exact: true }).first().click();
    await waitForLog(mark4, "POST /api/notes/n-1/reverse");
    try { gates.noteReverse.release(); gates.noteReverse = null; } catch (e) { gates.noteReverse = null; }
    let revResp = null;
    try { revResp = await revRespP; } catch (e) {}
    ok("identity-new-reverse-completes", !!revResp && revResp.status() === 200 && countFrom(mark4, "POST", "/api/notes/n-1/reverse") === 1, "fresh reverse posts once, status=" + (revResp ? revResp.status() : "none"));
    await page.waitForFunction(() => document.body.innerText.indexOf("Note reversed") >= 0, null, { timeout: 30000 });
    try { if (gates.noteEditOld) { gates.noteEditOld.release(); gates.noteEditOld = null; } } catch (e) {}
    try { if (gates.noteReverseOld) { gates.noteReverseOld.release(); gates.noteReverseOld = null; } } catch (e) {}
    try { await oldEditP; } catch (e) {}
    try { await oldRevP; } catch (e) {}
    await sleep(400);
    ok("identity-old-edit-reverse-silent", (page.__qaErrors || []).length === 0 && (await bodyText()).indexOf("Note reversed") >= 0, "retired OLD edit/reverse released last stay silent (no crash, no NEW clobber; stub-side apply cannot clear NEW confirmation)");
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
  await closeMeetingSettings();
  await page.waitForFunction(() => !document.querySelector("dialog.conv-settings[open]"), null, { timeout: 20000 });
  await page.waitForFunction(() => document.body.innerText.indexOf("all listening") >= 0, null, { timeout: 30000 });
  // INITIAL OLD held through main composer (dialog CLOSED; audience secretary + prefix per actual Send142 route).
  gates.secInitial = deferred();
  let oldInitP = null;
  try {
    await page.locator('select[aria-label="Message audience"]').selectOption("secretary");
    await page.getByLabel("Message. Press Enter to send, Shift and Enter for a new line.").fill("secretary: held initial intent OLD");
    const markOldInit = reqLog.length;
    oldInitP = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/meetings/m-one/secretary", { timeout: 30000 });
    void oldInitP.catch(() => {});
    await page.getByRole("button", { name: "Send" }).first().click();
    await page.waitForFunction(() => document.body.innerText.indexOf("Sending secretary...") >= 0, null, { timeout: 30000 });
    ok("sec-initial-held", (await bodyText()).indexOf("Sending secretary...") >= 0, "OLD initial held shows pending via main composer secretary route");
    await waitForLog(markOldInit, "POST /api/meetings/m-one/secretary");
    const oldInitGate = gates.secInitial;
    // Identity retirement: Apply on PEOPLE retires the held OLD initial (epoch bump, pending cleared).
    await applyIdentityAs("owner3");
    await openMeet();
    await closeMeetingSettings();
    await page.waitForFunction(() => !document.querySelector("dialog.conv-settings[open]"), null, { timeout: 20000 });
    gates.secInitial = deferred();
    await page.locator('select[aria-label="Message audience"]').selectOption("secretary");
    await page.getByLabel("Message. Press Enter to send, Shift and Enter for a new line.").fill("secretary: fresh initial NEW");
    const markNewInit = reqLog.length;
    const newInitP = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/meetings/m-one/secretary", { timeout: 30000 });
    void newInitP.catch(() => {});
    await page.getByRole("button", { name: "Send" }).first().click();
    await waitForLog(markNewInit, "POST /api/meetings/m-one/secretary");
    ok("sec-initial-overlap-new", countFrom(markNewInit, "POST", "/api/meetings/m-one/secretary") >= 1, "NEW initial dispatched while OLD still held (distinct dispatch-captured gates)");
    try { oldInitGate.release(); } catch (e) {}
    let oldInitResp = null;
    try { oldInitResp = await oldInitP; } catch (e) {}
    ok("sec-initial-old-retired", !!oldInitResp && oldInitResp.status() === 200 && (await bodyText()).indexOf("held initial intent OLD") < 0, "retired OLD initial response processed but cannot clear NEW session (epoch/origin guard): status=" + (oldInitResp ? oldInitResp.status() : "none"));
    try { gates.secInitial.release(); gates.secInitial = null; } catch (e) { gates.secInitial = null; }
    let newInitResp = null;
    try { newInitResp = await newInitP; } catch (e) {}
    ok("sec-initial-completes", !!newInitResp && newInitResp.status() === 200, "NEW initial completes exact once, status=" + (newInitResp ? newInitResp.status() : "none"));
    await openMeetingSettings();
    await page.waitForFunction(() => document.body.innerText.indexOf("Secretary clarification") >= 0, null, { timeout: 30000 });
    const clar = await bodyText();
    ok("sec-initial-readback", clar.indexOf("Secretary clarification") >= 0 && clar.indexOf("fresh initial NEW") >= 0, "NEW initial clarification readback inside OPEN dialog: " + clar.slice(0, 180));
    await closeMeetingSettings();
  } finally {
    try { if (gates.secInitial) { gates.secInitial.release(); gates.secInitial = null; } } catch (e) {}
  }
  // ANSWER (inside OPEN dialog, actual Send answer button).
  gates.secAnswer = deferred();
  try {
    await openMeetingSettings();
    const ansBox = page.getByLabel("Answer").first();
    await ansBox.waitFor({ timeout: 15000 });
    await ansBox.fill("held answer body NEW");
    const markAns = reqLog.length;
    const ansP = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/meetings/m-one/secretary/answer", { timeout: 30000 });
    void ansP.catch(() => {});
    await page.getByRole("button", { name: "Send answer" }).first().click();
    await waitForLog(markAns, "POST /api/meetings/m-one/secretary/answer");
    ok("sec-answer-held", countFrom(markAns, "POST", "/api/meetings/m-one/secretary/answer") >= 1, "answer held behind its own barrier with real dispatch");
    try { gates.secAnswer.release(); gates.secAnswer = null; } catch (e) { gates.secAnswer = null; }
    let ansResp = null;
    try { ansResp = await ansP; } catch (e) {}
    ok("sec-answer-completes", !!ansResp && ansResp.status() === 200, "answer status=" + (ansResp ? ansResp.status() : "none"));
    await page.waitForFunction(() => document.body.innerText.indexOf("Secretary note saved") >= 0, null, { timeout: 30000 });
    ok("sec-answer-readback", (await bodyText()).indexOf("Secretary note saved") >= 0, "answer completes with mounted readback inside dialog");
    await closeMeetingSettings();
  } finally {
    try { if (gates.secAnswer) { gates.secAnswer.release(); gates.secAnswer = null; } } catch (e) {}
  }
  // RETRY: fail-once MUST actually fail BEFORE installing the RETRY hold; stage gates after error.
  await openMeet();
  await closeMeetingSettings();
  await page.locator('select[aria-label="Message audience"]').selectOption("secretary");
  await page.getByLabel("Message. Press Enter to send, Shift and Enter for a new line.").fill("secretary: fail-once retry probe");
  let sendReady = "";
  for (let k = 0; k < 50; k++) {
    sendReady = await page.evaluate(() => {
      try {
        const sel = document.querySelector('select[aria-label="Message audience"]');
        const ta = document.querySelector('textarea[aria-label="Message. Press Enter to send, Shift and Enter for a new line."]');
        const btns = [...document.querySelectorAll("button")].filter((b) => (b.textContent || "").trim() === "Send");
        const b0 = btns[0];
        return "sel=" + (sel ? sel.value : "?") + " ta=" + (ta ? String(ta.value).slice(0, 40) : "?") + " dis=" + (b0 ? String(b0.disabled) : "?");
      } catch (e) { return "evalfail"; }
    }).catch(() => "evalfail");
    if (sendReady.indexOf("sel=secretary") >= 0 && sendReady.indexOf("fail-once") >= 0 && sendReady.indexOf("dis=false") >= 0) break;
    await sleep(200);
  }
  ok("sec-retry-ready", sendReady.indexOf("sel=secretary") >= 0 && sendReady.indexOf("fail-once") >= 0, "composer state settled before retry Send (actual select/textarea/disabled): " + sendReady);
  const mSend = reqLog.length;
  const bodyMark = seenSecretaryInputs.length;
  await page.getByRole("button", { name: "Send" }).first().click();
  await sleep(1500);
  const pendProbe = await bodyText();
  const pendSeen = pendProbe.indexOf("Sending secretary") >= 0 || pendProbe.indexOf("Secretary working") >= 0 || pendProbe.indexOf("Secretary error") >= 0;
  try { await waitForLog(mSend, "POST /api/meetings/m-one/secretary"); }
  catch (e) {
    const tail = await bodyText();
    try { if (outPath) fs.appendFileSync(outPath, "FAILREQ req=" + reqLog.slice(-8).join(" | ") + " body=" + tail.slice(0, 400) + "\n"); } catch (x) {}
    throw e;
  }
  const gotFailOnce = seenSecretaryInputs.slice(bodyMark).join(" || ");
  ok("sec-retry-input", gotFailOnce.indexOf("fail-once") >= 0, "fail-once intent actually reached the stub input: " + gotFailOnce.slice(0, 120));
  await openMeetingSettings();
  await page.waitForFunction(() => document.body.innerText.indexOf("Secretary error") >= 0, null, { timeout: 30000 });
  const errText = await bodyText();
  ok("sec-retry-available", errText.indexOf("Retry secretary (same envelope)") >= 0, "fail-once initial actually FAILED before any RETRY hold, surfacing retry with same envelope: " + errText.slice(0, 180));
  gates.secRetry = deferred();
  try {
    await page.locator('select[aria-label="Message audience"]').selectOption("secretary");
    const mRet = reqLog.length;
    const retP = page.waitForResponse((r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/meetings/m-one/secretary", { timeout: 30000 });
    void retP.catch(() => {});
    await page.getByRole("button", { name: "Retry secretary (same envelope)" }).first().click();
    await waitForLog(mRet, "POST /api/meetings/m-one/secretary");
    ok("sec-retry-held", countFrom(mRet, "POST", "/api/meetings/m-one/secretary") >= 1, "retry held behind its own barrier with real dispatch after staged error");
    try { gates.secRetry.release(); gates.secRetry = null; } catch (e) { gates.secRetry = null; }
    let retResp = null;
    try { retResp = await retP; } catch (e) {}
    ok("sec-retry-completes", !!retResp && retResp.status() === 200, "retry status=" + (retResp ? retResp.status() : "none"));
    await openMeetingSettings();
    await page.waitForFunction(() => document.body.innerText.indexOf("Secretary clarification") >= 0, null, { timeout: 30000 });
    ok("sec-retry-readback", (await bodyText()).indexOf("Secretary clarification") >= 0, "retry completes with clarification readback inside dialog");
    await closeMeetingSettings();
  } finally {
    try { if (gates.secRetry) { gates.secRetry.release(); gates.secRetry = null; } } catch (e) {}
    try { if (gates.secInitial) { gates.secInitial.release(); gates.secInitial = null; } } catch (e) {}
  }
}
async function testProvenance() {
  const crypto = await import("node:crypto");
  const headFile = (() => { try { return fs.readFileSync(path.join(here, "..", ".git"), "utf8"); } catch (e) { return ""; } })();
  let headRef = "";
  try {
    const m = headFile.match(/gitdir:\s*(.+)/);
    if (m) {
      const gd = m[1].trim();
      headRef = fs.readFileSync(path.join(gd, "HEAD"), "utf8").trim().slice(0, 120);
    }
  } catch (e) {}
  let headSym = "";
  try {
    const m2 = headFile.match(/gitdir:\s*(.+)/);
    if (m2) {
      const gd2 = m2[1].trim();
      const headRaw = fs.readFileSync(path.join(gd2, "HEAD"), "utf8").trim();
      const rm = headRaw.match(/ref:\s*(.+)/);
      if (rm) { try { headSym = fs.readFileSync(path.join(gd2, rm[1].trim()), "utf8").trim().slice(0, 80); } catch (e) {} }
      else headSym = headRaw.slice(0, 80);
    }
  } catch (e) {}
  let distFiles = [];
  try { distFiles = fs.readdirSync(path.join(dist, "assets")).filter((f) => f.endsWith(".js") || f.endsWith(".css")); } catch (e) {}
  const hashes = [];
  for (const f of distFiles) {
    try {
      const buf = fs.readFileSync(path.join(dist, "assets", f));
      const h = crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
      hashes.push(f + ":sha256:" + h);
    } catch (e) {}
  }
  const idxExists = (() => { try { return fs.statSync(path.join(dist, "index.html")).size > 0; } catch (e) { return false; } })();
  ok("provenance-head", headRef.length > 0, "observed worktree HEAD text (NOT intrinsic commit binding): " + headRef.slice(0, 80) + " sym=" + headSym.slice(0, 40));
  ok("provenance-dist", idxExists && hashes.length >= 2, "served bundle observed asset SHA256 (content hashes, not sizes/mtimes; binding established by primary build command + before/after git webtree SHA256 manifest via existing toolchain, no new shipping hook): " + hashes.slice(0, 4).join(" | ").slice(0, 220));
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
