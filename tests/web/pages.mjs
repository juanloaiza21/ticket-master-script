// End-to-end tests for watching pages from the web page: browser -> real Worker code -> stand-in site.
// Run: cd tests/web && npm install && CHROMIUM_PATH=/path/to/chrome node pages.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import worker from '../../worker/fetch-proxy.mjs';

const DOCS = fileURLToPath(new URL('../../docs', import.meta.url));
const PAGE_PORT = 8821, PROXY_PORT = 8822, PROXY_OTHER_PORT = 8823;
const PAGE_ORIGIN = `http://127.0.0.1:${PAGE_PORT}`;
const PROXY = `http://127.0.0.1:${PROXY_PORT}`;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm' };
const TM = 'https://www.ticketmaster.co/event/silvana-estrada';
const LT = 'https://latiquetera.com/site/comfama/events/view/vendran-suaves-lluvias---silvana-estrada';

// ---- stand-in for the ticketing sites (what the Worker's fetch() reaches) ---------------------
const FILLER = '<p>Silvana Estrada presenta Vendrán Suaves Lluvias en Colombia. Consulta fechas, zonas y precios de las boletas para el concierto en Vive Claro Music Hall, Bogotá.</p>';
const doc = (main, head = '<title>Silvana Estrada | Ticketmaster</title>') => `<!doctype html><html><head><meta charset="utf-8">${head}</head><body><nav>Inicio Conciertos</nav><main>${main}</main></body></html>`;
const SOLD = () => doc(`<h1>Silvana Estrada</h1>${FILLER}<p>20 de noviembre de 2026</p><div>Agotado</div>`);
const AVAILABLE = () => doc(`<h1>Silvana Estrada</h1>${FILLER}<p>20 de noviembre de 2026</p><button>Comprar boletas</button><p>Zona Platea COP $311.000</p>`);
const RICH = () => doc(`<h1>Silvana Estrada</h1>${FILLER}<p>20 de noviembre de 2026</p><div>Agotado</div><ul>${Array.from({ length: 20 }, (_, i) => `<li>Zona ${i} disponible en taquilla</li>`).join('')}</ul>`);

const routes = new Map(); // "host/path" -> { status, html }
const upstream = [];
const setSite = (url, html, status = 200) => { const u = new URL(url); routes.set(u.host + u.pathname, { status, html }); };
globalThis.fetch = async (url, init) => {
  const u = new URL(String(url));
  upstream.push({ url: String(url), init });
  const r = routes.get(u.host + u.pathname);
  if (!r) throw new Error(`no stand-in for ${url}`);
  return new Response(r.html(), { status: r.status, headers: { 'content-type': 'text/html; charset=utf-8' } });
};

// ---- servers: the web page, and the real Worker behind a tiny Node adapter ------------------------
const proxyLog = [];
const serveWorker = (port, allowedOrigins, log) => http.createServer(async (req, res) => {
  if (log) log.push({ url: req.url, headers: { ...req.headers } });
  const resp = await worker.fetch(new Request(`http://127.0.0.1:${port}${req.url}`, { method: req.method, headers: req.headers }),
    { ALLOWED_ORIGINS: allowedOrigins });
  res.writeHead(resp.status, Object.fromEntries(resp.headers));
  res.end(Buffer.from(await resp.arrayBuffer()));
}).listen(port, '127.0.0.1');
serveWorker(PROXY_PORT, PAGE_ORIGIN, proxyLog);
serveWorker(PROXY_OTHER_PORT, 'https://somewhere-else.example');

http.createServer((req, res) => {
  const p = new URL(req.url, PAGE_ORIGIN).pathname;
  const file = path.join(DOCS, p === '/' ? 'index.html' : p);
  if (!file.startsWith(DOCS) || !fs.existsSync(file)) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
}).listen(PAGE_PORT, '127.0.0.1');

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

async function open({ blockApi = true } = {}) {
  const ctx = await browser.newContext();
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: PAGE_ORIGIN });
  const page = await ctx.newPage();
  const errors = [];
  const apiCalls = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    window.__notes = [];
    window.Notification = class {
      static get permission() { return 'granted'; }
      static requestPermission() { return Promise.resolve('granted'); }
      constructor(t, o) { window.__notes.push({ title: t, body: o && o.body }); }
    };
  });
  if (blockApi) await page.route('https://app.ticketmaster.com/**', (r) => { apiCalls.push(r.request().url()); r.abort(); });
  await page.goto(`${PAGE_ORIGIN}/`);
  await page.waitForFunction(() => document.documentElement.dataset.ready === '1');
  return { ctx, page, errors, apiCalls };
}

