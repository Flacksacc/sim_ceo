const { chromium } = require("./node_modules/playwright-core");
const fs = require("fs");
const path = require("path");
const API = process.env.QA_API || "http://127.0.0.1:5097";
const WEB = process.env.QA_WEB || "http://127.0.0.1:5187/";
const SHOT = process.env.QA_SHOTS || path.join(__dirname, "..", ".tmp");
const run = "p8ui-" + Date.now().toString(36);
let pass = 0, fail = 0; const bad = [];
function ok(n, c, e) { if (c) { pass++; console.log("  ok - " + n); } else { fail++; bad.push(n + (e ? " :: " + e : "")); console.log("  FAIL " + n + (e ? " :: " + e : "")); } }
async function req(method, p, body, headers) {
  const r = await fetch(API + p, { method, headers: { "content-type": "application/json", ...(headers || {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {} return { status: r.status, json: j, text: t };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  console.log("repair-ui run=" + run + " web=" + WEB + " api=" + API);
  const pw = "TestPassword123!";
  const B = (t) => ({ Authorization: "Bearer " + t });
  const ownerE = run + "-owner@example.com", guestE = run + "-guest@example.com";
  // owner setup via REST: register, board, meeting, invite
  const ow = await req("POST", "/api/auth/register", { email: ownerE, password: pw });
  ok("owner-rest-reg", ow.status === 201 && ow.json?.token, ow.status + " " + ow.text.slice(0, 120));
  const ownerT = ow.json?.token;
  const b = await req("POST", "/api/boards", { name: run + "-board", mission: "m", stage: "s" }, B(ownerT));
  ok("owner-rest-board", b.status === 201 && b.json?.id, b.status + " " + b.text.slice(0, 160));
  const bid = b.json?.id;
  const m = await req("POST", `/api/boards/${bid}/meetings`, { title: run + "-meeting", brief: "brief" }, B(ownerT));
  const mid = m.json?.id; ok("owner-rest-meeting", m.status === 201 && mid, m.status + " " + m.text.slice(0, 160));
  const inv = await req("POST", `/api/boards/${bid}/invites`, { email: guestE, role: "guest", meetingId: mid }, B(ownerT));
  const invId = inv.json?.id || inv.json?.Id; ok("owner-rest-invite", inv.status === 201 && invId, inv.status + " " + inv.text.slice(0, 200));
  const exe = process.env.USERPROFILE + "\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe";
  const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  // 1. invite lookup renders WITHOUT any token (credential-free)
  await page.goto(WEB + "#/boards?invite=" + invId, { waitUntil: "domcontentloaded" });
  await sleep(2500);
  const pubBody = await page.content();
  ok("ui-invite-public-no-token", pubBody.includes(run + "-board") && pubBody.includes(run + "-meeting"), "public invite did not render board/meeting");
  await page.screenshot({ path: path.join(SHOT, "ui-invite.png") });
  // 2. real UI registration binds a verified session (not just echoed text)
  await page.getByLabel("Account email").fill(guestE);
  await page.getByLabel("Account password").fill(pw);
  await page.getByRole("button", { name: "Register" }).click();
  await sleep(2500);
  const token = await page.evaluate(() => localStorage.getItem("simceo-token") || "");
  const user = await page.evaluate(() => localStorage.getItem("simceo-user") || "");
  ok("ui-register-token", !!token && token.length > 20, "len=" + (token || "").length);
  ok("ui-register-user", user.toLowerCase() === guestE, user);
  const statusText = await page.getByRole("status").first().textContent().catch(() => "");
  ok("ui-register-status", (statusText || "").includes("signed in"), (statusText || "").slice(0, 120));
  await page.screenshot({ path: path.join(SHOT, "ui-register.png") });
  // 3. invite survives remount; accept binds identity + opens exact meeting
  const invStill = await page.getByLabel("Invite ID").inputValue().catch(() => "");
  ok("ui-invite-survives-signup", invStill === invId, invStill);
  try { await page.getByRole("button", { name: "Accept invite" }).click({ timeout: 8000 }); } catch (e) { ok("ui-accept-click", false, String(e).split("\n")[0]); }
  await sleep(2500);
  const openBtn = page.getByRole("button", { name: "Open meeting" });
  ok("ui-accept-opens", await openBtn.count() === 1, "open button missing");
  try { await openBtn.click({ timeout: 8000 }); } catch (e) { ok("ui-open-click", false, String(e).split("\n")[0]); try { await page.screenshot({ path: path.join(SHOT, "ui-accept-debug.png") }); } catch {} }
  await sleep(3000);
  const hash = await page.evaluate(() => location.hash);
  ok("ui-open-hash", hash.includes(bid) && hash.includes(mid), hash);
  const meetBody = await page.content();
  ok("ui-meeting-renders", meetBody.includes(run + "-meeting"), "meeting title not rendered");
  await page.screenshot({ path: path.join(SHOT, "ui-meeting.png") });
  let __closed = false;
  try {
  // 4. guest sends one message through the real composer; UI renders it live
  const composer = page.getByLabel("Message. Press Enter to send, Shift and Enter for a new line.");
  ok("ui-composer-present", await composer.count() === 1, "composer missing");
  await composer.fill("hello from browser guest");
  await composer.press("Enter");
  await sleep(3500);
  const liveSend = await page.content();
  ok("ui-guest-send-live", liveSend.includes("hello from browser guest"), "sent message not rendered live");
  // browser SignalR transport joined (live badge), not just polling
  const liveBadge = await page.getByText("live", { exact: true }).count().catch(() => 0);
  ok("ui-hub-live", liveBadge >= 1, "live badge missing (hub not joined via browser transport)");
  await page.reload({ waitUntil: "domcontentloaded" }); await sleep(4500);
  const afterSend = await page.content();
  ok("ui-message-renders", afterSend.includes("hello from browser guest"), "sent message not rendered after reload");
  // 5. read-only guest settings show actual values; forbidden controls absent
  ok("ui-guest-settings", afterSend.includes("Read-only guest settings"), "guest settings missing");
  ok("ui-settings-values", afterSend.includes(run + "-board"), "board name missing from settings");
  const secOpt = await page.getByRole("option", { name: "Secretary (direct)" }).count().catch(() => 0);
  ok("ui-secretary-absent", secOpt === 0, "secretary option visible to guest");
  const forbid = ["Pause", "Resume", "End discussion", "Approve selected", "Approve all", "Save draft", "Activate configuration", "Prepare briefing", "Save note", "Prepare draft from items", "Discard draft"];
  const missing = [];
  for (const label of forbid) { const c = await page.getByRole("button", { name: label }).count().catch(() => 0); if (c > 0) missing.push(label); }
  ok("ui-forbidden-absent", missing.length === 0, "visible: " + missing.join(","));
  await page.screenshot({ path: path.join(SHOT, "ui-settings.png") });
  // 5b. Back/Forward + deep link
  await page.goBack().catch(() => {});
  await sleep(1500);
  await page.goForward().catch(() => {});
  await sleep(2500);
  const fwdBody = await page.content();
  ok("ui-forward-restore", fwdBody.includes(run + "-meeting"), "forward navigation lost meeting");
  await page.goto(WEB + "#/meet?board=" + bid + "&meeting=" + mid, { waitUntil: "domcontentloaded" });
  await sleep(3000);
  ok("ui-deep-link", (await page.content()).includes(run + "-meeting"), "deep link did not render");
  // 6. leave via the visible UI Leave button (boards tab My meetings)
  await page.evaluate(() => { window.location.hash = "#/boards"; });
  await sleep(2500);
  const myMeet = page.getByText(mid, { exact: false });
  ok("ui-mymeetings-row", await myMeet.count() >= 1, "membership row missing");
  const leaveBtn = page.getByRole("button", { name: "Leave" });
  const leaveCount = await leaveBtn.count().catch(() => 0);
  ok("ui-leave-visible", leaveCount >= 1, "no UI Leave button");
  if (leaveCount > 0) { try { await leaveBtn.first().click({ timeout: 8000 }); } catch (e) { ok("ui-leave-click", false, String(e).split("\\n")[0]); } await sleep(2000); }
  const viaToken2 = await page.evaluate(() => localStorage.getItem("simceo-token") || "");
  const leftDenied = await req("GET", `/api/meetings/${mid}/messages?take=5`, undefined, B(viaToken2));
  ok("ui-leave-rest-denied", leftDenied.status === 403, leftDenied.status + " " + leftDenied.text.slice(0, 120));
  await page.reload({ waitUntil: "domcontentloaded" }); await sleep(2500);
  const leftBody = await page.content();
  ok("ui-leave-no-private", !leftBody.includes("hello from browser guest"), "private messages visible after leave");
  // 7. REAL expiry: restart the API (sessions are memory-only), reload, re-login via UI
  const { execSync } = require("node:child_process");
  let restarted = false;
  try {
    execSync("powershell -NoProfile -Command \"$p = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'dotnet.exe' -or $_.Name -eq 'SimCEO.Api.exe' } | Where-Object { $_.CommandLine -like '*5097*' } | Select-Object -ExpandProperty ProcessId; if ($p) { Stop-Process -Id $p -Force }\"", { timeout: 30000 });
    await sleep(3000);
    execSync("powershell -NoProfile -Command \"$env:USE_POSTGRES='1'; $env:META_API_BASE='http://127.0.0.1:5199'; $env:META_API_KEY='dummy-qa-key'; $env:ConnectionStrings__App='Host=127.0.0.1;Port=15437;Database=simceo;Username=simceo;Password=simceo-dev-only'; Set-Location 'C:\\Users\\War\\scrach\\sim_ceo\\.tmp\\meeting-guests-worktree'; Start-Process dotnet -ArgumentList 'run','--project','server\\SimCEO.Api\\SimCEO.Api.csproj','--no-build','--','--urls','http://127.0.0.1:5097' -WindowStyle Hidden\"", { timeout: 30000 });
    for (let i = 0; i < 30; i++) {
      await sleep(2000);
      try { const h = await fetch(API + "/health"); if (h.ok) { restarted = true; break; } } catch {}
    }
  } catch (e) { ok("ui-restart", false, String(e).split("\\n")[0]); }
  ok("ui-restart", restarted, "API did not come back after restart");
  const deadCheck = await req("GET", `/api/meetings/${mid}/messages?take=5`, undefined, B(viaToken2));
  ok("ui-restart-killed-sessions", deadCheck.status === 401, deadCheck.status + " " + deadCheck.text.slice(0, 120));
  await page.reload({ waitUntil: "domcontentloaded" }); await sleep(3000);
  const expBody = await page.content();
  ok("ui-expired-banner", expBody.includes("Session expired"), "no expired-session transition after real restart");
  ok("ui-expired-no-private", !expBody.includes("hello from browser guest"), "stale private data rendered");
  await page.screenshot({ path: path.join(SHOT, "ui-expired.png") });
  await page.getByLabel("Account email").fill(guestE);
  await page.getByLabel("Account password").fill(pw);
  await page.getByRole("button", { name: "Sign in" }).click();
  await sleep(2500);
  const reUser = await page.evaluate(() => localStorage.getItem("simceo-user") || "");
  ok("ui-reauth", reUser.toLowerCase() === guestE, reUser);
  const reDenied = await req("GET", `/api/meetings/${mid}/messages?take=5`, undefined, B(await page.evaluate(() => localStorage.getItem("simceo-token") || "")));
  ok("ui-reauth-still-denied", reDenied.status === 403, reDenied.status + " left membership must not resurrect");
  // 8. left guest deep link is denied; stranger link recovers without private data
  await page.goto(WEB + "#/meet?board=" + bid + "&meeting=" + mid, { waitUntil: "domcontentloaded" });
  await sleep(3000);
  const leftDeep = await page.content();
  ok("ui-left-deep-denied", !leftDeep.includes("hello from browser guest"), "left guest saw private meeting");
  const strCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const strPage = await strCtx.newPage();
  try {
    await strPage.goto(WEB + "#/meet?board=" + bid + "&meeting=" + mid, { waitUntil: "domcontentloaded" });
    await sleep(3000);
    const strBody = await strPage.content();
    ok("ui-denied-link", !strBody.includes("hello from browser guest"), "stranger saw private content");
  } finally { try { await strCtx.close(); } catch {} }
  // 9. mobile viewport + keyboard-only send + same-account draft preservation
  const mobCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const mob = await mobCtx.newPage();
  try {
    await mob.goto(WEB + "#/boards", { waitUntil: "domcontentloaded" });
    await sleep(2500);
    ok("ui-mobile-boards", (await mob.content()).includes("Accounts"), "mobile boards view missing");
    await mob.getByLabel("Account email").fill(ownerE);
    await mob.getByLabel("Account password").fill(pw);
    await mob.getByRole("button", { name: "Sign in" }).click();
    await sleep(2500);
    const mobComposer = mob.getByLabel("Message. Press Enter to send, Shift and Enter for a new line.");
    await mob.goto(WEB + "#/meet?board=" + bid + "&meeting=" + mid, { waitUntil: "domcontentloaded" });
    await sleep(3000);
    ok("ui-mobile-composer", await mobComposer.count() >= 1, "composer missing on mobile");
    // keyboard-only: anchor focus on the chat tab with a real click, then Tab to the composer
    const compFocused = () => mob.evaluate(() => ((document.activeElement && document.activeElement.getAttribute("aria-label")) || "").indexOf("Press Enter to send") >= 0).catch(() => false);
    try { await mob.getByRole("tab", { name: "chat" }).click({ timeout: 8000 }); } catch {}
    await sleep(500);
    let tabbed = await compFocused();
    let trail = "";
    for (let i = 0; i < 60 && !tabbed; i++) {
      await mob.keyboard.press("Tab");
      await sleep(80);
      tabbed = await compFocused();
      if (i < 8) { try { trail += "|" + await mob.evaluate(() => (document.activeElement && ((document.activeElement.getAttribute("aria-label") || document.activeElement.textContent || "").trim().slice(0, 24))) || "?"); } catch {} }
    }
    ok("ui-keyboard-focus", tabbed, "composer not keyboard reachable trail=" + trail);
    await mob.keyboard.type("kb-only hello");
    await sleep(500);
    await mob.keyboard.press("Enter");
    await sleep(3000);
    ok("ui-keyboard-send", (await mob.content()).includes("kb-only hello"), "keyboard-sent message not rendered");
    await mobComposer.fill("draft-keep-me");
    await sleep(1500);
    await mob.reload({ waitUntil: "domcontentloaded" });
    await sleep(2500);
    const kept = await mobComposer.inputValue().catch(() => "");
    ok("ui-draft-preserved", kept === "draft-keep-me", "same-account draft lost: [" + kept + "]");
    await mob.screenshot({ path: path.join(SHOT, "ui-mobile.png") });
  } finally { try { await mobCtx.close(); } catch {} }
  } finally { if (!__closed) { try { await browser.close(); } catch {} __closed = true; } }

  console.log(`FINAL pass=${pass} fail=${fail}`);
  if (bad.length) { console.log("FAILURES:"); for (const x of bad) console.log(" - " + x); }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log("HARNESS-ERROR " + (e && e.stack || e)); process.exit(2); });
