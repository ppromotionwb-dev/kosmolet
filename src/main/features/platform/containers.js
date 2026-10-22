'use strict';
// Контейнеры: очистка и удаление данных сессии, «Открыть в контейнере ▸» в меню вкладки, меню чипа контейнера,
// а также общие операции приватности (кэш, cookies всех контейнеров).
// Список контейнеров живёт в settings.containers (схема и проверка — ядро).

const fs = require('fs');
const path = require('path');
const { errText } = require('./util');

const STORAGES_ALL = ['cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache', 'websql', 'serviceworkers', 'cachestorage'];

function createContainers(ctx) {
  const log = (...a) => ctx.log('containers', ...a);
  const purgeStore = ctx.store('containers-purge', { ids: [] });

  // Папки удалённых контейнеров стираются при следующем запуске, до создания их сессий.
  (function purge() {
    const s = purgeStore.get();
    const ids = Array.isArray(s.ids) ? s.ids : [];
    if (!ids.length) return;
    const live = new Set(ctx.sessions.containers().map((c) => c.id));
    const left = [];
    for (const id of ids) {
      if (!/^[a-z0-9_-]{1,40}$/i.test(id) || id === 'main' || live.has(id)) continue;
      const dir = path.join(ctx.paths.userData, 'Partitions', 'c-' + id.toLowerCase());
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { left.push(id); log('папка контейнера занята:', id, errText(e)); }
    }
    purgeStore.set({ ids: left });
  })();

  function list() { return ctx.sessions.containers(); }
  function exists(id) { return list().some((c) => c.id === id); }

  function tabsOf(id) { return ctx.tabs.all().filter((t) => t.info.containerId === id); }

  function stats() {
    const out = {};
    for (const c of list()) out[c.id] = 0;
    for (const t of ctx.tabs.all()) out[t.info.containerId] = (out[t.info.containerId] || 0) + 1;
    return out;
  }

  async function clearSession(ses) {
    await ses.clearStorageData({ storages: STORAGES_ALL });
    await ses.clearCache();
    try { ses.clearAuthCache(); } catch (_) { /* ignore */ }
    try { await ses.clearHostResolverCache(); } catch (_) { /* ignore */ }
    try { await ses.clearCodeCaches({}); } catch (_) { /* ignore */ }
  }

  async function clearData(id, opts = {}) {
    if (!exists(id)) throw new Error('нет такого контейнера');
    const ses = ctx.sessions.get(id);
    await clearSession(ses);
    log(`данные контейнера ${id} очищены`);
    if (opts.reload !== false) for (const t of tabsOf(id)) if (t.wc && !t.wc.isDestroyed()) ctx.tabs.reload(t.id);
    return true;
  }

  async function remove(id) {
    if (id === 'main') throw new Error('основной контейнер удалить нельзя');
    if (!exists(id)) throw new Error('нет такого контейнера');
    const ids = tabsOf(id).map((t) => t.id);
    if (ids.length) ctx.tabs.closeMany(ids);
    try { await clearSession(ctx.sessions.get(id)); } catch (e) { log('очистка при удалении:', errText(e)); }
    ctx.settings.set('containers', list().filter((c) => c.id !== id));
    const s = purgeStore.get();
    purgeStore.set({ ids: Array.from(new Set([].concat(s.ids || [], id))) });
    log(`контейнер ${id} удалён (${ids.length} вкладок закрыто)`);
    return { closed: ids.length };
  }

  // Открыть копию вкладки в другом контейнере (оригинал остаётся — например, второй кабинет рядом).
  function reopenIn(tabId, cid) {
    const t = ctx.tabs.get(tabId);
    if (!t || !exists(cid)) return null;
    const url = t.info.url && !/^kosmo:\/\/error/i.test(t.info.url) ? t.info.url : ctx.tabs.NEWTAB;
    return ctx.tabs.create({ url, containerId: cid, index: t.index + 1, active: true });
  }

  function containerSubmenu(tab) {
    return list().map((c) => ({
      label: c.name + (c.id === tab.info.containerId ? ' (текущий)' : ''),
      enabled: c.id !== tab.info.containerId,
      click: () => reopenIn(tab.id, c.id),
    })).concat([{ type: 'separator' }, { label: 'Настроить контейнеры…', click: () => ctx.tabs.openOrActivate('kosmo://settings/#containers') }]);
  }

  // Меню вкладки (ядро: commands.addTabMenuProvider, если есть).
  if (ctx.commands && typeof ctx.commands.addTabMenuProvider === 'function') {
    ctx.commands.addTabMenuProvider((tab) => [{ label: 'Открыть в контейнере', submenu: containerSubmenu(tab) }]);
  }

  // Меню чипа контейнера в адресной строке.
  function chipMenu(p = {}) {
    const tab = ctx.tabs.active();
    if (!tab) return false;
    const c = ctx.sessions.container(tab.info.containerId);
    const tpl = [
      { label: `Контейнер «${c.name}»`, enabled: false },
      { type: 'separator' },
      { label: 'Новая вкладка в этом контейнере', click: () => ctx.tabs.create({ url: ctx.tabs.NEWTAB, containerId: c.id, active: true }) },
      { label: 'Открыть страницу в контейнере', submenu: containerSubmenu(tab) },
    ];
    return ctx.commands.popup(tpl, p);
  }

  // ---------- приватность ----------
  function allSessions() {
    return list().map((c) => ({ id: c.id, session: ctx.sessions.get(c.id) }));
  }

  async function clearCache() {
    let n = 0;
    for (const { session } of allSessions()) {
      try { await session.clearCache(); await session.clearCodeCaches({}).catch(() => {}); n++; } catch (e) { log('кэш:', errText(e)); }
    }
    return { containers: n };
  }

  async function clearCookies() {
    let n = 0;
    for (const { session } of allSessions()) {
      try { await session.clearStorageData({ storages: ['cookies'] }); n++; } catch (e) { log('cookies:', errText(e)); }
    }
    return { containers: n };
  }

  // Проверка изоляции (для отладки): cookies сайта в каждом контейнере.
  async function cookiesFor(url) {
    const out = {};
    for (const { id, session } of allSessions()) {
      try { out[id] = (await session.cookies.get({ url })).map((c) => c.name + '=' + c.value); } catch (e) { out[id] = { error: errText(e) }; }
    }
    return out;
  }

  return { list, stats, clearData, remove, reopenIn, chipMenu, clearCache, clearCookies, cookiesFor };
}

module.exports = { createContainers };
