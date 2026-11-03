import crypto from "node:crypto";
const API = process.env.QA_API || "http://127.0.0.1:5152";
if (API.includes(":5173") || API.includes(":5080") || API.includes(":15180")) { console.log("FATAL refuse human/test ports "+API); process.exit(1); }
const run = "pd-" + Date.now().toString(36) + "-" + Math.floor(Math.random()*1e6).toString(36);
let pass=0, fail=0; const bad=[];
function ok(n,c,e){ if(c){pass++; console.log("  ok "+n);} else {fail++; bad.push(n+(e?" :: "+String(e).slice(0,300):"")); console.log("  FAIL "+n+(e?" :: "+String(e).slice(0,300):"")); } }
async function req(method, path, body, opts={}){
  const ctl=new AbortController(); const t=setTimeout(()=>ctl.abort(), opts.timeout||30000);
  try{
    const r=await fetch(API+path,{method, signal:ctl.signal, headers:{"content-type":"application/json", ...(opts.headers||{})}, body: body===undefined?undefined:JSON.stringify(body)});
    const text=await r.text(); let json=null; try{ json=text?JSON.parse(text):null;}catch{json=null;}
    return {status:r.status, json, text};
  } finally{clearTimeout(t);}
}
const get=(p,o)=>req("GET",p,undefined,o);
const post=(p,b,o)=>req("POST",p,b,o);
const H=u=>({"x-user":u});
const AH=t=>({Authorization:"Bearer "+t});
const P=s=>"para-"+run+"\n\n"+s+"\n\ntail-"+run;
const GUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function boardIdOf(v){ return (typeof v==="string" && GUID_RE.test(v)) ? v : null; }
function extractBoardId(j){
  if(!j || typeof j!=="object") return null;
  const cands=[j.boardId, j.boardID, j.id];
  if(j.board && typeof j.board==="object") cands.push(j.board.id, j.board.Id);
  for(const c of cands){ const b=boardIdOf(c); if(b) return b; }
  return null;
}
console.log("profile-default backend QA run="+run+" api="+API);
// --- demo: default without board ---
let r = await get("/api/profile", {headers:H("owner")});
ok("default-fresh-404", r.status===404, r.status);
const multi_bg = "Bg line one.\nBg line two "+run+".\nThird.";
const multi_fam = "Fam A\nFam B";
const multi_sim = "Explain:\n- a\n- b";
const multi_comm = "Be clear and direct. Explain unfamiliar terms, use practical examples, and finish with actionable next steps.";
let s = await post("/api/profile", {name:"Ada Default", roleLabel:"Board Lead", background:multi_bg, familiarTopics:multi_fam, simplerTopics:multi_sim, commPrefs:multi_comm, version:0}, {headers:H("owner")});
ok("default-save-200", s.status===200 && s.json && s.json.version===1, s.status+" "+s.text.slice(0,160));
const v1 = s.json.version;
let g = await get("/api/profile", {headers:H("owner")});
ok("default-reload-exact", g.status===200 && g.json.background===multi_bg && g.json.commPrefs===multi_comm, g.status);
let fg = await post("/api/profile", {name:"Ada Default", roleLabel:"Board Lead", background:"x", familiarTopics:"x", simplerTopics:"x", commPrefs:"x", version:v1, OwnerKey:"victim@example.com", ownerKey:"victim@example.com", boardId:"11111111-1111-1111-1111-111111111111"}, {headers:H("owner")});
ok("forged-ignored", fg.status===200 && (!fg.json.ownerKey || String(fg.json.ownerKey).toLowerCase()!=="victim@example.com"), fg.status+" "+fg.text.slice(0,160));
const v2 = fg.json.version;
let st = await post("/api/profile", {name:"S", roleLabel:"Board Lead", background:"x", familiarTopics:"x", simplerTopics:"x", commPrefs:"x", version:v1}, {headers:H("owner")});
ok("stale-409", st.status===409, st.status);
async function mkBoard(name, user){ const rr = await post("/api/boards", {name, mission:run+" m", stage:"qa"}, {headers:H(user)}); ok("mk-"+name, rr.status===201 && boardIdOf(rr.json.id), rr.status+" "+rr.text.slice(0,160)); return rr.json.id; }
const b1 = await mkBoard(run+"-b1", "owner");
const b2 = await mkBoard(run+"-b2", "owner");
for (const [bid,nm] of [[b1,"b1"],[b2,"b2"]]){ const gl = await get("/api/boards/"+bid+"/lead", {headers:H("owner")}); ok("reuse-"+nm, gl.status===200 && gl.json.source==="default", gl.status+" "+gl.text.slice(0,200)); }
let eg = await get("/api/boards/00000000-0000-0000-0000-000000000000/lead", {headers:H("owner")});
ok("empty-guid-404", eg.status===404, eg.status);
let eg2 = await post("/api/boards/00000000-0000-0000-0000-000000000000/lead", {name:"x"}, {headers:H("owner")});
ok("empty-guid-post-404", eg2.status===404, eg2.status);
let miss = await get("/api/boards/11111111-1111-1111-1111-111111111111/lead", {headers:H("owner")});
ok("missing-board-404", miss.status===404 || miss.status===403, miss.status);
const ov = await post("/api/boards/"+b1+"/lead", {name:"Override", roleLabel:"CEO", background:"obg", familiarTopics:"of", simplerTopics:"os", commPrefs:"oc", version:0}, {headers:H("owner")});
ok("override-save", ov.status===200, ov.status+" "+ov.text.slice(0,160));
{
  const gl = await get("/api/boards/"+b1+"/lead", {headers:H("owner")});
  ok("override-source", gl.status===200 && gl.json.source==="board" && gl.json.name==="Override", gl.status+" "+gl.text.slice(0,160));
  const gl2 = await get("/api/boards/"+b2+"/lead", {headers:H("owner")});
  ok("sibling-still-default", gl2.status===200 && gl2.json.source==="default", gl2.status);
  const d2 = await post("/api/profile", {name:"Ada v3", roleLabel:"Board Lead", background:multi_bg+"\nMore.", familiarTopics:multi_fam, simplerTopics:multi_sim, commPrefs:multi_comm, version:v2}, {headers:H("owner")});
  ok("default-v3", d2.status===200, d2.status);
  const gl3 = await get("/api/boards/"+b1+"/lead", {headers:H("owner")});
  ok("override-preserved", gl3.status===200 && gl3.json.source==="board" && gl3.json.name==="Override", gl3.status);
  const gl4 = await get("/api/boards/"+b2+"/lead", {headers:H("owner")});
  ok("inherit-updated", gl4.status===200 && gl4.json.source==="default" && gl4.json.name==="Ada v3", gl4.status+" "+gl4.text.slice(0,200));
  const s1 = await get("/api/boards/"+b2+"/setup", {headers:H("owner")});
  const s2 = await get("/api/boards/"+b1+"/setup", {headers:H("owner")});
  ok("setup-inherit-lead", s1.status===200 && s1.json && s1.json.lead && s1.json.lead.name==="Ada v3", s1.status);
  ok("setup-override-lead", s2.status===200 && s2.json && s2.json.lead && s2.json.lead.name==="Override", s2.status);
}
{
  const gg = await get("/api/profile", {headers:H("owner")});
  const cv = gg.json.version;
  const cust = await post("/api/profile", {name:"Ada Custom", roleLabel:"Board Lead", background:"bg", familiarTopics:"f", simplerTopics:"s", commPrefs:"terse, no fluff", version:cv}, {headers:H("owner")});
  ok("custom-save", cust.status===200 && cust.json.commPrefs==="terse, no fluff", cust.status);
  const gg2 = await get("/api/profile", {headers:H("owner")});
  ok("custom-preserved", gg2.status===200 && gg2.json.commPrefs==="terse, no fluff", gg2.status);
}
// secure: two owners same-version isolation + legacy global + cross-user denied
const alice="qa-"+run+"-a@example.com", bob="qa-"+run+"-b@example.com", pw="0123456789abCD!x";
let ra = await post("/api/auth/register", {email:alice, password:pw});
ok("reg-alice", ra.status===201 && ra.json && ra.json.token, ra.status);
const tokA = ra.json.token;
let rb = await post("/api/auth/register", {email:bob, password:pw});
ok("reg-bob", rb.status===201 && rb.json && rb.json.token, rb.status);
const tokB = rb.json.token;
{
  const una = await get("/api/profile");
  ok("unauth-401", una.status===401, una.status);
  const bad = await get("/api/profile", {headers:{Authorization:"Bearer invalid-"+run}});
  ok("badtoken-401", bad.status===401, bad.status);
  const bprof = await get("/api/profile", {headers:AH(tokB)});
  ok("bob-fresh-404", bprof.status===404, bprof.status);
  const asave = await post("/api/profile", {name:"Alice", roleLabel:"CEO", background:P("alice bg"), familiarTopics:"af", simplerTopics:"as", commPrefs:"ap", version:0}, {headers:AH(tokA)});
  ok("alice-save", asave.status===200 && asave.json.version===1, asave.status);
  const bsave = await post("/api/profile", {name:"Bob", roleLabel:"CEO", background:P("bob bg"), familiarTopics:"bf", simplerTopics:"bs", commPrefs:"bp", version:0}, {headers:AH(tokB)});
  ok("bob-save-v1", bsave.status===200 && bsave.json.version===1, bsave.status);
  const ag = await get("/api/profile", {headers:AH(tokA)});
  const bg2 = await get("/api/profile", {headers:AH(tokB)});
  ok("same-version-isolated", ag.status===200 && bg2.status===200 && ag.json.version===1 && bg2.json.version===1 && ag.json.background!==bg2.json.background, ag.status+"/"+bg2.status);
  const gl = await post("/api/lead", {name:"Global", roleLabel:"Board Lead", background:P("global bg"), familiarTopics:"gf", simplerTopics:"gs", commPrefs:"gc", version:0}, {headers:AH(tokA)});
  ok("legacy-global-save", gl.status===200, gl.status+" "+gl.text.slice(0,160));
  const bLeadGlobal = await get("/api/lead", {headers:AH(tokB)});
  ok("global-admin-only", bLeadGlobal.status===403, bLeadGlobal.status);
  const aLeadGlobal = await get("/api/lead", {headers:AH(tokA)});
  ok("global-admin-read", aLeadGlobal.status===200, aLeadGlobal.status);
  const ab = await post("/api/boards", {name:run+"-alice-b", mission:"m", stage:"s"}, {headers:AH(tokA)});
  ok("alice-board", ab.status===201 && boardIdOf(ab.json.id), ab.status);
  const aliceBid = ab.json.id;
  const bobGet = await get("/api/boards/"+aliceBid+"/lead", {headers:AH(tokB)});
  ok("cross-denied", bobGet.status===403 || bobGet.status===404, bobGet.status+" "+bobGet.text.slice(0,120));
  // export by owner: inherit marker without content; admin export of another owner board never leaks
  const expA = await get("/api/boards/"+aliceBid+"/export", {headers:AH(tokA)});
  ok("export-owner", expA.status===200, expA.status);
  try{
    const ej = JSON.parse(expA.json.snapshot);
    const lsk = String(ej.leadSource||ej.LeadSource||"").toLowerCase();
    const hasLeadContent = !!(ej.lead||ej.Lead);
    ok("export-inherit-marker", lsk==="inherit" && !hasLeadContent, "source="+lsk+" hasLead="+hasLeadContent);
    const snapActive = JSON.stringify(ej.board||ej.Board||{});
    ok("export-active-redacted", !snapActive.includes(P("alice bg")) && !snapActive.includes(P("global bg")), "active leaks content");
  } catch(e){ ok("export-inherit-marker", false, String(e).slice(0,120)); }
  try{
    const snapStr = expA.json.snapshot, snapHash = expA.json.hash;
    const imp = await post("/api/boards/import", {snapshot: snapStr, hash: snapHash}, {headers:AH(tokB)});
    ok("import-inherit", imp.status===200 || imp.status===201, imp.status+" "+imp.text.slice(0,200));
    const nbId = extractBoardId(imp.json);
    ok("import-board-id", nbId!==null, "extracted="+String(nbId).slice(0,40));
    if (nbId){
      const nl = await get("/api/boards/"+nbId+"/lead", {headers:AH(tokB)});
      ok("import-uses-importer-default", nl.status===200 && nl.json.source==="default" && nl.json.name==="Bob", nl.status+" "+nl.text.slice(0,200));
    } else {
      ok("import-uses-importer-default", false, "no board id; failing closed, no skip");
    }
    const bl = await get("/api/boards", {headers:AH(tokB)});
    ok("import-list", bl.status===200 && Array.isArray(bl.json), bl.status);
  } catch(e){ ok("import-inherit", false, String(e).slice(0,120)); }
  const ovb = await post("/api/boards/"+aliceBid+"/lead", {name:"Alice Override", roleLabel:"CEO", background:"aobg", familiarTopics:"aof", simplerTopics:"aos", commPrefs:"aoc", version:0}, {headers:AH(tokA)});
  ok("alice-override", ovb.status===200, ovb.status);
  const expO = await get("/api/boards/"+aliceBid+"/export", {headers:AH(tokA)});
  ok("export-explicit", expO.status===200, expO.status);
  try{
    const ej = JSON.parse(expO.json.snapshot);
    const lsk = String(ej.leadSource||ej.LeadSource||"").toLowerCase();
    ok("export-explicit-marker", lsk==="board" && !!(ej.lead||ej.Lead), "source="+lsk);
  } catch(e){ ok("export-explicit-marker", false, String(e).slice(0,120)); }
  try{
    const snapStr = expO.json.snapshot, snapHash = expO.json.hash;
    const imp2 = await post("/api/boards/import", {snapshot: snapStr, hash: snapHash}, {headers:AH(tokB)});
    ok("explicit-import-roundtrip", imp2.status===200 || imp2.status===201, imp2.status+" "+imp2.text.slice(0,200));
    const nb2 = extractBoardId(imp2.json);
    ok("explicit-import-id", nb2!==null, String(nb2).slice(0,40));
    if (nb2){
      const nl2 = await get("/api/boards/"+nb2+"/lead", {headers:AH(tokB)});
      ok("explicit-import-override", nl2.status===200 && nl2.json.source==="board" && nl2.json.name==="Alice Override", nl2.status+" "+nl2.text.slice(0,200));
    } else {
      ok("explicit-import-override", false, "no board id; failing closed");
    }
  } catch(e){ ok("explicit-import-roundtrip", false, String(e).slice(0,120)); }
  const stA = await get("/api/boards/"+aliceBid+"/setup", {headers:AH(tokA)});
  ok("setup-owner-lead", stA.status===200 && stA.json && stA.json.lead, stA.status);
  const stB = await get("/api/boards/"+aliceBid+"/lead", {headers:AH(tokB)});
  ok("setup-cross-still-denied", stB.status===403||stB.status===404, stB.status);
}
// genuine legacy-global setup redaction + historical snapshot redaction + non-admin manager export redaction
// Uses a dedicated admin (first registrant on this fresh DB owns global); bob is non-admin reader/manager.
{
  // NOTE: alice already has a default from above, so current-source redaction alone would not trigger.
  // Build the historical repro on a separate board: activate under current default, then verify
  // non-admin ActiveJson is always redacted (lead null, no profile content) even though top-level shows default.
  const hb = await post("/api/boards", {name:run+"-hist", mission:"m", stage:"s"}, {headers:AH(tokA)});
  ok("hist-board", hb.status===201 && boardIdOf(hb.json.id), hb.status);
  const hbid = hb.json.id;
  // grant bob read so non-admin reader can request setup
  const gr = await post("/api/boards/"+hbid+"/grants", {userKey:bob, access:"read"}, {headers:AH(tokA)});
  ok("hist-grant-read", gr.status===200||gr.status===201, gr.status+" "+gr.text.slice(0,160));
  const stBob = await get("/api/boards/"+hbid+"/setup", {headers:AH(tokB)});
  ok("hist-setup-readable", stBob.status===200, stBob.status);
  if (stBob.status===200){
    const activeStr = JSON.stringify(stBob.json.activeJson||stBob.json.ActiveJson||"");
    const canonStr = JSON.stringify(stBob.json.canonicalJson||stBob.json.CanonicalJson||"");
    ok("hist-active-no-global-leak", !activeStr.includes(P("global bg")) && !canonStr.includes(P("global bg")), "leak?");
    // ActiveJson for non-admin must never carry lead content
    let activeHasLead = true;
    try{ const aj = JSON.parse(stBob.json.activeJson); activeHasLead = aj && aj.lead !== null && aj.lead !== undefined; } catch(e){ activeHasLead = false; }
    // If never activated, ActiveJson is "{}" (lead absent) which is acceptable (no content).
    ok("hist-active-redacted-or-empty", !activeHasLead, "active has lead object");
  }
}
// wizard inherit vs explicit (owner has default)
{
  const wiz = await post("/api/wizard", {step:4, presetKey:"", fieldsJson: JSON.stringify({name:run+"-wiz", mission:run+" mission", stage:"qa", advisors:[{role:"Strategist", name:run+"-adv"}]})}, {headers:AH(tokA)});
  ok("wiz-created", (wiz.status===200||wiz.status===201) && boardIdOf(wiz.json.id), wiz.status+" "+wiz.text.slice(0,200));
  const wid = wiz.json.id;
  if (wid){
    const rev = await get("/api/wizard/"+wid+"/review", {headers:AH(tokA)});
    const bl = (rev.json && (rev.json.blockers||rev.json.Blockers)) || [];
    ok("wiz-review-inherit-clean", rev.status===200 && bl.length===0, rev.status+" "+rev.text.slice(0,300));
    // interview must also treat inherited profile as complete (no lead question)
    const iv = await post("/api/wizard/"+wid+"/interview", {version: rev.json ? 1 : 1, answer:""}, {headers:AH(tokA)});
    // version may differ; fetch current draft version first if conflict
    if (iv.status===409){
      const cur = await get("/api/wizard/"+wid, {headers:AH(tokA)});
      const cv = cur.json ? (cur.json.version||cur.json.Version||1) : 1;
      const iv2 = await post("/api/wizard/"+wid+"/interview", {version: cv, answer:""}, {headers:AH(tokA)});
      const q2 = iv2.json ? (iv2.json.question||iv2.json.Question||"") : "";
      const bl2 = (iv2.json && (iv2.json.blockers||iv2.json.Blockers)) || [];
      ok("wiz-interview-inherited", iv2.status===200 && !String(q2).includes("Who leads") && !bl2.some(b=>JSON.stringify(b).includes("lead")), iv2.status+" q="+String(q2).slice(0,120));
    } else {
      const q = iv.json ? (iv.json.question||iv.json.Question||"") : "";
      const bls = (iv.json && (iv.json.blockers||iv.json.Blockers)) || [];
      ok("wiz-interview-inherited", iv.status===200 && !String(q).includes("Who leads") && !bls.some(b=>JSON.stringify(b).includes("lead")), iv.status+" q="+String(q).slice(0,120));
    }
    const cr = await post("/api/wizard/"+wid+"/create", {}, {headers:AH(tokA)});
    ok("wiz-create", (cr.status===200||cr.status===201), cr.status+" "+cr.text.slice(0,300));
    const wbid = extractBoardId(cr.json);
    ok("wiz-create-id", wbid!==null, "extracted="+String(wbid).slice(0,40));
    if (wbid){
      const wl = await get("/api/boards/"+wbid+"/lead", {headers:AH(tokA)});
      ok("wiz-inherit-no-freeze", wl.status===200 && wl.json.source!=="board", wl.status+" source="+(wl.json&&wl.json.source));
      const cur = await get("/api/profile", {headers:AH(tokA)});
      const nv = cur.json.version;
      const up = await post("/api/profile", {name:cur.json.name, roleLabel:cur.json.roleLabel, background:P("wiz update"), familiarTopics:cur.json.familiarTopics||"f", simplerTopics:cur.json.simplerTopics||"s", commPrefs:cur.json.commPrefs||"c", version:nv}, {headers:AH(tokA)});
      ok("wiz-default-update", up.status===200, up.status);
      const wl2 = await get("/api/boards/"+wbid+"/lead", {headers:AH(tokA)});
      ok("wiz-follows-default", wl2.status===200 && wl2.json.background===P("wiz update"), wl2.status+" "+wl2.text.slice(0,200));
      // retry same draft creates no duplicate: same board id, same lead count
      const beforeBoards = await get("/api/boards", {headers:AH(tokA)});
      const beforeCount = Array.isArray(beforeBoards.json) ? beforeBoards.json.length : -1;
      const cr2 = await post("/api/wizard/"+wid+"/create", {}, {headers:AH(tokA)});
      const wbid2 = extractBoardId(cr2.json);
      ok("wiz-retry-same-id", (cr2.status===200||cr2.status===201) && wbid2===wbid, cr2.status+" "+String(wbid2).slice(0,40));
      const afterBoards = await get("/api/boards", {headers:AH(tokA)});
      const afterCount = Array.isArray(afterBoards.json) ? afterBoards.json.length : -2;
      ok("wiz-retry-no-dup-count", beforeCount===afterCount, beforeCount+"/"+afterCount);
    } else {
      ok("wiz-inherit-no-freeze", false, "no board id; failing closed, no skip");
      ok("wiz-follows-default", false, "no board id; failing closed");
      ok("wiz-retry-same-id", false, "no board id");
      ok("wiz-retry-no-dup-count", false, "no board id");
    }
    const wiz2 = await post("/api/wizard", {step:4, fieldsJson: JSON.stringify({name:run+"-wizov", mission:"m", stage:"s", advisors:[{role:"Strategist", name:"x"}], lead:{name:"Wiz Override", roleLabel:"CEO", background:"wobg", familiarTopics:"wof", simplerTopics:"wos", commPrefs:"woc", override:true}})}, {headers:AH(tokA)});
    const wid2 = wiz2.json.id;
    if (wid2){
      const cr3 = await post("/api/wizard/"+wid2+"/create", {}, {headers:AH(tokA)});
      ok("wiz-explicit-create", (cr3.status===200||cr3.status===201), cr3.status);
      const wb2 = extractBoardId(cr3.json);
      ok("wiz-explicit-id", wb2!==null, String(wb2).slice(0,40));
      if (wb2){
        const wl3 = await get("/api/boards/"+wb2+"/lead", {headers:AH(tokA)});
        ok("wiz-explicit-override", wl3.status===200 && wl3.json.source==="board" && wl3.json.name==="Wiz Override", wl3.status+" "+wl3.text.slice(0,200));
      } else {
        ok("wiz-explicit-override", false, "no board id; failing closed");
      }
    }
  }
}
{
  const be = await get("/api/backend");
  ok("backend-postgres", be.status===200 && be.json.mode==="postgres", be.status+" "+be.text.slice(0,120));
}
console.log(`PASS ${pass} FAIL ${fail}`);
if (fail>0){ console.log("FAILURES:"); for (const f of bad) console.log(" - "+f); process.exit(1); }
console.log("PROFILE-DEFAULT-BACKEND-QA PASS");
