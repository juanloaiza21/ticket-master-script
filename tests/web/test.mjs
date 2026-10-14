import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

// Browser tests for docs/index.html. Run: cd tests/web && npm install && npm test
// Needs a Chromium: set CHROMIUM_PATH, or run `npx playwright-core install chromium` once.
const DOCS = fileURLToPath(new URL('../../docs', import.meta.url));
const PAGE_PORT = 8801, API_PORT = 8802;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm' };

// ---- mock Ticketmaster (a *different origin* from the page, so CORS is really exercised) ----
const api = { mode: 'ok', attractions: null, events: [], log: [], countryTotals: {}, coverageStatus: 200 };
const ATTR = { _embedded: { attractions: [{ id: 'ATTR1', name: 'Silvana Estrada' }, { id: 'ATTR2', name: 'Silvana Estrada Tribute' }] } };
const ev = (id, status = 'offsale', extra = {}) => ({
  id, name: `Show ${id}`, url: `https://tm.example/${id}`,
  dates: { start: { localDate: '2026-11-20', localTime: '20:00:00' }, status: { code: status } },
  _embedded: { venues: [{ name: 'Auditorio', city: { name: 'CDMX' }, country: { countryCode: 'MX' } }] },
  ...extra,
});
const resetApi = () => Object.assign(api, { mode: 'ok', attractions: ATTR, events: [], log: [], countryTotals: {}, coverageStatus: 200 });

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  api.log.push({ path: u.pathname, q: Object.fromEntries(u.searchParams) });
  if (api.mode !== 'nocors') res.setHeader('Access-Control-Allow-Origin', '*');
  if (api.mode === '401') { res.statusCode = 401; return res.end('{"fault":{"faultstring":"Invalid ApiKey"}}'); }
  res.setHeader('Content-Type', 'application/json');
  if (u.pathname.endsWith('attractions.json')) return res.end(JSON.stringify(api.attractions));
  if (u.pathname.endsWith('events.json') && !u.searchParams.has('attractionId')) {
    // country-wide coverage probe: no artist filter, only the total matters
    if (api.coverageStatus !== 200) { res.statusCode = api.coverageStatus; return res.end('{"errors":[{"detail":"nope"}]}'); }
    const n = api.countryTotals[u.searchParams.get('countryCode')] ?? 0;
    return res.end(JSON.stringify({ page: { size: 1, totalElements: n, totalPages: n } }));
  }
  if (u.pathname.endsWith('events.json')) {
    const body = api.events.length
      ? { _embedded: { events: api.events }, page: { totalPages: 1 } } : { page: { totalPages: 0 } };
    return res.end(JSON.stringify(body));
  }
  res.statusCode = 404; res.end('{}');
}).listen(API_PORT, '127.0.0.1');

http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  const file = path.join(DOCS, p === '/' ? 'index.html' : p);
  if (!file.startsWith(DOCS) || !fs.existsSync(file)) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
}).listen(PAGE_PORT, '127.0.0.1');

const URL_LOCAL = `http://127.0.0.1:${PAGE_PORT}/?base=http://127.0.0.1:${API_PORT}/discovery/v2`;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--host-resolver-rules=MAP evil.test 127.0.0.1'],
});

async function newPage(opts = {}) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  if (opts.clock) await page.clock.install();
  await page.goto(opts.url || URL_LOCAL);
  await page.waitForFunction(() => document.documentElement.dataset.ready === '1');
  return { ctx, page, errors };
}

async function fill(page, { key = 'good-key', artists = 'Silvana Estrada', country = '' } = {}) {
  await page.fill('#apikey', key);
  await page.fill('#artists', artists);
  await page.fill('#country', country);
}

const waitChecked = (page) => page.waitForFunction(() => /Last check|Finished with/.test(document.getElementById('status').textContent));
const clickCheck = async (page) => {
  await page.evaluate(() => { document.getElementById('status').textContent = ''; });
  await page.click('#check');
  await waitChecked(page);
};
const text = (page, sel) => page.locator(sel).innerText();
const eventsCalls = () => api.log.filter((r) => r.path.endsWith('events.json') && r.q.attractionId);
const coverageCalls = () => api.log.filter((r) => r.path.endsWith('events.json') && !r.q.attractionId);

let passed = 0, failed = 0;
async function test(name, fn) {
  resetApi();
  try { await fn(); passed++; console.log(`ok   - ${name}`); }
  catch (e) { failed++; console.log(`FAIL - ${name}\n       ${String(e.stack || e).split('\n').slice(0, 6).join('\n       ')}`); }
}

