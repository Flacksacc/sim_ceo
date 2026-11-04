import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Owned Voice QA runner: launches ONLY own 5125/5225/5245 (+proxy 5126 in-suite),
// retains hidden handles from first Start, bounded drain in outer finally.
// No PG, no new app services, no user ports. Reuses matching production DLL.
const ROOT = process.cwd();
const LOGDIR = ".tmp/voice-qa";
function log(s) { console.log("[runner] " + s); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitHttp(url, secs, label) {
  const deadline = Date.now() + secs * 1000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (r.status < 500) { log(label + " up " + r.status); return true; }
    } catch {}
    await sleep(500);
  }
  log(label + " NOT up: " + url);
  return false;
}
function startHidden(cmd, args, opts, outFile, errFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const out = fs.openSync(outFile, "w");
  const err = fs.openSync(errFile, "w");
  const p = spawn(cmd, args, { ...opts, stdio: ["ignore", out, err], windowsHide: true, detached: false });
  return { proc: p, out, err, outFile, errFile };
}
async function stopBounded(h, label, ms) {
  if (!h || !h.proc) return { ok: true };
  const p = h.proc;
  if (p.exitCode !== null || p.signalCode !== null) return { ok: true };
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      try { p.kill("SIGKILL"); } catch {}
      setTimeout(() => { try { fs.closeSync(h.out); } catch {} try { fs.closeSync(h.err); } catch {} resolve({ ok: false, why: label + "-kill" }); }, 2000);
    }, ms);
    p.once("exit", () => {
      if (done) return;
      done = true;
      try { clearTimeout(t); } catch {}
      try { fs.closeSync(h.out); } catch {} try { fs.closeSync(h.err); } catch {}
      resolve({ ok: true });
    });
    try { p.kill("SIGTERM"); } catch {}
  });
}
async function runSuite(label, args, logFile) {
  log("suite " + label);
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env } });
    let out = "";
    p.stdout.on("data", (d) => { out += String(d); });
    p.stderr.on("data", (d) => { out += String(d); });
    p.on("close", (code) => {
      try { fs.mkdirSync(LOGDIR, { recursive: true }); fs.writeFileSync(logFile, out); } catch {}
      resolve({ label, code: code ?? 1, out });
    });
  });
}
const suites = (process.argv[2] || "all").split(",");
let fakeH = null, apiH = null, webH = null, edgeH = null;
function findFreePort() {
  return new Promise((resolve, reject) => {
    import("node:net").then(({ createServer }) => {
      const s = createServer();
      s.on("error", reject);
      s.listen(0, "127.0.0.1", () => {
        const a = s.address();
        const port = typeof a === "object" && a ? a.port : 0;
        s.close(() => resolve(port));
      });
    }).catch(reject);
  });
}
async function startOwnEdge() {
  const port = await findFreePort();
  const profile = path.join(ROOT, ".tmp", "voice-qa", "edge-profile-" + process.pid);
  try { fs.mkdirSync(profile, { recursive: true }); } catch {}
  const edgeBin = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
  const args = ["--headless", "--remote-debugging-port=" + port, "--no-first-run", "--no-default-browser-check", "--user-data-dir=" + profile, "about:blank"];
  const outFile = LOGDIR + "/edge.log", errFile = LOGDIR + "/edge.err.log";
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const out = fs.openSync(outFile, "w");
  const err = fs.openSync(errFile, "w");
  const proc = spawn(edgeBin, args, { stdio: ["ignore", out, err], windowsHide: true, detached: false });
  const h = { proc, out, err };
  const url = "http://127.0.0.1:" + port + "/json/version";
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (r.status === 200) {
        const j = await r.json();
        if (j && j.webSocketDebuggerUrl) {
          process.env.QA_CDP = "http://127.0.0.1:" + port;
          log("own-edge up port=" + port + " pid=" + proc.pid + " browser=" + (j.Browser || "").slice(0, 40));
          return h;
        }
      }
    } catch {}
    await sleep(500);
  }
  try { proc.kill("SIGKILL"); } catch {}
  throw new Error("own-edge failed to come up on port " + port);
}
let exitCode = 0;
const results = [];
try {
  edgeH = await startOwnEdge();
  fakeH = startHidden(process.execPath, ["qa/fake-provider.mjs", "--port", "5225"], { cwd: ROOT, env: { ...process.env } }, LOGDIR + "/fake5225.log", LOGDIR + "/fake5225.err.log");
  log("fake start pid=" + fakeH.proc.pid);
  const dll = "server/SimCEO.Api/bin/Debug/net10.0/SimCEO.Api.dll";
  apiH = startHidden("dotnet", ["exec", dll, "--urls", "http://127.0.0.1:5125"], { cwd: ROOT, env: { ...process.env, META_API_BASE: "http://127.0.0.1:5225", META_API_KEY: "qa-dummy-key", ASPNETCORE_ENVIRONMENT: "Production" } }, LOGDIR + "/api5125.log", LOGDIR + "/api5125.err.log");
  log("api start pid=" + apiH.proc.pid + " dll=" + dll);
  webH = startHidden(process.execPath, ["node_modules/vite/bin/vite.js", "--config", "vite.voice5245.config.ts"], { cwd: path.join(ROOT, "web"), env: { ...process.env } }, ROOT + "/" + LOGDIR + "/web5245.log", ROOT + "/" + LOGDIR + "/web5245.err.log");
  log("web start pid=" + webH.proc.pid);
  const okFake = await waitHttp("http://127.0.0.1:5225/__counts", 30, "fake");
  const okApi = await waitHttp("http://127.0.0.1:5125/api/auth/status", 60, "api");
  const okWeb = await waitHttp("http://127.0.0.1:5245/", 90, "web");
  if (!okFake || !okApi || !okWeb) throw new Error("owned services failed to come up");
  const want = (s) => suites.includes("all") || suites.includes(s);
  if (want("http")) results.push(await runSuite("http", ["qa/voice-codec-http.mjs"], LOGDIR + "/http.log"));
  if (want("driver")) results.push(await runSuite("driver", ["qa/voice-account-driver.mjs"], LOGDIR + "/driver.log"));
  if (want("assertcx")) results.push(await runSuite("assertcx", ["qa/voice-assertion-counterexamples.mjs"], LOGDIR + "/assertcx.log"));
  if (want("fakecx")) results.push(await runSuite("fakecx", ["qa/voice-fake-counterexamples.mjs"], LOGDIR + "/fakecx.log"));
  if (want("deadline")) results.push(await runSuite("deadline", ["qa/voice-converter-deadline.mjs"], LOGDIR + "/deadline.log"));
  if (want("gateway")) {
    const gw = await new Promise((resolve) => {
      const p = spawn("dotnet", ["run", "--project", "qa/VoiceGatewayProbe/VoiceGatewayProbe.csproj", "--no-build"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, QA_FAKE: "http://127.0.0.1:5225", META_API_BASE: "http://127.0.0.1:5225", META_API_KEY: "qa-dummy-key" } });
      let out = "";
      p.stdout.on("data", (d) => { out += String(d); });
      p.stderr.on("data", (d) => { out += String(d); });
      p.on("close", (code) => {
        try { fs.mkdirSync(LOGDIR, { recursive: true }); fs.writeFileSync(LOGDIR + "/gateway.log", out); } catch {}
        resolve({ label: "gateway", code: code ?? 1, out });
      });
    });
    results.push(gw);
  }
  if (want("parent")) results.push(await runSuite("parent", ["qa/voice-browser-parent.mjs"], LOGDIR + "/parent.log"));
  for (const r of results) log(r.label + " exit=" + r.code);
  if (results.some((r) => r.code !== 0)) exitCode = 1;
} catch (e) {
  log("FATAL " + String((e && e.stack) || e).slice(0, 400));
  exitCode = 1;
} finally {
  // Outer finally from first Start: bounded ALL cleanup, truthful failure.
  const stops = [];
  if (edgeH) stops.push(stopBounded(edgeH, "edge", 15000));
  if (webH) stops.push(stopBounded(webH, "web", 15000));
  if (apiH) stops.push(stopBounded(apiH, "api", 15000));
  if (fakeH) stops.push(stopBounded(fakeH, "fake", 10000));
  const outs = await Promise.all(stops);
  for (const o of outs) if (!o.ok) { log("cleanup-" + o.why); exitCode = 1; }
  log("cleanup done exit=" + exitCode);
  process.exitCode = exitCode;
}
