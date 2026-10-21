'use strict';
// Космолёт — точка входа main-процесса (ARCHITECTURE §2–§3): флаги, профиль, протокол, single-instance, порядок init.

const path = require('path');
const fs = require('fs');
const electron = require('electron');
const { app, protocol } = electron;

const ROOT = path.resolve(__dirname, '..', '..');
const FEATURES = ['platform', 'themes', 'cdp-hub', 'devtools', 'ux-chrome', 'claude-bridge', 'claude-terminal', 'tools-pack'];
const URL_ARG_RE = /^(https?|kosmo|file|about|view-source):/i;

// ---------- флаги ----------

function parseFlags(argv) {
  const flags = {
    dev: false, profile: null, devPort: 47399, cdpPort: null, mcpPort: null, noRestore: false,
    open: [], selftest: false, uiRoot: null, offscreen: false, raw: {},
  };
  for (const a of argv) {
    if (typeof a !== 'string') continue;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
      const val = eq > 0 ? a.slice(eq + 1) : true;
      flags.raw[key] = val;
      switch (key) {
        case 'dev': flags.dev = true; break;
        case 'profile': if (typeof val === 'string' && /^[\w.-]{1,64}$/.test(val)) flags.profile = val; break;
        case 'dev-port': flags.devPort = Number(val) || flags.devPort; break;
        case 'cdp-port': flags.cdpPort = Number(val) || null; break;
        case 'mcp-port': flags.mcpPort = Number(val) || null; break;
        case 'no-restore': flags.noRestore = true; break;
        case 'open': if (typeof val === 'string' && val) flags.open.push(val); break;
        case 'selftest': flags.selftest = true; break;
        case 'ui-root': if (typeof val === 'string') flags.uiRoot = val; break;
        case 'offscreen': flags.offscreen = true; break;
        default: break;
      }
    } else if (URL_ARG_RE.test(a)) {
      flags.open.push(a); // ассоциация «браузер по умолчанию» передаёт адрес позиционным аргументом
    }
  }
  if (flags.dev && !flags.cdpPort) flags.cdpPort = 9333;
  if (!flags.dev) flags.offscreen = false;
  return flags;
}

const flags = parseFlags(process.argv.slice(1));

// ---------- профиль ----------

app.setName('Kosmolet');
if (flags.profile) app.setPath('userData', path.join(ROOT, '.profiles', flags.profile));
else app.setPath('userData', path.join(app.getPath('appData'), 'Kosmolet'));
const USER_DATA = app.getPath('userData');
try { fs.mkdirSync(USER_DATA, { recursive: true }); } catch (_) {}

// corsEnabled:false — сайты не могут читать kosmo:// через fetch/XHR (обработчик протокола не видит Origin,
// отличить запрос сайта иначе нельзя). Внутри kosmo:// same-origin fetch и ES-модули работают.
protocol.registerSchemesAsPrivileged([{
  scheme: 'kosmo',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false, stream: true, codeCache: true },
}]);

// Remote debugging: в dev — всегда (порт из флагов), иначе — по настройке devtools.remoteDebugging.
(function remoteDebugging() {
  let port = flags.cdpPort;
  if (!port) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(USER_DATA, 'settings.json'), 'utf8'));
      if (s && s.devtools && s.devtools.remoteDebugging) port = Number(s.devtools.remoteDebuggingPort) || 9222;
    } catch (_) { /* настроек ещё нет */ }
  }
  if (port) app.commandLine.appendSwitch('remote-debugging-port', String(port));
})();

// В dev окно показывается без фокуса и часто перекрыто другими окнами: без этого Chromium считает
// вкладки скрытыми (occlusion), не рисует их и скриншоты выходят пустыми.
if (flags.dev) app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

app.setAppUserModelId('Kosmolet');

if (!app.requestSingleInstanceLock({ argv: process.argv.slice(1) })) {
  app.quit();
} else {
  boot();
}

// ---------- запуск ----------

