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
