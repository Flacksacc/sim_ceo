// qa/meeting-activity-pg-qa.mjs - FOCUSED native-PG MeetingActivity QA (Muse-authored).
// Own children only: API 127.0.0.1:5275 (USE_POSTGRES=1, owned test DB only),
// inline fake model 127.0.0.1:5276. Refuses 5080/5173/9333/5199/5271/5272.
// Do NOT manage Docker (existing simceo-integration-qa-pg untouched); connect
// via Npgsql-compatible TCP using the authorized QA credential only.
// Unique owned DB simceo_act_* is created for this run and dropped at the end;
// the simceo maintenance DB is used ONLY for CREATE/DROP DATABASE. Live volumes
// and other databases are never touched. Kills only own children.
//
// Proves, against durable storage (not memory 404s): fresh boot on owned DB,
// kill WHILE run+secretary provider calls are blocked, restart on the SAME DB,
// durable request/row survival with terminal interrupted (no infinite
// activity), post-restart new work, and private auth/session/snapshot
// boundaries. Memory-fixture checks stay in meeting-activity-qa.mjs.
import http from "node:http";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import crypto from "node:crypto";

const require = createRequire(process.cwd() + "/qa/.pgclient/");
const { Client } = require("pg");

const API = "http://127.0.0.1:5275";
const FAKE_PORT = 5276;
for (const bad of [":5080", ":5173", ":9333", ":5199", ":5271", ":5272", ":5099", ":5100"]) {
  if (API.includes(bad)) { console.error("REFUSE port"); process.exit(2); }
}
const PG = { host: "127.0.0.1", port: 15441, user: "simceo", password: "qa-only" };
const OWN_DB = "simceo_act_" + Date.now().toString(36).replace(/[^a-z0-9]/g, "") + Math.floor(Math.random() * 1296).toString(36);
const CONN = `Host=${PG.host};Port=${PG.port};Database=${OWN_DB};Username=${PG.user};Password=${PG.password}`;

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; const m = name + (extra ? " :: " + extra : ""); failures.push(m); console.log("  FAIL " + m); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const camel = (o, k) => {
  if (!o || typeof o !== "object") return undefined;
  if (k in o) return o[k];
  const lo = k.toLowerCase();
  for (const key of Object.keys(o)) if (key.toLowerCase() === lo) return o[key];
  return undefined;
};
async function req(method, path, body, token, timeoutMs = 30000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const headers = { "content-type": "application/json" };
    if (token) headers.authorization = "Bearer " + token;
    else headers["x-user"] = "owner";
    const r = await fetch(API + path, {
      method, signal: ctl.signal, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text };
  } finally { clearTimeout(t); }
}
async function pgAdmin(sql, params = []) {
  const c = new Client({ ...PG, database: "simceo", connectionTimeoutMillis: 8000 });
  await c.connect();
  try { return await c.query(sql, params); }
  finally { await c.end(); }
}
async function pgOwned(sql, params = []) {
  const c = new Client({ ...PG, database: OWN_DB, connectionTimeoutMillis: 8000 });
  await c.connect();
  try { return await c.query(sql, params); }
  finally { await c.end(); }
}

function startFake() {
  const server = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/chat/completions") {
      let raw = "";
      for await (const c of req) raw += c;
      let body = {};
      try { body = JSON.parse(raw); } catch { body = {}; }
      const prompt = (body.messages || []).map((m) => m.content).join("\n") || "";
      const ms = /QA-SLEEP:(\d+)/.exec(prompt);
      if (ms) await sleep(Math.min(Number(ms[1]), 15000));
      const send = (code, obj) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      const chat = (content) => send(200, {
        id: "qa-" + Date.now(),
        choices: [{ message: { role: "assistant", content } }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      });
      if (/Reply with exactly YES or NO/.test(prompt)) {
        if (/QASlow/.test(prompt)) await sleep(8000);
        chat("YES - directly relevant.");
        return;
      }
      if (/YOUR TURN/.test(prompt)) {
        if (/QASlow/.test(prompt)) await sleep(8000);
        chat("QA advisor reply with a clear position. [stance: Agrees]");
        return;
      }
      if (/board secretary/i.test(prompt)) {
        if (/OWNER ANSWER/.test(prompt) || !/QA-/.test(prompt)) { chat(JSON.stringify({ kind: "note", title: "QA note", body: "QA secretary body" })); return; }
        chat(JSON.stringify({ kind: "note", title: "QA note", body: "QA secretary body" }));
        return;
      }
      chat("QA default text.");
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "qa: unknown route" }));
  });
  return new Promise((resolve) => server.listen(FAKE_PORT, "127.0.0.1", () => resolve(server)));
}

