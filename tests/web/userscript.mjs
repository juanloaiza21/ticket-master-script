// Browser tests for docs/ticketwatch-page.user.js, run against a stand-in event page.
// Run: cd tests/web && npm install && CHROMIUM_PATH=/path/to/chrome node userscript.mjs
import http from 'node:http';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const SCRIPT = fs.readFileSync(fileURLToPath(new URL('../../docs/ticketwatch-page.user.js', import.meta.url)), 'utf8');
const PORT = 8811;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const EVENT_URL = `${ORIGIN}/event/silvana-estrada`;
const STATE_KEY = `tw:v1:${ORIGIN}/event/silvana-estrada`;

// ---- stand-in for the ticketing site ----------------------------------------------------------
const FILLER = '<p>Silvana Estrada presenta Vendrán Suaves Lluvias en Colombia. Consulta fechas, zonas y precios de las boletas para el concierto en Vive Claro Music Hall, Bogotá.</p>';
const doc = (main, head = '') =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Silvana Estrada | Ticketmaster</title>${head}</head><body><nav>Inicio Conciertos</nav><main>${main}</main></body></html>`;
const SOLD = () => doc(`<h1>Silvana Estrada</h1>${FILLER}<p>20 de noviembre de 2026</p><div>Agotado</div>`);
const AVAILABLE = () => doc(`<h1>Silvana Estrada</h1>${FILLER}<p>20 de noviembre de 2026</p><button>Comprar boletas</button><p>Zona Platea COP $311.000</p>`);
const ld = (availability) => `<script type="application/ld+json">${JSON.stringify({
  '@context': 'https://schema.org', '@type': 'MusicEvent', name: 'Silvana Estrada', startDate: '2026-11-20',
  location: { name: 'Vive Claro' },
  offers: { '@type': 'Offer', availability: `https://schema.org/${availability}`, price: 311000, priceCurrency: 'COP' },
})}</script>`;

const site = { html: SOLD, ntfy: [] };
http.createServer((req, res) => {
  const p = new URL(req.url, ORIGIN).pathname;
  if (req.method === 'POST' && p.startsWith('/ntfy/')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { site.ntfy.push({ topic: decodeURIComponent(p.slice(6)), body, click: req.headers.click }); res.end('ok'); });
    return;
  }
  if (p === '/event/silvana-estrada') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(site.html()); }
  res.statusCode = 404; res.end();
}).listen(PORT, '127.0.0.1');

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

// Stands in for Tampermonkey: settings first, then the userscript itself, before any page script runs.
const initScript = (cfg = '{}', pre = '') => `
  window.__TW_TEST = 1;
  window.__reloads = 0;
  window.__notes = [];
  window.__TW_CONFIG = Object.assign({ settleMs: 50, maxSettleMs: 3000, ntfyBase: '${ORIGIN}/ntfy',
    reload: () => { window.__reloads++; } }, ${cfg});
  window.Notification = class { static get permission() { return 'granted'; }
    static requestPermission() { return Promise.resolve('granted'); }
    constructor(t, o) { window.__notes.push({ title: t, body: o && o.body }); } };
  ${pre}`;

async function open({ cfg, pre, clock } = {}) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  if (clock) await page.clock.install();
  await page.addInitScript({ content: initScript(cfg, pre) });
  await page.addInitScript({ content: SCRIPT });
  await page.goto(EVENT_URL);
  await page.waitForFunction(() => document.documentElement.dataset.twReady === '1');
  return { ctx, page, errors };
}

const checks = (page) => page.evaluate(() => Number(document.documentElement.dataset.twChecked) || 0);
const waitChecks = (page, n) => page.waitForFunction((k) => Number(document.documentElement.dataset.twChecked) >= k, n);
const notes = (page) => page.evaluate(() => window.__notes);
const status = (page) => page.locator('.card .muted').innerText();
async function startWatching(page) {
  await page.click('.pill');
  await page.click('button.go');
  await waitChecks(page, 1);
}
async function reload(page) {
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.twReady === '1');
  await waitChecks(page, 1);
}

let passed = 0, failed = 0;
async function test(name, fn) {
  site.html = SOLD; site.ntfy = [];
  try { await fn(); passed++; console.log(`ok   - ${name}`); }
  catch (e) { failed++; console.log(`FAIL - ${name}\n       ${String(e.stack || e).split('\n').slice(0, 6).join('\n       ')}`); }
}

await test('does nothing until you press Watch', async () => {
  const { page, ctx, errors } = await open();
  assert.equal(await checks(page), 0);
  assert.equal(await page.evaluate((k) => localStorage.getItem(k), STATE_KEY), null);
  assert.match(await page.locator('.card').innerText(), /Page says: SOLD OUT/, 'diagnostic guess is shown');
  assert.deepEqual(errors, []);
  await ctx.close();
});

await test('baseline, then alerts when tickets become available', async () => {
  const { page, ctx, errors } = await open();
  await startWatching(page);
  assert.match(await status(page), /Baseline saved/);
  assert.deepEqual(await notes(page), []);

  site.html = AVAILABLE;
  await reload(page);
  const [n] = await notes(page);
  assert.ok(n, 'a notification fired');
  assert.match(n.title, /NO LONGER SOLD OUT/);
  assert.match(n.title, /TICKETS AVAILABLE\?/);
  assert.match(n.title, /PRICES/);
  assert.match(n.body, /\+ Comprar boletas/);
  assert.match(n.body, /- Agotado/);
  assert.match(await page.title(), /^\(!\) /);

  await reload(page); // unchanged now: must stay quiet
  assert.deepEqual(await notes(page), []);
  assert.match(await status(page), /No changes/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await test('a page that becomes sold out is reported as such', async () => {
  site.html = AVAILABLE;
  const { page, ctx } = await open();
  await startWatching(page);
  site.html = SOLD;
  await reload(page);
  assert.match((await notes(page))[0].title, /SOLD OUT/);
  await ctx.close();
});

await test('countdowns and cookie banners are ignored', async () => {
  site.html = () => doc(`<h1>Silvana Estrada</h1>${FILLER}<div>Agotado</div><div>${String(Math.random()).slice(2, 4)}:${String(Math.random()).slice(2, 4)}:07</div><div>Usamos cookies ${Math.random()}</div>`);
  const { page, ctx } = await open();
  await startWatching(page);
  await reload(page);
  await reload(page);
  assert.deepEqual(await notes(page), []);
  assert.match(await status(page), /No changes/);
  await ctx.close();
});

await test('queue / verification pages are skipped and do not overwrite the baseline', async () => {
  const { page, ctx } = await open();
  await startWatching(page);

  site.html = () => doc('<h1>Sala de espera</h1><p>Estás en la fila. Te llevaremos al evento en cuanto sea tu turno, por favor no cierres ni recargues esta ventana para conservar tu lugar.</p>');
  await reload(page);
  assert.match(await status(page), /Skipped this check: it looks like a queue or verification page/);
  assert.deepEqual(await notes(page), []);

  site.html = AVAILABLE; // the real change must still be caught against the *original* baseline
  await reload(page);
  assert.match((await notes(page))[0].title, /TICKETS AVAILABLE\?/);
  await ctx.close();
});

await test('a nearly empty page (blocked or still loading) is skipped', async () => {
  const { page, ctx } = await open();
  await startWatching(page);
  site.html = () => doc('<p>Loading</p>');
  await reload(page);
  assert.match(await status(page), /Skipped this check: the page is nearly empty/);
  assert.deepEqual(await notes(page), []);
  await ctx.close();
});

await test('schema.org availability is used when the page provides it', async () => {
  site.html = () => doc(`<h1>Silvana Estrada</h1>${FILLER}`, ld('SoldOut'));
  const { page, ctx } = await open();
  await startWatching(page);
  site.html = () => doc(`<h1>Silvana Estrada</h1>${FILLER}`, ld('InStock'));
  await reload(page);
  const [n] = await notes(page);
  assert.match(n.title, /NO LONGER SOLD OUT/);
  assert.match(n.title, /TICKETS AVAILABLE\?/);
  assert.match(n.body, /\[data\] offer: InStock/);
  await ctx.close();
});

await test('waits for a late-rendering single-page app before taking the baseline', async () => {
  site.html = () => doc('<div id="app"></div><script>setTimeout(() => { document.getElementById("app").innerHTML = "<h1>Silvana Estrada</h1><p>Vive Claro Music Hall, Bogotá. Zonas y precios disponibles pronto para el concierto del 20 de noviembre. Consulta fechas, zonas y precios de las boletas en esta misma página.</p><div>Agotado</div>"; }, 400);</script>');
  const { page, ctx } = await open({ cfg: '{ settleMs: 700 }' });
  await startWatching(page);
  const snap = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).snapshot, STATE_KEY);
  assert.ok(snap.some((l) => /Vive Claro/.test(l)), `late content captured, got: ${JSON.stringify(snap)}`);
  await ctx.close();
});

await test('reloads on the chosen interval and stops when told to', async () => {
  const { page, ctx } = await open({ cfg: '{ settleMs: 0 }', clock: true });
  await page.click('.pill');
  await page.selectOption('select', '60');
  await page.click('button.go');
  await waitChecks(page, 1);
  assert.equal(await page.evaluate(() => window.__reloads), 0);

  await page.clock.fastForward('00:40'); // before the 54s minimum of the jittered interval
  assert.equal(await page.evaluate(() => window.__reloads), 0, 'not too early');
  await page.clock.fastForward('00:40');
  assert.equal(await page.evaluate(() => window.__reloads), 1, 'reloaded after ~1 minute');

  await page.click('button.go'); // Stop watching
  await page.clock.fastForward('10:00');
  assert.equal(await page.evaluate(() => window.__reloads), 1, 'no reloads after stopping');
  assert.equal(await page.evaluate((k) => JSON.parse(localStorage.getItem(k)).watching, STATE_KEY), false);
  await ctx.close();
});

await test('it never reloads faster than the minimum interval, whatever is saved', async () => {
  const { page, ctx } = await open({ cfg: '{ settleMs: 0 }', pre: `localStorage.setItem('${STATE_KEY}', JSON.stringify({ watching: true, intervalSec: 1, snapshot: null }));`, clock: true });
  await waitChecks(page, 1);
  await page.clock.fastForward('00:30');
  assert.equal(await page.evaluate(() => window.__reloads), 0);
  await ctx.close();
});

await test('sends a phone push through ntfy when a topic is set', async () => {
  const { page, ctx } = await open({ pre: `localStorage.setItem('tw:ntfyTopic', JSON.stringify('my topic'));` });
  await startWatching(page);
  assert.equal(site.ntfy.length, 0, 'no push for the baseline');
  site.html = AVAILABLE;
  await reload(page);
  await page.waitForTimeout(300);
  assert.equal(site.ntfy.length, 1);
  assert.equal(site.ntfy[0].topic, 'my topic');
  assert.match(site.ntfy[0].body, /TICKETS AVAILABLE\?/);
  assert.equal(site.ntfy[0].click, EVENT_URL);
  await ctx.close();
});

await test('"Captured text" shows what is being compared (for diagnosing noise)', async () => {
  const { page, ctx } = await open();
  await page.click('.pill');
  await page.click('text=Captured text');
  const shown = await page.locator('.card pre').innerText();
  assert.match(shown, /Silvana Estrada/);
  assert.match(shown, /Agotado/);
  assert.doesNotMatch(shown, /^Inicio Conciertos$/m, 'nav outside <main> is excluded');
  await ctx.close();
});

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
