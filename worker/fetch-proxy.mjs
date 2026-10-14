// Page fetch proxy for the ticketwatch web page (a Cloudflare Worker, free tier is plenty).
//
// Browsers won't let a web page read other sites (CORS), so the page asks this Worker to fetch
// the event page for it. The Worker is deliberately narrow:
//   * only the hosts in ALLOWED_HOSTS can be fetched (it is NOT an open proxy)
//   * every redirect hop is re-checked against that list
//   * it sends no cookies and forwards nothing from the caller
//   * only the origins in ALLOWED_ORIGINS may read the answer from a browser
//
// Deploy: Cloudflare dashboard > Workers & Pages > Create > Hello World > Edit code > paste this
// file > Deploy. Using your own domain? Add a variable ALLOWED_ORIGINS (comma-separated) instead
// of editing this file.

const ALLOWED_HOSTS = new Set([
  'ticketmaster.co',
  'www.ticketmaster.co',
  'latiquetera.com',
  'www.latiquetera.com',
]);
const DEFAULT_ORIGINS = ['https://juanloaiza21.github.io', 'http://localhost:8000', 'http://127.0.0.1:8000'];
const MAX_BYTES = 2_000_000;
const MAX_HOPS = 5;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

class Refused extends Error {}

function allowedOrigins(env) {
  const v = env && env.ALLOWED_ORIGINS;
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : DEFAULT_ORIGINS;
}

function checkTarget(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Refused('url is not a valid URL'); }
  if (u.protocol !== 'https:') throw new Refused('only https URLs are allowed');
  if (u.username || u.password) throw new Refused('URLs with credentials are not allowed');
  if (u.port && u.port !== '443') throw new Refused('custom ports are not allowed');
  if (!ALLOWED_HOSTS.has(u.hostname)) throw new Refused(`host not allowed: ${u.hostname}`);
  return u;
}

// Follow redirects by hand so each hop is validated; fetch() would happily follow one to anywhere.
async function fetchAllowed(start) {
  let url = start;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const resp = await fetch(url.href, {
      redirect: 'manual',
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.5',
        'Accept-Language': 'es-CO,es;q=0.9,en;q=0.8',
      },
      cf: { cacheTtl: 0 },
    });
    const location = resp.headers.get('location');
    if (resp.status >= 300 && resp.status < 400 && location) {
      url = checkTarget(new URL(location, url).href);
      continue;
    }
    return { resp, finalUrl: url };
  }
  throw new Refused('too many redirects');
}

async function readCapped(resp) {
  if (!resp.body) return { text: '', truncated: false };
  const reader = resp.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BYTES) {
      chunks.push(value.slice(0, value.length - (total - MAX_BYTES)));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return { text: await new Blob(chunks).text(), truncated };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const originOk = !origin || allowedOrigins(env).includes(origin);
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Origin' };
    if (origin && originOk) headers['Access-Control-Allow-Origin'] = origin;
    const reply = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers });

    if (!originOk) {
      // Say why. This refusal carries no data, so any site may read it, and it saves a baffling
      // CORS failure in the browser when the page's address just needs adding to the list.
      return new Response(
        JSON.stringify({ error: `origin not allowed: ${origin}. Add it to the Worker's ALLOWED_ORIGINS variable.` }),
        { status: 403, headers: { ...headers, 'Access-Control-Allow-Origin': '*' } },
      );
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: { ...headers, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '86400' },
      });
    }
    if (request.method !== 'GET') return reply({ error: 'GET only' }, 405);

    const raw = new URL(request.url).searchParams.get('url');
    if (!raw) return reply({ error: 'missing ?url=' }, 400);

    try {
      const { resp, finalUrl } = await fetchAllowed(checkTarget(raw));
      const { text, truncated } = await readCapped(resp);
      return reply({
        ok: resp.ok,
        status: resp.status,
        finalUrl: finalUrl.href,
        contentType: resp.headers.get('content-type') || '',
        truncated,
        body: text,
      });
    } catch (e) {
      if (e instanceof Refused) return reply({ error: e.message }, 400);
      return reply({ error: `could not reach the site: ${e && e.message ? e.message : e}` }, 502);
    }
  },
};
