const API = process.env.QA_API || "http://127.0.0.1:5097";
const run = "p8run-" + Date.now().toString(36);
let pass = 0, fail = 0; const bad = [];
function ok(n, c, e) { if (c) pass++; else { fail++; bad.push(n + (e ? " :: " + e : "")); console.log("  FAIL " + n + (e ? " :: " + e : "")); } }
async function req(method, p, body, headers, form) {
  const r = await fetch(API + p, { method, headers: { ...(form ? {} : { "content-type": "application/json" }), ...(headers || {}) }, body: form ? body : (body === undefined ? undefined : JSON.stringify(body)) });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch {} return { status: r.status, json: j, text: t };
}
const B = (t) => ({ Authorization: "Bearer " + t });
const pw = "TestPassword123!";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
(async () => {
  console.log("repair-run test api=" + API + " run=" + run);
  const owE = run + "-owner@example.com", guE = run + "-guest@example.com";
  const ow = await req("POST", "/api/auth/register", { email: owE, password: pw });
  const gr = await req("POST", "/api/auth/register", { email: guE, password: pw });
  ok("run-reg", ow.status === 201 && gr.status === 201, ow.status + "/" + gr.status);
  const ownerT = ow.json.token, guestT = gr.json.token;
  const b = await req("POST", "/api/boards", { name: run + "-b" }, B(ownerT));
  const bid = b.json.id; ok("run-board", b.status === 201 && bid, b.status + " " + b.text.slice(0, 120));
  const put = await req("PATCH", "/api/boards/" + bid, { discussionPolicy: "focused" }, B(ownerT));
  ok("run-policy-focused", put.status === 200, put.status + " " + put.text.slice(0, 160));
  async function mkAdvisor(name, role) {
    const re = await req("POST", "/api/roster", { name, description: "d-" + name, profileJson: "{\"bio\":\"a sufficiently long test profile for run\"}" }, B(ownerT));
    const rid = re.json.id || re.json.Id;
    const fd = new FormData(); fd.append("file", new Blob([PNG], { type: "image/png" }), "p.png");
    const up = await fetch(API + "/api/roster/" + rid + "/image/upload", { method: "POST", headers: B(ownerT), body: fd });
    const upj = await up.json();
    const rv = await req("POST", "/api/images/" + upj.id + "/review", { decision: "accept" }, B(ownerT));
    const cp = await req("POST", "/api/boards/" + bid + "/advisors", { rosterEntryId: rid, boardRole: role }, B(ownerT));
    const aid = cp.json.id || cp.json.Id;
    const ap = await req("POST", "/api/boards/" + bid + "/advisors/" + aid + "/approve", {}, B(ownerT));
    return { rid, aid, img: upj.id, ok: up.status === 201 && rv.status === 200 && cp.status === 201 && ap.status === 200 };
  }
  const a1 = await mkAdvisor("AdvOne", "strategist");
  const a2 = await mkAdvisor("AdvTwo", "analyst");
  ok("run-advisors-ready", a1.ok && a2.ok, JSON.stringify([a1.ok, a2.ok]));
  const lp = await req("POST", "/api/boards/" + bid + "/lead", { name: "Lead", roleLabel: "CEO", background: "bg", familiarTopics: "f", simplerTopics: "s", commPrefs: "c" }, B(ownerT));
  ok("run-lead", lp.status === 200 || lp.status === 201, lp.status + " " + lp.text.slice(0, 160));
  const m = await req("POST", "/api/boards/" + bid + "/meetings", { title: "rm", brief: "Please discuss the roadmap." }, B(ownerT));
  const mid = m.json.id || m.json.Id; ok("run-meeting", m.status === 201 && mid, m.status + " " + m.text.slice(0, 120));
  const pt = await req("PATCH", "/api/meetings/" + mid, { participantIds: [a1.aid] }, B(ownerT));
  ok("run-participants", pt.status === 200, pt.status + " " + pt.text.slice(0, 160));
  await req("POST", "/api/boards/" + bid + "/grants", { userKey: guE, access: "discuss", meetingId: mid }, B(ownerT));
  const grun = await req("POST", "/api/meetings/" + mid + "/run", { policy: "open", prompt: "Go." }, B(guestT));
  ok("run-guest-200", grun.status === 200, grun.status + " " + (grun.text || "").slice(0, 200));
  const published = (grun.json && grun.json.published) || [];
  ok("run-guest-published", Array.isArray(published) && published.length >= 1, "published=" + published.length);
  const names = published.map((p) => (p.advisorName || p.AdvisorName || "")).join(",");
  ok("run-stored-participants", names.includes("strategist") && !names.includes("analyst"), names);
  const notes = await req("GET", "/api/meetings/" + mid + "/notes?kind=run-outcome", undefined, B(ownerT));
  const last = Array.isArray(notes.json) ? notes.json[0] : null;
  let pol = "";
  try { pol = last ? JSON.parse(last.Body || last.body).policy : ""; } catch {}
  ok("run-effective-policy", pol === "focused", "policy=" + pol);
  const gm = await req("GET", "/api/meetings/" + mid + "/messages?take=60", undefined, B(guestT));
  ok("run-guest-reads", gm.status === 200 && JSON.stringify(gm.json).includes("QA advisor reply"), gm.status);
  // transcription creator flow + concurrent finalize
  const tr = await req("POST", "/api/meetings/" + mid + "/voice", { partial: "guest draft one" }, B(guestT));
  const trj = tr.json;
  ok("run-voice-create", tr.status === 201 && (trj.id || trj.Id), tr.status);
  const vid = trj.id || trj.Id;
  const gl = await req("GET", "/api/meetings/" + mid + "/voice", undefined, B(guestT));
  const grows = Array.isArray(gl.json) ? gl.json : [];
  ok("run-voice-creator-sees", grows.some((x) => (x.Id || x.id) === vid), "rows=" + grows.length);
  const ol = await req("GET", "/api/meetings/" + mid + "/voice", undefined, B(ownerT));
  const orows = Array.isArray(ol.json) ? ol.json : [];
  ok("run-voice-owner-no-unsent", !orows.some((x) => (x.Id || x.id) === vid), "rows=" + orows.length);
  const [f1, f2] = await Promise.all([
    req("POST", "/api/voice/" + vid + "/finalize", { transcript: "final A" }, B(guestT)),
    req("POST", "/api/voice/" + vid + "/finalize", { transcript: "final B" }, B(guestT)),
  ]);
  const codes = [f1.status, f2.status].sort().join(",");
  ok("run-voice-once", codes === "200,409", codes);
  const of = await req("POST", "/api/voice/" + vid + "/finalize", { transcript: "owner hijack" }, B(ownerT));
  ok("run-voice-owner-denied", of.status === 403 || of.status === 409, of.status);
  const tfd = new FormData(); tfd.append("audio", new Blob([PNG], { type: "audio/webm" }), "mic.webm");
  const ttr = await fetch(API + "/api/meetings/" + mid + "/transcribe", { method: "POST", headers: B(guestT), body: tfd });
  const ttrj = await ttr.json().catch(() => null);
  const tvid = ttrj && (ttrj.turn || ttrj.id || ttrj.Id);
  ok("run-transcribe-creator", ttr.status === 201 && !!tvid, ttr.status + " " + JSON.stringify(ttrj).slice(0, 160));
  if (tvid) {
    const tf = await req("POST", "/api/voice/" + tvid + "/finalize", { transcript: "transcribed final" }, B(guestT));
    ok("run-transcribe-finalize", tf.status === 200, tf.status + " " + tf.text.slice(0, 160));
  }
  // media: linked pending/unselected denial + record export bytes
  const pend = await fetch(API + "/api/images/" + a2.img, { headers: B(guestT) });
  ok("run-media-pending-denied", pend.status === 403, pend.status);
  const dl = await fetch(API + "/api/images/" + a1.img, { headers: B(ownerT) });
  const dbuf = Buffer.from(await dl.arrayBuffer());
  ok("run-media-bytes", dl.status === 200 && dbuf.equals(PNG), dl.status + " len=" + dbuf.length);
  console.log("FINAL pass=" + pass + " fail=" + fail);
  if (bad.length) { console.log("FAILURES:"); for (const x of bad) console.log(" - " + x); }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log("HARNESS-ERROR " + (e && e.stack || e)); process.exit(2); });
