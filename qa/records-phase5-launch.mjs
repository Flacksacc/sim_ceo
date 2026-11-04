import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MAINTMP = path.dirname(ROOT);
const API = "http://127.0.0.1:15320";
const FAKE = "http://127.0.0.1:15322";
const WEB = API;
const INST = "muse-r597-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 5);
const KEY = "qa-only-muse-r597";
const PUB = path.join(ROOT, ".qa", "publish");
const KEYRING = path.join(ROOT, ".qa", "keyring-muse-r597-" + Date.now().toString(36));
const LOGP = (n) => path.join(MAINTMP, "muse-r597-" + INST + "-" + n + ".log");
function refuse(m) { console.error("REFUSE " + m); process.exit(2); }
function checkUrl(v, want, name) {
  let u; try { u = new URL(v); } catch { refuse("bad " + name); }
  if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") refuse("non loopback " + name);
  if (Number(u.port) !== want) refuse(name + " must be 127.0.0.1:" + want + " got " + v);
  if (u.search || u.hash || u.username || u.password) refuse(name + " no query/fragment/userinfo");
}
for (const bad of [":5080", ":5173", ":9333", ":15180"]) {
  if (API.includes(bad) || FAKE.includes(bad) || WEB.includes(bad)) refuse("human port " + bad);
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
function run(cmd, args, opts) {
  const r = spawnSync(cmd, args, { ...(opts || {}) });
  if (r.status !== 0) { console.error("BUILD FAIL " + cmd + " " + (args || []).join(" ")); process.exit(1); }
  return r;
}
async function boundedWait(child, ms) {
  if (!child || child.exitCode !== null) return;
  await Promise.race([new Promise((res) => { try { child.once("exit", () => res(0)); } catch { res(0); } }), new Promise((res) => setTimeout(() => res(0), ms))]);
}
async function cleanup() {
  if (cleaned) return; cleaned = true;
  for (const c of children) { try { if (c && c.exitCode === null) c.kill(); } catch {} }
  for (const c of children) { try { await boundedWait(c, 5000); } catch {} }
  try {
    const b1 = await portBusy(15320); const b2 = await portBusy(15322);
    if (b1 || b2) console.error("WARN ports still bound after cleanup");
    else console.log("ports closed verified");
  } catch {}
}
async function prove() {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
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
  console.error("PROOF TIMEOUT api/fake provenance");
  process.exit(2);
}
function suiteEnv(extra) {
  return { ...process.env, QA_API: API, QA_FAKE: FAKE, QA_WEB: WEB, SIMCEO_INSTANCE: INST, QA_PROVENANCE: INST, META_API_BASE: FAKE, META_API_KEY: KEY, QA_FAKE_BOOT: proof.boot, ...(extra || {}) };
}
let proof = null;
async function main() {
  console.log("LAUNCHER instance=" + INST);
  if (await portBusy(15320)) refuse("API port busy");
  if (await portBusy(15322)) refuse("FAKE port busy");
  console.log("publish api...");
  run("dotnet", ["publish", "server/SimCEO.Api/SimCEO.Api.csproj", "-c", "Release", "-o", ".qa/publish", "--nologo", "-v", "q"], { cwd: ROOT });
  run("cmd.exe", ["/c", "npm", "--prefix", "web", "run", "build"], { cwd: ROOT });
  fs.mkdirSync(path.join(PUB, "wwwroot"), { recursive: true });
  fs.cpSync(path.join(ROOT, "web", "dist"), path.join(PUB, "wwwroot"), { recursive: true, force: true });
  fs.mkdirSync(KEYRING, { recursive: true });
  console.log("staged wwwroot from dist");
  const apiLog = fs.openSync(LOGP("api"), "a"); const fakeLog = fs.openSync(LOGP("fake"), "a");
  const fakeProc = spawn("node", ["qa/records-phase5-fake.mjs", "--port", "15322"], { cwd: ROOT, windowsHide: true, stdio: ["ignore", fakeLog, fakeLog] });
  children.push(fakeProc);
  const apiProc = spawn("dotnet", [path.join(PUB, "SimCEO.Api.dll")], { cwd: PUB, windowsHide: true, stdio: ["ignore", apiLog, apiLog], env: { ...process.env, SIMCEO_INSTANCE: INST, USE_POSTGRES: "0", META_API_BASE: FAKE, META_API_KEY: KEY, WIKI_KEYRING_DIR: KEYRING, ASPNETCORE_URLS: API } });
  children.push(apiProc);
  console.log("fake pid=" + fakeProc.pid + " api pid=" + apiProc.pid);
  proof = await prove();
  console.log("proven owned api/fake boot=" + String(proof.boot).slice(0, 8) + " chatBefore=" + proof.chatBefore);
  const httpR = spawnSync("node", ["qa/records-phase5-onedoc.mjs"], { cwd: ROOT, env: suiteEnv({}), stdio: "inherit" });
  if (httpR.status !== 0) { console.error("HTTP suite failed status=" + httpR.status); await cleanup(); process.exit(httpR.status || 1); }
  console.log("HTTP suite passed");
  fs.mkdirSync(path.join(ROOT, ".tmp", "records-phase5-shots"), { recursive: true });
  const browserR = spawnSync("node", ["qa/browser/records-phase5-onedoc-ui.cjs"], { cwd: ROOT, env: suiteEnv({ QA_SHOTS: ".tmp/records-phase5-shots" }), stdio: "inherit" });
  if (browserR.status !== 0) { console.error("browser suite failed status=" + browserR.status); await cleanup(); process.exit(browserR.status || 1); }
  console.log("browser suite passed");
  await cleanup();
  console.log("LAUNCHER done instance=" + INST);
}
main().catch(async (e) => { console.error("LAUNCHER FATAL " + String((e && e.stack) || e).slice(0, 300)); try { await cleanup(); } catch {} process.exit(1); });
