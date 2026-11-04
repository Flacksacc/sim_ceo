// qa/advisor-live-provider-proof.mjs — PRIMARY-ONLY actual-provider proof (Muse-authored, sole script author).
//
// Own files: this script + docs/advisor-live-provider-proof.md ONLY. Prod 509e6a6 frozen:
// no server/web/compose/Dockerfile edits. Muse never runs this script
// against a service (node --check only here); PRIMARY executes it against the isolated
// Docker project QA_LIVE_PROJECT allowlist: simceo-advisor-real-15190 (default, source 509e6a6ea4a9c9078774f8963eca446760878cdc backcompat)
// OR simceo-advisor-real-15190-v2 (requires explicit QA_LIVE_SOURCE_COMMIT full 40hex)
// OR simceo-advisor-real-15190-v3 (forthcoming fresh stack; requires explicit QA_LIVE_SOURCE_COMMIT full 40hex = actual primary integrated HEAD at proof time, never a hardcoded older SHA); fresh PG/appdata volumes) at the EXACT origin http://127.0.0.1:15190 with the approved
// sealed app.env server-side. Trusted identity (primary docker-inspect, outside script):
// containerId 55fd668e4bcca1e50d5220c9f3484bebb3175fa6375031b328e960c18b0172d0 (64hex),
// image sha256 eb48b80d1063a25051e029bcf4798e699d68e8218f132ebd9e34dbc99399781f (64hex).
//
// Boundedness: at most 1 research + 1 roster chat + 1 audition (paid/model calls).
// App-internal research subcalls (fetch round + <=2 model calls) are natural and bounded
// by the server ResearchDeadline (<=180s). TOTAL execution is bounded at 480s plus ONE absolute 15s cleanup allowance
// shared by abort/drain + artifact write. NO retries/double POST, NO policy/force changes,
// NO admin DB/restore/reconcile, NO meeting/board run, NO 5173/15180/9333/5080 contact,
// NO .env/key/token reads. One fresh attempt only: no resume, no extra accounts/retry.
//
// Invocation (primary only; QA_LIVE_PROJECT + QA_LIVE_SOURCE_COMMIT select the expected build; v2/v3 require explicit full-40hex source):
//   QA_ALLOW_LIVE_PROVIDER=1 QA_LIVE_PROJECT=simceo-advisor-real-15190-v2 QA_LIVE_SOURCE_COMMIT=<full40hex> QA_LIVE_PROOF_PATH=/path/to/live-proof.json \
//     node qa/advisor-live-provider-proof.mjs
// Without the gate this script performs code-only validation and refuses (no HTTP).
import crypto from "node:crypto";
import fs from "node:fs/promises";

// ---------- immutable proof contract ----------
const ORIGIN = "http://127.0.0.1:15190";
const PROJECT_DEFAULT = "simceo-advisor-real-15190";
const PROJECT_V2 = "simceo-advisor-real-15190-v2";
const PROJECT_V3 = "simceo-advisor-real-15190-v3";
const PROJECT_V4 = "simceo-advisor-real-15190-v4";
const PROJECT_V5 = "simceo-advisor-real-15190-v5";
const PROJECT_ALLOWLIST = [PROJECT_DEFAULT, PROJECT_V2, PROJECT_V3, PROJECT_V4, PROJECT_V5];
const SOURCE_COMMIT_DEFAULT = "509e6a6ea4a9c9078774f8963eca446760878cdc";
function expectedProject() {
  const v = (process.env.QA_LIVE_PROJECT || "").trim() || PROJECT_DEFAULT;
  if (!PROJECT_ALLOWLIST.includes(v)) throw new ProofError("QA_LIVE_PROJECT must be exactly " + PROJECT_ALLOWLIST.join(" OR "));
  return v;
}
function expectedSourceCommit() {
  const raw = (process.env.QA_LIVE_SOURCE_COMMIT || "").trim().toLowerCase();
  const proj = (process.env.QA_LIVE_PROJECT || "").trim() || PROJECT_DEFAULT;
  if (proj !== PROJECT_DEFAULT && !raw) throw new ProofError("QA_LIVE_SOURCE_COMMIT explicit full 40hex is required for " + proj);
  const v = raw || SOURCE_COMMIT_DEFAULT;
  if (!/^[0-9a-f]{40}$/.test(v)) throw new ProofError("QA_LIVE_SOURCE_COMMIT must be full 40 lowercase hex");
  return v;
}
const TRUSTED_CONTAINER_ID = "55fd668e4bcca1e50d5220c9f3484bebb3175fa6375031b328e960c18b0172d0";
const TRUSTED_IMAGE_SHA = "eb48b80d1063a25051e029bcf4798e699d68e8218f132ebd9e34dbc99399781f";
const FORBIDDEN_PORTS = ["5173", "15180", "9333", "5080", "5099", "5100", "5199", "15433"];
const GATE = process.env.QA_ALLOW_LIVE_PROVIDER === "1";
const PROOF_PATH = (process.env.QA_LIVE_PROOF_PATH || "").trim();
const TOTAL_MS = 480000;
const DRAIN_MS = 15000;
const REQ_MS = 30000;
const POLL_MS = 5000;
const RESEARCH_ABSOLUTE_MS = 185000;
const RUN_TAG = "live-proof-" + crypto.randomBytes(6).toString("hex");
const RESULT_DEFAULT = "qa/proof/advisor-live-provider-proof-" + RUN_TAG + ".json";
const RESULT_PATH = ((process.env.QA_LIVE_RESULT_PATH || "").trim() || RESULT_DEFAULT);

// Fictional public-domain advisor. Grounded character; upstream evidence URLs only.
const ADVISOR_NAME = "Sherlock Holmes";
const ADVISOR_DESC = "Fictional consulting detective of 221B Baker Street: observes trifles, reasons " +
  "backwards from effects to causes, and refuses to theorise before data. Public-domain character " +
  "from Arthur Conan Doyle's stories; used here only as a QA persona for weighing uncertain claims.";
