'use strict';
// Фича «devtools»: встроенный Chrome DevTools в панели, «Сеть и API», «Хранилище», «Устройство», настройки.
//
// DevTools в панели: на каждую вкладку свой одноразовый вид (ctx.panel.createDevtoolsView), DevTools открываются
// в него: wc.setDevToolsWebContents(view.webContents) → openDevTools({mode:'detach', activate:false}).
// Важно (проверено): закрывать DevTools (closeDevTools) нужно ДО уничтожения их webContents, а перезагрузка
// фронтенда DevTools рвёт связь с вкладкой — поэтому настройки фронтенда (тема, без плашки языка, без
// «What's new») меняются живьём через его модуль Settings, а настройки, требующие перезапуска, — пересозданием вида.
// Живых видов не больше MAX_DOCKS (самые давние закрываются — их вкладки снова можно выгружать).

const fs = require('fs');
const path = require('path');
const { createEmulation } = require('./devtools/emulation');
const { createStorage } = require('./devtools/storage');
const { createNetwork } = require('./devtools/network');

const MAX_DOCKS = 4;
const INSPECT_WINDOW_MS = 2500;

function createDevtools(ctx) {
  const docks = new Map(); // tabId → {tabId, wc, view, dwc, external, ready, lastShown, recreated}
  const lastMenu = new Map(); // wc.id → {x, y, at} — последнее контекстное меню вкладки (для «Исследовать элемент»)
  let dockState = null;

  const S = ctx.settings;
  const lightUi = () => {
    const ui = S.peek('ui') || {};
    if (ui.theme === 'light') return true;
    if (ui.theme === 'custom' && ui.custom && ui.custom.bg) {
      const m = /^#?([0-9a-f]{6})$/i.exec(ui.custom.bg);
      if (m) { const n = parseInt(m[1], 16); const l = (0.2126 * (n >> 16 & 255) + 0.7152 * (n >> 8 & 255) + 0.0722 * (n & 255)) / 255; return l > 0.55; }
    }
    return false;
  };
  const frontendPrefs = () => ({
    'ui-theme': lightUi() ? 'default' : 'dark',
    'disable-locale-info-bar': true,
    'help.show-release-note': false,
    // русской локали во фронтенде DevTools Electron нет (ru.json не входит в сборку) — только английский
    language: 'en-US',
  });

  // Записать настройки фронтенда в Preferences раздела до создания сессии — первые DevTools сразу тёмные
  // и без плашки «DevTools is now available in Russian». (Electron хранит их в electron.devtools.preferences.)
  function seedPrefs(containerId) {
    // сессия уже создана — Chromium держит Preferences в памяти и перезапишет файл; там настройки применятся живьём
    if (ctx.sessions.all().some((x) => x.id === containerId)) return;
    const dir = path.join(ctx.paths.userData, 'Partitions', 'c-' + containerId);
    const file = path.join(dir, 'Preferences');
    try {
      let data = {};
      try { data = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (_) { data = {}; }
      if (!data.electron || typeof data.electron !== 'object') data.electron = {};
      if (!data.electron.devtools || typeof data.electron.devtools !== 'object') data.electron.devtools = {};
      const prefs = data.electron.devtools.preferences && typeof data.electron.devtools.preferences === 'object' ? data.electron.devtools.preferences : {};
      let changed = false;
      for (const [k, v] of Object.entries(frontendPrefs())) {
        const j = JSON.stringify(v);
        if (prefs[k] !== j) { prefs[k] = j; changed = true; }
      }
      if (!changed) return;
      data.electron.devtools.preferences = prefs;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data));
    } catch (e) { ctx.log('devtools', 'настройки DevTools не записаны:', e.message); }
  }

  // Применить настройки во фронтенде DevTools живьём. → список изменённых.
  function applyFrontend(dwc) {
    if (!dwc || dwc.isDestroyed()) return Promise.resolve([]);
    const want = frontendPrefs();
    const code = `(async () => {
      const Common = await import('./core/common/common.js');
      // Settings создаются при запуске фронтенда — до этого ждём (did-finish-load приходит раньше)
      let S = null;
      for (let i = 0; i < 100 && !S; i++) {
        try { S = Common.Settings.Settings.instance(); } catch (e) { await new Promise((r) => setTimeout(r, 100)); }
      }
      if (!S) return [];
      const st = (n, d) => { try { return S.moduleSetting(n); } catch (e) { return S.createSetting(n, d); } };
      const want = ${JSON.stringify(want)};
      const changed = [];
      for (const k of Object.keys(want)) {
        const s = st(k, want[k]);
        if (JSON.stringify(s.get()) !== JSON.stringify(want[k])) { s.set(want[k]); changed.push(k); }
      }
      return changed;
    })()`;
    return dwc.executeJavaScript(code, false).catch((e) => { ctx.log('devtools', 'настройки фронтенда DevTools:', e.message); return []; });
  }

  // ---------- док ----------

  function panelShowsDevtools() { return ctx.panel.isOpen() && ctx.panel.tool() === 'devtools'; }

  function setPanelView(v) {
    if (ctx.panel.devtoolsViewIfCreated !== v) ctx.panel.setDevtoolsView(v || null);
  }

  function pushState() {
    const tab = ctx.tabs.active();
    const d = tab ? docks.get(tab.id) : null;
    let state = 'none';
    if (!tab) state = 'none';
    else if (!tab.wc) state = 'unloaded';
    else if (d && d.external) state = 'external';
    else if (d) state = d.ready ? 'ready' : 'loading';
    const st = { tabId: tab ? tab.id : null, state, url: tab ? tab.info.url : '', title: tab ? tab.info.title : '' };
    const key = JSON.stringify(st);
    if (key === dockState) return st;
    dockState = key;
    ctx.panel.send('kosmo:devtools.dock', st);
    return st;
  }

  function destroyDock(d) {
    if (!d) return;
    if (docks.get(d.tabId) === d) docks.delete(d.tabId);
    d.dead = true;
    if (d.view && ctx.panel.devtoolsViewIfCreated === d.view) ctx.panel.setDevtoolsView(null);
    // порядок важен: сначала закрыть DevTools у вкладки, потом уничтожить их webContents
    try { if (d.wc && !d.wc.isDestroyed() && d.wc.devToolsWebContents) d.wc.closeDevTools(); } catch (_) { /* уже */ }
    if (d.win) { try { if (!d.win.isDestroyed()) d.win.destroy(); } catch (_) { /* уже */ } return; }
    try { if (d.dwc && !d.dwc.isDestroyed()) d.dwc.close(); } catch (_) { /* уже */ }
  }

  function createDock(tab) {
    const wc = tab.wc;
    // DevTools уже открыты иначе (отдельное окно не нашей командой) — закрываем, чтобы встроить
    if (wc.isDevToolsOpened()) { try { wc.closeDevTools(); } catch (_) { /* нет */ } }
    const view = ctx.panel.createDevtoolsView();
    const dwc = view.webContents;
    const d = { tabId: tab.id, wc, view, dwc, external: false, ready: false, lastShown: Date.now(), dead: false };
    docks.set(tab.id, d);
    dwc.on('did-finish-load', () => {
      if (d.dead) return;
      applyFrontend(dwc).then((changed) => {
        if (d.dead) return;
        // язык и плашка языка применяются только при загрузке фронтенда — один раз пересоздаём вид
        if (!d.recreated && (changed.includes('language') || changed.includes('disable-locale-info-bar'))) {
          ctx.log('devtools', `вкладка ${tab.id}: настройки DevTools применены, вид пересоздан`);
          recreate(tab.id);
          return;
        }
        d.ready = true;
        pushState();
      });
    });
    dwc.on('render-process-gone', () => { if (!d.dead) { destroyDock(d); setImmediate(sync); } });
    wc.setDevToolsWebContents(dwc);
    wc.openDevTools({ mode: 'detach', activate: false });
    return d;
  }

  // «Исследовать элемент» из контекстного меню. Core открывает панель и через 50 мс зовёт inspectElement(x, y),
  // но если панель была закрыта, страница сужается и под (x, y) оказывается другой элемент. Поэтому узел под
  // курсором запоминаем в момент меню (DOM.getNodeForLocation) и после открытия DevTools показываем именно его.
  function noteMenu(tab, wc, p) {
    const m = { x: p.x, y: p.y, at: Date.now(), node: null, used: false };
    lastMenu.set(wc.id, m);
    if (!ctx.cdp.isAttached(tab.id)) return;
    const z = wc.getZoomFactor() || 1;
    ctx.cdp.send(tab.id, 'DOM.getNodeForLocation', { x: Math.round(p.x / z), y: Math.round(p.y / z), includeUserAgentShadowDOM: false, ignorePointerEventsNone: true })
      .then((r) => { m.node = r && r.backendNodeId ? r.backendNodeId : null; }).catch(() => {});
  }
  function maybeReveal(d) {
    const m = lastMenu.get(d.wc.id);
    if (!m || m.used || Date.now() - m.at > INSPECT_WINDOW_MS) return;
    m.used = true;
    const run = () => {
      if (d.dead || !m.node || !d.dwc || d.dwc.isDestroyed()) return;
      d.dwc.executeJavaScript(`(async () => {
        const SDK = await import('./core/sdk/sdk.js');
        const Common = await import('./core/common/common.js');
        let target = null;
        for (let i = 0; i < 60 && !target; i++) {
          target = SDK.TargetManager.TargetManager.instance().primaryPageTarget();
          if (!target) await new Promise((r) => setTimeout(r, 100));
        }
        if (!target) return false;
        const node = await new SDK.DOMModel.DeferredDOMNode(target, ${Number(m.node)}).resolvePromise();
        if (!node) return false;
        await Common.Revealer.reveal(node);
        return true;
      })()`, false).catch((e) => ctx.log('devtools', 'исследовать элемент:', e.message));
    };
    // после inspectElement(x, y) из core (50 мс) — наш точный узел поверх
    if (d.ready) setTimeout(run, 250);
    else d.dwc.once('did-finish-load', () => setTimeout(run, 500));
  }

  // Закрыть док и дождаться уничтожения его webContents. Новые DevTools той же вкладки можно открывать только
  // после этого: если старый фронтенд умирает позже, он рвёт связь новому (проверено).
  function destroyDockAndWait(d) {
    return new Promise((resolve) => {
      const dwc = d ? d.dwc : null;
      if (!dwc || dwc.isDestroyed()) { destroyDock(d); setImmediate(resolve); return; }
      const t = setTimeout(resolve, 2000);
      dwc.once('destroyed', () => { clearTimeout(t); setImmediate(resolve); });
      destroyDock(d);
    });
  }

  let recreating = false;
  async function recreate(tabId) {
    const d = docks.get(tabId);
    if (!d) return;
    recreating = true;
    try { await destroyDockAndWait(d); } finally { recreating = false; }
    const tab = ctx.tabs.get(tabId);
    if (!tab || !tab.wc || docks.has(tabId)) { pushState(); return; }
    if (panelShowsDevtools() && ctx.tabs.activeId === tabId) {
      const nd = createDock(tab);
      nd.recreated = true;
      setPanelView(nd.view);
    }
    pushState();
  }

  function trim(keepId) {
    const live = Array.from(docks.values()).filter((d) => !d.external && d.tabId !== keepId);
    if (live.length + 1 <= MAX_DOCKS) return;
    live.sort((a, b) => a.lastShown - b.lastShown);
    for (const d of live.slice(0, live.length + 1 - MAX_DOCKS)) destroyDock(d);
  }

  // Показать DevTools активной вкладки, если в панели выбран инструмент devtools.
  function sync() {
    if (!panelShowsDevtools() || recreating) { pushState(); return; }
    const tab = ctx.tabs.active();
    if (!tab || !tab.wc || tab.wc.isDestroyed()) { setPanelView(null); pushState(); return; }
    let d = docks.get(tab.id);
    if (d && (d.wc !== tab.wc || d.wc.isDestroyed())) { destroyDock(d); d = null; }
    if (d && d.external) { setPanelView(null); pushState(); return; }
    if (!d) d = createDock(tab);
    d.lastShown = Date.now();
    setPanelView(d.view);
    trim(tab.id);
    maybeReveal(d);
    pushState();
  }

  // DevTools в отдельном окне — в нашем BrowserWindow (встроенный «detach» Electron после встраивания в панель
  // не открывается): так управляем размером, заголовком и фоном, а закрытие окна возвращает DevTools в панель.
  async function openWindow(tabId, opts = {}) {
    const { BrowserWindow, screen } = ctx.electron;
    const tab = tabId != null ? ctx.tabs.get(tabId) : ctx.tabs.active();
    if (!tab) return false;
    if (!tab.wc) ctx.tabs.activate(tab.id);
    const wc = tab.wc;
    if (!wc || wc.isDestroyed()) return false;
    const old = docks.get(tab.id);
    if (old && old.external) { if (old.win && !old.win.isDestroyed()) { old.win.show(); old.win.focus(); } return true; }
    const d = { tabId: tab.id, wc, view: null, dwc: null, win: null, external: true, ready: true, lastShown: Date.now(), dead: false };
    docks.set(tab.id, d); // место занято — sync() не создаст встроенные, пока ждём
    if (old) await destroyDockAndWait(old);
    if (wc.isDestroyed() || docks.get(tab.id) !== d) return false;
    if (ctx.tabs.activeId === tab.id) setPanelView(null);
    const main = ctx.windows.main;
    const mb = main && !main.isDestroyed() ? main.getBounds() : { x: 100, y: 100, width: 1400, height: 900 };
    const w = Math.min(1100, Math.max(700, Math.round(mb.width * 0.7))), hgt = Math.min(800, Math.max(500, Math.round(mb.height * 0.8)));
    let x = mb.x + Math.round((mb.width - w) / 2), y = mb.y + Math.round((mb.height - hgt) / 2);
    if (ctx.flags.offscreen) x = Math.max(...screen.getAllDisplays().map((dd) => dd.bounds.x + dd.bounds.width)) + 60; // dev: не мешать пользователю
    const title = 'DevTools — ' + (tab.info.title || tab.info.url);
    const win = new BrowserWindow({
      x, y, width: w, height: hgt, show: false, title, autoHideMenuBar: true,
      backgroundColor: lightUi() ? '#ffffff' : '#282828',
      icon: (() => { const p = path.join(ctx.paths.root, 'assets', 'icon.ico'); try { fs.accessSync(p); return p; } catch (_) { return undefined; } })(),
    });
    win.removeMenu();
    d.win = win; d.dwc = win.webContents;
    ctx.commands.attach(win.webContents, 'devtools');
    win.webContents.once('did-finish-load', () => applyFrontend(win.webContents));
    win.on('page-title-updated', (e) => e.preventDefault());
    win.once('ready-to-show', () => { if (!win.isDestroyed()) { if (opts.activate === false || ctx.flags.offscreen) win.showInactive(); else win.show(); } });
    setTimeout(() => { if (!win.isDestroyed() && !win.isVisible()) win.showInactive(); }, 2500);
    // окно закрыли — сначала DevTools у вкладки, затем док освобождается (и панель может встроить их снова)
    win.on('close', () => { try { if (!wc.isDestroyed()) wc.closeDevTools(); } catch (_) { /* уже */ } });
    const dwc = win.webContents;
    win.on('closed', () => {
      if (docks.get(tab.id) === d) {
        docks.delete(tab.id); d.dead = true;
        // встроить снова можно только после смерти фронтенда в окне
        if (dwc.isDestroyed()) setImmediate(sync); else dwc.once('destroyed', () => setImmediate(sync));
      }
      pushState();
    });
    wc.setDevToolsWebContents(win.webContents);
    wc.openDevTools({ mode: 'detach', activate: false });
    pushState();
    return true;
  }

  async function dockBack(tabId) {
    const id = tabId != null ? Number(tabId) : ctx.tabs.activeId;
    const d = docks.get(id);
    if (d && d.external) await destroyDockAndWait(d);
    if (!panelShowsDevtools()) ctx.panel.open('devtools'); else sync();
    return true;
  }

  // Режим выбора элемента на странице (как Ctrl+Shift+C в Chrome).
  async function pickElement() {
    ctx.panel.open('devtools');
    const tab = ctx.tabs.active();
    const d = tab && docks.get(tab.id);
    if (!d || !d.dwc || d.external) return false;
    const run = () => d.dwc.executeJavaScript(`(async () => {
      const UI = await import('./ui/legacy/legacy.js');
      const a = UI.ActionRegistry.ActionRegistry.instance().getAction('elements.toggle-element-search');
      await a.execute();
      return true;
    })()`, true).catch((e) => { ctx.log('devtools', 'выбор элемента:', e.message); return false; });
    if (d.ready) return run();
    return new Promise((resolve) => d.dwc.once('did-finish-load', () => setTimeout(() => resolve(run()), 300)));
  }

  // ---------- события ----------

  ctx.panel.on('opened', () => sync());
  ctx.panel.on('tool-changed', () => sync());
  ctx.panel.on('closed', () => pushState());
  ctx.tabs.on('activated', () => sync());
  ctx.tabs.on('view-created', (tab, wc) => {
    wc.on('context-menu', (_e, p) => noteMenu(tab, wc, p));
    wc.once('destroyed', () => lastMenu.delete(wc.id));
    if (tab.id === ctx.tabs.activeId) setImmediate(sync);
  });
  ctx.tabs.on('view-destroyed', (tab) => { const d = docks.get(tab.id); if (d) destroyDock(d); pushState(); });
  ctx.tabs.on('closed', (tab) => { const d = docks.get(tab.id); if (d) destroyDock(d); });
  ctx.tabs.on('navigated', (tab) => { if (tab.id === ctx.tabs.activeId) pushState(); });

  S.on('change', (p) => {
    if (p === 'ui' || p.startsWith('ui.theme') || p.startsWith('ui.custom')) {
      for (const d of docks.values()) if (d.dwc && !d.dead) applyFrontend(d.dwc);
    }
    if (p === 'containers') for (const c of ctx.sessions.containers()) seedPrefs(c.id);
  });

  return {
    sync, openWindow, dockBack, pickElement, pushState, seedPrefs,
    // для проверок: то же, что делает правый клик по странице
    noteMenu: (tabId, p) => { const t = ctx.tabs.get(tabId); if (t && t.wc) noteMenu(t, t.wc, p); },
    state: pushState,
    docks: () => Array.from(docks.values()).map((d) => ({ tabId: d.tabId, external: d.external, ready: d.ready })),
  };
}