async function configure(page, { pages = TM, proxy = PROXY, key = '', artists = '' } = {}) {
  await page.fill('#pages', pages);
  await page.fill('#proxy', proxy);
  await page.fill('#apikey', key);
  await page.fill('#artists', artists);
}
const waitDone = (page) => page.waitForFunction(() => /Last check|Finished with|Enter|Not a valid|must be|Added/.test(document.getElementById('status').textContent));
async function check(page) {
  await page.evaluate(() => { document.getElementById('status').textContent = ''; });
  await page.click('#check');
  await waitDone(page);
}
const text = (page, sel) => page.locator(sel).innerText();
const notes = (page) => page.evaluate(() => window.__notes);

let passed = 0, failed = 0;
async function test(name, fn) {
  routes.clear(); upstream.length = 0; proxyLog.length = 0;
  setSite(TM, SOLD);
  try { await fn(); passed++; console.log(`ok   - ${name}`); }
  catch (e) { failed++; console.log(`FAIL - ${name}\n       ${String(e.stack || e).split('\n').slice(0, 6).join('\n       ')}`); }
}

await test('baseline, then an alert when the page goes from sold out to available (through the Worker)', async () => {
  const { page, ctx, errors } = await open();
  await configure(page);
  await check(page);
  const card = await text(page, '#artists-out');
  assert.match(card, /Silvana Estrada \| Ticketmaster/);
  assert.match(card, /First check: saved \d+ lines as the baseline/);
  assert.match(card, /read through your proxy/);
  assert.equal(await page.locator('#alerts-card').isHidden(), true);

  await page.check('#notify'); // desktop notifications are opt-in
  setSite(TM, AVAILABLE);
  await check(page);
  const alerts = await text(page, '#alerts');
  assert.match(alerts, /NO LONGER SOLD OUT/);
  assert.match(alerts, /TICKETS AVAILABLE\?/);
  assert.match(alerts, /\+ Comprar boletas/);
  assert.match(alerts, /- Agotado/);
  const [n] = await notes(page);
  assert.match(n.title, /TICKETS AVAILABLE\?/);
  assert.match(await page.title(), /^\(1\) ticketwatch/);

  // Reload: the baseline survives in localStorage, so an unchanged page stays quiet.
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.ready === '1');
  assert.equal(await page.inputValue('#proxy'), PROXY);
  await check(page);
  assert.match(await text(page, '#artists-out'), /No changes/);
  assert.equal(await page.locator('#alerts-card').isHidden(), true);
  assert.deepEqual(errors, []);
  await ctx.close();
});

await test('the Worker is asked for the right page, with nothing but the URL', async () => {
  const { page, ctx } = await open();
  await configure(page, { key: 'my-secret-key', artists: '' });
  await check(page);
  assert.equal(proxyLog.length, 1);
  const u = new URL(proxyLog[0].url, PROXY);
  assert.equal(u.searchParams.get('url'), TM);
  assert.deepEqual([...u.searchParams.keys()], ['url']);
  assert.ok(!JSON.stringify(proxyLog).includes('my-secret-key'), 'the API key must never be sent to the proxy');
  assert.equal(upstream.length, 1);
  await ctx.close();
});

await test('works with pages only: no API key needed and no Ticketmaster API calls', async () => {
  const { page, ctx, apiCalls } = await open();
  await configure(page, { key: '', artists: '' });
  await check(page);
  assert.match(await text(page, '#artists-out'), /First check/);
  assert.deepEqual(apiCalls, []);
  await ctx.close();
});

await test("an upstream 403 is explained, skipped, and doesn't disturb the baseline", async () => {
  const { page, ctx } = await open();
  await configure(page);
  await check(page);

  setSite(TM, () => '<html><body>Access Denied</body></html>', 403);
  await check(page);
  const card = await text(page, '#artists-out');
  assert.match(card, /Skipped this check: the site answered HTTP 403 \(it may be blocking the proxy\)/);
  assert.equal(await page.locator('#artists-out .err').count(), 1);
  assert.equal(await page.locator('#alerts-card').isHidden(), true);

  setSite(TM, AVAILABLE); // recovery is compared with the ORIGINAL baseline
  await check(page);
  assert.match(await text(page, '#alerts'), /TICKETS AVAILABLE\?/);
  await ctx.close();
});

await test('queue pages are skipped and never become the baseline', async () => {
  setSite(TM, () => doc('<h1>Sala de espera</h1><p>Estás en la fila. Te llevaremos al evento en cuanto sea tu turno, por favor no cierres ni recargues esta ventana para conservar tu lugar.</p>'));
  const { page, ctx } = await open();
  await configure(page);
  await check(page);
  assert.match(await text(page, '#artists-out'), /Skipped this check: it looks like a queue or verification page/);

  setSite(TM, SOLD);
  await check(page);
  assert.match(await text(page, '#artists-out'), /First check: saved/, 'the real page is the first baseline');
  await ctx.close();
});