const ADVISOR_BG = "Sherlock Holmes is the fictional consulting detective created by Arthur Conan Doyle, " +
  "resident at 221B Baker Street, London, with Dr Watson chronicling his cases. Methods: observation " +
  "of trifles, deduction from effects back to causes, knowledge of special constrained domains " +
  "(tobacco ash, footprints, ciphers), and disciplined refusal to theorise ahead of data. " +
  "Canonical public sources for this QA run only: the Wikipedia character article and the Project " +
  "Gutenberg edition of The Adventures of Sherlock Holmes (ebook 1661).";
const SOURCE_URLS = [
  "https://en.wikipedia.org/wiki/Sherlock_Holmes",
  "https://www.gutenberg.org/ebooks/1661",
];
const RESEARCH_FOCUS = "Canonical methods and cases of Sherlock Holmes for weighing uncertain " +
  "witness testimony without overclaiming certainty.";
const NARROW_QUESTION = "Two witnesses disagree about the direction a cab took on a foggy night, and " +
  "neither saw the driver clearly. How would you weigh their claims, and what would you refuse " +
  "to conclude from such uncertain testimony?";
const PARA_KEYS = ["contributionCriteria", "reasoningApproach", "responseStyle"];
const EMPTY_GUID = "00000000-0000-0000-0000-000000000000";

