// Run: node --test worker/
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './fetch-proxy.mjs';

const ORIGIN = 'https://juanloaiza21.github.io';
const call = (target, { origin = ORIGIN, method = 'GET', headers = {}, env } = {}) =>
  worker.fetch(
    new Request(`https://proxy.example/?url=${encodeURIComponent(target)}`, {
      method,
      headers: { ...(origin ? { Origin: origin } : {}), ...headers },
    }),
    env,
  );

// Replace the network: `routes` maps a URL to a Response (or a function returning one).
function mockUpstream(routes) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const r = routes[String(url)];
    if (!r) throw new Error(`unexpected upstream request: ${url}`);
    return typeof r === 'function' ? r() : r;
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const html = (body, init = {}) => new Response(body, { status: 200, headers: { 'content-type': 'text/html' }, ...init });

test('returns the page with status info and CORS for the allowed origin', async () => {
  const up = mockUpstream({ 'https://www.ticketmaster.co/event/x': html('<h1>Hola</h1>') });
  try {
    const res = await call('https://www.ticketmaster.co/event/x');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const j = await res.json();
    assert.deepEqual({ ok: j.ok, status: j.status, body: j.body, truncated: j.truncated },
      { ok: true, status: 200, body: '<h1>Hola</h1>', truncated: false });
    assert.equal(j.finalUrl, 'https://www.ticketmaster.co/event/x');
  } finally { up.restore(); }
});

test('refuses everything that is not an allowlisted https host', async () => {
  const up = mockUpstream({});
  try {
    for (const bad of [
      'https://evil.com/',
      'https://ticketmaster.co.evil.com/',
      'https://evilticketmaster.co/',
      'https://ticketmaster.co@evil.com/',
      'https://user:pass@ticketmaster.co/',
      'https://ticketmaster.co:8443/',
      'https://ticketmaster.co./',
      'http://www.ticketmaster.co/',
      'https://127.0.0.1/',
      'https://169.254.169.254/latest/meta-data/',
      'file:///etc/passwd',
      'not a url',
    ]) {
      const res = await call(bad);
      assert.equal(res.status, 400, `${bad} should be refused, got ${res.status}`);
    }
    assert.equal(up.calls.length, 0, 'nothing may reach the network for a refused URL');
  } finally { up.restore(); }
});

test('accepts all four configured hosts', async () => {
  const urls = ['https://ticketmaster.co/a', 'https://www.ticketmaster.co/a', 'https://latiquetera.com/a', 'https://www.latiquetera.com/a'];
  const up = mockUpstream(Object.fromEntries(urls.map((u) => [u, () => html('ok')])));
  try {
    for (const u of urls) assert.equal((await call(u)).status, 200, u);
  } finally { up.restore(); }
});

test('follows redirects between allowed hosts and reports the final URL', async () => {
  const up = mockUpstream({
    'https://ticketmaster.co/event/x': new Response(null, { status: 301, headers: { location: 'https://www.ticketmaster.co/event/x' } }),
    'https://www.ticketmaster.co/event/x': new Response(null, { status: 302, headers: { location: '/event/y' } }),
    'https://www.ticketmaster.co/event/y': html('final'),
  });
  try {
    const j = await (await call('https://ticketmaster.co/event/x')).json();
    assert.equal(j.body, 'final');
    assert.equal(j.finalUrl, 'https://www.ticketmaster.co/event/y');
  } finally { up.restore(); }
});

test('a redirect to a disallowed host is refused, not followed', async () => {
  const up = mockUpstream({
    'https://www.ticketmaster.co/event/x': new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest' } }),
  });
  try {
    const res = await call('https://www.ticketmaster.co/event/x');
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /only https|host not allowed/);
    assert.equal(up.calls.length, 1, 'the redirect target must never be requested');
  } finally { up.restore(); }
});

test('redirect loops are cut off', async () => {
  const loop = () => new Response(null, { status: 302, headers: { location: 'https://www.ticketmaster.co/loop' } });
  const up = mockUpstream({ 'https://www.ticketmaster.co/loop': loop });
  try {
    const res = await call('https://www.ticketmaster.co/loop');
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /too many redirects/);
    assert.ok(up.calls.length <= 6);
  } finally { up.restore(); }
});

