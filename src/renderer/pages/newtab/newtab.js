// Новая вкладка. Владелец: ux-chrome.
// Поле поиска — «приманка»: клик или ввод с клавиатуры переводит фокус в адресную строку (там подсказки и бэнги).
'use strict';
(function () {
  const U = window.KUI;
  const { h } = U;
  const $ = (id) => document.getElementById(id);
  $('nt-logo').innerHTML = window.KIcons.get('orbit', 40, { stroke: 1.3 });
  $('nt-icon').innerHTML = window.KIcons.get('search', 18);

  function focusOmnibox(text) {
    if (!U.hasKosmo) return;
    U.invoke('kosmo:ux.focusOmnibox', typeof text === 'string' ? { text } : {}).catch(() => {});
  }
  $('nt-search').addEventListener('click', () => focusOmnibox());
  // печать на странице уходит в адресную строку
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key.length === 1 && e.key !== ' ') { e.preventDefault(); focusOmnibox(e.key); }
  });

  function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }
  function icon(b) {
    const box = h('span.nt-tile-ic');
    const letter = () => {
      const t = (b.title || hostOf(b.url) || '?').trim();
      return h('span.nt-tile-letter', (t.match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase());
    };
    if (b.favicon && /^(https?:|data:image\/)/i.test(b.favicon)) {
      const img = h('img', { alt: '', decoding: 'async', loading: 'lazy', referrerpolicy: 'no-referrer', draggable: 'false' });
      img.addEventListener('error', () => { U.clear(box).appendChild(letter()); }, { once: true });
      img.src = b.favicon;
      box.appendChild(img);
    } else box.appendChild(letter());
    return box;
  }
  function tile(b, removable) {
    const title = b.title || hostOf(b.url) || b.url;
    const a = h('a.nt-tile', { href: b.url, title: title + '\n' + b.url, draggable: 'false' }, icon(b), h('span.nt-tile-title', title));
    if (removable) {
      const x = h('button.nt-tile-x', { type: 'button', title: 'Убрать с новой вкладки', 'aria-label': 'Убрать', html: window.KIcons.get('x', 13) });
      x.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        U.invoke('kosmo:ux.newtabHide', { url: b.url }).then(load).catch(() => {});
      });
      a.appendChild(x);
    }
    return a;
  }
  function fill(sectionId, items, removable) {
    const sec = $(sectionId);
    const grid = sec.querySelector('.nt-grid');
    U.clear(grid);
    // одинаковые заголовки разных сайтов — показываем домен
    const counts = new Map();
    for (const b of items) counts.set(b.title, (counts.get(b.title) || 0) + 1);
    for (const b of items) grid.appendChild(tile(counts.get(b.title) > 1 && hostOf(b.url) ? Object.assign({}, b, { title: hostOf(b.url) }) : b, removable));
    sec.hidden = !items.length;
  }

  let chipsDone = false;
  function render(d) {
    d = d || {};
    if (d.engine) $('nt-placeholder').textContent = 'Поиск в ' + d.engine + ' или адрес';
    if (!chipsDone && Array.isArray(d.chips)) {
      chipsDone = true;
      const box = $('nt-chips');
      for (const c of d.chips) {
        const b = h('button.nt-chip', { type: 'button', title: 'Поиск в ' + c.name + ': «' + c.key + ' запрос»' }, h('span.k-kbd', c.key), c.name);
        b.addEventListener('click', () => focusOmnibox(c.key + ' '));
        box.appendChild(b);
      }
    }
    fill('nt-bar', d.bar || [], false);
    fill('nt-freq', d.frequent || [], true);
  }

  let loading = false;
  function load() {
    if (!U.hasKosmo || loading) return Promise.resolve();
    loading = true;
    return U.invoke('kosmo:ux.newtab', {}).then(render).catch((e) => console.warn('[newtab]', e && e.message)).finally(() => { loading = false; });
  }
  load();
  const reload = U.debounce(load, 300);
  U.on('kosmo:bookmarks.changed', reload);
  U.on('kosmo:settings.changed', (p) => { if (p && (!p.path || String(p.path).indexOf('search') === 0)) reload(); });
  // вернулись на вкладку — обновить частые сайты
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reload(); });
})();