module.exports = {
  id: 'devtools',
  init(ctx) {
    const dock = createDevtools(ctx);
    for (const c of ctx.sessions.containers()) dock.seedPrefs(c.id);
    const emu = createEmulation(ctx);
    const storage = createStorage(ctx);
    const net = createNetwork(ctx);
    storage.register();
    net.register();
    ctx.devtools = { dock, emu, storage, net };

    // ---------- IPC ----------
    const tabIdOf = (p) => (p && p.tabId != null ? Number(p.tabId) : ctx.tabs.activeId);
    ctx.ipc.handle('kosmo:devtools.state', () => dock.state());
    ctx.ipc.handle('kosmo:devtools.openWindow', (p) => dock.openWindow(p && p.tabId));
    ctx.ipc.handle('kosmo:devtools.dockBack', (p) => dock.dockBack(p && p.tabId));
    ctx.ipc.handle('kosmo:devtools.pick', () => dock.pickElement());
    ctx.ipc.handle('kosmo:emu.get', (p) => Object.assign(emu.get(tabIdOf(p)), { devices: emu.DEVICES.map((d) => ({ id: d.id, title: d.title, w: d.w, h: d.h, dpr: d.dpr, mobile: d.mobile, icon: d.icon, group: d.group })), networks: emu.NETWORKS.map((n) => ({ id: n.id, title: n.title })) }));
    ctx.ipc.handle('kosmo:emu.set', (p) => emu.set(tabIdOf(p), (p && p.patch) || {}));
    ctx.ipc.handle('kosmo:emu.reset', (p) => emu.reset(tabIdOf(p)));
    // раздел настроек: что сейчас с удалённой отладкой
    ctx.ipc.handle('kosmo:devtools.info', () => {
      const sw = ctx.app.commandLine.hasSwitch('remote-debugging-port') ? ctx.app.commandLine.getSwitchValue('remote-debugging-port') : '';
      return { remotePort: sw ? Number(sw) : null, fromFlag: !!ctx.flags.cdpPort, dev: !!ctx.flags.dev };
    }, { allow: ['ui', 'internal'] });
    ctx.ipc.handle('kosmo:devtools.relaunch', () => {
      ctx.app.relaunch();
      ctx.app.quit();
      return true;
    }, { allow: ['ui', 'internal'] });

    // ---------- команды ----------
    const R = (def) => ctx.commands.register(Object.assign({ category: 'Разработка' }, def));
    const active = () => ctx.tabs.activeId;
    const web = () => { const t = ctx.tabs.active(); return !!t && /^https?:/i.test(t.info.url); };
    R({ id: 'devtools.window', title: 'DevTools в отдельном окне', appMenu: { section: 'tools', order: 12 }, run: () => dock.openWindow() });
    R({ id: 'devtools.dock', title: 'DevTools в панель', run: () => dock.dockBack() });
    R({ id: 'devtools.pick', title: 'Выбрать элемент на странице', keys: ['Ctrl+Shift+C'], scopes: ['chrome', 'tab'], repeat: false, run: () => dock.pickElement() });
    R({ id: 'devtools.network', title: 'Сеть и API', run: () => ctx.panel.open('network') });
    R({ id: 'devtools.storage', title: 'Хранилище: cookies и localStorage', run: () => ctx.panel.open('storage') });
    R({ id: 'devtools.emulation', title: 'Эмуляция устройства', run: () => ctx.panel.open('emulation') });
    R({ id: 'net.clear', title: 'Сеть: очистить журнал', run: () => ctx.cdp.clear(active()) });
    R({ id: 'net.har', title: 'Сеть: сохранить HAR', run: () => net.exportHar({ tabId: active() }) });
    for (const d of emu.DEVICES) {
      R({ id: 'emu.' + d.id, title: `Эмуляция: ${d.title} (${d.w}×${d.h})`, when: web, run: () => emu.set(active(), { device: d.id, rotate: false }) });
    }
    R({ id: 'emu.rotate', title: 'Эмуляция: повернуть', when: () => !!emu.get(active()).device, run: () => emu.set(active(), { rotate: !emu.get(active()).rotate }) });
    R({ id: 'emu.reset', title: 'Эмуляция: сбросить всё', when: () => emu.isActive(active()), run: () => emu.reset(active()) });
    R({ id: 'emu.offline', title: 'Сеть: офлайн (вкл./выкл.)', when: web, run: () => emu.set(active(), { net: emu.get(active()).net === 'offline' ? 'none' : 'offline' }) });
    R({ id: 'emu.slow4g', title: 'Сеть: медленный 4G (вкл./выкл.)', when: web, run: () => emu.set(active(), { net: emu.get(active()).net === 'slow4g' ? 'none' : 'slow4g' }) });
    R({ id: 'emu.nocache', title: 'Отключить кэш (вкл./выкл.)', when: web, run: () => emu.set(active(), { noCache: !emu.get(active()).noCache }) });
    R({ id: 'emu.dark', title: 'Эмуляция: тёмная схема сайта (вкл./выкл.)', when: web, run: () => emu.set(active(), { scheme: emu.get(active()).scheme === 'dark' ? '' : 'dark' }) });
    R({ id: 'emu.print', title: 'Эмуляция: режим печати (вкл./выкл.)', when: web, run: () => emu.set(active(), { print: !emu.get(active()).print }) });
  },
};
