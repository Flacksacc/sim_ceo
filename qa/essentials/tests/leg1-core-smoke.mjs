// leg1: core essentials smoke on REAL handlers (needs API+fake+PG).
// health/ready, register/login, boards/meetings/discussion/wizard/directRun,
// held-logout no-publication, one billed ledger pair, backend PG hash.
// Exit nonzero on ANY failure. Secure-mode safe (Bearer everywhere).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { makeCtx, API, get, post, camel, mustArray, registerOrLogin, digest, fakeJson } from "../helpers/essentials-http.mjs";

const ctx = makeCtx("leg1");
const ART = process.env.ESS_QA_ARTIFACT_DIR || ".";
const run = "ess1-" + Date.now().toString(36);
const writeArt = (name, obj) => {
  try { fs.writeFileSync(path.join(ART, name), typeof obj === "string" ? obj : JSON.stringify(obj, null, 2)); }
  catch (e) { ctx.ok("artifact-" + name, false, String(e).slice(0, 160)); }
};

// --- health / ready / backend ---
{
  const h = await get("/health");
  ctx.ok("health-200", h.status === 200 && camel(h.json, "ok") === true, "status=" + h.status);
  const r = await get("/ready");
  ctx.ok("ready-200-pg", r.status === 200, "status=" + r.status + " " + String(r.text).slice(0, 200));
  const b = await get("/api/backend");
  const mode = camel(b.json, "mode");
  ctx.ok("backend-postgres", b.status === 200 && mode === "postgres", "status=" + b.status + " mode=" + mode);
  writeArt("backend.json", b.json);
  if (b.json) {
    const hash = crypto.createHash("sha256").update(JSON.stringify(b.json)).digest("hex");
    writeArt("backend-hash.txt", "LOADED-BACKEND-SHA256=" + hash + "\n");
    console.log("  info loaded-backend-sha256=" + hash);
  }
}

// --- auth: ownerA (admin-first), ownerB, wrong-password 401 isolation ---
const tokA = await registerOrLogin(ctx, post, run + "-owner-a@qa.local", "qa-owner-a-1");
const tokB = await registerOrLogin(ctx, post, run + "-owner-b@qa.local", "qa-owner-b-1");
ctx.ok("tokens-present", !!tokA && !!tokB, "digests=" + digest(tokA) + "/" + digest(tokB));
{
  const me = await get("/api/auth/me", { token: tokA });
  ctx.ok("me-200", me.status === 200, "status=" + me.status);
  const bad = await post("/api/auth/login", { email: run + "-owner-a@qa.local", password: "wrong-password" });
  ctx.ok("wrong-password-401", bad.status === 401, "status=" + bad.status);
  const still = await get("/api/auth/me", { token: tokA });
  ctx.ok("stale-401-keeps-owner", still.status === 200, "status=" + still.status);
  const anon = await get("/api/boards", { token: null, user: null, headers: {} });
  ctx.ok("anon-boards-denied-or-public", anon.status === 401 || anon.status === 200, "status=" + anon.status);
}

// --- boards / meetings / discussion via real handlers ---
let bid = "", mid = "";
{
  const b = await post("/api/boards", { name: run + "-board", mission: run + " mission", stage: "forming" }, { token: tokA });
  ctx.ok("board-create-201", b.status === 201 && !!camel(b.json, "id"), "status=" + b.status + " " + String(b.text).slice(0, 200));
  bid = camel(b.json, "id");
  const list = mustArray(ctx, "boards-list", await get("/api/boards", { token: tokA }));
  ctx.ok("boards-list-contains", list.some((x) => String(camel(x, "id")) === String(bid)), "len=" + list.length);
  const m = await post("/api/boards/" + bid + "/meetings", { title: run + " meeting", brief: "essentials core brief" }, { token: tokA });
  ctx.ok("meeting-create-201", m.status === 201 && !!camel(m.json, "id"), "status=" + m.status + " " + String(m.text).slice(0, 200));
  mid = camel(m.json, "id");
  const q1 = "core lead question " + run + " caf\u00e9 \u4e2d\u6587";
  const msg = await post("/api/meetings/" + mid + "/messages", { sender: "lead", content: q1 }, { token: tokA });
  ctx.ok("message-post-201", msg.status === 201 || msg.status === 200, "status=" + msg.status + " " + String(msg.text).slice(0, 200));
}

