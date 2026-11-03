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
// Single-line unique markers for leak detection inside serialized JSON (no raw newlines).
const MK = g=>"MK-"+run+"-"+g;
const GUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function boardIdOf(v){ return (typeof v==="string" && GUID_RE.test(v)) ? v : null; }
function extractBoardId(j){
  if(!j || typeof j!=="object") return null;
  const cands=[j.boardId, j.boardID, j.id, j.Id];
  if(j.board && typeof j.board==="object") cands.push(j.board.id, j.board.Id);
  for(const c of cands){ const b=boardIdOf(c); if(b) return b; }
  return null;
}
// Recursively collect all string values from a parsed JSON value.
function stringsOf(v, out=[]){
  if(typeof v==="string"){ out.push(v); return out; }
  if(Array.isArray(v)){ for(const x of v) stringsOf(x,out); return out; }
  if(v && typeof v==="object"){ for(const k of Object.keys(v)) stringsOf(v[k],out); return out; }
  return out;
}
function parsedLeadOfActive(activeJson){
  try{
    const o = typeof activeJson==="string" ? JSON.parse(activeJson) : activeJson;
    if(!o || typeof o!=="object" || !("lead" in o)) return {present:false, value:undefined};
    return {present:true, value:o.lead};
  } catch { return {present:false, value:undefined, parseError:true}; }
}
// Export snapshots use web (camelCase) casing: board.activeJson. Accept legacy
// PascalCase only as fallback; never treat a missing/empty snapshot as proof.
function exportActiveJsonOf(ej){
  const b = (ej&&(ej.board||ej.Board))||{};
  const v = b.activeJson ?? b.ActiveJson ?? "";
  return typeof v==="string" ? v : "";
}
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
async function uploadPortrait(rid, authHeaders){
  const form = new FormData();
  form.append("file", new Blob([PNG], {type:"image/png"}), "qa.png");
  const ctl=new AbortController(); const t=setTimeout(()=>ctl.abort(), 30000);
  try{
    const r=await fetch(API+"/api/roster/"+rid+"/image/upload", {method:"POST", signal:ctl.signal, headers:{...(authHeaders||{})}, body:form});
    const text=await r.text(); let json=null; try{ json=text?JSON.parse(text):null;}catch{json=null;}
    return {status:r.status, json, text};
  } finally{clearTimeout(t);}
}
async function makeAdvisor(boardId, role, authHeaders, tag){
  // Every sub-step is asserted fail-closed by the caller via returned error.
  const nm = run+"-"+role+"-"+tag;
  const q = await post("/api/roster/quick", {accountId:"00000000-0000-0000-0000-000000000000", name:nm, description:role+" helping with "+run}, {headers:authHeaders});
  if(q.status!==201) return {error:"quick:"+q.status+" "+q.text.slice(0,160)};
  const rid = (q.json && (q.json.id||q.json.Id)) || null;
  if(!rid) return {error:"quick-noid"};
  const up = await uploadPortrait(rid, authHeaders);
  if(up.status!==201) return {error:"upload:"+up.status+" "+up.text.slice(0,160)};
  const imgs = await get("/api/roster/"+rid+"/images", {headers:authHeaders});
  const imgId = imgs.json && imgs.json[0] && (imgs.json[0].id||imgs.json[0].Id);
  if(!imgId) return {error:"noimg "+imgs.status};
  const rev = await post("/api/images/"+imgId+"/review", {decision:"accept"}, {headers:authHeaders});
  if(rev.status!==200) return {error:"review:"+rev.status+" "+rev.text.slice(0,160)};
  const cp = await post("/api/roster/"+rid+"/copy", {boardId, boardRole:role}, {headers:authHeaders});
  if(cp.status!==201) return {error:"copy:"+cp.status+" "+cp.text.slice(0,200)};
  const aid = (cp.json && (cp.json.id||cp.json.Id)) || null;
  if(!aid) return {error:"copy-noid"};
  const ap = await post("/api/boards/"+boardId+"/advisors/"+aid+"/approve", {}, {headers:authHeaders});
  if(ap.status!==200) return {error:"approve:"+ap.status+" "+ap.text.slice(0,200)};
  return {aid};
}
console.log("profile-default backend QA run="+run+" api="+API);
// --- demo: default without board (multiline exact via parsed JSON, not raw text) ---
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
const GLOBALMK = MK("global");
const DEFAULTMK = MK("default");
const OVERRIDEMK = MK("override");
{
  const una = await get("/api/profile");
  ok("unauth-401", una.status===401, una.status);
  const bad = await get("/api/profile", {headers:{Authorization:"Bearer invalid-"+run}});
  ok("badtoken-401", bad.status===401, bad.status);
  const bprof = await get("/api/profile", {headers:AH(tokB)});
  ok("bob-fresh-404", bprof.status===404, bprof.status);
  // GENUINE global flow FIRST: admin saves legacy global before any default exists,
  // so the global is the actual effective lead for activation (not shadowed).
  const gl = await post("/api/lead", {name:"Global", roleLabel:"Board Lead", background:GLOBALMK, familiarTopics:"gf", simplerTopics:"gs", commPrefs:"gc", version:0}, {headers:AH(tokA)});
  ok("legacy-global-save", gl.status===200, gl.status+" "+gl.text.slice(0,160));
  const bLeadGlobal = await get("/api/lead", {headers:AH(tokB)});
  ok("global-admin-only", bLeadGlobal.status===403, bLeadGlobal.status);
  const aLeadGlobal = await get("/api/lead", {headers:AH(tokA)});
  ok("global-admin-read", aLeadGlobal.status===200 && aLeadGlobal.json.background===GLOBALMK, aLeadGlobal.status);
  // Activate an admin-owned board under legacy global (no default yet, no override).
  const gact = await post("/api/boards", {name:run+"-globalact", mission:"m", stage:"s"}, {headers:AH(tokA)});
  ok("globalact-board", gact.status===201 && boardIdOf(gact.json.id), gact.status+" "+gact.text.slice(0,160));
  const gactBid = gact.json.id;
  const gadv = await makeAdvisor(gactBid, "Strategist", AH(tokA), "glob");
  ok("globalact-advisor", !gadv.error, gadv.error||"ok");
  const grev = await get("/api/boards/"+gactBid+"/setup", {headers:AH(tokA)});
  ok("globalact-review", grev.status===200 && grev.json && grev.json.draftHash, grev.status+" "+grev.text.slice(0,200));
  const gactv = await post("/api/boards/"+gactBid+"/setup/activate", {hash:grev.json.draftHash}, {headers:AH(tokA)});
  ok("globalact-activate-200", gactv.status===200, gactv.status+" "+gactv.text.slice(0,200));
  // Admin view must embed the global marker BEFORE any redaction assertions.
  const gAdmin = await get("/api/boards/"+gactBid+"/setup", {headers:AH(tokA)});
  ok("globalact-admin-setup", gAdmin.status===200, gAdmin.status);
  if(gAdmin.status===200){
    try{
      const ajx = JSON.parse(gAdmin.json.activeJson);
      const hasMk = ajx && ajx.lead && typeof ajx.lead.background==="string" && ajx.lead.background.includes(GLOBALMK);
      ok("globalact-active-contains-global", !!hasMk, "admin ActiveJson must embed legacy global");
    } catch(e){ ok("globalact-active-contains-global", false, String(e).slice(0,160)); }
  } else {
    ok("globalact-active-contains-global", false, "no admin setup; failing closed");
  }
  // Non-admin reader: everything redacted, no global leak, unchanged => dirty false.
  const ggr = await post("/api/boards/"+gactBid+"/grants", {userKey:bob, access:"read"}, {headers:AH(tokA)});
  ok("globalact-grant-read", ggr.status===200||ggr.status===201, ggr.status+" "+ggr.text.slice(0,160));
  const gBob = await get("/api/boards/"+gactBid+"/setup", {headers:AH(tokB)});
  ok("globalact-bob-setup", gBob.status===200, gBob.status+" "+gBob.text.slice(0,200));
  if(gBob.status===200){
    ok("globalact-bob-lead-null", !gBob.json.lead, "top lead must be hidden");
    let cHas=false, aHas=false, aLeadNull=false;
    try{
      const cj = JSON.parse(gBob.json.canonicalJson);
      cHas = cj && cj.lead && typeof cj.lead.background==="string" && cj.lead.background.includes(GLOBALMK);
      const aj = JSON.parse(gBob.json.activeJson);
      aLeadNull = aj && aj.lead===null;
      aHas = stringsOf(aj).join("\n").includes(GLOBALMK);
    } catch(e){ cHas=true; }
    ok("globalact-bob-canonical-redacted", !cHas, "canonical must not embed global");
    ok("globalact-bob-active-redacted", aLeadNull && !aHas, "active must be redacted");
    ok("globalact-bob-dirty-false", gBob.json.dirty===false, "dirty="+gBob.json.dirty);
    // Non-admin manager export of legacy-global board: no content anywhere.
    const ggm = await post("/api/boards/"+gactBid+"/grants", {userKey:bob, access:"manage"}, {headers:AH(tokA)});
    ok("globalact-grant-manage", ggm.status===200||ggm.status===201, ggm.status);
    const gExp = await get("/api/boards/"+gactBid+"/export", {headers:AH(tokB)});
    ok("globalact-bob-export", gExp.status===200, gExp.status+" "+gExp.text.slice(0,200));
    if(gExp.status===200){
      try{
        const ej = JSON.parse(gExp.json.snapshot);
        ok("globalact-export-no-top", !(ej.lead||ej.Lead), "top lead must be absent for hidden global");
        const gBoard = ej.board||ej.Board||{};
        const emb = exportActiveJsonOf(ej);
        ok("globalact-export-active-nonempty", typeof emb==="string" && emb.length>2, "len="+(typeof emb==="string"?emb.length:"?"));
        const plx = parsedLeadOfActive(emb);
        ok("globalact-export-parse-ok", !plx.parseError, "parseError must be false");
        ok("globalact-export-active-redacted", plx.present && plx.value===null, "lead must be null; present="+plx.present);
        ok("globalact-export-activated-config", (gBoard.activeConfig===true||gBoard.ActiveConfig===true), "ActiveConfig must be true for activated board");
        const leakx = stringsOf(ej.board||ej.Board||{}).join("\n").includes(GLOBALMK);
        ok("globalact-export-no-leak", !leakx, "leak?");
      } catch(e){ ok("globalact-bob-export", false, String(e).slice(0,160)); }
    } else {
      ok("globalact-export-no-top", false, "no export");
    }
  } else {
    ok("globalact-bob-lead-null", false, "no bob setup");
    ok("globalact-bob-canonical-redacted", false, "no setup");
    ok("globalact-bob-active-redacted", false, "no setup");
    ok("globalact-bob-dirty-false", false, "no setup");
  }
  // NOW alice saves her default: current source flips global->default; history stays redacted.
  const asave = await post("/api/profile", {name:"Alice", roleLabel:"CEO", background:P("alice bg"), familiarTopics:"af", simplerTopics:"as", commPrefs:"ap", version:0}, {headers:AH(tokA)});
  ok("alice-save", asave.status===200 && asave.json.version===1, asave.status+" "+asave.text.slice(0,160));
  const bsave = await post("/api/profile", {name:"Bob", roleLabel:"CEO", background:P("bob bg"), familiarTopics:"bf", simplerTopics:"bs", commPrefs:"bp", version:0}, {headers:AH(tokB)});
  ok("bob-save-v1", bsave.status===200 && bsave.json.version===1, bsave.status);
  const ag = await get("/api/profile", {headers:AH(tokA)});
  const bg2 = await get("/api/profile", {headers:AH(tokB)});
  ok("same-version-isolated", ag.status===200 && bg2.status===200 && ag.json.version===1 && bg2.json.version===1 && ag.json.background!==bg2.json.background, ag.status+"/"+bg2.status);
  // Historical check on the global-activated board after default exists.
  const gBob2 = await get("/api/boards/"+gactBid+"/setup", {headers:AH(tokB)});
  ok("hist-after-default-setup", gBob2.status===200, gBob2.status);
  if(gBob2.status===200){
    const topBg = (gBob2.json.lead && (gBob2.json.lead.background||"")) || "";
    ok("hist-top-shows-default", topBg.includes(DEFAULTMK) || topBg.includes("alice bg"), "top="+topBg.slice(0,80));
    let canonHasDef=false, activeHasGlob=false, activeHasDef=false, activeNull=false;
    try{
      const cj = JSON.parse(gBob2.json.canonicalJson);
      canonHasDef = cj && cj.lead && typeof cj.lead.background==="string" && (cj.lead.background.includes(DEFAULTMK)||cj.lead.background.includes("alice bg"));
      const aj = JSON.parse(gBob2.json.activeJson);
      activeNull = aj && aj.lead===null;
      const astr = stringsOf(aj).join("\n");
      activeHasGlob = astr.includes(GLOBALMK);
      activeHasDef = astr.includes(DEFAULTMK);
    } catch(e){}
    ok("hist-canonical-current-default", canonHasDef, "canonical must show current default");
    ok("hist-active-still-redacted", activeNull && !activeHasGlob && !activeHasDef, "null="+activeNull+" glob="+activeHasGlob+" def="+activeHasDef);
  } else {
    ok("hist-top-shows-default", false, "no setup");
    ok("hist-canonical-current-default", false, "no setup");
    ok("hist-active-still-redacted", false, "no setup");
  }
  const ab = await post("/api/boards", {name:run+"-alice-b", mission:"m", stage:"s"}, {headers:AH(tokA)});
  ok("alice-board", ab.status===201 && boardIdOf(ab.json.id), ab.status);
  const aliceBid = ab.json.id;
  const bobGet = await get("/api/boards/"+aliceBid+"/lead", {headers:AH(tokB)});
  ok("cross-denied", bobGet.status===403 || bobGet.status===404, bobGet.status+" "+bobGet.text.slice(0,120));
  // export inherit marker + ActiveJson redaction (parsed, not raw text)
  const expA = await get("/api/boards/"+aliceBid+"/export", {headers:AH(tokA)});
  ok("export-owner", expA.status===200, expA.status);
  try{
    const ej = JSON.parse(expA.json.snapshot);
    const lsk = String(ej.leadSource||ej.LeadSource||"").toLowerCase();
    const hasLeadContent = !!(ej.lead||ej.Lead);
    ok("export-inherit-marker", lsk==="inherit" && !hasLeadContent, "source="+lsk+" hasLead="+hasLeadContent);
    const emb = exportActiveJsonOf(ej);
    const pl = parsedLeadOfActive(emb);
    ok("export-active-parse-ok", !pl.parseError, "parseError must be false");
    const cleanActive = (!pl.present) || (pl.value===null);
    ok("export-active-redacted", cleanActive, "active lead present="+pl.present+" val="+String(JSON.stringify(pl.value)||"").slice(0,80));
    const allStr = stringsOf(ej).join("\n");
    ok("export-no-alice-default-leak", !allStr.includes(DEFAULTMK), "leak?");
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
  const ovb = await post("/api/boards/"+aliceBid+"/lead", {name:"Alice Override", roleLabel:"CEO", background:OVERRIDEMK, familiarTopics:"aof", simplerTopics:"aos", commPrefs:"aoc", version:0}, {headers:AH(tokA)});
  ok("alice-override", ovb.status===200, ovb.status+" "+ovb.text.slice(0,160));
  const expO = await get("/api/boards/"+aliceBid+"/export", {headers:AH(tokA)});
  ok("export-explicit", expO.status===200, expO.status);
  try{
    const ej = JSON.parse(expO.json.snapshot);
    const lsk = String(ej.leadSource||ej.LeadSource||"").toLowerCase();
    ok("export-explicit-marker", lsk==="board" && !!(ej.lead||ej.Lead), "source="+lsk);
    const emb = exportActiveJsonOf(ej);
    const pl = parsedLeadOfActive(emb);
    ok("export-explicit-active-parse-ok", !pl.parseError, "parseError must be false");
    ok("export-explicit-active-redacted", (!pl.present) || pl.value===null, "active lead should be redacted even with override; present="+pl.present);
    const topLead = ej.lead||ej.Lead||{};
    ok("export-explicit-top-retained", (topLead.background||topLead.Background)===OVERRIDEMK, "top lead must retain override");
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
// genuine global activation -> override/export + default/setup historical redaction + unchanged dirty=false
{
  // Use demo owner (no auth accounts on THIS leg? DB is secure now, so use alice admin).
  // Create a board that will be activated under the CURRENT effective (alice default), then verify
  // non-admin views: ActiveJson redacted, dirty computed pre-redaction.
  const gb = await post("/api/boards", {name:run+"-act", mission:"m", stage:"s"}, {headers:AH(tokA)});
  ok("act-board", gb.status===201 && boardIdOf(gb.json.id), gb.status+" "+gb.text.slice(0,160));
  const gbid = gb.json.id;
  const adv = await makeAdvisor(gbid, "Strategist", AH(tokA), "act");
  ok("act-advisor", !adv.error, adv.error||"ok");
  const rev0 = await get("/api/boards/"+gbid+"/setup", {headers:AH(tokA)});
  ok("act-review", rev0.status===200 && rev0.json && rev0.json.draftHash, rev0.status+" "+rev0.text.slice(0,200));
  const dh = rev0.json.draftHash;
  const act = await post("/api/boards/"+gbid+"/setup/activate", {hash:dh}, {headers:AH(tokA)});
  ok("act-activate-200", act.status===200, act.status+" "+act.text.slice(0,200));
  // verify ActiveJson actually contains the effective marker BEFORE redaction assertions (admin view)
  const stAdmin = await get("/api/boards/"+gbid+"/setup", {headers:AH(tokA)});
  ok("act-admin-setup", stAdmin.status===200, stAdmin.status);
  let adminActiveHasDefault = false;
  try{
    const aj = JSON.parse(stAdmin.json.activeJson);
    const strs = stringsOf(aj).join("\n");
    adminActiveHasDefault = aj && aj.lead && typeof aj.lead.background==="string" && aj.lead.background.includes("alice bg");
    ok("act-active-contains-marker", adminActiveHasDefault, "admin active should embed effective default");
  } catch(e){ ok("act-active-contains-marker", false, String(e).slice(0,160)); }
  // grant bob read; non-admin setup must redact ActiveJson but keep top-level default + dirty pre-redaction
  const gr2 = await post("/api/boards/"+gbid+"/grants", {userKey:bob, access:"read"}, {headers:AH(tokA)});
  ok("act-grant-read", gr2.status===200||gr2.status===201, gr2.status+" "+gr2.text.slice(0,160));
  const stBob = await get("/api/boards/"+gbid+"/setup", {headers:AH(tokB)});
  ok("act-bob-setup", stBob.status===200, stBob.status+" "+stBob.text.slice(0,200));
  if(stBob.status===200){
    const topHasDefault = !!(stBob.json.lead && (stBob.json.lead.background||"").includes("alice bg"));
    ok("act-bob-top-default", topHasDefault, "top lead should show current default");
    let bobActiveLeadNull = false, bobActiveLeak=false;
    try{
      const aj = JSON.parse(stBob.json.activeJson);
      bobActiveLeadNull = aj && aj.lead===null;
      bobActiveLeak = stringsOf(aj).join("\n").includes("alice bg");
    } catch(e){ bobActiveLeadNull=false; }
    ok("act-bob-active-redacted", bobActiveLeadNull && !bobActiveLeak, "leadNull="+bobActiveLeadNull+" leak="+bobActiveLeak);
    ok("act-bob-dirty-false", stBob.json.dirty===false, "dirty="+stBob.json.dirty);
  } else {
    ok("act-bob-top-default", false, "no setup; failing closed");
    ok("act-bob-active-redacted", false, "no setup");
    ok("act-bob-dirty-false", false, "no setup");
  }
  // non-admin manager export of an inheriting activated board: top null, ActiveJson redacted
  const grm = await post("/api/boards/"+gbid+"/grants", {userKey:bob, access:"manage"}, {headers:AH(tokA)});
  ok("act-grant-manage", grm.status===200||grm.status===201, grm.status);
  // need bob session still valid; export as bob
  const expBob = await get("/api/boards/"+gbid+"/export", {headers:AH(tokB)});
  ok("act-bob-export", expBob.status===200, expBob.status+" "+expBob.text.slice(0,200));
  if(expBob.status===200){
    try{
      const ej = JSON.parse(expBob.json.snapshot);
      const lsk = String(ej.leadSource||ej.LeadSource||"").toLowerCase();
      ok("act-bob-export-inherit", lsk==="inherit" && !(ej.lead||ej.Lead), "source="+lsk);
      const aBoard = ej.board||ej.Board||{};
      const emb = exportActiveJsonOf(ej);
      ok("act-bob-export-active-nonempty", typeof emb==="string" && emb.length>2, "len="+(typeof emb==="string"?emb.length:"?"));
      const pl = parsedLeadOfActive(emb);
      ok("act-bob-export-parse-ok", !pl.parseError, "parseError must be false");
      ok("act-bob-export-active-redacted", pl.present && pl.value===null, "active lead must be null; present="+pl.present);
      ok("act-bob-export-activated-config", (aBoard.activeConfig===true||aBoard.ActiveConfig===true), "ActiveConfig must be true");
      ok("act-bob-export-no-leak", !stringsOf(ej).join("\n").includes("alice bg"), "leak?");
    } catch(e){ ok("act-bob-export-inherit", false, String(e).slice(0,160)); }
  } else {
    ok("act-bob-export-inherit", false, "no export; failing closed");
  }
  // override without reactivation, then non-admin manager export must not leak historical snapshot
  const ov2 = await post("/api/boards/"+gbid+"/lead", {name:"PostAct Override", roleLabel:"CEO", background:OVERRIDEMK, familiarTopics:"of", simplerTopics:"os", commPrefs:"oc", version:0}, {headers:AH(tokA)});
  ok("act-override-no-reactivate", ov2.status===200, ov2.status+" "+ov2.text.slice(0,200));
  const expBob2 = await get("/api/boards/"+gbid+"/export", {headers:AH(tokB)});
  ok("act-bob-export2", expBob2.status===200, expBob2.status);
  if(expBob2.status===200){
    try{
      const ej = JSON.parse(expBob2.json.snapshot);
      const top = ej.lead||ej.Lead||{};
      ok("act-export-top-override", (top.background||top.Background)===OVERRIDEMK, "top must retain override");
      const emb = exportActiveJsonOf(ej);
      const pl = parsedLeadOfActive(emb);
      const leak = stringsOf(ej.board||ej.Board||{}).join("\n").includes("alice bg");
      ok("act-export-historical-parse-ok", !pl.parseError, "parseError must be false");
      ok("act-export-historical-redacted", pl.present && pl.value===null && !leak, "leadNull="+pl.present+"/"+String(JSON.stringify(pl.value)||"").slice(0,40)+" leak="+leak);
    } catch(e){ ok("act-export-top-override", false, String(e).slice(0,160)); }
  } else {
    ok("act-export-top-override", false, "no export");
  }
}
// wizard inherit vs explicit (owner has default)
{
  const wiz = await post("/api/wizard", {step:4, presetKey:"", fieldsJson: JSON.stringify({name:run+"-wiz", mission:run+" mission", stage:"qa", advisors:[{role:"Strategist", name:run+"-adv"}]})}, {headers:AH(tokA)});
  ok("wiz-created", (wiz.status===200||wiz.status===201) && boardIdOf(wiz.json.id), wiz.status+" "+wiz.text.slice(0,200));
  const wid = wiz.json.id;
  ok("wiz-id", wid!==null && wid!==undefined, String(wid).slice(0,40));
  if (wid){
    const rev = await get("/api/wizard/"+wid+"/review", {headers:AH(tokA)});
    const bl = (rev.json && (rev.json.blockers||rev.json.Blockers)) || [];
    ok("wiz-review-inherit-clean", rev.status===200 && bl.length===0, rev.status+" "+rev.text.slice(0,300));
    // interview must treat inherited profile as complete
    const cur0 = await get("/api/wizard/"+wid, {headers:AH(tokA)});
    const cv0 = cur0.json ? (cur0.json.version||cur0.json.Version||2) : 2;
    const iv = await post("/api/wizard/"+wid+"/interview", {version: cv0, answer:""}, {headers:AH(tokA)});
    if(iv.status===200){
      const q = iv.json ? (iv.json.question||iv.json.Question||"") : "";
      const bls = (iv.json && (iv.json.blockers||iv.json.Blockers)) || [];
      ok("wiz-interview-inherited", !String(q).includes("Who leads") && !bls.some(b=>JSON.stringify(b).includes("lead")), iv.status+" q="+String(q).slice(0,120));
    } else {
      ok("wiz-interview-inherited", false, iv.status+" "+iv.text.slice(0,200)+"; failing closed, no skip");
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
    ok("wiz2-created", (wiz2.status===200||wiz2.status===201) && boardIdOf(wiz2.json.id), wiz2.status+" "+wiz2.text.slice(0,200));
    const wid2 = (wiz2.json && wiz2.json.id) || null;
    ok("wiz2-id", wid2!==null, String(wid2).slice(0,40));
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
    } else {
      ok("wiz-explicit-create", false, "missing wid2; failing closed, no skip");
      ok("wiz-explicit-id", false, "missing wid2");
      ok("wiz-explicit-override", false, "missing wid2");
    }
  } else {
    ok("wiz-review-inherit-clean", false, "missing wid; failing closed");
    ok("wiz-interview-inherited", false, "missing wid");
    ok("wiz-create", false, "missing wid");
    ok("wiz-create-id", false, "missing wid");
  }
}
{
  const be = await get("/api/backend");
  ok("backend-postgres", be.status===200 && be.json.mode==="postgres", be.status+" "+be.text.slice(0,120));
}
console.log(`PASS ${pass} FAIL ${fail}`);
if (fail>0){ console.log("FAILURES:"); for (const f of bad) console.log(" - "+f); process.exit(1); }
console.log("PROFILE-DEFAULT-BACKEND-QA PASS");
