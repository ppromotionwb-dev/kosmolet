'use strict';
// ux-chrome: подсказки адресной строки. Провайдер для ctx.search (история, закладки, «Товар <бэнг> 123»)
// + сборка строк для выпадающего списка: «перейти/найти» первой, инлайн-дополнение домена, вкладки, бэнги.

const { shown, urlKey, describe } = require('./util');

const MAX_ROWS = 8;

function createOmni(ctx, history, bookmarks) {
  const S = ctx.search;

  // Короткое имя бэнга (поле short — из пака или своего бэнга), иначе название.
  function bangLabel(b) { return b.short || b.name; }

  function bookmarkMatches(q, limit) {
    const ts = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!ts.length) return [];
    const res = [];
    for (const b of bookmarks.list()) {
      const d = describe(b.url);
      const t = (b.title || '').toLowerCase();
      const u = d.dispBare.toLowerCase();
      const h = d.hostBare.toLowerCase();
      let ok = true, strong = false;
      for (const w of ts) {
        if (h.startsWith(w) || t.startsWith(w) || t.includes(' ' + w)) strong = true;
        else if (!u.includes(w) && !t.includes(w)) { ok = false; break; }
      }
      if (ok) res.push({ b, strong });
      if (res.length >= limit) break;
    }
    res.sort((a, b) => (b.strong ? 1 : 0) - (a.strong ? 1 : 0));
    return res;
  }

  // Провайдер для ctx.search.suggest (его подсказки видят и другие потребители kosmo:search.suggest).
  function provider(q) {
    const items = [];
    const hs = history.search(q, 8);
    hs.forEach((h, i) => items.push({
      type: 'history', title: h.title || shown(h.url), subtitle: shown(h.url), url: h.url, favicon: h.favicon,
      score: (h.strong ? 860 : 650) - i, removable: true,
    }));
    bookmarkMatches(q, 4).forEach(({ b, strong }, i) => items.push({
      type: 'bookmark', title: b.title, subtitle: shown(b.url), url: b.url, favicon: b.favicon, score: (strong ? 880 : 660) - i,
    }));
    if (/^\d{3,}$/.test(q)) {
      S.bangs().filter((b) => b.numericUrl).forEach((b, i) => items.push({
        type: 'product', title: `Товар ${bangLabel(b)} ${q}`, subtitle: shown(b.numericUrl.split('{q}').join(q)),
        url: b.numericUrl.split('{q}').join(encodeURIComponent(q)), bang: b.key, score: 950 - i,
      }));
    }
    return items;
  }
  S.addSuggestProvider(provider);

  function goRow(q, r) {
    if (r.kind === 'bang') {
      const b = S.findBang(r.bang) || { name: r.bang, key: r.bang };
      const numeric = !!(b.numericUrl && /^\d+$/.test(r.query || ''));
      return {
        type: 'bang', go: true, url: r.url, fill: q, bang: b.key, icon: numeric ? 'shopping-bag' : 'search',
        title: numeric ? `Товар ${bangLabel(b)} ${r.query}` : `Поиск в ${b.name}: ${r.query || '…'}`,
        sub: r.query ? shown(r.url) : 'Введите запрос или нажмите Enter — откроется сайт',
      };
    }
    if (r.kind === 'search') return { type: 'search', go: true, url: r.url, fill: q, icon: 'search', title: q, sub: 'Поиск в ' + S.engine().name };
    if (r.kind === 'internal') return { type: 'url', go: true, url: r.url, fill: q, icon: 'kosmolet', title: r.url, sub: 'Страница Космолёта' };
    const h = history.get(r.url);
    return { type: 'url', go: true, url: r.url, fill: q, icon: 'globe', favicon: h && h.favicon, title: /^https?:\/\//i.test(q) ? q : shown(r.url), sub: h && h.title ? h.title : '' };
  }

  function fromCore(it) {
    switch (it.type) {
      case 'tab': return { type: 'tab', title: it.title || shown(it.url), sub: shown(it.url), url: it.url, tabId: it.tabId, favicon: it.favicon, icon: 'app-window', fill: it.url };
      case 'bang':
        if (!it.insert) return null;
        return { type: 'bangkey', title: it.title, sub: 'Tab — искать на сайте', url: it.url, insert: it.insert, bang: it.bang, icon: 'search', fill: it.insert };
      case 'history': return { type: 'history', title: it.title, sub: it.subtitle, url: it.url, favicon: it.favicon, icon: 'history', fill: shown(it.url), removable: true };
      case 'bookmark': return { type: 'bookmark', title: it.title, sub: it.subtitle, url: it.url, favicon: it.favicon, icon: 'star', fill: shown(it.url) };
      case 'product': return { type: 'product', title: it.title, sub: it.subtitle, url: it.url, icon: 'shopping-bag', fill: it.subtitle || it.url };
      default:
        // подсказки других провайдеров
        if (!it.url && !it.insert) return null;
        return { type: it.type || 'url', title: it.title || it.url, sub: it.subtitle || '', url: it.url, favicon: it.favicon, icon: it.icon || 'globe', fill: it.insert || it.url, insert: it.insert };
    }
  }

  // Строки для выпадающего списка. raw — как есть (с пробелом в конце), opts.inline — можно дополнять домен.
  async function omni(raw, opts = {}) {
    const t0 = process.hrtime.bigint();
    raw = String(raw == null ? '' : raw).slice(0, 2000);
    const q = raw.trim();
    if (!q) return { input: raw, items: [], inline: null, ms: 0 };

    // «gh » — бэнг без запроса
    const mb = /^!?(\S+)\s+$/.exec(raw);
    const bangOnly = mb ? S.findBang(mb[1]) : null;
    const r = bangOnly ? S.resolve('!' + bangOnly.key) : S.resolve(q);
    const core = await S.suggest(q);

    const rows = [];
    const go = goRow(q, r);
    let inline = null;
    if (opts.inline && !bangOnly && r.kind !== 'bang' && !/\s/.test(q) && raw === q) {
      const c = history.complete(q);
      if (c && c.tail) {
        inline = { text: c.completion, tail: c.tail, url: c.url };
        rows.push({ type: 'url', go: true, inline: true, url: c.url, fill: c.completion, icon: 'globe', favicon: history.faviconFor(c.url), title: shown(c.url), sub: c.title || '' });
      }
    }
    rows.push(go);
    if (bangOnly) rows.push({ type: 'search', url: S.searchUrl(q), fill: q, icon: 'search', title: q, sub: 'Поиск в ' + S.engine().name });

    const tabByKey = new Map();
    for (const it of core) if (it.type === 'tab' && it.url) tabByKey.set(urlKey(it.url), it);
    const bmKeys = new Set(bookmarks.list().map((b) => urlKey(b.url)));
    const seen = new Set(rows.filter((x) => x.url && x.type !== 'search' && x.type !== 'bang').map((x) => urlKey(x.url)));
    const usedTabs = new Set();
    const tabUrls = new Set(); // две вкладки с одним адресом — одна строка

    for (const it of core) {
      if (rows.length >= MAX_ROWS) break;
      // строка «перейти/найти» от core — у нас своя
      if (it.score === 1000 && (it.type === 'url' || it.type === 'search' || (it.type === 'bang' && !it.insert))) continue;
      let row = fromCore(it);
      if (!row || (bangOnly && row.type === 'bangkey')) continue;
      const k = row.url ? urlKey(row.url) : '';
      if (row.type === 'tab') {
        if (usedTabs.has(row.tabId)) continue;
      } else if (k && tabByKey.has(k) && (row.type === 'history' || row.type === 'bookmark')) {
        // страница уже открыта — предлагаем перейти на вкладку
        const t = tabByKey.get(k);
        if (usedTabs.has(t.tabId)) continue;
        row = Object.assign(fromCore(t), { title: row.title || t.title });
      }
      if (row.type === 'tab') {
        const tk = row.url ? urlKey(row.url) : '';
        if (tk && tabUrls.has(tk)) continue;
        if (tk) tabUrls.add(tk);
        usedTabs.add(row.tabId);
        rows.push(row);
        continue;
      }
      if (k && row.type !== 'bangkey') {
        if (seen.has(k)) {
          // дубль строки «перейти» — берём её заголовок
          const g = rows.find((x) => x.go && x.url && urlKey(x.url) === k);
          if (g && (g.type === 'url') && row.title && row.title !== shown(row.url) && !g.sub) g.sub = row.title;
          if (g && !g.favicon && row.favicon) g.favicon = row.favicon;
          continue;
        }
        seen.add(k);
      }
      if (row.type === 'history' && bmKeys.has(k)) row.bookmarked = true;
      rows.push(row);
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return { input: raw, items: rows.slice(0, MAX_ROWS), inline, ms: Math.round(ms * 100) / 100 };
  }

  // ---------- палитра команд ----------
  function paletteData() {
    return {
      commands: ctx.commands.list().filter((c) => c.id !== 'palette.open'),
      tabs: ctx.tabs.list().map((t) => ({ id: t.id, title: t.title, url: t.url, favicon: t.favicon, active: t.active, containerId: t.containerId, containerName: t.containerName })),
      bookmarks: bookmarks.list(),
      bangs: S.bangs().map((b) => ({ key: b.key, name: b.name, numeric: !!b.numericUrl })),
      engine: S.engine().name,
    };
  }

  // ---------- новая вкладка ----------
  function newtabData() {
    const bar = bookmarks.list('bar').slice(0, 12);
    const bm = new Set(bookmarks.list().map((b) => urlKey(b.url)));
    const frequent = history.top(24).filter((h) => !bm.has(urlKey(h.url))).slice(0, 8);
    // быстрые кнопки — бэнги с chip: сначала из паков, потом свои и ядра
    const all = S.bangs().filter((b) => b.chip);
    const chips = all.filter((b) => b.pack).concat(all.filter((b) => !b.pack)).slice(0, 8).map((b) => ({ key: b.key, name: b.name }));
    return { bar, frequent, chips, engine: S.engine().name };
  }

  return { omni, provider, paletteData, newtabData };
}

module.exports = { createOmni };