function boot() {
  let ctx = null;
  const early = []; // адреса из второго запуска до готовности

  process.on('uncaughtException', (e) => {
    if (ctx) ctx.log('main', 'необработанное исключение:', e); else console.error(e);
  });
  process.on('unhandledRejection', (e) => {
    if (ctx) ctx.log('main', 'необработанный отказ промиса:', e); else console.error(e);
  });

  app.on('second-instance', (_e, argv) => {
    const f = parseFlags((argv || []).slice(1));
    if (!ctx || !ctx.ready) { early.push(...f.open); return; }
    ctx.windows.focus();
    if (f.open.length) ctx.tabs.openUrls(f.open);
  });

  app.on('window-all-closed', () => app.quit());

  app.whenReady().then(() => {
    const t0 = Date.now();
    const { createCtx } = require('./ctx');
    const paths = {
      root: ROOT,
      src: path.join(ROOT, 'src'),
      renderer: path.join(ROOT, 'src', 'renderer'),
      userData: USER_DATA,
      devOut: path.join(ROOT, 'tools', 'dev-out'),
      gen: path.join(USER_DATA, 'gen'),
    };
    ctx = createCtx({ app, electron, flags, paths });
    const log = ctx.log;
    log('main', `старт: Electron ${process.versions.electron}, Chromium ${process.versions.chrome}, профиль ${USER_DATA}${flags.dev ? ', dev' : ''}`);

    // Ядро.
    const { createSettings, registerSettingsIpc } = require('./settings');
    const { createIpc } = require('./ipc');
    const { createSessions } = require('./sessions');
    const { createPreloadComposer } = require('./preload-composer');
    const { createSearch, registerSearchIpc } = require('./search');
    const { createCommands, registerCommandsIpc } = require('./commands');
    const { createContextMenu } = require('./context-menu');
    const { createWindows, registerWindowsIpc } = require('./windows');
    const { createTabs, registerTabsIpc } = require('./tabs');
    const { createPanel, registerPanelIpc } = require('./panel');
    const { createOverlay, registerOverlayIpc } = require('./overlay');

    ctx.settings = createSettings(ctx);
    ctx.ipc = createIpc(ctx);
    ctx.broadcast = makeBroadcast(ctx);
    ctx.preload = createPreloadComposer(ctx);
    ctx.uiPreload = makeUiPreload();
    ctx.sessions = createSessions(ctx);
    ctx.search = createSearch(ctx);
    ctx.commands = createCommands(ctx);
    ctx.contextMenu = createContextMenu(ctx);
    ctx.windows = createWindows(ctx);
    ctx.tabs = createTabs(ctx);
    ctx.panel = createPanel(ctx);
    ctx.overlay = createOverlay(ctx);

    registerSettingsIpc(ctx);
    registerSearchIpc(ctx);
    registerCommandsIpc(ctx);
    registerWindowsIpc(ctx);
    registerTabsIpc(ctx);
    registerPanelIpc(ctx);
    registerOverlayIpc(ctx);
    registerAppIpc(ctx);
    ctx.commands.registerBase();
    wireInput(ctx);

    // Фичи: синхронная фаза init.
    for (const id of FEATURES) {
      try {
        const mod = require(`./features/${id}.js`);
        ctx.features[id] = mod;
        if (mod && typeof mod.init === 'function') mod.init(ctx);
      } catch (e) {
        log('features', `фича ${id} не инициализирована:`, e);
        ctx.featureErrors.push({ id, phase: 'init', message: e.message, stack: e.stack });
      }
    }

    // tab-preload → в сессии; окно и интерфейс; вкладки.
    try {
      ctx.sessions.setPreloadPath(ctx.preload.build());
    } catch (e) {
      log('main', 'сборка tab-preload не удалась:', e);
    }
    ctx.sessions.get('main');
    const win = ctx.windows.create();
    ctx.bus.emit('windows:created', win);
    // Вкладки восстанавливаются сразу (модель), а view активной создаётся после dom-ready интерфейса:
    // так рендерер вкладки не конкурирует с chrome за холодный старт и окно появляется вдвое быстрее.
    ctx.tabs.restore({ deferViews: true });
    let realized = false;
    const realize = () => { if (realized) return; realized = true; ctx.tabs.realizeActive(); };
    win.webContents.once('dom-ready', realize);
    // Замеры холодного старта (от запуска процесса).
    const upMs = () => Math.round(process.uptime() * 1000);
    win.webContents.once('did-finish-load', () => log('main', `интерфейс загружен через ${upMs()} мс от запуска процесса`));
    ctx.tabs.once('loaded', (t) => log('main', `первая вкладка загружена через ${upMs()} мс от запуска процесса (${t.info.url})`));
    setTimeout(realize, 1500);
    if (early.length) ctx.tabs.openUrls(early.splice(0));

    app.on('before-quit', () => {
      ctx.quitting = true;
      try { ctx.tabs.flushSession(); } catch (e) { log('main', e); }
      try { ctx.store.flushAll(); } catch (e) { log('main', e); }
    });

    ctx.ready = true;
    ctx.bus.emit('ready');
    log('main', `готов за ${Date.now() - t0} мс (app ready через ${upMs() - (Date.now() - t0)} мс от запуска процесса)`);

    for (const id of FEATURES) {
      const mod = ctx.features[id];
      if (!mod || typeof mod.start !== 'function') continue;
      Promise.resolve().then(() => mod.start(ctx)).catch((e) => {
        log('features', `фича ${id}: ошибка start:`, e);
        ctx.featureErrors.push({ id, phase: 'start', message: e.message, stack: e.stack });
      });
    }

    // Overlay прогреваем после загрузки первой вкладки (не мешая холодному старту),
    // чтобы первая подсказка адресной строки не ждала создания вида.
    let warmed = false;
    const warm = () => { if (warmed) return; warmed = true; ctx.overlay.warm(); };
    ctx.tabs.once('loaded', () => setTimeout(warm, 200));
    setTimeout(warm, 4000);

    if (flags.dev) {
      const { createDevServer } = require('./dev-server');
      ctx.devServer = createDevServer(ctx);
      ctx.devServer.start();
    }
  }).catch((e) => {
    console.error('Космолёт: ошибка запуска', e);
    if (ctx) ctx.log('main', 'ошибка запуска:', e);
  });
}

