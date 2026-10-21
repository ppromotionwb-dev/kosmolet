'use strict';
// Главное окно и раскладка видов (ARCHITECTURE §6): chrome — собственный webContents окна,
// поверх — WebContentsView: активная вкладка, панель, DevTools, overlay (самый верхний).

const path = require('path');
const { EventEmitter } = require('events');

// Цвета нативных кнопок окна по умолчанию (фон полосы вкладок = --k-bg-sunken, символы = --k-text).
// Пресеты — фича themes (shared/tokens.css): менять вместе.
const TITLEBAR_COLORS = {
  cosmos: { color: '#0f121c', symbolColor: '#e4e7f2' },
  graphite: { color: '#0f0f11', symbolColor: '#e8e8ea' },
  light: { color: '#e5e8ef', symbolColor: '#1a1c24' },
  terminal: { color: '#000000', symbolColor: '#c8ead2' },
};
const WINDOW_BG = { cosmos: '#151926', graphite: '#18181b', light: '#f9fafb', terminal: '#050806' };

const DENSITY = { normal: { tab: 38, bar: 40 }, compact: { tab: 32, bar: 34 } };
const PANEL_MIN = 320;
const TAB_MIN = 400;

function createWindows(ctx) {
  const { BrowserWindow, screen } = ctx.electron;
  const emitter = new EventEmitter();
  const winState = ctx.store('window-state', {});
  let win = null;
  let activeView = null;
  let colorsOverridden = false;
  let fullscreenKind = null; // null | 'html' | 'window'
  let layoutTimer = null;

  const density = () => (ctx.settings.peek('ui.density') === 'compact' ? 'compact' : 'normal');
  let titleBarHeight = DENSITY[density()].tab;
  // До сообщения от chrome — полоса вкладок + панель навигации.
  let chromeHeight = DENSITY[density()].tab + DENSITY[density()].bar;

  function themeColors() {
    const ui = ctx.settings.peek('ui') || {};
    if (ui.theme === 'custom' && ui.custom) {
      return { color: ui.custom.bg || TITLEBAR_COLORS.cosmos.color, symbolColor: ui.custom.text || TITLEBAR_COLORS.cosmos.symbolColor };
    }
    return TITLEBAR_COLORS[ui.theme] || TITLEBAR_COLORS.cosmos;
  }
  let titleBarColors = Object.assign({}, themeColors());

  function windowBg() {
    const ui = ctx.settings.peek('ui') || {};
    if (ui.theme === 'custom' && ui.custom && ui.custom.bg) return ui.custom.bg;
    return WINDOW_BG[ui.theme] || WINDOW_BG.cosmos;
  }

  function restoreBounds() {
    const s = winState.get() || {};
    const b = s.bounds;
    const def = { width: 1360, height: 860 };
    if (!b || typeof b.width !== 'number') return def;
    const width = Math.max(640, b.width);
    const height = Math.max(400, b.height);
    // Окно должно хотя бы частично попадать в рабочую область какого-нибудь экрана.
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return b.x + 80 < a.x + a.width && b.x + width - 80 > a.x && b.y >= a.y - 10 && b.y + 40 < a.y + a.height;
    });
    return visible ? { x: b.x, y: b.y, width, height } : { width, height };
  }

  // dev --offscreen: окно справа за пределами всех экранов — не мешает пользователю,
  // а снимки (desktopCapturer) и отрисовка работают. Положение не сохраняется.
  function offscreenBounds(b) {
    const right = Math.max(...screen.getAllDisplays().map((d) => d.bounds.x + d.bounds.width));
    return { x: right + 40, y: 0, width: b.width, height: b.height };
  }

  function saveBounds() {
    if (!win || win.isDestroyed() || ctx.flags.offscreen) return;
    const maximized = win.isMaximized();
    const prev = winState.get() || {};
    const bounds = maximized || win.isFullScreen() || win.isMinimized() ? prev.bounds : win.getNormalBounds();
    winState.set({ bounds, maximized });
  }

  function uiWebPreferences(viewName) {
    return {
      session: ctx.sessions.ui(),
      preload: path.join(ctx.paths.src, 'preload', 'ui-preload.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // Панель и overlay не должны отнимать фокус при загрузке (overlay прогревается в фоне).
      focusOnNavigation: viewName === 'chrome',
      // Скрытый overlay должен сразу отрабатывать show/тему: без троттлинга (в покое он ничего не делает).
      backgroundThrottling: viewName !== 'overlay',
      additionalArguments: [
        '--kosmo-view=' + viewName,
        '--kosmo-app-version=' + ctx.app.getVersion(),
        '--kosmo-ui-modules=' + encodeURIComponent(JSON.stringify(ctx.uiPreload ? ctx.uiPreload.modules() : [])),
      ],
    };
  }

  // Адрес страницы интерфейса с темой в параметрах: UI-сессия в памяти (localStorage не переживает перезапуск),
  // а theme.js применяет ?theme=&accent=&density=&fs= синхронно — без вспышки темы по умолчанию.
  function uiUrl(page) {
    const ui = ctx.settings.peek('ui') || {};
    const q = new URLSearchParams();
    if (ui.theme) q.set('theme', ui.theme);
    if (ui.accent) q.set('accent', ui.accent);
    if (ui.density) q.set('density', ui.density);
    if (ui.fontSize) q.set('fs', String(ui.fontSize));
    return 'kosmo://ui/' + page + '?' + q.toString();
  }

  function create() {
    let bounds = restoreBounds();
    if (ctx.flags.offscreen) bounds = offscreenBounds(bounds);
    win = new BrowserWindow(Object.assign({}, bounds, {
      minWidth: 640,
      minHeight: 400,
      show: false,
      title: 'Космолёт',
      backgroundColor: windowBg(),
      titleBarStyle: 'hidden',
      titleBarOverlay: Object.assign({}, titleBarColors, { height: titleBarHeight }),
      icon: iconPath(),
      webPreferences: uiWebPreferences('chrome'),
    }));
    const wc = win.webContents;
    ctx.ipc.registerUi(wc);
    const wantMax = !!(winState.get() || {}).maximized && !ctx.flags.offscreen;

    let shown = false;
    const show = () => {
      if (shown || win.isDestroyed()) return;
      shown = true;
      // maximize() сам показывает окно (без фокуса), поэтому вызываем его здесь, а не сразу после создания.
      if (wantMax) { win.maximize(); if (!ctx.flags.dev) win.focus(); } else if (ctx.flags.dev) win.showInactive(); else win.show();
      ctx.log('windows', `окно показано через ${Math.round(process.uptime() * 1000)} мс от запуска процесса`);
      layout();
    };
    win.once('ready-to-show', show);
    setTimeout(show, 2500);

    wc.on('did-finish-load', () => {
      sendLayoutState();
      if (ctx.tabs) ctx.tabs.broadcastState(true);
      if (ctx.settings.peek('ui.theme') === 'custom') syncTitleBarFromChrome();
    });
    wc.on('render-process-gone', (_e, d) => {
      ctx.log('windows', 'процесс интерфейса завершился:', d.reason);
      if (d.reason !== 'clean-exit' && !ctx.quitting) setTimeout(() => { if (!win.isDestroyed()) wc.reload(); }, 500);
    });
    wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
      if (isMain && code !== -3) ctx.log('windows', 'chrome не загрузился:', code, desc, url);
    });
    // Интерфейс никуда не уходит со своей страницы.
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url) && ctx.tabs) ctx.tabs.create({ url });
      return { action: 'deny' };
    });

    for (const ev of ['resize', 'maximize', 'unmaximize', 'restore']) win.on(ev, () => { layout(); emitter.emit('resize'); });
    win.on('resized', saveBounds);
    win.on('moved', saveBounds);
    win.on('maximize', saveBounds);
    win.on('unmaximize', saveBounds);
    win.on('enter-full-screen', () => {
      if (!fullscreenKind) fullscreenKind = 'window';
      layout(); sendLayoutState();
    });
    win.on('leave-full-screen', () => {
      const was = fullscreenKind;
      fullscreenKind = null;
      if (was === 'html') exitHtmlFullscreenInTab();
      layout(); sendLayoutState();
    });
    win.on('blur', () => emitter.emit('blur'));
    win.on('focus', () => emitter.emit('focus'));
    // Кнопки мыши «назад/вперёд».
    win.on('app-command', (_e, cmd) => {
      const tab = ctx.tabs && ctx.tabs.active();
      if (!tab || !tab.wc) return;
      if (cmd === 'browser-backward' && tab.wc.navigationHistory.canGoBack()) tab.wc.navigationHistory.goBack();
      if (cmd === 'browser-forward' && tab.wc.navigationHistory.canGoForward()) tab.wc.navigationHistory.goForward();
    });
    // Закрытие главного окна = выход: сессию вкладок пишем до того, как виды начнут уничтожаться.
    win.on('close', () => {
      saveBounds();
      winState.flush();
      ctx.quitting = true;
      try { if (ctx.tabs) ctx.tabs.flushSession(); } catch (e) { ctx.log('windows', e); }
    });
    win.on('closed', () => { win = null; });

    wc.loadURL(uiUrl('chrome/index.html'));
    emitter.emit('created', win);
    return win;
  }

  function iconPath() {
    const p = path.join(ctx.paths.root, 'assets', 'icon.ico');
    try { require('fs').accessSync(p); return p; } catch (_) { return undefined; }
  }

  function contentSize() {
    if (!win || win.isDestroyed()) return { width: 0, height: 0 };
    const [width, height] = win.getContentSize();
    return { width, height };
  }

  function isFullscreen() { return !!fullscreenKind; }

  function panelWidthFor(W) {
    const want = ctx.panel && ctx.panel.desiredWidth ? ctx.panel.desiredWidth() : Number(ctx.settings.peek('ui.panelWidth')) || 460;
    const max = Math.max(PANEL_MIN, W - TAB_MIN);
    return Math.round(Math.min(Math.max(want, PANEL_MIN), max));
  }

  function geometry() {
    const { width: W, height: H } = contentSize();
    const fs = isFullscreen();
    const top = fs ? 0 : Math.min(chromeHeight, H);
    const panelOpen = !!(ctx.panel && ctx.panel.isOpen()) && !fs;
    const panelW = panelOpen ? Math.min(panelWidthFor(W), W) : 0;
    return {
      W, H, top, panelOpen, panelW,
      tab: { x: 0, y: top, width: Math.max(0, W - panelW), height: Math.max(0, H - top) },
      panel: { x: W - panelW, y: top, width: panelW, height: Math.max(0, H - top) },
    };
  }

  // Порядок дочерних видов: вкладка, панель (+ DevTools), overlay.
  function syncViews() {
    if (!win || win.isDestroyed()) return;
    const cv = win.contentView;
    const want = [];
    if (activeView) want.push(activeView);
    if (ctx.panel) for (const v of ctx.panel.views()) want.push(v);
    if (ctx.overlay) { const v = ctx.overlay.view(); if (v) want.push(v); }
    for (const v of cv.children.slice()) if (!want.includes(v)) cv.removeChildView(v);
    for (let j = 0; j < want.length; j++) {
      const cur = cv.children;
      if (cur[j] === want[j]) continue;
      if (cur.includes(want[j])) cv.removeChildView(want[j]);
      cv.addChildView(want[j], j);
    }
  }

  function layout() {
    if (!win || win.isDestroyed()) return;
    const g = geometry();
    syncViews();
    if (activeView) activeView.setBounds(g.tab);
    if (ctx.panel) ctx.panel.layout(g.panel, g.panelOpen);
    if (ctx.overlay) ctx.overlay.layout(g);
    emitter.emit('layout', g);
  }

  // Отложенная раскладка (для частых событий).
  function scheduleLayout() {
    if (layoutTimer) return;
    layoutTimer = setTimeout(() => { layoutTimer = null; layout(); }, 0);
  }

  function layoutState() {
    const p = ctx.panel;
    const { width } = contentSize();
    return {
      panelOpen: !!(p && p.isOpen()),
      panelWidth: panelWidthFor(width),
      panelTool: p ? p.tool() : ctx.settings.peek('ui.panelTool'),
      fullscreen: isFullscreen(),
      fullscreenKind,
      chromeHeight,
      titleBarHeight,
      maximized: !!(win && !win.isDestroyed() && win.isMaximized()),
    };
  }

  let stateTimer = null;
  function sendLayoutState() {
    if (stateTimer) return;
    stateTimer = setTimeout(() => {
      stateTimer = null;
      ctx.broadcast('kosmo:layout.state', layoutState());
    }, 16);
  }

  function setActiveView(view) {
    activeView = view || null;
    layout();
  }

  function setChromeHeight(px, tbh) {
    const h = Math.max(0, Math.min(400, Math.round(Number(px) || 0)));
    let changed = false;
    if (h && h !== chromeHeight) { chromeHeight = h; changed = true; }
    const t = Math.round(Number(tbh) || 0);
    if (t >= 20 && t <= 80 && t !== titleBarHeight) {
      titleBarHeight = t;
      applyTitleBar();
    }
    if (changed) { layout(); sendLayoutState(); }
    return chromeHeight;
  }

  function applyTitleBar() {
    if (!win || win.isDestroyed()) return;
    try { win.setTitleBarOverlay(Object.assign({}, titleBarColors, { height: titleBarHeight })); } catch (e) {
      ctx.log('windows', 'setTitleBarOverlay:', e.message);
    }
  }

  let syncTimer = null;
  function syncTitleBarFromChrome() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      if (!win || win.isDestroyed() || colorsOverridden) return;
      win.webContents.executeJavaScript('window.KChrome ? KChrome.titlebarColors() : null', true).then((c) => {
        if (!c || colorsOverridden || ctx.settings.peek('ui.theme') !== 'custom') return;
        if (/^#[0-9a-f]{6}$/i.test(c.color)) titleBarColors.color = c.color;
        if (/^#[0-9a-f]{6}$/i.test(c.symbolColor)) titleBarColors.symbolColor = c.symbolColor;
        applyTitleBar();
      }).catch(() => {});
    }, 120);
  }

  // {color, symbolColor} — свои цвета (дальше смена темы их не трогает); null — снова по теме интерфейса.
  function setTitleBarColors(c) {
    if (c === null) {
      colorsOverridden = false;
      titleBarColors = Object.assign({}, themeColors());
      applyTitleBar();
      return;
    }
    if (!c || typeof c !== 'object') return;
    colorsOverridden = true;
    if (typeof c.color === 'string') titleBarColors.color = c.color;
    if (typeof c.symbolColor === 'string') titleBarColors.symbolColor = c.symbolColor;
    applyTitleBar();
  }

  function exitHtmlFullscreenInTab() {
    const tab = ctx.tabs && ctx.tabs.active();
    if (tab && tab.wc && !tab.wc.isDestroyed()) {
      tab.wc.executeJavaScript('document.fullscreenElement && document.exitFullscreen()', true).catch(() => {});
    }
  }

  // Выйти из HTML5-полноэкранного режима: просим страницу, и на всякий случай снимаем режим окна сами.
  function exitHtmlFullscreen() {
    if (fullscreenKind !== 'html') return;
    exitHtmlFullscreenInTab();
    setTimeout(() => { if (fullscreenKind === 'html') setHtmlFullscreen(false); }, 300);
  }

  function setHtmlFullscreen(on) {
    if (!win || win.isDestroyed()) return;
    if (on) {
      fullscreenKind = 'html';
      if (!win.isFullScreen()) win.setFullScreen(true);
    } else if (fullscreenKind === 'html') {
      fullscreenKind = null;
      if (win.isFullScreen()) win.setFullScreen(false);
    }
    layout(); sendLayoutState();
  }

  function toggleFullscreen() {
    if (!win || win.isDestroyed()) return;
    if (win.isFullScreen()) {
      if (fullscreenKind === 'html') exitHtmlFullscreenInTab();
      win.setFullScreen(false);
    } else {
      fullscreenKind = 'window';
      win.setFullScreen(true);
    }
  }

  function focusWindow() {
    if (!win || win.isDestroyed() || ctx.flags.offscreen) return;
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
  }

  ctx.settings.on('change', (p) => {
    if (p === 'ui' || p.startsWith('ui.density')) {
      const d = DENSITY[density()];
      if (d.tab !== titleBarHeight) { titleBarHeight = d.tab; applyTitleBar(); }
    }
    if ((p === 'ui' || p.startsWith('ui.theme') || p.startsWith('ui.custom')) && !colorsOverridden) {
      titleBarColors = Object.assign({}, themeColors());
      applyTitleBar();
      if (win && !win.isDestroyed()) win.setBackgroundColor(windowBg());
      // Своя тема: фон полосы вкладок вычисляется в CSS (color-mix) — берём готовые цвета у chrome.
      if (ctx.settings.peek('ui.theme') === 'custom') syncTitleBarFromChrome();
    }
    if (p === 'ui' || p.startsWith('ui.panelWidth')) scheduleLayout();
  });

  return {
    get main() { return win; },
    get chromeHeight() { return chromeHeight; },
    get titleBarHeight() { return titleBarHeight; },
    create,
    layout,
    scheduleLayout,
    geometry,
    layoutState,
    sendLayoutState,
    setActiveView,
    get activeView() { return activeView; },
    setChromeHeight,
    setTitleBarColors,
    get titleBarColors() { return Object.assign({}, titleBarColors, { height: titleBarHeight }); },
    setHtmlFullscreen,
    exitHtmlFullscreen,
    toggleFullscreen,
    isFullscreen,
    focus: focusWindow,
    uiWebPreferences,
    uiUrl,
    contentSize,
    on(ev, cb) { emitter.on(ev, cb); return () => emitter.off(ev, cb); },
    off(ev, cb) { emitter.off(ev, cb); },
  };
}

function registerWindowsIpc(ctx) {
  ctx.ipc.handle('kosmo:layout.setChromeHeight', (p) => {
    if (typeof p === 'number') return ctx.windows.setChromeHeight(p);
    return ctx.windows.setChromeHeight(p && p.height, p && p.titleBarHeight);
  });
  ctx.ipc.handle('kosmo:layout.get', () => ctx.windows.layoutState(), { allow: ['ui', 'internal'] });
  ctx.ipc.handle('kosmo:window.toggleFullscreen', () => { ctx.windows.toggleFullscreen(); return true; });
}

module.exports = { createWindows, registerWindowsIpc, PANEL_MIN, TAB_MIN };
