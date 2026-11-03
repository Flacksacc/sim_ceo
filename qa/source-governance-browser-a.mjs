import { spawn } from "node:child_process";
import fs from "fs";
const API = "http://127.0.0.1:5095";
const WEB = "http://127.0.0.1:5184";
const FAKE_PORT = 5195;
const HIND_PORT = 5198;
const INSTANCE = "source-gov-qa";
const OUT = ".tmp/source-governance-browser-a-result.txt";
fs.mkdirSync(".tmp", { recursive: true });
fs.writeFileSync(OUT, "START browser " + new Date().toISOString() + "\n");
let pass = 0, fail = 0; const failures = [];
function ok(n, c, e) { if (c) { pass++; fs.appendFileSync(OUT, "PASS " + n + "\n"); } else { fail++; failures.push(n + (e ? " :: " + e : "")); fs.appendFileSync(OUT, "FAIL " + n + (e ? " :: " + e : "") + "\n"); console.log("FAIL " + n + (e ? " :: " + e : "")); } }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitHealth(t) { const t0 = Date.now(); while (Date.now() - t0 < t) { try { const r = await fetch(API + "/health", { signal: AbortSignal.timeout(3000) }); if (r.ok) return true; } catch { } await sleep(500); } return false; }
async function waitWeb(t) { const t0 = Date.now(); while (Date.now() - t0 < t) { try { const r = await fetch(WEB + "/api/backend", { signal: AbortSignal.timeout(3000) }); if (r.ok) return await r.json(); } catch { } await sleep(500); } return null; }
function startProc(cmd, args, env, cwd, log) { const out = fs.openSync(log, "w"); return spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", out, out] }); }
async function stopProc(p, label) { if (!p) return true; try { p.kill(); } catch { } const t0 = Date.now(); while (Date.now() - t0 < 8000) { if (p.exitCode !== null || p.signalCode !== null) return true; await sleep(250); } ok("proc-stop-" + label, false, "owned process did not exit"); return false; }
const { chromium } = await import("playwright-core");

// fixed launcher: with cwd "qa", the entry is fake-provider.mjs (the old
// "qa/fake-provider.mjs" resolved to qa/qa/fake-provider.mjs -> MODULE_NOT_FOUND)
{
  let busy = false;
  try {
    const r = await fetch(API + "/health", { signal: AbortSignal.timeout(3000) });
    busy = r.ok;
  } catch {}
  ok("preflight-ports-free", !busy, API + " already answers; refusing to hijack a foreign instance");
  if (busy) process.exit(1);
}
// seed via API (spawned ONLY after the foreign-instance preflight below)
const out0 = fs.openSync(".tmp/sg-b-api.log", "w");
const api = spawn("dotnet", ["server/SimCEO.Api/bin/Debug/net10.0/SimCEO.Api.dll", "--urls", API], { env: { ...process.env, META_API_KEY: "dummy", META_API_BASE: "http://127.0.0.1:" + FAKE_PORT, HINDSIGHT_URL: "", SIMCEO_INSTANCE: INSTANCE, ASPNETCORE_URLS: API }, stdio: ["ignore", out0, out0] });
let fake = startProc("node", ["fake-provider.mjs", "--port", String(FAKE_PORT)], {}, "qa", ".tmp/sg-b-fake.log");
const apiUp = await waitHealth(30000);
ok("b-api-up", apiUp);
if (!apiUp) {
  fs.appendFileSync(OUT, "ABORT no api");
  fs.appendFileSync(OUT, "DONE pass=" + pass + " fail=" + fail + " failures=" + JSON.stringify(failures));
  try { fake.kill(); } catch {}
  await stopProc(api, "api");
  setTimeout(() => process.exit(1), 500);
  await new Promise(() => {});
}
{
  const h = await (await fetch(API + "/health")).json();
  ok("b-api-identity", (h.instance || h.Instance) === INSTANCE, JSON.stringify(h));
}
async function apiJson(method, path, body, user) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await fetch(API + path, { method, signal: ctl.signal, headers: { "content-type": "application/json", "x-user": user || "owner" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { }
      return { status: r.status, json, text };
    } finally { clearTimeout(t); }
  } catch (e) { return { status: 0, json: null, text: "qa-transport-failure: " + String(e && e.message || e) }; }
}
let r = await fetch(API + "/api/boards", { method: "POST", headers: { "content-type": "application/json", "x-user": "owner" }, body: JSON.stringify({ name: "browser-proof-" + Date.now() }) });
const bid = (await r.json()).id;
let m = await fetch(API + "/api/boards/" + bid + "/meetings", { method: "POST", headers: { "content-type": "application/json", "x-user": "owner" }, body: JSON.stringify({ title: "b-m1" }) });
const mid = (await m.json()).id;
let m2 = await fetch(API + "/api/boards/" + bid + "/meetings", { method: "POST", headers: { "content-type": "application/json", "x-user": "owner" }, body: JSON.stringify({ title: "b-m2" }) });
const mid2 = (await m2.json()).id;
const fd = new FormData();
fd.append("file", new Blob(["# Browser proof\n\nProof evidence body for UI screenshot.\n"], { type: "text/plain" }), "proof.txt");
fd.append("scope", "board");
let up1 = await fetch(API + "/api/boards/" + bid + "/sources/upload", { method: "POST", headers: { "x-user": "owner" }, body: fd });
ok("b-seed-upload-201", up1.status === 201, "status=" + up1.status);
const s1 = await up1.json();
await fetch(API + "/api/sources/" + (s1.id || s1.Id) + "/approve", { method: "POST", headers: { "x-user": "owner", "content-type": "application/json" }, body: "{}" });
// isolated web on 5184 (strict proxy to 5095 only)
const web = startProc("node", ["node_modules/vite/bin/vite.js", "--config", "vite.sourceqa.config.ts"], {}, "web", ".tmp/sg-b-web.log");
const be = await waitWeb(60000);
ok("b-web-proxy-identity", !!be && (be.mode || be.Mode) === "memory", JSON.stringify(be));
const browser = await chromium.launch({ executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
// No QA-only identity substitute anywhere: the removed window.__srcActAs
// global must stay undefined, and default UI requests carry no forged
// X-User header (server resolves the dev-owner default itself).
let uploadPosts = 0, hit5080 = false, sawXUser = false, sawNonOwnerUser = "";
page.on("request", (q) => {
  const u = q.url();
  if (u.includes(":5080")) hit5080 = true;
  if (q.method() === "POST" && /\/api\/boards\/.*\/sources\/upload/.test(u)) {
    uploadPosts++;
    const h = q.headers();
    const xu = h["x-user"] || h["X-User"] || "";
    if (xu) { sawXUser = true; if (String(xu).toLowerCase() !== "owner") sawNonOwnerUser = String(xu); }
  }
});
await page.goto(WEB + "/#/sources?board=" + bid, { waitUntil: "networkidle" });
await page.screenshot({ path: ".tmp/source-governance-boards.png" });
await page.getByText("Resources and Inbox").first().waitFor({ timeout: 20000 });
ok("b-no-global-actas", await page.evaluate("window.__srcActAs") === undefined, "window.__srcActAs substitute present");
const bodyText = await page.content();
ok("b-resources", bodyText.includes("Resources and Inbox"));
ok("b-policy", bodyText.includes("Source policy") && bodyText.includes("Wiki-only"));
ok("b-proof-file", bodyText.includes("proof.txt"), "proof file not rendered");
ok("b-no-5080", !hit5080, "page contacted real-user :5080");
await page.screenshot({ path: ".tmp/source-governance-sources.png", fullPage: true });
// applied identity (finding 10): drafting a name without Apply changes
// nothing on the wire; only Apply identity switches transported X-User.
let reviewUsers = [];
page.on("request", (q) => {
  if (q.method() === "GET" && /\/api\/boards\/.*\/sources\/review/.test(q.url())) {
    const h = q.headers(); reviewUsers.push(h["x-user"] || h["X-User"] || "(default)");
  }
});
{
  await page.getByRole("button", { name: "People" }).first().click();
  await page.getByText("Board-scoped invitations", { exact: false }).first().waitFor({ timeout: 20000 }).catch(() => {});
  const actCount = await page.getByLabel("Act as user").count();
  ok("b-actas-present", actCount >= 1, "count=" + actCount);
  if (actCount >= 1) {
    // Draft only: no Apply yet, so the Sources review must keep arriving
    // with the default identity even after returning to the Sources tab.
    reviewUsers = [];
    await page.getByLabel("Act as user").fill("reader");
    await sleep(1200);
    await page.getByRole("button", { name: "Sources" }).first().click();
    await page.getByText("Resources and Inbox").first().waitFor({ timeout: 20000 });
    await sleep(1200);
    ok("b-draft-not-applied", reviewUsers.length >= 1 && !reviewUsers.includes("reader"), JSON.stringify(reviewUsers));
    await page.screenshot({ path: ".tmp/source-governance-identity-draft.png" });
    // Apply: returning to Sources must now fetch the review as reader.
    await page.getByRole("button", { name: "People" }).first().click();
    await page.getByLabel("Act as user").fill("reader");
    await page.getByRole("button", { name: "Apply identity" }).click();
    reviewUsers = [];
    await page.getByRole("button", { name: "Sources" }).first().click();
    await page.getByText("Resources and Inbox").first().waitFor({ timeout: 20000 });
    await sleep(1200);
    ok("b-applied-identity", reviewUsers.includes("reader"), JSON.stringify(reviewUsers));
    await page.screenshot({ path: ".tmp/source-governance-identity-applied.png" });
    await page.getByRole("button", { name: "People" }).first().click();
    await page.getByLabel("Act as user").fill("owner");
    await page.getByRole("button", { name: "Apply identity" }).click();
    await page.getByRole("button", { name: "Sources" }).first().click();
    await page.getByText("Resources and Inbox").first().waitFor({ timeout: 20000 });
    await sleep(800);
    reviewUsers = [];
  }
}
// real UI upload: exactly ONE POST, success notice, file rendered, no 409 alert
const uniq = "ui-upload-body-" + Date.now();
fs.writeFileSync(".tmp/ui-upload.txt", uniq + "\nsecond line\n");
fs.writeFileSync(".tmp/ui-upload2.txt", uniq + "-second-file\nsecond line\n");
fs.writeFileSync(".tmp/ui-upload3.txt", uniq + "-third-file\nsecond line\n");
await page.locator('input[type="file"]').first().setInputFiles(".tmp/ui-upload.txt");
await page.getByText("Uploaded as pending", { exact: false }).first().waitFor({ timeout: 20000 }).catch(() => {});
await sleep(900);
const afterUpload = await page.content();
ok("b-upload-one-post", uploadPosts === 1, "upload POSTs=" + uploadPosts);
ok("b-upload-no-forged-user", !sawNonOwnerUser, "UI upload carried a forged X-User header: " + sawNonOwnerUser);
ok("b-upload-notice", afterUpload.includes("Uploaded as pending"), "no success notice");
ok("b-upload-no-409", !afterUpload.includes("Request failed: 409") && !/Request failed:.*409/.test(afterUpload), "spurious 409 shown");
ok("b-upload-rendered", afterUpload.includes("ui-upload.txt"), "uploaded file not listed");
// persisted scope/identity of the UI upload (board scope, pending review)
{
  const rev = await apiJson("GET", "/api/boards/" + bid + "/sources/review");
  const row = (rev.json || []).flatMap((g) => (g.versions || g.Versions || [])).find((x) => (x.fileName || x.FileName) === "ui-upload.txt");
  ok("b-upload-persisted-201-scope", !!row && (row.scope || row.Scope) === "board" && (row.reviewState || row.ReviewState) === "pending", JSON.stringify(row).slice(0, 300));
}
// meeting scope without a meeting: blocked client-side, zero additional POSTs
const postsBefore = uploadPosts;
await page.getByLabel("Upload scope").selectOption("meeting");
await page.locator('input[type="file"]').first().setInputFiles(".tmp/ui-upload2.txt");
await sleep(900);
const afterScope = await page.content();
ok("b-scope-needs-meeting", afterScope.includes("Pick a meeting for meeting scope"), "no client-side meeting requirement");
ok("b-scope-no-post", uploadPosts === postsBefore, "upload POSTs=" + uploadPosts + " before=" + postsBefore);
// meeting scope WITH the seeded meeting: one more POST, file rendered,
// persisted meeting scope/identity verified through the API.
await page.getByLabel("Upload meeting").selectOption(mid);
await page.locator('input[type="file"]').first().setInputFiles(".tmp/ui-upload3.txt");
await page.getByText("Uploaded as pending", { exact: false }).first().waitFor({ timeout: 20000 }).catch(() => {});
await sleep(900);
const afterMeet = await page.content();
ok("b-meeting-upload-one-post", uploadPosts === postsBefore + 1, "upload POSTs=" + uploadPosts);
ok("b-meeting-upload-rendered", afterMeet.includes("ui-upload3.txt"), "meeting file not listed");
{
  const rev = await apiJson("GET", "/api/boards/" + bid + "/sources/review");
  const row = (rev.json || []).flatMap((g) => (g.versions || g.Versions || [])).find((x) => (x.fileName || x.FileName) === "ui-upload3.txt");
  ok("b-meeting-persisted-scope", !!row && (row.scope || row.Scope) === "meeting" && String(row.meetingId || row.MeetingId).toLowerCase() === String(mid).toLowerCase(), JSON.stringify(row).slice(0, 400));
}
// same-file resubmission: the input resets after every selection, so picking
// the SAME file again (now with a meeting chosen) fires a change event and
// uploads as a new pending version instead of being swallowed.
{
  const beforeSame = uploadPosts;
  await page.locator('input[type="file"]').first().setInputFiles(".tmp/ui-upload3.txt");
  await sleep(900);
  const afterSame = await page.content();
  ok("b-same-file-resubmits", uploadPosts === beforeSame + 1, "upload POSTs=" + uploadPosts + " before=" + beforeSame);
  ok("b-same-file-dedup-409", /409/.test(afterSame) && /Identical content/.test(afterSame), "no deterministic dedup conflict surfaced");
  const rev = await apiJson("GET", "/api/boards/" + bid + "/sources/review");
  const fam = (rev.json || []).find((x) => ((x.familyKey || x.FamilyKey) || "").includes("ui-upload3.txt") && String(x.scope || x.Scope) === "meeting");
  ok("b-same-file-no-dup-version", !!fam && fam.versions.length === 1, "versions=" + (fam ? fam.versions.length : "none"));
}
// scope-move controls are GONE (immutable family, deny-and-upload): no move
// buttons, no target-meeting select; the immutable-scope hint renders and the
// API denies a scope PATCH with an actionable 409 instead of moving anything.
{
  const pageText = await page.content();
  ok("b-no-move-controls", !pageText.includes("Move to board") && !pageText.includes("Move to meeting") && !pageText.includes("Target meeting for scope moves"), "move controls still rendered");
  ok("b-immutable-hint", pageText.includes("Scope is immutable"), "no deny-and-upload hint");
  const deny = await apiJson("PATCH", "/api/sources/" + (s1.id || s1.Id), { scope: "meeting", meetingId: mid2 });
  ok("b-ui-context-deny-409", deny.status === 409, deny.status + " " + (deny.text || "").slice(0, 200));
  ok("b-ui-context-deny-actionable", (deny.text || "").toLowerCase().includes("upload"), (deny.text || "").slice(0, 200));
  const rev = await apiJson("GET", "/api/boards/" + bid + "/sources/review");
  const rows = (rev.json || []).flatMap((g) => (g.versions || g.Versions || []));
  const kept = rows.find((x) => String(x.id || x.Id).toLowerCase() === String(s1.id || s1.Id).toLowerCase());
  ok("b-ui-context-scope-kept", !!kept && (kept.scope || kept.Scope) === "board", JSON.stringify(kept).slice(0, 300));
  await page.screenshot({ path: ".tmp/source-governance-scope-denied.png", fullPage: true });
}
const statesA = { bid, mid, uploadPosts, hit5080, sawXUser };
fs.writeFileSync(".tmp/source-governance-browser-a.json", JSON.stringify(statesA, null, 2));
await browser.close();
fs.appendFileSync(OUT, "DONE pass=" + pass + " fail=" + fail + " failures=" + JSON.stringify(failures) + "\n");
await stopProc(web, "web"); await stopProc(api, "api"); await stopProc(fake, "fake");
setTimeout(() => process.exit(fail === 0 ? 0 : 1), 500);
