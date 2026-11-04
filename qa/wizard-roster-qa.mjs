import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
const base = 'http://127.0.0.1:15396';
async function call(method, path, body) {
  const r = await fetch(base + path, {method, headers:body === undefined ? {} : {'content-type':'application/json'}, body:body === undefined ? undefined : JSON.stringify(body)});
  const text = await r.text(); let data; try {data = JSON.parse(text);} catch {data = text;}
  return {status:r.status,data};
}
async function ok(method,path,body) {const r=await call(method,path,body);assert.ok(r.status>=200&&r.status<300,`${path}: ${r.status} ${JSON.stringify(r.data)}`);return r.data;}
assert.equal((await ok('GET','/health')).instance,'qa-author-15396');
assert.equal((await ok('GET','/ready')).store,'inmemory');
assert.equal((await ok('GET','/api/auth/status')).hasAccounts,false);
const noProfile=await ok('POST','/api/wizard',{step:4,fieldsJson:JSON.stringify({name:'No saved profile',mission:'First run'})});
assert.ok((await ok('GET',`/api/wizard/${noProfile.id}/review`)).blockers.some(b=>b.field==='profile'));
const defaultProfile=await ok('POST','/api/profile',{name:'Roster picker CEO',background:'Saved background',commPrefs:'Explain the tradeoffs briefly.'});
const entries=[];
for(let i=0;i<11;i++) {
  const entry=await ok('POST','/api/roster',{name:`Advisor ${String(i).padStart(2,'0')}`,description:'An existing fictional specialist.',profileJson:JSON.stringify({background:'An experienced fictional specialist with documented practices.',contributionCriteria:'Contribute when operations expertise is relevant.',reasoningApproach:'Explain practical options using the CEO context.',responseStyle:'Concise conversational explanations.'})});
  const form=new FormData();form.set('file',new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6kWQAAAAASUVORK5CYII=','base64')],{type:'image/png'}),'portrait.png');
  const upload=await fetch(base+`/api/roster/${entry.id}/image/upload`,{method:'POST',body:form});assert.equal(upload.status,201);
  const image=await upload.json();await ok('POST',`/api/images/${image.id}/review`,{decision:'accept'});entries.push(entry);
}
// Put the complete advisors on the second page to verify the entire roster loads.
for(let i=0;i<200;i++) await ok('POST','/api/roster',{name:`Unfinished ${i}`,description:'An unfinished roster profile.',profileJson:JSON.stringify({background:'A fictional profile awaiting a portrait.'})});
const accountId='00000000-0000-0000-0000-000000000000';
assert.equal((await ok('GET',`/api/roster?accountId=${accountId}`)).length,200);
assert.equal((await ok('GET',`/api/roster?accountId=${accountId}&skip=200`)).length,11);
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
const errors=[];
let createdId;
try {
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await context.grantPermissions(['local-network-access'],{origin:base});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(String(e)));
  await page.goto(base+'/#/wizard');
  await page.getByLabel('Board name',{exact:true}).fill('Roster selection QA');
  await page.getByLabel('Mission',{exact:true}).fill('Use existing roster expertise');
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  const group=page.getByRole('group',{name:'Roster advisors'});await group.waitFor();
  await page.waitForFunction(()=>document.querySelectorAll('.wizard-roster-option').length===211);
  assert.equal(await page.getByRole('heading',{name:'Guided interview',exact:true}).count(),0);
  assert.equal(await page.getByRole('heading',{name:'Setup guide',exact:true}).count(),0);
  assert.equal(await group.getByRole('checkbox').count(),211);
  await page.getByLabel('Search roster').fill('Unfinished 199');assert.equal(await group.getByRole('checkbox').count(),1);assert.equal(await group.getByRole('checkbox').isDisabled(),true);
  await page.getByLabel('Search roster').fill('Advisor');assert.equal(await group.getByRole('checkbox').count(),11);
  for(let i=0;i<10;i++) await group.getByRole('checkbox').nth(i).check();
  assert.equal(await group.getByRole('checkbox').nth(10).isDisabled(),true);
  await group.getByRole('checkbox').nth(0).uncheck();assert.equal(await group.getByRole('checkbox').nth(10).isEnabled(),true);
  await group.getByRole('checkbox').nth(10).check();
  await page.getByLabel('Search roster').fill('Advisor 10');assert.equal(await group.getByRole('checkbox').count(),1);assert.equal(await group.getByRole('checkbox').isChecked(),true);
  const saved=page.waitForResponse(r=>r.url().endsWith('/api/wizard')&&r.request().method()==='POST');await page.getByRole('button',{name:'Save draft',exact:true}).click();await saved;
  await page.reload();await group.waitFor();await page.waitForFunction(()=>document.querySelectorAll('.wizard-roster-option input:checked').length===10);
  await page.screenshot({path:'.tmp/wizard-roster-picker.png',fullPage:true,animations:'disabled'});
  await page.getByRole('button',{name:'Continue',exact:true}).click();
  assert.equal(await page.getByRole('heading',{name:'Who leads this board?',exact:true}).count(),0);
  assert.equal(await page.getByRole('list',{name:'Progress'}).locator('li').count(),3);
  await page.getByText('Your saved profile (Roster picker CEO) will be used automatically.',{exact:true}).waitFor();
  const create=page.getByRole('button',{name:'Create board',exact:true});await create.waitFor();
  const response=page.waitForResponse(r=>/\/api\/wizard\/[^/]+\/create$/.test(r.url())&&r.request().method()==='POST');
  await create.click();const r=await response;assert.equal(r.status(),201);const data=await r.json();createdId=data.board.id;
  const lead=await ok('GET',`/api/boards/${createdId}/lead`);assert.equal(lead.source,'default');assert.equal(lead.id,defaultProfile.id);
  const replay=await ok('POST',new URL(r.url()).pathname,{});assert.equal(replay.board.id,createdId);
  const members=await ok('GET',`/api/boards/${createdId}/advisors`);assert.equal(members.length,10);
  assert.deepEqual(members.map(a=>a.rosterEntryId).sort(),entries.slice(1).map(e=>e.id).sort());
  const roster=[...await ok('GET',`/api/roster?accountId=${accountId}`),...await ok('GET',`/api/roster?accountId=${accountId}&skip=200`)];assert.equal(roster.length,211,'No duplicate roster entries created');
  for(const entry of entries) assert.equal(roster.find(r=>r.entry.id===entry.id).entry.profileJson,entry.profileJson);
  await context.close();
} finally {await browser.close();}
assert.deepEqual(errors,[]);
async function rejected(advisors,status=409) {
  const d=await ok('POST','/api/wizard',{step:4,fieldsJson:JSON.stringify({name:'Invalid roster selection',mission:'Validate membership',advisors})});
  const before=(await ok('GET','/api/boards')).length;
  assert.equal((await call('POST',`/api/wizard/${d.id}/create`,{})).status,status);
  assert.equal((await ok('GET','/api/boards')).length,before,'Rejected creation leaves no board');
}
const legacy=await ok('POST','/api/wizard',{step:3,fieldsJson:JSON.stringify({name:'Legacy leader draft',mission:'Inherit the saved CEO',lead:{name:'Outdated leader',background:'Outdated context',override:true},advisors:[{rosterEntryId:entries[0].id}]})});
const resumeBrowser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
try {
 const ctx=await resumeBrowser.newContext();await ctx.grantPermissions(['local-network-access'],{origin:base});
 await ctx.addInitScript(id=>{localStorage.setItem('simceo-wizard:anon',id);localStorage.setItem('simceo-wizard',id);},legacy.id);
 const page=await ctx.newPage();await page.goto(base+'/#/wizard');
 await page.getByRole('heading',{name:'Review and create',exact:true}).waitFor();
 assert.equal(await page.getByRole('heading',{name:'Who leads this board?',exact:true}).count(),0);
 await page.getByText('Your saved profile (Roster picker CEO) will be used automatically.',{exact:true}).waitFor();
 await ctx.close();
} finally {await resumeBrowser.close();}
const oldBoard=await ok('POST',`/api/wizard/${legacy.id}/create`,{});
assert.equal((await ok('GET',`/api/boards/${oldBoard.board.id}/lead`)).id,defaultProfile.id);
const updated=await ok('POST','/api/profile',{...defaultProfile,name:'Updated CEO',background:'New CEO background'});
for(const id of [createdId,oldBoard.board.id]) {
 const lead=await ok('GET',`/api/boards/${id}/lead`);assert.equal(lead.source,'default');assert.equal(lead.name,updated.name);assert.equal(lead.background,updated.background);
}
const seats=entries.map(e=>({rosterEntryId:e.id,role:e.name,name:e.name}));
await rejected([]);await rejected(seats);await rejected([seats[0],seats[0]]);await rejected([{name:'Invented',role:'Invented'}]);await rejected([{rosterEntryId:crypto.randomUUID()}]);
await ok('POST',`/api/roster/${entries[0].id}/archive`,{archived:true});await rejected([seats[0]]);
const unfinished=(await ok('GET',`/api/roster?accountId=${accountId}`)).find(r=>!r.complete);await rejected([{rosterEntryId:unfinished.entry.id}]);
console.log(JSON.stringify({passed:true,checks:['211-member paginated roster','search','ten-member cap','uncheck at cap','incomplete disabled','saved selection reload','guided helper hidden on Advisors','existing roster identities and profiles retained','idempotent creation','three-step wizard without leader form','saved profile inherited and updates propagate','legacy leader fields ignored','legacy leader step resumes at review','missing saved profile directs user to Profile','empty, duplicate, over-limit, legacy, missing, archived and incomplete rejected'],createdBoard:createdId}));
