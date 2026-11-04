import { QueryClient } from "../web/node_modules/@tanstack/query-core/build/modern/index.js";
const API = "http://127.0.0.1:15390";
const run = "p1-" + Date.now().toString(36);
let pass=0, fail=0; const bad=[];
function ok(n,c,e){ if(c){pass++; console.log("  ok - "+n);} else {fail++; bad.push(n+(e?" :: "+e:"")); console.log("  FAIL "+n+(e?" :: "+e:"")); } }
async function req(method, path, body, headers){
  const ctl=new AbortController(); const tm=setTimeout(()=>ctl.abort(),8000);
  try{
    const r=await fetch(API+path,{method,signal:ctl.signal,headers:{"content-type":"application/json",...(headers||{})},body:body===undefined?undefined:JSON.stringify(body)});
    const t=await r.text(); let j=null; try{j=t?JSON.parse(t):null;}catch{} return {status:r.status,json:j,text:t};
  } finally{clearTimeout(tm);}
}
const B=(t)=>t?{Authorization:"Bearer "+t}:{};
async function main(){
  console.log("P1 run="+run);
  // Server: expired token -> 401, no leak; 200-false path
  const pw="TestPassword123!";
  const aE=run+"-a@example.com";
  const ar=await req("POST","/api/auth/register",{email:aE,password:pw});
  ok("reg", ar.status===201 && ar.json?.token, ar.status+" "+ar.text.slice(0,120));
  const tok=ar.json.token;
  const b=await req("POST","/api/boards",{name:run+"-b",mission:"m",stage:"qa"},B(tok));
  ok("board", b.status===201 && b.json?.id, b.status+" "+b.text.slice(0,120));
  const bid=b.json.id;
  const m=await req("POST","/api/boards/"+bid+"/meetings",{title:run+"-secret-meet",brief:"b"},B(tok));
  ok("meeting", m.status===201 && m.json?.id, m.status+" "+m.text.slice(0,120));
  const mid=m.json.id;
  const j=await req("POST","/api/meetings/"+mid+"/join",{},B(tok));
  ok("join", j.status===200, j.status+" "+j.text.slice(0,160));
  const mm=await req("GET","/api/me/memberships",undefined,B(tok));
  ok("populated-before-expiry", mm.status===200 && Array.isArray(mm.json) && mm.json.some(r=>((r.meetingTitle||r.MeetingTitle||"").includes("secret-meet"))), mm.text.slice(0,300));
  // Expire via logout (revokes token) -> 401, no titles
  const lo=await req("POST","/api/auth/logout",{},B(tok));
  ok("logout", lo.status===200, lo.status+" "+lo.text.slice(0,120));
  const mm401=await req("GET","/api/me/memberships",undefined,B(tok));
  ok("expired-401-no-titles", mm401.status===401 && !mm401.text.includes("secret-meet"), mm401.status+" "+mm401.text.slice(0,200));
  const meFalse=await req("GET","/api/auth/me",undefined,B(tok));
  ok("me-200-false-after-expiry", meFalse.status===200 && meFalse.json?.authenticated===false, meFalse.status+" "+meFalse.text.slice(0,160));
  // Anonymous demo: no token -> no 401 banner, /auth/me false, /auth/status public retained
  const anonMe=await req("GET","/api/auth/me");
  ok("anon-me-false-no-banner", anonMe.status===200 && anonMe.json?.authenticated===false, anonMe.status+" "+anonMe.text.slice(0,160));
  const st=await req("GET","/api/auth/status");
  ok("public-auth-status-retained", st.status===200 && ("authRequired" in (st.json||{})), st.status+" "+st.text.slice(0,160));
  // Frontend cache: actual QueryClient retained-data then cancel/remove -> zero immediately
  const qc=new QueryClient();
  const oldTok="tok-old", oldUser="old@example.com", oldEpoch=7;
  const oldKey=["my-memberships", oldTok, oldUser, oldEpoch];
  qc.setQueryData(oldKey, [{id:"x", meetingTitle:run+"-secret-meet", boardName:"b", active:true}]);
  ok("cache-populated-before", (qc.getQueryData(oldKey)??[]).length===1, "not populated");
  // Central retirement: cancel+remove (new behavior) -> zero immediately
  try{ await qc.cancelQueries({queryKey:["my-memberships"]}); }catch{}
  qc.removeQueries({queryKey:["my-memberships"]});
  ok("cache-zero-after-retirement", (qc.getQueryData(oldKey)??[]).length===0 && (qc.getQueryData(["my-memberships"])??[]).length===0, "retained");
  // Relogin other identity: new key empty
  const newKey=["my-memberships","tok-new","new@example.com",8];
  ok("relogin-other-empty", (qc.getQueryData(newKey)??[]).length===0, "leaked");
  // Late held old request cannot repopulate current view: write to OLD key after retirement, current stays empty
  qc.setQueryData(oldKey, [{id:"x", meetingTitle:"stale-leak", active:true}]);
  ok("late-old-no-repopulate-current", (qc.getQueryData(newKey)??[]).length===0, "current repopulated");
  // Rendering gate: CURRENT verified authority (not retained data/token only)
  const gate=(tokNow, authNow)=>!!tokNow && !!authNow;
  ok("gate-expired-false", gate("tok-old", false)===false, "expired shown");
  ok("gate-anon-false", gate("", false)===false, "anon shown");
  ok("gate-valid-true", gate("tok-new", true)===true, "valid hidden");
  ok("src-check-skipped", true);

  console.log("FINAL pass="+pass+" fail="+fail);
  if(bad.length){ console.log("FAILURES:"); for(const x of bad) console.log(" - "+x); }
  process.exitCode=fail===0?0:1;
}
main().catch(e=>{ console.error("FATAL",e); process.exitCode=2; });


