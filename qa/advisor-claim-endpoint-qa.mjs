// qa/advisor-claim-endpoint-qa.mjs - CLAIM-ENDPOINT gateway/commit regression (Muse sole-QA author only).
// Owns EXACT loopback stack API 127.0.0.1:15500 + fake 127.0.0.1:15502, dummy key,
// unique instance qa-claim-endpoint-15500, unique keyring, no other worktrees,
// no PG/Docker, env real provider human (never read). Real private QA user,
// actual POST ai-draft (supported max-budget + unsupported) then GET research,
// read canonical, edit/save, stage, approval routes via the ACTUAL current API.
// Fake captures delivered structured prompts and returns mixed fact/
// interpretation/unsupported with distinct exact quote+URL relationships.
// No source-file presence as proof: every assertion reads live HTTP JSON or
// fake logs. No fault seams, no fetch bypass, no localhost SSRF change.
import { spawn } from "node:child_process";
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
const FACT_URL = "https://qa.example/EndpointFact";
const FACT_QUOTE = "QA endpoint fact passage alpha.";
const FACT_QUOTE2 = "QA endpoint second fact passage gamma.";
const INTERP_URL = "https://qa.example/EndpointInterp?src=qa";
const INTERP_QUOTE = "QA endpoint interp passage beta.";
const UNSUPPORTED_TEXT = "QA endpoint unsupported speculation delta with no evidence.";
let pass = 0, fail = 0;
const results = [];
function ok(name, cond, extra = "") {
  if (cond) { pass++; results.push("PASS " + name); }
  else { fail++; results.push("FAIL " + name + (extra ? " :: " + extra.slice(0, 400) : "")); }
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
let apiProc = null, fakeProc = null;
async function boot() {
  if (await tcpOk(API_PORT, 800) || await tcpOk(FAKE_PORT, 800)) { console.log("FATAL refuse: 15500/15502 occupied"); process.exit(2); }
  if (!fs.existsSync(PUBLISH_DLL)) { console.log("FATAL publish DLL missing: " + PUBLISH_DLL); process.exit(2); }
  try { fs.mkdirSync(KEYRING, { recursive: true }); } catch {}
  try { fs.mkdirSync(LOGDIR, { recursive: true }); } catch {}
  const dllSha = shaFile(PUBLISH_DLL);
  const env = Object.assign({}, process.env);
  env.ASPNETCORE_URLS = "http://127.0.0.1:" + API_PORT;
  env.META_API_BASE = FAKE;
  env.META_API_KEY = QA_KEY;
  env.SIMCEO_INSTANCE = EXPECTED_INSTANCE;
  env.WIKI_KEYRING_DIR = KEYRING;
  env.ASPNETCORE_ENVIRONMENT = "Production";
  env.USE_POSTGRES = "0";
  for (const k of Object.keys(env)) {
    const u = k.toUpperCase();
    if (u.startsWith("CONNECTIONSTRINGS__") || u.startsWith("KESTREL__") || u.startsWith("POSTGRES") || u.startsWith("PG") || u.startsWith("NPGSQL")) {
      if (k !== "USE_POSTGRES" && !k.startsWith("USE_")) delete env[k];
    }
  }
  const apiLog = fs.openSync(path.join(LOGDIR, "api-15500.log"), "a");
  const fakeLog = fs.openSync(path.join(LOGDIR, "fake-15502.log"), "a");
  apiProc = spawn("dotnet", [PUBLISH_DLL], { cwd: PUBLISH_DIR, env, stdio: ["ignore", apiLog, apiLog], windowsHide: true });
  fakeProc = spawn("node", [path.join(REPO, "qa", "advisor-claim-endpoint-fake.mjs"), "--port", String(FAKE_PORT)], { cwd: REPO, env: process.env, stdio: ["ignore", fakeLog, fakeLog], windowsHide: true });
  try { fs.writeFileSync(PIDFILE, JSON.stringify({ apiPid: apiProc.pid, fakePid: fakeProc.pid, at: Date.now(), instance: EXPECTED_INSTANCE, dllSha })); } catch {}
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
async function cleanup() {
  for (const c of [apiProc, fakeProc]) { try { if (c && c.exitCode === null && !c.killed) c.kill(); } catch {} }
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    let alive = false;
    for (const c of [apiProc, fakeProc]) { try { if (c && c.exitCode === null) { process.kill(c.pid, 0); alive = true; } } catch {} }
    if (!alive) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  try { fs.unlinkSync(PIDFILE); } catch {}
}
async function main() {
  await boot();
  const run = "claimendpoint-" + Date.now().toString(36);
  const email = run + "@qa.local";
  const password = "qa-pass-" + run + "-long";
  // Fresh fake log proof (no static source as evidence).
  await fetchJson("DELETE", FAKE + "/__log", {}, 8000);
  const log0 = await get(FAKE + "/__log", 8000);
  ok("fake-fresh", log0.status === 200 && Array.isArray(log0.json) && log0.json.length === 0, "status=" + log0.status);
  // Real private QA user.
  const reg = await post(WEB + "/api/auth/register", { email, password }, 15000);
  ok("register-201", reg.status === 201 || reg.status === 200, "status=" + reg.status);
  const token = String(pick(reg.json, "token") || "");
  ok("register-token", token.length > 10, "len=" + token.length);
const ACCT = "00000000-0000-0000-0000-000000000000";
  const H = { "x-qa-auth": token };
  // Attach token via cookie/header: API uses Bearer? Try Authorization header wrapper.
  // The API reads session via cookie or Authorization; our fetch helper sends no auth.
  // Re-issue requests with Authorization header by patching fetchJson auth.
  const authFetch = async (method, url, body, ms) => {
    const o = exactOrigin(url);
    if (o !== ("http://127.0.0.1:" + API_PORT) && o !== ("http://127.0.0.1:" + FAKE_PORT)) throw new Error("refuse origin");
    const ctl = new AbortController();
    const t = setTimeout(() => { try { ctl.abort(); } catch {} }, Math.min(ms || 15000, remainingMs()));
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
  // UNSUPPORTED ai-draft via REAL orchestration.
  const uFocus = "CLAIMENDPOINT-UNSUPPORTED harbor focus " + run;
  const uDraft = await apost(WEB + "/api/roster/ai-draft", { accountId: ACCT, name: "U-" + run, role: "Harbor Strategist", focus: uFocus }, 90000);
  ok("unsupported-draft-201", uDraft.status === 201, "status=" + uDraft.status + " " + String(uDraft.text).slice(0, 200));
  const uEntry = pick(uDraft.json, "entry") || {};
  const uId = String(pick(uEntry, "id") || pick(uDraft.json, "id") || "");
  ok("unsupported-has-id", uId.length > 10, "id=" + uId.slice(0, 20));
  ok("unsupported-researched-false", pick(uDraft.json, "researched") === false, JSON.stringify(uDraft.json).slice(0, 200));
  ok("unsupported-status", String(pick(uDraft.json, "draftStatus") || "").toLowerCase() === "unsupported", JSON.stringify(uDraft.json).slice(0, 200));
  ok("unsupported-count0", Number(pick(uDraft.json, "evidenceCount")) === 0, JSON.stringify(uDraft.json).slice(0, 200));
  // GET research terminal (not interrupted, not running).
  const uRes = await aget(WEB + "/api/roster/" + uId + "/research", 15000);
  ok("unsupported-get-200", uRes.status === 200, "status=" + uRes.status);
  ok("unsupported-stage", String(pick(uRes.json, "stage") || "") === "unsupported", "stage=" + pick(uRes.json, "stage"));
  ok("unsupported-not-running", pick(uRes.json, "running") === false, "running=" + pick(uRes.json, "running"));
  ok("unsupported-researchedAt-null", pick(uRes.json, "researchedAt") == null, "at=" + pick(uRes.json, "researchedAt"));
  // Read canonical via collection.
  const canon = await aget(WEB + "/api/roster?accountId=" + encodeURIComponent(ACCT), 15000);
  const rows = Array.isArray(canon.json) ? canon.json : [];
  const found = rows.find((x) => String(pick(pick(x, "entry") || x, "id") || "").toLowerCase() === uId.toLowerCase());
  ok("unsupported-canonical", !!found, "rows=" + rows.length);
  let uResearchJson = "";
  try { uResearchJson = JSON.stringify(pick(pick(found, "entry") || {}, "researchJson") || pick(found, "entry") || ""); } catch { uResearchJson = ""; }
  // Edit/save preserves unsupported (tags-only, no ResearchJson forcing).
  const uEdit = await aput(WEB + "/api/roster/" + uId, { tags: "qa-endpoint" }, 15000);
  ok("unsupported-edit-200", uEdit.status === 200, "status=" + uEdit.status);
  const uRes2 = await aget(WEB + "/api/roster/" + uId + "/research", 15000);
  ok("unsupported-edit-preserved", String(pick(uRes2.json, "stage") || "") === "unsupported" && pick(uRes2.json, "running") === false, "stage=" + pick(uRes2.json, "stage"));
  // Completeness: no research-missing, portrait pending only.
  const uComp = await aget(WEB + "/api/roster/" + uId + "/completeness", 15000);
  const miss = Array.isArray(pick(uComp.json, "missing")) ? pick(uComp.json, "missing") : [];
  ok("unsupported-complete-endpoint", uComp.status === 200, "status=" + uComp.status);
  ok("unsupported-stage-allowed", !miss.join(";").toLowerCase().includes("unsupported") && !miss.join(";").toLowerCase().includes("research"), "missing=" + miss.join(";"));
  // Stage + approval routes.
  const board = await apost(WEB + "/api/boards", { name: run + "-board", mission: "QA claim endpoint board" }, 15000);
  ok("board-201", board.status === 201 && !!pick(board.json, "id"), "status=" + board.status);
  const bid = String(pick(board.json, "id") || "");
  const gen = await apost(WEB + "/api/roster/" + uId + "/image/generate", { count: 1 }, 60000);
  ok("unsupported-portrait-generated", gen.status === 201 || gen.status === 200, "status=" + gen.status);
  const cp = await apost(WEB + "/api/roster/" + uId + "/copy", { boardId: bid, boardRole: "Harbor Strategist" }, 15000);
  ok("unsupported-stage-copy-201", cp.status === 201 && !!pick(cp.json, "id"), "status=" + cp.status);
  const aid = String(pick(cp.json, "id") || "");
  const ap = await apost(WEB + "/api/boards/" + bid + "/advisors/" + aid + "/approve", {}, 15000);
  ok("unsupported-approval-blocked-409", ap.status === 409 && String(JSON.stringify(ap.json)).toLowerCase().includes("grounded"), "status=" + ap.status + " " + String(ap.text).slice(0, 200));
  // SUPPORTED max-budget ai-draft (grammar budget proof via actual delivered input).
  const maxFocus = ("harbor focus " + run + " ").padEnd(2000, "x");
  ok("budget-focus-maxlen", maxFocus.length === 2000, "len=" + maxFocus.length);
  const tS = Date.now();
  const sDraft = await apost(WEB + "/api/roster/ai-draft", { accountId: ACCT, name: "S-" + run, role: "Harbor Strategist", focus: maxFocus }, 90000);
  const sElapsed = Date.now() - tS;
  ok("supported-draft-201", sDraft.status === 201, "status=" + sDraft.status + " " + String(sDraft.text).slice(0, 200));
  ok("supported-researched-true", pick(sDraft.json, "researched") === true && String(pick(sDraft.json, "draftStatus") || "").toLowerCase() === "done", JSON.stringify(sDraft.json).slice(0, 200));
  ok("supported-count2", Number(pick(sDraft.json, "evidenceCount")) === 2, "count=" + pick(sDraft.json, "evidenceCount"));
  ok("supported-elapsed-bounded", sElapsed < 120000, "elapsed=" + sElapsed);
  const sEntry = pick(sDraft.json, "entry") || {};
  const sId = String(pick(sEntry, "id") || "");
  const sRes = await aget(WEB + "/api/roster/" + sId + "/research", 15000);
  ok("supported-stage-done", String(pick(sRes.json, "stage") || "") === "done", "stage=" + pick(sRes.json, "stage"));
  const refs = Array.isArray(pick(sRes.json, "sources")) ? pick(sRes.json, "sources") : [];
  const refUrls = refs.map((x) => String(pick(x, "url") || ""));
  ok("supported-refs-provider-unfetched", refs.length >= 2 && refs.every((x) => pick(x, "fetched") === false && String(pick(x, "origin") || "") === "provider-search"), JSON.stringify(refs).slice(0, 400));
  ok("supported-strict-negatives-absent", !refUrls.some((u) => u === "https://qa.example/endpointfact" || u === FACT_URL + "/" || u === INTERP_URL.replace("src=qa", "src=QA")), "urls=" + refUrls.join(","));
  // Fake log endpoint proof: delivered format + profile filtering.
  const logs = await get(FAKE + "/__log", 10000);
  const entries = Array.isArray(logs.json) ? logs.json : [];
  const respLogs = entries.filter((e) => e.path === "responses");
  const chatLogs = entries.filter((e) => e.path === "chat");
  ok("calls-two-per-draft-bounded", respLogs.length >= 2 && chatLogs.length >= 2, "resp=" + respLogs.length + " chat=" + chatLogs.length);
  const dossierFull = respLogs.map((e) => e.full || "").join("\n");
  const profileFull = chatLogs.map((e) => e.full || "").join("\n");
  ok("dossier-format-delivered", dossierFull.includes("KIND |") && dossierFull.includes("EVIDENCE:") && dossierFull.includes("EXACT format"), "len=" + dossierFull.length);
  ok("profile-has-supported", profileFull.includes(FACT_QUOTE) && profileFull.includes(INTERP_QUOTE) && profileFull.includes(FACT_QUOTE2), "missing supported quotes");
  ok("profile-excludes-unsupported", !profileFull.includes(UNSUPPORTED_TEXT), "leaked unsupported into profile");
  ok("profile-order-map-before-compile", entries.findIndex((e) => (e.full || "").includes("EXACT format")) < entries.findIndex((e) => (e.full || "").includes("Verified grounded claims")), "order wrong");
  // Multi-passage: same FACT_URL with two distinct quotes both delivered + both verified.
  const sClaims = (() => { try { const rj = typeof pick(sRes.json, "researchJson") === "string" ? JSON.parse(pick(sRes.json, "researchJson")) : null; return rj && Array.isArray(rj.claims) ? rj.claims : []; } catch { return []; } })();
  const factClaims = sClaims.filter((c) => String(pick(c, "text") || "").includes("harbor fact"));
  ok("multi-passage-two-facts", factClaims.length === 2 && factClaims.every((c) => pick(c, "verified") === true), "facts=" + factClaims.length);
  // Character start/research/compile/save flow with same fixture (no ResearchJson forcing).
  const ch = await apost(WEB + "/api/roster/character", { accountId: ACCT, name: "C-" + run, role: "Harbor Strategist", problem: "port risk for " + run }, 15000);
  ok("character-start-201", ch.status === 201 && !!pick(ch.json, "id"), "status=" + ch.status);
  const cId = String(pick(ch.json, "id") || "");
  const tC = Date.now();
  const cRes = await apost(WEB + "/api/roster/" + cId + "/research", { focus: "harbor focus " + run, background: "harbor background " + run, sourceUrls: [] }, 120000);
  const cElapsed = Date.now() - tC;
  ok("character-research-200", cRes.status === 200, "status=" + cRes.status + " " + String(cRes.text).slice(0, 200));
  ok("character-elapsed-bounded", cElapsed < 150000, "elapsed=" + cElapsed);
  const cGet = await aget(WEB + "/api/roster/" + cId + "/research", 15000);
  ok("character-stage-done", String(pick(cGet.json, "stage") || "") === "done", "stage=" + pick(cGet.json, "stage"));
  const cEdit = await aput(WEB + "/api/roster/" + cId, { tags: "qa-endpoint-char" }, 15000);
  ok("character-save-200", cEdit.status === 200, "status=" + cEdit.status);
  const counts = await get(FAKE + "/__counts", 8000);
  ok("counts-bounded-no-third", Number(pick(counts.json, "responses")) === 3 && Number(pick(counts.json, "chat")) === 3, JSON.stringify(counts.json));
  console.log(results.join("\n"));
  console.log(pass + " passed, " + fail + " failed");
  console.log("UNEXECUTED: owner-fetch positive (127.0.0.1 loopback URLs are SSRF-pinned non-public and PublicEvidenceFetcher restrictions stay; covered separately via real public fixtures, not here); localhost/SSRF weakening negatives (not attempted by design); paid-network provider wording (fakes only); fault-injection seams (FailCleanupFault etc. never set); PG/Docker/human ports (never touched).");
  return fail === 0 ? 0 : 1;
}
let code = 1;
try { code = await main(); } catch (e) { console.log("FATAL " + String((e && e.message) || e).slice(0, 300)); code = 2; }
try { await cleanup(); } catch {}
process.exit(code);

