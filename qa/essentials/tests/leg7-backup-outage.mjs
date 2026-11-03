// leg7: full backup roundtrip + prior-state failed validation + real COMMIT
// fault + outage 503/health 200/redacted diag + held restore-epoch discard +
// two restarts + one billed pair (needs owned PG + published current API).
// SELF-MANAGED: the runner creates/drops ONLY the exclusive DB; this leg
// owns its API/fake generations (three API starts = baseline + TWO restarts).
// Uses REAL handlers + real RecordFull pairs (never surrogate table
// appends), a QA-owned PG trigger (no server change, no shipping switch)
// for the uncertain-commit fault, and drops ONLY its own exclusive DB for
// the outage (never prior/other DBs, no container lifecycle changes).
// Preservation: CURRENT admin ACL re-ownership, redacted diag, spend/ledger
// semantics (ledgers restart empty by design after total loss; new billing
// works), grants/invites excluded by design. Exit nonzero on ANY failure.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { makeCtx, API, get, post, camel, mustArray, registerOrLogin, digest, fakeJson, waitFor, ledgerSnapshot, sharedNewId, newPairsComplete, priorRowsIntact, sha256 } from "../helpers/essentials-http.mjs";
import { verifyContainer, tableList, triggerInstall, triggerDrop, psql } from "../helpers/essentials-pg.mjs";
import { startOwned, stopOwned, tailOf, waitForHttpOk } from "../helpers/essentials-proc.mjs";

