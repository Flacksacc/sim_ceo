import { execSync } from "node:child_process";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

// Mounted client QA for Sources + Wiki human UI. Builds an ephemeral static
// fixture (no app backend, no real services), serves it on loopback only,
// and drives it with headless Edge. Every external origin is blocked
// fail-closed; all API traffic is answered by in-page fixture transports.
//
// Lifecycle: one overall deadline covers build + launch + all interactions +
// route cleanup; a complete try/finally from startup guarantees bounded
// close (route cleanup, browser close, awaited server close with
// listener-closed proof) with failure exit. No global kills, no external
// services, no .env.
const STARTED = Date.now();
const OVERALL_MS = 240000;
const DEADLINE = STARTED + OVERALL_MS;
function msLeft() { return DEADLINE - Date.now(); }
function capTimeout(want) {
  const left = msLeft();
  if (left <= 0) throw new Error("overall QA deadline (" + OVERALL_MS + "ms) exceeded");
  return Math.min(want, Math.max(1, left));
}
function withBound(promise, ms, label) {
  let t = null;
  const guard = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error("bounded " + label + " timed out after " + ms + "ms")), ms);
    if (t.unref) t.unref();
  });
  return Promise.race([promise, guard]).finally(() => { if (t) clearTimeout(t); });
}

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const web = path.join(root, "web");
const dist = path.join(root, ".tmp", "human-mount-dist");

let server = null;
let browser = null;
let page = null;
let port = 0;
let blocked = 0;
let exitCode = 0;

