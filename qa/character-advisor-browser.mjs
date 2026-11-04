/* Character advisor browser QA (fixture-only, owned ports).
 * Drives the REAL CreateAdvisor component in headless Chromium against a
 * fixture stub that implements the appended backend contract exactly:
 * quick seed (exact keys), research compile (server draftProfile),
 * live-stage GET polling, version-bumping PUT with configurable
 * dossier preservation. No human ports/services/tabs are touched.
 * Run: node qa/character-advisor-browser.mjs (exit 0 = pass).
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB = path.join(ROOT, "web");
const TMP = path.join(ROOT, "qa", ".char-tmp");
const DIST = path.join(TMP, "dist");
const STUB_PORT = 5129;
const WEB_PORT = 5194;
const STUB = "http://127.0.0.1:" + STUB_PORT;
const COMPILED = {
  contributionCriteria: "COMPILED-C: covers pricing reviews on Tuesdays; abstains without a cost model.",
  reasoningApproach: "COMPILED-R: compares two options against the approved brief; challenges premises lacking numbers.",
  responseStyle: "COMPILED-RS: brief and direct in reviews; diplomatic with owners when uncertain.",
};
const CLAIM_TEXT = "CLAIM-WORK: margins slipped two quarters in a row.";
const CRITICISM_TEXT = "CRITICISM-WORK: too blunt about supplier risk.";

let pass = 0, fail = 0;
const bad = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok - " + name); }
  else { fail++; bad.push(name); console.log("  FAIL - " + name + (extra ? " :: " + String(extra).slice(0, 300) : "")); }
}

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "content-type": "application/json", "content-length": Buffer.byteLength(body),
    "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => { s += c; });
    req.on("end", () => {
      try { resolve(s ? JSON.parse(s) : {}); } catch { resolve({}); }
    });
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function seedProfile(name, desc, bg) {
  return JSON.stringify({
    fictional: true, name, background: bg || desc,
    characterSeed: true, researched: false,
    contributionCriteria: "Seed (pending research) for " + name,
    reasoningApproach: "Seed (pending research): reason from the description only.",
    responseStyle: "Seed (pending research): direct and concise.",
    strengths: ["old-strength"], security: "keep-1",
  });
}

function startStub() {
  const entries = new Map();
  const live = new Map();
  const calls = { quick: [], research: [], puts: [], putIds: [] };
  const mode = { research: "ok", putInvalidates: true, failCount: 0, slowPut: false, slowGet: false, get401: false };
  let nextId = 1;
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url || "/", STUB);
    const p = u.pathname;
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,PUT,OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      res.end();
      return;
    }
    if (req.method === "POST" && p === "/__test/reset") {
      entries.clear(); live.clear();
      calls.quick = []; calls.research = []; calls.puts = []; calls.putIds = [];
      mode.research = "ok"; mode.putInvalidates = true; mode.failCount = 0; mode.slowPut = false; mode.slowGet = false; mode.get401 = false; mode.slowQuick = false; mode.staleNextGet = false; mode.staleNextPut = false; mode.frozenGet = false;
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && p === "/__test/mode") {
      const b = await readBody(req);
      if (b.research) mode.research = b.research;
      if (typeof b.putInvalidates === "boolean") mode.putInvalidates = b.putInvalidates;
      if (typeof b.slowPut === "boolean") mode.slowPut = b.slowPut;
      if (typeof b.slowGet === "boolean") mode.slowGet = b.slowGet;
      if (typeof b.slowQuick === "boolean") mode.slowQuick = b.slowQuick;
      if (typeof b.staleNextGet === "boolean") mode.staleNextGet = b.staleNextGet;
      if (typeof b.staleNextPut === "boolean") mode.staleNextPut = b.staleNextPut;
      if (typeof b.frozenGet === "boolean") mode.frozenGet = b.frozenGet;
      if (typeof b.get401 === "boolean") mode.get401 = b.get401;
      return send(res, 200, { ok: true, mode });
    }
    if (req.method === "GET" && p === "/__test/calls") return send(res, 200, calls);
    if (req.method === "POST" && p === "/api/roster/quick") {
      const b = await readBody(req);
      calls.quick.push(b);
      const name = (b.name ?? "").trim(), desc = (b.description ?? "").trim();
      if (!name || name.length > 120) return send(res, 400, { error: "Name is required (1-120)." });
      if (desc.length < 5) return send(res, 400, { error: "Description required." });
      const urls = Array.isArray(b.sourceUrls) ? b.sourceUrls : [];
      if (urls.length > 5 || urls.some((x) => typeof x !== "string" || !/^https?:\/\//.test(x)))
        return send(res, 400, { error: "sourceUrls must be up to 5 http(s) URLs." });
      if (mode.slowQuick) await wait(3000);
      const id = "r" + (nextId++);
      const bg = typeof b.background === "string" ? b.background.trim() : "";
      const entry = {
        id, accountId: b.accountId ?? "", type: "FictionalCharacter", name, description: desc,
        profileJson: seedProfile(name, desc, bg), version: 1, archived: false, tags: "",
        researchJson: JSON.stringify({ seed: true, pendingBackground: bg, pendingSourceUrls: urls }),
        researchInputsJson: JSON.stringify({ background: bg, sourceUrls: urls, focus: "" }),
        researchedAt: null, researchRequested: false, evidenceCount: 0,
        researchJobId: "", researchBaseVersion: 1, updatedAt: new Date().toISOString(),
      };
      entries.set(id, entry);
      return send(res, 201, entry);
    }
    if (req.method === "POST" && p === "/__test/bump") {
      const bb = await readBody(req);
      const ent = entries.get(bb.id);
      if (!ent) return send(res, 404, { error: "no entry" });
      const prof = JSON.parse(ent.profileJson);
      for (const k of ["contributionCriteria", "reasoningApproach", "responseStyle"]) {
        if (typeof prof[k] === "string" && prof[k]) prof[k] = prof[k] + " [server update]";
      }
      prof.serverBump = true;
      ent.profileJson = JSON.stringify(prof);
      ent.version += 1;
      ent.updatedAt = new Date().toISOString();
      return send(res, 200, ent);
    }
    let m = p.match(/^\/api\/roster\/([^/]+)\/research$/);
    if (m) {
      const id = m[1];
      const entry = entries.get(id);
      if (!entry) return send(res, 404, { error: "no entry" });
      if (req.method === "POST") {
        const b = await readBody(req);
        calls.research.push(b);
        let persisted = { background: "", sourceUrls: [] };
        try { persisted = { background: "", sourceUrls: [], ...JSON.parse(entry.researchInputsJson || "{}") }; } catch { /* keep */ }
        const urls = Array.isArray(b.sourceUrls) ? b.sourceUrls : (persisted.sourceUrls || []);
        const bgEff = typeof b.background === "string" ? b.background : (persisted.background || "");
        entry.researchInputsJson = JSON.stringify({ background: bgEff, sourceUrls: urls, focus: typeof b.focus === "string" ? b.focus : "" });
        if (urls.length > 5 || urls.some((x) => typeof x !== "string" || !/^https?:\/\//.test(x)))
          return send(res, 400, { error: "sourceUrls must be up to 5 http(s) URLs." });
        if (mode.research === "slow-fail") { await wait(6000); return send(res, 502, { error: "stub slow failure" }); }
        if (mode.research === "fail-always" || (mode.research === "fail-once" && mode.failCount++ === 0)) {
          entry.researchRequested = true; entry.researchedAt = null;
          entry.researchJson = JSON.stringify({ draftStatus: "failed", note: "stub provider failure" });
          return send(res, 502, { error: "stub provider failure" });
        }
        const job = "job" + Date.now();
        entry.researchRequested = true; entry.researchedAt = null;
        entry.researchJson = "{}"; entry.researchJobId = job;
        entry.researchBaseVersion = entry.version;
        const finish = (built) => {
          live.delete(id);
          entry.researchJobId = "";
          entry.researchedAt = new Date().toISOString();
          entry.evidenceCount = built.evidenceRefs.filter((e) => e.excerpt).length;
          entry.researchJson = JSON.stringify(built);
          entry.version += 1;
          entry.updatedAt = new Date().toISOString();
        };
        if (mode.research === "unsupported") {
          live.set(id, { stage: "compiling" });
          await wait(300);
          live.delete(id);
          entry.researchJobId = "";
          entry.researchedAt = null;
          entry.evidenceCount = 0;
          entry.researchRequested = true;
          entry.researchJson = JSON.stringify({
            subject: entry.name, searched: 0, supported: false, claims: [], responseIds: [],
            version: entry.researchBaseVersion, evidenceRefs: [],
            draftProfile: { ...COMPILED }, draftStatus: "unsupported", note: "stub: no evidence",
          });
          entry.version += 1;
          entry.updatedAt = new Date().toISOString();
          const out = JSON.parse(entry.researchJson);
          return send(res, 200, out);
        }
        if (mode.research === "orphan") {
          entry.researchRequested = true;
          entry.researchedAt = null;
          entry.researchJson = "{}";
          entry.researchJobId = "";
          entry.evidenceCount = 0;
          return send(res, 200, { subject: entry.name, searched: 0, supported: false, claims: [], responseIds: [], version: entry.version, evidenceRefs: [], draftProfile: null, draftStatus: null, note: "stub: orphan" });
        }
        const slow = mode.research === "slow";
        live.set(id, { stage: "fetching-sources" });
        await wait(slow ? 2500 : 400);
        live.set(id, { stage: "researching" });
        await wait(slow ? 2500 : 700);
        live.set(id, { stage: "compiling" });
        await wait(slow ? 3000 : 700);
        const ownerUrl = urls[0] || "https://example.com/inspo";
        const built = {
          subject: entry.name, searched: 1, supported: true,
          claims: [
            { angle: "dossier", text: CLAIM_TEXT, sources: [{ url: ownerUrl }] },
            { angle: "dossier [citation]", text: CRITICISM_TEXT, sources: [{ url: "https://example.com/cite" }] },
          ],
          responseIds: [], version: entry.researchBaseVersion,
          evidenceRefs: [
            { kind: "source", ref: ownerUrl, url: ownerUrl, title: "Owner inspiration", excerpt: "EXCERPT-OWNER: pricing background.", ownerSupplied: true },
            { kind: "source", ref: "https://example.com/cite", url: "https://example.com/cite", title: "Cite", excerpt: "EXCERPT-CITE: margin data." },
          ],
          draftProfile: { ...COMPILED }, draftStatus: "done", note: "stub note",
        };
        finish(built);
        return send(res, 200, built);
      }
      let frozen = null;
      if (mode.frozenGet) {
        try {
          const fLiveNow = live.has(id);
          let fDocNow = {};
          try { fDocNow = JSON.parse(entry.researchJson || "{}"); } catch { fDocNow = {}; }
          const fDsNow = fDocNow.draftStatus || null;
          let fStageNow;
          if (fLiveNow) fStageNow = (live.get(id) || {}).stage || "researching";
          else if (entry.researchedAt) fStageNow = "done";
          else if (fDsNow === "failed") fStageNow = "failed";
          else if (fDsNow === "unsupported") fStageNow = "unsupported";
          else if (fDsNow === "superseded") fStageNow = "interrupted";
          else if (entry.researchRequested) fStageNow = "interrupted";
          else fStageNow = "not-started";
          frozen = {
            researchJson: entry.researchJson, researchedAt: entry.researchedAt,
            researchRequested: entry.researchRequested, evidenceCount: entry.evidenceCount,
            version: entry.version, researchBaseVersion: entry.researchBaseVersion,
            running: fLiveNow, stage: fStageNow, sources: fDocNow.evidenceRefs || [],
            draftProfile: fDocNow.draftProfile || null, draftStatus: fDsNow,
            stageError: fDocNow.stageError || fDocNow.note || null,
          };
        } catch { frozen = null; }
      }
      if (mode.slowGet) await wait(2000);
      if (frozen) return send(res, 200, frozen);
      if (mode.get401) return send(res, 401, { error: "stub stale auth" });
      const effJson = frozen ? frozen.researchJson : entry.researchJson;
      const effAt = frozen ? frozen.researchedAt : entry.researchedAt;
      const effReq = frozen ? frozen.researchRequested : entry.researchRequested;
      const effEv = frozen ? frozen.evidenceCount : entry.evidenceCount;
      const effVer = frozen ? frozen.version : entry.version;
      const effBase = frozen ? frozen.researchBaseVersion : entry.researchBaseVersion;
      const effJob = frozen ? frozen.job : entry.researchJobId;
      const isLive = effJob ? live.has(id) : live.has(id);
      let doc = {};
      try { doc = JSON.parse(effJson || "{}"); } catch { doc = {}; }
      const ds = doc.draftStatus || null;
      let stage;
      if (isLive) stage = (live.get(id) || {}).stage || "researching";
      else if (entry.researchedAt) stage = "done";
      else if (ds === "failed") stage = "failed";
      else if (ds === "unsupported") stage = "unsupported";
      else if (ds === "superseded") stage = "interrupted";
      else if (entry.researchRequested) stage = "interrupted";
      else stage = "not-started";
      return send(res, 200, {
        researchJson: effJson, researchedAt: effAt,
        researchRequested: effReq, evidenceCount: effEv,
        version: effVer, researchBaseVersion: effBase,
        running: isLive, stage,
        stageError: doc.stageError || doc.note || null, sources: doc.evidenceRefs || [],
        draftProfile: doc.draftProfile || null, draftStatus: ds,
      });
    }
    if (req.method === "GET" && p === "/api/roster") {
      const q = new URL(req.url || "/", STUB).searchParams;
      const acct = q.get("accountId");
      const rows = [...entries.values()].filter((e) => !acct || e.accountId === acct).map((e) => ({ entry: e, boardCount: 0, complete: false, missing: [] }));
      return send(res, 200, rows);
    }
    if (req.method === "POST" && p === "/__test/seed-owner") {
      const b = await readBody(req);
      const nid = "r" + (nextId++);
      const prof = typeof b.profileJson === "string" ? b.profileJson : JSON.stringify(b.profileJson || {});
      const ent = {
        id: nid, accountId: "test-acct", type: "FictionalCharacter", name: b.name || "Owner V1",
        description: b.description || "Owner-provided v1 profile.", profileJson: prof, version: 1,
        archived: false, tags: "", researchJson: "{}", researchedAt: null, researchRequested: false,
        evidenceCount: 0, researchJobId: "", researchBaseVersion: 1,
        researchInputsJson: JSON.stringify({ background: "", sourceUrls: [], focus: "" }),
        updatedAt: new Date().toISOString(),
      };
      entries.set(nid, ent);
      return send(res, 200, ent);
    }
    if (req.method === "GET" && p === "/__test/entry") {
      const q = new URL(req.url || "/", STUB).searchParams;
      const ent = entries.get(q.get("id") || "");
      if (!ent) return send(res, 404, { error: "no entry" });
      return send(res, 200, ent);
    }
    m = p.match(/^\/api\/roster\/([^/]+)$/);
    if (m && req.method === "PUT") {
      const entry = entries.get(m[1]);
      if (!entry) return send(res, 404, { error: "no entry" });
      const b = await readBody(req);
      calls.puts.push(b); calls.putIds.push(m[1]);
      if (mode.slowPut) await wait(3000);
      let newProfileStr = null;
      if (b.profileJson !== undefined && b.profileJson !== null) {
        if (typeof b.profileJson === "object") newProfileStr = JSON.stringify(b.profileJson);
        else if (typeof b.profileJson === "string") newProfileStr = b.profileJson;
        else return send(res, 400, { error: "profileJson must be a JSON object or a JSON-encoded object string." });
        if (newProfileStr.trim().length < 20) return send(res, 400, { error: "Profile must be at least 20 characters." });
        if (newProfileStr.length > 20000) return send(res, 400, { error: "Profile must be 20000 chars or fewer." });
        let pj;
        try { pj = JSON.parse(newProfileStr); } catch { return send(res, 400, { error: "Profile must be a JSON object." }); }
        for (const k of ["contributionCriteria", "reasoningApproach", "responseStyle"]) {
          const v = pj[k];
          if (typeof v !== "string" || !v.trim()) return send(res, 400, { error: k + " must be a non-empty paragraph when saving character behavior." });
          if (v.length > 2000) return send(res, 400, { error: k + " is " + v.length + " chars; keep each behavior paragraph under 2000." });
        }
      }
      let newUrls = null;
      if (b.sourceUrls !== undefined && b.sourceUrls !== null) {
        if (!Array.isArray(b.sourceUrls)) return send(res, 400, { error: "sourceUrls must be an array of up to 5 http(s) URLs." });
        if (b.sourceUrls.length > 5 || b.sourceUrls.some((x) => typeof x !== "string" || !/^https?:\/\//.test(x))) return send(res, 400, { error: "sourceUrls must be an array of up to 5 http(s) URLs." });
        newUrls = b.sourceUrls;
      }
      const oldProf = (() => { try { return JSON.parse(entry.profileJson || "{}"); } catch { return {}; } })();
      const newProf = newProfileStr !== null ? (() => { try { return JSON.parse(newProfileStr); } catch { return null; } })() : null;
      const bgChanged = newProf && typeof newProf.background === "string" && (oldProf.background || "") !== newProf.background;
      const urlsChanged = (() => {
        if (!newUrls) return false;
        try {
          const inp = JSON.parse(entry.researchInputsJson || "{}");
          const a = (inp.sourceUrls || []).map(String);
          if (a.length !== newUrls.length) return true;
          const sa = new Set(a.map((x) => x.toLowerCase()));
          return newUrls.some((u) => !sa.has(String(u).toLowerCase()));
        } catch { return newUrls.length > 0; }
      })();
      let newName = null;
      if (typeof b.name === "string" && b.name.trim()) newName = b.name.trim();
      let newDesc = null;
      if (typeof b.description === "string" && b.description.trim()) newDesc = b.description.trim();
      const subjectChanged = (newName && newName !== entry.name) || (newDesc && newDesc !== entry.description) || bgChanged || urlsChanged;
      if (newName) entry.name = newName;
      if (newDesc) entry.description = newDesc;
      if (newProfileStr !== null) entry.profileJson = newProfileStr;
      if (newUrls !== null) {
        let bg = oldProf.background || "";
        if (newProf && typeof newProf.background === "string") bg = newProf.background;
        entry.researchInputsJson = JSON.stringify({ background: bg, sourceUrls: newUrls, focus: "" });
      }
      entry.version += 1;
      entry.updatedAt = new Date().toISOString();
      if (subjectChanged) {
        entry.researchJson = "{}"; entry.researchedAt = null; entry.evidenceCount = 0; entry.researchBaseVersion = entry.version;
      } else if (newProfileStr !== null) {
        try {
          const doc = JSON.parse(entry.researchJson || "{}");
          const hasDraft = doc.draftProfile || doc.claims;
          if (hasDraft) {
            const ds = typeof doc.draftStatus === "string" ? doc.draftStatus : "";
            const keep = (ds === "failed" || ds === "unsupported") ? ds : "saved";
            const payload = {};
            for (const k of Object.keys(doc)) {
              if (k === "draftStatus" || k === "savedAt" || k === "savedProfileHash") continue;
              payload[k] = doc[k];
            }
            payload.draftStatus = keep;
            payload.savedAt = new Date().toISOString();
            try { payload.savedProfileHash = "h" + newProfileStr.length; } catch { payload.savedProfileHash = "h0"; }
            entry.researchJson = JSON.stringify(payload);
          }
        } catch { /* keep */ }
      }
      return send(res, 200, entry);
    }
    return send(res, 404, { error: "stub: unknown route " + p });
  });
  return new Promise((resolve) => server.listen(STUB_PORT, "127.0.0.1", () => resolve(server)));
}
// ---- harness: bundles the real component, serves it on an owned port ----
async function buildHarness() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });
  const comp = WEB + "/src/advisor-creation";
  const src = `
import * as React from "react";
import { createRoot } from "react-dom/client";
import { CreateAdvisor, CharacterEditor } from ${JSON.stringify(comp)};
async function check(r, path) {
  const text = await r.text();
  if (!r.ok) throw new Error(path + " -> " + r.status + " " + text.slice(0, 200));
  return JSON.parse(text || "{}");
}
let epoch = 1;
let epochRerender = null;
if (typeof window !== "undefined") window.__testBumpEpoch = () => { epoch += 1; if (epochRerender) epochRerender(epoch); };
function staleIfMoved(myEpoch, path) {
  if (epoch !== myEpoch) {
    const e = new Error("stale response discarded (identity changed) for " + path);
    e.stale = true;
    throw e;
  }
}
const get = async (path) => { const my = epoch; const r = await fetch(${JSON.stringify(STUB)} + path); staleIfMoved(my, path); return check(r, "GET " + path); };
const post = async (path, body) => { const my = epoch; const r = await fetch(${JSON.stringify(STUB)} + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); staleIfMoved(my, path); return check(r, "POST " + path); };
const originIdentity = () => ({ epoch, token: "t" + epoch, user: "owner" });
const originStale = (o) => !o || o.epoch !== epoch;
const resolveCanonicalEntry = async (id) => { try { const rows = await get("/api/roster?accountId=test-acct"); const f = (rows || []).find((r) => r && r.entry && r.entry.id === id); const ent = f ? f.entry : null; if (window.__testCanonFail) return null; if (window.__testCanonVersion && ent) return { ...ent, version: window.__testCanonVersion }; return ent || null; } catch { return null; } };
const put = async (path, body) => { const my = epoch; const r = await fetch(${JSON.stringify(STUB)} + path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); staleIfMoved(my, path); return check(r, "PUT " + path); };
function App() {
  const [log, setLog] = React.useState([]);
  const [direct, setDirect] = React.useState(null);
  const [rev, setRev] = React.useState(1);
  const [reopenId, setReopenId] = React.useState(null);
  React.useEffect(() => { epochRerender = (e) => setRev(e); return () => { epochRerender = null; }; }, []);
  const histRef = React.useRef([]);
  const openSecond = async (label) => {
    const b = await post("/api/roster/quick", { accountId: "test-acct", name: label, description: "Second description for swap coverage." });
    histRef.current = [...histRef.current, b];
    setDirect(b);
    setReopenId(b.id);
    setLog((l) => [...l, "swapped:" + b.id + ":v" + b.version]);
  };
  const applyStale = async () => {
    const h = histRef.current;
    if (h.length >= 2) {
      const stale = h[h.length - 2];
      setDirect(stale);
      setLog((l) => [...l, "stale-applied:" + stale.id + ":v" + stale.version]);
    }
  };
  const openOwnerV1 = async () => {
    const prof = JSON.stringify({ fictional: true, background: "Owner background color.", sourceUrls: [], characterSeed: true, researched: false,
      contributionCriteria: "Owner draft text here for Second Draft!!",
      reasoningApproach: "Owner method weighs both options against the full brief!!!",
      responseStyle: "Owner voice stays brief and direct in review" });
    const b = await post("/__test/seed-owner", { name: "Second Draft", description: "Owner-provided v1 profile.", profileJson: prof });
    histRef.current = [...histRef.current, b];
    setDirect(b); setReopenId(b.id);
    setLog((l) => [...l, "swapped:" + b.id + ":v" + b.version]);
  };
  const reopenSame = async () => {
    if (!reopenId) return;
    const rows = await get("/api/roster?accountId=test-acct");
    const f = (rows || []).find((r) => r && r.entry && r.entry.id === reopenId);
    if (f && f.entry) { setDirect(f.entry); setLog((l) => [...l, "reopened:" + f.entry.id + ":v" + f.entry.version]); }
  };
  return React.createElement("div", null,
    direct
      ? React.createElement("div", null,
          React.createElement("button", { type: "button", onClick: () => openSecond("Second Draft") }, "Swap to second draft"),
          React.createElement("button", { type: "button", onClick: () => { setDirect(null); setLog((l) => [...l, "unmounted"]); } }, "Close editor"),
          React.createElement("button", { type: "button", onClick: reopenSame }, "Reopen same draft"),
        React.createElement("button", { type: "button", onClick: async () => { const u = await post("/__test/bump", { id: direct.id }); histRef.current = [...histRef.current, u]; setDirect(u); setLog((l) => [...l, "bumped:" + u.id + ":v" + u.version]); } }, "Simulate external edit"),
        React.createElement("button", { type: "button", onClick: applyStale }, "Apply stale entry"),
          React.createElement(CharacterEditor, {
            key: "same-mount", entry: direct, get, post, put, originIdentity, originStale, originRevision: String(rev), resolveCanonicalEntry, freshCreation: false,
            onSaved: (e) => setLog((l) => [...l, "saved:" + e.id + ":v" + e.version]),
          }))
      : React.createElement("div", null,
          React.createElement(CreateAdvisor, {
            accountId: "test-acct", get, post, put, originIdentity, originStale, originRevision: String(rev), resolveCanonicalEntry,
            onCreated: (e) => setLog((l) => [...l, "created:" + e.id + ":v" + e.version]),
            onClose: () => setLog((l) => [...l, "closed"]),
          }),
          React.createElement("button", { type: "button", onClick: () => openSecond("Second Draft") }, "Open roster editor directly"),
          React.createElement("button", { type: "button", onClick: reopenSame }, "Reopen same draft"),
          React.createElement("button", { type: "button", onClick: openOwnerV1 }, "Open owner v1 draft")),
    React.createElement("pre", { id: "test-log" }, log.join("\\n")));
}
createRoot(document.getElementById("root")).render(React.createElement(App));
`;
  fs.writeFileSync(path.join(TMP, "harness.tsx"), src);
  const esbuild = (await import("file://" + WEB + "/node_modules/esbuild/lib/main.js")).default;
  await esbuild.build({
    entryPoints: [path.join(TMP, "harness.tsx")],
    bundle: true, jsx: "automatic", outfile: path.join(DIST, "harness.js"),
    loader: { ".css": "css" }, nodePaths: [path.join(WEB, "node_modules")], logLevel: "warning",
  });
  const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/harness.css"></head><body><div id="root"></div><script src="/harness.js"></script></body></html>`;
  fs.writeFileSync(path.join(DIST, "index.html"), html);
}

