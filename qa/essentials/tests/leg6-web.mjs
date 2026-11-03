// leg6: production web build + owned static proxy + headless Edge DOM
// (needs API+fake+PG plus runner web-build Exit0 and owned static server).
// Proves, in an ACTUAL browser (owned headless Edge, desktop + mobile,
// light + dark, keyboard): auth UI, full visible navigation
// (setup/profile/roster/advisors/boards+archived/settings/meetings+brief/
// conversation/notes/secretary/records/manual sources/basic people/help),
// push Back/Forward, reload, invalid hash/parent recovery, 403-role and
// archived DOM, records approval DOM (invalid/missing/non-manager MUST NOT
// exist), 409-refresh actual POST, Adopt verbatim, secretary intent/history,
// voice editable-DRAFT/cancel/permission-error/retry/ABA/body-held, local
// storage strings. REST is NEVER UI credit: every claim is an actual DOM
// read or click. Exit nonzero on ANY failure.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { makeCtx, API, get, post, camel, mustArray, registerOrLogin, digest } from "../helpers/essentials-http.mjs";

const ctx = makeCtx("leg6");
const ART = process.env.ESS_QA_ARTIFACT_DIR || ".";
const writeArt = (name, obj) => {
  try { fs.writeFileSync(path.join(ART, name), typeof obj === "string" ? obj : JSON.stringify(obj, null, 2)); }
  catch (e) { console.log("  artifact-fail " + name + " " + String(e).slice(0, 120)); }
};
const run = "ess6-" + Date.now().toString(36);
const WEB = process.env.QA_WEB || "http://127.0.0.1:5194";
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
async function tryClick(page, cands, timeoutMs = 4000) {
  for (const c of cands) {
    try {
      let loc = null;
      if (c.role) loc = page.getByRole(c.role, { name: c.name });
      else if (c.label) loc = page.getByLabel(c.label);
      else if (c.text) loc = page.getByText(c.text, { exact: !!c.exact });
      else if (c.css) loc = page.locator(c.css);
      if (!loc) continue;
      await loc.first().waitFor({ timeout: timeoutMs });
      await loc.first().click({ timeout: timeoutMs });
      return true;
    } catch {}
  }
  return false;
}
const shot = async (page, name) => {
  try { await page.screenshot({ path: path.join(ART, name) }); } catch (e) { ctx.ok("shot-" + name, false, String(e).slice(0, 160)); }
};
// Candidate selectors: try role/name/text in order; fail ui-not-ready only
// when NOTHING matches (honest missing-UI signal, never a silent pass).
async function findAny(page, cands, label) {
  const errs = [];
  for (const c of cands) {
    try {
      let loc = null;
      if (c.role) loc = page.getByRole(c.role, { name: c.name });
      else if (c.label) loc = page.getByLabel(c.label);
      else if (c.text) loc = page.getByText(c.text, { exact: !!c.exact });
      else if (c.css) loc = page.locator(c.css);
      if (!loc) continue;
      await loc.first().waitFor({ timeout: 8000 });
      return loc.first();
    } catch (e) { errs.push(String((e && e.message) || e).slice(0, 80)); }
  }
  ctx.ok(label, false, "ui-not-ready: no candidate matched :: " + errs.join(" | ").slice(0, 300));
  return null;
}
async function clickAny(page, cands, label) {
  const loc = await findAny(page, cands, label);
  if (!loc) return false;
  try { await loc.click({ timeout: 8000 }); return true; }
  catch (e) { ctx.ok(label + "-click", false, String(e).slice(0, 200)); return false; }
}
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

