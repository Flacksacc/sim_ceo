// qa/advisor-claim-endpoint-qa.mjs - CLAIM-ENDPOINT gateway/commit regression (Muse sole-QA author only).
// Owns EXACT loopback stack API 127.0.0.1:15500 + fake 127.0.0.1:15502, dummy key,
// unique instance qa-claim-endpoint-15500, unique keyring, no other worktrees,
// no PG/Docker, env real provider human (never read). Real private QA user,
// actual POST ai-draft then GET research, canonical read, BEHAVIOR edit/save,
// stage, approval via ACTUAL API. Fake captures prompts; MIXED fact/interp/
// variants/SID + unsupported. Provenance pinned BEFORE first mutation; stale
// prebuilt refused. Cleanup verified and controls exit; pidfile retained if
// uncertain. All requests via exact-origin + deadline + abort-through-body.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const REPO = path.resolve(HERE, "..");
const OWN = path.resolve(REPO, "..", "own-15500-15502");
const API_PORT = 15500, FAKE_PORT = 15502;
const WEB = "http://127.0.0.1:" + API_PORT, FAKE = "http://127.0.0.1:" + FAKE_PORT;
const EXPECTED_INSTANCE = "qa-claim-endpoint-15500";
const QA_KEY = "qa-only-claimendpoint-15500-never-real";
const PUBLISH_DLL = path.resolve(REPO, "..", "own-15500-15502", "publish", "SimCEO.Api.dll");
const PUBLISH_DIR = path.dirname(PUBLISH_DLL);
const KEYRING = path.join(OWN, "keyring"), LOGDIR = path.join(OWN, "logs");
const PIDFILE = path.join(OWN, "pids.json");
const DEADLINE_MS = 240000;
const T0 = Date.now();
const deadline = T0 + DEADLINE_MS;
const DOSSIER_BUDGET_CHARS = 16000;
const MAX_FOCUS = 2000, MAX_BG = 4000, MAX_URL = 2000, MAX_URLS = 5, MAX_NAME = 120, MAX_ROLE = 500, MAX_PROBLEM = 4000;
const FACT_URL = "https://qa.example/EndpointFact";
const FACT_QUOTE = "QA endpoint fact passage alpha.";
const FACT_QUOTE2 = "QA endpoint second fact passage gamma.";
const INTERP_URL = "https://qa.example/EndpointInterp?src=qa";
const INTERP_QUOTE = "QA endpoint interp passage beta.";
const WRONG_PATH_URL = "https://qa.example/endpointfact";
const WRONG_PATH_QUOTE = "QA endpoint wrongpath distinct passage omega.";
const SLASH_URL = "https://qa.example/EndpointFact/";
const SLASH_QUOTE = "QA endpoint slash distinct passage sigma.";
const QUERYCASE_URL = "https://qa.example/EndpointInterp?src=QA";
const QUERYCASE_QUOTE = "QA endpoint querycase distinct passage tau.";
const HOSTCASE_URL = "https://QA.EXAMPLE/EndpointFact";
const UNSUPPORTED_TEXT = "QA endpoint unsupported speculation delta with no evidence.";
let pass = 0, fail = 0;
const results = [];
function ok(name, cond, extra = "") {
  if (cond) { pass++; results.push("PASS " + name); }
  else { fail++; results.push("FAIL " + name + (extra ? " :: " + String(extra).slice(0, 500) : "")); }
}
// Safe JSON truncation for diagnostics: JSON.stringify(undefined) returns
// undefined (not a string), so eager JSON.stringify(x).slice throws
// Cannot read properties of undefined (reading slice) and masks the real
// FAIL as FATAL. truncJson never throws and preserves assertion conditions.
function safeJson(v) {
  try {
    if (typeof v === "undefined") return "undefined";
    const s = JSON.stringify(v);
    if (typeof s === "string") return s;
    return String(s);
  } catch { try { return String(v); } catch { return "unstringifiable"; } }
}
function truncJson(v, n) {
  try { return safeJson(v).slice(0, n); } catch { return "untruncatable"; }
}
function remainingMs() { return deadline - Date.now(); }
function assertDeadline(where) { if (remainingMs() <= 0) throw new Error("deadline exceeded at " + where); }
function exactOrigin(u) {
  try { const x = new URL(u); if (x.username || x.password) return null; if (x.protocol !== "http:") return null; if (x.hostname !== "127.0.0.1") return null; return x.origin; } catch { return null; }
}
async function fetchJson(method, url, body, ms = 15000) {
  const o = exactOrigin(url);
  if (o !== ("http://127.0.0.1:" + API_PORT) && o !== ("http://127.0.0.1:" + FAKE_PORT)) throw new Error("refuse non-exact-origin " + url);
  const rem = remainingMs();
  if (rem <= 0) throw new Error("deadline exceeded before fetch");
  const ctl = new AbortController();
  const t = setTimeout(() => { try { ctl.abort(); } catch {} }, Math.min(ms, rem));
  try {
    const r = await fetch(url, { method, headers: body !== undefined ? { "content-type": "application/json" } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined, signal: ctl.signal, redirect: "manual" });
    if (r.status >= 300 && r.status < 400) throw new Error("refuse redirect");
    const tx = await r.text();
    let j = null;
    try { j = tx ? JSON.parse(tx) : null; } catch { j = { _raw: tx.slice(0, 2000) }; }
    return { status: r.status, json: j, text: tx };
  } finally { clearTimeout(t); }
}
const get = (u, ms) => fetchJson("GET", u, undefined, ms);
const post = (u, b, ms) => fetchJson("POST", u, b, ms);
const put = (u, b, ms) => fetchJson("PUT", u, b, ms);
function tcpOk(port, ms) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    let done = false;
    const fin = (v) => { if (done) return; done = true; try { s.destroy(); } catch {} resolve(v); };
    s.on("connect", () => fin(true));
    s.on("error", () => fin(false));
    setTimeout(() => fin(false), ms || 800);
  });
}
function pick(o, k) {
  if (!o || typeof o !== "object") return undefined;
  if (k in o) return o[k];
  const lo = String(k).toLowerCase();
  for (const key of Object.keys(o)) if (key.toLowerCase() === lo) return o[key];
  return undefined;
}
function shaFile(p) { try { return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); } catch { return ""; } }
function gitHead() {
  try {
    const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8", timeout: 15000 });
    return String(r.stdout || "").trim();
  } catch { return ""; }
}
function buildChildEnv() {
  const env = Object.assign({}, process.env);
  const absPub = path.resolve(PUBLISH_DIR), absKey = path.resolve(KEYRING);
  env.ASPNETCORE_URLS = "http://127.0.0.1:" + API_PORT;
  env.META_API_BASE = FAKE;
  env.META_API_KEY = QA_KEY;
  env.SIMCEO_INSTANCE = EXPECTED_INSTANCE;
  env.WIKI_KEYRING_DIR = absKey;
  env.ASPNETCORE_ENVIRONMENT = "Production";
  env.ASPNETCORE_CONTENTROOT = absPub;
  env.USE_POSTGRES = "0";
  for (const k of Object.keys(env)) {
    const u = k.toUpperCase();
    if (u.startsWith("CONNECTIONSTRINGS__") || u.startsWith("KESTREL__") || u.startsWith("POSTGRES") || u.startsWith("PG") || u.startsWith("NPGSQL")) {
      if (k !== "USE_POSTGRES" && !k.startsWith("USE_")) delete env[k];
    }
    if (u === "NODE_OPTIONS" || u === "NODE_EXTRA_CA_CERTS" || u.startsWith("NODE_") || u.startsWith("NPM_") || u === "DOTENV_KEY" || u === "ENV_FILE") delete env[k];
  }
  delete env.DOTNET_ENVIRONMENT;
  ok("childenv-absolute-contentroot", path.isAbsolute(absPub) && path.isAbsolute(absKey), absPub);
  ok("childenv-dummy-fake-only", env.META_API_BASE === FAKE && env.META_API_KEY === QA_KEY, env.META_API_BASE);
  ok("childenv-no-pg", env.USE_POSTGRES === "0" && !Object.keys(env).some((k) => k.toUpperCase().startsWith("PG")), "pg scrubbed");
  ok("childenv-no-node-hooks", !Object.keys(env).some((k) => k.toUpperCase() === "NODE_OPTIONS"), "node scrubbed");
  return env;
}
function ensureProvenanceBeforeMutation() {
  const head = gitHead();
  const dllSha = shaFile(PUBLISH_DLL);
  ok("provenance-source-head-present", /^[0-9a-f]{40}$/.test(head), String(head || "").slice(0, 12));
  ok("provenance-dll-present", dllSha.length === 64, String(dllSha || "").slice(0, 12));
  // Honest provenance: QA_FRESH_BUILD never built; old bypass removed.
  const expRev = String(process.env.QA_EXPECTED_SOURCE_REV || "").trim();
  const expSha = String(process.env.QA_EXPECTED_DLL_SHA || "").trim().toLowerCase();
  if (process.env.QA_FRESH_BUILD === "1") {
    ok("provenance-fresh-build-removed", false, "QA_FRESH_BUILD bypass removed; use primary fresh publish + pinned REV+SHA");
    throw new Error("QA_FRESH_BUILD=1 removed: set QA_EXPECTED_SOURCE_REV+QA_EXPECTED_DLL_SHA from primary fresh publish");
  }
  if (!expRev || !expSha) {
    ok("provenance-pinned-required", false, "set QA_EXPECTED_SOURCE_REV+QA_EXPECTED_DLL_SHA from primary fresh publish");
    throw new Error("provenance not pinned: set QA_EXPECTED_SOURCE_REV+QA_EXPECTED_DLL_SHA");
  }
  ok("provenance-source-pinned", head.toLowerCase() === expRev.toLowerCase(), "head=" + String(head || "").slice(0, 12));
  ok("provenance-dll-pinned", dllSha.toLowerCase() === expSha, "dll=" + String(dllSha || "").slice(0, 12));
  if (head.toLowerCase() !== expRev.toLowerCase() || dllSha.toLowerCase() !== expSha) throw new Error("provenance mismatch");
  return { head, dllSha, fresh: false };
}
let apiProc = null, fakeProc = null;
let provInfo = null;
async function boot() {
  if (await tcpOk(API_PORT, 800) || await tcpOk(FAKE_PORT, 800)) { console.log("FATAL refuse: 15500/15502 occupied"); process.exit(2); }
  if (!fs.existsSync(PUBLISH_DLL)) { console.log("FATAL publish DLL missing: " + PUBLISH_DLL); process.exit(2); }
  provInfo = ensureProvenanceBeforeMutation();
  try { fs.mkdirSync(KEYRING, { recursive: true }); } catch {}
  try { fs.mkdirSync(LOGDIR, { recursive: true }); } catch {}
  const dllSha = shaFile(PUBLISH_DLL);
  const head = gitHead();
  const env = buildChildEnv();
  const apiLog = fs.openSync(path.join(LOGDIR, "api-15500.log"), "a");
  const fakeLog = fs.openSync(path.join(LOGDIR, "fake-15502.log"), "a");
  apiProc = spawn("dotnet", [PUBLISH_DLL], { cwd: PUBLISH_DIR, env, stdio: ["ignore", apiLog, apiLog], windowsHide: true });
  fakeProc = spawn("node", [path.join(REPO, "qa", "advisor-claim-endpoint-fake.mjs"), "--port", String(FAKE_PORT)], { cwd: REPO, env: process.env, stdio: ["ignore", fakeLog, fakeLog], windowsHide: true });
  try { fs.writeFileSync(PIDFILE, JSON.stringify({ apiPid: apiProc.pid, fakePid: fakeProc.pid, at: Date.now(), instance: EXPECTED_INSTANCE, dllSha, sourceRev: head })); } catch {}
  const bootEnd = Date.now() + 90000;
  while (Date.now() < bootEnd) {
    assertDeadline("boot");
    try {
      const h = await get(WEB + "/health", 4000);
      const r = await get(WEB + "/ready", 4000);
      const f = await get(FAKE + "/__health", 4000);
      if (h.status === 200 && pick(h.json, "instance") === EXPECTED_INSTANCE && r.status === 200 && pick(r.json, "store") === "inmemory" && f.status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1200));
  }
  throw new Error("boot failed within 90s");
}
async function cleanupAndVerify() {
  const exited = (c) => !!c && (c.exitCode !== null || c.signalCode !== null);
  const end = Date.now() + 20000;
  for (const c of [apiProc, fakeProc]) { try { if (c && c.exitCode === null && !c.killed) c.kill(); } catch {} }
  let apiOpen = true, fakeOpen = true;
  while (Date.now() < end) {
    apiOpen = await tcpOk(API_PORT, Math.min(800, Math.max(1, end - Date.now())));
    fakeOpen = await tcpOk(FAKE_PORT, Math.min(800, Math.max(1, end - Date.now())));
    if (exited(apiProc) && exited(fakeProc) && !apiOpen && !fakeOpen) break;
    await new Promise((r) => setTimeout(r, Math.min(100, Math.max(0, end - Date.now()))));
  }
  const apiExited = exited(apiProc), fakeExited = exited(fakeProc);
  const clean = apiExited && fakeExited && !apiOpen && !fakeOpen;
  if (clean) { try { fs.unlinkSync(PIDFILE); } catch {} }
  return { apiExited, fakeExited, apiPortClosed: !apiOpen, fakePortClosed: !fakeOpen, clean, pidRetained: fs.existsSync(PIDFILE) };
}
function parseResearchJson(v) {
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v || {});
    const j = typeof v === "string" ? JSON.parse(v) : v;
    return { raw: s, json: j };
  } catch { return { raw: "", json: null }; }
}
function claimByText(claims, needle) {
  return (claims || []).find((c) => String(pick(c, "text") || "").toLowerCase().includes(String(needle).toLowerCase()));
}
function rosterEntries(response) {
  return (Array.isArray(response.json) ? response.json : []).map((row) => pick(row, "entry") || row);
}
function refUrl(r) { return String(pick(r, "url") || pick(r, "ref") || ""); }
function refQuote(r) { return String(pick(r, "excerpt") || pick(r, "quote") || ""); }
async function main() {
  await boot();
  const run = "claimendpoint-" + Date.now().toString(36);
  const tail = run.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(-8);
  const MARK_U = "CLMEP-U-" + tail, MARK_S = "CLMEP-S-" + tail, MARK_C = "CLMEP-C-" + tail;
  const email = run + "@qa.local";
  const password = "qa-pass-" + run + "-long";
  await fetchJson("DELETE", FAKE + "/__log", {}, 8000);
  const log0 = await get(FAKE + "/__log", 8000);
  ok("fake-fresh", log0.status === 200 && Array.isArray(log0.json) && log0.json.length === 0, "status=" + log0.status);
  const reg = await post(WEB + "/api/auth/register", { email, password }, 15000);
  ok("register-201", reg.status === 201 || reg.status === 200, "status=" + reg.status);
  const token = String(pick(reg.json, "token") || "");
  ok("register-token", token.length > 10, "len=" + token.length);
  const ACCT = "00000000-0000-0000-0000-000000000000";
  const authFetch = async (method, url, body, ms) => {
    const o = exactOrigin(url);
    if (o !== ("http://127.0.0.1:" + API_PORT) && o !== ("http://127.0.0.1:" + FAKE_PORT)) throw new Error("refuse origin");
    const rem = remainingMs();
    if (rem <= 0) throw new Error("deadline exceeded before fetch");
    const ctl = new AbortController();
    const t = setTimeout(() => { try { ctl.abort(); } catch {} }, Math.min(ms || 15000, rem));
    try {
      const headers = { "content-type": "application/json" };
      if (token) headers["authorization"] = "Bearer " + token;
      const r = await fetch(url, { method, headers: body !== undefined ? headers : (token ? { authorization: "Bearer " + token } : undefined), body: body !== undefined ? JSON.stringify(body) : undefined, signal: ctl.signal, redirect: "manual" });
      if (r.status >= 300 && r.status < 400) throw new Error("refuse redirect");
      const tx = await r.text();
      let j = null;
      try { j = tx ? JSON.parse(tx) : null; } catch { j = { _raw: tx.slice(0, 2000) }; }
      return { status: r.status, json: j, text: tx };
    } finally { clearTimeout(t); }
  };
  const aget = (u, ms) => authFetch("GET", u, undefined, ms);
  const apost = (u, b, ms) => authFetch("POST", u, b, ms);
  const aput = (u, b, ms) => authFetch("PUT", u, b, ms);
  const uFocus = "CLAIMENDPOINT-UNSUPPORTED " + MARK_U + " harbor focus " + run;
  const uDraft = await apost(WEB + "/api/roster/ai-draft", { accountId: ACCT, name: "U-" + run, role: "Harbor Strategist", focus: uFocus }, 90000);
  ok("unsupported-draft-201", uDraft.status === 201, "status=" + uDraft.status);
  const uEntry = pick(uDraft.json, "entry") || {};
  const uId = String(pick(uEntry, "id") || pick(uDraft.json, "id") || "");
  ok("unsupported-has-id", uId.length > 10, "id=" + uId.slice(0, 20));
  ok("unsupported-researched-false", pick(uDraft.json, "researched") === false, truncJson(uDraft.json, 200));
  ok("unsupported-status", String(pick(uDraft.json, "draftStatus") || "").toLowerCase() === "unsupported", truncJson(uDraft.json, 200));
  ok("unsupported-count0", Number(pick(uDraft.json, "evidenceCount")) === 0, truncJson(uDraft.json, 200));
  const uRes = await aget(WEB + "/api/roster/" + uId + "/research", 15000);
  ok("unsupported-get-200", uRes.status === 200, "status=" + uRes.status);
  ok("unsupported-stage", String(pick(uRes.json, "stage") || "") === "unsupported", "stage=" + pick(uRes.json, "stage"));
  ok("unsupported-not-running", pick(uRes.json, "running") === false, "running=" + pick(uRes.json, "running"));
  ok("unsupported-researchedAt-null", pick(uRes.json, "researchedAt") == null, "at=" + pick(uRes.json, "researchedAt"));
  const uRj = parseResearchJson(pick(uRes.json, "researchJson"));
  const uRespIds = (uRj.json && uRj.json.responseIds) || [];
  ok("unsupported-responseid-marker", Array.isArray(uRespIds) && uRespIds.some((x) => String(x).includes(MARK_U)), truncJson(uRespIds, 200));
  const uClaims = (uRj.json && uRj.json.claims) || [];
  const uUn = claimByText(uClaims, "unsupported speculation");
  ok("unsupported-claim-unverified-empty-refs", !!uUn && pick(uUn, "verified") === false && Array.isArray(pick(uUn, "refs")) && pick(uUn, "refs").length === 0, truncJson(uUn, 300));
  const canon = await aget(WEB + "/api/roster?accountId=" + encodeURIComponent(ACCT), 15000);
  const rows = rosterEntries(canon);
  const found = rows.find((x) => String(pick(x, "id") || "").toLowerCase() === uId.toLowerCase());
  ok("unsupported-canonical", !!found, "rows=" + rows.length);
  const uVer0 = Number(pick(found, "version") || 0);
  const uInputs0 = String(pick(found, "researchInputsJson") || "");
  const behaviorU = JSON.stringify({ contributionCriteria: "QA U contribution for " + MARK_U + ": harbor risk surfacing; abstains without port data.", reasoningApproach: "QA U reasoning for " + MARK_U + ": compares options against port evidence; challenges unsupported premises.", responseStyle: "QA U style for " + MARK_U + ": blunt about port risk, diplomatic with crew." });
  const uEdit = await aput(WEB + "/api/roster/" + uId, { profileJson: behaviorU }, 15000);
  ok("unsupported-behavior-save-200", uEdit.status === 200, "status=" + uEdit.status);
  const uCanon2 = await aget(WEB + "/api/roster?accountId=" + encodeURIComponent(ACCT), 15000);
  const uFound2 = rosterEntries(uCanon2).find((x) => String(pick(x, "id") || "").toLowerCase() === uId.toLowerCase());
  const uRj2 = parseResearchJson(pick(uFound2, "researchJson"));
  ok("unsupported-behavior-preserved", uRj2.json && String(pick(uRj2.json, "draftStatus") || "").toLowerCase() === "unsupported", truncJson(uRj2.json, 300));
  ok("unsupported-version-bumped", Number(pick(uFound2, "version") || 0) === uVer0 + 1, "v0=" + uVer0);
  ok("unsupported-inputs-pinned", String(pick(uFound2, "researchInputsJson") || "") === uInputs0, "inputs changed");
  ok("unsupported-saved-hash", !!pick(uRj2.json, "savedProfileHash"), "no savedProfileHash");
  const uRes2 = await aget(WEB + "/api/roster/" + uId + "/research", 15000);
  ok("unsupported-edit-preserved", String(pick(uRes2.json, "stage") || "") === "unsupported" && pick(uRes2.json, "running") === false, "stage=" + pick(uRes2.json, "stage"));
  const uComp = await aget(WEB + "/api/roster/" + uId + "/completeness", 15000);
  const miss = Array.isArray(pick(uComp.json, "missing")) ? pick(uComp.json, "missing") : [];
  ok("unsupported-complete-endpoint", uComp.status === 200, "status=" + uComp.status);
  ok("unsupported-stage-allowed", !miss.join(";").toLowerCase().includes("unsupported"), "missing=" + miss.join(";"));
  const board = await apost(WEB + "/api/boards", { name: run + "-board", mission: "QA claim endpoint board" }, 15000);
  ok("board-201", board.status === 201 && !!pick(board.json, "id"), "status=" + board.status);
  const bid = String(pick(board.json, "id") || "");
  const gen = await apost(WEB + "/api/roster/" + uId + "/image/generate", { count: 1 }, 60000);
  ok("unsupported-portrait-generated", gen.status === 201 || gen.status === 200, "status=" + gen.status);
  const cp = await apost(WEB + "/api/roster/" + uId + "/copy", { boardId: bid, boardRole: "Harbor Strategist" }, 15000);
  ok("unsupported-stage-copy-201", cp.status === 201 && !!pick(cp.json, "id"), "status=" + cp.status);
  const aid = String(pick(cp.json, "id") || "");
  const ap = await apost(WEB + "/api/boards/" + bid + "/advisors/" + aid + "/approve", {}, 15000);
  ok("unsupported-approval-blocked-409", ap.status === 409 && String(JSON.stringify(ap.json)).toLowerCase().includes("grounded"), "status=" + ap.status);
  const maxFocus = ("harbor focus " + run + " " + MARK_S + " ").padEnd(2000, "x").slice(0, 2000);
  ok("budget-focus-maxlen", maxFocus.length === 2000, "len=" + maxFocus.length);
  const tS = Date.now();
  const sDraft = await apost(WEB + "/api/roster/ai-draft", { accountId: ACCT, name: "S-" + run, role: "Harbor Strategist", focus: maxFocus }, 90000);
  const sElapsed = Date.now() - tS;
  ok("supported-draft-201", sDraft.status === 201, "status=" + sDraft.status);
  ok("supported-researched-true", pick(sDraft.json, "researched") === true && String(pick(sDraft.json, "draftStatus") || "").toLowerCase() === "done", truncJson(sDraft.json, 200));
  ok("supported-count5-distinct", Number(pick(sDraft.json, "evidenceCount")) === 5, "count=" + pick(sDraft.json, "evidenceCount"));
  ok("supported-elapsed-bounded", sElapsed < 120000, "elapsed=" + sElapsed);
  const sEntry = pick(sDraft.json, "entry") || {};
  const sId = String(pick(sEntry, "id") || "");
  const sRes = await aget(WEB + "/api/roster/" + sId + "/research", 15000);
  ok("supported-stage-done", String(pick(sRes.json, "stage") || "") === "done", "stage=" + pick(sRes.json, "stage"));
  const sRj = parseResearchJson(pick(sRes.json, "researchJson"));
  const sRespIds = (sRj.json && sRj.json.responseIds) || [];
  ok("supported-responseid-marker", Array.isArray(sRespIds) && sRespIds.some((x) => String(x).includes(MARK_S)), truncJson(sRespIds, 200));
  const sClaims = (sRj.json && sRj.json.claims) || [];
  const sFact = claimByText(sClaims, "harbor fact alpha");
  const sFact2 = claimByText(sClaims, "second harbor fact gamma");
  const sInterp = claimByText(sClaims, "crew interpretation beta");
  const sWrong = claimByText(sClaims, "wrongpath fact");
  const sSlash = claimByText(sClaims, "slash fact");
  const sQuery = claimByText(sClaims, "querycase inference");
  const sHost = claimByText(sClaims, "hostcase fact");
  const sUn = claimByText(sClaims, "unsupported speculation");
  function exactClaim(c, url, quote, kind) {
    if (!c) return false;
    if (String(pick(c, "kind") || "").toLowerCase() !== kind) return false;
    if (pick(c, "verified") !== true) return false;
    const refs = pick(c, "refs") || [];
    if (!Array.isArray(refs) || refs.length === 0) return false;
    return !!refs.find((r) => refUrl(r) === url && refQuote(r) === quote);
  }
  ok("supported-fact-alpha-exact", exactClaim(sFact, FACT_URL, FACT_QUOTE, "fact"), truncJson(sFact, 300));
  ok("supported-fact-gamma-exact", exactClaim(sFact2, FACT_URL, FACT_QUOTE2, "fact"), truncJson(sFact2, 300));
  ok("supported-interp-exact", exactClaim(sInterp, INTERP_URL, INTERP_QUOTE, "interpretation"), truncJson(sInterp, 300));
  ok("supported-wrongpath-distinct", exactClaim(sWrong, WRONG_PATH_URL, WRONG_PATH_QUOTE, "fact"), truncJson(sWrong, 300));
  ok("supported-slash-distinct", exactClaim(sSlash, SLASH_URL, SLASH_QUOTE, "fact"), truncJson(sSlash, 300));
  ok("supported-querycase-distinct", exactClaim(sQuery, QUERYCASE_URL, QUERYCASE_QUOTE, "interpretation"), truncJson(sQuery, 300));
  ok("supported-hostcase-canonical-retain", !!sHost && pick(sHost, "verified") === true && (() => { const rs = pick(sHost, "refs") || []; return rs.length > 0 && refUrl(rs[0]) === FACT_URL && refQuote(rs[0]) === FACT_QUOTE; })(), truncJson(sHost, 300));
  ok("supported-unverified-empty-refs", !!sUn && pick(sUn, "verified") === false && Array.isArray(pick(sUn, "refs")) && pick(sUn, "refs").length === 0, truncJson(sUn, 300));
  ok("supported-no-conflation", (() => { const a = sFact ? refQuote((pick(sFact, "refs") || [])[0] || {}) : ""; const w = sWrong ? refQuote((pick(sWrong, "refs") || [])[0] || {}) : ""; return a === FACT_QUOTE && w === WRONG_PATH_QUOTE && a !== w; })(), "quotes swapped?");
  const sRefs = Array.isArray(pick(sRes.json, "sources")) ? pick(sRes.json, "sources") : [];
  ok("supported-refs-provider-unfetched", sRefs.length >= 5 && sRefs.every((x) => pick(x, "fetched") === false && String(pick(x, "origin") || "") === "provider-search"), truncJson(sRefs, 400));
  const sCanon = await aget(WEB + "/api/roster?accountId=" + encodeURIComponent(ACCT), 15000);
  const sFound = rosterEntries(sCanon).find((x) => String(pick(x, "id") || "").toLowerCase() === sId.toLowerCase());
  const sVer0 = Number(pick(sFound, "version") || 0);
  const sInputs0 = String(pick(sFound, "researchInputsJson") || "");
  const behaviorS = JSON.stringify({ contributionCriteria: "QA S contribution for " + MARK_S + ": harbor risk surfacing.", reasoningApproach: "QA S reasoning for " + MARK_S + ": options against port evidence.", responseStyle: "QA S style for " + MARK_S + ": blunt about port risk, diplomatic." });
  const sEdit = await aput(WEB + "/api/roster/" + sId, { profileJson: behaviorS }, 15000);
  ok("supported-behavior-save-200", sEdit.status === 200, "status=" + sEdit.status);
  const sCanon2 = await aget(WEB + "/api/roster?accountId=" + encodeURIComponent(ACCT), 15000);
  const sFound2 = rosterEntries(sCanon2).find((x) => String(pick(x, "id") || "").toLowerCase() === sId.toLowerCase());
  const sRj2 = parseResearchJson(pick(sFound2, "researchJson"));
  ok("supported-behavior-saved", sRj2.json && String(pick(sRj2.json, "draftStatus") || "").toLowerCase() === "saved", truncJson(sRj2.json, 300));
  ok("supported-version-bumped", Number(pick(sFound2, "version") || 0) === sVer0 + 1, "v0=" + sVer0);
  ok("supported-inputs-pinned", String(pick(sFound2, "researchInputsJson") || "") === sInputs0, "inputs changed");
  const cName = ("C-" + run + "-" + MARK_C + "-").padEnd(MAX_NAME, "n").slice(0, MAX_NAME);
  const cRole = ("Harbor Strategist " + MARK_C + " ").padEnd(MAX_ROLE, "r").slice(0, MAX_ROLE);
  const cProblem = ("port risk for " + run + " " + MARK_C + " ").padEnd(MAX_PROBLEM, "p").slice(0, MAX_PROBLEM);
  ok("character-name-maxlen", cName.length === MAX_NAME, "len=" + cName.length);
  ok("character-role-maxlen", cRole.length === MAX_ROLE, "len=" + cRole.length);
  ok("character-problem-maxlen", cProblem.length === MAX_PROBLEM, "len=" + cProblem.length);
  const ch = await apost(WEB + "/api/roster/character", { accountId: ACCT, name: cName, role: cRole, problem: cProblem }, 15000);
  ok("character-start-201", ch.status === 201 && !!pick(ch.json, "id"), "status=" + ch.status);
  const cId = String(pick(ch.json, "id") || "");
  const cFocus = ("harbor focus " + run + " " + MARK_C + " ").padEnd(MAX_FOCUS, "f").slice(0, MAX_FOCUS);
  const cBg = ("harbor background " + run + " " + MARK_C + " ").padEnd(MAX_BG, "b").slice(0, MAX_BG);
  ok("character-focus-maxlen", cFocus.length === MAX_FOCUS, "len=" + cFocus.length);
  ok("character-bg-maxlen", cBg.length === MAX_BG, "len=" + cBg.length);
  const cUrls = [];
  for (let i = 1; i <= MAX_URLS; i++) {
    const tail2 = "-S" + i + "-" + MARK_C.toLowerCase() + "-end";
    const base = "https://qa.example/char" + i + "/" + tail.toLowerCase() + "/";
    const fill = MAX_URL - base.length - tail2.length;
    cUrls.push((base + "q".repeat(Math.max(0, fill)) + tail2).slice(0, MAX_URL));
  }
  ok("character-urls-five-full", cUrls.length === 5 && cUrls.every((u) => u.length === MAX_URL), cUrls.map((u) => u.length).join(","));
  ok("character-urls-distinct", new Set(cUrls).size === 5, "dup urls");
  const tC = Date.now();
  const maxUrls = [...cUrls];
  const maxRes = await apost(WEB + "/api/roster/" + cId + "/research", { focus: cFocus, background: cBg, sourceUrls: maxUrls }, 120000);
  ok("character-oversize-dossier-rejected", maxRes.status === 502 && maxRes.text.includes("compile budget"), "status=" + maxRes.status);
  const maxGet = await aget(WEB + "/api/roster/" + cId + "/research", 15000);
  const maxResearch = parseResearchJson(pick(maxGet.json, "researchJson")).json;
  const maxClaims = maxResearch?.partial?.claims || [];
  ok("character-oversize-terminal-retains-claims", pick(maxGet.json, "stage") === "failed" && pick(maxGet.json, "running") === false && maxUrls.every((url) => maxClaims.some((c) => (pick(c, "refs") || []).some((r) => refUrl(r) === url))), "claims=" + maxClaims.length);
  // Explicit recovery with ordinary link lengths; oversized evidence is
  // never truncated just to make compilation succeed.
  cUrls.splice(0, cUrls.length, ...maxUrls.map((_, i) => "https://qa.example/char" + (i + 1) + "/" + tail));
  const cRes = await apost(WEB + "/api/roster/" + cId + "/research", { focus: cFocus, background: cBg, sourceUrls: cUrls }, 120000);
  const cElapsed = Date.now() - tC;
  ok("character-research-200", cRes.status === 200, "status=" + cRes.status);
  ok("character-elapsed-bounded", cElapsed < 150000, "elapsed=" + cElapsed);
  const cGet = await aget(WEB + "/api/roster/" + cId + "/research", 15000);
  ok("character-stage-done", String(pick(cGet.json, "stage") || "") === "done", "stage=" + pick(cGet.json, "stage"));
  const cRj = parseResearchJson(pick(cGet.json, "researchJson"));
  const cRespRaw = (cRj.json && (cRj.json.responseIds || cRj.json.responseId)) || [];
  const cRespArr = Array.isArray(cRespRaw) ? cRespRaw : [cRespRaw];
  ok("character-responseid-marker", cRespArr.some((x) => String(x).includes(MARK_C)), truncJson(cRespArr, 200));
  const cClaims = (cRj.json && cRj.json.claims) || [];
  let sidAll = true;
  for (let i = 1; i <= 5; i++) {
    const sid = "S" + i;
    const wantUrl = cUrls[i - 1];
    const wantQuote = "QA endpoint SID passage for " + sid + " " + MARK_C + ".";
    const cl = claimByText(cClaims, "SID fact " + sid);
    const good = cl && String(pick(cl, "kind") || "").toLowerCase() === "fact" && pick(cl, "verified") === true && (() => {
      const rs = pick(cl, "refs") || [];
      return Array.isArray(rs) && rs.some((r) => refUrl(r) === wantUrl && refQuote(r) === wantQuote);
    })();
    if (!good) sidAll = false;
  }
  ok("character-sid-full-url-exact", sidAll, "sid claims=" + cClaims.length);
  const cUn = claimByText(cClaims, "unsupported speculation");
  ok("character-unverified-empty-refs", !!cUn && pick(cUn, "verified") === false && Array.isArray(pick(cUn, "refs")) && pick(cUn, "refs").length === 0, truncJson(cUn, 300));
  const cCanon = await aget(WEB + "/api/roster?accountId=" + encodeURIComponent(ACCT), 15000);
  const cFound = rosterEntries(cCanon).find((x) => String(pick(x, "id") || "").toLowerCase() === cId.toLowerCase());
  const cVer0 = Number(pick(cFound, "version") || 0);
  const cInputs0 = String(pick(cFound, "researchInputsJson") || "");
  const behaviorC = JSON.stringify({ contributionCriteria: "QA C contribution for " + MARK_C + ": harbor risk; abstains without data.", reasoningApproach: "QA C reasoning for " + MARK_C + ": compares options; challenges unsupported.", responseStyle: "QA C style for " + MARK_C + ": blunt about risk, diplomatic." });
  const cEdit = await aput(WEB + "/api/roster/" + cId, { profileJson: behaviorC }, 15000);
  ok("character-save-200", cEdit.status === 200, "status=" + cEdit.status);
  const cCanon2 = await aget(WEB + "/api/roster?accountId=" + encodeURIComponent(ACCT), 15000);
  const cFound2 = rosterEntries(cCanon2).find((x) => String(pick(x, "id") || "").toLowerCase() === cId.toLowerCase());
  const cRj2 = parseResearchJson(pick(cFound2, "researchJson"));
  ok("character-behavior-saved-pinned", cRj2.json && ["saved", "done"].includes(String(pick(cRj2.json, "draftStatus") || "").toLowerCase()), truncJson(cRj2.json, 300));
  ok("character-version-bumped", Number(pick(cFound2, "version") || 0) === cVer0 + 1, "v0=" + cVer0);
  ok("character-inputs-pinned", String(pick(cFound2, "researchInputsJson") || "") === cInputs0, "inputs changed");
  const logs = await get(FAKE + "/__log", 10000);
  const entries = Array.isArray(logs.json) ? logs.json : [];
  const respLogs = entries.filter((e) => e.path === "responses");
  const chatLogs = entries.filter((e) => e.path === "chat");
  ok("calls-two-per-draft-bounded", respLogs.length === 4 && chatLogs.length === 3, "resp=" + respLogs.length + " chat=" + chatLogs.length);
  function logsFor(marker, p) { return entries.filter((e) => e.path === p && String(e.full || "").includes(marker)); }
  const sDoss = logsFor(MARK_S, "responses");
  ok("supported-dossier-sameflow-grammar", sDoss.length === 1 && sDoss[0].full.includes("KIND |") && sDoss[0].full.includes("EVIDENCE:") && sDoss[0].full.includes("EXACT format") && sDoss[0].full.length <= DOSSIER_BUDGET_CHARS, "n=" + sDoss.length);
  const cDoss = logsFor(MARK_C, "responses");
  ok("character-dossier-sameflow-sid-grammar", cDoss.length === 2 && cDoss.every((e) => e.full.includes("EXACT format") && ["S1", "S2", "S3", "S4", "S5"].every((s) => e.full.includes("[" + s + "]")) && e.full.length <= DOSSIER_BUDGET_CHARS) && maxUrls.every((u) => cDoss[0].full.includes(u)) && cUrls.every((u) => cDoss[1].full.includes(u)), "n=" + cDoss.length);
  const uDoss = logsFor(MARK_U, "responses");
  ok("unsupported-dossier-sameflow", uDoss.length === 1 && uDoss[0].full.includes(MARK_U), "n=" + uDoss.length);
  const sProf = logsFor(MARK_S, "chat");
  ok("supported-profile-sameflow-has-verified", sProf.length === 1 && sProf[0].full.includes(FACT_QUOTE) && sProf[0].full.includes(INTERP_QUOTE), "missing quotes");
  ok("supported-profile-excludes-unsupported-sameflow", sProf.length === 1 && !sProf[0].full.includes(UNSUPPORTED_TEXT + " " + MARK_S), "leaked unsupported");
  const cComp = entries.filter((e) => e.path === "chat" && String(e.full || "").includes(MARK_C) && String(e.full || "").includes("COMPILE-CHARACTER-PARAGRAPHS"));
  ok("character-compiler-sameflow", cComp.length === 1 && cComp[0].full.includes(MARK_C), "n=" + cComp.length);
  function orderOk(marker) {
    const di = entries.findIndex((e) => e.path === "responses" && String(e.full || "").includes(marker));
    const ci = entries.findIndex((e) => e.path === "chat" && String(e.full || "").includes(marker));
    return di >= 0 && ci >= 0 && di < ci;
  }
  ok("order-dossier-before-profile-U", orderOk(MARK_U), "order wrong U");
  ok("order-dossier-before-profile-S", orderOk(MARK_S), "order wrong S");
  ok("order-dossier-before-compile-C", orderOk(MARK_C), "order wrong C");
  const dossierFull = respLogs.map((e) => e.full || "").join("\n");
  ok("dossier-format-delivered", dossierFull.includes("KIND |") && dossierFull.includes("EVIDENCE:") && dossierFull.includes("EXACT format"), "len=" + dossierFull.length);
  const factClaims = sClaims.filter((c) => String(pick(c, "text") || "").includes("harbor fact"));
  ok("multi-passage-two-facts", factClaims.length >= 2 && factClaims.every((c) => pick(c, "verified") === true), "facts=" + factClaims.length);
  const counts = await get(FAKE + "/__counts", 8000);
  ok("counts-bounded-no-third", Number(pick(counts.json, "responses")) === 4 && Number(pick(counts.json, "chat")) === 3, JSON.stringify(counts.json));
  const ver = await cleanupAndVerify();
  ok("cleanup-children-exited", ver.apiExited && ver.fakeExited, JSON.stringify(ver));
  ok("cleanup-ports-closed", ver.apiPortClosed && ver.fakePortClosed, JSON.stringify(ver));
  ok("cleanup-pidfile-removed-when-clean", ver.clean && !ver.pidRetained, "retained=" + ver.pidRetained);
  console.log(results.join("\n"));
  console.log(pass + " passed, " + fail + " failed");
  console.log("UNEXECUTED: owner-fetch positive + no-refetch production counts ONLY via separate production-worker injected gateway probe (34792 path), not this loopback fake; localhost/SSRF negatives not attempted; paid-network wording fakes only; fault seams never set; PG/Docker/human ports/.env never touched. Prior 41/0 primary result concerned older 67a902f source, not CBC/851.");
  return fail === 0 && ver.clean ? 0 : 1;
}
let code = 1;
let cleanupDone = false;
try {
  code = await main();
  cleanupDone = true;
} catch (e) {
  try {
    console.log("FATAL " + String((e && e.message) || e).slice(0, 500));
    try { console.log("FATAL-stack " + String((e && e.stack) || "no-stack").slice(0, 2000)); } catch {}
    try {
      console.log("FATAL-results pass=" + pass + " fail=" + fail + " total=" + results.length);
      console.log(results.slice(-25).join("\n").slice(0, 4000));
    } catch {}
  } catch {}
  code = 2;
} finally {
  if (!cleanupDone) { try { await cleanupAndVerify(); } catch (ce) { try { console.log("FATAL-cleanup " + String((ce && ce.message) || ce).slice(0, 300)); } catch {} } }
}
process.exit(code);
