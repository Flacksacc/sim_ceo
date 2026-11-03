
// Phase7 PG QA (PG API :5112 + container :15439). Restart + backup + schedule.
import fs from "node:fs";
import crypto from "node:crypto";
const API = process.env.QA_API || "http://127.0.0.1:5112";
const WIKI = process.env.QA_WIKI || "http://127.0.0.1:5201";
const TOKEN = "qa-wiki-token-plain";
const MODE = process.argv.includes("--recheck") ? "recheck" : "setup";
let pass = 0, fail = 0;
const failures = [];
function ok(n, c, e) { if (c) pass++; else { fail++; failures.push(n + (e ? " :: " + e : "")); console.log("  FAIL " + n + (e ? " :: " + e : "")); } }
async function api(method, path, body) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 30000);
  try {
    const r = await fetch(API + path, { method, signal: ctl.signal, headers: { "content-type": "application/json", "x-user": "owner" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  } finally { clearTimeout(t); }
}
const low = (o) => { const m = {}; if (o && typeof o === "object") for (const k of Object.keys(o)) m[k.toLowerCase()] = o[k]; return m; }
const val = (o, k) => low(o)[String(k).toLowerCase()];
if (MODE === "setup") {
  let r = await api("GET", "/ready");
  ok("pg-ready-postgres", r.status === 200 && (low(r.json).store === "postgres"), JSON.stringify(r.json));
  let b = await api("POST", "/api/boards", { name: "wiki-pg-board" });
  const BID = b.json.id || b.json.Id;
  let m = await api("POST", "/api/boards/" + BID + "/meetings", { title: "pg-m1" });
  const MID = m.json.id || m.json.Id;
  let wr = await api("POST", "/api/boards/" + BID + "/wiki-resources", { baseUrl: WIKI + "/", description: "pg seed", allowedUse: "pg lookup", scope: "board", allowlist: ["/guides/**"], token: TOKEN });
  ok("pg-create", wr.status === 200 || wr.status === 201, wr.status + " " + wr.text.slice(0, 200));
  const RID = wr.json.id || wr.json.Id;
  await api("PATCH", "/api/wiki-resources/" + RID, { token: TOKEN });
  await api("POST", "/api/wiki-resources/" + RID + "/enable", {});
  await fetch(WIKI + "/__control?mode=normal&singleDelayMs=0&listDelayMs=0");
  let sy = await api("POST", "/api/wiki-resources/" + RID + "/sync", {});
  ok("pg-sync", sy.status === 200, sy.status + " " + sy.text.slice(0, 300));
  ok("pg-ids-preserved", (sy.json.id || sy.json.Id) === RID, "sync returned wrong row");
  let rev = await api("GET", "/api/boards/" + BID + "/sources/review");
  const flat = (Array.isArray(rev.json) ? rev.json : []).filter((g) => (low(g).origin === "wiki")).flatMap((g) => g.versions || []);
  const alpha = flat.find((d) => String((low(d).filename || low(d).fileName || "")).includes("alpha"));
  ok("pg-docs", flat.length === 2 && !!alpha, "docs=" + flat.length);
  const aid = (low(alpha).id);
  let ap = await api("POST", "/api/sources/" + aid + "/approve", {});
  ok("pg-approve", ap.status === 200, ap.status);
  let ix = await api("GET", "/api/sources/" + aid + "/index");
  ok("pg-eligible", (low(ix.json).eligible) === true, JSON.stringify(ix.json));
  fs.mkdirSync(".tmp", { recursive: true });
  fs.writeFileSync(".tmp/wiki-pg-ids.txt", BID + "\n" + MID + "\n" + RID + "\n" + aid + "\n");
  console.log("PG-SETUP pass=" + pass + " fail=" + fail);
  process.exit(fail ? 1 : 0);
} else {
  const [BID, MID, RID, AID] = fs.readFileSync(".tmp/wiki-pg-ids.txt", "utf-8").split("\n").map((s) => s.trim()).filter(Boolean);
  let r = await api("GET", "/ready");
  ok("pg-ready-after-restart", r.status === 200 && low(r.json).store === "postgres", JSON.stringify(r.json));
  r = await api("GET", "/api/wiki-resources/" + RID);
  ok("pg-resource-persisted", r.status === 200 && (low(r.json).status === "succeeded"), r.status + " " + r.text.slice(0, 300));
  ok("pg-membership-persisted", ((low(r.json).importedpages ?? low(r.json).importedPages ?? low(r.json).sourceDocs ?? 0) === 2) && ((low(r.json).usablepages ?? low(r.json).usablePages) === 1), "alpha approved, beta pending: " + r.text.slice(0, 300));
  ok("pg-alloweduse-persisted", ((low(r.json).alloweduse ?? low(r.json).allowedUse) === "pg lookup"), r.text.slice(0, 200));
  r = await api("GET", "/api/sources/" + AID + "/index");
  ok("pg-eligible-after-restart", low(r.json).eligible === true, JSON.stringify(r.json));
  r = await api("POST", "/api/wiki-resources/" + RID + "/sync", {});
  ok("pg-idempotent-resync", r.status === 200, r.status + " " + r.text.slice(0, 200));
  let rev = await api("GET", "/api/boards/" + BID + "/sources/review");
  const flat = (Array.isArray(rev.json) ? rev.json : []).filter((g) => low(g).origin === "wiki").flatMap((g) => g.versions || []);
  ok("pg-no-dupes", flat.length === 2, "docs=" + flat.length);
  // Backup exact configuration/history/source graph on PG; restore disabled + blocked.
  let bk = await api("GET", "/api/backup");
  const snap = (bk.json.snapshot || bk.json.Snapshot || "");
  ok("pg-backup-has-wiki", snap.includes("wikiResources") && snap.includes("boardId"), "no wikiResources");
  ok("pg-backup-no-secret", !snap.includes(TOKEN), "secret leaked");
  const normB = (x) => String(x||"").replace(/([{,])"at":"[^"]*"/, "$1\"at\":\"FIXED\"");
  const sh = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
  async function pgCanon() {
    const rl = await api("GET", "/api/boards/" + BID + "/wiki-resources");
    const res = (Array.isArray(rl.json) ? rl.json : []).map((x) => { const l = low(x); return { id: val(x, "id"), url: l.baseurl, rev: l.configrevision, iv: l.syncintervalminutes, created: l.createdat, en: l.enabled, st: l.status, cred: l.hascredential, usable: l.usablepages }; }).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const rv = await api("GET", "/api/boards/" + BID + "/sources/review");
    const flat = (Array.isArray(rv.json) ? rv.json : []).filter((g) => low(g).origin === "wiki").flatMap((g) => g.versions || []).map((d) => ({ id: val(d, "id"), fam: val(d, "familyKey"), v: val(d, "version"), h: val(d, "contentHash"), rs: (val(d, "reviewState") || "").toLowerCase() })).sort((a, b) => String(a.fam).localeCompare(String(b.fam)));
    return { res, rows: flat };
  }
  const C0 = await pgCanon();
  const h = (bk.json.hash || bk.json.Hash || "");
  ok("pg-backup-hash", h === sh(snap), "hash mismatch");
  let rs = await api("POST", "/api/backup/restore", { snapshot: snap, hash: h });
  ok("pg-restore-ok", rs.status === 200, rs.status + " " + rs.text.slice(0, 200));
  const C1 = await pgCanon();
  ok("pg-roundtrip-config", JSON.stringify(C1.res.map(({ en, st, cred, usable, ...rest }) => rest)) === JSON.stringify(C0.res.map(({ en, st, cred, usable, ...rest }) => rest)), "PG config/history changed");
  ok("pg-roundtrip-sources", JSON.stringify(C1.rows) === JSON.stringify(C0.rows), "PG source graph changed");
  ok("pg-restored-disabled", C1.res.every((x) => x.en === false && x.st === "disabled" && x.cred === false && x.usable === 0), "restored health not reset: " + JSON.stringify(C1.res).slice(0, 300));
  // Malformed correct-hash graphs reject before any clear; bytes unchanged.
  const bads = [
    ["pg-reject-noid", (o) => { delete o.wikiResources[0].id; }],
    ["pg-reject-scope", (o) => { o.wikiResources[0].scope = "global"; }],
    ["pg-reject-rule-json", (o) => { o.wikiResources[0].allowlistJson = "["; }],
  ];
  for (const [nm, mut] of bads) {
    const oo = JSON.parse(snap);
    mut(oo);
    const bs = JSON.stringify(oo);
    const beforeB = normB(val((await api("GET", "/api/backup")).json, "snapshot"));
    const rb = await api("POST", "/api/backup/restore", { snapshot: bs, hash: sh(bs) });
    const aftB = normB(val((await api("GET", "/api/backup")).json, "snapshot"));
    ok(nm, rb.status === 400 && aftB === beforeB, nm + " got " + rb.status);
  }
  // Storage failure mid-apply rolls back on PG (Atomic transaction).
  const pObj = JSON.parse(snap);
  pObj.messages["00000000-0000-0000-0000-000000000001"] = null;
  const pBad = JSON.stringify(pObj);
  const preP = await pgCanon();
  const preB = normB(val((await api("GET", "/api/backup")).json, "snapshot"));
  const pr = await api("POST", "/api/backup/restore", { snapshot: pBad, hash: sh(pBad) });
  const postB = normB(val((await api("GET", "/api/backup")).json, "snapshot"));
  ok("pg-poison-rolled-back", pr.status === 500 && postB === preB, "PG restore did not roll back: " + pr.status);
  ok("pg-poison-identities", JSON.stringify(await pgCanon()) === JSON.stringify(preP), "PG state changed despite rollback");
  // Legacy version-1 snapshot restores, then the exact snapshot restores back deterministically.
  const v1 = JSON.parse(snap);
  delete v1.wikiResources;
  v1.version = 1;
  const v1s = JSON.stringify(v1);
  const v1r = await api("POST", "/api/backup/restore", { snapshot: v1s, hash: sh(v1s) });
  ok("pg-v1-accepted", v1r.status === 200, "v1 restore got " + v1r.status + " " + v1r.text.slice(0, 200));
  const back = await api("POST", "/api/backup/restore", { snapshot: snap, hash: sh(snap) });
  ok("pg-v1-roundtrip-back", back.status === 200, back.status);
  const C2 = await pgCanon();
  ok("pg-v1-deterministic", JSON.stringify(C2) === JSON.stringify(C1), "v1 detour changed state");
  // Authority on PG: delete the RETURNED grant id, then the same user is denied reads/writes.
  await api("POST", "/api/boards/" + BID + "/grants", { userKey: "pgkeeper", access: "read", meetingId: MID });
  const gP = await api("POST", "/api/boards/" + BID + "/grants", { userKey: "pgrevoked", access: "read", meetingId: MID });
  const pgGid = val(gP.json, "id");
  ok("tpg-grant-created", !!pgGid, gP.status + " " + gP.text.slice(0, 160));
  const pgGuest = (method, path, body) => (async () => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 30000);
    try {
      const rr = await fetch(API + path, { method, signal: ctl.signal, headers: { "content-type": "application/json", "x-user": "pgrevoked" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await rr.text();
      let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
      return { status: rr.status, json, text };
    } finally { clearTimeout(t); }
  })();
  const pgDel = await api("DELETE", "/api/grants/" + pgGid, undefined);
  ok("pg-revoke-deleted", pgDel.status === 204 || pgDel.status === 200, "delete returned " + pgDel.status);
  const pgList = await api("GET", "/api/boards/" + BID + "/grants");
  ok("pg-revoke-gone", Array.isArray(pgList.json) && !pgList.json.map((g) => val(g, "id")).includes(pgGid), "grant still listed");
  const pgRevList = await pgGuest("GET", "/api/boards/" + BID + "/wiki-resources", undefined);
  ok("pg-revoked-no-list", pgRevList.status === 200 && Array.isArray(pgRevList.json) && pgRevList.json.length === 0, "revoked user sees " + pgRevList.status + " " + pgRevList.text.slice(0, 200));
  const pgRevRead = await pgGuest("GET", "/api/wiki-resources/" + RID, undefined);
  ok("pg-revoked-no-read", pgRevRead.status === 403, "revoked read returned " + pgRevRead.status);
  // Manual-only schedule: no auto NextSyncAt (incl. after restart).
  await api("PATCH", "/api/wiki-resources/" + RID, { manualOnly: true });
  let mo = await api("GET", "/api/wiki-resources/" + RID);
  ok("pg-manual-null-schedule", (mo.json.nextSyncAt == null && mo.json.NextSyncAt == null), JSON.stringify(mo.json).slice(0, 200));
  await api("PATCH", "/api/wiki-resources/" + RID, { manualOnly: false });
  console.log("PG-RECHECK pass=" + pass + " fail=" + fail);
  if (failures.length) console.log("FAILURES:\n" + failures.join("\n"));
  process.exit(fail ? 1 : 0);
}