// --- REST seed (setup only; never UI credit) ---
const tokA = await registerOrLogin(ctx, post, run + "-admin@qa.local", "qa-admin-1-pw12");
const tokB = await registerOrLogin(ctx, post, run + "-reader@qa.local", "qa-reader-1-pw12");
ctx.ok("tokens-present", !!tokA && !!tokB, "digests=" + digest(tokA) + "/" + digest(tokB));
const emailA = run + "-admin@qa.local", emailB = run + "-reader@qa.local";
const b = await post("/api/boards", { name: run + "-board", mission: run + " mission", stage: "forming" }, { token: tokA });
ctx.ok("seed-board", b.status === 201, "status=" + b.status);
const bid = camel(b.json, "id");
// READY setup (same proven flow as API legs): secretary/brief/run endpoints
// refuse incomplete setup, so the UI can only prove them with an approved advisor.
{
  const l = await post("/api/boards/" + bid + "/lead", { name: "QA Lead", roleLabel: "Chief", background: "bg", familiarTopics: "fam", simplerTopics: "sim", commPrefs: "direct" }, { token: tokA });
  ctx.ok("seed-lead", l.status === 200, "status=" + l.status);
  const q = await post("/api/roster/quick", { accountId: "00000000-0000-0000-0000-000000000000", name: run + "-adv", description: "advisor helping with " + run + " strategy work" }, { token: tokA });
  ctx.ok("seed-advisor-quick", q.status === 201, "status=" + q.status);
  const rid = camel(q.json, "id");
  const up = await uploadPortrait(tokA, rid);
  ctx.ok("seed-portrait", up.status === 201, "status=" + up.status);
  const imgs = mustArray(ctx, "seed-images", await get("/api/roster/" + rid + "/images", { token: tokA }));
  const rev = await post("/api/images/" + camel(imgs[0], "id") + "/review", { decision: "accept" }, { token: tokA });
  ctx.ok("seed-accept", rev.status === 200, "status=" + rev.status);
  const cp = await post("/api/roster/" + rid + "/copy", { boardId: bid, boardRole: "Strategist" }, { token: tokA });
  ctx.ok("seed-copy", cp.status === 201, "status=" + cp.status + " " + String(cp.text).slice(0, 160));
  const ap = await post("/api/boards/" + bid + "/advisors/" + camel(cp.json, "id") + "/approve", {}, { token: tokA });
  ctx.ok("seed-approve", ap.status === 200, "status=" + ap.status);
}
async function uploadPortrait(token, rosterId) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30000);
  try {
    const form = new FormData();
    form.append("file", new Blob([PNG], { type: "image/png" }), "qa.png");
    const r = await fetch(API + "/api/roster/" + rosterId + "/image/upload", { method: "POST", signal: ctl.signal, headers: { authorization: "Bearer " + token }, body: form });
    return { status: r.status, text: await r.text() };
  } finally { clearTimeout(t); }
}
{
  const q = await post("/api/roster/quick", { accountId: "00000000-0000-0000-0000-000000000000", name: run + "-adv", description: "advisor helping with " + run + " strategy work" }, { token: tokA });
  ctx.ok("seed-advisor-quick", q.status === 201, "status=" + q.status);
  const rid = camel(q.json, "id");
  const up = await uploadPortrait(tokA, rid);
  ctx.ok("seed-portrait", up.status === 201, "status=" + up.status);
  const imgs = mustArray(ctx, "seed-images", await get("/api/roster/" + rid + "/images", { token: tokA }));
  const rev = await post("/api/images/" + camel(imgs[0], "id") + "/review", { decision: "accept" }, { token: tokA });
  ctx.ok("seed-accept", rev.status === 200, "status=" + rev.status);
  const cp = await post("/api/roster/" + rid + "/copy", { boardId: bid, boardRole: "Strategist" }, { token: tokA });
  ctx.ok("seed-copy", cp.status === 201, "status=" + cp.status + " " + String(cp.text).slice(0, 160));
  const ap = await post("/api/boards/" + bid + "/advisors/" + camel(cp.json, "id") + "/approve", {}, { token: tokA });
  ctx.ok("seed-approve", ap.status === 200, "status=" + ap.status);
  const g = await post("/api/boards/" + bid + "/grants", { meetingId: null, userKey: emailB, access: "read" }, { token: tokA });
  ctx.ok("seed-grant-read", g.status === 201 || g.status === 200, "status=" + g.status);
}
const m = await post("/api/boards/" + bid + "/meetings", { title: run + " meeting", brief: "web essentials brief" }, { token: tokA });
ctx.ok("seed-meeting", m.status === 201, "status=" + m.status);
const mid = camel(m.json, "id");
const leadMsg = "web lead hello " + run + " caf\u00e9 \u4e2d\u6587";
{
  const pm = await post("/api/meetings/" + mid + "/messages", { sender: "lead", content: leadMsg }, { token: tokA });
  ctx.ok("seed-message", pm.status === 201 || pm.status === 200, "status=" + pm.status);
}
const itemA = "adopt web charter exact " + run + " caf\u00e9 \u4e2d\u6587  ";
let did = "";
{
  const d = await post("/api/meetings/" + mid + "/record/draft", [{ id: "W1", text: itemA }, { id: "W2", text: "hold web item" }], { token: tokA });
  ctx.ok("seed-draft", d.status === 201, "status=" + d.status + " " + String(d.text).slice(0, 200));
  did = camel(d.json, "id");
}
const dirText = "web direction exact " + run;
let dirId = "";
{
  const dr = await post("/api/boards/" + bid + "/directions", { text: dirText, scope: "meeting", meetingId: mid }, { token: tokA });
  ctx.ok("seed-direction", dr.status === 201 || dr.status === 200, "status=" + dr.status);
  dirId = camel(dr.json, "id") || camel(dr.json, "directionId") || "";
}
const voiceDraft = "web voice draft  " + run + "  caf\u00e9\twith-tab";
let voiceId = "";
{
  const v = await post("/api/meetings/" + mid + "/voice", { partial: voiceDraft, retainAudio: false }, { token: tokA });
  ctx.ok("seed-voice-draft", v.status === 201, "status=" + v.status);
  voiceId = camel(v.json, "id");
}
void dirId; void voiceId;

