// qa/meeting-activity-qa.mjs - MeetingActivity independent-review QA (Muse-authored).
// Own children only: API 127.0.0.1:5271, inline fake model 127.0.0.1:5272, short-lived
// SignalR capture children (qa/sigsub.mjs). Refuses 5080/5173/9333/5199. No Docker,
// no env changes, no shared processes. Kills only own children (finally).
// Covers: asymmetric held individual outcomes, per-task waiting states, op-guard
// stability, pause/end/removal/new-lead invalidation DURING calls, all terminal
// failures (provider/malformed/clarify/answer/discard/409s), in-reservation identity
// vs X-User spoof + logout, backup/restore epoch + missing-request removal,
// kill-WHILE-pending + reboot, real authorized SignalR + private continuation order.
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import crypto from "node:crypto";

let QA_API_CFG = {};
try { QA_API_CFG = JSON.parse(fs.readFileSync("qa/.qarun.json", "utf8")); } catch { QA_API_CFG = {}; }
const API = process.env.QA_API || QA_API_CFG.api || "http://127.0.0.1:5271";
const FAKE_PORT = Number(process.env.QA_FAKE_PORT || QA_API_CFG.fakePort || "5272");
const ALT_DLL = process.env.QA_ALT_DLL || QA_API_CFG.altDll || "";

