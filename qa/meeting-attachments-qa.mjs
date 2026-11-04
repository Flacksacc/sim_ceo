// Run only on the owned QA stack; may also follow parallel-dialogue-qa.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
const base='http://127.0.0.1:15396';
const fixtures=JSON.parse(fs.readFileSync(new URL('./fixtures/meeting-attachments.json',import.meta.url)));
async function ok(method,path,body){const r=await fetch(base+path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});assert.ok(r.ok,`${path}: ${r.status} ${await (!r.ok?r.text():Promise.resolve(''))}`);return r.json();}
assert.equal((await ok('GET','/health')).instance,'qa-author-15396');
assert.equal((await ok('GET','/ready')).store,'inmemory');
const profile=await fetch(base+'/api/profile');if(profile.status===404)await ok('POST','/api/profile',{name:'Attachment CEO',background:'A business leader evaluating evidence.',commPrefs:'Brief, clear advice.'});else assert.ok(profile.ok);
const board=await ok('POST','/api/boards',{name:'Attachment QA',mission:'Use source documents to inform practical advice.'});
const roster=await ok('POST','/api/roster',{name:'Attachment Expert',description:'A fictional specialist.',profileJson:JSON.stringify({background:'An experienced specialist in document analysis.',contributionCriteria:'Respond to direct requests.',reasoningApproach:'Use the supplied evidence.',responseStyle:'Concise and conversational.'})});
const portrait=new FormData();portrait.set('file',new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6kWQAAAAASUVORK5CYII=','base64')],{type:'image/png'}),'portrait.png');assert.equal((await fetch(base+`/api/roster/${roster.id}/image/upload`,{method:'POST',body:portrait})).status,201);
await ok('POST',`/api/roster/${roster.id}/copy`,{boardId:board.id,boardRole:roster.name});
const makeMeeting=title=>ok('POST',`/api/boards/${board.id}/meetings`,{title,brief:'Use attachment evidence.',participantIds:[]});
const meeting=await makeMeeting('Attachment context'),other=await makeMeeting('Isolated context');
await ok('PATCH',`/api/meetings/${meeting.id}`,{brief:'Use attachment evidence.'});
async function upload(name,bytes,mid=meeting.id,auto=true,scope='meeting'){
 const data=new FormData();data.set('file',new Blob([bytes]),name);data.set('scope',scope);data.set('meetingId',mid);if(auto)data.set('addToMeetingContext','true');
 return fetch(base+`/api/boards/${board.id}/sources/upload`,{method:'POST',body:data});
}
const before=await ok('GET',`/api/boards/${board.id}/meetings`);
const bytes=Buffer.from('TXT-ATTACHMENT-CONTEXT: Project Juniper has a hiring budget of 73129 dollars.');
const first=await upload('budget.txt',bytes);assert.equal(first.status,200);const source=await first.json();assert.ok(source.approved&&source.isCurrent&&source.sectionCount>0);assert.equal(source.indexState,'completed');
const duplicate=await upload('budget.txt',bytes);assert.equal(duplicate.status,200);assert.equal((await duplicate.json()).id,source.id);
for(const ext of ['pdf','docx','pptx','xlsx']){
 const r=await upload(`evidence.${ext}`,Buffer.from(fixtures[ext],'base64'));assert.equal(r.status,200,`${ext} ${r.status}`);const row=await r.json();assert.ok(row.approved&&row.sectionCount>0);assert.ok(row.extractionJson.includes(ext.toUpperCase()+'-ATTACHMENT-CONTEXT'));
}
assert.equal((await upload('empty.txt',Buffer.alloc(0))).status,400);
assert.equal((await upload('invalid.txt',Buffer.from([255,254,253]))).status,422);
assert.equal((await upload('broken.pdf',Buffer.from('not a PDF'))).status,422);
assert.equal((await upload('scan.png',Buffer.from('not supported'))).status,422);
assert.equal((await upload('big.txt',Buffer.alloc(10*1024*1024+1,65))).status,400);
assert.equal((await upload('board.txt',bytes,meeting.id,true,'board')).status,400);
const long=await upload('long.txt',Buffer.from('Long document context. '.repeat(1000)));assert.equal(long.status,200);assert.equal((await long.json()).indexTruncated,true);
const wrongBoard=await ok('POST','/api/boards',{name:'Wrong scope'});const wrongMeeting=await ok('POST',`/api/boards/${wrongBoard.id}/meetings`,{title:'Other board'});assert.equal((await upload('wrong.txt',bytes,wrongMeeting.id)).status,409);
const ordinary=await upload('manual.txt',Buffer.from('MANUAL-PENDING-CONTEXT must not activate'),meeting.id,false);assert.equal(ordinary.status,201);assert.equal((await ordinary.json()).approved,false);
const after=await ok('GET',`/api/boards/${board.id}/meetings`);
assert.equal(after.find(m=>m.id===meeting.id).state,before.find(m=>m.id===meeting.id).state,'Uploads must not pause the meeting');
assert.equal(after.find(m=>m.id===other.id).generation,before.find(m=>m.id===other.id).generation,'Uploads must not invalidate other meetings');
const recall=mid=>ok('GET',`/api/boards/${board.id}/recall?q=Juniper&meetingId=${mid}`);
assert.ok(JSON.stringify(await recall(meeting.id)).includes('73129'));
assert.ok(!JSON.stringify(await recall(other.id)).includes('73129'),'Meeting attachment must not leak across meetings');
assert.ok(!JSON.stringify(await ok('GET',`/api/boards/${board.id}/recall?q=Juniper`)).includes('73129'),'Meeting attachment must not leak into board-wide recall');
const prompt='QA-PARALLEL-DIALOGUE: Have Attachment Expert use the Juniper hiring budget from budget.txt to advise me.';
await ok('POST',`/api/meetings/${meeting.id}/messages`,{sender:'lead',content:prompt});await ok('POST',`/api/meetings/${meeting.id}/run`,{prompt});
const log=await (await fetch('http://127.0.0.1:15398/__log')).json();
assert.ok(log.some(p=>p.full.includes('YOUR TURN')&&p.full.includes('73129')&&p.full.includes('budget.txt')),'Attachment evidence must reach the actual advisor prompt');
console.log('PASS auto context, duplicate reuse, local text/PDF/Office reading, failed/oversize/unsupported files, normal upload preserved, scope isolation, actual advisor prompt');
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
try{
 const ctx=await browser.newContext({viewport:{width:1440,height:1000}});await ctx.grantPermissions(['local-network-access'],{origin:base});const page=await ctx.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.goto(`${base}/#/meet?board=${board.id}&meeting=${meeting.id}`);const area=page.getByRole('region',{name:'Meeting attachments'});await area.waitFor();await page.waitForFunction(()=>document.querySelectorAll('.mp-advisor-grid > li').length===10&&document.querySelectorAll('.mp-empty').length===9);assert.equal(await page.locator('.mp-empty').count(),9);
 await area.getByText('budget.txt',{exact:false}).waitFor();
 for(const role of ['orchestrator','secretary'])assert.equal(await page.locator(`.mp-seat img[src="/portraits/${role}-v2.webp"]`).evaluate(i=>i.complete&&i.naturalWidth>0),true);
 const composer=page.getByRole('textbox',{name:'Message. Press Enter to send, Shift and Enter for a new line.',exact:true});await composer.fill('Preserve this unsent draft.');
 await page.route('**/sources/upload',async route=>{await new Promise(resolve=>setTimeout(resolve,350));await route.continue();},{times:1});
 await area.locator('input[type=file]').setInputFiles({name:'browser.txt',mimeType:'text/plain',buffer:Buffer.from('BROWSER-ATTACHMENT-CONTEXT: visible progress.')});
 await area.getByText('browser.txt — Uploading and reading…').waitFor();await area.getByText('browser.txt Ready in meeting context').waitFor();
 assert.equal(await composer.inputValue(),'Preserve this unsent draft.');
 await area.getByText('First 12,000 characters available in context').waitFor();
 await area.locator('input[type=file]').setInputFiles({name:'invalid.pdf',mimeType:'application/pdf',buffer:Buffer.from('not a pdf')});
 await area.getByText(/invalid[.]pdf/).waitFor();await page.waitForFunction(()=>!document.querySelector('.attachment-spinner'));
 assert.equal(await area.getByText('invalid.pdf Ready in meeting context').count(),0);
 await area.locator('.attachment-drop').evaluate(el=>{const dt=new DataTransfer();dt.items.add(new File(['DROP-ATTACHMENT-CONTEXT: drag and drop works.'],'dropped.md',{type:'text/markdown'}));el.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));});
 await area.getByText('dropped.md Ready in meeting context').waitFor();
 await page.reload();await page.getByText('dropped.md Ready in meeting context').waitFor();
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 assert.deepEqual(errors,[]);await page.screenshot({path:new URL('../attachments-mobile.png',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'),fullPage:true});await ctx.close();
}finally{await browser.close();}
console.log('PASS portraits, file picker, visible processing, real drop, saved context after reload, untouched draft, mobile layout');