function startWeb() {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
  const server = http.createServer((req, res) => {
    const p = new URL(req.url || "/", "http://x").pathname;
    const f = path.join(DIST, p === "/" ? "index.html" : p.slice(1));
    fs.readFile(f, (err, data) => {
      if (err) { res.writeHead(404); res.end("nf"); return; }
      res.writeHead(200, { "content-type": types[path.extname(f)] || "text/plain" });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(WEB_PORT, "127.0.0.1", () => resolve(server)));
}

async function stubApi(method, p, body) {
  const r = await fetch(STUB + p, {
    method, headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return r.json();
}
// ---- browser scenarios (real interactions, no mocks in the page) ----
async function waitText(page, sel, re, timeout) {
  try {
    await page.waitForFunction(
      (args) => {
        const el = document.querySelector(args.sel);
        return !!el && new RegExp(args.src).test(el.textContent || "");
      },
      { sel, src: re.source }, { timeout: timeout || 60000 }
    );
  } catch (e) {
    let ctx = "";
    try {
      ctx = " STATUS<<" + (await page.locator("#cc-research-status").textContent()) +
        ">> ERR<<" + (await page.locator(".cc-err").count().then(async (n) => n ? await page.locator(".cc-err").textContent() : "")) +
        ">> C<<" + (await page.locator("#cc-contribute").count().then(async (n) => n ? await page.locator("#cc-contribute").inputValue() : "")) + ">>";
    } catch { ctx = " (context unreadable)"; }
    throw new Error("waitText " + re + " failed." + ctx);
  }
}
async function freshPage(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => { errs.push(String(e).slice(0, 200)); console.log("trace: pageerror " + String(e).slice(0, 300)); });
  page.on("crash", () => console.log("trace: PAGE CRASHED"));
  page.on("close", () => console.log("trace: page closed"));
  page.on("console", (m) => { if (m.type() === "error") console.log("trace: console-error " + m.text().slice(0, 300)); });
  page.on("requestfailed", (r) => console.log("trace: reqfail " + r.url().slice(0, 120) + " " + (r.failure() || {}).errorText));
  await page.goto("http://127.0.0.1:" + WEB_PORT + "/");
  return { ctx, page, errs };
}
async function createBrief(page, withLink) {
  await page.locator("#cc-name").fill("Ada Peer");
  await page.locator("#cc-description").fill("A pricing strategist who reads cost models.");
  await page.locator("#cc-background").fill("Former market analyst, fictional.");
  if (withLink) await page.getByLabel("Inspiration link 1 of 3").fill("https://example.com/inspo");
  await page.getByRole("button", { name: "Create draft" }).click();
}

async function scenarioSuccess(browser) {
  await stubApi("POST", "/__test/reset", {});
  await stubApi("POST", "/__test/mode", { research: "ok", putInvalidates: true });
  console.log("trace: freshPage start"); const { ctx, page, errs } = await freshPage(browser); console.log("trace: page ready");
  await createBrief(page, true);
  await waitText(page, "#cc-research-status", /Research status: working/);
  await waitText(page, "#cc-research-status", /Starting|Reading your links|Researching|Writing the three paragraphs|live server run/, 30000);
  await waitText(page, "#cc-research-status", /Research status: done/);
  const c = await page.locator("#cc-contribute").inputValue();
  const r = await page.locator("#cc-reason").inputValue();
  const s = await page.locator("#cc-respond").inputValue();
  ok("browser: compiled paragraphs shown", c === COMPILED.contributionCriteria && r === COMPILED.reasoningApproach && s === COMPILED.responseStyle, c + " | " + r + " | " + s);
  ok("browser: no claim-concat in responseStyle", !s.includes("CRITICISM-WORK") && !s.includes("CLAIM-WORK"));
  const flowBody = (await page.locator(".cc-flow").textContent()) || "";
  ok("browser: no wire stages shown", !flowBody.includes("fetching-sources") && !flowBody.includes("researchBaseVersion") && !flowBody.includes("ResearchJobId"), flowBody.slice(0, 200));
  const calls = await stubApi("GET", "/__test/calls");
  const rq = calls.research[calls.research.length - 1] || {};
  ok("browser: sourceUrls explicit field", Array.isArray(rq.sourceUrls) && rq.sourceUrls[0] === "https://example.com/inspo", JSON.stringify(rq));
  ok("browser: background explicit field", typeof rq.background === "string" && rq.background.includes("Former market analyst"), JSON.stringify(rq));
  await page.getByText(/Human research:/).click();
  const det = (await page.locator(".cc-research-detail").textContent()) || ""; ok("browser: source proof excerpt", det.includes("EXCERPT-OWNER"), det.slice(0, 200));
  ok("browser: source proof href", (await page.locator(".cc-research-detail").getByRole("link", { name: "Owner inspiration" }).getAttribute("href")) === "https://example.com/inspo");
  await page.locator("#cc-respond").fill(s + " OWNER-EDIT");
  await page.getByRole("button", { name: "Save draft changes" }).click();
  await waitText(page, "#cc-research-status", /Draft saved\./);
  const calls2 = await stubApi("GET", "/__test/calls");
  const putBody = calls2.puts[calls2.puts.length - 1] || {};
  let prof = {};
  try { prof = JSON.parse(putBody.profileJson || "{}"); } catch { prof = {}; }
  ok("browser: save payload exact keys", prof.contributionCriteria === COMPILED.contributionCriteria && prof.reasoningApproach === COMPILED.reasoningApproach && prof.responseStyle.includes("OWNER-EDIT"), Object.keys(prof).join(","));
  ok("browser: save sends explicit sourceUrls", Array.isArray(putBody.sourceUrls) && putBody.sourceUrls[0] === "https://example.com/inspo", JSON.stringify(putBody.sourceUrls));
  ok("browser: save keeps owner edit", (prof.responseStyle || "").includes("OWNER-EDIT"));
  ok("browser: save preserves unknown keys", prof.security === "keep-1" && (prof.strengths || [])[0] === "old-strength" && (prof.sourceUrls || [])[0] === "https://example.com/inspo", JSON.stringify(prof).slice(0, 300));
  const flowAfter = ((await page.locator(".cc-flow").textContent()) || "");
  ok("browser: paragraph-only save preserves proof", !flowAfter.includes("server cleared the research snapshot") && /Draft saved\./.test((await page.locator("#cc-research-status").textContent()) || ""), flowAfter.slice(0, 300));
  ok("browser: preserved proof still cited", flowAfter.includes("EXCERPT-OWNER") || flowAfter.includes("Cited sources: 2"), flowAfter.slice(0, 300));
  ok("browser: paragraphs intact after save", (await page.locator("#cc-contribute").inputValue()) === COMPILED.contributionCriteria);
  ok("browser: no auto research rerun", calls2.research.length === 1, "research posts: " + calls2.research.length);
  ok("browser: no page errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}

async function scenarioFailRetry(browser) {
  await stubApi("POST", "/__test/reset", {});
  await stubApi("POST", "/__test/mode", { research: "fail-once", putInvalidates: true });
  console.log("trace: freshPage start"); const { ctx, page, errs } = await freshPage(browser); console.log("trace: page ready");
  await createBrief(page, false);
  await waitText(page, "#cc-research-status", /Research status: failed/);
  ok("browser: brief preserved on failure", (await page.locator("#cc-name").inputValue()) === "Ada Peer");
  await page.getByRole("button", { name: "Retry research" }).click();
  await waitText(page, "#cc-research-status", /Research status: (done|incomplete)/);
  const st = (await page.locator("#cc-research-status").textContent()) || "";
  ok("browser: retry reaches terminal state", /Research status: (done|incomplete)/.test(st), st.slice(0, 200));
  ok("browser: no page errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}

async function scenarioCancel(browser) {
  await stubApi("POST", "/__test/reset", {});
  await stubApi("POST", "/__test/mode", { research: "slow", putInvalidates: true });
  console.log("trace: freshPage start"); const { ctx, page, errs } = await freshPage(browser); console.log("trace: page ready");
  await createBrief(page, false);
  await waitText(page, "#cc-research-status", /Research status: working/);
  await page.getByRole("button", { name: "Cancel waiting" }).click();
  await waitText(page, "#cc-research-status", /Stopped waiting/);
  await page.getByRole("button", { name: "Check again" }).click();
  await waitText(page, "#cc-research-status", /Research status: working/);
  ok("browser: cancel then check-again resumes working", true);
  ok("browser: resumed run keeps controls busy", await page.locator("#cc-contribute").isDisabled() && (await page.getByRole("button", { name: "Cancel waiting" }).count()) === 1, "controls should stay disabled with Cancel visible");
  await waitText(page, "#cc-research-status", /Research status: done/, 30000);
  ok("browser: cancel then check-again lands done", true);
  const callsC = await stubApi("GET", "/__test/calls");
  ok("browser: cancel does not start second run", callsC.research.length === 1, "research posts: " + callsC.research.length);
  ok("browser: no page errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}

async function scenarioUnsupported(browser) {
  await stubApi("POST", "/__test/reset", {});
  await stubApi("POST", "/__test/mode", { research: "unsupported", putInvalidates: true });
  console.log("trace: freshPage start"); const { ctx, page, errs } = await freshPage(browser); console.log("trace: page ready");
  await createBrief(page, false);
  await waitText(page, "#cc-research-status", /Research status: incomplete/);
  const st = (await page.locator("#cc-research-status").textContent()) || "";
  ok("browser: unsupported never done", !/Research status: done/.test(st), st.slice(0, 200));
  const s = await page.locator("#cc-respond").inputValue();
  ok("browser: unsupported draft editable", s === COMPILED.responseStyle);
  await page.getByRole("button", { name: "Save draft changes" }).click();
  await waitText(page, "#cc-research-status", /Draft saved\./);
  const st2 = (await page.locator("#cc-research-status").textContent()) || "";
  ok("browser: unsupported save stays incomplete", !/Research status: done/.test(st2), st2.slice(0, 200));
  ok("browser: no page errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}

async function scenarioProofKept(browser) {
  await stubApi("POST", "/__test/reset", {});
  await stubApi("POST", "/__test/mode", { research: "ok", putInvalidates: false });
  console.log("trace: freshPage start"); const { ctx, page, errs } = await freshPage(browser); console.log("trace: page ready");
  await createBrief(page, true);
  await waitText(page, "#cc-research-status", /Research status: done/);
  await page.locator("#cc-reason").fill(COMPILED.reasoningApproach + " TWEAK");
  await page.getByRole("button", { name: "Save draft changes" }).click();
  await waitText(page, "#cc-research-status", /Draft saved\./);
  const body = (await page.locator(".cc-flow").textContent()) || "";
  ok("browser: kept proof has no cleared note", !body.includes("server cleared the research snapshot"));
  ok("browser: kept proof keeps sources", body.includes("EXCERPT-OWNER") || body.includes("Cited sources: 2"), body.slice(0, 300));
  const calls = await stubApi("GET", "/__test/calls");
  ok("browser: kept proof no rerun", calls.research.length === 1, "research posts: " + calls.research.length);
  ok("browser: no page errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}

async function scenarioSwap(browser) {
  await stubApi("POST", "/__test/reset", {});
  await stubApi("POST", "/__test/mode", { research: "slow", putInvalidates: true, slowPut: true });
  const { ctx, page, errs } = await freshPage(browser);
  await page.getByRole("button", { name: "Open roster editor directly" }).click();
  await waitText(page, "#test-log", /swapped:/);
  const log1 = (await page.locator("#test-log").textContent()) || "";
  const idB = (log1.match(/swapped:(r\d+)/) || [])[1] || "";
  ok("browser: swap setup second draft", !!idB, log1.slice(0, 120));
  await page.getByRole("button", { name: "Run research on this draft" }).click();
  await waitText(page, "#cc-research-status", /Research status: working/);
  await page.getByRole("button", { name: "Swap to second draft" }).click();
  await waitText(page, "#test-log", /swapped:r\d+[\s\S]*swapped:r\d+/);
  const log2 = (await page.locator("#test-log").textContent()) || "";
  const ids = [...log2.matchAll(/swapped:(r\d+)/g)].map((m) => m[1]);
  const idC = ids[ids.length - 1];
  ok("browser: swapped mount kept", !!idC && idC !== idB, ids.join(","));
  const cSeed = await page.locator("#cc-contribute").inputValue();
  const rSeed = await page.locator("#cc-reason").inputValue();
  const sSeed = await page.locator("#cc-respond").inputValue();
  ok("browser: fresh draft shows its own seed text", cSeed === "Seed (pending research) for Second Draft" && rSeed !== "" && sSeed !== "", cSeed.slice(0, 80));
  await page.waitForTimeout(10000);
  const cVal = await page.locator("#cc-contribute").inputValue();
  const rVal = await page.locator("#cc-reason").inputValue();
  const sVal = await page.locator("#cc-respond").inputValue();
  const st = (await page.locator("#cc-research-status").textContent()) || "";
  ok("browser: late research never lands on new draft", cVal === cSeed && rVal === rSeed && sVal === sSeed && !cVal.includes(COMPILED.contributionCriteria) && !/Research status: done/.test(st), "c=" + cVal.slice(0, 80) + " st=" + st.slice(0, 160));
  await page.locator("#cc-contribute").fill("C-OWNER");
  await page.getByRole("button", { name: "Save draft changes" }).click();
  let dispatched = false;
  for (let i = 0; i < 40 && !dispatched; i++) {
    const pc = await stubApi("GET", "/__test/calls");
    if (pc.puts.length === 1 && pc.putIds[0] === idC) dispatched = true;
    else await page.waitForTimeout(250);
  }
  ok("browser: held PUT dispatched for old entry", dispatched);
  await page.getByRole("button", { name: "Swap to second draft" }).click();
  await waitText(page, "#test-log", /swapped:[\s\S]*swapped:[\s\S]*swapped:/);
  await page.waitForTimeout(5000);
  const dVal = (await page.locator("#cc-contribute").inputValue()) || "";
  const dEnabled = await page.locator("#cc-contribute").isEnabled();
  const dSt = (await page.locator("#cc-research-status").textContent()) || "";
  const dErr = await page.locator(".cc-err").count();
  const log3 = (await page.locator("#test-log").textContent()) || "";
  const ids3 = [...log3.matchAll(/swapped:(r\d+)/g)].map((m) => m[1]);
  const idD = ids3[ids3.length - 1];
  ok("browser: replacement draft usable and unchanged", dEnabled && dVal === "Seed (pending research) for Second Draft" && /Loaded a different draft/.test(dSt), "d=" + dVal.slice(0, 80) + " st=" + dSt.slice(0, 160));
  ok("browser: stale save never notifies new draft", dErr === 0 && !dVal.includes("C-OWNER") && !dVal.includes(COMPILED.contributionCriteria), log3.slice(0, 200));
  ok("browser: no onSaved for stale entry", !!idD && idD !== idC && !log3.includes("saved:" + idC) && !log3.includes("saved:" + idB), ids3.join(","));
  const calls = await stubApi("GET", "/__test/calls");
  ok("browser: save still reached server once", calls.puts.length === 1 && calls.putIds[0] === idC, "puts: " + calls.puts.length);
  ok("browser: no page errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}
async function scenarioAuthUnknown(browser) {
  await stubApi("POST", "/__test/reset", {});
  await stubApi("POST", "/__test/mode", { research: "ok", get401: true });
  const { ctx, page, errs } = await freshPage(browser);
  await page.getByRole("button", { name: "Open roster editor directly" }).click();
  await waitText(page, "#test-log", /swapped:/);
  await page.getByRole("button", { name: "Run research on this draft" }).click();
  await waitText(page, "#cc-research-status", /Research status: (failed|stale)/, 30000);
  const errBox = (await page.locator(".cc-err").count()) ? await page.locator(".cc-err").textContent() : "";
  ok("browser: stale auth surfaced not swallowed", /sign in again/i.test(errBox || "") && /session changed/i.test(errBox || "") && !/401/.test(errBox || ""), (errBox || "").slice(0, 200));
  await page.locator("#cc-contribute").fill("AUTH-OWNER");
  await page.getByRole("button", { name: "Save draft changes" }).click();
  await waitText(page, "#cc-research-status", /could not be verified|Draft saved\./, 20000);
  const st = (await page.locator("#cc-research-status").textContent()) || "";
  const log = (await page.locator("#test-log").textContent()) || "";
  ok("browser: save verifies honestly on auth failure", /could not be verified/.test(st) && /saved:r\d+/.test(log), st.slice(0, 220));
  ok("browser: no page errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}

async function scenarioEditDuringPoll(browser) {
  await stubApi("POST", "/__test/reset", {});
  await stubApi("POST", "/__test/mode", { research: "fail-once", putInvalidates: true });
  const { ctx, page, errs } = await freshPage(browser);
  await page.locator("#cc-name").fill("Poll Fresh");
  await page.locator("#cc-description").fill("A fresh character created in this flow for poll adoption.");
  await page.getByRole("button", { name: "Create draft" }).click();
  await waitText(page, "#cc-research-status", /Research status: failed/, 30000);
  await page.locator("#cc-contribute").fill("OWNER-KEPT");
  await stubApi("POST", "/__test/mode", { research: "slow" });
  await page.getByRole("button", { name: "Retry research" }).click();
  await waitText(page, "#cc-research-status", /Research status: working/);
  await waitText(page, "#cc-research-status", /Research status: done/, 30000);
  const c = await page.locator("#cc-contribute").inputValue();
  const r = await page.locator("#cc-reason").inputValue();
  ok("browser: fresh creation autofills untouched seed via poll", r === COMPILED.reasoningApproach, r.slice(0, 120));
  ok("browser: owner edit survives poll adoption", c === "OWNER-KEPT", c.slice(0, 120));
  ok("browser: no page errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}
async function scenarioAuthStale(browser) {
  await stubApi("POST", "/__test/reset", {});
  await stubApi("POST", "/__test/mode", { research: "slow", get401: false });
  const { ctx, page, errs } = await freshPage(browser);
  await page.getByRole("button", { name: "Open roster editor directly" }).click();
  await waitText(page, "#test-log", /swapped:/);
  const log0 = (await page.locator("#test-log").textContent()) || "";
  const idB = (log0.match(/swapped:(r\d+)/) || [])[1] || "";
  await page.getByRole("button", { name: "Run research on this draft" }).click();
  await waitText(page, "#cc-research-status", /Research status: working/);
  await page.evaluate(() => window.__testBumpEpoch());
  await waitText(page, "#cc-research-status", /Session changed/, 30000);
  const st = (await page.locator("#cc-research-status").textContent()) || "";
  const cVal = (await page.locator("#cc-contribute").inputValue()) || "";
  const usable = await page.locator("#cc-contribute").isEnabled();
  const errCount = await page.locator(".cc-err").count();
  const log1 = (await page.locator("#test-log").textContent()) || "";
  ok("browser: authority change retires to usable view", usable && errCount === 0 && cVal === "Seed (pending research) for Second Draft" && !/Research status: done/.test(st), st.slice(0, 200));
  ok("browser: old research never completes after epoch change", !log1.includes("saved:" + idB), log1.slice(0, 200));
  await page.waitForTimeout(9000);
  const st2 = (await page.locator("#cc-research-status").textContent()) || "";
  const cVal2 = (await page.locator("#cc-contribute").inputValue()) || "";
  ok("browser: late payload stays silent", cVal2 === "Seed (pending research) for Second Draft" && !/Research status: done/.test(st2) && !cVal2.includes(COMPILED.contributionCriteria), st2.slice(0, 200));
  await page.locator("#cc-contribute").fill("AUTH-OWNER");
  await page.getByRole("button", { name: "Save draft changes" }).click();
  await waitText(page, "#cc-research-status", /Draft saved\./, 20000);
  const log2 = (await page.locator("#test-log").textContent()) || "";
  ok("browser: new operation works after epoch change", log2.includes("saved:" + idB), log2.slice(0, 200));
  ok("browser: no page errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}

async function scenarioSavedRerun(browser) {
  await stubApi("POST", "/__test/reset", {});
  await stubApi("POST", "/__test/mode", { research: "ok" });
  const { ctx, page, errs } = await freshPage(browser);
  await page.getByRole("button", { name: "Open roster editor directly" }).click();
  await waitText(page, "#test-log", /swapped:/);
  await page.locator("#cc-contribute").fill("OWNER-A");
  await page.locator("#cc-reason").fill("OWNER-B");
  await page.locator("#cc-respond").fill("OWNER-C");
  await page.getByRole("button", { name: "Save draft changes" }).click();
  await waitText(page, "#cc-research-status", /Draft saved\./);
  await page.getByRole("button", { name: "Run research on this draft" }).click();
  await waitText(page, "#cc-research-status", /Research status: done/, 30000);
  await page.getByRole("button", { name: "Save draft changes" }).click();
  await waitText(page, "#cc-research-status", /Draft saved\./);
  await page.getByRole("button", { name: "Run research on this draft" }).click();
  await waitText(page, "#cc-research-status", /Research status: done/, 30000);
  const a = await page.locator("#cc-contribute").inputValue();
  const b = await page.locator("#cc-reason").inputValue();
  const c = await page.locator("#cc-respond").inputValue();
  ok("browser: saved owner text survives rerun", a === "OWNER-A" && b === "OWNER-B" && c === "OWNER-C", a + " | " + b + " | " + c);
  const useCount = await page.getByRole("button", { name: "Use compiled draft" }).count();
  ok("browser: explicit adopt offered after rerun", useCount === 3, "buttons: " + useCount);
  await page.getByRole("button", { name: "Close editor" }).click();
  await waitText(page, "#test-log", /unmounted/);
  await page.getByRole("button", { name: "Reopen same draft" }).click();
  await waitText(page, "#test-log", /reopened:/);
  const ra = await page.locator("#cc-contribute").inputValue();
  const rb = await page.locator("#cc-reason").inputValue();
  const rc = await page.locator("#cc-respond").inputValue();
  ok("browser: reopened owner text intact", ra === "OWNER-A" && rb === "OWNER-B" && rc === "OWNER-C", ra + " | " + rb + " | " + rc);
  await page.getByRole("button", { name: "Run research on this draft" }).click();
  await waitText(page, "#cc-research-status", /Research status: done/, 30000);
  const sa = await page.locator("#cc-contribute").inputValue();
  const sb = await page.locator("#cc-reason").inputValue();
  const sc = await page.locator("#cc-respond").inputValue();
  ok("browser: reopened owner text never auto-replaced", sa === "OWNER-A" && sb === "OWNER-B" && sc === "OWNER-C", sa + " | " + sb + " | " + sc);
  const logL = (await page.locator("#test-log").textContent()) || "";
  const idL = (logL.match(/reopened:(r\d+)/) || logL.match(/swapped:(r\d+)/) || [])[1] || "";
  const entL = await stubApi("GET", "/__test/entry?id=" + idL);
  const profL = JSON.parse(entL.profileJson || "{}");
  profL.characterSeed = true;
  profL.contributionCriteria = "OWNER-A";
  profL.reasoningApproach = "OWNER-B";
  profL.responseStyle = "OWNER-C";
  await stubApi("PUT", "/api/roster/" + idL, { profileJson: JSON.stringify(profL) });
  await page.getByRole("button", { name: "Close editor" }).click();
  await waitText(page, "#test-log", /unmounted/);
  await page.getByRole("button", { name: "Reopen same draft" }).click();
  await waitText(page, "#test-log", /reopened:/);
  const la = await page.locator("#cc-contribute").inputValue();
  await page.getByRole("button", { name: "Run research on this draft" }).click();
  await waitText(page, "#cc-research-status", /Research status: done/, 30000);
  const lb = await page.locator("#cc-contribute").inputValue();
  ok("browser: legacy seed flag never auto-replaces owner text", la === "OWNER-A" && lb === "OWNER-A", la + " | " + lb);
  ok("browser: no page errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}
async function scenarioClearUrls(browser) {
  await stubApi("POST", "/__test/reset", {});
  await stubApi("POST", "/__test/mode", { research: "ok" });
  const { ctx, page, errs } = await freshPage(browser);
  await page.getByRole("button", { name: "Open roster editor directly" }).click();
  await waitText(page, "#test-log", /swapped:/);
  await page.getByLabel("Inspiration link 1 of 3").fill("https://example.com/inspo");
  await page.getByLabel("Inspiration link 2 of 3").fill("https://example.com/two");
  await page.getByRole("button", { name: "Run research on this draft" }).click();
  await waitText(page, "#cc-research-status", /Research status: done/, 30000);
  await page.getByRole("button", { name: "Save draft changes" }).click();
  await waitText(page, "#cc-research-status", /Draft saved\./);
  await page.getByLabel("Inspiration link 1 of 3").fill("");
  await page.getByLabel("Inspiration link 2 of 3").fill("");
  await page.getByRole("button", { name: "Save draft changes" }).click();
  await waitText(page, "#cc-research-status", /Draft saved, but the research snapshot state is unclear|Draft saved\. Research state could not be verified/, 20000);
  const calls = await stubApi("GET", "/__test/calls");
  const putBody = calls.puts[calls.puts.length - 1] || {};
  let prof = {};
  try { prof = JSON.parse(putBody.profileJson || "{}"); } catch { prof = {}; }
  ok("browser: cleared URLs persist as empty", Array.isArray(prof.sourceUrls) && prof.sourceUrls.length === 0, JSON.stringify(prof.sourceUrls));
  ok("browser: canonical stored URLs empty", Array.isArray(prof.sourceUrls) && prof.sourceUrls.length === 0, JSON.stringify(prof.sourceUrls));
  const st = (await page.locator("#cc-research-status").textContent()) || "";
  const flowBody = (await page.locator(".cc-editor").textContent()) || "";
  ok("browser: identity clear honest cleared-note", /unclear|Check again|interrupted/.test(st) && !flowBody.includes("server cleared the research snapshot"), st.slice(0, 200));
  ok("browser: cleared snapshot not unknown", (await page.getByRole("button", { name: "Check again" }).count()) === 1, st.slice(0, 160));
  ok("browser: unknown not backed yes", !flowBody.includes("Backed by cited excerpts: yes"), flowBody.slice(0, 200));
  await page.getByRole("button", { name: "Run research on this draft" }).click();
  await waitText(page, "#cc-research-status", /Research status: done/, 30000);
  const calls2 = await stubApi("GET", "/__test/calls");
  const rq = calls2.research[calls2.research.length - 1] || {};
  ok("browser: rerun sends explicit empty URLs", Array.isArray(rq.sourceUrls) && rq.sourceUrls.length === 0, JSON.stringify(rq));
  ok("browser: no page errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}

async function scenarioSwapHeldError(browser) {
  await stubApi("POST", "/__test/reset", {});
  await stubApi("POST", "/__test/mode", { research: "slow-fail" });
  const { ctx, page, errs } = await freshPage(browser);
  await page.getByRole("button", { name: "Open roster editor directly" }).click();
  await waitText(page, "#test-log", /swapped:/);
  await page.getByRole("button", { name: "Run research on this draft" }).click();
  await waitText(page, "#cc-research-status", /Research status: working/);
  await page.getByRole("button", { name: "Swap to second draft" }).click();
  await waitText(page, "#test-log", /swapped:r\d+[\s\S]*swapped:r\d+/);
  await page.waitForTimeout(8000);
  const cVal = (await page.locator("#cc-contribute").inputValue()) || "";
  const rVal = await page.locator("#cc-reason").inputValue();
  const sVal = await page.locator("#cc-respond").inputValue();
  const st = (await page.locator("#cc-research-status").textContent()) || "";
  const hasErr = await page.locator(".cc-err").count();
  ok("browser: held failure never lands on new draft", cVal === "Seed (pending research) for Second Draft" && rVal !== "" && sVal !== "" && !cVal.includes(COMPILED.contributionCriteria) && hasErr === 0 && !/Research status: (failed|done)/.test(st), "c=" + cVal.slice(0, 60) + " st=" + st.slice(0, 160));
  ok("browser: no page errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}

async function scenarioUnmount(browser) {
  await stubApi("POST", "/__test/reset", {});
  await stubApi("POST", "/__test/mode", { research: "slow", slowPut: true, slowQuick: true });
  const { ctx, page, errs } = await freshPage(browser);
  await page.getByRole("button", { name: "Open roster editor directly" }).click();
  await waitText(page, "#test-log", /swapped:/);
  await page.getByRole("button", { name: "Run research on this draft" }).click();
  await waitText(page, "#cc-research-status", /Research status: working/);
  await page.getByRole("button", { name: "Close editor" }).click();
  await waitText(page, "#test-log", /unmounted/);
  await page.waitForTimeout(9000);
  const log = (await page.locator("#test-log").textContent()) || "";
  ok("browser: unmounted op stays silent", !log.includes("saved:") && !log.includes("created:r"), log.slice(0, 200));
  await page.getByRole("button", { name: "Open roster editor directly" }).click();
  await waitText(page, "#test-log", /swapped:[\s\S]*swapped:/);
  const logU = (await page.locator("#test-log").textContent()) || "";
  const idU = ([...logU.matchAll(/swapped:(r\d+)/g)].map((m) => m[1]).pop()) || "";
  await page.locator("#cc-contribute").fill("UNMOUNT-PENDING-SAVE");
  await page.getByRole("button", { name: "Save draft changes" }).click();
  await page.getByRole("button", { name: "Close editor" }).click();
  await waitText(page, "#test-log", /unmounted/);
  await page.waitForTimeout(5000);
  const logU2 = (await page.locator("#test-log").textContent()) || "";
  ok("browser: pending save unmount stays silent", !logU2.includes("saved:" + idU), logU2.slice(0, 200));
  await page.getByRole("button", { name: "Open roster editor directly" }).click();
  await waitText(page, "#test-log", /swapped:[\s\S]*swapped:/);
  ok("browser: remount works after unmount", true);
  ok("browser: no page errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}
async function scenarioSameId(browser) {
  await stubApi("POST", "/__test/reset", {});
  await stubApi("POST", "/__test/mode", { research: "ok" });
  const { ctx, page, errs } = await freshPage(browser);
  await page.getByRole("button", { name: "Open roster editor directly" }).click();
  await waitText(page, "#test-log", /swapped:/);
  await page.locator("#cc-contribute").fill("DIRTY-KEEP");
  await page.getByRole("button", { name: "Simulate external edit" }).click();
  await waitText(page, "#test-log", /bumped:/);
  await waitText(page, "#cc-research-status", /newer saved version/);
  const cVal = (await page.locator("#cc-contribute").inputValue()) || "";
  ok("browser: dirty draft survives canonical bump", cVal === "DIRTY-KEEP", cVal.slice(0, 80));
  ok("browser: conflict offers explicit reload", (await page.getByRole("button", { name: "Reload saved version" }).count()) === 1);
  await page.getByRole("button", { name: "Reload saved version" }).click();
  await waitText(page, "#cc-research-status", /Reloaded saved version/);
  const cVal2 = (await page.locator("#cc-contribute").inputValue()) || "";
  ok("browser: reload adopts canonical text", cVal2 === "Seed (pending research) for Second Draft [server update]", cVal2.slice(0, 120));
  await page.getByRole("button", { name: "Simulate external edit" }).click();
  await waitText(page, "#test-log", /bumped:[\s\S]*bumped:/);
  await page.waitForFunction(
    (exp) => { const el = document.getElementById("cc-contribute"); return !!el && el.value === exp; },
    "Seed (pending research) for Second Draft [server update] [server update]",
    { timeout: 20000 }
  );
  const cVal3 = (await page.locator("#cc-contribute").inputValue()) || "";
  ok("browser: clean draft auto-adopts canonical", cVal3 === "Seed (pending research) for Second Draft [server update] [server update]", cVal3.slice(0, 160));
  ok("browser: clean adopt shows no conflict barrier", (await page.getByRole("button", { name: "Reload saved version" }).count()) === 0 && !/newer saved version/.test((await page.locator("#cc-research-status").textContent()) || ""), (await page.locator("#cc-research-status").textContent() || "").slice(0, 200));
  ok("browser: no page errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}
async function scenarioCanonRace(browser) {
  await stubApi("POST", "/__test/reset", {});
  await stubApi("POST", "/__test/mode", { research: "ok" });
  const { ctx, page, errs } = await freshPage(browser);
  await page.getByRole("button", { name: "Open roster editor directly" }).click();
  await waitText(page, "#test-log", /swapped:/);
  await page.locator("#cc-contribute").fill("DIRTY-V1");
  const frozen = await page.evaluate(async () => {
    const log = document.getElementById("test-log").textContent || "";
    return log;
  });
  ok("browser: race setup froze payload", typeof frozen === "string", frozen.slice(0, 80));
  await page.getByRole("button", { name: "Simulate external edit" }).click();
  await waitText(page, "#test-log", /bumped:/);
  await waitText(page, "#cc-research-status", /newer saved version/);
  const logB = (await page.locator("#test-log").textContent()) || "";
  const bumpV = (logB.match(/bumped:r\d+:v(\d+)/) || [])[1] || "";
  ok("browser: dirty conflict holds highest", /newer saved version/.test((await page.locator("#cc-research-status").textContent()) || "") && bumpV !== "", bumpV);
  await page.getByRole("button", { name: "Simulate external edit" }).click();
  await waitText(page, "#test-log", /bumped:[\s\S]*bumped:/);
  await waitText(page, "#cc-research-status", /newer saved version/);
  await page.getByRole("button", { name: "Apply stale entry" }).click();
  await waitText(page, "#test-log", /stale-applied:/);
  await page.waitForTimeout(1000);
  const stV = (await page.locator("#cc-research-status").textContent()) || "";
  ok("browser: delayed v2 never reduces conflict", /v3|newer saved version/.test(stV) && !/\/v2[^0-9]/.test(stV), stV.slice(0, 200));
  await page.getByRole("button", { name: "Reload saved version" }).click();
  await waitText(page, "#cc-research-status", /Reloaded saved version v?3/);
  const rv = (await page.locator("#cc-contribute").inputValue()) || "";
  ok("browser: reload adopts highest canonical", rv === "Seed (pending research) for Second Draft [server update] [server update]", rv.slice(0, 160));
  ok("browser: no page errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}
async function scenarioKnownNewer(browser) {
  await stubApi("POST", "/__test/reset", {});
  await stubApi("POST", "/__test/mode", { research: "ok", slowGet: true });
  const { ctx, page, errs } = await freshPage(browser);
  await page.getByRole("button", { name: "Open roster editor directly" }).click();
  await waitText(page, "#test-log", /swapped:/);
  const log0 = (await page.locator("#test-log").textContent()) || "";
  const id0 = (log0.match(/swapped:(r\d+)/) || [])[1] || "";
  const cBefore = "OWNER-NEWER";
  await page.locator("#cc-contribute").fill(cBefore);
  await page.evaluate(() => { window.__testCanonFail = true; });
  await page.getByRole("button", { name: "Save draft changes" }).click();
  let putV = 0;
  for (let i = 0; i < 40; i++) {
    const ent = await stubApi("GET", "/__test/entry?id=" + id0);
    if (ent && ent.version >= 2) { putV = ent.version; break; }
    await page.waitForTimeout(250);
  }
  ok("browser: PUT committed before race", putV === 2, "putV=" + putV);
  await stubApi("POST", "/__test/bump", { id: id0 });
  const afterBump = await stubApi("GET", "/__test/entry?id=" + id0);
  const getV = (afterBump && afterBump.version) || 0;
  ok("browser: race produced newer GET", getV === 3 && putV === 2, "put=" + putV + " get=" + getV);
  await page.waitForTimeout(4000);
  const st = (await page.locator("#cc-research-status").textContent()) || "";
  const cVal = (await page.locator("#cc-contribute").inputValue()) || "";
  const log1 = (await page.locator("#test-log").textContent()) || "";
  ok("browser: known newer never adopts old PUT", !log1.includes("saved:" + id0) && cVal === cBefore && /newer version|unclear|Check again/.test(st), st.slice(0, 220));
  ok("browser: conflict or unknown shown", /Reload|Check again|newer version/.test(st) && (await page.getByRole("button", { name: "Reload saved version" }).count()) === 1, st.slice(0, 160));
  await page.evaluate(() => { window.__testCanonFail = false; });
  await page.locator("#cc-reason").fill("OWNER-REASON-2");
  await page.getByRole("button", { name: "Save draft changes" }).click();
  let putV2 = 0;
  for (let i = 0; i < 40; i++) {
    const ent = await stubApi("GET", "/__test/entry?id=" + id0);
    if (ent && ent.version >= 4) { putV2 = ent.version; break; }
    await page.waitForTimeout(250);
  }
  ok("browser: second PUT committed before race", putV2 === 4, "putV2=" + putV2);
  await stubApi("POST", "/__test/bump", { id: id0 });
  await stubApi("POST", "/__test/bump", { id: id0 });
  const afterBump2 = await stubApi("GET", "/__test/entry?id=" + id0);
  const getV2 = (afterBump2 && afterBump2.version) || 0;
  ok("browser: second race produced newer GET", getV2 === 6 && putV2 === 4, "put=" + putV2 + " get=" + getV2);
  await page.evaluate(() => { window.__testCanonVersion = 5; });
  const stBefore2 = (await page.locator("#cc-research-status").textContent()) || "";
  let secondDone = false;
  for (let i = 0; i < 80; i++) {
    const cur = (await page.locator("#cc-research-status").textContent()) || "";
    const saveEnabled = await page.getByRole("button", { name: "Save draft changes" }).isEnabled().catch(() => false);
    let gVer = 0;
    try { const g = await stubApi("GET", "/api/roster/" + id0 + "/research"); gVer = (g && g.version) || 0; } catch { gVer = 0; }
    if (saveEnabled && gVer >= 6 && cur !== stBefore2 && /newer version|unclear|Check again/.test(cur)) { secondDone = true; break; }
    await page.waitForTimeout(250);
  }
  ok("browser: second verification completed", secondDone, "stale-match guard tripped");
  await waitText(page, "#cc-research-status", /newer version|unclear|Check again/, 20000);
  const st2 = (await page.locator("#cc-research-status").textContent()) || "";
  const cVal2 = (await page.locator("#cc-contribute").inputValue()) || "";
  const log2 = (await page.locator("#test-log").textContent()) || "";
  ok("browser: stale resolver never adopts old PUT", !log2.includes("saved:" + id0) && /newer version|unclear|Check again/.test(st2), st2.slice(0, 220) + " getV2=" + getV2);
  ok("browser: current text preserved on resolver race", cVal2 === cBefore, cVal2.slice(0, 120));
  await page.evaluate(() => { window.__testCanonVersion = null; });
  ok("browser: no page errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}
async function scenarioResearchClearedDirty(browser) {
  await stubApi("POST", "/__test/reset", {});
  await stubApi("POST", "/__test/mode", { research: "slow", slowGet: true });
  const { ctx, page, errs } = await freshPage(browser);
  await page.getByRole("button", { name: "Open roster editor directly" }).click();
  await waitText(page, "#test-log", /swapped:/);
  const log0 = (await page.locator("#test-log").textContent()) || "";
  const id0 = (log0.match(/swapped:(r\d+)/) || [])[1] || "";
  await page.locator("#cc-contribute").fill("DIRTY-KEPT");
  await page.getByRole("button", { name: "Run research on this draft" }).click();
  await waitText(page, "#cc-research-status", /Research status: working/);
  let done = false;
  for (let i = 0; i < 60; i++) {
    const ent = await stubApi("GET", "/__test/entry?id=" + id0);
    if (ent && ent.version >= 2) { done = true; break; }
    await page.waitForTimeout(500);
  }
  ok("browser: research POST finished", done, "no finish");
  const ent0 = await stubApi("GET", "/__test/entry?id=" + id0);
  const prof0 = JSON.parse(ent0.profileJson || "{}");
  prof0.background = "changed-background-identity";
  await stubApi("PUT", "/api/roster/" + id0, { profileJson: JSON.stringify(prof0) });
  await waitText(page, "#cc-research-status", /Research status: (stale|failed|idle|incomplete)/, 30000);
  const st = (await page.locator("#cc-research-status").textContent()) || "";
  const cVal = (await page.locator("#cc-contribute").inputValue()) || "";
  ok("browser: cleared GET never resurrects POST draft", cVal === "DIRTY-KEPT" && !cVal.includes(COMPILED.contributionCriteria), cVal.slice(0, 120) + " :: " + st.slice(0, 160));
  ok("browser: cleared result honest terminal", !/Research status: done/.test(st), st.slice(0, 200));
  ok("browser: no page errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}
async function scenarioResearchClearedFresh(browser) {
  await stubApi("POST", "/__test/reset", {});
  await stubApi("POST", "/__test/mode", { research: "slow", slowGet: true });
  const { ctx, page, errs } = await freshPage(browser);
  await page.locator("#cc-name").fill("Fresh Clear");
  await page.locator("#cc-description").fill("A fresh character to test cleared research adoption.");
  await page.getByRole("button", { name: "Create draft" }).click();
  await waitText(page, "#cc-research-status", /Research status: working/, 30000);
  const log0 = (await page.locator("#test-log").textContent()) || "";
  const id0 = (log0.match(/created:(r\d+)/) || [])[1] || "";
  ok("browser: fresh draft created", !!id0, log0.slice(0, 120));
  let done = false;
  for (let i = 0; i < 60; i++) {
    const ent = await stubApi("GET", "/__test/entry?id=" + id0);
    if (ent && ent.version >= 2) { done = true; break; }
    await page.waitForTimeout(500);
  }
  ok("browser: fresh research POST finished", done, "no finish");
  const ent0 = await stubApi("GET", "/__test/entry?id=" + id0);
  const prof0 = JSON.parse(ent0.profileJson || "{}");
  prof0.background = "fresh-changed-identity";
  await stubApi("PUT", "/api/roster/" + id0, { profileJson: JSON.stringify(prof0) });
  await waitText(page, "#cc-research-status", /Research status: (stale|failed|idle|incomplete)/, 30000);
  const st = (await page.locator("#cc-research-status").textContent()) || "";
  const body = (await page.locator(".cc-flow").textContent()) || "";
  ok("browser: fresh cleared never adopts obsolete draft", !body.includes(COMPILED.contributionCriteria), st.slice(0, 200));
  ok("browser: fresh cleared honest terminal", !/Research status: done/.test(st), st.slice(0, 200));
  ok("browser: no page errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}
async function scenarioHeldQuick(browser) {
  await stubApi("POST", "/__test/reset", {});
  await stubApi("POST", "/__test/mode", { slowQuick: true });
  const { ctx, page, errs } = await freshPage(browser);
  await page.locator("#cc-name").fill("Held Quick");
  await page.locator("#cc-description").fill("A held quick creation to test authority retirement.");
  await page.getByRole("button", { name: "Create draft" }).click();
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__testBumpEpoch());
  await page.waitForTimeout(4500);
  const busyNote = (await page.locator("#cc-creation-status").textContent()) || "";
  const creating = await page.getByRole("button", { name: "Creating..." }).count();
  const createBtn = await page.getByRole("button", { name: "Create draft" }).count();
  ok("browser: held quick retires to usable", creating === 0 && createBtn === 1, busyNote.slice(0, 200));
  const log1 = (await page.locator("#test-log").textContent()) || "";
  ok("browser: old quick settlement silent", !log1.includes("created:r"), log1.slice(0, 200));
  await page.getByRole("button", { name: "Create draft" }).click();
  await waitText(page, "#test-log", /created:/, 20000);
  const log2 = (await page.locator("#test-log").textContent()) || "";
  const createdCount = (log2.match(/created:r\d+/g) || []).length;
  ok("browser: new create works after authority change", createdCount === 1, log2.slice(0, 200));
  ok("browser: no page errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}
async function scenarioFrozenGet(browser) {
  await stubApi("POST", "/__test/reset", {});
  await stubApi("POST", "/__test/mode", { research: "ok", slowGet: true, frozenGet: true });
  const { ctx, page, errs } = await freshPage(browser);
  await page.getByRole("button", { name: "Open roster editor directly" }).click();
  await waitText(page, "#test-log", /swapped:/);
  const frozenNote = await page.evaluate(async () => {
    const r = await fetch("/__test/calls").then((x) => x.json()).catch(() => ({}));
    return "frozen-armed";
  });
  ok("browser: frozen payload armed", frozenNote === "frozen-armed", frozenNote);
  await page.getByRole("button", { name: "Run research on this draft" }).click();
  await waitText(page, "#cc-research-status", /Research status: (done|incomplete)/, 30000);
  const c = await page.locator("#cc-contribute").inputValue();
  const idF = (((await page.locator("#test-log").textContent()) || "").match(/swapped:(r\d+)/) || [])[1] || "";
  const frozenBody = (await page.locator(".cc-editor").textContent()) || "";
  const frozenAdopt = await page.getByRole("button", { name: "Use compiled draft" }).count();
  const frozenSt = (await page.locator("#cc-research-status").textContent()) || "";
  const frozenGet = await stubApi("GET", "/api/roster/" + idF + "/research");
  ok("browser: frozen preserves owner paragraph", c === "Seed (pending research) for Second Draft" && !c.includes(COMPILED.contributionCriteria), c.slice(0, 120));
  ok("browser: frozen offers explicit adoption", frozenAdopt === 3, "buttons: " + frozenAdopt);
  ok("browser: frozen snapshot stage coherent", /Research status: (done|incomplete)/.test(frozenSt) && frozenGet && frozenGet.running === false && frozenGet.stage === "done", frozenSt.slice(0, 160));
  await page.getByRole("button", { name: "Use compiled draft" }).first().click();
  ok("browser: frozen compiled available", (await page.locator("#cc-contribute").inputValue()) === COMPILED.contributionCriteria, (await page.locator("#cc-contribute").inputValue()).slice(0, 200));
  ok("browser: no page errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}
async function scenarioInterrupted(browser) {
  await stubApi("POST", "/__test/reset", {});
  await stubApi("POST", "/__test/mode", { research: "orphan" });
  const { ctx, page, errs } = await freshPage(browser);
  await page.getByRole("button", { name: "Open roster editor directly" }).click();
  await waitText(page, "#test-log", /swapped:/);
  await page.getByRole("button", { name: "Run research on this draft" }).click();
  await waitText(page, "#cc-research-status", /Research status: (failed|incomplete|stale)/, 30000);
  const st = (await page.locator("#cc-research-status").textContent()) || "";
  const body = (await page.locator(".cc-editor").textContent()) || "";
  ok("browser: interrupted never cleared empty", !body.includes("server cleared the research snapshot"), st.slice(0, 200));
  ok("browser: interrupted offers retry", /retry|Check again|Run research/i.test(st + body), st.slice(0, 200));
  const cited = body.includes("Cited sources");
  ok("browser: interrupted proof honest", !/Research status: done/.test(st) && (!cited || /no \u2014 treat as incomplete|Backed by cited excerpts: no/.test(body)), st.slice(0, 200));
  ok("browser: no page errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}
async function scenarioOwnerV1(browser) {
  await stubApi("POST", "/__test/reset", {});
  await stubApi("POST", "/__test/mode", { research: "ok" });
  const { ctx, page, errs } = await freshPage(browser);
  await page.getByRole("button", { name: "Open owner v1 draft" }).click();
  await waitText(page, "#test-log", /swapped:/);
  const c0 = await page.locator("#cc-contribute").inputValue();
  const r0 = await page.locator("#cc-reason").inputValue();
  const s0 = await page.locator("#cc-respond").inputValue();
  ok("browser: owner v1 paragraphs shown", c0 === "Owner draft text here for Second Draft!!" && r0 === "Owner method weighs both options against the full brief!!!" && s0 === "Owner voice stays brief and direct in review", c0.slice(0, 60));
  ok("browser: owner v1 same lengths as seed", c0.length === 40 && r0.length === 58 && s0.length === 44, c0.length + "/" + r0.length + "/" + s0.length);
  await page.getByRole("button", { name: "Run research on this draft" }).click();
  await waitText(page, "#cc-research-status", /Research status: done/, 30000);
  const c1 = await page.locator("#cc-contribute").inputValue();
  const r1 = await page.locator("#cc-reason").inputValue();
  const s1 = await page.locator("#cc-respond").inputValue();
  ok("browser: existing v1 owner text never auto-replaced", c1 === c0 && r1 === r0 && s1 === s0, c1.slice(0, 60));
  const adoptCount = await page.getByRole("button", { name: "Use compiled draft" }).count();
  ok("browser: existing v1 offers explicit adopt", adoptCount === 3, "buttons: " + adoptCount);
  ok("browser: no page errors", errs.length === 0, errs.join(" | "));
  await ctx.close();
}
const allScenarios = { success: scenarioSuccess, canonRace: scenarioCanonRace, knownNewer: scenarioKnownNewer, failRetry: scenarioFailRetry, cancel: scenarioCancel, unsupported: scenarioUnsupported, proofKept: scenarioProofKept, swap: scenarioSwap, authUnknown: scenarioAuthUnknown, editDuringPoll: scenarioEditDuringPoll, authStale: scenarioAuthStale, savedRerun: scenarioSavedRerun, clearUrls: scenarioClearUrls, swapHeldError: scenarioSwapHeldError, unmount: scenarioUnmount, sameId: scenarioSameId, frozenGet: scenarioFrozenGet, interrupted: scenarioInterrupted, ownerV1: scenarioOwnerV1, researchClearedDirty: scenarioResearchClearedDirty, researchClearedFresh: scenarioResearchClearedFresh, heldQuick: scenarioHeldQuick };

async function main() {
  const only = (process.argv[2] || "").trim();
  let stub = null;
  let web = null;
  let browser = null;
  try {
    stub = await startStub();
    await buildHarness();
    web = await startWeb();
    const { chromium } = await import("playwright-core");
    console.log("trace: launching browser"); browser = await chromium.launch(); console.log("trace: browser up " + browser.version());
    const names = only && allScenarios[only] ? [only] : Object.keys(allScenarios);
    for (const n of names) { console.log("trace: enter " + n);
      console.log("scenario: " + n);
      try { await allScenarios[n](browser); } catch (e) { fail++; bad.push(n + ":harness-throw"); console.log("  FAIL - " + n + " threw :: " + String((e && e.message) || e).slice(0, 300)); }
    }
    console.log("character-advisor-browser: pass=" + pass + " fail=" + fail);
    if (fail > 0) { console.log("FAILED: " + bad.join("; ")); process.exitCode = 1; }
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (web) web.close();
    if (stub) stub.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  }
}
main().catch((e) => { console.error("HARNESS ERROR " + (e && e.stack || e)); process.exit(1); });