let QA_API_CFG = {};
try { QA_API_CFG = JSON.parse(require("node:fs").readFileSync("qa/.qarun-pg.json", "utf8")); } catch { QA_API_CFG = {}; }
const ALT_DLL = process.env.QA_ALT_DLL || QA_API_CFG.altDll || "";
function startApi() {
  const altArgs = ALT_DLL ? [ALT_DLL] : ["run", "--project", "server/SimCEO.Api", "--no-build"];
  const child = spawn("dotnet", altArgs, {
    cwd: process.cwd(),
    windowsHide: true,
    env: {
      ...process.env,
      ASPNETCORE_URLS: "http://127.0.0.1:5275",
      USE_POSTGRES: "1",
      ConnectionStrings__App: CONN,
      META_API_BASE: "http://127.0.0.1:" + FAKE_PORT,
      META_API_KEY: "qa-key",
      ASPNETCORE_ENVIRONMENT: "Development",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  return child;
}
async function waitApi() {
  for (let i = 0; i < 90; i++) {
    try {
      const r = await req("GET", "/api/presets", undefined, undefined, 3000);
      if (r.status === 200) return true;
    } catch { }
    await sleep(1000);
  }
  return false;
}
function killProc(child) {
  return new Promise((resolve) => {
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    try {
      child.on("exit", fin);
      try { child.kill("SIGKILL"); } catch { try { child.kill(); } catch { } }
      setTimeout(fin, 8000);
    } catch { fin(); }
  });
}
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
async function uploadPortrait(rosterId, token) {
  const form = new FormData();
  form.append("file", new Blob([PNG], { type: "image/png" }), "qa.png");
  const r = await fetch(API + "/api/roster/" + rosterId + "/image/upload", {
    method: "POST", headers: { authorization: "Bearer " + token }, body: form,
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: r.status, json, text };
}
const run = "qa-pg-" + Date.now().toString(36);
const ACCT = crypto.randomUUID();
async function makeAdvisor(boardId, role, token) {
  const nm = run + "-" + role;
  const q = await req("POST", "/api/roster/quick", { accountId: ACCT, name: nm, description: role + " helping with " + run }, token);
  if (q.status !== 201) return { error: "quick:" + q.status + " " + q.text.slice(0, 200) };
  const rid = camel(q.json, "id");
  const up = await uploadPortrait(rid, token);
  if (up.status !== 201) return { error: "upload:" + up.status + " " + up.text.slice(0, 200) };
  const imgs = await req("GET", "/api/roster/" + rid + "/images", undefined, token);
  const imgId = imgs.json?.[0]?.id || camel(imgs.json?.[0], "id");
  const rev = await req("POST", "/api/images/" + imgId + "/review", { decision: "accept" }, token);
  if (rev.status !== 200) return { error: "review:" + rev.status + " " + rev.text.slice(0, 200) };
  const cp = await req("POST", "/api/roster/" + rid + "/copy", { boardId, boardRole: role }, token);
  if (cp.status !== 201) return { error: "copy:" + cp.status + " " + cp.text.slice(0, 200) };
  const aid = camel(cp.json, "id");
  const ap = await req("POST", "/api/boards/" + boardId + "/advisors/" + aid + "/approve", {}, token);
  if (ap.status !== 200) return { error: "approve:" + ap.status + " " + ap.text.slice(0, 200) };
  return { rid, aid };
}
const actOf = (s) => s.json && s.json.discussion;

let api = null;
let fake = null;

async function main() {
  await pgAdmin(`CREATE DATABASE "${OWN_DB}"`);
  console.log("owned db " + OWN_DB);
  fake = await startFake();
  api = startApi();
  ok("pg api boots on owned DB", await waitApi(), "no 200 within 90s");

  const oMail = "owner-" + run + "@example.com";
  const gMail = "guest-" + run + "@example.com";
  const PW = "password12345678";
  let OT = camel((await req("POST", "/api/auth/register", { email: oMail, password: PW })).json, "token");
  ok("pg register owner", !!OT, "no token");
  let GT = camel((await req("POST", "/api/auth/register", { email: gMail, password: PW })).json, "token");
  ok("pg register guest", !!GT, "no token");
  const b = await req("POST", "/api/boards", { name: run + " board", mission: run + " m", stage: "qa" }, OT);
  const bid = camel(b.json, "id");
  ok("pg create board", b.status === 201 && !!bid, b.status + " " + b.text.slice(0, 120));
  await req("POST", "/api/boards/" + bid + "/lead", { name: "QA Lead", roleLabel: "Lead" }, OT);
  const a1 = await makeAdvisor(bid, "QASlowP", OT);
  ok("pg advisor QASlowP ready", !a1.error, a1.error || "");
  const a2 = await makeAdvisor(bid, "QASlowQ", OT);
  ok("pg advisor QASlowQ ready", !a2.error, a2.error || "");
  const m = await req("POST", "/api/boards/" + bid + "/meetings", { title: run + " m1", brief: "pg brief" }, OT);
  const mid = camel(m.json, "id");
  ok("pg create meeting", m.status === 201 && !!mid, m.status + " " + m.text.slice(0, 120));
  const gr = await req("POST", "/api/boards/" + bid + "/grants", { userKey: gMail, meetingId: mid, access: "read" }, OT);
  ok("pg guest grant", (gr.status === 201 || gr.status === 200) && !!camel(gr.json, "id"), gr.status + " " + gr.text.slice(0, 120));
  const mtgRow = await pgOwned(`SELECT "Id","Title","Generation" FROM "Meetings" WHERE "Id" = $1`, [mid]);
  ok("pg durable meeting row (not memory fallback)", mtgRow.rows.length === 1 && mtgRow.rows[0].Title === run + " m1", JSON.stringify(mtgRow.rows).slice(0, 160));
  await req("POST", "/api/meetings/" + mid + "/messages", { content: "pg turn one" }, OT);

  // slow run + slow secretary, both provider-blocked
  const secNonce = "n-" + crypto.randomUUID();
  const runP = req("POST", "/api/meetings/" + mid + "/run", { prompt: "slow pg kill" }, OT, 60000);
  runP.catch(() => ({}));
  const secP = req("POST", "/api/meetings/" + mid + "/secretary", { input: "QA-SLEEP:15000 pg kill pending", clientNonce: secNonce }, OT, 60000);
  secP.catch(() => ({}));
  let runLive = false, secLive = false;
  for (let i = 0; i < 14; i++) {
    const s = await req("GET", "/api/meetings/" + mid + "/activity", undefined, OT);
    if (s.json && s.json.discussion && s.json.discussion.status === "running") runLive = true;
    if (s.json && (s.json.secretary || []).some((e) => e.clientNonce === secNonce && e.status === "inflight")) secLive = true;
    if (runLive && secLive) break;
    await sleep(700);
  }
  ok("pg run live while provider blocked", runLive, "run never running");
  ok("pg secretary live while provider blocked", secLive, "secretary never inflight");

  // KILL with provider calls blocked (no await)
  await killProc(api);
  console.log("killed mid-flight, restarting same DB");
  api = startApi();
  ok("pg api reboots on same DB", await waitApi(), "no 200 after restart");

  // sessions are memory-only: old tokens must die; accounts are durable: relogin works
  const deadOld = await req("GET", "/api/meetings/" + mid + "/activity", undefined, OT);
  ok("pg pre-kill token dead after restart (sessions not durable)", deadOld.status === 401, deadOld.status + " " + deadOld.text.slice(0, 120));
  const liO = await req("POST", "/api/auth/login", { email: oMail, password: PW });
  ok("pg owner relogin (accounts durable)", liO.status === 200 && !!camel(liO.json, "token"), liO.status + " " + liO.text.slice(0, 160));
  OT = camel(liO.json, "token");
  const liG = await req("POST", "/api/auth/login", { email: gMail, password: PW });
  ok("pg guest relogin", liG.status === 200 && !!camel(liG.json, "token"), liG.status + " " + liG.text.slice(0, 160));
  GT = camel(liG.json, "token");

  // durable rows: secretary terminal-interrupted, run-outcome note persisted, meeting + lead messages persisted
  const secRows = await pgOwned(`SELECT "Status","Error","NoteId","Generation" FROM "SecretaryRequests" WHERE "MeetingId" = $1 AND "ClientNonce" = $2`, [mid, secNonce]);
  ok("pg secretary row survived with terminal interrupted", secRows.rows.length === 1 && secRows.rows[0].Status === "interrupted",
    JSON.stringify(secRows.rows).slice(0, 300));
  const outRows = await pgOwned(`SELECT "Kind","Title" FROM "Notes" WHERE "MeetingId" = $1 AND "Kind" = $2`, [mid, "run-outcome"]);
  ok("pg run-outcome note persisted across kill", outRows.rows.length >= 1, "rows=" + outRows.rows.length);
  const meetRows = await pgOwned(`SELECT "Title","Generation" FROM "Meetings" WHERE "Id" = $1`, [mid]);
  ok("pg meeting row persisted", meetRows.rows.length === 1 && meetRows.rows[0].Title === run + " m1", JSON.stringify(meetRows.rows).slice(0, 160));
  const msgRows = await pgOwned(`SELECT count(*)::int AS n FROM "Messages" WHERE "MeetingId" = $1 AND "Sender" = $2`, [mid, "lead"]);
  ok("pg lead messages persisted", msgRows.rows[0].n >= 2, "n=" + msgRows.rows[0].n);

  // activity mirror: fresh process, no orphans; durable row still readable as interrupted
  const post = await req("GET", "/api/meetings/" + mid + "/activity", undefined, OT);
  ok("pg no live discussion orphan after restart", post.json && (post.json.discussion === null || post.json.discussion.status !== "running"), JSON.stringify(post.json && post.json.discussion).slice(0, 200));
  ok("pg no private secretary orphan after restart", !(post.json.secretary || []).some((e) => ["pending", "inflight", "answering"].includes(e.status)), JSON.stringify(post.json.secretary).slice(0, 300));
  const rowGet = await req("GET", "/api/meetings/" + mid + "/secretary/requests", undefined, OT);
  ok("pg durable request readable as interrupted", rowGet.status === 200 && (rowGet.json || []).some((r) => camel(r, "clientNonce") === secNonce && camel(r, "status") === "interrupted"),
    (rowGet.text || "").slice(0, 300));
  const gPost = await req("GET", "/api/meetings/" + mid + "/activity", undefined, GT);
  ok("pg guest sees no owner secretary entries", gPost.status === 200 && Array.isArray(gPost.json.secretary) && gPost.json.secretary.length === 0, gPost.text.slice(0, 200));

  // post-restart new work on the same DB
  await req("POST", "/api/meetings/" + mid + "/messages", { content: "pg turn two" }, OT);
  const rNew = await req("POST", "/api/meetings/" + mid + "/run", { prompt: "pg after restart" }, OT, 60000);
  ok("pg new run completes after restart", rNew.status === 200, rNew.status + " " + (rNew.text || "").slice(0, 200));
  const sNew = await req("GET", "/api/meetings/" + mid + "/activity", undefined, OT);
  ok("pg new run terminal completed, advisors complete", sNew.json && sNew.json.discussion && sNew.json.discussion.status === "completed"
    && (sNew.json.discussion.advisors || []).every((a) => a.state === "complete"), JSON.stringify(sNew.json.discussion).slice(0, 400));
  const secNew = await req("POST", "/api/meetings/" + mid + "/secretary", { input: "pg after restart", clientNonce: "n-" + crypto.randomUUID() }, OT, 45000);
  ok("pg new secretary completes after restart", secNew.status === 200 && camel(secNew.json, "status") === "completed", secNew.status + " " + (secNew.text || "").slice(0, 200));

  // revoke boundary on durable grants
  const grants = await pgOwned(`SELECT "Id" FROM "Grants" WHERE "BoardId" = $1 AND "UserKey" = $2`, [bid, gMail]);
  ok("pg durable grant row", grants.rows.length >= 1, "grants=" + grants.rows.length);
  const del = await req("DELETE", "/api/grants/" + grants.rows[0].Id, undefined, OT);
  ok("pg grant revoked", del.status === 200 || del.status === 204, del.status + " " + del.text.slice(0, 120));
  const gRev = await req("GET", "/api/meetings/" + mid + "/activity", undefined, GT);
  ok("pg revoked guest denied", gRev.status === 403, gRev.status + " " + gRev.text.slice(0, 120));

  console.log(`\nmeeting-activity PG QA: ${pass} passed, ${fail} failed`);
  if (failures.length) { console.log("failures:"); for (const m of failures) console.log(" - " + m); }
  console.log("LIMITS: no Docker healing (container untouched); PG 15441 QA credential only; owned DB dropped after run; uncertain-503 path still defensive-only (no storage-fault injection).");
}

try {
  await main();
} finally {
  try { if (api) await killProc(api); } catch { }
  try { if (fake) await new Promise((r) => fake.close(r)); } catch { }
  try { await pgAdmin(`DROP DATABASE "${OWN_DB}" WITH (FORCE)`); console.log("owned db dropped"); }
  catch (e) { console.log("DROP DB NOTE: " + String((e && e.message) || e).slice(0, 200)); }
}
process.exit(fail ? 1 : 0);
