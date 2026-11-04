// Run LAST on the owned stack: registering a fixture account enables auth.
import assert from 'node:assert/strict';
const base='http://127.0.0.1:15396',fake='http://127.0.0.1:15398';
let token='';
async function call(method,path,body){const response=await fetch(base+path,{method,headers:{...(body?{'content-type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});let data=await response.text();try{data=JSON.parse(data);}catch{}return {status:response.status,data};}
async function ok(method,path,body){const r=await call(method,path,body);assert.ok(r.status>=200&&r.status<300,`${path}: ${r.status}`);return r.data;}
assert.equal((await ok('GET','/health')).instance,'qa-author-15396');assert.equal((await ok('GET','/ready')).store,'inmemory');assert.equal((await ok('GET','/api/auth/status')).hasAccounts,false);
const credentials={email:'assessment-qa@example.test',password:'Assessment-QA-Only-42!'};token=(await ok('POST','/api/auth/register',credentials)).token;
await ok('POST','/api/profile',{name:'Fixture CEO',background:'A fixture business leader.',commPrefs:'Brief honest advice.'});
const board=await ok('POST','/api/boards',{name:'Auth assessment fixture',mission:'Never publish after session revocation.'});
const entry=await ok('POST','/api/roster',{name:'Auth Expert',description:'A fictional advisor.',profileJson:JSON.stringify({background:'An experienced fictional expert.',contributionCriteria:'Evaluate relevant claims.',reasoningApproach:'Use evidence and practical tradeoffs.',responseStyle:'Concise and direct.'})});
const form=new FormData();form.set('file',new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAgElEQVR4nNXOQREAIAzAsFJxKEEOohGxB9coyNrnUiZxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEufvwNQDrygBtjpJMM0AAAAASUVORK5CYII=','base64')],{type:'image/png'}),'portrait.png');assert.equal((await fetch(base+`/api/roster/${entry.id}/image/upload`,{method:'POST',headers:{Authorization:'Bearer '+token},body:form})).status,201);
await ok('POST',`/api/roster/${entry.id}/copy`,{boardId:board.id,boardRole:entry.name});
const meeting=await ok('POST',`/api/boards/${board.id}/meetings`,{title:'Revoke during assessment',brief:'Evaluate the proposal.'});const prompt='QA-ASSESSMENT-AUTH-RACE: evaluate the supplied idea.';await ok('POST',`/api/meetings/${meeting.id}/messages`,{sender:'lead',content:prompt});
const pending=call('POST',`/api/meetings/${meeting.id}/run`,{prompt});
const start=Date.now();while(true){const log=await(await fetch(fake+'/__log')).json();if(log.some(p=>p.full.includes('QA-ASSESSMENT-AUTH-RACE')&&p.full.includes('ADVISOR-ASSESSMENT.')))break;assert.ok(Date.now()-start<10000);await new Promise(r=>setTimeout(r,25));}
await ok('POST','/api/auth/logout',{});assert.equal((await pending).status,401,'Revocation between assessment and writing must return 401, not 500');
token=(await ok('POST','/api/auth/login',credentials)).token;
assert.equal((await ok('GET',`/api/meetings/${meeting.id}/messages?take=60`)).filter(m=>m.sender==='advisor').length,0);
assert.ok(!(await(await fetch(fake+'/__log')).json()).some(p=>p.full.includes('QA-ASSESSMENT-AUTH-RACE')&&p.full.includes('VALIDATED ADVISOR ASSESSMENT')&&!p.full.includes('ADVISOR-ASSESSMENT.')),'Revoked assessment never reaches writer');
await ok('POST',`/api/meetings/${meeting.id}/run`,{prompt:'QA-SELECT-NONE'});
console.log('PASS session revoked between assessment and writer: 401, no writer call, no publication, run lock released');

// Revocation after HTTP 200/SSE headers must produce an error event, not a
// completed private answer or retained history on the client.
const response=await fetch(base+`/api/roster/${entry.id}/chat`,{method:'POST',headers:{'content-type':'application/json',Accept:'text/event-stream',Authorization:'Bearer '+token},body:JSON.stringify({message:'QA-STREAM-FORMAT: explain the plan.'})});
assert.ok(response.ok&&response.headers.get('content-type').includes('text/event-stream'));
const reader=response.body.getReader(),decoder=new TextDecoder();let wire='',revoked=false;
while(true){const next=await reader.read();if(next.done)break;wire+=decoder.decode(next.value,{stream:true});if(!revoked&&wire.includes('event: delta')){await ok('POST','/api/auth/logout',{});revoked=true;}}
assert.ok(revoked&&wire.includes('event: error')&&wire.includes('"status":401'));assert.ok(!wire.includes('event: done'));
// A revoked image request must not publish a new canonical portrait.
token=(await ok('POST','/api/auth/login',credentials)).token;
const previousImages=await ok('GET',`/api/roster/${entry.id}/images`);
assert.equal((await fetch(base+`/api/images/${previousImages[0].id}`)).status,401);
const beforeImageCalls=(await(await fetch(fake+'/__counts')).json()).images;
const pendingImage=call('POST',`/api/roster/${entry.id}/image/generate`,{count:1,prompt:'QA-PORTRAIT-SLOW auth revocation test'});
const imageStart=Date.now();
while((await(await fetch(fake+'/__counts')).json()).images===beforeImageCalls){assert.ok(Date.now()-imageStart<10000);await new Promise(r=>setTimeout(r,25));}
await ok('POST','/api/auth/logout',{});
assert.ok([401,403].includes((await pendingImage).status));
token=(await ok('POST','/api/auth/login',credentials)).token;
assert.equal((await ok('GET',`/api/roster/${entry.id}/images`)).length,previousImages.length);
console.log('PASS image bytes require authentication and revocation during generation cannot publish a portrait');
console.log('PASS private direct-chat SSE revocation after headers returns error 401 without a completed answer');
