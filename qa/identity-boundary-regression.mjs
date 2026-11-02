// SimCEO identity-boundary regression (focused closure #5 lead identity, #11 legacy portrait selection).
// Part 1 (HTTP, any backend): slow discussion on a board whose effective lead is the global lead v1;
//   saving a board-owned lead (also v1) mid-generation must discard the reply (409 "lead profile
//   changed", terminal run-outcome, zero advisor messages). A follow-up run with no changes publishes.
// Part 2 (PG ONLY): legacy competing portrait links seeded with exact owned-row INSERTs (fresh ids;
//   INSERT-only so the EF long-lived tracker cannot mask the seed). Full-ID provenance must beat the
//   newest link; a unique truncated 8-char prefix must resolve; an unresolvable selection must reject
//   (409) rather than rescue via an accepted image. A normal API re-select then approves (200).
// PG-only sections MUST FAIL, not skip, when PG/docker is unavailable.
// Isolated QA_API only. Default http://127.0.0.1:5099, REFUSE 5080.
// Does NOT restart any API. DEFERRED by default: run only after the primary integration barrier clears.
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const API = process.env.QA_API || "http://127.0.0.1:5099";
if (API.includes(":5080")) {
  console.error("REFUSE 5080: identity-boundary must run against an isolated QA API (default 5099).");
  process.exit(2);
}
const args = process.argv.slice(2);
function argVal(name) {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}
const TAG = argVal("--tag") || "identity";
const run = "ib-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e6).toString(36);
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; failures.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL " + name + (extra ? " :: " + extra : "")); }
}
async function req(method, path, body, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeout || 30000);
  try {
    const r = await fetch(API + path, {
      method,
      signal: ctl.signal,
      headers: { "content-type": "application/json", "x-user": "owner" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text };
  } finally { clearTimeout(t); }
}
const get = (p, o) => req("GET", p, undefined, o);
const post = (p, b, o) => req("POST", p, b, o);
const guid = () => crypto.randomUUID();
const ACCT = guid();
const camel = (o, k) => {
  if (!o || typeof o !== "object") return undefined;
  if (k in o) return o[k];
  const lo = k.toLowerCase();
  for (const key of Object.keys(o)) if (key.toLowerCase() === lo) return o[key];
  return undefined;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  ok("create-board-" + TAG + "-" + name.slice(-8), r.status === 201 && camel(r.json, "id"), r.status + " " + r.text.slice(0, 160));
  return camel(r.json, "id");
}
async function makeAdvisor(boardId, role) {
  const nm = run + "-" + role;
  const q = await post("/api/roster/quick", { accountId: ACCT, name: nm, description: role + " helping with " + run });
  if (q.status !== 201) return { error: "quick:" + q.status + " " + q.text.slice(0, 200) };
  const rid = camel(q.json, "id") || camel(q.json && q.json.entry, "id");
  const up = await uploadPortrait(rid);
  if (up.status !== 201) return { error: "upload:" + up.status + " " + up.text.slice(0, 200) };
  const imgs = await get("/api/roster/" + rid + "/images");
  const imgId = (imgs.json && imgs.json[0] && imgs.json[0].id) || camel(imgs.json && imgs.json[0], "id");
  const rev = await post("/api/images/" + imgId + "/review", { decision: "accept" });
  if (rev.status !== 200) return { error: "review:" + rev.status + " " + rev.text.slice(0, 200) };
  const cp = await post("/api/roster/" + rid + "/copy", { boardId, boardRole: role });
  if (cp.status !== 201) return { error: "copy:" + cp.status + " " + cp.text.slice(0, 200) };
  const aid = camel(cp.json, "id");
  const ap = await post("/api/boards/" + boardId + "/advisors/" + aid + "/approve", {});
  if (ap.status !== 200) return { error: "approve:" + ap.status + " " + ap.text.slice(0, 200) };
  return { rid, aid };
}
console.log("identity-boundary-regression " + run + " vs " + API + " tag=" + TAG);

// ---- Part 1: same-version lead identity swap during a delayed run ----
async function partLeadIdentity() {
  console.log("part 1: stale lead identity during delayed run");
  let g = await get("/api/lead");
  let globalLead = g.status === 200 ? g.json : null;
  if (globalLead) {
    ok("global-reused-v1", camel(globalLead, "version") === 1, "version=" + camel(globalLead, "version"));
  } else {
    const c = await post("/api/lead", { name: "QA Global Lead", roleLabel: "Board Lead", background: "global base for " + run, familiarTopics: "", simplerTopics: "", commPrefs: "" });
    ok("global-lead-created", c.status === 200 && camel(c.json, "version") === 1, c.status + " " + c.text.slice(0, 160));
    globalLead = c.json;
  }
  const gId = camel(globalLead, "id");
  const gVer = camel(globalLead, "version");
  const bid = await makeBoard(run + "-leadswap");
  const eff = await get("/api/boards/" + bid + "/lead");
  ok("effective-is-global", eff.status === 200 && camel(eff.json, "id") === gId && camel(eff.json, "version") === gVer, eff.status + " " + eff.text.slice(0, 200));
  const a = await makeAdvisor(bid, "LeadSwapSolo");
  ok("leadswap-advisor-ready", !a.error, a.error || "");
  const m = await post("/api/boards/" + bid + "/meetings", { title: run + " mtg", brief: "lead identity probe" });
  ok("leadswap-meeting", m.status === 201 && camel(m.json, "id"), m.status + " " + m.text.slice(0, 160));
  const mid = camel(m.json, "id");
  await post("/api/meetings/" + mid + "/messages", { sender: "lead", content: "QA lead identity probe question" });
  const slow = post("/api/meetings/" + mid + "/run", { policy: "balanced", prompt: "QA-SLEEP:6000 leadswap " + run, leadVersion: gVer }, { timeout: 120000 });
  await sleep(900);
  const bs = await post("/api/boards/" + bid + "/lead", { name: "QA Board Lead", roleLabel: "Board Lead", background: "board-specific for " + run, familiarTopics: "x", simplerTopics: "y", commPrefs: "z" });
  ok("board-lead-saved-same-version", bs.status === 200 && camel(bs.json, "version") === gVer && camel(bs.json, "id") !== gId, bs.status + " " + bs.text.slice(0, 200));
  const done = await slow;
  ok("stale-lead-run-409", done.status === 409, String(done.status) + " " + done.text.slice(0, 200));
  ok("stale-lead-reason", (done.text || "").includes("lead profile changed"), done.text.slice(0, 200));
  const g2 = await get("/api/lead");
  ok("global-untouched", g2.status === 200 && camel(g2.json, "id") === gId && camel(g2.json, "version") === gVer, g2.status + " " + g2.text.slice(0, 160));
  const n = await get("/api/meetings/" + mid + "/notes?kind=run-outcome");
  const arr = Array.isArray(n.json) ? n.json : [];
  const blob = JSON.stringify(arr[0] || {});
  const body = (arr[0] && (arr[0].body || arr[0].Body)) || "";
  const flat = blob + " " + (typeof body === "string" ? body : JSON.stringify(body));
  ok("stale-lead-terminal", flat.includes("interrupted") && flat.includes("lead profile changed"), flat.slice(0, 300));
  const msgs = await get("/api/meetings/" + mid + "/messages?take=100");
  const adv = (Array.isArray(msgs.json) ? msgs.json : []).filter((mm) => (mm.sender || mm.Sender) === "advisor");
  ok("stale-lead-no-publish", adv.length === 0, "advisorMsgs=" + adv.length);
  await post("/api/meetings/" + mid + "/messages", { sender: "lead", content: "QA followup after swap " + run });
  const ctl = await post("/api/meetings/" + mid + "/run", { policy: "balanced", prompt: "QA control " + run }, { timeout: 120000 });
  ok("control-publishes", ctl.status === 200 && ((ctl.json && ctl.json.published && ctl.json.published.length) || 0) >= 1, ctl.status + " " + ctl.text.slice(0, 200));
}

// ---- Part 2: legacy competing portrait links (PG-only INSERT seed) ----
function psql(sql, terse) {
  const a = ["exec", "-i", "simceo-qa-pg", "psql", "-U", "simceo", "-d", "simceo"];
  if (terse) a.push("-tAc", sql);
  else a.push("-v", "ON_ERROR_STOP=1", "-q", "-c", sql);
  try {
    return spawnSync("docker", a, { encoding: "utf8", windowsHide: true, timeout: 30000 });
  } catch (e) {
    return { status: 99, stdout: "", stderr: "spawn: " + ((e && e.message) || e) };
  }
}
async function partLegacyPortraits() {
  console.log("part 2: legacy competing portrait links (PG-only)");
  const be = await get("/api/backend");
  const mode = be.status === 200 ? (be.json.mode || be.json.Mode) : "?";
  const isPg = mode === "postgres";
  ok("pg-backend-required", isPg, "mode=" + JSON.stringify(be.json).slice(0, 120));
  if (!isPg) return;
  const probe = psql("SELECT 1", true);
  ok("pg-docker-exec", probe.status === 0 && (probe.stdout || "").trim() === "1", "status=" + probe.status + " " + ((probe.stderr || "") + (probe.stdout || "")).slice(0, 160));
  if (!(probe.status === 0)) return;
  const tImg = psql('SELECT count(*) FROM "public"."Images"', true);
  const tAdv = psql('SELECT count(*) FROM "public"."BoardAdvisors"', true);
  const tablesOk = tImg.status === 0 && tAdv.status === 0;
  ok("pg-tables-present", tablesOk, ("img:" + tImg.status + " adv:" + tAdv.status + " " + ((tImg.stderr || "") + (tAdv.stderr || ""))).slice(0, 160));
  if (!tablesOk) return;
  const bid = await makeBoard(run + "-legimg");
  const q = await post("/api/roster/quick", { accountId: ACCT, name: run + "-leg", description: "legacy image probe for " + run });
  const rid = camel(q.json, "id");
  ok("leg-roster-201", q.status === 201 && !!rid, q.status + " " + q.text.slice(0, 160));
  if (!rid) return;
  const aid1 = guid(), a1 = guid(), b1 = guid();
  const aid2 = guid(), a2 = guid(), b2 = guid();
  const aid3 = guid(), a3 = guid(), b3 = guid();
  const p2 = a2.slice(0, 8);
  ok("trunc-prefix-unambiguous", p2 !== b2.slice(0, 8), p2);
  const dead = guid().slice(0, 8);
  ok("dead-prefix-no-match", dead !== a3.slice(0, 8) && dead !== b3.slice(0, 8), dead);
  const insAdvisor = (aid, prov) => 'INSERT INTO "public"."BoardAdvisors" ("Id","BoardId","RosterEntryId","RosterVersion","BoardRole","Approved","Removed","ImageProvenance","CreatedAt") VALUES ($$' + aid + '$$,$$' + bid + '$$,$$' + rid + '$$,(SELECT "Version" FROM "public"."RosterEntries" WHERE "Id"=$$' + rid + '$$),$$Legacy$$,false,false,$$' + prov + '$$,NOW())';
  const insImage = (img, aid, rev, older) => 'INSERT INTO "public"."Images" ("Id","RosterEntryId","BoardAdvisorId","Kind","Provenance","Review","ContentType","CreatedAt") VALUES ($$' + img + '$$,$$' + rid + '$$,$$' + aid + '$$,$$upload$$,$$upload:qa.png$$,$$' + rev + '$$,$$image/png$$,' + (older ? "NOW() - INTERVAL '2 minutes'" : "NOW()") + ')';
  const seeds = [
    insAdvisor(aid1, "upload:" + a1), insImage(a1, aid1, "rejected", true), insImage(b1, aid1, "accepted", false),
    insAdvisor(aid2, "upload:" + p2), insImage(a2, aid2, "rejected", true), insImage(b2, aid2, "accepted", false),
    insAdvisor(aid3, "upload:" + dead), insImage(a3, aid3, "rejected", true), insImage(b3, aid3, "accepted", false),
  ];
  let seeded = true;
  for (const sql of seeds) {
    const r = psql(sql, false);
    if (r.status !== 0) { seeded = false; console.log("  note: seed failed: " + ((r.stderr || "") + (r.stdout || "")).slice(0, 160)); }
  }
  ok("leg-rows-seeded", seeded, "INSERT-only exact owned rows");
  if (!seeded) return;
  const cnt = (aid) => (psql('SELECT count(*) FROM "public"."Images" WHERE "BoardAdvisorId"=$$' + aid + '$$', true).stdout || "").trim();
  ok("leg-links-exact", cnt(aid1) === "2" && cnt(aid2) === "2" && cnt(aid3) === "2", [cnt(aid1), cnt(aid2), cnt(aid3)].join(","));
  const prov1 = (psql('SELECT count(*) FROM "public"."BoardAdvisors" WHERE "Id"=$$' + aid1 + '$$ AND "ImageProvenance"=$$upload:' + a1 + '$$', true).stdout || "").trim();
  ok("leg-prov-exact", prov1 === "1", prov1);
  for (const [tag, aid] of [["full", aid1], ["trunc", aid2], ["dead", aid3]]) {
    const ap = await post("/api/boards/" + bid + "/advisors/" + aid + "/approve", {});
    ok("leg-" + tag + "-approve-409", ap.status === 409 && ap.text.toLowerCase().includes("portrait"), ap.status + " " + ap.text.slice(0, 200));
  }
  const setup = await get("/api/boards/" + bid + "/setup");
  const canon = JSON.stringify(setup.json || {});
  ok("setup-fingerprint-rejected-A", canon.includes(a1) && canon.includes("rejected"), canon.slice(0, 200));
  ok("setup-fingerprint-not-B", !canon.includes(b1), "B must not be the fingerprinted selection");
  const sel = await post("/api/images/" + b1 + "/select", { boardAdvisorId: aid1 });
  ok("reselect-B-200", sel.status === 200, String(sel.status) + " " + sel.text.slice(0, 160));
  const ap1 = await post("/api/boards/" + bid + "/advisors/" + aid1 + "/approve", {});
  ok("reselect-approve-200", ap1.status === 200, String(ap1.status) + " " + ap1.text.slice(0, 160));
  ok("reselect-single-link", cnt(aid1) === "1", cnt(aid1));
}

await partLeadIdentity();
await partLegacyPortraits();

console.log("PASS " + pass + " FAIL " + fail);
if (failures.length) console.log("failures:\n" + failures.join("\n"));
process.exit(fail ? 1 : 0);
