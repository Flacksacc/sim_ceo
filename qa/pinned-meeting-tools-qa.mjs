// Owned in-memory QA only. Run after meeting-attachments-qa.mjs.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
const base='http://127.0.0.1:15396';
async function api(method,path,body){const response=await fetch(base+path,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});assert.ok(response.ok,`${path}: ${response.status}`);return response.json();}
assert.equal((await api('GET','/health')).instance,'qa-author-15396');
const board=(await api('GET','/api/boards')).find(b=>b.name==='Attachment QA');assert.ok(board);
const meeting=(await api('GET',`/api/boards/${board.id}/meetings`)).find(m=>m.title==='Attachment context');assert.ok(meeting);
for(let i=0;i<9;i++){
 const entry=await api('POST','/api/roster',{name:`Rail Advisor ${i+1}`,description:'A focused fictional expert with experience explaining practical tradeoffs.',profileJson:JSON.stringify({background:'An experienced fictional business advisor.',contributionCriteria:'Respond when the user needs practical guidance.',reasoningApproach:'Explain options and evidence.',responseStyle:'Clear and conversational.'})});
 const form=new FormData();form.set('file',new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6kWQAAAAASUVORK5CYII=','base64')],{type:'image/png'}),'portrait.png');assert.equal((await fetch(base+`/api/roster/${entry.id}/image/upload`,{method:'POST',body:form})).status,201);
 await api('POST',`/api/roster/${entry.id}/copy`,{boardId:board.id,boardRole:i===0?'Finance Slow':entry.name});
}
for(let i=0;i<40;i++)await api('POST',`/api/meetings/${meeting.id}/messages`,{sender:'lead',content:`Long meeting message ${i+1}. `+'Discuss customer needs, budget, and practical priorities. '.repeat(12)});
const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
try{
 for(const theme of ['light','dark']){
  const ctx=await browser.newContext({viewport:{width:1440,height:900}});await ctx.grantPermissions(['local-network-access'],{origin:base});await ctx.addInitScript(theme=>localStorage.setItem('simceo-theme',theme),theme);const page=await ctx.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));
  await page.goto(`${base}/#/meet?board=${board.id}&meeting=${meeting.id}`);
  const tools=page.getByRole('complementary',{name:'Meeting tools'});await tools.waitFor();await page.waitForFunction(()=>document.querySelectorAll('.meeting-tools .mp-seat').length===12);
  assert.equal(await page.locator('.composer-bar .meet-participants,.composer-bar .meeting-attachments').count(),0);
  assert.equal(await tools.getByRole('region',{name:'Meeting attachments'}).count(),1);
  const mic=page.getByRole('button',{name:'Dictate with microphone',exact:true}),settings=page.getByRole('button',{name:'Meeting settings',exact:true});
  assert.equal(await settings.evaluate(el=>el.closest('.composer')?.querySelector('.composer-meeting-controls')?.contains(el)),true);
  assert.equal(await settings.evaluate(el=>el.closest('.composer-meeting-controls')?.previousElementSibling?.getAttribute('aria-label')),'Dictate with microphone');
  for(const role of ['orchestrator','secretary']){const img=tools.locator(`img[src="/portraits/${role}-v2.webp"]`);await img.evaluate(i=>i.decode());assert.ok(await img.evaluate(i=>i.naturalWidth>0));}
  await page.evaluate(()=>window.scrollTo(0,Math.min(5000,document.documentElement.scrollHeight/2)));await page.waitForTimeout(100);
  const pinned=await tools.boundingBox();assert.ok(pinned.x>900&&pinned.y>=0&&pinned.y<25);assert.ok(pinned.y+pinned.height<=900,'Panel fits viewport');
  await tools.locator('.meeting-rail-team').evaluate(el=>el.scrollTop=el.scrollHeight);const drop=tools.locator('.attachment-drop');const bounds=await drop.boundingBox();assert.ok(bounds.y>=0&&bounds.y+bounds.height<900,'Drop target stays visible while team scrolls');
  await drop.evaluate(el=>{const dt=new DataTransfer();dt.items.add(new File(['Pinned drop test evidence.'],'pinned-drop.txt',{type:'text/plain'}));el.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:dt}));});await tools.getByText('pinned-drop.txt Ready in meeting context').waitFor();
  if(theme==='light'){const question='QA-PARALLEL-DIALOGUE: explain the practical hiring priorities.';await api('POST',`/api/meetings/${meeting.id}/messages`,{sender:'lead',content:question});const run=api('POST',`/api/meetings/${meeting.id}/run`,{prompt:question});await page.locator('.meeting-tools .mp-seat.act-responding .mp-pulse').first().waitFor();await run;}
  await page.screenshot({path:`../pinned-tools-${theme}.png`});
  await mic.scrollIntoViewIfNeeded();await settings.click();const menu=page.getByRole('menu',{name:'Meeting commands'});await menu.waitFor();const mb=await menu.boundingBox();assert.ok(mb.y>=0&&mb.y+mb.height<=900);await page.keyboard.press('Escape');assert.equal(await settings.evaluate(el=>el===document.activeElement),true);
  for(const width of [1024,390]){await page.setViewportSize({width,height:844});await page.evaluate(()=>window.scrollTo(0,Math.min(4000,document.documentElement.scrollHeight/2)));await page.waitForTimeout(80);const rect=await tools.boundingBox();assert.ok(width<821 ? rect.y>=60&&rect.y<70 : rect.y>=0&&rect.y<10);assert.ok(rect.height<=280);assert.equal(await tools.locator('.context-bar').isVisible(),false);const dropRect=await drop.boundingBox();assert.ok(dropRect.y>=rect.y&&dropRect.y+dropRect.height<=rect.y+rect.height);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
  await tools.locator('.meeting-rail-team').evaluate(el=>el.scrollTop=0);await page.screenshot({path:`../pinned-tools-${theme}-mobile.png`});assert.deepEqual(errors,[]);await ctx.close();
 }
}finally{await browser.close();}
console.log('PASS 10 advisors plus system agents, sticky right rail through long-message scrolling, independently scrollable team, pinned drop uploads, settings beside microphone, menu focus/viewport, light/dark, tablet/mobile');
