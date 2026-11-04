// Owned stack only; run after parallel-dialogue-qa.mjs.
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
const base='http://127.0.0.1:15396';
async function call(method,path,body){const r=await fetch(base+path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const text=await r.text();let data;try{data=JSON.parse(text);}catch{data=text;}return {status:r.status,data};}
async function ok(method,path,body){const r=await call(method,path,body);assert.ok(r.status>=200&&r.status<300,`${path}: ${r.status} ${JSON.stringify(r.data)}`);return r.data;}
assert.equal((await ok('GET','/health')).instance,'qa-author-15396');assert.equal((await ok('GET','/ready')).store,'inmemory');
const board=await ok('POST','/api/boards',{name:'No advisor approvals',mission:'Use selected roster profiles immediately'});
let entry=await ok('POST','/api/roster',{name:'Independent Specialist',description:'A fictional specialist who explains practical tradeoffs.',profileJson:JSON.stringify({background:'Experienced fictional specialist.',contributionCriteria:'Contribute when specifically asked.',reasoningApproach:'Explain context and practical tradeoffs.',responseStyle:'Brief and conversational.'})});
const form=new FormData();form.set('file',new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6kWQAAAAASUVORK5CYII=','base64')],{type:'image/png'}),'portrait.png');
const uploaded=await fetch(base+`/api/roster/${entry.id}/image/upload`,{method:'POST',body:form});assert.equal(uploaded.status,201);const image=await uploaded.json();
const advisor=await ok('POST',`/api/roster/${entry.id}/copy`,{boardId:board.id,boardRole:entry.name});assert.equal(advisor.approved,false);
const meeting=await ok('POST',`/api/boards/${board.id}/meetings`,{title:'Ready without approval',brief:'Explain the tradeoffs',participantIds:[]});
async function turn(label){const question=`QA-SELECT-NONE: Have Independent Specialist explain ${label}.`;await ok('POST',`/api/meetings/${meeting.id}/messages`,{sender:'lead',content:question});await ok('POST',`/api/meetings/${meeting.id}/run`,{prompt:question});}
await turn('the available options');
assert.ok((await ok('GET',`/api/meetings/${meeting.id}/messages?take=60`)).some(m=>m.advisorId===advisor.id),'Legacy false flag and an unselected portrait do not prevent a response');
entry=(await ok('GET','/api/roster?accountId=00000000-0000-0000-0000-000000000000')).find(r=>r.entry.id===entry.id).entry;
await ok('PUT',`/api/roster/${entry.id}`,{version:entry.version,profileJson:JSON.stringify({...JSON.parse(entry.profileJson),reasoningApproach:'NEW-CURRENT-REASONING: explain opportunity costs before making recommendations.'})});
const stale=(await ok('GET',`/api/boards/${board.id}/advisors`))[0];assert.equal(stale.stale,true);assert.equal(stale.approved,false);
await turn('a second decision using the edited profile');
const log=await(await fetch('http://127.0.0.1:15398/__log')).json();assert.ok(log.some(p=>p.full.includes('YOUR TURN')&&p.full.includes('NEW-CURRENT-REASONING')),'Edited canonical profile is used without sync or reapproval');
const secretary=await call('POST',`/api/meetings/${meeting.id}/secretary`,{input:'Summarize the discussion briefly.',clientNonce:crypto.randomUUID()});assert.ok(secretary.status>=200&&secretary.status<300,JSON.stringify(secretary));
// Choosing a display image is independent of advisor participation.
await ok('POST',`/api/images/${image.id}/review`,{decision:'accept'});
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});const errors=[];
try{
 const ctx=await browser.newContext({viewport:{width:1440,height:1000}});await ctx.grantPermissions(['local-network-access'],{origin:base});const page=await ctx.newPage();page.on('pageerror',e=>errors.push(String(e)));
 await page.goto(`${base}/#/advisors?board=${board.id}`);await page.getByRole('group',{name:'Selected advisors',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:/approv/i}).count(),0);assert.equal(await page.getByText(/not enabled for meetings|needs approval/i).count(),0);
 await page.goto(`${base}/#/meet?board=${board.id}&meeting=${meeting.id}`);const photo=page.locator('.mp-avatar-crop img').first();await photo.waitFor();await photo.evaluate(i=>i.decode());
 for(const size of [[500,40],[40,500]]){
  const src='data:image/svg+xml,'+encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${size[0]}" height="${size[1]}"><rect width="100%" height="100%" fill="tomato"/></svg>`);
  await photo.evaluate((img,src)=>{img.src=src;},src);await photo.evaluate(i=>i.decode());
  const clipped=await photo.evaluate(img=>{const parent=img.parentElement,a=img.getBoundingClientRect(),b=parent.getBoundingClientRect(),css=getComputedStyle(parent);return {fits:a.width<=b.width+.5&&a.height<=b.height+.5,overflow:css.overflow,border:css.borderRadius,cornerIsImage:document.elementFromPoint(b.left+1,b.top+1)===img};});
  assert.equal(clipped.fits,true);assert.equal(clipped.overflow,'hidden');assert.equal(clipped.border,'50%');assert.equal(clipped.cornerIsImage,false);
 }
 assert.equal(await page.getByText(/needs approval|awaiting approval/i).count(),0);
 await page.screenshot({path:'.tmp/no-advisor-approval-portraits.png',fullPage:false,animations:'disabled'});await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await ctx.close();
}finally{await browser.close();}
assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,checks:['legacy unapproved advisor responds','pending portrait does not gate participation','edited profile responds without repin or approval','secretary works without advisor approval','no approval UI','wide and tall portraits stay inside circle','mobile fits'],errors}));
