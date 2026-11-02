// SimCEO core closure regression (phase-03 findings repair scope).
// Finding 3: ContextCurator BidPacket/BuildPacket consume the accepted
// effective board NAME (LeadSetup.EffectiveView), not live board.Name.
// LIMITATION (honest label): this script probes only the accepted-snapshot
// layer over real HTTP (ActiveJson vs live board.Name, dirty flag) without
// model calls. It does NOT call BidPacket/BuildPacket and is NOT runtime
// proof of packet behavior; the 2-line name fix is verified by source
// inspection + build, and the parent independently traces the actual lines.
// Finding 1 image-scope cases live in qa/roster-regression.mjs section 11.
// Isolated QA_API only. Default http://127.0.0.1:5099, REFUSE 5080.
// Run: QA_API=http://127.0.0.1:5099 node qa/core-closure-regression.mjs
// Does NOT restart shared QA API. No model calls, no ports, no images.
import crypto from "node:crypto";
const API = process.env.QA_API || "http://127.0.0.1:5099";
if (API.includes(":5080")) {
  console.error("REFUSE 5080: isolated QA_API required (default 5099).");
  process.exit(2);
}
const run = "cc-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e6).toString(36);
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok " + name); }
  else { fail++; failures.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL " + name + (extra ? " :: " + extra : "")); }
}
async function req(method, path, body, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeout || 30000);
  try {
    const headers = { "x-user": opts.user || "owner" };
    let b;
    if (body !== undefined && !(body instanceof FormData)) {
      headers["content-type"] = "application/json";
      b = JSON.stringify(body);
    } else if (body instanceof FormData) {
      b = body;
    }
    const r = await fetch(API + path, { method, signal: ctl.signal, headers, body: b });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text };
  } finally { clearTimeout(t); }
}
const get = (p, o) => req("GET", p, undefined, o);
const post = (p, b, o) => req("POST", p, b, o);
const patch = (p, b, o) => req("PATCH", p, b, o);
const guid = () => crypto.randomUUID();
const ACCT = guid();
const camel = (o, k) => {
  if (!o || typeof o !== "object") return undefined;
  if (k in o) return o[k];
  const lo = k.toLowerCase();
  for (const key of Object.keys(o)) if (key.toLowerCase() === lo) return o[key];
  return undefined;
};
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
async function uploadPortrait(rosterId) {
  const form = new FormData();
  form.append("file", new Blob([PNG], { type: "image/png" }), "qa.png");
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30000);
  try {
    const r = await fetch(API + "/api/roster/" + rosterId + "/image/upload", {
      method: "POST", signal: ctl.signal, headers: { "x-user": "owner" }, body: form,
    });
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text };
  } finally { clearTimeout(t); }
}
async function makeBoard(name) {
  const r = await post("/api/boards", { name, mission: run + " mission", stage: "qa" });
  ok("board-" + name, r.status === 201, r.status + " " + r.text.slice(0, 120));
  return camel(r.json, "id");
}
async function quickRoster(name, desc) {
  const q = await post("/api/roster/quick", { accountId: ACCT, name, description: desc });
  ok("quick-" + name, q.status === 201, q.status + " " + q.text.slice(0, 120));
  return camel(q.json, "id");
}
function activeNameOf(setupJson) {
  const raw = camel(setupJson, "activeJson");
  try { return (JSON.parse(raw || "{}") || {}).name; } catch { return undefined; }
}
console.log("core-closure-regression " + run + " vs " + API);
// Finding 3: accepted snapshot governs until reactivation (snapshot-layer probe
// only -- does not call the packet builders; not runtime proof of packets).
{
  console.log("  accepted-name packet scope (finding 3)");
  const acceptedName = run + "-Accepted";
  const draftName = run + "-Draft";
  const bid = await makeBoard(acceptedName);
  const lead = await post("/api/boards/" + bid + "/lead", { name: "QA Lead", roleLabel: "Lead" });
  ok("pkt-lead-200", lead.status === 200, String(lead.status) + " " + lead.text.slice(0, 120));
  const rid = await quickRoster(run + "-pkt", "packet scope probe for " + run);
  await uploadPortrait(rid);
  const imgs = await get("/api/roster/" + rid + "/images");
  const imgId = camel(imgs.json[0], "id");
  const acc = await post("/api/images/" + imgId + "/review", { decision: "accept" });
  ok("pkt-portrait-accept-200", acc.status === 200, String(acc.status));
  const cp = await post("/api/roster/" + rid + "/copy", { boardId: bid, boardRole: "Pkt" });
  const aid = camel(cp.json, "id");
  ok("pkt-copy-201", cp.status === 201, String(cp.status));
  const ap = await post("/api/boards/" + bid + "/advisors/" + aid + "/approve", {});
  ok("pkt-approve-200", ap.status === 200, String(ap.status) + " " + ap.text.slice(0, 160));
  const s0 = await get("/api/boards/" + bid + "/setup");
  const hash0 = camel(s0.json, "draftHash");
  ok("pkt-setup-hash", typeof hash0 === "string" && hash0.length >= 16, String(hash0).slice(0, 40));
  const act0 = await post("/api/boards/" + bid + "/setup/activate", { hash: hash0 });
  ok("pkt-activate-accepted-200", act0.status === 200, String(act0.status) + " " + act0.text.slice(0, 160));
  const ren = await patch("/api/boards/" + bid, { name: draftName });
  ok("pkt-rename-draft-200", ren.status === 200 && camel(ren.json, "name") === draftName, String(ren.status) + " " + ren.text.slice(0, 160));
  const s1 = await get("/api/boards/" + bid + "/setup");
  const liveName = camel(s1.json && s1.json.board, "name");
  ok("pkt-live-is-draft", liveName === draftName, String(liveName));
  ok("pkt-accepted-kept", activeNameOf(s1.json) === acceptedName, JSON.stringify(activeNameOf(s1.json)));
  ok("pkt-dirty-after-rename", camel(s1.json, "dirty") === true, s1.text.slice(0, 160));
  const hash1 = camel(s1.json, "draftHash");
  ok("pkt-rehash-after-rename", typeof hash1 === "string" && hash1 !== hash0, String(hash1).slice(0, 40));
  const act1 = await post("/api/boards/" + bid + "/setup/activate", { hash: hash1 });
  ok("pkt-reactivate-200", act1.status === 200, String(act1.status) + " " + act1.text.slice(0, 160));
  const s2 = await get("/api/boards/" + bid + "/setup");
  ok("pkt-reactivated-gets-draft", activeNameOf(s2.json) === draftName, JSON.stringify(activeNameOf(s2.json)));
  ok("pkt-clean-after-reactivate", camel(s2.json, "dirty") === false, s2.text.slice(0, 160));
}
console.log("PASS " + pass + " FAIL " + fail);
if (failures.length) console.log("failures: " + failures.join(" | "));
process.exit(fail ? 1 : 0);
