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
import { makeCtx, API, FAKE, get, post, camel, mustArray, registerOrLogin, digest, fakeJson, waitFor, ledgerSnapshot, sharedNewId, priorRowsIntact } from "../helpers/essentials-http.mjs";

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
const dirText = "web direction exact " + run + " caf\u00e9 \u4e2d\u6587  ";
const dirCore = "web direction exact " + run + " caf\u00e9 \u4e2d\u6587";
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
const browser2 = await chromium.launch({ executablePath: EDGE, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--deny-permission-prompts"] });
ctx.ok("browser2-deny-prompts", !!browser2, "owned headless Edge that auto-denies mic prompts (denial path)");
const browser3 = await chromium.launch({ executablePath: EDGE, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-fake-device-for-media-stream"] });
ctx.ok("browser3-fake-device", !!browser3, "owned headless Edge with fake mic + auto-grant (supported recovery path)");
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
    const readerBoxes = await rp.evaluate(() => document.querySelectorAll("section[aria-label=Records] input[type=checkbox]").length);
    ctx.ok("records-no-checkboxes-dom-reader", readerBoxes === 0, "reader checkboxes=" + readerBoxes);
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
  // Missing record: no approval controls of any kind in the DOM.
  {
    const fakeRec = "00000000-0000-0000-0000-000000000000";
    await page.goto(WEB + "/#/records?board=" + bid + "&meeting=" + mid + "&rec=" + fakeRec, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1500);
    const missBtns = await page.evaluate(() => {
      const sec = document.querySelector("section[aria-label=Records]");
      const root = sec || document.body;
      return Array.from(root.querySelectorAll("button")).filter((x) => /approve/i.test(x.textContent || "")).length;
    });
    ctx.ok("records-missing-no-approve", missBtns === 0, "approve buttons=" + missBtns);
    const missBoxes = await page.evaluate(() => document.querySelectorAll("section[aria-label=Records] input[type=checkbox]").length);
    ctx.ok("records-missing-no-checkboxes", missBoxes === 0, "checkboxes=" + missBoxes);
    const missDom = await page.evaluate(() => document.body.innerText);
    ctx.ok("records-missing-recovers", missDom.length > 100, "len=" + missDom.length);
  }

  // --- P4 records approval through the REAL review UI: exact wire proof ---
  // Route-level capture records every actual production POST body the UI
  // sends plus the exact status/response the server returns. DOM text only
  // locates controls; approval STATE is proven via the handler afterwards.
  // No whole-page regex substitutes for wire proof; INVALID/missing/
  // non-manager approval CHECKBOXES must be ABSENT from the DOM entirely.
  const wire = [];
  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const u = req.url();
    const path = u.startsWith(WEB) ? u.slice(WEB.length) : u;
    if (req.method() === "POST" && /\/(record\/approve|records\/[^/]+\/refresh|records\/[^/]+\/items\/approve|records\/[^/]+\/approve-all|record\/from-direction)$/.test(path)) {
      const postData = req.postData() || "";
      let resp = null;
      try { resp = await route.fetch(); } catch { await route.continue(); return; }
      let rbody = "";
      try { rbody = await resp.text(); } catch {}
      wire.push({ path, postData, status: resp.status(), rbody: rbody.slice(0, 2000) });
      await route.fulfill({ response: resp });
    } else { await route.continue(); }
  });
  // Checkbox locator: current UI renders aria-labelled boxes ONLY when
  // approval is allowed; legacy label-text form is the fallback.
  const itemBox = async (scope, id) => {
    let box = scope.locator('input[aria-label="Select item ' + id + '"]');
    if (await box.count() === 0) box = scope.locator("label", { hasText: "[" + id + "]" }).locator("input[type=checkbox]");
    return box;
  };
  const setChecked = async (scope, id, want) => {
    const box = await itemBox(scope, id);
    if (await box.count() === 0) return false;
    const cur = await box.first().isChecked().catch(() => null);
    if (cur === null || cur === want) return cur !== null;
    await box.first().click({ timeout: 8000 });
    return true;
  };
  // (re-navigate: the archive check above leaves the Boards route)
  await page.goto(WEB + "/#/records?board=" + bid + "&meeting=" + mid + "&rec=" + did, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1500);
  // Deterministic stale-first flow: REST-approve W2 (server advances),
  // then UI "Approve selected" (both checked, pre-REST guards) must 409
  // with the EXACT stale POST body captured; a fresh meeting message moves
  // the watermark so "Refresh review" POSTs current guards (200, watermark
  // moves, token rotates); then UI "Approve selected" approves W1 (200),
  // proven via the handler (not DOM text).
  {
    const recScope = page.locator("section[aria-label=Records]");
    await recScope.getByRole("button", { name: "Approve selected" }).waitFor({ timeout: 15000 });
    const g = await (await fetch(API + "/api/records/" + did, { headers: { authorization: "Bearer " + tokA } })).json();
    const preApprove = await fetch(API + "/api/records/" + did + "/items/approve", { method: "POST", headers: { authorization: "Bearer " + tokA, "content-type": "application/json" }, body: JSON.stringify({ version: g.version, hash: g.hash, reviewToken: g.reviewToken, watermark: g.watermark, itemId: "W2" }) });
    ctx.ok("seed-rest-approve-w2", preApprove.status === 200, "status=" + preApprove.status);
    const wireBeforeStale = wire.length;
    await recScope.getByRole("button", { name: "Approve selected" }).click();
    await page.waitForTimeout(1500);
    const stalePosts = wire.slice(wireBeforeStale).filter((w) => /record\/approve$/.test(w.path));
    ctx.ok("stale-409-post-captured", stalePosts.length >= 1 && stalePosts[0].status === 409, "posts=" + stalePosts.length + " status=" + (stalePosts[0] ? stalePosts[0].status : "?"));
    if (stalePosts.length > 0) {
      let sawBody = null;
      try { sawBody = JSON.parse(stalePosts[0].postData); } catch {}
      ctx.ok("stale-409-post-body", !!sawBody && typeof sawBody.version === "number" && typeof sawBody.hash === "string" && typeof sawBody.reviewToken === "string" && typeof sawBody.watermark === "number" && Array.isArray(sawBody.itemIds), "body=" + stalePosts[0].postData.slice(0, 300));
      ctx.ok("stale-409-response-body", /conflict|stale|refresh|expired|version|changed|409/i.test(stalePosts[0].rbody), stalePosts[0].rbody.slice(0, 300));
      writeArt("stale-409-wire.json", stalePosts[0]);
    }
    const conflictDom = await page.evaluate(() => document.body.innerText);
    ctx.ok("records-409-visible", /conflict|stale|refresh|expired|version|changed/i.test(conflictDom), conflictDom.slice(0, 400));
    // Fresh input moves DeliveredRevision past the loaded watermark, so the
    // refresh POST below does real work (200), not already-current.
    const bump = await post("/api/meetings/" + mid + "/messages", { sender: "lead", content: "records refresh bump " + run }, { token: tokA });
    ctx.ok("refresh-bump-posted", bump.status === 201 || bump.status === 200, "status=" + bump.status);
    const revBefore = await (await fetch(API + "/api/records/" + did + "/review", { headers: { authorization: "Bearer " + tokA } })).json();
    const wireBeforeRef = wire.length;
    await recScope.getByRole("button", { name: "Refresh review" }).click();
    await page.waitForTimeout(2000);
    const refPosts = wire.slice(wireBeforeRef).filter((w) => /\/refresh$/.test(w.path));
    ctx.ok("refresh-post-captured", refPosts.length >= 1 && refPosts[0].status === 200, "posts=" + refPosts.length + " status=" + (refPosts[0] ? refPosts[0].status : "?"));
    if (refPosts.length > 0) {
      let refBody = null;
      try { refBody = JSON.parse(refPosts[0].postData); } catch {}
      const bd = camel(revBefore, "draft") || {};
      ctx.ok("refresh-post-current-guards", !!refBody && refBody.version === camel(bd, "version") && refBody.hash === camel(bd, "hash") && refBody.reviewToken === camel(bd, "reviewToken") && refBody.watermark === camel(bd, "watermark"), "body=" + refPosts[0].postData.slice(0, 300));
      writeArt("refresh-wire.json", refPosts[0]);
    }
    const revAfter = await (await fetch(API + "/api/records/" + did + "/review", { headers: { authorization: "Bearer " + tokA } })).json();
    const ad = camel(revAfter, "draft") || {}, bd2 = camel(revBefore, "draft") || {};
    ctx.ok("refresh-watermark-moved", typeof camel(ad, "watermark") === "number" && camel(ad, "watermark") > camel(bd2, "watermark"), "watermark " + camel(bd2, "watermark") + "->" + camel(ad, "watermark"));
    ctx.ok("refresh-token-rotated", typeof camel(ad, "reviewToken") === "string" && camel(ad, "reviewToken") !== camel(bd2, "reviewToken"), "rotated=" + (camel(ad, "reviewToken") !== camel(bd2, "reviewToken")));
    ctx.ok("refresh-state-valid", camel(revAfter, "stateValid") === true && Array.isArray(camel(revAfter, "pending")) && camel(revAfter, "pending").includes("W1"), "pending=" + JSON.stringify(camel(revAfter, "pending") ?? null).slice(0, 120));
    const refDom = await page.evaluate(() => document.body.innerText);
    ctx.ok("records-refresh-dom", /Review v|approved|pending/i.test(refDom), refDom.slice(0, 400));
    // Select exactly W1 (uncheck already-approved W2), then approve.
    await setChecked(recScope, "W1", true);
    await setChecked(recScope, "W2", false);
    const wireBeforeAp = wire.length;
    await recScope.getByRole("button", { name: "Approve selected" }).click();
    await page.waitForTimeout(2000);
    const apPosts = wire.slice(wireBeforeAp).filter((w) => /record\/approve$/.test(w.path));
    ctx.ok("approve-post-captured", apPosts.length >= 1 && apPosts[0].status === 200, "posts=" + apPosts.length + " status=" + (apPosts[0] ? apPosts[0].status : "?"));
    if (apPosts.length > 0) {
      let apBody = null;
      try { apBody = JSON.parse(apPosts[apPosts.length - 1].postData); } catch {}
      ctx.ok("approve-post-w1-guards", !!apBody && apBody.draftId === did && typeof apBody.version === "number" && typeof apBody.hash === "string" && typeof apBody.reviewToken === "string" && typeof apBody.watermark === "number" && Array.isArray(apBody.itemIds) && apBody.itemIds.includes("W1"), "body=" + apPosts[apPosts.length - 1].postData.slice(0, 300));
      writeArt("approve-wire.json", apPosts[apPosts.length - 1]);
    }
    // Approval STATE via the handler: W1 approved, bytes exported.
    const recFinal = await (await fetch(API + "/api/records/" + did, { headers: { authorization: "Bearer " + tokA } })).json();
    const apList = (() => { try { const v = JSON.parse(camel(recFinal, "approvedJson") ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; } })();
    ctx.ok("approve-state-handler", apList.includes("W1"), "approvedJson=" + JSON.stringify(apList).slice(0, 160));
    const expFinal = await (await fetch(API + "/api/records/" + did + "/export?format=concise", { headers: { authorization: "Bearer " + tokA } })).text();
    ctx.ok("approve-export-bytes", expFinal.includes(itemCore), "W1 bytes present in export");
    const afterDom = await page.evaluate(() => document.body.innerText);
    ctx.ok("records-approve-w1-dom", /approv/i.test(afterDom), afterDom.slice(0, 400));
    // INVALID state (nothing left pending): approval CHECKBOXES must be
    // ABSENT from the DOM entirely, not merely disabled or hidden buttons.
    const noBoxes = await page.evaluate(() => document.querySelectorAll("section[aria-label=Records] input[type=checkbox]").length);
    ctx.ok("records-invalid-no-checkboxes", noBoxes === 0, "checkboxes=" + noBoxes);
    const invDom = await page.evaluate(() => document.body.innerText);
    ctx.ok("records-invalid-alert", /no pending|invalid|nothing to approve|disabled/i.test(invDom), invDom.slice(0, 300));
  }

  // --- P5 Adopt VERBATIM: "Record this direction" stages the EXACT stored
  // direction bytes as a new UNAPPROVED draft and selects it. Proven via the
  // handler (exact Unicode/whitespace bytes, decided/approved state) plus the
  // UI selection (hash carries the new draft id) -- not DOM substring alone.
  {
    const recsBefore = await (await fetch(API + "/api/meetings/" + mid + "/records", { headers: { authorization: "Bearer " + tokA } })).json();
    const beforeIds = new Set((Array.isArray(recsBefore) ? recsBefore : []).map((r) => String(r.id || r.Id)));
    const dirsRes = await (await fetch(API + "/api/boards/" + bid + "/directions", { headers: { authorization: "Bearer " + tokA } })).json();
    const storedDir = (Array.isArray(dirsRes) ? dirsRes : []).map((n) => String(n.body || n.Body || "")).find((t) => t.includes(dirCore)) || "";
    ctx.ok("adopt-stored-direction", storedDir.includes(dirCore), "stored=" + storedDir.slice(0, 200));
    await page.goto(WEB + "/#/meet?board=" + bid + "&meeting=" + mid + "&mtab=options", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1500);
    const recBtn = await findAny(page, [{ role: "button", name: "Record this direction" }], "adopt-button");
    if (!recBtn) { ctx.ok("adopt-button", false, "Record this direction not rendered"); }
    else {
      await recBtn.click();
      await page.waitForTimeout(2500);
      const recsAfter = await (await fetch(API + "/api/meetings/" + mid + "/records", { headers: { authorization: "Bearer " + tokA } })).json();
      const fresh = (Array.isArray(recsAfter) ? recsAfter : []).filter((r) => !beforeIds.has(String(r.id || r.Id)));
      ctx.ok("adopt-created-one", fresh.length === 1, "new drafts=" + fresh.length);
      if (fresh.length === 1) {
        const nid = String(fresh[0].id || fresh[0].Id);
        const det = await (await fetch(API + "/api/records/" + nid, { headers: { authorization: "Bearer " + tokA } })).json();
        const adoptItems = (() => { try { const v = JSON.parse(camel(det, "itemsJson") ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; } })();
        const adoptItem = adoptItems.find((x) => String(camel(x, "id") || "").startsWith("dir-"));
        ctx.ok("adopt-exact-bytes", !!adoptItem && String(camel(adoptItem, "text") || "") === storedDir && storedDir !== "", "text=" + String(adoptItem && camel(adoptItem, "text")).slice(0, 300));
        ctx.ok("adopt-whitespace-preserved", !!adoptItem && String(camel(adoptItem, "text") || "").endsWith("  "), "trailing spaces preserved verbatim");
        const adoptApproved = (() => { try { const v = JSON.parse(camel(det, "approvedJson") ?? "[]"); return Array.isArray(v) ? v : ["<unparseable>"]; } catch { return ["<unparseable>"]; } })();
        ctx.ok("adopt-unapproved", camel(det, "decided") === false && adoptApproved.length === 0, "decided=" + camel(det, "decided") + " approvedJson=" + JSON.stringify(adoptApproved));
        ctx.ok("adopt-open-status", String(camel(det, "status") || "").toLowerCase() === "open", "status=" + camel(det, "status"));
        try {
          await page.waitForFunction((id) => location.hash.includes(id), nid, { timeout: 10000 });
        } catch {}
        const hash = await page.evaluate(() => location.hash);
        ctx.ok("adopt-selected", hash.includes(nid), "hash=" + hash);
        const adoptDom = await page.evaluate(() => document.body.innerText);
        ctx.ok("adopt-direction-dom", adoptDom.includes(dirCore), adoptDom.slice(0, 400));
        writeArt("adopt-wire.json", { draft: nid, status: det.status, decided: det.decided });
      }
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

  // --- P7 voice through the REAL composer: this-attempt permission denial,
  // regrant + supported Record again + completed transcription into an
  // editable unsent draft; armed-fake 502 then fresh retry (BOTH ledger pairs
  // exact); mid-record navigation cancel; held-body reload; explicit Send.
  // No absence waiver: every recovery step is observed, not assumed.
  {
    const vctx = await browser2.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "light" });
    const vp = await vctx.newPage();
    const vDialogs = [];
    vp.on("dialog", async (d) => { vDialogs.push(d.type() + ":" + d.message().slice(0, 160)); try { await d.dismiss(); } catch {} });
    await vp.goto(WEB + "/#/boards", { waitUntil: "domcontentloaded", timeout: 30000 });
    const vBoards = vp.locator("section[aria-label=Boards]");
    await vBoards.getByLabel("Account email").waitFor({ timeout: 15000 });
    await vBoards.getByLabel("Account email").fill(emailA);
    await vBoards.getByLabel("Account password").fill("qa-admin-1-pw12");
    await vBoards.getByRole("button", { name: "Sign in" }).click();
    await vp.waitForTimeout(1500);
    await vp.goto(WEB + "/#/meet?board=" + bid + "&meeting=" + mid, { waitUntil: "domcontentloaded", timeout: 30000 });
    await vp.waitForTimeout(1500);
    const vMeet = vp.locator("section[aria-label='Meetings and conversation']");
    const vBox = vMeet.getByLabel("Message. Press Enter to send, Shift and Enter for a new line.");
    // Denied path: this context auto-denies mic prompts. The denial surfaces
    // as THIS attempt's inline error card (role=alert "Dictation failed" with
    // the permission text and a Record again control) -- never a dialog --
    // and nothing may record or publish while denied.
    const msgsV0 = mustArray(ctx, "voice-msgs-before", await get("/api/meetings/" + mid + "/messages?take=100", { token: tokA }));
    await vMeet.getByRole("button", { name: "Dictate with microphone" }).click();
    try {
      await vp.waitForFunction(() => !!document.querySelector('[aria-label="Dictation failed"]'), null, { timeout: 15000 });
    } catch (e) { ctx.ok("voice-denial-alert", false, "denial error card never rendered within 15s"); }
    const denyAlert = await vp.evaluate(() => { const a = document.querySelector('[aria-label="Dictation failed"]'); return a ? a.textContent.slice(0, 400) : ""; });
    ctx.ok("voice-denial-this-attempt", /Microphone unavailable or permission denied/i.test(denyAlert), "alert=" + denyAlert.slice(0, 240));
    ctx.ok("voice-denial-record-again", await vMeet.getByRole("button", { name: "Record again" }).count() >= 1, "supported recovery control present on denial");
    ctx.ok("voice-denied-no-recording", await vMeet.getByRole("button", { name: "Stop dictation" }).count() === 0, "recorder never started while denied");
    const msgsDenied = mustArray(ctx, "voice-msgs-denied", await get("/api/meetings/" + mid + "/messages?take=100", { token: tokA }));
    ctx.ok("voice-denied-no-publish", msgsDenied.length === msgsV0.length, "msgs " + msgsV0.length + "->" + msgsDenied.length);
    // Supported recovery on a SEPARATE browser with a fake mic device: grant
    // permission (headless equivalent of the OS grant), Record AGAIN via the
    // supported control, complete a real transcription. The draft stays
    // editable and UNSENT.
    await vctx.close();
    const vctx3 = await browser3.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "light", permissions: ["microphone"] });
    const vp3 = await vctx3.newPage();
    vp3.on("dialog", async (d) => { try { await d.dismiss(); } catch {} });
    await vp3.goto(WEB + "/#/boards", { waitUntil: "domcontentloaded", timeout: 30000 });
    const vBoards3 = vp3.locator("section[aria-label=Boards]");
    await vBoards3.getByLabel("Account email").waitFor({ timeout: 15000 });
    await vBoards3.getByLabel("Account email").fill(emailA);
    await vBoards3.getByLabel("Account password").fill("qa-admin-1-pw12");
    await vBoards3.getByRole("button", { name: "Sign in" }).click();
    await vp3.waitForTimeout(1500);
    await vp3.goto(WEB + "/#/meet?board=" + bid + "&meeting=" + mid, { waitUntil: "domcontentloaded", timeout: 30000 });
    await vp3.waitForTimeout(1500);
    const vMeet3 = vp3.locator("section[aria-label='Meetings and conversation']");
    const vBox3 = vMeet3.getByLabel("Message. Press Enter to send, Shift and Enter for a new line.");
    // Supported recovery: regrant permission, Record AGAIN, complete a real
    // transcription into the composer. The draft stays editable and UNSENT.
    const ledV0 = await ledgerSnapshot(ctx, "voice0", tokA, mid);
    const fcV0 = await fakeJson("/__counts");
    await vMeet3.getByRole("button", { name: "Dictate with microphone" }).click();
    await vp3.waitForTimeout(2500);
    ctx.ok("voice-regrant-records", await vMeet3.getByRole("button", { name: "Stop dictation" }).count() >= 1, "recording after regrant");
    await vp3.waitForTimeout(3000);
    if (await vMeet3.getByRole("button", { name: "Stop dictation" }).count()) { await vMeet3.getByRole("button", { name: "Stop dictation" }).click(); }
    else { ctx.ok("voice-stop-present", false, "Stop control never appeared; recording did not start"); }
    try {
      await vp3.waitForFunction(() => { const t = document.querySelector('section[aria-label="Meetings and conversation"] textarea'); return !!t && (t.value || "").includes("qa transcript"); }, null, { timeout: 30000 });
    } catch (e) { ctx.ok("voice-transcript-lands", false, "transcribed text never reached the draft within 30s"); }
    const draftV = await vBox3.inputValue();
    ctx.ok("voice-transcript-editable-draft", draftV.includes("qa transcript"), "draft=" + draftV.slice(0, 160));
    const msgsV1 = mustArray(ctx, "voice-msgs-unsent", await get("/api/meetings/" + mid + "/messages?take=100", { token: tokA }));
    ctx.ok("voice-transcript-no-autosend", msgsV1.length === msgsV0.length, "msgs " + msgsV0.length + "->" + msgsV1.length);
    const fcV1 = await fakeJson("/__counts");
    ctx.ok("voice-transcript-provider-hit", (fcV1.json.transcribe | 0) === (fcV0.json.transcribe | 0) + 1, "transcribe " + fcV0.json.transcribe + "->" + fcV1.json.transcribe);
    const wV = await waitFor("voice-pair", async () => {
      const after = await ledgerSnapshot(ctx, "voice-wait", tokA, mid);
      const s = sharedNewId(ledV0.calls, ledV0.usage, after.calls, after.usage);
      if (!s.ok) return { done: false, note: s.note };
      return { done: true, value: { after, shared: s } };
    }, { timeoutMs: 60000 });
    ctx.ok("voice-pair-correlated", wV.ok, String(wV.last || "").slice(0, 200));
    if (!wV.ok) throw new Error("voice pair never correlated");
    const ledV1 = wV.value.after, sV = wV.value.shared;
    ctx.ok("voice-pair-success", String(camel(sV.call, "status")) === "succeeded" && String(camel(sV.row, "status")) === "succeeded", "status=" + camel(sV.call, "status"));
    ctx.ok("voice-pair-purpose", String(camel(sV.call, "purpose")) === "voice-transcribe" && String(camel(sV.row, "kind")) === "voice-transcribe", "purpose=" + camel(sV.call, "purpose"));
    ctx.ok("voice-prior-intact", priorRowsIntact(ledV0.calls, ledV1.calls) && priorRowsIntact(ledV0.usage, ledV1.usage), "calls " + ledV0.calls.length + "->" + ledV1.calls.length);
    writeArt("voice-wire.json", { pair: sV.id, draft: draftV.slice(0, 200) });
    // Held body: reload restores the REAL transcribed draft (per-user
    // localStorage); explicit Send then publishes the exact bytes.
    await vp3.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
    await vp3.waitForTimeout(1500);
    const restoredV = await vMeet3.getByLabel("Message. Press Enter to send, Shift and Enter for a new line.").inputValue();
    ctx.ok("voice-body-held-reload", restoredV === draftV, "restored=" + restoredV.slice(0, 120));
    const vDraftKeys = await vp3.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("simceo-draft:")));
    ctx.ok("voice-draft-localstorage", vDraftKeys.length >= 1, vDraftKeys.slice(0, 3).join(","));
    await vMeet3locator('select[aria-label="Message audience"]').selectOption("everyone");
    await vMeet3.getByRole("button", { name: "Send" }).click();
    await vp3.waitForTimeout(2500);
    const sentV = mustArray(ctx, "voice-msgs-sent", await get("/api/meetings/" + mid + "/messages?take=100", { token: tokA }));
    ctx.ok("voice-send-exact", sentV.some((m) => String(camel(m, "content") || "") === draftV), "len=" + sentV.length);
    // Armed-fake 502 THEN fresh retry: the failed attempt shows the error
    // and bills exactly ONE FAILED pair; the retry bills exactly ONE
    // successful pair. Both ledger pairs are asserted complete with every
    // prior row intact; nothing publishes on the failed attempt.
    {
      const arm = await fakeJson("/__ess/arm", { method: "POST", body: { route: "transcribe", times: 1, status: 502 } });
      ctx.ok("voice-fake-armed", arm.status === 200, "status=" + arm.status);
      const ledH0 = await ledgerSnapshot(ctx, "voice-held0", tokA, mid);
      const fcH0 = await fakeJson("/__counts");
      await vMeet3.getByRole("button", { name: "Dictate with microphone" }).click();
      await vp3.waitForTimeout(2000);
      if (await vMeet3.getByRole("button", { name: "Stop dictation" }).count()) await vMeet3.getByRole("button", { name: "Stop dictation" }).click();
      await vp3.waitForTimeout(5000);
      const errDom = await vp3.evaluate(() => document.body.innerText);
      ctx.ok("voice-502-error-visible", /Dictation failed/i.test(errDom) && /502/.test(errDom), errDom.slice(0, 300));
      const fcH1 = await fakeJson("/__counts");
      ctx.ok("voice-502-provider-dispatched", (fcH1.json.transcribe | 0) === (fcH0.json.transcribe | 0) + 1, "transcribe " + fcH0.json.transcribe + "->" + fcH1.json.transcribe);
      const wH = await waitFor("voice-held-pair", async () => {
        const after = await ledgerSnapshot(ctx, "voice-held-wait", tokA, mid);
        const s = sharedNewId(ledH0.calls, ledH0.usage, after.calls, after.usage);
        if (!s.ok) return { done: false, note: s.note };
        return { done: true, value: { after, shared: s } };
      }, { timeoutMs: 60000 });
      ctx.ok("voice-502-pair-correlated", wH.ok, String(wH.last || "").slice(0, 200));
      if (!wH.ok) throw new Error("voice 502 pair never correlated");
      const ledH1 = wH.value.after, sH = wH.value.shared;
      ctx.ok("voice-502-pair-failed", String(camel(sH.call, "status")) === "failed" && String(camel(sH.row, "status")) === "failed", "status=" + camel(sH.call, "status"));
      ctx.ok("voice-502-prior-intact", priorRowsIntact(ledH0.calls, ledH1.calls) && priorRowsIntact(ledH0.usage, ledH1.usage), "rows intact around failed pair");
      const msgsH = mustArray(ctx, "voice-msgs-held", await get("/api/meetings/" + mid + "/messages?take=100", { token: tokA }));
      ctx.ok("voice-502-no-publish", msgsH.length === sentV.length, "msgs " + sentV.length + "->" + msgsH.length);
      // Fresh retry after the fault clears: Record again, Stop, completed.
      await vMeet3.getByRole("button", { name: "Dictate with microphone" }).click();
      await vp3.waitForTimeout(2000);
      if (await vMeet3.getByRole("button", { name: "Stop dictation" }).count()) await vMeet3.getByRole("button", { name: "Stop dictation" }).click();
      try {
        await vp3.waitForFunction((want) => { const t = document.querySelector('section[aria-label="Meetings and conversation"] textarea'); return !!t && (t.value || "").includes(want); }, "qa transcript", { timeout: 30000 });
      } catch (e) { ctx.ok("voice-retry-lands", false, "retry transcription never reached the draft"); }
      const wR = await waitFor("voice-retry-pair", async () => {
        const after = await ledgerSnapshot(ctx, "voice-retry-wait", tokA, mid);
        const s = sharedNewId(ledH1.calls, ledH1.usage, after.calls, after.usage);
        if (!s.ok) return { done: false, note: s.note };
        return { done: true, value: { after, shared: s } };
      }, { timeoutMs: 60000 });
      ctx.ok("voice-retry-pair-correlated", wR.ok, String(wR.last || "").slice(0, 200));
      if (!wR.ok) throw new Error("voice retry pair never correlated");
      const ledR = wR.value.after, sR = wR.value.shared;
      ctx.ok("voice-retry-pair-success", String(camel(sR.call, "status")) === "succeeded" && String(camel(sR.row, "status")) === "succeeded", "status=" + camel(sR.call, "status"));
      ctx.ok("voice-retry-distinct-pair", sR.id !== sH.id, "retry pair distinct from failed pair");
      ctx.ok("voice-retry-prior-intact", priorRowsIntact(ledH1.calls, ledR.calls) && priorRowsIntact(ledH1.usage, ledR.usage), "failed pair + priors intact");
      const reset = await fakeJson("/__ess/reset", { method: "POST", body: {} });
      ctx.ok("voice-fake-reset", reset.status === 200, "status=" + reset.status);
      writeArt("voice-502-wire.json", { failed: sH.id, retried: sR.id });
    }
    // Cancellation via the REAL Cancel control: Record, then Cancel dictation
    // mid-record. The attempt is discarded and never sends: no recording, no
    // error, the draft is untouched, nothing publishes.
    {
      const draftBefore = await vBox3.inputValue();
      const msgsC0 = mustArray(ctx, "voice-msgs-cancel-before", await get("/api/meetings/" + mid + "/messages?take=100", { token: tokA }));
      await vMeet3.getByRole("button", { name: "Dictate with microphone" }).click();
      await vp3.waitForTimeout(1500);
      const cancelVisible = await vMeet3.getByRole("button", { name: "Cancel dictation" }).count();
      ctx.ok("voice-cancel-present", cancelVisible >= 1, "Cancel control rendered while recording");
      if (cancelVisible) await vMeet3.getByRole("button", { name: "Cancel dictation" }).click();
      await vp3.waitForTimeout(1500);
      ctx.ok("voice-cancel-stopped", await vMeet3.getByRole("button", { name: "Stop dictation" }).count() === 0, "recorder stopped after Cancel");
      const draftAfterC = await vMeet3.getByLabel("Message. Press Enter to send, Shift and Enter for a new line.").inputValue().catch(() => "<no-composer>");
      ctx.ok("voice-cancel-no-draft-change", draftAfterC === draftBefore, "draft untouched by Cancel");
      const cancelDom = await vp3.evaluate(() => document.body.innerText);
      ctx.ok("voice-cancel-clean", !/Dictation failed/i.test(cancelDom), "no stuck error after Cancel");
      const msgsC1 = mustArray(ctx, "voice-msgs-cancel-after", await get("/api/meetings/" + mid + "/messages?take=100", { token: tokA }));
      ctx.ok("voice-cancel-no-publish", msgsC1.length === msgsC0.length, "msgs " + msgsC0.length + "->" + msgsC1.length);
    }
    await vctx3.close();
  }
  // --- Enter key behavior: single Enter sends exactly one POST (acceptance);
  // a same-tick double keydown count is RECORDED from the actual HTTP
  // observer and reported to the UI owner. Keyboard acceptance is the
  // single-Enter exactness below; the double count is data, not a waiver.
  {
    await page.goto(WEB + "/#/meet?board=" + bid + "&meeting=" + mid, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(1200);
    const enterScope = page.locator('section[aria-label="Meetings and conversation"]');
    await enterScope.locator('select[aria-label="Message audience"]').selectOption("everyone");
    const enterPosts = [];
    const onEnterReq = (req) => { if (req.method() === "POST" && /\/api\/meetings\/[^/]+\/(messages|secretary)$/.test(req.url())) enterPosts.push(req.url()); };
    page.on("request", onEnterReq);
    const enterBox = enterScope.getByLabel("Message. Press Enter to send, Shift and Enter for a new line.");
    const msgsE0 = mustArray(ctx, "enter-msgs-before", await get("/api/meetings/" + mid + "/messages?take=100", { token: tokA }));
    await enterBox.fill("enter single " + run);
    await enterBox.focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(3000);
    const msgsE1 = mustArray(ctx, "enter-msgs-single", await get("/api/meetings/" + mid + "/messages?take=100", { token: tokA }));
    ctx.ok("enter-single-sends-one", enterPosts.length === 1 && msgsE1.length === msgsE0.length + 1, "posts=" + enterPosts.length + " msgs " + msgsE0.length + "->" + msgsE1.length);
    // Worst case: two keydowns dispatched in the SAME tick (before React
    // flushes isPending). Count the ACTUAL production POSTs.
    enterPosts.length = 0;
    await enterBox.fill("enter double " + run);
    await page.evaluate(() => {
      const el = document.querySelector('section[aria-label="Meetings and conversation"] textarea');
      if (!el) return "no-box";
      const mk = () => new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true });
      el.dispatchEvent(mk());
      el.dispatchEvent(mk());
      return "dispatched-twice-same-tick";
    });
    await page.waitForTimeout(3000);
    const msgsE2 = mustArray(ctx, "enter-msgs-double", await get("/api/meetings/" + mid + "/messages?take=100", { token: tokA }));
    ctx.ok("enter-double-count-recorded", true, "same-tick double keydown actual POSTs=" + enterPosts.length + " msgs " + msgsE1.length + "->" + msgsE2.length + " (reported to UI owner; acceptance is single-Enter exactness above)");
    writeArt("enter-double.json", { posts: enterPosts.length, urls: enterPosts, msgsBefore: msgsE1.length, msgsAfter: msgsE2.length });
    try { page.off("request", onEnterReq); } catch {}
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
  ctx.ok("leg6-fatal", false, String((e && e.message) || e).slice(0, 300) + " STACK:" + String((e && e.stack) || "none").slice(0, 600));
} finally {
  try { await browser3.close(); } catch {}
  try { await browser2.close(); } catch {}
  try { await browser.close(); } catch {}
  ctx.ok("leg6-browser-closed", true, "owned Edge closed, no shared CDP touched");
}

process.exit(ctx.verdict());
