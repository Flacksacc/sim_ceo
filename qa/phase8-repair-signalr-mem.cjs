const { HubConnectionBuilder } = require("../web/node_modules/@microsoft/signalr/dist/cjs/index.js");
const API = process.env.QA_API || "http://127.0.0.1:5197";
let pass = 0, fail = 0; const bad = [];
function ok(n, c, e) { if (c) pass++; else { fail++; bad.push(n + (e ? " :: " + e : "")); console.log("  FAIL " + n + (e ? " :: " + e : "")); } }
async function req(method, path, body, headers) {
  const r = await fetch(API + path, { method, headers: { "content-type": "application/json", ...(headers || {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {} return { status: r.status, json: j, text: t };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  console.log("repair-signalr-mem run api=" + API);
  const B = (t) => ({ Authorization: "Bearer " + t });
  const conn = (tok, extra) => new HubConnectionBuilder().withUrl(API + "/hubs/board", { accessTokenFactory: tok ? () => tok : undefined }).withAutomaticReconnect().build();
  const b = await req("POST", "/api/boards", { name: "demo-b" });
  const bid = b.json && (b.json.id || b.json.Id); ok("mem-demo-board", !!bid, b.status + " " + b.text.slice(0, 120));
  const m = await req("POST", "/api/boards/" + bid + "/meetings", { title: "demo-m", brief: "b" });
  const mid = m.json && (m.json.id || m.json.Id); ok("mem-demo-meeting", !!mid, m.status + " " + m.text.slice(0, 120));
  const anon = conn(null);
  let anonClosed = false; const anonMsgs = [];
  anon.onclose(() => { anonClosed = true; });
  anon.on("message", (x) => anonMsgs.push(x));
  let anonJoined = false;
  try { await anon.start(); await anon.invoke("JoinMeeting", mid); anonJoined = true; } catch (e) { ok("mem-anon-join", false, String(e).split("\\n")[0]); }
  ok("mem-anon-join", anonJoined, "demo join failed");
  await req("POST", "/api/meetings/" + mid + "/messages", { content: "demo ping", boardId: bid, meetingId: mid }, { "X-User": "owner" });
  await sleep(2000);
  const preCount = anonMsgs.length;
  ok("mem-anon-delivery", preCount >= 1, "got " + preCount);
  const r = await req("POST", "/api/auth/register", { email: "first@example.com", password: "TestPassword123!" });
  ok("mem-first-reg", r.status === 201 && r.json && r.json.token, r.status + " " + r.text.slice(0, 160));
  await sleep(2500);
  const adminT = r.json.token;
  await req("POST", "/api/meetings/" + mid + "/messages", { content: "post-secure ping", boardId: bid, meetingId: mid }, B(adminT)).catch(() => ({}));
  await sleep(2000);
  ok("mem-anon-aborted", anonClosed, "anonymous connection survived first registration (closed=" + anonClosed + ")");
  ok("mem-anon-no-delivery", anonMsgs.length === preCount, "pre=" + preCount + " post=" + anonMsgs.length);
  try { await anon.stop(); } catch {}
  const st = await req("GET", "/api/auth/status");
  ok("mem-secure", st.json && st.json.authRequired === true, st.text.slice(0, 160));
  const g2 = conn("00".repeat(32));
  let anonRejoinDenied = false;
  try { await g2.start(); await g2.invoke("JoinMeeting", mid); } catch { anonRejoinDenied = true; } finally { try { await g2.stop(); } catch {} }
  ok("mem-anon-rejoin-denied", anonRejoinDenied, "anonymous rejoin succeeded after secure transition");
  console.log("FINAL pass=" + pass + " fail=" + fail);
  if (bad.length) { console.log("FAILURES:"); for (const x of bad) console.log(" - " + x); }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log("HARNESS-ERROR " + (e && e.stack || e)); process.exit(2); });
