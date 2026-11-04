 // qa/meeting-brief-autoinit-qa.mjs - REAL HTTP auto-init brief race QA (Muse-authored).
 // Proves delayed obsolete auto-PATCH cannot overwrite newer brief/lead.
 // Owns only new QA board/meeting/leads on primary-provided real backend (QA_API).
 // No stubs, no provider/run, no Docker, no env keys, no foreign service.
 // Primary provides owned isolated backend URL and executes; this change is script-only.
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
 const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
 async function main() {
   console.log("setup: register own QA account (token in memory, never logged)");
   const reg = await post("/api/auth/register", { email, password });
   ok("setup-register", reg.status === 201 && pick(reg.json, "token"), "status=" + reg.status + " " + redact(reg.text));
   if (reg.status !== 201) failExit("register failed " + redact(reg.text));
   token = String(pick(reg.json, "token") || "");
   const b = await post("/api/boards", { name: run + "-auto-board", mission: "auto-init race QA", stage: "qa" });
   ok("setup-board", b.status === 201 && pick(b.json, "id"), "status=" + b.status + " " + redact(b.text));
   if (!pick(b.json, "id")) failExit("board failed " + redact(b.text));
   const boardId = String(pick(b.json, "id"));
   const m = await post("/api/boards/" + boardId + "/meetings", { title: run + " auto race", brief: "", participantIds: [] });
   ok("setup-meeting", m.status === 201 && pick(m.json, "id"), "status=" + m.status + " " + redact(m.text));
   if (!pick(m.json, "id")) failExit("meeting failed " + redact(m.text));
   const meetingId = String(pick(m.json, "id"));
   const det0 = await get("/api/boards/" + boardId + "/meetings/" + meetingId);
   ok("setup-brief-empty", det0.status === 200 && String(pick(det0.json, "brief") || "") === "", "status=" + det0.status + " " + redact(det0.text));
   console.log("lead1: post old lead (blank brief, auto-init source)");
   const lead1Text = "Old auto lead " + run;
   const l1 = await post("/api/meetings/" + meetingId + "/messages", { sender: "lead", content: lead1Text, parentSequence: null });
   ok("lead1-posted", (l1.status === 201 || l1.status === 200) && pick(l1.json, "sequence"), "status=" + l1.status + " " + redact(l1.text));
   if (!pick(l1.json, "sequence")) failExit("lead1 no sequence " + redact(l1.text));
   const seq1 = pick(l1.json, "sequence");
   const gen1 = pick(l1.json, "generation", "Generation");
   const rId1 = pick(l1.json, "restoreEpochId", "RestoreEpochId");
   const rRev1 = pick(l1.json, "restoreEpochRev", "RestoreEpochRev");
   const content1 = String(pick(l1.json, "content", "Content") || lead1Text);
   const oldAutoBody = { brief: content1.slice(0, 800), briefAutoInit: true, expectedBrief: "", expectBriefEmpty: true, leadSequence: seq1, leadContent: content1, expectedGeneration: gen1 ?? null, restoreEpochId: rId1 ?? null, restoreEpochRev: rRev1 ?? null };
   console.log("lead2: post newer lead before delayed old auto-PATCH");
   const lead2Text = "Newer lead " + run;
   const l2 = await post("/api/meetings/" + meetingId + "/messages", { sender: "lead", content: lead2Text, parentSequence: null });
   ok("lead2-posted", (l2.status === 201 || l2.status === 200) && pick(l2.json, "sequence") !== seq1, "status=" + l2.status + " " + redact(l2.text));
   console.log("manual: set newer brief via settings semantics (unconditional)");
   const man = await patch("/api/meetings/" + meetingId, { brief: "new manual brief " + run });
   ok("manual-brief-set", man.status === 200 && String(pick(man.json, "brief") || "").includes("new manual brief"), "status=" + man.status + " " + redact(man.text));
   console.log("race: send delayed obsolete old auto-PATCH (must 409, no overwrite)");
   const oldRes = await patch("/api/meetings/" + meetingId, oldAutoBody);
   ok("oldauto-409", oldRes.status === 409, "status=" + oldRes.status + " " + redact(oldRes.text));
   ok("oldauto-actionable", String(pick(oldRes.json, "error") || oldRes.text || "").toLowerCase().includes("discard") || String(pick(oldRes.json, "error") || oldRes.text || "").toLowerCase().includes("supersed") || String(pick(oldRes.json, "error") || oldRes.text || "").toLowerCase().includes("already"), "body=" + redact(oldRes.text).slice(0, 200));
   const det1 = await get("/api/boards/" + boardId + "/meetings/" + meetingId);
   ok("brief-unchanged", det1.status === 200 && String(pick(det1.json, "brief") || "") === "new manual brief " + run, "brief=" + redact(det1.text).slice(0, 200));
   const msgs = await get("/api/meetings/" + meetingId + "/messages?take=50");
   const count = Array.isArray(msgs.json) ? msgs.json.length : -1;
   ok("two-leads", msgs.status === 200 && count === 2, "status=" + msgs.status + " count=" + count + " " + redact(msgs.text).slice(0, 200));
   console.log("manual-overwrite: settings PATCH without autoInit still overwrites (semantics unchanged)");
   const man2 = await patch("/api/meetings/" + meetingId, { brief: "manual v2 " + run });
   ok("manual-overwrite-ok", man2.status === 200 && String(pick(man2.json, "brief") || "") === "manual v2 " + run, "status=" + man2.status + " " + redact(man2.text));
   console.log("eligible: brief non-blank so newer Send chains run without PATCH");
   const det2 = await get("/api/boards/" + boardId + "/meetings/" + meetingId);
   ok("eligible-brief", det2.status === 200 && String(pick(det2.json, "brief") || "").trim() !== "", "brief=" + redact(det2.text).slice(0, 120));
   const l3 = await post("/api/meetings/" + meetingId + "/messages", { sender: "lead", content: "Eligible send " + run, parentSequence: null });
   ok("eligible-send", (l3.status === 201 || l3.status === 200) && pick(l3.json, "sequence"), "status=" + l3.status + " " + redact(l3.text));
 }
 try { await main(); } catch (e) { fail++; const m = "threw " + String((e && e.message) || e).slice(0, 400); failures.push(m); console.log("  FAIL " + m); try { outLine("FAIL " + m); } catch {} }
 console.log("PASS=" + pass + " FAIL=" + fail); try { outLine("PASS=" + pass + " FAIL=" + fail); } catch {}
 if (failures.length) { console.log("FAILURES: " + failures.join(" ; ")); try { outLine("FAILURES: " + failures.join(" ; ")); } catch {} }
 process.exit(fail ? 1 : 0);
