// qa/own-local-stack.mjs - OWN local QA stack launcher (Muse sole-QA author only).
// Owns EXACTLY loopback API 127.0.0.1:15396 + integrated fake 127.0.0.1:15398.
// No PG, Docker, human ports (5173/15180/9333), shared ports, .env reads, or real
// providers are touched. Primary owns the monolith/contract original root;
// this helper + its hardening doc are the ONLY files Muse edits this round.
// Hardening (closes parent advisor-2adbcde findings 1,3,4,5 + helper 6):
//  (1) CIM tri-state absent vs UNAVAILABLE; initial identity MUST match expected
//      absolute exe+args (API absolute DLL via dotnet, fake absolute .mjs via node);
//      later compares ALL of CreationDate/CommandLine/ExecutablePath (never
//      process-name-only); unavailable retains recovery metadata, never treated
//      as dead; PID reuse is refused, never killed.
//  (3) Controlled env allowlist: purges PG/Kestrel/endpoint families incl
//      DOTNET_CONTENTROOT / *STARTUP_HOOKS* / ASPNETCORE_CONTENTROOT (case-prefix),
//      any KESTREL substring; published appsettings*.json in publish dir ONLY is
//      rejected on any Kestrel key (any case, flattened __ / : syntax, ASP.NET
//      case-insensitive semantics); malformed JSON refuses; no appsettings from
//      external roots (content root is publish dir, CONTENTROOT env purged).
//  (4) Post-spawn supervision installed IMMEDIATELY, unconditional try/finally,
//      active for the FULL controller lifetime (no deadline gate on sibling
//      handling); every boot-expiry / sibling-error / any-exit / signal path uses
//      a SEPARATE fresh cleanup deadline; cleanup result controls exit code and
//      retains failure metadata with verified exit (absent confirmed, unavailable
//      preserved).
//  (5) Build-time provenance: `build` (alias `publish`) stages fresh controlled
//      npm web + dotnet publish, records actual PRODUCTION input hashes + runtime
//      DLL/deps/runtimeconfig/appsettings + ALL served JS/CSS + wwwroot index,
//      source commit + dirty list, QA/fake/helper hashes, builder versions.
//      `start` requires a SUCCESSFUL build manifest, re-hashes CURRENT
//      inputs/artifacts (never trusts an old DLL hash), attaches fresh HEAD,
//      records nonce + controller PID + exact launched child identities for QA
//      consumption. No secrets/.env reads; only existence-checks of unapproved
//      env names before build (values never logged).
// All child launches use bounded array args + windowsHide (no shell injection).
import { spawn, spawnSync } from "node:child_process";
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
const BUILD_MANIFESTFILE = path.join(OWN, "build-manifest.json");
const FAILFILE = path.join(OWN, "pids.failed.json");
const WEB = "http://127.0.0.1:" + API_PORT;
const FAKE = "http://127.0.0.1:" + FAKE_PORT;
const EXPECTED_API_DLL = path.resolve(API_DIR, "SimCEO.Api.dll");
const EXPECTED_FAKE_JS = path.resolve(REPO, "qa", "advisor-integrated-fake.mjs");
const START_BUDGET_MS = 120000;
const STOP_BUDGET_MS = 25000;
const BUILD_BUDGET_MS = 600000;
const FRESH_CLEANUP_MS = 15000;
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
const KEEP_ENV = new Set(["USE_POSTGRES","ASPNETCORE_URLS","META_API_BASE","META_API_KEY","SIMCEO_INSTANCE","WIKI_KEYRING_DIR","ASPNETCORE_ENVIRONMENT"]);
function isBlockedEnvKey(k) {
  const u = String(k).toUpperCase();
  if (KEEP_ENV.has(k)) return false;
  if (u.includes("KESTREL")) return true;
  if (u.startsWith("CONNECTIONSTRINGS__")) return true;
  if (u.startsWith("ENDPOINTS__")) return true;
  if (u.startsWith("POSTGRES") || u.startsWith("PG") || u.startsWith("NPGSQL")) return true;
  if (u.startsWith("ASPNETCORE_HTTPS")) return true;
  if (u.startsWith("ASPNETCORE_CONTENTROOT")) return true;
  if (u.startsWith("DOTNET_CONTENTROOT")) return true;
  if (u.includes("STARTUP_HOOKS")) return true;
  if (u.startsWith("DOTNET_URLS") || u.startsWith("DOTNET_HTTPS")) return true;
  if (u.startsWith("DOTNET_") && (u.includes("URL") || u.includes("HTTPS") || u.includes("KESTREL") || u.includes("CONTENTROOT") || u.includes("STARTUP"))) return true;
  if (u.startsWith("ASPNETCORE_") && (u.includes("URL") || u.includes("HTTPS") || u.includes("ENDPOINT") || u.includes("CONTENTROOT"))) return true;
  if (u.startsWith("HTTPS_")) return true;
  return false;
}
function apiEnv() {
  const e = Object.assign({}, process.env);
  for (const k of Object.keys(e)) { if (isBlockedEnvKey(k)) delete e[k]; }
  e.ASPNETCORE_URLS = "http://127.0.0.1:" + API_PORT;
  e.META_API_BASE = "http://127.0.0.1:" + FAKE_PORT;
  e.META_API_KEY = QA_KEY;
  e.SIMCEO_INSTANCE = EXPECTED_INSTANCE;
  e.WIKI_KEYRING_DIR = KEYRING;
  e.ASPNETCORE_ENVIRONMENT = "Production";
  e.USE_POSTGRES = "0";
  return e;
}
function assertControlledEnv(e) {
  if (e.META_API_KEY !== QA_KEY) { console.log("FATAL QA key not forced"); process.exit(2); }
  if (e.USE_POSTGRES !== "0") { console.log("FATAL USE_POSTGRES not 0"); process.exit(2); }
  for (const k of Object.keys(e)) {
    const u = String(k).toUpperCase();
    if (u.includes("KESTREL")) { console.log("FATAL uncontrolled Kestrel env survives: " + k); process.exit(2); }
    if (u.startsWith("DOTNET_CONTENTROOT") || u.startsWith("ASPNETCORE_CONTENTROOT") || u.includes("STARTUP_HOOKS")) { console.log("FATAL uncontrolled contentroot/startup env survives: " + k); process.exit(2); }
  }
}
function existenceCheckUnapprovedBeforeBuild() {
  const names = Object.keys(process.env);
  const flagged = names.filter((k) => isBlockedEnvKey(k));
  const secrets = ["META_API_KEY","OPENAI_API_KEY","ANTHROPIC_API_KEY","META_API_BASE","CONNECTIONSTRINGS__APP","POSTGRES_PASSWORD","DOTNET_CONTENTROOT","ASPNETCORE_CONTENTROOT"];
  const presentSecrets = secrets.filter((k) => Object.prototype.hasOwnProperty.call(process.env, k));
  if (flagged.length > 0 || presentSecrets.length > 0) {
    const uniq = Array.from(new Set([...flagged, ...presentSecrets])).sort();
    console.log("build env note: unapproved names present (names only, values never read): " + uniq.join(","));
  } else { console.log("build env note: no unapproved names present"); }
}
function procIdentity(pid, timeoutMs) {
  pid = Number(pid);
  if (!Number.isInteger(pid) || pid <= 0) return { status: "absent", pid: pid, creation: "", cmd: "", exe: "" };
  timeoutMs = Number(timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = 8000;
  timeoutMs = Math.max(1000, Math.min(8000, Math.floor(timeoutMs)));
  const ps = "Get-CimInstance Win32_Process -Filter \"ProcessId=" + pid + "\" | Select-Object ProcessId,CreationDate,CommandLine,ExecutablePath | ConvertTo-Json -Compress";
  let r;
  try {
    r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: timeoutMs, windowsHide: true, encoding: "utf8" });
  } catch (e) { return { status: "unavailable", pid: pid, creation: "", cmd: "", exe: "", error: "spawn-threw" }; }
  if (!r || r.error) return { status: "unavailable", pid: pid, creation: "", cmd: "", exe: "", error: String((r && r.error && r.error.message) || "spawn-error").slice(0, 80) };
  if (r.signal) return { status: "unavailable", pid: pid, creation: "", cmd: "", exe: "", error: "signal" };
  const out = String((r.stdout || "")).trim();
  if (r.status !== 0) { return { status: "unavailable", pid: pid, creation: "", cmd: "", exe: "", error: "cim-exit-" + r.status }; }
  if (out === "" || out === "null") return { status: "absent", pid: pid, creation: "", cmd: "", exe: "" };
  let j = null;
  try { j = JSON.parse(out); } catch (e) { return { status: "unavailable", pid: pid, creation: "", cmd: "", exe: "", error: "cim-parse" }; }
  if (Array.isArray(j)) { j = j.find((x) => x && Number(x.ProcessId) === pid) || null; }
  if (!j || Number(j.ProcessId) !== pid) return { status: "absent", pid: pid, creation: "", cmd: "", exe: "" };
  const creation = String(j.CreationDate || "");
  const cmd = String(j.CommandLine || "");
  const exe = String(j.ExecutablePath || "");
  if (creation === "" || cmd === "" || exe === "") return { status: "unavailable", pid: pid, creation: creation, cmd: cmd, exe: exe, error: "identity-incomplete" };
  return { status: "alive", pid: pid, creation: creation, cmd: cmd, exe: exe };
}
function procIdentityBounded(pid, deadline) {
  const rem = Number(deadline) - Date.now();
  if (!(rem > 0)) return { status: "unavailable", pid: Number(pid), creation: "", cmd: "", exe: "", error: "cleanup-deadline-exceeded" };
  try { return procIdentity(pid, Math.min(8000, rem)); } catch (e) { return { status: "unavailable", pid: Number(pid), creation: "", cmd: "", exe: "", error: "cim-threw" }; }
}
function procNameFallback(pid) {
  try {
    const r = spawnSync("tasklist.exe", ["/FI", "PID eq " + Number(pid), "/FO", "CSV", "/NH"], { timeout: 8000, windowsHide: true, encoding: "utf8" });
    const out = String((r && r.stdout) || "");
    const m = out.match(/"([^"]+)","(\d+)"/);
    if (m && Number(m[2]) === Number(pid)) return m[1];
    return "";
  } catch (e) { return ""; }
}
function baseNameLower(p) { try { const b = String(p).split(/[\\/]/).pop() || ""; return b.toLowerCase(); } catch { return ""; } }
let _dotnetAbs = ""; let _whereTried = false;
function whichAbs(cmd) { try { const r = spawnSync("where.exe", [cmd], { timeout: 8000, windowsHide: true, encoding: "utf8" }); const l = String((r && r.stdout) || "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean); for (const c of l) { try { if (fs.existsSync(c)) return c; } catch {} } return l.length ? l[0] : ""; } catch { return ""; } }
function dotnetHostAbs() { if (_dotnetAbs) return _dotnetAbs; if (!_whereTried) { _whereTried = true; const w = whichAbs("dotnet.exe") || whichAbs("dotnet"); if (w) _dotnetAbs = w; } if (!_dotnetAbs) _dotnetAbs = "dotnet"; return _dotnetAbs; }
function nodeHostAbs() { try { if (process.execPath && fs.existsSync(process.execPath)) return process.execPath; } catch {} return "node"; }
function apiHostAbs() { return dotnetHostAbs(); }
function fakeHostAbs() { return nodeHostAbs(); }
function normPathLower(v) { try { return String(v || "").replace(/\//g, "\\").toLowerCase(); } catch { return ""; } }
function splitArgv(cmd) { const out = []; let cur = ""; let q = null; const t = String(cmd || ""); for (let i = 0; i < t.length; i++) { const c = t[i]; if (q) { if (c === q) q = null; else cur += c; } else if (c === "\"" || c === "'") q = c; else if (/\s/.test(c)) { if (cur !== "") { out.push(cur); cur = ""; } } else cur += c; } if (cur !== "") out.push(cur); return out; }
function argvEqualsExact(kind, cmdStr, exeAbs, expectedArgs) { const toks = splitArgv(cmdStr); if (toks.length < 1) return false; const hostTok = normPathLower(toks[0]); const hostExp = normPathLower(exeAbs); const hostBaseOk = (kind === "api") ? (hostTok.endsWith("dotnet") || hostTok.endsWith("dotnet.exe")) : (hostTok.endsWith("node") || hostTok.endsWith("node.exe")); if (!hostBaseOk) return false; if (hostExp && hostExp !== "" && hostExp !== "dotnet" && hostExp !== "node") { if (hostTok !== hostExp) return false; } const rest = toks.slice(1); const norm = rest.map((x) => String(x)); const expN = expectedArgs.map((x) => String(x)); if (norm.length === expN.length && norm.every((v, i) => normPathLower(v) === normPathLower(expN[i]))) return true; if (kind === "fake" && norm.length === 2 && normPathLower(norm[0]) === normPathLower(expectedArgs[0]) && /^--port=15398$/i.test(norm[1]) && expectedArgs[1] === "--port" && expectedArgs[2] === String(15398)) return true; return false; }
function expectedApiArgs() { return [EXPECTED_API_DLL]; }
function expectedFakeArgs() { return [EXPECTED_FAKE_JS, "--port", String(FAKE_PORT)]; }
function validateInitialIdentity(kind, ident, expectedAbs) {
  if (!ident || ident.status !== "alive") return false;
  if (ident.status === "unavailable") return false;
  const exeAbs = String(ident.exe || "");
  if (!path.isAbsolute(exeAbs)) return false;
  let resolvedExe = "";
  try { resolvedExe = path.resolve(exeAbs); } catch { return false; }
  if (!path.isAbsolute(resolvedExe)) return false;
  if (!expectedAbs || !path.isAbsolute(String(expectedAbs))) return false;
  let resolvedExp = "";
  try { resolvedExp = path.resolve(String(expectedAbs)); } catch { return false; }
  const base = baseNameLower(resolvedExe);
  let hostAbs = "";
  let wantArgs = null;
  if (kind === "api") { if (!(base === "dotnet" || base === "dotnet.exe")) return false; hostAbs = apiHostAbs(); wantArgs = expectedApiArgs(); }
  else if (kind === "fake") { if (!(base === "node" || base === "node.exe")) return false; hostAbs = fakeHostAbs(); wantArgs = expectedFakeArgs(); }
  else return false;
  let resolvedHost = hostAbs;
  try { if (path.isAbsolute(String(hostAbs))) resolvedHost = path.resolve(String(hostAbs)); } catch {}
  const exeLow = normPathLower(resolvedExe);
  const hostLow = (resolvedHost && String(resolvedHost) !== "dotnet" && String(resolvedHost) !== "node") ? normPathLower(resolvedHost) : "";
  if (hostLow && exeLow !== hostLow) return false;
  const cmdStr = String(ident.cmd || "");
  if (!cmdStr) return false;
  if (!argvEqualsExact(kind, cmdStr, resolvedHost, wantArgs)) return false;
  const cmdLow = cmdStr.toLowerCase();
  if (cmdLow.indexOf(String(resolvedExp).toLowerCase()) < 0) return false;
  return true;
}
function identityMatches(recorded, current, wantKind) {
  if (!recorded || !current) return false;
  if (recorded.status !== "alive" || current.status !== "alive") return false;
  if (String(recorded.creation || "") === "" || String(current.creation || "") === "") return false;
  if (String(recorded.creation) !== String(current.creation)) return false;
  const rc = String(recorded.cmd || ""), cc = String(current.cmd || "");
  if (!rc || !cc || rc !== cc) return false;
  const re = String(recorded.exe || ""), ce = String(current.exe || "");
  if (!re || !ce || re.toLowerCase() !== ce.toLowerCase()) return false;
  const base = baseNameLower(ce);
  if (wantKind === "api" && !(base === "dotnet" || base === "dotnet.exe")) return false;
  if (wantKind === "fake" && !(base === "node" || base === "node.exe")) return false;
  return true;
}
function runBounded(file, args, opts) {
  const o = Object.assign({ windowsHide: true }, opts || {});
  o.windowsHide = true;
  return spawnSync(file, args, o);
}
function sourceCommit() {
  try {
    const r = runBounded("git", ["rev-parse", "HEAD"], { cwd: REPO, timeout: 8000, encoding: "utf8" });
    const out = String((r.stdout || "")).trim();
    if (r.status !== 0 || !/^[0-9a-f]{40}$/i.test(out)) return "unknown";
    return out.toLowerCase();
  } catch (e) { return "unknown"; }
}
function sourceDirtyList() {
  try {
    const r = runBounded("git", ["status", "--porcelain"], { cwd: REPO, timeout: 8000, encoding: "utf8" });
    if (r.status !== 0) return { dirty: true, files: ["git-status-failed"], unknown: true };
    const lines = String(r.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean);
    return { dirty: lines.length > 0, files: lines.slice(0, 200) };
  } catch (e) { return { dirty: true, files: ["git-status-threw"], unknown: true }; }
}
function sha256File(p) { try { const b = fs.readFileSync(p); return crypto.createHash("sha256").update(b).digest("hex"); } catch (e) { return ""; } }
function listFilesRecursive(dir, exts) {
  const out = [];
  try {
    const stack = [dir];
    while (stack.length > 0) {
      const d = stack.pop();
      let entries = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { continue; }
      for (const en of entries) {
        const full = path.join(d, en.name);
        if (en.isDirectory()) stack.push(full);
        else if (en.isFile()) {
          const low = en.name.toLowerCase();
          if (exts.length === 0 || exts.some((x) => low.endsWith(x))) out.push(full);
        }
      }
    }
  } catch (e) {}
  out.sort();
  return out;
}
function prodInputFiles() {
  const files = [];
  const pushIf = (p) => { try { if (fs.statSync(p).isFile()) files.push(p); } catch (e) {} };
  pushIf(path.join(REPO, "SimCEO.sln"));
  pushIf(path.join(REPO, "NuGet.Config"));
  pushIf(path.join(REPO, "server", "SimCEO.Api", "SimCEO.Api.csproj"));
  pushIf(path.join(REPO, "server", "SimCEO.Api", "Program.cs"));
  pushIf(path.join(REPO, "server", "SimCEO.Postgres", "SimCEO.Postgres.csproj"));
  pushIf(path.join(REPO, "web", "package.json"));
  pushIf(path.join(REPO, "web", "package-lock.json"));
  pushIf(path.join(REPO, "web", "tsconfig.json"));
  pushIf(path.join(REPO, "web", "vite.config.ts"));
  pushIf(path.join(REPO, "web", "index.html"));
  pushIf(path.join(REPO, "web", "boardroom-template.html"));
  pushIf(path.join(REPO, "web", "human-mount.html"));
  try { for (const f of fs.readdirSync(path.join(REPO, "web", "public"))) pushIf(path.join(REPO, "web", "public", f)); } catch (e) {}
  try { for (const f of fs.readdirSync(path.join(REPO, "web"))) { if (/^vite\..*\.config\.ts$/i.test(f)) pushIf(path.join(REPO, "web", f)); } } catch (e) {}
  for (const srv of [path.join(REPO, "server", "SimCEO.Api"), path.join(REPO, "server", "SimCEO.Postgres")]) {
    for (const f of listFilesRecursive(srv, [".cs", ".csproj", ".props", ".targets"])) {
      const n = String(f).replace(/\\/g, "/");
      if (n.includes("/bin/") || n.includes("/obj/")) continue;
      files.push(f);
    }
  }
  const webSrc = path.join(REPO, "web", "src");
  for (const f of listFilesRecursive(webSrc, [".ts", ".tsx", ".js", ".jsx", ".css"])) files.push(f);
  return Array.from(new Set(files)).sort();
}
function hashMap(files, baseForKey) {
  const m = {};
  for (const f of files) {
    let key = f;
    try { key = path.relative(baseForKey || REPO, f).replace(/\\/g, "/"); } catch (e) {}
    m[key] = sha256File(f);
  }
  return m;
}
function publishOutputInventory() {
  const dll = path.join(API_DIR, "SimCEO.Api.dll");
  const deps = path.join(API_DIR, "SimCEO.Api.deps.json");
  const rc = path.join(API_DIR, "SimCEO.Api.runtimeconfig.json");
  const idx = path.join(API_DIR, "wwwroot", "index.html");
  const dllSha = sha256File(dll);
  let dllSize = -1;
  try { dllSize = fs.statSync(dll).size; } catch (e) {}
  const jsFiles = listFilesRecursive(path.join(API_DIR, "wwwroot"), [".js"]);
  const cssFiles = listFilesRecursive(path.join(API_DIR, "wwwroot"), [".css"]);
  const appsettings = [];
  try {
    for (const f of fs.readdirSync(API_DIR)) {
      if (/^appsettings.*\.json$/i.test(f)) appsettings.push(path.join(API_DIR, f));
    }
  } catch (e) {}
  appsettings.sort();
  const dllTop = [];
  try { for (const f of fs.readdirSync(API_DIR)) { if (/\.dll$/i.test(f)) dllTop.push(path.join(API_DIR, f)); } } catch (e) {}
  dllTop.sort();
  const allWww = listFilesRecursive(path.join(API_DIR, "wwwroot"), []);
  return { dll, dllSha, dllSize, deps, depsSha: sha256File(deps), rc, rcSha: sha256File(rc), idx, idxSha: sha256File(idx), jsFiles, js: hashMap(jsFiles, API_DIR), cssFiles, css: hashMap(cssFiles, API_DIR), appsettings, appsettingsHashes: hashMap(appsettings, API_DIR), dlls: hashMap(dllTop, API_DIR), wwwrootAll: hashMap(allWww, API_DIR) };
}
function hasKestrelKeyWalk(v) {
  const seen = new Set();
  function keyHits(name) {
    const parts = String(name).split(/__|:/);
    for (const p of parts) { if (p.toLowerCase() === "kestrel") return true; }
    return false;
  }
  function walk(o) {
    if (!o || typeof o !== "object") return false;
    if (seen.has(o)) return false;
    seen.add(o);
    if (Array.isArray(o)) { for (const el of o) { if (walk(el)) return true; } return false; }
    for (const k of Object.keys(o)) {
      if (keyHits(k)) return true;
      if (walk(o[k])) return true;
    }
    return false;
  }
  return walk(v);
}
function verifyPublishedEndpointConfigStrict() {
  let files = [];
  try { files = fs.readdirSync(API_DIR).filter((f) => /^appsettings.*\.json$/i.test(f)); } catch (e) { files = []; }
  files.sort();
  for (const f of files) {
    const full = path.join(API_DIR, f);
    let txt = "";
    try { txt = fs.readFileSync(full, "utf8"); } catch (e) { console.log("FATAL cannot read published config " + f); process.exit(2); }
    if (txt.trim() === "") continue;
    let j = null;
    try { j = JSON.parse(txt); }
    catch (e) { console.log("FATAL malformed published JSON refusing (" + f + ")"); process.exit(2); }
    if (hasKestrelKeyWalk(j)) { console.log("FATAL published endpoint config present in " + f + " (refusing uncontrolled listeners)"); process.exit(2); }
    const flatHits = Object.keys(j || {}).filter((k) => /kestrel/i.test(k));
    if (flatHits.length > 0 && hasKestrelKeyWalk(j)) { console.log("FATAL published flattened endpoint config in " + f); process.exit(2); }
  }
}
function writeBuildManifest(success, extra, pre) {
  const commit = (pre && pre.commit) || sourceCommit();
  const dirty = (pre && pre.dirty) || sourceDirtyList();
  const inputs = (pre && pre.inputs) || prodInputFiles();
  const inputsCaptured = (pre && pre.inputs) ? "pre-build" : "at-write";
  const inv = publishOutputInventory();
  const qaFile = path.join(REPO, "qa", "advisor-integrated-qa.mjs");
  const fakeFile = EXPECTED_FAKE_JS;
  const helperFile = path.join(REPO, "qa", "own-local-stack.mjs");
  let nodeV = "", dotnetV = "";
  try { nodeV = String(runBounded("node", ["--version"], { timeout: 8000, encoding: "utf8" }).stdout || "").trim(); } catch (e) {}
  try { dotnetV = String(runBounded("dotnet", ["--version"], { timeout: 15000, encoding: "utf8" }).stdout || "").trim(); } catch (e) {}
  const m = {
    version: 1, kind: "own-build-manifest", success: !!success, at: Date.now(),
    commit: commit, dirty: dirty.dirty, dirtyFiles: dirty.files,
    nodeVersion: nodeV, dotnetVersion: dotnetV, builderPid: process.pid,
    inputs: hashMap(inputs, REPO),
    inputsCaptured: inputsCaptured,
    outputs: { dllSha: inv.dllSha, dllSize: inv.dllSize, depsSha: inv.depsSha, rcSha: inv.rcSha, wwwrootSha: inv.idxSha, js: inv.js, css: inv.css, appsettings: inv.appsettingsHashes, dlls: inv.dlls, wwwrootAll: inv.wwwrootAll },
    qaSha: sha256File(qaFile), fakeSha: sha256File(fakeFile), helperSha: sha256File(helperFile),
    error: (extra && extra.error) || ""
  };
  try { fs.mkdirSync(OWN, { recursive: true }); } catch (e) {}
  try { fs.writeFileSync(BUILD_MANIFESTFILE, JSON.stringify(m, null, 2)); } catch (e) { console.log("FATAL build manifest write failed"); process.exit(2); }
  return m;
}
function verifyBuildManifestForStart() {
  let b = null;
  try { b = JSON.parse(fs.readFileSync(BUILD_MANIFESTFILE, "utf8")); } catch (e) { console.log("FATAL missing build manifest (run `node qa/own-local-stack.mjs build` before start)"); process.exit(2); }
  if (!b || b.success !== true || b.version !== 1) { console.log("FATAL unsuccessful build manifest (rebuild before start)"); process.exit(2); }
  if (!b.commit || b.commit === "unknown" || !/^[0-9a-f]{40}$/i.test(String(b.commit))) { console.log("FATAL build manifest commit invalid"); process.exit(2); }
  verifyPublishedEndpointConfigStrict();
  const inv = publishOutputInventory();
  if (!inv.dllSha || !inv.idxSha) { console.log("FATAL publish missing (rebuild before start)"); process.exit(2); }
  if (inv.dllSha !== b.outputs.dllSha) { console.log("FATAL current DLL differs from successful build manifest (rebuild before start)"); process.exit(2); }
  if (inv.idxSha !== b.outputs.wwwrootSha) { console.log("FATAL current wwwroot differs from build manifest (rebuild before start)"); process.exit(2); }
  const curJs = JSON.stringify(inv.js), recJs = JSON.stringify(b.outputs.js || {});
  if (curJs !== recJs) { console.log("FATAL current served JS differs from build manifest (rebuild before start)"); process.exit(2); }
  const curCss = JSON.stringify(inv.css), recCss = JSON.stringify(b.outputs.css || {});
  if (curCss !== recCss) { console.log("FATAL current served CSS differs from build manifest (rebuild before start)"); process.exit(2); }
  const curQa = sha256File(path.join(REPO, "qa", "advisor-integrated-qa.mjs"));
  if (!b.inputs || typeof b.inputs !== "object" || Array.isArray(b.inputs)) { console.log("FATAL build manifest missing production input hashes (rebuild before start)"); process.exit(2); }
  const curInputs = hashMap(prodInputFiles(), REPO);
  if (JSON.stringify(curInputs) !== JSON.stringify(b.inputs)) { console.log("FATAL current production inputs differ from successful build manifest (rebuild before start)"); process.exit(2); }
  if (!inv.depsSha || inv.depsSha !== b.outputs.depsSha) { console.log("FATAL current deps.json differs from build manifest (rebuild before start)"); process.exit(2); }
  if (!inv.rcSha || inv.rcSha !== b.outputs.rcSha) { console.log("FATAL current runtimeconfig differs from build manifest (rebuild before start)"); process.exit(2); }
  const curApps = JSON.stringify(inv.appsettingsHashes), recApps = JSON.stringify(b.outputs.appsettings || {});
  if (curApps !== recApps) { console.log("FATAL current appsettings differ from build manifest (rebuild before start)"); process.exit(2); }
  if (JSON.stringify(inv.dlls) !== JSON.stringify(b.outputs.dlls || {})) { console.log("FATAL current publish DLL set differs from build manifest (rebuild before start)"); process.exit(2); }
  if (JSON.stringify(inv.wwwrootAll) !== JSON.stringify(b.outputs.wwwrootAll || {})) { console.log("FATAL current served wwwroot files differ from build manifest (rebuild before start)"); process.exit(2); }
  const curFake = sha256File(EXPECTED_FAKE_JS);
  const curHelper = sha256File(path.join(REPO, "qa", "own-local-stack.mjs"));
  if (!curQa || curQa !== b.qaSha) { console.log("FATAL current QA differs from build manifest (rebuild before start)"); process.exit(2); }
  if (!curFake || curFake !== b.fakeSha) { console.log("FATAL current fake differs from build manifest (rebuild before start)"); process.exit(2); }
  if (!curHelper || curHelper !== b.helperSha) { console.log("FATAL current helper differs from build manifest (rebuild before start)"); process.exit(2); }
  const startHead = sourceCommit();
  const startDirty = sourceDirtyList();
  if (startDirty.dirty && !b.dirty) { console.log("FATAL working tree dirty since clean build (rebuild before start)"); process.exit(2); }
  if (!b.dirty && startHead !== b.commit) { console.log("FATAL HEAD moved since build (" + String(b.commit).slice(0,12) + " -> " + String(startHead).slice(0,12) + "); rebuild before start"); process.exit(2); }
  console.log("provenance ok buildCommit=" + String(b.commit).slice(0,12) + " startHead=" + String(startHead).slice(0,12) + " dll=" + inv.dllSha.slice(0,12) + " wwwroot=" + inv.idxSha.slice(0,12));
  return { build: b, inv: inv, startHead: startHead, startDirty: startDirty };
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
async function cleanupFresh(reason, contextPids) {
  const deadline = Date.now() + FRESH_CLEANUP_MS;
  let killed = false;
  try { killed = await killOwnedBounded(deadline); } catch (e) { killed = false; }
  let verified = killed;
  const details = { at: Date.now(), reason: String(reason || "cleanup"), killed: killed, pids: contextPids || null, states: [] };
  try {
    const rec = contextPids || null;
    const pairs = [];
    if (rec) {
      if (Number(rec.apiPid) > 0) pairs.push(["api", Number(rec.apiPid), rec.apiIdent, "api"]);
      if (Number(rec.fakePid) > 0) pairs.push(["fake", Number(rec.fakePid), rec.fakeIdent, "fake"]);
    } else {
      for (const c of owned) { try { pairs.push(["child", c.pid, null, null]); } catch (e) {} }
    }
    for (const t of pairs) {
      const cur = procIdentityBounded(Number(t[1]), deadline);
      details.states.push({ name: String(t[0]), pid: Number(t[1]), status: cur.status });
      if (cur.status === "alive") verified = false;
      if (cur.status === "unavailable") verified = false;
    }
    const rem = deadline - Date.now();
    if (rem > 0) {
      const a = await tcpOk(API_PORT, Math.min(1500, rem));
      const f = await tcpOk(FAKE_PORT, Math.min(1500, deadline - Date.now()));
      details.apiOpen = a; details.fakeOpen = f;
      if (a || f) verified = false;
    } else { details.apiOpen = true; details.fakeOpen = true; verified = false; }
  } catch (e) { verified = false; details.error = String((e && e.message) || e).slice(0, 160); }
  details.verified = verified;
  if (!verified) { try { fs.writeFileSync(FAILFILE, JSON.stringify(details, null, 2)); } catch (e) {} }
  else { try { if (fs.existsSync(FAILFILE)) fs.unlinkSync(FAILFILE); } catch (e) {} }
  return verified;
}
async function cmdBuild() {
  const t0 = Date.now();
  const deadline = t0 + BUILD_BUDGET_MS;
  existenceCheckUnapprovedBeforeBuild();
  try { fs.mkdirSync(LOGDIR, { recursive: true }); } catch (e) {}
  try { fs.mkdirSync(KEYRING, { recursive: true }); } catch (e) {}
  try { fs.mkdirSync(API_DIR, { recursive: true }); } catch (e) {}
  const buildLogPath = path.join(LOGDIR, "build-own.log");
  function logBoth(s) { console.log(s); try { fs.appendFileSync(buildLogPath, "[" + new Date().toISOString() + "] " + s + "\n"); } catch (e) {} }
  logBoth("own build start commit=" + sourceCommit());
  const preCommit = sourceCommit();
  const preDirty = sourceDirtyList();
  const preInputs = prodInputFiles();
  const pre = { commit: preCommit, dirty: preDirty, inputs: preInputs };
  logBoth("pre-build inputs hashed n=" + preInputs.length + " commit=" + String(preCommit).slice(0, 12));
  const webLog = path.join(LOGDIR, "build-web.log");
  let npmCmd = "npm.cmd";
  let npmCli = "";
  try { const r0 = runBounded("where.exe", ["npm.cmd"], { timeout: 8000, encoding: "utf8" }); const l0 = String((r0.stdout || "")).split(/\r?\n/).map((x) => x.trim()).filter(Boolean); if (l0.length > 0) npmCmd = l0[0]; } catch (e) {}
  try { const d = path.dirname(npmCmd); const cand = path.join(d, "node_modules", "npm", "bin", "npm-cli.js"); if (fs.existsSync(cand)) npmCli = cand; } catch (e) {}
  const apiLog = path.join(LOGDIR, "build-api.log");
  try {
    try {
      const nm = "web" + "/node_modules";
      let needCi = true;
      try { needCi = !fs.existsSync("web/node_modules/.package-lock.json") && !fs.existsSync("web/node_modules"); } catch (e) { needCi = true; }
      try { if (fs.existsSync("web/node_modules")) { const t = fs.statSync("web/node_modules").mtimeMs; const pl = fs.statSync("web/package-lock.json").mtimeMs; needCi = pl > t; } } catch (e) { needCi = true; }
      if (needCi) {
        logBoth("step npm ci (controlled, windowsHide, bounded args, no shell)");
        const ciArgs = npmCli ? [npmCli, "--prefix", "web", "ci"] : ["--prefix", "web", "ci"];
        const ciExe = npmCli ? process.execPath : npmCmd;
        const ci = spawn(ciExe, ciArgs, { cwd: REPO, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        let ciOut = "", ciErr = "";
        ci.stdout.on("data", (d) => { ciOut += String(d); });
        ci.stderr.on("data", (d) => { ciErr += String(d); });
        const ciCode = await new Promise((resolve) => { const to = setTimeout(() => { try { ci.kill(); } catch (e) {} resolve(124); }, Math.max(1000, deadline - Date.now())); ci.on("close", (c) => { clearTimeout(to); resolve(c); }); ci.on("error", () => { clearTimeout(to); resolve(127); }); });
        try { fs.appendFileSync(webLog, ciOut + "\n" + ciErr); } catch (e) {}
        if (ciCode !== 0) { logBoth("FATAL npm ci failed code=" + ciCode); writeBuildManifest(false, { error: "npm-ci-" + ciCode }, pre); process.exit(2); }
      } else { logBoth("skip npm ci (node_modules fresh)"); }
    } catch (e) { logBoth("FATAL npm ci threw: " + String((e && e.message) || e).slice(0, 160)); writeBuildManifest(false, { error: "npm-ci-throw" }, pre); process.exit(2); }
    logBoth("step web build (controlled npm.cmd absolute, windowsHide, bounded args, no shell)");
    const wArgs = npmCli ? [npmCli, "--prefix", "web", "run", "build"] : ["--prefix", "web", "run", "build"];
    const wExe = npmCli ? process.execPath : npmCmd;
    const w = spawn(wExe, wArgs, { cwd: REPO, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let wOut = "", wErr = "";
    w.stdout.on("data", (d) => { wOut += String(d); });
    w.stderr.on("data", (d) => { wErr += String(d); });
    const wCode = await new Promise((resolve) => { const to = setTimeout(() => { try { w.kill(); } catch (e) {} resolve(124); }, Math.max(1000, deadline - Date.now())); w.on("close", (c) => { clearTimeout(to); resolve(c); }); w.on("error", () => { clearTimeout(to); resolve(127); }); });
    try { fs.appendFileSync(webLog, wOut + "\n" + wErr); } catch (e) {}
    if (wCode !== 0) { logBoth("FATAL web build failed code=" + wCode); writeBuildManifest(false, { error: "web-build-" + wCode }, pre); process.exit(2); }
    if (Date.now() >= deadline) { logBoth("FATAL build budget exceeded after web"); writeBuildManifest(false, { error: "budget-web" }, pre); process.exit(2); }
    logBoth("step dotnet publish (controlled, windowsHide, bounded args)");
    const a = spawn("dotnet", ["publish", "server/SimCEO.Api/SimCEO.Api.csproj", "-c", "Release", "-o", API_DIR], { cwd: REPO, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let aOut = "", aErr = "";
    a.stdout.on("data", (d) => { aOut += String(d); });
    a.stderr.on("data", (d) => { aErr += String(d); });
    const aCode = await new Promise((resolve) => { const to = setTimeout(() => { try { a.kill(); } catch (e) {} resolve(124); }, Math.max(1000, deadline - Date.now())); a.on("close", (c) => { clearTimeout(to); resolve(c); }); a.on("error", () => { clearTimeout(to); resolve(127); }); });
    try { fs.appendFileSync(apiLog, aOut + "\n" + aErr); } catch (e) {}
    if (aCode !== 0) { logBoth("FATAL dotnet publish failed code=" + aCode); writeBuildManifest(false, { error: "dotnet-publish-" + aCode }, pre); process.exit(2); }
    const distDir = path.join(REPO, "web", "dist");
    const wwwDir = path.join(API_DIR, "wwwroot");
    try {
      if (!fs.existsSync(path.join(distDir, "index.html"))) { logBoth("FATAL web dist missing index.html"); writeBuildManifest(false, { error: "dist-missing" }, pre); process.exit(2); }
      try { fs.rmSync(wwwDir, { recursive: true, force: true }); } catch (e) {}
      fs.mkdirSync(wwwDir, { recursive: true });
      copyDir(distDir, wwwDir);
      logBoth("staged wwwroot from web/dist");
    } catch (e) { logBoth("FATAL wwwroot stage failed: " + String((e && e.message) || e).slice(0, 160)); writeBuildManifest(false, { error: "wwwroot-stage" }, pre); process.exit(2); }
    verifyPublishedEndpointConfigStrict();
    const m = writeBuildManifest(true, {}, pre);
    logBoth("own build ok commit=" + m.commit.slice(0,12) + " dll=" + String(m.outputs.dllSha).slice(0,12) + " wwwroot=" + String(m.outputs.wwwrootSha).slice(0,12) + " elapsed=" + (Date.now() - t0));
  } catch (e) {
    logBoth("FATAL build threw: " + String((e && e.message) || e).slice(0, 200));
    try { writeBuildManifest(false, { error: "throw" }, pre); } catch (ee) {}
    process.exit(2);
  }
}
function copyDir(src, dst) {
  for (const en of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, en.name), d = path.join(dst, en.name);
    if (en.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyDir(s, d); }
    else if (en.isFile()) fs.copyFileSync(s, d);
  }
}
async function cmdStart() {
  const startDeadline = Date.now() + START_BUDGET_MS;
  const controllerPid = process.pid;
  const prov = verifyBuildManifestForStart();
  try { fs.mkdirSync(LOGDIR, { recursive: true }); } catch (e) {}
  try { fs.mkdirSync(KEYRING, { recursive: true }); } catch (e) {}
  let stale = null; try { stale = JSON.parse(fs.readFileSync(PIDFILE, "utf8")); } catch (e) {}
  if (stale && (Number(stale.apiPid) > 0 || Number(stale.fakePid) > 0)) {
    const aCur = procIdentity(Number(stale.apiPid) || 0, Math.max(1000, Math.min(8000, startDeadline - Date.now())));
    const fCur = procIdentity(Number(stale.fakePid) || 0, Math.max(1000, Math.min(8000, startDeadline - Date.now())));
    const aOwned = stale.apiIdent && aCur.status === "alive" && identityMatches(stale.apiIdent, aCur, "api");
    const fOwned = stale.fakeIdent && fCur.status === "alive" && identityMatches(stale.fakeIdent, fCur, "fake");
    if (aOwned || fOwned) { console.log("FATAL refuse: pidfile owns live children (creation-identity match)"); process.exit(2); }
    const aUnav = aCur.status === "unavailable" || fCur.status === "unavailable";
    if (aUnav) { console.log("FATAL stale pidfile identity UNAVAILABLE (cannot prove death); retaining for forensics"); try { fs.writeFileSync(FAILFILE, JSON.stringify({ at: Date.now(), stale: stale, aState: aCur.status, fState: fCur.status })); } catch (e) {} process.exit(2); }
    if ((aCur.status === "alive" && !aOwned && Number(stale.apiPid) > 0) || (fCur.status === "alive" && !fOwned && Number(stale.fakePid) > 0)) {
      console.log("stale pidfile with PID reuse detected (live unrelated process); refusing to kill, removing stale file");
    } else { console.log("stale pidfile (dead pids), removing"); }
    try { fs.unlinkSync(PIDFILE); } catch (e) {}
  }
  const remPorts = startDeadline - Date.now();
  if (remPorts <= 0) { console.log("FATAL start deadline exceeded before port check"); process.exit(2); }
  const aOpen = await tcpOk(API_PORT, Math.min(2000, remPorts));
  const fOpen = await tcpOk(FAKE_PORT, Math.min(2000, startDeadline - Date.now()));
  if (aOpen || fOpen) { console.log("FATAL refuse: occupied ports"); process.exit(2); }
  const env = apiEnv();
  assertControlledEnv(env);
  const nonce = Date.now().toString(36) + "-" + Math.floor(Math.random() * 16777215).toString(16);
  const apiLog = fs.openSync(path.join(LOGDIR, "api-15396.log"), "a");
  const apiErr = fs.openSync(path.join(LOGDIR, "api-15396.err.log"), "a");
  let api = null, fake = null;
  let stopping = false;
  let supervisionActive = true;
  async function failCleanupAndExit(reason, code) {
    if (stopping) return;
    stopping = true; supervisionActive = false;
    for (const c of owned) { try { if (!c.killed && c.exitCode === null) c.kill(); } catch (e) {} }
    const rec = { apiPid: api ? api.pid : 0, fakePid: fake ? fake.pid : 0, apiIdent: null, fakeIdent: null };
    /* kill-first: identity snapshot moved inside cleanupFresh shared deadline; no blocking pre-queries */
    /* kill-first: fake identity snapshot inside cleanupFresh shared deadline */
    console.log("cleanup: " + reason);
    const ok = await cleanupFresh(reason, { apiPid: rec.apiPid, fakePid: rec.fakePid, apiIdent: rec.apiIdent, fakeIdent: rec.fakeIdent });
    if (!ok) { console.log("FATAL cleanup incomplete (see " + FAILFILE + ")"); process.exit(2); }
    process.exit(code || 2);
  }
  try {
    api = track(spawn(apiHostAbs(), [EXPECTED_API_DLL], { cwd: API_DIR, env: env, detached: false, stdio: ["ignore", apiLog, apiErr], windowsHide: true }));
  } catch (e) { console.log("FATAL api spawn threw: " + String((e && e.message) || e).slice(0,160)); await cleanupFresh("api-spawn-throw", null); process.exit(2); }
  try {
    api.on("error", () => { if (supervisionActive && !stopping) failCleanupAndExit("api-error", 2); });
    api.on("exit", () => { if (supervisionActive && !stopping) failCleanupAndExit("api-exit", 2); });
  } catch (e) {}
  let fakeLogFd = null;
  try {
    fakeLogFd = fs.openSync(path.join(LOGDIR, "fake-15398.log"), "a");
    fake = track(spawn(fakeHostAbs(), [EXPECTED_FAKE_JS, "--port", String(FAKE_PORT)], { cwd: REPO, env: process.env, detached: false, stdio: ["ignore", fakeLogFd, fakeLogFd], windowsHide: true }));
  } catch (e) { console.log("FATAL fake spawn threw: " + String((e && e.message) || e).slice(0,160)); await cleanupFresh("fake-spawn-throw", null); process.exit(2); }
  try {
    fake.on("error", () => { if (supervisionActive && !stopping) failCleanupAndExit("fake-error", 2); });
    fake.on("exit", () => { if (supervisionActive && !stopping) failCleanupAndExit("fake-exit", 2); });
  } catch (e) {}
  const onSig = (sig) => {
    if (stopping) return;
    stopping = true; supervisionActive = false;
    console.log("signal cleanup " + sig);
    for (const c of owned) { try { if (!c.killed && c.exitCode === null) c.kill(); } catch (e) {} }
    cleanupFresh("signal-" + sig, { apiPid: api ? api.pid : 0, fakePid: fake ? fake.pid : 0, apiIdent: null, fakeIdent: null /* bounded snapshot inside cleanupFresh shared deadline; kill-first */ }).then((ok) => {
      if (!ok) { console.log("FATAL signal cleanup incomplete"); process.exit(2); }
      process.exit(0);
    }).catch(() => process.exit(2));
  };
  try { process.on("SIGINT", () => onSig("SIGINT")); process.on("SIGTERM", () => onSig("SIGTERM")); } catch (e) {}
  let boot = { ok: false };
  try {
    await sleep(800);
    const apiIdentLive = procIdentity(api.pid, Math.max(1000, Math.min(8000, startDeadline - Date.now())));
    const fakeIdentLive = procIdentity(fake.pid, Math.max(1000, Math.min(8000, startDeadline - Date.now())));
    if (apiIdentLive.status === "unavailable" || fakeIdentLive.status === "unavailable") {
      console.log("FATAL child identity UNAVAILABLE immediately after spawn (retain, no kill ambiguity)");
      try { fs.writeFileSync(FAILFILE, JSON.stringify({ at: Date.now(), api: apiIdentLive, fake: fakeIdentLive })); } catch (e) {}
      await cleanupFresh("identity-unavailable-after-spawn", null);
      process.exit(2);
    }
    if (!validateInitialIdentity("api", apiIdentLive, EXPECTED_API_DLL) || !validateInitialIdentity("fake", fakeIdentLive, EXPECTED_FAKE_JS)) {
      console.log("FATAL child identity MUST mismatch expected absolute exe+args api=" + JSON.stringify({ exe: apiIdentLive.exe, cmd: String(apiIdentLive.cmd).slice(0, 200) }) + " fake=" + JSON.stringify({ exe: fakeIdentLive.exe, cmd: String(fakeIdentLive.cmd).slice(0, 200) }));
      await cleanupFresh("identity-mismatch", null);
      process.exit(2);
    }
    const rec = { apiPid: api.pid, fakePid: fake.pid, apiIdent: apiIdentLive, fakeIdent: fakeIdentLive, startedAt: Date.now(), nonce: nonce, controllerPid: controllerPid, commit: prov.build.commit, startHead: prov.startHead, instance: EXPECTED_INSTANCE, manifest: { dllSha: prov.build.outputs.dllSha, wwwrootSha: prov.build.outputs.wwwrootSha, qaSha: prov.build.qaSha, fakeSha: prov.build.fakeSha, helperSha: prov.build.helperSha } };
    try { fs.writeFileSync(PIDFILE, JSON.stringify(rec)); } catch (e) { console.log("FATAL pidfile write failed"); await cleanupFresh("pidfile-write-fail", null); process.exit(2); }
    try { fs.writeFileSync(RUNFILE, JSON.stringify(rec)); } catch (e) {}
    try { fs.writeFileSync(MANIFESTFILE, JSON.stringify({ nonce: nonce, controllerPid: controllerPid, commit: prov.build.commit, startHead: prov.startHead, at: Date.now(), instance: EXPECTED_INSTANCE, apiPid: api.pid, fakePid: fake.pid, apiIdent: apiIdentLive, fakeIdent: fakeIdentLive, dllSha: prov.build.outputs.dllSha, wwwrootSha: prov.build.outputs.wwwrootSha, qaSha: prov.build.qaSha, fakeSha: prov.build.fakeSha, helperSha: prov.build.helperSha })); } catch (e) {}
    console.log("spawned api=" + api.pid + " fake=" + fake.pid + " nonce=" + nonce + " controller=" + controllerPid);
    try { boot = await waitBoot(startDeadline); }
    catch (e) { console.log("FATAL boot threw: " + String((e && e.message) || e).slice(0,160)); await cleanupFresh("boot-throw", rec); process.exit(2); }
    if (!boot.ok) { console.log("FATAL boot verification failed within deadline"); await cleanupFresh("boot-expiry", rec); process.exit(2); }
    if (boot.fakeEntries !== 0) { console.log("FATAL refuse: fake not fresh"); await cleanupFresh("fake-not-fresh", rec); process.exit(2); }
    console.log("boot ok instance=" + boot.health.instance + " store=" + boot.ready.store + " manifest dll=" + String(prov.build.outputs.dllSha).slice(0,12) + " qa=" + String(prov.build.qaSha).slice(0,12));
  } catch (e) {
    console.log("FATAL start threw: " + String((e && e.message) || e).slice(0, 200));
    try { await cleanupFresh("start-throw", null); } catch (ee) {}
    process.exit(2);
  }
}
async function cmdStop() {
  const stopDeadline = Date.now() + STOP_BUDGET_MS;
  let pids = null; try { pids = JSON.parse(fs.readFileSync(PIDFILE, "utf8")); } catch (e) { console.log("no pidfile; nothing owned to stop"); return; }
  const targets = [["api", pids.apiPid || pids.api, pids.apiIdent, "api"], ["fake", pids.fakePid || pids.fake, pids.fakeIdent, "fake"]];
  let refusedReuse = false;
  let unavailableSeen = false;
  for (const t of targets) {
    const name = String(t[0]); const pid = Number(t[1]); const recorded = t[2]; const kind = String(t[3]);
    if (!pid) continue;
    const cur = procIdentityBounded(pid, stopDeadline);
    if (cur.status === "absent") { console.log("skip " + name + " pid=" + pid + " already dead (absent)"); continue; }
    if (cur.status === "unavailable") {
      const fb = procNameFallback(pid);
      console.log("retain " + name + " pid=" + pid + " identity UNAVAILABLE (query failed; fallback=" + fb + "); not killing, retaining metadata");
      unavailableSeen = true;
      continue;
    }
    if (!recorded || !recorded.creation || recorded.status !== "alive") {
      const fb = procNameFallback(pid);
      console.log("refuse " + name + " pid=" + pid + " (no recorded creation identity; fallback=" + fb + " insufficient for ownership)");
      refusedReuse = true;
      continue;
    }
    if (!identityMatches(recorded, cur, kind)) {
      console.log("refuse " + name + " pid=" + pid + " PID reuse suspected (creation/cmd/exe mismatch; not ours)");
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
  console.log("after-stop apiOpen=" + a2 + " fakeOpen=" + f2 + (refusedReuse ? " refusedReuse=true" : "") + (unavailableSeen ? " unavailable=true" : ""));
  if (a2 || f2) {
    console.log("FATAL ports still open after bounded stop");
    try { fs.writeFileSync(FAILFILE, JSON.stringify({ at: Date.now(), pids: pids, apiOpen: a2, fakeOpen: f2 })); } catch (e) {}
    process.exit(2);
  }
  if (refusedReuse || unavailableSeen) {
    console.log("stop incomplete (reuse refused or identity unavailable); retaining pidfile for forensics");
    try { fs.writeFileSync(FAILFILE, JSON.stringify({ at: Date.now(), pids: pids, refusedReuse: refusedReuse, unavailable: unavailableSeen })); } catch (e) {}
    process.exit(2);
  }
  for (const t of targets) {
    const pid = Number(t[1]);
    if (!pid) continue;
    const cur = procIdentityBounded(pid, stopDeadline);
    if (cur.status === "alive") { console.log("FATAL child still alive after stop pid=" + pid); try { fs.writeFileSync(FAILFILE, JSON.stringify({ at: Date.now(), pids: pids })); } catch (e) {} process.exit(2); }
    if (cur.status === "unavailable") { console.log("FATAL child identity UNAVAILABLE after stop pid=" + pid + " (cannot verify exit)"); try { fs.writeFileSync(FAILFILE, JSON.stringify({ at: Date.now(), pids: pids, pid: pid })); } catch (e) {} process.exit(2); }
  }
  try { fs.unlinkSync(PIDFILE); } catch (e) {}
  try { if (fs.existsSync(FAILFILE)) fs.unlinkSync(FAILFILE); } catch (e) {}
}
async function cmdStatus() { const deadline = Date.now() + 15000; const h = await getJson(WEB + "/health", 5000, deadline); const r = await getJson(WEB + "/ready", 5000, deadline); const f = await getJson(FAKE + "/__log", 5000, deadline); console.log("health=" + h.status + " instance=" + ((h.json && h.json.instance) || "?") + " ready=" + r.status + " store=" + ((r.json && r.json.store) || "?") + " fake=" + f.status); }
const cmd = String(process.argv[2] || "");
if (cmd === "start") { cmdStart().catch((e) => { console.log("FATAL " + String((e && e.message) || e).slice(0, 200)); process.exit(2); }); }
else if (cmd === "stop") { cmdStop().catch((e) => { console.log("FATAL " + String((e && e.message) || e).slice(0, 200)); process.exit(2); }); }
else if (cmd === "status") { cmdStatus().catch((e) => { console.log("FATAL " + String((e && e.message) || e).slice(0, 200)); process.exit(2); }); }
else if (cmd === "build" || cmd === "publish") { cmdBuild().catch((e) => { console.log("FATAL " + String((e && e.message) || e).slice(0, 200)); process.exit(2); }); }
else { console.log("usage: node qa/own-local-stack.mjs build|start|stop|status"); process.exit(2); }