try {
  execSync("npx vite build --config vite.humanmount.config.ts", {
    cwd: web,
    stdio: "inherit",
    timeout: capTimeout(120000),
  });

  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };
  server = http.createServer((req, res) => {
    if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
    let p = "/";
    try { p = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname); } catch { res.writeHead(400); res.end(); return; }
    if (p === "/") p = "/human-mount.html";
    const file = path.join(dist, p.replace(/^\/+/, ""));
    if (!file.startsWith(dist)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
      res.end(data);
    });
  });
  await withBound(new Promise((r) => server.listen(0, "127.0.0.1", r)), capTimeout(15000), "server listen");
  port = server.address().port;

  const edge = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
  if (!fs.existsSync(edge)) throw new Error("headless Edge not found at " + edge);
  browser = await chromium.launch({ executablePath: edge, headless: true, args: ["--no-sandbox"] });
  page = await browser.newPage();
  await page.route("**", (route) => {
    let u;
    try { u = new URL(route.request().url()); } catch { blocked++; return route.abort(); }
    if (u.protocol === "http:" && u.hostname === "127.0.0.1" && Number(u.port) === port) return route.continue();
    blocked++;
    return route.abort();
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e && e.message ? e.message : e)));

  let passed = 0;
  function check(name, cond, extra) {
    if (!cond) throw new Error("FAIL " + name + (extra ? " :: " + extra : ""));
    passed++;
    console.log("ok - " + name);
  }
  const bodyText = () => page.locator("body").innerText();

  await page.goto("http://127.0.0.1:" + port + "/human-mount.html", { timeout: capTimeout(30000) });
  await page.getByText("Usable now: version 2.").waitFor({ timeout: capTimeout(15000) });
  check("mount: promoted head distinct from usable current", (await bodyText()).indexOf("Promoted: version 2.") >= 0);
  check("mount: hidden group keeps promoted slot", (await bodyText()).indexOf("No usable version") >= 0 && (await bodyText()).indexOf("Promoted: version 1.") >= 0);
  check("mount: approval and visibility both shown", (await bodyText()).indexOf("Waiting for review") >= 0 && (await bodyText()).indexOf("Temporarily hidden") >= 0);  // Expanded states: History and Sections effects run on click and render.
  await page.getByRole("button", { name: "Show history for Evidence.txt version 3 (1 of 3)" }).click({ timeout: capTimeout(15000) });
  await page.getByText("Version history (1)").waitFor({ timeout: capTimeout(15000) });
  check("mount: history effect renders", (await bodyText()).indexOf("Uploaded - version 3. Board file.") >= 0);
  await page.getByRole("button", { name: "Show history for Evidence.txt version 2 (2 of 3)" }).click({ timeout: capTimeout(15000) });
  await page.getByText("Search repaired - version 2. Search index repaired.").waitFor({ timeout: capTimeout(15000) });
  check("mount: history repair row human", (await bodyText()).indexOf("rev2") < 0);
  await page.getByRole("button", { name: "Show history for Evidence.txt version 1 (3 of 3)" }).click({ timeout: capTimeout(15000) });
  await page.getByText("Wiki pages added - version 1. Evidence.txt synced.").waitFor({ timeout: capTimeout(15000) });
  check("mount: history import row human", true);
  await page.getByRole("button", { name: "Show sections for Evidence.txt version 2 (2 of 3)" }).click({ timeout: capTimeout(15000) });
  await page.getByText("Saved sections (1)").waitFor({ timeout: capTimeout(15000) });
  check("mount: sections effect renders", (await bodyText()).indexOf("Solar arrays passed inspection.") >= 0);

  // Recall: client mount runs the transport effect; server record prefix is cleaned.
  await page.getByLabel("Recall query").fill("hiring plan", { timeout: capTimeout(15000) });
  await page.getByRole("button", { name: "Recall" }).click({ timeout: capTimeout(15000) });
  await page.getByText("Approve the hiring plan.").waitFor({ timeout: capTimeout(15000) });
  check("mount: recall server prefix stripped", (await bodyText()).indexOf("record v3") < 0 && (await bodyText()).indexOf("Evidence.txt v2") >= 0);
  // Permissions: read-only hides management controls without touching data.
  await page.getByLabel("Toggle read-only test").click({ timeout: capTimeout(15000) });
  await page.waitForTimeout(Math.min(200, capTimeout(15000)));
  check("mount: read-only hides approve", (await page.getByRole("button", { name: /Approve Evidence/ }).count()) === 0);
  check("mount: read-only hides upload", (await page.locator("input[type=file]").count()) === 0);
  await page.getByLabel("Toggle read-only test").click({ timeout: capTimeout(15000) });
  await page.getByRole("button", { name: "Approve Evidence.txt version 3 (1 of 3)" }).waitFor({ timeout: capTimeout(15000) });
  check("mount: manage restored", (await page.getByRole("button", { name: /Approve/ }).count()) === 4);
  check("mount: only pending approve enabled", await page.getByRole("button", { name: "Approve Evidence.txt version 3 (1 of 3)" }).isEnabled());

  // Governance actions hit exact transports; retry and reindex stay distinct.
  await page.getByRole("button", { name: "Reindex Evidence.txt version 3 (1 of 3)" }).click({ timeout: capTimeout(15000) });
  await page.waitForFunction(() => window.__mount.calls.some((c) => c.indexOf("POST /api/sources/99999999-2222-3333-4444-555555555555/reindex") >= 0), { timeout: capTimeout(15000) });
  await page.getByRole("button", { name: "Retry extraction for Evidence.txt version 3 (1 of 3)" }).click({ timeout: capTimeout(15000) });
  await page.waitForFunction(() => window.__mount.calls.some((c) => c.indexOf("POST /api/sources/99999999-2222-3333-4444-555555555555/retry") >= 0), { timeout: capTimeout(15000) });
  check("mount: reindex vs retry distinct transports", true);

  // Actionable errors: denied stays an access error, not config troubleshooting.
  await page.evaluate(() => { window.__mount.govActError = "403 {\"error\":\"Access denied for this scope.\"}"; });
  await page.getByRole("button", { name: "Approve Evidence.txt version 3 (1 of 3)" }).click({ timeout: capTimeout(15000) });
  await page.getByText("You do not have access to do that.").waitFor({ timeout: capTimeout(15000) });
  check("mount: denied keeps access copy", true);
  await page.evaluate(() => { window.__mount.govActError = "400 {\"error\":\"Description is required"; });
  await page.getByRole("button", { name: "Approve Evidence.txt version 3 (1 of 3)" }).click({ timeout: capTimeout(15000) });
  await page.getByText("That did not finish. Try again.").waitFor({ timeout: capTimeout(15000) });
  check("mount: truncated backend fails closed", true);
  await page.evaluate(() => { window.__mount.govActError = null; });

  // Recall failure is generic, never a JSON fragment.
  await page.evaluate(() => { window.__mount.govRecallError = "400 {\"error\":\"Description is required"; });
  await page.getByRole("button", { name: "Recall" }).click({ timeout: capTimeout(15000) });
  await page.getByText("That did not finish. Try again.").waitFor({ timeout: capTimeout(15000) });
  check("mount: recall failure generic", true);
  await page.evaluate(() => { window.__mount.govRecallError = null; });

  // Downloads keep the identity-guarded transport path.
  await page.getByRole("button", { name: "Download original of Evidence.txt version 2 (2 of 3)" }).click({ timeout: capTimeout(15000) });
  await page.waitForFunction(() => window.__mount.downloads.length === 1, { timeout: capTimeout(15000) });
  check("mount: download transport kept", (await page.evaluate(() => window.__mount.downloads[0])).indexOf("/api/sources/33333333-2222-3333-4444-555555555555/download") >= 0);  // Uploads: board scope, then meeting scope with an explicit meeting (never widened).
  await page.setInputFiles("input[type=file]", { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await page.getByText("Uploaded as pending").waitFor({ timeout: capTimeout(15000) });
  check("mount: upload effect runs", true);
  await page.getByLabel("Upload scope").selectOption("meeting");
  await page.getByLabel("Upload meeting").selectOption("11111111-2222-3333-4444-555555555555");
  await page.setInputFiles("input[type=file]", { name: "mnotes.txt", mimeType: "text/plain", buffer: Buffer.from("hello meeting") });
  await page.waitForFunction(() => window.__mount.uploads.length >= 2, { timeout: capTimeout(15000) });
  const lastUp = await page.evaluate(() => window.__mount.uploads[window.__mount.uploads.length - 1]);
  check("mount: meeting upload pins meeting", lastUp.scope === "meeting" && lastUp.meetingId === "11111111-2222-3333-4444-555555555555");

  // Wiki connector: errors preserve sync/config differences; textareas stay usable.
  const taDesc = page.locator("textarea[aria-label=\"Wiki description\"]");
  check("mount: textarea rows kept", (await taDesc.getAttribute("rows")) === "3" && (await page.locator("textarea[aria-label=\"Wiki allowed use\"]").getAttribute("rows")) === "4");
  check("mount: token stays password", (await page.locator("input[aria-label=\"Wiki token\"]").getAttribute("type")) === "password");
  check("mount: no protocol internals", (await bodyText()).indexOf("pages.list") < 0 && (await bodyText()).indexOf("POST /graphql") < 0);
  await page.evaluate(() => { window.__mount.wikiOpError = "403 {\"error\":\"Access denied for this scope.\"}"; });
  await page.getByRole("button", { name: "Enable connector Team handbook (board) - 1 of 1" }).click({ timeout: capTimeout(15000) });
  await page.getByText("You do not have access to do that.").first().waitFor({ timeout: capTimeout(15000) });
  check("mount: connector denied keeps access copy", true);
  await page.evaluate(() => { window.__mount.wikiOpError = "{\"error\":\"Resource is disabled; enable it first.\"}"; });
  await page.getByRole("button", { name: "Sync connector now Team handbook (board) - 1 of 1" }).click({ timeout: capTimeout(15000) });
  await page.getByText("This connector is disabled - enable it first, then sync.").waitFor({ timeout: capTimeout(15000) });
  check("mount: disabled keeps enable-first copy", true);
  await page.evaluate(() => { window.__mount.wikiOpError = null; });
  await page.getByRole("button", { name: "Sync connector now Team handbook (board) - 1 of 1" }).click({ timeout: capTimeout(15000) });
  await page.getByText("Manual sync finished").waitFor({ timeout: capTimeout(15000) });
  check("mount: sync success notice", true);
  await page.getByRole("button", { name: "Edit connector Team handbook (board) - 1 of 1" }).click({ timeout: capTimeout(15000) });
  await page.locator("textarea[aria-label=\"Edit description\"]").fill("Updated handbook", { timeout: capTimeout(15000) });
  await page.getByRole("button", { name: "Save resource" }).click({ timeout: capTimeout(15000) });
  await page.waitForFunction(() => window.__mount.calls.some((c) => c.indexOf("PATCH /api/wiki-resources/77777777-2222-3333-4444-555555555555") >= 0), { timeout: capTimeout(15000) });
  check("mount: edit rules patch kept", true);

  // Accessible names are deterministic and carry no IDs.
  const a11y = await page.evaluate(() => Array.from(document.querySelectorAll("[aria-label]")).map((e) => e.getAttribute("aria-label") || ""));
  const guid = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}/;
  check("mount: names unique without IDs", new Set(a11y).size === a11y.length && !a11y.some((n) => guid.test(n)), a11y.filter((n) => guid.test(n)).join(" | ").slice(0, 200));

  check("mount: no page errors", errors.length === 0, errors.slice(0, 3).join(" ;; ").slice(0, 500));
  console.log("source-wiki-human-mounted: PASS (" + passed + " checks, " + blocked + " external blocked)");
} catch (err) {
  exitCode = 1;
  console.error("source-wiki-human-mounted: FAIL :: " + (err && err.message ? err.message : String(err)));
} finally {
  // Bounded cleanup: HTTP route cleanup, browser close, awaited server close
  // with listener-closed proof. Fixed small bounds so cleanup itself cannot hang.
  try {
    if (page) await withBound(page.unrouteAll({ behavior: "wait" }).catch(() => {}), 10000, "route cleanup");
  } catch {}
  try {
    if (browser) await withBound(browser.close(), 15000, "browser close");
  } catch (e) {
    exitCode = 1;
    console.error("cleanup: browser close failed :: " + (e && e.message ? e.message : String(e)));
  }
  try {
    if (server) {
      await withBound(new Promise((resolve, reject) => {
        try { server.close((e) => (e ? reject(e) : resolve())); } catch (e) { reject(e); }
      }), 10000, "server close");
      console.log("cleanup: listener closed=" + (server.listening === false) + " port=" + port + " blocked=" + blocked);
      if (server.listening !== false) { exitCode = 1; console.error("cleanup: listener still open"); }
    } else {
      console.log("cleanup: no server started port=0 blocked=" + blocked);
    }
  } catch (e) {
    exitCode = 1;
    console.error("cleanup: server close failed :: " + (e && e.message ? e.message : String(e)));
  }
  process.exitCode = exitCode;
  if (msLeft() <= 0 && exitCode === 0) { process.exitCode = 1; console.error("cleanup: overall deadline exhausted"); }
}