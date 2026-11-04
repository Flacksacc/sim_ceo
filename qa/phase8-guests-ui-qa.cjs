const fs = require("fs");
const path = require("path");
const API = process.env.QA_API || "http://127.0.0.1:15340";
const BASE = process.env.QA_BASE || API;
const SHOT = process.env.QA_SHOTS || path.join(__dirname, "..", ".tmp");
const run = "p8gui-" + Date.now().toString(36);
let pass = 0, fail = 0; const bad = [];
function ok(n, c, e) { if (c) { pass++; console.log("  ok - " + n); } else { fail++; bad.push(n + (e ? " :: " + e : "")); console.log("  FAIL " + n + (e ? " :: " + e : "")); } }
async function req(method, p, body, headers) {
  const r = await fetch(API + p, { method, headers: { "content-type": "application/json", ...(headers || {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {} return { status: r.status, json: j, text: t };
}
const B = (t) => (t ? { Authorization: "Bearer " + t } : {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function exePath() {
  try {
    const base = process.env.USERPROFILE + "\\AppData\\Local\\ms-playwright";
    const entries = fs.readdirSync(base).filter((x) => x.startsWith("chromium-"));
    entries.sort().reverse();
    for (const e of entries) {
      const cand = path.join(base, e, "chrome-win64", "chrome.exe");
      if (fs.existsSync(cand)) return cand;
    }
  } catch {}
  return undefined;
}
(async () => {
  console.log("guests-ui run=" + run + " base=" + BASE + " api=" + API);
  const pw = "TestPassword123!";
  const Bnd = (t) => ({ Authorization: "Bearer " + t });
  const ownerE = run + "-owner@example.com", guestE = run + "-guest@example.com";
  const ow = await req("POST", "/api/auth/register", { email: ownerE, password: pw });
  ok("owner-rest-reg", ow.status === 201 && ow.json && ow.json.token, ow.status + " " + ow.text.slice(0, 120));
  const ownerT = ow.json && ow.json.token;
  const b = await req("POST", "/api/boards", { name: run + "-board", mission: "m", stage: "s" }, Bnd(ownerT));
  ok("owner-rest-board", b.status === 201 && b.json && b.json.id, b.status + " " + b.text.slice(0, 160));
  const bid = b.json.id;
  const m = await req("POST", "/api/boards/" + bid + "/meetings", { title: run + "-meeting", brief: "brief" }, Bnd(ownerT));
  const mid = m.json && m.json.id; ok("owner-rest-meeting", m.status === 201 && mid, m.status + " " + m.text.slice(0, 160));
  const inv = await req("POST", "/api/boards/" + bid + "/invites", { email: guestE, role: "guest", meetingId: mid }, Bnd(ownerT));
  const invId = (inv.json && (inv.json.id || inv.json.Id)) || null; ok("owner-rest-invite", inv.status === 201 && invId, inv.status + " " + inv.text.slice(0, 200));
  let chromium;
  try { chromium = require("playwright-core").chromium; } catch { chromium = require("./node_modules/playwright-core").chromium; }
  const exe = exePath();
  const browser = await (exe ? chromium.launch({ executablePath: exe, args: ["--no-sandbox"] }) : chromium.launch({ args: ["--no-sandbox"] }));
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  try {
    await page.goto(BASE + "#/boards?invite=" + invId, { waitUntil: "domcontentloaded" });
    await sleep(2500);
    const pubBody = await page.content();
    ok("ui-invite-public-no-token", pubBody.includes(run + "-board") && pubBody.includes(run + "-meeting"), "public invite did not render board/meeting");
    try { await page.screenshot({ path: path.join(SHOT, "p8gui-invite.png") }); } catch {}
    await page.getByLabel("Account email").fill(guestE);
    await page.getByLabel("Account password").fill(pw);
    await page.getByRole("button", { name: "Register" }).click();
    await sleep(2500);
    const token = await page.evaluate(() => localStorage.getItem("simceo-token") || "");
    const user = await page.evaluate(() => localStorage.getItem("simceo-user") || "");
    ok("ui-register-token", !!token && token.length > 20, "len=" + (token || "").length);
    ok("ui-register-user", (user || "").toLowerCase() === guestE, user);
    await page.getByRole("button", { name: "Accept invite" }).click({ timeout: 8000 });
    await sleep(2500);
    const openBtn = page.getByRole("button", { name: "Open meeting" });
    ok("ui-accept-opens", await openBtn.count() === 1, "open button missing");
    await openBtn.click({ timeout: 8000 });
    await sleep(3000);
    const hash = await page.evaluate(() => location.hash);
    ok("ui-open-hash", hash.includes(bid) && hash.includes(mid), hash);
    const meetBody = await page.content();
    ok("ui-meeting-renders", meetBody.includes(run + "-meeting"), "meeting title not rendered");
    const composer = page.getByLabel("Message. Press Enter to send, Shift and Enter for a new line.");
    ok("ui-composer-present", await composer.count() === 1, "composer missing");
    await composer.fill("hello from browser guest");
    await composer.press("Enter");
    await sleep(3500);
    const liveSend = await page.content();
    ok("ui-guest-send-live", liveSend.includes("hello from browser guest"), "sent message not rendered live");
    const liveBadge = await page.getByText("live", { exact: true }).count().catch(() => 0);
    ok("ui-hub-live", liveBadge >= 1, "live badge missing");
    await page.reload({ waitUntil: "domcontentloaded" }); await sleep(4500);
    const afterSend = await page.content();
    ok("ui-message-renders", afterSend.includes("hello from browser guest"), "sent message not rendered after reload");
    ok("ui-guest-settings", afterSend.includes("Read-only guest settings"), "guest settings missing");
    ok("ui-settings-values", afterSend.includes(run + "-board"), "board name missing from settings");
    const forbid = ["Pause", "Resume", "End discussion", "Approve selected", "Approve all", "Save draft", "Activate configuration", "Prepare briefing", "Save note", "Prepare draft from items", "Discard draft"];
    const missing = [];
    for (const label of forbid) { const cc = await page.getByRole("button", { name: label }).count().catch(() => 0); if (cc > 0) missing.push(label); }
    ok("ui-forbidden-absent", missing.length === 0, "visible: " + missing.join(","));
    const secOpt = await page.getByRole("option", { name: "Secretary (direct)" }).count().catch(() => 0);
    ok("ui-secretary-absent", secOpt === 0, "secretary option visible to guest");
    try { await page.screenshot({ path: path.join(SHOT, "p8gui-settings.png") }); } catch {}
    await page.evaluate(() => { window.location.hash = "#/boards"; });
    await sleep(2500);
    const myMeet = page.getByText(mid, { exact: false });
    ok("ui-mymeetings-row", await myMeet.count() >= 1, "membership row missing");
    const leaveBtn = page.getByRole("button", { name: "Leave" });
    ok("ui-leave-visible", await leaveBtn.count() >= 1, "no UI Leave button");
    await leaveBtn.first().click({ timeout: 8000 });
    await sleep(2000);
    const viaToken = await page.evaluate(() => localStorage.getItem("simceo-token") || "");
    const leftDenied = await req("GET", "/api/meetings/" + mid + "/messages?take=5", undefined, Bnd(viaToken));
    ok("ui-leave-rest-denied", leftDenied.status === 403, leftDenied.status + " " + leftDenied.text.slice(0, 120));
    await page.reload({ waitUntil: "domcontentloaded" }); await sleep(2500);
    const leftBody = await page.content();
    ok("ui-leave-no-private", !leftBody.includes("hello from browser guest"), "private messages visible after leave");
    await page.goto(BASE + "#/meet?board=" + bid + "&meeting=" + mid, { waitUntil: "domcontentloaded" });
    await sleep(3000);
    const leftDeep = await page.content();
    ok("ui-left-deep-denied", !leftDeep.includes("hello from browser guest"), "left guest saw private meeting");
    ok("ui-stale-purged", !leftDeep.includes("hello from browser guest"), "stale private response rendered after leave");
    const strCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const strPage = await strCtx.newPage();
    try {
      await strPage.goto(BASE + "#/meet?board=" + bid + "&meeting=" + mid, { waitUntil: "domcontentloaded" });
      await sleep(3000);
      const strBody = await strPage.content();
      ok("ui-denied-link", !strBody.includes("hello from browser guest"), "stranger saw private content");
    } finally { try { await strCtx.close(); } catch {} }
    const inv2 = await req("POST", "/api/boards/" + bid + "/invites", { email: guestE, role: "guest", meetingId: mid }, Bnd(ownerT));
    const invId2 = (inv2.json && (inv2.json.id || inv2.json.Id)) || null;
    ok("owner-rest-invite2", inv2.status === 201 && invId2, inv2.status + " " + inv2.text.slice(0, 160));
    await page.goto(BASE + "#/boards?invite=" + invId2, { waitUntil: "domcontentloaded" });
    await sleep(2500);
    await page.getByRole("button", { name: "Accept invite" }).click({ timeout: 8000 });
    await sleep(2000);
    const openBtn2 = page.getByRole("button", { name: "Open meeting" });
    if (await openBtn2.count() === 1) { await openBtn2.click({ timeout: 8000 }); await sleep(3000); }
    const reBody = await page.content();
    ok("ui-rejoin-renders", reBody.includes(run + "-meeting"), "rejoin did not render meeting");
    const grants = await req("GET", "/api/boards/" + bid + "/grants", undefined, Bnd(ownerT));
    const rows = Array.isArray(grants.json) ? grants.json : [];
    const tgt = rows.find((x) => (((x.userKey || x.UserKey) || "").toLowerCase() === guestE) && ((x.meetingId || x.MeetingId) === mid));
    ok("ui-purge-target", !!tgt, "grant rows=" + rows.length);
    if (tgt) await req("DELETE", "/api/grants/" + (tgt.id || tgt.Id), undefined, Bnd(ownerT));
    await sleep(6000);
    const purged = await page.content();
    ok("ui-live-purge", !purged.includes("hello from browser guest"), "live private content survived revoke without reload");
    const liveAfter = await page.getByText("live", { exact: true }).count().catch(() => 0);
    ok("ui-live-cleared", liveAfter === 0, "live badge survived revoke (live=" + liveAfter + ")");
    try { await page.screenshot({ path: path.join(SHOT, "p8gui-purged.png") }); } catch {}
  } finally { try { await browser.close(); } catch {} }
  console.log("FINAL pass=" + pass + " fail=" + fail);
  if (bad.length) { console.log("FAILURES:"); for (const x of bad) console.log(" - " + x); }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log("HARNESS-ERROR " + (e && e.stack || e)); process.exit(2); });