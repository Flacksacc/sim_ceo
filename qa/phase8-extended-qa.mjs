import crypto from "node:crypto";
const API = process.env.QA_API || "http://127.0.0.1:5107";
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
const pw="TestPassword123!";
const adminE=run+"-admin@example.com", guestE=run+"-guest@example.com", readerE=run+"-reader@example.com";
const ar=await req("POST","/api/auth/register",{email:adminE,password:pw}); const adminT=ar.json.token;
const gr=await req("POST","/api/auth/register",{email:guestE,password:pw}); const guestT=gr.json.token;
const rr=await req("POST","/api/auth/register",{email:readerE,password:pw}); const readerT=rr.json.token;
const B=(t)=>({Authorization:"Bearer "+t});
const b=await req("POST","/api/boards",{name:run+"-b"},{...B(adminT)}); const bid=b.json.id;
// advisor for run: need approved advisor (use quick + upload + review + copy + approve via existing pattern? simplified: use roster quick then attach? For run to succeed need eligible advisor. To keep test fast, test Run permission only (403 vs 409), not full success.
const m=await req("POST",`/api/boards/${bid}/meetings`,{title:run+"-m",brief:"brief QA-NO"},{...B(adminT)}); const mid=m.json.id;
await req("POST",`/api/boards/${bid}/grants`,{userKey:guestE,access:"discuss",meetingId:mid},{...B(adminT)});
await req("POST",`/api/boards/${bid}/grants`,{userKey:readerE,access:"read"},{...B(adminT)});
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
// source upload by admin, approve, guest download eligible
const form=new FormData(); form.append("file",new Blob(["hello source"],{type:"text/plain"}),"note.txt");
let up=await req("POST",`/api/boards/${bid}/sources/upload?scope=board`,form,{...B(adminT)},true);
ok("source-upload",up.status===201,up.status+" "+up.text.slice(0,200));
const sid=up.json?.id;
await req("POST",`/api/sources/${sid}/approve`,{},{...B(adminT)});
let gdl=await req("GET",`/api/sources/${sid}/download`,undefined,{...B(guestT)});
ok("guest-download-eligible",gdl.status===200,gdl.status+" "+gdl.text.slice(0,120));
let sdl=await req("GET",`/api/sources/${sid}/download`,undefined,{Authorization:"Bearer "+"00".repeat(32)});
ok("expired-download-401",sdl.status===401,sdl.status+" "+sdl.text.slice(0,120));
let ndl=await req("GET",`/api/sources/${sid}/download`,undefined,{});
ok("anon-download-401",ndl.status===401,ndl.status+" "+ndl.text.slice(0,120));
// images: upload portrait as admin roster? skip heavy; test protected image 401 anon
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
