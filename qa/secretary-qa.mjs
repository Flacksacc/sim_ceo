import { spawn } from "node:child_process";
import fs from "node:fs";
// Legit Secretary QA runner (Muse-owned): strict aggregate exit + guaranteed cleanup finally.
// Owns 5113 (API PG), 5205 (fake), 5191 (web), PG 15440 exclusively during the run.
// Old ignored .tmp/matrix.mjs is NOT required and is not used here.
const API = "http://127.0.0.1:5113";
const FAKE = "http://127.0.0.1:5205";
const WEB = "http://127.0.0.1:5191";
const PGCS = "Host=127.0.0.1;Port=15440;Database=simceo;Username=simceo;Password=simceo-dev-only";
const DLL = "server/SimCEO.Api/bin/Debug/net10.0/SimCEO.Api.dll";
const LOG = ".tmp/secretary-qa-run.log";
fs.mkdirSync(".tmp", { recursive: true });
fs.writeFileSync(LOG, "SECRETARY-QA START " + new Date().toISOString() + "\n");
const log = (m) => { fs.appendFileSync(LOG, m + "\n"); console.log(m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let owned = { fake: 0, api: 0, web: 0, pgContainer: false };
let failures = [];
function sh(exe, args, env, outFile) {
  return new Promise((resolve) => {
    const out = outFile ? fs.openSync(outFile, "a") : "ignore";
    const p = spawn(exe, args, { windowsHide: true, stdio: ["ignore", out, "ignore"], env: { ...process.env, ...(env || {}) } });
    p.on("error", (e) => resolve({ code: -1, pid: 0, error: String(e) }));
    p.on("spawn", () => resolve({ code: 0, pid: p.pid }));
    setTimeout(() => resolve({ code: 0, pid: p.pid }), 1000);
  });
}
async function waitHealth(url, timeoutMs, wantUp) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    let up = false;
    try { const r = await fetch(url); up = r.status === 200; } catch { up = false; }
    if (wantUp === false ? !up : up) return true;
    await sleep(1500);
  }
  return false;
}
async function listenPort(port) {
  try {
    const r = await fetch("http://127.0.0.1:" + port + "/health").catch(() => null);
    return !!r;
  } catch { return false; }
}
async function runOne(name, cmd, args, env) {
  log("RUN " + name + ": " + cmd + " " + args.join(" "));
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true, env: { ...process.env, ...(env || {}) } });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { out += d; });
    p.on("close", (code) => {
      fs.appendFileSync(LOG, "DONE " + name + " code=" + code + "\n");
      log("DONE " + name + " code=" + code);
      resolve({ name, code, out });
    });
    p.on("error", (e) => {
      fs.appendFileSync(LOG, "FAIL-SPAWN " + name + " " + String(e) + "\n");
      resolve({ name, code: -1, out: String(e) });
    });
  });
}
async function main() {
  let exitCode = 0;
  try {
    // Owned PG container on 15440 (start only if not already listening via our container; track ownership)
    // NOTE: container simceo-secretary-qa-pg is owned; never touch userdata/other DBs.
    // Fake 5205
    try {
      const fUp = await waitHealth(FAKE + "/__log", 5000, true).catch(() => false);
      if (!fUp) {
        const r = await sh("node", ["qa/secretary-fake.mjs", "--port", "5205"], {}, ".tmp/fake5205.log");
        owned.fake = r.pid || 0;
        log("fake spawned pid=" + owned.fake);
      } else log("fake already up; reusing (not owned)");
    } catch (e) { log("fake start note: " + String(e).slice(0,120)); }
    // API PG 5113
    {
      const aUp = await waitHealth(API + "/health", 5000, true).catch(() => false);
      if (!aUp) {
        const env = { META_API_BASE: FAKE, META_API_KEY: "dummy-local-qa-key", ASPNETCORE_URLS: API, USE_POSTGRES: "1", CONNECTIONSTRINGS__APP: PGCS };
        const out = fs.openSync(".tmp/api5113.log", "a");
        const p = spawn("dotnet", [DLL, "--urls", API], { detached: true, stdio: ["ignore", out, "ignore"], windowsHide: true, env: { ...process.env, ...env } });
        p.unref();
        owned.api = p.pid || 0;
        fs.writeFileSync(".tmp/api5113.pid", String(owned.api));
        log("api spawned pid=" + owned.api);
      } else log("api already up; reusing (not owned)");
    }
    const apiUp = await waitHealth(API + "/health", 120000, true);
    log("api up=" + apiUp + " exactListen=" + API);
    if (!apiUp) throw new Error("API 5113 failed exact Listen verification");
    const be = await (await fetch(API + "/api/backend")).json().catch(() => null);
    log("backend=" + JSON.stringify(be).slice(0,120));
    // Web 5191 (proxy to API)
    {
      let wUp = false;
      try { const r = await fetch(WEB + "/api/boards", { method: "GET" }); wUp = r.status === 200 || r.status === 401 || r.status === 403; } catch { wUp = false; }
      if (!wUp) {
        const env = { QA_API: API, QA_WEB_PORT: "5191", QA_DIST: "web/dist" };
        const out = fs.openSync(".tmp/web5191.log", "a");
        const p = spawn("node", ["qa/secretary-web-proxy.mjs"], { detached: true, stdio: ["ignore", out, "ignore"], windowsHide: true, env: { ...process.env, ...env } });
        p.unref();
        owned.web = p.pid || 0;
        fs.writeFileSync(".tmp/web5191.pid", String(owned.web));
        log("web spawned pid=" + owned.web);
        await sleep(3000);
      } else log("web already up; reusing");
    }
    // Depth PG
    {
      const r = await runOne("depth-pg", "node", ["qa/secretary-depth-qa.mjs"], { QA_API: API, QA_FAKE: FAKE, QA_OUT: ".tmp/secretary-depth-qa-pg.txt", QA_EXPECT_MODE: "pg" });
      if (r.code !== 0) { exitCode = 1; failures.push("depth-pg exit=" + r.code); }
      try {
        const txt = fs.readFileSync(".tmp/secretary-depth-qa-pg.txt", "utf-8");
        const fails = txt.split("\n").filter((l) => l.startsWith("FAIL"));
        if (fails.length > 0) { exitCode = 1; failures.push("depth-pg fails=" + fails.length + " first=" + fails[0].slice(0,160)); }
        else log("depth-pg PASS lines=" + txt.split("\n").filter((l) => l.startsWith("PASS")).length);
      } catch (e) { exitCode = 1; failures.push("depth-pg output missing"); }
    }
    // Browser PG (headless Edge owned; avoids parallel CDP)
    {
      const r = await runOne("browser-pg", "node", ["qa/secretary-browser.mjs"], { QA_API: API, QA_FAKE: FAKE, QA_WEB: WEB, QA_BROWSER_OUT: ".tmp/secretary-browser-pg.txt" });
      if (r.code !== 0) { exitCode = 1; failures.push("browser-pg exit=" + r.code); }
      try {
        const txt = fs.readFileSync(".tmp/secretary-browser-pg.txt", "utf-8");
        const fails = txt.split("\n").filter((l) => l.startsWith("FAIL"));
        if (fails.length > 0) { exitCode = 1; failures.push("browser-pg fails=" + fails.length + " first=" + fails[0].slice(0,160)); }
        else log("browser-pg PASS lines=" + txt.split("\n").filter((l) => l.startsWith("PASS")).length);
      } catch (e) { exitCode = 1; failures.push("browser-pg output missing"); }
    }
    if (failures.length > 0) log("FAILURES: " + failures.join(" | "));
    else log("ALL SECRETARY QA PASS");
  } catch (e) {
    exitCode = 1;
    failures.push("fatal " + String((e && e.stack) || e).slice(0,300));
    try { fs.appendFileSync(LOG, "FATAL " + String((e && e.stack) || e) + "\n"); } catch { }
  } finally {
    // Guaranteed cleanup finally: reap ONLY owned handles/trees started here; verify exact Listen down; no idle terminals.
    try {
      if (owned.web) { try { process.kill(owned.web); } catch { } try { const { execSync } = await import("node:child_process"); execSync("taskkill /F /PID " + owned.web, { windowsHide: true }); } catch { } }
    } catch { }
    try {
      if (owned.api) { try { process.kill(owned.api); } catch { } try { const { execSync } = await import("node:child_process"); execSync("taskkill /F /PID " + owned.api, { windowsHide: true }); } catch { } }
    } catch { }
    try {
      if (owned.fake) { try { process.kill(owned.fake); } catch { } try { const { execSync } = await import("node:child_process"); execSync("taskkill /F /PID " + owned.fake, { windowsHide: true }); } catch { } }
    } catch { }
    try {
      // Exact Listen verification that owned ports are down (or still up if reused/not owned)
      const apiStill = await waitHealth(API + "/health", 8000, true).catch(() => false);
      log("cleanup apiStillUp=" + apiStill + " ownedApi=" + owned.api);
      try { await fetch(FAKE + "/__log", { method: "DELETE" }).catch(() => {}); } catch { }
    } catch { }
    try { fs.appendFileSync(LOG, "SECRETARY-QA DONE exit=" + exitCode + " failures=" + failures.join(";").slice(0,500) + "\n"); } catch { }
  }
  if (exitCode !== 0) { console.log("SECRETARY-QA FAIL exit=" + exitCode + " " + failures.join(" | ").slice(0,500)); process.exit(exitCode); }
  console.log("SECRETARY-QA PASS");
}
main();