await test('baseline, then alerts for a new event and an on-sale change; persists across reload', async () => {
  const { page, ctx, errors } = await newPage();
  api.events = [ev('A', 'offsale')];
  await fill(page, { country: 'mx' });
  await clickCheck(page);

  const card = await text(page, '#artists-out');
  assert.match(card, /Silvana Estrada/);
  assert.match(card, /First check/);
  assert.match(card, /Show A/);
  assert.equal(await page.locator('#alerts-card').isHidden(), true, 'baseline must not alert');

  const q = eventsCalls()[0].q;
  assert.equal(q.attractionId, 'ATTR1', 'exact name must beat the tribute act');
  assert.equal(q.apikey, 'good-key');
  assert.equal(q.locale, '*');
  assert.equal(q.countryCode, 'MX', 'country must be upper-cased by the Rust code');

  api.events = [
    ev('A', 'onsale', { sales: { public: { startDateTime: '2026-10-16T16:00:00Z' } } }),
    ev('B', 'offsale'),
  ];
  await clickCheck(page);
  assert.equal(await page.locator('#alerts-card').isVisible(), true);
  const alerts = await text(page, '#alerts');
  assert.match(alerts, /NEW EVENT\s*Show B/);
  assert.match(alerts, /CHANGED\s*Show A/);
  assert.match(alerts, /status: offsale -> onsale/);
  assert.match(await page.title(), /^\(2\) ticketwatch/);

  // Reload: key/artist and what we've seen come back from localStorage, so no re-alert.
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.ready === '1');
  assert.equal(await page.inputValue('#apikey'), 'good-key');
  assert.equal(await page.inputValue('#artists'), 'Silvana Estrada');
  await clickCheck(page);
  assert.equal(await page.locator('#alerts-card').isHidden(), true, 'already-seen events must stay quiet after reload');
  assert.doesNotMatch(await text(page, '#artists-out'), /First check/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await test('bad API key shows an error and stops watching', async () => {
  const { page, ctx } = await newPage();
  api.mode = '401';
  await fill(page, { key: 'nope' });
  await page.click('#toggle');
  await waitChecked(page);
  assert.match(await text(page, '.err'), /rejected the API key/);
  assert.equal(await text(page, '#toggle'), 'Start watching');
  await ctx.close();
});

await test('a CORS-blocked response gives a readable error', async () => {
  const { page, ctx } = await newPage();
  api.mode = 'nocors';
  await fill(page);
  await clickCheck(page);
  assert.match(await text(page, '.err'), /Couldn't reach Ticketmaster from the browser/);
  await ctx.close();
});

await test('hostile event data cannot inject markup or javascript: links', async () => {
  const { page, ctx } = await newPage();
  api.events = [
    ev('X', 'onsale', {
      name: '<img src=x onerror="window.__xss=1">Evil',
      url: 'javascript:window.__xss=2',
      sales: { presales: [{ name: '<b onmouseover="window.__xss=3">p</b>', startDateTime: '2026-10-15T16:00:00Z' }] },
    }),
  ];
  await fill(page);
  await clickCheck(page);
  assert.match(await text(page, '#artists-out'), /<img src=x onerror=/, 'shown as literal text');
  assert.equal(await page.locator('#artists-out img, #artists-out b').count(), 0);
  assert.equal(await page.locator('a[href^="javascript"]').count(), 0);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  await ctx.close();
});

await test('watching re-checks on the interval and stops when told to', async () => {
  const { page, ctx } = await newPage({ clock: true });
  api.events = [ev('A', 'offsale')];
  await fill(page);
  await page.click('#toggle');
  await waitChecked(page);
  assert.equal(eventsCalls().length, 1);
  assert.equal(await text(page, '#toggle'), 'Stop watching');

  api.events = [ev('A', 'offsale'), ev('B', 'offsale')];
  await page.evaluate(() => { document.getElementById('status').textContent = ''; });
  await page.clock.fastForward('10:05'); // default interval is 10 minutes
  await waitChecked(page);
  assert.equal(eventsCalls().length, 2);
  assert.match(await text(page, '#alerts'), /NEW EVENT\s*Show B/);

  await page.click('#toggle');
  await page.clock.fastForward('30:00');
  await page.waitForTimeout(300);
  assert.equal(eventsCalls().length, 2, 'no checks after stopping');
  await ctx.close();
});

await test('artist with no Ticketmaster page yet is announced when it appears (not silently baselined)', async () => {
  const { page, ctx } = await newPage();
  api.attractions = {};
  await fill(page);
  await clickCheck(page);
  assert.match(await text(page, '#artists-out'), /No Ticketmaster artist page yet/);

  api.attractions = ATTR;
  api.events = [ev('A', 'onsale')];
  await clickCheck(page);
  assert.match(await text(page, '#alerts'), /NEW EVENT\s*Show A/);
  assert.doesNotMatch(await text(page, '#artists-out'), /First check/);
  await ctx.close();
});

await test('?base= is ignored outside localhost, so a crafted link cannot capture the key', async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const tmRequests = [];
  await page.route('https://app.ticketmaster.com/**', (route) => {
    tmRequests.push(new URL(route.request().url()));
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
      body: route.request().url().includes('attractions') ? JSON.stringify(ATTR) : '{"page":{"totalPages":0}}' });
  });
  await page.goto(`http://evil.test:${PAGE_PORT}/?base=http://127.0.0.1:${API_PORT}/discovery/v2`);
  await page.waitForFunction(() => document.documentElement.dataset.ready === '1');
  await fill(page, { key: 'secret-key' });
  await clickCheck(page);
  assert.equal(api.log.length, 0, 'the attacker-chosen base must never be contacted');
  assert.ok(tmRequests.length >= 2, 'requests go to the real Ticketmaster host');
  assert.equal(tmRequests[0].searchParams.get('apikey'), 'secret-key');
  await ctx.close();
});

