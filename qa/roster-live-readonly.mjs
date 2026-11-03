// Muse-authored read-only live roster acceptance. GETs + UI nav only.
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';
const BASE = (process.env.QA_WEB || 'http://127.0.0.1:5173').replace(/\/$/, '');
const OUT = '.tmp/qa-roster-live';
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); };
const errors = [], mutations = [];
const get = async (req, p) => {
  const r = await req.get(BASE + p, { timeout: 10000 });
  if (!r.ok()) throw new Error(`GET ${p} status ${r.status()}`);
  return r.json();
};
const browser = await chromium.launch({ executablePath: EDGE, headless: true });
try {
  mkdirSync(OUT, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route('**/api/**', (rt) => {
    const m = rt.request().method();
    const u = rt.request().url();
    if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return rt.continue();
    if (/negotiate/i.test(u)) return rt.continue();
    mutations.push(`${m} ${u.split('?')[0]}`);
    return rt.abort();
  });
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => errors.push(String(e?.message || e).slice(0, 160)));
  pg.on('console', (m) => { if (m.type() === 'error') errors.push(String(m.text()).slice(0, 160)); });
  await pg.goto(BASE + '/', { timeout: 15000, waitUntil: 'domcontentloaded' });
  await pg.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  let accountId = await pg.evaluate(() => { try { return localStorage.getItem('simceo-account'); } catch { return null; } });
  if (!/^[0-9a-fA-F-]{36}$/.test(String(accountId || ''))) accountId = randomUUID();
  const boardsRaw = await get(pg.request, '/api/boards');
  const rosterRaw = await get(pg.request, `/api/roster?accountId=${encodeURIComponent(accountId)}`);
  const countRaw = await get(pg.request, `/api/roster/count?accountId=${encodeURIComponent(accountId)}`);
  const boards = Array.isArray(boardsRaw) ? boardsRaw : (boardsRaw.boards || []);
  const rows = Array.isArray(rosterRaw) ? rosterRaw : (rosterRaw.rows || rosterRaw.items || []);
  ok(boards.length >= 1, `boards accessible >= 1 (saw ${boards.length})`);
  ok(rows.length >= 1, `roster rows accessible >= 1 (saw ${rows.length})`);
  ok(Number(countRaw.total) === rows.length, `roster count total matches rows (total=${countRaw.total} rows=${rows.length})`);
  const entryIds = rows.map((r) => String(r?.entry?.id || ''));
  ok(entryIds.every(Boolean), 'every roster row has entry.id');
  ok(new Set(entryIds).size === entryIds.length, 'no duplicate entry.id values');
  const entrySet = new Set(entryIds);
  const activeBoards = boards.filter((b) => !b.archived && !b.isArchived);
  const attached = [];
  for (const b of activeBoards) {
    const bid = b.id || b.boardId;
    if (!bid) continue;
    const advRaw = await get(pg.request, `/api/boards/${encodeURIComponent(bid)}/advisors`);
    const advs = Array.isArray(advRaw) ? advRaw : (advRaw.advisors || advRaw.items || []);
    for (const a of advs) {
      if (a.removed === true || a.status === 'removed') continue;
      if (a.rosterEntryId) attached.push(String(a.rosterEntryId));
    }
  }
  ok(attached.length >= 1, `active board attachments >= 1 (saw ${attached.length})`);
  const missing = attached.filter((id) => !entrySet.has(id));
  ok(missing.length === 0, `all attached rosterEntryIds visible in roster (missing=${missing.length})`);
  // UI: nav rail Roster button; list rows live in .listpanel-rows OUTSIDE the detail section.
  await pg.locator('nav.rail').getByRole('button', { name: 'Roster', exact: true }).click({ timeout: 8000 });
  const panel = pg.locator('section[aria-label="My Advisor Roster"]');
  await panel.waitFor({ timeout: 8000 });
  ok(await panel.isVisible(), 'My Advisor Roster section visible');
  const listRows = pg.locator('.listpanel-rows button');
  await listRows.first().waitFor({ timeout: 8000 });
  const entryRows = pg.locator('.listpanel-rows button[role="listitem"]');
  const uiCount = await entryRows.count();
  ok(uiCount === rows.length, `UI roster entry count matches API (${uiCount} vs ${rows.length})`);
  // Row names render in the list panel (not the detail section); presence only, never logged.
  const listPanel = pg.locator('.listpanel-rows');
  let vis = 0;
  for (const r of rows) {
    const nm = r?.entry?.name;
    if (!nm) continue;
    if (await listPanel.getByText(String(nm), { exact: false }).first().isVisible().catch(() => false)) vis++;
  }
  const named = rows.filter((r) => r?.entry?.name).length;
  ok(named >= 1 && vis === named, `all row names visible in list panel (${vis}/${named})`);
  // Select the first existing row; the section h2 must become that advisor entry.name.
  const selName = (await entryRows.first().locator('.lprow-name').innerText({ timeout: 8000 })).trim();
  ok(selName.length > 0, 'first roster row has a name');
  await entryRows.first().click({ timeout: 8000 });
  const detailH2 = panel.locator('h2').first();
  await detailH2.waitFor({ timeout: 8000 });
  const h2Text = (await detailH2.innerText({ timeout: 8000 })).trim();
  ok(h2Text === selName, 'selected roster detail h2 shows the selected advisor name');
  ok(await panel.locator('.roster-detail [data-roster-entry-id]').isVisible().catch(() => false), 'selected advisor detail card renders');
  const ov = await pg.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(ov <= 1, `no desktop horizontal overflow (${ov}px)`);
  await pg.screenshot({ path: `${OUT}/desktop-1440.png` });
  await pg.setViewportSize({ width: 390, height: 844 });
  await panel.waitFor({ timeout: 8000 }).catch(() => {});
  const ovm = await pg.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(ovm <= 1, `no mobile390 horizontal overflow (${ovm}px)`);
  await pg.screenshot({ path: `${OUT}/mobile-390.png` });
  ok(mutations.length === 0, `no non-GET api mutations (saw ${mutations.length})`);
  ok(errors.length === 0, `no page errors (saw ${errors.length})`);
} catch (e) { fail++; console.log(`FAIL fatal ${String(e?.message || e).slice(0, 160)}`); }
finally { await browser.close(); }
console.log(`TOTAL pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
