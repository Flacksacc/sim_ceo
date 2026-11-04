// Owned stack only. Run after parallel-dialogue-qa.mjs, before auth fixtures.
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
const base='http://127.0.0.1:15396';
async function call(method,path,body){const r=await fetch(base+path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});let data=await r.text();try{data=JSON.parse(data);}catch{}return {status:r.status,data};}
async function ok(method,path,body){const r=await call(method,path,body);assert.ok(r.status>=200&&r.status<300,`${path}: ${r.status} ${JSON.stringify(r.data).slice(0,180)}`);return r.data;}
assert.equal((await ok('GET','/health')).instance,'qa-author-15396');assert.equal((await ok('GET','/ready')).store,'inmemory');
const board=await ok('POST','/api/boards',{name:'Streaming QA',mission:'Show actual live replies and readable formatting.'});
const entries=[];
for(const name of ['Streaming Author','Streaming Operator']){
 const entry=await ok('POST','/api/roster',{name,description:'A fictional experienced advisor.',profileJson:JSON.stringify({background:'Experienced fictional expert.',contributionCriteria:'Answer relevant user requests.',reasoningApproach:'Assess claims against evidence and expertise.',responseStyle:'Clear conversational paragraphs, with supported formatting.'})});
 const form=new FormData();form.set('file',new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAgElEQVR4nNXOQREAIAzAsFJxKEEOohGxB9coyNrnUiZxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEufvwNQDrygBtjpJMM0AAAAASUVORK5CYII=','base64')],{type:'image/png'}),'portrait.png');assert.equal((await fetch(base+`/api/roster/${entry.id}/image/upload`,{method:'POST',body:form})).status,201);
 await ok('POST',`/api/roster/${entry.id}/copy`,{boardId:board.id,boardRole:entry.name});entries.push(entry);
}
async function meeting(title,marker){const m=await ok('POST',`/api/boards/${board.id}/meetings`,{title,brief:'Choose a practical plan.'});await ok('PATCH',`/api/meetings/${m.id}`,{brief:'Choose a practical plan.'});const question=marker+': explain a practical plan with useful formatting.';await ok('POST',`/api/meetings/${m.id}/messages`,{sender:'lead',content:question});return {...m,question};}
async function replies(m){return (await ok('GET',`/api/meetings/${m.id}/messages?take=60`)).filter(x=>x.sender==='advisor');}
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
try{
 const ctx=await browser.newContext({viewport:{width:1440,height:1000}});await ctx.grantPermissions(['local-network-access'],{origin:base});const page=await ctx.newPage();const errors=[],unsafeRequests=[];page.on('pageerror',e=>errors.push(String(e)));page.on('request',r=>{if(r.url().includes('/unsafe-image'))unsafeRequests.push(r.url());});
 async function open(m){await page.goto(`${base}/#/meet?board=${board.id}&meeting=${m.id}`);await page.locator('.is-grid .mp-head .badge.live').waitFor();}
 const first=await meeting('Rich live replies','QA-STREAM-UNSAFE');await open(first);let finished=false;const running=ok('POST',`/api/meetings/${first.id}/run`,{prompt:first.question}).then(r=>{finished=true;return r;});
 await page.locator('.advisor-stream .advisor-message').first().waitFor();assert.equal(finished,false,'Partial appears before response completes');
 const early=await page.locator('.advisor-stream .advisor-message').first().innerText();assert.ok(early.length>0&&early.length<220);
 await page.waitForFunction(()=>document.querySelectorAll('.advisor-stream').length>=2);assert.equal(finished,false,'Advisors stream independently in parallel');
 await running;await page.waitForFunction(()=>document.querySelectorAll('.advisor-stream').length===0);
 assert.equal((await replies(first)).length,4);const rich=page.locator('.msg-row.advisor .advisor-message');assert.equal(await rich.count(),4);
 assert.ok(await rich.first().locator('strong').getByText('A clear plan',{exact:true}).isVisible());assert.equal(await rich.first().locator('em').innerText(),'small test');assert.equal(await rich.first().locator('u').innerText(),'protect your runway');assert.equal(await rich.first().locator('ul > li').count(),2);assert.equal(await rich.first().locator('ol > li').count(),2);
 assert.ok((await rich.first().innerText()).includes('café 🌿'));assert.ok(!(await rich.first().innerText()).includes('**'));assert.equal(await rich.locator('script,img').count(),0);assert.equal(await page.evaluate(()=>window.__unsafeStream),undefined);assert.deepEqual(unsafeRequests,[]);assert.equal(await rich.locator('a[href^="javascript:"]').count(),0);
 await page.screenshot({path:'../streaming-formatted-desktop.png'});
 // A generation invalidated after visible tokens must not leave a saved reply.
 const paused=await meeting('Pause a live stream','QA-STREAM-FORMAT');await open(paused);const pauseRun=call('POST',`/api/meetings/${paused.id}/run`,{prompt:paused.question});await page.locator('.advisor-stream').first().waitFor();await ok('POST',`/api/meetings/${paused.id}/pause`,{});assert.equal((await pauseRun).status,409);await page.waitForFunction(()=>!document.querySelector('.advisor-stream'));assert.equal((await replies(paused)).length,0);
 const failed=await meeting('Interrupted provider stream','QA-STREAM-FAIL');await open(failed);const failRun=call('POST',`/api/meetings/${failed.id}/run`,{prompt:failed.question});await page.locator('.advisor-stream').first().waitFor();await failRun;await page.waitForFunction(()=>!document.querySelector('.advisor-stream'));assert.equal((await replies(failed)).length,0);
 // Direct roster chat uses the same renderer and incremental HTTP transport.
 await page.goto(base+'/#/roster');await page.locator('button.lprow').filter({hasText:'Streaming Author'}).first().click();await page.getByRole('tab',{name:'Chat',exact:true}).click();const chat=page.locator('[data-roster-chat="'+entries[0].id+'"]');await chat.getByRole('textbox',{name:'Message Streaming Author',exact:true}).fill('QA-STREAM-FORMAT: give me a clear plan.');await chat.getByRole('button',{name:'Send',exact:true}).click();await chat.locator('[aria-label="Advisor response in progress"] .advisor-message').waitFor();await chat.locator('.roster-chat-log .msg-row.advisor .advisor-message strong').getByText('A clear plan').first().waitFor();await chat.getByRole('button',{name:'Send',exact:true}).waitFor();await page.waitForFunction(()=>!document.querySelector('.roster-chat-log [aria-label="Advisor response in progress"]'));
 assert.equal(await chat.locator('.roster-chat-log .msg-row.advisor').count(),1);assert.equal(await chat.locator('.advisor-message u').innerText(),'protect your runway');
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:'../streaming-roster-mobile.png'});assert.deepEqual(errors,[]);await ctx.close();
}finally{await browser.close();}
console.log('PASS real partial display before completion, parallel streaming, final replacement without duplicates, bold/italic/underline/lists/Unicode, sanitized scripts/images/URLs, pause and truncation rollback, roster streaming and mobile layout');