await test('invalid country is rejected by the Rust validator before any request', async () => {
  const { page, ctx } = await newPage();
  await fill(page, { country: 'mexico' });
  await page.evaluate(() => { document.getElementById('country').maxLength = 20; });
  await page.fill('#country', 'mexico');
  await page.click('#check');
  await page.waitForFunction(() => /2-letter/.test(document.getElementById('status').textContent));
  assert.equal(api.log.length, 0);
  await ctx.close();
});

await test('country with no Ticketmaster data is called out, and probed only once', async () => {
  const { page, ctx } = await newPage();
  api.countryTotals = { CO: 0 };
  await fill(page, { country: 'co' });
  await clickCheck(page);
  const err = await text(page, '.err');
  assert.match(err, /lists no events at all in CO/);
  assert.match(err, /probably doesn't cover that country/);
  await clickCheck(page);
  assert.equal(coverageCalls().length, 1, 'coverage is cached per country');
  assert.equal(coverageCalls()[0].q.countryCode, 'CO');
  await ctx.close();
});

await test('covered country with no events for the artist says so (and alerts will come)', async () => {
  const { page, ctx } = await newPage();
  api.countryTotals = { CO: 1234 };
  await fill(page, { country: 'CO' });
  await clickCheck(page);
  const note = await text(page, '#artists-out');
  assert.match(note, /Ticketmaster does cover CO \(1,234 upcoming events overall\)/);
  assert.match(note, /nothing listed there yet/);
  assert.equal(await page.locator('.err').count(), 0);

  // The first event appearing must still alert, not vanish into a baseline.
  api.events = [ev('A', 'onsale')];
  await clickCheck(page);
  assert.match(await text(page, '#alerts'), /NEW EVENT\s*Show A/);
  await ctx.close();
});

await test('no coverage request when the artist has events or no country is set', async () => {
  const { page, ctx } = await newPage();
  api.events = [ev('A', 'onsale')];
  await fill(page, { country: 'MX' });
  await clickCheck(page);
  assert.equal(coverageCalls().length, 0);

  api.events = [];
  await fill(page, { country: '' });
  await clickCheck(page);
  assert.equal(coverageCalls().length, 0);
  await ctx.close();
});

await test('a failed coverage check says so, the table still renders, and it is retried next time', async () => {
  const { page, ctx } = await newPage();
  api.coverageStatus = 400;
  await fill(page, { country: 'CO' });
  await clickCheck(page);
  const card = await text(page, '#artists-out');
  assert.match(card, /Couldn't check whether Ticketmaster covers CO: .*HTTP 400/);
  assert.match(card, /No events listed right now/);
  assert.equal(await page.locator('.err').count(), 0, 'a failed probe is not evidence of no coverage');

  api.coverageStatus = 200;
  api.countryTotals = { CO: 5 };
  await clickCheck(page);
  assert.match(await text(page, '#artists-out'), /does cover CO \(5 upcoming events overall\)/);
  assert.equal(coverageCalls().length, 2, 'the failure was not cached');
  await ctx.close();
});

await test('the page shows when it was last updated', async () => {
  const { page, ctx } = await newPage();
  assert.match(await text(page, '#version'), /Page last updated: .+hard-refresh/);
  await ctx.close();
});

await test('the Colombia card links to a real, installable userscript', async () => {
  const { page, ctx } = await newPage();
  const href = await page.getAttribute('#install-userscript', 'href');
  assert.match(href, /\.user\.js$/, 'Tampermonkey only offers to install URLs ending in .user.js');
  const src = await page.evaluate(async (h) => (await fetch(new URL(h, location.href))).text(), href);
  assert.match(src, /^\/\/ ==UserScript==/, 'metadata block must be first');
  assert.match(src, /@match\s+https:\/\/www\.ticketmaster\.co\/event\/\*/);
  assert.match(src, /@match\s+https:\/\/latiquetera\.com\/\*/);
  assert.equal(await page.locator('#colombia a[target="_blank"]:not([rel*="noopener"])').count(), 0, 'external links use noopener');
  await ctx.close();
});

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