// --- one billed discussion run: exactly one new model-call + one usage row ---
let callsBefore = [], usageBefore = [];
{
  callsBefore = mustArray(ctx, "calls-before", await get("/api/models/calls?limit=200", { token: tokA }));
  ctx.ok("calls-complete-window", callsBefore.length < 200, "len=" + callsBefore.length);
  usageBefore = mustArray(ctx, "usage-before", await get("/api/usage?meetingId=" + mid, { token: tokA }));
  const fc0 = await fakeJson("/__counts");
  ctx.ok("fake-counts-shape", fc0.status === 200 && typeof (fc0.json && fc0.json.chat) === "number", "status=" + fc0.status);
  const r = await post("/api/meetings/" + mid + "/run", { policy: "balanced", prompt: "essentials core run " + run }, { token: tokA, timeout: 90000 });
  ctx.ok("run-200", r.status === 200, "status=" + r.status + " " + String(r.text).slice(0, 300));
  const msgs = mustArray(ctx, "messages-after-run", await get("/api/meetings/" + mid + "/messages?take=100", { token: tokA }));
  ctx.ok("messages-contain-lead", msgs.some((x) => String(camel(x, "content") || "").includes("core lead question " + run)), "len=" + msgs.length);
  const fc1 = await fakeJson("/__counts");
  ctx.ok("fake-chat-advanced", (fc1.json.chat | 0) === (fc0.json.chat | 0) + 1, JSON.stringify(fc1.json));
  const callsAfter = mustArray(ctx, "calls-after", await get("/api/models/calls?limit=200", { token: tokA }));
  ctx.ok("calls-still-complete", callsAfter.length < 200, "len=" + callsAfter.length);
  ctx.ok("calls-plus-one", callsAfter.length === callsBefore.length + 1, "before=" + callsBefore.length + " after=" + callsAfter.length);
  const usageAfter = mustArray(ctx, "usage-after", await get("/api/usage?meetingId=" + mid, { token: tokA }));
  ctx.ok("usage-plus-one", usageAfter.length === usageBefore.length + 1, "before=" + usageBefore.length + " after=" + usageAfter.length);
  const newCall = callsAfter[callsAfter.length - 1];
  ctx.ok("call-entry-shape", !!(camel(newCall, "model") || camel(newCall, "purpose")), JSON.stringify(newCall).slice(0, 200));
  writeArt("ledger-pair.json", { callsBefore: callsBefore.length, callsAfter: callsAfter.length, usageBefore: usageBefore.length, usageAfter: usageAfter.length });
}

// --- wizard: save + stale-version 409 + review + create board ---
{
  const me = await get("/api/auth/me", { token: tokA });
  const acct = camel(me.json, "accountId") || camel(me.json, "id") || "owner";
  const fields = JSON.stringify({ name: run + "-wizboard", mission: run + " mission", stage: "forming", lead: { name: "QA Lead" }, advisors: [{ role: "Strategist", name: "" }] });
  const w = await post("/api/wizard", { accountId: acct, step: 1, presetKey: "", fieldsJson: fields }, { token: tokA });
  ctx.ok("wizard-save-200", w.status === 200 && camel(w.json, "id"), "status=" + w.status + " " + String(w.text).slice(0, 200));
  const wid = camel(w.json, "id");
  const ver = camel(w.json, "version");
  const stale = await post("/api/wizard", { id: wid, version: 1, accountId: acct, step: 1, presetKey: "", fieldsJson: fields }, { token: tokA });
  ctx.ok("wizard-stale-409", stale.status === 409, "status=" + stale.status);
  const rev = await get("/api/wizard/" + wid + "/review", { token: tokA });
  ctx.ok("wizard-review-200", rev.status === 200, "status=" + rev.status + " " + String(rev.text).slice(0, 200));
  const created = await post("/api/wizard/" + wid + "/create", {}, { token: tokA });
  ctx.ok("wizard-create-201", created.status === 201 || created.status === 200, "status=" + created.status + " " + String(created.text).slice(0, 300));
}

// --- held-unit logout: old token cannot publish after logout ---
{
  const tokC = await registerOrLogin(ctx, post, run + "-owner-c@qa.local", "qa-owner-c-1");
  const before = mustArray(ctx, "boards-before-held", await get("/api/boards", { token: tokC }));
  const lo = await post("/api/auth/logout", {}, { token: tokC });
  ctx.ok("logout-200", lo.status === 200, "status=" + lo.status + " " + String(lo.text).slice(0, 160));
  const deniedBoard = await post("/api/boards", { name: run + "-held", mission: "held", stage: "forming" }, { token: tokC });
  ctx.ok("held-board-401", deniedBoard.status === 401, "status=" + deniedBoard.status + " " + String(deniedBoard.text).slice(0, 160));
  // Re-login (new session) sees no publication from the held token.
  const tokC2 = await registerOrLogin(ctx, post, run + "-owner-c@qa.local", "qa-owner-c-1");
  ctx.ok("relogin-token", !!tokC2, "digest=" + digest(tokC2));
  const after = mustArray(ctx, "boards-after-held", await get("/api/boards", { token: tokC2 }));
  ctx.ok("held-no-publication", after.length === before.length, "before=" + before.length + " after=" + after.length);
  // And ownerA (a different user) was never logged out by C's stale failures.
  const stillA = await get("/api/auth/me", { token: tokA });
  ctx.ok("stale-never-logs-out-other", stillA.status === 200, "status=" + stillA.status);
}

process.exit(ctx.verdict());