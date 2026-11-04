import crypto from "node:crypto";
const API = process.env.QA_API || "http://127.0.0.1:5107";
const run = "p8-" + Date.now().toString(36) + "-" + Math.floor(Math.random()*1e6).toString(36);
let pass=0, fail=0; const failures=[];
function ok(name, cond, extra){ if(cond){pass++;} else {fail++; failures.push(name+(extra?" :: "+extra:"")); console.log("  FAIL "+name+(extra?" :: "+extra:"")); } }
async function req(method, path, body, opts={}) {
  const ctl=new AbortController(); const t=setTimeout(()=>ctl.abort(), opts.timeout||30000);
  try{
    const headers={"content-type":"application/json", ...(opts.headers||{})};
    const r=await fetch(API+path,{method,signal:ctl.signal,headers,body:body===undefined?undefined:JSON.stringify(body)});
    const text=await r.text(); let json=null; try{json=text?JSON.parse(text):null;}catch{json=null;}
    return {status:r.status,json,text};
  } finally{clearTimeout(t);}
}
const get=(p,o)=>req("GET",p,undefined,o);
const post=(p,b,o)=>req("POST",p,b,o);
const del=(p,o)=>req("DELETE",p,undefined,o);
const B=(tok)=> tok?{Authorization:"Bearer "+tok}:{};
const X=(u)=> u?{"X-User":u}:{};

