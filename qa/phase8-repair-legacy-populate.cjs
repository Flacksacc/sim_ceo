const API = process.env.QA_API || "http://127.0.0.1:5197";
const fs = require("fs");
const path = require("path");
const run = "p8lb-" + Date.now().toString(36);
let pass = 0, fail = 0; const bad = [];
function ok(n, c, e) { if (c) pass++; else { fail++; bad.push(n + (e ? " :: " + e : "")); console.log("  FAIL " + n + (e ? " :: " + e : "")); } }
async function req(method, p, body, headers, form) {
  const r = await fetch(API + p, { method, headers: { ...(form ? {} : { "content-type": "application/json" }), ...(headers || {}) }, body: form ? body : (body === undefined ? undefined : JSON.stringify(body)) });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {} return { status: r.status, json: j, text: t };
}
const B = (t) => ({ Authorization: "Bearer " + t });
const XO = { "X-User": "owner" };
const pw = "TestPassword123!";
(async () => {
  console.log("legacy-populate run=" + run + " api=" + API);
  const ids = { run, pw };
  const b = await req("POST", "/api/boards", { name: run + "-legacy-board", mission: "m", stage: "s" }, XO);
  ok("old-board", b.status === 201 && b.json?.id, b.status + " " + b.text.slice(0, 160));
  ids.boardId = b.json?.id;
  const m = await req("POST", `/api/boards/${ids.boardId}/meetings`, { title: "legacy-mtg", brief: "b" }, XO);
  ok("old-meeting", (m.status === 201 || m.status === 200) && m.json?.id, m.status + " " + m.text.slice(0, 160));
  ids.meetingId = m.json?.id;
  async function roster(name, desc) {
    return await req("POST", "/api/roster", { name, description: desc, profileJson: "{\"bio\":\"a sufficiently long test profile for legacy\"}", version: 1 }, XO);
  }
  const r1 = await roster("LegacyOwner1", "d1"); ok("old-roster1", r1.status === 201 && r1.json?.id, r1.status + " " + r1.text.slice(0, 160));
  const r2 = await roster("LegacyOwner2", "d2"); ok("old-roster2", r2.status === 201 && r2.json?.id, r2.status + " " + r2.text.slice(0, 160));
  ids.rosOwner = r1.json?.id; ids.rosBlankSrc = r2.json?.id;
  const w = await req("POST", "/api/wizard", { fieldsJson: "{\"name\":\"W\"}" }, XO);
  ok("old-wizard", (w.status === 200 || w.status === 201) && w.json?.id, w.status + " " + w.text.slice(0, 200));
  ids.wizId = w.json?.id;
  async function reg(email) { return await req("POST", "/api/auth/register", { email, password: pw }); }
  const alphaE = run + "-alpha@example.com", betaE = run + "-beta@example.com", gammaE = run + "-gamma@example.com";
  ids.alpha = alphaE; ids.beta = betaE; ids.gamma = gammaE;
  const ar = await reg(alphaE); ok("old-reg-alpha", ar.status === 201 && ar.json?.token, ar.status + " " + ar.text.slice(0, 160));
  const br = await reg(betaE); ok("old-reg-beta", br.status === 201, br.status + " " + br.text.slice(0, 160));
  const gr = await reg(gammaE); ok("old-reg-gamma", gr.status === 201, gr.status + " " + gr.text.slice(0, 160));
  ids.alphaTok = ar.json?.token; ids.betaTok = br.json?.token; ids.gammaTok = gr.json?.token;
  const inv = await req("POST", `/api/boards/${ids.boardId}/invites`, { email: betaE, role: "guest", meetingId: ids.meetingId }, XO);
  ok("old-invite", inv.status === 201 && (inv.json?.id || inv.json?.Id), inv.status + " " + inv.text.slice(0, 200));
  ids.invId = inv.json?.id || inv.json?.Id;
  const acc = await req("POST", `/api/invites/${ids.invId}/accept`, {}, B(ids.betaTok));
  ok("old-accept", acc.status === 200, acc.status + " " + acc.text.slice(0, 200));
  const gWide = await req("POST", `/api/boards/${ids.boardId}/grants`, { userKey: betaE, access: "manage" }, XO);
  ok("old-widened", gWide.status === 201, gWide.status + " " + gWide.text.slice(0, 200));
  ids.widenedId = gWide.json?.id || gWide.json?.Id;
  const gLegit = await req("POST", `/api/boards/${ids.boardId}/grants`, { userKey: gammaE, access: "manage" }, XO);
  ok("old-legit", gLegit.status === 201, gLegit.status + " " + gLegit.text.slice(0, 200));
  ids.legitId = gLegit.json?.id || gLegit.json?.Id;
  const gMeet = await req("POST", `/api/boards/${ids.boardId}/grants`, { userKey: betaE, access: "discuss", meetingId: ids.meetingId }, B(ids.betaTok).Authorization ? XO : XO);
  ids.meetGrantId = gMeet.json?.id || gMeet.json?.Id;
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  const fd = new FormData(); fd.append("audio", new Blob([png], { type: "audio/webm" }), "mic.webm");
  const tr = await req("POST", `/api/meetings/${ids.meetingId}/transcribe`, fd, B(ids.betaTok), true);
  ok("old-transcribe", tr.status === 201 && (tr.json?.turn || tr.json?.id), tr.status + " " + tr.text.slice(0, 200));
  ids.voiceId = tr.json?.turn || tr.json?.id;
  fs.writeFileSync(path.join(__dirname, "..", ".tmp", "legacybin-ids.json"), JSON.stringify(ids, null, 1));
  console.log(`FINAL pass=${pass} fail=${fail} ids saved`);
  if (bad.length) { console.log("FAILURES:"); for (const x of bad) console.log(" - " + x); }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log("HARNESS-ERROR " + (e && e.stack || e)); process.exit(2); });
