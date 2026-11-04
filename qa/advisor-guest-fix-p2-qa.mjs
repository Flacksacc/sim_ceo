import fs from "node:fs";
const API = "http://127.0.0.1:15390";
const run = "gfix2-" + Date.now().toString(36) + "-" + Math.floor(Math.random()*1e6).toString(36);
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
  console.log("P2 run="+run);
  const pw="TestPassword123!";
  const adminE=run+"-admin@example.com", guestE=run+"-guest@example.com", otherE=run+"-other@example.com", boardGuestE=run+"-bguest@example.com";
  const ar=await req("POST","/api/auth/register",{email:adminE,password:pw});
  ok("admin-reg", ar.status===201 && ar.json?.token, ar.status+" "+ar.text.slice(0,120));
  const gr=await req("POST","/api/auth/register",{email:guestE,password:pw});
  ok("guest-reg", gr.status===201 && gr.json?.token, gr.status+" "+gr.text.slice(0,120));
  const or=await req("POST","/api/auth/register",{email:otherE,password:pw});
  ok("other-reg", or.status===201 && or.json?.token, or.status+" "+or.text.slice(0,120));
  const br=await req("POST","/api/auth/register",{email:boardGuestE,password:pw});
  ok("boardguest-reg", br.status===201 && br.json?.token, br.status+" "+br.text.slice(0,120));
  const adminT=ar.json.token, guestT=gr.json.token, otherT=or.json.token, bguestT=br.json.token;
  const b=await req("POST","/api/boards",{name:run+"-b",mission:"m",stage:"qa"},B(adminT));
  ok("board-create", b.status===201 && b.json?.id, b.status+" "+b.text.slice(0,160));
  const bid=b.json.id;
  const m=await req("POST","/api/boards/"+bid+"/meetings",{title:run+"-meet",brief:"b"},B(adminT));
  ok("meeting-create", m.status===201 && m.json?.id, m.status+" "+m.text.slice(0,120));
  const mid=m.json.id;
  const oj=await req("POST","/api/meetings/"+mid+"/join",{},B(adminT));
  ok("owner-join-no-grant", oj.status===200, oj.status+" "+oj.text.slice(0,200));
  const om=await req("GET","/api/me/memberships",undefined,B(adminT));
  const orows=Array.isArray(om.json)?om.json:[];
  const ofound=orows.find(r=>(r.meetingId||r.MeetingId)===mid && (r.active===true||r.Active===true));
  ok("owner-membership-listed-no-grant", om.status===200 && !!ofound, om.status+" rows="+orows.length);
  const od=await req("GET","/api/boards/"+bid+"/meetings/"+mid,undefined,B(otherT));
  ok("unrelated-denied", od.status===403||od.status===401||od.status===404, od.status+" "+od.text.slice(0,120));
  const om2=await req("GET","/api/me/memberships",undefined,B(otherT));
  ok("unrelated-empty", om2.status===200 && Array.isArray(om2.json) && om2.json.length===0, om2.status+" "+om2.text.slice(0,200));
  const gg=await req("POST","/api/boards/"+bid+"/grants",{userKey:guestE,access:"discuss",meetingId:mid},B(adminT));
  ok("grant-guest", gg.status===201, gg.status+" "+gg.text.slice(0,160));
  const gj=await req("POST","/api/meetings/"+mid+"/join",{},B(guestT));
  ok("guest-join", gj.status===200, gj.status+" "+gj.text.slice(0,200));
  const gm=await req("GET","/api/me/memberships",undefined,B(guestT));
  ok("guest-active-listed", Array.isArray(gm.json) && gm.json.some(r=>(r.meetingId||r.MeetingId)===mid && (r.active===true||r.Active===true)), gm.text.slice(0,300));
  const lv=await req("POST","/api/meetings/"+mid+"/leave",{},B(guestT));
  ok("guest-leave", lv.status===200, lv.status+" "+lv.text.slice(0,160));
  const gm2=await req("GET","/api/me/memberships",undefined,B(guestT));
  const grows2=Array.isArray(gm2.json)?gm2.json:[];
  ok("left-meeting-guest-hidden-no-resurrect", !grows2.some(r=>(r.meetingId||r.MeetingId)===mid), gm2.text.slice(0,300));
  const bg=await req("POST","/api/boards/"+bid+"/grants",{userKey:boardGuestE,access:"read"},B(adminT));
  ok("grant-boardwide", bg.status===201, bg.status+" "+bg.text.slice(0,200));
  const bj=await req("POST","/api/meetings/"+mid+"/join",{},B(bguestT));
  ok("boardguest-join", bj.status===200, bj.status+" "+bj.text.slice(0,200));
  const bm=await req("GET","/api/me/memberships",undefined,B(bguestT));
  ok("boardguest-active-listed", Array.isArray(bm.json) && bm.json.some(r=>(r.meetingId||r.MeetingId)===mid), bm.text.slice(0,300));
  const bl=await req("POST","/api/meetings/"+mid+"/leave",{},B(bguestT));
  ok("boardguest-leave", bl.status===200, bl.status+" "+bl.text.slice(0,160));
  const bm2=await req("GET","/api/me/memberships",undefined,B(bguestT));
  const brows2=Array.isArray(bm2.json)?bm2.json:[];
  const binv=brows2.find(r=>(r.meetingId||r.MeetingId)===mid && (r.active===false||r.Active===false));
  ok("boardwide-inactive-rejoinable", !!binv && (binv.canRejoin===true||binv.CanRejoin===true), bm2.text.slice(0,300));
  const bj2=await req("POST","/api/meetings/"+mid+"/join",{},B(bguestT));
  ok("boardwide-explicit-rejoin", bj2.status===200, bj2.status+" "+bj2.text.slice(0,200));
  const bm3=await req("GET","/api/me/memberships",undefined,B(bguestT));
  ok("boardwide-active-after-rejoin", Array.isArray(bm3.json) && bm3.json.some(r=>(r.meetingId||r.MeetingId)===mid && (r.active===true||r.Active===true)), bm3.text.slice(0,300));
  const om3=await req("GET","/api/me/memberships",undefined,B(adminT));
  ok("owner-still-listed", Array.isArray(om3.json) && om3.json.some(r=>(r.meetingId||r.MeetingId)===mid), om3.text.slice(0,300));
  console.log("FINAL pass="+pass+" fail="+fail);
  if(bad.length){ console.log("FAILURES:"); for(const x of bad) console.log(" - "+x); }
  process.exitCode=fail===0?0:1;
}
main().catch(e=>{ console.error("FATAL",e); process.exitCode=2; });
