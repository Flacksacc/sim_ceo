import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
const base = 'http://127.0.0.1:15396', fake = 'http://127.0.0.1:15398';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function call(method, path, body) {
  const response = await fetch(base + path, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data };
}
async function ok(method, path, body) { const r = await call(method, path, body); assert.ok(r.status >= 200 && r.status < 300, `${method} ${path}: ${r.status} ${JSON.stringify(r.data).slice(0,180)}`); return r.data; }
async function until(fn, message, timeout = 12000) { const start = Date.now(); while (Date.now() - start < timeout) { const value = await fn(); if (value) return value; await pause(35); } throw new Error(message); }
assert.equal((await ok('GET','/health')).instance, 'qa-author-15396');
assert.equal((await ok('GET','/ready')).store, 'inmemory');
assert.equal((await ok('GET','/api/auth/status')).hasAccounts, false);
assert.deepEqual(await (await fetch(fake + '/__log')).json(), []);
let profile = await ok('POST','/api/profile', { name:'CEO Context', roleLabel:'Board Lead', background:'CEO-BACKGROUND-ONLY: six weeks of cash and no hiring experience.', familiarTopics:'Sales', simplerTopics:'Cash flow', commPrefs:'Conversational advice with a practical next step.' });
const board = await ok('POST','/api/boards', { name:'Parallel dialogue QA', mission:'Hiring without exhausting runway', stage:'Early business', discussionPolicy:'balanced' });
const advisors = [];
for (const role of ['Operator Fast','Finance Slow','Designer Outside','Observer Outside']) {
  const roster = await ok('POST','/api/roster', { name:role, description:'A fictional experienced advisor for focused advice.', profileJson:JSON.stringify({ background:'BACKSTORY ' + role + ': distinctive experience addressing hiring and runway decisions.', contributionCriteria:'Contribute when ' + role + ' can add a useful perspective.', reasoningApproach:'Use the experience of ' + role + ' to identify concrete tradeoffs.', responseStyle:'Speak conversationally and challenge assumptions with reasons.' }) });
  const form = new FormData();
  form.set('file', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAgElEQVR4nNXOQREAIAzAsFJxKEEOohGxB9coyNrnUiZxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEufvwNQDrygBtjpJMM0AAAAASUVORK5CYII=','base64')], {type:'image/png'}),'portrait.png');
  const uploaded = await fetch(base + `/api/roster/${roster.id}/image/upload`, {method:'POST',body:form});
  assert.equal(uploaded.status,201);
  const image = await uploaded.json();
  await ok('POST',`/api/images/${image.id}/review`,{decision:'accept'});
  const advisor = await ok('POST',`/api/roster/${roster.id}/copy`,{boardId:board.id,boardRole:role});
  advisors.push({...advisor,rosterId:roster.id,role});
}
assert.ok((await ok('GET',`/api/boards/${board.id}/advisors`)).every(a=>a.approved===false),'No advisor approval calls or legacy flags are needed');
async function meeting(title) { return ok('POST',`/api/boards/${board.id}/meetings`,{title,brief:'Assess hiring with six weeks of runway.',participantIds:[]}); }
async function lead(m, question) { return ok('POST',`/api/meetings/${m.id}/messages`,{sender:'lead',content:question}); }
async function activity(m) { return (await ok('GET',`/api/meetings/${m.id}/activity`)).discussion; }
async function replies(m) { return (await ok('GET',`/api/meetings/${m.id}/messages?take=60`)).filter(x=>x.sender==='advisor'); }
const question = 'QA-PARALLEL-DIALOGUE: should I hire someone with six weeks of runway?';
const m = await meeting('Parallel first replies and peer review');
await lead(m,question);
const browser = await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
const errors = [];
try {
  const ctx = await browser.newContext({viewport:{width:1440,height:1000}});
  await ctx.grantPermissions(['local-network-access'],{origin:base});
  const page = await ctx.newPage(); page.on('pageerror',error=>errors.push(String(error)));
  await page.goto(`${base}/#/meet?board=${board.id}&meeting=${m.id}`);
  await page.locator('.is-grid .mp-head .badge.live').waitFor();
  assert.equal(await page.locator('.meeting-tools .mp-seat').count(),6,'All four board advisors plus orchestrator and secretary');
  let finished = false;
  const pending = call('POST',`/api/meetings/${m.id}/run`,{prompt:question,leadVersion:profile.version}).then(r=>{finished=true;return r;});
  await until(async()=> (await activity(m))?.phase==='selecting','Orchestrator selection activity missing');
  await page.waitForFunction(()=>document.querySelector('.mp-seat[title^="Orchestrator:"]')?.dataset.activity==='considering');
  const partial = await until(async()=>{const r=await replies(m);return r.length===1?r:null;},'First response was not posted independently');
  assert.equal(partial[0].advisorName,'Operator Fast'); assert.equal(finished,false);
  await page.waitForFunction(()=>document.querySelector('.mp-seat[title^="Finance Slow:"]')?.dataset.activity==='responding');
  await page.getByText(/QA first reply from Operator Fast/).first().waitFor();
  assert.equal(finished,false,'Browser receives a reply while a peer is still working');
  assert.equal(await page.locator('.mp-seat[title^="Finance Slow:"] .mp-pulse').count(),1);
  const result = await pending; assert.equal(result.status,200,JSON.stringify(result.data));
  const posted = await replies(m); assert.equal(posted.length,4);
  for (const role of ['Operator Fast','Finance Slow']) assert.equal(posted.filter(p=>p.advisorName===role).length,2);
  const initial = posted.slice(0,2);
  for(const reply of posted.slice(2)) {
    assert.ok(initial.some(p=>p.sequence===reply.parentSequence && p.advisorId!==reply.advisorId),'Follow-up threads to an actual peer');
    assert.ok(!reply.content.includes('[reply-to:'));
  }
  assert.equal((await activity(m)).status,'completed');
  await page.waitForFunction(()=>document.querySelector('.mp-seat[title^="Designer Outside:"]')?.dataset.activity==='not-selected');
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await ctx.close(); assert.deepEqual(errors,[]);
} finally { await browser.close(); }
console.log('PASS parallel first replies publish immediately to the UI; real per-agent animations; exactly one threaded peer follow-up; mobile fits');
const log = await (await fetch(fake+'/__log')).json();
const selection = log.find(p=>p.full.includes('SELECT-MEETING-ADVISORS.'));
assert.ok(selection.full.includes('CEO-BACKGROUND-ONLY'));
assert.ok(selection.full.includes('Designer Outside'));
assert.ok(selection.full.includes('Observer Outside'),'Legacy approval flags do not exclude selected board members');
for(const role of ['Operator Fast','Finance Slow']) {
  const first = log.find(p=>p.full.includes('YOUR TURN')&&!p.full.includes('PEER-REVIEW TURN:')&&p.full.includes('BOARD ROLE (board-specific, not canonical): '+role));
  assert.ok(first.full.includes('CEO-BACKGROUND-ONLY')&&first.full.includes('BACKSTORY '+role));
  assert.ok(first.full.includes('Never invent')&&first.full.includes('primary lens'));
  for(const instruction of ['subject-matter expert','concise and accurate','FamiliarTopics','SimplerTopics','never talk down']) assert.ok(first.full.includes(instruction), 'Delivered expert/knowledge-adaptation instruction: '+instruction);
  assert.ok(first.full.includes('Sales')&&first.full.includes('Cash flow'));
}
const firstDispatches = log.filter(p=>p.full.includes('YOUR TURN')&&!p.full.includes('PEER-REVIEW TURN:'));
assert.equal(firstDispatches.length,2); assert.ok(Math.abs(firstDispatches[0].t-firstDispatches[1].t)<500,'Workers dispatch in parallel');
const reviews = log.filter(p=>p.full.includes('PEER-REVIEW TURN:')&&!p.full.includes('ADVISOR-ASSESSMENT.'));
assert.equal(reviews.length,2);
assert.ok(reviews.every(p=>p.full.includes('subject-matter expert')&&p.full.includes('FamiliarTopics')&&p.full.includes('SimplerTopics')));
assert.ok(reviews.every(p=>p.full.includes('QA first reply from Operator Fast')&&p.full.includes('QA first reply from Finance Slow')));
await ok('POST',`/api/meetings/${m.id}/run`,{prompt:question});
assert.equal((await replies(m)).length,4,'Retry never exceeds two posts per advisor per CEO turn');
console.log('PASS selector sees all eligible profiles; packets contain CEO/own advisor backgrounds; reviewers see both peers; retries deduplicate');
const explicit = await meeting('Explicit requested output');
const explicitQuestion='QA-PARALLEL-DIALOGUE QA-SELECT-NONE: Have Designer Outside write a three-sentence story about hiring.';
await lead(explicit,explicitQuestion);
await ok('POST',`/api/meetings/${explicit.id}/run`,{prompt:explicitQuestion});
assert.deepEqual((await replies(explicit)).map(r=>r.advisorName),['Designer Outside']);
console.log('PASS explicit advisor/output request overrides relevance decline while respecting the selected meeting participants');
const abstain = await meeting('Optional peer review');
const abstainQuestion='QA-PARALLEL-DIALOGUE QA-REVIEW-ABSTAIN: advise on hiring.';
await lead(abstain,abstainQuestion); await ok('POST',`/api/meetings/${abstain.id}/run`,{prompt:abstainQuestion});
assert.equal((await replies(abstain)).length,2,'No forced disagreement when review abstains');
const interrupted = await meeting('Pause preserves partial replies'); await lead(interrupted,question);
const pausedRun = call('POST',`/api/meetings/${interrupted.id}/run`,{prompt:question});
await until(async()=>(await replies(interrupted)).length===1,'No partial reply before pause');
await ok('POST',`/api/meetings/${interrupted.id}/pause`,{});
assert.equal((await pausedRun).status,409); assert.equal((await replies(interrupted)).length,1);
assert.equal((await activity(interrupted)).status,'interrupted');
console.log('PASS optional follow-ups abstain; pause blocks unfinished responses while preserving posted replies');
const changed = await meeting('CEO profile changed during selection'); await lead(changed,question);
const changedRun = call('POST',`/api/meetings/${changed.id}/run`,{prompt:question});
await until(async()=>(await activity(changed))?.phase==='selecting','Selection did not start');
profile=await ok('POST','/api/profile',{...profile,background:'CEO-BACKGROUND-UPDATED: twelve weeks of runway.'});
assert.equal((await changedRun).status,409); assert.equal((await replies(changed)).length,0);
const chat = await ok('POST',`/api/roster/${advisors[0].rosterId}/chat`,{message:'CEO-CHAT-ONLY: how would you approach hiring?',history:Array.from({length:12},(_,i)=>({role:'user',content:'HISTORY-ITEM-'+i+'-END'}))});
assert.ok(chat.answer);
const chatLog=(await(await fetch(fake+'/__log')).json()).findLast(p=>p.full.includes('CEO-CHAT-ONLY'));
assert.ok(chatLog.full.includes('CEO-BACKGROUND-UPDATED')&&chatLog.full.includes('BACKSTORY Operator Fast'));
assert.ok(chatLog.full.includes('subject-matter expert')&&chatLog.full.includes('FamiliarTopics')&&chatLog.full.includes('SimplerTopics'));
assert.ok(chatLog.full.includes('HISTORY-ITEM-11-END')&&!chatLog.full.includes('HISTORY-ITEM-0-END'));
const bad = await meeting('Bad selector result'); await lead(bad,'QA-SELECT-BAD');
assert.equal((await call('POST',`/api/meetings/${bad.id}/run`,{prompt:'QA-SELECT-BAD'})).status,502);
assert.equal((await replies(bad)).length,0); assert.equal((await activity(bad)).status,'failed');
console.log('PASS stale CEO profile rejects generation; direct chat receives current default profile/latest history; malformed selection ends honestly');
const cancelled = await meeting('Cancel outstanding parallel workers'); await lead(cancelled,question);
const controller = new AbortController();
const cancelledRequest = fetch(base+`/api/meetings/${cancelled.id}/run`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({prompt:question}),signal:controller.signal}).catch(error=>error);
await until(async()=>(await activity(cancelled))?.phase==='responding','Workers did not start before cancellation');
controller.abort(); await cancelledRequest;
await until(async()=>['interrupted','failed'].includes((await activity(cancelled))?.status),'Cancelled workers did not terminate');
assert.equal((await replies(cancelled)).length,0);
await ok('POST',`/api/meetings/${cancelled.id}/run`,{prompt:'QA-SELECT-NONE'});
const rosterRace=await meeting('Advisor edited during response'); await lead(rosterRace,question);
const rosterRaceRun=call('POST',`/api/meetings/${rosterRace.id}/run`,{prompt:question});
await until(async()=>(await activity(rosterRace))?.phase==='responding','No workers before advisor edit');
const slowEntry=(await ok('GET','/api/roster?accountId=00000000-0000-0000-0000-000000000000')).find(r=>r.entry.id===advisors[1].rosterId).entry;
await ok('PUT',`/api/roster/${slowEntry.id}`,{version:slowEntry.version,profileJson:JSON.stringify({...JSON.parse(slowEntry.profileJson),reasoningApproach:'Updated reasoning invalidates the pending old response.'})});
assert.equal((await rosterRaceRun).status,200);
assert.ok(!(await replies(rosterRace)).some(r=>r.advisorId===advisors[1].id),'Edited advisor never publishes stale reply');
const chatRace=call('POST',`/api/roster/${advisors[0].rosterId}/chat`,{message:'QA-CHAT-PROFILE-RACE QA-SLEEP-C:900: personalize this answer.'});
await until(async()=>(await(await fetch(fake+'/__log')).json()).some(p=>p.full.includes('QA-CHAT-PROFILE-RACE')),'Direct chat did not dispatch');
profile=await ok('POST','/api/profile',{...profile,background:'CEO-BACKGROUND-NEWEST: current constraints changed.'});
assert.equal((await chatRace).status,409,'Direct chat rejects a stale personal profile');
console.log('PASS cancelled workers drain and unlock; edited advisors never publish stale output; direct-chat personal-profile race rejected');
