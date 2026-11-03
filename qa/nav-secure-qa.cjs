// qa/nav-secure-qa.cjs - navigation + secure-UI role/browser QA (Muse lane).
// Owned stack ONLY: API 127.0.0.1:5129, web 127.0.0.1:5197, Edge CDP 127.0.0.1:9336.
// REAL registered identities (admin/owner/contribute/readonly/discuss-guest/
// unrelated/anonymous/expired/revoked Bearer). No localStorage authority bypass.
// Every check asserts actual request authority AND rendered DOM; unexpected
// console errors, failed requests, or 5xx responses fail the run.
const { chromium } = require("playwright-core");
const fs = require("fs");
const path = require("path");
const API = process.env.NAVQA_API || "http://127.0.0.1:5129";
const WEB = (process.env.NAVQA_WEB || "http://127.0.0.1:5197/").replace(/\/*$/, "/");
const CDP = process.env.NAVQA_CDP || "http://127.0.0.1:9336";
const SHOTDIR = path.join(__dirname, "..", ".tmp", "nav-secure-shots");
try { fs.mkdirSync(SHOTDIR, { recursive: true }); } catch (e) {}
const TS = Date.now().toString(36);
let passed = 0, failed = 0; const failures = []; let shotN = 0;
function ok(n) { passed++; console.log("  ok - " + n); }
function bad(n, extra) { failed++; console.log("  FAIL - " + n + (extra ? " :: " + extra : "")); failures.push(n); }
async function check(n, fn) {
  try { if (await fn()) { ok(n); return true; } bad(n); return false; }
  catch (e) { bad(n, String((e && e.message) || e).split("\n")[0]); return false; }
}
async function api(method, p, token, body) {
  const h = { "Content-Type": "application/json" };
  if (token) h.Authorization = "Bearer " + token;
  const r = await fetch(API + p, { method: method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  let j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { j = null; }
  return { status: r.status, json: j, text: t };
}

async function must(promise, what) {
  const r = await promise;
  if (r.status < 200 || r.status >= 300) throw new Error(what + " -> HTTP " + r.status + " " + r.text.slice(0, 200));
  return r.json;
}
async function setupFixtures() {
  console.log("FIXTURES (real API " + API + ")");
  const pw = "0123456789ab";
  let adminTok = null;
  const adminLogin = await api("POST", "/api/auth/login", null, { email: "admin@nav.qa", password: pw });
  if (adminLogin.status === 200 && adminLogin.json && adminLogin.json.token) { adminTok = adminLogin.json.token; }
  else {
    const adminReg = await must(api("POST", "/api/auth/register", null, { email: "admin@nav.qa", password: pw }), "admin bootstrap register");
    adminTok = adminReg.token;
  }
  const admin = { email: "admin@nav.qa", token: adminTok };
  const users = {};
  for (const role of ["owner", "contrib", "reader", "discuss", "unrelated"]) {
    const email = role + "-" + TS + "@nav.qa";
    const reg = await must(api("POST", "/api/auth/register", null, { email: email, password: pw }), "register " + role);
    users[role] = { email: email, token: reg.token };
  }
  users.admin = { email: "admin@nav.qa", token: admin.token };
  const board = await must(api("POST", "/api/boards", users.owner.token, { name: "Nav Board " + TS, mission: "Prove navigation and role gates" }), "owner create board");
  const BID = board.id;
  const mtg = await must(api("POST", "/api/boards/" + BID + "/meetings", users.owner.token, { title: "Nav session", brief: "Probe the gates." }), "owner create meeting");
  const MID = mtg.id;
  const mtg2 = await must(api("POST", "/api/boards/" + BID + "/meetings", users.owner.token, { title: "Second session", brief: "Other context." }), "owner create meeting2");
  const MID2 = mtg2.id;
  const board2 = await must(api("POST", "/api/boards", users.owner.token, { name: "Other Board " + TS, mission: "Wrong parent probe" }), "owner create board2");
  const BID2 = board2.id;
  const mtgB2 = await must(api("POST", "/api/boards/" + BID2 + "/meetings", users.owner.token, { title: "Elsewhere", brief: "Far away." }), "owner create board2 meeting");
  const MIDB2 = mtgB2.id;
  await must(api("POST", "/api/boards/" + BID + "/grants", users.owner.token, { userKey: users.contrib.email, access: "contribute" }), "grant contrib");
  await must(api("POST", "/api/boards/" + BID + "/grants", users.owner.token, { userKey: users.reader.email, access: "read" }), "grant reader");
  const inv = await must(api("POST", "/api/boards/" + BID + "/invites", users.owner.token, { email: users.discuss.email, role: "discuss", meetingId: MID }), "invite discuss");
  const acc = await must(api("POST", "/api/invites/" + inv.id + "/accept", users.discuss.token, {}), "discuss accept");
  await must(api("POST", "/api/meetings/" + MID + "/join", users.discuss.token, {}), "discuss join");
  const draft = await must(api("POST", "/api/meetings/" + MID + "/record/draft", users.owner.token, [{ id: "a", text: "Raise starter by five" }]), "owner draft record");
  const REC = draft.id;
  const review0 = await must(api("GET", "/api/records/" + REC + "/review", users.owner.token), "review load");
  const tmp = await must(api("POST", "/api/auth/register", null, { email: "revoke-" + TS + "@nav.qa", password: pw }), "register revoke-target");
  users.revoked = { email: tmp.email || ("revoke-" + TS + "@nav.qa"), token: tmp.token };
  await must(api("POST", "/api/auth/logout", users.revoked.token, {}), "revoke token");
  users.anonymous = { email: "", token: "" };
  users.expired = { email: "expired@nav.qa", token: "DEAD" + TS + "BEEF" };
  console.log("  board=" + BID + " m1=" + MID + " m2=" + MID2 + " b2=" + BID2 + " mb2=" + MIDB2 + " rec=" + REC);
  return { users: users, BID: BID, MID: MID, MID2: MID2, BID2: BID2, MIDB2: MIDB2, REC: REC, review0: review0 };
}

let browser = null;
async function connectBrowser() {
  browser = await chromium.connectOverCDP(CDP);
  const contexts = browser.contexts();
  console.log("CDP connected: " + contexts.length + " context(s) already open (untouched)");
}
function watch(page, tag) {
  page._navqa = { consoleErrors: [], failed: [], bad: [] };
  page.on("console", (m) => { if (m.type() === "error") page._navqa.consoleErrors.push(tag + ": " + m.text().slice(0, 300)); });
  page.on("pageerror", (e) => { page._navqa.consoleErrors.push(tag + " pageerror: " + String((e && e.message) || e).slice(0, 300)); });
  page.on("requestfailed", (r) => { page._navqa.failed.push(tag + " " + r.method() + " " + r.url().slice(0, 160) + " :: " + (r.failure() && r.failure().errorText)); });
  page._navqa.statuses = []; page.on("response", (r) => {
    const u = r.url();
    if (u.indexOf("/api/") < 0 && u.indexOf("/hubs/") < 0) return;
    const s = r.status(); try { if (s >= 400) page._navqa.statuses.push(s + ":" + u.slice(u.indexOf("/api/"))); } catch (e) {}
    if (s >= 500) page._navqa.bad.push(tag + " " + s + " " + u.slice(0, 160));
  });
}
function auditPage(page, label, authNoiseOk) {
  const q = page._navqa || { consoleErrors: [], failed: [], bad: [] };
  let ce = q.consoleErrors.filter((m) => !/status of 404/.test(m)); if (authNoiseOk) ce = ce.filter((m) => !/status of (401|403)/.test(m)); const probs = ce.concat(q.failed, q.bad); const stx0 = (q.statuses || []).slice(); q.consoleErrors = []; q.failed = []; q.bad = []; q.statuses = [];
  if (probs.length === 0) { ok(label + " clean (no console errors/request failures/5xx)"); return true; } else { try { const stx = stx0.slice(0, 10).join(" ~ "); if (stx) console.log("    statuses: " + stx); } catch (e) {} }
  bad(label + " problems", probs.slice(0, 4).join(" | "));
  return false;
}
async function newCtx(vp, theme) {
  const ctx = await browser.newContext({ viewport: vp });
  if (theme) await ctx.addInitScript("try { localStorage.setItem(\"simceo-theme\", \"" + theme + "\"); } catch (e) {}");
  return ctx;
}
async function openAs(ctx, user, hash) {
  const page = await ctx.newPage();
  watch(page, user.email || "anon");
  if (user.token) {
    await page.addInitScript("try { localStorage.setItem(\"simceo-token\", \"" + user.token + "\"); localStorage.setItem(\"simceo-user\", \"" + user.email + "\"); } catch (e) {}");
  }
  await page.goto(WEB + "#" + hash, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2500);
  return page;
}
async function shot(page, name) {
  try { await page.screenshot({ path: path.join(SHOTDIR, name + ".png") }); } catch (e) {}
}
async function hasText(page, s) {
  try { const b = await page.$("body"); if (!b) return false; const t = await b.textContent(); return (t || "").indexOf(s) >= 0; } catch (e) { return false; }
}
async function hasSel(page, sel) {
  try { const el = await page.$(sel); return !!el; } catch (e) { return false; }
}
async function btnVisible(page, label) {
  try {
    const els = await page.$$("button");
    for (const el of els) { try { const t = await el.textContent(); if ((t || "").trim() === label && await el.isVisible()) return true; } catch (e) {} }
    return false;
  } catch (e) { return false; }
}
async function btnEnabled(page, label) {
  try {
    const els = await page.$$("button");
    for (const el of els) { try { const t = await el.textContent(); if ((t || "").trim() === label && await el.isVisible()) return await el.isEnabled(); } catch (e) {} }
    return null;
  } catch (e) { return null; }
}
async function hashOf(page) { try { return await page.evaluate("window.location.hash"); } catch (e) { return ""; } }

async function roleMatrix(fx) {
  console.log("ROLE MATRIX (desktop light)");
  const vp = { width: 1440, height: 1000 };
  const U = fx.users, BID = fx.BID, MID = fx.MID, REC = fx.REC;
  let ctx = await newCtx(vp, "light");
  let page = await openAs(ctx, U.owner, "/boards?board=" + BID);
  await check("owner sees Save draft", async () => btnVisible(page, "Save draft"));
  await check("owner sees Activate configuration", async () => btnVisible(page, "Activate configuration"));
  await check("owner sees Archive on open board", async () => btnVisible(page, "Archive"));
  await check("owner boards URL exact", async () => (await hashOf(page)) === "#/boards?board=" + BID);
  await check("owner boards tab active", async () => hasSel(page, "[aria-current=\"page\"]"));
  await page.goto(WEB + "#/activity?board=" + BID, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await check("owner sees Export full backup", async () => btnVisible(page, "Export full backup"));
  await check("owner sees NO Save spending controls", async () => !(await btnVisible(page, "Save spending controls")));
  await check("owner activity URL exact", async () => (await hashOf(page)) === "#/activity?board=" + BID);
  auditPage(page, "owner activity");
  await page.goto(WEB + "#/boards?board=" + BID, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  auditPage(page, "owner boards");
  await page.goto(WEB + "#/meet?board=" + BID + "&meeting=" + MID, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await check("owner sees Start meeting", async () => btnVisible(page, "Start meeting"));
  try { await page.fill("textarea[aria-label^=\"Message\"], textarea", "hello board"); } catch (e) {}
  await page.waitForTimeout(400);
  await check("owner Send enabled", async () => (await btnEnabled(page, "Send")) === true);
  await check("owner Run enabled", async () => (await btnEnabled(page, "Run discussion")) === true);
  await check("owner Meeting setup visible", async () => hasText(page, "Meeting setup"));
  await check("owner meet URL exact", async () => (await hashOf(page)) === "#/meet?board=" + BID + "&meeting=" + MID);
  auditPage(page, "owner meet");
  await page.goto(WEB + "#/records?board=" + BID + "&meeting=" + MID + "&rec=" + REC, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await check("owner sees Approve all", async () => btnVisible(page, "Approve all"));
  await check("owner sees Refresh review", async () => btnVisible(page, "Refresh review"));
  await check("owner sees Prepare draft", async () => btnVisible(page, "Prepare draft from items"));
  await check("owner sees Export concise", async () => btnVisible(page, "Export concise"));
  await check("owner records URL exact", async () => (await hashOf(page)) === "#/records?board=" + BID + "&meeting=" + MID + "&rec=" + REC);
  auditPage(page, "owner records");

  await ctx.close();
  ctx = await newCtx(vp, "light");
  page = await openAs(ctx, U.contrib, "/records?board=" + BID + "&meeting=" + MID + "&rec=" + REC);
  await check("contrib sees NO Approve all", async () => !(await btnVisible(page, "Approve all")));
  await check("contrib sees NO Approve selected", async () => !(await btnVisible(page, "Approve selected")));
  await check("contrib sees approval-requires note", async () => hasText(page, "Approval requires a manage grant"));
  await check("contrib sees Refresh review", async () => btnVisible(page, "Refresh review"));
  await check("contrib sees Prepare draft", async () => btnVisible(page, "Prepare draft from items"));
  auditPage(page, "contrib records");
  await page.goto(WEB + "#/meet?board=" + BID + "&meeting=" + MID, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  try { await page.fill("textarea", "contrib hello"); } catch (e) {}
  await page.waitForTimeout(400);
  await check("contrib Send enabled", async () => (await btnEnabled(page, "Send")) === true);
  await check("contrib Run enabled", async () => (await btnEnabled(page, "Run discussion")) === true);
  await check("contrib sees NO Start meeting", async () => !(await btnVisible(page, "Start meeting")));
  await page.goto(WEB + "#/meet?board=" + BID + "&meeting=" + MID + "&mtab=takeaways", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await check("contrib sees Save note", async () => btnVisible(page, "Save note"));
  await page.goto(WEB + "#/meet?board=" + BID + "&meeting=" + MID, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  auditPage(page, "contrib meet");
  await page.goto(WEB + "#/people?board=" + BID, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await check("contrib sees NO Invite", async () => !(await btnVisible(page, "Invite")));
  await check("contrib sees NO Set grant", async () => !(await btnVisible(page, "Set grant")));
  auditPage(page, "contrib people");
  await ctx.close();
  ctx = await newCtx(vp, "light");
  page = await openAs(ctx, U.reader, "/meet?board=" + BID + "&meeting=" + MID);
  await check("reader sees NO Start meeting", async () => !(await btnVisible(page, "Start meeting")));
  await check("reader Send disabled", async () => (await btnEnabled(page, "Send")) === false);
  await check("reader Run disabled", async () => (await btnEnabled(page, "Run discussion")) === false);
  await check("reader sees NO Meeting setup", async () => !(await hasText(page, "Meeting setup")));
  auditPage(page, "reader meet");
  await page.goto(WEB + "#/records?board=" + BID + "&meeting=" + MID + "&rec=" + REC, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await check("reader sees NO Approve all", async () => !(await btnVisible(page, "Approve all")));
  await check("reader sees approval-requires note", async () => hasText(page, "Approval requires a manage grant"));
  await check("reader sees NO Refresh review", async () => !(await btnVisible(page, "Refresh review")));
  await check("reader sees NO Export concise", async () => !(await btnVisible(page, "Export concise")));
  auditPage(page, "reader records");
  await ctx.close();

  ctx = await newCtx(vp, "light");
  page = await openAs(ctx, U.discuss, "/meet?board=" + BID + "&meeting=" + MID);
  try { await page.fill("textarea", "guest hello"); } catch (e) {}
  await page.waitForTimeout(400);
  await check("discuss Send enabled", async () => (await btnEnabled(page, "Send")) === true);
  await check("discuss Run enabled", async () => (await btnEnabled(page, "Run discussion")) === true);
  await check("discuss sees NO Meeting setup", async () => !(await hasText(page, "Meeting setup")));
  await check("discuss sees NO Start meeting", async () => !(await btnVisible(page, "Start meeting")));
  await check("discuss meet URL exact", async () => (await hashOf(page)) === "#/meet?board=" + BID + "&meeting=" + MID);
  auditPage(page, "discuss meet");
  await page.goto(WEB + "#/meet?board=" + BID + "&meeting=" + MID + "&mtab=takeaways", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await check("discuss sees NO Save note", async () => !(await btnVisible(page, "Save note")));
  await check("discuss sees NO Prepare briefing", async () => !(await btnVisible(page, "Prepare briefing")));
  await page.goto(WEB + "#/meet?board=" + BID + "&meeting=" + MID + "&mtab=options", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await check("discuss sees NO Adopt exact text", async () => !(await btnVisible(page, "Adopt exact text")));
  await check("discuss sees NO Record this direction", async () => !(await btnVisible(page, "Record this direction")));
  auditPage(page, "discuss takeaways-options");
  await page.goto(WEB + "#/settings?board=" + BID, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await check("discuss sees readonly guest settings", async () => hasText(page, "Read-only guest settings for your assigned meeting"));
  await check("discuss settings NO Save draft", async () => !(await btnVisible(page, "Save draft")));
  auditPage(page, "discuss settings");
  await page.goto(WEB + "#/sources?board=" + BID + "&meeting=" + MID, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await check("discuss sources NO policy", async () => !(await hasText(page, "Source policy")));
  await check("discuss sources NO Upload file", async () => !(await hasText(page, "Upload file")));
  await check("discuss sources recall visible", async () => btnVisible(page, "Recall"));
  auditPage(page, "discuss sources");
  await page.goto(WEB + "#/records?board=" + BID + "&meeting=" + MID + "&rec=" + REC, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await check("discuss records NO Prepare draft", async () => !(await btnVisible(page, "Prepare draft from items")));
  await check("discuss records NO Approve all", async () => !(await btnVisible(page, "Approve all")));
  auditPage(page, "discuss records");
  await ctx.close();

  ctx = await newCtx(vp, "light");
  page = await openAs(ctx, U.unrelated, "/boards");
  await check("unrelated sees no foreign board name", async () => !(await hasText(page, "Nav Board " + TS)));
  await check("unrelated boards URL", async () => (await hashOf(page)) === "#/boards");
  auditPage(page, "unrelated boards");
  await page.goto(WEB + "#/meet?board=" + BID + "&meeting=" + MID, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await check("unrelated denied-or-fallback", async () => {
    const h = await hashOf(page);
    if (h === "#/boards") return true;
    return (h === "#/meet?board=" + BID + "&meeting=" + MID) && hasText(page, "Not authorized for this board.");
  });
  await check("unrelated sees no meeting title", async () => !(await hasText(page, "Nav session")));
  auditPage(page, "unrelated denied", true);
  await ctx.close();
  ctx = await newCtx(vp, "light");
  page = await openAs(ctx, U.anonymous, "/boards");
  await check("anon sees Accounts", async () => hasText(page, "Accounts"));
  await check("anon sees Secure mode", async () => hasText(page, "Secure mode"));
  await check("anon sees NO Session expired", async () => !(await hasText(page, "Session expired")));
  await check("anon sees no board name", async () => !(await hasText(page, "Nav Board " + TS)));
  auditPage(page, "anon boards", true);
  await ctx.close();
  ctx = await newCtx(vp, "light");
  page = await openAs(ctx, U.expired, "/boards?board=" + BID);
  await check("expired banner", async () => hasText(page, "Session expired"));
  await check("expired verification note", async () => hasText(page, "Session verification pending"));
  await check("expired hides board name", async () => !(await hasText(page, "Nav Board " + TS)));
  await check("expired hides Save draft", async () => !(await btnVisible(page, "Save draft")));
  await check("expired purged to boards", async () => (await hashOf(page)) === "#/boards");
  auditPage(page, "expired", true);
  await ctx.close();
  ctx = await newCtx(vp, "light");
  page = await openAs(ctx, U.revoked, "/boards");
  await check("revoked banner", async () => hasText(page, "Session expired"));
  await check("revoked verification note", async () => hasText(page, "Session verification pending"));
  auditPage(page, "revoked", true);
  await ctx.close();
}

async function navigationMatrix(fx) {
  console.log("NAVIGATION MATRIX (owner, desktop light)");
  const vp = { width: 1440, height: 1000 };
  const U = fx.users, BID = fx.BID, MID = fx.MID, MID2 = fx.MID2, BID2 = fx.BID2, MIDB2 = fx.MIDB2, REC = fx.REC;
  const ctx = await newCtx(vp, "light");
  const page = await openAs(ctx, U.owner, "/nope?board=" + BID);
  await check("unknown tab normalizes to boards", async () => (await hashOf(page)) === "#/boards?board=" + BID);
  await check("unknown tab shows Boards", async () => hasText(page, "Boards"));
  await page.goto(WEB + "#/meet?board=" + BID + "&meeting=" + MID + "&mtab=takeaways", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await check("takeaways URL exact", async () => (await hashOf(page)) === "#/meet?board=" + BID + "&meeting=" + MID + "&mtab=takeaways");
  await check("takeaways tab selected", async () => {
    try { const el = await page.$("button[role=tab][aria-selected=true]"); if (!el) return false; return ((await el.textContent()) || "").toLowerCase().indexOf("take") >= 0; } catch (e) { return false; }
  });
  await page.goto(WEB + "#/meet?board=" + BID + "&meeting=" + MID + "&mtab=bogus", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await check("bogus mtab normalizes to chat", async () => (await hashOf(page)) === "#/meet?board=" + BID + "&meeting=" + MID);
  await page.goto(WEB + "#/meet?board=" + BID + "&meeting=" + MID + "&ctab=decisions", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await check("ctab decisions URL exact", async () => (await hashOf(page)) === "#/meet?board=" + BID + "&meeting=" + MID + "&ctab=decisions");
  await page.goto(WEB + "#/meet?board=" + BID + "&meeting=" + MIDB2, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await check("wrong-parent meeting cleared", async () => (await hashOf(page)) === "#/meet?board=" + BID);
  await check("wrong-parent keeps board context", async () => hasText(page, "Second session"));
  const BOGUS = "00000000-0000-0000-0000-000000000000";
  await page.goto(WEB + "#/meet?board=" + BOGUS + "&meeting=" + MID, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await check("unknown board falls back to boards", async () => (await hashOf(page)) === "#/boards");
  await page.goto(WEB + "#/meet?board=" + BID + "&meeting=" + BOGUS, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await check("unknown meeting cleared, board kept", async () => (await hashOf(page)) === "#/meet?board=" + BID);
  await page.goto(WEB + "#/records?board=" + BID + "&meeting=" + MID + "&rec=" + BOGUS, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await check("unknown record cleared", async () => (await hashOf(page)) === "#/records?board=" + BID + "&meeting=" + MID);
  await check("unknown record no review", async () => !(await hasText(page, "Review v")));
  auditPage(page, "navigation direct links");

  await api("PATCH", "/api/boards/" + BID2, U.owner.token, { archived: true });
  await page.goto(WEB + "#/meet?board=" + BID2 + "&meeting=" + MIDB2, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await check("archived board still resolves", async () => (await hashOf(page)) === "#/meet?board=" + BID2 + "&meeting=" + MIDB2);
  await check("archived meeting content shown", async () => hasText(page, "Elsewhere"));
  await api("PATCH", "/api/boards/" + BID2, U.owner.token, { archived: false });
  await page.goto(WEB + "#/boards?board=" + BID, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await page.goto(WEB + "#/meet?board=" + BID + "&meeting=" + MID, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await check("nav step1 meet", async () => (await hashOf(page)) === "#/meet?board=" + BID + "&meeting=" + MID);
  await page.goto(WEB + "#/records?board=" + BID + "&meeting=" + MID + "&rec=" + REC, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await check("nav step2 records", async () => (await hashOf(page)) === "#/records?board=" + BID + "&meeting=" + MID + "&rec=" + REC);
  await page.goBack({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await check("back returns to meet URL", async () => (await hashOf(page)) === "#/meet?board=" + BID + "&meeting=" + MID);
  await check("back returns to Discussion content", async () => hasText(page, "Discussion"));
  await page.goBack({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await check("back returns to boards URL", async () => (await hashOf(page)) === "#/boards?board=" + BID);
  await check("back shows Boards content", async () => hasText(page, "Board settings"));
  await page.goForward({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await check("forward returns to meet URL", async () => (await hashOf(page)) === "#/meet?board=" + BID + "&meeting=" + MID);
  await check("forward shows meet content", async () => hasText(page, "Discussion"));
  auditPage(page, "navigation back-forward");
  await ctx.close();
}

async function inviteAndGuestRecovery(fx) {
  console.log("INVITE JOIN + GUEST RECOVERY");
  const vp = { width: 1440, height: 1000 };
  const U = fx.users, BID = fx.BID, MID = fx.MID, BID2 = fx.BID2, MIDB2 = fx.MIDB2;
  const pw = "0123456789ab";
  await api("PATCH", "/api/boards/" + BID2, U.owner.token, { archived: false });
  const fresh = "invite-" + TS + "-" + Math.floor(Math.random() * 1e6) + "@nav.qa";
  const inv = await must(api("POST", "/api/boards/" + BID + "/invites", U.owner.token, { email: fresh, role: "discuss", meetingId: MID }), "invite fresh");
  const ctx = await newCtx(vp, "light");
  const page = await openAs(ctx, U.anonymous, "/boards");
  try { await page.fill("input[aria-label=\"Invite ID\"]", inv.id); } catch (e) {}
  await page.waitForTimeout(1500);
  await check("public invite lookup shows board", async () => hasText(page, "Nav Board " + TS));
  const reg = await must(api("POST", "/api/auth/register", null, { email: fresh, password: pw }), "register invitee");
  await page.evaluate("try { localStorage.setItem(\"simceo-token\", \"" + reg.token + "\"); localStorage.setItem(\"simceo-user\", \"" + fresh + "\"); } catch (e) {}");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  try { await page.fill("input[aria-label=\"Invite ID\"]", inv.id); } catch (e) {}
  await page.waitForTimeout(1000);
  const acceptBtn = await page.$("button:has-text(\"Accept invite\")");
  if (acceptBtn) { try { await acceptBtn.click(); } catch (e) {} }
  await page.waitForTimeout(2500);
  await check("invite accepted", async () => hasText(page, "Invite accepted"));
  const openBtn = await page.$("button:has-text(\"Open meeting\")");
  if (openBtn) { try { await openBtn.click(); } catch (e) {} }
  await page.waitForTimeout(2500);
  await check("invite opens meeting", async () => (await hashOf(page)) === "#/meet?board=" + BID + "&meeting=" + MID);
  auditPage(page, "invite join", true);
  await page.goto(WEB + "#/meet?board=" + BID2 + "&meeting=" + MIDB2, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await check("guest foreign board denied inline", async () => {
    const h = await hashOf(page);
    if (h === "#/boards") return true;
    return (h === "#/meet?board=" + BID2 + "&meeting=" + MIDB2) && hasText(page, "Not authorized for this board.");
  });
  await check("guest recovery close board", async () => {
    const h = await hashOf(page);
    if (h === "#/boards") return true;
    if (!(await clickBtn(page, "Close board"))) return false;
    await page.waitForTimeout(2000);
    return (await hashOf(page)) === "#/boards";
  });
  auditPage(page, "guest recovery", true);
  await ctx.close();
}

async function recordRefreshApprove(fx) {
  console.log("RECORD REFRESH + APPROVE + 409 (owner, real API)");
  const vp = { width: 1440, height: 1000 };
  const U = fx.users, BID = fx.BID, MID = fx.MID, REC = fx.REC;
  const ctx = await newCtx(vp, "light");
  const page = await openAs(ctx, U.owner, "/records?board=" + BID + "&meeting=" + MID + "&rec=" + REC);
  const reqLog = [];
  page.on("request", (r) => { const u = r.url(); if (u.indexOf("/api/") >= 0) reqLog.push(r.method() + " " + u.slice(u.indexOf("/api/"))); });
  await check("review renders", async () => hasText(page, "Review v"));
  await check("refresh posts when stale", async () => {
    await api("POST", "/api/meetings/" + MID + "/messages", U.owner.token, { sender: "lead", content: "Advance watermark for refresh." });
    reqLog.length = 0;
    const btn = await page.$("button:has-text(\"Refresh review\")");
    if (!btn) return false;
    await btn.click();
    try { await page.waitForFunction("window.__navqaRefreshed === true", null, { timeout: 2000 }); } catch (e) {}
    await page.waitForTimeout(2500);
    return reqLog.some((l) => l.indexOf("POST /api/records/" + REC + "/refresh") === 0);
  });
  await check("refresh toast visible", async () => hasText(page, "Review refreshed to current meeting input"));
  await check("approve-all posts with guards", async () => {
    reqLog.length = 0;
    const btn = await page.$("button:has-text(\"Approve all\")");
    if (!btn) return false;
    await btn.click();
    await page.waitForTimeout(2500);
    return reqLog.some((l) => l.indexOf("POST /api/meetings/" + MID + "/record/approve") === 0);
  });
  await check("approval reflected", async () => hasText(page, "Approved 1 item(s)."));
  let REC2 = "";
  await check("409 draft created", async () => {
    const mk = await api("POST", "/api/meetings/" + MID + "/record/draft", U.owner.token, [{ id: "a", text: "First" }, { id: "b", text: "Second" }]);
    if (mk.status < 200 || mk.status >= 300) return false;
    REC2 = mk.json.id;
    return !!REC2;
  });
  await check("409 review shown", async () => {
    if (!REC2) return false;
    await page.goto(WEB + "#/records?board=" + BID + "&meeting=" + MID + "&rec=" + REC2, { waitUntil: "domcontentloaded" });
    try { await page.waitForFunction((t) => (document.body.textContent || "").indexOf(t) >= 0, "Second", { timeout: 10000 }); } catch (e) { return false; }
    await page.waitForTimeout(500);
    return hasText(page, "Review v");
  });
  await check("409 stale approve rejected visibly", async () => {
    if (!REC2) return false;
    const rev = await api("GET", "/api/records/" + REC2 + "/review", U.owner.token);
    if (rev.status !== 200) return false;
    const g = rev.json.draft;
    const bump = await api("POST", "/api/records/" + REC2 + "/items/approve", U.owner.token, { version: g.version, hash: g.hash, reviewToken: g.reviewToken, watermark: g.watermark, itemId: "a" });
    if (bump.status < 200 || bump.status >= 300) return false;
    reqLog.length = 0;
    if (!(await clickBtn(page, "Approve selected"))) return false;
    await page.waitForTimeout(2500);
    const posted = reqLog.some((l) => l.indexOf("POST /api/meetings/" + MID + "/record/approve") === 0);
    if (!posted) return false;
    return (await hasText(page, "Review error:")) && (await hasText(page, "409"));
  });auditPage(page, "record refresh-approve");
  await ctx.close();
}
async function clickBtn(page, label) {
  try {
    const els = await page.$$("button");
    for (const el of els) { try { const t = await el.textContent(); if ((t || "").trim() === label && await el.isVisible()) { await el.click(); return true; } } catch (e) {} }
    return false;
  } catch (e) { return false; }
}
async function sessionTransitions(fx) {
  console.log("SESSION TRANSITIONS (held response, revoke, A-B-A drafts)");
  const vp = { width: 1440, height: 1000 };
  const U = fx.users, BID = fx.BID, MID = fx.MID;
  const b3 = await must(api("POST", "/api/boards", U.owner.token, { name: "Owner Only " + TS, mission: "Nobody else sees this" }), "owner-only board");
  const B3 = b3.id;
  const ctx = await newCtx(vp, "light");
  const page = await openAs(ctx, U.owner, "/boards");
  await page.waitForTimeout(1500);
  await check("owner sees owner-only board", async () => hasText(page, "Owner Only " + TS));
  await check("held owner response discarded after switch", async () => {
    try {
      await page.route("**/api/boards", async (route) => {
        try {
          await new Promise((r) => setTimeout(r, 1500));
          await route.continue();
        } catch (e) { try { await route.abort(); } catch (ee) {} }
      });
    } catch (e) { return false; }
    const navP = page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForTimeout(400);
    await page.evaluate("try { localStorage.setItem(\"simceo-token\", \"" + U.contrib.token + "\"); localStorage.setItem(\"simceo-user\", \"" + U.contrib.email + "\"); } catch (e) {}");
    await page.evaluate("try { window.dispatchEvent(new StorageEvent(\"storage\", { key: \"simceo-token\" })); } catch (e) {}");
    try { await navP; } catch (e) {}
    await page.waitForTimeout(2500);
    try { await page.unroute("**/api/boards"); } catch (e) {}
    try { await page.waitForFunction((t) => (document.body.textContent || "").indexOf(t) >= 0, "Nav Board", { timeout: 9000 }); } catch (e) {}
    const h = await hashOf(page);
    void h;
    return !(await hasText(page, "Owner Only " + TS));
  });
  await check("switch shows contrib identity, hides owner-only", async () => (await hasText(page, "Nav Board " + TS)) && !(await hasText(page, "Owner Only " + TS)));
  auditPage(page, "held switch", true);
  await check("revoke purges to expired", async () => {
    await page.evaluate("try { localStorage.setItem(\"simceo-token\", \"" + U.owner.token + "\"); localStorage.setItem(\"simceo-user\", \"" + U.owner.email + "\"); } catch (e) {}");
    await page.evaluate("try { window.dispatchEvent(new StorageEvent(\"storage\", { key: \"simceo-token\" })); } catch (e) {}");
    await page.waitForTimeout(1500);
    await api("POST", "/api/auth/logout", U.owner.token, {});
    await page.goto(WEB + "#/activity?board=" + BID, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(6000);
    return hasText(page, "Session expired");
  });
  await check("revoke hides private", async () => !(await hasText(page, "Nav Board " + TS)));
  await check("revoke navigates to boards", async () => (await hashOf(page)) === "#/boards");
  auditPage(page, "revoked-live", true);
  await ctx.close();
  const relog = await api("POST", "/api/auth/login", null, { email: U.owner.email, password: "0123456789ab" });
  if (relog.status < 200 || relog.status >= 300) throw new Error("owner relogin failed: " + relog.text.slice(0, 160));
  U.owner.token = relog.json.token;
  const ctx2 = await newCtx(vp, "light");
  const p2 = await openAs(ctx2, U.owner, "/meet?board=" + BID + "&meeting=" + MID);
  try { await p2.fill("textarea", "owner unsent draft XYZ"); } catch (e) {}
  await p2.waitForTimeout(800);
  await check("owner draft typed", async () => {
    try { const v = await p2.$eval("textarea", (el) => el.value); return v.indexOf("XYZ") >= 0; } catch (e) { return false; }
  });
  await clickBtn(p2, "Sign out");
  await p2.waitForTimeout(2500);
  const p3 = await openAs(ctx2, U.contrib, "/meet?board=" + BID + "&meeting=" + MID);
  try { await p3.fill("textarea", "contrib text"); } catch (e) {}
  await p3.waitForTimeout(800);
  const p4 = await openAs(ctx2, U.owner, "/meet?board=" + BID + "&meeting=" + MID);
  await check("owner draft preserved across A-B-A", async () => {
    try { const v = await p4.$eval("textarea", (el) => el.value); return v.indexOf("XYZ") >= 0; } catch (e) { return false; }
  });
  await check("contrib draft not leaked to owner", async () => {
    try { const v = await p4.$eval("textarea", (el) => el.value); return v.indexOf("contrib text") < 0; } catch (e) { return false; }
  });
  auditPage(p4, "aba drafts");
  await ctx2.close();
}
async function viewportsThemes(fx) {
  console.log("VIEWPORTS + THEMES");
  const U = fx.users, BID = fx.BID, MID = fx.MID, REC = fx.REC;
  const ba = await must(api("POST", "/api/boards", U.admin.token, { name: "Admin Board " + TS, mission: "Install admin probe" }), "admin create board");
  const BA = ba.id;
  let ctx = await newCtx({ width: 1440, height: 1000 }, "light");
  let page = await openAs(ctx, U.admin, "/boards?board=" + BA);
  await check("admin sees Save draft", async () => btnVisible(page, "Save draft"));
  await page.goto(WEB + "#/activity?board=" + BA, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await check("admin activity URL exact", async () => (await hashOf(page)) === "#/activity?board=" + BA);
  await check("admin sees Export full backup", async () => btnVisible(page, "Export full backup"));
  await check("admin sees Save spending controls", async () => btnVisible(page, "Save spending controls"));
  auditPage(page, "admin desktop");
  await ctx.close();
  ctx = await newCtx({ width: 390, height: 844 }, "light");
  page = await openAs(ctx, U.owner, "/meet?board=" + BID + "&meeting=" + MID);
  try { await page.fill("textarea", "mobile hello"); } catch (e) {}
  await page.waitForTimeout(400);
  await check("mobile owner Send enabled", async () => (await btnEnabled(page, "Send")) === true);
  await check("mobile no horizontal overflow", async () => {
    try { return await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"); } catch (e) { return false; }
  });
  auditPage(page, "mobile owner meet");
  await ctx.close();
  ctx = await newCtx({ width: 390, height: 844 }, "light");
  page = await openAs(ctx, U.expired, "/boards?board=" + BID);
  await check("mobile expired hidden", async () => !(await hasText(page, "Nav Board " + TS)));
  await check("mobile expired banner", async () => hasText(page, "Session expired"));
  auditPage(page, "mobile expired", true);
  await ctx.close();
  ctx = await newCtx({ width: 1440, height: 1000 }, "dark");
  page = await openAs(ctx, U.owner, "/boards?board=" + BID);
  await check("dark owner Save draft", async () => btnVisible(page, "Save draft"));
  await check("dark theme applied", async () => {
    try { return await page.evaluate("document.documentElement.dataset.theme === \"dark\""); } catch (e) { return false; }
  });
  await check("dark no horizontal overflow", async () => {
    try { return await page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"); } catch (e) { return false; }
  });
  auditPage(page, "dark owner boards");
  const dk = await api("POST", "/api/meetings/" + MID + "/record/draft", U.owner.token, [{ id: "d1", text: "Dark item" }]);
  if (dk.status < 200 || dk.status >= 300) throw new Error("dark draft create failed: " + dk.text.slice(0, 120));
  const RECD = dk.json.id;
  await page.goto(WEB + "#/records?board=" + BID + "&meeting=" + MID + "&rec=" + RECD, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await check("dark owner Approve all", async () => btnVisible(page, "Approve all"));
  auditPage(page, "dark owner records");
  await ctx.close();
}
async function main() {
  const t0 = Date.now();
  try { await connectBrowser(); } catch (e) { console.log("CDP connect failed: " + ((e && e.message) || e)); process.exitCode = 2; return; }
  let fx = null;
  try { fx = await setupFixtures(); } catch (e) { console.log("fixture setup failed: " + ((e && e.message) || e)); try { await browser.close(); } catch (ee) {} process.exitCode = 2; return; }
  try { await roleMatrix(fx); } catch (e) { bad("roleMatrix threw", String((e && e.message) || e).slice(0, 200)); }
  try { await navigationMatrix(fx); } catch (e) { bad("navigationMatrix threw", String((e && e.message) || e).slice(0, 200)); }
  try { await inviteAndGuestRecovery(fx); } catch (e) { bad("inviteAndGuestRecovery threw", String((e && e.message) || e).slice(0, 200)); }
  try { await recordRefreshApprove(fx); } catch (e) { bad("recordRefreshApprove threw", String((e && e.message) || e).slice(0, 200)); }
  try { await sessionTransitions(fx); } catch (e) { bad("sessionTransitions threw", String((e && e.message) || e).slice(0, 200)); }
  try { await viewportsThemes(fx); } catch (e) { bad("viewportsThemes threw", String((e && e.message) || e).slice(0, 200)); }
  try { await browser.close(); } catch (e) {}
  const secs = Math.round((Date.now() - t0) / 1000);
  console.log("NAV-SECURE-QA pass=" + passed + " fail=" + failed + " (" + secs + "s)");
  if (failed) { console.log("FAILURES:"); for (const f of failures) console.log("  - " + f); }
  process.exitCode = failed ? 1 : 0;
}
main();
