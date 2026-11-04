import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
const base='http://127.0.0.1:15396';
async function ok(method,path,body){const r=await fetch(base+path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});assert.ok(r.ok,`${path}: ${r.status}`);return r.status===204?null:r.json();}
assert.equal((await ok('GET','/health')).instance,'qa-author-15396');assert.equal((await ok('GET','/ready')).store,'inmemory');
const board=await ok('POST','/api/boards',{name:'Meeting rename QA',mission:'Edit only meeting names'});
const meeting=await ok('POST',`/api/boards/${board.id}/meetings`,{title:'Original meeting',brief:'Keep this brief.',participantIds:[]});
const other=await ok('POST',`/api/boards/${board.id}/meetings`,{title:'Second meeting',brief:'Keep the other brief.',participantIds:[]});
await ok('POST',`/api/meetings/${meeting.id}/messages`,{sender:'lead',content:'Keep the conversation history.'});
const original=await ok('GET',`/api/boards/${board.id}/meetings/${meeting.id}`),messages=await ok('GET',`/api/meetings/${meeting.id}/messages?take=60`);
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});const errors=[];
try{
 const ctx=await browser.newContext({viewport:{width:1440,height:1000}});await ctx.grantPermissions(['local-network-access'],{origin:base});const page=await ctx.newPage();page.on('pageerror',e=>errors.push(String(e)));
 await page.goto(`${base}/#/meet?board=${board.id}&meeting=${meeting.id}`);await page.getByRole('heading',{name:'Original meeting',exact:true}).waitFor();
 const header=page.locator('.conv-head');assert.equal(await header.getByRole('button',{name:'New meeting',exact:true}).count(),0);
 assert.ok(await page.getByRole('button',{name:'+ New meeting',exact:true}).count()>0,'Sidebar creation remains available');
 await header.getByRole('button',{name:'Rename meeting',exact:true}).click();const input=page.getByRole('textbox',{name:'Meeting name',exact:true});
 await input.fill('   ');assert.equal(await page.getByRole('button',{name:'Save name',exact:true}).isDisabled(),true);
 await input.fill('Unsaved title');await page.getByRole('button',{name:'Cancel',exact:true}).click();await page.getByRole('heading',{name:'Original meeting',exact:true}).waitFor();
 await header.getByRole('button',{name:'Rename meeting',exact:true}).click();await input.fill('Renamed meeting');
 const saved=page.waitForResponse(r=>r.request().method()==='PATCH'&&new URL(r.url()).pathname===`/api/meetings/${meeting.id}`);await input.press('Enter');const response=await saved;assert.equal(response.status(),200);assert.deepEqual(response.request().postDataJSON(),{title:'Renamed meeting'});
 await page.getByRole('heading',{name:'Renamed meeting',exact:true}).waitFor();await page.reload();await page.getByRole('heading',{name:'Renamed meeting',exact:true}).waitFor();
 assert.ok(await page.locator('.lprow').filter({hasText:'Renamed meeting'}).count()>0);
 await page.getByRole('button',{name:'Meeting settings',exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'Meeting title',exact:true}).inputValue(),'Renamed meeting');await page.getByRole('button',{name:'Done',exact:true}).click();
 await header.getByRole('button',{name:'Rename meeting',exact:true}).click();await input.fill('Retry title');await page.route(`**/api/meetings/${meeting.id}`,route=>route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:'Simulated rename failure'})}),{times:1});
 await page.getByRole('button',{name:'Save name',exact:true}).click();await page.getByRole('alert').filter({hasText:'Could not save the meeting name'}).waitFor();assert.equal(await input.inputValue(),'Retry title');await input.press('Escape');
 const actual=await ok('GET',`/api/boards/${board.id}/meetings/${meeting.id}`);assert.equal(actual.title,'Renamed meeting');for(const field of ['brief','state','generation','participantIdsJson'])assert.equal(actual[field],original[field]);assert.deepEqual(await ok('GET',`/api/meetings/${meeting.id}/messages?take=60`),messages);
 await page.screenshot({path:'.tmp/meeting-name-desktop.png',fullPage:false,animations:'disabled'});await page.setViewportSize({width:390,height:844});await header.getByRole('button',{name:'Rename meeting',exact:true}).click();await input.fill('A longer meeting name that wraps comfortably on a narrow screen');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:'.tmp/meeting-name-mobile.png',fullPage:false,animations:'disabled'});await input.press('Escape');await page.setViewportSize({width:1440,height:1000});
 let release;const pending=new Promise(resolve=>release=resolve);let started;const seen=new Promise(resolve=>started=resolve);
 await page.route(`**/api/meetings/${meeting.id}`,async route=>{if(route.request().method()!=='PATCH')return route.continue();started();await pending;await route.fulfill({response:await route.fetch()});},{times:1});
 await header.getByRole('button',{name:'Rename meeting',exact:true}).click();await input.fill('First meeting updated later');await page.getByRole('button',{name:'Save name',exact:true}).click();await seen;
 await page.locator('.lprow').filter({hasText:'Second meeting'}).click();await page.getByRole('heading',{name:'Second meeting',exact:true}).waitFor();release();
 await page.waitForResponse(r=>r.request().method()==='PATCH'&&new URL(r.url()).pathname===`/api/meetings/${meeting.id}`);assert.equal((await ok('GET',`/api/boards/${board.id}/meetings/${other.id}`)).title,'Second meeting');assert.equal(await page.getByRole('heading',{name:'Second meeting',exact:true}).count(),1);
 await ctx.close();
}finally{await browser.close();}
assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,checks:['inline rename','Enter saves and Escape cancels','blank title disabled','name persists after reload and updates sidebar/settings','title-only PATCH preserves brief, participants, state and history','failed saves retain edits','no New meeting in header; sidebar creation retained','late save cannot rename newly selected meeting','mobile fits'],errors}));
