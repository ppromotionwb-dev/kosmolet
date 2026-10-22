'use strict';
// tools-pack: «Рентген» страницы — SEO, технологии, скорость, сервер и заголовки безопасности.
// collect() выполняется в изолированном мире (DOM и Performance API), probe() — в главном мире (глобальные
// переменные библиотек: версии React/Vue/jQuery, ID счётчиков). Заголовки документа — из ctx.cdp (если вкладка
// записывалась) или повторным запросом в той же сессии. Отчёт: {sections:[{id, title, items:[{label, status, value, list?, rows?}]}]}.

const { evalRaw, isWebUrl } = require('./runner');

// ---------- выполняется в странице (изолированный мир) ----------
async function collect() {
  const d = document, loc = location;
  const q = (s) => d.querySelector(s);
  const qa = (s) => Array.from(d.querySelectorAll(s));
  const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n || 300);
  const metaContent = (sel) => { const m = q(sel); return m ? clean(m.getAttribute('content'), 2000) : null; };
  const describe = (el) => {
    if (!el || el.nodeType !== 1) return '';
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const c = typeof el.className === 'string' ? el.className.trim() : '';
    if (c) s += '.' + c.split(/\s+/).slice(0, 2).map((x) => (x.length > 28 ? x.slice(0, 28) + '…' : x)).join('.');
    return s.length > 90 ? s.slice(0, 90) + '…' : s;
  };
  const uniq = (arr) => arr.filter((v, i, a) => v && a.indexOf(v) === i);
  const out = { url: loc.href, host: loc.hostname, protocol: loc.protocol, secure: !!window.isSecureContext };

  // --- SEO ---
  out.title = q('title') ? clean(d.title, 500) : null;
  out.description = metaContent('meta[name="description" i]');
  out.robots = metaContent('meta[name="robots" i]');
  out.robotsBots = {};
  for (const b of ['googlebot', 'yandex']) { const v = metaContent('meta[name="' + b + '" i]'); if (v) out.robotsBots[b] = v; }
  const canon = qa('link[rel~="canonical" i]');
  out.canonical = canon[0] ? canon[0].href : null;
  out.canonicalCount = canon.length;
  out.lang = d.documentElement.getAttribute('lang') || null;
  out.hreflang = qa('link[rel~="alternate" i][hreflang]').slice(0, 100).map((l) => ({ lang: l.getAttribute('hreflang'), href: l.href }));
  out.h1 = qa('h1').slice(0, 30).map((h) => clean(h.innerText || h.textContent, 200));
  out.h1Count = qa('h1').length;
  out.outline = qa('h1, h2, h3').slice(0, 300).map((h) => ({ level: Number(h.tagName[1]), text: clean(h.innerText || h.textContent, 140) }));
  out.headings = { h2: qa('h2').length, h3: qa('h3').length };
  out.og = {};
  for (const m of qa('meta[property^="og:" i]')) { const k = String(m.getAttribute('property')).toLowerCase(); if (!(k in out.og)) out.og[k] = clean(m.getAttribute('content'), 500); }
  out.twitter = {};
  for (const m of qa('meta[name^="twitter:" i]')) { const k = String(m.getAttribute('name')).toLowerCase(); if (!(k in out.twitter)) out.twitter[k] = clean(m.getAttribute('content'), 500); }
  out.jsonLd = qa('script[type="application/ld+json" i]').slice(0, 50).map((s) => {
    const txt = s.textContent || '';
    try {
      const data = JSON.parse(txt);
      const types = [];
      const walk = (v, depth) => {
        if (!v || typeof v !== 'object' || depth > 5 || types.length > 40) return;
        if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return; }
        if (v['@type']) types.push([].concat(v['@type']).join('/'));
        if (v['@graph']) walk(v['@graph'], depth + 1);
      };
      walk(data, 0);
      return { ok: true, types };
    } catch (e) { return { ok: false, error: e.message, start: clean(txt, 100) }; }
  });
  out.microdata = uniq(qa('[itemscope][itemtype]').slice(0, 300).map((e) => String(e.getAttribute('itemtype')).replace(/^https?:\/\/schema\.org\//i, ''))).slice(0, 20);
  const imgs = qa('img');
  out.images = { total: imgs.length, noAlt: 0, emptyAlt: 0, samples: [] };
  for (const im of imgs) {
    const alt = im.getAttribute('alt');
    if (alt === null) { out.images.noAlt++; if (out.images.samples.length < 10) out.images.samples.push(im.currentSrc || im.src || '(нет src)'); } else if (!alt.trim()) out.images.emptyAlt++;
  }
  const L = { total: 0, internal: 0, external: 0, nofollow: 0, sponsored: 0, ugc: 0, other: 0, hosts: {} };
  const bare = (h) => h.replace(/^www\./, '');
  for (const a of qa('a[href]')) {
    L.total++;
    let u;
    try { u = new URL(a.href); } catch (e) { L.other++; continue; }
    if (!/^https?:$/.test(u.protocol)) { L.other++; continue; }
    const rel = String(a.getAttribute('rel') || '').toLowerCase();
    if (/\bnofollow\b/.test(rel)) L.nofollow++;
    if (/\bsponsored\b/.test(rel)) L.sponsored++;
    if (/\bugc\b/.test(rel)) L.ugc++;
    if (bare(u.hostname) === bare(loc.hostname)) L.internal++;
    else { L.external++; L.hosts[u.hostname] = (L.hosts[u.hostname] || 0) + 1; }
  }
  L.topHosts = Object.entries(L.hosts).sort((a, b) => b[1] - a[1]).slice(0, 10);
  delete L.hosts;
  out.links = L;
  out.viewport = metaContent('meta[name="viewport" i]');
  out.favicons = qa('link[rel~="icon" i], link[rel~="apple-touch-icon" i]').slice(0, 10).map((l) => ({ rel: l.getAttribute('rel'), href: l.href, sizes: l.getAttribute('sizes') || '' }));
  out.charset = d.characterSet;
  out.doctype = d.doctype ? d.doctype.name : null;
  out.generator = metaContent('meta[name="generator" i]');
  out.domSize = d.getElementsByTagName('*').length;

  // --- технологии по разметке ---
  const scripts = qa('script[src]').map((s) => s.src).slice(0, 500);
  const links = qa('link[href]').map((l) => l.href).slice(0, 400);
  let inline = '';
  for (const s of qa('script:not([src])')) { if (inline.length > 600000) break; inline += (s.textContent || '').slice(0, 80000) + '\n'; }
  const noscript = qa('noscript').map((n) => n.textContent || '').join('\n').slice(0, 60000);
  const all = scripts.join('\n') + '\n' + links.join('\n');
  const has = (re) => re.test(all);
  const ids = (re, text) => { const r = []; let m; re.lastIndex = 0; while ((m = re.exec(text)) && r.length < 20) r.push(m[1] || m[0]); return uniq(r); };
  const gen = out.generator || '';
  const T = {};
  T.nextData = !!q('script#__NEXT_DATA__');
  T.nextStatic = has(/\/_next\/static\//) || !!q('#__next');
  T.nuxt = !!q('#__nuxt, #__layout, script#__NUXT_DATA__') || has(/\/_nuxt\//) || /window\.__NUXT__\s*=/.test(inline);
  T.reactRoot = !!q('[data-reactroot], [data-reactid]');
  const ng = q('[ng-version]');
  T.ngVersion = ng ? ng.getAttribute('ng-version') : null;
  T.angularjs = !!q('[ng-app], [data-ng-app], .ng-scope');
  T.vueApp = !!q('[data-v-app]');
  let scoped = false;
  const sample = d.body ? d.body.getElementsByTagName('*') : [];
  for (let i = 0; i < sample.length && i < 800 && !scoped; i++) for (const at of sample[i].attributes) if (/^data-v-[0-9a-f]{6,8}$/.test(at.name)) { scoped = true; break; }
  T.vueScoped = scoped;
  T.svelte = !!q('[class*="svelte-"]');
  T.astro = !!q('astro-island, astro-slot') || /astro/i.test(gen);
  T.viteDev = has(/\/@vite\/client/);
  T.viteBuild = qa('script[type="module"][src]').some((s) => /\/assets\/[\w.-]+-[\w-]{8}\.js(\?|$)/.test(s.src)) && !!q('link[rel="modulepreload" i]');
  const jq = scripts.map((s) => /jquery[.-]?(\d+\.\d+(?:\.\d+)?)?(?:\.slim)?(?:\.min)?\.js/i.exec(s)).find(Boolean);
  T.jquerySrc = jq ? (jq[1] || 'есть') : null;
  T.tilda = has(/tildacdn\.(com|pro|net)|static\.tildacdn/) || !!q('#allrecords');
  T.bitrix = has(/\/bitrix\/(js|templates|cache|components)\//) || /BX\.(setJSList|message|ready)\(/.test(inline);
  T.wordpress = has(/\/wp-(content|includes)\//) || /wordpress/i.test(gen);
  T.shopify = has(/cdn\.shopify\.com|shopifycdn\.net/) || /Shopify\.shop\s*=/.test(inline);
  T.webflow = !!d.documentElement.getAttribute('data-wf-page') || has(/website-files\.com|webflow\.(com|io)\/js/);
  T.gtm = ids(/\b(GTM-[A-Z0-9]{4,10})\b/g, all + '\n' + inline + '\n' + noscript);
  T.ga4 = uniq(ids(/gtag\/js\?id=(G-[A-Z0-9]{6,12})/g, all).concat(ids(/['"](G-[A-Z0-9]{6,12})['"]/g, inline)));
  T.ua = ids(/\b(UA-\d{4,10}-\d{1,4})\b/g, all + '\n' + inline);
  T.ym = uniq(ids(/\bym\(\s*(\d{5,10})\s*,\s*['"]init['"]/g, inline).concat(ids(/yaCounter(\d{5,10})/g, inline), ids(/mc\.yandex\.ru\/watch\/(\d{5,10})/g, noscript + '\n' + inline)));
  T.ymScript = has(/mc\.yandex\.(ru|com)\/metrika\/(tag|watch)/) || /mc\.yandex\.(ru|com)\/metrika\/tag/.test(inline);
  T.fb = ids(/fbq\(\s*['"]init['"]\s*,\s*['"](\d{8,20})['"]/g, inline);
  T.fbScript = has(/connect\.facebook\.net\/[^/]+\/fbevents\.js/) || /fbevents\.js/.test(inline);
  T.vk = ids(/(VK-RTRG-\d+-[\w]+)/g, inline + '\n' + noscript);
  T.vkScript = has(/vk\.com\/js\/api\/openapi\.js|vk\.com\/rtrg/) || /vk\.com\/rtrg|VK\.Retargeting/.test(inline + noscript);
  T.tmr = ids(/_tmr\.push\(\s*\{\s*id:\s*["'](\d{5,10})["']/g, inline);
  T.tmrScript = has(/top-fwz1\.mail\.ru/) || /top-fwz1\.mail\.ru/.test(inline);
  T.tiktok = has(/analytics\.tiktok\.com/) || /ttq\.load\(/.test(inline);
  T.hotjar = has(/static\.hotjar\.com/) || /static\.hotjar\.com/.test(inline);
  T.clarity = has(/www\.clarity\.ms/) || /clarity\.ms\/tag/.test(inline);
  out.tech = T;

  // --- скорость ---
  const nav = performance.getEntriesByType('navigation')[0];
  out.nav = nav ? {
    name: nav.name, ttfb: nav.responseStart > 0 ? nav.responseStart - nav.startTime : null,
    dcl: nav.domContentLoadedEventEnd || null, load: nav.loadEventEnd || null,
    transfer: nav.transferSize, encoded: nav.encodedBodySize, decoded: nav.decodedBodySize,
    protocol: nav.nextHopProtocol || '', type: nav.type, redirects: nav.redirectCount,
    serverTiming: (nav.serverTiming || []).slice(0, 10).map((s) => ({ name: s.name, dur: s.duration, desc: s.description })),
  } : null;
  const fcp = performance.getEntriesByName('first-contentful-paint')[0];
  out.fcp = fcp ? fcp.startTime : null;
  const observe = (type) => new Promise((resolve) => {
    const list = [];
    let po;
    try { po = new PerformanceObserver((l) => { list.push(...l.getEntries()); }); po.observe({ type, buffered: true }); } catch (e) { resolve(null); return; }
    setTimeout(() => { try { list.push(...po.takeRecords()); po.disconnect(); } catch (e) { /* ничего */ } resolve(list); }, 150);
  });
  const [lcpList, clsList] = await Promise.all([observe('largest-contentful-paint'), observe('layout-shift')]);
  if (lcpList && lcpList.length) {
    const e = lcpList[lcpList.length - 1];
    out.lcp = { time: e.startTime || e.renderTime || e.loadTime, size: e.size, el: describe(e.element), url: e.url || '' };
  } else out.lcp = null;
  if (clsList) {
    // «Окна сессии» как в Core Web Vitals: разрыв больше 1 с или окно длиннее 5 с — новое окно; берём худшее.
    let max = 0, cur = 0, first = 0, last = 0;
    for (const e of clsList) {
      if (e.hadRecentInput) continue;
      if (cur && (e.startTime - last > 1000 || e.startTime - first > 5000)) { cur = 0; }
      if (!cur) first = e.startTime;
      cur += e.value; last = e.startTime;
      if (cur > max) max = cur;
    }
    out.cls = Math.round(max * 1000) / 1000;
  } else out.cls = null;
  const res = performance.getEntriesByType('resource');
  const kindOf = (e) => {
    const n = e.name.split(/[?#]/)[0].toLowerCase();
    const it = e.initiatorType;
    if (it === 'xmlhttprequest' || it === 'fetch' || it === 'beacon') return 'api';
    if (/\.(woff2?|ttf|otf|eot)$/.test(n)) return 'font';
    if (/\.css$/.test(n)) return 'css';
    if (/\.(m?js)$/.test(n) || it === 'script') return 'js';
    if (/\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/.test(n) || it === 'img' || it === 'image') return 'img';
    if (/\.(mp4|webm|mp3|m4a|ogg|m3u8|ts)$/.test(n) || it === 'video' || it === 'audio') return 'media';
    if (it === 'link' && /css/.test(n)) return 'css';
    return 'other';
  };
  const by = {};
  const third = {};
  let unknown = 0, mixed = 0;
  const heavy = [];
  for (const e of res) {
    const k = kindOf(e);
    const b = by[k] || (by[k] = { count: 0, transfer: 0, size: 0 });
    b.count++;
    b.transfer += e.transferSize || 0;
    b.size += e.encodedBodySize || 0;
    const sz = Math.max(e.transferSize || 0, e.encodedBodySize || 0);
    if (!sz && !e.decodedBodySize) unknown++;
    if (loc.protocol === 'https:' && /^http:/i.test(e.name)) mixed++;
    heavy.push([sz, e.name, k]);
    try { const h = new URL(e.name).hostname; if (h && h !== loc.hostname) third[h] = (third[h] || 0) + 1; } catch (er) { /* data: и т.п. */ }
  }
  heavy.sort((a, b) => b[0] - a[0]);
  out.resources = {
    count: res.length, by, unknown, mixed, full: res.length >= 250,
    heaviest: heavy.slice(0, 5).filter((x) => x[0] > 0).map((x) => ({ size: x[0], url: x[1], kind: x[2] })),
    thirdParty: Object.entries(third).sort((a, b) => b[1] - a[1]).slice(0, 10),
    thirdPartyHosts: Object.keys(third).length,
  };
  return out;
}

// ---------- выполняется в главном мире страницы: только чтение глобальных переменных ----------
function probe() {
  const w = window, o = {};
  const safe = (f) => { try { const v = f(); return v === undefined || v === null || v === false ? undefined : v; } catch (e) { return undefined; } };
  const str = (v) => (v == null || v === '' ? undefined : v === true ? true : String(v).slice(0, 40));
  o.jquery = safe(() => str((w.jQuery && w.jQuery.fn && w.jQuery.fn.jquery) || (w.$ && w.$.fn && w.$.fn.jquery)));
  o.react = safe(() => {
    if (w.React && w.React.version) return str(w.React.version);
    const hook = w.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (hook && hook.renderers && hook.renderers.size) for (const r of hook.renderers.values()) if (r && r.version) return str(r.version);
    const els = [document.getElementById('root'), document.getElementById('__next'), document.getElementById('app'), document.body && document.body.firstElementChild];
    for (const el of els) if (el) for (const k of Object.keys(el)) if (k.startsWith('__reactContainer$') || k.startsWith('__reactFiber$') || k === '_reactRootContainer') return true;
    const all = document.body ? document.body.getElementsByTagName('*') : [];
    for (let i = 0; i < all.length && i < 600; i++) for (const k of Object.keys(all[i])) if (k.startsWith('__reactFiber$') || k.startsWith('__reactProps$')) return true;
    return undefined;
  });
  o.next = safe(() => (w.next && w.next.version ? str(w.next.version) : w.__NEXT_DATA__ ? true : undefined));
  o.nuxt = safe(() => {
    if (w.$nuxt && w.$nuxt.$root && w.$nuxt.$root.constructor && w.$nuxt.$root.constructor.version) return true;
    return w.__NUXT__ || w.useNuxtApp || w.$nuxt ? true : undefined;
  });
  o.vue = safe(() => {
    if (w.Vue && w.Vue.version) return str(w.Vue.version);
    const els = [document.querySelector('[data-v-app]'), document.getElementById('app'), document.getElementById('__nuxt'), document.getElementById('root')];
    for (const el of els) {
      if (!el) continue;
      if (el.__vue_app__) return str(el.__vue_app__.version || '3');
      if (el.__vue__) { const c = el.__vue__.$root && el.__vue__.$root.constructor; return str((c && c.version) || '2'); }
    }
    return undefined;
  });
  o.angularjs = safe(() => w.angular && w.angular.version && str(w.angular.version.full));
  o.svelte = safe(() => (w.__svelte && w.__svelte.v ? str(Array.from(w.__svelte.v).join(', ')) : undefined));
  o.gtm = safe(() => (w.google_tag_manager ? Object.keys(w.google_tag_manager).filter((k) => /^(GTM|G|AW|DC|UA)-/.test(k)).slice(0, 20) : undefined));
  o.ym = safe(() => {
    const ids = new Set();
    try { if (w.Ya && w.Ya.Metrika2 && typeof w.Ya.Metrika2.counters === 'function') for (const c of w.Ya.Metrika2.counters()) if (c && c.id) ids.add(String(c.id)); } catch (e) { /* нет */ }
    try { if (w.Ya && w.Ya._metrika && w.Ya._metrika.counters) for (const k of Object.keys(w.Ya._metrika.counters)) { const m = /^(\d+)/.exec(k); if (m) ids.add(m[1]); } } catch (e) { /* нет */ }
    for (const k of Object.keys(w)) { const m = /^yaCounter(\d+)$/.exec(k); if (m) ids.add(m[1]); }
    try { if (w.ym && Array.isArray(w.ym.a)) for (const a of w.ym.a) if (a && /^\d{5,}$/.test(String(a[0]))) ids.add(String(a[0])); } catch (e) { /* нет */ }
    return ids.size ? Array.from(ids).slice(0, 20) : typeof w.ym === 'function' ? [] : undefined;
  });
  o.fb = safe(() => {
    if (!w.fbq) return undefined;
    const ids = new Set();
    try { const st = w.fbq.getState && w.fbq.getState(); if (st && st.pixels) for (const p of st.pixels) ids.add(String(p.id)); } catch (e) { /* нет */ }
    try { if (w.fbq.instance && w.fbq.instance.pixelsByID) for (const k of Object.keys(w.fbq.instance.pixelsByID)) ids.add(k); } catch (e) { /* нет */ }
    return Array.from(ids).slice(0, 20);
  });
  o.vk = safe(() => (w.VK && w.VK.Retargeting ? true : undefined));
  o.tmr = safe(() => (Array.isArray(w._tmr) ? w._tmr.filter((x) => x && x.id).map((x) => String(x.id)).slice(0, 20) : undefined));
  o.tiktok = safe(() => (w.ttq ? true : undefined));
  o.bitrix = safe(() => (w.BX ? true : undefined));
  o.tilda = safe(() => (typeof w.t_onReady === 'function' || typeof w.tildaForm === 'object' ? true : undefined));
  o.shopify = safe(() => (w.Shopify ? true : undefined));
  o.webflow = safe(() => (w.Webflow ? true : undefined));
  o.wp = safe(() => (w.wp || w.wpApiSettings ? true : undefined));
  return JSON.parse(JSON.stringify(o));
}

const COLLECT_SRC = '(' + collect.toString() + ')()';
const PROBE_SRC = '(' + probe.toString() + ')()';

// ---------- заголовки документа ----------
function lowerKeys(h) {
  const o = {};
  for (const [k, v] of Object.entries(h || {})) o[String(k).toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
  return o;
}
const noHash = (u) => String(u || '').split('#')[0];

async function documentHeaders(ctx, tab, url) {
  if (!/^https?:/i.test(url)) return { source: null, error: 'у локального файла нет HTTP-заголовков' };
  const cdp = ctx.cdp;
  if (cdp && typeof cdp.network === 'function' && typeof cdp.entry === 'function') {
    try {
      const list = cdp.network(tab.id, { type: 'doc', limit: 50 }) || [];
      let host = '';
      try { host = new URL(url).host; } catch (_) { /* нет */ }
      const ok = list.filter((e) => e && !e.failed && e.status);
      const cand = ok.filter((e) => noHash(e.url) === noHash(url)).pop() || ok.filter((e) => { try { return new URL(e.url).host === host; } catch (_) { return false; } }).pop();
      if (cand) {
        const e = await cdp.entry(tab.id, cand.id);
        if (e && e.responseHeaders && Object.keys(e.responseHeaders).length) {
          return { source: 'cdp', status: e.status, headers: lowerKeys(e.responseHeaders), protocol: e.protocol || '', remote: e.remote || null, url: e.url };
        }
      }
    } catch (_) { /* перейдём к повторному запросу */ }
  }
  const ses = tab.wc && !tab.wc.isDestroyed() ? tab.wc.session : null;
  if (!ses || typeof ses.fetch !== 'function') return { source: null, error: 'нет доступа к сети вкладки' };
  const once = async (method) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await ses.fetch(url, { method, signal: ctrl.signal, redirect: 'follow', cache: 'no-store' });
      const headers = {};
      r.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
      try { if (r.body) r.body.cancel(); } catch (_) { /* тело не нужно */ }
      return { status: r.status, headers, url: r.url };
    } finally { clearTimeout(t); }
  };
  try {
    let r = await once('HEAD');
    if ([400, 403, 404, 405, 501].includes(r.status)) r = await once('GET');
    return { source: 'fetch', status: r.status, headers: r.headers, url: r.url };
  } catch (e) {
    return { source: null, error: e.name === 'AbortError' ? 'сервер не ответил за 8 с' : String(e.message || e) };
  }
}

// ---------- отчёт ----------
const fmtMs = (ms) => (ms == null || !isFinite(ms) ? '—' : ms < 1000 ? Math.round(ms) + ' мс' : (Math.round(ms / 100) / 10).toString().replace('.', ',') + ' с');
function fmtBytes(b) {
  if (b == null || !isFinite(b)) return '—';
  if (b < 1024) return b + ' Б';
  const u = ['КБ', 'МБ', 'ГБ'];
  let v = b / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (v >= 100 ? Math.round(v) : Math.round(v * 10) / 10).toString().replace('.', ',') + ' ' + u[i];
}
// 1 тег, 2 тега, 5 тегов
function pl(n, f) { const m = n % 100, d = n % 10; return n + ' ' + (m > 10 && m < 20 ? f[2] : d === 1 ? f[0] : d > 1 && d < 5 ? f[1] : f[2]); }
const by3 = (v, ok, warn) => (v == null ? 'info' : v <= ok ? 'ok' : v <= warn ? 'warn' : 'bad');
const KIND = { js: 'Скрипты', css: 'Стили', img: 'Картинки', font: 'Шрифты', api: 'Запросы API', media: 'Медиа', other: 'Прочее' };

function seoSection(D, H) {
  const items = [];
  const add = (o) => items.push(o);
  // title
  if (D.title == null || !D.title) add({ label: 'Title', status: 'bad', value: 'нет' });
  else {
    const n = D.title.length;
    add({ label: 'Title', status: n < 10 ? 'warn' : n > 70 ? 'warn' : 'ok', value: `${n} симв. — ${D.title}`, hint: n > 70 ? 'длинный: в выдаче обрежется (лучше 30–65)' : n < 10 ? 'слишком короткий (лучше 30–65)' : '' });
  }
  // description
  if (D.description == null) add({ label: 'Description', status: 'bad', value: 'нет' });
  else {
    const n = D.description.length;
    add({ label: 'Description', status: n < 50 || n > 170 ? 'warn' : 'ok', value: `${n} симв. — ${D.description}`, hint: n < 50 ? 'короткое (лучше 70–160)' : n > 170 ? 'длинное: обрежется (лучше 70–160)' : '' });
  }
  // canonical
  if (!D.canonical) add({ label: 'Canonical', status: 'warn', value: 'не указан' });
  else if (D.canonicalCount > 1) add({ label: 'Canonical', status: 'bad', value: `${pl(D.canonicalCount, ['тег', 'тега', 'тегов'])} — должен быть один`, list: [D.canonical] });
  else if (noHash(D.canonical) !== noHash(D.url)) add({ label: 'Canonical', status: 'info', value: 'указывает на другой адрес: ' + D.canonical });
  else add({ label: 'Canonical', status: 'ok', value: 'совпадает с адресом страницы' });
  // robots
  const xr = H && H.headers ? H.headers['x-robots-tag'] : '';
  const robotsAll = [D.robots, ...Object.values(D.robotsBots || {}), xr].filter(Boolean).join(', ').toLowerCase();
  const robotsList = [];
  if (D.robots) robotsList.push('meta robots: ' + D.robots);
  for (const [k, v] of Object.entries(D.robotsBots || {})) robotsList.push(`meta ${k}: ${v}`);
  if (xr) robotsList.push('X-Robots-Tag: ' + xr);
  if (/noindex|none/.test(robotsAll)) add({ label: 'Robots', status: 'bad', value: 'noindex — страница закрыта от индексации', list: robotsList });
  else if (/nofollow/.test(robotsAll)) add({ label: 'Robots', status: 'warn', value: 'nofollow — ссылки не учитываются', list: robotsList });
  else add({ label: 'Robots', status: 'ok', value: robotsList.length ? robotsList.join('; ') : 'не задан — индексируется', list: robotsList.length > 1 ? robotsList : null });
  // lang, hreflang
  add({ label: 'Язык (lang)', status: D.lang ? 'ok' : 'warn', value: D.lang || 'не указан у <html>' });
  add({ label: 'Hreflang', status: 'info', value: D.hreflang.length ? pl(D.hreflang.length, ['вариант', 'варианта', 'вариантов']) : 'нет', list: D.hreflang.length ? D.hreflang.map((x) => `${x.lang} → ${x.href}`) : null });
  // h1
  if (!D.h1Count) add({ label: 'H1', status: 'bad', value: 'нет' });
  else if (D.h1Count > 1) add({ label: 'H1', status: 'warn', value: `${pl(D.h1Count, ['заголовок', 'заголовка', 'заголовков'])} — лучше один`, list: D.h1 });
  else add({ label: 'H1', status: D.h1[0] ? 'ok' : 'warn', value: D.h1[0] || 'пустой' });
  // структура
  let skips = 0, prev = 0;
  for (const h of D.outline) { if (prev && h.level > prev + 1) skips++; prev = h.level; }
  add({
    label: 'Структура H2–H3', status: skips ? 'warn' : D.headings.h2 ? 'ok' : 'info',
    value: `H2: ${D.headings.h2}, H3: ${D.headings.h3}` + (skips ? `, пропусков уровня: ${skips}` : ''),
    outline: D.outline.length ? D.outline : null,
  });
  // OG / Twitter
  const ogKeys = Object.keys(D.og);
  const ogMissing = ['og:title', 'og:description', 'og:image', 'og:url'].filter((k) => !D.og[k]);
  add({
    label: 'Open Graph', status: !ogKeys.length ? 'warn' : ogMissing.length ? 'warn' : 'ok',
    value: !ogKeys.length ? 'нет — ссылка в мессенджерах будет без превью' : ogMissing.length ? 'нет ' + ogMissing.join(', ') : pl(ogKeys.length, ['тег', 'тега', 'тегов']),
    list: ogKeys.length ? ogKeys.map((k) => `${k}: ${D.og[k]}`) : null,
  });
  const twKeys = Object.keys(D.twitter);
  add({ label: 'Twitter Card', status: D.twitter['twitter:card'] ? 'ok' : 'info', value: D.twitter['twitter:card'] || (ogKeys.length ? 'нет (подхватятся теги OG)' : 'нет'), list: twKeys.length ? twKeys.map((k) => `${k}: ${D.twitter[k]}`) : null });
  // JSON-LD
  const bad = D.jsonLd.filter((x) => !x.ok);
  const types = [...new Set(D.jsonLd.filter((x) => x.ok).flatMap((x) => x.types))];
  if (!D.jsonLd.length) add({ label: 'JSON-LD', status: 'info', value: D.microdata.length ? 'нет (есть микроразметка: ' + D.microdata.join(', ') + ')' : 'нет разметки' });
  else add({
    label: 'JSON-LD', status: bad.length ? 'bad' : 'ok',
    value: (bad.length ? `ошибок разбора: ${bad.length}; ` : '') + `блоков: ${D.jsonLd.length}` + (types.length ? ', типы: ' + types.slice(0, 12).join(', ') : ''),
    list: bad.length ? bad.map((x) => `${x.error} — ${x.start}`) : null,
  });
  // картинки
  const im = D.images;
  if (!im.total) add({ label: 'Картинки без alt', status: 'info', value: 'картинок нет' });
  else add({
    label: 'Картинки без alt', status: im.noAlt ? 'warn' : 'ok',
    value: im.noAlt ? `${im.noAlt} из ${im.total}` + (im.emptyAlt ? `, с пустым alt: ${im.emptyAlt}` : '') : `у всех ${im.total} есть alt` + (im.emptyAlt ? ` (пустой у ${im.emptyAlt})` : ''),
    list: im.samples.length ? im.samples : null,
  });
  // ссылки
  const L = D.links;
  add({
    label: 'Ссылки', status: 'info',
    value: `внутренних ${L.internal}, внешних ${L.external}` + (L.nofollow ? `, nofollow ${L.nofollow}` : '') + (L.sponsored ? `, sponsored ${L.sponsored}` : '') + (L.ugc ? `, ugc ${L.ugc}` : ''),
    list: L.topHosts.length ? L.topHosts.map(([h, n]) => `${h} — ${n}`) : null,
  });
  // viewport
  if (!D.viewport) add({ label: 'Viewport', status: 'bad', value: 'нет — страница не адаптирована под телефоны' });
  else if (/user-scalable\s*=\s*(no|0)|maximum-scale\s*=\s*1(\.0)?\b/i.test(D.viewport)) add({ label: 'Viewport', status: 'warn', value: D.viewport, hint: 'запрещено масштабирование' });
  else add({ label: 'Viewport', status: /width\s*=\s*device-width/i.test(D.viewport) ? 'ok' : 'warn', value: D.viewport });
  // favicon
  add({ label: 'Favicon', status: D.favicons.length ? 'ok' : 'warn', value: D.favicons.length ? D.favicons.map((f) => f.sizes || f.rel).join(', ') : 'не указана в HTML (браузер попробует /favicon.ico)', list: D.favicons.length ? D.favicons.map((f) => f.href) : null });
  add({ label: 'Документ', status: D.doctype ? 'ok' : 'warn', value: `${D.doctype ? '<!doctype ' + D.doctype + '>' : 'без doctype (режим совместимости)'}, ${D.charset}, элементов DOM: ${D.domSize}` });
  return { id: 'seo', title: 'SEO', items };
}

function techSection(D, P) {
  const T = D.tech || {};
  P = P || {};
  const items = [];
  const v = (x) => (x === true ? '' : x ? String(x) : '');
  const add = (label, value, group) => items.push({ label, status: 'info', value: value || 'есть', group });
  if (P.next || T.nextData || T.nextStatic) add('Next.js', v(P.next) ? 'версия ' + v(P.next) : '', 'Фреймворки');
  if (P.nuxt || T.nuxt) add('Nuxt', '', 'Фреймворки');
  if (P.react || T.reactRoot || P.next || T.nextData) add('React', v(P.react) ? 'версия ' + v(P.react) : '', 'Фреймворки');
  if (P.vue || T.vueApp || T.vueScoped || P.nuxt || T.nuxt) add('Vue', v(P.vue) ? 'версия ' + v(P.vue) : '', 'Фреймворки');
  if (T.ngVersion) add('Angular', 'версия ' + T.ngVersion, 'Фреймворки');
  if (P.angularjs || T.angularjs) add('AngularJS', v(P.angularjs) ? 'версия ' + v(P.angularjs) : '', 'Фреймворки');
  if (P.svelte || T.svelte) add('Svelte', v(P.svelte) ? 'версия ' + v(P.svelte) : '', 'Фреймворки');
  if (T.astro) add('Astro', '', 'Фреймворки');
  if (T.viteDev) add('Vite', 'dev-сервер', 'Фреймворки');
  else if (T.viteBuild) add('Vite', 'вероятно (сборка /assets/*-hash.js)', 'Фреймворки');
  if (P.jquery || T.jquerySrc) add('jQuery', v(P.jquery) ? 'версия ' + v(P.jquery) : T.jquerySrc && T.jquerySrc !== 'есть' ? 'версия ' + T.jquerySrc : '', 'Фреймворки');
  if (T.tilda || P.tilda) add('Tilda', '', 'Сайт');
  if (T.bitrix || P.bitrix) add('1С-Битрикс', '', 'Сайт');
  if (T.wordpress || P.wp) add('WordPress', /wordpress\s*([\d.]+)/i.test(D.generator || '') ? 'версия ' + /wordpress\s*([\d.]+)/i.exec(D.generator)[1] : '', 'Сайт');
  if (T.shopify || P.shopify) add('Shopify', '', 'Сайт');
  if (T.webflow || P.webflow) add('Webflow', '', 'Сайт');
  if (D.generator && !items.some((i) => D.generator.toLowerCase().includes(i.label.toLowerCase()))) add('Генератор', D.generator, 'Сайт');
  const gtm = [...new Set([...(T.gtm || []), ...((P.gtm || []).filter((x) => /^GTM-/.test(x)))])];
  const ga4 = [...new Set([...(T.ga4 || []), ...((P.gtm || []).filter((x) => /^G-/.test(x)))])];
  if (gtm.length) add('Google Tag Manager', gtm.join(', '), 'Аналитика');
  if (ga4.length) add('Google Analytics 4', ga4.join(', '), 'Аналитика');
  if (T.ua && T.ua.length) add('Universal Analytics', T.ua.join(', ') + ' (устарел)', 'Аналитика');
  const ym = [...new Set([...(T.ym || []), ...((Array.isArray(P.ym) ? P.ym : []))])];
  if (ym.length) add('Яндекс Метрика', 'счётчик ' + ym.join(', '), 'Аналитика');
  else if (T.ymScript || Array.isArray(P.ym)) add('Яндекс Метрика', 'подключена, номер счётчика не найден', 'Аналитика');
  if (T.hotjar) add('Hotjar', '', 'Аналитика');
  if (T.clarity) add('Microsoft Clarity', '', 'Аналитика');
  const fb = [...new Set([...(T.fb || []), ...(Array.isArray(P.fb) ? P.fb : [])])];
  if (fb.length || T.fbScript) add('Пиксель Meta (Facebook)', fb.join(', '), 'Пиксели');
  if ((T.vk && T.vk.length) || T.vkScript || P.vk) add('Пиксель VK', (T.vk || []).join(', '), 'Пиксели');
  const tmr = [...new Set([...(T.tmr || []), ...(Array.isArray(P.tmr) ? P.tmr : [])])];
  if (tmr.length || T.tmrScript) add('Top@Mail.ru', tmr.length ? 'счётчик ' + tmr.join(', ') : '', 'Пиксели');
  if (T.tiktok || P.tiktok) add('Пиксель TikTok', '', 'Пиксели');
  if (!items.length) items.push({ label: 'Не распознано', status: 'info', value: 'известных библиотек, CMS и счётчиков не найдено' });
  return { id: 'tech', title: 'Технологии', items };
}

function speedSection(D) {
  const N = D.nav || {};
  const R = D.resources || { by: {}, heaviest: [], count: 0 };
  const items = [];
  items.push({ label: 'TTFB', status: by3(N.ttfb, 800, 1800), value: fmtMs(N.ttfb), hint: 'время до первого байта ответа' });
  items.push({ label: 'FCP', status: by3(D.fcp, 1800, 3000), value: fmtMs(D.fcp), hint: 'первая отрисовка контента' });
  items.push({ label: 'LCP', status: D.lcp ? by3(D.lcp.time, 2500, 4000) : 'info', value: D.lcp ? fmtMs(D.lcp.time) + (D.lcp.el ? ' — ' + D.lcp.el : '') : 'нет данных (вкладка была в фоне?)', list: D.lcp && D.lcp.url ? [D.lcp.url] : null });
  items.push({ label: 'CLS', status: D.cls == null ? 'info' : by3(D.cls, 0.1, 0.25), value: D.cls == null ? 'нет данных' : String(D.cls).replace('.', ',') });
  items.push({ label: 'DOMContentLoaded', status: by3(N.dcl, 2500, 5000), value: fmtMs(N.dcl) });
  items.push({ label: 'Load', status: N.load ? by3(N.load, 3000, 7000) : 'info', value: N.load ? fmtMs(N.load) : 'ещё грузится' });
  const total = Object.values(R.by).reduce((s, b) => s + b.transfer, 0) + (N.transfer || 0);
  items.push({
    label: 'Документ', status: 'info',
    value: `${fmtBytes(N.transfer)} по сети, ${fmtBytes(N.decoded)} HTML` + (N.protocol ? `, ${N.protocol}` : '') + (N.redirects ? `, редиректов: ${N.redirects}` : ''),
    list: N.serverTiming && N.serverTiming.length ? N.serverTiming.map((s) => `Server-Timing ${s.name}: ${Math.round(s.dur)} мс${s.desc ? ' (' + s.desc + ')' : ''}`) : null,
  });
  items.push({
    label: 'Ресурсы', status: by3(R.count, 80, 150) === 'ok' && by3(total, 2 * 1048576, 5 * 1048576) === 'ok' ? 'ok' : by3(total, 2 * 1048576, 5 * 1048576) === 'bad' || by3(R.count, 80, 150) === 'bad' ? 'bad' : 'warn',
    value: `запросов: ${R.count}, по сети ${fmtBytes(total)}` + (R.unknown ? ` (размер ${R.unknown} сторонних неизвестен)` : '') + (R.full ? ', журнал браузера заполнен — показаны первые 250' : ''),
    rows: Object.entries(R.by).sort((a, b) => b[1].transfer - a[1].transfer).map(([k, b]) => [KIND[k] || k, String(b.count), fmtBytes(b.transfer)]),
    columns: ['Тип', 'Штук', 'По сети'],
  });
  if (R.heaviest.length) {
    items.push({
      label: 'Самые тяжёлые', status: 'info', value: R.heaviest.map((h) => fmtBytes(h.size)).join(', '),
      rows: R.heaviest.map((h) => [fmtBytes(h.size), KIND[h.kind] || h.kind, h.url]),
      columns: ['Размер', 'Тип', 'Адрес'],
    });
  }
  if (R.thirdPartyHosts) {
    items.push({ label: 'Сторонние домены', status: R.thirdPartyHosts > 20 ? 'warn' : 'info', value: String(R.thirdPartyHosts), list: R.thirdParty.map(([h, n]) => `${h} — ${n}`) });
  }
  return { id: 'speed', title: 'Скорость', items };
}

function cdnOf(h) {
  const server = (h.server || '').toLowerCase();
  const found = [];
  if (h['cf-ray'] || server.includes('cloudflare')) found.push('Cloudflare');
  if (h['x-amz-cf-id'] || /cloudfront/i.test(h.via || '')) found.push('Amazon CloudFront');
  if (h['x-served-by'] && /cache-/.test(h['x-served-by']) || h['x-fastly-request-id']) found.push('Fastly');
  if (h['x-akamai-transformed'] || server.includes('akamai') || h['akamai-grn']) found.push('Akamai');
  if (h['x-vercel-id'] || server === 'vercel') found.push('Vercel');
  if (h['x-nf-request-id'] || server.includes('netlify')) found.push('Netlify');
  if (server.includes('qrator')) found.push('Qrator');
  if (server.includes('ddos-guard')) found.push('DDoS-Guard');
  if (server.includes('ngenix')) found.push('NGENIX');
  if (server.includes('stormwall')) found.push('StormWall');
  if (h['x-cdn'] && !found.length) found.push(h['x-cdn']);
  if (h['x-varnish'] || /varnish/i.test(h.via || '')) found.push('Varnish (кэш)');
  if (server.includes('github.com') || h['x-github-request-id']) found.push('GitHub');
  return found;
}

function serverSection(D, H) {
  const items = [];
  if (!H || !H.headers) {
    items.push({ label: 'Заголовки', status: 'warn', value: 'недоступны: ' + ((H && H.error) || 'нет данных') });
    return { id: 'server', title: 'Сервер и CDN', items };
  }
  const h = H.headers;
  items.push({ label: 'Ответ', status: H.status >= 400 ? 'bad' : H.status >= 300 ? 'warn' : 'ok', value: String(H.status) + (H.source === 'fetch' ? ' (повторный запрос)' : '') });
  if (h.server) items.push({ label: 'Сервер', status: 'info', value: h.server });
  if (h['x-powered-by']) items.push({ label: 'X-Powered-By', status: 'info', value: h['x-powered-by'] });
  const cdn = cdnOf(h);
  items.push({ label: 'CDN и защита', status: 'info', value: cdn.length ? cdn.join(', ') : 'не распознаны' });
  const proto = (D.nav && D.nav.protocol) || H.protocol || '';
  if (proto) items.push({ label: 'Протокол', status: /^h[23]/.test(proto) ? 'ok' : 'info', value: proto + (h['alt-svc'] && /h3/.test(h['alt-svc']) && proto !== 'h3' ? ' (сервер умеет HTTP/3)' : '') });
  const remote = typeof H.remote === 'string' ? H.remote : H.remote && (H.remote.ip || H.remote.address) ? String(H.remote.ip || H.remote.address) + (H.remote.port ? ':' + H.remote.port : '') : '';
  if (remote) items.push({ label: 'IP сервера', status: 'info', value: remote });
  const enc = h['content-encoding'];
  items.push({ label: 'Сжатие', status: enc ? 'ok' : 'warn', value: enc || 'нет (HTML передаётся без сжатия)' });
  if (h['cache-control']) items.push({ label: 'Cache-Control', status: 'info', value: h['cache-control'] });
  return { id: 'server', title: 'Сервер и CDN', items };
}

function securitySection(D, H) {
  const items = [];
  const https = D.protocol === 'https:';
  items.push({ label: 'HTTPS', status: https ? 'ok' : D.protocol === 'file:' ? 'info' : 'bad', value: https ? 'да' : D.protocol === 'file:' ? 'локальный файл' : 'нет — данные идут открытым текстом' });
  if (D.resources && D.resources.mixed) items.push({ label: 'Смешанное содержимое', status: 'bad', value: `${pl(D.resources.mixed, ['ресурс', 'ресурса', 'ресурсов'])} по http на https-странице` });
  if (!H || !H.headers) {
    items.push({ label: 'Заголовки', status: 'warn', value: 'недоступны: ' + ((H && H.error) || 'нет данных') });
    return { id: 'security', title: 'Безопасность', items };
  }
  const h = H.headers;
  const csp = h['content-security-policy'];
  const cspRo = h['content-security-policy-report-only'];
  if (https) {
    const hsts = h['strict-transport-security'];
    const age = hsts ? Number((/max-age=(\d+)/i.exec(hsts) || [])[1] || 0) : 0;
    items.push({ label: 'HSTS', status: !hsts ? 'warn' : age < 15552000 ? 'warn' : 'ok', value: hsts || 'нет', hint: hsts && age < 15552000 ? 'max-age меньше полугода' : '' });
  }
  if (csp) {
    const dirs = csp.split(';').map((s) => s.trim()).filter(Boolean);
    const weak = /'unsafe-inline'/.test(csp) && /script-src|default-src/.test(csp) && !/'nonce-|'strict-dynamic'|'sha(256|384|512)-/.test(csp);
    items.push({ label: 'CSP', status: weak ? 'warn' : 'ok', value: pl(dirs.length, ['директива', 'директивы', 'директив']) + (weak ? ", скрипты: 'unsafe-inline'" : ''), list: dirs.map((x) => (x.length > 300 ? x.slice(0, 300) + '…' : x)) });
  } else if (cspRo) items.push({ label: 'CSP', status: 'warn', value: 'только Report-Only (не блокирует)', list: [cspRo.slice(0, 600)] });
  else items.push({ label: 'CSP', status: 'warn', value: 'нет' });
  const xfo = h['x-frame-options'];
  const fa = csp && /frame-ancestors/i.test(csp) ? (/frame-ancestors[^;]*/i.exec(csp) || [''])[0] : '';
  items.push({ label: 'X-Frame-Options', status: xfo || fa ? 'ok' : 'warn', value: xfo || (fa ? 'нет, но есть CSP ' + fa : 'нет — страницу можно встроить во фрейм') });
  const xcto = h['x-content-type-options'];
  items.push({ label: 'X-Content-Type-Options', status: /nosniff/i.test(xcto || '') ? 'ok' : 'warn', value: xcto || 'нет' });
  const rp = h['referrer-policy'];
  items.push({ label: 'Referrer-Policy', status: rp ? (/unsafe-url/i.test(rp) ? 'warn' : 'ok') : 'info', value: rp || 'нет (браузер использует strict-origin-when-cross-origin)' });
  if (h['permissions-policy']) items.push({ label: 'Permissions-Policy', status: 'ok', value: h['permissions-policy'].length > 160 ? h['permissions-policy'].slice(0, 160) + '…' : h['permissions-policy'] });
  return { id: 'security', title: 'Безопасность', items };
}

async function run(ctx, tab) {
  const t0 = Date.now();
  const wc = tab && tab.wc;
  if (!wc || wc.isDestroyed()) throw new Error('Вкладка выгружена — откройте её, чтобы она загрузилась');
  const url = wc.getURL();
  if (!isWebUrl(url)) throw new Error('Рентген работает на сайтах (http, https, file)');
  const [dom, probeRes, hdr] = await Promise.all([
    evalRaw(tab, COLLECT_SRC, { world: 'isolated', timeoutMs: 20000 }),
    evalRaw(tab, PROBE_SRC, { world: 'page', timeoutMs: 5000 }).catch((e) => ({ __error: String(e && e.message || e) })),
    documentHeaders(ctx, tab, url),
  ]);
  if (!dom || typeof dom !== 'object') throw new Error('Страница не ответила');
  const P = probeRes && !probeRes.__error ? probeRes : {};
  const notes = [];
  if (probeRes && probeRes.__error) notes.push('Глобальные переменные страницы прочитать не удалось: ' + probeRes.__error);
  if (hdr && hdr.source === 'fetch') notes.push('Заголовки получены повторным запросом страницы (запись сети для вкладки не велась).');
  if (dom.nav && dom.nav.name && noHash(dom.nav.name) !== noHash(dom.url)) notes.push('Скорость — для первой загрузки документа (' + dom.nav.name + '), адрес с тех пор сменился без перезагрузки.');
  return {
    url: dom.url, title: dom.title || wc.getTitle(), host: dom.host, at: Date.now(), ms: Date.now() - t0, tabId: tab.id,
    sections: [seoSection(dom, hdr), techSection(dom, P), speedSection(dom), serverSection(dom, hdr), securitySection(dom, hdr)],
    notes,
  };
}

module.exports = { run, documentHeaders, COLLECT_SRC, PROBE_SRC };
