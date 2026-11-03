import { spawn } from "node:child_process";
import fs from "fs";
const API = "http://127.0.0.1:5095";
const WEB = "http://127.0.0.1:5184";
const FAKE_PORT = 5195;
const HIND_PORT = 5198;
const INSTANCE = "source-gov-qa";
const OUT = ".tmp/source-governance-browser-result.txt";
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
// seed via API
const out0 = fs.openSync(".tmp/sg-b-api.log", "w");
const api = spawn("dotnet", ["server/SimCEO.Api/bin/Debug/net10.0/SimCEO.Api.dll"], { env: { ...process.env, META_API_KEY: "dummy", META_API_BASE: "http://127.0.0.1:" + FAKE_PORT, HINDSIGHT_URL: "", SIMCEO_INSTANCE: INSTANCE, ASPNETCORE_URLS: API }, stdio: ["ignore", out0, out0] });
let fake = startProc("node", ["qa/fake-provider.mjs", "--port", String(FAKE_PORT)], {}, "qa", ".tmp/sg-b-fake.log");
ok("b-api-up", await waitHealth(30000));
{
  const h = await (await fetch(API + "/health")).json();
  ok("b-api-identity", (h.instance || h.Instance) === INSTANCE, JSON.stringify(h));
}
let r = await fetch(API + "/api/boards", { method: "POST", headers: { "content-type": "application/json", "x-user": "owner" }, body: JSON.stringify({ name: "browser-proof-" + Date.now() }) });
const bid = (await r.json()).id;
let m = await fetch(API + "/api/boards/" + bid + "/meetings", { method: "POST", headers: { "content-type": "application/json", "x-user": "owner" }, body: JSON.stringify({ title: "b-m1" }) });
const mid = (await m.json()).id;
const fd = new FormData();
fd.append("file", new Blob(["# Browser proof\n\nProof evidence body for UI screenshot.\n"], { type: "text/plain" }), "proof.txt");
fd.append("scope", "board");
let up1 = await fetch(API + "/api/boards/" + bid + "/sources/upload", { method: "POST", headers: { "x-user": "owner" }, body: fd });
const s1 = await up1.json();
await fetch(API + "/api/sources/" + (s1.id || s1.Id) + "/approve", { method: "POST", headers: { "x-user": "owner", "content-type": "application/json" }, body: "{}" });
// isolated web on 5184 (strict proxy to 5095 only)
const web = startProc("node", ["node_modules/vite/bin/vite.js", "--config", "vite.sourceqa.config.ts"], {}, "web", ".tmp/sg-b-web.log");
const be = await waitWeb(60000);
ok("b-web-proxy-identity", !!be && (be.mode || be.Mode) === "memory", JSON.stringify(be));
const browser = await chromium.launch({ executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => { window.__srcActAs = "owner"; });
const page = await ctx.newPage();
let uploadPosts = 0, hit5080 = false;
page.on("request", (q) => {
  const u = q.url();
  if (u.includes(":5080")) hit5080 = true;
  if (q.method() === "POST" && /\/api\/boards\/.*\/sources\/upload/.test(u)) uploadPosts++;
});
await page.goto(WEB + "/#/sources?board=" + bid, { waitUntil: "networkidle" });
await page.screenshot({ path: ".tmp/source-governance-boards.png" });
await page.getByText("Resources and Inbox").first().waitFor({ timeout: 20000 });
const bodyText = await page.content();
ok("b-resources", bodyText.includes("Resources and Inbox"));
ok("b-policy", bodyText.includes("Source policy") && bodyText.includes("Wiki-only"));
ok("b-proof-file", bodyText.includes("proof.txt"), "proof file not rendered");
ok("b-no-5080", !hit5080, "page contacted real-user :5080");
await page.screenshot({ path: ".tmp/source-governance-sources.png", fullPage: true });
// real UI upload: exactly ONE POST, success notice, file rendered, no 409 alert
const uniq = "ui-upload-body-" + Date.now();
fs.writeFileSync(".tmp/ui-upload.txt", uniq + "\nsecond line\n");
fs.writeFileSync(".tmp/ui-upload2.txt", uniq + "-second-file\nsecond line\n");
fs.writeFileSync(".tmp/ui-upload3.txt", uniq + "-third-file\nsecond line\n");
await page.locator('input[type="file"]').first().setInputFiles(".tmp/ui-upload.txt");
await page.getByText("Uploaded as pending", { exact: false }).first().waitFor({ timeout: 20000 }).catch(() => {});
await sleep(1500);
const afterUpload = await page.content();
ok("b-upload-one-post", uploadPosts === 1, "upload POSTs=" + uploadPosts);
ok("b-upload-notice", afterUpload.includes("Uploaded as pending"), "no success notice");
ok("b-upload-no-409", !afterUpload.includes("Request failed: 409") && !/Request failed:.*409/.test(afterUpload), "spurious 409 shown");
ok("b-upload-rendered", afterUpload.includes("ui-upload.txt"), "uploaded file not listed");
// meeting scope without a meeting: blocked client-side, zero additional POSTs
const postsBefore = uploadPosts;
await page.getByLabel("Upload scope").selectOption("meeting");
await page.locator('input[type="file"]').first().setInputFiles(".tmp/ui-upload2.txt");
await sleep(1500);
const afterScope = await page.content();
ok("b-scope-needs-meeting", afterScope.includes("Pick a meeting for meeting scope"), "no client-side meeting requirement");
ok("b-scope-no-post", uploadPosts === postsBefore, "upload POSTs=" + uploadPosts + " before=" + postsBefore);
// meeting scope WITH the seeded meeting: one more POST, file rendered
await page.getByLabel("Upload meeting").selectOption(mid);
await page.locator('input[type="file"]').first().setInputFiles(".tmp/ui-upload3.txt");
await page.getByText("Uploaded as pending", { exact: false }).first().waitFor({ timeout: 20000 }).catch(() => {});
await sleep(1500);
const afterMeet = await page.content();
ok("b-meeting-upload-one-post", uploadPosts === postsBefore + 1, "upload POSTs=" + uploadPosts);
// scope-move controls present
ok("b-move-controls", afterMeet.includes("Move to board") && afterMeet.includes("Move to meeting") && afterMeet.includes("Target meeting for scope moves"));
const states = { bid, mid, uploadPosts, hit5080 };
fs.writeFileSync(".tmp/source-governance-browser.json", JSON.stringify(states, null, 2));
await browser.close();
fs.appendFileSync(OUT, "DONE pass=" + pass + " fail=" + fail + " failures=" + JSON.stringify(failures) + "\n");
await stopProc(web, "web"); await stopProc(api, "api"); await stopProc(fake, "fake");
setTimeout(() => process.exit(fail === 0 ? 0 : 1), 500);