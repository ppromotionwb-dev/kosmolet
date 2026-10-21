'use strict';
// TabManager (ARCHITECTURE §5): вкладки = WebContentsView, ленивое восстановление, выгрузка, стек закрытых, сессия.

const { EventEmitter } = require('events');

const NEWTAB = 'kosmo://newtab/';
const ERROR_PAGE = 'kosmo://error/';
const CLOSED_LIMIT = 25;
const HISTORY_PERSIST_LIMIT = 30;
const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const URL_SCHEME_RE = /^(https?|kosmo|file|about|view-source|data|chrome|chrome-extension|devtools|blob):/i;

class Tab {
  constructor(mgr, id, info) {
    Object.defineProperty(this, '_mgr', { value: mgr });
    this.id = id;
    this.info = info;
    this.view = null;
    this.wc = null;
    this.openerId = null;
    this.createdAt = Date.now();
    this.lastActiveAt = Date.now();
    this.pendingUrl = null; // что загрузить при создании view
    this.history = null; // { entries, index } для восстановления после выгрузки
    this.errorUrl = null; // адрес, который не загрузился (показываем страницу ошибки)
    this.errorPending = false; // ждём загрузки страницы ошибки (чистка истории)
    this.retryFromError = false; // повтор загрузки со страницы ошибки
  }
  ensureView() { return this._mgr._ensureView(this); }
  get index() { return this._mgr._indexOf(this); }
  get active() { return this._mgr._activeId === this.id; }
}