// Рассылка во все UI webContents и во вкладки с внутренними страницами.
function makeBroadcast(ctx) {
  return function broadcast(channel, payload) {
    const targets = [];
    const win = ctx.windows && ctx.windows.main;
    if (win && !win.isDestroyed()) targets.push(win.webContents);
    const pw = ctx.panel && ctx.panel.webContents();
    if (pw) targets.push(pw);
    const ow = ctx.overlay && ctx.overlay.webContents();
    if (ow) targets.push(ow);
    if (ctx.tabs) {
      for (const t of ctx.tabs.all()) {
        const wc = t.wc;
        if (!wc || wc.isDestroyed()) continue;
        if (ctx.ipc.isInternalUrl(wc.getURL())) targets.push(wc);
      }
    }
    for (const wc of targets) {
      try { if (!wc.isDestroyed()) wc.send(channel, payload); } catch (e) { ctx.log('broadcast', channel, e.message); }
    }
  };
}

// Модули для ui-preload от фич (например 'electron-chrome-extensions/preload'). Вызывать в init.
function makeUiPreload() {
  const modules = [];
  return {
    addModule(m) { if (m && !modules.includes(String(m))) modules.push(String(m)); },
    modules: () => modules.slice(),
  };
}

// Горячие клавиши и контекстные меню на всех webContents.
function wireInput(ctx) {
  const C = ctx.commands;
  const M = ctx.contextMenu;
  // dev: предупреждения и ошибки консоли интерфейса — в лог main (видно в /logs).
  const uiConsole = (wc, name) => {
    if (!ctx.flags.dev || !wc) return;
    wc.on('console-message', (e) => {
      if (e.level !== 'warning' && e.level !== 'error') return;
      const src = e.sourceId ? ` (${String(e.sourceId).replace(/^kosmo:\/\/ui\//, '')}:${e.lineNumber})` : '';
      ctx.log('ui:' + name, `${e.level}: ${e.message}${src}`);
    });
  };
  ctx.bus.once('windows:created', (win) => {
    C.attach(win.webContents, 'chrome');
    M.attach(win.webContents, 'ui');
    uiConsole(win.webContents, 'chrome');
  });
  ctx.tabs.on('view-created', (tab, wc) => {
    C.attach(wc, 'tab');
    M.attach(wc, 'tab');
    // Отдельное окно DevTools (если фича devtools не встроила их в панель).
    wc.on('devtools-opened', () => { const d = wc.devToolsWebContents; if (d) C.attach(d, 'devtools'); });
  });
  ctx.panel.on('view-created', (_v, wc) => { C.attach(wc, 'panel'); M.attach(wc, 'ui'); uiConsole(wc, 'panel'); });
  ctx.panel.on('devtools-view-created', (_v, wc) => C.attach(wc, 'devtools'));
  ctx.overlay.on('view-created', (_v, wc) => { C.attach(wc, 'overlay'); M.attach(wc, 'ui'); uiConsole(wc, 'overlay'); });
}

function registerAppIpc(ctx) {
  ctx.ipc.handle('kosmo:app.info', () => ({
    version: ctx.app.getVersion(),
    versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    dev: ctx.flags.dev,
    profile: ctx.flags.profile,
    userData: ctx.paths.userData,
    featureErrors: ctx.featureErrors.map((e) => ({ id: e.id, phase: e.phase, message: e.message })),
  }), { allow: ['ui', 'internal'] });
  ctx.ipc.handle('kosmo:app.quit', () => { ctx.app.quit(); return true; });
  ctx.ipc.handle('kosmo:containers.list', () => ctx.sessions.containers(), { allow: ['ui', 'internal'] });
}

module.exports = { parseFlags };