// ---------- tiny infra: hard TOTAL timer, remaining clamp, real drain ----------
const startedAt = Date.now();
const HARD_STOP = startedAt + TOTAL_MS;
const timers = new Set();
const inFlight = new Set();
const pendingOps = new Set();
function track(p) { pendingOps.add(p); p.finally(() => pendingOps.delete(p)); return p; }
function remainingMs() { return HARD_STOP - Date.now(); }
function clampTimeout(want) {
  const r = remainingMs() - 1000;
  if (r <= 0) throw new ProofError("TOTAL budget exhausted; refusing new operation.");
  return Math.min(want, r);
}
function later(ms) {
  const want = Math.max(0, Math.min(ms, Math.max(0, remainingMs() - 500)));
  return track(new Promise((res) => {
    const t = setTimeout(() => { timers.delete(t); res(); }, want);
    timers.add(t);
  }));
}
function assertBudget(tag) {
  if (Date.now() > HARD_STOP - DRAIN_MS)
    throw new ProofError("TOTAL budget exhausted at " + tag + "; entering abort/drain.");
}
class ProofError extends Error {}
const structural = [];
function check(name, pass, detail) {
  structural.push({ name, pass: !!pass, detail: String(detail || "") });
  if (!pass) throw new ProofError("structural check failed: " + name + " :: " + detail);
}
function refuseUnlessOrigin(url) {
  if (!url.startsWith(ORIGIN + "/") && url !== ORIGIN)
    throw new ProofError("FATAL REFUSE: URL outside exact 15190 origin: " + url);
  const after = url.slice("http://127.0.0.1:".length);
  const port = after.split("/")[0];
  if (port !== "15190" || FORBIDDEN_PORTS.includes(port))
    throw new ProofError("FATAL REFUSE: forbidden port/host: " + url);
  if (/^https?:\/\/[^/]*@/i.test(url)) throw new ProofError("FATAL REFUSE: credential URL.");
}
function sha256Hex(s) { return crypto.createHash("sha256").update(s, "utf8").digest("hex"); }
function normImageId(v) {
  const s = String(v || "").trim().toLowerCase();
  if (s.startsWith("sha256:")) return s.slice(7);
  return s;
}
// Bodies are always fully consumed (tracked) so no socket/resource is orphaned.
// Every acquisition clamps to the hard TOTAL remaining budget (incl. fs writes).
async function call(method, path, body, opts) {
  const o = opts || {};
  assertBudget(method + " " + path);
  const timeout = clampTimeout(o.timeout || REQ_MS);
  const url = ORIGIN + path;
  refuseUnlessOrigin(url);
  const ctl = new AbortController();
  inFlight.add(ctl);
  let timer = null;
  const p = (async () => {
    timer = setTimeout(() => { try { ctl.abort(new Error("request-timeout")); } catch {} }, timeout);
    timers.add(timer);
    try {
      const res = await fetch(url, {
        method,
        headers: Object.assign({ "Content-Type": "application/json" }, o.headers || {}),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl.signal,
        redirect: "manual",
      });
      if (res.status >= 300 && res.status < 400)
        throw new ProofError("FATAL REFUSE: redirect encountered at " + path + " status=" + res.status);
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      return { status: res.status, json, text };
    } finally {
      if (timer) { clearTimeout(timer); timers.delete(timer); }
      inFlight.delete(ctl);
    }
  })();
  return track(p);
}
function authz(token) { return { Authorization: "Bearer " + token }; }
function pick(o, k) {
  if (!o || typeof o !== "object") return undefined;
  if (k in o) return o[k];
  const lo = String(k).toLowerCase();
  for (const key of Object.keys(o)) if (String(key).toLowerCase() === lo) return o[key];
  return undefined;
}
// ---------- code-only validation (runs WITHOUT the gate; performs NO HTTP) ----------
function validateProofShape(p) {
  const errs = [];
  if (!p || typeof p !== "object") return ["proof must be a JSON object"];
  let expProj = null;
  try { expProj = expectedProject(); } catch (e) { return ["invalid QA_LIVE_PROJECT: " + e.message]; }
  if (p.project !== expProj) errs.push("project must be exactly " + expProj + " (allowlist: " + PROJECT_ALLOWLIST.join(" OR ") + ")");
  if (typeof p.containerId !== "string" || !/^[0-9a-f]{64}$/.test(p.containerId.trim().toLowerCase()))
    errs.push("containerId must be full 64 lowercase hex (primary docker-inspect identity; not length-6)");
  if (typeof p.imageId !== "string" || !/^[0-9a-f]{64}$/.test(normImageId(p.imageId)))
    errs.push("imageId must be full 64 lowercase hex container/image id (sha256: prefix allowed; not length-6)");
  if (typeof p.sourceCommit !== "string" || !/^[0-9a-f]{40}$/.test(p.sourceCommit.trim().toLowerCase()))
    errs.push("sourceCommit must be full 40 lowercase hex");
  else {
    let expSrc = null;
    try { expSrc = expectedSourceCommit(); }
    catch (e) { errs.push("invalid QA_LIVE_SOURCE_COMMIT: " + e.message); expSrc = null; }
    if (expSrc && p.sourceCommit.trim().toLowerCase() !== expSrc)
      errs.push("sourceCommit must equal exact trusted QA_LIVE_SOURCE_COMMIT " + expSrc);
  }
  if (typeof p.servedIndexSha256 !== "string" || !/^[0-9a-f]{64}$/.test(p.servedIndexSha256))
    errs.push("servedIndexSha256 must be 64 lowercase hex");
  if (p.apiOrigin !== ORIGIN) errs.push("apiOrigin must be exactly " + ORIGIN);
  return errs;
}
function validateAdvisorSeed() {
  const errs = [];
  if (!ADVISOR_NAME || ADVISOR_NAME.trim().length > 120) errs.push("name bounds");
  if (!ADVISOR_DESC || ADVISOR_DESC.trim().length < 5 || ADVISOR_DESC.length > 4000) errs.push("desc bounds");
  if (!ADVISOR_BG || ADVISOR_BG.length > 4000) errs.push("background bounds");
  if (!Array.isArray(SOURCE_URLS) || SOURCE_URLS.length === 0 || SOURCE_URLS.length > 5) errs.push("urls count");
  for (const u of SOURCE_URLS) {
    if (!/^https:\/\//.test(u)) errs.push("url must be https: " + u);
    if (u.length > 2000) errs.push("url too long: " + u);
    refuseUnlessOrigin(ORIGIN + "/"); // self-test of the allowlist helper
  }
  if (NARROW_QUESTION.length > 4000) errs.push("question bounds");
  return errs;
}
async function validateOnly() {
  const problems = [];
  try { refuseUnlessOrigin("http://127.0.0.1:5173/"); problems.push("allowlist missed 5173"); }
  catch (e) { if (!(e instanceof ProofError)) problems.push("allowlist threw wrong type"); }
  try { refuseUnlessOrigin("http://127.0.0.1:15190.evil.example/"); problems.push("allowlist missed suffix trick"); }
  catch (e) { if (!(e instanceof ProofError)) problems.push("allowlist threw wrong type"); }
  refuseUnlessOrigin(ORIGIN + "/api/health");
  const seedErrs = validateAdvisorSeed();
  if (seedErrs.length) problems.push("seed: " + seedErrs.join(";"));
  const shapeErrs = validateProofShape(null);
  if (!shapeErrs.length) problems.push("proof-shape validator accepts null");
  // Strict-shape self-tests: length-6 ids and non-exact commit must be rejected.
  let expProj0 = PROJECT_DEFAULT, expSrc0 = SOURCE_COMMIT_DEFAULT;
  try { expProj0 = expectedProject(); expSrc0 = expectedSourceCommit(); }
  catch (e) { problems.push("env: " + e.message); }
  const lax = validateProofShape({ project: expProj0, containerId: "abc123", imageId: "abc123",
    sourceCommit: "0".repeat(7), servedIndexSha256: "0".repeat(64), apiOrigin: ORIGIN });
  if (!problems.length && lax.length < 3) problems.push("strict-shape self-test failed: length-6/prefix-only accepted");
  const exact = validateProofShape({ project: expProj0, containerId: TRUSTED_CONTAINER_ID,
    imageId: TRUSTED_IMAGE_SHA, sourceCommit: expSrc0,
    servedIndexSha256: "0".repeat(64), apiOrigin: ORIGIN });
  if (!problems.length && exact.length) problems.push("strict-shape self-test failed: trusted exact rejected: " + exact.join(";"));
  const wrongSrc = validateProofShape({ project: expProj0, containerId: TRUSTED_CONTAINER_ID,
    imageId: TRUSTED_IMAGE_SHA, sourceCommit: expSrc0 === SOURCE_COMMIT_DEFAULT ? "1".repeat(40) : SOURCE_COMMIT_DEFAULT,
    servedIndexSha256: "0".repeat(64), apiOrigin: ORIGIN });
  if (!problems.length && !wrongSrc.some((m) => /sourceCommit must equal/.test(m)))
    problems.push("strict-shape self-test failed: mismatched sourceCommit accepted");
  for (const bad of ["", null, undefined]) {
    const okMode = bad === "block" || bad === "warn" || bad === "off";
    if (okMode) problems.push("spending allowlist self-test failed for empty mode");
  }
  // Spending-policy self-test: fresh-DB warn/null/false is VALID; enforced==true/cap-number is NOT required.
  const spendCases = [
    { mode: "warn", cap: null, enforced: false, ok: true },
    { mode: "off", cap: null, enforced: false, ok: true },
    { mode: "block", cap: 5, enforced: true, ok: true },
    { mode: "block", cap: null, enforced: false, ok: true },
    { mode: "warn", cap: null, enforced: true, ok: false },
  ];
  for (const c of spendCases) {
    const eff = c.mode === "block" && c.cap !== null && c.cap !== undefined;
    if ((eff === c.enforced) !== c.ok) problems.push("spending self-test failed for " + JSON.stringify(c));
  }
  if (problems.length) {
    console.log("CODE-ONLY VALIDATION FAIL: " + problems.join(" | "));
    process.exit(2);
  }
  console.log("CODE-ONLY VALIDATION PASS (no HTTP performed; no mutation).");
  console.log("REFUSED live proof: set QA_ALLOW_LIVE_PROVIDER=1 + QA_LIVE_PROOF_PATH to let PRIMARY run it.");
  console.log("Trusted identity (primary-inspected outside script): containerId=" + TRUSTED_CONTAINER_ID.slice(0,12) + "... image sha256=" + TRUSTED_IMAGE_SHA.slice(0,12) + "... source=" + expSrc0 + " project=" + expProj0);
  process.exit(2);
}

// ---------- live proof (PRIMARY ONLY; never executed by Muse) ----------
async function readProof() {
  if (!PROOF_PATH) throw new ProofError("QA_LIVE_PROOF_PATH is required (trusted live proof JSON).");
  assertBudget("readProof-fs");
  let raw;
  try { raw = await track(fs.readFile(PROOF_PATH, "utf8")); }
  catch (e) { throw new ProofError("cannot read QA_LIVE_PROOF_PATH: " + e.message); }
  let p;
  try { p = JSON.parse(raw); } catch { throw new ProofError("proof file is not valid JSON."); }
  const errs = validateProofShape(p);
  if (errs.length) throw new ProofError("untrusted proof JSON: " + errs.join("; "));
  return p;
}
async function checkFreshness(proof) {
  const h = await call("GET", "/health");
  check("health-ok", h.status === 200 && h.json && h.json.ok === true, "status=" + h.status);
  const r = await call("GET", "/ready");
  check("ready-postgres", r.status === 200 && r.json && r.json.ready === true && r.json.store === "postgres",
    "status=" + r.status + " body=" + String(r.text).slice(0, 160));
  const idx = await call("GET", "/", undefined, { timeout: REQ_MS });
  check("index-fetched", idx.status === 200 && idx.text.length > 0, "status=" + idx.status);
  const served = sha256Hex(idx.text);
  check("index-sha-exact-manifest", served === proof.servedIndexSha256,
    "fetched sha=" + served.slice(0, 16) + "... expected=" + String(proof.servedIndexSha256).slice(0, 16) + "...");
  const st = await call("GET", "/api/auth/status");
  check("auth-status-readable", st.status === 200 && st.json, "status=" + st.status);
  const count = Number(pick(st.json, "accountCount"));
  const required = pick(st.json, "authRequired");
  // ONE fresh attempt only. No resume mode: after registration authRequired is
  // true and the script retains no other account credentials, so a resume that
  // "logs in fresh" would register yet another random account. Removed rather
  // than inventing credential persistence. Primary preserves failed QA data
  // and chooses an explicit new owned run when needed.
  check("auth-pristine-one-attempt", count === 0 && required === false,
    "accountCount=" + count + " authRequired=" + required + " (need 0/false fresh; no resume)");
  return { resumed: false };
}
async function registerLogin() {
  const email = "qa-live-" + crypto.randomBytes(6).toString("hex") + "@example.invalid";
  const password = crypto.randomBytes(24).toString("hex"); // in-memory only; never logged/stored
  const reg = await call("POST", "/api/auth/register", { email, password });
  if (!(reg.status === 200 || reg.status === 201) || !reg.json || typeof reg.json.token !== "string")
    throw new ProofError("register failed status=" + reg.status + " body=" + String(reg.text).slice(0, 200));
  const token = reg.json.token;
  check("register-token-shape", token.length >= 16, "tokenLen=" + token.length + " (value never logged)");
  const me = await call("GET", "/api/auth/me", undefined, { headers: authz(token) });
  check("fresh-login-me", me.status === 200 && me.json &&
    String(pick(me.json, "user") || "").toLowerCase() === email.toLowerCase(),
    "status=" + me.status);
  return { email, token };
}
async function boardsCount(token, tag) {
  const b = await call("GET", "/api/boards", undefined, { headers: authz(token) });
  check("boards-readable-" + tag, b.status === 200 && Array.isArray(b.json), "status=" + b.status);
  return b.json.length;
}
async function checkModelAndSpending(token) {
  const ms = await call("GET", "/api/model/status", undefined, { headers: authz(token) });
  if (ms.status === 403) throw new ProofError("STOP 403 on model status; aborting (no bypass).");
  check("model-status-readable", ms.status === 200 && ms.json, "status=" + ms.status);
  check("model-configured", pick(ms.json, "configured") === true,
    "configured=" + pick(ms.json, "configured") + " model=" + pick(ms.json, "model"));
  const sp = await call("GET", "/api/spending", undefined, { headers: authz(token) });
  if (sp.status === 403) throw new ProofError("STOP 403 on spending (admin-only); aborting (no bypass).");
  check("spending-readable", sp.status === 200 && sp.json, "status=" + sp.status);
  const mode = pick(sp.json, "mode");
  const cap = pick(sp.json, "monthlyCapUsd");
  const enforced = pick(sp.json, "enforced");
  const overCap = pick(sp.json, "overCap");
  check("spending-allowed-mode", mode === "block" || mode === "warn" || mode === "off", "mode=" + mode);
  check("spending-cap-shape", cap === null || cap === undefined || typeof cap === "number", "cap=" + cap);
  const expectedEnforced = mode === "block" && cap !== null && cap !== undefined;
  check("spending-enforced-formula", enforced === expectedEnforced,
    "mode=" + mode + " cap=" + cap + " enforced=" + enforced + " want=" + expectedEnforced);
  // Fresh-DB default warn/cap-null/enforced-false is a VALID policy: do NOT invent a
  // mandatory enforced-cap=true/number requirement (primary never requested force-cap).
  // Effective rule: overCap && mode==block stops further paid calls. Policy is observed
  // only (bounded 1 research/chat/audition + 1 addl ready authorized); never PUT.
  const known = Number(pick(sp.json, "knownSpendUsd") || 0);
  const capNum = typeof cap === "number" ? cap : null;
  const effectiveOverCap = capNum !== null && known >= capNum;
  if (effectiveOverCap && mode === "block")
    throw new ProofError("STOP effective overCap in block mode: known=" + known + " cap=" + capNum + "; aborting paid calls.");
  check("spending-observed-no-put", true, "mode=" + mode + " cap=" + cap + " enforced=" + enforced + " overCap=" + overCap + " (no PUT performed)");
  return {
    model: String(pick(ms.json, "model") || ""),
    modelSource: String(pick(ms.json, "source") || ""),
    spendMode: String(mode || ""),
    monthlyCapUsd: cap === undefined ? null : cap,
    knownSpendUsd: pick(sp.json, "knownSpendUsd"),
    unknownCostCalls: pick(sp.json, "unknownCostCalls"),
    overCap: pick(sp.json, "overCap"),
    enforced: !!enforced,
  };
}
async function quickCreate(token) {
  const q = await call("POST", "/api/roster/quick", {
    accountId: EMPTY_GUID,
    name: ADVISOR_NAME,
    description: ADVISOR_DESC,
    background: ADVISOR_BG,
    sourceUrls: SOURCE_URLS,
    tags: "qa-live-provider-proof",
  }, { headers: authz(token) });
  if (q.status === 403) throw new ProofError("STOP 403 on roster/quick; aborting.");
  check("quick-created", (q.status === 200 || q.status === 201) && q.json && q.json.id,
    "status=" + q.status + " body=" + String(q.text).slice(0, 200));
  const id = String(q.json.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new ProofError("quick returned non-guid id.");
  return { id, version: Number(q.json.version || 1) };
}
async function runResearch(token, id) {
  // Actual server bound: ResearchDeadline <=180s (default 150s). The POST itself
  // awaits the full run; a 60s client cap would abort early and misreport.
  // One absolute research end from BEFORE POST (<=185s, within TOTAL): the POST
  // promise is tracked while concurrently polling the actual GET stages; the
  // request body end is bounded and the POST is awaited exactly once. No retry/double POST.
  const researchStart = Date.now();
  const researchEnd = researchStart + RESEARCH_ABSOLUTE_MS;
  if (researchEnd > HARD_STOP - DRAIN_MS - 2000)
    throw new ProofError("research absolute end would exceed hard TOTAL; refusing to start.");
  const stages = [];
  const postTimeout = clampTimeout(researchEnd - Date.now());
  const postPromise = track(call("POST", "/api/roster/" + id + "/research", { focus: RESEARCH_FOCUS },
    { headers: authz(token), timeout: postTimeout }));
  let postSettled = false, postResult = null, postError = null;
  postPromise.then((r) => { postSettled = true; postResult = r; },
    (e) => { postSettled = true; postError = e; });
  // Concurrent stage poll while POST is pending: free GETs, bounded by the same absolute end.
  while (!postSettled) {
    assertBudget("research-poll");
    if (Date.now() > researchEnd - 1000) break;
    await later(POLL_MS);
    if (postSettled) break;
    if (Date.now() > researchEnd - 1000) break;
    try {
      const g = await call("GET", "/api/roster/" + id + "/research", undefined,
        { headers: authz(token), timeout: clampTimeout(Math.min(REQ_MS, researchEnd - Date.now())) });
      if (g.status === 200 && g.json) {
        stages.push({ tMs: Date.now() - researchStart, stage: String(pick(g.json, "stage") || ""),
          draftStatus: String(pick(g.json, "draftStatus") || ""), running: !!pick(g.json, "running") });
      }
    } catch (e) {
      stages.push({ tMs: Date.now() - researchStart, stage: "poll-error", error: String((e && e.message) || e).slice(0, 120) });
      if (e instanceof ProofError && /TOTAL budget/.test(e.message)) break;
    }
    if (Date.now() > researchEnd) break;
  }
  // Await the single POST exactly once (request/body bounded end already applied).
  let start;
  try { start = await postPromise; }
  catch (e) {
    if (postError && /abort|timeout/i.test(String(postError.message || postError)))
      throw new ProofError("research POST did not complete within the 185s absolute bound; no retry/double POST. detail=" + String((postError && postError.message) || postError).slice(0, 200));
    throw postError || e;
  }
  if (start.status === 403 || start.status === 402 || start.status === 503 || start.status === 504 || start.status === 499)
    throw new ProofError("STOP " + start.status + " on research start/complete (model/policy/deadline); aborting. body=" + String(start.text).slice(0, 200));
  check("research-post-terminal", start.status === 200 || start.status === 202 || start.status === 409,
    "status=" + start.status + " body=" + String(start.text).slice(0, 200));
  if (start.status === 409)
    throw new ProofError("research superseded/conflict (409); no retry/double POST by policy. body=" + String(start.text).slice(0, 200));
  // Final authoritative GET (bounded by remaining TOTAL, not by the research end alone).
  assertBudget("research-final-get");
  const g = await call("GET", "/api/roster/" + id + "/research", undefined, { headers: authz(token) });
  check("research-poll-readable", g.status === 200 && g.json, "status=" + g.status);
  const cur = g.json;
  stages.push({ tMs: Date.now() - researchStart, stage: String(pick(cur, "stage") || ""),
    draftStatus: String(pick(cur, "draftStatus") || ""), running: !!pick(cur, "running") });
  const stage = String(pick(cur, "stage") || "");
  const draftStatus = String(pick(cur, "draftStatus") || "");
  if (stage === "unsupported" || draftStatus === "unsupported")
    throw new ProofError("research UNSUPPORTED (zero grounded evidence); honest stop, no forced retry.");
  if (stage === "failed" || stage === "interrupted")
    throw new ProofError("research terminal failure stage=" + stage + " error=" +
      String(pick(cur, "stageError") || "").slice(0, 200) + "; no forced retry.");
  check("research-done", stage === "done", "stage=" + stage + " draftStatus=" + draftStatus);
  check("research-draft-done", draftStatus === "done", "draftStatus=" + draftStatus + " (need done before PUT save)");
  const srcs = Array.isArray(pick(cur, "sources")) ? pick(cur, "sources") : [];
  // Strict proof ONLY: fetched===true (strict) + non-empty excerpt + URL in the
  // approved seed URLs or actual owned fetch (ownerSupplied===true). Excerpt
  // alone never proves fetch: fetched===false (or missing) always fails.
  const strictGood = srcs.filter((s) => s && s.fetched === true &&
    typeof s.excerpt === "string" && s.excerpt.length > 0 &&
    (SOURCE_URLS.includes(String(s.url || "")) || s.ownerSupplied === true));
  check("research-evidence-fetched", strictGood.length > 0,
    "sources=" + srcs.length + " strict=" + strictGood.length);
  const draft = pick(cur, "draftProfile") || {};
  const paras = {};
  for (const k of PARA_KEYS) paras[k] = typeof draft[k] === "string" ? draft[k] : "";
  for (const k of PARA_KEYS)
    check("draft-para-" + k, paras[k].length > 0 && paras[k].length <= 2000, "len=" + paras[k].length);
  const inputs = pick(cur, "inputs") || null;
  if (inputs) {
    check("research-inputs-background", String(inputs.background || "") === ADVISOR_BG,
      "background preserved full seed");
    check("research-inputs-urls", Array.isArray(inputs.sourceUrls) && SOURCE_URLS.every((u) => inputs.sourceUrls.includes(u)),
      "urls=" + JSON.stringify((inputs && inputs.sourceUrls) || []));
  }
  // Full returned research claims retained (bounded) for dedicated semantic review.
  // Retention is not grounding: excerpts/quotes alone do not prove claim truth.
  const rawClaims = Array.isArray(pick(cur, "claims")) ? pick(cur, "claims") : [];
  const retainedClaims = rawClaims.slice(0, 30).map((c) => ({
    angle: String((c && c.angle) || ""),
    text: String((c && c.text) || "").slice(0, 4000),
    sources: Array.isArray(c && c.sources) ? c.sources.slice(0, 5).map((x) => ({
      url: String((x && x.url) || ""), title: String((x && x.title) || "").slice(0, 200),
    })) : [],
    refs: Array.isArray(c && c.refs) ? c.refs.slice(0, 5).map((x) => ({
      kind: String((x && x.kind) || ""), ref: String((x && x.ref) || "").slice(0, 500),
      url: String((x && x.url) || ""), title: String((x && x.title) || "").slice(0, 200),
      excerpt: String((x && x.excerpt) || "").slice(0, 1000),
      fetched: (x && Object.prototype.hasOwnProperty.call(x, "fetched")) ? (x.fetched === true) : null,
    })) : [],
  }));
  return {
    elapsedMs: Date.now() - researchStart, stages, stage, draftStatus,
    inputs,
    evidence: strictGood.slice(0, 5).map((s) => ({
      url: String(s.url || ""), title: String(s.title || "").slice(0, 200),
      excerpt: String(s.excerpt || "").slice(0, 500), fetched: s.fetched === true,
    })),
    draftParas: paras, researchBaseVersion: pick(cur, "version"),
    claims: retainedClaims, claimsTotalN: rawClaims.length,
  };
}
async function canonicalEntry(token, id) {
  const rl = await call("GET", "/api/roster?accountId=" + EMPTY_GUID, undefined, { headers: authz(token) });
  check("roster-list-readable", rl.status === 200 && Array.isArray(rl.json), "status=" + rl.status);
  let row = null;
  for (const r of rl.json) {
    const e = (r && r.entry) || r;
    if (e && String(e.id || "").toLowerCase() === id.toLowerCase()) { row = e; break; }
  }
  check("canonical-unwrap-exact-id", !!row, "rows=" + rl.json.length);
  let profile = null;
  try { profile = JSON.parse(row.profileJson || "{}"); } catch { profile = null; }
  check("canonical-profile-json", profile && typeof profile === "object", "version=" + row.version);
  const paras = {};
  for (const k of PARA_KEYS) paras[k] = typeof profile[k] === "string" ? profile[k] : "";
  return { entry: row, profile, paras, version: Number(row.version || 0) };
}
async function saveDraftPut(token, id, canon, draftParas) {
  // Capture pre-save research inputs + dossier so the PUT can prove preservation.
  const pre = await call("GET", "/api/roster/" + id + "/research", undefined, { headers: authz(token) });
  const preInputs = (pre.json && pick(pre.json, "inputs")) || null;
  const preBg = preInputs ? String(preInputs.background || "") : "";
  const canonBg = canon.profile && typeof canon.profile.background === "string" ? canon.profile.background : "";
  const next = Object.assign({}, canon.profile);
  for (const k of PARA_KEYS) next[k] = draftParas[k];
  const body = JSON.stringify(next);
  check("put-profile-bounds", body.length <= 20000, "len=" + body.length);
  const v0 = canon.version;
  // Same-profile PUT could no-op on version in theory, but the researched draft
  // differs from the seed profile, so the version contract is exact +1. No edits
  // to this expectation are necessary: the diff is real paragraph content.
  const put = await call("PUT", "/api/roster/" + id, { profileJson: body }, { headers: authz(token) });
  if (put.status === 403 || put.status === 409)
    throw new ProofError("STOP " + put.status + " on roster PUT; aborting. body=" +
      String(put.text).slice(0, 200));
  check("put-saved", put.status === 200 && put.json, "status=" + put.status);
  check("put-version-advance", Number(put.json.version || 0) === v0 + 1, "v0=" + v0 + " v1=" + put.json.version);
  const back = await canonicalEntry(token, id);
  for (const k of PARA_KEYS)
    check("put-readback-" + k, back.paras[k] === draftParas[k], "len=" + back.paras[k].length);
  // Canonical background: all other profile fields round-trip byte-identical.
  if (canonBg) check("put-background-preserved", back.profile && back.profile.background === canonBg,
    "background round-tripped");
  for (const k of Object.keys(canon.profile || {})) {
    if (PARA_KEYS.includes(k)) continue;
    check("put-field-preserved-" + k, JSON.stringify(back.profile[k]) === JSON.stringify(canon.profile[k]),
      "field=" + k);
  }
  // Explicit Saved proof: dossier stage stays done (ResearchedAt set) and
  // draftStatus becomes saved; inputs background/URLs survive the behavior save.
  const rs = await call("GET", "/api/roster/" + id + "/research", undefined, { headers: authz(token) });
  check("dossier-stage-done", rs.status === 200 && String(pick(rs.json, "stage") || "") === "done",
    "stage=" + (rs.json && pick(rs.json, "stage")));
  check("dossier-draft-saved", rs.status === 200 && String(pick(rs.json, "draftStatus") || "") === "saved",
    "draftStatus=" + (rs.json && pick(rs.json, "draftStatus")) + " (explicit PUT save proof)");
  const post = (rs.json && pick(rs.json, "inputs")) || null;
  if (preBg) check("dossier-inputs-background", post && String(post.background || "") === preBg, "inputs background preserved");
  if (preInputs && Array.isArray(preInputs.sourceUrls))
    check("dossier-inputs-urls", post && Array.isArray(post.sourceUrls) && JSON.stringify(post.sourceUrls) === JSON.stringify(preInputs.sourceUrls),
      "inputs urls preserved");
  return { version: back.version, readback: back.paras };
}
async function rosterChatOnce(token, id, version) {
  const c = await call("POST", "/api/roster/" + id + "/chat", { message: NARROW_QUESTION },
    { headers: authz(token), timeout: clampTimeout(120000) });
  if (c.status === 403 || c.status === 402 || c.status === 409 || c.status === 503)
    throw new ProofError("STOP " + c.status + " on roster chat; aborting. body=" + String(c.text).slice(0, 200));
  check("chat-ok", c.status === 200 && c.json && typeof c.json.answer === "string" && c.json.answer.length > 0,
    "status=" + c.status);
  check("chat-version-pinned", Number(c.json.rosterVersion || 0) === version,
    "rosterVersion=" + c.json.rosterVersion + " want=" + version);
  check("chat-not-stored", c.json.stored === false, "stored=" + c.json.stored);
  return { answer: c.json.answer };
}
async function auditionOnce(token, id, version) {
  const a = await call("POST", "/api/auditions", { rosterId: id, question: NARROW_QUESTION },
    { headers: authz(token), timeout: clampTimeout(120000) });
  if (a.status === 403 || a.status === 402 || a.status === 409 || a.status === 503)
    throw new ProofError("STOP " + a.status + " on audition; aborting. body=" + String(a.text).slice(0, 200));
  check("audition-ok", a.status === 200 && a.json && typeof a.json.answer === "string" && a.json.answer.length > 0,
    "status=" + a.status);
  check("audition-version-pinned", Number(a.json.rosterVersion || 0) === version,
    "rosterVersion=" + a.json.rosterVersion + " want=" + version);
  check("audition-not-stored", a.json.stored === false, "stored=" + a.json.stored);
  return { answer: a.json.answer };
}
const partial = {};
function artifactBase(extra) {
  return Object.assign({
    contract: {
      script: "qa/advisor-live-provider-proof.mjs",
      origin: ORIGIN, project: expectedProject(), sourceCommitExact: expectedSourceCommit(),
      trustedContainerId: partial.provenance?.containerId || "primary proof required",
      callBudget: "1 research + 1 roster-chat + 1 audition (no retries/double POST; polls are free GETs)",
      totalBudgetMs: TOTAL_MS, drainMs: DRAIN_MS, researchAbsoluteMs: RESEARCH_ABSOLUTE_MS,
      spending: "observed only (warn/null/false is VALID fresh default); no spending/model PUT",
      attempt: "one fresh attempt only; no resume/extra accounts/retry",
      forbidden: ["admin DB/restore/reconcile", "policy PUTs", ".env/keys", "5173/15180/9333/5080",
        "board/meeting run", "token/password logs"],
    },
    runTag: RUN_TAG, elapsedMs: Date.now() - startedAt,
    structuralChecks: structural,
    meetingIntegration: "NOT CLAIMED: no board created/joined/run; boards count asserted unchanged.",
    semanticGate: "PENDING: dedicated AI semantic review of paragraphs/chat/audition still required; " +
      "structural checks above are not model self-rating or claim-tone proof. " +
      "Full returned research claims are retained in research.claims for that review; structural counts and semantics are separate.",
  }, extra || {});
}
async function writeArtifacts(doc) {
  // No assertBudget here: at TOTAL expiry the execution budget is gone, but the
  // ONE absolute 15s cleanup allowance (drainAndExit) still covers this write.
  const jsonText = JSON.stringify(doc, null, 2);
  await track(fs.writeFile(RESULT_PATH, jsonText, "utf8"));
  const mdPath = RESULT_PATH.replace(/\.json$/i, "") + ".md";
  const L = [];
  L.push("# Advisor live-provider proof — " + RUN_TAG);
  L.push("");
  L.push("- Origin: " + ORIGIN + " | Project: " + expectedProject() + " (" + PROJECT_ALLOWLIST.join("/") + ") | Elapsed: " + doc.elapsedMs + " ms");
  L.push("- Freshness: " + (doc.freshness || ""));
  L.push("- Model: " + ((doc.modelInfo && doc.modelInfo.model) || "") + " (" +
    ((doc.modelInfo && doc.modelInfo.modelSource) || "") + ")");
  L.push("- Spending: mode=" + ((doc.modelInfo && doc.modelInfo.spendMode) || "") +
    " cap=" + ((doc.modelInfo && doc.modelInfo.monthlyCapUsd) ?? "") +
    " known=" + ((doc.modelInfo && doc.modelInfo.knownSpendUsd) ?? "") +
    " enforced=" + ((doc.modelInfo && doc.modelInfo.enforced) ?? ""));
  L.push("- Research: stage=" + ((doc.research && doc.research.stage) || "") +
    " draftStatus=" + ((doc.research && doc.research.draftStatus) || "") +
    " elapsedMs=" + ((doc.research && doc.research.elapsedMs) ?? "") +
    " stages=" + ((doc.research && doc.research.stages.map((s) => s.stage).join("->")) || ""));
  L.push("");
  L.push("## Evidence-backed URLs");
  for (const e of ((doc.research && doc.research.evidence) || []))
    L.push("- [" + (e.title || e.url) + "](" + e.url + ") fetched=" + e.fetched);
  L.push("- Full returned research claims retained: " + (((doc.research && doc.research.claims) || []).length) + " of " + ((doc.research && doc.research.claimsTotalN) ?? "?") + " (retention is not grounding; dedicated semantic review still required).");
  L.push("");
  for (const k of PARA_KEYS) {
    L.push("## " + k);
    L.push("");
    L.push(((doc.paragraphs && doc.paragraphs[k]) || ""));
    L.push("");
  }
  L.push("## Roster-only direct chat answer");
  L.push("");
  L.push(((doc.chat && doc.chat.answer) || ""));
  L.push("");
  L.push("## Audition answer");
  L.push("");
  L.push(((doc.audition && doc.audition.answer) || ""));
  L.push("");
  L.push("## Structural checks (" + structural.filter((s) => s.pass).length + "/" + structural.length + " pass)");
  for (const s of structural) L.push("- [" + (s.pass ? "x" : " ") + "] " + s.name + " — " + s.detail);
  L.push("");
  L.push("> Semantic gate PENDING: paragraphs/chat/audition require dedicated AI semantic review.");
  await track(fs.writeFile(mdPath, L.join("\n"), "utf8"));
  return { jsonPath: RESULT_PATH, mdPath };
}
async function drainAndExit(code, doc) {
  for (const ctl of Array.from(inFlight)) { try { ctl.abort(new Error("drain")); } catch {} }
  // ONE absolute 15s cleanup allowance shared by abort/drain + artifact write:
  // cleanupEnd caps everything (no separate 15s + 10s beyond this allowance).
  // Execution (assertBudget/clampTimeout) stays hard at HARD_STOP; only this
  // cleanup path may run past HARD_STOP, up to HARD_STOP + DRAIN_MS.
  const cleanupEnd = Math.min(HARD_STOP + DRAIN_MS, Date.now() + DRAIN_MS);
  try {
    while (pendingOps.size > 0 && Date.now() < cleanupEnd) await new Promise((r) => setTimeout(r, 50));
  } catch {}
  for (const t of Array.from(timers)) { try { clearTimeout(t); } catch {} timers.delete(t); }
  const paths = { jsonPath: RESULT_PATH, mdPath: RESULT_PATH.replace(/\.json$/i, "") + ".md" };
  // No success after execution expiry, and no success on failed pending drain.
  let finalCode = code;
  if (Date.now() > HARD_STOP) finalCode = 1;
  if (pendingOps.size > 0) finalCode = 1;
  if (doc) {
    try {
      doc.elapsedMs = Date.now() - startedAt;
      doc.outcome = finalCode === 0 ? "PASS" : "FAIL";
      if (pendingOps.size > 0) doc.pendingDrainFailed = true;
      if (Date.now() > HARD_STOP) doc.executionExpired = true;
      const remain = Math.max(0, cleanupEnd - Date.now());
      const w = await Promise.race([
        writeArtifacts(doc),
        new Promise((_, rej) => setTimeout(() => rej(new Error("artifact write exceeded cleanup budget")), remain)),
      ]);
      paths.jsonPath = w.jsonPath; paths.mdPath = w.mdPath;
    } catch (e) {
      // Artifact write failure MUST be nonzero: never report PASS without the artifact.
      console.log("artifact write failed: " + e.message);
      console.log("LIVE-PROVIDER PROOF FAIL (exit 1)");
      console.log("artifact: " + paths.jsonPath);
      process.exit(1);
    }
  }
  console.log(finalCode === 0 ? "LIVE-PROVIDER PROOF PASS" : "LIVE-PROVIDER PROOF FAIL (exit " + finalCode + ")");
  console.log("artifact: " + paths.jsonPath);
  console.log("readable: " + paths.mdPath);
  process.exit(finalCode);
}
let unhandled = null;
process.on("unhandledRejection", (e) => {
  // Never swallow: record first unhandled rejection; main turns it into FAIL with partials.
  if (!unhandled) unhandled = e;
  console.log("unhandled: " + ((e && e.message) || e));
});
async function main() {
  if (!GATE) { await validateOnly(); return; }
  try {
    refuseUnlessOrigin(ORIGIN + "/api/health");
    const seedErrs = validateAdvisorSeed();
    if (seedErrs.length) throw new ProofError("seed invalid: " + seedErrs.join(";"));
    const proof = await readProof();
    partial.provenance = {
      project: proof.project,
      containerId: String(proof.containerId),
      imageId: String(proof.imageId),
      sourceCommit: proof.sourceCommit, apiOrigin: proof.apiOrigin,
      indexShaMatch: false, resumed: false,
    };
    const fresh = await checkFreshness(proof);
    partial.provenance.indexShaMatch = true;
    partial.freshness = "pristine accountCount=0 authRequired=false";
    const creds = await registerLogin();
    partial.qaEmail = creds.email;
    partial.identityNote = "nonsecret identity only (email/advisor id); password/token never stored in artifact";
    const token = creds.token;
    const boardsBefore = await boardsCount(token, "before");
    partial.boardsBefore = boardsBefore;
    const modelInfo = await checkModelAndSpending(token);
    partial.modelInfo = modelInfo;
    const created = await quickCreate(token);
    partial.advisor = { id: created.id, name: ADVISOR_NAME, versions: [created.version] };
    const research = await runResearch(token, created.id);
    partial.research = research;
    partial.paragraphs = research.draftParas;
    const canon = await canonicalEntry(token, created.id);
    partial.advisor.versions.push(canon.version);
    const saved = await saveDraftPut(token, created.id, canon, research.draftParas);
    partial.advisor.versions.push(saved.version);
    partial.paragraphs = saved.readback;
    const chat = await rosterChatOnce(token, created.id, saved.version);
    partial.chat = chat;
    const audition = await auditionOnce(token, created.id, saved.version);
    partial.audition = audition;
    const boardsAfter = await boardsCount(token, "after");
    check("boards-unchanged-no-meeting-run", boardsAfter === boardsBefore,
      "before=" + boardsBefore + " after=" + boardsAfter);
    if (unhandled) throw new ProofError("unhandled rejection observed: " + String((unhandled && unhandled.message) || unhandled).slice(0, 200));
    const doc = artifactBase(Object.assign({ provenance: partial.provenance,
      freshness: partial.freshness, qaEmail: partial.qaEmail, boardsBefore, boardsAfter,
      modelInfo, research, advisor: partial.advisor,
      paragraphs: saved.readback, chat, audition }, {}));
    await drainAndExit(0, doc);
  } catch (e) {
    console.log("FAIL: " + (e && e.message));
    try {
      // Failure retains completed research/paragraph/identity-nonsecret/partial
      // results instead of discarding the doc.
      const doc = artifactBase(Object.assign({
        error: String((e && e.message) || e),
        provenance: partial.provenance || null,
      }, partial));
      if (unhandled && !/unhandled/.test(String((e && e.message) || "")))
        doc.unhandled = String((unhandled && unhandled.message) || unhandled).slice(0, 300);
      await drainAndExit(1, doc);
    } catch { process.exit(1); }
  }
}
await main();

