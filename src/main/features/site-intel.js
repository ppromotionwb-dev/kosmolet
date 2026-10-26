'use strict';
// Фича «site-intel»: браузер копит знания о сайтах между сессиями.
// 1. Автокаталог API: завершённые XHR/fetch из ctx.cdp ('entry') → эндпоинты «метод + хост + шаблон пути» по сайту
//    (регистрируемый домен страницы вкладки): query-параметры с примерами (токены замаскированы), схемы JSON тела
//    запроса и ответа (только ключи и типы), статусы, страницы, «заметные» заголовки (только имена), тип авторизации.
// 2. Какое действие что вызвало: действия пользователя из tab-preload (kosmo-tab:intel.action) и Claude
//    (ctx.siteIntel.noteAction) → запросы в течение 2 с после действия в той же вкладке привязываются к нему.
// 3. Память агента: заметки по сайту.
// Хранилище: userData/site-intel/<site>.json (атомарная запись с дебаунсом). Всё только локально.
// Настройки: siteIntel {enabled, exclude}. API: ctx.siteIntel (см. конец файла), IPC kosmo:siteIntel.*.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const S = require('./site-intel/shape');

const ACTION_WINDOW = 2000;      // запросы, начатые в течение 2 с после действия
const ACTION_EARLY = 300;        // запрос мог стартовать чуть раньше, чем main получил IPC о клике
const MERGE_WINDOW = 1500;       // событие страницы после действия Claude — то же действие
const PROCESS_DELAY = 350;       // ждём IPC о действии, прежде чем привязывать запросы
const MAX_ENDPOINTS = 300;
const MAX_NOTES = 200;
const MAX_PAGES = 8;
const MAX_ACTIONS = 12;
const MAX_INITS = 6;
const MAX_SAMPLES = 5;
const JOURNAL = 50;
const JOURNAL_REQ = 40;
const BODY_MAX = 1024 * 1024;
const BODY_SAMPLES = 3;
const BODY_EVERY = 24 * 3600 * 1000;
const BODY_RATE_MS = 250;        // не чаще 4 тел в секунду
const BODY_QUEUE = 40;
const REQ_BODY_MAX = 256 * 1024;
const WRITE_DEBOUNCE = 1500;
const LOADED_MAX = 16;
const NOTE_MAX = 2000;
const ACTION_RATE = 5;           // действий в секунду на вкладку

const API_TYPES = new Set(['XHR', 'Fetch']);
const TRACKER_HOSTS = ['google-analytics.com', 'analytics.google.com', 'googletagmanager.com', 'doubleclick.net', 'googlesyndication.com',
  'mc.yandex.ru', 'mc.yandex.com', 'mc.webvisor.org', 'an.yandex.ru', 'top-fwz1.mail.ru', 'sentry.io', 'hotjar.com', 'clarity.ms',
  'criteo.com', 'criteo.net', 'adfox.ru', 'facebook.net', 'connect.facebook.net', 'tiktok.com', 'vk.com/rtrg'];
const ACTION_KINDS = new Set(['click', 'submit', 'enter', 'change']);

function now() { return Date.now(); }
const clip = S.clip;
function str(v, n) { return v == null ? '' : clip(String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim(), n); }
function newId(prefix) { return prefix + now().toString(36) + crypto.randomBytes(3).toString('hex'); }

