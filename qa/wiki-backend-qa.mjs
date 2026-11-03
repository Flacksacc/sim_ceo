
// Phase7 Wiki.js connector backend QA (memory API :5111 + fixture :5201).
// Deterministic, isolated ports only. Exit nonzero on any failure.
// Covers all 17 independent findings with positive controls; no false passes.
import fs from "node:fs";
import crypto from "node:crypto";
import { validateWikiQuery, oldBrokenQueryFails, EXPECTED_LIST, EXPECTED_SINGLE, normQuery } from "./wiki-sdl-validator.mjs";
const API = process.env.QA_API || "http://127.0.0.1:5111";
const WIKI = process.env.QA_WIKI || "http://127.0.0.1:5201";
const WIKIBASE = WIKI + "/";
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; } else { fail++; failures.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL " + name + (extra ? " :: " + extra : "")); }
}
async function req(method, path, body, headers = {}, timeout = 30000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(API + path, {
      method, signal: ctl.signal,
      headers: { "content-type": "application/json", "x-user": "owner", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: r.status, json, text };
  } finally { clearTimeout(t); }
}
const get = (p, h) => req("GET", p, undefined, h);
const post = (p, b, h) => req("POST", p, b, h);
const patch = (p, b, h) => req("PATCH", p, b, h);
const del = (p, h) => req("DELETE", p, undefined, h);
const low = (o) => { const m = {}; if (o && typeof o === "object") for (const k of Object.keys(o)) m[k.toLowerCase()] = o[k]; return m; };
const val = (o, k) => low(o)[k.toLowerCase()];
async function wikictl(qs) {
  const r = await fetch(WIKI + "/__control" + qs);
  return r.json();
}
async function readLogLines() {
  try {
    const raw = fs.readFileSync(".tmp/wiki-qa-requests.jsonl", "utf-8");
    return raw.split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let r = await get("/health");
ok("t01-fixture-health", (await (await fetch(WIKI + "/health")).json()).ok === true);
ok("t02-api-health", r.status === 200);
r = await get("/ready");
ok("t02-api-ready-memory", r.status === 200, JSON.stringify(r.json));
await wikictl("?mode=normal&singleDelayMs=0&listDelayMs=0");
r = await post("/api/boards", { name: "wiki-qa-board" });
ok("t03-board", r.status === 200 || r.status === 201, r.status + " " + r.text.slice(0, 200));
const BID = val(r.json, "id");
r = await post("/api/boards/" + BID + "/meetings", { title: "wiki-m1" });
const M1 = val(r.json, "id");
r = await post("/api/boards/" + BID + "/meetings", { title: "wiki-m2" });
const M2 = val(r.json, "id");
ok("t03-meetings", !!M1 && !!M2, JSON.stringify([M1, M2]));
const TOKEN = "qa-wiki-token-plain";
let logBefore = (await readLogLines()).length;
r = await post("/api/boards/" + BID + "/wiki-resources", {
  baseUrl: WIKIBASE, description: "qa handbook", allowedUse: "board lookup only", scope: "board",
  allowlist: ["/guides/**"], exclusions: [], requiredTags: [], locale: "", syncIntervalMinutes: 60,
});
ok("t04-create-200", r.status === 200 || r.status === 201, r.status + " " + r.text.slice(0, 300));
const RID = val(r.json, "id");
ok("t04-row-id", !!RID, "missing resource id");
const created = low(r.json);
ok("t04-disabled-default", created.enabled === false && (created.status === "disabled" || created.status === "pending"), JSON.stringify({ enabled: created.enabled, status: created.status }));
ok("t04-no-cred-default", created.hascredential === false || created.hasCredential === false, r.text.slice(0, 300));
ok("t04-no-token-echo", !r.text.includes(TOKEN) && !r.text.toLowerCase().includes("protectedtoken"), "token echoed in create response");
ok("t04-alloweduse-persisted", (created.alloweduse ?? created.allowedUse ?? "") === "board lookup only", r.text.slice(0, 300));
let logAfter = (await readLogLines()).length;
ok("t05-disabled-zero-fetch", logAfter === logBefore, "graphql posts=" + (logAfter - logBefore));
for (const [nm, url] of [["userinfo", "https://user:pass@example.com/"], ["query", "https://example.com/?x=1"], ["fragment", "https://example.com/#a"], ["envvar", "https://example.com/$(SECRET)"], ["scheme", "ftp://example.com/"]]) {
  const rr = await post("/api/boards/" + BID + "/wiki-resources", { baseUrl: url, scope: "board", allowlist: ["/a"] });
  ok("t06-url-" + nm, rr.status === 400, rr.status + " " + rr.text.slice(0, 160));
}
// Oversized rule collections must REJECT, never truncate.
const big201 = Array.from({ length: 201 }, (_, i) => "/guides/p" + i);
let rr = await patch("/api/wiki-resources/" + RID, { exclusions: big201 });
ok("t06-oversize-reject", rr.status === 400 && /200/.test(rr.text), rr.status + " " + rr.text.slice(0, 200));
rr = await patch("/api/wiki-resources/" + RID, { allowlist: ["/guides/%2e%2e/private"] });
ok("t06-encoded-dot-reject", rr.status === 400, rr.status + " " + rr.text.slice(0, 200));
rr = await patch("/api/wiki-resources/" + RID, { allowlist: ["/**"] });
ok("t06-root-prefix-works", rr.status === 200, rr.status + " " + rr.text.slice(0, 200));
rr = await patch("/api/wiki-resources/" + RID, { allowlist: ["/guides/**"] });
ok("t06-restore-allow", rr.status === 200, rr.status);
// Numeric type preservation: string interval must be rejected, number accepted.
rr = await patch("/api/wiki-resources/" + RID, { syncIntervalMinutes: "60" });
ok("t06-interval-string-reject", rr.status === 400, rr.status + " " + rr.text.slice(0, 160));
rr = await patch("/api/wiki-resources/" + RID, { syncIntervalMinutes: 60 });
ok("t06-interval-number-ok", rr.status === 200 && (val(rr.json, "syncIntervalMinutes") === 60), rr.status + " " + rr.text.slice(0, 200));
// Explicit scope semantics: board move via meetingId null.
rr = await post("/api/boards/" + BID + "/wiki-resources", {
  baseUrl: WIKIBASE, description: "scope move probe", allowedUse: "probe", scope: "meeting", meetingId: M1,
  allowlist: ["/guides/**"], token: TOKEN,
});
const MOVE_RID = val(rr.json, "id");
rr = await patch("/api/wiki-resources/" + MOVE_RID, { scope: "board", meetingId: null });
ok("t06-scope-board-move", rr.status === 200 && val(rr.json, "scope") === "board" && val(rr.json, "meetingId") == null, rr.status + " " + rr.text.slice(0, 300));
await del("/api/wiki-resources/" + MOVE_RID);
// Malformed token rejected.
rr = await patch("/api/wiki-resources/" + RID, { token: "x" });
ok("t06-malformed-token", rr.status === 400, rr.status + " " + rr.text.slice(0, 160));
// Enable gates: credential, description, allowedUse, allowlist all required.
r = await post("/api/wiki-resources/" + RID + "/enable", {});
ok("t08-enable-no-cred", r.status === 409, r.status + " " + r.text.slice(0, 200));
r = await patch("/api/wiki-resources/" + RID, { token: TOKEN });
ok("t09-cred-set", r.status === 200 && (low(r.json).hascredential === true || low(r.json).hasCredential === true), r.status + " " + r.text.slice(0, 300));
ok("t09-cred-no-echo", !r.text.includes(TOKEN) && !r.text.toLowerCase().includes("protectedtoken"), "token echoed");
r = await post("/api/wiki-resources/" + RID + "/enable", {});
ok("t10-enable", r.status === 200 && (low(r.json).enabled === true || low(r.json).Enabled === true), r.status + " " + r.text.slice(0, 300));
logBefore = (await readLogLines()).length;
r = await post("/api/wiki-resources/" + RID + "/sync", {});
ok("t11-sync-ok", r.status === 200, r.status + " " + r.text.slice(0, 400));
const synced = low(r.json);
const syncedId = val(r.json, "id");
ok("t11-actual-row", syncedId === RID, "sync returned wrong row " + syncedId + " vs " + RID);
ok("t11-sync-state", (synced.status === "succeeded") && ((synced.importedPages ?? synced.importedpages ?? synced.sourceDocs ?? 0) === 2), JSON.stringify({ status: synced.status, imported: synced.importedPages ?? synced.sourceDocs }));
ok("t11-usable-is-eligible", (synced.usablePages === 0 || synced.usablepages === 0) && (synced.eligibleDocs === 0 || synced.eligibledocs === 0), "pending docs are not usable yet: " + JSON.stringify(synced).slice(0, 300));
logAfter = (await readLogLines()).length;
const fresh = (await readLogLines()).slice(logBefore);
const ops = fresh.map((e) => e.op);
ok("t12-fixed-queries", ops.includes("pages.list") && ops.filter((o) => o === "pages.single").length === 2, JSON.stringify(ops));
ok("t12-no-mutations", !fresh.some((e) => e.isMutation) && !fresh.some((e) => /mutation/i.test(e.query || "")), "mutation emitted");
for (const e of fresh) {
  const v = validateWikiQuery(e.query || "", e.variables || {});
  ok("t12-sdl-" + e.op, v.ok, (e.op || "") + " :: " + v.problems.join("; ") + " :: " + (e.query || "").slice(0, 200));
  const expected = e.op === "pages.list" ? EXPECTED_LIST : e.op === "pages.single" ? EXPECTED_SINGLE : null;
  ok("t12-exact-" + e.op, expected !== null && normQuery(e.query) === normQuery(expected), "emitted text differs from SDL-validated shape: " + normQuery(e.query || "").slice(0, 160));
}
ok("t12-old-query-fails", oldBrokenQueryFails(), "String-enum orderBy must fail SDL validation");
// Negative controls: each must FAIL real SDL validation (types, fields,
// selections, mutations, quoted enums, String variables, coercion, names).
const negControls = [
  ["t12n-string-id", "query WikiSingle($id: String!) { pages { single(id: $id) { id path locale title content contentType updatedAt tags { tag } } } }", { id: 11 }],
  ["t12n-imaginary", "query WikiSingle($id: Int!) { pages { single(id: $id) { id path locale title content contentType updatedAt tags { imaginaryField } } } }", { id: 11 }],
  ["t12n-tags-noselect", "query WikiSingle($id: Int!) { pages { single(id: $id) { id path locale title content contentType updatedAt tags } } } # tag", { id: 11 }],
  ["t12n-float-id", EXPECTED_SINGLE, { id: 11.5 }],
  ["t12n-mutation", "mutation M { pages { list(limit: 1) { id } } }", {}],
  ["t12n-quoted-enum", EXPECTED_LIST.replace("orderBy: PATH", "orderBy: \"PATH\""), { limit: 1 }],
  ["t12n-missing-sel", EXPECTED_LIST.replace(" title tags", " title"), { limit: 1 }],
  ["t12n-unexpected-op", "query FooBar { pages { list(limit: 1) { id path locale title tags } } }", {}],
  ["t12n-string-orderby", EXPECTED_LIST.replace("($limit: Int $tags:", "($limit: Int $orderBy: String $tags:").replace("orderBy: PATH", "orderBy: $orderBy"), { limit: 1 }],
];
for (const [nm, q, vars] of negControls) {
  const nv = validateWikiQuery(q, vars);
  ok(nm, !nv.ok, nm + " unexpectedly passed: " + q.slice(0, 120));
}
// String tags are rejected by the server as malformed (strict object shape).
await wikictl("?mode=string-tags");
r = await post("/api/wiki-resources/" + RID + "/sync", {});
ok("t12-string-tags-rejected", r.status === 502, r.status + " " + r.text.slice(0, 200));
await wikictl("?mode=normal");
r = await post("/api/wiki-resources/" + RID + "/sync", {});
ok("t12-recover", r.status === 200, r.status);
ok("t13-bearer-redaction", !JSON.stringify(fresh).includes(TOKEN) && fresh.every((e) => (e.authPrefix || "") === "Bearer " || (e.authPrefix || "") === ""), JSON.stringify(fresh.map((e) => e.authPrefix)));
console.log("PART1 done pass=" + pass + " fail=" + fail);
r = await get("/api/boards/" + BID + "/sources/review");
ok("t14-review-200", r.status === 200, r.status + " " + r.text.slice(0, 200));
const groups = Array.isArray(r.json) ? r.json : [];
const wikiGroups = groups.filter((g) => { const o = low(g); return (o.origin === "wiki"); });
const flat = wikiGroups.flatMap((g) => (g.versions || g.Versions || []));
ok("t14-two-pending", flat.length === 2 && flat.every((d) => { const o = low(d); return (o.reviewstate === "pending" || o.reviewState === "pending"); }), JSON.stringify(flat.map((d) => ({ v: val(d, "version"), rs: val(d, "reviewState") }))));
ok("t14-origin-resource", flat.every((d) => val(d, "origin") === "wiki" && !!val(d, "resourceId")), "origin/resourceId missing");
const fams = flat.map((d) => val(d, "familyKey"));
ok("t14-family-distinct", new Set(fams).size === 2 && fams.every((f) => f.includes("|wiki|")), JSON.stringify(fams));
ok("t14-index-completed", flat.every((d) => (val(d, "indexState") || "").toLowerCase() === "completed"), "index not completed");
const alpha = flat.find((d) => String(val(d, "fileName")).includes("alpha"));
const beta = flat.find((d) => String(val(d, "fileName")).includes("beta"));
ok("t14-found-pages", !!alpha && !!beta, "alpha/beta missing");
r = await get("/api/sources/" + val(alpha, "id") + "/index");
ok("t14-eligible-false-pending", r.status === 200 && (val(r.json, "eligible") === false), JSON.stringify(r.json));
r = await post("/api/sources/" + val(alpha, "id") + "/approve", {});
ok("t15-approve-alpha", r.status === 200, r.status + " " + r.text.slice(0, 200));
r = await get("/api/sources/" + val(alpha, "id") + "/index");
ok("t15-alpha-eligible", val(r.json, "eligible") === true, JSON.stringify(r.json));
r = await get("/api/sources/" + val(beta, "id") + "/index");
ok("t15-beta-not-eligible", val(r.json, "eligible") === false, JSON.stringify(r.json));
const secsBefore = (await get("/api/sources/" + val(alpha, "id") + "/sections")).json;
const secCountBefore = (val(secsBefore, "sections") || []).length;
r = await post("/api/wiki-resources/" + RID + "/sync", {});
ok("t16-resync-ok", r.status === 200, r.status + " " + r.text.slice(0, 300));
r = await get("/api/boards/" + BID + "/sources/review");
const flat2 = (Array.isArray(r.json) ? r.json : []).filter((g) => low(g).origin === "wiki").flatMap((g) => (g.versions || []));
ok("t16-no-dupe-versions", flat2.length === 2, "versions=" + flat2.length);
const secsAfter = (await get("/api/sources/" + val(alpha, "id") + "/sections")).json;
ok("t16-no-dupe-sections", (val(secsAfter, "sections") || []).length === secCountBefore, "sections changed");
r = await patch("/api/wiki-resources/" + RID, { requiredTags: ["handbook", "public"] });
const revAfterRule = val(low(r.json), "configrevision") ?? val(r.json, "configRevision");
ok("t17-rev-bump", r.status === 200 && revAfterRule > 1, r.status + " " + r.text.slice(0, 200));
r = await get("/api/sources/" + val(alpha, "id") + "/index");
ok("t17-blocked-until-resync", val(r.json, "eligible") === false, "cached evidence still usable after rule change: " + JSON.stringify(r.json));
r = await post("/api/wiki-resources/" + RID + "/sync", {});
ok("t17-resync-filtered", r.status === 200 && ((low(r.json).usablepages ?? low(r.json).usablePages) === 1), r.status + " " + r.text.slice(0, 300));
r = await get("/api/sources/" + val(alpha, "id") + "/index");
ok("t17-alpha-still-eligible", val(r.json, "eligible") === true, JSON.stringify(r.json));
r = await get("/api/sources/" + val(beta, "id") + "/index");
ok("t17-beta-excluded", val(r.json, "eligible") === false, JSON.stringify(r.json));
r = await patch("/api/wiki-resources/" + RID, { requiredTags: [] });
ok("t17b-reset-tags", r.status === 200, r.status);
r = await post("/api/wiki-resources/" + RID + "/sync", {});
ok("t17b-both-usable", ((low(r.json).importedpages ?? low(r.json).importedPages ?? low(r.json).sourceDocs ?? 0) === 2) && ((low(r.json).usablepages ?? low(r.json).usablePages) === 1), "alpha approved, beta pending: " + r.text.slice(0, 300));
r = await patch("/api/wiki-resources/" + RID, { requiredTags: ["handbook"], locale: "en" });
ok("t18-rules-set", r.status === 200, r.status);
r = await post("/api/wiki-resources/" + RID + "/sync", {});
ok("t18-baseline-2", ((low(r.json).importedpages ?? low(r.json).importedPages ?? 0) === 2) && ((low(r.json).usablepages ?? low(r.json).usablePages) === 1), "alpha approved only: " + r.text.slice(0, 300));
await wikictl("?mode=changed");
r = await post("/api/wiki-resources/" + RID + "/sync", {});
ok("t18-changed-sync", r.status === 200, r.status + " " + r.text.slice(0, 300));
const usable18 = low(r.json).usablepages ?? low(r.json).usablePages;
ok("t18-changed-excluded", usable18 === 0, "usable=" + usable18 + " (beta pending, alpha excluded) " + r.text.slice(0, 300));
r = await get("/api/sources/" + val(alpha, "id") + "/index");
ok("t18-alpha-blocked", val(r.json, "eligible") === false, "stale alpha still usable: " + JSON.stringify(r.json));
await wikictl("?mode=normal");
r = await post("/api/wiki-resources/" + RID + "/sync", {});
ok("t18-restore", r.status === 200, r.status);
r = await patch("/api/wiki-resources/" + RID, { requiredTags: [], locale: "" });
ok("t18-rules-clear", r.status === 200, r.status);
r = await post("/api/wiki-resources/" + RID + "/sync", {});
ok("t18-post-clear-sync", r.status === 200, r.status);
// Positive control: approve BETA before deleted-page test so blocking is proven.
r = await post("/api/sources/" + val(beta, "id") + "/approve", {});
ok("t19-beta-approve-control", r.status === 200, r.status + " " + r.text.slice(0, 200));
r = await get("/api/sources/" + val(beta, "id") + "/index");
ok("t19-beta-eligible-control", val(r.json, "eligible") === true, JSON.stringify(r.json));
await wikictl("?mode=deleted");
r = await post("/api/wiki-resources/" + RID + "/sync", {});
ok("t19-deleted-sync", r.status === 200 && ((low(r.json).usablepages ?? low(r.json).usablePages) === 1), r.status + " " + r.text.slice(0, 300));
r = await get("/api/sources/" + val(beta, "id") + "/index");
ok("t19-beta-blocked", val(r.json, "eligible") === false, "removed page still usable: " + JSON.stringify(r.json));
await wikictl("?mode=normal");
r = await post("/api/wiki-resources/" + RID + "/sync", {});
ok("t19-restore-both", (low(r.json).usablepages ?? low(r.json).usablePages) === 2, r.text.slice(0, 200));
// Changed content with new hash: new version pending, old head still current until approval.
await wikictl("?mode=newhash");
r = await post("/api/wiki-resources/" + RID + "/sync", {});
ok("t19b-newhash-sync", r.status === 200, r.status + " " + r.text.slice(0, 300));
r = await get("/api/boards/" + BID + "/sources/review");
const alphaVers = (Array.isArray(r.json) ? r.json : []).filter((g) => low(g).origin === "wiki").flatMap((g) => (g.versions || [])).filter((d) => String(val(d, "fileName")).includes("alpha"));
ok("t19b-new-pending", alphaVers.length === 2 && alphaVers.some((d) => (val(d, "reviewState") || "").toLowerCase() === "pending"), JSON.stringify(alphaVers.map((d) => val(d, "version") + ":" + val(d, "reviewState"))));
r = await get("/api/sources/" + val(alpha, "id") + "/index");
ok("t19b-old-head-current", val(r.json, "eligible") === true, "old approved head must stay current until new approval: " + JSON.stringify(r.json));
await wikictl("?mode=normal");
r = await post("/api/wiki-resources/" + RID + "/sync", {});
ok("t19b-restore-hash", r.status === 200, r.status);
r = await patch("/api/wiki-resources/" + RID, { allowlist: [] });
ok("t20-blank-disables", r.status === 200 && val(r.json, "enabled") === false && (val(r.json, "status") || "") === "disabled", "blanking required config must disable: " + r.status + " " + r.text.slice(0, 300));
r = await post("/api/wiki-resources/" + RID + "/sync", {});
ok("t20-blank-sync-blocked", r.status === 409, "disabled sync must be rejected: " + r.status);
r = await get("/api/sources/" + val(alpha, "id") + "/index");
ok("t20-blank-blocks", val(r.json, "eligible") === false, JSON.stringify(r.json));
r = await patch("/api/wiki-resources/" + RID, { allowlist: ["/guides/**"] });
ok("t20-blank-restore", r.status === 200, r.status);
r = await post("/api/wiki-resources/" + RID + "/enable", {});
ok("t20-reenable", r.status === 200, r.status);
r = await post("/api/wiki-resources/" + RID + "/sync", {});
ok("t20-resync-after", r.status === 200, r.status);
r = await patch("/api/wiki-resources/" + RID, { allowlist: ["/guides/**"], exclusions: ["/guides/beta"] });
ok("t21-excl-save", r.status === 200, r.status);
r = await post("/api/wiki-resources/" + RID + "/sync", {});
ok("t21-excl-sync", (low(r.json).usablepages ?? low(r.json).usablePages) === 1, r.text.slice(0, 200));
r = await get("/api/sources/" + val(beta, "id") + "/index");
ok("t21-beta-excluded-wins", val(r.json, "eligible") === false, JSON.stringify(r.json));
r = await patch("/api/wiki-resources/" + RID, { exclusions: [] });
ok("t21-excl-clear", r.status === 200, r.status);
console.log("PART2 done pass=" + pass + " fail=" + fail);
for (const bad of ["..", "/a/../b", "/x\\y", "/e%2Ff", "/a//b", "/./c", "/guides/%2e%2e/private"]) {
  const rrx = await patch("/api/wiki-resources/" + RID, { allowlist: [bad] });
  ok("t22-path-" + bad.replace(/[^a-z0-9]+/gi, "_"), rrx.status === 400, rrx.status + " " + rrx.text.slice(0, 160));
}
r = await patch("/api/wiki-resources/" + RID, { locale: "en" });
ok("t23-locale-save", r.status === 200, r.status);
r = await post("/api/wiki-resources/" + RID + "/sync", {});
ok("t23-locale-en", (low(r.json).usablepages ?? low(r.json).usablePages) === 2, r.text.slice(0, 200));
r = await patch("/api/wiki-resources/" + RID, { locale: "fr" });
r = await post("/api/wiki-resources/" + RID + "/sync", {});
ok("t23-locale-fr-blocks", (low(r.json).usablepages ?? low(r.json).usablePages) === 0, r.text.slice(0, 200));
r = await patch("/api/wiki-resources/" + RID, { locale: "" });
ok("t23-locale-clear", r.status === 200, r.status);
r = await patch("/api/wiki-resources/" + RID, { requiredTags: ["handbook"] });
r = await post("/api/wiki-resources/" + RID + "/sync", {});
ok("t24-one-tag", (low(r.json).usablepages ?? low(r.json).usablePages) === 2, r.text.slice(0, 200));
r = await patch("/api/wiki-resources/" + RID, { requiredTags: ["handbook", "public"] });
r = await post("/api/wiki-resources/" + RID + "/sync", {});
ok("t24-all-tags", (low(r.json).usablepages ?? low(r.json).usablePages) === 1, r.text.slice(0, 200));
r = await patch("/api/wiki-resources/" + RID, { requiredTags: [] });
r = await post("/api/wiki-resources/" + RID + "/sync", {});
ok("t24-tags-clear", (low(r.json).usablepages ?? low(r.json).usablePages) === 2, r.text.slice(0, 200));
r = await post("/api/boards/" + BID + "/wiki-resources", {
  baseUrl: WIKIBASE, description: "meeting wiki", allowedUse: "m1 only", scope: "meeting", meetingId: M1,
  allowlist: ["/guides/**"], syncIntervalMinutes: 60, token: TOKEN,
});
ok("t25-meet-create", r.status === 200 || r.status === 201, r.status + " " + r.text.slice(0, 200));
const MRID = val(r.json, "id");
r = await post("/api/wiki-resources/" + MRID + "/enable", {});
ok("t25-meet-enable", r.status === 200, r.status + " " + r.text.slice(0, 200));
r = await post("/api/wiki-resources/" + MRID + "/sync", {});
ok("t25-meet-sync", r.status === 200 && ((low(r.json).importedpages ?? low(r.json).importedPages ?? low(r.json).sourceDocs ?? 0) === 2), "meeting sync imports 2 pending: " + r.status + " " + r.text.slice(0, 300));
const g1 = await post("/api/boards/" + BID + "/grants", { userKey: "guest1", access: "manage", meetingId: M1 });
ok("t25-grant", g1.status === 200 || g1.status === 201, g1.status + " " + g1.text.slice(0, 160));
const asGuest = { "x-user": "guest1" };
r = await post("/api/wiki-resources/" + RID + "/sync", {}, asGuest);
ok("t25-meet-grant-no-board", r.status === 403, "meeting grant reached board resource: " + r.status);
r = await post("/api/wiki-resources/" + MRID + "/sync", {}, asGuest);
ok("t25-meet-grant-own", r.status === 200, "meeting manager blocked on own resource: " + r.status + " " + r.text.slice(0, 200));
// Per-row read filtering: guest1 (M1) must not see M2 resource.
const rM2 = await post("/api/boards/" + BID + "/wiki-resources", {
  baseUrl: WIKIBASE, description: "m2 wiki", allowedUse: "m2 only", scope: "meeting", meetingId: M2,
  allowlist: ["/guides/**"], token: TOKEN,
});
const M2RID = val(rM2.json, "id");
await post("/api/wiki-resources/" + M2RID + "/enable", {});
const listGuest = await req("GET", "/api/boards/" + BID + "/wiki-resources", undefined, asGuest);
const guestIds = Array.isArray(listGuest.json) ? listGuest.json.map((x) => val(x, "id")) : [];
ok("t25-guest-filter", !guestIds.includes(M2RID) && guestIds.includes(MRID), "guest sees " + JSON.stringify(guestIds));
ok("t25-guest-no-m2-origin", !listGuest.text.includes(M2RID), "M2 origin leaked to M1 guest");
r = await patch("/api/wiki-resources/" + MRID, { description: "move attempt" }, { "x-user": "guest1" });
ok("t25-meet-no-move-read", r.status === 200, r.status);
r = await req("GET", "/api/wiki-resources/" + RID, undefined, asGuest);
ok("t25-guest-board-config", r.status === 403, "guest read board config: " + r.status);
// Revoked user: delete the RETURNED grant id, verify deletion, then exercise
// the same user's denied reads/writes. A second grant keeps the board enforced.
const gRev = await post("/api/boards/" + BID + "/grants", { userKey: "revoked1", access: "read", meetingId: M1 });
const revGid = val(gRev.json, "id");
ok("t25-revoke-grant-created", !!revGid, gRev.status + " " + gRev.text.slice(0, 160));
const gKeep = await post("/api/boards/" + BID + "/grants", { userKey: "keeper1", access: "read", meetingId: M1 });
ok("t25-keeper-grant-created", !!val(gKeep.json, "id"), gKeep.status);
const delRev = await req("DELETE", "/api/grants/" + revGid, undefined, {});
ok("t25-revoke-deleted", delRev.status === 204 || delRev.status === 200, "delete returned " + delRev.status + " " + delRev.text.slice(0, 160));
const grantsAfter = await get("/api/boards/" + BID + "/grants");
ok("t25-revoke-gone", Array.isArray(grantsAfter.json) && !grantsAfter.json.map((g) => val(g, "id")).includes(revGid), "grant still listed");
const asRevoked = { "x-user": "revoked1" };
const revList = await req("GET", "/api/boards/" + BID + "/wiki-resources", undefined, asRevoked);
ok("t25-revoked-no-list", revList.status === 200 && Array.isArray(revList.json) && revList.json.length === 0, "revoked user sees " + revList.status + " " + revList.text.slice(0, 200));
const revRead = await req("GET", "/api/wiki-resources/" + MRID, undefined, asRevoked);
ok("t25-revoked-no-read", revRead.status === 403, "revoked read returned " + revRead.status);
const revSync = await post("/api/wiki-resources/" + MRID + "/sync", {}, asRevoked);
ok("t25-revoked-no-sync", revSync.status === 403, "revoked sync returned " + revSync.status);
const revApprove = await post("/api/sources/" + val(alpha, "id") + "/approve", {}, asRevoked);
ok("t25-revoked-no-approve", revApprove.status === 403, "revoked approve returned " + revApprove.status + " " + revApprove.text.slice(0, 160));
const listStranger = await req("GET", "/api/boards/" + BID + "/wiki-resources", undefined, { "x-user": "stranger-no-grant-xyz" });
ok("t25-stranger-blocked", listStranger.status === 200 && Array.isArray(listStranger.json) && listStranger.json.length === 0, listStranger.status + " " + listStranger.text.slice(0, 200));
r = await get("/api/sources/" + val(alpha, "id") + "/index");
const alphaEligibleBefore = val(r.json, "eligible") === true;
await wikictl("?mode=http500");
r = await post("/api/wiki-resources/" + RID + "/sync", {});
ok("t27-fail-502", r.status === 502, r.status + " " + (r.json ? JSON.stringify(r.json).slice(0, 200) : r.text.slice(0, 200)));
const rstat = await get("/api/wiki-resources/" + RID);
ok("t27-status-failed", (val(rstat.json, "status") || "").toLowerCase() === "failed", JSON.stringify({ status: val(rstat.json, "status") }));
ok("t27-failure-refreshes-status", (val(rstat.json, "usablePages") === 0 || val(rstat.json, "usablepages") === 0), "usablePages not zero after failure: " + JSON.stringify(rstat.json).slice(0, 200));
r = await get("/api/sources/" + val(alpha, "id") + "/index");
ok("t27-blocks-cache", alphaEligibleBefore && val(r.json, "eligible") === false, "previously usable cache still served: " + JSON.stringify(r.json));
await wikictl("?mode=normal");
r = await post("/api/wiki-resources/" + RID + "/sync", {});
ok("t28-retry-restores", r.status === 200, r.status + " " + r.text.slice(0, 300));
r = await get("/api/sources/" + val(alpha, "id") + "/index");
ok("t28-alpha-back", val(r.json, "eligible") === true, JSON.stringify(r.json));
// Strict shape failures: every malformed/unindexable selected page fails the whole attempt.
for (const [m, frag] of [["id-mismatch", "mismatch"], ["string-tags", "tags"], ["missing-content", "content"], ["empty-content", "content"], ["duplicate", "duplicate"]]) {
  await wikictl("?mode=" + m);
  const rrx = await post("/api/wiki-resources/" + RID + "/sync", {});
  ok("t28b-" + m, rrx.status === 502 && JSON.stringify(rrx.json || {}).toLowerCase().includes(frag.toLowerCase()), "mode=" + m + " got " + rrx.status + " " + JSON.stringify(rrx.json || {}).slice(0, 220));
  const st = await get("/api/wiki-resources/" + RID);
  ok("t28b-" + m + "-failed", (val(st.json, "status") || "") === "failed", JSON.stringify(val(st.json, "status")));
}
await wikictl("?mode=normal");
r = await post("/api/wiki-resources/" + RID + "/sync", {});
ok("t28b-recover", r.status === 200, r.status);
// Token-bearing upstream errors must never leak the secret.
await wikictl("?mode=token-echo");
const CANARY = "qa-canary-secret-9f8e7d6c5b4a";
await patch("/api/wiki-resources/" + RID, { token: CANARY });
r = await post("/api/wiki-resources/" + RID + "/sync", {});
ok("t28c-canary-502", r.status === 502, r.status + " " + r.text.slice(0, 300));
ok("t28c-no-canary-leak", !r.text.includes(CANARY) && !(await get("/api/wiki-resources/" + RID)).text.includes(CANARY), "canary leaked");
await patch("/api/wiki-resources/" + RID, { token: TOKEN });
await wikictl("?mode=normal");
r = await post("/api/wiki-resources/" + RID + "/sync", {});
ok("t28c-recover", r.status === 200, r.status);
const errModes = [
  ["timeout-single", 504, "timed out"],
  ["stall-body", 504, "timed out"],
  ["oversize", 502, "256"],
  ["malformed", 502, "malformed"],
  ["graphql-error", 502, "GraphQL"],
  ["http500", 502, ""],
  ["redirect", 502, "redirect"],
  ["forbidden", 502, "permission"],
  ["toomany", 502, "100"],
];
for (const [m, st, frag] of errModes) {
  await wikictl("?mode=" + m);
  const rrx = await post("/api/wiki-resources/" + RID + "/sync", {});
  ok("t29-" + m, rrx.status === st && (frag === "" || JSON.stringify(rrx.json || {}).toLowerCase().includes(frag.toLowerCase()) || (rrx.text || "").toLowerCase().includes(frag.toLowerCase())), "mode=" + m + " got " + rrx.status + " " + (rrx.json ? JSON.stringify(rrx.json).slice(0, 220) : rrx.text.slice(0, 220)));
}
await wikictl("?mode=normal");
r = await post("/api/wiki-resources/" + RID + "/sync", {});
ok("t29-recover", r.status === 200, r.status);
// Upstream auth is a connector 502, never an app 401/403 that logs the user out.
await wikictl("?mode=forbidden");
r = await post("/api/wiki-resources/" + RID + "/sync", {});
ok("t29b-upstream-not-app-auth", r.status === 502 && r.status !== 401 && r.status !== 403, r.status + " " + r.text.slice(0, 200));
await wikictl("?mode=normal");
await post("/api/wiki-resources/" + RID + "/sync", {});
// ---- Observed-barrier helpers (no sleep-races): every mutation is issued
// only after the fixture log proves the attempt reached the intended boundary.
async function logMark() { return (await readLogLines()).length; }
async function waitForLog(from, pred, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < (timeoutMs || 15000)) {
    const ls = await readLogLines();
    for (let i = from; i < ls.length; i++) if (pred(ls[i], i)) return ls[i];
    await sleep(200);
  }
  return null;
}
async function wikiRows() {
  const rev = await get("/api/boards/" + BID + "/sources/review");
  const flat = (Array.isArray(rev.json) ? rev.json : []).filter((g) => low(g).origin === "wiki").flatMap((g) => (g.versions || g.Versions || []));
  return flat.map((d) => ({ id: val(d, "id"), fam: val(d, "familyKey"), v: val(d, "version"), h: val(d, "contentHash"), rs: (val(d, "reviewState") || "").toLowerCase(), ix: (val(d, "indexState") || "").toLowerCase() })).sort((a, b) => String(a.fam).localeCompare(String(b.fam)));
}
async function wikiSectionsOf(rows) {
  const out = {};
  for (const r of rows) {
    const s = await get("/api/sources/" + r.id + "/sections");
    const secs = (s.json && (s.json.sections || s.json.Sections)) || [];
    out[r.fam] = secs.map((x) => String(x.text || x.Text || "")).join("\n---\n");
  }
  return out;
}
async function resCore(rid) {
  const rr = await get("/api/wiki-resources/" + rid);
  const j = low(rr.json || {});
  return { status: j.status, rev: j.configrevision, gen: j.attemptgeneration, usable: j.usablepages, enabled: j.enabled, err: j.lasterror, next: j.nextsyncat === undefined ? null : j.nextsyncat };
}
async function meetSnap(mid) {
  const m = await get("/api/boards/" + BID + "/meetings/" + mid);
  return { status: m.status, body: m.text };
}
async function auditFor(rid, action) {
  const a = await get("/api/activity/audit");
  const arr = Array.isArray(a.json) ? a.json : [];
  return arr.filter((e) => String(val(e, "action") || "") === action && JSON.stringify(e).includes(rid));
}
// Pin the main resource to manual-only during barrier work so the 15s
// scheduler cannot add noise between observed barriers.
r = await patch("/api/wiki-resources/" + RID, { manualOnly: true });
ok("t31-manual-pin", r.status === 200, r.status);
// Pin sibling auto resources too: the 15s scheduler syncing MRID/M2RID
// would pause the same board meetings between observed barriers (F18).
await patch("/api/wiki-resources/" + MRID, { manualOnly: true });
await patch("/api/wiki-resources/" + M2RID, { manualOnly: true });
// Credential/origin coherence: reconfigure DURING an observed fetch discards (409, no cross-origin token).
await wikictl("?mode=normal&singleDelayMs=1500");
{
  const m0 = await logMark();
  const syncP = fetch(API + "/api/wiki-resources/" + RID + "/sync", { method: "POST", headers: { "content-type": "application/json", "x-user": "owner" }, body: "{}" });
  const listed = await waitForLog(m0, (e) => e.op === "pages.list", 15000);
  ok("t31a-reached-fetch", !!listed, "sync never reached the fetch boundary");
  const reconf = await patch("/api/wiki-resources/" + RID, { description: "concurrent reconfig observed" });
  ok("t31a-reconf-during", reconf.status === 200, reconf.status);
  const rev0 = await resCore(RID);
  const rowsBefore = await wikiRows();
  const secsBefore = await wikiSectionsOf(rowsBefore);
  const meetBefore = await meetSnap(M1);
  const auditFailBefore = (await auditFor(RID, "wiki.sync-failed")).length;
  const auditOkBefore = (await auditFor(RID, "wiki.sync-success")).length;
  const syncRes = await syncP.then(async (x) => ({ status: x.status, text: await x.text() })).catch((e) => ({ status: 0, text: String(e) }));
  ok("t31a-sync-discarded-reconf", syncRes.status === 409, "midfetch reconfig not discarded: " + syncRes.status + " " + syncRes.text.slice(0, 200));
  const after = await resCore(RID);
  ok("t31a-rev-stable-after-reconf", after.rev === rev0.rev && after.gen === rev0.gen, "stale completion moved revision: " + JSON.stringify({ before: rev0, after }));
  ok("t31a-no-partial-rows", JSON.stringify(await wikiRows()) === JSON.stringify(rowsBefore), "staged rows leaked into sources");
  ok("t31a-no-partial-sections", JSON.stringify(await wikiSectionsOf(await wikiRows())) === JSON.stringify(secsBefore), "staged sections leaked");
  const meetAfter = await meetSnap(M1);
  ok("t31a-meetings-unchanged", JSON.stringify(meetAfter) === JSON.stringify(meetBefore), "stale attempt paused/bumped meetings: " + JSON.stringify({ meetBefore, meetAfter }).slice(0, 300));
  ok("t31a-no-fail-audit", (await auditFor(RID, "wiki.sync-failed")).length === auditFailBefore, "stale failure was audited");
  ok("t31a-no-success-audit", (await auditFor(RID, "wiki.sync-success")).length === auditOkBefore, "stale success was audited");
  ok("t31a-still-pending", after.status === "pending", "expected pending, got " + after.status);
}
await wikictl("?mode=normal&singleDelayMs=0");
r = await post("/api/wiki-resources/" + RID + "/sync", {});
ok("t31a-resync-after", r.status === 200, r.status);
// Disable during fetch discards; re-enable BEFORE releasing the old attempt invalidates it.
await wikictl("?mode=hold-ok");
{
  const m0 = await logMark();
  const rev0 = await resCore(RID);
  const rowsBefore = await wikiRows();
  const auditFailBefore = (await auditFor(RID, "wiki.sync-failed")).length;
  const auditOkBefore = (await auditFor(RID, "wiki.sync-success")).length;
  const syncP2 = fetch(API + "/api/wiki-resources/" + RID + "/sync", { method: "POST", headers: { "content-type": "application/json", "x-user": "owner" }, body: "{}" });
  const singleSeen = await waitForLog(m0, (e) => e.op === "pages.single", 15000);
  ok("t31b-reached-fetch", !!singleSeen, "sync never reached a single fetch");
  const disRes = await post("/api/wiki-resources/" + RID + "/disable", {});
  ok("t31b-disable-mid", disRes.status === 200, disRes.status);
  const enRes = await post("/api/wiki-resources/" + RID + "/enable", {});
  ok("t31b-reenable-before-release", enRes.status === 200, enRes.status);
  const meetBefore = await meetSnap(M1);
  const rel = await (await fetch(WIKI + "/__release")).json().catch(() => ({}));
  ok("t31b-released", (rel.released || 0) >= 1, JSON.stringify(rel).slice(0, 160));
  const syncRes2 = await syncP2.then(async (x) => ({ status: x.status, text: await x.text() })).catch((e) => ({ status: 0, text: String(e) }));
  ok("t31b-sync-discarded", syncRes2.status === 409, "stale attempt after re-enable not discarded: " + syncRes2.status + " " + syncRes2.text.slice(0, 200));
  const after = await resCore(RID);
  ok("t31b-new-gen-pending", after.status === "pending" && after.gen === rev0.gen + 2, "expected newer pending generation, got " + JSON.stringify(after));
  ok("t31b-no-partial-rows", JSON.stringify(await wikiRows()) === JSON.stringify(rowsBefore), "stale rows leaked");
  const meetAfter = await meetSnap(M1);
  ok("t31b-meetings-unchanged", JSON.stringify(meetAfter) === JSON.stringify(meetBefore), "stale completion paused meetings");
  ok("t31b-no-fail-audit", (await auditFor(RID, "wiki.sync-failed")).length === auditFailBefore, "stale failure was audited");
  ok("t31b-no-success-audit", (await auditFor(RID, "wiki.sync-success")).length === auditOkBefore, "stale success was audited");
}
await wikictl("?mode=normal");
r = await post("/api/wiki-resources/" + RID + "/sync", {});
ok("t31b-resync-after", r.status === 200, r.status);
// Stale failure finalization held across a lifecycle change: nothing may change.
await wikictl("?mode=hold-fail");
{
  const m0 = await logMark();
  const rev0 = await resCore(RID);
  const rowsBefore = await wikiRows();
  const secsBefore = await wikiSectionsOf(rowsBefore);
  const auditFailBefore = (await auditFor(RID, "wiki.sync-failed")).length;
  const failP = fetch(API + "/api/wiki-resources/" + RID + "/sync", { method: "POST", headers: { "content-type": "application/json", "x-user": "owner" }, body: "{}" });
  const singleSeen = await waitForLog(m0, (e) => e.op === "pages.single", 15000);
  ok("t31c-reached-fetch", !!singleSeen, "sync never reached a single fetch");
  const genAtDisable = (await resCore(RID)).gen;
  await post("/api/wiki-resources/" + RID + "/disable", {});
  const meetBefore = await meetSnap(M1);
  const rel = await (await fetch(WIKI + "/__release")).json().catch(() => ({}));
  ok("t31c-released", (rel.released || 0) >= 1, JSON.stringify(rel).slice(0, 160));
  const failRes = await failP.then(async (x) => ({ status: x.status, text: await x.text() })).catch((e) => ({ status: 0, text: String(e) }));
  ok("t31c-fail-discarded", failRes.status === 409, "stale failure not discarded: " + failRes.status + " " + failRes.text.slice(0, 200));
  const curStat = await resCore(RID);
  ok("t31c-keeps-disabled", curStat.status === "disabled" && curStat.next === null, "stale failure overwrote disabled state: " + JSON.stringify(curStat));
  ok("t31c-gen-stable", curStat.gen === genAtDisable + 1, "generation moved after disable: " + JSON.stringify(curStat));
  ok("t31c-no-partial-rows", JSON.stringify(await wikiRows()) === JSON.stringify(rowsBefore), "partial rows leaked");
  ok("t31c-no-partial-sections", JSON.stringify(await wikiSectionsOf(await wikiRows())) === JSON.stringify(secsBefore), "partial sections leaked");
  const meetAfter = await meetSnap(M1);
  ok("t31c-meetings-unchanged", JSON.stringify(meetAfter) === JSON.stringify(meetBefore), "stale failure paused meetings");
  ok("t31c-no-fail-audit", (await auditFor(RID, "wiki.sync-failed")).length === auditFailBefore, "stale failure was audited");
}
await wikictl("?mode=normal");
await post("/api/wiki-resources/" + RID + "/enable", {});
await post("/api/wiki-resources/" + RID + "/sync", {});
// Two origins, two dummy secret identities, observed configuration-window barrier.
{
  const reachA = await (await fetch("http://127.0.0.1:5201/health")).json().catch(() => null);
  const reachB = await (await fetch("http://localhost:5201/health")).json().catch(() => null);
  ok("t32-origins-reachable", !!(reachA && reachA.ok) && !!(reachB && reachB.ok), JSON.stringify({ reachA, reachB }));
  const tag = Date.now().toString(36);
  const ORIG_A = "http://127.0.0.1:5201/";
  const ORIG_B = "http://localhost:5201/";
  const TOK_A = "qa-barrier-A-" + tag;
  const TOK_B = "qa-barrier-B-" + tag;
  const mkRes = async (baseUrl, token) => {
    const rr = await post("/api/boards/" + BID + "/wiki-resources", {
      baseUrl, description: "barrier", allowedUse: "barrier", scope: "board",
      allowlist: ["/guides/**"], manualOnly: true, token,
    });
    const id = val(rr.json, "id");
    await post("/api/wiki-resources/" + id + "/enable", {});
    return id;
  };
  const AID = await mkRes(ORIG_A, TOK_A);
  const BID2 = await mkRes(ORIG_B, TOK_B);
  ok("t32-two-resources", !!AID && !!BID2, "resource ids missing");
  let m = await logMark();
  await post("/api/wiki-resources/" + AID + "/sync", {});
  let nl = (await readLogLines()).slice(m);
  const aLogs = nl.filter((e) => e.tokenTag === TOK_A);
  ok("t32-a-routed", aLogs.length > 0, "no A requests logged");
  ok("t32-a-no-cross", aLogs.every((e) => String(e.host || "").includes("127.0.0.1")), "A secret sent to wrong origin: " + JSON.stringify(aLogs.map((e) => e.host)).slice(0, 200));
  ok("t32-a-no-b", !nl.some((e) => e.tokenTag === TOK_B), "B secret observed during A sync");
  m = await logMark();
  await post("/api/wiki-resources/" + BID2 + "/sync", {});
  nl = (await readLogLines()).slice(m);
  const bLogs = nl.filter((e) => e.tokenTag === TOK_B);
  ok("t32-b-routed", bLogs.length > 0, "no B requests logged");
  ok("t32-b-no-cross", bLogs.every((e) => String(e.host || "").includes("localhost") && !String(e.host || "").includes("127.0.0.1")), "B secret sent to wrong origin");
  // Configuration-window barrier: retarget A at B's origin MID-FLIGHT.
  // The coherent capture pairs the new origin with no usable credential and
  // disables the resource instead of sending A to B.
  await wikictl("?mode=normal&singleDelayMs=1500");
  m = await logMark();
  const syncA = fetch(API + "/api/wiki-resources/" + AID + "/sync", { method: "POST", headers: { "content-type": "application/json", "x-user": "owner" }, body: "{}" });
  const listedA = await waitForLog(m, (e) => e.op === "pages.list", 15000);
  ok("t32w-reached-fetch", !!listedA, "A sync never reached fetch");
  const revA = await resCore(AID);
  const moveA = await patch("/api/wiki-resources/" + AID, { baseUrl: ORIG_B });
  ok("t32w-retarget", moveA.status === 200, moveA.status);
  const resA = await syncA.then(async (x) => ({ status: x.status, text: await x.text() })).catch((e) => ({ status: 0, text: String(e) }));
  ok("t32w-discarded", resA.status === 409, "cross-origin attempt not discarded: " + resA.status + " " + resA.text.slice(0, 200));
  nl = (await readLogLines()).slice(m);
  ok("t32w-no-cross", !nl.some((e) => e.tokenTag === TOK_A && String(e.host || "").includes("localhost")), "A secret reached B origin");
  const afterA = await resCore(AID);
  ok("t32w-disabled-nocred", afterA.enabled === false && afterA.status === "disabled", "retarget must disable + clear credential: " + JSON.stringify(afterA));
  // Hammer: alternating mid-flight reconfigurations never cross routes.
  await wikictl("?mode=normal&singleDelayMs=800");
  let hammerOk = true;
  for (let k = 0; k < 4; k++) {
    const tgt = k % 2 === 0 ? BID2 : AID;
    const isB = k % 2 === 0;
    if (!isB) {
      await patch("/api/wiki-resources/" + AID, { baseUrl: ORIG_A, token: TOK_A });
      await post("/api/wiki-resources/" + AID + "/enable", {});
    }
    m = await logMark();
    const sp = fetch(API + "/api/wiki-resources/" + tgt + "/sync", { method: "POST", headers: { "content-type": "application/json", "x-user": "owner" }, body: "{}" });
    const li = await waitForLog(m, (e) => e.op === "pages.list", 15000);
    if (!li) { hammerOk = false; break; }
    await patch("/api/wiki-resources/" + tgt, { description: "hammer-" + k });
    const sr = await sp.then(async (x) => ({ status: x.status })).catch(() => ({ status: 0 }));
    if (sr.status !== 409) hammerOk = false;
    nl = (await readLogLines()).slice(m);
    const wrong = isB ? TOK_A : TOK_B;
    const mine = isB ? TOK_B : TOK_A;
    if (nl.some((e) => e.tokenTag === wrong)) hammerOk = false;
    if (!nl.some((e) => e.tokenTag === mine)) hammerOk = false;
  }
  ok("t32-hammer-no-cross", hammerOk, "mid-flight reconfigurations crossed origins");
  await wikictl("?mode=normal&singleDelayMs=0");
  await del("/api/wiki-resources/" + AID);
  await del("/api/wiki-resources/" + BID2);
}
// Manual-only: scheduler never auto-syncs; NextSyncAt stays null.
r = await patch("/api/wiki-resources/" + RID, { manualOnly: true });
ok("t32-manual-only-set", r.status === 200 && (val(r.json, "manualOnly") === true), r.status + " " + r.text.slice(0, 200));
ok("t32-manual-next-null", val(r.json, "nextSyncAt") == null, "manual-only must clear NextSyncAt: " + r.text.slice(0, 200));
r = await patch("/api/wiki-resources/" + RID, { manualOnly: false });
ok("t32-manual-off", r.status === 200, r.status);
// Scope authoritative: generic source scope move on wiki doc rejected.
const wikiDocId = val(alpha, "id");
const scopeMove = await patch("/api/sources/" + wikiDocId, { scope: "meeting", meetingId: M1 });
ok("t32-wiki-scope-authoritative", scopeMove.status === 409, "wiki scope move not rejected: " + scopeMove.status + " " + scopeMove.text.slice(0, 200));
// Setup-use gate: a real owned wizard and the exact source. Every rejection
// leaves provenance unchanged; only a healthy authorized positive control
// appends exactly one checkpoint.
const wiz = await post("/api/wizard", {});
const WID = val(wiz.json, "id");
ok("t32-wizard-created", wiz.status === 200 && !!WID, wiz.status + " " + wiz.text.slice(0, 200));
async function wizProv() { const w = await get("/api/wizard/" + WID); return JSON.stringify((w.json && (w.json.provenanceJson ?? w.json.ProvenanceJson)) ?? null); }
const prov0 = await wizProv();
const noSetup = await post("/api/wizard/" + WID + "/extract", { sourceId: wikiDocId });
ok("t32-setup-off-rejected", noSetup.status === 409, "setup-off extract returned " + noSetup.status + " " + noSetup.text.slice(0, 200));
ok("t32-setup-off-no-checkpoint", (await wizProv()) === prov0, "rejected extract mutated provenance");
// Failed health rejects without a checkpoint (revision unchanged by the failure).
await wikictl("?mode=http500");
r = await post("/api/wiki-resources/" + RID + "/sync", {});
ok("t32-setup-fail-sync", r.status === 502, r.status);
const noHealth = await post("/api/wizard/" + WID + "/extract", { sourceId: wikiDocId });
ok("t32-setup-failed-rejected", noHealth.status === 409, "failed-health extract returned " + noHealth.status);
ok("t32-setup-failed-no-checkpoint", (await wizProv()) === prov0, "rejected extract mutated provenance");
await wikictl("?mode=normal");
r = await post("/api/wiki-resources/" + RID + "/sync", {});
ok("t32-setup-recover", r.status === 200, r.status);
// Missing connector rejects without a checkpoint: sync a throwaway resource,
// extract its pending doc (pending rejects), then delete the RESOURCE and
// extract the orphaned source (missing connector rejects).
const rowsPreGhost = await wikiRows();
const gTmp = await post("/api/boards/" + BID + "/wiki-resources", { baseUrl: WIKIBASE, description: "ghost", allowedUse: "ghost", scope: "board", allowlist: ["/guides/beta"], manualOnly: true, token: TOKEN });
const GID = val(gTmp.json, "id");
ok("t32-ghost-created", !!GID, gTmp.status + " " + gTmp.text.slice(0, 160));
await post("/api/wiki-resources/" + GID + "/enable", {});
await post("/api/wiki-resources/" + GID + "/sync", {});
const gRows = (await wikiRows()).filter((d) => !(rowsPreGhost.some((p) => p.id === d.id)));
const gDoc = gRows.find((d) => d.fam.includes("/guides/beta"));
ok("t32-ghost-doc", !!gDoc && gDoc.rs === "pending", "ghost pending doc missing: " + JSON.stringify(gRows).slice(0, 300));
const noPend = await post("/api/wizard/" + WID + "/extract", { sourceId: gDoc.id });
ok("t32-setup-pending-rejected", noPend.status === 409, "pending extract returned " + noPend.status + " " + noPend.text.slice(0, 200));
ok("t32-setup-pending-no-checkpoint", (await wizProv()) === prov0, "rejected extract mutated provenance");
await del("/api/wiki-resources/" + GID);
const noRes = await post("/api/wizard/" + WID + "/extract", { sourceId: gDoc.id });
ok("t32-setup-missing-rejected", noRes.status === 409, "missing-resource extract returned " + noRes.status + " " + noRes.text.slice(0, 200));
ok("t32-setup-missing-no-checkpoint", (await wizProv()) === prov0, "rejected extract mutated provenance");
await wikictl("?mode=deleted");
await post("/api/wiki-resources/" + RID + "/sync", {});
const noRemoved = await post("/api/wizard/" + WID + "/extract", { sourceId: wikiDocId });
ok("t32-setup-removed-rejected", noRemoved.status === 409, "removed-page extract returned " + noRemoved.status);
ok("t32-setup-removed-no-checkpoint", (await wizProv()) === prov0, "rejected extract mutated provenance");
await wikictl("?mode=normal");
await post("/api/wiki-resources/" + RID + "/sync", {});
// Unauthorized scope rejects without a checkpoint (guest1 sees only M1).
const noScope = await post("/api/wizard/" + WID + "/extract", { sourceId: wikiDocId }, { "x-user": "guest1" });
ok("t32-setup-scope-rejected", noScope.status === 409 || noScope.status === 403, "out-of-scope extract returned " + noScope.status);
ok("t32-setup-scope-no-checkpoint", (await wizProv()) === prov0, "rejected extract mutated provenance");
// Healthy authorized positive control appends exactly one checkpoint.
r = await patch("/api/wiki-resources/" + RID, { setupUse: true });
ok("t32-setup-on", r.status === 200, r.status);
await post("/api/wiki-resources/" + RID + "/sync", {});
const yesSetup = await post("/api/wizard/" + WID + "/extract", { sourceId: wikiDocId });
ok("t32-setup-positive", yesSetup.status === 200, "healthy extract returned " + yesSetup.status + " " + yesSetup.text.slice(0, 300));
const prov1 = await wizProv();
ok("t32-setup-one-checkpoint", prov0 !== prov1 && JSON.stringify(prov1).includes(wikiDocId), "positive control did not append its checkpoint");
r = await patch("/api/wiki-resources/" + RID, { setupUse: false });
ok("t32-setup-off-restore", r.status === 200, r.status);
await post("/api/wiki-resources/" + RID + "/sync", {});
// Governance regression (source seam).
const fd = new FormData();
fd.append("file", new Blob(["# qa gov\n\nGovernance regression body.\n"], { type: "text/plain" }), "gov.txt");
fd.append("scope", "board");
let up = await fetch(API + "/api/boards/" + BID + "/sources/upload", { method: "POST", headers: { "x-user": "owner" }, body: fd });
ok("t33-upload-pending", up.status === 201 || up.status === 200, "upload " + up.status);
const upj = await up.json();
const gup = low(upj);
ok("t33-upload-fields", (gup.reviewstate || gup.reviewState) === "pending" && (gup.origin || gup.Origin) === "upload", JSON.stringify({ rs: gup.reviewstate ?? gup.reviewState, o: gup.origin ?? gup.Origin }));
const gid = gup.id || gup.Id;
let ap = await post("/api/sources/" + gid + "/approve", {});
ok("t33-approve", ap.status === 200, ap.status + " " + ap.text.slice(0, 160));
let pol = await req("PUT", "/api/boards/" + BID + "/source-policy", { blockedTypes: "", mode: "wikiOnly" });
ok("t33-policy-wiki", pol.status === 200, pol.status + " " + pol.text.slice(0, 160));
const fd2 = new FormData();
fd2.append("file", new Blob(["x"], { type: "text/plain" }), "blocked.txt");
fd2.append("scope", "board");
let up2 = await fetch(API + "/api/boards/" + BID + "/sources/upload", { method: "POST", headers: { "x-user": "owner" }, body: fd2 });
ok("t33-wikionly-denies-upload", up2.status === 415, "upload under wikiOnly: " + up2.status);
pol = await req("PUT", "/api/boards/" + BID + "/source-policy", { blockedTypes: "txt", mode: "allowAll" });
up2 = await fetch(API + "/api/boards/" + BID + "/sources/upload", { method: "POST", headers: { "x-user": "owner" }, body: fd2 });
ok("t33-blocked-ext", up2.status === 415, "blocked ext: " + up2.status);
pol = await req("PUT", "/api/boards/" + BID + "/source-policy", { blockedTypes: "", mode: "allowAll" });
ok("t33-policy-restore", pol.status === 200, pol.status);
r = await get("/api/backup", { "x-user": "owner" });
let snapText = "";
if (r.status === 200) {
  const outer = r.json;
  snapText = val(outer, "snapshot") || "";
  ok("t34-backup-has-wiki", snapText.includes("wikiResources"), "no wikiResources in backup");
  ok("t34-backup-no-secret", !snapText.includes(TOKEN) && !snapText.toLowerCase().includes("protectedtoken"), "secret leaked into backup");
  ok("t34-backup-camel", snapText.includes("boardId") && snapText.includes("baseUrl"), "backup must use consistent camelCase");
  const snapHash = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
  async function exportBytes() { const b = await get("/api/backup", { "x-user": "owner" }); const s2 = val(b.json, "snapshot") || ""; return String(s2).replace(/([{,])"at":"[^"]*"/, "$1\"at\":\"FIXED\""); }
  async function wikiCanon() {
    const rl = await get("/api/boards/" + BID + "/wiki-resources");
    const res = (Array.isArray(rl.json) ? rl.json : []).map((x) => { const l = low(x); return { id: val(x, "id"), scope: l.scope, meeting: val(x, "meetingid"), url: l.baseurl, desc: l.description, use: l.alloweduse, setup: l.setupuse, man: l.manualonly, allow: JSON.stringify(l.allowlist), excl: JSON.stringify(l.exclusions), tags: JSON.stringify(l.requiredtags), loc: l.locale, rev: l.configrevision, iv: l.syncintervalminutes, created: l.createdat, en: l.enabled, st: l.status, cred: l.hascredential, usable: l.usablepages, err: l.lasterror, next: l.nextsyncat, completed: l.lastcompletedat, successRev: l.lastsuccessrevision, successAt: l.lastsuccessat, updated: l.updatedat }; }).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const rows = await wikiRows();
    const secs = await wikiSectionsOf(rows);
    return { res, rows, secs };
  }
  const healthOf = (c) => c.res.map((x) => ({ id: x.id, en: x.en, st: x.st, cred: x.cred, usable: x.usable, err: x.err, next: x.next, completed: x.completed, successRev: x.successRev, successAt: x.successAt, updated: x.updated }));
  const configOf = (c) => JSON.stringify(c.res.map(({ en, st, cred, usable, err, next, completed, successRev, successAt, updated, ...rest }) => rest)) + "|" + JSON.stringify(c.rows) + "|" + JSON.stringify(c.secs);
  await post("/api/wiki-resources/" + RID + "/sync", {});
  const C0 = await wikiCanon();
  ok("t34-baseline-healthy", C0.res.some((x) => x.id === RID && x.st === "succeeded"), "RID not healthy before restore tests");
  // Exact round-trip: configuration/history/source graph identical; only the
  // intentionally required disabled/credential-free health reset may differ.
  const rr2 = await post("/api/backup/restore", { snapshot: snapText, hash: snapHash(snapText) });
  ok("t34-restore-ok", rr2.status === 200, rr2.status + " " + rr2.text.slice(0, 300));
  const C1 = await wikiCanon();
  ok("t34-config-preserved", configOf(C1) === configOf(C0), "configuration/history changed across restore");
  ok("t34-health-reset", C1.res.every((x) => x.en === false && x.st === "disabled" && x.cred === false && x.usable === 0), "health not reset: " + JSON.stringify(healthOf(C1)).slice(0, 300));
  // Malformed correct-hash graphs reject BEFORE any clear: bytes and identities unchanged.
  const baseObj = () => JSON.parse(snapText);
  const meetRes = baseObj().wikiResources.find((x) => (x.scope || x.Scope) === "meeting");
  const malformed = [
    ["missing-id", (o) => { delete o.wikiResources[0].id; }],
    ["bad-scope", (o) => { o.wikiResources[0].scope = "global"; }],
    ["dangling-meeting", (o) => { const m = o.wikiResources.find((x) => (x.scope || x.Scope) === "meeting"); if (m) { m.meetingId = "11111111-2222-3333-4444-555555555555"; } }],
    ["malformed-rule-json", (o) => { o.wikiResources[0].allowlistJson = "[invalid"; }],
    ["nonstring-tag", (o) => { o.wikiResources[0].requiredTagsJson = JSON.stringify(["ok", 42]); }],
    ["duplicate-id", (o) => { if (o.wikiResources.length > 1) o.wikiResources[1].id = o.wikiResources[0].id; }],
    ["unknown-source-ref", (o) => { const s = o.sources.find((x) => (x.origin || x.Origin || "").toLowerCase() === "wiki"); if (s) { s.resourceId = "22222222-3333-4444-5555-666666666666"; } }],
    ["unknown-section-source", (o) => { if (o.sections && o.sections.length) o.sections[0].sourceId = "33333333-4444-5555-6666-777777777777"; }],
  ];
  for (const [nm, mut] of malformed) {
    const obj = baseObj();
    mut(obj);
    const bad = JSON.stringify(obj);
    const bb = await exportBytes();
    const cb = await wikiCanon();
    const rb = await post("/api/backup/restore", { snapshot: bad, hash: snapHash(bad) });
    const ba = await exportBytes();
    ok("t34-reject-" + nm, rb.status === 400 && ba === bb, nm + " got " + rb.status + " bytes-changed=" + (ba !== bb));
    ok("t34-reject-identities-" + nm, JSON.stringify(await wikiCanon()) === JSON.stringify(cb), nm + " changed identities despite rejection");
  }
  // Storage failure DURING replacement rolls back completely (poison message row).
  const pObj = baseObj();
  pObj.messages["00000000-0000-0000-0000-000000000001"] = null;
  const pBad = JSON.stringify(pObj);
  const Cpre = await wikiCanon();
  const bytesPre = await exportBytes();
  const pr = await post("/api/backup/restore", { snapshot: pBad, hash: snapHash(pBad) });
  const bytesPost = await exportBytes();
  ok("t34-poison-rolled-back", pr.status === 500 && bytesPost === bytesPre, "storage failure did not roll back: " + pr.status + " bytes-changed=" + (bytesPost !== bytesPre));
  ok("t34-poison-identities", JSON.stringify(await wikiCanon()) === JSON.stringify(Cpre), "poison restore changed identities");
  // Legacy version-1 snapshot restores, then the exact snapshot restores back deterministically.
  const v1obj = baseObj();
  delete v1obj.wikiResources;
  v1obj.version = 1;
  const v1s = JSON.stringify(v1obj);
  const v1r = await post("/api/backup/restore", { snapshot: v1s, hash: snapHash(v1s) });
  ok("t34-v1-accepted", v1r.status === 200, "v1 restore got " + v1r.status + " " + v1r.text.slice(0, 200));
  const boardsAfterV1 = await get("/api/boards");
  ok("t34-v1-boards-intact", Array.isArray(boardsAfterV1.json) && boardsAfterV1.json.some((b) => val(b, "id") === BID), "boards lost in v1 restore");
  const back = await post("/api/backup/restore", { snapshot: snapText, hash: snapHash(snapText) });
  ok("t34-v1-roundtrip-back", back.status === 200, back.status);
  const C2 = await wikiCanon();
  const stripU = (c) => JSON.stringify({ res: c.res.map(({ updated, ...rest }) => rest), rows: c.rows, secs: c.secs });
  ok("t34-v1-deterministic", stripU(C2) === stripU(C1), "v1 detour corrupted state");
  // Reconfigure credential + enable after restore.
  await patch("/api/wiki-resources/" + RID, { token: TOKEN });
  await post("/api/wiki-resources/" + RID + "/enable", {});
  await post("/api/wiki-resources/" + RID + "/sync", {});
} else {
  ok("t34-backup", false, "backup status " + r.status);
}
await wikictl("?mode=normal&singleDelayMs=1500");
const p1 = fetch(API + "/api/wiki-resources/" + RID + "/sync", { method: "POST", headers: { "content-type": "application/json", "x-user": "owner" }, body: "{}" });
await sleep(300);
const p2 = await post("/api/wiki-resources/" + RID + "/sync", {});
const r1 = await p1.then(async (x) => x.status).catch(() => 0);
ok("t37-single-flight", p2.status === 409 || r1 === 409, "concurrent syncs: first=" + r1 + " second=" + p2.status);
await wikictl("?mode=normal&singleDelayMs=0");
// F8: blanking required config on an ENABLED resource force-disables + blocks; no autosync.
{
  const before = await resCore(RID);
  ok("tF8-healthy-before", before.status === "succeeded", JSON.stringify(before));
  const blank = await patch("/api/wiki-resources/" + RID, { allowedUse: "" });
  ok("tF8-blank-200", blank.status === 200, blank.status + " " + blank.text.slice(0, 200));
  const dis = await resCore(RID);
  ok("tF8-disabled-blocked", dis.enabled === false && dis.status === "disabled" && dis.next === null, "required-config removal did not block: " + JSON.stringify(dis));
  ok("tF8-rev-bumped", dis.rev === before.rev + 1, JSON.stringify({ before, dis }));
  const blocked = await post("/api/wiki-resources/" + RID + "/sync", {});
  ok("tF8-sync-blocked", blocked.status === 409, "sync after required-config removal: " + blocked.status);
  const enNoFix = await post("/api/wiki-resources/" + RID + "/enable", {});
  ok("tF8-enable-still-blocked", enNoFix.status === 409, "enable without required config: " + enNoFix.status);
  await patch("/api/wiki-resources/" + RID, { allowedUse: "board lookup only" });
  const enFix = await post("/api/wiki-resources/" + RID + "/enable", {});
  ok("tF8-enable-after-fix", enFix.status === 200, enFix.status);
  const reSync = await post("/api/wiki-resources/" + RID + "/sync", {});
  ok("tF8-recover-sync", reSync.status === 200, reSync.status);
}
// F11: null / number / blank entries reject the WHOLE collection; revision and rules unchanged.
{
  const before = await resCore(RID);
  const bres = await get("/api/wiki-resources/" + RID);
  const bAllow = JSON.stringify(low(bres.json).allowlist);
  const bExcl = JSON.stringify(low(bres.json).exclusions);
  const bTags = JSON.stringify(low(bres.json).requiredtags);
  for (const [nm, body] of [["null-entry", { exclusions: ["/guides/a", null] }], ["number-entry", { requiredTags: ["handbook", 42] }], ["blank-entry", { allowlist: ["/guides/**", "   "] }], ["nonarray", { allowlist: "/guides/**" }]]) {
    const rr = await patch("/api/wiki-resources/" + RID, body);
    ok("tF11-reject-" + nm, rr.status === 400, nm + " got " + rr.status + " " + (rr.text || "").slice(0, 160));
  }
  const after = await resCore(RID);
  const ares = await get("/api/wiki-resources/" + RID);
  ok("tF11-rev-unchanged", after.rev === before.rev && after.gen === before.gen, "rejected mutation changed revision: " + JSON.stringify({ before, after }));
  ok("tF11-rules-unchanged", JSON.stringify(low(ares.json).allowlist) === bAllow && JSON.stringify(low(ares.json).exclusions) === bExcl && JSON.stringify(low(ares.json).requiredtags) === bTags, "rejected mutation changed rules");
}
// F13: rejected-single bytes count toward the aggregate bound (no bypass).
{
  const fr = await post("/api/boards/" + BID + "/wiki-resources", { baseUrl: WIKIBASE, description: "fat", allowedUse: "fat", scope: "board", allowlist: ["/guides/**", "/fat/**"], requiredTags: ["keep"], locale: "en", manualOnly: true, token: TOKEN });
  const FID = val(fr.json, "id");
  await post("/api/wiki-resources/" + FID + "/enable", {});
  await wikictl("?mode=fat");
  const m0 = await logMark();
  const fsy = await post("/api/wiki-resources/" + FID + "/sync", {});
  ok("tF13-fat-aggregate", fsy.status === 502 && /aggregate/i.test(fsy.text), "rejected singles bypassed bound: " + fsy.status + " " + fsy.text.slice(0, 200));
  const fst = await resCore(FID);
  ok("tF13-fat-failed", fst.status === "failed", JSON.stringify(fst));
  const frows = (await wikiRows()).filter((d) => String(d.fam).includes(String(FID).replace(/-/g, "").toLowerCase()));
  ok("tF13-fat-no-partial", frows.length === 0, "rejected batch published rows: " + JSON.stringify(frows).slice(0, 200));
  const fatAud = await auditFor(FID, "wiki.sync-success");
  ok("tF13-fat-no-success-audit", fatAud.length === 0, "rejected batch audited success");
  await wikictl("?mode=normal");
  await del("/api/wiki-resources/" + FID);
}
// Whitespace-only content fails the whole attempt closed (F3/F4).
{
  const wr = await post("/api/boards/" + BID + "/wiki-resources", { baseUrl: WIKIBASE, description: "white", allowedUse: "white", scope: "board", allowlist: ["/guides/**"], manualOnly: true, token: TOKEN });
  const WID = val(wr.json, "id");
  await post("/api/wiki-resources/" + WID + "/enable", {});
  await wikictl("?mode=white-content");
  const wsy = await post("/api/wiki-resources/" + WID + "/sync", {});
  ok("tF34-white-fail", wsy.status === 502, "whitespace content did not fail closed: " + wsy.status + " " + wsy.text.slice(0, 200));
  const wst = await resCore(WID);
  ok("tF34-white-failed", wst.status === "failed", JSON.stringify(wst));
  const wrows = (await wikiRows()).filter((d) => String(d.fam).includes(String(WID).replace(/-/g, "").toLowerCase()));
  ok("tF34-white-no-partial", wrows.length === 0, "unindexable batch published rows");
  await wikictl("?mode=normal");
  await del("/api/wiki-resources/" + WID);
}
// F15: transport disposal across every outcome; server connections drain to baseline.
{
  const cc = async () => { try { return (await (await fetch(WIKI + "/__connections")).json()).connections; } catch { return -1; } };
  const c0 = await cc();
  ok("tF15-conn-baseline", typeof c0 === "number" && c0 >= 0, "no connection count: " + c0);
  for (const md of ["normal", "redirect", "malformed", "graphql-error", "http500", "oversize", "toomany", "forbidden"]) {
    await wikictl("?mode=" + md);
    await post("/api/wiki-resources/" + RID + "/sync", {});
  }
  await wikictl("?mode=timeout-single");
  await post("/api/wiki-resources/" + RID + "/sync", {});
  await wikictl("?mode=stall-body");
  await post("/api/wiki-resources/" + RID + "/sync", {});
  await wikictl("?mode=normal");
  await post("/api/wiki-resources/" + RID + "/sync", {});
  let cNow = 999;
  for (let i = 0; i < 12; i++) {
    await sleep(2000);
    cNow = await cc();
    if (cNow !== -1 && cNow <= c0 + 1) break;
  }
  ok("tF15-connections-drained", cNow !== -1 && cNow <= c0 + 1, "transport objects leaked: base=" + c0 + " now=" + cNow);
}
// F3/F4/F18: new multi-page batch whose later page fails leaves zero partial rows/sections.
{
  const tr = await post("/api/boards/" + BID + "/wiki-resources", { baseUrl: WIKIBASE, description: "trio", allowedUse: "trio", scope: "board", allowlist: ["/guides/**"], manualOnly: true, token: TOKEN });
  const TID = val(tr.json, "id");
  await post("/api/wiki-resources/" + TID + "/enable", {});
  await wikictl("?mode=trio");
  let sy = await post("/api/wiki-resources/" + TID + "/sync", {});
  ok("trio-sync-ok", sy.status === 200, sy.status + " " + sy.text.slice(0, 200));
  const allRows = await wikiRows();
  const trows = allRows.filter((d) => String(d.fam).includes(String(TID).replace(/-/g, "").toLowerCase()));
  ok("trio-three-docs", trows.length === 3, "trio docs: " + JSON.stringify(trows.map((d) => d.fam)));
  for (const d of trows) {
    const ap = await post("/api/sources/" + d.id + "/approve", {});
    if (ap.status !== 200) ok("trio-approve-" + d.fam, false, ap.status + " " + ap.text.slice(0, 160));
  }
  ok("trio-all-approved", true);
  const rowsBefore = await wikiRows();
  const trioBefore = rowsBefore.filter((d) => String(d.fam).includes(String(TID).replace(/-/g, "").toLowerCase()));
  const secsBefore = await wikiSectionsOf(rowsBefore);
  const revBefore = await resCore(TID);
  await wikictl("?mode=fail-single-13");
  const tf = await post("/api/wiki-resources/" + TID + "/sync", {});
  ok("trio-fail-502", tf.status === 502, "failed batch did not fail closed: " + tf.status + " " + tf.text.slice(0, 200));
  const rowsAfter = await wikiRows();
  ok("trio-no-new-versions", JSON.stringify(rowsAfter) === JSON.stringify(rowsBefore), "partial batch changed rows");
  ok("trio-no-new-sections", JSON.stringify(await wikiSectionsOf(rowsAfter)) === JSON.stringify(secsBefore), "partial batch changed sections");
  const revAfter = await resCore(TID);
  ok("trio-rev-stable", revAfter.rev === revBefore.rev, "revision moved on failed batch");
  ok("trio-health-failed", revAfter.status === "failed", JSON.stringify(revAfter));
  for (const d of trioBefore) {
    const ix = await get("/api/sources/" + d.id + "/index");
    if (val(ix.json, "eligible") !== false) ok("trio-blocked-" + d.fam, false, "previously usable cache still served: " + JSON.stringify(ix.json));
  }
  ok("trio-cache-blocked", true);
  await wikictl("?mode=normal");
  const rec = await post("/api/wiki-resources/" + TID + "/sync", {});
  ok("trio-recover", rec.status === 200, rec.status);
  const rowsRec = await wikiRows();
  ok("trio-idempotent", JSON.stringify(rowsRec) === JSON.stringify(rowsBefore), "recovery duplicated rows");
  await del("/api/wiki-resources/" + TID);
}
// F14/F18 schedule: automatic positive control plus manual-only zero-request control.
{
  const mkA = await post("/api/boards/" + BID + "/wiki-resources", { baseUrl: WIKIBASE, description: "sched-auto", allowedUse: "sched", scope: "board", allowlist: ["/guides/**"], token: "qa-barrier-auto" });
  const AUID = val(mkA.json, "id");
  await post("/api/wiki-resources/" + AUID + "/enable", {});
  const mkM = await post("/api/boards/" + BID + "/wiki-resources", { baseUrl: WIKIBASE, description: "sched-man", allowedUse: "sched", scope: "board", allowlist: ["/guides/**"], manualOnly: true, token: "qa-barrier-manual" });
  const MUID = val(mkM.json, "id");
  await post("/api/wiki-resources/" + MUID + "/enable", {});
  const man0 = await resCore(MUID);
  ok("tSched-man-null", man0.next === null, "manual-only must clear NextSyncAt: " + JSON.stringify(man0));
  const t0 = Date.now();
  const m0 = await logMark();
  // Hosted scheduler polls every 15s; the auto resource is due immediately.
  let autoDone = null;
  for (let i = 0; i < 16 && !autoDone; i++) {
    await sleep(2500);
    const a = await resCore(AUID);
    if (a.status === "succeeded") autoDone = a;
  }
  ok("tSched-auto-positive", !!autoDone, "scheduler never auto-synced the due resource");
  const manLogs = (await readLogLines()).slice(m0).filter((e) => e.tokenTag === "qa-barrier-manual");
  ok("tSched-manual-zero", manLogs.length === 0, "manual-only resource was auto-fetched " + manLogs.length + " time(s)");
  const man1 = await resCore(MUID);
  ok("tSched-man-still-null", man1.next === null && man1.status !== "succeeded", "manual-only changed without a manual sync: " + JSON.stringify(man1));
  // Manual-only failure also keeps null (F14).
  await wikictl("?mode=http500");
  const mf = await post("/api/wiki-resources/" + MUID + "/sync", {});
  ok("tSched-man-fail-502", mf.status === 502, mf.status);
  const man2 = await resCore(MUID);
  ok("tSched-man-fail-null", man2.next === null && man2.status === "failed", JSON.stringify(man2));
  await wikictl("?mode=normal");
  await del("/api/wiki-resources/" + AUID);
  await del("/api/wiki-resources/" + MUID);
}
// F8: full permitted-use guidance in actual authorized context (fake provider, zero paid calls).
{
  const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  const LONG_USE = "Alpha lookup only. " + "x".repeat(320) + " CONDITION-BEYOND-300: only Flagship briefing outcomes may be cited. " + "y".repeat(160);
  ok("tF8-use-long", LONG_USE.length > 400 && LONG_USE.indexOf("CONDITION-BEYOND-300") > 300, "condition must sit beyond char 300");
  const cb = await post("/api/boards", { name: "wiki-ctx-board" });
  const CBID = val(cb.json, "id");
  await post("/api/boards/" + CBID + "/lead", { name: "QA Lead", roleLabel: "Lead" });
  const q = await post("/api/roster/quick", { accountId: "ctx-acct", name: "ctx-adv", description: "Context advisor for handbook retrieval testing." });
  const cRid = val(q.json, "id") || val(q.json && q.json.entry, "id");
  const fdP = new FormData();
  fdP.append("file", new Blob([PNG], { type: "image/png" }), "qa.png");
  const upP = await fetch(API + "/api/roster/" + cRid + "/image/upload", { method: "POST", headers: { "x-user": "owner" }, body: fdP });
  const upPj = await upP.json().catch(() => ({}));
  const imgId = (upPj && (upPj.id || (upPj[0] && upPj[0].id))) || (Array.isArray(upPj) && upPj[0] && upPj[0].id);
  if (imgId) await post("/api/images/" + imgId + "/review", { decision: "accept" });
  const cp = await post("/api/roster/" + cRid + "/copy", { boardId: CBID, boardRole: "CtxRole" });
  ok("tF8-ctx-copy", (cp.status === 200 || cp.status === 201) && !!val(cp.json, "id"), cp.status + " " + cp.text.slice(0, 200));
  const cAid = val(cp.json, "id");
  const cAp = await post("/api/boards/" + CBID + "/advisors/" + cAid + "/approve", {});
  ok("tF8-ctx-approve", cAp.status === 200, cAp.status + " " + cAp.text.slice(0, 200));
  const cm = await post("/api/boards/" + CBID + "/meetings", { title: "ctx-m1" });
  const CMID = val(cm.json, "id");
  const cwr = await post("/api/boards/" + CBID + "/wiki-resources", { baseUrl: WIKIBASE, description: "ctx handbook", allowedUse: LONG_USE, scope: "board", allowlist: ["/guides/**"], manualOnly: true, token: TOKEN });
  const CRID = val(cwr.json, "id");
  await post("/api/wiki-resources/" + CRID + "/enable", {});
  await post("/api/wiki-resources/" + CRID + "/sync", {});
  const crev = await get("/api/boards/" + CBID + "/sources/review");
  const cflat = (Array.isArray(crev.json) ? crev.json : []).filter((g) => low(g).origin === "wiki").flatMap((g) => (g.versions || g.Versions || []));
  for (const d of cflat) { await post("/api/sources/" + val(d, "id") + "/approve", {}); }
  await post("/api/meetings/" + CMID + "/resume", {});
  await fetch((process.env.QA_FAKE || "http://127.0.0.1:5199") + "/__log", { method: "DELETE" }).catch(() => {});
  const runRes = await post("/api/meetings/" + CMID + "/run", { policy: "balanced", prompt: "Alpha handbook retrieval" }, { timeout: 90000 });
  ok("tF8-run-ok", runRes.status === 200, "advisor run failed: " + runRes.status + " " + (runRes.text || "").slice(0, 300));
  const plog = await (await fetch((process.env.QA_FAKE || "http://127.0.0.1:5199") + "/__log")).json().catch(() => []);
  const yourTurn = (Array.isArray(plog) ? plog : []).filter((e) => e && e.draft && typeof e.full === "string");
  ok("tF8-prompt-captured", yourTurn.length > 0, "no YOUR TURN prompt reached the fake provider");
  const pkt = yourTurn.map((e) => e.full).join("\n");
  ok("tF8-guidance-complete", pkt.includes(LONG_USE), "complete permitted-use text missing from model context");
  ok("tF8-guidance-beyond-300", pkt.includes("CONDITION-BEYOND-300"), "post-300 condition missing from model context");
  const guideCount = (pkt.match(/WIKI PERMITTED USE/g) || []).length;
  ok("tF8-guidance-once", guideCount === 1, "guidance must appear once per resource, found " + guideCount);
  ok("tF8-no-cred-in-context", !pkt.includes(TOKEN) && !/protectedtoken/i.test(pkt), "credential leaked into model context");
}
await sleep(2500);
console.log("BACKEND-QA pass=" + pass + " fail=" + fail);
if (failures.length) console.log("FAILURES:\n" + failures.join("\n"));
process.exit(fail ? 1 : 0);






