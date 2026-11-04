import crypto from "node:crypto";
const API = process.env.QA_API || "http://127.0.0.1:15340";
const run = "p8e-" + Date.now().toString(36);
let pass=0,fail=0; const bad=[];
function ok(n,c,e){ if(c)pass++; else {fail++; bad.push(n+(e?" :: "+e:"")); console.log("  FAIL "+n+(e?" :: "+e:"")); } }
async function req(method,path,body,headers,isForm){
  const h={...(headers||{})};
  let b=undefined;
  if(isForm){ b=body; } else if(body!==undefined){ h["content-type"]="application/json"; b=JSON.stringify(body); }
  const r=await fetch(API+path,{method,headers:h,body:b});
  const t=await r.text(); let j=null; try{j=t?JSON.parse(t):null;}catch{} return {status:r.status,json:j,text:t,headers:r.headers};
}
console.log("extended QA run="+run);
if (API !== "http://127.0.0.1:15340") { console.log("FATAL-GATE QA_API exact"); process.exitCode = 2; throw new Error("gate"); }
const FAKEE = process.env.QA_FAKE || "http://127.0.0.1:15342";
if (FAKEE !== "http://127.0.0.1:15342") { console.log("FATAL-GATE QA_FAKE exact"); process.exitCode = 2; throw new Error("gate"); }
const PGDBE = process.env.QA_PGDB || "";
const EXPDBE = process.env.QA_EXPECTED_DB || "";
if (PGDBE && PGDBE.indexOf("primary_phase8_") !== 0) { console.log("FATAL-GATE QA_PGDB prefix"); process.exitCode = 2; throw new Error("gate"); }
if (EXPDBE && EXPDBE.indexOf("primary_phase8_") !== 0) { console.log("FATAL-GATE QA_EXPECTED_DB prefix"); process.exitCode = 2; throw new Error("gate"); }
if (EXPDBE && PGDBE && EXPDBE !== PGDBE) { console.log("FATAL-GATE DB mismatch"); process.exitCode = 2; throw new Error("gate"); }
const stg = await req("GET","/api/auth/status");
if (!stg || stg.status !== 200) { console.log("FATAL-GATE status 200 required"); process.exitCode = 2; throw new Error("gate"); }
try {
  const fr = await fetch(FAKEE + "/__log", { method: "GET" });
  const ft = await fr.text(); let fj = null; try { fj = ft ? JSON.parse(ft) : null; } catch {}
  if (!(fr.status === 200 && Array.isArray(fj))) { console.log("FATAL-GATE fake log array required"); process.exitCode = 2; throw new Error("gate"); }
} catch { console.log("FATAL-GATE fake unreachable"); process.exitCode = 2; throw new Error("gate"); }


