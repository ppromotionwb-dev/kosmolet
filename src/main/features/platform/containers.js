'use strict';
// Контейнеры: очистка и удаление данных сессии, «Открыть в контейнере ▸» в меню вкладки, меню чипа контейнера,
// изолированные вкладки (вкладка = свой временный контейнер), а также общие операции приватности (кэш, cookies всех контейнеров).
// Список контейнеров живёт в settings.containers (схема и проверка — ядро). Временный контейнер — { temp: true }:
// удаляется вместе с данными, когда закрыта его последняя вкладка; «Оставить контейнер» снимает метку.

const fs = require('fs');
const path = require('path');
const { errText } = require('./util');

const STORAGES_ALL = ['cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache', 'websql', 'serviceworkers', 'cachestorage'];
// Цвета новых контейнеров (как палитра раздела настроек «Контейнеры»); серый — запасной.
const PALETTE = ['#4c8dff', '#22b8cf', '#43c98a', '#e9b04f', '#ff8a3d', '#ef6b6b', '#e86bb6', '#7c6cff'];
const ISO_PREFIX = 'Изоляция ';

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
  function find(id) { return list().find((c) => c.id === id) || null; }

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

  // ---------- создание, изолированные вкладки ----------

  function newId(prefix) {
    let id;
    do id = prefix + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36); while (exists(id));
    return id;
  }

  function freeColor() {
    const used = new Set(list().map((c) => String(c.color).toLowerCase()));
    return PALETTE.find((c) => !used.has(c)) || PALETTE[list().length % PALETTE.length];
  }

  function freeName(base) {
    const names = new Set(list().map((c) => c.name));
    let n = 1;
    while (names.has(base + n)) n++;
    return base + n;
  }

  // Новый контейнер. temp — временный (удалится с последней вкладкой). → запись контейнера.
  function create(opts = {}) {
    const temp = opts.temp !== false;
    const name = String(opts.name || '').trim().slice(0, 40) || freeName(temp ? ISO_PREFIX : 'Контейнер ');
    const color = /^#[0-9a-f]{6}$/i.test(opts.color || '') ? opts.color.toLowerCase() : freeColor();
    const c = { id: newId(temp ? 't' : 'c'), name, color };
    if (temp) c.temp = true;
    ctx.settings.set('containers', list().concat(c));
    log(`создан ${temp ? 'временный ' : ''}контейнер ${c.id} «${name}»`);
    return c;
  }

  // Изолированная вкладка: свой новый контейнер (cookies, вход, кэш — только её и открытых из неё окон).
  function openIsolated(opts = {}) {
    const c = create({ temp: opts.temp !== false, name: opts.name, color: opts.color });
    const tab = ctx.tabs.create({
      url: opts.url || ctx.tabs.NEWTAB, containerId: c.id, index: opts.index,
      active: opts.active !== false, pinned: !!opts.pinned,
    });
    return { tab, container: c };
  }

  // Оставить временный контейнер (перестаёт удаляться при закрытии вкладок); name — заодно переименовать.
  function keep(id, name) {
    const c = find(id);
    if (!c) throw new Error('нет такого контейнера');
    const nm = String(name || '').trim().slice(0, 40);
    ctx.settings.set('containers', list().map((x) => {
      if (x.id !== id) return x;
      const o = Object.assign({}, x, nm ? { name: nm } : null);
      delete o.temp;
      return o;
    }));
    return true;
  }

  // Временные контейнеры без вкладок — удалить (с данными). Вызов после закрытия вкладки и при старте.
  const sweepPending = new Set();
  function sweep(ids) {
    if (ctx.quitting) return;
    const busy = new Set(ctx.tabs.all().map((t) => t.info.containerId));
    for (const c of list()) {
      if (!c.temp || busy.has(c.id) || sweepPending.has(c.id) || (ids && !ids.includes(c.id))) continue;
      sweepPending.add(c.id);
      remove(c.id).catch((e) => log('временный контейнер:', errText(e))).finally(() => sweepPending.delete(c.id));
    }
  }
  ctx.tabs.on('closed', (tab) => {
    const id = tab.info.containerId;
    const c = find(id);
    // после закрытия: вкладку могли тут же переоткрыть в том же контейнере (перенос, повтор)
    if (c && c.temp) setTimeout(() => sweep([id]), 300);
  });
  // При старте: временные контейнеры, чьи вкладки не восстановились (сессия выключена, сбой).
  ctx.bus.once('ready', () => setTimeout(() => sweep(), 2000));

  // Вкладка ссылается на контейнер, которого уже нет (повтор закрытой вкладки удалённого временного контейнера):
  // открываем её в новом изолированном контейнере, а не в основном — иначе вход «кабинета» смешается с основным.
  const remap = new Map();
  if (ctx.sessions && typeof ctx.sessions.setMissingHandler === 'function') {
    ctx.sessions.setMissingHandler((id) => {
      const prev = remap.get(id);
      if (prev && exists(prev)) return prev;
      const c = create({ temp: true });
      remap.set(id, c.id);
      return c.id;
    });
  }

  // Открыть копию вкладки в другом контейнере (оригинал остаётся — например, второй кабинет рядом).
  function reopenIn(tabId, cid) {
    const t = ctx.tabs.get(tabId);
    if (!t || !exists(cid)) return null;
    const url = t.info.url && !/^kosmo:\/\/error/i.test(t.info.url) ? t.info.url : ctx.tabs.NEWTAB;
    return ctx.tabs.create({ url, containerId: cid, index: t.index + 1, active: true });
  }

  function containerSubmenu(tab) {
    const url = tab.info.url && !/^kosmo:\/\/error/i.test(tab.info.url) ? tab.info.url : ctx.tabs.NEWTAB;
    return [{ label: 'Новый изолированный', click: () => openIsolated({ url, index: tab.index + 1 }) }, { type: 'separator' }]
      .concat(list().map((c) => ({
        label: c.name + (c.id === tab.info.containerId ? ' (текущий)' : ''),
        enabled: c.id !== tab.info.containerId,
        click: () => reopenIn(tab.id, c.id),
      })))
      .concat([{ type: 'separator' }, { label: 'Настроить контейнеры…', click: () => ctx.tabs.openOrActivate('kosmo://settings/#containers') }]);
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
      { label: `${c.temp ? 'Временный контейнер' : 'Контейнер'} «${c.name}»`, enabled: false },
      { type: 'separator' },
      { label: 'Новая вкладка в этом контейнере', click: () => ctx.tabs.create({ url: ctx.tabs.NEWTAB, containerId: c.id, active: true }) },
      { label: 'Новая изолированная вкладка', click: () => openIsolated({}) },
      { label: 'Открыть страницу в контейнере', submenu: containerSubmenu(tab) },
    ];
    if (c.temp) {
      tpl.push({ type: 'separator' },
        { label: 'Оставить контейнер (не удалять при закрытии)', click: () => { keep(c.id); ctx.overlay.toast(`Контейнер «${c.name}» сохранён — переименовать можно в настройках`); } });
    }
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

  return { list, stats, create, openIsolated, keep, sweep, clearData, remove, reopenIn, chipMenu, clearCache, clearCookies, cookiesFor };
}

module.exports = { createContainers };
