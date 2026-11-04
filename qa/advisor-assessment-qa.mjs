// Owned stack only. Run after parallel-dialogue-qa.mjs.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
const base='http://127.0.0.1:15396',fake='http://127.0.0.1:15398';
async function call(method,path,body){const response=await fetch(base+path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});let data=await response.text();try{data=JSON.parse(data);}catch{}return {status:response.status,data};}
async function ok(method,path,body){const r=await call(method,path,body);assert.ok(r.status>=200&&r.status<300,`${path}: ${r.status} ${JSON.stringify(r.data).slice(0,180)}`);return r.data;}
assert.equal((await ok('GET','/health')).instance,'qa-author-15396');assert.equal((await ok('GET','/ready')).store,'inmemory');
const board=await ok('POST','/api/boards',{name:'Independent judgment QA',mission:'Give grounded advice and critique instead of automatic agreement.'});
const entries=[];
for(const name of ['Author Expert','Product Expert']){
 const entry=await ok('POST','/api/roster',{name,description:'A fictional expert who evaluates evidence independently.',profileJson:JSON.stringify({background:'Experienced fictional advisor evaluating craft and practical decisions.',contributionCriteria:'Contribute relevant evidence and critiques.',reasoningApproach:'Use causal motivation and specific evidence; support, challenge or give a mixed judgment as justified.',responseStyle:'Direct, concise and conversational. User preferences affect delivery, never correctness.'})});
 const form=new FormData();form.set('file',new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6kWQAAAAASUVORK5CYII=','base64')],{type:'image/png'}),'portrait.png');assert.equal((await fetch(base+`/api/roster/${entry.id}/image/upload`,{method:'POST',body:form})).status,201);
 await ok('POST',`/api/roster/${entry.id}/copy`,{boardId:board.id,boardRole:entry.name});entries.push(entry);
}
let mixed;
for(const [marker,stance] of [['CHALLENGE','Disagrees'],['SUPPORT','Agrees'],['MIXED','Mixed assessment'],['MISSING','Needs context']]){
 const meeting=await ok('POST',`/api/boards/${board.id}/meetings`,{title:'Judgment '+marker,brief:'Evaluate the supplied material.'});await ok('PATCH',`/api/meetings/${meeting.id}`,{brief:'Evaluate the supplied material.'});
 const question=`QA-ASSESSMENT-${marker}: Evaluate this story and the user's direction using the advisor standards. Hero follows a stranger into the cave for no reason.`;
 await ok('POST',`/api/meetings/${meeting.id}/messages`,{sender:'lead',content:question});await ok('POST',`/api/meetings/${meeting.id}/run`,{prompt:question});
 const replies=(await ok('GET',`/api/meetings/${meeting.id}/messages?take=60`)).filter(m=>m.sender==='advisor');assert.ok(replies.length>=2&&replies.length<=4);
 assert.ok(replies.every(r=>r.stance===stance));assert.ok(replies.every(r=>!r.content.includes('"position"')&&!r.content.includes('[stance:')&&!r.content.includes('[reply-to:')));
 const first=replies.filter(r=>r.parentSequence===1||r.parentSequence==null).slice(0,2);
 for(const follow of replies.slice(2))assert.ok(replies.slice(0,2).some(r=>r.sequence===follow.parentSequence&&r.advisorId!==follow.advisorId),'Follow-up has a real peer target');
 const log=await(await fetch(fake+'/__log')).json();const calls=log.filter(p=>p.full.includes(`QA-ASSESSMENT-${marker}`));
 for(const role of ['Author Expert','Product Expert']){const own=calls.filter(p=>p.full.includes('BOARD ROLE (board-specific, not canonical): '+role));const initialAssessment=own.findIndex(p=>p.full.includes('ADVISOR-ASSESSMENT.')&&!p.full.includes('PEER-REVIEW TURN:'));const writer=own.findIndex(p=>p.full.includes('VALIDATED ADVISOR ASSESSMENT')&&!p.full.includes('ADVISOR-ASSESSMENT.')&&!p.full.includes('PEER-REVIEW TURN:'));assert.ok(initialAssessment>=0&&writer>initialAssessment,'Assessment completes before writing');assert.ok(own[writer].full.includes('"position":"'+({CHALLENGE:'challenge',SUPPORT:'support',MIXED:'mixed',MISSING:'insufficient'}[marker])+'"'));}
 if(marker==='MIXED')mixed=meeting;
 const chat=await ok('POST',`/api/roster/${entries[0].id}/chat`,{message:question});assert.ok(chat.answer&&!chat.answer.includes('"position"')&&!chat.answer.includes('[stance:'));
 const audition=await ok('POST','/api/auditions',{rosterId:entries[0].id,question});assert.ok(audition.answer&&!audition.answer.includes('"position"')&&!audition.answer.includes('[stance:'));
}
for(const marker of ['INVALID','HALLUCINATION']){
 const meeting=await ok('POST',`/api/boards/${board.id}/meetings`,{title:'Reject '+marker,brief:'Do not publish an ungrounded assessment.'});const question=`QA-ASSESSMENT-${marker}: critique this scene.`;await ok('POST',`/api/meetings/${meeting.id}/messages`,{sender:'lead',content:question});await call('POST',`/api/meetings/${meeting.id}/run`,{prompt:question});
 assert.equal((await ok('GET',`/api/meetings/${meeting.id}/messages?take=60`)).filter(m=>m.sender==='advisor').length,0);
 assert.equal((await call('POST',`/api/roster/${entries[0].id}/chat`,{message:question})).status,502);
 const log=await(await fetch(fake+'/__log')).json();assert.ok(!log.some(p=>p.full.includes(`QA-ASSESSMENT-${marker}`)&&p.full.includes('VALIDATED ADVISOR ASSESSMENT')&&!p.full.includes('ADVISOR-ASSESSMENT.')),'Invalid assessment never reaches the writer');
}
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
try{const ctx=await browser.newContext();await ctx.grantPermissions(['local-network-access'],{origin:base});const page=await ctx.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));await page.goto(`${base}/#/meet?board=${board.id}&meeting=${mixed.id}`);await page.getByText('Mixed assessment',{exact:true}).first().waitFor();assert.equal(await page.getByText('VALIDATED ADVISOR ASSESSMENT',{exact:false}).count(),0);assert.deepEqual(errors,[]);await ctx.close();}finally{await browser.close();}
console.log('PASS assessment before writer, support/challenge/mixed/missing context, direct chat, peer threading and bounds, server-owned stance, malformed and fabricated evidence blocked, human-readable mixed badge');