for (const bad of [":5080", ":5173", ":9333", ":5199", ":5198", ":5100", ":5099"]) {
  if (API.includes(bad)) { console.error("REFUSE port"); process.exit(2); }
}

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
async function req(method, path, body, token, timeoutMs = 30000, extraHeaders = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const headers = { "content-type": "application/json", ...extraHeaders };
    if (token) headers.authorization = "Bearer " + token;
    else if (!headers["x-user"]) headers["x-user"] = "owner";
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
        if (/QA-BIDERR/.test(prompt)) { send(500, { error: "qa bid failure" }); return; }
        if (/QAFAILFAST/.test(prompt)) { send(500, { error: "qa fast bid failure" }); return; }
        if (/QAFast/.test(prompt)) { chat("NO - not relevant to this prompt."); return; }
        if (/QASlow/.test(prompt)) { await sleep(8000); chat("YES - directly relevant."); return; }
        if (/QA-NO/.test(prompt)) { chat("NO - not relevant to this prompt."); return; }
        chat("YES - directly relevant.");
        return;
      }
      if (/YOUR TURN/.test(prompt)) {
        if (/QA-REPLYERR/.test(prompt)) { send(500, { error: "qa reply failure" }); return; }
        if (/QASlow/.test(prompt)) await sleep(8000);
        if (/QA-ABSTAIN/.test(prompt)) { chat("ABSTAIN"); return; }
        chat("QA advisor reply with a clear position. [stance: Agrees]");
        return;
      }
      if (/board secretary/i.test(prompt)) {
        if (/OWNER ANSWER/.test(prompt)) { chat(JSON.stringify({ kind: "note", title: "QA note", body: "QA secretary body" })); return; }
        if (/QA-SECREPFAIL/.test(prompt)) { send(500, { error: "qa secretary failure" }); return; }
        if (/QA-SECBAD/.test(prompt)) { chat("this is not json at all {{{"); return; }
        if (/QA-CLARIFY/.test(prompt)) { chat(JSON.stringify({ kind: "question", question: "QA clarification?" })); return; }
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

function startApi() {
  const altArgs = ALT_DLL ? [ALT_DLL] : ["run", "--project", "server/SimCEO.Api", "--no-build"];
  const child = spawn("dotnet", altArgs, {
    cwd: process.cwd(),
    windowsHide: true,
    env: {
      ...process.env,
      ASPNETCORE_URLS: API,
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
  for (let i = 0; i < 60; i++) {
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
function startSub(token, meetingsCsv, outfile, durationMs) {
  const child = spawn("node", ["qa/sigsub.mjs", API, token, meetingsCsv, outfile, String(durationMs)], {
    cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  return child;
}
function loadEvents(path) {
  try {
    const t = fs.readFileSync(path, "utf8");
    return t.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch { return []; }
}
const evFrames = (events, meetingId, method) => events.filter((e) => e.method === method && e.payload && e.payload.meetingId === meetingId);
const evAdvisors = (frame) => frame.payload.advisors || [];
const evState = (frame, roleSub) => {
  const a = evAdvisors(frame).find((x) => (x.boardRole || "").includes(roleSub));
  return a ? a.state : null;
};
const run = "qa-act2-" + Date.now().toString(36);
const ACCT = crypto.randomUUID();
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

async function uploadPortrait(rosterId, token) {
  const form = new FormData();
  form.append("file", new Blob([PNG], { type: "image/png" }), "qa.png");
  const headers = token ? { authorization: "Bearer " + token } : { "x-user": "owner" };
  const r = await fetch(API + "/api/roster/" + rosterId + "/image/upload", { method: "POST", headers, body: form });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: r.status, json, text };
}
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
async function makeMeeting(boardId, title, brief, token) {
  const m = await req("POST", "/api/boards/" + boardId + "/meetings", { title, brief }, token);
  if (m.status !== 201) return { error: "meeting:" + m.status + " " + m.text.slice(0, 200) };
  return { id: camel(m.json, "id") };
}
const actOf = (s) => s.json && s.json.discussion;
const advBy = (d, sub) => (d && d.advisors ? d.advisors.find((a) => (a.boardRole || "").includes(sub)) : null);

let api = null;
let fake = null;
const children = [];
function track(c) { children.push(c); return c; }

async function main() {
  fake = await startFake();
  console.log("fake on 5272");
  api = track(startApi());
  ok("api boots", await waitApi(), "no 200 on /api/presets within 60s");

  const oMail = "owner-" + run + "@example.com";
  const gMail = "guest-" + run + "@example.com";
  const ro = await req("POST", "/api/auth/register", { email: oMail, password: "password12345678" });
  ok("register owner", ro.status === 201 && camel(ro.json, "token"), ro.status + " " + ro.text.slice(0, 160));
  const rg = await req("POST", "/api/auth/register", { email: gMail, password: "password12345678" });
  ok("register guest", rg.status === 201 && camel(rg.json, "token"), rg.status + " " + rg.text.slice(0, 160));
  let OT = camel(ro.json, "token");
  const GT = camel(rg.json, "token");

  const b = await req("POST", "/api/boards", { name: run + " board", mission: run + " mission", stage: "qa" }, OT);
  ok("create board", b.status === 201 && camel(b.json, "id"), b.status + " " + b.text.slice(0, 160));
  const bid = camel(b.json, "id");
  const ld = await req("POST", "/api/boards/" + bid + "/lead", { name: "QA Lead", roleLabel: "Lead" }, OT);
  ok("save lead", ld.status === 200 || ld.status === 201, ld.status + " " + ld.text.slice(0, 160));
  const aFast = await makeAdvisor(bid, "QAFAILFAST", OT);
  ok("advisor QAFAILFAST ready", !aFast.error, aFast.error || "");
  const aSlow = await makeAdvisor(bid, "QASlow", OT);
  ok("advisor QASlow ready", !aSlow.error, aSlow.error || "");
  const m1 = await makeMeeting(bid, run + " m1", "brief one", OT);
  ok("create m1", !m1.error, m1.error || "");
  const mid1 = m1.id;
  const m2 = await makeMeeting(bid, run + " m2", "brief two", OT);
  ok("create m2", !m2.error, m2.error || "");
  const mid2 = m2.id;

  const pre = await req("GET", "/api/meetings/" + mid1 + "/activity", undefined, OT);
  ok("snapshot pre-run 200 + empty", pre.status === 200 && pre.json && pre.json.discussion === null, pre.status + " " + pre.text.slice(0, 200));

  const gr = await req("POST", "/api/boards/" + bid + "/grants", { userKey: gMail, meetingId: mid1, access: "read" }, OT);
  ok("guest grant m1", (gr.status === 201 || gr.status === 200) && camel(gr.json, "id"), gr.status + " " + gr.text.slice(0, 200));
  const gid = camel(gr.json, "id");
  const gOther = await req("GET", "/api/meetings/" + mid2 + "/activity", undefined, GT);
  ok("guest denied on m2 (meeting switch isolation)", gOther.status === 403, gOther.status + " " + gOther.text.slice(0, 160));

  // ---- T2 asymmetric held outcomes + per-task waiting states (real events) ----
  track(startSub(OT, mid1, "qa/sig-o-a1.log", 95000));
  track(startSub(GT, mid1, "qa/sig-g-a1.log", 95000));
  track(startSub(GT, mid2, "qa/sig-g-deny.log", 25000));
  await sleep(2500);
  const runP = req("POST", "/api/meetings/" + mid1 + "/run", { prompt: "asymmetric" }, OT, 60000);
  await sleep(1500);
  const conc = await req("POST", "/api/meetings/" + mid1 + "/run", { prompt: "concurrent" }, OT);
  ok("concurrent run rejected 409", conc.status === 409, conc.status + " " + conc.text.slice(0, 160));
  let sawAsym = false, sawWait = false;
  for (let i = 0; i < 10; i++) {
    const s = await req("GET", "/api/meetings/" + mid1 + "/activity", undefined, OT);
    const d = actOf(s);
    if (d && d.status === "running") {
      const f = advBy(d, "QAFAILFAST"), sl = advBy(d, "QASlow");
      if (f && sl && f.state === "failed" && ["considering", "responding", "awaiting-selection"].includes(sl.state)) sawAsym = true;
      if (sl && ["awaiting-selection", "awaiting-publication"].includes(sl.state)) sawWait = true;
    }
    await sleep(600);
  }
  const r1 = await runP;
  ok("T2 run completes 200", r1.status === 200, r1.status + " " + r1.text.slice(0, 300));
  const post1 = await req("GET", "/api/meetings/" + mid1 + "/activity", undefined, OT);
  const d1 = actOf(post1);
  ok("T2 held asymmetry (failed vs live bid)", sawAsym, "never saw QAFAILFAST=failed while QASlow live");
  ok("T2 final: QAFAILFAST failed, QASlow complete", d1 && d1.status === "completed"
    && advBy(d1, "QAFAILFAST")?.state === "failed" && advBy(d1, "QASlow")?.state === "complete",
    JSON.stringify(d1 && d1.advisors));
  const op1 = d1 && d1.operationId;
  await sleep(85000);
  const evO1 = loadEvents("qa/sig-o-a1.log");
  const evG1 = loadEvents("qa/sig-g-a1.log");
  const frames1 = evFrames(evO1, mid1, "meeting-activity");
  ok("T2 owner receives real meeting-activity events", frames1.length >= 3, "frames=" + frames1.length);
  ok("T2 event shows asymmetric held states", frames1.some((f) => evState(f, "QAFAILFAST") === "failed"
    && ["considering", "responding", "awaiting-selection"].includes(evState(f, "QASlow"))),
    "no frame with failed-vs-live combo");
  ok("T2 event shows truthful waiting states", frames1.some((f) => ["awaiting-selection", "awaiting-publication"].includes(evState(f, "QASlow"))),
    "states seen: " + JSON.stringify([...new Set(frames1.flatMap((f) => evAdvisors(f).map((a) => a.boardRole + "=" + a.state)))]).slice(0, 400));
  ok("T2 guest receives board-visible events", evFrames(evG1, mid1, "meeting-activity").length >= 1, "guest frames missing");
  const evGDeny = loadEvents("qa/sig-g-deny.log");
  ok("T2 guest join of ungranted m2 refused", evGDeny.some((e) => e.method === "__join-failed"), "no join-failed recorded");
  ok("T2 subscriber logs prove live connections", evO1.some((e) => e.method === "__connected") && evO1.some((e) => e.method === "__joined")
    && evG1.some((e) => e.method === "__connected") && evG1.some((e) => e.method === "__joined") && evGDeny.length > 0, "missing connect/join proof");
  const gSecEv1 = evFrames(evG1, mid1, "secretary-activity");
  ok("T2 no private secretary events leak yet", gSecEv1.length === 0, "leaked=" + gSecEv1.length);

  // ---- T2b immediate NO is terminal before batch end (not awaiting-selection) ----
  const mnb = await makeMeeting(bid, run + " mnb", "brief nobid", OT);
  ok("T2b create mnb", !mnb.error, mnb.error || "");
  const midnb = mnb.id;
  const qfN = await makeAdvisor(bid, "QAFastN", OT);
  ok("T2b advisor QAFastN ready", !qfN.error, qfN.error || "");
  const qsN = await makeAdvisor(bid, "QASlowN", OT);
  ok("T2b advisor QASlowN ready", !qsN.error, qsN.error || "");
  await req("POST", "/api/meetings/" + midnb + "/messages", { content: "no-bid turn" }, OT);
  const runNbP = req("POST", "/api/meetings/" + midnb + "/run", { prompt: "nobid asymmetric" }, OT, 60000);
  let sawNoHold = false;
  for (let i = 0; i < 16; i++) {
    const s = await req("GET", "/api/meetings/" + midnb + "/activity", undefined, OT);
    const d = actOf(s);
    if (d && d.status === "running") {
      const f = advBy(d, "QAFastN"), sl = advBy(d, "QASlowN");
      if (f && f.state === "abstained" && f.reason === "bid-declined" && sl && ["considering", "responding", "awaiting-selection"].includes(sl.state)) { sawNoHold = true; break; }
    }
    await sleep(400);
  }
  ok("T2b NO-bid terminal immediately while other bid pends", sawNoHold, "decliner stuck waiting");
  const rNb = await runNbP;
  const sNb = await req("GET", "/api/meetings/" + midnb + "/activity", undefined, OT);
  ok("T2b final: decliner abstained, slow advisor complete", rNb.status === 200 && advBy(actOf(sNb), "QAFastN")?.state === "abstained"
    && advBy(actOf(sNb), "QASlowN")?.state === "complete", (rNb.text || "").slice(0, 200));

  // ---- T3 pause DURING slow call invalidates promptly ----
  const lm3 = await req("POST", "/api/meetings/" + mid1 + "/messages", { content: "turn two" }, OT);
  ok("T3 lead message posted", lm3.status === 201, lm3.status + " " + lm3.text.slice(0, 120));
  const run3P = req("POST", "/api/meetings/" + mid1 + "/run", { prompt: "slow for pause" }, OT, 60000);
  await sleep(3000);
  const pz = await req("POST", "/api/meetings/" + mid1 + "/pause", undefined, OT);
  ok("T3 pause accepted", pz.status === 200, pz.status + " " + pz.text.slice(0, 160));
  let sawPaused = false;
  for (let i = 0; i < 8; i++) {
    const s = await req("GET", "/api/meetings/" + mid1 + "/activity", undefined, OT);
    const d = actOf(s);
    if (d && d.status === "interrupted") {
      sawPaused = true;
      const live = (d.advisors || []).filter((a) => ["considering", "responding", "awaiting-selection", "awaiting-publication"].includes(a.state));
      ok("T3 no advisor stuck live after pause", live.length === 0, JSON.stringify(live));
      break;
    }
    await sleep(500);
  }
  ok("T3 snapshot interrupted promptly (not after 120s batch)", sawPaused, "still running past pause");
  const r3 = await run3P;
  ok("T3 run itself refused as interrupted", r3.status === 409, r3.status + " " + r3.text.slice(0, 160));
  const rs = await req("POST", "/api/meetings/" + mid1 + "/resume", undefined, OT);
  ok("T3 resume accepted", rs.status === 200, rs.status + " " + rs.text.slice(0, 120));
  const postPause = await req("GET", "/api/meetings/" + mid1 + "/activity", undefined, OT);
  ok("T3 terminal stays interrupted after resume", postPause.json && postPause.json.discussion && postPause.json.discussion.status === "interrupted", postPause.text.slice(0, 200));

  // ---- T4 advisor removal DURING slow draft ----
  const lm4 = await req("POST", "/api/meetings/" + mid1 + "/messages", { content: "turn three" }, OT);
  ok("T4 lead message posted", lm4.status === 201, lm4.status + " " + lm4.text.slice(0, 120));
  const run4P = req("POST", "/api/meetings/" + mid1 + "/run", { prompt: "slow for removal" }, OT, 60000);
  let sawResponding = false;
  for (let i = 0; i < 22; i++) {
    const s = await req("GET", "/api/meetings/" + mid1 + "/activity", undefined, OT);
    const d = actOf(s);
    if (d && advBy(d, "QASlow") && advBy(d, "QASlow").state === "responding") { sawResponding = true; break; }
    await sleep(700);
  }
  ok("T4 QASlow reaches responding", sawResponding, "never observed");
  const del = await req("DELETE", "/api/boards/" + bid + "/advisors/" + aSlow.aid, undefined, OT);
  ok("T4 advisor removed", del.status === 200 || del.status === 204, del.status + " " + del.text.slice(0, 120));
  let sawRemoved = false, removedReason = "";
  for (let i = 0; i < 8; i++) {
    const s = await req("GET", "/api/meetings/" + mid1 + "/activity", undefined, OT);
    const d = actOf(s);
    const a = d && advBy(d, "QASlow");
    if (a && a.state === "abstained" && ["not-eligible", "stale-profile"].includes(a.reason)) { sawRemoved = true; removedReason = a.reason; break; }
    await sleep(500);
  }
  ok("T4 removed advisor reconciled promptly (" + removedReason + ")", sawRemoved, "still live after removal");
  const r4 = await run4P;
  ok("T4 run finishes with yields", r4.status === 200, r4.status + " " + r4.text.slice(0, 300));
  const post4 = await req("GET", "/api/meetings/" + mid1 + "/activity", undefined, OT);
  const d4 = actOf(post4);
  ok("T4 final: removed advisor abstained/not-eligible", d4 && advBy(d4, "QASlow")?.state === "abstained"
    && ["not-eligible", "stale-profile"].includes(advBy(d4, "QASlow")?.reason), JSON.stringify(d4 && d4.advisors));
  // ---- T5 new owner turn DURING slow call ----
  const bSlow = await makeAdvisor(bid, "QASlowB", OT);
  ok("T5 advisor QASlowB ready", !bSlow.error, bSlow.error || "");
  const cSlow = await makeAdvisor(bid, "QASlowC", OT);
  ok("T5 advisor QASlowC ready", !cSlow.error, cSlow.error || "");
  const m5 = await makeMeeting(bid, run + " m5", "brief five", OT);
  ok("T5 create m5", !m5.error, m5.error || "");
  const mid5 = m5.id;

  const run5P = req("POST", "/api/meetings/" + mid5 + "/run", { prompt: "slow for newlead" }, OT, 60000);
  await sleep(3000);
  const lm5 = await req("POST", "/api/meetings/" + mid5 + "/messages", { content: "interrupting question" }, OT);
  ok("T5 interrupting lead posted", lm5.status === 201, lm5.status + " " + lm5.text.slice(0, 120));
  let sawNewLead = false;
  for (let i = 0; i < 8; i++) {
    const s = await req("GET", "/api/meetings/" + mid5 + "/activity", undefined, OT);
    const d = actOf(s);
    if (d && d.status === "interrupted") { sawNewLead = true; break; }
    await sleep(500);
  }
  ok("T5 snapshot interrupted by new lead promptly", sawNewLead, "still running");
  const r5 = await run5P;
  ok("T5 run refused as interrupted", r5.status === 409, r5.status + " " + r5.text.slice(0, 160));

  // ---- T6 terminal failures ----
  const m6 = await makeMeeting(bid, run + " m6", "brief six", OT);
  ok("T6 create m6", !m6.error, m6.error || "");
  const mid6 = m6.id;
  const nA = await makeAdvisor(bid, "Alpha", OT);
  ok("T6 advisor Alpha ready", !nA.error, nA.error || "");
  const nB = await makeAdvisor(bid, "Beta", OT);
  ok("T6 advisor Beta ready", !nB.error, nB.error || "");
  const gr6 = await req("POST", "/api/boards/" + bid + "/grants", { userKey: gMail, meetingId: mid6, access: "read" }, OT);
  ok("T6 guest granted m6", (gr6.status === 201 || gr6.status === 200) && !!camel(gr6.json, "id"), gr6.status + " " + gr6.text.slice(0, 120));
  track(startSub(OT, mid6 + "," + mid1, "qa/sig-o-a2.log", 180000));
  track(startSub(GT, mid1 + "," + mid6, "qa/sig-g-a2.log", 180000));
  let oJoined6 = false, gJoined6 = false;
  for (let w = 0; w < 20; w++) {
    const oTmp = loadEvents("qa/sig-o-a2.log");
    const gTmp = loadEvents("qa/sig-g-a2.log");
    if (!oJoined6) oJoined6 = oTmp.some((e) => e.method === "__joined" && e.payload && e.payload.meeting === mid6);
    if (!gJoined6) gJoined6 = gTmp.some((e) => e.method === "__joined" && e.payload && e.payload.meeting === mid6);
    if (oJoined6 && gJoined6) break;
    await sleep(1000);
  }
  ok("T6 subs joined mid6 before secretary traffic (capture spans lifecycle)", oJoined6 && gJoined6, "owner=" + oJoined6 + " guest=" + gJoined6);
  const lm6 = await req("POST", "/api/meetings/" + mid6 + "/messages", { content: "failures turn" }, OT);
  ok("T6 lead posted", lm6.status === 201, lm6.status + " " + lm6.text.slice(0, 120));
  const r6a = await req("POST", "/api/meetings/" + mid6 + "/run", { prompt: "QA-BIDERR boom" }, OT, 60000);
  ok("T6a bid-error run completes 200", r6a.status === 200, r6a.status + " " + r6a.text.slice(0, 300));
  const s6a = await req("GET", "/api/meetings/" + mid6 + "/activity", undefined, OT);
  const d6a = actOf(s6a);
  ok("T6a all advisors failed/provider-error", d6a && (d6a.advisors || []).length >= 2
    && (d6a.advisors || []).every((a) => a.state === "failed" && a.reason === "provider-error")
    && ["Alpha", "Beta"].every((r) => advBy(d6a, r)?.state === "failed"), JSON.stringify(d6a && d6a.advisors));
  const lm6b = await req("POST", "/api/meetings/" + mid6 + "/messages", { content: "reply failures turn" }, OT);
  ok("T6 lead2 posted", lm6b.status === 201, lm6b.status + " " + lm6b.text.slice(0, 120));
  const r6b = await req("POST", "/api/meetings/" + mid6 + "/run", { prompt: "QA-REPLYERR boom" }, OT, 60000);
  ok("T6b reply-error run completes 200", r6b.status === 200, r6b.status + " " + r6b.text.slice(0, 300));
  const s6b = await req("GET", "/api/meetings/" + mid6 + "/activity", undefined, OT);
  const d6b = actOf(s6b);
  ok("T6b reply errors fail YES-bidders, NO-bidder abstains, none published", d6b
    && advBy(d6b, "Alpha")?.state === "failed" && advBy(d6b, "Beta")?.state === "failed"
    && advBy(d6b, "QAFastN")?.state === "abstained" && advBy(d6b, "QAFastN")?.reason === "bid-declined"
    && Array.isArray(r6b.json && r6b.json.published) && r6b.json.published.length === 0, JSON.stringify(d6b && d6b.advisors));
  const failNonce = "n-" + crypto.randomUUID();
  const secFail = await req("POST", "/api/meetings/" + mid6 + "/secretary", { input: "QA-SECREPFAIL do it", clientNonce: failNonce }, OT, 45000);
  ok("T6c secretary provider failure 502", secFail.status === 502, secFail.status + " " + secFail.text.slice(0, 200));
  const sFail = await req("GET", "/api/meetings/" + mid6 + "/activity", undefined, OT);
  ok("T6c failed secretary mirrored failed for that request", (sFail.json.secretary || []).some((e) => e.clientNonce === failNonce && e.status === "failed"), JSON.stringify(sFail.json.secretary).slice(0, 300));
  const badNonce = "n-" + crypto.randomUUID();
  const secBad = await req("POST", "/api/meetings/" + mid6 + "/secretary", { input: "QA-SECBAD do it", clientNonce: badNonce }, OT, 45000);
  ok("T6d secretary malformed 502", secBad.status === 502, secBad.status + " " + secBad.text.slice(0, 200));
  const sBad = await req("GET", "/api/meetings/" + mid6 + "/activity", undefined, OT);
  ok("T6d malformed secretary mirrored failed for that request", (sBad.json.secretary || []).some((e) => e.clientNonce === badNonce && e.status === "failed"), JSON.stringify(sBad.json.secretary).slice(0, 300));
  const clNonce = "n-" + crypto.randomUUID();
  const tClarifyFired = Date.now();
  const secCl = await req("POST", "/api/meetings/" + mid6 + "/secretary", { input: "QA-CLARIFY explain", clientNonce: clNonce }, OT, 45000);
  ok("T6e clarification asked", secCl.status === 200 && camel(secCl.json, "status") === "needs-clarification", secCl.status + " " + secCl.text.slice(0, 300));
  const sCl = await req("GET", "/api/meetings/" + mid6 + "/activity", undefined, OT);
  ok("T6e clarification mirrored", (sCl.json.secretary || []).some((e) => e.clientNonce === clNonce && e.status === "needs-clarification"), JSON.stringify(sCl.json.secretary).slice(0, 300));
  const ansReq = camel(secCl.json, "requestId");
  const secAns = await req("POST", "/api/meetings/" + mid6 + "/secretary/answer", { requestId: ansReq, answer: "because reasons" }, OT, 45000);
  ok("T6e continuation completes", secAns.status === 200 && camel(secAns.json, "status") === "completed", secAns.status + " " + secAns.text.slice(0, 300));
  const sAns = await req("GET", "/api/meetings/" + mid6 + "/activity", undefined, OT);
  ok("T6e answer mirrored completed", (sAns.json.secretary || []).some((e) => e.clientNonce === clNonce && e.status === "completed"), JSON.stringify(sAns.json.secretary).slice(0, 300));
  const slowNonce = "n-" + crypto.randomUUID();
  const slowSecP = req("POST", "/api/meetings/" + mid6 + "/secretary", { input: "QA-SLEEP:10000 slow work", clientNonce: slowNonce }, OT, 45000);
  await sleep(2500);
  const pz6 = await req("POST", "/api/meetings/" + mid6 + "/pause", undefined, OT);
  ok("T6f pause accepted", pz6.status === 200, pz6.status + " " + pz6.text.slice(0, 120));
  const slowSec = await slowSecP;
  ok("T6f paused secretary discarded 409", slowSec.status === 409, slowSec.status + " " + slowSec.text.slice(0, 200));
  const sDisc = await req("GET", "/api/meetings/" + mid6 + "/activity", undefined, OT);
  ok("T6f discard mirrored", (sDisc.json.secretary || []).some((e) => e.clientNonce === slowNonce && e.status === "discarded"), JSON.stringify(sDisc.json.secretary).slice(0, 300));
  await req("POST", "/api/meetings/" + mid6 + "/resume", undefined, OT);
  // ---- T7 in-reservation identity vs spoof + logout ----
  const spNonce = "n-" + crypto.randomUUID();
  const sp = await req("POST", "/api/meetings/" + mid1 + "/secretary", { input: "spoof check", clientNonce: spNonce }, OT, 45000, { "x-user": gMail });
  ok("T7 spoofed-header request completes", sp.status === 200, sp.status + " " + sp.text.slice(0, 200));
  const oSp = await req("GET", "/api/meetings/" + mid1 + "/activity", undefined, OT);
  const gSp = await req("GET", "/api/meetings/" + mid1 + "/activity", undefined, GT);
  ok("T7 entry attributed to session owner, not X-User", (oSp.json.secretary || []).some((e) => e.clientNonce === spNonce)
    && !(gSp.json.secretary || []).some((e) => e.clientNonce === spNonce), "owner=" + JSON.stringify((oSp.json.secretary || []).map((e) => e.clientNonce)).slice(0, 200));
  const lo = await req("POST", "/api/auth/logout", undefined, OT);
  ok("T7 owner logout", lo.status === 200 || lo.status === 204, lo.status + " " + lo.text.slice(0, 120));
  const dead = await req("GET", "/api/meetings/" + mid1 + "/activity", undefined, OT);
  ok("T7 dead session denied", dead.status === 401, dead.status + " " + dead.text.slice(0, 120));
  const deadSpoof = await req("GET", "/api/meetings/" + mid1 + "/activity", undefined, OT, 30000, { "x-user": gMail });
  ok("T7 dead session + X-User still denied (no fallback leak)", deadSpoof.status === 401, deadSpoof.status + " " + deadSpoof.text.slice(0, 120));
  const li = await req("POST", "/api/auth/login", { email: oMail, password: "password12345678" });
  ok("T7 owner re-login", li.status === 200 && camel(li.json, "token"), li.status + " " + li.text.slice(0, 160));
  OT = camel(li.json, "token");

  // ---- T8 backup/restore: epoch + missing request ----
  const bk0 = await req("GET", "/api/backup", undefined, OT);
  ok("T8 export works", bk0.status === 200 && camel(bk0.json, "snapshot") && camel(bk0.json, "hash"), bk0.status + " " + bk0.text.slice(0, 120));
  const missNonce = "n-" + crypto.randomUUID();
  const missP = req("POST", "/api/meetings/" + mid6 + "/secretary", { input: "QA-SLEEP:12000 missing row", clientNonce: missNonce }, OT, 45000);
  missP.catch(() => ({}));
  await sleep(2500);
  const missLive = await req("GET", "/api/meetings/" + mid6 + "/activity", undefined, OT);
  ok("T8 request in flight before restore", (missLive.json.secretary || []).some((e) => e.clientNonce === missNonce && e.status === "inflight"), JSON.stringify(missLive.json.secretary).slice(0, 300));
  const rs0 = await req("POST", "/api/backup/restore", { snapshot: camel(bk0.json, "snapshot"), hash: camel(bk0.json, "hash") }, OT, 45000);
  ok("T8 restore pre-request backup", rs0.status === 200, rs0.status + " " + rs0.text.slice(0, 300));
  const sMiss = await req("GET", "/api/meetings/" + mid6 + "/activity", undefined, OT);
  ok("T8 restored-away request removed from snapshot (no orphan inflight)", !(sMiss.json.secretary || []).some((e) => e.clientNonce === missNonce), JSON.stringify(sMiss.json.secretary).slice(0, 300));
  const rowsMiss = await req("GET", "/api/meetings/" + mid6 + "/secretary/requests", undefined, OT);
  ok("T8 restored-away row gone", rowsMiss.status === 200 && !(rowsMiss.json || []).some((r) => camel(r, "clientNonce") === missNonce), (rowsMiss.text || "").slice(0, 300));
  const missDone = await missP;
  ok("T8 orphaned attempt ends 409, never publishes", missDone.status === 409, missDone.status + " " + (missDone.text || "").slice(0, 200));
  const sMiss2 = await req("GET", "/api/meetings/" + mid6 + "/activity", undefined, OT);
  ok("T8 mirror still clean after orphan exit", !(sMiss2.json.secretary || []).some((e) => e.clientNonce === missNonce), JSON.stringify(sMiss2.json.secretary).slice(0, 200));

  // epoch bump with identical rows: stale op invalidated, newer run owns entry
  const m7 = await makeMeeting(bid, run + " m7", "brief seven", OT);
  ok("T8 create m7", !m7.error, m7.error || "");
  const mid7 = m7.id;
  const dSlow = await makeAdvisor(bid, "QASlowD", OT);
  ok("T8 advisor QASlowD ready", !dSlow.error, dSlow.error || "");
  await req("POST", "/api/meetings/" + mid7 + "/messages", { content: "epoch turn" }, OT);
  const bk1 = await req("GET", "/api/backup", undefined, OT);
  ok("T8 export b1", bk1.status === 200 && camel(bk1.json, "snapshot"), bk1.status + " " + bk1.text.slice(0, 120));
  const run7P = req("POST", "/api/meetings/" + mid7 + "/run", { prompt: "slow epoch" }, OT, 60000);
  run7P.catch(() => ({}));
  await sleep(2500);
  const s7run = await req("GET", "/api/meetings/" + mid7 + "/activity", undefined, OT);
  const op7 = s7run.json && s7run.json.discussion && s7run.json.discussion.operationId;
  ok("T8 op7 running", s7run.json && s7run.json.discussion && s7run.json.discussion.status === "running" && !!op7, s7run.text.slice(0, 200));
  const rs1 = await req("POST", "/api/backup/restore", { snapshot: camel(bk1.json, "snapshot"), hash: camel(bk1.json, "hash") }, OT, 45000);
  ok("T8 restore same rows (epoch bump)", rs1.status === 200, rs1.status + " " + rs1.text.slice(0, 200));
  let sawEpoch = false;
  for (let i = 0; i < 8; i++) {
    const s = await req("GET", "/api/meetings/" + mid7 + "/activity", undefined, OT);
    if (s.json && s.json.discussion && s.json.discussion.status === "interrupted") { sawEpoch = true; break; }
    await sleep(500);
  }
  ok("T8 pre-restore op invalidated promptly", sawEpoch, "stale op still running");
  const r7 = await run7P;
  ok("T8 stale run refused, not published", r7.status === 409, r7.status + " " + (r7.text || "").slice(0, 200));
  await req("POST", "/api/meetings/" + mid7 + "/messages", { content: "after restore" }, OT);
  const r7b = await req("POST", "/api/meetings/" + mid7 + "/run", { prompt: "after restore" }, OT, 60000);
  const s7b = await req("GET", "/api/meetings/" + mid7 + "/activity", undefined, OT);
  ok("T8 newer run owns entry and completes", r7b.status === 200 && s7b.json && s7b.json.discussion
    && s7b.json.discussion.status === "completed" && s7b.json.discussion.operationId !== op7, (r7b.text || "").slice(0, 200));

  // ---- T12 revoke suppresses events on a LIVE established connection ----
  const m12 = await makeMeeting(bid, run + " m12", "brief twelve", OT);
  ok("T12 create m12", !m12.error, m12.error || "");
  const mid12 = m12.id;
  const pt12 = await req("PATCH", "/api/meetings/" + mid12, { participantIds: [nA.aid, nB.aid] }, OT);
  ok("T12 scoped to instant advisors", pt12.status === 200, pt12.status + " " + pt12.text.slice(0, 160));
  const gr12 = await req("POST", "/api/boards/" + bid + "/grants", { userKey: gMail, meetingId: mid12, access: "read" }, OT);
  ok("T12 guest granted m12", (gr12.status === 201 || gr12.status === 200) && !!camel(gr12.json, "id"), gr12.status + " " + gr12.text.slice(0, 120));
  const gid12 = camel(gr12.json, "id");
  track(startSub(OT, mid12, "qa/sig-o-t12.log", 60000));
  track(startSub(GT, mid12, "qa/sig-g-t12.log", 60000));
  await sleep(3000);
  const del12 = await req("DELETE", "/api/grants/" + gid12, undefined, OT);
  ok("T12 grant revoked mid-connection", del12.status === 200 || del12.status === 204, del12.status + " " + del12.text.slice(0, 120));
  await req("POST", "/api/meetings/" + mid12 + "/messages", { content: "post revoke turn" }, OT);
  const run12P = req("POST", "/api/meetings/" + mid12 + "/run", { prompt: "post revoke run" }, OT, 60000);
  run12P.catch(() => ({}));
  let sawLive12 = false;
  for (let i = 0; i < 10; i++) {
    const s = await req("GET", "/api/meetings/" + mid12 + "/activity", undefined, OT);
    if (s.json && s.json.discussion && s.json.discussion.status === "running") { sawLive12 = true; break; }
    await sleep(1000);
  }
  const run12 = await run12P;
  ok("T12 run completes after revoke", run12.status === 200, run12.status + " " + (run12.text || "").slice(0, 160));
  const s12 = await req("GET", "/api/meetings/" + mid12 + "/activity", undefined, OT);
  const op12 = s12.json && s12.json.discussion && s12.json.discussion.operationId;
  await sleep(8000);
  for (let w = 0; w < 75; w++) {
    try { fs.accessSync("qa/sig-o-t12.log"); fs.accessSync("qa/sig-g-t12.log"); break; } catch { }
    await sleep(1000);
  }
  await sleep(3000);
  const evO12 = loadEvents("qa/sig-o-t12.log");
  const evG12 = loadEvents("qa/sig-g-t12.log");
  ok("T12 subscriber logs exist (no missing-file vacuous pass)", evO12.length > 0 && evG12.length > 0, `o=${evO12.length} g=${evG12.length}`);
  ok("T12 owner sub proves live delivery of new op", evO12.some((e) => e.method === "__connected") && evFrames(evO12, mid12, "meeting-activity").some((f) => f.payload && f.payload.operationId === op12), "no owner frames for op " + op12);
  ok("T12 guest sub stayed connected (positive proof)", evG12.some((e) => e.method === "__connected") && evG12.some((e) => e.method === "__joined"), "guest sub dead/missing");
  ok("T12 revoked guest gets zero new-op events", op12 ? evFrames(evG12, mid12, "meeting-activity").filter((f) => f.payload && f.payload.operationId === op12).length === 0 : false, "leak or missing op");

  // ---- T10 revoke (before reboot wipes memory) ----
  const gr10 = await req("POST", "/api/boards/" + bid + "/grants", { userKey: gMail, meetingId: mid1, access: "read" }, OT);
  ok("T10 guest re-granted m1", (gr10.status === 201 || gr10.status === 200) && !!camel(gr10.json, "id"), gr10.status + " " + gr10.text.slice(0, 120));
  const delG = await req("DELETE", "/api/grants/" + camel(gr10.json, "id"), undefined, OT);
  ok("T10 grant revoked", delG.status === 200 || delG.status === 204, delG.status + " " + delG.text.slice(0, 120));
  const gRev = await req("GET", "/api/meetings/" + mid1 + "/activity", undefined, GT);
  ok("T10 revoked guest denied", gRev.status === 403, gRev.status + " " + gRev.text.slice(0, 120));
  const hyg = JSON.stringify([post1.json, s6b.json, sAns.json]);
  ok("T10 no message contents in activity", !hyg.includes("QA advisor reply") && !hyg.includes("QA secretary body"), "leak");
  ok("T10 no fake percentages/timers/secrets", !/\bpercent\b|\bprogress\b|\belapsed\b|\bbearer\b|\bapi[_-]?key\b/i.test(hyg), "fake progress or secret");

  // ---- T9 kill WHILE provider pending (run + secretary live), then reboot ----
  const m8 = await makeMeeting(bid, run + " m8", "brief eight", OT);
  ok("T9 create m8", !m8.error, m8.error || "");
  const mid8 = m8.id;
  const eSlow = await makeAdvisor(bid, "QASlowE", OT);
  ok("T9 advisor QASlowE ready", !eSlow.error, eSlow.error || "");
  await req("POST", "/api/meetings/" + mid8 + "/messages", { content: "kill turn" }, OT);
  const sec8P = req("POST", "/api/meetings/" + mid8 + "/secretary", { input: "QA-SLEEP:12000 kill pending", clientNonce: "n-" + crypto.randomUUID() }, OT, 60000);
  sec8P.catch(() => ({}));
  let secLive = false;
  for (let i = 0; i < 10; i++) {
    const s = await req("GET", "/api/meetings/" + mid8 + "/activity", undefined, OT);
    if (s.json && (s.json.secretary || []).some((e) => e.status === "inflight")) { secLive = true; break; }
    await sleep(500);
  }
  ok("T9a secretary live before kill", secLive, "secretary never reached inflight");
  const run8P = req("POST", "/api/meetings/" + mid8 + "/run", { prompt: "slow kill" }, OT, 60000);
  run8P.catch(() => ({}));
  let runLive = false;
  for (let i = 0; i < 10; i++) {
    const s = await req("GET", "/api/meetings/" + mid8 + "/activity", undefined, OT);
    const d = actOf(s);
    if (d && d.status === "running") { runLive = true; break; }
    await sleep(500);
  }
  ok("T9b run live before kill", runLive, "run never reached running");
  await killProc(api);
  api = track(startApi());
  ok("T9 api reboots after mid-flight kill", await waitApi(), "no 200 after restart");
  const gone = await req("GET", "/api/meetings/" + mid8 + "/activity", undefined, undefined, 10000);
  ok("T9 no endless busy after kill (meeting gone in memory -> 404)", gone.status === 404, gone.status + " " + gone.text.slice(0, 120));
  const nb = await req("POST", "/api/boards", { name: run + " fresh", mission: run + " m", stage: "qa" });
  ok("T9 fresh boot creates board", nb.status === 201 && camel(nb.json, "id"), nb.status + " " + nb.text.slice(0, 160));
  const nbid = camel(nb.json, "id");
  await req("POST", "/api/boards/" + nbid + "/lead", { name: "QA Lead", roleLabel: "Lead" });
  const na = await makeAdvisor(nbid, "Solo");
  ok("T9 fresh advisor ready", !na.error, na.error || "");
  const nm = await makeMeeting(nbid, run + " fresh mtg", "fresh brief");
  const nr = await req("POST", "/api/meetings/" + nm.id + "/run", { prompt: "hello" }, undefined, 60000);
  const nact = await req("GET", "/api/meetings/" + nm.id + "/activity");
  ok("T9 fresh run completes after kill (no phantom busy)", nr.status === 200 && nact.json && nact.json.discussion && nact.json.discussion.status === "completed", (nr.text || "").slice(0, 200));
  // ---- T11 real authorized SignalR + private continuation order ----
  for (let w = 0; w < 90; w++) {
    try {
      fs.accessSync("qa/sig-o-a2.log"); fs.accessSync("qa/sig-g-a2.log"); break;
    } catch { }
    await sleep(1000);
  }
  await sleep(3000);
  const evO1b = loadEvents("qa/sig-o-a1.log");
  const evO2 = loadEvents("qa/sig-o-a2.log");
  const evG2 = loadEvents("qa/sig-g-a2.log");
  ok("T11 owner subs connected+joined", evO1b.some((e) => e.method === "__connected") && evO2.some((e) => e.method === "__connected")
    && evO2.some((e) => e.method === "__joined"), "missing connect/join");
  const gJoin6 = evG2.find((e) => e.method === "__joined" && e.payload && e.payload.meeting === mid6);
  const gJoinT = (gJoin6 && gJoin6.t) || 0;
  const oJoin6 = evO2.find((e) => e.method === "__joined" && e.payload && e.payload.meeting === mid6);
  const oJoinT = (oJoin6 && oJoin6.t) || 0;
  ok("T11 subs joined mid6 before clarify fired (lifecycle correlation)", gJoinT > 0 && oJoinT > 0 && gJoinT < tClarifyFired && oJoinT < tClarifyFired, "gJoin=" + gJoinT + " oJoin=" + oJoinT + " fired=" + tClarifyFired);
  const gLiveMid6 = evFrames(evG2, mid6, "meeting-activity");
  ok("T11 guest live on mid6 group during lifecycle (positive proof)", gLiveMid6.length >= 1, "no board-visible frames for joined guest");
  const gSecAll = evFrames(evG1, mid1, "secretary-activity").concat(evFrames(evG2, mid1, "secretary-activity"), evFrames(evG2, mid6, "secretary-activity"));
  ok("T11 guest receives zero private secretary events (non-vacuous: live guest, joined group)", gSecAll.length === 0 && gLiveMid6.length >= 1, "leaked=" + gSecAll.length);
  const clStages = evFrames(evO2, mid6, "secretary-activity")
    .filter((e) => e.payload && e.payload.clientNonce === clNonce)
    .map((e) => e.payload.status);
  ok("T11 continuation stage order inflight>clarify>answering>completed",
    JSON.stringify(clStages) === JSON.stringify(["inflight", "needs-clarification", "answering", "completed"]),
    JSON.stringify(clStages));
  ok("T11 owner sees discussion + run-complete events", evFrames(evO1b, mid1, "meeting-activity").length >= 1, "no frames");

  console.log(`\nmeeting-activity QA: ${pass} passed, ${fail} failed`);
  if (failures.length) { console.log("failures:"); for (const m of failures) console.log(" - " + m); }
  console.log("LIMITS: uncertain-503 path is defensive-only (storage faults are not HTTP-triggerable in isolation); native-PG restart persistence is covered separately by meeting-activity-pg-qa (kill-while-blocked + same-DB restart + durable interrupted rows); memory-mode kill/reboot here covers orphan-free restart only, not PG persistence proof.");
}

try {
  await main();
} finally {
  try { for (const c of children) { try { c.kill(); } catch { } } } catch { }
  try { if (api) await killProc(api); } catch { }
  try { if (fake) await new Promise((r) => fake.close(r)); } catch { }
  try { for (const f of ["qa/sig-o-a1.log", "qa/sig-g-a1.log", "qa/sig-g-deny.log", "qa/sig-o-a2.log", "qa/sig-g-a2.log", "qa/sig-o-t12.log", "qa/sig-g-t12.log"]) fs.rmSync(f, { force: true }); } catch { }
}
process.exit(fail ? 1 : 0);
