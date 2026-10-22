'use strict';
// Блокировщик рекламы и трекеров на движке @ghostery/adblocker-electron.
//
// Почему своя обёртка, а не ElectronBlocker.enableBlockingInSession:
//  - enableBlockingInSession вешает ipcMain.handle на каналы косметики при КАЖДОЙ сессии — для второго
//    контейнера это исключение «second handler», а disable() одной сессии снимает обработчики у всех;
//  - белый список (privacy.adblockAllow) — сайты, где не фильтруется вообще ничего: решение принимается по
//    адресу страницы вкладки (webContents), а не по referrer запроса, и меняется без пересборки движка.
// Сами решения (match, редиректы-заглушки, $csp, косметика) — из движка ghostery.
//
// Движок грузится ПОСЛЕ показа окна. Первая сборка (скачать и разобрать списки) идёт в worker_thread,
// дальше — кэш userData/adblock-engine.bin; старше 7 дней — пересборка в фоне.

const fs = require('fs');
const path = require('path');
const { hostOf, matchList, normHostEntry, errText } = require('./util');

const WEEK = 7 * 24 * 3600 * 1000;
const CHECK_EVERY = 6 * 3600 * 1000;
const RETRY_AFTER = 30 * 60 * 1000;
const COSMETIC_PRELOAD_ID = 'kosmo-adblock-cosmetic';
const IPC_COSMETIC = '@ghostery/adblocker/inject-cosmetic-filters';
const IPC_MUTATION = '@ghostery/adblocker/is-mutation-observer-enabled';