function init(ctx) {
  const Set_ = ctx.settings;
  Set_.addDefaults({ siteIntel: { enabled: true, exclude: [] } });
  const dir = path.join(ctx.paths.userData, 'site-intel');

  const enabled = () => Set_.peek('siteIntel.enabled') !== false;
  function excludeList() {
    const v = Set_.peek('siteIntel.exclude');
    return Array.isArray(v) ? v.map((x) => String(x || '').trim().toLowerCase().replace(/^\*\./, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean) : [];
  }
  function excluded(host, site) {
    host = String(host || '').toLowerCase();
    for (const p of excludeList()) if (site === p || host === p || host.endsWith('.' + p)) return true;
    return false;
  }
  const isTracker = (host) => TRACKER_HOSTS.some((t) => host === t || host.endsWith('.' + t));

  const stats = { entries: 0, processed: 0, skipped: 0, bodies: 0, bodyErrors: 0, reqBodies: 0, ms: 0, msMax: 0, bodyMs: 0, bodyMsMax: 0, writes: 0, actions: 0 };

  // ---------- хранилище ----------
  const docs = new Map(); // site → {doc, dirty, timer, lastUse, writing}
  function fileOf(site) { return path.join(dir, S.siteFile(site) + '.json'); }
  function emptyDoc(site) { return { v: 1, site, created: now(), updated: now(), endpoints: {}, notes: [] }; }

  function load(site, create) {
    if (!site) return null;
    let d = docs.get(site);
    if (d) { d.lastUse = now(); return d.doc; }
    let doc = null;
    try {
      const raw = fs.readFileSync(fileOf(site), 'utf8');
      doc = JSON.parse(raw);
      if (!doc || typeof doc !== 'object' || !doc.endpoints) doc = null;
    } catch (e) {
      if (e.code !== 'ENOENT') ctx.log('site-intel', `файл сайта ${site} не прочитан:`, e.message);
    }
    if (!doc) { if (!create) return null; doc = emptyDoc(site); }
    if (!Array.isArray(doc.notes)) doc.notes = [];
    doc.site = site;
    d = { doc, dirty: false, timer: null, lastUse: now(), writing: Promise.resolve() };
    docs.set(site, d);
    evict();
    return doc;
  }
  function evict() {
    if (docs.size <= LOADED_MAX) return;
    const list = Array.from(docs.entries()).sort((a, b) => a[1].lastUse - b[1].lastUse);
    for (const [site, d] of list) {
      if (docs.size <= LOADED_MAX) break;
      if (d.dirty) writeSync(site, d);
      if (d.timer) clearTimeout(d.timer);
      docs.delete(site);
    }
  }
  function touch(site) {
    const d = docs.get(site);
    if (!d) return;
    d.doc.updated = now();
    d.dirty = true;
    if (!d.timer) d.timer = setTimeout(() => { d.timer = null; writeAsync(site, d); }, WRITE_DEBOUNCE);
    changed(site);
  }
  function serialize(doc) { return JSON.stringify(doc); }
  function renameRetry(tmp, file) {
    for (let i = 0; i < 5; i++) {
      try { fs.renameSync(tmp, file); return; } catch (e) {
        if (i === 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
        const until = Date.now() + 20 * (i + 1);
        while (Date.now() < until) { /* антивирус держит файл */ }
      }
    }
  }
  function writeAsync(site, d) {
    if (!d.dirty || docs.get(site) !== d) return;
    d.dirty = false;
    const text = serialize(d.doc);
    const file = fileOf(site);
    d.writing = d.writing.then(async () => {
      await fs.promises.mkdir(dir, { recursive: true });
      const tmp = file + '.tmp-a';
      await fs.promises.writeFile(tmp, text, 'utf8');
      if (docs.get(site) !== d) { fs.promises.unlink(tmp).catch(() => {}); return; } // сайт забыли во время записи
      renameRetry(tmp, file);
      stats.writes++;
    }).catch((e) => ctx.log('site-intel', `запись ${site}:`, e.message));
  }
  function writeSync(site, d) {
    if (!d.dirty) return;
    d.dirty = false;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = fileOf(site);
      const tmp = file + '.tmp-s';
      fs.writeFileSync(tmp, serialize(d.doc), 'utf8');
      renameRetry(tmp, file);
      stats.writes++;
    } catch (e) { ctx.log('site-intel', `запись ${site}:`, e.message); }
  }
  function flushAll() {
    for (const [site, d] of docs) { if (d.timer) { clearTimeout(d.timer); d.timer = null; } writeSync(site, d); }
  }
  ctx.app.on('before-quit', flushAll);

  const changeTimers = new Map();
  function changed(site) {
    if (changeTimers.has(site)) return;
    changeTimers.set(site, setTimeout(() => { changeTimers.delete(site); ctx.broadcast('kosmo:siteIntel.changed', { site }); }, 1000));
  }

  // ---------- вкладки ----------
  function tabUrl(tabId) {
    const t = ctx.tabs.get(tabId);
    if (!t) return '';
    const wc = t.wc;
    return (wc && !wc.isDestroyed() && wc.getURL()) || t.info.url || '';
  }
  function siteForUrl(u) {
    if (!/^https?:/i.test(String(u || ''))) return '';
    return S.siteOf(u);
  }
  function pageTemplate(u) {
    try { const x = new URL(u); return x.host + S.pathTemplate(x.pathname); } catch (_) { return ''; }
  }

  // ---------- журнал действий ----------
  const journals = new Map(); // tabId → {actions: [], rate: []}
  function journal(tabId) {
    let j = journals.get(tabId);
    if (!j) { j = { actions: [], rate: [] }; journals.set(tabId, j); }
    return j;
  }
  ctx.tabs.on('closed', (t) => { journals.delete(t.id); });

  function addAction(tabId, a) {
    const j = journal(tabId);
    j.actions.push(a);
    if (j.actions.length > JOURNAL) j.actions.splice(0, j.actions.length - JOURNAL);
    stats.actions++;
    return a;
  }

  // Действие Claude (мост MCP) — до отправки ввода, чтобы запросы привязались к нему.
  function noteAction(tabId, label, source, extra) {
    tabId = Number(tabId);
    if (!enabled() || !ctx.tabs.get(tabId)) return null;
    const url = tabUrl(tabId);
    if (!/^https?:/i.test(url)) return null;
    const e = extra || {};
    return addAction(tabId, {
      id: newId('a'), ts: now(), source: source === 'user' ? 'user' : 'claude', kind: ACTION_KINDS.has(e.kind) ? e.kind : String(e.kind || 'action').slice(0, 20),
      label: str(label, 60) || '(action)', tag: str(e.tag, 30), role: str(e.role, 30), sel: str(e.sel, 120),
      page: pageTemplate(url), site: siteForUrl(url), requests: [], merged: false,
    });
  }

  // Действие из страницы (недоверенные данные).
  function onPageAction(p, meta) {
    if (!enabled() || !meta || !meta.tab || !p || typeof p !== 'object') return;
    const tabId = meta.tab.id;
    const url = tabUrl(tabId);
    if (!/^https?:/i.test(url)) return;
    try { if (meta.frameUrl && new URL(meta.frameUrl).origin !== new URL(url).origin) return; } catch (_) { return; }
    const kind = String(p.kind || '');
    if (!ACTION_KINDS.has(kind)) return;
    const j = journal(tabId);
    const t = now();
    j.rate = j.rate.filter((x) => t - x < 1000);
    if (j.rate.length >= ACTION_RATE) return;
    j.rate.push(t);
    const label = str(p.label, 60);
    const tag = /^[a-z][a-z0-9-]{0,29}$/i.test(String(p.tag || '')) ? String(p.tag).toLowerCase() : '';
    const role = /^[a-z-]{0,30}$/i.test(String(p.role || '')) ? String(p.role || '').toLowerCase() : '';
    const sel = str(p.sel, 120);
    // клик Claude приходит в страницу как настоящий — это то же действие
    for (let i = j.actions.length - 1; i >= 0; i--) {
      const a = j.actions[i];
      if (t - a.ts > MERGE_WINDOW) break;
      if (a.source === 'claude' && !a.merged) {
        a.merged = true;
        if (label) { if (a.label !== label) a.claudeLabel = a.label; a.label = label; }
        a.tag = tag || a.tag; a.role = role || a.role; a.sel = sel || a.sel;
        if (kind === 'submit' || kind === 'enter' || kind === 'change') a.kind = kind;
        return;
      }
    }
    addAction(tabId, { id: newId('a'), ts: t, source: 'user', kind, label: label || '(' + (tag || kind) + ')', tag, role, sel, page: pageTemplate(url), site: siteForUrl(url), requests: [], merged: true });
  }
  ctx.ipc.on('kosmo-tab:intel.action', onPageAction, { allow: ['tab'] });

  function actionFor(tabId, ts) {
    const j = journals.get(tabId);
    if (!j || !ts) return null;
    for (let i = j.actions.length - 1; i >= 0; i--) {
      const a = j.actions[i];
      if (a.ts <= ts + ACTION_EARLY) return ts - a.ts <= ACTION_WINDOW ? a : null;
    }
    return null;
  }

  // ---------- каталог: обработка запросов ----------
  const pending = [];
  let pendTimer = null;
  function onEntry(tabId, e) {
    if (!enabled() || !e || e.marker || e.pending) return;
    stats.entries++;
    pending.push({ tabId, e, at: now() });
    if (pending.length > 500) pending.splice(0, pending.length - 500);
    if (!pendTimer) pendTimer = setTimeout(drain, PROCESS_DELAY);
  }
  function drain() {
    pendTimer = null;
    const t0 = process.hrtime.bigint();
    const cutoff = now() - PROCESS_DELAY + 20;
    let i = 0;
    for (; i < pending.length; i++) {
      if (pending[i].at > cutoff) break;
      try { processEntry(pending[i].tabId, pending[i].e); } catch (err) { ctx.log('site-intel', 'запрос:', err && err.stack || err); }
    }
    pending.splice(0, i);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    stats.ms += ms; stats.msMax = Math.max(stats.msMax, ms);
    if (pending.length && !pendTimer) pendTimer = setTimeout(drain, Math.max(20, pending[0].at + PROCESS_DELAY - now()));
  }

  function acceptMime(mime, status) {
    const m = String(mime || '').toLowerCase();
    if (status === 204 && !m) return true;
    if (/javascript|ecmascript|text\/css/.test(m)) return false;
    return /json|^text\/|xml|graphql|x-www-form-urlencoded|x-ndjson/.test(m);
  }

  function processEntry(tabId, e) {
    if (e.failed || e.redirect || !e.status || e.kind === 'ws') { stats.skipped++; return; }
    const isJson = /json/i.test(e.mime || '');
    if (!API_TYPES.has(e.type) && !(e.type === 'Other' && isJson)) { stats.skipped++; return; }
    if (!acceptMime(e.mime, e.status)) { stats.skipped++; return; }
    let u;
    try { u = new URL(e.url); } catch (_) { stats.skipped++; return; }
    if (!/^https?:$/.test(u.protocol)) { stats.skipped++; return; }
    const page = tabUrl(tabId);
    const site = siteForUrl(page);
    if (!site) { stats.skipped++; return; }
    const host = u.host.toLowerCase();
    if (isTracker(u.hostname) || excluded(new URL(page).hostname, site) || excluded(u.hostname, S.siteOf(u.hostname))) { stats.skipped++; return; }
    const doc = load(site, true);
    const method = String(e.method || 'GET').toUpperCase().slice(0, 16);
    const tpl = S.pathTemplate(u.pathname);
    const key = method + ' ' + host + tpl;
    let ep = doc.endpoints[key];
    const t = now();
    if (!ep) {
      const keys = Object.keys(doc.endpoints);
      if (keys.length >= MAX_ENDPOINTS) {
        let old = keys[0];
        for (const k of keys) if ((doc.endpoints[k].last || 0) < (doc.endpoints[old].last || 0)) old = k;
        delete doc.endpoints[old];
      }
      ep = doc.endpoints[key] = { key, method, host, path: tpl, q: {}, count: 0, first: t, last: t, status: {}, mime: {}, types: {}, pages: {}, headers: {}, auth: { cookie: 0, bearer: 0, basic: 0, none: 0, headers: {} }, actions: {}, inits: {}, samples: [], reqType: '', reqN: 0, resN: 0, resAt: 0, reqAt: 0 };
    }
    ep.count++;
    ep.last = t;
    inc(ep.status, String(e.status));
    if (e.mime) inc(ep.mime, String(e.mime).slice(0, 60), 4);
    inc(ep.types, e.type, 4);
    S.mergeQuery(ep.q, u.searchParams);
    const pt = pageTemplate(page);
    if (pt) inc(ep.pages, pt, MAX_PAGES);
    ep.samples = [{ tab: tabId, id: e.id, ts: e.ts || t }].concat((ep.samples || []).filter((x) => !(x.tab === tabId && x.id === e.id))).slice(0, MAX_SAMPLES);

    // заголовки — только имена
    const raw = ctx.cdp && typeof ctx.cdp.raw === 'function' ? ctx.cdp.raw(tabId, e.id) : null;
    const headers = raw ? (raw.reqHeadersExtra || raw.reqHeaders || {}) : {};
    for (const n of S.headerNames(headers)) inc(ep.headers, n, 24);
    const a = S.authOf(headers);
    if (a.cookie) ep.auth.cookie++;
    if (a.bearer) ep.auth.bearer++;
    if (a.basic) ep.auth.basic++;
    if (!a.cookie && !a.bearer && !a.basic && !a.headers.length) ep.auth.none++;
    for (const h of a.headers) inc(ep.auth.headers, h, 8);
    let ct = '';
    for (const [k, v] of Object.entries(headers)) if (String(k).toLowerCase() === 'content-type') ct = String(v || '').split(';')[0].trim().toLowerCase().slice(0, 80);
    if (ct) ep.reqType = ct;

    // тело запроса: схема (значения не храним)
    if (raw && (ep.reqN < BODY_SAMPLES + 2 || t - (ep.reqAt || 0) > BODY_EVERY)) {
      const pd = typeof raw.postData === 'string' ? raw.postData : null;
      if (pd && pd.length <= REQ_BODY_MAX) {
        const sc = bodySchema(pd, ct);
        if (sc) { ep.req = ep.req ? S.merge(ep.req, sc) : sc; ep.reqN++; ep.reqAt = t; stats.reqBodies++; }
      }
    }
    // тело ответа — лениво и с ограничением частоты
    // JSON бывает и с text/plain (у некоторых магазинов) — тело проверяется после чтения
    const maybeJson = isJson || /^text\/plain/i.test(e.mime || '');
    if (maybeJson && (e.size || 0) <= BODY_MAX && (ep.resN < BODY_SAMPLES || t - (ep.resAt || 0) > BODY_EVERY)) queueBody(site, key, tabId, e.id);

    // действие
    const act = actionFor(tabId, e.ts);
    if (act) {
      let r = ep.actions[act.label];
      if (!r) {
        trim(ep.actions, MAX_ACTIONS - 1, (x) => x.n);
        r = ep.actions[act.label] = { n: 0, user: 0, claude: 0, last: 0 };
      }
      r.n++; r[act.source] = (r[act.source] || 0) + 1; r.last = t;
      if (act.requests.length < JOURNAL_REQ) act.requests.push({ id: e.id, key, method, url: clip(urlShort(u), 200), status: e.status });
    }
    // JS-инициатор
    const fr = topFrame(e.initiator);
    if (fr) inc(ep.inits, fr, MAX_INITS);
    stats.processed++;
    touch(site);
  }

  function urlShort(u) { return u.host + u.pathname + (u.search ? '?' + Array.from(u.searchParams.keys()).slice(0, 8).join('&') : ''); }
  function topFrame(i) {
    if (!i) return '';
    const st = Array.isArray(i.stack) && i.stack.length ? i.stack[0] : i;
    if (!st || !st.url) return '';
    let file = String(st.url);
    try { const x = new URL(file); file = x.host + x.pathname; } catch (_) { /* как есть */ }
    return clip((st.fn ? st.fn : '(anonymous)') + ' @ ' + clip(file, 140) + (st.line ? ':' + st.line : ''), 200);
  }
  function inc(map, k, cap) {
    if (!k) return;
    if (map[k] == null && cap && Object.keys(map).length >= cap) {
      // вытесняем самый редкий
      let min = null;
      for (const x of Object.keys(map)) if (min == null || map[x] < map[min]) min = x;
      if (min != null && map[min] > 1) return; // все частые — новый не берём
      delete map[min];
    }
    map[k] = (map[k] || 0) + 1;
  }
  function trim(map, max, score) {
    const keys = Object.keys(map);
    if (keys.length <= max) return;
    keys.sort((a, b) => score(map[a]) - score(map[b]));
    for (const k of keys.slice(0, keys.length - max)) delete map[k];
  }
  function bodySchema(text, ct) {
    const s = String(text).trim();
    if (!s) return null;
    if (/json/.test(ct) || /^[[{]/.test(s)) {
      try { return S.schemaFrom(JSON.parse(s)); } catch (_) { return null; }
    }
    if (/x-www-form-urlencoded/.test(ct) || (!ct && /^[\w.%-]+=[^&]*(&[\w.%-]+=[^&]*)*$/.test(s))) {
      const o = {};
      try { for (const [k] of new URLSearchParams(s)) o[clip(k, 80)] = ''; } catch (_) { return null; }
      return Object.keys(o).length ? S.schemaFrom(o) : null;
    }
    return null;
  }

  // ---------- тела ответов ----------
  const bodyQueue = [];
  const bodyPending = new Set();
  let bodyTimer = null;
  function queueBody(site, key, tabId, id) {
    const k = site + '|' + key;
    if (bodyPending.has(k) || bodyQueue.length >= BODY_QUEUE) return;
    bodyPending.add(k);
    bodyQueue.push({ site, key, tabId, id, k });
    if (!bodyTimer) bodyTimer = setTimeout(bodyStep, 30);
  }
  async function bodyStep() {
    bodyTimer = null;
    const job = bodyQueue.shift();
    if (!job) return;
    try {
      const b = await ctx.cdp.body(job.tabId, job.id, { limit: BODY_MAX + 1 });
      if (b && !b.base64Encoded && !b.truncated && b.body && b.body.length <= BODY_MAX) {
        const t0 = process.hrtime.bigint();
        let sc = null;
        if (/^\s*[[{]/.test(b.body.slice(0, 64))) { try { sc = S.schemaFrom(JSON.parse(b.body)); } catch (_) { sc = null; } }
        const doc = sc ? load(job.site, false) : null;
        const ep = doc && doc.endpoints[job.key];
        if (ep) { ep.res = ep.res ? S.merge(ep.res, sc) : sc; ep.resN = (ep.resN || 0) + 1; ep.resAt = now(); touch(job.site); stats.bodies++; }
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        stats.bodyMs += ms; stats.bodyMsMax = Math.max(stats.bodyMsMax, ms);
      }
    } catch (_) { stats.bodyErrors++; }
    bodyPending.delete(job.k);
    if (bodyQueue.length && !bodyTimer) bodyTimer = setTimeout(bodyStep, BODY_RATE_MS);
  }

  if (ctx.cdp && typeof ctx.cdp.on === 'function') ctx.cdp.on('entry', onEntry);
  else ctx.log('site-intel', 'ctx.cdp недоступен — каталог API не собирается');

  // ---------- чтение ----------
  function resolveSite(o) {
    o = o || {};
    if (o.site) {
      const s = String(o.site).trim();
      const site = /^[a-z]+:\/\//i.test(s) ? S.siteOf(s) : S.siteOf(s.split('/')[0]);
      if (!S.validSite(site)) throw new Error('bad site: ' + s);
      return site;
    }
    let tabId = o.tabId;
    if (tabId == null) { const a = ctx.tabs.active(); tabId = a ? a.id : null; }
    if (tabId == null || !ctx.tabs.get(tabId)) throw new Error('no such tab');
    const site = siteForUrl(tabUrl(tabId));
    if (!site) throw new Error('the tab is not on an http(s) site');
    return site;
  }

  function sortedEndpoints(doc) {
    return Object.values(doc.endpoints).sort((a, b) => (b.count - a.count) || (b.last - a.last) || (a.key < b.key ? -1 : 1));
  }
  function topAction(ep) {
    const list = Object.entries(ep.actions || {}).sort((a, b) => b[1].n - a[1].n);
    return list.map(([label, r]) => ({ label, n: r.n, user: r.user || 0, claude: r.claude || 0, last: r.last }));
  }
  function authSummary(ep) {
    const a = ep.auth || {};
    return S.authText({ cookie: a.cookie > 0, bearer: a.bearer > 0, basic: a.basic > 0, headers: a.headers || {} });
  }
  function queryTemplate(ep, maxParams = 8) {
    // сначала меняющиеся параметры (query, page, sort), потом постоянные
    const all = Object.keys(ep.q || {});
    const names = all.filter((n) => ep.q[n].varies).concat(all.filter((n) => !ep.q[n].varies));
    if (!names.length) return '';
    const parts = names.slice(0, maxParams).map((n) => {
      const p = ep.q[n];
      let v;
      if (p.masked) v = '{secret}';
      else if (!p.varies && p.ex[0] != null && p.ex[0].length <= 20 && !/[&=?#\s]/.test(p.ex[0])) v = p.ex[0];
      else v = p.type === 'number' ? '{n}' : p.type === 'bool' ? '{bool}' : '{q}';
      return n + '=' + v;
    });
    return '?' + parts.join('&') + (names.length > maxParams ? '&…' : '');
  }
  function summaryOf(ep, index) {
    const acts = topAction(ep);
    return {
      index, key: ep.key, method: ep.method, host: ep.host, path: ep.path, query: queryTemplate(ep), count: ep.count, first: ep.first, last: ep.last,
      status: ep.status, auth: authSummary(ep), actions: acts.slice(0, 3), hasReq: !!ep.req, hasRes: !!ep.res,
    };
  }

  function catalog(site, o = {}) {
    const doc = load(site, false);
    if (!doc) return { site, total: 0, items: [] };
    const all = sortedEndpoints(doc);
    const f = o.filter ? String(o.filter).toLowerCase() : '';
    const m = o.method ? String(o.method).toUpperCase() : '';
    const items = [];
    all.forEach((ep, i) => {
      if (m && ep.method !== m) return;
      if (f) {
        const hay = (ep.key + ' ' + Object.keys(ep.q || {}).join(' ') + ' ' + Object.keys(ep.actions || {}).join(' ')).toLowerCase();
        if (!hay.includes(f)) return;
      }
      items.push(summaryOf(ep, i + 1));
    });
    const limit = Math.max(1, Math.min(500, Number(o.limit) || 200));
    return { site, total: all.length, matched: items.length, items: items.slice(0, limit), notes: doc.notes.length };
  }

  function findEndpoint(doc, keyOrIndex) {
    if (keyOrIndex == null || keyOrIndex === '') return null;
    if (typeof keyOrIndex === 'number' || /^#?\d+$/.test(String(keyOrIndex))) {
      const i = Number(String(keyOrIndex).replace('#', ''));
      const ep = sortedEndpoints(doc)[i - 1];
      return ep ? { ep, index: i } : null;
    }
    const k = String(keyOrIndex).trim();
    const all = sortedEndpoints(doc);
    let i = all.findIndex((x) => x.key === k);
    if (i < 0) { const kk = k.replace(/\s+/, ' ').toLowerCase(); i = all.findIndex((x) => x.key.toLowerCase() === kk); }
    if (i < 0) {
      const hits = all.map((x, j) => [x, j]).filter(([x]) => x.key.toLowerCase().includes(k.toLowerCase()));
      if (hits.length === 1) i = hits[0][1];
      else if (hits.length > 1) throw new Error('several endpoints match "' + k + '": ' + hits.slice(0, 5).map(([x, j]) => '#' + (j + 1) + ' ' + x.key).join('; '));
    }
    return i >= 0 ? { ep: all[i], index: i + 1 } : null;
  }

  function liveSample(ep) {
    for (const s of ep.samples || []) {
      try { if (ctx.tabs.get(s.tab) && ctx.cdp.raw(s.tab, s.id)) return s; } catch (_) { /* нет */ }
    }
    return null;
  }

  function exampleUrl(ep) {
    const scheme = /^(127\.0\.0\.1|localhost)(:|$)/.test(ep.host) ? 'http' : 'https';
    const names = Object.keys(ep.q || {});
    const qs = names.map((n) => {
      const p = ep.q[n];
      const v = p.masked ? '<' + n + '>' : (p.ex[0] != null ? String(p.ex[0]).replace(/…$/, '') : '');
      return encodeURIComponent(n) + '=' + (p.masked ? v : encodeURIComponent(v));
    }).join('&');
    return scheme + '://' + ep.host + ep.path + (qs ? '?' + qs : '');
  }
  function neededHeaders(ep) {
    const auth = (ep.auth && ep.auth.headers) || {};
    const all = Object.keys(ep.headers || {});
    const out = [];
    for (const h of all) if (auth[h] || /^x-|csrf|xsrf|token|device|auth|api-?key|client|version/i.test(h)) out.push(h);
    return out.slice(0, 10);
  }

  function fetchTemplate(ep) {
    const headers = {};
    if (ep.reqType && ep.method !== 'GET') headers['content-type'] = ep.reqType;
    for (const h of neededHeaders(ep)) headers[h] = '<значение из запроса>';
    const init = { method: ep.method, headers, credentials: 'include' };
    if (ep.method !== 'GET' && ep.method !== 'HEAD' && ep.req) {
      const sk = S.skeleton(ep.req);
      init.body = /x-www-form-urlencoded/.test(ep.reqType) ? new URLSearchParams(Object.keys(sk || {}).map((k) => [k, ''])).toString() : JSON.stringify(sk);
    }
    const lines = [
      `const r = await fetch(${JSON.stringify(exampleUrl(ep))}, ${JSON.stringify(init, null, 2)});`,
      'const data = await r.json();',
    ];
    return lines.join('\n');
  }

  function endpoint(site, keyOrIndex) {
    const doc = load(site, false);
    if (!doc) return null;
    const hit = findEndpoint(doc, keyOrIndex);
    if (!hit) return null;
    const ep = hit.ep;
    const sample = liveSample(ep);
    return {
      site, index: hit.index, key: ep.key, method: ep.method, host: ep.host, path: ep.path, query: queryTemplate(ep, 50),
      count: ep.count, first: ep.first, last: ep.last, status: ep.status, mime: ep.mime, types: ep.types,
      params: Object.entries(ep.q || {}).map(([name, p]) => ({ name, n: p.n, type: p.type, varies: !!p.varies, masked: !!p.masked, examples: p.ex.slice(), optional: p.n < ep.count })),
      reqType: ep.reqType || '', reqSchema: ep.req ? S.render(ep.req) : '', reqSamples: ep.reqN || 0,
      resSchema: ep.res ? S.render(ep.res) : '', resSamples: ep.resN || 0,
      headers: Object.entries(ep.headers || {}).sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n })),
      neededHeaders: neededHeaders(ep), auth: authSummary(ep), authCounts: ep.auth,
      actions: topAction(ep), initiators: Object.entries(ep.inits || {}).sort((a, b) => b[1] - a[1]).map(([where, n]) => ({ where, n })),
      pages: Object.entries(ep.pages || {}).sort((a, b) => b[1] - a[1]).map(([page, n]) => ({ page, n })),
      sample, exampleUrl: exampleUrl(ep), fetchTemplate: fetchTemplate(ep),
      bodySkeleton: ep.req ? S.skeleton(ep.req) : null,
    };
  }

  function initiator(tabId, id) {
    tabId = Number(tabId);
    id = String(id).replace(/^#/, '');
    const raw = ctx.cdp && ctx.cdp.raw(tabId, id);
    if (!raw || raw.marker) return null;
    let act = null;
    const j = journals.get(tabId);
    if (j) for (const a of j.actions) if (a.requests.some((r) => r.id === id)) act = a;
    if (!act) act = actionFor(tabId, raw.ts);
    return { id, method: raw.method, url: raw.url, status: raw.status, type: raw.type, ts: raw.ts, initiator: raw.initiator || null, action: act ? actionPub(act) : null };
  }
  function actionPub(a) {
    return { id: a.id, ts: a.ts, source: a.source, kind: a.kind, label: a.label, claudeLabel: a.claudeLabel || '', tag: a.tag, role: a.role, sel: a.sel, page: a.page, site: a.site, requests: a.requests.slice() };
  }
  function recentActions(tabId, limit) {
    const j = journals.get(Number(tabId));
    if (!j) return [];
    const n = Math.max(1, Math.min(JOURNAL, Number(limit) || 15));
    return j.actions.slice(-n).map(actionPub);
  }

  // ---------- заметки ----------
  function cleanTags(tags) {
    const list = Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(/[,\s]+/) : [];
    return Array.from(new Set(list.map((t) => str(t, 30).toLowerCase().replace(/^#/, '')).filter(Boolean))).slice(0, 10);
  }
  function notes(site) { const doc = load(site, false); return doc ? doc.notes.slice() : []; }
  function addNote(site, o = {}) {
    const text = String(o.text == null ? '' : o.text).trim();
    if (!text) throw new Error('note text is empty');
    if (text.length > NOTE_MAX) throw new Error(`note is too long: ${text.length} chars (max ${NOTE_MAX})`);
    const doc = load(site, true);
    if (doc.notes.length >= MAX_NOTES) throw new Error(`too many notes for ${site} (max ${MAX_NOTES}) — remove old ones first`);
    const n = { id: newId('n').slice(0, 12), text, tags: cleanTags(o.tags), created: now(), updated: now(), author: o.author === 'user' ? 'user' : 'claude' };
    doc.notes.push(n);
    touch(site);
    return n;
  }
  function updateNote(site, id, o = {}) {
    const doc = load(site, false);
    const n = doc && doc.notes.find((x) => x.id === String(id));
    if (!n) throw new Error('note not found: ' + id);
    if (o.text != null) {
      const text = String(o.text).trim();
      if (!text) throw new Error('note text is empty');
      if (text.length > NOTE_MAX) throw new Error(`note is too long (max ${NOTE_MAX})`);
      n.text = text;
    }
    if (o.tags != null) n.tags = cleanTags(o.tags);
    n.updated = now();
    if (o.author === 'user' || o.author === 'claude') n.editedBy = o.author;
    touch(site);
    return n;
  }
  function removeNote(site, id) {
    const doc = load(site, false);
    const i = doc ? doc.notes.findIndex((x) => x.id === String(id)) : -1;
    if (i < 0) throw new Error('note not found: ' + id);
    const [n] = doc.notes.splice(i, 1);
    touch(site);
    return n;
  }

  // ---------- сайты ----------
  function forget(site) {
    const d = docs.get(site);
    if (d) { if (d.timer) clearTimeout(d.timer); docs.delete(site); }
    try { fs.unlinkSync(fileOf(site)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    ctx.broadcast('kosmo:siteIntel.changed', { site, forgotten: true });
    return true;
  }
  function sites() {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch (_) { files = []; }
    const out = new Map();
    for (const f of files.slice(0, 500)) {
      let bytes = 0, mtime = 0;
      try { const st = fs.statSync(path.join(dir, f)); bytes = st.size; mtime = st.mtimeMs; } catch (_) { continue; }
      const name = f.slice(0, -5);
      let site = name, endpoints = 0, nNotes = 0;
      const d = Array.from(docs.values()).find((x) => S.siteFile(x.doc.site) === name);
      let doc = d ? d.doc : null;
      if (!doc) { try { doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { doc = null; } }
      if (doc) { site = doc.site || name; endpoints = Object.keys(doc.endpoints || {}).length; nNotes = (doc.notes || []).length; }
      out.set(site, { site, bytes, updated: (doc && doc.updated) || mtime, endpoints, notes: nNotes });
    }
    for (const d of docs.values()) {
      if (out.has(d.doc.site)) continue;
      out.set(d.doc.site, { site: d.doc.site, bytes: serialize(d.doc).length, updated: d.doc.updated, endpoints: Object.keys(d.doc.endpoints).length, notes: d.doc.notes.length, unsaved: true });
    }
    return Array.from(out.values()).sort((a, b) => b.updated - a.updated);
  }
  function clearAll() { for (const s of sites()) forget(s.site); return true; }

  function counts(site) {
    if (!site) return null;
    const d = docs.get(site);
    let doc = d ? d.doc : null;
    if (!doc) { if (!fs.existsSync(fileOf(site))) return null; doc = load(site, false); }
    if (!doc) return null;
    return { site, endpoints: Object.keys(doc.endpoints).length, notes: doc.notes.length };
  }
  function hint(url) {
    const c = counts(siteForUrl(url));
    if (!c || (!c.endpoints && !c.notes)) return '';
    return `Site knowledge (${c.site}): ${c.endpoints} API endpoint${c.endpoints === 1 ? '' : 's'}, ${c.notes} note${c.notes === 1 ? '' : 's'} — see site_api_catalog / site_notes`;
  }

  // ---------- IPC ----------
  const allow = { allow: ['ui', 'internal:settings'] };
  const site0 = (p) => resolveSite(p && (p.site || p.tabId != null) ? { site: p.site, tabId: p.tabId != null ? Number(p.tabId) : undefined } : {});
  ctx.ipc.handle('kosmo:siteIntel.summary', (p = {}) => {
    let site = '';
    try { site = site0(p); } catch (e) { return { site: '', error: e.message, enabled: enabled() }; }
    const c = catalog(site, { limit: 500 });
    const tabId = p && p.tabId != null ? Number(p.tabId) : (ctx.tabs.active() || {}).id;
    let capture = 'api';
    try { if (tabId != null && ctx.cdp && ctx.cdp.info) capture = ctx.cdp.info(tabId).mode; } catch (_) { /* нет вкладки */ }
    return { site, enabled: enabled(), excluded: excluded(site, site), capture, total: c.total, items: c.items, notes: notes(site) };
  }, allow);
  ctx.ipc.handle('kosmo:siteIntel.endpoint', (p = {}) => endpoint(site0(p), p.key != null ? p.key : p.index), allow);
  ctx.ipc.handle('kosmo:siteIntel.noteAdd', (p = {}) => addNote(site0(p), { text: p.text, tags: p.tags, author: 'user' }), allow);
  ctx.ipc.handle('kosmo:siteIntel.noteUpdate', (p = {}) => updateNote(site0(p), p.id, { text: p.text, tags: p.tags, author: 'user' }), allow);
  ctx.ipc.handle('kosmo:siteIntel.noteRemove', (p = {}) => removeNote(site0(p), p.id), allow);
  ctx.ipc.handle('kosmo:siteIntel.forget', (p = {}) => forget(site0(p)), allow);
  ctx.ipc.handle('kosmo:siteIntel.sites', () => ({ sites: sites(), dir }), allow);
  ctx.ipc.handle('kosmo:siteIntel.clearAll', () => clearAll(), allow);
  ctx.ipc.handle('kosmo:siteIntel.actions', (p = {}) => recentActions(p.tabId != null ? Number(p.tabId) : (ctx.tabs.active() || {}).id, p.limit), allow);

  ctx.siteIntel = {
    enabled, dir, siteOf: S.siteOf, siteForUrl, siteForTab: (tabId) => siteForUrl(tabUrl(tabId)), resolveSite,
    noteAction, catalog, endpoint, initiator, recentActions, notes, addNote, updateNote, removeNote,
    forget, sites, clearAll, counts, hint, stats: () => Object.assign({}, stats, { loaded: docs.size, queue: bodyQueue.length, pending: pending.length }),
    flush: flushAll, render: S.render, _shape: S,
  };
}

module.exports = { id: 'site-intel', init };
