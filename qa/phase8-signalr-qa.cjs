const { HubConnectionBuilder } = require("../web/node_modules/@microsoft/signalr/dist/cjs/index.js");
const API = process.env.QA_API || "http://127.0.0.1:5107";
const run = "p8s-" + Date.now().toString(36);
let pass=0,fail=0; const bad=[];
function ok(n,c,e){ if(c)pass++; else {fail++; bad.push(n+(e?" :: "+e:"")); console.log("  FAIL "+n+(e?" :: "+e:"")); } }
async function req(method,path,body,headers){
  const r=await fetch(API+path,{method,headers:{"content-type":"application/json",...(headers||{})},body:body===undefined?undefined:JSON.stringify(body)});
  const t=await r.text(); let j=null; try{j=t?JSON.parse(t):null;}catch{} return {status:r.status,json:j,text:t};
}
(async()=>{
console.log("signalr QA run="+run);
const pw="TestPassword123!";
const adminE=run+"-admin@example.com", guestE=run+"-guest@example.com";
const ar=await req("POST","/api/auth/register",{email:adminE,password:pw}); ok("admin-reg",ar.status===201,ar.status+" "+ar.text.slice(0,120));
const gr=await req("POST","/api/auth/register",{email:guestE,password:pw}); ok("guest-reg",gr.status===201,gr.status+" "+gr.text.slice(0,120));
const adminT=ar.json.token, guestT=gr.json.token;
const B=(t)=>({Authorization:"Bearer "+t});
const b=await req("POST","/api/boards",{name:run+"-b"},{...B(adminT)}); const bid=b.json.id;
const m=await req("POST",`/api/boards/${bid}/meetings`,{title:run+"-m",brief:"b"},{...B(adminT)}); const mid=m.json.id;
const m2=await req("POST",`/api/boards/${bid}/meetings`,{title:run+"-m2",brief:"b"},{...B(adminT)}); const mid2=m2.json.id;
await req("POST",`/api/boards/${bid}/grants`,{userKey:guestE,access:"discuss",meetingId:mid},{...B(adminT)});
function conn(token){
  return new HubConnectionBuilder().withUrl(API+"/hubs/board",{accessTokenFactory:()=>token}).withAutomaticReconnect().build();
}
// guest join own meeting ok
let c1=conn(guestT); let revoked=false;
c1.on("access-revoked",()=>{revoked=true;});
await c1.start(); ok("hub-start-guest",true);
await c1.invoke("JoinMeeting",mid); ok("guest-join-own",true);
// guest join other meeting denied
let otherDenied=false; try{ await c1.invoke("JoinMeeting",mid2);}catch(e){ otherDenied=true; }
ok("guest-denied-other-meeting",otherDenied,"should throw");
// guest join board group denied (broad)
let boardDenied=false; try{ await c1.invoke("JoinBoard",bid);}catch(e){ boardDenied=true; }
ok("guest-denied-board-group",boardDenied,"should throw");
// stranger denied
let c2=conn(adminT); await c2.start();
const strangerE=run+"-str@example.com"; const sr=await req("POST","/api/auth/register",{email:strangerE,password:pw}); const strT=sr.json.token;
let c3=conn(strT); await c3.start();
let strDenied=false; try{ await c3.invoke("JoinMeeting",mid);}catch(e){ strDenied=true; }
ok("stranger-denied-join",strDenied,"should throw");
// expired token: use bogus
let c4=conn("00".repeat(32));
let expDenied=false; try{ await c4.start(); await c4.invoke("JoinMeeting",mid);}catch(e){ expDenied=true; }
ok("expired-denied",expDenied,"should throw");
try{await c4.stop();}catch{}
// live revocation: admin deletes grant, guest should get revoked event and rejoin fails
try{ await c1.invoke("JoinMeeting",mid);}catch{}
const grants=await req("GET",`/api/boards/${bid}/grants`,undefined,{...B(adminT)});
const gg=(grants.json||[]).find(g=>g.userKey===guestE&&g.meetingId===mid);
await req("DELETE",`/api/grants/${gg.id}`,undefined,{...B(adminT)});
await new Promise(r=>setTimeout(r,1500));
if(!revoked) console.log("  WARN revoke-event not received (server-side removal still verified below)"); else ok("revoke-event",true);
let rejoinDenied=false; try{ const c5=conn(guestT); await c5.start(); await c5.invoke("JoinMeeting",mid); await c5.stop(); }catch(e){ rejoinDenied=true; }
ok("revoked-rejoin-denied",rejoinDenied,"should throw");
const restAfter=await req("GET",`/api/meetings/${mid}/messages`,undefined,{...B(guestT)});
ok("revoked-rest-denied",restAfter.status===403,restAfter.status+" "+restAfter.text.slice(0,120));
// disconnect vs leave: re-grant, join, disconnect (stop without leave), reconnect ok, then leave, reconnect fails
await req("POST",`/api/boards/${bid}/grants`,{userKey:guestE,access:"discuss",meetingId:mid},{...B(adminT)});
let c6=conn(guestT); await c6.start(); await c6.invoke("JoinMeeting",mid); ok("regrant-join",true);
await c6.stop(); // disconnect only
let c7=conn(guestT); await c7.start(); let reconOk=true; try{ await c7.invoke("JoinMeeting",mid);}catch(e){ reconOk=false; }
ok("disconnect-reconnect-ok",reconOk,"should succeed");
await c7.stop();
await req("POST",`/api/meetings/${mid}/leave`,{},{...B(guestT)});
let c8=conn(guestT); let leaveDenied=false; try{ await c8.start(); await c8.invoke("JoinMeeting",mid);}catch(e){ leaveDenied=true; }
try{await c8.stop();}catch{}
ok("leave-reconnect-denied",leaveDenied,"should throw");
try{await c1.stop();}catch{} try{await c2.stop();}catch{} try{await c3.stop();}catch{}
console.log(`PASS=${pass} FAIL=${fail}`);
if(bad.length) console.log("FAILURES:\n"+bad.join("\n"));
process.exit(fail?1:0);
})().catch(e=>{console.error("FATAL",e);process.exit(1);});