function createTabs(ctx) {
  const { WebContentsView } = ctx.electron;
  const emitter = new EventEmitter();
  emitter.setMaxListeners(100);
  const tabs = [];
  const byId = new Map();
  const byWc = new Map(); // webContents.id → Tab
  const closed = [];
  const sessionStore = ctx.store('session', { tabs: [], activeIndex: 0 });
  let nextId = 1;
  let activeId = null;
  let restored = false;
  let stateTimer = null;
  let saveTimer = null;

  const mgr = {
    _ensureView: (tab) => ensureView(tab),
    _indexOf: (tab) => tabs.indexOf(tab),
    get _activeId() { return activeId; },
  };

  // ---------- помощники ----------

  function isInternalUrl(u) { return typeof u === 'string' && u.startsWith('kosmo:'); }

  function normalizeUrl(input) {
    const s = String(input == null ? '' : input).trim();
    if (!s) return NEWTAB;
    if (URL_SCHEME_RE.test(s)) return s;
    const r = ctx.search ? ctx.search.resolve(s) : null;
    return r && r.url ? r.url : s;
  }

  function containerInfo(id) {
    const c = ctx.sessions.container(id);
    return { containerColor: c.color, containerName: c.name };
  }

  function makeInfo(id, containerId, url, o) {
    return Object.assign({
      id,
      containerId,
      url,
      title: typeof o.title === 'string' ? o.title : '',
      favicon: typeof o.favicon === 'string' ? o.favicon : '',
      loading: false,
      pinned: !!o.pinned,
      muted: false,
      audible: false,
      zoom: 1,
      discarded: false,
      canGoBack: false,
      canGoForward: false,
      crashed: false,
      error: 0, // код ошибки загрузки, пока показана страница ошибки; 0 — нет
      claudeActiveAt: 0,
      badges: {},
    }, containerInfo(containerId));
  }

  function get(id) { return byId.get(Number(id)) || null; }
  function active() { return activeId != null ? get(activeId) : null; }
  function fromWebContents(wc) { return wc ? byWc.get(wc.id) || null : null; }
  function pinnedCount() { let n = 0; for (const t of tabs) if (t.info.pinned) n++; return n; }

  function infoCopy(t) {
    const i = Object.assign({}, t.info);
    i.badges = Object.assign({}, t.info.badges);
    i.active = t.id === activeId;
    i.index = tabs.indexOf(t);
    return i;
  }
  function list() { return tabs.map(infoCopy); }

  function scheduleState() {
    if (stateTimer) return;
    stateTimer = setTimeout(() => { stateTimer = null; broadcastState(true); }, 16);
  }

  function broadcastState(now) {
    if (!now) return scheduleState();
    if (stateTimer) { clearTimeout(stateTimer); stateTimer = null; }
    ctx.broadcast('kosmo:tabs.state', { tabs: list(), activeId });
  }

  function update(tab, patch) {
    let changed = false;
    for (const k of Object.keys(patch)) {
      if (tab.info[k] !== patch[k]) { tab.info[k] = patch[k]; changed = true; }
    }
    if (changed) { emitter.emit('updated', tab); scheduleState(); }
    return changed;
  }

  function navState(tab) {
    const wc = tab.wc;
    if (!wc || wc.isDestroyed()) return;
    const h = wc.navigationHistory;
    update(tab, { canGoBack: h.canGoBack(), canGoForward: h.canGoForward(), zoom: round2(wc.getZoomFactor()) });
  }

  function round2(x) { return Math.round(x * 100) / 100; }

  function load(tab, url) {
    const wc = tab.wc;
    if (!wc || wc.isDestroyed()) return;
    wc.loadURL(url).catch(() => { /* ошибки загрузки обрабатывает did-fail-load */ });
  }

  // ---------- view ----------

  function tabWebPreferences(ses) {
    return {
      session: ses,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true,
      spellcheck: false,
      safeDialogs: true,
      webviewTag: false,
      // Иначе Chromium отдаёт фокус вкладке при каждой загрузке: новая вкладка отнимает его у адресной строки,
      // а фоновая (Ctrl+клик) — у текущей страницы. Фокус ставим явно: activate() и navigate().
      focusOnNavigation: false,
    };
  }

  function ensureView(tab) {
    if (tab.view) return tab.view;
    const ses = ctx.sessions.get(tab.info.containerId);
    const view = new WebContentsView({ webPreferences: tabWebPreferences(ses) });
    attachView(tab, view);
    update(tab, { discarded: false, crashed: false });
    const hist = tab.history;
    tab.history = null;
    if (hist && Array.isArray(hist.entries) && hist.entries.length) {
      const index = Math.max(0, Math.min(hist.entries.length - 1, Number(hist.index) || 0));
      tab.wc.navigationHistory.restore({ entries: hist.entries, index }).catch((e) => {
        ctx.log('tabs', 'restore истории не удался:', e.message);
        load(tab, tab.info.url || NEWTAB);
      });
    } else {
      load(tab, tab.pendingUrl || tab.info.url || NEWTAB);
    }
    tab.pendingUrl = null;
    return view;
  }

  function attachView(tab, view) {
    const wc = view.webContents;
    tab.view = view;
    tab.wc = wc;
    byWc.set(wc.id, tab);
    if (tab.info.muted) wc.setAudioMuted(true);

    wc.on('did-start-loading', () => update(tab, { loading: true, crashed: false }));
    wc.on('did-stop-loading', () => { update(tab, { loading: false }); navState(tab); });
    wc.on('did-navigate', (_e, url) => onNavigated(tab, url, false));
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => { if (isMainFrame) onNavigated(tab, url, true); });
    wc.on('page-title-updated', (_e, title) => { update(tab, { title: String(title || '') }); saveSession(); });
    wc.on('page-favicon-updated', (_e, favicons) => {
      const f = Array.isArray(favicons) && favicons.length ? String(favicons[0]) : '';
      update(tab, { favicon: f });
    });
    wc.on('did-finish-load', () => { navState(tab); emitter.emit('loaded', tab); });
    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => onFailLoad(tab, code, desc, url, isMainFrame));
    wc.on('render-process-gone', (_e, d) => {
      ctx.log('tabs', `вкладка ${tab.id}: процесс завершился (${d.reason})`);
      update(tab, { crashed: d.reason !== 'clean-exit', loading: false, audible: false });
    });
    wc.on('preload-error', (_e, file, err) => ctx.log('tabs', 'ошибка preload:', file, err && err.message));
    wc.on('audio-state-changed', (e) => update(tab, { audible: !!e.audible }));
    wc.on('zoom-changed', (_e, dir) => zoom(tab.id, dir === 'in' ? 'in' : 'out'));
    wc.on('found-in-page', (_e, r) => {
      ctx.broadcast('kosmo:find.result', {
        tabId: tab.id, requestId: r.requestId, activeMatchOrdinal: r.activeMatchOrdinal, matches: r.matches, finalUpdate: r.finalUpdate,
      });
    });
    wc.on('enter-html-full-screen', () => { if (tab.id === activeId) ctx.windows.setHtmlFullscreen(true); });
    wc.on('leave-html-full-screen', () => { if (tab.id === activeId) ctx.windows.setHtmlFullscreen(false); });
    wc.on('update-target-url', (_e, url) => emitter.emit('target-url', tab, url));
    wc.on('focus', () => emitter.emit('focus', tab));
    wc.on('will-navigate', (details) => guardNavigation(tab, details));
    // Редирект на kosmo:// не бывает законным (наш протокол не редиректит) — режем всегда.
    wc.on('will-redirect', (details) => {
      if (details && /^kosmo:/i.test(details.url || '')) { details.preventDefault(); ctx.log('tabs', 'заблокирован редирект на', details.url); }
    });
    wc.on('destroyed', () => {
      byWc.delete(wc.id);
      // Страница закрылась сама (window.close) — убираем вкладку.
      if (tab.wc === wc && byId.has(tab.id)) {
        tab.view = null; tab.wc = null;
        if (ctx.windows.activeView === view) ctx.windows.setActiveView(null);
        emitter.emit('view-destroyed', tab);
        if (!ctx.quitting) close(tab.id);
      }
    });
    wc.setWindowOpenHandler((details) => onWindowOpen(tab, details));
    emitter.emit('view-created', tab, wc);
  }

  function destroyView(tab) {
    const { view, wc } = tab;
    if (!view) return;
    tab.view = null;
    tab.wc = null;
    if (wc) byWc.delete(wc.id);
    if (ctx.windows.activeView === view) ctx.windows.setActiveView(null);
    emitter.emit('view-destroyed', tab);
    try { if (wc && !wc.isDestroyed()) wc.close(); } catch (e) { ctx.log('tabs', 'close webContents:', e.message); }
  }

  function guardNavigation(tab, details) {
    const target = details && details.url;
    if (!target || !/^kosmo:/i.test(target)) return;
    const cur = tab.wc && !tab.wc.isDestroyed() ? tab.wc.getURL() : '';
    if (cur.startsWith('kosmo:')) return; // с внутренней страницы на внутреннюю — можно
    details.preventDefault();
    ctx.log('tabs', `заблокирован переход на ${target} с ${cur || 'пустой страницы'}`);
  }

  function errorParam(url) {
    try { return new URL(url).searchParams.get('url') || ''; } catch (_) { return ''; }
  }

  // Убрать из истории служебные записи вокруг страницы ошибки, чтобы «назад/вперёд» не прыгали по ним.
  function pruneErrorEntries(tab, failedUrl) {
    const h = tab.wc && !tab.wc.isDestroyed() ? tab.wc.navigationHistory : null;
    if (!h) return;
    for (let n = 0; n < 2; n++) {
      const i = h.getActiveIndex();
      if (i < 1) return;
      const prev = h.getEntryAtIndex(i - 1);
      if (!prev) return;
      const isFailed = prev.url === failedUrl;
      const isOldError = prev.url.startsWith(ERROR_PAGE) && errorParam(prev.url) === failedUrl;
      if (!isFailed && !isOldError) return;
      try { h.removeEntryAtIndex(i - 1); } catch (_) { return; }
    }
  }

  function onNavigated(tab, url, inPage) {
    let shown = url;
    if (url.startsWith(ERROR_PAGE)) {
      const failed = errorParam(url) || tab.errorUrl;
      if (failed) { tab.errorUrl = failed; shown = failed; }
      if (!inPage && tab.errorPending) { tab.errorPending = false; pruneErrorEntries(tab, failed); }
    } else if (!inPage) {
      // Удачный повтор со страницы ошибки — сама страница ошибки в истории не нужна.
      if (tab.retryFromError) {
        const h = tab.wc.navigationHistory;
        const i = h.getActiveIndex();
        const prev = i > 0 ? h.getEntryAtIndex(i - 1) : null;
        if (prev && prev.url.startsWith(ERROR_PAGE)) { try { h.removeEntryAtIndex(i - 1); } catch (_) {} }
      }
      tab.errorUrl = null;
    }
    if (!inPage) tab.retryFromError = false;
    const patch = { url: shown, crashed: false };
    if (!inPage && !url.startsWith(ERROR_PAGE)) patch.error = 0;
    if (!inPage) patch.favicon = '';
    update(tab, patch);
    navState(tab);
    emitter.emit('navigated', tab, shown);
    saveSession();
  }

  function onFailLoad(tab, code, desc, url, isMainFrame) {
    if (!isMainFrame || code === -3) return; // -3 ERR_ABORTED: остановка/загрузка файла
    if (!url || url.startsWith(ERROR_PAGE)) return;
    tab.errorUrl = url;
    tab.errorPending = true;
    // Страница ошибки без kosmo API (её параметры приходят от сайта) — тему передаём в адресе, theme.js её применит.
    const ui = ctx.settings.peek('ui') || {};
    const q = new URLSearchParams({ code: String(code), desc: String(desc || ''), url });
    if (ui.theme && ui.theme !== 'custom') { q.set('theme', ui.theme); if (ui.accent) q.set('accent', ui.accent); }
    if (ui.density) q.set('density', ui.density);
    ctx.log('tabs', `вкладка ${tab.id}: ошибка загрузки ${code} ${desc} ${url}`);
    load(tab, ERROR_PAGE + '?' + q.toString());
    update(tab, { url, loading: false, error: code });
  }

  function onWindowOpen(opener, details) {
    const url = details.url || '';
    const fromInternal = opener.wc && !opener.wc.isDestroyed() && opener.wc.getURL().startsWith('kosmo:');
    if (/^kosmo:/i.test(url) && !fromInternal) return { action: 'deny' };
    if (/^(javascript|file):/i.test(url) && !fromInternal) return { action: 'deny' };
    const background = details.disposition === 'background-tab';
    return {
      action: 'allow',
      outlivesOpener: true,
      createWindow: (options) => {
        const tab = create({
          url: url || 'about:blank',
          containerId: opener.info.containerId,
          openerId: opener.id,
          active: !background,
          webContents: options && options.webContents,
        });
        return tab.wc;
      },
    };
  }

  // ---------- операции ----------

  function insertAt(tab, index, opener) {
    const pc = pinnedCount();
    let i;
    if (typeof index === 'number' && isFinite(index)) i = Math.round(index);
    else if (opener && tabs.includes(opener)) {
      i = tabs.indexOf(opener) + 1;
      while (i < tabs.length && tabs[i].openerId === opener.id) i++;
    } else i = tabs.length;
    if (tab.info.pinned) i = Math.min(i, pc); else i = Math.max(i, pc);
    i = Math.max(0, Math.min(tabs.length, i));
    tabs.splice(i, 0, tab);
  }

  function create(opts = {}) {
    const opener = opts.openerId != null ? get(opts.openerId) : null;
    const containerId = ctx.sessions.normalizeId(opts.containerId || (opener && opener.info.containerId) || 'main');
    const url = opts.webContents ? String(opts.url || 'about:blank') : normalizeUrl(opts.url);
    const id = nextId++;
    const tab = new Tab(mgr, id, makeInfo(id, containerId, url, opts));
    tab.openerId = opener ? opener.id : null;
    tab.pendingUrl = url;
    if (opts.history && Array.isArray(opts.history.entries) && opts.history.entries.length) tab.history = opts.history;
    byId.set(id, tab);
    insertAt(tab, opts.index, opener);
    emitter.emit('created', tab);

    const makeActive = opts.active !== false;
    if (opts.webContents) {
      // Окно, открытое страницей (window.open / target=_blank): принимаем готовый webContents — opener сохраняется.
      const view = new WebContentsView({ webContents: opts.webContents });
      attachView(tab, view);
      tab.pendingUrl = null;
    } else if (!opts.lazy || makeActive) {
      ensureView(tab);
    } else {
      update(tab, { discarded: true });
    }
    if (makeActive) activate(id);
    scheduleState();
    saveSession();
    return tab;
  }

  function nextAfterClose(tab, idx) {
    if (tab.openerId != null) {
      const sib = tabs.slice(idx).find((t) => t.openerId === tab.openerId) || tabs.slice(0, idx).reverse().find((t) => t.openerId === tab.openerId);
      if (sib) return sib;
      const op = get(tab.openerId);
      if (op) return op;
    }
    return tabs[idx] || tabs[idx - 1] || null;
  }

  function historyOf(tab, persist) {
    const wc = tab.wc;
    if (!wc || wc.isDestroyed()) return tab.history;
    try {
      const h = wc.navigationHistory;
      let entries = h.getAllEntries();
      let index = h.getActiveIndex();
      if (persist) {
        entries = entries.map((e) => ({ url: e.url, title: e.title || '' }));
        if (entries.length > HISTORY_PERSIST_LIMIT) {
          const cut = entries.length - HISTORY_PERSIST_LIMIT;
          entries = entries.slice(cut);
          index = Math.max(0, index - cut);
        }
      }
      return { entries, index };
    } catch (_) { return null; }
  }

  function persistUrl(tab) { return tab.errorUrl || tab.info.url || NEWTAB; }

  function close(id) {
    const tab = get(id);
    if (!tab) return false;
    const idx = tabs.indexOf(tab);
    closed.push({
      url: persistUrl(tab), title: tab.info.title, containerId: tab.info.containerId, pinned: tab.info.pinned,
      index: idx, history: historyOf(tab, false),
    });
    if (closed.length > CLOSED_LIMIT) closed.shift();
    const wasActive = activeId === tab.id;
    tabs.splice(idx, 1);
    byId.delete(tab.id);
    const next = wasActive ? nextAfterClose(tab, idx) : null;
    for (const t of tabs) if (t.openerId === tab.id) t.openerId = null;
    destroyView(tab);
    emitter.emit('closed', tab);
    if (wasActive) {
      activeId = null;
      if (next) activate(next.id);
    }
    if (!tabs.length && !ctx.quitting) create({ url: NEWTAB });
    scheduleState();
    saveSession();
    return true;
  }

  function closeMany(ids) {
    for (const id of ids) close(id);
  }

  function activate(id, opts = {}) {
    const tab = get(id);
    if (!tab) return null;
    const prev = active();
    const now = Date.now();
    if (prev && prev !== tab) prev.lastActiveAt = now;
    activeId = tab.id;
    tab.lastActiveAt = now;
    if (!tab.view) ensureView(tab);
    if (ctx.windows.activeView !== tab.view) ctx.windows.setActiveView(tab.view);
    const win = ctx.windows.main;
    if (opts.focus !== false && win && !win.isDestroyed() && win.isFocused() && tab.info.url !== NEWTAB && tab.wc) {
      tab.wc.focus();
    }
    if (prev !== tab) emitter.emit('activated', tab, prev);
    scheduleState();
    saveSession();
    return tab;
  }

  function activateOffset(delta) {
    if (!tabs.length) return null;
    const cur = active();
    const i = cur ? tabs.indexOf(cur) : 0;
    const n = tabs.length;
    return activate(tabs[(((i + delta) % n) + n) % n].id);
  }

  function activateIndex(i) {
    if (!tabs.length) return null;
    const idx = i < 0 ? tabs.length - 1 : Math.min(i, tabs.length - 1);
    return activate(tabs[idx].id);
  }

  function navigate(id, input) {
    const tab = get(id);
    if (!tab) return null;
    const r = ctx.search ? ctx.search.resolve(input) : { url: normalizeUrl(input), kind: 'url' };
    const url = r && r.url ? r.url : normalizeUrl(input);
    tab.errorUrl = null;
    update(tab, { url });
    if (!tab.view) {
      tab.history = null;
      tab.pendingUrl = url;
      ensureView(tab);
      if (tab.id === activeId) ctx.windows.setActiveView(tab.view);
    } else {
      load(tab, url);
    }
    // Ввод в адресной строке → фокус странице (как в Chrome); на новую вкладку — остаётся в интерфейсе.
    const win = ctx.windows.main;
    if (tab.id === activeId && url !== NEWTAB && tab.wc && win && !win.isDestroyed() && win.isFocused()) tab.wc.focus();
    emitter.emit('navigated', tab, url);
    saveSession();
    return { url, kind: r ? r.kind : 'url' };
  }

  function withWc(id, fn) {
    const tab = get(id);
    if (!tab) return null;
    if (!tab.view) {
      if (tab.id === activeId) ensureView(tab);
      else return null;
    }
    return fn(tab, tab.wc);
  }

  function back(id) {
    return withWc(id, (t, wc) => { if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); return true; });
  }
  function forward(id) {
    return withWc(id, (t, wc) => { if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); return true; });
  }
  function reload(id, hard) {
    const tab = get(id);
    if (!tab) return false;
    if (!tab.view) { ensureView(tab); if (tab.id === activeId) ctx.windows.setActiveView(tab.view); return true; }
    const wc = tab.wc;
    if (tab.errorUrl && wc.getURL().startsWith(ERROR_PAGE)) { tab.retryFromError = true; load(tab, tab.errorUrl); return true; }
    if (hard) wc.reloadIgnoringCache(); else wc.reload();
    return true;
  }
  function stop(id) { return withWc(id, (t, wc) => { wc.stop(); return true; }); }

  function move(id, index) {
    const tab = get(id);
    if (!tab) return false;
    const from = tabs.indexOf(tab);
    tabs.splice(from, 1);
    const pc = pinnedCount();
    let i = Math.round(Number(index));
    if (!isFinite(i)) i = tabs.length;
    if (tab.info.pinned) i = Math.min(Math.max(0, i), pc);
    else i = Math.max(pc, Math.min(tabs.length, i));
    tabs.splice(i, 0, tab);
    if (from !== i) { emitter.emit('updated', tab); scheduleState(); saveSession(); }
    return i;
  }

  function pin(id, pinned) {
    const tab = get(id);
    if (!tab) return false;
    const v = pinned === undefined ? !tab.info.pinned : !!pinned;
    if (v === tab.info.pinned) return v;
    const from = tabs.indexOf(tab);
    tabs.splice(from, 1);
    tab.info.pinned = v;
    const pc = pinnedCount();
    tabs.splice(v ? pc : pc, 0, tab); // закреплённая — в конец закреплённых, откреплённая — в начало обычных
    emitter.emit('updated', tab);
    scheduleState();
    saveSession();
    return v;
  }

  function mute(id, muted) {
    const tab = get(id);
    if (!tab) return false;
    const v = muted === undefined ? !tab.info.muted : !!muted;
    if (tab.wc && !tab.wc.isDestroyed()) tab.wc.setAudioMuted(v);
    update(tab, { muted: v });
    return v;
  }

  function duplicate(id) {
    const tab = get(id);
    if (!tab) return null;
    return create({
      url: persistUrl(tab), containerId: tab.info.containerId, index: tabs.indexOf(tab) + 1, openerId: tab.id,
      active: true, title: tab.info.title, favicon: tab.info.favicon, history: historyOf(tab, false),
    });
  }

  function reopenClosed() {
    const c = closed.pop();
    if (!c) return null;
    return create({ url: c.url, containerId: c.containerId, index: c.index, pinned: c.pinned, title: c.title, history: c.history, active: true });
  }

  function refreshZoom() {
    for (const t of tabs) if (t.wc && !t.wc.isDestroyed()) update(t, { zoom: round2(t.wc.getZoomFactor()) });
  }

  function zoom(id, z) {
    const tab = get(id);
    if (!tab || !tab.wc || tab.wc.isDestroyed()) return null;
    const cur = tab.wc.getZoomFactor();
    let next = cur;
    if (z === 'in') next = ZOOM_STEPS.find((s) => s > cur + 0.001) || ZOOM_STEPS[ZOOM_STEPS.length - 1];
    else if (z === 'out') next = ZOOM_STEPS.slice().reverse().find((s) => s < cur - 0.001) || ZOOM_STEPS[0];
    else if (z === 'reset') next = 1;
    else if (typeof z === 'number' && isFinite(z)) next = Math.min(5, Math.max(0.25, z));
    tab.wc.setZoomFactor(next);
    refreshZoom();
    return round2(next);
  }

  function find(id, opts = {}) {
    const tab = get(id);
    if (!tab || !tab.wc || tab.wc.isDestroyed()) return null;
    const text = String(opts.text || '');
    if (!text) { tab.wc.stopFindInPage('clearSelection'); return null; }
    const requestId = tab.wc.findInPage(text, {
      forward: opts.forward !== false, findNext: !!opts.findNext, matchCase: !!opts.matchCase,
    });
    return { requestId };
  }

  function stopFind(id, action) {
    const tab = get(id);
    if (!tab || !tab.wc || tab.wc.isDestroyed()) return false;
    const a = ['clearSelection', 'keepSelection', 'activateSelection'].includes(action) ? action : 'clearSelection';
    tab.wc.stopFindInPage(a);
    return true;
  }

  function discard(id) {
    const tab = get(id);
    if (!tab || !tab.view || tab.id === activeId) return false;
    tab.history = historyOf(tab, false);
    tab.pendingUrl = persistUrl(tab);
    destroyView(tab);
    update(tab, { discarded: true, loading: false, audible: false, crashed: false });
    return true;
  }

  function setBadge(id, key, value) {
    const tab = get(id);
    if (!tab) return false;
    const k = String(key);
    const badges = Object.assign({}, tab.info.badges);
    if (value === undefined || value === null || value === false) delete badges[k];
    else badges[k] = JSON.parse(JSON.stringify(value));
    if (JSON.stringify(badges) === JSON.stringify(tab.info.badges)) return true;
    tab.info.badges = badges;
    emitter.emit('updated', tab);
    scheduleState();
    return true;
  }

  function markClaude(id) {
    const tab = get(id);
    if (!tab) return false;
    tab.info.claudeActiveAt = Date.now();
    emitter.emit('updated', tab);
    scheduleState();
    return true;
  }

  function focusTab(id) {
    const tab = get(id == null ? activeId : id);
    if (tab && tab.wc && !tab.wc.isDestroyed()) { tab.wc.focus(); return true; }
    return false;
  }

  // ---------- выгрузка неактивных ----------

  function checkDiscard() {
    const min = Number(ctx.settings.peek('performance.discardAfterMin')) || 0;
    if (!min) return;
    const limit = min * 60000;
    const now = Date.now();
    for (const t of tabs) {
      if (t.id === activeId || !t.view || t.info.pinned || t.info.audible || t.info.loading) continue;
      const wc = t.wc;
      if (!wc || wc.isDestroyed() || wc.isDevToolsOpened()) continue;
      const last = Math.max(t.lastActiveAt, t.info.claudeActiveAt || 0);
      if (now - last > limit) {
        ctx.log('tabs', `выгружена вкладка ${t.id} (${t.info.url})`);
        discard(t.id);
      }
    }
  }
  const discardTimer = setInterval(checkDiscard, 60000);
  if (discardTimer.unref) discardTimer.unref();

  // ---------- сессия ----------

  function snapshot() {
    const act = active();
    const out = [];
    for (const t of tabs) {
      const fav = t.info.favicon && /^https?:/i.test(t.info.favicon) && t.info.favicon.length < 2000 ? t.info.favicon : '';
      const entry = { url: persistUrl(t), title: t.info.title || '', containerId: t.info.containerId, pinned: !!t.info.pinned };
      if (fav) entry.favicon = fav;
      const h = t.wc ? historyOf(t, true) : (t.history ? {
        entries: t.history.entries.slice(-HISTORY_PERSIST_LIMIT).map((e) => ({ url: e.url, title: e.title || '' })),
        index: Math.min(t.history.index, HISTORY_PERSIST_LIMIT - 1),
      } : null);
      if (h && h.entries && h.entries.length > 1) entry.history = h;
      out.push(entry);
    }
    return { tabs: out, activeIndex: act ? tabs.indexOf(act) : 0, savedAt: Date.now() };
  }

  function saveSession() {
    if (!restored || ctx.quitting) return;
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try { sessionStore.set(snapshot()); } catch (e) { ctx.log('tabs', 'сохранение сессии:', e.message); }
    }, 500);
  }

  let finalFlushed = false;
  function flushSession() {
    if (!restored) return;
    // При выходе пишем один раз — дальше виды уничтожаются и история вкладок уже недоступна.
    if (ctx.quitting) { if (finalFlushed) return; finalFlushed = true; }
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    try { sessionStore.set(snapshot()); sessionStore.flush(); } catch (e) { ctx.log('tabs', 'flush сессии:', e.message); }
  }

  // deferViews: активная вкладка получает view позже, в realizeActive() (после загрузки интерфейса).
  function restore(opts = {}) {
    const defer = !!opts.deferViews;
    const enabled = ctx.settings.peek('performance.restoreSession') !== false && !ctx.flags.noRestore;
    const s = sessionStore.get();
    let target = null;
    if (enabled && s && Array.isArray(s.tabs) && s.tabs.length) {
      for (const t of s.tabs) {
        if (!t || typeof t.url !== 'string' || !t.url) continue;
        const history = t.history && Array.isArray(t.history.entries) && t.history.entries.length
          ? { entries: t.history.entries.filter((e) => e && typeof e.url === 'string').map((e) => ({ url: e.url, title: String(e.title || '') })), index: Number(t.history.index) || 0 }
          : null;
        create({
          url: t.url, containerId: t.containerId, pinned: !!t.pinned, title: t.title, favicon: t.favicon,
          lazy: true, active: false, history,
        });
      }
      if (tabs.length) target = tabs[Math.max(0, Math.min(tabs.length - 1, Number(s.activeIndex) || 0))];
    }
    for (const u of ctx.flags.open || []) target = create({ url: u, lazy: defer, active: !defer });
    if (!tabs.length) target = create({ url: NEWTAB, lazy: defer, active: !defer });
    if (target) {
      if (defer) { activeId = target.id; target.lastActiveAt = Date.now(); scheduleState(); } else activate(target.id);
    }
    restored = true;
    saveSession();
  }

  // Создать view активной вкладки, если её отложили при восстановлении.
  function realizeActive() {
    const t = active();
    if (t && (!t.view || ctx.windows.activeView !== t.view)) activate(t.id);
    return t;
  }

  // Открыть URL из второго запуска / командной строки.
  function openUrls(urls) {
    let last = null;
    for (const u of urls || []) last = create({ url: u, active: true });
    return last;
  }

  // Найти вкладку с этим адресом или открыть новую (для настроек, истории…).
  function openOrActivate(url) {
    // Без #раздела: kosmo://settings/#search — та же страница настроек.
    const base = (u) => String(u || '').split('#')[0];
    const t = tabs.find((x) => base(x.info.url) === base(url) || base(persistUrl(x)) === base(url));
    if (t) return activate(t.id);
    const cur = active();
    if (cur && cur.info.url === NEWTAB) { navigate(cur.id, url); return cur; }
    return create({ url, active: true });
  }

  ctx.settings.on('change', (p) => {
    if (p === 'containers') {
      for (const t of tabs) Object.assign(t.info, containerInfo(t.info.containerId));
      scheduleState();
    }
  });

  return {
    list, get, active, fromWebContents, create, close, closeMany, activate, activateOffset, activateIndex,
    navigate, back, forward, reload, stop, move, pin, mute, duplicate, reopenClosed, zoom, find, stopFind,
    discard, setBadge, markClaude, focus: focusTab, restore, realizeActive, openUrls, openOrActivate, flushSession,
    broadcastState, normalizeUrl, checkDiscard,
    get activeId() { return activeId; },
    get closedCount() { return closed.length; },
    all: () => tabs.slice(),
    on(ev, cb) { emitter.on(ev, cb); return () => emitter.off(ev, cb); },
    off(ev, cb) { emitter.off(ev, cb); },
    once(ev, cb) { emitter.once(ev, cb); },
    NEWTAB,
    ZOOM_STEPS,
  };
}

