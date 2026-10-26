'use strict';
// Действия моста над вкладками (claude-bridge): выбор вкладки, вызов библиотеки снимка в изолированном мире,
// доверенный ввод (sendInputEvent: мышь, клавиши; insertText), наблюдение за навигацией, скриншоты.

const snap = require('../page-snapshot');

const BLOCKED_SCHEMES = /^(kosmo|devtools|chrome|chrome-extension|chrome-devtools|view-source):/i;
const FETCH_WORLD_FALLBACK = 1004;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function readable(u) { try { return decodeURI(u); } catch (_) { return String(u || ''); } }

function withTimeout(p, ms, message) {
  let t;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(message || `timeout ${ms} ms`)), ms); }),
  ]);
}

// Electron-ключи для sendInputEvent (accelerator key codes) и символ char-события.
const KEY_ALIASES = {
  enter: ['Enter', '\r'], return: ['Enter', '\r'], tab: ['Tab', '\t'], escape: ['Escape'], esc: ['Escape'],
  backspace: ['Backspace'], delete: ['Delete'], del: ['Delete'], insert: ['Insert'], space: ['Space', ' '], ' ': ['Space', ' '],
  arrowup: ['Up'], up: ['Up'], arrowdown: ['Down'], down: ['Down'], arrowleft: ['Left'], left: ['Left'], arrowright: ['Right'], right: ['Right'],
  home: ['Home'], end: ['End'], pageup: ['PageUp'], pagedown: ['PageDown'], plus: ['Plus', '+'],
};
const MODS = { control: 'control', ctrl: 'control', shift: 'shift', alt: 'alt', option: 'alt', meta: 'meta', cmd: 'meta', command: 'meta', win: 'meta' };

function parseCombo(str) {
  const s = String(str || '').trim();
  if (!s) throw new Error('empty key');
  let key;
  let mods;
  if (s === '+') { key = '+'; mods = []; }
  else if (s.endsWith('++')) { key = '+'; mods = s.slice(0, -2).split('+'); }
  else { mods = s.split('+'); key = mods.pop(); }
  key = String(key).trim() || (s.endsWith(' ') ? ' ' : '');
  const modifiers = [];
  for (const m of mods) {
    const l = m.trim().toLowerCase();
    if (!l) continue;
    if (!MODS[l]) throw new Error('unknown modifier: ' + m + ' (use Control, Shift, Alt, Meta)');
    if (!modifiers.includes(MODS[l])) modifiers.push(MODS[l]);
  }
  if (!key) throw new Error('no key in ' + s);
  const alias = KEY_ALIASES[key.toLowerCase()];
  let keyCode, char;
  if (alias) { keyCode = alias[0]; char = alias[1]; }
  else if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(key)) keyCode = key.toUpperCase();
  else if ([...key].length === 1) { keyCode = key.length === 1 && /[a-z]/i.test(key) ? key.toUpperCase() : key; char = key; }
  else throw new Error('unknown key: ' + key + ' (use names like Enter, Tab, Escape, ArrowDown, Backspace, PageDown, F5, or single characters)');
  // С Ctrl/Alt/Meta символ не вводится (Ctrl+A — команда, а не «a»).
  const typing = !modifiers.some((m) => m === 'control' || m === 'alt' || m === 'meta');
  if (char && modifiers.includes('shift') && /^[a-z]$/.test(char)) char = char.toUpperCase();
  return { keyCode, modifiers, char: typing ? char : undefined, label: modifiers.map((m) => m[0].toUpperCase() + m.slice(1)).concat(key).join('+') };
}