test("the site's own error status is passed through (so the page can explain a block)", async () => {
  const up = mockUpstream({ 'https://www.ticketmaster.co/event/x': html('Access denied', { status: 403 }) });
  try {
    const res = await call('https://www.ticketmaster.co/event/x');
    assert.equal(res.status, 200, 'the proxy itself worked');
    const j = await res.json();
    assert.deepEqual({ ok: j.ok, status: j.status, body: j.body }, { ok: false, status: 403, body: 'Access denied' });
  } finally { up.restore(); }
});

test('forwards no cookies or credentials from the caller, and sends browser-like headers', async () => {
  const up = mockUpstream({ 'https://www.ticketmaster.co/e': html('ok') });
  try {
    await call('https://www.ticketmaster.co/e', { headers: { Cookie: 'session=secret', Authorization: 'Bearer secret', 'X-Api-Key': 'secret' } });
    const sent = Object.fromEntries(Object.entries(up.calls[0].init.headers).map(([k, v]) => [k.toLowerCase(), v]));
    assert.deepEqual(Object.keys(sent).sort(), ['accept', 'accept-language', 'user-agent']);
    assert.equal(up.calls[0].init.redirect, 'manual');
    assert.ok(!JSON.stringify(sent).includes('secret'));
  } finally { up.restore(); }
});

test('CORS: only allowed origins may read; others are refused before any fetch', async () => {
  const up = mockUpstream({ 'https://www.ticketmaster.co/e': html('ok') });
  try {
    const bad = await call('https://www.ticketmaster.co/e', { origin: 'https://evil.example' });
    assert.equal(bad.status, 403);
    const refusal = await bad.json();
    assert.match(refusal.error, /origin not allowed: https:\/\/evil\.example.*ALLOWED_ORIGINS/);
    assert.deepEqual(Object.keys(refusal), ['error'], 'a refusal carries no page data');
    assert.equal(bad.headers.get('access-control-allow-origin'), '*', 'readable so the page can say what to fix');
    assert.equal(up.calls.length, 0, 'nothing is fetched for a refused origin');

    const noOrigin = await call('https://www.ticketmaster.co/e', { origin: null }); // curl-style
    assert.equal(noOrigin.status, 200);
    assert.equal(noOrigin.headers.get('access-control-allow-origin'), null);

    const custom = await call('https://www.ticketmaster.co/e', { origin: 'https://mine.example', env: { ALLOWED_ORIGINS: 'https://mine.example, http://localhost:3000' } });
    assert.equal(custom.headers.get('access-control-allow-origin'), 'https://mine.example');
    const defaultNowDenied = await call('https://www.ticketmaster.co/e', { env: { ALLOWED_ORIGINS: 'https://mine.example' } });
    assert.equal(defaultNowDenied.status, 403, 'setting ALLOWED_ORIGINS replaces the defaults');
  } finally { up.restore(); }
});

test('preflight and non-GET methods', async () => {
  const pre = await call('https://www.ticketmaster.co/e', { method: 'OPTIONS' });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal((await call('https://www.ticketmaster.co/e', { method: 'POST' })).status, 405);
  const missing = await worker.fetch(new Request('https://proxy.example/', { headers: { Origin: ORIGIN } }));
  assert.equal(missing.status, 400);
});

test('oversized pages are truncated and flagged', async () => {
  const big = 'x'.repeat(2_500_000);
  const up = mockUpstream({ 'https://www.ticketmaster.co/big': html(big) });
  try {
    const j = await (await call('https://www.ticketmaster.co/big')).json();
    assert.equal(j.truncated, true);
    assert.equal(j.body.length, 2_000_000);
  } finally { up.restore(); }
});

test('a network failure is a 502 with a readable message', async () => {
  const up = mockUpstream({ 'https://www.ticketmaster.co/e': () => { throw new Error('connection reset'); } });
  try {
    const res = await call('https://www.ticketmaster.co/e');
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /could not reach the site: connection reset/);
  } finally { up.restore(); }
});
