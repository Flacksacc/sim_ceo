// Muse-authored read-only live profile acceptance. GETs + UI nav only. Never saves.
import { chromium } from 'playwright-core';
const BASE = (process.env.QA_WEB || 'http://127.0.0.1:5173').replace(/\/$/, '');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); };
const errors = [], mutations = [];
try {
  const u = new URL(BASE);
  const hostOk = ['127.0.0.1', 'localhost', '::1'].includes(u.hostname);
  if (!hostOk || u.port !== '5173' || !/^https?:$/.test(u.protocol)) throw new Error('blocked non-loopback QA_WEB');
} catch (e) { console.log(`FAIL loopback guard ${String(e?.message || e).slice(0, 120)}`); process.exit(1); }
const browser = await chromium.launch({ executablePath: EDGE, headless: true });
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route('**/api/**', (rt) => {
    const m = rt.request().method(), u = rt.request().url();
    if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return rt.continue();
    if (/negotiate/i.test(u)) return rt.continue();
    mutations.push(`${m} ${u.split('?')[0]}`);
    return rt.abort();
  });
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => errors.push(String(e?.message || e).slice(0, 160)));
  pg.on('console', (m) => {
    if (m.type() !== 'error') return;
    const txt = String(m.text());
    let loc = '';
    try { loc = (m.location() && m.location().url) || ''; } catch {}
    // Fresh profile (GET /api/profile -> 404) is legitimate: drop ONLY a
    // failed-resource 404 whose location URL is exactly the profile endpoint.
    if (/\/api\/profile(\?|$)/.test(loc) && /404|failed to load resource/i.test(txt)) return;
    errors.push(txt.slice(0, 160));
  });
  await pg.goto(BASE + '/', { timeout: 15000, waitUntil: 'domcontentloaded' });
  await pg.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  const st = await pg.request.get(BASE + '/api/auth/status', { timeout: 10000 });
  ok(st.ok(), `auth status reachable (status=${st.status()})`);
  if (st.status() === 401 || st.status() === 403) throw new Error('auth-gated refusing bypass');
  const boardsR = await pg.request.get(BASE + '/api/boards?includeArchived=true', { timeout: 10000 });
  const boardsJ = await boardsR.json().catch(() => []);
  const boards = Array.isArray(boardsJ) ? boardsJ : (boardsJ.boards || []);
  ok(boardsR.ok(), `boards GET ok (count=${boards.length})`);
  await pg.locator('nav.rail').getByRole('button', { name: 'Boards', exact: true }).click({ timeout: 8000 }).catch(() => {});
  const profRespP = pg.waitForResponse((r) => r.url().includes('/api/profile') && r.request().method() === 'GET', { timeout: 15000 }).catch(() => null);
  await pg.locator('nav.rail').getByRole('button', { name: 'Profile', exact: true }).click({ timeout: 8000 });
  const profResp = await profRespP;
  const profStatus = profResp ? profResp.status() : -1;
  ok(profStatus === 200 || profStatus === 404, `profile GET resolved 200-or-404 (status=${profStatus})`);
  const hasProfile = profStatus === 200;
  const panel = pg.locator('section[aria-label="Profile"]');
  await panel.waitFor({ state: 'visible', timeout: 8000 });
  ok(await panel.isVisible(), 'Profile section visible without selected board');
  const saveBtn = panel.getByRole('button', { name: /^(Save profile|Saving\.\.\.)$/ });
  await saveBtn.first().waitFor({ state: 'visible', timeout: 8000 });
  ok((await saveBtn.count()) >= 1, 'Save button visible');
  // Textbox accessible names carry a nested "Use default" button suffix, so
  // match each field by unique accessible-name prefix instead of exact label.
  const fields = [/^Background/, /^Subjects already familiar/, /^Subjects needing simpler explanation/, /^Communication preferences/];
  let areaOk = 0, minH = Infinity;
  for (const rx of fields) {
    const ta = panel.getByRole('textbox', { name: rx });
    const vis = await ta.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
    const tag = vis ? (await ta.evaluate((el) => el.tagName).catch(() => '')) : '';
    const h = vis ? (await ta.evaluate((el) => parseFloat(getComputedStyle(el).height) || 0).catch(() => 0)) : 0;
    if (h < minH) minH = h;
    if (vis && tag === 'TEXTAREA' && h >= 48) areaOk++;
  }
  ok(areaOk === 4, `four profile textareas roomy (ok=${areaOk}/4 minH=${Math.round(minH)}px)`);
  const commLen = await panel.getByRole('textbox', { name: /^Communication preferences/ }).inputValue().then((v) => v.length).catch(() => -1);
  if (!hasProfile) ok(commLen > 0, 'default comm prefs nonempty on fresh profile');
  else ok(commLen >= 0, 'existing profile prefs readable without overwrite');
  const lens1 = await panel.locator('textarea.profile-area').evaluateAll((els) => els.map((e) => e.value.length)).catch(() => []);
  await pg.waitForTimeout(1500);
  const lens2 = await panel.locator('textarea.profile-area').evaluateAll((els) => els.map((e) => e.value.length)).catch(() => []);
  ok(lens1.length === 4 && JSON.stringify(lens1) === JSON.stringify(lens2), 'existing field state untouched (no edits issued)');
  await pg.locator('nav.rail').getByRole('button', { name: 'Roster', exact: true }).click({ timeout: 8000 }).catch(() => {});
  await pg.locator('nav.rail').getByRole('button', { name: 'Boards', exact: true }).click({ timeout: 8000 }).catch(() => {});
  await pg.locator('nav.rail').getByRole('button', { name: 'Profile', exact: true }).click({ timeout: 8000 }).catch(() => {});
  await panel.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
  ok(await panel.isVisible(), 'Profile reachable after Boards/Roster round-trip');
  await pg.goBack({ timeout: 8000 }).catch(() => {});
  await pg.goForward({ timeout: 8000 }).catch(() => {});
  await panel.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
  ok(mutations.length === 0, `no non-GET api mutations (saw ${mutations.length})`);
  ok(errors.length === 0, `no page errors (saw ${errors.length})`);
} catch (e) { fail++; console.log(`FAIL fatal ${String(e?.message || e).slice(0, 160)}`); }
finally { await browser.close(); }
console.log(`TOTAL pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
