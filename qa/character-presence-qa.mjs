 // Character research presence-semantics QA (contract v3 + frontend mount contract).
 // Proves strict JSON-property PRESENCE semantics at runtime against QA_API (fake provider):
 // omitted field => falls back to persisted ResearchInputsJson; explicitly provided
 // valid empty (sourceUrls:[] / background:"" / focus:"") => CLEARS, never falls
 // through to stored or legacy-seed values. No services spawned, no human ports.
 // Primary executes: QA_API=http://127.0.0.1:5159 QA_FAKE=http://127.0.0.1:5252 node qa/character-presence-qa.mjs
 const API = process.env.QA_API || "http://127.0.0.1:5159";
 const FAKE = process.env.QA_FAKE || "http://127.0.0.1:5252";
 const run = "cpres-" + Date.now().toString(36);
 let pass = 0, fail = 0; const failures = [];
 function ok(name, cond, extra) { if (cond) pass++; else { fail++; failures.push(name + (extra ? " :: " + extra : "")); console.log("  FAIL " + name + (extra ? " :: " + extra : "")); } }
 async function req(method, path, body, opts) {
   opts = opts || {};
   const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), opts.timeout || 30000);
   try {
     const r = await fetch(API + path, { method: method, signal: ctl.signal,
       headers: { "content-type": "application/json", "x-user": opts.user || "owner" },
       body: body === undefined ? undefined : JSON.stringify(body) });
     const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
     return { status: r.status, json: json, text: text };
   } finally { clearTimeout(t); }
 }
 const post = (p, b, o) => req("POST", p, b, o);
 const put = (p, b, o) => req("PUT", p, b, o);
 const get = (p, o) => req("GET", p, undefined, o);
 const guid = () => globalThis.crypto.randomUUID();
 const camel = (o, k) => { if (!o || typeof o !== "object") return undefined; if (k in o) return o[k]; const lo = k.toLowerCase(); for (const key of Object.keys(o)) if (key.toLowerCase() === lo) return o[key]; return undefined; };
 const ACCT = guid();
 async function fakeLog() { const r = await fetch(FAKE + "/__log"); return r.json(); }
 async function fakeLogClear() { await fetch(FAKE + "/__log", { method: "DELETE" }); }
 function responsesWith(log, s) { return log.filter((e) => e.path === "responses" && (e.full || "").includes(s)); }
 async function inputsOf(rid) { const g = await get("/api/roster/" + rid + "/research"); const inp = g.json ? (g.json.inputs || g.json.Inputs) : null; return { g: g, inp: inp }; }
 const OLD_BG = "OLD-BG-PRESENCE-" + run + " harbor background seed text with enough detail.";
 const NEW_BG = "NEW-BG-PRESENCE-" + run + " documentation-domain background replacement text.";
 const OLD_URL_MARK = "old-clear-" + run;
 const OLD_URL = "https://example.com/?" + OLD_URL_MARK;
 const F_OLD = "F-OLD-PRESENCE-" + run + " harbor logistics focus";
 // 1: seed old background + old URL
 console.log("1: seed old background + old URL");
 const seed = await post("/api/roster/quick", { accountId: ACCT, name: "Presence Pat " + run, description: "Documentation and example-domain teaching advisor: explains reserved example domains and illustrative examples in documentation.", background: OLD_BG, sourceUrls: [OLD_URL] });
 ok("seed-201", seed.status === 201 && camel(seed.json, "id"), seed.status + " " + seed.text.slice(0, 160));
 const rid = camel(seed.json, "id");
 ok("seed-inputs-oldurl", (camel(seed.json, "researchInputsJson") || "").includes(OLD_URL_MARK), (camel(seed.json, "researchInputsJson") || "").slice(0, 160));
 // 2: baseline research with explicit focus only (background/urls omitted => fallback)
 console.log("2: baseline research, omitted background/urls fall back");
 await fakeLogClear();
 const base = await post("/api/roster/" + rid + "/research", { focus: F_OLD }, { timeout: 170000 });
 ok("base-200", base.status === 200, base.status + " " + base.text.slice(0, 200));
 const bIn = await inputsOf(rid);
 ok("base-inputs-fallback", bIn.inp && bIn.inp.background === OLD_BG && JSON.stringify(bIn.inp.sourceUrls || []) === JSON.stringify([OLD_URL]) && bIn.inp.focus === F_OLD, JSON.stringify(bIn.inp).slice(0, 300));
 const bRefs = (base.json && (base.json.evidenceRefs || base.json.EvidenceRefs)) || [];
 ok("base-oldurl-tracked", bRefs.some((e) => ((e.url || e.Url) || "").includes(OLD_URL_MARK)), JSON.stringify(bRefs).slice(0, 300));
 ok("base-oldurl-fetched", bRefs.some(e => ((e.url || e.Url) || "").includes(OLD_URL_MARK) && (e.fetched === true || e.Fetched === true)), JSON.stringify(bRefs).slice(0,300));
 const bLog = await fakeLog();
 ok("base-prompt-has-oldurl", responsesWith(bLog, OLD_URL_MARK).length >= 1, "old URL missing from baseline dossier prompt");
 // 3: clear links WITHOUT any PUT: explicit sourceUrls:[] must CLEAR, never fetch old URL
 console.log("3: explicit sourceUrls:[] clears without PUT");
 await fakeLogClear();
 const clr = await post("/api/roster/" + rid + "/research", { sourceUrls: [] }, { timeout: 170000 });
 ok("clear-200", clr.status === 200, clr.status + " " + clr.text.slice(0, 200));
 const cIn = await inputsOf(rid);
 ok("clear-inputs-empty", cIn.inp && cIn.inp.background === OLD_BG && JSON.stringify(cIn.inp.sourceUrls || []) === "[]" && cIn.inp.focus === F_OLD, JSON.stringify(cIn.inp).slice(0, 300));
 const cRefs = (clr.json && (clr.json.evidenceRefs || clr.json.EvidenceRefs)) || [];
 ok("clear-no-oldurl-refs", !cRefs.some((e) => ((e.url || e.Url) || "").includes(OLD_URL_MARK)), JSON.stringify(cRefs).slice(0, 300));
 const cLog = await fakeLog();
 ok("clear-no-oldurl-prompt", responsesWith(cLog, OLD_URL_MARK).length === 0, "stale old URL reached the model prompt");
 ok("clear-bg-fallback-kept", responsesWith(cLog, OLD_BG).length >= 1, "omitted background should still fall back to stored OLD_BG");
 // 4: omitted {} retry retains the cleared [] (stored inputs are the cleared ones)
 console.log("4: omitted retry retains cleared urls");
 await fakeLogClear();
 const ret = await post("/api/roster/" + rid + "/research", {}, { timeout: 170000 });
 ok("retry-200", ret.status === 200, ret.status + " " + ret.text.slice(0, 200));
 const rIn = await inputsOf(rid);
 ok("retry-inputs-still-cleared", rIn.inp && rIn.inp.background === OLD_BG && JSON.stringify(rIn.inp.sourceUrls || []) === "[]" && rIn.inp.focus === F_OLD, JSON.stringify(rIn.inp).slice(0, 300));
 const rLog = await fakeLog();
 ok("retry-no-oldurl-prompt", responsesWith(rLog, OLD_URL_MARK).length === 0, "cleared URL resurrected on omitted retry");
 // 5: explicit new background + explicit empty focus respected; omitted urls stay cleared
 console.log("5: explicit new background + empty focus clear");
 await fakeLogClear();
 const nb = await post("/api/roster/" + rid + "/research", { background: NEW_BG, focus: "" }, { timeout: 170000 });
 ok("newbg-200", nb.status === 200, nb.status + " " + nb.text.slice(0, 200));
 const nIn = await inputsOf(rid);
 ok("newbg-inputs", nIn.inp && nIn.inp.background === NEW_BG && JSON.stringify(nIn.inp.sourceUrls || []) === "[]" && nIn.inp.focus === "", JSON.stringify(nIn.inp).slice(0, 300));
 const nLog = await fakeLog();
 ok("newbg-prompt-new", responsesWith(nLog, NEW_BG).length >= 1, "explicit new background missing from dossier prompt");
 ok("newbg-prompt-no-old", responsesWith(nLog, OLD_BG).length === 0 && responsesWith(nLog, F_OLD).length === 0, "stale background/focus reached the model after explicit replace/clear");
 // 6: omitted {} retry retains latest (new background, cleared urls, empty focus)
 console.log("6: omitted retry retains latest inputs");
 const fin = await post("/api/roster/" + rid + "/research", {}, { timeout: 170000 });
 ok("final-retry-200", fin.status === 200, fin.status + " " + fin.text.slice(0, 200));
 const fIn = await inputsOf(rid);
 ok("final-inputs-retained", fIn.inp && fIn.inp.background === NEW_BG && JSON.stringify(fIn.inp.sourceUrls || []) === "[]" && fIn.inp.focus === "", JSON.stringify(fIn.inp).slice(0, 300));
 // 7: explicit bad background type is 400, not silently ignored
 console.log("7: explicit bad background type rejected");
 const badBg = await post("/api/roster/" + rid + "/research", { background: 12345 });
 ok("badbg-400", badBg.status === 400 && badBg.text.toLowerCase().includes("background"), badBg.status + " " + badBg.text.slice(0, 160));
 const badUrls = await post("/api/roster/" + rid + "/research", { sourceUrls: "not-an-array" });
 ok("badurls-400", badUrls.status === 400, badUrls.status + " " + badUrls.text.slice(0, 160));
 const afterBad = await inputsOf(rid);
 ok("bad-no-state-change", afterBad.inp && afterBad.inp.background === NEW_BG && JSON.stringify(afterBad.inp.sourceUrls || []) === "[]", JSON.stringify(afterBad.inp).slice(0, 200));
 console.log("character-presence-qa: pass=" + pass + " fail=" + fail);
 if (fail && failures.length) { console.log("FAILURES:"); for (const f of failures) console.log(" - " + f); }
 process.exit(fail ? 1 : 0);