function createAdblock(ctx) {
  const { webContents, ipcMain } = ctx.electron;
  const file = path.join(ctx.paths.userData, 'adblock-engine.bin');
  const log = (...a) => ctx.log('adblock', ...a);

  let lib = null;          // модуль @ghostery/adblocker-electron (грузится лениво)
  let engine = null;
  let loading = null;      // Promise первой загрузки
  let updating = null;     // Promise пересборки
  let lastError = '';
  let info = { updatedAt: 0, size: 0, buildMs: 0, source: '' };
  let started = false;
  let preloadPath = null;
  const attached = new Map(); // Session → { preloadId }
  const counts = new Map();   // tabId → заблокировано на текущей странице
  let total = 0;
  const dirty = new Set();
  let flushTimer = null;
  let retryTimer = null;

  // ---------- настройки ----------
  let allowList = [];
  function readAllow() {
    const raw = ctx.settings.peek('privacy.adblockAllow');
    allowList = (Array.isArray(raw) ? raw : []).map(normHostEntry).filter(Boolean);
  }
  readAllow();
  const enabled = () => ctx.settings.peek('privacy.adblock') !== false;
  const allowedHost = (host) => !!matchList(host, allowList);

  // Адрес страницы, к которой относится запрос: адрес вкладки (главный фрейм), иначе referrer.
  function pageUrlFor(details) {
    if (details.resourceType === 'mainFrame') return details.url;
    if (details.webContentsId) {
      try {
        const wc = webContents.fromId(details.webContentsId);
        if (wc && !wc.isDestroyed()) return wc.getURL();
      } catch (_) { /* вкладка закрылась */ }
    }
    return details.referrer || '';
  }

  function frameUrl(details) {
    try { return details.frame && !details.frame.isDestroyed() ? details.frame.url : ''; } catch (_) { return ''; }
  }

  function makeRequest(details, pageUrl) {
    const req = lib.Request.fromRawDetails({
      requestId: String(details.id),
      tabId: details.webContentsId || 0,
      url: details.url,
      sourceUrl: details.referrer || frameUrl(details) || pageUrl,
      type: details.resourceType || 'other',
      _originalRequestDetails: details,
    });
    if (req.type === 'other') req.guessTypeOfRequest();
    return req;
  }

  // ---------- счётчики ----------
  function countBlocked(details) {
    total++;
    if (!details.webContentsId) return;
    let tab = null;
    try { tab = ctx.tabs.fromWebContents(webContents.fromId(details.webContentsId)); } catch (_) { tab = null; }
    if (!tab) return;
    counts.set(tab.id, (counts.get(tab.id) || 0) + 1);
    markDirty(tab.id);
  }
  function markDirty(tabId) {
    dirty.add(tabId);
    if (flushTimer) return;
    flushTimer = setTimeout(flushCounts, 400);
  }
  function flushCounts() {
    flushTimer = null;
    if (!dirty.size) return;
    const changes = {};
    for (const id of dirty) changes[id] = counts.get(id) || 0;
    dirty.clear();
    ctx.broadcast('kosmo:adblock.counts', { changes, total });
  }

  // ---------- webRequest ----------
  function onBeforeRequest(details, cb) {
    try {
      if (engine && details.resourceType !== 'mainFrame') {
        const pageUrl = pageUrlFor(details);
        const host = hostOf(pageUrl);
        if (host && !allowedHost(host)) {
          const { redirect, match } = engine.match(makeRequest(details, pageUrl));
          if (redirect) { countBlocked(details); cb({ redirectURL: redirect.dataUrl }); return; }
          if (match) { countBlocked(details); cb({ cancel: true }); return; }
        }
      }
    } catch (_) { /* блокировщик не должен ломать загрузку */ }
    cb({});
  }

  function onHeadersReceived(details, cb) {
    try {
      if (engine && (details.resourceType === 'mainFrame' || details.resourceType === 'subFrame')) {
        const pageUrl = pageUrlFor(details);
        const host = hostOf(pageUrl);
        if (host && !allowedHost(host)) {
          const csp = engine.getCSPDirectives(makeRequest(details, pageUrl));
          if (csp) {
            const headers = Object.assign({}, details.responseHeaders || {});
            const policies = csp.split(';').map((s) => s.trim()).filter(Boolean);
            for (const name of Object.keys(headers)) {
              if (name.toLowerCase() === 'content-security-policy') { policies.push(...[].concat(headers[name])); delete headers[name]; }
            }
            headers['content-security-policy'] = [policies.join(';')];
            cb({ responseHeaders: headers });
            return;
          }
        }
      }
    } catch (_) { /* ignore */ }
    cb({});
  }

  function attach(ses) {
    if (attached.has(ses)) return;
    const rec = { preloadId: null };
    try {
      ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, onBeforeRequest);
      ses.webRequest.onHeadersReceived({ urls: ['<all_urls>'] }, onHeadersReceived);
      if (preloadPath) rec.preloadId = ses.registerPreloadScript({ type: 'frame', id: COSMETIC_PRELOAD_ID, filePath: preloadPath });
    } catch (e) { log('не подключился к сессии:', errText(e)); }
    attached.set(ses, rec);
  }

  function detach(ses) {
    const rec = attached.get(ses);
    if (!rec) return;
    attached.delete(ses);
    try {
      ses.webRequest.onBeforeRequest(null);
      ses.webRequest.onHeadersReceived(null);
      if (rec.preloadId) ses.unregisterPreloadScript(rec.preloadId);
    } catch (e) { log('отключение от сессии:', errText(e)); }
  }

  function syncSessions() {
    const want = !!engine && enabled();
    for (const { session } of ctx.sessions.all()) {
      if (want) attach(session); else detach(session);
    }
  }

  // ---------- косметика (скрытие баннеров CSS-правилами) ----------
  // Каналы preload'а ghostery — один обработчик на все сессии.
  ipcMain.handle(IPC_COSMETIC, (event, url, msg) => {
    if (!engine || !enabled()) return undefined;
    let top = '';
    try { top = event.sender && !event.sender.isDestroyed() ? event.sender.getURL() : ''; } catch (_) { top = ''; }
    const host = hostOf(top || url);
    if (!host || allowedHost(host)) return undefined;
    return engine.onInjectCosmeticFilters(event, String(url || ''), msg);
  });
  ipcMain.handle(IPC_MUTATION, () => !!(engine && enabled() && engine.config && engine.config.enableMutationObserver));

  // ---------- загрузка и обновление движка ----------
  function loadLib() {
    if (lib) return lib;
    const t0 = Date.now();
    lib = require('@ghostery/adblocker-electron');
    log(`библиотека за ${Date.now() - t0} мс`);
    try { preloadPath = require.resolve('@ghostery/adblocker-electron-preload'); } catch (e) { preloadPath = null; log('нет preload косметики:', errText(e)); }
    return lib;
  }

  function setEngine(eng, meta) {
    engine = eng;
    info = Object.assign({}, info, meta);
    lastError = '';
    syncSessions();
    broadcastStatus();
  }

  async function writeAtomic(buf) {
    const tmp = file + '.tmp';
    await fs.promises.writeFile(tmp, buf);
    await fs.promises.rename(tmp, file);
  }

  function buildInWorker() {
    return new Promise((resolve, reject) => {
      let Worker;
      try { ({ Worker } = require('worker_threads')); } catch (e) { reject(e); return; }
      const w = new Worker(path.join(__dirname, 'adblock-worker.js'));
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; w.terminate(); reject(new Error('сборка списков не уложилась в 3 минуты')); } }, 180000);
      w.once('message', (m) => {
        if (done) return;
        done = true; clearTimeout(timer);
        w.terminate();
        if (m && m.ok && m.buf) resolve({ buf: m.buf, ms: m.ms });
        else reject(new Error((m && m.error) || 'сборка не удалась'));
      });
      w.once('error', (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } });
      w.once('exit', (code) => { if (!done) { done = true; clearTimeout(timer); reject(new Error('поток сборки завершился: ' + code)); } });
    });
  }

  // Запасной путь, если поток не поднялся: тот же API, но в main (с кэшем в файле).
  function buildInMain() {
    const t0 = Date.now();
    return lib.ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
      path: file,
      read: (p) => fs.promises.readFile(p),
      write: (p, buf) => writeAtomic(buf),
    }).then((eng) => ({ eng, ms: Date.now() - t0 }));
  }

  function update(reason) {
    if (updating) return updating;
    loadLib();
    log(`обновление списков (${reason})…`);
    broadcastStatus(true);
    updating = (async () => {
      try {
        const { buf, ms } = await buildInWorker();
        await writeAtomic(buf);
        const eng = lib.ElectronBlocker.deserialize(buf);
        setEngine(eng, { updatedAt: Date.now(), size: buf.length, buildMs: ms, source: 'network' });
        log(`списки обновлены за ${ms} мс, ${Math.round(buf.length / 1024)} КБ`);
      } catch (e) {
        log('поток сборки:', errText(e), '— пробую в main');
        try {
          try { await fs.promises.unlink(file); } catch (_) { /* нет файла */ }
          const { eng, ms } = await buildInMain();
          let size = 0; try { size = (await fs.promises.stat(file)).size; } catch (_) {}
          setEngine(eng, { updatedAt: Date.now(), size, buildMs: ms, source: 'network' });
        } catch (e2) {
          lastError = errText(e2);
          log('списки не обновились:', lastError);
          clearTimeout(retryTimer);
          retryTimer = setTimeout(() => update('повтор'), RETRY_AFTER);
          if (retryTimer.unref) retryTimer.unref();
          broadcastStatus();
        }
      } finally {
        updating = null;
        broadcastStatus();
      }
    })();
    return updating;
  }

  async function load() {
    if (loading) return loading;
    loading = (async () => {
      const t0 = Date.now();
      loadLib();
      let st = null;
      try { st = await fs.promises.stat(file); } catch (_) { st = null; }
      if (st && st.size > 0) {
        try {
          const buf = await fs.promises.readFile(file);
          const eng = lib.ElectronBlocker.deserialize(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
          setEngine(eng, { updatedAt: st.mtimeMs, size: st.size, source: 'cache' });
          log(`движок из кэша за ${Date.now() - t0} мс (${Math.round(st.size / 1024)} КБ, от ${new Date(st.mtimeMs).toLocaleDateString('ru-RU')})`);
          if (Date.now() - st.mtimeMs > WEEK) update('старше 7 дней');
          return;
        } catch (e) {
          log('кэш движка не читается (другая версия библиотеки?):', errText(e));
        }
      }
      await update('первый запуск');
    })();
    return loading;
  }

  function checkStale() {
    if (!engine || updating) return;
    if (Date.now() - (info.updatedAt || 0) > WEEK) update('раз в неделю');
  }

  // После показа окна: ленивая загрузка движка (если блокировщик включён).
  function start() {
    if (started) return;
    started = true;
    if (enabled()) load().catch((e) => log(errText(e)));
    const t = setInterval(checkStale, CHECK_EVERY);
    if (t.unref) t.unref();
  }

  // ---------- состояние для интерфейса ----------
  function status() {
    return {
      enabled: enabled(),
      ready: !!engine,
      loading: !!(updating || (loading && !engine)),
      error: lastError,
      updatedAt: info.updatedAt || 0,
      size: info.size || 0,
      total,
    };
  }
  let statusTimer = null;
  function broadcastStatus(now) {
    if (now) { clearTimeout(statusTimer); statusTimer = null; ctx.broadcast('kosmo:adblock.status', status()); return; }
    if (statusTimer) return;
    statusTimer = setTimeout(() => { statusTimer = null; ctx.broadcast('kosmo:adblock.status', status()); }, 50);
  }

  function tabState(tab, url) {
    const u = url || (tab ? tab.info.url : '');
    const host = hostOf(u);
    const allowEntry = host ? matchList(host, allowList) : '';
    return Object.assign(status(), {
      tabId: tab ? tab.id : null,
      host,
      siteKey: host.replace(/^www\./, ''),
      allowed: !!allowEntry,
      allowEntry,
      blocked: tab ? counts.get(tab.id) || 0 : 0,
      active: !!(engine && enabled() && host && !allowEntry),
    });
  }

  // Включить/выключить блокировку на сайте: добавляет/убирает запись белого списка.
  function setSite(host, block) {
    const h = normHostEntry(host);
    if (!h) throw new Error('не удалось определить сайт');
    const raw = ctx.settings.get('privacy.adblockAllow') || [];
    let list = raw.slice();
    if (block) {
      // убрать все записи, которые покрывают этот хост (иначе блокировка так и не включится)
      list = list.filter((e) => { const n = normHostEntry(e); return !(n && (h === n || h.endsWith('.' + n) || (n === 'localhost' && matchList(h, ['localhost'])))); });
    } else if (!matchList(h, list.map(normHostEntry))) {
      list.push(h);
    }
    ctx.settings.set('privacy.adblockAllow', list);
    return list;
  }

  // ---------- события ----------
  ctx.settings.on('change', (p) => {
    if (p === 'privacy' || p.startsWith('privacy.adblockAllow')) readAllow();
    if (p === 'privacy' || p.startsWith('privacy.adblock')) {
      if (enabled() && started && !engine) load().catch((e) => log(errText(e)));
      syncSessions();
      broadcastStatus();
    }
  });

  ctx.sessions.onSession((ses) => { if (engine && enabled()) attach(ses); });

  ctx.tabs.on('view-created', (tab, wc) => {
    wc.on('did-navigate', () => { if (counts.get(tab.id)) { counts.set(tab.id, 0); markDirty(tab.id); } });
  });
  ctx.tabs.on('closed', (tab) => { counts.delete(tab.id); dirty.delete(tab.id); });

  return {
    start,
    load,
    update: (reason) => { if (!started) start(); return update(reason || 'вручную'); },
    status,
    tabState,
    setSite,
    counts: () => Object.fromEntries(counts),
    isEnabledFor(url) { const h = hostOf(url); return !!(enabled() && h && !allowedHost(h)); },
    blockedCount(tabId) { return counts.get(Number(tabId)) || 0; },
    get engine() { return engine; },
    get allowList() { return allowList.slice(); },
  };
}

module.exports = { createAdblock };
