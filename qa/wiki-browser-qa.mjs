
// Phase7 browser QA: real Chromium clicks on the strict QA web (:5189 -> :5111).
// No swallowed clicks, no global badges, no test-only globals. Uses the real
// demo identity selector in the App (Act as input), not window.__srcActAs.
import fs from "node:fs";
const API = process.env.QA_API || "http://127.0.0.1:5111";
const WEB = process.env.QA_WEB || "http://127.0.0.1:5189";
const WIKI = process.env.QA_WIKI || "http://127.0.0.1:5201";
const TOKEN = "qa-wiki-token-plain";
const OUT = ".tmp/wiki-browser-result.txt";
const PNGDIR = ".tmp/wiki-qa-png";
fs.mkdirSync(".tmp", { recursive: true });
fs.mkdirSync(PNGDIR, { recursive: true });
fs.writeFileSync(OUT, "START browser " + new Date().toISOString() + "\n");
let pass = 0, fail = 0;
const failures = [];
function ok(n, c, e) {
  const line = (c ? "PASS " : "FAIL ") + n + (e ? " :: " + e : "");
  fs.appendFileSync(OUT, line + "\n");
  if (c) pass++; else { fail++; failures.push(line); console.log("  " + line); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const low = (o) => { const m = {}; if (o && typeof o === "object") for (const k of Object.keys(o)) m[k.toLowerCase()] = o[k]; return m; };
const val = (o, k) => low(o)[k.toLowerCase()];
async function api(method, path, body, user) {
  const r = await fetch(API + path, { method, headers: { "content-type": "application/json", "x-user": user || "owner" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
let b = await api("POST", "/api/boards", { name: "wiki-browser-board" });
const BID = (b.json.id || b.json.Id);
let m = await api("POST", "/api/boards/" + BID + "/meetings", { title: "wb-m1" });
const MID = (m.json.id || m.json.Id);
await fetch(WIKI + "/__control?mode=normal&singleDelayMs=0&listDelayMs=0");
fs.writeFileSync(".tmp/wiki-browser-board.txt", BID + "\n" + MID + "\n");
const { chromium } = await import("playwright-core");
let exe = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
try { if (!fs.existsSync(exe)) exe = process.env.HOME + ""; } catch {}
if (!fs.existsSync(exe)) {
  const cand = process.env.USERPROFILE + "\\AppData\\Local\\ms-playwright\\chromium-1228\\chrome-win64\\chrome.exe";
  if (fs.existsSync(cand)) exe = cand;
}
ok("w-chromium-present", fs.existsSync(exe), exe);
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
let hitForbidden = false;
const seen = [];
const wikiRequests = [];
const reqLog = [];
page.on("request", (q) => {
  const u = q.url();
  seen.push(q.method() + " " + u);
  try { reqLog.push({ method: q.method(), url: u, headers: q.headers() }); } catch {}
  if (u.includes(":5080") || u.includes(":5173") || u.includes(":5099") || u.includes(":9333")) hitForbidden = true;
  if (u.includes("/api/wiki-resources") || u.includes("/api/boards/") && u.includes("wiki")) {
    wikiRequests.push({ method: q.method(), url: u, headers: q.headers() });
  }
});
page.on("pageerror", (e) => { fs.appendFileSync(OUT, "PAGEERROR " + String(e).slice(0, 300) + "\n"); });
await page.goto(WEB + "/#/sources?board=" + BID, { waitUntil: "networkidle", timeout: 60000 });
await page.getByText("Wiki.js 2.x connector", { exact: false }).first().waitFor({ timeout: 30000 });
ok("w-resources-render", true);
ok("w-no-forbidden-ports", !hitForbidden, seen.filter((s) => s.includes(":5080") || s.includes(":5173")).slice(0, 3).join(";"));
ok("w-no-test-global", await page.evaluate(() => !(window.__srcActAs)), "test-only global present");
await page.screenshot({ path: PNGDIR + "/wiki-resources-top.png" });
// Real identity selector lives in the People tab: set it there, then return to sources.
await page.goto(WEB + "/#/people?board=" + BID, { waitUntil: "networkidle", timeout: 60000 });
await page.getByLabel("Act as user").fill("owner");
await page.getByRole("button", { name: "Apply identity" }).click();
await sleep(1000); await page.goto(WEB + "/#/sources?board=" + BID, { waitUntil: "networkidle", timeout: 60000 }); await page.getByText("Wiki.js 2.x connector", { exact: false }).first().waitFor({ timeout: 30000 });
// Real UI create with full required fields (description + allowedUse).
await page.getByLabel("Wiki base URL").fill(WIKI + "/");
await page.getByLabel("Wiki description").fill("browser-created");
await page.getByLabel("Wiki allowed use").fill("browser lookup only");
await page.getByLabel("Wiki token").fill(TOKEN);
await page.getByRole("button", { name: "Create disabled resource" }).click();
await page.getByText("created disabled", { exact: false }).first().waitFor({ timeout: 20000 });
ok("w-ui-create", true);
// Capture the ACTUAL new resource id from the API (not the outer card).
const listAfterCreate = await api("GET", "/api/boards/" + BID + "/wiki-resources");
const createdRow = (listAfterCreate.json || []).find((x) => (x.description || x.Description) === "browser-created");
const NEW_RID = createdRow ? (createdRow.id || createdRow.Id) : null;
ok("w-create-row-id", !!NEW_RID, "new resource id missing: " + JSON.stringify(listAfterCreate.json).slice(0, 300));
await page.screenshot({ path: PNGDIR + "/wiki-resources-created.png" });
// Enable + sync the ACTUAL new row by its resource id (never the first card).
const row = page.locator("div[data-resource-id='" + NEW_RID + "']");
await row.getByRole("button", { name: "Enable" }).click();
await page.getByText("bounded sync", { exact: false }).first().waitFor({ timeout: 20000 });
ok("w-ui-enable-actual-row", true);
await row.getByRole("button", { name: "Sync " + NEW_RID }).click();
await page.getByText("Manual sync finished", { exact: false }).first().waitFor({ timeout: 30000 });
ok("w-ui-sync-actual-row", true);
// Verify via API that the ACTUAL row succeeded (not a seeded card).
const afterSync = await api("GET", "/api/wiki-resources/" + NEW_RID);
ok("w-ui-row-succeeded", afterSync.json && (afterSync.json.status === "succeeded") && ((afterSync.json.importedPages ?? afterSync.json.sourceDocs ?? 0) === 2), JSON.stringify(afterSync.json).slice(0, 300));
const domAfter = await page.content();
ok("w-ui-status-eligible", domAfter.includes("succeeded") && domAfter.includes("usable pages"), "status not rendered");
await page.screenshot({ path: PNGDIR + "/wiki-resources-synced.png", fullPage: true });
// Restricted identity via the REAL selector: both transports must carry it, and denials must hold.
const gB = await api("POST", "/api/boards/" + BID + "/grants", { userKey: "guestB", access: "read", meetingId: MID });
ok("w-guest-grant", gB.status === 200 || gB.status === 201, gB.status + " " + gB.text.slice(0, 160));
await page.goto(WEB + "/#/people?board=" + BID, { waitUntil: "networkidle", timeout: 60000 });
await page.getByLabel("Act as user").fill("guestB");
await page.getByRole("button", { name: "Apply identity" }).click();
await sleep(1000);
await page.goto(WEB + "/#/sources?board=" + BID, { waitUntil: "networkidle", timeout: 60000 });
await page.getByText("Wiki.js 2.x connector", { exact: false }).first().waitFor({ timeout: 30000 });
const irow = page.locator("div[data-resource-id='" + NEW_RID + "']");
ok("w-guest-row-hidden", (await irow.count()) === 0, "board connector row leaked to meeting guest");
const gGet = await api("GET", "/api/wiki-resources/" + NEW_RID, undefined, "guestB");
ok("w-guest-wiki-denied", gGet.status === 403, "guest wiki read not denied: " + gGet.status);
const iAlpha = page.locator("div.card", { hasText: "/guides/alpha" }).last();
await iAlpha.getByRole("button", { name: "Approve", exact: true }).click({ timeout: 15000 });
await sleep(2000);
const domGuest = await page.content();
ok("w-guest-inbox-denied", domGuest.includes("403") || domGuest.toLowerCase().includes("denied"), "guest approve not denied");
const guestReqs = reqLog.filter((e) => (e.headers["x-user"] || "") === "guestB");
ok("w-guest-headers-wiki", guestReqs.some((e) => e.url.includes("wiki-resources")), "wiki transport missing guest identity");
ok("w-guest-headers-inbox", guestReqs.some((e) => e.url.includes("/api/sources/") && e.url.includes("/approve")), "inbox transport missing guest identity");
const alphaStill = await api("GET", "/api/boards/" + BID + "/sources/review");
const alphaStillFlat = (Array.isArray(alphaStill.json) ? alphaStill.json : []).filter((g) => ((g.origin || g.Origin) === "wiki")).flatMap((g) => g.versions || []);
const alphaPend = alphaStillFlat.filter((d) => String(d.fileName || d.FileName || "").includes("alpha"));
ok("w-guest-no-change", alphaPend.length > 0 && alphaPend.every((d) => (d.reviewState || d.ReviewState) === "pending"), "guest denial changed state: " + JSON.stringify(alphaStillFlat.map((d) => d.reviewState || d.ReviewState)));
await page.goto(WEB + "/#/people?board=" + BID, { waitUntil: "networkidle", timeout: 60000 });
await page.getByLabel("Act as user").fill("owner");
await page.getByRole("button", { name: "Apply identity" }).click();
await sleep(1000);
await page.goto(WEB + "/#/sources?board=" + BID, { waitUntil: "networkidle", timeout: 60000 });
await page.getByText("Wiki.js 2.x connector", { exact: false }).first().waitFor({ timeout: 30000 });
// Inbox reloads without navigation: new pending pages appear after sync.
await page.getByText("/guides/alpha", { exact: false }).first().waitFor({ timeout: 15000 });
const inboxBefore = await page.locator("div.card", { hasText: "/guides/alpha" }).count();
ok("w-inbox-reloads", inboxBefore >= 1, "inbox missing alpha, count=" + inboxBefore);
// Approve ALPHA via its actual inbox row; verify CURRENT head marker on that family's card only,
// the persisted head points at the exact approved version, and row-local text transitions.
const pendingAlpha = (await api("GET", "/api/boards/" + BID + "/sources/review")).json;
const pendingFlat = (Array.isArray(pendingAlpha) ? pendingAlpha : []).filter((g) => ((g.origin || g.Origin) === "wiki")).flatMap((g) => (g.versions || []));
const pendAlpha = pendingFlat.find((d) => String(d.fileName || d.FileName || "").includes("alpha") && (d.reviewState || d.ReviewState) === "pending");
ok("w-approve-pending-found", !!pendAlpha, "no pending alpha version to approve");
const pendAlphaId = pendAlpha ? (pendAlpha.id || pendAlpha.Id) : null;
const famCard = page.locator("div.card", { hasText: "/guides/alpha" }).first();
await famCard.getByRole("button", { name: "Approve", exact: true }).click({ timeout: 15000 });
await famCard.getByText("CURRENT", { exact: false }).first().waitFor({ timeout: 15000 });
ok("w-ui-approve-row-local", true);
let famText = await famCard.textContent().catch(() => "");
for (let pi = 0; pi < 10 && !((famText || "").includes("CURRENT") && (famText || "").includes("approved")); pi++) { await sleep(1000); famText = await famCard.textContent().catch(() => ""); }
ok("w-ui-approve-row-text", (famText || "").includes("CURRENT") && (famText || "").includes("approved"), "family card did not transition: " + (famText || "").slice(0, 300));
const alphaDocs = await api("GET", "/api/boards/" + BID + "/sources/review");
const alphaGroups = Array.isArray(alphaDocs.json) ? alphaDocs.json : [];
const alphaGroup = alphaGroups.find((g) => String(g.fileName || g.FileName || "").includes("alpha"));
const alphaFlat = alphaGroups.flatMap((g) => (g.versions || g.Versions || []));
const alphaRow = alphaFlat.find((d) => String(val(d, "id")).toLowerCase() === String(pendAlphaId || "").toLowerCase());
ok("w-ui-approve-actual", !!alphaRow && ((alphaRow.reviewState || alphaRow.ReviewState) === "approved"), "approved version missing: " + JSON.stringify((alphaRow || {})));
ok("w-ui-approve-head", !!alphaRow && (!!alphaRow.isCurrent || !!alphaRow.IsCurrent || (alphaGroup && (String(alphaGroup.currentId || alphaGroup.CurrentId || "").toLowerCase() === String(pendAlphaId || "").toLowerCase()))), "head not pinned at approved version");
let domApprove = await page.content();
for (let di = 0; di < 10 && !domApprove.includes("CURRENT"); di++) { await sleep(1000); domApprove = await page.content(); }
ok("w-ui-current-marker", domApprove.includes("CURRENT"), "no CURRENT marker after approve");
await page.screenshot({ path: PNGDIR + "/wiki-inbox-approved.png", fullPage: true });
ok("w-no-token-in-dom", !domApprove.includes(TOKEN), "credential leaked into DOM");
const ls = await page.evaluate(() => ({ keys: Object.keys(localStorage), vals: Object.values(localStorage).join(" ").slice(0, 2000) }));
ok("w-no-token-storage", !JSON.stringify(ls).includes(TOKEN), JSON.stringify(ls).slice(0, 300));
// Credential clears on submit on BOTH paths: force a validation failure and verify.
const editRow = page.locator("div[data-resource-id='" + NEW_RID + "']");
await editRow.getByRole("button", { name: "Edit resource" }).click();
await page.getByLabel("Edit token").fill(TOKEN);
await page.getByLabel("Edit base URL").fill("not a url");
await page.getByRole("button", { name: "Save resource" }).click();
await sleep(800);
const tokFail = await page.getByLabel("Edit token").inputValue().catch(() => "missing");
ok("w-token-cleared-failure", tokFail === "", "token retained after failed save: len=" + String(tokFail).length);
const stor = await page.evaluate(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o["ls:" + k] = (localStorage.getItem(k) || "").slice(0, 4000); } for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); o["ss:" + k] = (sessionStorage.getItem(k) || "").slice(0, 4000); } return o; });
ok("w-token-storage-clean", !JSON.stringify(stor).includes(TOKEN), "token in complete storage: " + JSON.stringify(Object.keys(stor)).slice(0, 300));
await page.getByLabel("Edit base URL").fill(WIKI + "/");
await page.getByRole("button", { name: "Save resource" }).click();
await sleep(1500);
const tokVal = await page.getByLabel("Wiki token").inputValue().catch(() => "missing");
ok("w-token-cleared", tokVal === "", "create token retained: len=" + String(tokVal).length);
// Failure refreshes the EXACT resource row: succeeded -> failed with the safe error and zero usable count.
const rowBefore = await row.textContent().catch(() => "");
ok("w-fail-row-before", (rowBefore || "").includes("succeeded"), "row was not succeeded before failure: " + (rowBefore || "").slice(0, 200));
await fetch(WIKI + "/__control?mode=http500");
await row.getByRole("button", { name: "Sync " + NEW_RID }).click();
await row.getByText("failed", { exact: false }).first().waitFor({ timeout: 20000 });
const rowFail = await row.textContent().catch(() => "");
ok("w-failure-row", (rowFail || "").includes("sync:failed"), "row did not transition to failed: " + (rowFail || "").slice(0, 300));
ok("w-failure-usable-zero", (rowFail || "").includes("0 usable pages"), "usable count not zeroed on failure: " + (rowFail || "").slice(0, 300));
ok("w-failure-safe-error", (rowFail || "").toLowerCase().includes("connector") && !(rowFail || "").includes(TOKEN), "error text unsafe or missing: " + (rowFail || "").slice(0, 300));
await fetch(WIKI + "/__control?mode=normal");
await row.getByRole("button", { name: "Sync " + NEW_RID }).click();
await row.getByText("succeeded", { exact: false }).first().waitFor({ timeout: 30000 });
ok("w-failure-recover-row", true);
// Cross-board barrier: an obsolete in-flight sync must not displace another board's view.
const b2 = await api("POST", "/api/boards", { name: "wiki-cross-board" });
const B2 = b2.json.id || b2.json.Id;
await api("POST", "/api/boards/" + B2 + "/meetings", { title: "xb-m1" });
const xR = await api("POST", "/api/boards/" + B2 + "/wiki-resources", { baseUrl: WIKI + "/", description: "cross-b", allowedUse: "cross", scope: "board", allowlist: ["/guides/**"], manualOnly: true, token: TOKEN });
const XB = xR.json.id || xR.json.Id;
await api("POST", "/api/wiki-resources/" + XB + "/enable", {});
await fetch(WIKI + "/__control?mode=normal&singleDelayMs=2000");
const syncAP = row.getByRole("button", { name: "Sync " + NEW_RID }).click().catch(() => {});
await sleep(300);
await page.goto(WEB + "/#/sources?board=" + B2, { waitUntil: "networkidle", timeout: 60000 });
await page.getByText("Wiki.js 2.x connector", { exact: false }).first().waitFor({ timeout: 30000 });
await sleep(3000);
const b2dom = await page.content();
ok("w-cross-b-intact", b2dom.includes("cross-b"), "B board lost its resource");
ok("w-cross-no-leak", !b2dom.includes("browser-created"), "stale A response displaced B board view");
await fetch(WIKI + "/__control?mode=normal&singleDelayMs=0");
await page.goto(WEB + "/#/sources?board=" + BID, { waitUntil: "networkidle", timeout: 60000 });
await page.getByText("Wiki.js 2.x connector", { exact: false }).first().waitFor({ timeout: 30000 });
let aDone = false;
for (let i = 0; i < 15 && !aDone; i++) {
  const aa = await api("GET", "/api/wiki-resources/" + NEW_RID);
  aDone = !!aa.json && aa.json.status === "succeeded";
  if (!aDone) await sleep(1000);
}
ok("w-cross-a-consistent", aDone, "A never became consistent");
const aDom = await page.content();
await page.getByText("browser-created", { exact: false }).first().waitFor({ timeout: 15000 });
ok("w-cross-a-intact", aDom.includes("browser-created"), "A board lost its resource");
await api("DELETE", "/api/wiki-resources/" + XB, {});
// Mobile + dark theme: verified theme state, controls, and layout metrics.
const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
const mp = await mctx.newPage();
await mp.goto(WEB + "/#/profile?board=" + BID, { waitUntil: "networkidle", timeout: 60000 });
await mp.getByRole("button", { name: "Switch to dark" }).click({ timeout: 15000 });
const mTheme = await mp.evaluate(() => document.documentElement.dataset.theme);
await mp.goto(WEB + "/#/sources?board=" + BID, { waitUntil: "networkidle", timeout: 60000 });
await mp.getByText("Wiki.js 2.x connector", { exact: false }).first().waitFor({ timeout: 30000 });
ok("w-mobile-dark-theme", mTheme === "dark", "theme=" + mTheme);
const mHeadVisible = await mp.getByText("Wiki.js 2.x connector", { exact: false }).first().isVisible().catch(() => false);
ok("w-mobile-controls", mHeadVisible, "connector heading not visible at 390px");
const mOverflow = await mp.evaluate(() => ({ sw: document.scrollingElement ? document.scrollingElement.scrollWidth : 0, iw: window.innerWidth }));
ok("w-mobile-layout", mOverflow.sw <= mOverflow.iw + 1, "horizontal overflow at 390px: " + JSON.stringify(mOverflow));
await mp.screenshot({ path: PNGDIR + "/wiki-mobile-dark.png", fullPage: true });
await browser.close();
console.log("BROWSER-QA pass=" + pass + " fail=" + fail);
fs.appendFileSync(OUT, "BROWSER-QA pass=" + pass + " fail=" + fail + "\n");
if (failures.length) fs.appendFileSync(OUT, "FAILURES:\n" + failures.join("\n") + "\n");
process.exit(fail ? 1 : 0);