await test('a page with very little static text gets a "built in the browser" hint; a rich one does not', async () => {
  const { page, ctx } = await open();
  await configure(page);
  await check(page);
  assert.match(await text(page, '#artists-out'), /Very little text came back/);

  setSite(TM, RICH);
  await page.click('text=Forget what I\'ve seen');
  await check(page);
  assert.doesNotMatch(await text(page, '#artists-out'), /Very little text came back/);
  await ctx.close();
});

await test('"What was read" shows the captured text so you can check it is the event info', async () => {
  const { page, ctx } = await open();
  await configure(page);
  await check(page);
  await page.click('summary');
  const shown = await text(page, '#artists-out pre');
  assert.match(shown, /Silvana Estrada/);
  assert.match(shown, /Agotado/);
  assert.doesNotMatch(shown, /^Inicio Conciertos$/m, 'nav outside <main> is excluded');
  await ctx.close();
});

await test('a host outside the Worker allowlist is refused with a clear message', async () => {
  const { page, ctx } = await open();
  await configure(page, { pages: 'https://example.com/event/x' });
  await check(page);
  assert.match(await text(page, '#artists-out .err'), /The proxy refused: host not allowed: example\.com/);
  assert.equal(upstream.length, 0);
  await ctx.close();
});

await test("a Worker that doesn't list this site's address says exactly what to change", async () => {
  const { page, ctx } = await open();
  await configure(page, { proxy: `http://127.0.0.1:${PROXY_OTHER_PORT}` });
  await check(page);
  const err = await text(page, '#artists-out .err');
  assert.match(err, /The proxy refused: origin not allowed: http:\/\/127\.0\.0\.1:8821/);
  assert.match(err, /ALLOWED_ORIGINS/);
  assert.equal(upstream.length, 0);
  await ctx.close();
});

