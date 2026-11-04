const fs = require("fs");
const path = require("path");
const API = process.env.QA_API || "http://127.0.0.1:15340";
const BASE = process.env.QA_BASE || API;
const SHOT = process.env.QA_SHOTS || path.join(__dirname, "..", ".tmp");
const run = "p8gui-" + Date.now().toString(36);
let pass = 0, fail = 0; const bad = [];function redact(t){ try { return String(t||"").replace(/[0-9a-fA-F]{32,}/g,"***").slice(0,160); } catch(e){ return ""; } }
function ok(n, c, e) { if (c) { pass++; console.log("  ok - " + n); } else { fail++; bad.push(n + (e ? " :: " + e : "")); console.log("  FAIL " + n + (e ? " :: " + e : "")); } }
async function req(method, p, body, headers) { const ctl = new AbortController(); const tm = setTimeout(()=>ctl.abort(),8000); let r; try { r = await fetch(API + p, { method, signal: ctl.signal, headers: { "content-type": "application/json", ...(headers || {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); } finally { clearTimeout(tm); }
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
  if (API !== "http://127.0.0.1:15340") { console.log("FATAL-GATE QA_API exact"); process.exitCode = 2; throw new Error("gate"); }
  try { const u = new URL(API); if (u.hostname !== "127.0.0.1" || u.port !== "15340") { console.log("FATAL-GATE API loopback"); process.exitCode = 2; throw new Error("gate"); } } catch { console.log("FATAL-GATE API parse"); process.exitCode = 2; throw new Error("gate"); }
  try { const ub = new URL(BASE); if (ub.hostname !== "127.0.0.1") { console.log("FATAL-GATE BASE loopback"); process.exitCode = 2; throw new Error("gate"); } } catch { console.log("FATAL-GATE BASE parse"); process.exitCode = 2; throw new Error("gate"); }
  const FAKEU = process.env.QA_FAKE || "http://127.0.0.1:15342";
  if (FAKEU !== "http://127.0.0.1:15342") { console.log("FATAL-GATE QA_FAKE exact"); process.exitCode = 2; throw new Error("gate"); }
  const st0 = await req("GET", "/api/auth/status");
  if (!st0 || st0.status !== 200) { console.log("FATAL-GATE status 200"); process.exitCode = 2; throw new Error("gate"); }
  try {
    const fr = await fetch(FAKEU + "/__log", { method: "GET" });
    const ft = await fr.text(); let fj = null; try { fj = ft ? JSON.parse(ft) : null; } catch {}
    if (!(fr.status === 200 && Array.isArray(fj))) { console.log("FATAL-GATE fake log"); process.exitCode = 2; throw new Error("gate"); }
  } catch { console.log("FATAL-GATE fake unreachable"); process.exitCode = 2; throw new Error("gate"); }

  const pw = "TestPassword123!";
  const Bnd = (t) => ({ Authorization: "Bearer " + t });
  const ownerE = run + "-owner@example.com", guestE = run + "-guest@example.com";
  const ow = await req("POST", "/api/auth/register", { email: ownerE, password: pw });
  ok("owner-rest-reg", ow.status === 201 && ow.json && ow.json.token, ow.status + " " + redact(ow.text));
  const ownerT = ow.json && ow.json.token;
  const b = await req("POST", "/api/boards", { name: run + "-board", mission: "m", stage: "s" }, Bnd(ownerT));
  ok("owner-rest-board", b.status === 201 && b.json && b.json.id, b.status + " " + redact(b.text));
  const bid = b.json.id;
  const m = await req("POST", "/api/boards/" + bid + "/meetings", { title: run + "-meeting", brief: "brief" }, Bnd(ownerT));
  const mid = m.json && m.json.id; ok("owner-rest-meeting", m.status === 201 && mid, m.status + " " + redact(m.text));
  const inv = await req("POST", "/api/boards/" + bid + "/invites", { email: guestE, role: "guest", meetingId: mid }, Bnd(ownerT));
  const invId = (inv.json && (inv.json.id || inv.json.Id)) || null; ok("owner-rest-invite", inv.status === 201 && invId, inv.status + " " + redact(inv.text));
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
    ok("ui-open-hash-structure", hash.includes("#/meet") && hash.includes("board=") && hash.includes("meeting="), hash);
    const meetBody = await page.content();
    ok("ui-meeting-renders", meetBody.includes(run + "-meeting"), "meeting title not rendered");
    const composer = page.getByLabel("Message. Press Enter to send, Shift and Enter for a new line.");
    ok("ui-composer-present", await composer.count() === 1, "composer missing");
    await composer.fill("hello from browser guest");
    const sendRespP = page.waitForResponse((r) => r.url().includes("/api/meetings/") && r.url().includes("/messages") && r.request().method() === "POST", { timeout: 15000 }).catch(() => null);
    await composer.press("Enter");
    const sendResp = await sendRespP;
    ok("ui-send-barrier-201", !!sendResp && sendResp.status() === 201, sendResp ? ("status=" + sendResp.status()) : "no-send-response");
    await sleep(2500);
    const liveSend = await page.content();
    ok("ui-guest-send-live", liveSend.includes("hello from browser guest"), "sent message not rendered live");
    const liveBadge = await page.getByText("live", { exact: true }).count().catch(() => 0);
    ok("ui-hub-live", liveBadge >= 1, "live badge missing");
    const guestTok0 = await page.evaluate(() => localStorage.getItem("simceo-token") || "");
    ok("ui-guest-token-present", !!guestTok0 && guestTok0.length > 20, "len=" + (guestTok0 || "").length);
    const srcForm = new FormData();
    srcForm.append("file", new Blob(["hello source"], { type: "text/plain" }), "note.txt");
    srcForm.append("scope", "meeting");
    srcForm.append("meetingId", mid);
    const upRes = await fetch(API + "/api/boards/" + bid + "/sources/upload", { method: "POST", headers: Bnd(ownerT), body: srcForm });
    const upText = await upRes.text(); let upJson = null; try { upJson = upText ? JSON.parse(upText) : null; } catch {}
    ok("ui-source-upload-201", upRes.status === 201 && upJson && upJson.id, upRes.status + " " + redact(upText));
    const sid = upJson && upJson.id;
    const apRes = await req("POST", "/api/sources/" + sid + "/approve", {}, Bnd(ownerT));
    ok("ui-source-approve-200", apRes.status === 200, apRes.status + " " + redact(apRes.text));
    const gdlPos = await req("GET", "/api/sources/" + sid + "/download", undefined, Bnd(guestTok0));
    ok("ui-download-positive-200", gdlPos.status === 200, gdlPos.status + " " + redact(gdlPos.text));
    ok("ui-download-positive-bytes", gdlPos.text === "hello source", redact(gdlPos.text));

    await page.reload({ waitUntil: "domcontentloaded" }); await sleep(4500);
    const afterSend = await page.content();
    ok("ui-message-renders", afterSend.includes("hello from browser guest"), "sent message not rendered after reload");
    await page.goto(BASE + "#/settings?board=" + bid, { waitUntil: "domcontentloaded" }); await sleep(2500);
    const settingsBody = await page.content();
    ok("ui-guest-settings", settingsBody.includes("Read-only guest settings for your assigned meeting."), "exact guest settings heading missing on settings tab");
    ok("ui-settings-values", settingsBody.includes(run + "-board"), "board name missing from settings tab");
    await page.goto(BASE + "#/meet?board=" + bid + "&meeting=" + mid, { waitUntil: "domcontentloaded" }); await sleep(2500);
    const forbid = ["Pause", "Resume", "End discussion", "Approve selected", "Approve all", "Save draft", "Activate configuration", "Prepare briefing", "Save note", "Prepare draft from items", "Discard draft"];
    const missing = [];
    for (const label of forbid) { const cc = await page.getByRole("button", { name: label }).count().catch(() => 0); if (cc > 0) missing.push(label); }
    ok("ui-forbidden-absent", missing.length === 0, "visible: " + missing.join(","));
    const secOpt = await page.getByRole("option", { name: "Secretary (direct)" }).count().catch(() => 0);
    ok("ui-secretary-absent", secOpt === 0, "secretary option visible to guest");
    try { await page.screenshot({ path: path.join(SHOT, "p8gui-settings.png") }); } catch {}
    await page.evaluate(() => { window.location.hash = "#/boards"; });
    await sleep(2500);
    ok("ui-mymeetings-heading", (await page.getByText("My meetings", { exact: false }).count()) >= 1, "My meetings heading missing");
    ok("ui-mymeetings-row-named", (await page.getByText(run + "-meeting", { exact: false }).count()) >= 1, "exact named meeting row missing for "+run+"-meeting");
    ok("ui-mymeetings-open", (await page.getByRole("button", { name: "Open" }).count()) >= 1, "Open missing");
    ok("ui-leave-visible", (await page.getByRole("button", { name: "Leave" }).count()) >= 1, "no UI Leave button");
    ok("ui-rejoin-absent-while-active", (await page.getByRole("button", { name: "Join again" }).count()) === 0, "Join again should be absent while membership active");
    const leaveBtn = page.getByRole("button", { name: "Leave" });
    ok("ui-leave-actionable", await leaveBtn.count() >= 1, "Leave button not actionable before click");
    await leaveBtn.first().click({ timeout: 8000 });
    await sleep(2000);
    const viaToken = await page.evaluate(() => localStorage.getItem("simceo-token") || "");
    const leftDenied = await req("GET", "/api/meetings/" + mid + "/messages?take=5", undefined, Bnd(viaToken));
    ok("ui-leave-rest-denied", leftDenied.status === 403, leftDenied.status + " " + redact(leftDenied.text));
    const leftBody = await page.content();
    ok("ui-leave-no-private", !leftBody.includes("hello from browser guest"), "private messages visible after leave");
    await page.goto(BASE + "#/meet?board=" + bid + "&meeting=" + mid, { waitUntil: "domcontentloaded" });
    await sleep(3000);
    const leftDeep = await page.content();
    ok("ui-left-deep-denied", !leftDeep.includes("hello from browser guest"), "left guest saw private meeting");
    ok("ui-stale-purged", !leftDeep.includes("hello from browser guest"), "stale private response rendered after leave");
    const uiRegrant = await req("POST", "/api/boards/" + bid + "/grants", { userKey: guestE, access: "discuss", meetingId: mid }, Bnd(ownerT));
    ok("ui-regrant-for-rejoin-201", uiRegrant.status === 201, uiRegrant.status + " " + redact(uiRegrant.text));
    await page.goto(BASE + "#/boards", { waitUntil: "domcontentloaded" }); await sleep(1500); await page.reload({ waitUntil: "domcontentloaded" }); await sleep(2500);
    ok("ui-rejoin-appears-after-regrant", (await page.getByRole("button", { name: "Join again" }).count()) >= 1, "Join again missing for inactive membership with fresh grant");
    await page.getByRole("button", { name: "Join again" }).first().click({ timeout: 8000 }); await sleep(3000);
    const rejoinClickBody = await page.content();
    ok("ui-rejoin-click-confirms", rejoinClickBody.includes("Rejoined meeting."), "Join again click did not confirm Rejoined meeting.");
    await page.reload({ waitUntil: "domcontentloaded" }); await sleep(2500);
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
    ok("owner-rest-invite2", inv2.status === 201 && invId2, inv2.status + " " + redact(inv2.text));
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

    ok("ui-purge-target-id", !!tgt && !!((tgt.id || tgt.Id)), "missing grant id");
    const guestTokPurge = await page.evaluate(() => localStorage.getItem("simceo-token") || "");
    await page.route("**/api/meetings/*/messages*", async (route) => { await sleep(2500); await route.continue(); });
    const heldFetchPurge = page.evaluate((args) => fetch(args.api + "/api/meetings/" + args.mid + "/messages?take=5", { headers: { Authorization: "Bearer " + args.tok } }).then(async (r) => ({ status: r.status, text: (await r.text()).slice(0, 120) })).catch((e) => ({ status: 0, text: "fetch-failed" })), { api: API, mid: mid, tok: guestTokPurge });
    await sleep(800);
    const delPurge = tgt ? await req("DELETE", "/api/grants/" + (tgt.id || tgt.Id), undefined, Bnd(ownerT)) : { status: 0, text: "no-target" };
    ok("ui-purge-delete-204", delPurge.status === 204, delPurge.status + " " + redact(delPurge.text || ""));
    const heldResPurge = await heldFetchPurge;
    try { await page.unroute("**/api/meetings/*/messages*"); } catch {}
    ok("ui-held-no-private-403", heldResPurge && heldResPurge.status === 403, redact(JSON.stringify(heldResPurge)));
    const gdlAfter = await req("GET", "/api/sources/" + sid + "/download", undefined, Bnd(guestTokPurge));
    ok("ui-download-zero-after-403", gdlAfter.status === 403, gdlAfter.status + " " + redact(gdlAfter.text));
    const blobsAfter = await page.evaluate(() => { try { return (window.__simceoBlobs || []).length; } catch { return -1; } });
    ok("ui-blobs-revoked", blobsAfter === 0, "blobs=" + blobsAfter);
    const abortsAfter = await page.evaluate(() => { try { return (window.__simceoAborts || []).length; } catch { return -1; } });
    ok("ui-aborts-retired", abortsAfter === 0, "aborts=" + abortsAfter);

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
