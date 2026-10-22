'use strict';
// Расширения Chrome.
//  - electron-chrome-extensions: chrome.tabs / action / contextMenus / windows… для каждой сессии-контейнера,
//    вкладки Космолёта регистрируются в нём (addTab / selectTab), попапы действий — его PopupView;
//  - electron-chrome-web-store: кнопка «Установить» на chromewebstore.google.com, установка/удаление/обновление;
//  - общая папка userData/extensions для всех контейнеров: установленное в одном контейнере подгружается в остальные.
// Всё это включается лениво — после показа окна (start), до этого ни одной библиотеки не грузим.

const fs = require('fs');
const path = require('path');
const { errText } = require('./util');

const WEBSTORE_URL = 'https://chromewebstore.google.com/';
const UPDATE_EVERY = 6 * 3600 * 1000;

function createExtensions(ctx, modal) {
  const { nativeImage } = ctx.electron;
  const extensionsPath = path.join(ctx.paths.userData, 'extensions');
  const unpackedStore = ctx.store('extensions-unpacked', { paths: [] });
  const log = (...a) => ctx.log('extensions', ...a);

  let ECE = null; // electron-chrome-extensions
  let CWS = null; // electron-chrome-web-store
  let started = false;
  let firstLoad = null; // Promise загрузки в основной контейнер
  const instances = new Map(); // containerId → ElectronChromeExtensions
  const loadedIn = new Map(); // containerId → Promise загрузки расширений в сессию
  const busy = new Set(); // id расширений, которые сейчас грузятся/удаляются вручную (без «распространения»)
  const readySessions = new Set(); // контейнеры, где первая загрузка из папки закончилась
  let guard = 0; // >0 — наши собственные addTab/selectTab (их эхо в impl.selectTab игнорируем)
  let changeTimer = null;

  // ---------- помощники ----------
  const sesOf = (cid) => ctx.sessions.get(cid);
  const sx = (ses) => ses.extensions || ses;
  const win = () => ctx.windows.main;

  function tabOfWc(wc) {
    try { return wc ? ctx.tabs.fromWebContents(wc) : null; } catch (_) { return null; }
  }

  function guarded(fn) {
    guard++;
    try { return fn(); } catch (e) { log(errText(e)); return undefined; } finally { guard--; }
  }

  function addTab(ext, wc) {
    const w = win();
    if (!w || w.isDestroyed() || !wc || wc.isDestroyed()) return;
    guarded(() => ext.addTab(wc, w));
  }

  function selectActive(cid) {
    const t = ctx.tabs.active();
    const ext = instances.get(cid);
    if (!ext || !t || !t.wc || t.wc.isDestroyed() || t.info.containerId !== cid) return;
    guarded(() => ext.selectTab(t.wc));
  }

  function scheduleChanged() {
    if (changeTimer) return;
    changeTimer = setTimeout(() => { changeTimer = null; ctx.broadcast('kosmo:ext.changed', state()); }, 120);
  }

  function isUnpackedPath(p) {
    const rel = path.relative(extensionsPath, p || '');
    return !p || rel.startsWith('..') || path.isAbsolute(rel);
  }

  // Иконка расширения → data URL (страница kosmo://extensions не может грузить chrome-extension://).
  function iconOf(ext, size = 48) {
    const m = ext.manifest || {};
    const icons = m.icons || (m.action && m.action.default_icon) || (m.browser_action && m.browser_action.default_icon) || null;
    let rel = null;
    if (typeof icons === 'string') rel = icons;
    else if (icons && typeof icons === 'object') {
      const sizes = Object.keys(icons).map(Number).filter((n) => n > 0).sort((a, b) => a - b);
      const pick = sizes.find((n) => n >= size) || sizes[sizes.length - 1];
      if (pick) rel = icons[String(pick)];
    }
    if (!rel) return '';
    try {
      const full = path.join(ext.path, String(rel).replace(/^\//, ''));
      if (path.relative(ext.path, full).startsWith('..')) return '';
      const img = nativeImage.createFromPath(full);
      if (img.isEmpty()) return '';
      return img.resize({ width: size, height: size, quality: 'best' }).toDataURL();
    } catch (_) { return ''; }
  }

  function localized(ext, s) {
    // __MSG_name__ — ext.name Electron уже локализует; для description берём как есть или пусто.
    if (typeof s !== 'string') return '';
    return /^__MSG_.+__$/.test(s) ? '' : s;
  }

  function describe(ext) {
    const m = ext.manifest || {};
    const action = m.action || m.browser_action || null;
    const opt = m.options_page || (m.options_ui && m.options_ui.page) || '';
    return {
      id: ext.id,
      name: ext.name || m.name || ext.id,
      version: ext.version || m.version || '',
      description: localized(ext, m.description).slice(0, 300),
      icon: iconOf(ext),
      unpacked: isUnpackedPath(ext.path),
      path: ext.path,
      mv: m.manifest_version || 0,
      hasAction: !!action,
      options: !!opt,
      homepage: m.homepage_url || '',
    };
  }

  // ---------- сессии ----------
  function setupSession(ses, cid) {
    if (instances.has(cid)) return instances.get(cid);
    let ext;
    try {
      ext = new ECE.ElectronChromeExtensions({
        license: 'GPL-3.0',
        session: ses,
        async createTab(details) {
          const url = details && typeof details.url === 'string' && details.url ? details.url : ctx.tabs.NEWTAB;
          const tab = ctx.tabs.create({ url, containerId: cid, active: !details || details.active !== false });
          const wc = tab.ensureView() && tab.wc;
          return [wc, win()];
        },
        selectTab(wc) {
          if (guard) return; // эхо наших же addTab/selectTab
          const t = tabOfWc(wc);
          if (t && ctx.tabs.activeId !== t.id) ctx.tabs.activate(t.id);
        },
        removeTab(wc) {
          const t = tabOfWc(wc); // для закрытой/выгруженной вкладки — null: это не просьба расширения
          if (t) ctx.tabs.close(t.id);
        },
        async createWindow(details) {
          const urls = [].concat((details && details.url) || []).filter((u) => typeof u === 'string' && u);
          if (!urls.length) urls.push(ctx.tabs.NEWTAB);
          urls.forEach((u, i) => ctx.tabs.create({ url: u, containerId: cid, active: i === urls.length - 1 && (!details || details.focused !== false) }));
          return win();
        },
        removeWindow() { /* окно одно — расширение его не закрывает */ },
        assignTabDetails(details, wc) {
          const t = tabOfWc(wc);
          if (!t) return;
          details.pinned = !!t.info.pinned;
          details.index = t.index;
          details.discarded = !!t.info.discarded;
          details.mutedInfo = { muted: !!t.info.muted };
        },
      });
    } catch (e) {
      log(`контейнер ${cid}: не удалось включить расширения:`, errText(e));
      return null;
    }
    instances.set(cid, ext);

    ext.on('browser-action-popup-created', (popup) => {
      // Попап — отдельное окно без рамки: тёмная подложка до загрузки, горячие клавиши ядра.
      try {
        const bw = popup.browserWindow;
        if (bw && !bw.isDestroyed()) ctx.commands.attach(bw.webContents, 'devtools');
      } catch (_) { /* ignore */ }
    });

    try {
      CWS.installChromeWebStore({
        session: ses,
        extensionsPath,
        loadExtensions: false, // грузим сами (общая папка + распакованные), см. loadInto
        autoUpdate: false,     // обновления — один раз на все контейнеры (ниже)
        allowUnpackedExtensions: false,
        beforeInstall: (details) => confirmInstall(details),
      }).catch((e) => log(`веб-магазин в контейнере ${cid}:`, errText(e)));
    } catch (e) { log('installChromeWebStore:', errText(e)); }

    const exts = sx(ses);
    exts.on('extension-loaded', (_e, extension) => { propagate(cid, extension); scheduleChanged(); });
    exts.on('extension-unloaded', () => scheduleChanged());

    for (const t of ctx.tabs.all()) {
      if (t.wc && !t.wc.isDestroyed() && t.info.containerId === cid) addTab(ext, t.wc);
    }
    selectActive(cid);
    loadedIn.set(cid, loadInto(ses, cid));
    return ext;
  }

  async function startWorker(ses, extension) {
    try {
      const m = extension.manifest || {};
      if (m.manifest_version === 3 && m.background && m.background.service_worker) {
        await ses.serviceWorkers.startWorkerForScope(`chrome-extension://${extension.id}`);
      }
    } catch (_) { /* воркер поднимется сам при первом событии */ }
  }

  let purged = null;
  function purgeRemoved() {
    if (purged) return purged;
    purged = (async () => {
      const s = unpackedStore.get();
      const ids = Array.isArray(s.removed) ? s.removed.filter((x) => /^[a-p]{32}$/.test(String(x))) : [];
      if (!ids.length) return;
      const left = [];
      for (const id of ids) {
        try { await fs.promises.rm(path.join(extensionsPath, id), { recursive: true, force: true }); } catch (_) { left.push(id); }
      }
      unpackedStore.patch({ removed: left });
    })();
    return purged;
  }

  async function loadInto(ses, cid) {
    const t0 = Date.now();
    try { await fs.promises.mkdir(extensionsPath, { recursive: true }); } catch (_) {}
    await purgeRemoved();
    try {
      await CWS.loadAllExtensions(ses, extensionsPath, { allowUnpacked: false });
    } catch (e) { log(`загрузка расширений (${cid}):`, errText(e)); }
    for (const p of unpackedPaths()) {
      try {
        const e = await sx(ses).loadExtension(p, { allowFileAccess: true });
        await startWorker(ses, e);
      } catch (e) { log(`распакованное ${p}:`, errText(e)); }
    }
    const n = sx(ses).getAllExtensions().length;
    if (n) log(`контейнер ${cid}: расширений ${n}, ${Date.now() - t0} мс`);
    readySessions.add(cid);
    // что успели поставить сюда, пока шла загрузка (магазин в только что открытом контейнере), — остальным
    for (const e of sx(ses).getAllExtensions()) propagate(cid, e);
    // вкладки со страницами расширений, восстановленные до загрузки (ERR_BLOCKED_BY_CLIENT), — повторить
    for (const t of ctx.tabs.all()) {
      if (t.info.containerId === cid && t.info.error && /^chrome-extension:\/\//i.test(t.info.url || '') && t.wc) ctx.tabs.reload(t.id);
    }
    scheduleChanged();
  }

  // Расширение появилось в одном контейнере (установка из магазина, обновление) — подгрузить в остальные.
  // Пока контейнер грузит папку сам, его не трогаем (иначе гонка двух loadExtension одного расширения).
  function propagate(fromCid, extension) {
    if (busy.has(extension.id) || !readySessions.has(fromCid)) return;
    for (const [cid] of instances) {
      if (cid === fromCid || !readySessions.has(cid)) continue;
      const ses = sesOf(cid);
      const exts = sx(ses);
      const cur = exts.getExtension(extension.id);
      if (cur && (cur.path === extension.path || cmpVersion(cur.version, extension.version) >= 0)) continue; // не откатываем
      (async () => {
        try {
          if (cur) exts.removeExtension(extension.id);
          const opts = isUnpackedPath(extension.path) ? { allowFileAccess: true } : undefined;
          const e = await exts.loadExtension(extension.path, opts);
          await startWorker(ses, e);
        } catch (e) { log(`не подгрузилось в контейнер ${cid}:`, errText(e)); }
      })();
    }
  }

  function cmpVersion(a, b) {
    const pa = String(a || '').split('.').map((x) => parseInt(x, 10) || 0);
    const pb = String(b || '').split('.').map((x) => parseInt(x, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d > 0 ? 1 : -1;
    }
    return 0;
  }

  function unpackedPaths() {
    const s = unpackedStore.get();
    return Array.isArray(s.paths) ? s.paths.filter((p) => typeof p === 'string' && p) : [];
  }

  // ---------- подтверждение установки из магазина ----------
  const asking = new Map(); // id → Promise ответа (магазин может спросить дважды подряд)
  function confirmInstall(details) {
    const id = String(details.id || '');
    // уже установлено (повторный клик в магазине) — без второго вопроса, библиотека вернёт загруженное
    if (Array.from(instances.keys()).some((cid) => sx(sesOf(cid)).getExtension(id))) return Promise.resolve({ action: 'allow' });
    if (asking.has(id)) return asking.get(id);
    const p = askInstall(details).finally(() => asking.delete(id));
    asking.set(id, p);
    return p;
  }
  function askInstall(details) {
    const m = details.manifest || {};
    let icon = '';
    try { if (details.icon && !details.icon.isEmpty()) icon = details.icon.resize({ width: 48, height: 48, quality: 'best' }).toDataURL(); } catch (_) {}
    const perms = [].concat(m.permissions || []).filter((p) => typeof p === 'string');
    const hosts = [].concat(m.host_permissions || [], (m.content_scripts || []).flatMap((c) => c.matches || [])).filter((p) => typeof p === 'string');
    return modal.ask('platform-install', {
      id: details.id,
      name: String(details.localizedName || m.name || details.id).slice(0, 120),
      version: String(m.version || ''),
      icon,
      permissions: perms.slice(0, 40),
      allSites: hosts.some((h) => h === '<all_urls>' || /^\*:\/\/\*\//.test(h) || /^https?:\/\/\*\//.test(h)),
      hosts: Array.from(new Set(hosts)).slice(0, 12),
    }).then((r) => ({ action: r && r.allow ? 'allow' : 'deny' }), () => ({ action: 'deny' }));
  }

  // ---------- операции ----------
  function mainExts() { return sx(sesOf('main')); }

  function list() {
    if (!started) return [];
    return mainExts().getAllExtensions().map(describe).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }

  // Короткое состояние для кнопок в chrome (без иконок — их чтение с диска здесь не нужно).
  function state() {
    const all = started ? mainExts().getAllExtensions() : [];
    const actions = all.filter((e) => { const m = e.manifest || {}; return !!(m.action || m.browser_action); }).length;
    return { started, ready: started && !!instances.get('main'), loading: !!(started && firstLoad && !firstLoad.done), count: all.length, actions };
  }

  async function ensureStarted() {
    if (!started) start();
    if (firstLoad) await firstLoad;
  }

  async function installById(id, cid = 'main') {
    await ensureStarted();
    if (!/^[a-p]{32}$/.test(String(id))) throw new Error('неверный id расширения');
    const ses = sesOf(cid);
    if (!instances.has(cid)) setupSession(ses, cid);
    const e = await CWS.installExtension(id, { session: ses, extensionsPath });
    await startWorker(ses, e);
    return describe(e);
  }

  async function remove(id) {
    await ensureStarted();
    const ext = mainExts().getExtension(id) || Array.from(instances.keys()).map((c) => sx(sesOf(c)).getExtension(id)).find(Boolean);
    if (!ext) throw new Error('расширение не найдено');
    busy.add(id);
    try {
      const unpacked = isUnpackedPath(ext.path);
      for (const [cid] of instances) {
        const exts = sx(sesOf(cid));
        if (exts.getExtension(id)) { try { exts.removeExtension(id); } catch (e) { log(errText(e)); } }
      }
      if (unpacked) {
        const paths = unpackedPaths().filter((p) => path.resolve(p) !== path.resolve(ext.path));
        unpackedStore.patch({ paths });
      } else {
        // удалить файлы из общей папки (как uninstallExtension, но без привязки к одной сессии)
        const dir = path.join(extensionsPath, id);
        if (!path.relative(extensionsPath, dir).startsWith('..')) {
          try { await fs.promises.rm(dir, { recursive: true, force: true }); } catch (e) {
            // файлы ещё заняты (Windows) — удалим при следующем запуске, до загрузки
            log('папка расширения занята, удалю при следующем запуске:', errText(e));
            const s = unpackedStore.get();
            unpackedStore.patch({ removed: Array.from(new Set([].concat(s.removed || [], id))) });
          }
        }
      }
    } finally {
      busy.delete(id);
      scheduleChanged();
    }
    return true;
  }

  async function reload(id) {
    await ensureStarted();
    const ext = mainExts().getExtension(id);
    if (!ext) throw new Error('расширение не найдено');
    const p = ext.path;
    const opts = isUnpackedPath(p) ? { allowFileAccess: true } : undefined;
    busy.add(id);
    try {
      for (const [cid] of instances) {
        const ses = sesOf(cid);
        const exts = sx(ses);
        try {
          if (exts.getExtension(id)) exts.removeExtension(id);
          const e = await exts.loadExtension(p, opts);
          await startWorker(ses, e);
        } catch (e) { log(`перезагрузка в ${cid}:`, errText(e)); if (cid === 'main') throw e; }
      }
    } finally {
      busy.delete(id);
      scheduleChanged();
    }
    return describe(mainExts().getExtension(id) || ext);
  }

  async function loadUnpacked(dir) {
    await ensureStarted();
    const p = path.resolve(String(dir || ''));
    let manifest;
    try { manifest = JSON.parse(await fs.promises.readFile(path.join(p, 'manifest.json'), 'utf8')); } catch (e) {
      throw new Error('в папке нет manifest.json');
    }
    if (!manifest || !manifest.name || !manifest.version) throw new Error('manifest.json без name или version');
    // В основной контейнер; остальные подхватят сами (propagate по extension-loaded).
    const ses = sesOf('main');
    if (!instances.has('main')) setupSession(ses, 'main');
    await loadedIn.get('main');
    const existing = sx(ses).getAllExtensions().find((e) => path.resolve(e.path) === p);
    if (existing) throw new Error('это расширение уже загружено');
    const first = await sx(ses).loadExtension(p, { allowFileAccess: true });
    await startWorker(ses, first);
    const paths = unpackedPaths().filter((x) => path.resolve(x) !== p);
    paths.push(p);
    unpackedStore.patch({ paths });
    scheduleChanged();
    return first ? describe(first) : null;
  }

  async function chooseUnpacked() {
    const { dialog } = ctx.electron;
    const r = await dialog.showOpenDialog(win(), { title: 'Папка распакованного расширения', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return null;
    return loadUnpacked(r.filePaths[0]);
  }

  function openOptions(id) {
    const ext = mainExts().getExtension(id);
    if (!ext) throw new Error('расширение не найдено');
    const m = ext.manifest || {};
    const page = m.options_page || (m.options_ui && m.options_ui.page);
    if (!page) throw new Error('у расширения нет настроек');
    const active = ctx.tabs.active();
    return ctx.tabs.create({ url: `chrome-extension://${id}/${String(page).replace(/^\//, '')}`, containerId: active ? active.info.containerId : 'main', active: true }).id;
  }

  function openStore() {
    const active = ctx.tabs.active();
    const cid = active ? active.info.containerId : 'main';
    return ctx.tabs.create({ url: WEBSTORE_URL, containerId: cid, active: true }).id;
  }

  async function updateAll() {
    try {
      if (!mainExts().getAllExtensions().some((e) => !isUnpackedPath(e.path))) return;
      await CWS.updateExtensions(sesOf('main'));
    } catch (e) { log('проверка обновлений:', errText(e)); }
  }

  // Пункты контекстного меню от расширений (chrome.contextMenus).
  function menuItems(params, tab) {
    if (!started || !tab || !tab.wc || tab.wc.isDestroyed()) return [];
    const ext = instances.get(tab.info.containerId);
    if (!ext) return [];
    let items = [];
    try { items = ext.getContextMenuItems(tab.wc, params) || []; } catch (e) { log(errText(e)); return []; }
    const conv = (mi) => {
      const o = { label: mi.label || '', enabled: mi.enabled !== false, visible: mi.visible !== false };
      if (mi.icon) o.icon = mi.icon;
      if (mi.type === 'separator') return { type: 'separator' };
      const sub = mi.submenu && Array.isArray(mi.submenu.items) ? mi.submenu.items : null;
      if (sub && sub.length) o.submenu = sub.map(conv);
      else {
        if (mi.type === 'checkbox' || mi.type === 'radio') { o.type = mi.type; o.checked = !!mi.checked; }
        o.click = () => { try { mi.click(); } catch (e) { log(errText(e)); } };
      }
      return o;
    };
    return items.map((mi) => Object.assign(conv(mi), { section: 'tools' }));
  }

  // ---------- запуск ----------
  function start() {
    if (started) return;
    const t0 = Date.now();
    try {
      ECE = require('electron-chrome-extensions');
      CWS = require('electron-chrome-web-store');
    } catch (e) {
      log('библиотеки расширений не загрузились:', errText(e));
      return;
    }
    started = true;
    const tReq = Date.now() - t0;
    for (const { id, session } of ctx.sessions.all()) setupSession(session, id);
    if (!instances.has('main')) setupSession(sesOf('main'), 'main');
    log(`включены за ${Date.now() - t0} мс (библиотеки ${tReq} мс)`);
    firstLoad = (loadedIn.get('main') || Promise.resolve()).then(() => { firstLoad.done = true; scheduleChanged(); });
    firstLoad.done = false;
    const t = setTimeout(() => {
      updateAll();
      const i = setInterval(updateAll, UPDATE_EVERY);
      if (i.unref) i.unref();
    }, 90000);
    if (t.unref) t.unref();
    scheduleChanged();
  }

  // Иконки действий в <browser-action-list>: crx://extension-icon/<id>/<size>/<resize>?partition=persist:c-<контейнер>.
  // Обработчик ставится в UI-сессию сразу (в init): протокол, подключённый после загрузки chrome, странице не виден.
  // Сам ответ — из библиотеки (handleCRXRequest), как в ElectronChromeExtensions.handleCRXProtocol.
  function handleCrx(request) {
    let url;
    try { url = new URL(request.url); } catch (_) { return new Response('Неверный адрес', { status: 400 }); }
    const m = /^persist:c-([a-z0-9_-]{1,40})$/i.exec(url.searchParams.get('partition') || '');
    const ext = m ? instances.get(m[1]) : null;
    if (!ext || !ext.api || !ext.api.browserAction) return new Response(null, { status: 404 });
    return ext.api.browserAction.handleCRXRequest(request);
  }
  try {
    const ui = ctx.sessions.ui();
    if (!ui.protocol.isProtocolHandled('crx')) ui.protocol.handle('crx', handleCrx);
  } catch (e) { log('crx://', errText(e)); }

  // Новые контейнеры после старта — сразу с расширениями.
  ctx.sessions.onSession((ses, cid) => { if (started) setupSession(ses, cid); });

  ctx.tabs.on('view-created', (tab, wc) => {
    if (!started) return;
    const ext = instances.get(tab.info.containerId);
    if (!ext) return;
    addTab(ext, wc);
    selectActive(tab.info.containerId);
  });
  // Попап действия привязан к месту кнопки в окне: смена вкладки, сдвиг или ресайз окна — закрыть.
  function closePopups() {
    for (const ext of instances.values()) {
      const p = ext.api && ext.api.browserAction && ext.api.browserAction.popup;
      if (p && !p.isDestroyed()) { try { p.destroy(); } catch (_) { /* ignore */ } }
    }
  }
  ctx.tabs.on('activated', (tab) => { if (!started) return; closePopups(); selectActive(tab.info.containerId); });
  ctx.bus.once('windows:created', (w) => { for (const ev of ['move', 'resize', 'minimize', 'enter-full-screen']) w.on(ev, closePopups); });

  return {
    start, state, list, installById, remove, reload, loadUnpacked, chooseUnpacked, openOptions, openStore, updateAll, menuItems,
    instance: (cid) => instances.get(cid || 'main') || null,
    closePopups,
    get started() { return started; },
    whenLoaded: () => firstLoad || Promise.resolve(),
    extensionsPath,
    WEBSTORE_URL,
  };
}

module.exports = { createExtensions };