console.log("phase8 guests QA run="+run+" api="+API);
// 1. status before accounts (PG fresh? may have accounts from prior runs; use unique emails so first-admin already set)
let st0=await get("/api/auth/status");
ok("status-public",st0.status===200, st0.status+" "+st0.text.slice(0,120));
console.log("  status0="+st0.text.slice(0,200));
// 2. register admin + users (unique)
async function reg(email,pw){ return await post("/api/auth/register",{email,password:pw}); }
const pw="TestPassword123!";
const adminE=run+"-admin@example.com", mgrE=run+"-mgr@example.com", contribE=run+"-contrib@example.com", readerE=run+"-reader@example.com", guestE=run+"-guest@example.com", strangerE=run+"-stranger@example.com";
const adminR=await reg(adminE,pw); ok("admin-register",adminR.status===201&&adminR.json?.token,adminR.status+" "+adminR.text.slice(0,200));
const adminT=adminR.json?.token;
const mgrR=await reg(mgrE,pw); ok("mgr-register",mgrR.status===201,mgrR.status+" "+mgrR.text.slice(0,160));
const contribR=await reg(contribE,pw); ok("contrib-register",contribR.status===201,contribR.status+" "+contribR.text.slice(0,160));
const readerR=await reg(readerE,pw); ok("reader-register",readerR.status===201,readerR.status+" "+readerR.text.slice(0,160));
const guestR=await reg(guestE,pw); ok("guest-register",guestR.status===201,guestR.status+" "+guestR.text.slice(0,160));
const strangerR=await reg(strangerE,pw); ok("stranger-register",strangerR.status===201,strangerR.status+" "+strangerR.text.slice(0,160));
const guestT=guestR.json?.token, strangerT=strangerR.json?.token, readerT=readerR.json?.token, contribT=contribR.json?.token, mgrT=mgrR.json?.token;
let st1=await get("/api/auth/status");
ok("status-secure",st1.status===200&&st1.json?.authRequired===true,st1.text.slice(0,200));
// 3. admin creates board + meeting
let b=await post("/api/boards",{name:run+"-board",mission:"m",stage:"s"},{headers:B(adminT)});
ok("admin-create-board",b.status===201&&b.json?.id, b.status+" "+b.text.slice(0,200));
const bid=b.json?.id;
let m=await post(`/api/boards/${bid}/meetings`,{title:run+"-mtg",brief:"brief"},{headers:B(adminT)});
ok("admin-create-meeting",m.status===201&&m.json?.id, m.status+" "+m.text.slice(0,200));
const mid=m.json?.id;
let m2=await post(`/api/boards/${bid}/meetings`,{title:run+"-other",brief:"other"},{headers:B(adminT)});
const mid2=m2.json?.id;
// 4. grants: manager/contribute/read/discuss
async function grant(userKey,access,meeting){ return await post(`/api/boards/${bid}/grants`,{userKey,access,meetingId:meeting||undefined},{headers:B(adminT)}); }
let g1=await grant(mgrE,"manage"); ok("grant-manager",g1.status===201,g1.status+" "+g1.text.slice(0,160));
let g2=await grant(contribE,"contribute"); ok("grant-contrib",g2.status===201,g2.status+" "+g2.text.slice(0,160));
let g3=await grant(readerE,"read"); ok("grant-reader",g3.status===201,g3.status+" "+g3.text.slice(0,160));
let g4=await grant(guestE,"discuss",mid); ok("grant-guest-discuss",g4.status===201,g4.status+" "+g4.text.slice(0,200));
let gBad=await post(`/api/boards/${bid}/grants`,{userKey:guestE,access:"discuss"},{headers:B(adminT)});
ok("grant-discuss-requires-meeting",gBad.status===400,gBad.status+" "+gBad.text.slice(0,160));
// 5. permission checks
async function chk(tok,method,path,body){ return await req(method,path,body,{headers:B(tok)}); }
// guest can read own meeting messages, cannot read other meeting
await post(`/api/meetings/${mid}/messages`,{content:"owner hello"},{headers:B(adminT)});
let gm=await chk(guestT,"GET",`/api/meetings/${mid}/messages`); ok("guest-read-own-meeting",gm.status===200,gm.status+" "+gm.text.slice(0,160));
let gm2=await chk(guestT,"GET",`/api/meetings/${mid2}/messages`); ok("guest-denied-other-meeting",gm2.status===403,gm2.status+" "+gm2.text.slice(0,160));
// guest can post own meeting message (discuss)
let gp=await chk(guestT,"POST",`/api/meetings/${mid}/messages`,{content:"guest hello"}); ok("guest-post-own",gp.status===201,gp.status+" "+gp.text.slice(0,200));
// guest cannot patch meeting (participants/policy)
let gpatch=await req("PATCH",`/api/meetings/${mid}`,{title:"hacked"},{headers:B(guestT)}); ok("guest-denied-patch",gpatch.status===403,gpatch.status+" "+gpatch.text.slice(0,160));
// guest cannot create meeting
let gcm=await chk(guestT,"POST",`/api/boards/${bid}/meetings`,{title:"x"}); ok("guest-denied-create-meeting",gcm.status===403,gcm.status+" "+gcm.text.slice(0,160));
// guest can read guest-settings, cannot read full setup
let gs=await chk(guestT,"GET",`/api/boards/${bid}/guest-settings`); ok("guest-settings",gs.status===200&&gs.json?.meetingIds,gs.status+" "+gs.text.slice(0,200));
let gsetup=await chk(guestT,"GET",`/api/boards/${bid}/setup`); ok("guest-denied-setup",gsetup.status===403,gsetup.status+" "+gsetup.text.slice(0,160));
// guest cannot secretary/briefing/notes-post/records
let gsec=await chk(guestT,"POST",`/api/meetings/${mid}/secretary`,{input:"hello",clientNonce:crypto.randomUUID()}); ok("guest-denied-secretary",gsec.status===403,gsec.status+" "+gsec.text.slice(0,160));
let gnote=await chk(guestT,"POST",`/api/meetings/${mid}/notes`,{title:"t",body:"b"}); ok("guest-denied-note-post",gnote.status===403,gnote.status+" "+gnote.text.slice(0,160));
let gbrief=await chk(guestT,"POST",`/api/meetings/${mid}/briefings`,{topic:"t"}); ok("guest-denied-briefing",gbrief.status===403,gbrief.status+" "+gbrief.text.slice(0,160));
// guest cannot sources upload, can read eligible
let gsup=await req("POST",`/api/boards/${bid}/sources`,{fileName:"x.txt"},{headers:B(guestT)}); ok("guest-denied-source-post",gsup.status===403,gsup.status+" "+gsup.text.slice(0,160));
let gslist=await chk(guestT,"GET",`/api/boards/${bid}/sources`); ok("guest-sources-filtered",gslist.status===200&&Array.isArray(gslist.json),gslist.status+" "+gslist.text.slice(0,200));
// stranger denied
let sread=await chk(strangerT,"GET",`/api/meetings/${mid}/messages`); ok("stranger-denied",sread.status===403,sread.status+" "+sread.text.slice(0,160));
// expired token
let exp=await get("/api/boards",{headers:{Authorization:"Bearer "+"00".repeat(32)}}); ok("expired-401",exp.status===401,exp.status+" "+exp.text.slice(0,160));
// header spoof: valid guest Bearer + X-User admin must NOT elevate (X-User ignored)
let spoof=await req("GET",`/api/boards/${bid}/setup`,undefined,{headers:{Authorization:"Bearer "+guestT,"X-User":adminE}}); ok("spoof-not-elevated",spoof.status===403,spoof.status+" "+spoof.text.slice(0,200));
// missing bearer when secure => 401
let nobear=await get("/api/boards"); ok("missing-bearer-401",nobear.status===401,nobear.status+" "+nobear.text.slice(0,160));
// cross-board: create board2, guest of board1 cannot read board2
let b2=await post("/api/boards",{name:run+"-b2"},{headers:B(adminT)}); const bid2=b2.json?.id;
let cross=await chk(guestT,"GET",`/api/boards/${bid2}/guest-settings`); ok("cross-board-denied",cross.status===403,cross.status+" "+cross.text.slice(0,200));
// invite accept binds session, preserves MeetingId, prevents spoof
let inv=await post(`/api/boards/${bid}/invites`,{email:"invite-"+run+"@example.com",role:"guest",meetingId:mid},{headers:B(adminT)});
ok("invite-guest-created",inv.status===201&&inv.json?.meetingId===mid,inv.status+" "+inv.text.slice(0,240));
const invId=inv.json?.id;
const inviteUserE=run+"-invited@example.com"; const inviteReg=await reg(inviteUserE,pw); const inviteT=inviteReg.json?.token;
let accSpoof=await post(`/api/invites/${invId}/accept`,{userKey:"someone-else@example.com"},{headers:B(inviteT)});
ok("accept-spoof-403",accSpoof.status===403,accSpoof.status+" "+accSpoof.text.slice(0,200));
let acc=await post(`/api/invites/${invId}/accept`,{},{headers:B(inviteT)});
ok("accept-ok-preserves-meeting",acc.status===200&&acc.json?.meetingId===mid,acc.status+" "+acc.text.slice(0,240));
let accRead=await chk(inviteT,"GET",`/api/meetings/${mid}/messages`); ok("accepted-can-read",accRead.status===200,accRead.status+" "+accRead.text.slice(0,160));
// explicit leave revokes
let leave=await post(`/api/meetings/${mid}/leave`,{},{headers:B(inviteT)});
ok("leave-ok",leave.status===200,leave.status+" "+leave.text.slice(0,160));
let afterLeave=await chk(inviteT,"GET",`/api/meetings/${mid}/messages`); ok("leave-revokes-read",afterLeave.status===403,afterLeave.status+" "+afterLeave.text.slice(0,160));
// revoke sticks after last grant (delete guest grant, stranger still denied, owner still ok)
let delG=await del(`/api/grants/${g4.json?.id}`,{headers:B(adminT)}); ok("revoke-guest-grant",delG.status===204,delG.status+" "+delG.text.slice(0,160));
let afterRevoke=await chk(guestT,"GET",`/api/meetings/${mid}/messages`); ok("revoked-denied",afterRevoke.status===403,afterRevoke.status+" "+afterRevoke.text.slice(0,160));
// owner/manager/contrib/reader retained
let oread=await chk(adminT,"GET",`/api/meetings/${mid}/messages`); ok("owner-read",oread.status===200,oread.status+" "+oread.text.slice(0,120));
let mread=await chk(mgrT,"GET",`/api/meetings/${mid}/messages`); ok("manager-read",mread.status===200,mread.status+" "+mread.text.slice(0,120));
let cread=await chk(contribT,"GET",`/api/meetings/${mid}/messages`); ok("contrib-read",cread.status===200,cread.status+" "+cread.text.slice(0,120));
let rread=await chk(readerT,"GET",`/api/meetings/${mid}/messages`); ok("reader-read",rread.status===200,rread.status+" "+rread.text.slice(0,120));
let rwrite=await chk(readerT,"POST",`/api/meetings/${mid}/messages`,{content:"x"}); ok("reader-denied-write",rwrite.status===403,rwrite.status+" "+rwrite.text.slice(0,160));
// record approve requires manage: guest denied, manager ok? (need draft)
let draft=await post(`/api/meetings/${mid}/record/draft`,[{id:"a1",text:"t1"}] ,{headers:B(adminT)});
ok("draft-created",draft.status===201,draft.status+" "+draft.text.slice(0,160));
const did=draft.json?.id, dh=draft.json?.hash, dw=draft.json?.watermark;
let gapp=await post(`/api/meetings/${mid}/record/approve`,{draftId:did,hash:dh,watermark:dw,itemIds:["a1"]},{headers:B(guestT)});
ok("guest-denied-approve",gapp.status===403,gapp.status+" "+gapp.text.slice(0,160));
console.log(`PASS=${pass} FAIL=${fail}`);
if(failures.length) console.log("FAILURES:\n"+failures.join("\n"));
process.exit(fail?1:0);
