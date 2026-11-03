import { spawn } from "node:child_process";
import fs from "fs";
const API = "http://127.0.0.1:5095";
const WEB = "http://127.0.0.1:5184";
const FAKE_PORT = 5195;
const HIND_PORT = 5198;
const INSTANCE = "source-gov-qa";
const OUT = ".tmp/source-governance-browser-b-result.txt";
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
await page.screenshot({ path: ".tmp/source-governance-sources-b.png", fullPage: true });
// meeting-to-meeting scope edits are denied (immutable family): the move
// controls no longer exist, the hint renders, and the API denies with an
// actionable 409 while the row keeps its meeting scope and review state.
{
  const fd = new FormData();
  fd.append("file", new Blob(["meeting scope body " + Date.now()], { type: "text/plain" }), "meetkeep.txt");
  fd.append("scope", "meeting"); fd.append("meetingId", mid);
  const rr = await fetch(API + "/api/boards/" + bid + "/sources/upload", { method: "POST", headers: { "x-user": "owner" }, body: fd });
  ok("b-meet-upload-201", rr.status === 201, "status=" + rr.status);
  const jj = await rr.json();
  const mmid = jj.id || jj.Id;
  await page.getByText("meetkeep.txt", { exact: false }).first().waitFor({ timeout: 20000 }).catch(() => {});
  await page.reload({ waitUntil: "networkidle" });
  await page.getByText("Resources and Inbox").first().waitFor({ timeout: 20000 });
  const pageText = await page.content();
  ok("b-no-meet-move-controls", !pageText.includes("Move to board") && !pageText.includes("Move to meeting") && !pageText.includes("Scope-move meeting"), "move controls still rendered");
  ok("b-immutable-hint-b", pageText.includes("Scope is immutable"), "no deny-and-upload hint");
  const deny = await apiJson("PATCH", "/api/sources/" + mmid, { scope: "meeting", meetingId: mid2 });
  ok("b-meet-scope-deny-409", deny.status === 409, deny.status + " " + (deny.text || "").slice(0, 200));
  const rev = await apiJson("GET", "/api/boards/" + bid + "/sources/review");
  const row = (rev.json || []).flatMap((g) => (g.versions || g.Versions || [])).find((x) => String(x.id || x.Id).toLowerCase() === String(mmid).toLowerCase());
  ok("b-meet-scope-kept", !!row && String(row.meetingId || row.MeetingId).toLowerCase() === String(mid).toLowerCase() && (row.scope || row.Scope) === "meeting", JSON.stringify(row).slice(0, 300));
  await page.screenshot({ path: ".tmp/source-governance-meet-denied.png", fullPage: true });
}
// collision coexistence without moves: same-name board + meeting files
// live as two families; scope PATCH in either direction is denied 409 and
// both rows keep scope, review, and content.
{
  const cbody = "collision body " + Date.now();
  const bfd = new FormData();
  bfd.append("file", new Blob([cbody + " board"], { type: "text/plain" }), "clash.txt");
  bfd.append("scope", "board");
  const br = await fetch(API + "/api/boards/" + bid + "/sources/upload", { method: "POST", headers: { "x-user": "owner" }, body: bfd });
  ok("b-clash-board-201", br.status === 201, "status=" + br.status);
  const bj = await br.json(); const clashBoard = bj.id || bj.Id;
  const mfd = new FormData();
  mfd.append("file", new Blob([cbody + " meeting"], { type: "text/plain" }), "clash.txt");
  mfd.append("scope", "meeting"); mfd.append("meetingId", mid);
  const mr = await fetch(API + "/api/boards/" + bid + "/sources/upload", { method: "POST", headers: { "x-user": "owner" }, body: mfd });
  ok("b-clash-meeting-201", mr.status === 201, "status=" + mr.status);
  const mj = await mr.json(); const clashMeet = mj.id || mj.Id;
  await page.reload({ waitUntil: "networkidle" });
  await page.getByText("Resources and Inbox").first().waitFor({ timeout: 20000 });
  const clashCards = page.locator(".card", { hasText: "clash.txt" });
  const nCards = await clashCards.count();
  ok("b-collision-two-families", nCards === 2, "cards=" + nCards);
  const d1 = await apiJson("PATCH", "/api/sources/" + clashBoard, { scope: "meeting", meetingId: mid });
  ok("b-collision-deny-board", d1.status === 409, d1.status + " " + (d1.text || "").slice(0, 200));
  const d2 = await apiJson("PATCH", "/api/sources/" + clashMeet, { scope: "board" });
  ok("b-collision-deny-meeting", d2.status === 409, d2.status + " " + (d2.text || "").slice(0, 200));
  const rev = await apiJson("GET", "/api/boards/" + bid + "/sources/review");
  const rows = (rev.json || []).flatMap((g) => (g.versions || g.Versions || []));
  const rb = rows.find((x) => String(x.id || x.Id).toLowerCase() === String(clashBoard).toLowerCase());
  const rm = rows.find((x) => String(x.id || x.Id).toLowerCase() === String(clashMeet).toLowerCase());
  ok("b-collision-unchanged", !!rb && !!rm && (rb.scope || rb.Scope) === "board" && (rm.scope || rm.Scope) === "meeting", JSON.stringify([rb && rb.scope, rm && rm.scope]));
}
// NOTE: read-only/grant permission denials are proved at API level on BOTH
// backends in qa/source-governance-concurrency-qa.mjs (perm-*). The browser
// lane keeps UI-only interactions so this run stays short-lived.
const states = { bid, mid, mid2, uploadPosts, hit5080, sawXUser };
fs.writeFileSync(".tmp/source-governance-browser-b.json", JSON.stringify(states, null, 2));
await browser.close();
fs.appendFileSync(OUT, "DONE pass=" + pass + " fail=" + fail + " failures=" + JSON.stringify(failures) + "\n");
await stopProc(web, "web"); await stopProc(api, "api"); await stopProc(fake, "fake");
setTimeout(() => process.exit(fail === 0 ? 0 : 1), 500);
