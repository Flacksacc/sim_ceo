// Voice account-authority driver: REAL server register/login/session
// credentials for two distinct accounts (A/B), never a localStorage-only
// epoch pretend. Runs against the OWN exclusive API (default 5125) with the
// OWN fake (default 5225) behind it. Shared Auth/Core gates (secure
// boundary, grants, session invalidation) are integration-owned: steps that
// the current checkpoint cannot support report PENDING-SHARED-AUTH with the
// exact observation, and exit 0. Only voice-lane defects FAIL (exit 1).
// No paid calls; no user ports; loopback only.
const API = process.env.QA_API || "http://127.0.0.1:5125";
const FAKE = process.env.QA_FAKE || "http://127.0.0.1:5225";
for (const [v, port, label] of [[API, 5125, "api"], [FAKE, 5225, "fake"]]) {
  let u = null;
  try { u = new URL(v); } catch { u = null; }
  // Bracket-tolerant loopback: URL keeps IPv6 brackets in hostname.
  const host = u ? String(u.hostname).replace(/^\[/, "").replace(/\]$/, "") : "";
  const loop = !!u && (host === "127.0.0.1" || host === "localhost" || host === "::1");
  const rooted = !!u && u.pathname === "/";
  const protoOk = !!u && u.protocol === "http:";
  const secrets = !!u && (u.username !== "" || u.password !== "" || (u.search !== "" && u.search !== "?") || u.hash !== "");
  if (!u || !loop || !rooted || !protoOk || secrets || Number(u.port) !== port || /:(5080|5173)\b/.test(String(v))) {
    console.log("  FAIL " + label + "-owns-port :: must be http loopback :" + port + " root no-userinfo/query/fragment (raw value withheld)");
    process.exit(2);
  }
}
let pass = 0, pend = 0, fail = 0;
const failures = [], pendings = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; failures.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL " + name + (extra ? " :: " + extra : "")); }
}
function pending(name, why) {
  pend++; pendings.push(name + " :: " + why);
  console.log("  PENDING-SHARED-AUTH " + name + " :: " + why);
}
async function req(method, path, opts) {
  const hasBody = method !== "GET" && method !== "HEAD";
  const r = await fetch(API + path, {
    method,
    headers: { "content-type": "application/json", ...((opts && opts.headers) || {}) },
    body: !hasBody ? undefined : (opts && opts.body === undefined ? undefined : JSON.stringify((opts && opts.body) || {})),
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: r.status, json, text };
}
const bearer = (t) => ({ Authorization: "Bearer " + t });
const run = "drv-" + Date.now().toString(36);
const emailA = run + "-a@example.com";
const emailB = run + "-b@example.com";
const pw = "qa-driver-pass-0123456789";
// 1. Baseline status on the fresh exclusive API.
{
  const st = await req("GET", "/api/auth/status");
  ok("status-shape", st.status === 200 && st.json && typeof st.json.authRequired === "boolean", st.status + " " + st.text.slice(0, 160));
  console.log("  info baseline authRequired=" + (st.json && st.json.authRequired) + " accounts=" + (st.json && st.json.accountCount));
}
// 2. Register two REAL distinct accounts.
let tokenA = "", tokenB = "";
{
  const ra = await req("POST", "/api/auth/register", { body: { email: emailA, password: pw } });
  ok("register-a-201", ra.status === 201 && ra.json && typeof ra.json.token === "string" && ra.json.token.length >= 32, ra.status + " " + ra.text.slice(0, 200));
  tokenA = (ra.json && ra.json.token) || "";
  const rb = await req("POST", "/api/auth/register", { body: { email: emailB, password: pw } });
  ok("register-b-201", rb.status === 201 && rb.json && typeof rb.json.token === "string" && rb.json.token.length >= 32, rb.status + " " + rb.text.slice(0, 200));
  tokenB = (rb.json && rb.json.token) || "";
  ok("tokens-distinct", !!tokenA && !!tokenB && tokenA !== tokenB, "lenA=" + tokenA.length + " lenB=" + tokenB.length);
  const dup = await req("POST", "/api/auth/register", { body: { email: emailA, password: pw } });
  ok("register-duplicate-409", dup.status === 409, dup.status + " " + dup.text.slice(0, 160));
}
// 3. Login + negative; session resolution via /api/auth/me.
{
  const li = await req("POST", "/api/auth/login", { body: { email: emailA, password: pw } });
  ok("login-a-200", li.status === 200 && li.json && typeof li.json.token === "string", li.status + " " + li.text.slice(0, 200));
  const bad = await req("POST", "/api/auth/login", { body: { email: emailA, password: "wrong-" + pw } });
  ok("login-wrong-401", bad.status === 401, bad.status + " " + bad.text.slice(0, 160));
  const meA = await req("GET", "/api/auth/me", { headers: bearer(tokenA) });
  ok("me-a-authenticated", meA.status === 200 && meA.json && meA.json.authenticated === true && meA.json.user === emailA, meA.status + " " + meA.text.slice(0, 200));
  const meB = await req("GET", "/api/auth/me", { headers: bearer(tokenB) });
  ok("me-b-authenticated", meB.status === 200 && meB.json && meB.json.authenticated === true && meB.json.user === emailB, meB.status + " " + meB.text.slice(0, 200));
  const meNone = await req("GET", "/api/auth/me");
  ok("me-none-unauthenticated", meNone.status === 200 && meNone.json && meNone.json.authenticated === false, meNone.status + " " + meNone.text.slice(0, 160));
}
// 4. A creates board+meeting under REAL authority (OwnerKey = emailA).
let bid = "", mid = "";
{
  const b = await req("POST", "/api/boards", { headers: bearer(tokenA), body: { name: run + "-b", mission: run + " mission", stage: "qa" } });
  if (b.status === 201 && b.json && (b.json.id || b.json.Id)) {
    bid = b.json.id || b.json.Id;
    ok("board-a-201", true);
    ok("board-ownerkey-a", (b.json.ownerKey || b.json.OwnerKey) === emailA, JSON.stringify(b.json).slice(0, 200));
  } else {
    pending("board-a-create", "expected 201 Bearer-A, got " + b.status + " " + b.text.slice(0, 160));
  }
  if (bid) {
    const m = await req("POST", "/api/boards/" + bid + "/meetings", { headers: bearer(tokenA), body: { title: run + " m1", brief: "driver brief" } });
    if (m.status === 201 || m.status === 200) {
      mid = (m.json && (m.json.id || m.json.Id)) || "";
      ok("meeting-a-created", !!mid, m.status + " " + m.text.slice(0, 160));
    } else {
      pending("meeting-a-create", "expected 2xx Bearer-A, got " + m.status + " " + m.text.slice(0, 160));
    }
  }
}
// 5. B attempts transcribe on A's meeting: server MUST distinguish (403).
// 6. A transcribes with REAL credentials: 201 + creator binding.
function makeWav16(sr, seconds, freq) {
  const n = Math.floor(sr * seconds);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8);
  buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(32767 * 0.5 * Math.sin((2 * Math.PI * freq * i) / sr)), 44 + i * 2);
  return buf;
}
async function postTranscribe(midV, buf, headers) {
  const form = new FormData();
  form.append("audio", new Blob([buf], { type: "audio/wav" }), "mic.wav");
  const r = await fetch(API + "/api/meetings/" + midV + "/transcribe", { method: "POST", headers, body: form });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: r.status, json, text };
}
let turnA = "";
if (mid) {
  const wav = makeWav16(16000, 0.5, 440);
  const rb = await postTranscribe(mid, wav, bearer(tokenB));
  if (rb.status === 403) {
    ok("transcribe-b-denied-403", true, rb.text.slice(0, 160));
  } else {
    // SEVENTH: authority already proved (board+meeting created with Bearer-A),
    // so ANY unexpected Voice/provider response for B (including 502) is a
    // voice defect and MUST FAIL. PENDING is reserved for observed shared
    // integration blockers only, never for post-authority voice results.
    ok("transcribe-b-denied-403", false, "expected 403 Bearer-B on A meeting, got " + rb.status + " " + rb.text.slice(0, 160));
  }
  const ra = await postTranscribe(mid, wav, bearer(tokenA));
  if (ra.status === 201 && ra.json && (ra.json.transcript || ra.json.Transcript) === "qa transcript") {
    ok("transcribe-a-201", true);
    turnA = ra.json.turn || ra.json.Turn || "";
    ok("transcribe-a-turn", typeof turnA === "string" && turnA.length > 0, JSON.stringify(ra.json).slice(0, 200));
  } else {
    // SIXTH: authority already proved (board+meeting created with Bearer-A),
    // so a Voice/provider failure (e.g. 502) is a VOICE defect and MUST FAIL.
    // PENDING is reserved for demonstrated shared-auth blockers only.
    ok("transcribe-a-201", false, "expected 201 Bearer-A, got " + ra.status + " " + ra.text.slice(0, 200));
  }
  // SIXTH: controlled provider-failure proof under real credentials.
  // Arm the owned fake once; the REAL API must return 502 (failed pair).
  // After proved authority this is a voice result, never shared-auth pending.
  {
    const w502 = makeWav16(16000, 0.5, 440);
    let armed502 = false;
    try {
      const fr = await fetch(FAKE + "/__fail-next-transcribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: 502, body: "provider request aborted" }) });
      armed502 = fr.status === 200;
    } catch { armed502 = false; }
    ok("voice502-fake-armed", armed502 === true, "fake arm must succeed on owned fake");
    if (armed502) {
      const r502 = await postTranscribe(mid, w502, bearer(tokenA));
      ok("voice502-api-502", r502.status === 502, "expected 502 Bearer-A, got " + r502.status + " " + r502.text.slice(0, 200));
    }
  }
  // 7. Creator-private list: A sees the draft, B must not (or 403 at board).
  if (turnA) {
    const la = await req("GET", "/api/meetings/" + mid + "/voice", { headers: bearer(tokenA) });
    const seenA = la.status === 200 && Array.isArray(la.json) && la.json.some((v) => String(v.id || v.Id) === String(turnA));
    if (la.status === 200 && seenA) {
      ok("list-a-sees-own-draft", true);
      const row = la.json.find((v) => String(v.id || v.Id) === String(turnA));
      ok("list-a-draft-state", (row.state || row.State) === "draft", JSON.stringify(row).slice(0, 200));
    } else {
      ok("list-a-sees-own-draft", false, "expected A to list own draft turn, got " + la.status + " " + la.text.slice(0, 200));
    }
    const lb = await req("GET", "/api/meetings/" + mid + "/voice", { headers: bearer(tokenB) });
    if (lb.status === 403) {
      ok("list-b-denied-403", true, lb.text.slice(0, 160));
    } else if (lb.status === 200 && Array.isArray(lb.json) && !lb.json.some((v) => String(v.id || v.Id) === String(turnA))) {
      ok("list-b-hides-a-draft", true, "rows=" + lb.json.length);
    } else {
      // SEVENTH: turnA exists under proved Bearer-A authority, so any other
      // B list outcome (including 502/provider responses) is a voice defect
      // and MUST FAIL. PENDING only for observed shared blockers.
      ok("list-b-isolation", false, "expected 403 or hidden draft for B, got " + lb.status + " " + lb.text.slice(0, 200));
    }
    // 8. Finalize is creator-private: B must fail, A succeeds.
    const fb = await req("POST", "/api/voice/" + turnA + "/finalize", { headers: bearer(tokenB), body: { transcript: "qa transcript" } });
    if (fb.status === 403 || fb.status === 401) {
      ok("finalize-b-denied", true, fb.status + " " + fb.text.slice(0, 160));
    } else {
      // SEVENTH: proved authority; unexpected finalize outcome (including
      // provider/voice 502) MUST FAIL, never shared-auth pending.
      ok("finalize-b-denied", false, "expected 401/403 Bearer-B finalizing A turn, got " + fb.status + " " + fb.text.slice(0, 200));
    }
    const fa = await req("POST", "/api/voice/" + turnA + "/finalize", { headers: bearer(tokenA), body: { transcript: "qa transcript" } });
    if (fa.status === 200) {
      ok("finalize-a-200", true);
    } else {
      ok("finalize-a-200", false, "expected 200 Bearer-A, got " + fa.status + " " + fa.text.slice(0, 200));
    }
  }
} else {
  pending("authority-voice-steps", "no meeting; board/meeting creation blocked by shared-auth gate");
}
// 9. Logout revokes: me becomes unauthenticated.
if (tokenA) {
  const lo = await req("POST", "/api/auth/logout", { headers: bearer(tokenA), body: {} });
  ok("logout-a-shape", lo.status === 200, lo.status + " " + lo.text.slice(0, 160));
  const meAfter = await req("GET", "/api/auth/me", { headers: bearer(tokenA) });
  // Revoked bearer is rejected (401) or reports unauthenticated: either way
  // it no longer authenticates. 401 is the secure-correct stale-bearer
  // outcome (the App expires the identity on 401 via fetchAuth).
  const loggedOut = meAfter.status === 401 || (meAfter.status === 200 && meAfter.json && meAfter.json.authenticated === false);
  ok("me-after-logout-not-authenticated", loggedOut, meAfter.status + " " + meAfter.text.slice(0, 160));
}
if (fail > 0) console.log("VOICEDRIVER FAIL pass=" + pass + " pending=" + pend + " fail=" + fail);
else if (pend > 0) console.log("VOICEDRIVER INCOMPLETE pass=" + pass + " pending=" + pend + " fail=" + fail);
else console.log("VOICEDRIVER PASS pass=" + pass + " pending=" + pend);
for (const p of pendings) console.log(" - PENDING " + p);
for (const f of failures) console.log(" - " + f);
process.exitCode = fail === 0 ? 0 : 1;
