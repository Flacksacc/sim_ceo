// qa/own-local-stack.mjs - OWN local QA stack launcher (Muse sole-QA author only).
// Starts the EXACT owned loopback stack: API on 127.0.0.1:15396 + integrated fake on
// 127.0.0.1:15398. No services outside these two ports are touched. No PG, Docker,
// human ports, .env keys, or real providers are used or modified.
// Hardened: QAONLY key forced (never inherit), USE_POSTGRES=0 + PG/Kestrel env removed
// case-insensitively (incl ASPNETCORE_/DOTNET_ prefixes), controlled endpoint config,
// publish/manifest binding (DLL+wwwroot+QA+fake sha256 + nonce + commit tied to run),
// exact PID creation-identity binding (CreationDate+CommandLine+ExecutablePath, never
// process-name-only), retained-controller kill with PID-reuse refusal, post-spawn
// unconditional cleanup with child error/sibling-exit handling, absolute local
// deadlines (no floors past deadline), exact origins + redirect manual, trusted fresh
// fake recall, refuse occupied ports, no detached/unref (blocking controller).
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
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
const MANIFESTFILE = path.join(OWN, "manifest.json");
const FAILFILE = path.join(OWN, "pids.failed.json");
const WEB = "http://127.0.0.1:" + API_PORT;
const FAKE = "http://127.0.0.1:" + FAKE_PORT;
const START_BUDGET_MS = 120000;
const STOP_BUDGET_MS = 25000;
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
function tcpOk(port, timeoutMs) { return new Promise((resolve) => { const s = net.connect({ host: "127.0.0.1", port: port }); let done = false; const fin = (v) => { if (done) return; done = true; try { s.destroy(); } catch (e) {} resolve(v); }; s.on("connect", () => fin(true)); s.on("error", () => fin(false)); s.setTimeout(timeoutMs || 2000, () => fin(false)); }); }
function exactOrigin(u) { try { const x = new URL(u); if (x.username || x.password) return null; if (x.protocol !== "http:") return null; if (x.hostname !== "127.0.0.1") return null; return x.origin; } catch { return null; } }
async function getJson(url, ms, deadlineMs) {
  const o = exactOrigin(url);
  if (o !== WEB && o !== FAKE) throw new Error("refuse non-exact-origin");
  const now = Date.now();
  const rem = deadlineMs ? (deadlineMs - now) : ms;
  if (rem <= 0) throw new Error("deadline exceeded before fetch");
  const cap = Math.min(ms, rem);
  const ctl = new AbortController(); const t = setTimeout(() => { try { ctl.abort(); } catch (e) {} }, cap);
  try {
    const r = await fetch(url, { signal: ctl.signal, redirect: "manual" });
    if (r.status >= 300 && r.status < 400) throw new Error("refuse redirect");
    const tx = await r.text();
    let j = null;
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
  const KEEP = new Set(["USE_POSTGRES","ASPNETCORE_URLS","META_API_BASE","META_API_KEY","SIMCEO_INSTANCE","WIKI_KEYRING_DIR","ASPNETCORE_ENVIRONMENT"]);
  for (const k of Object.keys(e)) {
    if (KEEP.has(k)) continue;
    const u = String(k).toUpperCase();
    if (u.indexOf("CONNECTIONSTRINGS__") >= 0) { delete e[k]; continue; }
    if (u.indexOf("KESTREL__") >= 0) { delete e[k]; continue; }
    if (u.indexOf("ENDPOINTS__") >= 0 && (u.indexOf("HTTP") >= 0 || u.indexOf("URL") >= 0)) { delete e[k]; continue; }
    if (u.startsWith("POSTGRES") || u.startsWith("PG") || u.startsWith("NPGSQL")) { delete e[k]; continue; }
    if (u.startsWith("ASPNETCORE_HTTPS") || u.startsWith("DOTNET_URLS") || u.startsWith("HTTPS_")) { delete e[k]; continue; }
    if (u.startsWith("DOTNET_") && (u.indexOf("URL") >= 0 || u.indexOf("HTTPS") >= 0 || u.indexOf("KESTREL") >= 0)) { delete e[k]; continue; }
  }
  return e;
}
function procIdentity(pid) {
  pid = Number(pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const ps = "Get-CimInstance Win32_Process -Filter 'ProcessId=" + pid + "' | Select-Object ProcessId,CreationDate,CommandLine,ExecutablePath | ConvertTo-Json -Compress";
    const out = execSync("powershell -NoProfile -NonInteractive -Command \"" + ps + "\"", { timeout: 8000, windowsHide: true }).toString().trim();
    if (!out) return null;
    let j = null;
    try { j = JSON.parse(out); } catch (e) { return null; }
    if (!j || Number(j.ProcessId) !== pid) return null;
    return { pid: pid, creation: String((j.CreationDate || "")), cmd: String((j.CommandLine || "")), exe: String((j.ExecutablePath || "")) };
  } catch (e) { return null; }
}
function procNameFallback(pid) { try { const out = execSync("tasklist /FI \"PID eq " + pid + "\" /FO CSV /NH", { timeout: 8000, windowsHide: true }).toString(); const m = out.match(/"([^"]+)","(\d+)"/); if (m && Number(m[2]) === Number(pid)) return m[1]; return ""; } catch (e) { return ""; } }
function sourceCommit() { try { return execSync("git rev-parse HEAD", { cwd: REPO, timeout: 8000, windowsHide: true }).toString().trim().slice(0, 40); } catch (e) { return "unknown"; } }
function sha256File(p) { try { const b = fs.readFileSync(p); return crypto.createHash("sha256").update(b).digest("hex"); } catch (e) { return ""; } }
function buildManifest() {
  const dll = path.join(API_DIR, "SimCEO.Api.dll");
  const idx = path.join(API_DIR, "wwwroot", "index.html");
  const qaFile = path.join(REPO, "qa", "advisor-integrated-qa.mjs");
  const fakeFile = path.join(REPO, "qa", "advisor-integrated-fake.mjs");
  const helperFile = path.join(REPO, "qa", "own-local-stack.mjs");
  return {
    dll: dll, dllSha: sha256File(dll), dllSize: (() => { try { return fs.statSync(dll).size; } catch (e) { return -1; } })(),
    wwwroot: idx, wwwrootSha: sha256File(idx),
    qa: qaFile, qaSha: sha256File(qaFile),
    fake: fakeFile, fakeSha: sha256File(fakeFile),
    helper: helperFile, helperSha: sha256File(helperFile),
    commit: sourceCommit()
  };
}
function verifyPublish() {
  const dll = path.join(API_DIR, "SimCEO.Api.dll");
  const idx = path.join(API_DIR, "wwwroot", "index.html");
  if (!fs.existsSync(dll)) { console.log("FATAL publish missing (rebuild before start)"); process.exit(2); }
  if (!fs.existsSync(idx)) { console.log("FATAL wwwroot missing (rebuild before start)"); process.exit(2); }
  try {
    const files = fs.readdirSync(API_DIR);
    for (const f of files) {
      if (/^appsettings.*\.json$/i.test(f)) {
        try {
          const txt = fs.readFileSync(path.join(API_DIR, f), "utf8");
          const low = txt.toLowerCase();
          if (low.indexOf("kestrel") >= 0) {
            const j = JSON.parse(txt);
            const hasKestrel = j && (j.Kestrel || j.kestrel || j["Kestrel__Endpoints"]);
            if (hasKestrel) { console.log("FATAL published endpoint config present in " + f + " (refusing uncontrolled listeners)"); process.exit(2); }
          }
        } catch (e) { if (String((e && e.message) || "").indexOf("FATAL published") === 0) throw e; }
      }
    }
  } catch (e) { if (String((e && e.message) || "").indexOf("FATAL published") === 0) { console.log(String(e.message)); process.exit(2); } }
  const m = buildManifest();
  if (!m.dllSha || !m.wwwrootSha || !m.qaSha || !m.fakeSha) { console.log("FATAL manifest hash missing (unhashed artifact)"); process.exit(2); }
  try { const st = fs.statSync(dll); console.log("publish ok dll=" + st.size + " dllSha=" + m.dllSha.slice(0,12) + " wwwrootSha=" + m.wwwrootSha.slice(0,12) + " qaSha=" + m.qaSha.slice(0,12) + " fakeSha=" + m.fakeSha.slice(0,12) + " commit=" + m.commit); } catch (e) {}
  return m;
}
async function waitBoot(deadline) {
  while (Date.now() < deadline) {
    const rem = deadline - Date.now();
    if (rem <= 0) break;
    const per = Math.min(5000, rem);
    const h = await getJson(WEB + "/health", per, deadline);
    const r = await getJson(WEB + "/ready", per, deadline);
    const f = await getJson(FAKE + "/__log", per, deadline);
    const ok = h.status === 200 && h.json && h.json.service === "simceo-api" && h.json.instance === EXPECTED_INSTANCE && r.status === 200 && r.json && r.json.ready === true && String(r.json.store) === "inmemory" && f.status === 200 && Array.isArray(f.json);
    if (ok) return { ok: true, health: h.json, ready: r.json, fakeEntries: f.json.length };
    const rem2 = deadline - Date.now();
    if (rem2 <= 0) break;
    await sleep(Math.min(1500, rem2));
  }
  return { ok: false };
}
let owned = [];
function track(c) { owned.push(c); return c; }
async function killOwnedBounded(deadline) {
  for (const c of owned) { try { if (!c.killed && c.exitCode === null) c.kill(); } catch (e) {} }
  while (Date.now() < deadline) {
    let alive = false;
    for (const c of owned) { try { if (c.exitCode === null && c.killed === false) { alive = true; break; } if (c.exitCode === null) { try { process.kill(c.pid, 0); alive = true; break; } catch (e) {} } } catch (e) {} }
    if (!alive) break;
    const rem = deadline - Date.now();
    if (rem <= 0) break;
    await sleep(Math.min(500, rem));
  }
  let still = false;
  for (const c of owned) { try { if (c.exitCode === null) { try { process.kill(c.pid, 0); still = true; } catch (e) {} } } catch (e) {} }
  return !still;
}
function identityMatches(recorded, current, wantKind) {
  if (!recorded || !current) return false;
  if (String(recorded.creation || "") === "" || String(current.creation || "") === "") return false;
  if (String(recorded.creation) !== String(current.creation)) return false;
  const rc = String(recorded.cmd || ""), cc = String(current.cmd || "");
  if (!rc || !cc || rc !== cc) return false;
  const exe = String(current.exe || "").toLowerCase();
  if (wantKind === "api" && exe.indexOf("dotnet") < 0) return false;
  if (wantKind === "fake" && exe.indexOf("node") < 0) return false;
  return true;
}
async function cmdStart() {
  const startDeadline = Date.now() + START_BUDGET_MS;
  const manifestPre = verifyPublish();
  try { fs.mkdirSync(LOGDIR, { recursive: true }); } catch (e) {}
  try { fs.mkdirSync(KEYRING, { recursive: true }); } catch (e) {}
  let stale = null; try { stale = JSON.parse(fs.readFileSync(PIDFILE, "utf8")); } catch (e) {}
  if (stale && (Number(stale.apiPid) > 0 || Number(stale.fakePid) > 0)) {
    const aCur = procIdentity(Number(stale.apiPid) || 0);
    const fCur = procIdentity(Number(stale.fakePid) || 0);
    const aOwned = stale.apiIdent && aCur && identityMatches(stale.apiIdent, aCur, "api");
    const fOwned = stale.fakeIdent && fCur && identityMatches(stale.fakeIdent, fCur, "fake");
    if (aOwned || fOwned) { console.log("FATAL refuse: pidfile owns live children (creation-identity match)"); process.exit(2); }
    if ((aCur && !aOwned && Number(stale.apiPid) > 0) || (fCur && !fOwned && Number(stale.fakePid) > 0)) {
      console.log("stale pidfile with PID reuse detected (live unrelated process); refusing to kill, removing stale file");
    } else {
      console.log("stale pidfile (dead pids), removing");
    }
    try { fs.unlinkSync(PIDFILE); } catch (e) {}
  }
  const remPorts = startDeadline - Date.now();
  if (remPorts <= 0) { console.log("FATAL start deadline exceeded before port check"); process.exit(2); }
  const aOpen = await tcpOk(API_PORT, Math.min(2000, remPorts));
  const fOpen = await tcpOk(FAKE_PORT, Math.min(2000, startDeadline - Date.now()));
  if (aOpen || fOpen) { console.log("FATAL refuse: occupied ports"); process.exit(2); }
  const env = apiEnv();
  if (env.META_API_KEY !== QA_KEY) { console.log("FATAL QA key not forced"); process.exit(2); }
  if (env.USE_POSTGRES !== "0") { console.log("FATAL USE_POSTGRES not 0"); process.exit(2); }
  for (const k of Object.keys(env)) { const u = String(k).toUpperCase(); if (u.indexOf("KESTREL__") >= 0) { console.log("FATAL uncontrolled Kestrel env survives: " + k); process.exit(2); } }
  const commit = manifestPre.commit;
  const nonce = Date.now().toString(36) + "-" + Math.floor(Math.random() * 16777215).toString(16);
  const apiLog = fs.openSync(path.join(LOGDIR, "api-15396.log"), "a");
  const apiErr = fs.openSync(path.join(LOGDIR, "api-15396.err.log"), "a");
  let api = null, fake = null;
  try {
    api = track(spawn("dotnet", ["SimCEO.Api.dll"], { cwd: API_DIR, env: env, detached: false, stdio: ["ignore", apiLog, apiErr], windowsHide: true }));
    const fakeLog = fs.openSync(path.join(LOGDIR, "fake-15398.log"), "a");
    fake = track(spawn("node", ["qa/advisor-integrated-fake.mjs", "--port", String(FAKE_PORT)], { cwd: REPO, env: process.env, detached: false, stdio: ["ignore", fakeLog, fakeLog], windowsHide: true }));
  } catch (e) { console.log("FATAL spawn threw: " + String((e && e.message) || e).slice(0,160)); await killOwnedBounded(startDeadline); process.exit(2); }
  try {
    api.on("error", () => { try { if (fake && !fake.killed && fake.exitCode === null) fake.kill(); } catch (e) {} });
    fake.on("error", () => { try { if (api && !api.killed && api.exitCode === null) api.kill(); } catch (e) {} });
    api.on("exit", () => { try { if (fake && !fake.killed && fake.exitCode === null) { if (Date.now() < startDeadline) fake.kill(); } } catch (e) {} });
    fake.on("exit", () => { try { if (api && !api.killed && api.exitCode === null) { if (Date.now() < startDeadline) api.kill(); } } catch (e) {} });
  } catch (e) {}
  await sleep(800);
  const apiIdentLive = procIdentity(api.pid);
  const fakeIdentLive = procIdentity(fake.pid);
  if (!apiIdentLive || !fakeIdentLive) { console.log("FATAL child identity unavailable immediately after spawn"); await killOwnedBounded(startDeadline); process.exit(2); }
  const rec = { apiPid: api.pid, fakePid: fake.pid, apiIdent: apiIdentLive, fakeIdent: fakeIdentLive, startedAt: Date.now(), nonce: nonce, commit: commit, instance: EXPECTED_INSTANCE, manifest: { dllSha: manifestPre.dllSha, wwwrootSha: manifestPre.wwwrootSha, qaSha: manifestPre.qaSha, fakeSha: manifestPre.fakeSha, helperSha: manifestPre.helperSha } };
  try { fs.writeFileSync(PIDFILE, JSON.stringify(rec)); } catch (e) { console.log("FATAL pidfile write failed"); await killOwnedBounded(startDeadline); process.exit(2); }
  try { fs.writeFileSync(RUNFILE, JSON.stringify(rec)); } catch (e) {}
  try { fs.writeFileSync(MANIFESTFILE, JSON.stringify({ nonce: nonce, commit: commit, at: Date.now(), instance: EXPECTED_INSTANCE, dllSha: manifestPre.dllSha, wwwrootSha: manifestPre.wwwrootSha, qaSha: manifestPre.qaSha, fakeSha: manifestPre.fakeSha, helperSha: manifestPre.helperSha })); } catch (e) {}
  console.log("spawned api=" + api.pid + " fake=" + fake.pid + " nonce=" + nonce);
  let stopping = false;
  const onSig = async (sig) => { if (stopping) return; stopping = true; console.log("signal cleanup"); await killOwnedBounded(Date.now() + 15000); try { process.exit(0); } catch (e) {} };
  try { process.on("SIGINT", () => onSig("SIGINT")); process.on("SIGTERM", () => onSig("SIGTERM")); } catch (e) {}
  let boot = { ok: false };
  try {
    boot = await waitBoot(startDeadline);
  } catch (e) { console.log("FATAL boot threw: " + String((e && e.message) || e).slice(0,160)); await killOwnedBounded(startDeadline); process.exit(2); }
  if (!boot.ok) { console.log("FATAL boot verification failed within deadline"); await killOwnedBounded(startDeadline); process.exit(2); }
  if (boot.fakeEntries !== 0) { console.log("FATAL refuse: fake not fresh"); await killOwnedBounded(startDeadline); process.exit(2); }
  console.log("boot ok instance=" + boot.health.instance + " store=" + boot.ready.store + " manifest dll=" + manifestPre.dllSha.slice(0,12) + " qa=" + manifestPre.qaSha.slice(0,12));
}
async function cmdStop() {
  const stopDeadline = Date.now() + STOP_BUDGET_MS;
  let pids = null; try { pids = JSON.parse(fs.readFileSync(PIDFILE, "utf8")); } catch (e) { console.log("no pidfile; nothing owned to stop"); return; }
  const targets = [["api", pids.apiPid || pids.api, pids.apiIdent, "api"], ["fake", pids.fakePid || pids.fake, pids.fakeIdent, "fake"]];
  let refusedReuse = false;
  for (const t of targets) {
    const name = String(t[0]); const pid = Number(t[1]); const recorded = t[2]; const kind = String(t[3]);
    if (!pid) continue;
    const cur = procIdentity(pid);
    if (!cur) { console.log("skip " + name + " pid=" + pid + " already dead"); continue; }
    if (!recorded || !recorded.creation) {
      const fb = procNameFallback(pid);
      console.log("refuse " + name + " pid=" + pid + " (no recorded creation identity; fallback name=" + fb + " insufficient for ownership)");
      refusedReuse = true;
      continue;
    }
    if (!identityMatches(recorded, cur, kind)) {
      console.log("refuse " + name + " pid=" + pid + " PID reuse suspected (creation/cmd mismatch; not ours)");
      refusedReuse = true;
      continue;
    }
    try { process.kill(pid); console.log("killed " + name + " pid=" + pid + " (creation-verified)"); } catch (e) { console.log("kill failed " + name + " pid=" + pid); }
  }
  while (Date.now() < stopDeadline) {
    const rem = stopDeadline - Date.now();
    if (rem <= 0) break;
    const a = await tcpOk(API_PORT, Math.min(1500, rem));
    const f = await tcpOk(FAKE_PORT, Math.min(1500, stopDeadline - Date.now()));
    if (!a && !f) break;
    await sleep(Math.min(1000, stopDeadline - Date.now()));
  }
  const remFinal = stopDeadline - Date.now();
  const a2 = remFinal > 0 ? await tcpOk(API_PORT, Math.min(1500, remFinal)) : true;
  const f2 = (stopDeadline - Date.now()) > 0 ? await tcpOk(FAKE_PORT, Math.min(1500, stopDeadline - Date.now())) : true;
  console.log("after-stop apiOpen=" + a2 + " fakeOpen=" + f2 + (refusedReuse ? " refusedReuse=true" : ""));
  if (a2 || f2) {
    console.log("FATAL ports still open after bounded stop");
    try { fs.writeFileSync(FAILFILE, JSON.stringify({ at: Date.now(), pids: pids, apiOpen: a2, fakeOpen: f2 })); } catch (e) {}
    process.exit(2);
  }
  if (refusedReuse) {
    console.log("stop refused PID reuse for at least one target; retaining pidfile for forensics");
    try { fs.writeFileSync(FAILFILE, JSON.stringify({ at: Date.now(), pids: pids, refusedReuse: true })); } catch (e) {}
    process.exit(2);
  }
  for (const t of targets) {
    const pid = Number(t[1]);
    if (!pid) continue;
    const cur = procIdentity(pid);
    if (cur) { console.log("FATAL child still alive after stop pid=" + pid); try { fs.writeFileSync(FAILFILE, JSON.stringify({ at: Date.now(), pids: pids })); } catch (e) {} process.exit(2); }
  }
  try { fs.unlinkSync(PIDFILE); } catch (e) {}
  try { fs.unlinkSync(FAILFILE); } catch (e) {}
}
async function cmdStatus() { const deadline = Date.now() + 15000; const h = await getJson(WEB + "/health", 5000, deadline); const r = await getJson(WEB + "/ready", 5000, deadline); const f = await getJson(FAKE + "/__log", 5000, deadline); console.log("health=" + h.status + " instance=" + ((h.json && h.json.instance) || "?") + " ready=" + r.status + " store=" + ((r.json && r.json.store) || "?") + " fake=" + f.status); }
const cmd = String(process.argv[2] || "");
if (cmd === "start") { cmdStart().catch((e) => { console.log("FATAL " + String((e && e.message) || e).slice(0, 200)); process.exit(2); }); }
else if (cmd === "stop") { cmdStop().catch((e) => { console.log("FATAL " + String((e && e.message) || e).slice(0, 200)); process.exit(2); }); }
else if (cmd === "status") { cmdStatus().catch((e) => { console.log("FATAL " + String((e && e.message) || e).slice(0, 200)); process.exit(2); }); }
else { console.log("usage: node qa/own-local-stack.mjs start|stop|status"); process.exit(2); }