// qa/own-local-stack.mjs - OWN local QA stack launcher (Muse sole-QA author only).
// Starts the EXACT owned loopback stack: API on 127.0.0.1:15396 + integrated fake on
// 127.0.0.1:15398. No services outside these two ports are touched. No PG, Docker,
// human ports, .env keys, or real providers are used or modified.
// Hardened: QAONLY key forced (never inherit), USE_POSTGRES=0 + PG/Kestrel env removed,
// publish/keyring/health/source+artifact/PID binding, refuse occupied ports,
// no detached/unref (blocking controller with bounded cleanup), exact origins,
// redirect manual, trusted fresh fake recall.
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const REPO = path.resolve(HERE, "..");
const OWN = path.resolve(REPO, "..", "own-15396-15398");
const API_PORT = 15396;
const FAKE_PORT = 15398;
const EXPECTED_INSTANCE = "qa-author-15396";
const QA_KEY = "qa-only-15396-never-real";
const API_DIR = path.join(OWN, "publish");
const KEYRING = path.join(OWN, "keyring");
const LOGDIR = path.join(OWN, "logs");
const PIDFILE = path.join(OWN, "pids.json");
const RUNFILE = path.join(OWN, "run.json");
const WEB = "http://127.0.0.1:" + API_PORT;
const FAKE = "http://127.0.0.1:" + FAKE_PORT;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function tcpOk(port) { return new Promise((resolve) => { const s = net.connect({ host: "127.0.0.1", port: port }); const done = (v) => { try { s.destroy(); } catch (e) { } resolve(v); }; s.on("connect", () => done(true)); s.on("error", () => done(false)); s.setTimeout(2000, () => done(false)); }); }
function exactOrigin(u) { try { const x = new URL(u); if (x.username || x.password) return null; if (x.protocol !== "http:") return null; if (x.hostname !== "127.0.0.1") return null; return x.origin; } catch { return null; } }
async function getJson(url, ms) {
  const o = exactOrigin(url);
  if (o !== WEB && o !== FAKE) throw new Error("refuse non-exact-origin");
  const ctl = new AbortController(); const t = setTimeout(() => { try { ctl.abort(); } catch (e) {} }, ms);
  try {
    const r = await fetch(url, { signal: ctl.signal, redirect: "manual" });
    if (r.status >= 300 && r.status < 400) throw new Error("refuse redirect");
    const tx = await r.text(); let j = null;
    try { j = tx ? JSON.parse(tx) : null; } catch (e) { j = null; }
    try { if (r.body && r.body.cancel) await r.body.cancel(); } catch (e) {}
    return { status: r.status, json: j };
  } catch (e) { return { status: 0, json: null }; } finally { clearTimeout(t); }
}
function apiEnv() {
  const e = Object.assign({}, process.env);
  e.ASPNETCORE_URLS = "http://127.0.0.1:" + API_PORT;
  e.META_API_BASE = "http://127.0.0.1:" + FAKE_PORT;
  e.META_API_KEY = QA_KEY;
  e.SIMCEO_INSTANCE = EXPECTED_INSTANCE;
  e.WIKI_KEYRING_DIR = KEYRING;
  e.ASPNETCORE_ENVIRONMENT = "Production";
  e.USE_POSTGRES = "0";
  for (const k of Object.keys(e)) {
    if (k === "USE_POSTGRES" || k === "ASPNETCORE_URLS" || k === "META_API_BASE" || k === "META_API_KEY" || k === "SIMCEO_INSTANCE" || k === "WIKI_KEYRING_DIR" || k === "ASPNETCORE_ENVIRONMENT") continue;
    if (k.indexOf("ConnectionStrings__") === 0) delete e[k];
    else if (k.indexOf("POSTGRES") === 0 || k.indexOf("PG") === 0 || k.indexOf("NPGSQL") === 0 || k.indexOf("Kestrel__") === 0 || k.indexOf("ASPNETCORE_HTTPS") === 0 || k.indexOf("DOTNET_URLS") === 0 || k.indexOf("HTTPS_") === 0) delete e[k];
  }
  return e;
}
function procName(pid) { try { const out = execSync("tasklist /FI \"PID eq " + pid + "\" /FO CSV /NH", { timeout: 8000 }).toString(); const m = out.match(/"([^"]+)","(\d+)"/); if (m && Number(m[2]) === Number(pid)) return m[1]; return ""; } catch (e) { return ""; } }
function sourceCommit() { try { return execSync("git rev-parse HEAD", { cwd: REPO, timeout: 8000 }).toString().trim().slice(0, 40); } catch (e) { return "unknown"; } }
function verifyPublish() {
  const dll = path.join(API_DIR, "SimCEO.Api.dll");
  const idx = path.join(API_DIR, "wwwroot", "index.html");
  if (!fs.existsSync(dll)) { console.log("FATAL publish missing (rebuild before start)"); process.exit(2); }
  if (!fs.existsSync(idx)) { console.log("FATAL wwwroot missing (rebuild before start)"); process.exit(2); }
  try { const st = fs.statSync(dll); console.log("publish ok dll=" + st.size); } catch (e) {}
}
async function waitBoot(deadline) { while (Date.now() < deadline) { const h = await getJson(WEB + "/health", 5000); const r = await getJson(WEB + "/ready", 5000); const f = await getJson(FAKE + "/__log", 5000); const ok = h.status === 200 && h.json && h.json.service === "simceo-api" && h.json.instance === EXPECTED_INSTANCE && r.status === 200 && r.json && r.json.ready === true && String(r.json.store) === "inmemory" && f.status === 200 && Array.isArray(f.json); if (ok) return { ok: true, health: h.json, ready: r.json, fakeEntries: f.json.length }; await sleep(1500); } return { ok: false }; }
let owned = [];
function track(c) { owned.push(c); return c; }
async function killOwnedBounded(ms) {
  const end = Date.now() + ms;
  for (const c of owned) { try { if (!c.killed && c.exitCode === null) c.kill(); } catch (e) {} }
  while (Date.now() < end) { let alive = false; for (const c of owned) { try { if (c.exitCode === null) { alive = true; break; } } catch (e) {} } if (!alive) break; await sleep(500); }
}
async function cmdStart() {
  verifyPublish();
  try { fs.mkdirSync(LOGDIR, { recursive: true }); } catch (e) {}
  try { fs.mkdirSync(KEYRING, { recursive: true }); } catch (e) {}
  let stale = null; try { stale = JSON.parse(fs.readFileSync(PIDFILE, "utf8")); } catch (e) {}
  if (stale && (Number(stale.api) > 0 || Number(stale.fake) > 0)) {
    const aN = procName(Number(stale.api) || 0); const fN = procName(Number(stale.fake) || 0);
    const aLive = /dotnet/i.test(String(aN)); const fLive = /node/i.test(String(fN));
    if (aLive || fLive) { console.log("FATAL refuse: pidfile owns live pids"); process.exit(2); }
    console.log("stale pidfile (dead pids), removing");
    try { fs.unlinkSync(PIDFILE); } catch (e) {}
  }
  const aOpen = await tcpOk(API_PORT); const fOpen = await tcpOk(FAKE_PORT);
  if (aOpen || fOpen) { console.log("FATAL refuse: occupied ports"); process.exit(2); }
  const env = apiEnv();
  if (env.META_API_KEY !== QA_KEY) { console.log("FATAL QA key not forced"); process.exit(2); }
  if (env.USE_POSTGRES !== "0") { console.log("FATAL USE_POSTGRES not 0"); process.exit(2); }
  const commit = sourceCommit();
  const nonce = Date.now().toString(36) + "-" + Math.floor(Math.random() * 16777215).toString(16);
  const apiLog = fs.openSync(path.join(LOGDIR, "api-15396.log"), "a");
  const apiErr = fs.openSync(path.join(LOGDIR, "api-15396.err.log"), "a");
  const api = track(spawn("dotnet", ["SimCEO.Api.dll"], { cwd: API_DIR, env: env, detached: false, stdio: ["ignore", apiLog, apiErr], windowsHide: true }));
  const fakeLog = fs.openSync(path.join(LOGDIR, "fake-15398.log"), "a");
  const fake = track(spawn("node", ["qa/advisor-integrated-fake.mjs", "--port", String(FAKE_PORT)], { cwd: REPO, env: process.env, detached: false, stdio: ["ignore", fakeLog, fakeLog], windowsHide: true }));
  const rec = { api: api.pid, fake: fake.pid, startedAt: Date.now(), nonce: nonce, commit: commit, instance: EXPECTED_INSTANCE };
  fs.writeFileSync(PIDFILE, JSON.stringify(rec));
  fs.writeFileSync(RUNFILE, JSON.stringify(rec));
  console.log("spawned api=" + api.pid + " fake=" + fake.pid + " nonce=" + nonce);
  let stopping = false;
  const onSig = async (sig) => { if (stopping) return; stopping = true; console.log("signal cleanup"); await killOwnedBounded(15000); try { process.exit(0); } catch (e) {} };
  try { process.on("SIGINT", () => onSig("SIGINT")); process.on("SIGTERM", () => onSig("SIGTERM")); } catch (e) {}
  const boot = await waitBoot(Date.now() + 120000);
  if (!boot.ok) { console.log("FATAL boot verification failed within deadline"); await killOwnedBounded(15000); process.exit(2); }
  if (boot.fakeEntries !== 0) { console.log("FATAL refuse: fake not fresh"); await killOwnedBounded(15000); process.exit(2); }
  console.log("boot ok instance=" + boot.health.instance + " store=" + boot.ready.store);
}
async function cmdStop() {
  let pids = null; try { pids = JSON.parse(fs.readFileSync(PIDFILE, "utf8")); } catch (e) { console.log("no pidfile; nothing owned to stop"); return; }
  const targets = [["api", pids.api, "dotnet"], ["fake", pids.fake, "node"]];
  for (const t of targets) {
    const name = String(t[0]); const pid = Number(t[1]); const want = String(t[2]).toLowerCase();
    if (!pid) continue;
    const actual = String(procName(pid) || "").toLowerCase();
    if (actual.indexOf(want) < 0) { console.log("skip " + name + " pid=" + pid + " not ours"); continue; }
    try { process.kill(pid); console.log("killed " + name + " pid=" + pid); } catch (e) { console.log("kill failed " + name); }
  }
  const end = Date.now() + 15000;
  while (Date.now() < end) { const a = await tcpOk(API_PORT); const f = await tcpOk(FAKE_PORT); if (!a && !f) break; await sleep(1000); }
  const a2 = await tcpOk(API_PORT); const f2 = await tcpOk(FAKE_PORT);
  console.log("after-stop apiOpen=" + a2 + " fakeOpen=" + f2);
  try { fs.unlinkSync(PIDFILE); } catch (e) {}
  if (a2 || f2) { console.log("FATAL ports still open after bounded stop"); process.exit(2); }
}
async function cmdStatus() { const h = await getJson(WEB + "/health", 5000); const r = await getJson(WEB + "/ready", 5000); const f = await getJson(FAKE + "/__log", 5000); console.log("health=" + h.status + " instance=" + ((h.json && h.json.instance) || "?") + " ready=" + r.status + " store=" + ((r.json && r.json.store) || "?") + " fake=" + f.status); }
const cmd = String(process.argv[2] || "");
if (cmd === "start") { cmdStart().catch((e) => { console.log("FATAL " + String((e && e.message) || e).slice(0, 200)); process.exit(2); }); }
else if (cmd === "stop") { cmdStop().catch((e) => { console.log("FATAL " + String((e && e.message) || e).slice(0, 200)); process.exit(2); }); }
else if (cmd === "status") { cmdStatus().catch((e) => { console.log("FATAL " + String((e && e.message) || e).slice(0, 200)); process.exit(2); }); }
else { console.log("usage: node qa/own-local-stack.mjs start|stop|status"); process.exit(2); }