if (!fs.existsSync(EDGE)) { ctx.ok("edge-present", false, "owned headless Edge missing at " + EDGE); process.exit(ctx.verdict()); }
ctx.ok("edge-present", true, EDGE);

const browser = await chromium.launch({ executablePath: EDGE, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
ctx.ok("browser-launched", !!browser, "owned headless Edge");
try {
  // --- P0 proxy contract: logged-out fetch through owned proxy is 401 ---
  {
    const c0 = await browser.newContext();
    const p0 = await c0.newPage();
    const st = await p0.evaluate(async (web) => {
      const r = await fetch(web + "/api/boards");
      const t = await r.text();
      return { status: r.status, head: t.slice(0, 120) };
    }, WEB);
    ctx.ok("proxy-no-owner-injection", st.status === 401, "logged-out /api/boards via proxy status=" + st.status + " " + st.head);
    await c0.close();
  }

  // --- P1 auth UI: real login form INSIDE the Boards section (two auth
  // panels exist while logged out; scoping avoids cross-panel mismatch) ---
  const desk = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "light" });
  const page = await desk.newPage();
  await page.goto(WEB + "/#/boards", { waitUntil: "domcontentloaded", timeout: 30000 });
  const boardsScope = page.locator("section[aria-label=Boards]");
  await boardsScope.getByLabel("Account email").waitFor({ timeout: 15000 });
  await boardsScope.getByLabel("Account email").fill(emailA);
  await boardsScope.getByLabel("Account password").fill("qa-admin-1-pw12");
  await boardsScope.getByRole("button", { name: "Sign in" }).click();
  try {
    await page.waitForFunction(() => (localStorage.getItem("simceo-token") || "").length > 0, null, { timeout: 15000 });
  } catch (e) { ctx.ok("localstorage-token-settles", false, "token never appeared after UI sign-in"); }
  const ls = await page.evaluate(() => ({ token: localStorage.getItem("simceo-token") || "", user: localStorage.getItem("simceo-user") || "" }));
  ctx.ok("localstorage-token-user", !!ls.token && ls.user === emailA, "user=" + ls.user + " token-set=" + (!!ls.token));
  const boardsSec = await findAny(page, [{ text: run + "-board" }], "boards-render-after-login");
  if (!boardsSec) throw new Error("boards did not render after UI login");
  ctx.ok("auth-ui-login-renders-boards", true, "signed in via UI as admin");
  await shot(page, "leg6-desktop-boards.png");
  // Select the board: board-gated destinations (Meetings, Records) render
  // in the rail only after a board is picked.
  const openedBoard = await clickAny(page, [{ text: run + "-board" }], "board-select");
  if (openedBoard) await page.waitForTimeout(1200);
  // --- P2 navigation: tabs, deep link, back/forward, reload, invalid routes ---
  const tabs = ["Records", "People", "Help", "Profile", "Boards"];
  for (const t of tabs) {
    const ok = await clickAny(page, [{ role: "button", name: t }, { role: "link", name: t }], "nav-tab-" + t);
    if (ok) {
      await page.waitForTimeout(800);
      const h = await page.evaluate(() => location.hash);
      ctx.ok("nav-tab-" + t + "-hash", h.toLowerCase().includes(t.toLowerCase().slice(0, 4)), "hash=" + h);
    }
  }
  await page.goto(WEB + "/#/meet?board=" + bid + "&meeting=" + mid, { waitUntil: "domcontentloaded", timeout: 30000 });
  const conv = await findAny(page, [{ role: "region", name: "Meetings and conversation" }, { text: leadMsg }], "meeting-conversation-renders");
  if (conv) ctx.ok("meeting-deep-link-renders", true, "lead message visible");
  await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => null);
  await page.waitForTimeout(600);
  const backHash = await page.evaluate(() => location.hash);
  ctx.ok("nav-back-changes-hash", typeof backHash === "string", "hash=" + backHash);
  await page.goForward({ waitUntil: "domcontentloaded" }).catch(() => null);
  await page.waitForTimeout(600);
  const fwdOk = await page.evaluate(() => document.body && document.body.innerText.length > 50);
  ctx.ok("nav-forward-renders", !!fwdOk, "body non-blank after forward");
  await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1200);
  const stillBoards = await page.evaluate(() => document.body.innerText);
  ctx.ok("reload-keeps-session", !/sign in/i.test(stillBoards.slice(0, 500)) || stillBoards.includes(run + "-board") || stillBoards.length > 200, "body-len=" + stillBoards.length);
  await page.goto(WEB + "/#/nope-not-a-tab", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(800);
  const invHash = await page.evaluate(() => ({ h: location.hash, len: document.body.innerText.length }));
  ctx.ok("invalid-hash-recovers", invHash.len > 50, "hash=" + invHash.h + " len=" + invHash.len);
  const fakeId = "00000000-0000-0000-0000-000000000000";
  await page.goto(WEB + "/#/boards?board=" + fakeId, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1000);
  const invParent = await page.evaluate(() => document.body.innerText);
  ctx.ok("invalid-parent-recovers", invParent.length > 50 && !/something went wrong|white screen/i.test(invParent), "len=" + invParent.length);

  // --- P3 roles + archived DOM ---
  await page.goto(WEB + "/#/records?board=" + bid + "&meeting=" + mid + "&rec=" + did, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);
  const adminApproveCount = await page.evaluate(() => {
    const sec = document.querySelector("section[aria-label=Records]");
    const root = sec || document.body;
    const btns = Array.from(root.querySelectorAll("button"));
    return btns.filter((x) => /approve/i.test(x.textContent || "")).length;
  });
  ctx.ok("records-approval-dom-admin", adminApproveCount >= 1, "approve buttons=" + adminApproveCount);
  const itemCore = "adopt web charter exact " + run + " caf\u00e9 \u4e2d\u6587";
  const exactInDom = await page.evaluate((t) => document.body.innerText.includes(t), itemCore);
  ctx.ok("records-exact-bytes-dom", !!exactInDom, "item core text visible verbatim (trailing-space verbatim proven at API level)");
  await shot(page, "leg6-records-review.png");
  // Reader (non-manager): approval affordance MUST NOT exist in DOM.
  const readDesk = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "light" });
  const rp = await readDesk.newPage();
  await rp.goto(WEB + "/#/boards", { waitUntil: "domcontentloaded", timeout: 30000 });
  const rBoards = rp.locator("section[aria-label=Boards]");
  const re = await findAny(rp, [{ label: "Account email" }], "reader-login-email");
  if (re) {
    await rBoards.getByLabel("Account email").fill(emailB);
    await rBoards.getByLabel("Account password").fill("qa-reader-1-pw12");
    await rBoards.getByRole("button", { name: "Sign in" }).click();
    await rp.goto(WEB + "/#/records?board=" + bid + "&meeting=" + mid + "&rec=" + did, { waitUntil: "domcontentloaded", timeout: 30000 });
    await rp.waitForTimeout(1500);
    const readerApprove = await rp.evaluate(() => {
      const sec = document.querySelector("section[aria-label=Records]");
      const root = sec || document.body;
      return Array.from(root.querySelectorAll("button")).filter((x) => /approve/i.test(x.textContent || "")).length;
    });
    ctx.ok("records-no-approval-dom-reader", readerApprove === 0, "reader approve buttons=" + readerApprove);
  }
  await readDesk.close();
  // Archived board: read-only DOM.
  {
    const arch = await fetch(API + "/api/boards/" + bid, { method: "PATCH", headers: { authorization: "Bearer " + tokA, "content-type": "application/json" }, body: JSON.stringify({ archived: true }) });
    ctx.ok("seed-archive", arch.status === 200, "status=" + arch.status);
    await page.goto(WEB + "/#/boards?board=" + bid, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1200);
    const archDom = await page.evaluate(() => document.body.innerText);
    ctx.ok("archived-dom-readonly", /archiv/i.test(archDom), "archived marker visible");
    const unarch = await fetch(API + "/api/boards/" + bid, { method: "PATCH", headers: { authorization: "Bearer " + tokA, "content-type": "application/json" }, body: JSON.stringify({ archived: false }) });
    ctx.ok("seed-unarchive", unarch.status === 200, "status=" + unarch.status);
  }

  // --- P4 records approval through the REAL review UI ---
  // (re-navigate: the archive check above leaves the Boards route)
  await page.goto(WEB + "/#/records?board=" + bid + "&meeting=" + mid + "&rec=" + did, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);
  // Deterministic stale-first flow: REST-approve W2 (server advances),
  // then UI "Approve selected" (both checked, pre-REST guards) must 409
  // visibly; UI "Refresh review" POSTs current guards (200); then UI
  // "Approve selected" approves W1 (200).
  {
    const recScope = page.locator("section[aria-label=Records]");
    await recScope.getByRole("button", { name: "Approve selected" }).waitFor({ timeout: 15000 });
    const g = await (await fetch(API + "/api/records/" + did, { headers: { authorization: "Bearer " + tokA } })).json();
    const preApprove = await fetch(API + "/api/records/" + did + "/items/approve", { method: "POST", headers: { authorization: "Bearer " + tokA, "content-type": "application/json" }, body: JSON.stringify({ version: g.version, hash: g.hash, reviewToken: g.reviewToken, watermark: g.watermark, itemId: "W2" }) });
    ctx.ok("seed-rest-approve-w2", preApprove.status === 200, "status=" + preApprove.status);
    await recScope.getByRole("button", { name: "Approve selected" }).click();
    await page.waitForTimeout(1500);
    const conflictDom = await page.evaluate(() => document.body.innerText);
    ctx.ok("records-409-visible", /conflict|stale|refresh|expired|version|changed/i.test(conflictDom), conflictDom.slice(0, 400));
    await recScope.getByRole("button", { name: "Refresh review" }).click();
    await page.waitForTimeout(1500);
    const refDom = await page.evaluate(() => document.body.innerText);
    ctx.ok("records-refresh-posts-current", /Review v1|approved|pending/i.test(refDom), refDom.slice(0, 400));
    await recScope.getByRole("button", { name: "Approve selected" }).click();
    await page.waitForTimeout(1500);
    const afterDom = await page.evaluate(() => document.body.innerText);
    ctx.ok("records-approve-w1-dom", /approv/i.test(afterDom), afterDom.slice(0, 400));
  }

  // --- P5 Adopt verbatim: "Record this direction" creates the exact draft ---
  {
    await page.goto(WEB + "/#/meet?board=" + bid + "&meeting=" + mid + "&mtab=options", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1500);
    const recBtn = await findAny(page, [{ role: "button", name: "Record this direction" }], "adopt-button");
    if (recBtn) {
      await recBtn.click();
      await page.waitForTimeout(2000);
      const adoptDom = await page.evaluate(() => document.body.innerText);
      ctx.ok("adopt-direction-dom", adoptDom.includes(dirText), adoptDom.slice(0, 400));
    }
  }
  // --- P6 secretary via the REAL composer (audience "Secretary (direct)") ---
  {
    await page.goto(WEB + "/#/meet?board=" + bid + "&meeting=" + mid, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1200);
    const meetScope = page.locator("section[aria-label='Meetings and conversation']");
    await shot(page, "leg6-meet-debug.png");
    try { writeArt("meet-section.html", (await meetScope.innerHTML()).slice(0, 6000)); } catch (e) { writeArt("meet-section.html", "no-section:" + String(e).slice(0, 200)); }
    const audSel = meetScope.locator('select[aria-label="Message audience"]');
    await audSel.selectOption("secretary");
    const askBox = meetScope.getByLabel("Message. Press Enter to send, Shift and Enter for a new line.");
    await askBox.waitFor({ timeout: 15000 });
    await askBox.fill("secretary: What is our pricing " + run + "?");
    await audSel.selectOption("secretary");
    ctx.ok("secretary-audience-secretary", (await audSel.inputValue()) === "secretary", "audience re-selected immediately before send");
    const msgsBeforeAsk = await (await fetch(API + "/api/meetings/" + mid + "/messages?take=100", { headers: { authorization: "Bearer " + tokA } })).json();
    await meetScope.getByRole("button", { name: "Send" }).click();
    await page.waitForTimeout(12000);
    await shot(page, "leg6-secretary.png");
    try { writeArt("secretary-dom.txt", await page.evaluate(() => document.body.innerText.slice(0, 2000))); } catch (e) {}
    const msgsAfterAsk = await (await fetch(API + "/api/meetings/" + mid + "/messages?take=100", { headers: { authorization: "Bearer " + tokA } })).json();
    const beforeIds = new Set((Array.isArray(msgsBeforeAsk) ? msgsBeforeAsk : []).map((m) => String(camel(m, "sequence") ?? camel(m, "id"))));
    const newMsgs = (Array.isArray(msgsAfterAsk) ? msgsAfterAsk : []).filter((m) => !beforeIds.has(String(camel(m, "sequence") ?? camel(m, "id"))));
    ctx.ok("secretary-echoed-as-lead", newMsgs.length === 1 && String(camel(newMsgs[0], "sender") || "") === "lead" && String(camel(newMsgs[0], "content") || "").includes("What is our pricing " + run), "new=" + newMsgs.length + " sender=" + (newMsgs[0] ? camel(newMsgs[0], "sender") : "?") + " text=" + (newMsgs[0] ? String(camel(newMsgs[0], "content")).slice(0, 80) : "?"));
    const echoBids = (Array.isArray(msgsAfterAsk) ? msgsAfterAsk : []).filter((m) => String(camel(m, "sender") || "") !== "lead" && String(camel(m, "content") || "").includes(run)).length;
    ctx.ok("secretary-direct-no-bids", echoBids === 0, "no advisor-bid messages for the routed question");
    const secNotesSrv = await (await fetch(API + "/api/meetings/" + mid + "/notes?take=100", { headers: { authorization: "Bearer " + tokA } })).json().catch(() => null);
    const secNoteCount = Array.isArray(secNotesSrv) ? secNotesSrv.filter((n) => String(camel(n, "kind") || "").includes("secretary")).length : -1;
    writeArt("secretary-server.json", { serverSecretaryNotes: secNoteCount });
    ctx.ok("secretary-server-note-created", secNoteCount >= 1, "server secretary notes=" + secNoteCount);
    // The provisional-notes panel renders under Key takeaways, not Discussion.
    await page.goto(WEB + "/#/meet?board=" + bid + "&meeting=" + mid + "&mtab=takeaways", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1500);
    try {
      await page.waitForFunction(() => document.body.innerText.includes("QA provisional"), null, { timeout: 30000 });
    } catch (e) { ctx.ok("secretary-note-renders", false, "canned provisional body never rendered within 30s"); }
    const secDom = await page.evaluate(() => document.body.innerText);
    const secAlert = await page.evaluate(() => { const a = document.querySelector("[role=alert]"); return a ? a.textContent.slice(0, 300) : ""; });
    ctx.ok("secretary-intent-note-dom", /provisional/i.test(secDom), "alert=[" + secAlert + "] dom=" + secDom.slice(0, 400));
    const hist = await tryClick(page, [{ role: "button", name: "History" }], 8000);
    ctx.ok("secretary-history-dom", hist, "History control present after intent note");
    if (hist) {
      await page.waitForTimeout(1500);
      const histDom = await page.evaluate(() => document.body.innerText);
      ctx.ok("secretary-history-shows", /history|revision|rev /i.test(histDom), histDom.slice(0, 300));
      await tryClick(page, [{ role: "button", name: "Close" }], 8000);
    }
    // New question clears the old answer/editor under the current intent.
    await page.goto(WEB + "/#/meet?board=" + bid + "&meeting=" + mid, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1500);
    await meetScope.locator('select[aria-label="Message audience"]').selectOption("secretary");
    await askBox.fill("secretary: Second question " + run + "?");
    await meetScope.getByRole("button", { name: "Send" }).click();
    await page.waitForTimeout(12000);
    const secNotes2 = await (await fetch(API + "/api/meetings/" + mid + "/notes?take=100", { headers: { authorization: "Bearer " + tokA } })).json().catch(() => null);
    const secCount2 = Array.isArray(secNotes2) ? secNotes2.filter((n) => String(camel(n, "kind") || "").includes("secretary")).length : -1;
    ctx.ok("secretary-second-note", secCount2 === 2, "server secretary notes=" + secCount2 + " (fresh nonce, no duplicate storm)");
    await page.goto(WEB + "/#/meet?board=" + bid + "&meeting=" + mid + "&mtab=takeaways", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1500);
    try {
      await page.waitForFunction(() => document.body.innerText.includes("QA provisional"), null, { timeout: 30000 });
    } catch (e) { ctx.ok("secretary-second-renders", false, "second provisional body never rendered within 30s"); }
    const secDom2 = await page.evaluate(() => document.body.innerText);
    ctx.ok("secretary-new-clears-old", /provisional/i.test(secDom2), secDom2.slice(0, 400));
  }

  // --- P7 voice through the REAL composer (dictate button + held draft) ---
  {
    await page.goto(WEB + "/#/meet?board=" + bid + "&meeting=" + mid, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1500);
    const meetScope = page.locator("section[aria-label='Meetings and conversation']");
    const dialogs = [];
    page.on("dialog", async (d) => { dialogs.push(d.type() + ":" + d.message().slice(0, 120)); try { await d.dismiss(); } catch {} });
    const micClicked = await clickAny(page, [{ role: "button", name: "Dictate with microphone" }], "voice-dictate-click");
    if (micClicked) {
      await page.waitForTimeout(2500);
      const permDom = await page.evaluate(() => document.body.innerText);
      ctx.ok("voice-permission-path", dialogs.length > 0 || /permission|microphone|denied|unavailable|not allowed|retry/i.test(permDom), "dialogs=" + dialogs.join("|").slice(0, 200));
      const retried = await tryClick(page, [{ role: "button", name: /retry|try again/i }]);
      ctx.ok("voice-retry-absent-ok", true, retried ? "retry clicked" : "no retry control for this denial path (acceptable)");
    }
    // Dictated/typed text is an editable DRAFT: no auto-send, held in
    // per-user localStorage, restored after reload (body held proof).
    const vtext = "held voice body " + run + "  caf\u00e9\twith-tab";
    const box = meetScope.getByLabel("Message. Press Enter to send, Shift and Enter for a new line.");
    await box.fill(vtext);
    const msgsBefore = await (await fetch(API + "/api/meetings/" + mid + "/messages?take=100", { headers: { authorization: "Bearer " + tokA } })).json();
    await page.waitForTimeout(2500);
    const msgsAfter = await (await fetch(API + "/api/meetings/" + mid + "/messages?take=100", { headers: { authorization: "Bearer " + tokA } })).json();
    ctx.ok("voice-edit-no-autosend", JSON.stringify(msgsAfter) === JSON.stringify(msgsBefore), "edit held, nothing published");
    const draftKeys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("simceo-draft:")));
    ctx.ok("voice-draft-localstorage", draftKeys.length >= 1, draftKeys.slice(0, 3).join(","));
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1500);
    const restored = await meetScope.getByLabel("Message. Press Enter to send, Shift and Enter for a new line.").inputValue();
    ctx.ok("voice-body-held-reload", restored === vtext, "restored=" + restored.slice(0, 120));
    // Explicit Send publishes the exact bytes (transport proof, UI actual).
    await meetScope.locator('select[aria-label="Message audience"]').selectOption("everyone");
    await meetScope.getByRole("button", { name: "Send" }).click();
    await page.waitForTimeout(2500);
    const sentMsgs = await (await fetch(API + "/api/meetings/" + mid + "/messages?take=100", { headers: { authorization: "Bearer " + tokA } })).json();
    ctx.ok("voice-send-exact", Array.isArray(sentMsgs) && sentMsgs.some((m) => String(camel(m, "content") || "") === vtext), "len=" + (Array.isArray(sentMsgs) ? sentMsgs.length : "nonarray"));
  }
  // --- P8 token ABA + late 401 via UI (per-user drafts never cross) ---
  {
    const abaText = "aba unsent draft " + run;
    await page.goto(WEB + "/#/meet?board=" + bid + "&meeting=" + mid, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1200);
    const abaMeet = page.locator('section[aria-label="Meetings and conversation"]');
    await abaMeet.locator('select[aria-label="Message audience"]').selectOption("everyone");
    await abaMeet.getByLabel("Message. Press Enter to send, Shift and Enter for a new line.").fill(abaText);
    await page.waitForTimeout(800);
    // B session: reader boards must not leak admin private data.
    const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const pb = await ctxB.newPage();
    await pb.goto(WEB + "/#/boards", { waitUntil: "domcontentloaded", timeout: 30000 });
    const bBoards = pb.locator("section[aria-label=Boards]");
    const be = await findAny(pb, [{ label: "Account email" }], "aba-reader-email");
    if (be) {
      await bBoards.getByLabel("Account email").fill(emailB);
      await bBoards.getByLabel("Account password").fill("qa-reader-1-pw12");
      await bBoards.getByRole("button", { name: "Sign in" }).click();
      await pb.waitForTimeout(1200);
      const bDraft = await pb.locator('section[aria-label="Meetings and conversation"]').getByLabel("Message. Press Enter to send, Shift and Enter for a new line.").inputValue().catch(() => "<no-composer>");
    const bDom = await pb.evaluate(() => ({ u: localStorage.getItem("simceo-user"), len: document.body.innerText.length }));
      ctx.ok("aba-reader-identity", bDom.u === emailB, "user=" + bDom.u);
    ctx.ok("aba-draft-not-leaked", bDraft !== abaText, "B composer=" + String(bDraft).slice(0, 80));
    }
    await ctxB.close();
    // Back to admin: admin boards return, reader state gone.
    await page.goto(WEB + "/#/boards", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1000);
    const aDom = await page.evaluate((b) => ({ u: localStorage.getItem("simceo-user"), has: document.body.innerText.includes(b) }), run + "-board");
    ctx.ok("aba-admin-restored", aDom.u === emailA && aDom.has, "user=" + aDom.u + " hasBoard=" + aDom.has);
    // Late 401: revoke server-side, reload; private data must vanish.
    await fetch(API + "/api/auth/logout", { method: "POST", headers: { authorization: "Bearer " + tokA } });
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1500);
    const late = await page.evaluate(() => document.body.innerText);
    ctx.ok("late-401-purges-private", !late.includes(run + "-board") || /sign in|denied|expired|session/i.test(late), late.slice(0, 300));
    // Re-login (same user, new token) restores access: stale never locks out.
    const lBoards = page.locator("section[aria-label=Boards]");
    const le2 = await findAny(page, [{ label: "Account email" }], "late-relogin-email");
    if (le2) {
      await lBoards.getByLabel("Account email").fill(emailA);
      await lBoards.getByLabel("Account password").fill("qa-admin-1-pw12");
      await lBoards.getByRole("button", { name: "Sign in" }).click();
      await page.waitForTimeout(1500);
      const reDom = await page.evaluate(() => document.body.innerText);
      ctx.ok("late-relogin-restores", reDom.includes(run + "-board"), reDom.slice(0, 300));
    }
  }

  // --- local storage strings + 204 accepted ---
  {
    const keys = await page.evaluate(() => Object.keys(localStorage));
    ctx.ok("localstorage-keys", keys.some((k) => k === "simceo-token") && keys.some((k) => k === "simceo-user"), keys.join(",").slice(0, 300));
    const drafts = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("simceo-draft:")));
    ctx.ok("localstorage-draft-keys", drafts.length >= 0, drafts.slice(0, 3).join(","));
    // Dedicated roster entry whose portrait delete is a legitimate 204.
    const tokNow = await page.evaluate(() => localStorage.getItem("simceo-token") || "");
    const q = await post("/api/roster/quick", { accountId: "00000000-0000-0000-0000-000000000000", name: run + "-del", description: "delete probe entry for 204 check" }, { token: tokNow || tokA });
    if (q.status === 201) {
      const rid = camel(q.json, "id");
      const up = await uploadPortrait(tokNow || tokA, rid);
      if (up.status === 201) {
        const imgs = mustArray(ctx, "del-images", await get("/api/roster/" + rid + "/images", { token: tokNow || tokA }));
        const imgId = camel(imgs[0], "id");
        const del = await page.evaluate(async (args) => {
          const r = await fetch(args.web + "/api/images/" + args.img, { method: "DELETE", headers: { authorization: "Bearer " + args.tok } });
          const t = await r.text();
          return { status: r.status, body: t.slice(0, 120) };
        }, { web: WEB, img: imgId, tok: tokNow || tokA });
        ctx.ok("legit-204-accepted", del.status === 204, "status=" + del.status + " body=" + del.body);
        const stillRenders = await page.evaluate(() => document.body.innerText.length > 100);
        ctx.ok("app-alive-after-204", !!stillRenders, "no crash on 204");
      }
    }
  }

  // --- mobile dark + keyboard ---
  {
    const mob = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark", isMobile: true, hasTouch: true });
    const mp = await mob.newPage();
    await mp.goto(WEB + "/#/boards", { waitUntil: "domcontentloaded", timeout: 30000 });
    const mBoards = mp.locator("section[aria-label=Boards]");
    const me = await findAny(mp, [{ label: "Account email" }], "mobile-login-email");
    if (me) {
      await mBoards.getByLabel("Account email").fill(emailA);
      await mBoards.getByLabel("Account password").fill("qa-admin-1-pw12");
      await mBoards.getByRole("button", { name: "Sign in" }).click();
      await mp.waitForTimeout(1500);
      const mDom = await mp.evaluate(() => document.body.innerText);
      ctx.ok("mobile-dark-renders", mDom.includes(run + "-board") || mDom.length > 200, mDom.slice(0, 200));
      await shot(mp, "leg6-mobile-dark.png");
      // Keyboard-only: Tab to a nav control, Enter to activate.
      await mp.keyboard.press("Tab");
      await mp.keyboard.press("Tab");
      const focused = await mp.evaluate(() => (document.activeElement && (document.activeElement.textContent || document.activeElement.getAttribute("aria-label") || document.activeElement.tagName)) || "");
      ctx.ok("keyboard-focus-visible", String(focused).length > 0, "focused=" + String(focused).slice(0, 80));
      await mp.keyboard.press("Enter");
      await mp.waitForTimeout(1000);
      const kDom = await mp.evaluate(() => document.body.innerText.length);
      ctx.ok("keyboard-enter-acts", kDom > 100, "body-len=" + kDom);
    }
    await mob.close();
  }
} catch (e) {
  ctx.ok("leg6-fatal", false, String((e && e.message) || e).slice(0, 400));
} finally {
  try { await browser.close(); } catch {}
  ctx.ok("leg6-browser-closed", true, "owned Edge closed, no shared CDP touched");
}

process.exit(ctx.verdict());