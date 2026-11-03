// Shared honest HTTP helper for essentials legs (Muse-owned).
// - Real endpoints only; every predicate is an explicit true/false check.
// - Array endpoints: assert Array.isArray + exact Length (never nested counts).
// - Auth: Bearer when opts.token is set, else demo x-user header.
// - Tokens are NEVER logged; use digest() (12-char sha256) for correlation.
// - Every request is bounded (default 30s); AbortController enforced.
// - Ledger windows are OrderByDescending(At): NEVER take the last row as "new".
//   Compare ID sets; the billed pair shares ONE nonzero GUID (same Id in both
//   ModelCalls and Usage) plus matching scope/model/purpose/status/cost/basis.
import crypto from "node:crypto";

export const API = process.env.QA_API || "http://127.0.0.1:5142";
export const FAKE = process.env.QA_FAKE || "http://127.0.0.1:5242";
export const TIMEOUT_MS = Number(process.env.QA_HTTP_TIMEOUT_MS || "30000");

export function digest(s) {
  return crypto.createHash("sha256").update(String(s ?? "")).digest("hex").slice(0, 12);
}

export function sha256(s) {
  return crypto.createHash("sha256").update(String(s ?? "")).digest("hex");
}

export function camel(o, k) {
  if (!o || typeof o !== "object") return undefined;
  if (k in o) return o[k];
  const lo = String(k).toLowerCase();
  for (const key of Object.keys(o)) if (String(key).toLowerCase() === lo) return o[key];
  return undefined;
}

export function makeCtx(tag) {
  const ctx = {
    tag, pass: 0, fail: 0,
    failures: [],
    ok(name, cond, extra) {
      if (cond) { ctx.pass++; console.log("  ok " + name); }
      else {
        ctx.fail++;
        const m = name + (extra ? " :: " + String(extra).slice(0, 400) : "");
        ctx.failures.push(m);
        console.log("  FAIL " + m);
      }
    },
    verdict() {
      console.log(ctx.fail === 0
        ? ("ESSENTIALS-" + tag + " PASS pass=" + ctx.pass)
        : ("ESSENTIALS-" + tag + " FAIL pass=" + ctx.pass + " fail=" + ctx.fail));
      for (const f of ctx.failures) console.log(" - " + f);
      return ctx.fail === 0 ? 0 : 1;
    },
  };
  return ctx;
}

export async function req(method, path, body, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeout || TIMEOUT_MS);
  try {
    const headers = {};
    if (opts.token) headers["authorization"] = "Bearer " + opts.token;
    else if (opts.user !== null) headers["x-user"] = opts.user || "owner";
    if (body !== undefined && !opts.raw) headers["content-type"] = "application/json";
    Object.assign(headers, opts.headers || {});
    const r = await fetch(API + path, {
      method, signal: ctl.signal, headers,
      body: body === undefined ? undefined : (opts.raw ? body : JSON.stringify(body)),
    });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text };
  } finally { clearTimeout(t); }
}

export const get = (p, o) => req("GET", p, undefined, o);
export const post = (p, b, o) => req("POST", p, b, o);

// Assert the response body is a REAL array and return it; otherwise record
// the failure and throw (fail-closed: no capped/false-pass comparisons).
export function mustArray(ctx, label, res) {
  const isArr = res.status === 200 && Array.isArray(res.json);
  ctx.ok(label + "-is-array", isArr, "status=" + res.status + " body=" + String(res.text).slice(0, 200));
  if (!isArr) throw new Error(label + " expected array, got status=" + res.status);
  return res.json;
}

// Register (201 new) or login (409 existing) and return a token.
// Never logs the token; logs only its digest.
export async function registerOrLogin(ctx, postFn, email, password) {
  let r = await postFn("/api/auth/register", { email, password });
  if (r.status === 201) {
    const tok = camel(r.json, "token");
    ctx.ok("auth-register-" + email, !!tok, "status=" + r.status);
    if (tok) console.log("  info token-digest=" + digest(tok));
    return tok;
  }
  ctx.ok("auth-register-conflict-" + email, r.status === 409, "status=" + r.status);
  r = await postFn("/api/auth/login", { email, password });
  ctx.ok("auth-login-" + email, r.status === 200 && !!camel(r.json, "token"), "status=" + r.status);
  const tok = camel(r.json, "token");
  if (tok) console.log("  info token-digest=" + digest(tok));
  return tok;
}