const ctx = makeCtx("leg7");
const ART = process.env.ESS_QA_ARTIFACT_DIR || ".";
const run = "ess7-" + Date.now().toString(36);
const DB = process.env.ESS_QA_DB || "";
const CONN = process.env.ESS_QA_PG_CONN || "";
const API_DLL = process.env.ESS_QA_API_DLL || "";
const PUBDIR = process.env.ESS_QA_PUBLISH_DIR || ".";
const FAKE = process.env.QA_FAKE || "http://127.0.0.1:5242";
const writeArt = (name, obj) => {
  try { fs.writeFileSync(path.join(ART, name), typeof obj === "string" ? obj : JSON.stringify(obj, null, 2)); }
  catch (e) { ctx.ok("artifact-" + name, false, String(e).slice(0, 160)); }
};
function docker(args, timeoutMs = 60000) {
  return execFileSync("docker", args, { windowsHide: true, timeout: timeoutMs, stdio: "pipe" }).toString();
}
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
async function uploadPortrait(token, rosterId) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30000);
  try {
    const form = new FormData();
    form.append("file", new Blob([PNG], { type: "image/png" }), "qa.png");
    const r = await fetch(API + "/api/roster/" + rosterId + "/image/upload", { method: "POST", signal: ctl.signal, headers: { authorization: "Bearer " + token }, body: form });
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text };
  } finally { clearTimeout(t); }
}
async function makeApprovedAdvisor(token, boardId, role, tag) {
  const q = await post("/api/roster/quick", { accountId: "00000000-0000-0000-0000-000000000000", name: run + "-" + tag, description: role + " helping with " + run + " strategy work" }, { token });
  if (q.status !== 201) throw new Error("quick failed " + q.status + " " + q.text.slice(0, 200));
  const rid = camel(q.json, "id");
  const up = await uploadPortrait(token, rid);
  if (up.status !== 201) throw new Error("portrait upload failed " + up.status);
  const imgs = mustArray(ctx, "adv-images-" + tag, await get("/api/roster/" + rid + "/images", { token }));
  const rev = await post("/api/images/" + camel(imgs[0], "id") + "/review", { decision: "accept" }, { token });
  if (rev.status !== 200) throw new Error("portrait accept failed " + rev.status);
  const cp = await post("/api/roster/" + rid + "/copy", { boardId, boardRole: role }, { token });
  if (cp.status !== 201) throw new Error("copy failed " + cp.status + " " + cp.text.slice(0, 200));
  const ap = await post("/api/boards/" + boardId + "/advisors/" + camel(cp.json, "id") + "/approve", {}, { token });
  if (ap.status !== 200) throw new Error("approve failed " + ap.status + " " + ap.text.slice(0, 200));
  return { rid };
}
let apiH = null, fakeH = null;
const gens = [];
async function startFake() {
  const out = path.join(ART, "fake.log"), err = path.join(ART, "fake.err.log");
  fakeH = startOwned({ file: "node.exe", args: ["qa/essentials/helpers/essentials-fake.mjs", "--port", String(new URL(FAKE).port || "5242")], cwd: process.env.ESS_QA_PROJECTROOT || ".", env: {}, outFile: out, errFile: err });
  const w = await waitForHttpOk(FAKE + "/__health", { timeoutMs: 30000 });
  if (!w.ok) throw new Error("fake never healthy: " + w.last);
  ctx.ok("fake-ready", true, "owned fake up");
}
async function startApi(gen) {
  const out = path.join(ART, "api-gen" + gen + ".log"), err = path.join(ART, "api-gen" + gen + ".err.log");
  apiH = startOwned({
    file: "dotnet", args: [API_DLL], cwd: PUBDIR,
    env: { ASPNETCORE_URLS: API, USE_POSTGRES: "1", CONNECTIONSTRINGS__APP: CONN, META_API_BASE: FAKE, META_API_KEY: "qa-dummy" },
    outFile: out, errFile: err,
  });
  gens.push({ gen, out, err });
  const w = await waitForHttpOk(API + "/ready", { timeoutMs: 120000 });
  if (!w.ok) { ctx.ok("api-gen" + gen + "-ready", false, w.last + " apiErr=[" + tailOf(err) + "]"); throw new Error("api gen" + gen + " /ready never 200"); }
  ctx.ok("api-gen" + gen + "-ready", true, "gen" + gen);
}
async function stopApi(gen) {
  if (!apiH) return;
  const r = await stopOwned(apiH, "api-gen" + gen, path.join(ART, "api-gen" + gen + ".log"), path.join(ART, "api-gen" + gen + ".err.log"));
  apiH = null;
  if (!r.ok) { ctx.ok("api-gen" + gen + "-stop", false, r.note); throw new Error("api gen" + gen + " stop failed: " + r.note); }
  ctx.ok("api-gen" + gen + "-stopped-eof", true, r.note);
}
// Restore has TWO deliberate, code-confirmed effects beyond the export
// timestamp (OpsEndpoints restore handler):
//  1. meetings[].Generation = max(live, restored) + 1 (epoch invalidation).
//  2. notes with RootId == Empty adopt RootId = self (chain-root norm).
// Everything else must be byte-identical; any other drift is a hard FAIL.
const normSnap = (snapStr) => {
  // PG timestamptz stores microsecond precision; in-memory tracked entities
  // carry 7-digit ticks. Truncate both sides to microseconds so pre-persist
  // vs post-persist serializations compare exactly (no data content change).
  const o = JSON.parse(snapStr.replace(/(\.\d{6})\d+(Z|[+-]\d{2}:\d{2})/g, "$1$2").replace(/(\.\d*[1-9])0+(Z|[+-]\d{2}:\d{2})/g, "$1$2"));
  delete o.at;
  const effects = [];
  for (const m of (o.meetings || [])) {
    if (typeof m.Generation === "number") { effects.push("meeting-gen=" + m.Generation); delete m.Generation; }
  }
  for (const n of (o.notes || [])) {
    if (n.RootId === "00000000-0000-0000-0000-000000000000" || !n.RootId) { effects.push("note-root-self:" + n.Id); n.RootId = n.Id; }
  }
  return { canon: JSON.stringify(o), effects };
};
const snapsEqual = (a, b) => {
  const na = normSnap(a), nb = normSnap(b);
  return { equal: na.canon === nb.canon, effectsA: na.effects, effectsB: nb.effects };
};

