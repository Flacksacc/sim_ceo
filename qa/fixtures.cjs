// qa/fixtures.cjs - shared deterministic fixtures (required by navigation.cjs).
// Mirrors the real server shapes AND its real limits:
// - GET /api/boards returns the newest-100 window (BOLD is valid but outside it).
// - GET /api/boards/:bid/meetings returns the newest-200 window (MOLD is valid
//   but outside the unfiltered window; it still appears under a matching q=).
// - GET /api/meetings/:mid/records returns the newest-50 window (ROLD is valid
//   for MOLD but omitted from that meeting's list window).
// - GET /api/boards/:id and GET /api/boards/:bid/meetings/:mid are the
//   authoritative selected-entity lookups: a 404 (unknown id or parent-board
//   mismatch, also 404) is the only signal that clears a route. Absence from a
//   capped/filtered window never establishes deletion.
const B1 = { id: "b-alpha", name: "Alpha Board", mission: "Decide pricing" };
const B2 = { id: "b-beta", name: "Beta Board", mission: "Explore onboarding" };
const BOLD = { id: "b-old", name: "Old Archive Board", mission: "Archived work" };
const M1 = { id: "m-one", boardId: "b-alpha", title: "Pricing move QA session", state: 1, brief: "Should we raise the starter tier?" };
const M2 = { id: "m-two", boardId: "b-alpha", title: "Second session notes", state: 0, brief: "Follow-up notes" };
const MOLD = { id: "m-old", boardId: "b-alpha", title: "Ancient pricing debate", state: 1, brief: "Legacy decision record" };
const M3 = { id: "m-three", boardId: "b-beta", title: "Beta kickoff", state: 1, brief: "Kick off beta" };
const MSGS1 = [
  { sequence: 1, sender: "lead", content: "Hello board" },
  { sequence: 2, sender: "advisor1", advisorName: "CFO Ada", content: "Raise it." },
];
const MSGOLD = [
  { sequence: 1, sender: "lead", content: "Legacy hello from the archive" },
];
const A1 = { id: "a-1", boardRole: "CFO Ada", approved: true, removed: false, rosterEntryId: "r-ent-1", rosterVersion: 1, imageProvenance: "initials" };
const A2 = { id: "a-2", boardRole: "CTO Bo", approved: false, removed: false, rosterEntryId: "r-ent-2", rosterVersion: 1, imageProvenance: "initials" };
const R1 = { id: "r-1", boardId: "b-alpha", meetingId: "m-one", version: 1, hash: "h1", watermark: 1, itemsJson: '[{"id":"a","text":"Raise starter by $5"}]', decided: false, status: "draft", approvedJson: "[]", supersedesJson: "[]" };
const R2 = { id: "r-2", boardId: "b-alpha", meetingId: "m-one", version: 2, hash: "h2", watermark: 2, itemsJson: '[{"id":"a","text":"Raise starter by $5"},{"id":"b","text":"Hold enterprise flat"}]', decided: false, status: "draft", approvedJson: "[]", supersedesJson: "[r-1]" };
const ROLD = { id: "r-old", boardId: "b-alpha", meetingId: "m-old", version: 3, hash: "h-old", watermark: 5, itemsJson: '[{"id":"z","text":"Legacy item stands"}]', decided: false, status: "draft", approvedJson: "[]", supersedesJson: "[]" };
const setupFor = (b) => ({ board: { id: b.id, name: b.name, mission: b.mission, stage: "Seed", activeConfig: true, leadProfileVersion: 1, retainAudio: false, discussionPolicy: "balanced", dataUse: "standard" }, draftJson: "{}", activeJson: "{}", draftHash: "dh", dirty: false, lead: null, advisors: { total: 0, approved: 0 } });
const statusFor = (b) => ({ board: b.name, active: true, dirty: false, name: true, lead: false, leadVersion: 0, advisors: { total: 0, approved: 0 }, meetings: { total: 2, active: 1 }, sourcesPending: 0, jobsFailed: 0, policy: "balanced", retainAudio: false });
const LEAD = { id: "l1", boardId: "b-alpha", version: 1, name: "QA Lead", roleLabel: "CEO", background: "", familiarTopics: "", simplerTopics: "", commPrefs: "", updatedAt: "2026-11-02", provenanceJson: "{}" };
const STATE_NUM = { AwaitingBrief: 0, Active: 1, Yielded: 2, Paused: 3, WrappingUp: 4, AwaitingRecordDecision: 5, ClosedWithRecord: 6, ClosedWithoutPublication: 7 };

