// ==UserScript==
// @name         ticketwatch: page watcher (Ticketmaster Colombia / La Tiquetera)
// @namespace    https://github.com/juanloaiza21/ticket-master-script
// @version      0.1.0
// @description  Reloads an event page on an interval and alerts you when its content changes: sold out -> available, new dates, prices, presales.
// @match        https://www.ticketmaster.co/event/*
// @match        https://ticketmaster.co/event/*
// @match        https://latiquetera.com/*
// @match        https://www.latiquetera.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_notification
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      ntfy.sh
// @run-at       document-idle
// ==/UserScript==

// How it works: open an event page, click "Watch this page" in the little panel at the bottom
// right, and leave the tab open. Every few minutes the page reloads, the visible text is compared
// with the previous copy, and any difference raises an alert (desktop notification, tab title, and
// optionally a phone push through https://ntfy.sh). Nothing leaves your browser except that push.
//
// If it alerts too much (rotating banners, "recommended events"...) or too little, press
// "Captured text" in the panel to see exactly what it reads, then narrow it with CONTENT_SELECTOR
// below (a CSS selector for the part of the page that holds the tickets), or add to IGNORE.
(function () {
  'use strict';

// Page-comparison logic shared by the web page and the userscript. Pure functions only: callers
// read the page (live DOM or fetched HTML) and hand over text. This file is a classic script
// that defines `TW`, and the build also pastes it into the userscript.
const TW = (() => {
  'use strict';

  const SOLD = /agotad[oa]s?|sold\s*out|soldout|sin disponibilidad|no hay (boletas|entradas)/i;
  const AVAIL = /comprar|buy tickets|get tickets|a[gñ]adir al carrito|agregar al carrito|seleccionar (boletas|entradas)|elegir (boletas|entradas|ubicaci)|ver (boletas|entradas)|in ?stock|limitedavailability|preorder|onlineonly/i;
  const PRESALE = /pre-?venta|presale/i;
  const DATE = /\b\d{1,2} de (enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b|\b20\d\d-\d\d-\d\d\b/i;
  const PRICE = /(\$|cop)\s?\d[\d.,]*/i;
  const BLOCK = /queue-it|sala de espera|est[aá]s en la fila|you are now in line|verify you are (a )?human|verifica que eres|captcha|access denied|acceso denegado|just a moment|checking your browser/i;

  // Bare numbers/clocks (countdowns, counters) change constantly and mean nothing, so drop them.
  function normalizeLines(text, ignore = [/cookies?\b/i]) {
    const out = [];
    for (const raw of String(text).split(/\n+/)) {
      const line = raw.replace(/\s+/g, ' ').trim();
      if (line.length < 2) continue;
      if (/^[\d\s:.,/\-–—+%]+$/.test(line)) continue;
      if (ignore.some((re) => re.test(line))) continue;
      out.push(line.length > 300 ? line.slice(0, 300) : line);
    }
    return out.slice(0, 600);
  }

  // Event pages often embed schema.org JSON-LD with the real availability. Far more reliable than
  // button text, so surface it as extra lines when present. Takes the raw JSON strings.
  function jsonLdLines(scriptTexts) {
    const out = [];
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(visit);
      if (node['@graph']) visit(node['@graph']);
      const type = [].concat(node['@type'] || []).join(' ');
      if (/Event/.test(type)) {
        const loc = node.location && (node.location.name || '');
        out.push(`[data] event: ${node.name || '?'} | ${node.startDate || 'no date'} | ${loc}`);
        for (const o of [].concat(node.offers || [])) {
          const avail = String(o.availability || '').split('/').pop();
          out.push(`[data] offer: ${avail || '?'} | ${o.price ?? '?'} ${o.priceCurrency || ''} | from ${o.validFrom || '?'}`.trim());
        }
      }
    };
    for (const t of scriptTexts) {
      try { visit(JSON.parse(t)); } catch { /* malformed JSON-LD: ignore */ }
    }
    return out;
  }

  function looksBlocked(text) {
    const t = text.trim();
    if (t.length < 150) return 'the page is nearly empty (still loading, or blocked)';
    // Real pages mention "captcha" in a footer; only trust the pattern on short pages.
    const m = t.length < 1500 && BLOCK.exec(t);
    return m ? `it looks like a queue or verification page ("${m[0]}")` : null;
  }

  function diffLines(oldL, newL) {
    const count = (arr) => {
      const m = new Map();
      for (const l of arr) m.set(l, (m.get(l) || 0) + 1);
      return m;
    };
    const a = count(oldL), b = count(newL);
    const added = [], removed = [];
    for (const [l, n] of b) for (let i = n - (a.get(l) || 0); i > 0; i--) added.push(l);
    for (const [l, n] of a) for (let i = n - (b.get(l) || 0); i > 0; i--) removed.push(l);
    return { added, removed };
  }

  function classify({ added, removed }) {
    const any = (arr, re) => arr.some((l) => re.test(l));
    const tags = [];
    if (any(removed, SOLD) && !any(added, SOLD)) tags.push('NO LONGER SOLD OUT');
    if (any(added, SOLD) && !any(removed, SOLD)) tags.push('SOLD OUT');
    if (any(added, AVAIL)) tags.push('TICKETS AVAILABLE?');
    if (any(added, PRESALE)) tags.push('PRESALE');
    if (any(added, DATE)) tags.push('NEW DATE?');
    if (any(added, PRICE)) tags.push('PRICES');
    if (!tags.length) tags.push('PAGE CHANGED');
    return tags;
  }

  function buildAlert(d, pageTitle) {
    const tags = classify(d);
    const clip = (l) => (l.length > 140 ? `${l.slice(0, 137)}...` : l);
    const body = [
      ...d.added.slice(0, 8).map((l) => `+ ${clip(l)}`),
      ...d.removed.slice(0, 5).map((l) => `- ${clip(l)}`),
    ].join('\n');
    return { tags, title: `${tags.join(' / ')}: ${String(pageTitle).slice(0, 60)}`, body };
  }

  // A rough read of the current state, shown so you can sanity-check what was captured.
  function statusGuess(text) {
    return SOLD.test(text) ? 'sold out' : AVAIL.test(text) ? 'buy options' : 'unclear';
  }

  return { normalizeLines, jsonLdLines, looksBlocked, diffLines, classify, buildAlert, statusGuess };
})();

  // ---- things you may want to edit --------------------------------------------------------
  const CONTENT_SELECTOR = ''; // e.g. '#tickets' ; empty = the <main> element, else the whole page
  const IGNORE = [/cookies?\b/i]; // lines matching any of these are never compared

  // ---- internals ----------------------------------------------------------------------------
  const CFG = Object.assign({
    contentSelector: CONTENT_SELECTOR,
    settleMs: 4000,      // wait until the page text has stopped changing for this long
    maxSettleMs: 25000,  // ...but never longer than this (single-page apps render late)
    minIntervalSec: 60,  // be polite: never reload more often than this
    ntfyBase: 'https://ntfy.sh',
    reload: () => location.reload(),
  }, globalThis.__TW_CONFIG || {});

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Storage: Tampermonkey's shared store when available, localStorage otherwise (tests).
  const kv = {
    get(k, d) {
      try {
        if (typeof GM_getValue === 'function') return GM_getValue(k, d);
        const v = localStorage.getItem(k);
        return v == null ? d : JSON.parse(v);
      } catch { return d; }
    },
    set(k, v) {
      try {
        if (typeof GM_setValue === 'function') GM_setValue(k, v);
        else localStorage.setItem(k, JSON.stringify(v));
      } catch { /* storage unavailable: carry on without persistence */ }
    },
  };

  // ---- reading the live page ----------------------------------------------------------------
  function readRoot() {
    const sel = CFG.contentSelector;
    return (sel && document.querySelector(sel)) || document.querySelector('main') || document.body;
  }

  function readText() {
    const root = readRoot();
    return root ? root.innerText || '' : '';
  }

  const pageLines = (text) => [
    ...TW.normalizeLines(text, IGNORE),
    ...TW.jsonLdLines([...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent)),
  ];

  // ---- alerting -----------------------------------------------------------------------------
  function ntfy(title, body) {
    const topic = kv.get('tw:ntfyTopic', '');
    if (!topic) return;
    const url = `${CFG.ntfyBase}/${encodeURIComponent(topic)}`;
    const data = `${title}\n${body}\n${location.href}`;
    try {
      if (typeof GM_xmlhttpRequest === 'function') {
        // Not fetch(): the site's own CSP could block calls to ntfy.sh, GM_xmlhttpRequest is exempt.
        GM_xmlhttpRequest({ method: 'POST', url, data, headers: { Click: location.href } });
      } else {
        fetch(url, { method: 'POST', body: data, headers: { Click: location.href } }).catch(() => {});
      }
    } catch { /* push is a bonus; the desktop alert already fired */ }
  }

  function deliver(title, body) {
    document.title = `(!) ${document.title.replace(/^\(!\) /, '')}`;
    try {
      if (typeof GM_notification === 'function') {
        GM_notification({ title, text: body.slice(0, 250), timeout: 0, onclick: () => window.focus() });
      } else if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(title, { body: body.slice(0, 250) });
      }
    } catch { /* notifications unsupported: the tab title and panel still show it */ }
    ntfy(title, body);
  }

  // ---- per-page state -----------------------------------------------------------------------
  const PAGE_KEY = `tw:v1:${location.origin}${location.pathname}`;
  const loadPage = () => Object.assign({ watching: false, intervalSec: 300, snapshot: null }, kv.get(PAGE_KEY, {}));
  const savePage = (st) => kv.set(PAGE_KEY, st);

  let reloadTimer = null;
  function schedule(st) {
    clearTimeout(reloadTimer);
    if (!st.watching) return;
    const base = Math.max(CFG.minIntervalSec, st.intervalSec) * 1000;
    reloadTimer = setTimeout(CFG.reload, base * (0.9 + Math.random() * 0.2)); // jitter: less robotic
  }

  async function captureSettled() {
    const start = Date.now();
    let last = null, stableSince = Date.now();
    for (;;) {
      const text = readText();
      if (text !== last) { last = text; stableSince = Date.now(); }
      const now = Date.now();
      if (now - stableSince >= CFG.settleMs || now - start >= CFG.maxSettleMs) return last;
      await sleep(250);
    }
  }

  async function check(st) {
    const text = await captureSettled();
    st.lastCheck = Date.now();
    const blocked = TW.looksBlocked(text);
    if (blocked) {
      st.note = `Skipped this check: ${blocked}.`;
    } else {
      const lines = pageLines(text);
      if (!st.snapshot) {
        st.snapshot = lines;
        st.note = `Baseline saved (${lines.length} lines). You'll be alerted when it changes.`;
      } else {
        const d = TW.diffLines(st.snapshot, lines);
        if (d.added.length || d.removed.length) {
          const a = TW.buildAlert(d, document.title);
          st.note = `CHANGED: ${a.tags.join(' / ')}`;
          st.lastChange = { at: st.lastCheck, tags: a.tags, body: a.body };
          deliver(a.title, a.body);
          st.snapshot = lines;
        } else {
          st.note = 'No changes.';
        }
      }
    }
    savePage(st);
    schedule(st);
    document.documentElement.dataset.twChecked = String((Number(document.documentElement.dataset.twChecked) || 0) + 1);
  }

  // ---- panel (Shadow DOM, built without innerHTML so strict page CSP can't break it) ---------
  function el(tag, props = {}, ...kids) {
    const e = document.createElement(tag);
    Object.assign(e, props);
    for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k)));
    return e;
  }

  function buildPanel(st) {
    const host = el('div');
    host.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    const css = el('style', { textContent: `
      :host{all:initial} *{box-sizing:border-box;font:13px/1.4 system-ui,sans-serif}
      .pill{background:#2457d6;color:#fff;border:0;border-radius:999px;padding:6px 12px;cursor:pointer}
      .card{width:300px;background:#fff;color:#1b1f24;border:1px solid #ccd;border-radius:10px;padding:12px;
            box-shadow:0 6px 24px rgba(0,0,0,.25);margin-bottom:8px;max-height:70vh;overflow:auto}
      .card[hidden]{display:none} h4{margin:0 0 6px;font-weight:600}
      button.b{margin:4px 4px 0 0;padding:5px 9px;border:1px solid #ccd;border-radius:7px;background:#f4f6fa;cursor:pointer}
      button.go{background:#2457d6;color:#fff;border-color:#2457d6}
      input,select{width:100%;margin-top:4px;padding:5px;border:1px solid #ccd;border-radius:6px}
      pre{white-space:pre-wrap;word-break:break-word;background:#f4f6fa;padding:6px;border-radius:6px;max-height:220px;overflow:auto;margin:6px 0 0;font:12px/1.35 ui-monospace,monospace}
      .muted{color:#667085;font-size:12px}` });
    const status = el('div', { className: 'muted' });
    const guess = el('div');
    const out = el('pre', { hidden: true });
    const go = el('button', { className: 'b go' });
    const interval = el('select');
    for (const [sec, label] of [[60, 'every 1 min'], [120, 'every 2 min'], [300, 'every 5 min'], [600, 'every 10 min']]) {
      interval.append(el('option', { value: String(sec), textContent: label, selected: sec === st.intervalSec }));
    }
    const topic = el('input', { placeholder: 'ntfy topic for phone alerts (optional)', value: kv.get('tw:ntfyTopic', '') });
    const card = el('div', { className: 'card', hidden: true },
      el('h4', {}, 'ticketwatch'), guess, status, go, interval,
      el('button', { className: 'b', textContent: 'Test alert', onclick: () => deliver('ticketwatch test', 'If you can read this, alerts work.') }),
      el('button', { className: 'b', textContent: 'Captured text', onclick: () => {
        out.textContent = pageLines(readText()).join('\n') || '(nothing captured yet)';
        out.hidden = !out.hidden;
      } }),
      topic, out);
    const pill = el('button', { className: 'pill', textContent: st.watching ? 'watching' : 'watch?', onclick: () => { card.hidden = !card.hidden; } });
    root.append(css, card, pill);

    const render = () => {
      go.textContent = st.watching ? 'Stop watching' : 'Watch this page';
      pill.textContent = st.watching ? 'watching' : 'watch?';
      const text = readText();
      const g = TW.statusGuess(text);
      guess.textContent = g === 'sold out' ? 'Page says: SOLD OUT' : g === 'buy options' ? 'Page shows buy options' : 'Page status: unclear';
      const when = st.lastCheck ? ` Last check ${new Date(st.lastCheck).toLocaleTimeString()}.` : '';
      status.textContent = `${st.note || (st.watching ? 'Starting…' : 'Not watching.')}${when}`;
    };
    go.onclick = async () => {
      st.watching = !st.watching;
      st.snapshot = null; // a fresh baseline each time you start
      st.note = '';
      if (st.watching) {
        if (typeof GM_notification !== 'function' && 'Notification' in window && Notification.permission === 'default') {
          try { await Notification.requestPermission(); } catch { /* ignore */ }
        }
        savePage(st);
        render();
        await check(st);
      } else {
        clearTimeout(reloadTimer);
        savePage(st);
      }
      render();
    };
    interval.onchange = () => { st.intervalSec = Number(interval.value); savePage(st); schedule(st); };
    topic.onchange = () => kv.set('tw:ntfyTopic', topic.value.trim());
    document.body.append(host);
    render();
    return render;
  }

  async function main() {
    const st = loadPage();
    const render = buildPanel(st);
    if (st.watching) { await check(st); render(); }
    document.documentElement.dataset.twReady = '1';
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main);
  else main();
})();