function registerTabsIpc(ctx) {
  const T = ctx.tabs;
  const both = { allow: ['ui', 'internal'] };
  const idOf = (p, meta) => {
    if (p && p.id != null) return Number(p.id);
    if (meta && meta.kind === 'internal' && meta.tab) return meta.tab.id;
    return T.activeId;
  };
  // Ответ на invoke и рассылка состояния идут одним каналом: шлём состояние до ответа,
  // чтобы renderer, получив ответ, уже видел новую активную вкладку (иначе фокус адресной строки сбрасывается).
  const info = (tab) => { T.broadcastState(true); return tab ? T.list().find((x) => x.id === tab.id) || null : null; };

  ctx.ipc.handle('kosmo:tabs.list', () => ({ tabs: T.list(), activeId: T.activeId }), both);
  ctx.ipc.handle('kosmo:tabs.create', (p = {}, meta) => {
    const opts = {
      url: p.url, containerId: p.containerId, active: p.active !== false && !p.background,
      index: typeof p.index === 'number' ? p.index : undefined, pinned: !!p.pinned,
      openerId: p.openerId != null ? p.openerId : (meta.kind === 'internal' && meta.tab ? meta.tab.id : undefined),
    };
    return info(T.create(opts));
  }, both);
  ctx.ipc.handle('kosmo:tabs.close', (p = {}, meta) => {
    if (Array.isArray(p.ids)) { T.closeMany(p.ids); return true; }
    return T.close(idOf(p, meta));
  }, both);
  ctx.ipc.handle('kosmo:tabs.closeOthers', (p = {}, meta) => {
    const keep = idOf(p, meta);
    T.closeMany(T.all().filter((t) => t.id !== keep && !t.info.pinned).map((t) => t.id));
    return true;
  }, both);
  ctx.ipc.handle('kosmo:tabs.closeRight', (p = {}, meta) => {
    const all = T.all();
    const i = all.findIndex((t) => t.id === idOf(p, meta));
    if (i < 0) return false;
    T.closeMany(all.slice(i + 1).filter((t) => !t.info.pinned).map((t) => t.id));
    return true;
  }, both);
  ctx.ipc.handle('kosmo:tabs.activate', (p = {}) => {
    if (typeof p.offset === 'number') return info(T.activateOffset(p.offset));
    if (typeof p.index === 'number') return info(T.activateIndex(p.index));
    return info(T.activate(p.id));
  }, both);
  ctx.ipc.handle('kosmo:tabs.navigate', (p = {}, meta) => T.navigate(idOf(p, meta), p.url != null ? p.url : p.input), both);
  ctx.ipc.handle('kosmo:tabs.back', (p = {}, meta) => T.back(idOf(p, meta)), both);
  ctx.ipc.handle('kosmo:tabs.forward', (p = {}, meta) => T.forward(idOf(p, meta)), both);
  ctx.ipc.handle('kosmo:tabs.reload', (p = {}, meta) => T.reload(idOf(p, meta), !!p.hard), both);
  ctx.ipc.handle('kosmo:tabs.stop', (p = {}, meta) => T.stop(idOf(p, meta)), both);
  ctx.ipc.handle('kosmo:tabs.move', (p = {}) => T.move(p.id, p.index));
  ctx.ipc.handle('kosmo:tabs.pin', (p = {}, meta) => T.pin(idOf(p, meta), p.pinned));
  ctx.ipc.handle('kosmo:tabs.mute', (p = {}, meta) => T.mute(idOf(p, meta), p.muted));
  ctx.ipc.handle('kosmo:tabs.duplicate', (p = {}, meta) => info(T.duplicate(idOf(p, meta))), both);
  ctx.ipc.handle('kosmo:tabs.reopenClosed', () => info(T.reopenClosed()), both);
  ctx.ipc.handle('kosmo:tabs.zoom', (p = {}, meta) => T.zoom(idOf(p, meta), p.zoom), both);
  ctx.ipc.handle('kosmo:tabs.find', (p = {}, meta) => T.find(idOf(p, meta), p));
  ctx.ipc.handle('kosmo:tabs.stopFind', (p = {}, meta) => T.stopFind(idOf(p, meta), p.action));
  ctx.ipc.handle('kosmo:tabs.discard', (p = {}) => T.discard(p.id));
  ctx.ipc.handle('kosmo:tabs.focus', (p = {}) => T.focus(p.id));
}

module.exports = { createTabs, registerTabsIpc, NEWTAB, ERROR_PAGE };