function fixtureHandler(reqLog, unhandled) {
  const store = {
    boards: [B1, B2],
    meetings: { "b-alpha": [M1, M2], "b-beta": [M3], "b-old": [] },
    drafts: { "m-one": [R1, R2], "m-two": [], "m-three": [], "m-old": [] },
    byRecordId: { "r-1": R1, "r-2": R2, "r-old": ROLD },
    advisors: { "b-alpha": [A1, A2], "b-beta": [], "b-old": [] },
    wizards: {},
    wizNext: 1,
    failOne: null,
    nextBoard: 1,
    nextMeeting: 1,
    nextRecord: 1,
    delays: {},
  };
  const boardById = (id) =>
    store.boards.find((b) => b.id === id) || (id === BOLD.id ? BOLD : undefined);
  const meetingById = (id) =>
    Object.values(store.meetings).flat().find((m) => m.id === id) ||
    (id === MOLD.id ? MOLD : undefined);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const takeDelay = (key) => {
    const ms = store.delays[key] || 0;
    store.delays[key] = 0;
    return ms;
  };
  return async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    reqLog.push(req.method() + " " + u.pathname + u.search);
    const J = (v, s = 200) => route.fulfill({ status: s, contentType: "application/json", body: JSON.stringify(v) });
    const N = (msg) => { unhandled.push(req.method() + " " + u.pathname + u.search); return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: msg }) }); };
    // Validation 404s: the app MUST issue these scoped/singular lookups to
    // confirm context (unknown id or parent mismatch). They are expected, so
    // they stay in reqLog but are not fixture gaps.
    const V = (msg) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: msg }) });
    const p = u.pathname;
    let m;
    if (p === "/api/__qa/delay" && req.method() === "GET") {
      store.delays[u.searchParams.get("key") || ""] = Number(u.searchParams.get("ms") || 0) || 0;
      return J({ ok: true });
    }
    if (p === "/api/__qa/fail" && req.method() === "GET") {
      store.failOne = { key: u.searchParams.get("key") || "", status: Number(u.searchParams.get("status") || 500) || 500 };
      return J({ ok: true });
    }
    if (p === "/api/boards" && req.method() === "GET") {
      const d = takeDelay("boards");
      if (d) await sleep(d);
      return J(store.boards.slice());
    }
    if ((m = p.match(/^\/api\/boards\/([^/]+)$/)) && req.method() === "GET") {
      const b = boardById(m[1]);
      if (!b) return V("unknown board");
      return J({ id: b.id, name: b.name, mission: b.mission });
    }
    if ((m = p.match(/^\/api\/boards\/([^/]+)$/)) && req.method() === "PATCH") {const bb=boardById(m[1]);if(!bb)return V("unknown board");let bbody={};try{bbody=req.postDataJSON()||{};}catch{}if(typeof bbody.name==="string"&&bbody.name)bb.name=bbody.name;if(typeof bbody.mission==="string")bb.mission=bbody.mission;return J({id:bb.id,name:bb.name,mission:bb.mission});}
    if ((m = p.match(/^\/api\/boards\/([^/]+)\/meetings$/))) {
      const b = m[1];
      if (!boardById(b)) return V("unknown board");
      if (req.method() === "POST") {
        const n = store.nextMeeting++;
        const created = { id: "m-new-" + n, boardId: b, title: "Meeting", state: 0, brief: "" };
        store.meetings[b] = [...(store.meetings[b] || []).filter((x) => x.id !== created.id), created];
        return J(created);
      }
      const d = takeDelay("meetings");
      if (d) await sleep(d);
      let out = (store.meetings[b] || []).slice();
      const q = (u.searchParams.get("q") || "").toLowerCase();
      if (q) {
        // Filtered search scans the whole board history, so MOLD (outside the
        // unfiltered newest-200 window) still matches a fitting query.
        if (b === "b-alpha" && (MOLD.title + " " + MOLD.brief).toLowerCase().includes(q)) out = [...out, MOLD];
        out = out.filter((x) => (x.title + " " + (x.brief || "")).toLowerCase().includes(q));
      }
      const st = u.searchParams.get("state");
      if (st && st in STATE_NUM) out = out.filter((x) => x.state === STATE_NUM[st]);
      return J(out);
    }
    if ((m = p.match(/^\/api\/boards\/([^/]+)\/meetings\/([^/]+)$/)) && req.method() === "GET") {
      if (store.failOne && (store.failOne.key === "meeting-detail" || store.failOne.key === m[2])) {const st=store.failOne.status||500;store.failOne=null;return route.fulfill({status:st,contentType:"application/json",body:JSON.stringify({error:"injected"})});}
      const found = meetingById(m[2]);
      if (!boardById(m[1]) || !found || found.boardId !== m[1]) return V("unknown meeting");
      return J(found);
    }
    if ((m = p.match(/^\/api\/boards\/([^/]+)\/(setup|status)$/))) {
      const b = boardById(m[1]);
      if (!b) return V("unknown board");
      return J(m[2] === "setup" ? setupFor(b) : statusFor(b));
    }
    if ((m = p.match(/^\/api\/boards\/([^/]+)\/(advisors|sources|directions|invites|grants)$/))) {
      if (!boardById(m[1])) return V("unknown board");
      if (m[2] === "advisors" && req.method() === "GET") return J(store.advisors[m[1]] || []);
      return J([]);
    }
    if ((m = p.match(/^\/api\/boards\/([^/]+)\/advisors\/([^/]+)\/chat$/)) && req.method() === "POST") {
      const list = store.advisors[m[1]] || [];
      const a = list.find((x) => x.id === m[2]);
      if (!a) return V("unknown advisor");
      return J({ answer: "Fixture reply from " + a.boardRole + ": noted." });
    }
    if ((m = p.match(/^\/api\/boards\/([^/]+)\/advisors\/([^/]+)\/approve$/)) && req.method() === "POST") {
      const list = store.advisors[m[1]] || [];
      const a = list.find((x) => x.id === m[2]);
      if (!a) return V("unknown advisor");
      a.approved = true;
      return J(a);
    }
    if ((m = p.match(/^\/api\/boards\/([^/]+)\/recall$/))) {
      if (!boardById(m[1])) return V("unknown board");
      return J([]);
    }
    if ((m = p.match(/^\/api\/meetings\/([^/]+)\/(pause|resume|end|reopen)$/)) && req.method() === "POST") {const mm=meetingById(m[1]);if(!mm)return V("unknown meeting");const op=m[2];if(op==="pause")mm.state=3;else if(op==="resume")mm.state=1;else if(op==="end")mm.state=4;else if(op==="reopen")mm.state=1;return J(mm);}
    if ((m = p.match(/^\/api\/meetings\/([^/]+)\/close$/)) && req.method() === "POST") {const mm=meetingById(m[1]);if(!mm)return V("unknown meeting");let bb={};try{bb=req.postDataJSON()||{};}catch{}mm.state=bb.withRecord?6:7;return J(mm);}
    if ((m = p.match(/^\/api\/meetings\/([^/]+)\/run$/)) && req.method() === "POST") {const mm=meetingById(m[1]);if(!mm)return V("unknown meeting");if(!mm.brief||!mm.brief.trim())return J({error:"Brief required."},409);if(mm.state===3)return J({error:"Paused."},409);return J({published:[],yielded:[],abstained:[],overflow:null});}
    if ((m = p.match(/^\/api\/meetings\/([^/]+)\/(briefings|notes)$/)) && req.method() === "POST") {const mm=meetingById(m[1]);if(!mm)return V("unknown meeting");return J({id:"n-"+store.nextRecord,boardId:mm.boardId,meetingId:m[1],kind:"note"});}
    if ((m = p.match(/^\/api\/meetings\/([^/]+)$/))) {
      if (req.method() !== "PATCH") return N("no fixture");
      const found = meetingById(m[1]);
      if (!found) return V("unknown meeting");
      let body = {};
      try { body = req.postDataJSON() || {}; } catch {}
      if (typeof body.title === "string" && body.title) found.title = body.title;
      if (typeof body.brief === "string") {found.brief = body.brief; if (found.brief && found.state === 0) found.state = 1;}
      return J(found);
    }
    if ((m = p.match(/^\/api\/meetings\/([^/]+)\/messages$/))) {
      const found = meetingById(m[1]);
      if (!found && !String(m[1]).startsWith("m-new-")) return V("unknown meeting");
      if (m[1] === "m-one") return J(MSGS1);
      if (m[1] === "m-old") return J(MSGOLD);
      return J([]);
    }
    if ((m = p.match(/^\/api\/meetings\/([^/]+)\/messages\/search$/))) {
      const found = meetingById(m[1]);
      if (!found && !String(m[1]).startsWith("m-new-")) return V("unknown meeting");
      const q = (u.searchParams.get("q") || "").toLowerCase();
      const pool = m[1] === "m-one" ? MSGS1 : m[1] === "m-old" ? MSGOLD : [];
      return J(pool.filter((x) => x.content.toLowerCase().includes(q)).map((x) => ({ sequence: x.sequence, sender: x.sender, advisorName: x.advisorName, excerpt: x.content })));
    }
    if ((m = p.match(/^\/api\/meetings\/([^/]+)\/delivery$/))) {
      const found = meetingById(m[1]);
      if (!found && !String(m[1]).startsWith("m-new-")) return V("unknown meeting");
      return J({ state: "Active", deliveredRevision: 2, messages: m[1] === "m-one" ? 2 : m[1] === "m-old" ? 1 : 0, lastSequence: m[1] === "m-one" ? 2 : m[1] === "m-old" ? 1 : 0 });
    }
    if ((m = p.match(/^\/api\/meetings\/([^/]+)\/notes$/))) {
      const found = meetingById(m[1]);
      if (!found && !String(m[1]).startsWith("m-new-")) return V("unknown meeting");
      return J([]);
    }
    if ((m = p.match(/^\/api\/meetings\/([^/]+)\/records$/))) {
      const found = meetingById(m[1]);
      if (!found && !String(m[1]).startsWith("m-new-")) return V("unknown meeting");
      const d = takeDelay("records");
      if (d) await sleep(d);
      return J(store.drafts[m[1]] || []);
    }
    if ((m = p.match(/^\/api\/meetings\/([^/]+)\/record\/draft$/)) && req.method() === "POST") {
      const found = meetingById(m[1]);
      if (!found && !String(m[1]).startsWith("m-new-")) return V("unknown meeting");
      const boardId = found ? found.boardId : "b-alpha";
      const n = store.nextRecord++;
      const rec = { id: "r-new-" + n, boardId, meetingId: m[1], version: 1, hash: "h-new-" + n, watermark: 2, itemsJson: '[{"id":"n","text":"QA draft item"}]', decided: false, status: "draft", approvedJson: "[]", supersedesJson: "[]" };
      store.drafts[m[1]] = [...(store.drafts[m[1]] || []), rec];
      store.byRecordId[rec.id] = rec;
      return J(rec);
    }
    if ((m = p.match(/^\/api\/meetings\/([^/]+)\/record\/approve$/)) && req.method() === "POST") {let bb={};try{bb=req.postDataJSON()||{};}catch{}const dd=store.byRecordId[bb.draftId];if(!dd)return V("unknown record");dd.decided=true;dd.status="approved";try{dd.approvedJson=JSON.stringify(bb.itemIds||[]);}catch{}return J({approved:bb.itemIds||[],draft:dd.id});}
    if ((m = p.match(/^\/api\/records\/([^/]+)\/(revise|amend)$/)) && req.method() === "POST") {
      const old = store.byRecordId[m[1]];
      if (!old) return V("unknown record");
      const n = store.nextRecord++;
      const rec = { ...old, id: "r-new-" + n, version: old.version + 1, hash: "h-new-" + n, itemsJson: '[{"id":"n","text":"QA revised item"}]', decided: false, status: "draft" };
      store.drafts[old.meetingId] = [...(store.drafts[old.meetingId] || []), rec];
      store.byRecordId[rec.id] = rec;
      return J(rec);
    }
    if ((m = p.match(/^\/api\/records\/([^/]+)\/discard$/)) && req.method() === "POST") {const dd=store.byRecordId[m[1]];if(!dd)return V("unknown record");dd.decided=true;dd.status="discarded";return J(dd);}
    if ((m = p.match(/^\/api\/records\/([^/]+)$/))) {
      if (store.byRecordId[m[1]]) return J(store.byRecordId[m[1]]);
      return V("unknown record");
    }
    if (p === "/api/wizard" && req.method() === "POST") {let body={};try{body=req.postDataJSON()||{};}catch{}let wid=(body.id&&typeof body.id==="string")?body.id:"";if(wid&&store.wizards[wid]){const w=store.wizards[wid];if(body.version===undefined||body.version!==w.version)return J({error:"Stale"},409);if(body.step!==undefined)w.step=body.step;if(body.presetKey)w.presetKey=body.presetKey;if(body.fieldsJson!==undefined)w.fieldsJson=body.fieldsJson;if(body.interviewJson)w.interviewJson=body.interviewJson;if(body.accountId)w.accountId=body.accountId;w.version+=1;return J({id:w.id,version:w.version,step:w.step,presetKey:w.presetKey,fieldsJson:w.fieldsJson,interviewJson:w.interviewJson,status:w.status,accountId:w.accountId});}const nid="w-"+(store.wizNext++);const w2={id:nid,version:1,step:body.step||1,presetKey:body.presetKey||"strategy",fieldsJson:body.fieldsJson||"{}",interviewJson:body.interviewJson||"{}",status:"Saved",accountId:body.accountId||""};w2.version+=1;store.wizards[nid]=w2;return J({id:w2.id,version:w2.version,step:w2.step,presetKey:w2.presetKey,fieldsJson:w2.fieldsJson,interviewJson:w2.interviewJson,status:w2.status,accountId:w2.accountId});}
    if ((m = p.match(/^\/api\/wizard\/([^/]+)$/)) && req.method() === "GET") {const w=store.wizards[m[1]];if(!w)return V("unknown wizard");return J({id:w.id,version:w.version,step:w.step,presetKey:w.presetKey,fieldsJson:w.fieldsJson,interviewJson:w.interviewJson,status:w.status,accountId:w.accountId});}
    if ((m = p.match(/^\/api\/wizard\/([^/]+)\/review$/))) {const w=store.wizards[m[1]];if(!w)return V("unknown wizard");let f={};try{f=JSON.parse(w.fieldsJson||"{}");}catch{}const adv=Array.isArray(f.advisors)?f.advisors.filter((x)=>x&&x.role):[];const lead=(f.lead&&f.lead.name)?f.lead.name:"";const blockers=[];if(!f.name)blockers.push({field:"name",step:1,message:"Give."});if(!f.mission)blockers.push({field:"mission",step:1,message:"Describe."});if(adv.length===0)blockers.push({field:"advisors",step:2,message:"Add."});if(!lead)blockers.push({field:"lead",step:3,message:"Lead."});const fields=[{field:"name",step:1,status:f.name?"set":"missing"}];return J({step:blockers.length?blockers[0].step:4,preset:w.presetKey,status:blockers.length?"Blocked":"Ready",blockers,fields});}
    if ((m = p.match(/^\/api\/wizard\/([^/]+)\/(suggest|interview)$/)) && req.method() === "POST") {const w=store.wizards[m[1]];if(!w)return V("unknown wizard");w.version+=1;if(m[2]==="suggest")return J({suggestion:"Fixture guide.",nextQuestion:"Fixture?",fields:{}});return J({question:"Fixture?",analysis:"Recorded.",applied:[],turns:[],checkpoints:[],version:w.version});}
    if ((m = p.match(/^\/api\/wizard\/([^/]+)\/create$/)) && req.method() === "POST") {const w=store.wizards[m[1]];if(!w)return V("unknown wizard");if(w.status&&w.status.indexOf("created:")===0){const bid=w.status.slice(8);const prior=store.boards.find((x)=>x.id===bid);if(prior)return J({board:prior,advisors:[],resumed:true});}let f={};try{f=JSON.parse(w.fieldsJson||"{}");}catch{}const adv=Array.isArray(f.advisors)?f.advisors.filter((x)=>x&&x.role):[];const lead=(f.lead&&f.lead.name)?f.lead.name:"";const blockers=[];if(!f.name)blockers.push({field:"name",step:1});if(!f.mission)blockers.push({field:"mission",step:1});if(!adv.length)blockers.push({field:"advisors",step:2});if(!lead)blockers.push({field:"lead",step:3});if(blockers.length)return J({blockers},409);const nn=store.nextBoard++;const nb={id:"b-new-"+nn,name:f.name,mission:f.mission};store.boards=[...store.boards,nb];store.meetings[nb.id]=[];store.advisors[nb.id]=[];w.status="created:"+nb.id;w.version+=1;return J({board:nb,advisors:[]});}
    if (p === "/api/lead") return J(LEAD);
    if (p === "/api/presets") return J([]);
    if (p === "/api/roster") return J([]);
    if (p === "/api/roster/count") return J({ total: 0 });
    if (/^\/api\/roster\/[^/]+\/images$/.test(p)) return J([]);
    if (p === "/api/activity/jobs") return J([]);
    if (p === "/api/activity/audit") return J([]);
    if (p === "/api/usage") return J([]);
    if (p === "/api/models/calls") return J([]);
    if (p === "/api/model/status") return J({ configured: false, source: "", model: "muse-spark-1.3", chatOverride: "", keyHint: "", lastTestAt: null, lastTestOk: false, lastTestModel: "", lastTestError: "" });
    if (p === "/api/spending") return J({ month: "2026-11", monthlyCapUsd: null, mode: "warn", knownSpendUsd: 0, unknownCostCalls: 0, overCap: false, enforced: false, note: "fixture" });
    if (p === "/api/commands") return J([{ command: "meetings", view: "Meetings", action: "Open a meeting" }]);
    if (p === "/api/auth/me") return J({ user: "qa-fixture", authenticated: false });
    return N("no fixture");
  };
}

module.exports = { B1, B2, BOLD, M1, M2, MOLD, fixtureHandler };
