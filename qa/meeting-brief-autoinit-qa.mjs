 // qa/meeting-brief-autoinit-qa.mjs - REAL HTTP auto-init brief contract QA (Muse-authored).
 // Independent cases per guard: valid empty, valid whitespace, old-lead-while-blank,
 // wrong content, wrong generation, restore epoch, malformed/missing metadata, legacy race.
 // Owns only new QA board/meetings/leads on primary-provided real backend (QA_API).
 // No stubs, no provider/run, no Docker, no env keys, no foreign service.
 // Primary provides owned isolated backend URL and executes; this script is executed by primary.
 // Run: QA_API=http://127.0.0.1:15201 node qa/meeting-brief-autoinit-qa.mjs
 import crypto from "node:crypto";
 import fs from "node:fs";
 import path from "node:path";
 import { fileURLToPath } from "node:url";
 const here = path.dirname(fileURLToPath(import.meta.url));
 const tmpDir = path.join(here, "..", ".tmp");
 const QA_API = (process.env.QA_API || "").trim();
 let pass = 0; let fail = 0; const failures = [];
 function outPath() { try { return path.join(tmpDir, "meeting-brief-autoinit-qa-result.txt"); } catch { return ""; } }
 function outLine(s) { try { fs.mkdirSync(tmpDir, { recursive: true }); fs.appendFileSync(outPath(), s + "\n"); } catch {} }
 function ok(name, cond, extra) { if (cond) { pass++; console.log("  ok - " + name); outLine("PASS " + name); } else { fail++; console.log("  FAIL - " + name + (extra ? " :: " + extra : "")); outLine("FAIL " + name + (extra ? " :: " + extra : "")); failures.push(name + (extra ? " :: " + extra : "")); } }
 function trunc(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n) : s; }
 function redact(s) { return trunc(s, 300).replace(/[0-9a-f]{32,}/gi, "[redacted]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]"); }
 function failExit(msg) { console.log("FATAL " + msg); try { outLine("FATAL " + msg); } catch {} process.exit(2); }
 try { fs.mkdirSync(tmpDir, { recursive: true }); fs.writeFileSync(outPath(), "START " + new Date().toISOString() + "\n"); } catch {}
 if (!QA_API) failExit("REFUSE: QA_API is required (primary-provided owned isolated real backend URL).");
 if (/[^\s:@\/]*:[^\s:@\/]*@/.test(QA_API)) failExit("REFUSE: credentials-in-URL are never accepted.");
 let apiUrl = null;
 try { apiUrl = new URL(QA_API); } catch { failExit("REFUSE: QA_API is not a valid URL."); }
 if (apiUrl.protocol !== "http:") failExit("REFUSE: QA_API must be plain http loopback.");
 if (apiUrl.hostname !== "127.0.0.1") failExit("REFUSE: QA_API must be 127.0.0.1 loopback.");
 if (apiUrl.username || apiUrl.password) failExit("REFUSE: credentials-in-URL are never accepted.");
 const WEB = apiUrl.origin;
 for (const bad of [":5173", ":5080", ":9333"]) { if (WEB.includes(bad)) failExit("REFUSE port " + bad + ": never use human/dev ports."); }
 const run = "qa-auto-" + Date.now().toString(36) + "-" + crypto.randomBytes(3).toString("hex");
 const email = run + "@example.test";
 const password = "Qa-" + crypto.randomBytes(9).toString("hex") + "-x9";
 let token = "";
 async function req(method, p, body, opts = {}) {
   const ctl = new AbortController();
   const t = setTimeout(() => ctl.abort(), opts.timeout || 30000);
   const headers = { "content-type": "application/json" };
   if (token) headers["authorization"] = "Bearer " + token;
   try {
     const r = await fetch(WEB + p, { method, signal: ctl.signal, headers, body: body === undefined ? undefined : JSON.stringify(body) });
     const text = await r.text();
     let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = null; }
     return { status: r.status, json, text };
   } catch (e) { return { status: 0, json: null, text: "transport-failure: " + (e && e.name ? e.name : "error") }; }
   finally { clearTimeout(t); }
 }
 const get = (p, o) => req("GET", p, undefined, o);
 const post = (p, b, o) => req("POST", p, b, o);
 const patch = (p, b, o) => req("PATCH", p, b, o);
 function pick(o, ...keys) { if (!o || typeof o !== "object") return undefined; for (const k of keys) { if (k in o) return o[k]; const lo = String(k).toLowerCase(); for (const key of Object.keys(o)) if (key.toLowerCase() === lo) return o[key]; } return undefined; }
 function metaOf(label, l) {
   const seq = pick(l.json, "sequence");
   const content = pick(l.json, "content", "Content");
   const gen = pick(l.json, "generation", "Generation");
   const rid = pick(l.json, "restoreEpochId", "RestoreEpochId");
   const rrev = pick(l.json, "restoreEpochRev", "RestoreEpochRev");
   ok(label + "-meta-seq", typeof seq === "number", "seq=" + JSON.stringify(seq));
   ok(label + "-meta-content", typeof content === "string" && content.length > 0, "content=" + redact(l.text).slice(0, 120));
   ok(label + "-meta-gen", typeof gen === "number", "gen=" + JSON.stringify(gen));
   ok(label + "-meta-rid", typeof rid === "string" && rid.length > 0, "rid=" + JSON.stringify(rid));
   ok(label + "-meta-rrev", typeof rrev === "number", "rrev=" + JSON.stringify(rrev));
   if (typeof seq !== "number" || typeof content !== "string" || !content || typeof gen !== "number" || typeof rid !== "string" || !rid || typeof rrev !== "number") failExit(label + " metadata incomplete; refusing to null-drop guards");
   return { seq, content, gen, rid, rrev };
 }
 function autoBody(mm, extra) {
   const b = { brief: mm.content.slice(0, 800), briefAutoInit: true, expectedBrief: "", expectBriefEmpty: true, leadSequence: mm.seq, leadContent: mm.content, expectedGeneration: mm.gen, restoreEpochId: mm.rid, restoreEpochRev: mm.rrev };
   if (extra) for (const k of Object.keys(extra)) { if (extra[k] === undefined) delete b[k]; else b[k] = extra[k]; }
   return b;
 }
 function errCat(r) { return String((r.json && r.json.error) || r.text || "").toLowerCase(); }
 async function newMeeting(boardId, title, brief) {
   const m = await post("/api/boards/" + boardId + "/meetings", { title, brief, participantIds: [] });
   ok("setup-meeting-" + title.slice(0, 14), m.status === 201 && pick(m.json, "id"), "status=" + m.status + " " + redact(m.text));
   if (!pick(m.json, "id")) failExit("meeting create failed " + redact(m.text));
   return String(pick(m.json, "id"));
 }
 async function postLead(meetingId, text) {
   return post("/api/meetings/" + meetingId + "/messages", { sender: "lead", content: text, parentSequence: null });
 }
 async function getBrief(boardId, meetingId) {
   const d = await get("/api/boards/" + boardId + "/meetings/" + meetingId);
   return { status: d.status, brief: String(pick(d.json, "brief") ?? ""), text: d.text };
 }
 async function msgCount(meetingId) {
   const r = await get("/api/meetings/" + meetingId + "/messages?take=50");
   return { status: r.status, count: Array.isArray(r.json) ? r.json.length : -1, text: r.text };
 }
 async function main() {
   console.log("setup: register own QA account (token in memory, never logged)");
   const reg = await post("/api/auth/register", { email, password });
   ok("setup-register", reg.status === 201 && pick(reg.json, "token"), "status=" + reg.status + " " + redact(reg.text));
   if (reg.status !== 201) failExit("register failed " + redact(reg.text));
   token = String(pick(reg.json, "token") || "");
   const b = await post("/api/boards", { name: run + "-auto-board", mission: "auto-init contract QA", stage: "qa" });
   ok("setup-board", b.status === 201 && pick(b.json, "id"), "status=" + b.status + " " + redact(b.text));
   if (!pick(b.json, "id")) failExit("board failed " + redact(b.text));
   const boardId = String(pick(b.json, "id"));
   console.log("caseA: valid auto-init on empty brief");
   const mA = await newMeeting(boardId, run + "-A-empty", "");
   const lA = await postLead(mA, "CaseA lead " + run);
   ok("A-lead", (lA.status === 201 || lA.status === 200) && pick(lA.json, "sequence"), "status=" + lA.status + " " + redact(lA.text));
   const mmA = metaOf("A", lA);
   const pA = await patch("/api/meetings/" + mA, autoBody(mmA));
   ok("A-auto-200", pA.status === 200, "status=" + pA.status + " " + redact(pA.text));
   const gA = await getBrief(boardId, mA);
   ok("A-brief", gA.status === 200 && gA.brief === mmA.content, "brief=" + redact(gA.text).slice(0, 160));
   console.log("caseB: valid auto-init over whitespace-only brief");
   const mB = await newMeeting(boardId, run + "-B-wspace", "");
   const w0 = await patch("/api/meetings/" + mB, { brief: "   " });
   ok("B-wspace-set", w0.status === 200, "status=" + w0.status + " " + redact(w0.text));
   const gB0 = await getBrief(boardId, mB);
   ok("B-wspace-stored", gB0.status === 200 && gB0.brief === "   ", "brief=" + JSON.stringify(gB0.brief));
   const lB = await postLead(mB, "CaseB lead " + run);
   ok("B-lead", (lB.status === 201 || lB.status === 200) && pick(lB.json, "sequence"), "status=" + lB.status + " " + redact(lB.text));
   const mmB = metaOf("B", lB);
   const pB = await patch("/api/meetings/" + mB, autoBody(mmB));
   ok("B-auto-200", pB.status === 200, "status=" + pB.status + " " + redact(pB.text));
   const gB = await getBrief(boardId, mB);
   ok("B-brief", gB.status === 200 && gB.brief === mmB.content, "brief=" + redact(gB.text).slice(0, 160));
   console.log("caseC: obsolete old lead while still blank (no manual mask)");
   const mC = await newMeeting(boardId, run + "-C-oldblank", "");
   const lC1 = await postLead(mC, "CaseC old " + run);
   const mmC1 = metaOf("C1", lC1);
   const lC2 = await postLead(mC, "CaseC new " + run);
   ok("C-lead2", (lC2.status === 201 || lC2.status === 200) && pick(lC2.json, "sequence") !== mmC1.seq, "status=" + lC2.status + " " + redact(lC2.text));
   const cOld = await patch("/api/meetings/" + mC, autoBody(mmC1));
   ok("C-old-409", cOld.status === 409, "status=" + cOld.status + " " + redact(cOld.text));
   ok("C-old-leadcat", errCat(cOld).includes("supersed") || errCat(cOld).includes("newer message"), "body=" + redact(cOld.text).slice(0, 200));
   const gC = await getBrief(boardId, mC);
   ok("C-brief-still-blank", gC.status === 200 && gC.brief === "", "brief=" + JSON.stringify(gC.brief));
   const nC = await msgCount(mC);
   ok("C-two-leads", nC.status === 200 && nC.count === 2, "count=" + nC.count);
   console.log("caseD: same lead wrong content");
   const mD = await newMeeting(boardId, run + "-D-content", "");
   const lD = await postLead(mD, "CaseD lead " + run);
   const mmD = metaOf("D", lD);
   const dBad = await patch("/api/meetings/" + mD, autoBody(mmD, { leadContent: mmD.content + " [tampered]" }));
   ok("D-content-409", dBad.status === 409, "status=" + dBad.status + " " + redact(dBad.text));
   ok("D-content-leadcat", errCat(dBad).includes("supersed") || errCat(dBad).includes("newer message"), "body=" + redact(dBad.text).slice(0, 200));
   const gD = await getBrief(boardId, mD);
   ok("D-brief-still-blank", gD.status === 200 && gD.brief === "", "brief=" + JSON.stringify(gD.brief));
   console.log("caseE: same lead wrong generation via close/reopen");
   const mE = await newMeeting(boardId, run + "-E-gen", "");
   const lE = await postLead(mE, "CaseE lead " + run);
   const mmE = metaOf("E", lE);
   const cE = await post("/api/meetings/" + mE + "/close", { withRecord: false });
   ok("E-close", cE.status === 200, "status=" + cE.status + " " + redact(cE.text));
   const rE = await post("/api/meetings/" + mE + "/reopen", {});
   ok("E-reopen", rE.status === 200, "status=" + rE.status + " " + redact(rE.text));
   const eBad = await patch("/api/meetings/" + mE, autoBody(mmE));
   ok("E-gen-409", eBad.status === 409, "status=" + eBad.status + " " + redact(eBad.text));
   ok("E-gen-cat", errCat(eBad).includes("meeting changed"), "body=" + redact(eBad.text).slice(0, 200));
   const gE = await getBrief(boardId, mE);
   ok("E-brief-still-blank", gE.status === 200 && gE.brief === "", "brief=" + JSON.stringify(gE.brief));
   console.log("caseF: restore epoch invalidates same row state");
   const mF = await newMeeting(boardId, run + "-F-restore", "");
   const lF = await postLead(mF, "CaseF lead " + run);
   const mmF = metaOf("F", lF);
   const gF0 = await getBrief(boardId, mF);
   const nF0 = await msgCount(mF);
   let restoredActual = false;
   const bk = await get("/api/backup");
   if (bk.status === 200 && bk.json && pick(bk.json, "snapshot") && pick(bk.json, "hash")) {
     const rs = await post("/api/backup/restore", { snapshot: pick(bk.json, "snapshot"), hash: pick(bk.json, "hash") });
     if (rs.status === 200) {
       restoredActual = true;
       ok("F-restore-200", true, "");
       const gFr = await getBrief(boardId, mF);
       const nFr = await msgCount(mF);
       ok("F-row-same", gFr.status === 200 && gFr.brief === gF0.brief && nFr.count === nF0.count, "brief=" + JSON.stringify(gFr.brief) + " n=" + nFr.count);
       const fOld = await patch("/api/meetings/" + mF, autoBody(mmF));
       ok("F-restore-409", fOld.status === 409, "status=" + fOld.status + " " + redact(fOld.text));
       ok("F-restore-cat", errCat(fOld).includes("restored"), "body=" + redact(fOld.text).slice(0, 200));
     } else {
       outLine("NOTE F-restore-blocked status=" + rs.status);
     }
   } else {
     outLine("NOTE F-backup-blocked status=" + bk.status);
   }
   if (!restoredActual) {
     const fTam = await patch("/api/meetings/" + mF, autoBody(mmF, { restoreEpochId: "00000000-0000-0000-0000-000000000000" }));
     ok("F-epoch-guard-409", fTam.status === 409, "status=" + fTam.status + " " + redact(fTam.text));
     ok("F-epoch-guard-cat", errCat(fTam).includes("restored"), "body=" + redact(fTam.text).slice(0, 200));
     outLine("NOTE F-actual-restore-unavailable primary-admin-required");
   }
   console.log("caseG: malformed/missing metadata rejected");
   const mG = await newMeeting(boardId, run + "-G-meta", "");
   const lG = await postLead(mG, "CaseG lead " + run);
   const mmG = metaOf("G", lG);
   const gMiss = await patch("/api/meetings/" + mG, { brief: mmG.content.slice(0, 800), briefAutoInit: true, expectedBrief: "", expectBriefEmpty: true });
   ok("G-missing-409", gMiss.status === 409, "status=" + gMiss.status + " " + redact(gMiss.text));
   const gMal = await patch("/api/meetings/" + mG, autoBody(mmG, { leadSequence: "bad" }));
   ok("G-malformed-409", gMal.status === 409, "status=" + gMal.status + " " + redact(gMal.text));
   const gG = await getBrief(boardId, mG);
   ok("G-brief-still-blank", gG.status === 200 && gG.brief === "", "brief=" + JSON.stringify(gG.brief));
   console.log("caseH: legacy race manual brief wins, settings overwrite unchanged");
   const mH = await newMeeting(boardId, run + "-H-race", "");
   const lH1 = await postLead(mH, "CaseH old " + run);
   const mmH1 = metaOf("H1", lH1);
   const lH2 = await postLead(mH, "CaseH new " + run);
   ok("H-lead2", (lH2.status === 201 || lH2.status === 200) && pick(lH2.json, "sequence") !== mmH1.seq, "status=" + lH2.status);
   const manH = await patch("/api/meetings/" + mH, { brief: "new manual brief " + run });
   ok("H-manual-set", manH.status === 200 && String(pick(manH.json, "brief") || "").includes("new manual brief"), "status=" + manH.status);
   const hOld = await patch("/api/meetings/" + mH, autoBody(mmH1));
   ok("H-old-409", hOld.status === 409, "status=" + hOld.status + " " + redact(hOld.text));
   ok("H-old-blankcat", errCat(hOld).includes("already"), "body=" + redact(hOld.text).slice(0, 200));
   const gH = await getBrief(boardId, mH);
   ok("H-brief-manual", gH.status === 200 && gH.brief === "new manual brief " + run, "brief=" + redact(gH.text).slice(0, 160));
   const manH2 = await patch("/api/meetings/" + mH, { brief: "manual v2 " + run });
   ok("H-manual-overwrite", manH2.status === 200 && String(pick(manH2.json, "brief") || "") === "manual v2 " + run, "status=" + manH2.status);
   const gH2 = await getBrief(boardId, mH);
   ok("H-eligible", gH2.status === 200 && gH2.brief.trim() !== "", "brief=" + redact(gH2.text).slice(0, 120));
 }
 try { await main(); } catch (e) { fail++; const m = "threw " + String((e && e.message) || e).slice(0, 400); failures.push(m); console.log("  FAIL " + m); try { outLine("FAIL " + m); } catch {} }
 console.log("PASS=" + pass + " FAIL=" + fail); try { outLine("PASS=" + pass + " FAIL=" + fail); } catch {}
 if (failures.length) { console.log("FAILURES: " + failures.join(" ; ")); try { outLine("FAILURES: " + failures.join(" ; ")); } catch {} }
 process.exit(fail ? 1 : 0);
