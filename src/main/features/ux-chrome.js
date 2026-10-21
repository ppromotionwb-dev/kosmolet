'use strict';
// Фича «ux-chrome»: история, закладки, подсказки адресной строки, командная палитра, загрузки, новая вкладка.
// API для соседей: ctx.history, ctx.bookmarks, ctx.downloads (см. отчёт фичи).

const { createHistory } = require('./ux/history');
const { createBookmarks } = require('./ux/bookmarks');
const { createDownloads } = require('./ux/downloads');
const { createOmni } = require('./ux/suggest');
const { stripHash } = require('./ux/util');

function init(ctx) {
  const history = createHistory(ctx);
  const bookmarks = createBookmarks(ctx, history);
  const downloads = createDownloads(ctx);
  const omni = createOmni(ctx, history, bookmarks);

  // ---------- API в ctx ----------
  ctx.history = {
    search: (q, limit) => history.search(q, limit).map(({ url, title, visitCount, lastVisit, favicon }) => ({ url, title, visitCount, lastVisit, favicon })),
    add: (entry) => history.add(entry),
    remove: (url) => history.remove(url),
    clear: (opts) => history.clear(opts),
    recent: (limit) => history.recent(limit),
    top: (limit) => history.top(limit),
    get: (url) => history.get(url),
    count: () => history.count(),
    onChange: (cb) => history.onChange(cb),
  };
  ctx.bookmarks = {
    list: (folder) => bookmarks.list(folder),
    add: (o) => bookmarks.add(o),
    remove: (idOrUrl) => bookmarks.remove(idOrUrl),
    update: (id, patch) => bookmarks.update(id, patch),
    move: (id, index, folder) => bookmarks.move(id, index, folder),
    has: (url) => bookmarks.has(url),
    find: (url) => bookmarks.find(url),
  };
  ctx.downloads = {
    list: () => downloads.list().items,
    dir: () => downloads.dir(),
    summary: () => downloads.summary(),
  };

  // ---------- запись посещений ----------
  ctx.tabs.on('view-created', (tab, wc) => {
    // view создан для восстановления истории вкладки (сессия, выгрузка, «открыть заново») — первая загрузка не посещение
    let skip = !!(tab.history && Array.isArray(tab.history.entries) && tab.history.entries.length);
    let last = null;
    wc.on('did-navigate', (_e, url) => {
      const reload = url === last;
      last = url;
      if (skip) { skip = false; return; }
      history.visit(url, { reload });
    });
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return;
      const prev = last;
      last = url;
      if (prev && stripHash(prev) === stripHash(url)) return; // только якорь
      history.visit(url, { title: wc.isDestroyed() ? '' : wc.getTitle() });
    });
    wc.on('page-title-updated', (_e, title) => { if (!wc.isDestroyed()) history.setTitle(wc.getURL(), title); });
    wc.on('page-favicon-updated', (_e, favs) => {
      if (wc.isDestroyed() || !Array.isArray(favs) || !favs.length) return;
      const url = wc.getURL();
      history.setFavicon(url, favs[0]);
      bookmarks.setFavicon(url, favs[0]);
    });
  });

  // ---------- IPC ----------
  const both = { allow: ['ui', 'internal'] };
  const H = (ch, fn, opts) => ctx.ipc.handle(ch, fn, opts || both);
  const str = (v, n = 4096) => String(v == null ? '' : v).slice(0, n);

  H('kosmo:ux.suggest', (p = {}) => omni.omni(typeof p === 'string' ? p : p.input, { inline: !!p.inline }), { allow: ['ui'] });
  H('kosmo:ux.newtab', () => omni.newtabData());
  H('kosmo:ux.newtabHide', (p = {}) => history.hide(str(p.url)));
  H('kosmo:ux.focusOmnibox', (p = {}) => focusOmnibox(typeof p.text === 'string' ? str(p.text, 500) : undefined));
  H('kosmo:ux.palette', () => omni.paletteData(), { allow: ['ui'] });
  H('kosmo:ux.paletteRun', (p = {}) => paletteRun(p), { allow: ['ui'] });
  H('kosmo:ux.defaultBangs', () => require('../settings').DEFAULT_BANGS);

  H('kosmo:history.search', (p = {}) => history.search(str(p.q, 500), p.limit));
  H('kosmo:history.page', (p = {}) => history.page({ q: str(p.q, 500), offset: p.offset, limit: p.limit }));
  H('kosmo:history.recent', (p = {}) => history.recent(p.limit));
  H('kosmo:history.remove', (p = {}) => (Array.isArray(p.urls) ? history.removeMany(p.urls.map((u) => str(u))) : history.remove(str(p.url))));
  H('kosmo:history.clear', (p = {}) => history.clear({ since: Number(p.since) || 0 }));

  H('kosmo:bookmarks.list', (p = {}) => bookmarks.list(p && p.folder));
  H('kosmo:bookmarks.find', (p = {}) => bookmarks.find(str(p.url)));
  H('kosmo:bookmarks.add', (p = {}) => bookmarks.add({ url: str(p.url), title: str(p.title, 300), folder: p.folder, index: p.index, favicon: p.favicon }));
  H('kosmo:bookmarks.update', (p = {}) => bookmarks.update(str(p.id, 64), { title: p.title !== undefined ? str(p.title, 300) : undefined, url: p.url !== undefined ? str(p.url) : undefined, folder: p.folder }));
  H('kosmo:bookmarks.remove', (p = {}) => bookmarks.remove(str(p.id || p.url)));
  H('kosmo:bookmarks.move', (p = {}) => bookmarks.move(str(p.id, 64), Number(p.index), p.folder));

  H('kosmo:downloads.list', (p = {}) => downloads.list({ checkFiles: !!(p && p.checkFiles) }));
  H('kosmo:downloads.open', (p = {}) => downloads.open(str(p.id, 64)));
  H('kosmo:downloads.show', (p = {}) => downloads.show(str(p.id, 64)));
  H('kosmo:downloads.cancel', (p = {}) => downloads.cancel(str(p.id, 64)));
  H('kosmo:downloads.pause', (p = {}) => downloads.pause(str(p.id, 64)));
  H('kosmo:downloads.resume', (p = {}) => downloads.resume(str(p.id, 64)));
  H('kosmo:downloads.remove', (p = {}) => downloads.remove(str(p.id, 64)));
  H('kosmo:downloads.retry', (p = {}) => downloads.retry(str(p.id, 64)));
  H('kosmo:downloads.clear', () => downloads.clear());
  H('kosmo:downloads.markSeen', () => downloads.markSeen());
  H('kosmo:downloads.openDir', () => downloads.openDir());
  H('kosmo:downloads.chooseDir', () => downloads.chooseDir());

  // ---------- команды ----------
  ctx.commands.register({
    id: 'palette.open', title: 'Командная палитра', category: 'Браузер', keys: ['Ctrl+K', 'Ctrl+Shift+P'], repeat: false,
    // не в DevTools: там Ctrl+Shift+P — своё меню команд
    scopes: ['chrome', 'tab', 'panel', 'overlay'],
    appMenu: { section: 'tools', order: 5 },
    run: () => {
      const cur = ctx.overlay.current();
      if (cur && cur.type === 'palette') { ctx.overlay.close('toggle'); return; }
      ctx.overlay.open({ type: 'palette', modal: true, data: omni.paletteData() });
    },
  });
  ctx.commands.register({
    id: 'bookmarks.star', title: 'Добавить страницу в закладки', category: 'Закладки', keys: ['Ctrl+D'], repeat: false,
    scopes: ['chrome', 'tab', 'overlay'],
    run: () => chromeCommand('ux.star'),
  });
  ctx.commands.register({
    id: 'bookmarks.toggleBar', title: 'Показать или скрыть полосу закладок', category: 'Закладки', keys: ['Ctrl+Shift+B'], repeat: false,
    run: () => ctx.settings.set('ui.showBookmarksBar', !ctx.settings.peek('ui.showBookmarksBar')),
  });
  ctx.commands.register({
    id: 'downloads.popover', title: 'Последние загрузки', category: 'Браузер', repeat: false,
    run: () => chromeCommand('ux.downloads'),
  });

  // ---------- контекстное меню: ссылка в закладки ----------
  if (ctx.contextMenu && ctx.contextMenu.addProvider) {
    ctx.contextMenu.addProvider((params) => {
      const link = params && params.linkURL;
      if (!link || !/^https?:/i.test(link)) return [];
      return [{
        section: 'link',
        label: bookmarks.has(link) ? 'Ссылка уже в закладках' : 'Добавить ссылку в закладки',
        enabled: !bookmarks.has(link),
        click: () => { try { bookmarks.add({ url: link, title: String(params.linkText || '').trim(), folder: 'other' }); } catch (_) { /* неверный адрес */ } },
      }];
    });
  }

  // ---------- помощники ----------
  function chromeCommand(name, extra) {
    const win = ctx.windows.main;
    if (!win || win.isDestroyed()) return false;
    win.webContents.send('kosmo:chrome.command', Object.assign({ name }, extra || {}));
    return true;
  }

  function focusOmnibox(text) {
    const win = ctx.windows.main;
    if (!win || win.isDestroyed()) return false;
    win.webContents.focus();
    // как chromeCmd в core: сначала состояние вкладок, потом команда
    ctx.tabs.broadcastState(true);
    win.webContents.send('kosmo:chrome.command', Object.assign({ name: 'focusOmnibox' }, typeof text === 'string' ? { text } : {}));
    return true;
  }

  function openUrl(url, newTab) {
    const t = ctx.tabs.active();
    if (newTab || !t) return ctx.tabs.create({ url, active: true });
    return ctx.tabs.navigate(t.id, url);
  }

  function paletteRun(p) {
    const kind = String(p.kind || '');
    ctx.overlay.close('palette-run');
    setImmediate(() => {
      try {
        if (kind === 'command') ctx.commands.run(String(p.id), { source: 'palette' });
        else if (kind === 'tab') ctx.tabs.activate(Number(p.id));
        else if (kind === 'bookmark' || kind === 'history' || kind === 'url') openUrl(str(p.url), !!p.newTab);
        else if (kind === 'bang') focusOmnibox(str(p.key, 40) + ' ');
        else if (kind === 'search') {
          const t = ctx.tabs.active();
          if (p.newTab || !t) { const nt = ctx.tabs.create({ active: true }); ctx.tabs.navigate(nt.id, str(p.text, 2000)); } else ctx.tabs.navigate(t.id, str(p.text, 2000));
        }
      } catch (e) { ctx.log('ux-chrome', 'палитра:', e.message); }
    });
    return true;
  }

  ctx.uxChrome = { history, bookmarks, downloads, omni, focusOmnibox };
}

module.exports = {
  id: 'ux-chrome',
  init,
  async start(ctx) {
    // история (до 10 000 записей) — в простое после старта, чтобы первая подсказка не ждала
    // после загрузки истории у закладок могут появиться значки сайтов
    const u = ctx.uxChrome;
    if (u) u.history.warm(2500, () => ctx.broadcast('kosmo:bookmarks.changed', { items: u.bookmarks.list() }));
  },
};