// Bounded poll for correlated completion (API + proxy + ledger ALL done).
// The fake /__counts counter increments BEFORE completion and is NOT
// synchronization: always wait for the correlated ledger/state predicate.
export async function waitFor(label, fn, { timeoutMs = 60000, intervalMs = 750 } = {}) {
  const start = Date.now();
  let last = null;
  for (;;) {
    try {
      const out = await fn();
      if (out && out.done) return { ok: true, value: out.value, last };
      last = out && out.note ? out.note : last;
    } catch (e) { last = String((e && e.message) || e).slice(0, 200); }
    if (Date.now() - start > timeoutMs) return { ok: false, last };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// Ledger snapshot: full ordered rows for one meeting scope, serialized for
// exact prior-row comparison. Never picks "last row" as new.
export async function ledgerSnapshot(ctx, label, token, mid) {
  const calls = mustArray(ctx, label + "-calls", await get("/api/models/calls?limit=200&meetingId=" + mid, { token }));
  const usage = mustArray(ctx, label + "-usage", await get("/api/usage?limit=500&meetingId=" + mid, { token }));
  ctx.ok(label + "-complete-window", calls.length < 200 && usage.length < 500, "calls=" + calls.length + " usage=" + usage.length);
  return { calls, usage, callsJson: JSON.stringify(calls), usageJson: JSON.stringify(usage) };
}

export function idSet(rows) {
  const s = new Set();
  for (const r of rows) { const id = String(camel(r, "id") || ""); if (id && id !== "00000000-0000-0000-0000-000000000000") s.add(id); }
  return s;
}

// Exactly one NEW id shared by both after-sets (ModelCalls + Usage share ONE
// nonzero call GUID per billed attempt). Returns the shared id or null.
export function sharedNewId(beforeCalls, beforeUsage, afterCalls, afterUsage) {
  const bC = idSet(beforeCalls), bU = idSet(beforeUsage);
  const nC = afterCalls.filter((r) => !bC.has(String(camel(r, "id"))));
  const nU = afterUsage.filter((r) => !bU.has(String(camel(r, "id"))));
  if (nC.length !== 1 || nU.length !== 1) return { ok: false, note: "newCalls=" + nC.length + " newUsage=" + nU.length };
  const idC = String(camel(nC[0], "id")), idU = String(camel(nU[0], "id"));
  if (!idC || idC !== idU) return { ok: false, note: "shared-id-mismatch " + idC + " vs " + idU };
  return { ok: true, id: idC, call: nC[0], row: nU[0] };
}

// PG timestamptz stores microsecond precision: a 7th fractional second digit
// in a JSON "at" is an in-memory EF identity-map artifact (the tracked entity
// keeps 7-digit ticks until ChangeTracker.Clear detaches it), never stored
// data. ONLY the At-field lexeme is aligned to 6 digits so a fault path
// that clears tracking cannot false-fail; any real stored change still fails.
// This weakens nothing PG can persist; leg4 backs it with exact raw PG bytes for the same prior IDs. All other fields stay byte-exact.
export function normAt(json) {
  return String(json).replace(/("(?:at)"\s*:\s*"[^"]*?\.\d{6})\d+((?:Z|[+-]\d{2}:?\d{2})")/gi, "$1$2");
}
// All prior full rows must be byte-identical below actual caps (no silent rewrite).
export function priorRowsIntact(before, after) {
  if (after.length < before.length) return false;
  const bIds = new Set(before.map((r) => String(camel(r, "id"))));
  const aById = new Map(after.map((r) => [String(camel(r, "id")), JSON.stringify(r)]));
  for (const r of before) {
    const a = aById.get(String(camel(r, "id")));
    if (a === undefined || normAt(a) !== normAt(JSON.stringify(r))) return false;
  }
  void bIds;
  return true;
}

export async function fakeJson(path, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(FAKE + path, { signal: ctl.signal, method: opts.method || "GET", headers: opts.body ? { "content-type": "application/json" } : {}, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text };
  } finally { clearTimeout(t); }
}
// All NEW pairs complete: every new ModelCall id has a matching new Usage
// row with equal scope/model/purpose/status/cost/basis. Never last-row-as-new.
export function newPairsComplete(beforeCalls, beforeUsage, afterCalls, afterUsage) {
  const bC = idSet(beforeCalls), bU = idSet(beforeUsage);
  const nC = afterCalls.filter((r) => !bC.has(String(camel(r, "id"))));
  const nU = afterUsage.filter((r) => !bU.has(String(camel(r, "id"))));
  if (nC.length !== nU.length) return { ok: false, note: "newCalls=" + nC.length + " newUsage=" + nU.length, pairs: [] };
  const uById = new Map(nU.map((r) => [String(camel(r, "id")), r]));
  const pairs = [];
  for (const c of nC) {
    const id = String(camel(c, "id"));
    const u = uById.get(id);
    if (!id || !u) return { ok: false, note: "unpaired call id=" + id.slice(0, 8), pairs: [] };
    if (String(camel(u, "kind")) !== String(camel(c, "purpose"))) return { ok: false, note: "purpose-mismatch " + id.slice(0, 8), pairs: [] };
    if (String(camel(u, "model")) !== String(camel(c, "model"))) return { ok: false, note: "model-mismatch " + id.slice(0, 8), pairs: [] };
    if (String(camel(u, "status")) !== String(camel(c, "status"))) return { ok: false, note: "status-mismatch " + id.slice(0, 8), pairs: [] };
    if (String(camel(u, "meetingId")) !== String(camel(c, "meetingId"))) return { ok: false, note: "scope-mismatch " + id.slice(0, 8), pairs: [] };
    if (String(camel(u, "cost") ?? "") !== String(camel(c, "cost") ?? "") || String(camel(u, "costBasis") ?? "") !== String(camel(c, "costBasis") ?? "")) return { ok: false, note: "cost-mismatch " + id.slice(0, 8), pairs: [] };
    pairs.push({ id, call: c, row: u });
  }
  return { ok: true, note: "pairs=" + pairs.length, pairs };
}