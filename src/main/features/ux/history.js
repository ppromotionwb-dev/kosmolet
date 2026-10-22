'use strict';
// ux-chrome: история посещений (userData/history.json). Одна запись на адрес: {url, title, favicon, visitCount, lastVisit}.
// В памяти — индекс с заранее приведёнными к нижнему регистру строками: поиск по 10 000 записей — единицы миллисекунд.

const { describe, isWebUrl, stripHash } = require('./util');

const LIMIT = 10000;
const SLACK = 200;          // обрезаем пачкой, а не на каждую запись
const MAX_URL = 4096;
const MAX_TITLE = 500;
const HOUR = 3600000;

function cleanTitle(t) { return String(t || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE); }
function cleanFavicon(f) {
  const s = String(f || '');
  if (/^https?:\/\//i.test(s) && s.length < 1000) return s;
  if (/^data:image\//i.test(s) && s.length < 4000) return s;
  return '';
}

function createHistory(ctx) {
  // Файл читается и индекс строится лениво: при первом обращении или в простое после старта (не на холодном старте).
  let store = null;
  let data = null;
  function ensure() {
    if (data) return;
    const t0 = Date.now();
    // Запись всего файла (10 000 записей ≈ 1,6 МБ) стоит ~40 мс потока main — пишем не чаще раза в 15 с
    // (PERF-13); при выходе store.flushAll() дописывает остаток.
    store = ctx.store('history', { version: 1, entries: [], hidden: [] }, { pretty: false, debounceMs: 15000 });
    data = store.get();
    if (!data || typeof data !== 'object') data = { version: 1, entries: [], hidden: [] };
    if (!Array.isArray(data.entries)) data.entries = [];
    if (!Array.isArray(data.hidden)) data.hidden = [];
    rebuild();
    if (ctx.flags && ctx.flags.dev) ctx.log('ux-history', `история загружена: ${list.length} записей за ${Date.now() - t0} мс`);
  }

  const byUrl = new Map();      // url → x
  let list = [];                // [x]; x = {e, h, d, t, root, host}
  const hostFav = new Map();    // хост → favicon (последний известный)
  const listeners = new Set();

  function index(e) {
    const d = describe(e.url);
    const x = { e, host: d.hostBare, h: d.hostBare.toLowerCase(), d: d.dispBare.toLowerCase(), t: (e.title || '').toLowerCase(), root: d.root };
    if (e.favicon && x.host) hostFav.set(x.host, e.favicon);
    return x;
  }

  function rebuild() {
    byUrl.clear();
    list = [];
    for (const e of data.entries) {
      if (!e || typeof e.url !== 'string' || byUrl.has(e.url)) continue;
      e.visitCount = Math.max(1, Number(e.visitCount) || 1);
      e.lastVisit = Number(e.lastVisit) || 0;
      const x = index(e);
      byUrl.set(e.url, x);
      list.push(x);
    }
    data.entries = list.map((x) => x.e);
  }

  let changeTimer = null;
  function changed(reason) {
    store.set(data);
    if (changeTimer) return;
    changeTimer = setTimeout(() => {
      changeTimer = null;
      ctx.broadcast('kosmo:history.changed', { reason, count: list.length });
      for (const cb of listeners) { try { cb(reason); } catch (e) { ctx.log('ux-history', e); } }
    }, 1200);
  }

  function prune() {
    if (list.length <= LIMIT + SLACK) return;
    list.sort((a, b) => b.e.lastVisit - a.e.lastVisit);
    const drop = list.splice(LIMIT);
    for (const x of drop) byUrl.delete(x.e.url);
    data.entries = list.map((x) => x.e);
  }

  function recordable(url) {
    return typeof url === 'string' && url.length <= MAX_URL && isWebUrl(url);
  }

  // Посещение. opts: {title, favicon, reload, time}
  function visit(url, opts = {}) {
    if (!recordable(url)) return null;
    const t = Number(opts.time) || Date.now();
    let x = byUrl.get(url);
    if (x) {
      if (!opts.reload) x.e.visitCount++;
      x.e.lastVisit = t;
      if (opts.title) { x.e.title = cleanTitle(opts.title); x.t = x.e.title.toLowerCase(); }
    } else {
      const e = { url, title: cleanTitle(opts.title), favicon: cleanFavicon(opts.favicon), visitCount: 1, lastVisit: t };
      x = index(e);
      byUrl.set(url, x);
      list.push(x);
      data.entries.push(e);
      prune();
    }
    // скрытая с новой вкладки страница, открытая снова, остаётся скрытой (как в Chrome)
    changed('visit');
    return x.e;
  }

  function setTitle(url, title) {
    const x = byUrl.get(url);
    const tt = cleanTitle(title);
    if (!x || !tt || x.e.title === tt) return;
    x.e.title = tt;
    x.t = tt.toLowerCase();
    changed('title');
  }

  function setFavicon(url, favicon) {
    const x = byUrl.get(url);
    const f = cleanFavicon(favicon);
    if (!f) return;
    if (x && x.host) hostFav.set(x.host, f);
    if (!x || x.e.favicon === f) return;
    x.e.favicon = f;
    changed('favicon');
  }

  function add(entry) {
    if (!entry || !recordable(entry.url)) return null;
    return visit(entry.url, { title: entry.title, favicon: entry.favicon, time: entry.lastVisit || entry.visitTime });
  }

  function removeMany(urls) {
    let n = 0;
    const set = new Set(urls);
    if (!set.size) return 0;
    list = list.filter((x) => { if (set.has(x.e.url)) { byUrl.delete(x.e.url); n++; return false; } return true; });
    if (n) { data.entries = list.map((x) => x.e); changed('remove'); }
    return n;
  }
  function remove(url) { return removeMany(Array.isArray(url) ? url : [url]) > 0; }

  // clear() — всё; clear({since}) — посещённое начиная с метки времени
  function clear(opts = {}) {
    const since = Number(opts.since) || 0;
    const before = list.length;
    if (!since) { list = []; byUrl.clear(); } else {
      list = list.filter((x) => { if (x.e.lastVisit >= since) { byUrl.delete(x.e.url); return false; } return true; });
    }
    data.entries = list.map((x) => x.e);
    if (!since) data.hidden = [];
    changed('clear');
    return before - list.length;
  }

  // ---------- поиск ----------

  function terms(q) {
    return String(q || '').toLowerCase().trim().split(/\s+/).filter(Boolean).slice(0, 8);
  }

  // Качество совпадения одного слова: начало домена > начало части домена > начало слова в заголовке > подстрока.
  function termScore(x, t) {
    let s = 0;
    if (x.h.startsWith(t)) s = 1000;
    else if (x.h.includes('.' + t) || x.h.includes('-' + t)) s = 620;
    else if (x.d.includes(t)) s = x.d.indexOf(t) <= x.h.length ? 380 : 240;
    if (s < 520 && x.t) {
      const i = x.t.indexOf(t);
      if (i === 0 || (i > 0 && /[\s\-—:|«"(.,/]/.test(x.t[i - 1]))) s = Math.max(s, 520);
      else if (i > 0) s = Math.max(s, 260);
    }
    return s;
  }

  function frecency(e, now) {
    const ageH = Math.max(0, (now - e.lastVisit) / HOUR);
    return Math.log2(1 + e.visitCount) * 110 + 320 / (1 + ageH / 24);
  }

  // Ранжированный поиск (подсказки, ctx.history.search). Возвращает [{url, title, favicon, visitCount, lastVisit, score, strong}].
  function search(q, limit = 10) {
    const ts = terms(q);
    if (!ts.length) return recent(limit);
    const now = Date.now();
    const top = [];
    let minScore = -1;
    const cap = Math.max(1, Math.min(200, Number(limit) || 10));
    for (const x of list) {
      let s = 0;
      let strong = false;
      let ok = true;
      for (const t of ts) {
        const v = termScore(x, t);
        if (!v) { ok = false; break; }
        if (v >= 520) strong = true;
        s += v;
      }
      if (!ok) continue;
      s += frecency(x.e, now);
      if (x.root) s += 140;
      s -= Math.min(120, x.d.length / 3);
      if (top.length >= cap && s <= minScore) continue;
      top.push({ x, s, strong });
      if (top.length > cap) {
        top.sort((a, b) => b.s - a.s);
        top.length = cap;
        minScore = top[top.length - 1].s;
      }
    }
    top.sort((a, b) => b.s - a.s);
    return top.map(({ x, s, strong }) => out(x, { score: Math.round(s), strong }));
  }

  function out(x, extra) {
    const e = x.e;
    return Object.assign({
      url: e.url, title: e.title || '', favicon: e.favicon || hostFav.get(x.host) || '',
      visitCount: e.visitCount, lastVisit: e.lastVisit,
    }, extra || {});
  }

  function recent(limit = 20) {
    const cap = Math.max(1, Math.min(1000, Number(limit) || 20));
    return list.slice().sort((a, b) => b.e.lastVisit - a.e.lastVisit).slice(0, cap).map((x) => out(x));
  }

  // Для страницы истории: фильтр по словам (все слова в адресе или заголовке), новые сверху, постранично.
  function page(opts = {}) {
    const ts = terms(opts.q);
    const offset = Math.max(0, Number(opts.offset) || 0);
    const limit = Math.max(1, Math.min(1000, Number(opts.limit) || 200));
    let arr = list;
    if (ts.length) arr = list.filter((x) => ts.every((t) => x.d.includes(t) || x.t.includes(t)));
    arr = arr.slice().sort((a, b) => b.e.lastVisit - a.e.lastVisit);
    return { total: arr.length, offset, items: arr.slice(offset, offset + limit).map((x) => out(x)) };
  }

  // Часто посещаемые (новая вкладка): по посещениям и свежести, без скрытых и без дублей хоста-корня.
  function top(limit = 8, exclude) {
    // убранный с новой вкладки адрес скрывает весь сайт (плитки — по сайтам)
    const hiddenHosts = new Set(data.hidden.map((u) => describe(u).hostBare || u));
    const skip = exclude instanceof Set ? exclude : new Set(exclude || []);
    const now = Date.now();
    const scored = [];
    for (const x of list) {
      if (skip.has(x.e.url) || hiddenHosts.has(x.host || x.e.url)) continue;
      if (/^file:/i.test(x.e.url)) continue;
      const ageD = Math.max(0, (now - x.e.lastVisit) / (24 * HOUR));
      scored.push({ x, s: x.e.visitCount / (1 + ageD / 14) + (x.root ? 0.5 : 0) });
    }
    // один адрес на сайт: сайт целиком набирает вес всех своих страниц, показываем самую посещаемую
    const byHost = new Map();
    for (const it of scored) {
      const k = it.x.host || it.x.e.url;
      const cur = byHost.get(k);
      if (!cur) byHost.set(k, { best: it.x, s: it.s, bestS: it.s });
      else { cur.s += it.s; if (it.s > cur.bestS) { cur.best = it.x; cur.bestS = it.s; } }
    }
    return Array.from(byHost.values()).sort((a, b) => b.s - a.s).slice(0, limit).map((v) => out(v.best));
  }

  function hide(url) {
    if (!url || data.hidden.includes(url)) return false;
    data.hidden.push(String(url));
    if (data.hidden.length > 500) data.hidden.splice(0, data.hidden.length - 500);
    changed('hide');
    return true;
  }

  // ---------- инлайн-автодополнение ----------
  // Ввод без пробелов. Без «/» — дополняем домен; с «/» — адрес целиком. Возвращает {completion, url} или null.
  function complete(input) {
    const raw = String(input || '');
    if (!raw || /\s/.test(raw) || raw.length > 300) return null;
    const m = raw.match(/^(https?:\/\/)?(www\.)?(.*)$/i);
    const scheme = (m[1] || '').toLowerCase();
    const www = !!m[2];
    const rest = m[3].toLowerCase();
    if (!rest) return null;
    const now = Date.now();
    if (!rest.includes('/')) {
      // домены: сумма «весов» адресов сайта
      const hosts = new Map();
      for (const x of list) {
        if (!x.h || !x.h.startsWith(rest)) continue;
        if (scheme && !x.e.url.toLowerCase().startsWith(scheme)) continue;
        let hh = hosts.get(x.h);
        if (!hh) { hh = { host: x.host, w: 0, best: null, bestW: -1, rootUrl: null }; hosts.set(x.h, hh); }
        const w = frecency(x.e, now);
        hh.w += w;
        if (w > hh.bestW) { hh.bestW = w; hh.best = x; }
        if (x.root) hh.rootUrl = x.e.url;
      }
      let pick = null;
      for (const hh of hosts.values()) if (!pick || hh.w > pick.w || (hh.w === pick.w && hh.host.length < pick.host.length)) pick = hh;
      if (!pick) return null;
      if (pick.host.length <= rest.length) {
        // уже введён весь домен — дополнять нечего, но адрес для «перейти» знаем
        return { completion: raw, tail: '', url: pick.rootUrl || schemeOf(pick.best.e.url) + '://' + (www ? 'www.' : '') + pick.host + '/', host: pick.host };
      }
      const tail = pick.host.slice(rest.length);
      const url = pick.rootUrl || schemeOf(pick.best.e.url) + '://' + (www ? 'www.' : '') + pick.host + '/';
      const rootX = pick.rootUrl ? byUrl.get(pick.rootUrl) : null;
      return { completion: raw + tail, tail, url, host: pick.host, title: rootX ? rootX.e.title : '' };
    }
    // адрес целиком: самый «весомый», при равенстве — короче
    let best = null;
    let bestW = -1;
    for (const x of list) {
      if (!x.d.startsWith(rest) || x.d.length <= rest.length) continue;
      if (scheme && !x.e.url.toLowerCase().startsWith(scheme)) continue;
      const w = frecency(x.e, now) - x.d.length;
      if (w > bestW) { bestW = w; best = x; }
    }
    if (!best) return null;
    const disp = describe(best.e.url).dispBare;
    const tail = disp.slice(rest.length);
    return { completion: raw + tail, tail, url: best.e.url, title: best.e.title };
  }

  function schemeOf(url) { const m = /^([a-z]+):/i.exec(url); return m ? m[1].toLowerCase() : 'https'; }

  function get(url) { const x = byUrl.get(url); return x ? out(x) : null; }

  function faviconFor(url) {
    const x = byUrl.get(url) || byUrl.get(stripHash(url));
    if (x && x.e.favicon) return x.e.favicon;
    const d = describe(url);
    return hostFav.get(d.hostBare) || '';
  }

  const api = {
    visit, add, setTitle, setFavicon, remove, removeMany, clear, search, recent, page, top, hide, complete, get, faviconFor,
    count: () => list.length,
    flush: () => store.flush(),
    _bench(n) {
      // для проверки скорости: n синтетических записей (не сохраняются)
      const saved = data.entries.slice();
      const words = ['seller', 'wildberries', 'ozon', 'market', 'github', 'claude', 'docs', 'api', 'news', 'shop', 'avito', 'yandex'];
      const tlds = ['ru', 'com', 'org', 'io', 'net'];
      for (let i = 0; i < n; i++) {
        const host = words[i % words.length] + (i % 97) + '.' + tlds[i % tlds.length];
        visit('https://' + host + '/page/' + i + '?q=' + (i * 7919 % 1000), { title: 'Страница ' + words[(i * 3) % words.length] + ' ' + i, time: Date.now() - i * 60000 });
      }
      return { restore() { data.entries = saved; rebuild(); store.set(data); } };
    },
  };
  for (const k of Object.keys(api)) {
    const f = api[k];
    api[k] = (...args) => { ensure(); return f(...args); };
  }
  api.onChange = (cb) => { listeners.add(cb); return () => listeners.delete(cb); };
  api.loaded = () => !!data;
  // загрузить в простое: delay мс после вызова
  api.warm = (delay, cb) => {
    const t = setTimeout(() => {
      const was = !!data;
      try { ensure(); } catch (e) { ctx.log('ux-history', e.message); return; }
      if (!was && cb) cb();
    }, delay || 0);
    if (t.unref) t.unref();
  };
  return api;
}

module.exports = { createHistory };