function createActions(ctx) {
  const T = () => ctx.tabs;

  // ---------- вкладки ----------
  function getTab(tabId) {
    if (tabId != null && tabId !== '') {
      const t = T().get(Number(tabId));
      if (!t) throw new Error(`tab ${tabId} not found. Use tabs_list.`);
      return t;
    }
    const a = T().active();
    if (!a) throw new Error('no active tab');
    return a;
  }

  function waitEvent(wc, events, ms) {
    return new Promise((resolve) => {
      let done = false;
      const offs = [];
      const finish = (v) => { if (done) return; done = true; clearTimeout(t); for (const off of offs) off(); resolve(v); };
      for (const ev of events) {
        const fn = (...a) => finish({ event: ev, args: a });
        wc.on(ev, fn);
        offs.push(() => { try { wc.removeListener(ev, fn); } catch (_) { /* уничтожен */ } });
      }
      const t = setTimeout(() => finish(null), ms);
    });
  }

  // Вкладка с живым webContents (выгруженную — загрузить).
  async function liveTab(tabId, opts = {}) {
    const tab = getTab(tabId);
    // Внутренние страницы не будим зря: проверка до загрузки выгруженной вкладки.
    if (opts.web && BLOCKED_SCHEMES.test(tab.info.url || '')) throw new Error(`tab ${tab.id} shows an internal page (${String(tab.info.url).split('?')[0]}); Claude tools work only on web pages`);
    if (!tab.wc || tab.wc.isDestroyed()) {
      tab.ensureView();
      if (tab.id === T().activeId) ctx.windows.setActiveView(tab.view);
      if (tab.wc) await waitEvent(tab.wc, ['did-stop-loading', 'did-fail-load'], opts.loadTimeout || 15000);
    }
    const wc = tab.wc;
    if (!wc || wc.isDestroyed()) throw new Error(`tab ${tab.id} has no page`);
    // Фоновая вкладка, ни разу не показанная, имеет вид 0×0: страница без вьюпорта (innerWidth 0) — даём размер вкладки.
    try { const b = tab.view && tab.view.getBounds(); if (b && (!b.width || !b.height)) tab.view.setBounds(ctx.windows.geometry().tab); } catch (_) { /* окна нет */ }
    if (wc.isCrashed()) throw new Error(`tab ${tab.id} crashed; reload it with navigate {"url":"reload"}`);
    return tab;
  }

  function assertWebPage(tab) {
    const url = tab.wc.getURL() || tab.info.url || '';
    if (BLOCKED_SCHEMES.test(url)) throw new Error(`tab ${tab.id} shows an internal page (${url.split('?')[0]}); Claude tools work only on web pages`);
    return url;
  }

  // ---------- выполнение кода в изолированном мире ----------
  // Основной путь — именованный изолированный мир через CDP (Page.createIsolatedWorld + Runtime.evaluate):
  // webContents.executeJavaScriptInIsolatedWorld в Electron ждёт did-stop-loading, а тяжёлые сайты
  // «грузятся» десятки секунд — инструменты висели бы. Мир один на документ (Chromium переиспользует его
  // по имени), поэтому ref-ы живут между вызовами. Без ctx.cdp — запасной путь: мир WORLD через Electron.
  const worlds = new Map(); // `${tabId}:${name}` → { wc, ctxId }
  const hasCdp = () => !!(ctx.cdp && typeof ctx.cdp.send === 'function');

  async function evalCdp(tab, name, expression, timeoutMs) {
    const key = tab.id + ':' + name;
    for (let attempt = 0; attempt < 3; attempt++) {
      let w = worlds.get(key);
      if (!w || w.wc !== tab.wc || !w.ctxId) {
        const tree = await ctx.cdp.send(tab.id, 'Page.getFrameTree', {});
        const frameId = tree && tree.frameTree && tree.frameTree.frame && tree.frameTree.frame.id;
        if (!frameId) throw new Error('no main frame');
        const cw = await ctx.cdp.send(tab.id, 'Page.createIsolatedWorld', { frameId, worldName: name, grantUniveralAccess: false });
        w = { wc: tab.wc, ctxId: cw.executionContextId };
        worlds.set(key, w);
      }
      let r;
      try {
        r = await withTimeout(ctx.cdp.send(tab.id, 'Runtime.evaluate', {
          expression, contextId: w.ctxId, returnByValue: true, awaitPromise: true, userGesture: true, silent: true,
        }), timeoutMs, 'the page did not respond in time (busy, frozen or showing a dialog)');
      } catch (e) {
        if (/context|Execution context was destroyed|Inspected target navigated|Cannot find/i.test(e.message)) { worlds.delete(key); await sleep(120); continue; }
        throw e;
      }
      if (r.exceptionDetails) {
        const ex = r.exceptionDetails;
        const msg = (ex.exception && (ex.exception.description || ex.exception.value)) || ex.text || 'exception';
        if (/context.*destroyed|navigat/i.test(String(msg))) { worlds.delete(key); await sleep(120); continue; }
        throw new Error(String(msg));
      }
      return r.result ? r.result.value : undefined;
    }
    throw new Error('the page keeps navigating; try again when it settles');
  }

  async function evalWorld(tab, name, expression, timeoutMs, legacyWorld) {
    if (hasCdp()) {
      try { return await evalCdp(tab, name, expression, timeoutMs); } catch (e) {
        if (!/attach|debugger|вкладка не найдена|not found or unloaded/i.test(e.message)) throw e;
        ctx.log('bridge', 'CDP недоступен, запасной путь:', e.message);
      }
    }
    return withTimeout(tab.wc.executeJavaScriptInIsolatedWorld(legacyWorld, [{ code: expression }], true), timeoutMs,
      'the page did not respond in time (busy or still loading)');
  }
  ctx.tabs.on('closed', (t) => { for (const k of worlds.keys()) if (k.startsWith(t.id + ':')) worlds.delete(k); });

  // ---------- библиотека снимка ----------
  async function lib(tab, method, args, timeoutMs = 15000) {
    const short = `(globalThis.__kosmoSnap && globalThis.__kosmoSnap.v === ${snap.VERSION}) ? globalThis.__kosmoSnap.run(${JSON.stringify(method)}, ${JSON.stringify(args || {})}) : ({ __needLib: true })`;
    const run = (code) => evalWorld(tab, 'kosmolet-snapshot', code, timeoutMs, snap.WORLD);
    let r = await run(short);
    if (r && r.__needLib) r = await run(snap.code(method, args));
    if (r === undefined) throw new Error('script failed on the page (the document may be navigating); try again');
    if (r && r.__error) throw new Error(r.__error);
    return r;
  }

  // ---------- ввод ----------
  function zoomOf(tab) { try { return tab.wc.getZoomFactor() || 1; } catch (_) { return 1; } }
  // CSS px страницы → DIP вида вкладки (то, что ждёт sendInputEvent и что приходит в context-menu): обычно zoom
  // вкладки; при эмуляции устройства (devtools) — с её масштабом вписывания (ctx.devtools.emu.viewFactor).
  function viewScale(tab) {
    const z = zoomOf(tab);
    try {
      const e = ctx.devtools && ctx.devtools.emu;
      const f = e && typeof e.viewFactor === 'function' ? Number(e.viewFactor(tab.id, z)) : 0;
      if (f > 0) return f;
    } catch (_) { /* нет эмуляции */ }
    return z;
  }

  function mouse(tab, x, y, o = {}) {
    const wc = tab.wc;
    const z = viewScale(tab);
    const X = Math.round(x * z), Y = Math.round(y * z);
    const button = o.button || 'left';
    const modifiers = o.modifiers || [];
    wc.sendInputEvent({ type: 'mouseMove', x: X, y: Y, modifiers });
    if (o.move) return { x: X, y: Y };
    const count = Math.max(1, Math.min(3, Number(o.clickCount) || 1));
    for (let i = 1; i <= count; i++) {
      wc.sendInputEvent({ type: 'mouseDown', x: X, y: Y, button, clickCount: i, modifiers });
      wc.sendInputEvent({ type: 'mouseUp', x: X, y: Y, button, clickCount: i, modifiers });
    }
    return { x: X, y: Y };
  }

  function key(tab, combo) {
    const k = typeof combo === 'string' ? parseCombo(combo) : combo;
    const wc = tab.wc;
    wc.sendInputEvent({ type: 'keyDown', keyCode: k.keyCode, modifiers: k.modifiers });
    if (k.char !== undefined) wc.sendInputEvent({ type: 'char', keyCode: k.char, modifiers: k.modifiers });
    wc.sendInputEvent({ type: 'keyUp', keyCode: k.keyCode, modifiers: k.modifiers });
    return k.label;
  }

  function wheel(tab, x, y, dx, dy) {
    const z = viewScale(tab);
    tab.wc.sendInputEvent({ type: 'mouseWheel', x: Math.round(x * z), y: Math.round(y * z), deltaX: -dx, deltaY: -dy, canScroll: true });
  }

  // ---------- наблюдение за навигацией после действия ----------
  function watchNav(tab) {
    const wc = tab.wc;
    const st = { startUrl: wc.getURL(), started: null, committed: null, inPage: null, failed: null, newTabs: [], stopped: false };
    const onStart = (e, url, inPlace, isMain) => {
      const d = e && typeof e === 'object' && 'isMainFrame' in e ? e : { url, isSameDocument: inPlace, isMainFrame: isMain };
      if (d.isMainFrame && !d.isSameDocument) { st.started = d.url || url; st.stopped = false; }
    };
    const onNav = (_e, url) => { st.committed = url; };
    const onInPage = (_e, url, isMain) => { if (isMain) st.inPage = url; };
    const onFail = (_e, code, desc, url, isMain) => { if (isMain && code !== -3) st.failed = `${desc} (${code})`; };
    const onStop = () => { st.stopped = true; };
    wc.on('did-start-navigation', onStart);
    wc.on('did-navigate', onNav);
    wc.on('did-navigate-in-page', onInPage);
    wc.on('did-fail-load', onFail);
    wc.on('did-stop-loading', onStop);
    const offCreated = T().on('created', (t) => { if (t !== tab) st.newTabs.push(t); });
    function off() {
      offCreated();
      if (wc.isDestroyed()) return;
      wc.removeListener('did-start-navigation', onStart);
      wc.removeListener('did-navigate', onNav);
      wc.removeListener('did-navigate-in-page', onInPage);
      wc.removeListener('did-fail-load', onFail);
      wc.removeListener('did-stop-loading', onStop);
    }
    async function settle(o = {}) {
      const quiet = o.quiet != null ? o.quiet : 500;
      const max = o.timeout != null ? o.timeout : 10000;
      const t0 = Date.now();
      await sleep(quiet);
      // SPA меняют адрес через history с задержкой — подождать ещё немного, если пока тихо.
      const extra = o.extra != null ? o.extra : 1200;
      for (let t = 0; t < extra && !st.started && !st.inPage && !st.newTabs.length && !st.failed; t += 150) await sleep(150);
      if (st.started && !wc.isDestroyed()) {
        while (Date.now() - t0 < max && !wc.isDestroyed()) {
          if (st.failed) break;
          if (st.committed && (st.stopped || !wc.isLoading())) break;
          if (st.committed && o.wait === 'commit') break;
          await sleep(150);
        }
      }
      off();
      return report();
    }
    function report() {
      const lines = [];
      const url = wc.isDestroyed() ? '' : wc.getURL();
      if (st.failed) lines.push(`Navigation failed: ${st.failed}`);
      if (st.committed && st.committed !== st.startUrl) {
        lines.push(`Navigated to ${readable(url)}${!wc.isDestroyed() && wc.isLoading() ? ' (still loading)' : ''} — "${wc.isDestroyed() ? '' : wc.getTitle()}"`);
      } else if (st.started && !st.committed && !st.failed) {
        lines.push(`Navigation to ${st.started} started, not finished yet`);
      } else if (st.inPage && st.inPage !== st.startUrl) {
        lines.push(`URL changed (same page): ${readable(st.inPage)}`);
      } else if (st.committed && st.committed === st.startUrl) {
        lines.push('Page reloaded: ' + url);
      }
      for (const t of st.newTabs) lines.push(`Opened new tab [${t.id}] ${readable(t.info.url || '')}${t.id === T().activeId ? ' (now active)' : ' (background)'}`);
      if (!lines.length) lines.push('No navigation; URL unchanged.');
      return { lines, url, navigated: !!(st.committed || st.inPage), newTabs: st.newTabs.map((t) => t.id) };
    }
    return { st, settle, off, report };
  }

  // Ждать окончания загрузки (или таймаута).
  async function waitLoad(tab, timeout = 15000, until = 'load') {
    const wc = tab.wc;
    if (!wc || wc.isDestroyed()) return false;
    if (!wc.isLoading()) return true;
    const ev = until === 'domcontentloaded' ? ['dom-ready', 'did-stop-loading', 'did-fail-load'] : ['did-stop-loading', 'did-fail-load'];
    const r = await waitEvent(wc, ev, timeout);
    return !!r;
  }

  // ---------- скриншот ----------
  // Фоновая вкладка не рисуется (её вид снят с окна). На время снимка кладём её вид в окно ПОД активную вкладку:
  // пользователь его не видит, а Chromium рисует кадры. Раскладка core (syncViews) сама уберёт лишний вид,
  // если успеет сработать раньше нас.
  async function withPainted(tab, fn) {
    const win = ctx.windows.main;
    const view = tab.view;
    const bg = !!(view && win && !win.isDestroyed() && ctx.windows.activeView && ctx.windows.activeView !== view);
    if (!bg) return fn(false);
    const cv = win.contentView;
    try {
      cv.addChildView(view, 0);
      view.setBounds(ctx.windows.geometry().tab);
    } catch (e) { return fn(false); }
    try {
      await sleep(300);
      return await fn(true);
    } finally {
      try {
        if (ctx.windows.activeView === view) ctx.windows.layout();
        else if (cv.children.includes(view)) cv.removeChildView(view);
      } catch (_) { /* окно закрыто */ }
    }
  }

  async function grab(tab, o, quality, maxW, background) {
    const wc = tab.wc;
    const { nativeImage } = ctx.electron;
    let img = null;
    let note = '';
    // Видимая область: сначала готовый кадр (capturePage — мгновенно); CDP ждёт новый кадр и на занятой
    // странице (тяжёлый магазин после прокрутки) может висеть секундами. capturePage падает на только что показанном
    // виде — тогда CDP.
    if (!o.fullPage && !background) {
      try { img = await withTimeout(wc.capturePage(), 3000, 'capturePage timeout'); } catch (_) { img = null; }
      if (img && !img.isEmpty()) return { img, note };
      img = null;
    }
    if (ctx.cdp && typeof ctx.cdp.send === 'function') {
      try {
        const params = { format: 'jpeg', quality, fromSurface: true };
        if (o.fullPage) {
          const m = await withTimeout(ctx.cdp.send(tab.id, 'Page.getLayoutMetrics', {}), 5000, 'layout metrics timeout');
          const cs = m.cssContentSize || m.contentSize;
          const w = Math.ceil(cs.width), h = Math.ceil(cs.height);
          const H = Math.min(h, 12000);
          if (H < h) note = ` (page is ${h}px tall; captured the top ${H}px)`;
          params.captureBeyondViewport = true;
          params.clip = { x: 0, y: 0, width: w, height: H, scale: Math.min(1, maxW / Math.max(1, w)) };
        }
        const r = await withTimeout(ctx.cdp.send(tab.id, 'Page.captureScreenshot', params), o.fullPage ? 25000 : 8000, 'screenshot timeout');
        img = nativeImage.createFromBuffer(Buffer.from(r.data, 'base64'));
      } catch (e) {
        ctx.log('bridge', 'скриншот через CDP не удался:', e.message);
        img = null;
        if (o.fullPage) throw new Error('full-page screenshot failed: ' + e.message);
      }
    }
    if (!img || img.isEmpty()) {
      for (let i = 0; i < 2 && (!img || img.isEmpty()); i++) {
        try { img = await withTimeout(wc.capturePage(), 5000, 'capturePage timeout'); } catch (e) { img = null; await sleep(300); }
      }
    }
    return { img, note };
  }

  async function capture(tab, o = {}) {
    const maxW = Math.max(200, Math.min(1600, Number(o.maxWidth) || 1600));
    const quality = Math.max(30, Math.min(95, Number(o.quality) || 75));
    let { img, note } = await withPainted(tab, (bg) => grab(tab, o, quality, maxW, bg));
    if (!img || img.isEmpty()) throw new Error('could not capture the tab (the page has not painted yet); select it with tab_select and retry');
    // Обрезка по элементу.
    if (o.clip) {
      const sz = img.getSize();
      const s = sz.width / Math.max(1, o.clip.vw);
      const r = { x: Math.max(0, Math.floor(o.clip.x * s)), y: Math.max(0, Math.floor(o.clip.y * s)) };
      r.width = Math.max(1, Math.min(sz.width - r.x, Math.ceil(o.clip.w * s)));
      r.height = Math.max(1, Math.min(sz.height - r.y, Math.ceil(o.clip.h * s)));
      img = img.crop(r);
    }
    let size = img.getSize();
    if (size.width > maxW) { img = img.resize({ width: maxW, quality: 'good' }); size = img.getSize(); }
    if (size.height > 8000) { img = img.resize({ height: 8000, quality: 'good' }); size = img.getSize(); }
    const jpeg = img.toJPEG(quality);
    return { data: jpeg.toString('base64'), width: size.width, height: size.height, bytes: jpeg.length, note };
  }

  // ---------- fetch из страницы (если нет ctx.cdp.pageFetch) ----------
  async function pageFetchFallback(tab, o) {
    const pageUrl = tab.wc.getURL();
    if (!/^https?:/i.test(pageUrl)) throw new Error('page_fetch works only on http(s) pages');
    const url = new URL(String(o.url || ''), pageUrl).href;
    const opts = {
      url, method: String(o.method || 'GET').toUpperCase(), headers: o.headers || {}, body: o.body == null ? null : String(o.body),
      credentials: o.credentials || 'include', timeoutMs: Math.max(1000, Math.min(120000, Number(o.timeoutMs) || 30000)), limit: 5 * 1024 * 1024,
    };
    if (opts.method === 'GET' || opts.method === 'HEAD') opts.body = null;
    const code = `(async (o) => {
      const t0 = performance.now(); const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), o.timeoutMs);
      try {
        const init = { method: o.method, headers: o.headers, credentials: o.credentials, signal: ac.signal, cache: 'no-store' };
        if (o.body != null) init.body = o.body;
        const r = await fetch(o.url, init);
        const headers = {}; r.headers.forEach((v, k) => { headers[k] = v; });
        let body = await r.text(); let truncated = false;
        if (body.length > o.limit) { body = body.slice(0, o.limit); truncated = true; }
        clearTimeout(tm);
        return { ok: r.ok, status: r.status, statusText: r.statusText, url: r.url, headers, body, truncated, timeMs: Math.round(performance.now() - t0) };
      } catch (e) { clearTimeout(tm); return { ok: false, status: 0, headers: {}, body: '', error: e && e.name === 'AbortError' ? 'timeout' : String(e && e.message || e), timeMs: Math.round(performance.now() - t0) }; }
    })(${JSON.stringify(opts)})`;
    const r = await evalWorld(tab, 'kosmolet-fetch', code, opts.timeoutMs + 5000, FETCH_WORLD_FALLBACK);
    return r || { ok: false, status: 0, headers: {}, body: '', error: 'empty result' };
  }

  async function pageFetch(tabId, o) {
    const tab = await liveTab(tabId);
    assertWebPage(tab);
    // ctx.cdp.pageFetch выполняет fetch через CDP (без ожидания конца загрузки); старая сборка без evalInWorld
    // ждала did-stop-loading — тогда, пока страница грузится, делаем fetch сами в своём мире.
    if (ctx.cdp && typeof ctx.cdp.pageFetch === 'function' && (typeof ctx.cdp.evalInWorld === 'function' || !tab.wc.isLoadingMainFrame())) return ctx.cdp.pageFetch(tab.id, o);
    return pageFetchFallback(tab, o);
  }

  return {
    getTab, liveTab, assertWebPage, lib, evalWorld, mouse, key, wheel, parseCombo, watchNav, waitLoad, waitEvent, capture, pageFetch,
    zoomOf, viewScale, sleep, withTimeout,
  };
}

module.exports = { createActions, parseCombo, withTimeout, sleep };
