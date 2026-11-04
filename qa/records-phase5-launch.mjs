import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
const TOTAL_START = Date.now();
const TOTAL_BUDGET_MS = 22 * 60 * 1000;
// Agreed cooperative-deadline contract with browser author (browser file NOT edited here).
// Browser implements: RECORDS_QA_WORK_DEADLINE_EPOCH_MS (absolute ms) + RECORDS_QA_CLEANUP_MS.
// Parent force-timeout for browser = min(nominal, remaining - PARENT_RESERVE); cooperative
// work deadline = force-timeout start + force-timeout - CLEANUP, so runner finishes/tears down
// BEFORE the parent kills it. Parent reserve (40000) >= cleanup (20000) + margin (20000).
const RECORDS_QA_CLEANUP_MS = 20000;
const RECORDS_QA_PARENT_MARGIN_MS = 20000;
const RECORDS_QA_PARENT_RESERVE_MS = RECORDS_QA_CLEANUP_MS + RECORDS_QA_PARENT_MARGIN_MS;
function totalExpired() { return Date.now() - TOTAL_START > TOTAL_BUDGET_MS; }
function checkTotal(phase) { if (totalExpired()) throw new Error("TOTAL deadline exceeded before " + phase); }
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MAINTMP = path.dirname(ROOT);
const API = "http://127.0.0.1:15320";
const FAKE = "http://127.0.0.1:15322";
const WEB = API;
const INST = "muse-r597-" + Date.now().toString(36) + "-" + crypto.randomBytes(3).toString("hex").slice(0, 4);
const KEY = "qa-only-muse-r597";
const PUB = path.join(ROOT, ".qa", "publish-muse-" + INST);
const KEYRING = path.join(ROOT, ".qa", "keyring-muse-r597-" + INST);
const LOGP = (n) => path.join(MAINTMP, "muse-r597-" + INST + "-" + n + ".log");
function refuse(m) { console.error("REFUSE " + m); process.exit(2); }
function checkUrl(v, want, name) {
  let u; try { u = new URL(v); } catch { refuse("bad " + name); }
  if (u.protocol !== "http:") refuse(name + " must be http exactly");
  if (u.hostname !== "127.0.0.1") refuse(name + " must be 127.0.0.1 exactly");
  if (Number(u.port) !== want) refuse(name + " must be 127.0.0.1:" + want + " got " + v);
  if (u.search || u.hash || u.username || u.password) refuse(name + " no query/fragment/userinfo");
}
for (const bad of [":5080", ":5173", ":9333", ":15180", ":15300", ":15302"]) {
  if (API.includes(bad) || FAKE.includes(bad) || WEB.includes(bad)) refuse("human/shared port " + bad);
}
checkUrl(API, 15320, "QA_API"); checkUrl(FAKE, 15322, "QA_FAKE");
if (process.env.USE_POSTGRES === "1") refuse("USE_POSTGRES must be 0");
function portBusy(port) {
  return new Promise((resolve) => {
    const s = new net.Socket(); let done = false;
    const fin = (b) => { if (!done) { done = true; try { s.destroy(); } catch {} resolve(b); } };
    s.setTimeout(1000);
    s.once("connect", () => fin(true));
    s.once("timeout", () => fin(false));
    s.once("error", () => fin(false));
    try { s.connect(port, "127.0.0.1"); } catch { fin(false); }
  });
}
function portBusy6(port) {
  return new Promise((resolve) => {
    const s = new net.Socket(); let done = false;
    const fin = (b) => { if (!done) { done = true; try { s.destroy(); } catch {} resolve(b); } };
    s.setTimeout(1000);
    s.once("connect", () => fin(true));
    s.once("timeout", () => fin(false));
    s.once("error", () => fin(false));
    try { s.connect(port, "::1"); } catch { fin(false); }
  });
}
async function fetchJson(url, opts) {
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(url, { redirect: "error", signal: ctl.signal, ...(opts || {}) });
    const text = await r.text(); let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text };
  } finally { clearTimeout(tm); }
}
const children = [];
let cleaned = false;
let cleanupFailed = false;
let cleanupPromise = null;
function runBounded(cmd, args, opts, timeoutMs) {
  const r = spawnSync(cmd, args, { ...(opts || {}), timeout: Math.min(timeoutMs, Math.max(1000, TOTAL_BUDGET_MS - (Date.now() - TOTAL_START) - RECORDS_QA_PARENT_RESERVE_MS)) });
  if (r.error && String((r.error && r.error.code) || "") === "ETIMEDOUT") throw new Error("BUILD TIMEOUT " + cmd + " " + (args || []).join(" "));
  if (r.status !== 0) throw new Error("BUILD FAIL " + cmd + " " + (args || []).join(" ") + " status=" + r.status + " " + String(r.stderr || "").slice(0, 300));
  return r;
}
async function boundedWait(child, ms) {
  if (!child || child.exitCode !== null) return true;
  const done = await Promise.race([new Promise((res) => { try { child.once("exit", () => res(true)); } catch { res(false); } }), new Promise((res) => setTimeout(() => res(false), ms))]);
  return !!done;
}
function childEnv() {
  const allowExact = new Set(["PATH", "PATHEXT", "SystemRoot", "SYSTEMROOT", "COMSPEC", "ComSpec", "TEMP", "TMP", "HOME", "USERPROFILE", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "OS", "WINDIR", "PROGRAMFILES", "PROGRAMDATA", "PROGRAMFILES(X86)", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "DOTNET_CLI_TELEMETRY_OPTOUT", "DOTNET_SKIP_FIRST_TIME_EXPERIENCE", "DOTNET_NOLOGO"]);
  const allowPrefix = ["NUGET_", "NPM_", "PROGRAM"]; // NODE_ deliberately excluded: NODE_OPTIONS/--require/--import hooks
  const denyRe = /API_KEY|SECRET|TOKEN|PASSWORD|OPENAI|ANTHROPIC|AZURE|GITHUB|META_|GOOGLE|AWS_|ASPNETCORE_|KESTREL_|DOTNET_URLS|PORT|URLS/i;
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    const allowed = allowExact.has(k) || allowPrefix.some((p) => k.startsWith(p));
    if (!allowed) continue;
    if (denyRe.test(k)) continue;
    out[k] = v;
  }
  for (const hk of Object.keys(out)) { if (hk !== "DOTNET_CONTENTROOT" && hk.indexOf("DOTNET_") === 0 && !allowExact.has(hk)) delete out[hk]; }
  for (const hk of Object.keys(out)) { if (hk === "NODE_OPTIONS" || hk.indexOf("NODE_") === 0 || /NODE_OPTIONS/i.test(hk)) delete out[hk]; }
  delete out["NODE_OPTIONS"];
  out["DOTNET_CONTENTROOT"] = PUB;
  out["PATH"] = process.env.PATH || process.env.Path || out["PATH"] || "";
  out["SystemRoot"] = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
  out["SYSTEMROOT"] = out["SystemRoot"];
  out["TEMP"] = process.env.TEMP || process.env.TMP || out["TEMP"] || "C:\\Windows\\Temp";
  out["TMP"] = process.env.TMP || process.env.TEMP || out["TMP"] || "C:\\Windows\\Temp";
  out["SIMCEO_INSTANCE"] = INST;
  out["USE_POSTGRES"] = "0";
  out["META_API_BASE"] = FAKE;
  out["META_API_KEY"] = KEY;
  out["WIKI_KEYRING_DIR"] = KEYRING;
  out["ASPNETCORE_URLS"] = API;
  out["QA_API"] = API;
  out["QA_FAKE"] = FAKE;
  out["QA_WEB"] = WEB;
  out["SIMCEO_PROVENANCE"] = INST;
  out["QA_PROVENANCE"] = INST;
  return out;
}
function buildEnv() { return childEnv(); } // builds use the same allowlisted child env; DOTNET_CONTENTROOT pinned to fresh PUB
function attachSpawnError(child, label) {
  try { child.on("error", (er) => { console.error("SPAWN " + label + " failed " + String((er && er.message) || er).slice(0, 200)); }); } catch {}
  return child;
}
function suiteEnv(extra) {
  const e = { ...childEnv(), QA_API: API, QA_FAKE: FAKE, QA_WEB: WEB, SIMCEO_INSTANCE: INST, QA_PROVENANCE: INST, META_API_BASE: FAKE, META_API_KEY: KEY, QA_FAKE_BOOT: (proof && proof.boot) || "", ...(extra || {}) }; for (const k of Object.keys(e)) { if (k === "NODE_OPTIONS" || k.indexOf("NODE_") === 0 || /NODE_OPTIONS/i.test(k)) delete e[k]; } return e;
}
async function cleanupOnce() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    if (cleaned) return !cleanupFailed;
    cleaned = true;
    for (const c of children) { try { if (c && c.exitCode === null) c.kill(); } catch {} }
    for (const c of children) {
      try {
        const exited = await boundedWait(c, 5000);
        if (!exited && c && c.exitCode === null) { try { c.kill("SIGKILL"); } catch {} await boundedWait(c, 2000); }
      } catch {}
    }
    try {
      const b1 = await portBusy(15320); const b2 = await portBusy(15322); const b3 = await portBusy6(15320); const b4 = await portBusy6(15322);
      if (b1 || b2 || b3 || b4) { console.error("FAIL ports still bound after cleanup 15320=" + b1 + " 15322=" + b2); cleanupFailed = true; return false; }
      console.log("ports closed verified");
      return !cleanupFailed;
    } catch (e) { console.error("FAIL cleanup probe " + String(e).slice(0, 200)); cleanupFailed = true; return false; }
  })();
  return cleanupPromise;
}
async function prove() {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    checkTotal("prove");
    try {
      const h = await fetchJson(API + "/health");
      const be = await fetchJson(API + "/api/backend");
      const fh = await fetchJson(FAKE + "/__health");
      const fc = await fetchJson(FAKE + "/__counts");
      const mode = String((be.json && (be.json.mode || be.json.Mode)) || "").toLowerCase();
      if (h.status === 200 && h.json && h.json.ok === true && String(h.json.instance || h.json.Instance) === INST
        && be.status === 200 && be.json && mode === "memory"
        && fh.status === 200 && fh.json && fh.json.fake === "records5-scoped" && !!fh.json.boot
        && fc.status === 200 && fc.json && typeof fc.json.chat === "number") {
        return { boot: fh.json.boot, chatBefore: fc.json.chat };
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error("PROOF TIMEOUT api/fake provenance");
}
let proof = null;
let exitCode = 0;
async function main() {
  console.log("LAUNCHER instance=" + INST + " totalStart=" + TOTAL_START);
  checkTotal("preflight");
  if (await portBusy(15320)) refuse("API port busy");
  if (await portBusy(15322)) refuse("FAKE port busy");
  if (await portBusy6(15320)) refuse("API IPv6 port busy (unowned listener)");
  if (await portBusy6(15322)) refuse("FAKE IPv6 port busy (unowned listener)");
  let srcSha = "";
  try { srcSha = String(spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, timeout: 15000, env: buildEnv() }).stdout || "").trim(); } catch {}
  console.log("source sha=" + (srcSha || "unknown"));
  try { fs.rmSync(PUB, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(KEYRING, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(PUB, { recursive: true });
  fs.mkdirSync(KEYRING, { recursive: true });
  console.log("fresh staging pub=" + PUB + " keyring=" + KEYRING);
  console.log("publish api...");
  checkTotal("build-api");
  runBounded("dotnet", ["publish", "server/SimCEO.Api/SimCEO.Api.csproj", "-c", "Release", "-o", PUB, "--nologo", "-v", "q"], { cwd: ROOT, env: buildEnv() }, 600000);
  checkTotal("build-web");
  runBounded("cmd.exe", ["/c", "npm", "--prefix", "web", "run", "build"], { cwd: ROOT, env: buildEnv() }, 600000);
  const dllP = path.join(PUB, "SimCEO.Api.dll");
  if (!fs.existsSync(dllP)) throw new Error("missing artifact " + dllP);
  console.log("artifact bytes=" + fs.statSync(dllP).size + " sha=" + (srcSha || "unknown"));
  fs.mkdirSync(path.join(PUB, "wwwroot"), { recursive: true });
  fs.cpSync(path.join(ROOT, "web", "dist"), path.join(PUB, "wwwroot"), { recursive: true, force: true });
  console.log("staged wwwroot from dist");
  const apiLog = fs.openSync(LOGP("api"), "a"); const fakeLog = fs.openSync(LOGP("fake"), "a");
  const env = childEnv();
  const fakeProc = attachSpawnError(spawn("node", ["qa/records-phase5-fake.mjs", "--port", "15322"], { cwd: ROOT, windowsHide: true, stdio: ["ignore", fakeLog, fakeLog], env }), "fake");
  if (!fakeProc.pid) throw new Error("fake spawn failed");
  children.push(fakeProc);
  const apiProc = attachSpawnError(spawn("dotnet", [dllP], { cwd: PUB, windowsHide: true, stdio: ["ignore", apiLog, apiLog], env }), "api");
  if (!apiProc.pid) throw new Error("api spawn failed");
  children.push(apiProc);
  console.log("fake pid=" + fakeProc.pid + " api pid=" + apiProc.pid + " src=" + (srcSha || "unknown").slice(0, 8) + " artifact=" + dllP);
  proof = await prove();
  console.log("sanitized host: CONTENTROOT=" + env.DOTNET_CONTENTROOT + " hooksabsent=" + ((("DOTNET_STARTUP_HOOKS" in env) || ("NODE_OPTIONS" in env) || Object.keys(env).some((k) => k.indexOf("NODE_") === 0)) ? "BAD" : "absent") + " leakedotnet=" + Object.keys(env).filter((k) => k !== "DOTNET_CONTENTROOT" && k.indexOf("DOTNET_") === 0).join(",") + " nodeleak=" + Object.keys(env).filter((k) => k === "NODE_OPTIONS" || k.indexOf("NODE_") === 0).join(","));
  console.log("proven owned api/fake boot=" + String(proof.boot).slice(0, 8) + " chatBefore=" + proof.chatBefore);
  checkTotal("http-suite");
  const httpR = spawnSync("node", ["qa/records-phase5-onedoc.mjs"], { cwd: ROOT, env: suiteEnv({}), stdio: "inherit", timeout: Math.min(480000, Math.max(1000, TOTAL_BUDGET_MS - (Date.now() - TOTAL_START) - 120000)) });
  if (httpR.status !== 0) throw new Error("HTTP suite failed status=" + httpR.status);
  console.log("HTTP suite passed");
  fs.mkdirSync(path.join(ROOT, ".tmp", "records-phase5-shots"), { recursive: true });
  checkTotal("browser-suite");
  const browserStartMs = Date.now();
  const browserRemainingMs = TOTAL_BUDGET_MS - (browserStartMs - TOTAL_START);
  const nominalBrowserMs = 960000;
  if (browserRemainingMs - RECORDS_QA_PARENT_RESERVE_MS < 60000) throw new Error("TOTAL insufficient remaining for browser suite reserve");
  const browserParentTimeoutMs = Math.min(nominalBrowserMs, browserRemainingMs - RECORDS_QA_PARENT_RESERVE_MS);
  if (browserParentTimeoutMs < 60000) throw new Error("TOTAL insufficient remaining for browser suite window");
  const browserWorkDeadlineEpochMs = browserStartMs + browserParentTimeoutMs - RECORDS_QA_CLEANUP_MS;
  console.log("browser cooperative deadline epochMs=" + browserWorkDeadlineEpochMs + " parentTimeoutMs=" + browserParentTimeoutMs + " cleanupMs=" + RECORDS_QA_CLEANUP_MS);
  const browserR = spawnSync("node", ["qa/browser/records-phase5-onedoc-ui.cjs"], { cwd: ROOT, env: suiteEnv({ QA_SHOTS: ".tmp/records-phase5-shots", RECORDS_QA_WORK_DEADLINE_EPOCH_MS: String(browserWorkDeadlineEpochMs), RECORDS_QA_CLEANUP_MS: String(RECORDS_QA_CLEANUP_MS) }), stdio: "inherit", timeout: browserParentTimeoutMs });
  if (browserR.status !== 0) throw new Error("browser suite failed status=" + browserR.status);
  console.log("browser suite passed");
  checkTotal("final-success");
  console.log("TOTAL guard passed at final success elapsedMs=" + (Date.now() - TOTAL_START));
}
try {
  await main();
} catch (e) {
  console.error("LAUNCHER FAIL " + String((e && e.stack) || e).slice(0, 500));
  exitCode = 1;
  if (String((e && e.message) || "").startsWith("REFUSE") || String(e).includes("REFUSE")) exitCode = 2;
  else if (totalExpired()) exitCode = 3;
  else if (/BUILD|HTTP suite|browser suite|PROOF/.test(String((e && e.message) || ""))) exitCode = 1;
} finally {
  const ok = await cleanupOnce();
  if (!ok) exitCode = 1;
  console.log("LAUNCHER done instance=" + INST + " exit=" + exitCode);
  process.exit(exitCode);
}
