// Mutations are permitted only against the owned in-memory/fake QA stack.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const base = 'http://127.0.0.1:15396';
async function call(method, path, body, headers = {}) {
  const response = await fetch(base + path, { method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: response.status, data };
}
const health = await call('GET', '/health');
assert.equal(health.data.instance, 'qa-author-15396');
assert.equal((await call('GET', '/ready')).data.store, 'inmemory');
assert.equal((await call('GET', '/api/auth/status')).data.hasAccounts, false, 'Requires a fresh QA stack');
assert.equal((await fetch('http://127.0.0.1:15398/__log')).status, 200);

const visitor = { 'X-User': 'settings-visitor' };
assert.equal((await call('GET', '/api/model/status', undefined, visitor)).status, 200);
assert.equal((await call('PUT', '/api/model/settings', { chatModel: 'muse-wonder-1.0' }, visitor)).status, 200);
assert.equal((await call('GET', '/api/model/status')).data.model, 'muse-wonder-1.0');
assert.equal((await call('PUT', '/api/model/settings', { chatModel: 'invalid' }, visitor)).status, 400);
assert.equal((await call('PUT', '/api/model/settings', { apiKey: 42, chatModel: 'muse-spark-1.3' }, visitor)).status, 400);
assert.equal((await call('GET', '/api/model/status')).data.model, 'muse-wonder-1.0', 'Invalid settings do not partially change the model');
const tested = await call('POST', '/api/model/test', {}, visitor);
assert.equal(tested.status, 200); assert.equal(tested.data.ok, true);
assert.equal((await call('GET', '/api/model/status')).data.lastTestOk, true);
assert.equal((await call('GET', '/api/model/status', undefined, { authorization: 'Bearer invalid-test-token' })).status, 401);
assert.equal((await call('PUT', '/api/model/settings', { apiKey: 'qa-shared-settings-key-1234' }, visitor)).status, 200);
console.log('PASS demo visitors read/save/test settings, validation stays atomic, invalid tokens rejected');

const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const pageErrors = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx.grantPermissions(['local-network-access'], { origin: base });
  const page = await ctx.newPage();
  page.on('pageerror', error => pageErrors.push(String(error)));
  await page.goto(base + '/#/settings');
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  await settings.getByRole('heading', { name: 'Model connection', exact: true }).waitFor();
  assert.ok(!/installation admin|select a board|restricted/i.test(await settings.innerText()));
  assert.equal(await page.locator('.rail-items').getByRole('button', { name: /^(Profile|People|Activity)$/ }).count(), 0);
  const footerProfile = page.locator('.railfoot').getByRole('button', { name: 'Open profile', exact: true });
  assert.equal(await footerProfile.count(), 1);
  await settings.getByLabel('Chat model').selectOption('muse-spark-1.3');
  const saved = page.waitForResponse(r => r.url().endsWith('/api/model/settings') && r.request().method() === 'PUT');
  await settings.getByRole('button', { name: 'Save model settings', exact: true }).click();
  assert.equal((await saved).status(), 200);
  assert.equal((await call('GET', '/api/model/status')).data.keyHint, '...1234', 'Blank key field preserves the saved connection key');
  const connection = page.waitForResponse(r => r.url().endsWith('/api/model/test') && r.request().method() === 'POST');
  await settings.getByRole('button', { name: 'Test connection', exact: true }).click();
  assert.equal((await connection).status(), 200);
  await footerProfile.click();
  await page.getByRole('heading', { name: 'Profile', exact: true }).waitFor();
  assert.equal(await footerProfile.getAttribute('aria-current'), 'page');
  assert.equal(await page.getByRole('button', { name: /^(sign in|sign out|register)$/i }).count(), 0);
  await ctx.close();
  assert.deepEqual(pageErrors, []);
} finally { await browser.close(); }
console.log('PASS browser Settings works without a board; Save/Test use real fake-backed API; only bottom Profile remains');

const password = 'isolated-settings-qa-only-password';
const admin = await call('POST', '/api/auth/register', { email: 'settings-admin@example.test', password });
assert.equal(admin.status, 201);
const member = await call('POST', '/api/auth/register', { email: 'settings-member@example.test', password });
assert.equal(member.status, 201);
const memberHeaders = { authorization: 'Bearer ' + member.data.token };
const caps = await call('GET', '/api/model/status', undefined, memberHeaders);
assert.equal(caps.status, 200, 'A non-admin with no board can view settings');
assert.equal((await call('PUT', '/api/model/settings', { chatModel: 'muse-wonder-1.0' }, memberHeaders)).status, 200);
const memberTest = await call('POST', '/api/model/test', {}, memberHeaders);
assert.equal(memberTest.status, 200); assert.equal(memberTest.data.ok, true);
assert.equal((await call('GET', '/api/model/status', undefined, memberHeaders)).data.model, 'muse-wonder-1.0');
for (const [method, path, body] of [['GET','/api/model/status'], ['PUT','/api/model/settings',{}], ['POST','/api/model/test',{}]]) {
  assert.equal((await call(method, path, body)).status, 401, 'Secure mode still validates sessions');
}
assert.equal((await call('POST', '/api/auth/logout', {}, memberHeaders)).status, 200);
for (const [method, path, body] of [['GET','/api/model/status'], ['PUT','/api/model/settings',{}], ['POST','/api/model/test',{}]]) {
  assert.equal((await call(method, path, body, memberHeaders)).status, 401, 'Revoked sessions remain rejected');
}
const final = await call('GET', '/api/model/status', undefined, { authorization: 'Bearer ' + admin.data.token });
assert.equal(final.status, 200);
assert.equal(Object.hasOwn(final.data, 'apiKey'), false);
assert.ok(!JSON.stringify(final.data).includes('qa-only-15396-never-real'));
assert.ok(!JSON.stringify(final.data).includes('qa-shared-settings-key-1234'));
console.log('PASS secure non-admin read/save/test, anonymous/revoked-session rejection and credential masking');