const pw="TestPassword123!";
const adminE=run+"-admin@example.com", guestE=run+"-guest@example.com", readerE=run+"-reader@example.com";
const ar=await req("POST","/api/auth/register",{email:adminE,password:pw});
ok("setup-admin-reg-201",ar.status===201 && ar.json && ar.json.token,ar.status+" "+ar.text.slice(0,120));
const adminT=ar.json.token;
const gr=await req("POST","/api/auth/register",{email:guestE,password:pw});
ok("setup-guest-reg-201",gr.status===201 && gr.json && gr.json.token,gr.status+" "+gr.text.slice(0,120));
const guestT=gr.json.token;
const rr=await req("POST","/api/auth/register",{email:readerE,password:pw});
ok("setup-reader-reg-201",rr.status===201 && rr.json && rr.json.token,rr.status+" "+rr.text.slice(0,120));
const readerT=rr.json.token;
const B=(t)=>({Authorization:"Bearer "+t});
const b=await req("POST","/api/boards",{name:run+"-b"},{...B(adminT)});
ok("setup-board-201",b.status===201 && b.json && b.json.id,b.status+" "+b.text.slice(0,120));
const bid=b.json.id;
// advisor for run: need approved advisor (use quick + upload + review + copy + approve via existing pattern? simplified: use roster quick then attach? For run to succeed need eligible advisor. To keep test fast, test Run permission only (403 vs 409), not full success.
const m=await req("POST",`/api/boards/${bid}/meetings`,{title:run+"-m",brief:"brief QA-NO"},{...B(adminT)});
ok("setup-meeting-201",m.status===201 && m.json && m.json.id,m.status+" "+m.text.slice(0,120));
const mid=m.json.id;
let gg1=await req("POST",`/api/boards/${bid}/grants`,{userKey:guestE,access:"discuss",meetingId:mid},{...B(adminT)});
ok("grant-guest-setup-201",gg1.status===201,gg1.status+" "+gg1.text.slice(0,160));
let gg2=await req("POST",`/api/boards/${bid}/grants`,{userKey:readerE,access:"read"},{...B(adminT)});
ok("grant-reader-setup-201",gg2.status===201,gg2.status+" "+gg2.text.slice(0,160));
// Run: guest allowed to attempt (may 409 no advisors, but NOT 403); reader denied 403
let grun=await req("POST",`/api/meetings/${mid}/run`,{policy:"balanced",prompt:"hello"},{...B(guestT)});
ok("guest-run-not-403",grun.status!==403,grun.status+" "+grun.text.slice(0,200));
let rrun=await req("POST",`/api/meetings/${mid}/run`,{policy:"balanced",prompt:"hello"},{...B(readerT)});
ok("reader-run-403",rrun.status===403,rrun.status+" "+rrun.text.slice(0,160));
// voice draft + finalize as guest
let vd=await req("POST",`/api/meetings/${mid}/voice`,{partial:"hello draft",retainAudio:false},{...B(guestT)});
ok("guest-voice-draft",vd.status===201,vd.status+" "+vd.text.slice(0,160));
const vid=vd.json?.id;
let vf=await req("POST",`/api/voice/${vid}/finalize`,{transcript:"hello final"},{...B(guestT)});
ok("guest-voice-finalize",vf.status===200,vf.status+" "+vf.text.slice(0,200));
// reader voice draft denied? transcribe requires discuss, reader read should 403
let rvd=await req("POST",`/api/meetings/${mid}/voice`,{partial:"x"},{...B(readerT)});
ok("reader-voice-denied",rvd.status===403,rvd.status+" "+rvd.text.slice(0,160));
// meeting-scoped source: upload in own meeting, approve, guest downloads exact bytes
const m2=await req("POST",`/api/boards/${bid}/meetings`,{title:run+"-m2",brief:"other"},{...B(adminT)}); const mid2=m2.json.id; const m3=await req("POST",`/api/boards/${bid}/meetings`,{title:run+"-m3",brief:"third"},{...B(adminT)}); const mid3=m3.json.id;
await req("POST",`/api/boards/${bid}/grants`,{userKey:guestE,access:"discuss",meetingId:mid2},{...B(adminT)});
const form=new FormData(); form.append("file",new Blob(["hello source"],{type:"text/plain"}),"note.txt"); form.append("scope","meeting"); form.append("meetingId",mid);
let up=await req("POST",`/api/boards/${bid}/sources/upload`,form,{...B(adminT)},true);
ok("source-upload",up.status===201,up.status+" "+up.text.slice(0,200));
ok("source-upload-scope",up.json?.scope==="meeting"&&up.json?.meetingId===mid,JSON.stringify(up.json).slice(0,200));
const sid=up.json?.id;
let ap=await req("POST",`/api/sources/${sid}/approve`,{},{...B(adminT)});
ok("source-approve",ap.status===200,ap.status+" "+ap.text.slice(0,160));
let gdl=await req("GET",`/api/sources/${sid}/download`,undefined,{...B(guestT)});
ok("guest-download-eligible",gdl.status===200,gdl.status+" "+gdl.text.slice(0,120));
ok("guest-download-bytes",gdl.text==="hello source",gdl.text.slice(0,120));
// board-scoped source stays 403 for meeting-only guest (metadata visible, no board bytes)
const bform=new FormData(); bform.append("file",new Blob(["hello source"],{type:"text/plain"}),"board.txt");
let bup=await req("POST",`/api/boards/${bid}/sources/upload?scope=board`,bform,{...B(adminT)},true);
ok("board-source-upload",bup.status===201,bup.status+" "+bup.text.slice(0,200));
const boardSid=bup.json?.id;
await req("POST",`/api/sources/${boardSid}/approve`,{},{...B(adminT)});
let bdl=await req("GET",`/api/sources/${boardSid}/download`,undefined,{...B(guestT)});
ok("board-scoped-dl-403",bdl.status===403,bdl.status+" "+bdl.text.slice(0,160));
// other-meeting, pending, excluded, revoked negatives
const oform=new FormData(); oform.append("file",new Blob(["hello source"],{type:"text/plain"}),"other.txt"); oform.append("scope","meeting"); oform.append("meetingId",mid3);
let oup=await req("POST",`/api/boards/${bid}/sources/upload`,oform,{...B(adminT)},true);
const otherSid=oup.json?.id;
await req("POST",`/api/sources/${otherSid}/approve`,{},{...B(adminT)});
let odl=await req("GET",`/api/sources/${otherSid}/download`,undefined,{...B(guestT)});
ok("other-meeting-dl-403",odl.status===403,odl.status+" "+odl.text.slice(0,160));
const pform=new FormData(); pform.append("file",new Blob(["pending body"],{type:"text/plain"}),"pending.txt"); pform.append("scope","meeting"); pform.append("meetingId",mid);
let pup=await req("POST",`/api/boards/${bid}/sources/upload`,pform,{...B(adminT)},true);
let pdl=await req("GET",`/api/sources/${pup.json?.id}/download`,undefined,{...B(guestT)});
ok("pending-dl-403",pdl.status===403,pdl.status+" "+pdl.text.slice(0,160));
await req("POST",`/api/sources/${pup.json?.id}/approve`,{},{...B(adminT)});
await req("POST",`/api/sources/${pup.json?.id}/exclude`,{},{...B(adminT)});
let xdl=await req("GET",`/api/sources/${pup.json?.id}/download`,undefined,{...B(guestT)});
ok("excluded-dl-403",xdl.status===403,xdl.status+" "+xdl.text.slice(0,160));
let sdl=await req("GET",`/api/sources/${sid}/download`,undefined,{Authorization:"Bearer "+"00".repeat(32)});
ok("expired-download-401",sdl.status===401,sdl.status+" "+sdl.text.slice(0,120));
let ndl=await req("GET",`/api/sources/${sid}/download`,undefined,{});
ok("anon-download-401",ndl.status===401,ndl.status+" "+ndl.text.slice(0,120));
let rej=await req("POST","/api/sources/"+sid+"/reject",{},{...B(adminT)});
ok("approved-reject-409",rej.status===409,rej.status+" "+rej.text.slice(0,160));
let rdl=await req("GET","/api/sources/"+sid+"/download",undefined,{...B(guestT)});
ok("approved-reject-no-change-200",rdl.status===200&&rdl.text==="hello source",rdl.status+" "+rdl.text.slice(0,160));
// images: upload portrait as admin roster? skip heavy; test protected image 401 anon
let gg=await req("GET","/api/boards/"+bid+"/grants",undefined,{...B(adminT)});
ok("grant-list-ok",gg.status===200,gg.status+" "+gg.text.slice(0,120));
let tg=(Array.isArray(gg.json)?gg.json:[]).find((x)=>(((x.userKey||x.UserKey)||"").toLowerCase()===guestE)&&((x.meetingId||x.MeetingId)===mid));
ok("grant-found",!!tg,"missing");
let del=await req("DELETE","/api/grants/"+(tg.id||tg.Id),undefined,{...B(adminT)});
ok("grant-delete-204",del.status===204,del.status+" "+del.text.slice(0,160));
let rdl2=await req("GET","/api/sources/"+sid+"/download",undefined,{...B(guestT)});
ok("revoked-grant-dl-403",rdl2.status===403,rdl2.status+" "+rdl2.text.slice(0,160));
let imgAnon=await req("GET",`/api/images/00000000-0000-0000-0000-000000000000`,undefined,{});
ok("image-anon-404-or-401",imgAnon.status===401||imgAnon.status===404,imgAnon.status+" "+imgAnon.text.slice(0,120));
// delayed old request after user change: logout guest, old token 401, new login works
await req("POST","/api/auth/logout",{},{...B(guestT)});
let oldReq=await req("GET",`/api/meetings/${mid}/messages`,undefined,{...B(guestT)});
ok("old-token-after-logout-401",oldReq.status===401,oldReq.status+" "+oldReq.text.slice(0,160));
let relog=await req("POST","/api/auth/login",{email:guestE,password:pw});
ok("relogin-ok",relog.status===200&&relog.json?.token,relog.status+" "+relog.text.slice(0,160));
const guestT2=relog.json.token;
let newReq=await req("GET",`/api/meetings/${mid}/messages`,undefined,{...B(guestT2)});
ok("new-token-works",newReq.status===200,newReq.status+" "+newReq.text.slice(0,160));
console.log(`PASS=${pass} FAIL=${fail}`);
if(bad.length) console.log("FAILURES:\n"+bad.join("\n"));
process.exit(fail?1:0);