await test('without a proxy the browser block is explained instead of failing silently', async () => {
  const { page, ctx } = await open();
  await page.route('https://www.ticketmaster.co/**', (r) => r.abort());
  await configure(page, { proxy: '' });
  await check(page);
  assert.match(await text(page, '#artists-out .err'), /won't let a web page read that site directly \(CORS\)/);
  await ctx.close();
});

await test('proxy problems are reported plainly: unreachable, or not the Worker', async () => {
  const { page, ctx } = await open();
  await configure(page, { proxy: 'http://127.0.0.1:9' });
  await check(page);
  assert.match(await text(page, '#artists-out .err'), /Couldn't reach your page proxy/);

  await configure(page, { proxy: PAGE_ORIGIN }); // answers with HTML, not the Worker's JSON
  await check(page);
  assert.match(await text(page, '#artists-out .err'), /not in the expected format/);
  await ctx.close();
});

await test('one failing page does not stop the others', async () => {
  setSite(LT, () => 'nope', 403);
  const { page, ctx } = await open();
  await configure(page, { pages: `${LT}\n${TM}` });
  await check(page);
  const out = await text(page, '#artists-out');
  assert.match(out, /Skipped this check: the site answered HTTP 403/);
  assert.match(out, /First check: saved/);
  assert.equal(await page.locator('#artists-out .card').count(), 2);
  await ctx.close();
});

await test('page content cannot inject markup', async () => {
  setSite(TM, () => doc(`<h1>Silvana Estrada</h1>${FILLER}<p>&lt;img src=x onerror="window.__xss=1"&gt;</p>`,
    '<title>&lt;img src=x onerror="window.__xss=2"&gt; Evil</title>'));
  const { page, ctx } = await open();
  await configure(page);
  await check(page);
  await page.click('summary');
  assert.match(await text(page, '#artists-out'), /<img src=x onerror=/, 'shown as literal text');
  assert.equal(await page.locator('#artists-out img').count(), 0);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  await ctx.close();
});

await test('settings are validated before anything is fetched', async () => {
  const { page, ctx } = await open();
  const cases = [
    [{ pages: 'not a url' }, /Not a valid page URL/],
    [{ pages: 'javascript:alert(1)' }, /Not a valid page URL/],
    [{ proxy: 'http://evil.example' }, /must be an https:\/\/ address/],
    [{ proxy: 'ftp://x' }, /must be an https:\/\/ address/],
    [{ pages: '', artists: '' }, /Enter an artist or a page/],
    [{ pages: '', artists: 'Silvana Estrada', key: '' }, /Enter your API key first/],
  ];
  for (const [cfg, re] of cases) {
    await configure(page, cfg);
    await check(page);
    assert.match(await text(page, '#status'), re, JSON.stringify(cfg));
  }
  assert.equal(proxyLog.length, 0);
  await ctx.close();
});

await test('artists and pages are checked together in one run', async () => {
  const { page, ctx } = await open({ blockApi: false });
  await page.route('https://app.ticketmaster.com/discovery/v2/**', (r) => {
    const url = r.request().url();
    const body = url.includes('attractions.json') ? { _embedded: { attractions: [{ id: 'A1', name: 'Silvana Estrada' }] } } : { page: { totalPages: 0, totalElements: 0 } };
    r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  });
  await configure(page, { key: 'my-secret-key', artists: 'Silvana Estrada' });
  await check(page);
  assert.equal(await page.locator('#artists-out .card').count(), 2);
  assert.match(await text(page, '#artists-out'), /No events listed right now/);
  assert.match(await text(page, '#artists-out'), /First check: saved/);
  assert.ok(!JSON.stringify(proxyLog).includes('my-secret-key'));
  await ctx.close();
});

await test('an uncovered country is information, not an error, when pages are being watched', async () => {
  const { page, ctx } = await open({ blockApi: false });
  await page.route('https://app.ticketmaster.com/discovery/v2/**', (r) => {
    const url = r.request().url();
    const body = url.includes('attractions.json') ? { _embedded: { attractions: [{ id: 'A1', name: 'Silvana Estrada' }] } } : { page: { totalPages: 0, totalElements: 0 } };
    r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  });
  await page.fill('#country', 'CO');
  await configure(page, { key: 'k', artists: 'Silvana Estrada' });
  await check(page);
  const out = await text(page, '#artists-out');
  assert.match(out, /lists no events at all in CO/);
  assert.match(out, /the pages you are watching below are checked separately/);
  assert.equal(await page.locator('#artists-out .err').count(), 0, 'no red error while the pages are covering Colombia');

  await configure(page, { key: 'k', artists: 'Silvana Estrada', pages: '' }); // artists only: now it IS a problem
  await check(page);
  assert.equal(await page.locator('#artists-out .err').count(), 1);
  await ctx.close();
});

await test("the Colombia card's buttons: add Silvana's pages (idempotent) and copy the proxy code", async () => {
  const { page, ctx } = await open();
  await page.fill('#pages', TM);
  await page.click('#use-colombia');
  await page.click('#use-colombia');
  const urls = (await page.inputValue('#pages')).split('\n');
  assert.equal(urls.length, 3, `no duplicates, got ${JSON.stringify(urls)}`);
  assert.ok(urls.includes(TM) && urls.includes(LT));

  await page.click('#copy-worker');
  await page.waitForFunction(() => /copied/i.test(document.getElementById('status').textContent));
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(clip, fs.readFileSync(fileURLToPath(new URL('../../worker/fetch-proxy.mjs', import.meta.url)), 'utf8'));
  await ctx.close();
});

await test('the copy button never copies an error page as if it were the code', async () => {
  const { page, ctx } = await open();
  await page.evaluate(() => navigator.clipboard.writeText('SENTINEL'));
  await page.route('**/fetch-proxy.mjs', (r) => r.fulfill({ status: 404, contentType: 'text/html', body: '<html><body>404 File not found</body></html>' }));
  await page.click('#copy-worker');
  await page.waitForFunction(() => /Nothing was copied/.test(document.getElementById('status').textContent));
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'SENTINEL', 'clipboard untouched');

  // Even a 200 that is not the code (e.g. a captive page) must be rejected.
  await page.unroute('**/fetch-proxy.mjs');
  await page.route('**/fetch-proxy.mjs', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<html>Sign in to Wi-Fi</html>' }));
  await page.evaluate(() => { document.getElementById('status').textContent = ''; });
  await page.click('#copy-worker');
  await page.waitForFunction(() => /Nothing was copied/.test(document.getElementById('status').textContent));
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'SENTINEL');
  await ctx.close();
});

await test('"Show the proxy code" fills a box with exactly the Worker file, for copying by hand', async () => {
  const { page, ctx } = await open();
  await page.click('#worker-details summary');
  await page.waitForFunction(() => document.getElementById('worker-code').value.length > 100);
  const shown = await page.inputValue('#worker-code');
  assert.equal(shown, fs.readFileSync(fileURLToPath(new URL('../../worker/fetch-proxy.mjs', import.meta.url)), 'utf8'));
  assert.match(shown, /export default/);
  assert.equal((shown.match(/export default/g) || []).length, 1, 'exactly one handler, so pasting it once cannot duplicate it');
  await ctx.close();
});

await browser.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