try {
  ctx.ok("env-db", !!DB && /^essentials_[a-z0-9_]+$/.test(DB), "ESS_QA_DB=" + DB);
  ctx.ok("env-conn", !!CONN, "conn missing");
  ctx.ok("env-api-dll", !!API_DLL && fs.existsSync(API_DLL), API_DLL);
  if (!DB || !CONN || !API_DLL) throw new Error("leg7 env missing");
  verifyContainer();
  ctx.ok("container-verified", true, "owned 14bcfcf7 running");

  await startFake();
  await startApi(1);

  // --- seed: admin tokA, reader tokB, board/meeting/advisor, grant+invite ---
  const tokA = await registerOrLogin(ctx, post, run + "-admin@qa.local", "qa-admin-1-pw12");
  const tokB = await registerOrLogin(ctx, post, run + "-reader@qa.local", "qa-reader-1-pw12");
  ctx.ok("tokens-present", !!tokA && !!tokB, "digests=" + digest(tokA) + "/" + digest(tokB));
  const b = await post("/api/boards", { name: run + "-board", mission: run + " mission", stage: "forming" }, { token: tokA });
  ctx.ok("seed-board", b.status === 201, "status=" + b.status);
  const bid = camel(b.json, "id");
  const ld = await post("/api/boards/" + bid + "/lead", { name: "QA Lead", roleLabel: "Chief", background: "bg", familiarTopics: "fam", simplerTopics: "sim", commPrefs: "direct" }, { token: tokA });
  ctx.ok("seed-lead", ld.status === 200, "status=" + ld.status + " " + String(ld.text).slice(0, 160));
  await makeApprovedAdvisor(tokA, bid, "Strategist", "g1");
  const m = await post("/api/boards/" + bid + "/meetings", { title: run + " meeting", brief: "backup essentials" }, { token: tokA });
  ctx.ok("seed-meeting", m.status === 201, "status=" + m.status);
  const mid = camel(m.json, "id");
  const g = await post("/api/boards/" + bid + "/grants", { meetingId: null, userKey: run + "-reader@qa.local", access: "read" }, { token: tokA });
  ctx.ok("seed-grant", g.status === 201 || g.status === 200, "status=" + g.status + " " + String(g.text).slice(0, 160));
  const inv = await post("/api/boards/" + bid + "/invites", { email: run + "-pending@qa.local", userKey: run + "-pending", role: "viewer" }, { token: tokA });
  ctx.ok("seed-invite", inv.status === 201 || inv.status === 200, "status=" + inv.status + " " + String(inv.text).slice(0, 160));

  // --- full backup roundtrip ---
  const bk = await get("/api/backup", { token: tokA });
  ctx.ok("backup-200", bk.status === 200 && typeof camel(bk.json, "snapshot") === "string", "status=" + bk.status);
  let snap0 = camel(bk.json, "snapshot"), hash0 = camel(bk.json, "hash");
  ctx.ok("backup-hash-verifies", sha256(snap0) === String(hash0).toLowerCase() || ("sha256:" + sha256(snap0)) === String(hash0), "hash=" + String(hash0).slice(0, 32));
  writeArt("backup-S0.json", { hash: hash0, bytes: snap0.length, snapshot: snap0 });
  const boardsBefore = JSON.stringify(mustArray(ctx, "boards-before", await get("/api/boards", { token: tokA })));

  // --- prior-state failed validation: state unchanged after each refusal ---
  {
    const badHash = await post("/api/backup/restore", { snapshot: snap0, hash: "deadbeef" }, { token: tokA });
    ctx.ok("restore-bad-hash-409", badHash.status === 409, "status=" + badHash.status + " " + String(badHash.text).slice(0, 160));
    const tampered = (() => { const o = JSON.parse(snap0); o.version = 99; return JSON.stringify(o); })();
    const tamperedHash = sha256(tampered);
    const badVer = await post("/api/backup/restore", { snapshot: tampered, hash: tamperedHash }, { token: tokA });
    ctx.ok("restore-bad-version-4xx", badVer.status === 400 || badVer.status === 422, "status=" + badVer.status + " " + String(badVer.text).slice(0, 160));
    const badTyped = (() => { const o = JSON.parse(snap0); o.boards = "not-an-array"; return JSON.stringify(o); })();
    const badTypedHash = sha256(badTyped);
    const badType = await post("/api/backup/restore", { snapshot: badTyped, hash: badTypedHash }, { token: tokA });
    ctx.ok("restore-bad-typed-422", badType.status === 422 || badType.status === 400, "status=" + badType.status + " " + String(badType.text).slice(0, 200));
    const boardsAfterFail = JSON.stringify(mustArray(ctx, "boards-after-fail", await get("/api/boards", { token: tokA })));
    ctx.ok("failed-restore-state-unchanged", boardsAfterFail === boardsBefore, "boards identical after 3 refused restores");
  }

  // --- ONE billed pair on the live generation (correlated, ID-set) ---
  {
    const led0 = await ledgerSnapshot(ctx, "live0", tokA, mid);
    const r = await post("/api/meetings/" + mid + "/run", { policy: "balanced", prompt: "backup live run " + run }, { token: tokA, timeout: 90000 });
    ctx.ok("live-run-200", r.status === 200, "status=" + r.status + " " + String(r.text).slice(0, 200));
    const w = await waitFor("live-pair", async () => {
      const after = await ledgerSnapshot(ctx, "live-wait", tokA, mid);
      const s = newPairsComplete(led0.calls, led0.usage, after.calls, after.usage);
      if (!s.ok || s.pairs.length !== 2) return { done: false, note: s.note };
      return { done: true, value: { after, pairs: s.pairs } };
    }, { timeoutMs: 60000 });
    ctx.ok("live-pair-correlated", w.ok, String(w.last || "").slice(0, 160));
    if (!w.ok) throw new Error("live pair never correlated");
    const purposes = w.value.pairs.map((p) => String(camel(p.call, "purpose"))).sort().join(",");
    ctx.ok("live-pair-bid-reply", purposes === "advisor-bid,advisor-reply", "purposes=" + purposes);
    for (const p of w.value.pairs) ctx.ok("live-pair-status-" + camel(p.call, "purpose"), String(camel(p.call, "status")) === "succeeded", "status=" + camel(p.call, "status"));
    writeArt("live-pair.json", { pairs: w.value.pairs.map((p) => ({ id: p.id, purpose: camel(p.call, "purpose") })) });
  }

  // Re-baseline AFTER the live run: S0 must include the live messages so
  // the held-restore discard check and the drop/restore roundtrip compare
  // like-for-like (restoring a pre-live snapshot would rightly discard them).
  {
    const bk2 = await get("/api/backup", { token: tokA });
    ctx.ok("backup-S0-live", bk2.status === 200, "status=" + bk2.status);
    snap0 = camel(bk2.json, "snapshot"); hash0 = camel(bk2.json, "hash");
    ctx.ok("backup-S0-hash", sha256(snap0) === String(hash0).toLowerCase(), "hash=" + String(hash0).slice(0, 32));
    writeArt("backup-S0.json", { hash: hash0, bytes: snap0.length, snapshot: snap0 });
  }
  // --- held restore-epoch: slow run in flight, restore S0 mid-flight ---
  {
    const msgsBefore = JSON.stringify(mustArray(ctx, "held-msgs-before", await get("/api/meetings/" + mid + "/messages?take=100", { token: tokA })));
    const ledH0 = await ledgerSnapshot(ctx, "held0", tokA, mid);
    const t0 = Date.now();
    const runP = post("/api/meetings/" + mid + "/run", { policy: "balanced", prompt: "held restore run QA-SLEEP:9000 " + run }, { token: tokA, timeout: 90000 });
    await new Promise((r) => setTimeout(r, 2000));
    const rs = await post("/api/backup/restore", { snapshot: snap0, hash: hash0 }, { token: tokA });
    ctx.ok("held-restore-200", rs.status === 200, "status=" + rs.status + " " + String(rs.text).slice(0, 200));
    const heldRes = await runP;
    const heldMs = Date.now() - t0;
    ctx.ok("held-was-inflight", heldMs >= 8000, "held-ms=" + heldMs);
    ctx.ok("held-epoch-discards", heldRes.status === 409 && /restor|interrupt/i.test(String(heldRes.text)), "status=" + heldRes.status + " " + String(heldRes.text).slice(0, 300));
    const msgsAfter = JSON.stringify(mustArray(ctx, "held-msgs-after", await get("/api/meetings/" + mid + "/messages?take=100", { token: tokA })));
    ctx.ok("held-publication-discarded", msgsAfter === msgsBefore, "messages identical across restore epoch");
    const ledH1 = await ledgerSnapshot(ctx, "held1", tokA, mid);
    const hs = newPairsComplete(ledH0.calls, ledH0.usage, ledH1.calls, ledH1.usage);
    ctx.ok("held-ledger-complete-only", hs.ok, hs.note);
    if (hs.ok) {
      for (const p of hs.pairs) ctx.ok("held-pair-fields-" + camel(p.call, "purpose"), String(camel(p.call, "meetingId")) === String(mid), "purpose=" + camel(p.call, "purpose") + " status=" + camel(p.call, "status"));
      ctx.ok("held-prior-rows-intact", priorRowsIntact(ledH0.calls, ledH1.calls) && priorRowsIntact(ledH0.usage, ledH1.usage), "rows preserved");
    }
    writeArt("held-restore.json", { heldMs, reason: String(heldRes.text).slice(0, 200), newPairs: hs.ok ? hs.pairs.length : -1 });
  }

  // --- real COMMIT fault (QA-owned PG trigger, no server change) + adoption ---
  {
    const marker = "commit marker " + run;
    const notesPreFault = mustArray(ctx, "notes-pre-fault", await get("/api/meetings/" + mid + "/notes", { token: tokA }));
    const secPreFault = notesPreFault.filter((n) => String(camel(n, "kind") || "").includes("secretary")).length;
    triggerInstall(DB, { table: "Notes", mode: "commit" });
    ctx.ok("trigger-installed", true, "commit-fail trigger on Notes");
    const c0 = await fakeJson("/__counts");
    const sF = await post("/api/meetings/" + mid + "/secretary", { input: marker + " with SECRETARY-NOTE", clientNonce: "cf-" + run }, { token: tokA, timeout: 90000 });
    ctx.ok("commit-fault-uncertain", (sF.status === 502 || sF.status === 503) && /uncertain|storage|fault|retry/i.test(String(sF.text)), "status=" + sF.status + " " + String(sF.text).slice(0, 300));
    triggerDrop(DB, { table: "Notes" });
    ctx.ok("trigger-dropped", true, "fault cleared");
    const sR = await post("/api/meetings/" + mid + "/secretary", { input: marker + " with SECRETARY-NOTE", clientNonce: "cf-" + run }, { token: tokA, timeout: 90000 });
    ctx.ok("commit-retry-adopts", sR.status === 201 || sR.status === 200, "status=" + sR.status + " " + String(sR.text).slice(0, 300));
    const notes = mustArray(ctx, "notes-after-commit", await get("/api/meetings/" + mid + "/notes", { token: tokA }));
    const marked = notes.filter((n) => String(camel(n, "kind") || "").includes("secretary"));
    ctx.ok("commit-single-publication", marked.length === secPreFault + 1, "secretary notes " + secPreFault + "->" + marked.length + " (exactly one adopted note, no duplicate)");
    const c1 = await fakeJson("/__counts");
    ctx.ok("commit-no-retry-storm", (c1.json.chat | 0) - (c0.json.chat | 0) <= 2, "chat " + c0.json.chat + "->" + c1.json.chat);
    writeArt("commit-fault.json", { faultStatus: sF.status, retryStatus: sR.status, marked: marked.length });
  }

  // --- outage: drop ONLY our exclusive DB under the running API ---
  {
    const tablesBefore = tableList("postgres").length;
    docker(["exec", "simceo-integration-qa-pg", "psql", "-U", "simceo", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", "DROP DATABASE \"" + DB + "\" WITH (FORCE);"], 60000);
    ctx.ok("outage-dropped-own-db", true, "dropped " + DB + " (exclusive; other DBs untouched)");
    const others = docker(["exec", "simceo-integration-qa-pg", "psql", "-U", "simceo", "-d", "postgres", "-tAc", "SELECT datname FROM pg_database WHERE datistemplate=false ORDER BY 1;"], 60000).split("\n").map((s) => s.trim()).filter(Boolean);
    ctx.ok("outage-others-untouched", !others.includes(DB) && others.length > 0, "dbs=" + others.slice(0, 8).join(","));
    void tablesBefore;
    await new Promise((r) => setTimeout(r, 3000));
    const h = await get("/health");
    ctx.ok("outage-health-200", h.status === 200, "status=" + h.status);
    let ready503 = false;
    for (let i = 0; i < 12; i++) {
      const rd = await get("/ready");
      if (rd.status === 503) { ready503 = true; break; }
      await new Promise((r) => setTimeout(r, 1000));
    }
    ctx.ok("outage-ready-503", ready503, "ready must fail closed while backend gone");
    const dg = await get("/api/admin/diag", { token: tokA });
    const dgBody = String(dg.text || "");
    ctx.ok("outage-diag-no-secrets", !/password|connectionstring|qa-dummy/i.test(dgBody), "status=" + dg.status + " " + dgBody.slice(0, 300));
    writeArt("outage.json", { ready503, health: h.status, diagStatus: dg.status });
  }

  // --- restart 1 (gen2): recreate, restore S0, verify preservation ---
  await stopApi(1);
  docker(["exec", "simceo-integration-qa-pg", "psql", "-U", "simceo", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", "CREATE DATABASE \"" + DB + "\";"], 60000);
  ctx.ok("recreated-own-db", true, DB + " recreated empty (owned, exclusive)");
  await startApi(2);
  {
    const tables2 = tableList(DB);
    ctx.ok("gen2-schema-migrated", tables2.length > 5, "tables=" + tables2.length);
    // Fresh empty DB is non-secure: restore as owner, then re-register admin.
    const rs = await post("/api/backup/restore", { snapshot: snap0, hash: hash0 }, { token: null, user: "owner", headers: {} });
    ctx.ok("gen2-restore-200", rs.status === 200, "status=" + rs.status + " " + String(rs.text).slice(0, 300));
    const tokA2 = await registerOrLogin(ctx, post, run + "-admin@qa.local", "qa-admin-1-pw12");
    ctx.ok("gen2-admin-re-registered", !!tokA2, "digest=" + digest(tokA2));
    const boards2 = mustArray(ctx, "gen2-boards", await get("/api/boards", { token: tokA2 }));
    ctx.ok("gen2-boards-restored", boards2.some((x) => String(camel(x, "id")) === String(bid)), "count=" + boards2.length);
    const msgs2 = mustArray(ctx, "gen2-messages", await get("/api/meetings/" + mid + "/messages?take=100", { token: tokA2 }));
    ctx.ok("gen2-messages-restored", msgs2.length > 0, "count=" + msgs2.length);
    const grants2 = await get("/api/boards/" + bid + "/grants", { token: tokA2 });
    const invites2 = await get("/api/boards/" + bid + "/invites", { token: tokA2 });
    ctx.ok("gen2-grants-excluded", grants2.status === 200 && Array.isArray(grants2.json) && grants2.json.length === 0, "status=" + grants2.status + " " + String(grants2.text).slice(0, 160));
    ctx.ok("gen2-invites-excluded", invites2.status === 200 && Array.isArray(invites2.json) && invites2.json.length === 0, "status=" + invites2.status + " " + String(invites2.text).slice(0, 160));
    const st2 = await get("/api/auth/status");
    ctx.ok("gen2-security-preserved", st2.status === 200 && camel(st2.json, "authRequired") === true, String(st2.text).slice(0, 160));
    const dg2 = await get("/api/admin/diag", { token: tokA2 });
    ctx.ok("gen2-diag-no-secrets", !/password|connectionstring|qa-dummy/i.test(String(dg2.text || "")), "status=" + dg2.status);
    const bk2 = await get("/api/backup", { token: tokA2 });
    ctx.ok("gen2-backup-200", bk2.status === 200, "status=" + bk2.status);
    const snap2 = camel(bk2.json, "snapshot");
    const se2 = snapsEqual(snap2, snap0);
    ctx.ok("gen2-backup-roundtrip", se2.equal, "canon-equal=" + se2.equal + " effects=" + JSON.stringify(se2.effectsB).slice(0, 300));
    {
      const g0 = (JSON.parse(snap0).meetings || []).map((m) => m.Generation);
      const g2 = (JSON.parse(snap2).meetings || []).map((m) => m.Generation);
      ctx.ok("gen2-generation-bumps-one", g0.length === g2.length && g0.every((v, i) => g2[i] === v + 1), "gen " + JSON.stringify(g0) + "->" + JSON.stringify(g2));
    }
    writeArt("restore-verify.json", { boards: boards2.length, messages: msgs2.length, snapshot: snap2, restoreEffects: se2.effectsB });
    writeArt("restore-verify.json", { boards: boards2.length, messages: msgs2.length, snapshot: snap2 });
  }

  // --- restart 2 (gen3): final stability + ledger alive ---
  await stopApi(2);
  await startApi(3);
  {
    const bk3 = await get("/api/backup", { token: null, user: "owner", headers: {} }).catch(() => null);
    const tokA3 = await registerOrLogin(ctx, post, run + "-admin@qa.local", "qa-admin-1-pw12");
    const bk = await get("/api/backup", { token: tokA3 });
    ctx.ok("gen3-backup-200", bk.status === 200, "status=" + bk.status);
    writeArt("backup-S3.json", { snapshot: camel(bk.json, "snapshot") });
    const se3 = snapsEqual(camel(bk.json, "snapshot"), snap0);
    ctx.ok("gen3-backup-stable", se3.equal, "stable across two restarts; effects=" + JSON.stringify(se3.effectsB).slice(0, 300));
    void bk3;
    // Ledger alive after restore: a fresh run bills the bid+reply pairs.
    const turn = await post("/api/meetings/" + mid + "/messages", { sender: "lead", content: "post-restore turn " + run }, { token: tokA3 });
    ctx.ok("gen3-new-turn", turn.status === 201 || turn.status === 200, "status=" + turn.status);
    const led3a = await ledgerSnapshot(ctx, "gen3a", tokA3, mid);
    const r = await post("/api/meetings/" + mid + "/run", { policy: "balanced", prompt: "post-restore run " + run }, { token: tokA3, timeout: 90000 });
    ctx.ok("gen3-run-200", r.status === 200, "status=" + r.status + " " + String(r.text).slice(0, 200));
    try { writeArt("gen3-run.json", r.json); } catch {}
    const w = await waitFor("gen3-pair", async () => {
      const after = await ledgerSnapshot(ctx, "gen3-wait", tokA3, mid);
      const s = newPairsComplete(led3a.calls, led3a.usage, after.calls, after.usage);
      if (!s.ok || s.pairs.length !== 2) {
        const det = s.ok ? s.pairs.map((p) => String(camel(p.call, "purpose")) + ":" + String(camel(p.call, "status"))).join(",") : s.note;
        try { writeArt("gen3-mismatch.json", { det, calls: after.calls.length, usage: after.usage.length }); } catch {}
        return { done: false, note: s.note + " [" + det + "]" };
      }
      return { done: true, value: s };
    }, { timeoutMs: 60000 });
    ctx.ok("gen3-ledger-alive", w.ok && w.value.pairs.every((p) => String(camel(p.call, "status")) === "succeeded"), String((w.value && w.value.pairs.map((p) => p.id).join(",")) || w.last).slice(0, 160));
    // Idempotency: an immediate second run with no new turn yields
    // already-replied-this-turn (exactly one bid pair, no duplicate reply).
    const led3b = await ledgerSnapshot(ctx, "gen3b", tokA3, mid);
    const r2 = await post("/api/meetings/" + mid + "/run", { policy: "balanced", prompt: "post-restore run " + run }, { token: tokA3, timeout: 90000 });
    ctx.ok("gen3-rerun-200", r2.status === 200, "status=" + r2.status + " " + String(r2.text).slice(0, 200));
    const wy = await waitFor("gen3-yield", async () => {
      const after = await ledgerSnapshot(ctx, "gen3-ywait", tokA3, mid);
      const s = newPairsComplete(led3b.calls, led3b.usage, after.calls, after.usage);
      if (!s.ok || s.pairs.length !== 1) return { done: false, note: s.note };
      return { done: true, value: s };
    }, { timeoutMs: 60000 });
    ctx.ok("gen3-yield-correlated", wy.ok, String(wy.last || "").slice(0, 160));
    if (wy.ok) {
      ctx.ok("gen3-yield-bid-only", wy.value.pairs.length === 1 && String(camel(wy.value.pairs[0].call, "purpose")) === "advisor-bid", "pairs=" + wy.value.pairs.map((p) => camel(p.call, "purpose")).join(","));
      ctx.ok("gen3-yield-reason", /already-replied/i.test(String(r2.text)), String(r2.text).slice(0, 300));
    }
  }
  await stopApi(3);
} catch (e) {
  ctx.ok("leg7-fatal", false, String((e && e.message) || e).slice(0, 400));
} finally {
  if (apiH) {
    const r = await stopOwned(apiH, "api-final", path.join(ART, "api-genX.log"), path.join(ART, "api-genX.err.log"));
    if (!r.ok) ctx.ok("leg7-api-cleanup", false, r.note);
    else ctx.ok("leg7-api-cleaned", true, r.note);
    apiH = null;
  }
  if (fakeH) {
    const r = await stopOwned(fakeH, "fake-final", path.join(ART, "fake.log"), path.join(ART, "fake.err.log"));
    if (!r.ok) ctx.ok("leg7-fake-cleanup", false, r.note);
    else ctx.ok("leg7-fake-cleaned", true, r.note);
    fakeH = null;
  }
  try { triggerDrop(DB, { table: "Notes" }); } catch {}
  try {
    const ports = [5142, 5242];
    for (const p of ports) {
      const c = await fetch("http://127.0.0.1:" + p + "/health").then(() => true).catch(() => false);
      if (c) ctx.ok("leg7-port-" + p + "-free", false, "owned port still open after self-managed cleanup");
    }
    ctx.ok("leg7-ports-free", true, "5142/5242 free");
  } catch (e) { ctx.ok("leg7-port-check", false, String(e).slice(0, 160)); }
}

process.exit(ctx.verdict());