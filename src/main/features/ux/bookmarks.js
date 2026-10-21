'use strict';
// ux-chrome: закладки (userData/bookmarks.json). {id, title, url, folder: 'bar'|'other', addedAt, favicon?}.
// Первый старт — набор кабинетов на полосе. Порядок в массиве = порядок на полосе / в «Других».

const crypto = require('crypto');
const { urlKey, describe } = require('./util');

const FOLDERS = ['bar', 'other'];
const SEED = [
  { title: 'WB Партнёры', url: 'https://seller.wildberries.ru/' },
  { title: 'Ozon Seller', url: 'https://seller.ozon.ru/' },
  { title: 'Яндекс Маркет', url: 'https://partner.market.yandex.ru/' },
  { title: 'Авито', url: 'https://www.avito.ru/profile' },
  { title: 'Пульт агента', url: 'https://pult-agenta.pult-agenta.workers.dev/' },
  { title: 'GitHub', url: 'https://github.com/' },
  { title: 'Claude', url: 'https://claude.ai/' },
];
const MAX = 5000;

function newId() { return 'b' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'); }

function validUrl(u) {
  const s = String(u || '').trim();
  if (!s || s.length > 4096) return null;
  try {
    const x = new URL(s);
    if (!/^(https?|file|kosmo|ftp):$/.test(x.protocol)) return null;
    return x.href;
  } catch (_) { return null; }
}

function createBookmarks(ctx, history) {
  const store = ctx.store('bookmarks', { version: 1, seeded: false, items: [] });
  let data = store.get();
  if (!data || typeof data !== 'object') data = { version: 1, seeded: false, items: [] };
  if (!Array.isArray(data.items)) data.items = [];
  data.items = data.items.filter((b) => b && typeof b.url === 'string' && b.id).map((b) => Object.assign(b, { folder: FOLDERS.includes(b.folder) ? b.folder : 'bar' }));
  if (!data.seeded) {
    const t = Date.now();
    for (const s of SEED) if (!data.items.some((b) => urlKey(b.url) === urlKey(s.url))) data.items.push({ id: newId(), title: s.title, url: s.url, folder: 'bar', addedAt: t });
    data.seeded = true;
    store.set(data);
    store.flush();
  }

  let changeTimer = null;
  function changed() {
    store.set(data);
    if (changeTimer) return;
    changeTimer = setTimeout(() => { changeTimer = null; ctx.broadcast('kosmo:bookmarks.changed', { items: list() }); }, 0);
  }

  function view(b) {
    // историю не загружаем ради значка: она поднимается лениво (после старта)
    const fav = b.favicon || (history && history.loaded() ? history.faviconFor(b.url) : '') || '';
    return { id: b.id, title: b.title, url: b.url, folder: b.folder, addedAt: b.addedAt || 0, favicon: fav };
  }

  function list(folder) {
    return data.items.filter((b) => !folder || b.folder === folder).map(view);
  }

  function get(id) { const b = data.items.find((x) => x.id === id); return b ? view(b) : null; }

  function find(url) {
    const k = urlKey(url);
    const b = data.items.find((x) => urlKey(x.url) === k);
    return b ? view(b) : null;
  }

  function has(url) { return !!find(url); }

  function titleFor(url, title) {
    const t = String(title || '').replace(/\s+/g, ' ').trim();
    if (t) return t.slice(0, 300);
    const d = describe(url);
    return d.hostBare || url;
  }

  // add({url, title, folder='bar', index}) → закладка (если адрес уже есть — существующая)
  function add(o = {}) {
    const url = validUrl(o.url);
    if (!url) throw new Error('неверный адрес закладки');
    const ex = data.items.find((x) => urlKey(x.url) === urlKey(url));
    if (ex && !o.allowDuplicate) return view(ex);
    if (data.items.length >= MAX) throw new Error('слишком много закладок');
    const folder = FOLDERS.includes(o.folder) ? o.folder : 'bar';
    const b = { id: newId(), title: titleFor(url, o.title), url, folder, addedAt: Date.now() };
    if (typeof o.favicon === 'string' && /^https?:/i.test(o.favicon) && o.favicon.length < 1000) b.favicon = o.favicon;
    insert(b, folder, o.index);
    changed();
    return view(b);
  }

  // Вставить в папку на позицию index (среди закладок этой папки); без index — в конец.
  function insert(b, folder, index) {
    const same = data.items.filter((x) => x.folder === folder && x !== b);
    let at;
    if (typeof index === 'number' && isFinite(index) && index < same.length) {
      const ref = same[Math.max(0, Math.round(index))];
      at = data.items.indexOf(ref);
    } else if (same.length) {
      at = data.items.indexOf(same[same.length - 1]) + 1;
    } else at = data.items.length;
    data.items.splice(at, 0, b);
  }

  function update(id, patch = {}) {
    const b = data.items.find((x) => x.id === id);
    if (!b) throw new Error('закладка не найдена');
    if (patch.url !== undefined) {
      const url = validUrl(patch.url);
      if (!url) throw new Error('неверный адрес закладки');
      b.url = url;
    }
    if (patch.title !== undefined) b.title = titleFor(b.url, patch.title);
    if (patch.folder !== undefined && FOLDERS.includes(patch.folder) && patch.folder !== b.folder) {
      data.items.splice(data.items.indexOf(b), 1);
      b.folder = patch.folder;
      insert(b, b.folder);
    }
    changed();
    return view(b);
  }

  // remove(id | url)
  function remove(idOrUrl) {
    let i = data.items.findIndex((x) => x.id === idOrUrl);
    if (i < 0) { const k = urlKey(idOrUrl); i = data.items.findIndex((x) => urlKey(x.url) === k); }
    if (i < 0) return false;
    data.items.splice(i, 1);
    changed();
    return true;
  }

  // move(id, index, folder?) — перестановка (index — позиция среди закладок папки после перемещения)
  function move(id, index, folder) {
    const b = data.items.find((x) => x.id === id);
    if (!b) throw new Error('закладка не найдена');
    data.items.splice(data.items.indexOf(b), 1);
    if (folder && FOLDERS.includes(folder)) b.folder = folder;
    insert(b, b.folder, Number(index));
    changed();
    return view(b);
  }

  // Значок страницы: точное совпадение адреса — всегда, тот же сайт — если своего значка ещё нет.
  function setFavicon(url, favicon) {
    if (!favicon || !/^https?:/i.test(favicon) || favicon.length >= 1000) return;
    const k = urlKey(url);
    const host = describe(url).hostBare;
    let n = 0;
    for (const b of data.items) {
      if (b.favicon === favicon) continue;
      if (urlKey(b.url) === k || (!b.favicon && host && describe(b.url).hostBare === host)) { b.favicon = favicon; n++; }
    }
    if (n) changed();
  }

  return { list, get, find, has, add, update, remove, move, setFavicon, FOLDERS };
}

module.exports = { createBookmarks, SEED };
