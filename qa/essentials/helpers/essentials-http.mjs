// Shared honest HTTP helper for essentials legs (Muse-owned).
// - Real endpoints only; every predicate is an explicit true/false check.
// - Array endpoints: assert Array.isArray + exact Length (never nested counts).
// - Auth: Bearer when opts.token is set, else demo x-user header.
// - Tokens are NEVER logged; use digest() (12-char sha256) for correlation.
// - Every request is bounded (default 30s); AbortController enforced.
import crypto from "node:crypto";

export const API = process.env.QA_API || "http://127.0.0.1:5142";
export const FAKE = process.env.QA_FAKE || "http://127.0.0.1:5242";
export const TIMEOUT_MS = Number(process.env.QA_HTTP_TIMEOUT_MS || "30000");

export function digest(s) {
  return crypto.createHash("sha256").update(String(s ?? "")).digest("hex").slice(0, 12);
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