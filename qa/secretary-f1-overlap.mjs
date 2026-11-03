import crypto from "node:crypto";
import fs from "node:fs";
// F1 focused proof: answer status-write fault then 2 overlapping recovery retries exact owner+provider delta.
// Old marker MUST NOT supersede new LiveAttempts; after authoritative reconcile + successful new reservation retire old marker for BOTH initial+answer, no duplicate provider/accounting.
const API = process.env.QA_API || "http://127.0.0.1:5113";
const FAKE = process.env.QA_FAKE || "http://127.0.0.1:5205";
const OUT = process.env.QA_OUT || ".tmp/secretary-f1-overlap.txt";
fs.mkdirSync(".tmp", { recursive: true });
fs.writeFileSync(OUT, "START F1 " + new Date().toISOString() + "\n");
let pass = 0, fail = 0;
function ok(n, c, e) { if (c) { pass++; fs.appendFileSync(OUT, "PASS " + n + "\n"); } else { fail++; fs.appendFileSync(OUT, "FAIL " + n + " :: " + (e||"") + "\n"); console.log("FAIL " + n + " :: " + (e||"")); } }
async function req(m, p, b) { const r = await fetch(API + p, { method: m, headers: { "content-type": "application/json", "x-user": "owner" }, body: b===undefined?undefined:JSON.stringify(b) }); const t = await r.text(); let j=null; try { j=t?JSON.parse(t):null; } catch {} return { status:r.status, json:j, text:t }; }
async function fakeCounts() { try { const r = await fetch(FAKE + "/__counts"); return await r.json(); } catch { return null; } }
async function qaTrigger(a) { const dll="qa/StorageFaultTrigger/bin/Debug/net10.0/StorageFaultTrigger.dll"; const cs=process.env.PGCS||"Host=127.0.0.1;Port=15440;Database=simceo;Username=simceo;Password=simceo-dev-only"; return new Promise((res)=>{ const { spawn }=require("node:child_process"); const p=spawn("dotnet",[dll,a],{windowsHide:true,env:{...process.env,PGCS:cs}}); let o="",e=""; p.stdout.on("data",(d)=>o+=d); p.stderr.on("data",(d)=>e+=d); p.on("close",(c)=>res({code:c,out:o,err:e})); }); }
const guid=()=>crypto.randomUUID();
async function main() {
  const run="f1-"+Date.now().toString(36);
  const b=await req("POST","/api/boards",{name:run+" board",mission:run+" mission",stage:"qa"});
  ok("f1-board",b.status===201,b.status+" "+b.text.slice(0,120));
  const bid=b.json.id||b.json.Id;
  await req("POST","/api/boards/"+bid+"/lead",{name:"QA Lead",roleLabel:"Chief",background:"bg",familiarTopics:"fam",simplerTopics:"sim",commPrefs:"direct"});
  const q=await req("POST","/api/roster/quick",{accountId:guid(),name:run+" adv",description:"advisor helping with "+run+" and strategy work for grounding"});
  const rid=q.json.id||q.json.entry.id;
  const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==","base64");
  const fd=new FormData(); fd.append("file",new Blob([png],{type:"image/png"}),"qa.png");
  await fetch(API+"/api/roster/"+rid+"/image/upload",{method:"POST",headers:{"x-user":"owner"},body:fd});
  const imgs=await req("GET","/api/roster/"+rid+"/images",undefined);
  const imgId=(imgs.json&&imgs.json[0]&&(imgs.json[0].id||imgs.json[0].Id))||null;
  await req("POST","/api/images/"+imgId+"/review",{decision:"accept"});
  const cp=await req("POST","/api/roster/"+rid+"/copy",{boardId:bid,boardRole:"Strategist"});
  await req("POST","/api/boards/"+bid+"/advisors/"+(cp.json.id||cp.json.Id)+"/approve",{});
  const m=await req("POST","/api/boards/"+bid+"/meetings",{title:run+" meeting",brief:"f1 brief"});
  const mid=m.json.id||m.json.Id;
  const up=new FormData(); up.append("file",new Blob(["F1 pricing. Budget 10 to 20."],{type:"text/plain"}),"p.txt"); up.append("scope","board");
  const upR=await fetch(API+"/api/boards/"+bid+"/sources/upload",{method:"POST",headers:{"x-user":"owner"},body:up});
  const upJ=await upR.json();
  await req("POST","/api/sources/"+(upJ.id||upJ.Id)+"/approve",{});
  await req("POST","/api/meetings/"+mid+"/resume",{});
  // Ambiguous -> needs-clarification
  const nonce=guid();
  const sA=await req("POST","/api/meetings/"+mid+"/secretary",{input:"F1 ambiguous SECRETARY-AMBIGUOUS",clientNonce:nonce});
  ok("f1-ambiguous",sA.status===200&&sA.json&&sA.json.status==="needs-clarification",sA.status+" "+sA.text.slice(0,200));
  const reqId=sA.json.requestId;
  // Install answer status-write fault (BEFORE UPDATE on SecretaryRequests)
  const { spawn }=await import("node:child_process");
  const trig=await new Promise((res)=>{ const p=spawn("dotnet",["qa/StorageFaultTrigger/bin/Debug/net10.0/StorageFaultTrigger.dll","install-requests-fail"],{windowsHide:true,env:{...process.env,PGCS:process.env.PGCS||"Host=127.0.0.1;Port=15440;Database=simceo;Username=simceo;Password=simceo-dev-only"}}); let o=""; p.stdout.on("data",(d)=>o+=d); p.on("close",(c)=>res({code:c,out:o})); });
  ok("f1-trigger",trig.code===0&&trig.out.indexOf("installed")>=0,JSON.stringify(trig).slice(0,120));
  // First answer attempt will hit status-write fault on reservation (UPDATE) -> 503 with uncertain marker bound to failed attempt
  const c0=await fakeCounts();
  const lead0=(await req("GET","/api/meetings/"+mid+"/messages?take=100")).json.filter((x)=>(x.sender||x.Sender)==="lead").length;
  const a1=req("POST","/api/meetings/"+mid+"/secretary/answer",{requestId:reqId,answer:"F1 answer QA-SLEEP:3000"});
  // Overlapping retries: two identical retries while first is in-flight (or failed uncertain). They must serialize to one owner + one provider delta, not duplicate.
  // To exercise overlapping, we fire two retries without awaiting first (first will 503 due to trigger, second should 409 in-flight or 503, not duplicate provider).
  const r2=await req("POST","/api/meetings/"+mid+"/secretary/answer",{requestId:reqId,answer:"F1 answer QA-SLEEP:3000"});
  const r1=await a1;
  // Both should be 503 (reservation fault) or one 409 in-flight; neither should have done provider work (no new note, no provider delta beyond 0 or 1?).
  // With trigger armed, both reservations fail before provider, so provider delta must be 0 and owner messages unchanged (answer appends only on success, which needs drop).
  const c1=await fakeCounts();
  const lead1=(await req("GET","/api/meetings/"+mid+"/messages?take=100")).json.filter((x)=>(x.sender||x.Sender)==="lead").length;
  ok("f1-overlap-no-provider", (c1.chat - c0.chat)===0, "delta="+(c1.chat-c0.chat));
  ok("f1-overlap-owner-once", lead1===lead0, lead0+"->"+lead1);
  ok("f1-overlap-status", [503,409].includes(r1.status) && [503,409,502].includes(r2.status), r1.status+"/"+r2.status+" "+r1.text.slice(0,120)+" / "+r2.text.slice(0,120));
  // Drop trigger, retry with same nonce/answer must succeed exactly once (one owner append for answer? Actually answer appends lead message once on first success; retry must not duplicate).
  const drop=await new Promise((res)=>{ const p=spawn("dotnet",["qa/StorageFaultTrigger/bin/Debug/net10.0/StorageFaultTrigger.dll","drop"],{windowsHide:true,env:{...process.env,PGCS:process.env.PGCS||"Host=127.0.0.1;Port=15440;Database=simceo;Username=simceo;Password=simceo-dev-only"}}); let o=""; p.stdout.on("data",(d)=>o+=d); p.on("close",(c)=>res({code:c,out:o})); });
  ok("f1-drop",drop.code===0,JSON.stringify(drop).slice(0,120));
  const c2=await fakeCounts();
  const r3=await req("POST","/api/meetings/"+mid+"/secretary/answer",{requestId:reqId,answer:"F1 answer QA-SLEEP:3000"});
  ok("f1-retry-200",r3.status===200&&r3.json&&r3.json.note,r3.status+" "+r3.text.slice(0,200));
  const c3=await fakeCounts();
  ok("f1-retry-one-provider",(c3.chat-c2.chat)===1,"delta="+(c3.chat-c2.chat));
  const r4=await req("POST","/api/meetings/"+mid+"/secretary/answer",{requestId:reqId,answer:"F1 answer QA-SLEEP:3000"});
  ok("f1-replay-no-provider",r4.status===200&&((await fakeCounts()).chat-c3.chat)===0,"replay delta="+((await fakeCounts()).chat-c3.chat));
  fs.appendFileSync(OUT,"DONE pass="+pass+" fail="+fail+"\n");
  if (fail>0) process.exit(1);
}
main().catch((e)=>{ fs.appendFileSync(OUT,"FATAL "+String((e&&e.stack)||e)+"\n"); process.exit(1); });
