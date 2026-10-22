'use strict';
// Фича «platform»: расширения Chrome (+ Chrome Web Store), блокировщик рекламы, контейнеры, разрешения сайтов,
// HTTP-авторизация, приватность. Тяжёлые библиотеки (расширения, движок блокировщика) грузятся после показа окна.
// API для соседей: ctx.adblock = {isEnabledFor(url), blockedCount(tabId), …}, ctx.extensions = {list(), …}.

const path = require('path');
const { createModal } = require('./platform/modal');
const { createAdblock } = require('./platform/adblock');
const { createExtensions } = require('./platform/extensions');
const { createPermissions } = require('./platform/permissions');
const { createAuth } = require('./platform/auth');
const { createContainers } = require('./platform/containers');
const { clampStr, errText } = require('./platform/util');

const DEFER_MS = 1200; // после загрузки первой вкладки (или запасной таймер от ready)

function init(ctx) {
  const modal = createModal(ctx);
  const adblock = createAdblock(ctx);
  const extensions = createExtensions(ctx, modal);
  const permissions = createPermissions(ctx);
  createAuth(ctx, modal);
  const containers = createContainers(ctx);

  // <browser-action-list> в chrome — модуль ui-preload (аргументы задаются при создании окна, поэтому в init).
  ctx.uiPreload.addModule(path.join(__dirname, 'platform', 'ui-preload-actions.js'));

  // ---------- API для соседей ----------
  ctx.adblock = {
    isEnabledFor: (url) => adblock.isEnabledFor(url),
    blockedCount: (tabId) => adblock.blockedCount(tabId),
    status: () => adblock.status(),
    update: () => adblock.update('вручную'),
  };
  ctx.extensions = {
    list: () => extensions.list(),
    install: (id, containerId) => extensions.installById(id, containerId),
    remove: (id) => extensions.remove(id),
    instance: (cid) => extensions.instance(cid),
  };
  ctx.platform = { modal, adblock, extensions, permissions, containers };

  // ---------- контекстное меню: пункты расширений (chrome.contextMenus) ----------
  ctx.contextMenu.addProvider((params, tab) => extensions.menuItems(params, tab));

  // ---------- IPC ----------
  const both = { allow: ['ui', 'internal'] };
  const H = (ch, fn, opts) => ctx.ipc.handle(ch, fn, opts || both);
  const tabFor = (p, meta) => {
    if (p && p.tabId != null) return ctx.tabs.get(Number(p.tabId));
    if (meta && meta.kind === 'internal' && meta.tab) return meta.tab;
    return ctx.tabs.active();
  };

  // модальные окна (overlay)
  H('kosmo:platform.modalRespond', (p = {}) => {
    const r = p.result && typeof p.result === 'object' ? p.result : null;
    const clean = r ? {
      allow: !!r.allow,
      username: typeof r.username === 'string' ? r.username.slice(0, 1024) : undefined,
      password: typeof r.password === 'string' ? r.password.slice(0, 4096) : undefined,
    } : null;
    return modal.respond(String(p.id || ''), clean);
  }, { allow: ['ui'] });

  // блокировщик
  H('kosmo:adblock.state', (p = {}, meta) => adblock.tabState(tabFor(p, meta), p.url ? clampStr(p.url) : ''));
  H('kosmo:adblock.counts', () => ({ changes: adblock.counts(), total: adblock.status().total }));
  H('kosmo:adblock.setSite', (p = {}, meta) => {
    const tab = tabFor(p, meta);
    adblock.setSite(clampStr(p.host, 300), !!p.block);
    if (p.reload !== false && tab) ctx.tabs.reload(tab.id);
    return adblock.tabState(tab);
  });
  H('kosmo:adblock.setEnabled', (p = {}) => { ctx.settings.set('privacy.adblock', !!p.value); return adblock.status(); });
  H('kosmo:adblock.update', async () => { await adblock.update('вручную'); return adblock.status(); });

  // расширения
  H('kosmo:ext.state', () => extensions.state());
  H('kosmo:ext.list', async () => {
    if (!extensions.started) extensions.start();
    await extensions.whenLoaded();
    return { items: extensions.list(), state: extensions.state(), path: extensions.extensionsPath };
  });
  H('kosmo:ext.remove', (p = {}) => extensions.remove(clampStr(p.id, 64)));
  H('kosmo:ext.reload', (p = {}) => extensions.reload(clampStr(p.id, 64)));
  H('kosmo:ext.options', (p = {}) => extensions.openOptions(clampStr(p.id, 64)));
  H('kosmo:ext.loadUnpacked', () => extensions.chooseUnpacked());
  H('kosmo:ext.openStore', () => extensions.openStore());
  H('kosmo:ext.openFolder', () => { ctx.electron.shell.openPath(extensions.extensionsPath).catch(() => {}); return true; });

  // контейнеры
  H('kosmo:containers.stats', () => containers.stats());
  H('kosmo:containers.clearData', (p = {}) => containers.clearData(clampStr(p.id, 40), { reload: p.reload !== false }));
  H('kosmo:containers.remove', (p = {}) => containers.remove(clampStr(p.id, 40)));
  H('kosmo:containers.chipMenu', (p = {}) => containers.chipMenu(p), { allow: ['ui'] });
  H('kosmo:containers.newTab', (p = {}) => {
    const id = clampStr(p.id, 40);
    if (!ctx.sessions.containers().some((c) => c.id === id)) throw new Error('нет такого контейнера');
    return ctx.tabs.create({ url: ctx.tabs.NEWTAB, containerId: id, active: true }).id;
  });

  // разрешения сайтов
  H('kosmo:perm.queue', () => ({ items: permissions.queue() }));
  H('kosmo:perm.respond', (p = {}) => permissions.respond(String(p.id || ''), !!p.allow, p.remember !== false, { sourceId: p.sourceId ? clampStr(p.sourceId, 200) : undefined }), { allow: ['ui'] });
  H('kosmo:perm.list', () => permissions.listSaved());
  H('kosmo:perm.revoke', (p = {}) => permissions.revoke(clampStr(p.origin, 500), p.key ? clampStr(p.key, 80) : null));

  // приватность
  H('kosmo:privacy.clearCache', () => containers.clearCache());
  H('kosmo:privacy.clearCookies', () => containers.clearCookies());
  H('kosmo:privacy.uaInfo', () => ({ chrome: ctx.sessions.chromeUserAgent(), current: ctx.sessions.userAgent() }));

  // ---------- User-Agent: ядро меняет его у сессий (новые вкладки), открытым вкладкам — здесь ----------
  ctx.settings.on('change', (p) => {
    if (!(p === 'privacy' || p.startsWith('privacy.userAgent') || p.startsWith('privacy.customUA'))) return;
    const ua = ctx.sessions.userAgent();
    for (const t of ctx.tabs.all()) {
      try { if (t.wc && !t.wc.isDestroyed() && t.wc.getUserAgent() !== ua) t.wc.setUserAgent(ua); } catch (_) { /* ignore */ }
    }
  });

  // ---------- команды ----------
  ctx.commands.register({
    id: 'adblock.toggleSite', title: 'Блокировщик: вкл/выкл на этом сайте', category: 'Приватность',
    run: () => {
      const t = ctx.tabs.active();
      if (!t) return;
      const s = adblock.tabState(t);
      if (!s.host) return;
      adblock.setSite(s.host, s.allowed);
      ctx.tabs.reload(t.id);
    },
  });
  ctx.commands.register({
    id: 'adblock.toggle', title: 'Блокировщик рекламы: вкл/выкл', category: 'Приватность',
    run: () => ctx.settings.set('privacy.adblock', ctx.settings.peek('privacy.adblock') === false),
  });
  ctx.commands.register({
    id: 'extensions.store', title: 'Открыть Chrome Web Store', category: 'Браузер',
    run: () => extensions.openStore(),
  });

  // ---------- отложенный старт: после показа окна ----------
  let deferred = false;
  const startDeferred = () => {
    if (deferred) return;
    deferred = true;
    setTimeout(() => {
      try { extensions.start(); } catch (e) { ctx.log('platform', 'расширения:', errText(e)); }
      try { adblock.start(); } catch (e) { ctx.log('platform', 'блокировщик:', errText(e)); }
    }, 0);
  };
  ctx.tabs.once('loaded', () => setTimeout(startDeferred, DEFER_MS));
  ctx.bus.once('ready', () => setTimeout(startDeferred, 3500));
}

module.exports = {
  id: 'platform',
  init,
  async start() { /* отложенный старт — по загрузке первой вкладки (init) */ },
};
