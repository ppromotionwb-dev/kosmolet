// Владелец: ux-chrome. Всплывающие окна: подсказки адресной строки (omnibox), командная палитра (palette),
// закладка (bookmark-edit), меню закладки (bm-menu), папка закладок (bm-folder), загрузки (downloads).
'use strict';
(function () {
  const O = window.KOverlay;
  const U = window.KUI;
  if (!O || !U) return;
  const { h } = U;
  U.css('features/ux-chrome.css');
  const I = window.KIcons;
  I.add('app-window', '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 4v4"/><path d="M2 8h20"/><path d="M6 4v4"/>');
  I.add('folder-input', '<path d="M2 9V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-1"/><path d="M2 13h10"/><path d="m9 16 3-3-3-3"/>');
  I.add('bookmark-bar', '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/>');

  const warn = (e) => console.warn('[ux-chrome]', e && e.message ? e.message : e);
  function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }
  function shown(u) {
    try {
      const x = new URL(u);
      if (x.protocol === 'https:' || x.protocol === 'http:') {
        let rest = x.pathname + x.search + x.hash;
        if (rest === '/') rest = '';
        try { rest = decodeURI(rest); } catch (e) { /* как есть */ }
        return (x.protocol === 'http:' ? 'http://' : '') + U.hostToUnicode(x.hostname) + (x.port ? ':' + x.port : '') + rest;
      }
    } catch (e) { /* не адрес */ }
    return String(u || '');
  }
  function letter(text) {
    const ch = (String(text || '?').match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase();
    return h('span.ux-letter', ch);
  }
  // значок: favicon → иначе иконка набора (или буква)
  function favicon(src, fallback, letterText) {
    const box = h('span.ux-fav');
    const fb = () => (fallback ? U.icon(fallback, 16) : letter(letterText));
    if (src && /^(https?:|data:image\/)/i.test(src)) {
      const img = h('img', { alt: '', draggable: 'false', decoding: 'async', referrerpolicy: 'no-referrer' });
      img.addEventListener('error', () => { U.clear(box).appendChild(fb()); }, { once: true });
      img.src = src;
      box.appendChild(img);
    } else box.appendChild(fb());
    return box;
  }
  // подсветка совпадений слов запроса
  function marked(text, terms) {
    const s = String(text || '');
    const frag = document.createDocumentFragment();
    if (!terms.length || !s) { frag.appendChild(document.createTextNode(s)); return frag; }
    const low = s.toLowerCase();
    const marks = new Array(s.length).fill(false);
    for (const t of terms) {
      if (!t) continue;
      let i = low.indexOf(t);
      let guard = 0;
      while (i >= 0 && guard++ < 20) { for (let j = i; j < i + t.length; j++) marks[j] = true; i = low.indexOf(t, i + t.length); }
    }
    let i = 0;
    while (i < s.length) {
      const m = marks[i];
      let j = i;
      while (j < s.length && marks[j] === m) j++;
      const part = s.slice(i, j);
      frag.appendChild(m ? h('b', part) : document.createTextNode(part));
      i = j;
    }
    return frag;
  }
  const termsOf = (q) => String(q || '').toLowerCase().trim().split(/\s+/).filter(Boolean).slice(0, 6);

  // =====================================================================
  // omnibox — без фокуса; клавиши обрабатывает chrome, сюда приходит 'select'
  // =====================================================================
  O.register('omnibox', {
    className: 'ux-om',
    render(root, data, api) {
      api._list = h('div.ux-om-list', { role: 'listbox' });
      root.appendChild(api._list);
      root.addEventListener('pointerdown', (e) => {
        const rm = e.target.closest('.ux-om-rm');
        const row = e.target.closest('.ux-om-row');
        if (!row) return;
        e.preventDefault();
        const index = Number(row.dataset.i);
        if (rm) { api.emit('remove', { index }); return; }
        if (e.button === 0) api.emit('pick', { index, newTab: e.ctrlKey || e.shiftKey, background: e.ctrlKey });
        else if (e.button === 1) api.emit('pick', { index, newTab: true, background: true });
      });
      root.addEventListener('auxclick', (e) => e.preventDefault());
      this.update(data, api);
    },
    update(data, api) {
      data = data || {};
      const root = api.root;
      if (data.width) root.style.width = Math.max(320, Math.round(data.width)) + 'px';
      const list = api._list;
      U.clear(list);
      const terms = termsOf(data.typed);
      (data.items || []).forEach((it, i) => {
        const ic = it.favicon ? favicon(it.favicon, it.icon || 'globe') : h('span.ux-fav', U.icon(it.icon || 'globe', 16));
        const text = h('span.ux-om-text',
          h('span.ux-om-title', marked(it.title, it.go && (it.type === 'search' || it.type === 'bang') ? [] : terms)),
          it.sub ? h('span.ux-om-sep', '—') : null,
          it.sub ? h('span.ux-om-sub', it.type === 'history' || it.type === 'bookmark' || it.type === 'tab' ? marked(it.sub, terms) : it.sub) : null);
        let right = null;
        if (it.type === 'tab') right = h('span.ux-om-pill', 'Перейти на вкладку');
        else if (it.type === 'bangkey') right = h('span.k-kbd', 'Tab');
        else if (it.bookmarked || it.type === 'bookmark') right = h('span.ux-om-star', { title: 'В закладках', html: I.get('star-filled', 12) });
        const rm = it.removable ? h('button.ux-om-rm', { tabindex: '-1', title: 'Удалить из истории (Shift+Delete)', html: I.get('x', 14) }) : null;
        list.appendChild(h('div.ux-om-row' + (i === (data.sel || 0) ? '.sel' : '') + (it.go ? '.go' : ''), { role: 'option', dataset: { i: String(i), type: it.type || '' } }, ic, text, right, rm));
      });
    },
    onEvent(name, data, api) {
      if (name !== 'select') return;
      const rows = api._list.children;
      for (let i = 0; i < rows.length; i++) rows[i].classList.toggle('sel', i === Number(data));
    },
  });

  // =====================================================================
  // palette — модальная командная палитра
  // =====================================================================
  function fuzzy(q, text) {
    if (!q) return 1;
    const t = text.toLowerCase();
    const i = t.indexOf(q);
    if (i >= 0) {
      const wordStart = i === 0 || /[\s\-—.:/«(]/.test(t[i - 1]);
      return 1000 - i + (wordStart ? 300 : 0) + (i === 0 ? 200 : 0);
    }
    // подпоследовательность: бонус подряд идущим и началам слов
    let score = 0, ti = 0, run = 0;
    for (let qi = 0; qi < q.length; qi++) {
      const ch = q[qi];
      if (ch === ' ') { run = 0; continue; }
      const j = t.indexOf(ch, ti);
      if (j < 0) return -1;
      const ws = j === 0 || /[\s\-—.:/«(]/.test(t[j - 1]);
      run = j === ti ? run + 1 : 0;
      score += 10 + run * 6 + (ws ? 12 : 0) - Math.min(8, j - ti);
      ti = j + 1;
    }
    return Math.max(1, score);
  }

  const GROUPS = { command: 'Команды', tab: 'Вкладки', bookmark: 'Закладки', history: 'История', bang: 'Бэнги', search: 'Поиск' };
  const ORDER = ['command', 'tab', 'bookmark', 'history', 'bang', 'search'];

  O.register('palette', {
    align: 'top', width: 'min(640px, 100%)', className: 'ux-pal',
    render(root, data, api) {
      const st = api._st = { data: data || {}, q: '', items: [], sel: 0, history: [], histQ: '', histTimer: 0 };
      const input = h('input.ux-pal-input', { type: 'text', spellcheck: 'false', autocomplete: 'off', autofocus: true, placeholder: 'Команда, вкладка, закладка или бэнг', 'aria-label': 'Командная палитра' });
      const list = h('div.ux-pal-list.ov-scroll', { role: 'listbox' });
      st.input = input; st.list = list;
      root.append(h('div.ux-pal-head', U.icon('command', 16), input, h('span.k-kbd', 'Esc')), list);
      input.addEventListener('input', () => { st.q = input.value; st.sel = 0; compute(api); fetchHistory(api); });
      input.addEventListener('keydown', (e) => {
        const n = st.items.length;
        if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) { e.preventDefault(); if (n) setSel(api, (st.sel + 1) % n); }
        else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) { e.preventDefault(); if (n) setSel(api, (st.sel - 1 + n) % n); }
        else if (e.key === 'PageDown') { e.preventDefault(); if (n) setSel(api, Math.min(n - 1, st.sel + 8)); }
        else if (e.key === 'PageUp') { e.preventDefault(); if (n) setSel(api, Math.max(0, st.sel - 8)); }
        else if (e.key === 'Enter') { e.preventDefault(); run(api, st.items[st.sel], e.altKey || e.ctrlKey); }
      });
      list.addEventListener('click', (e) => {
        const row = e.target.closest('.ux-pal-row');
        if (row) run(api, st.items[Number(row.dataset.i)], e.ctrlKey || e.altKey);
      });
      list.addEventListener('pointermove', (e) => {
        const row = e.target.closest('.ux-pal-row');
        if (row && Number(row.dataset.i) !== st.sel) setSel(api, Number(row.dataset.i), true);
      });
      compute(api);
    },
    update(data, api) { api._st.data = data || {}; compute(api); },
  });

  function paletteCandidates(st) {
    const d = st.data || {};
    const q = st.q.trim().toLowerCase();
    const out = [];
    const add = (kind, score, o) => { if (score >= 0) out.push(Object.assign({ kind, score }, o)); };
    for (const c of d.commands || []) {
      const s = fuzzy(q, c.title + ' ' + (c.category || '') + ' ' + (c.keys || []).join(' '));
      add('command', s, { id: c.id, title: c.title, sub: c.category, keys: c.keys || [], disabled: c.enabled === false, icon: 'command' });
    }
    for (const t of d.tabs || []) {
      const s = q ? fuzzy(q, (t.title || '') + ' ' + shown(t.url)) : (t.active ? -1 : 1);
      add('tab', s, { id: t.id, title: t.title || shown(t.url), sub: shown(t.url) + (t.containerId && t.containerId !== 'main' && t.containerName ? ' · ' + t.containerName : ''), favicon: t.favicon, icon: 'app-window', active: t.active });
    }
    if (q) {
      for (const b of d.bookmarks || []) add('bookmark', fuzzy(q, (b.title || '') + ' ' + shown(b.url)), { id: b.id, url: b.url, title: b.title, sub: shown(b.url), favicon: b.favicon, icon: 'star' });
      const seenUrl = new Set((d.bookmarks || []).map((b) => b.url));
      st.history.forEach((x, i) => { if (!seenUrl.has(x.url)) add('history', 600 - i * 10, { url: x.url, title: x.title || shown(x.url), sub: shown(x.url), favicon: x.favicon, icon: 'history' }); });
      const m = /^(\S+)(\s+([\s\S]*))?$/.exec(st.q.trim());
      for (const b of d.bangs || []) {
        if (m && m[2] !== undefined && b.key === m[1].toLowerCase()) {
          const rest = (m[3] || '').trim();
          add('search', 5000, { text: st.q.trim(), title: (b.numeric && /^\d+$/.test(rest) ? 'Товар ' : 'Поиск в ') + b.name + (rest ? ': ' + rest : ''), sub: 'Бэнг ' + b.key, icon: 'search' });
        } else {
          const s = Math.max(fuzzy(q, b.key) + (b.key === q ? 500 : 0), fuzzy(q, b.name) - 200);
          add('bang', s > 0 ? s - 100 : -1, { key: b.key, title: b.key + ' — ' + b.name, sub: 'Поиск по сайту', icon: 'search' });
        }
      }
      add('search', 0, { text: st.q.trim(), title: 'Искать «' + st.q.trim() + '»', sub: d.engine ? 'в ' + d.engine : '', icon: 'search', last: true });
    }
    return out;
  }

  function compute(api) {
    const st = api._st;
    const q = st.q.trim();
    const cands = paletteCandidates(st);
    const limit = { command: q ? 30 : 9, tab: q ? 10 : 12, bookmark: 10, history: 6, bang: 4, search: 2 };
    const byKind = new Map();
    for (const c of cands) {
      if (!byKind.has(c.kind)) byKind.set(c.kind, []);
      byKind.get(c.kind).push(c);
    }
    const ordered = [];
    for (const k of ORDER) {
      const g = byKind.get(k);
      if (!g || !g.length) continue;
      if (q) g.sort((a, b) => b.score - a.score);
      ordered.push({ kind: k, items: g.slice(0, limit[k]), best: q ? g[0].score : -ORDER.indexOf(k) });
    }
    // группы — по лучшему совпадению; «Искать …» в конце, а поиск бэнгом («wb кроссовки») — первым
    const searchG = ordered.find((g) => g.kind === 'search');
    const groups = ordered.filter((g) => g.kind !== 'search');
    if (q) groups.sort((a, b) => b.best - a.best);
    if (searchG) { if (searchG.items[0].score >= 5000) groups.unshift(searchG); else groups.push(searchG); }
    st.items = [];
    st.groups = groups;
    for (const g of groups) for (const it of g.items) st.items.push(it);
    if (st.sel >= st.items.length) st.sel = 0;
    renderPalette(api);
  }

  function renderPalette(api) {
    const st = api._st;
    const list = st.list;
    U.clear(list);
    if (!st.items.length) {
      list.appendChild(U.empty({ icon: 'search', title: 'Ничего не найдено', text: 'Попробуйте другое слово.' }));
      return;
    }
    const terms = termsOf(st.q);
    let i = 0;
    for (const g of st.groups) {
      list.appendChild(h('div.ux-pal-group.k-label', GROUPS[g.kind]));
      for (const it of g.items) {
        const ic = it.favicon ? favicon(it.favicon, it.icon) : h('span.ux-fav', U.icon(it.icon || 'command', 16));
        let right = null;
        if (it.kind === 'command' && it.keys && it.keys.length) right = h('span.ux-pal-keys', it.keys.slice(0, 2).map((k) => h('span.k-kbd', k)));
        else if (it.kind === 'tab' && it.active) right = h('span.ux-om-pill', 'Текущая');
        const row = h('div.ux-pal-row' + (i === st.sel ? '.sel' : '') + (it.disabled ? '.disabled' : ''), { role: 'option', dataset: { i: String(i) } },
          ic,
          h('span.ux-pal-text', h('span.ux-pal-title', marked(it.title, terms)), it.sub ? h('span.ux-pal-sub', it.sub) : null),
          right);
        list.appendChild(row);
        i++;
      }
    }
    const selEl = list.querySelector('.ux-pal-row.sel');
    if (selEl) selEl.scrollIntoView({ block: 'nearest' });
  }

  function setSel(api, i, fromMouse) {
    const st = api._st;
    st.sel = i;
    const rows = st.list.querySelectorAll('.ux-pal-row');
    rows.forEach((r) => r.classList.toggle('sel', Number(r.dataset.i) === i));
    if (!fromMouse) { const el = st.list.querySelector('.ux-pal-row.sel'); if (el) el.scrollIntoView({ block: 'nearest' }); }
  }

  function fetchHistory(api) {
    const st = api._st;
    clearTimeout(st.histTimer);
    const q = st.q.trim();
    if (q.length < 2) { st.history = []; return; }
    st.histTimer = setTimeout(() => {
      api.invoke('kosmo:history.search', { q, limit: 6 }).then((res) => {
        if (st.q.trim() !== q) return;
        st.history = Array.isArray(res) ? res : [];
        const keep = st.items[st.sel];
        compute(api);
        if (keep) { const j = st.items.findIndex((x) => x.kind === keep.kind && (x.id || x.url || x.key) === (keep.id || keep.url || keep.key)); if (j >= 0) setSel(api, j); }
      }).catch(warn);
    }, 70);
  }

  function run(api, it, newTab) {
    if (!it || it.disabled) return;
    const p = { kind: it.kind, newTab: !!newTab };
    if (it.kind === 'command' || it.kind === 'tab') p.id = it.id;
    if (it.kind === 'bookmark' || it.kind === 'history') p.url = it.url;
    if (it.kind === 'bang') p.key = it.key;
    if (it.kind === 'search') p.text = it.text;
    api.invoke('kosmo:ux.paletteRun', p).catch((e) => { warn(e); api.close(); });
  }

  // =====================================================================
  // bookmark-edit — название, адрес, папка, удалить
  // =====================================================================
  O.register('bookmark-edit', {
    width: 340, className: 'ux-be',
    render(root, data, api) {
      const b = (data && data.bookmark) || {};
      const title = h('input.k-input', { type: 'text', value: b.title || '', autofocus: true, spellcheck: 'false', 'aria-label': 'Название' });
      const url = h('input.k-input.k-mono', { type: 'text', value: b.url || '', spellcheck: 'false', 'aria-label': 'Адрес' });
      const folder = h('select.k-select', { 'aria-label': 'Папка' },
        h('option', { value: 'bar' }, 'Полоса закладок'), h('option', { value: 'other' }, 'Другие закладки'));
      folder.value = b.folder === 'other' ? 'other' : 'bar';
      const err = h('div.ux-be-err', { hidden: true });
      const save = () => {
        err.hidden = true;
        api.invoke('kosmo:bookmarks.update', { id: b.id, title: title.value, url: url.value.trim(), folder: folder.value })
          .then(() => api.close())
          .catch((e) => { err.textContent = cleanErr(e); err.hidden = false; });
      };
      const del = h('button.k-btn.k-btn-ghost.k-btn-danger', { type: 'button' }, U.icon('trash', 14), 'Удалить');
      del.addEventListener('click', () => api.invoke('kosmo:bookmarks.remove', { id: b.id }).then(() => api.close()).catch(warn));
      const done = h('button.k-btn.k-btn-primary', { type: 'button' }, 'Готово');
      done.addEventListener('click', save);
      for (const el of [title, url]) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
      root.append(
        O.ui.header(data && data.added ? 'Закладка добавлена' : 'Изменить закладку', api),
        h('div.ux-be-body',
          h('label.ux-field', h('span.ux-field-label', 'Название'), title),
          h('label.ux-field', h('span.ux-field-label', 'Адрес'), url),
          h('label.ux-field', h('span.ux-field-label', 'Папка'), folder),
          err),
        h('div.ov-foot.ux-be-foot', del, h('span.k-grow'), done));
      setTimeout(() => { try { title.select(); } catch (e) { /* ignore */ } }, 30);
    },
  });
  function cleanErr(e) {
    return String((e && e.message) || e || 'Не получилось').replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '').replace(/^./, (c) => c.toUpperCase());
  }

  // =====================================================================
  // bm-menu — контекстное меню закладки на полосе
  // =====================================================================
  O.register('bm-menu', {
    width: 250, className: 'ux-bmm',
    render(root, data, api) {
      const b = (data && data.bookmark) || {};
      const other = b.folder === 'other';
      const menu = O.ui.menu([
        { id: 'open', icon: 'globe', title: 'Открыть' },
        { id: 'new', icon: 'plus', title: 'Открыть в новой вкладке' },
        { id: 'bg', icon: 'layers', title: 'Открыть в фоновой вкладке' },
        'sep',
        { id: 'edit', icon: 'pencil', title: 'Изменить…' },
        { id: 'move', icon: other ? 'bookmark-bar' : 'folder-input', title: other ? 'На полосу закладок' : 'Переместить в «Другие»' },
        { id: 'copy', icon: 'copy', title: 'Копировать адрес' },
        'sep',
        { id: 'del', icon: 'trash', title: 'Удалить', danger: true },
      ], { onPick: (it) => bmAction(api, b, it.id) });
      menu.setAttribute('autofocus', '');
      root.append(h('div.ux-menu-head.k-ellipsis', b.title || shown(b.url)), menu);
    },
  });

  function bmAction(api, b, act) {
    const done = () => api.close();
    switch (act) {
      case 'open': api.invoke('kosmo:tabs.navigate', { url: b.url }).then(done, warn); break;
      case 'new': api.invoke('kosmo:tabs.create', { url: b.url, active: true }).then(done, warn); break;
      case 'bg': api.invoke('kosmo:tabs.create', { url: b.url, background: true }).then(done, warn); break;
      case 'edit': api.invoke('kosmo:overlay.open', { type: 'bookmark-edit', data: { bookmark: b }, anchor: api.anchor, align: 'start' }).catch(warn); break;
      case 'move': api.invoke('kosmo:bookmarks.update', { id: b.id, folder: b.folder === 'other' ? 'bar' : 'other' }).then(done, warn); break;
      case 'copy': U.copyText(b.url, { toast: false }).then(done); break;
      case 'del': api.invoke('kosmo:bookmarks.remove', { id: b.id }).then(done, warn); break;
      default: done();
    }
  }

  // =====================================================================
  // bm-folder — «Другие закладки» и закладки, не поместившиеся на полосе
  // =====================================================================
  O.register('bm-folder', {
    width: 340, className: 'ux-bf',
    render(root, data, api) {
      const st = api._st = { data: data || {}, sel: -1 };
      st.list = h('div.ux-bf-list.ov-scroll', { tabindex: '-1', autofocus: true, role: 'listbox' });
      root.append(O.ui.header((data && data.title) || 'Закладки', api), st.list);
      st.list.addEventListener('click', (e) => {
        const row = e.target.closest('.ux-bf-row');
        if (!row) return;
        const b = st.items[Number(row.dataset.i)];
        const btn = e.target.closest('button[data-act]');
        if (btn) {
          e.stopPropagation();
          if (btn.dataset.act === 'edit') api.invoke('kosmo:overlay.open', { type: 'bookmark-edit', data: { bookmark: b }, anchor: api.anchor, align: 'end' }).catch(warn);
          else if (btn.dataset.act === 'del') api.invoke('kosmo:bookmarks.remove', { id: b.id }).catch(warn);
          return;
        }
        openFromFolder(api, b, e.ctrlKey ? 'bg' : e.shiftKey ? 'new' : 'cur');
      });
      st.list.addEventListener('auxclick', (e) => {
        if (e.button !== 1) return;
        const row = e.target.closest('.ux-bf-row');
        if (row) openFromFolder(api, st.items[Number(row.dataset.i)], 'bg');
      });
      st.list.addEventListener('keydown', (e) => {
        const n = st.items.length;
        if (!n) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); st.sel = (st.sel + 1) % n; markSel(st); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); st.sel = st.sel <= 0 ? n - 1 : st.sel - 1; markSel(st); }
        else if (e.key === 'Enter' && st.sel >= 0) { e.preventDefault(); openFromFolder(api, st.items[st.sel], e.altKey ? 'new' : 'cur'); }
      });
      api.on('kosmo:bookmarks.changed', (p) => {
        if (!p || !Array.isArray(p.items)) return;
        const d = st.data;
        const items = d.ids ? p.items.filter((b) => d.ids.includes(b.id) && b.folder === 'bar') : p.items.filter((b) => b.folder === (d.folder || 'other'));
        st.data = Object.assign({}, d, { items });
        renderFolder(api);
        api.resize();
      });
      renderFolder(api);
    },
    update(data, api) { api._st.data = data || {}; renderFolder(api); },
  });
  function markSel(st) {
    st.list.querySelectorAll('.ux-bf-row').forEach((r) => r.classList.toggle('sel', Number(r.dataset.i) === st.sel));
    const el = st.list.querySelector('.ux-bf-row.sel');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }
  function renderFolder(api) {
    const st = api._st;
    const items = st.items = (st.data && st.data.items) || [];
    U.clear(st.list);
    if (!items.length) {
      st.list.appendChild(U.empty({ icon: 'folder', title: 'Здесь пока пусто', text: st.data.folder === 'other' ? 'Перетащите закладку с полосы на «Другие» или выберите папку в окне закладки.' : 'Все закладки помещаются на полосе.' }));
      return;
    }
    items.forEach((b, i) => {
      st.list.appendChild(h('div.ux-bf-row' + (i === st.sel ? '.sel' : ''), { dataset: { i: String(i) }, title: b.url },
        favicon(b.favicon, null, b.title || hostOf(b.url)),
        h('span.ux-bf-text', h('span.ux-bf-title', b.title || hostOf(b.url)), h('span.ux-bf-sub', shown(b.url))),
        h('span.ux-bf-acts',
          h('button.k-icon-btn.k-icon-btn-sm', { tabindex: '-1', title: 'Изменить', dataset: { act: 'edit' }, html: I.get('pencil', 13) }),
          h('button.k-icon-btn.k-icon-btn-sm', { tabindex: '-1', title: 'Удалить', dataset: { act: 'del' }, html: I.get('trash', 13) }))));
    });
  }
  function openFromFolder(api, b, mode) {
    if (!b) return;
    const p = mode === 'cur' ? api.invoke('kosmo:tabs.navigate', { url: b.url })
      : api.invoke('kosmo:tabs.create', { url: b.url, active: mode === 'new', background: mode === 'bg' });
    p.then(() => api.close(), warn);
  }

  // =====================================================================
  // downloads — последние загрузки
  // =====================================================================
  const EXT = {
    archive: ['zip', 'rar', '7z', 'gz', 'tgz', 'tar', 'bz2', 'xz'],
    image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'heic'],
    doc: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'ppt', 'pptx', 'txt', 'rtf', 'odt', 'ods', 'md'],
    code: ['js', 'json', 'ts', 'html', 'css', 'xml', 'yml', 'yaml', 'py', 'sh', 'ps1', 'bat'],
    app: ['exe', 'msi', 'apk', 'dmg', 'appx', 'msix'],
    media: ['mp3', 'mp4', 'mov', 'avi', 'mkv', 'wav', 'webm', 'ogg', 'flac'],
  };
  function extOf(name) { const m = /\.([a-z0-9]{1,6})$/i.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; }
  function fileTile(name) {
    const ext = extOf(name);
    let kind = 'other';
    for (const k of Object.keys(EXT)) if (EXT[k].includes(ext)) kind = k;
    return h('span.ux-file', { dataset: { kind } }, ext ? ext.slice(0, 4).toUpperCase() : U.icon('file', 14));
  }
  function dlStatus(r) {
    const fb = U.formatBytes;
    if (r.state === 'progressing') {
      const parts = [];
      if (r.paused) parts.push('Пауза');
      parts.push(r.total > 0 ? fb(r.received) + ' из ' + fb(r.total) : fb(r.received));
      if (!r.paused && r.speed > 0) {
        parts.push(fb(r.speed) + '/с');
        if (r.total > 0) parts.push('осталось ' + U.formatMs(((r.total - r.received) / r.speed) * 1000));
      }
      return parts.join(' · ');
    }
    if (r.state === 'completed') return r.exists === false ? 'Файл удалён или перемещён' : fb(r.total || r.received) + ' · ' + U.timeAgo(r.endTime || r.startTime);
    if (r.state === 'cancelled') return 'Отменено';
    return 'Прервано' + (r.received ? ' · ' + fb(r.received) : '');
  }
  function dlActions(r) {
    const b = (act, icon, title) => h('button.k-icon-btn.k-icon-btn-sm', { tabindex: '-1', title, dataset: { act }, html: I.get(icon, 14) });
    if (r.state === 'progressing') return [r.paused ? b('resume', 'play', 'Продолжить') : b('pause', 'pause', 'Пауза'), b('cancel', 'x', 'Отменить')];
    if (r.state === 'completed') return [b('show', 'folder', 'Показать в папке'), b('remove', 'x', 'Убрать из списка')];
    return [b('retry', 'rotate-cw', 'Повторить'), b('remove', 'x', 'Убрать из списка')];
  }
  function dlRow(r) {
    const pct = r.state === 'progressing' && r.total > 0 ? Math.min(100, (r.received / r.total) * 100) : null;
    return h('div.ux-dl-row' + (r.state === 'completed' ? '.done' : '') + (r.state === 'cancelled' || r.state === 'interrupted' ? '.failed' : ''), { dataset: { id: r.id }, title: r.path || r.url },
      fileTile(r.filename),
      h('span.ux-dl-body',
        h('span.ux-dl-name', r.filename || 'Файл'),
        r.state === 'progressing' ? h('span.ux-dl-bar' + (pct == null ? '.indet' : ''), h('span', { style: pct == null ? null : { width: pct.toFixed(1) + '%' } })) : null,
        h('span.ux-dl-status', dlStatus(r))),
      h('span.ux-dl-acts', dlActions(r)));
  }
  function dlAction(api, id, act) {
    const ch = { pause: 'pause', resume: 'resume', cancel: 'cancel', show: 'show', remove: 'remove', retry: 'retry' }[act];
    if (!ch) return;
    api.invoke('kosmo:downloads.' + ch, { id }).catch((e) => showRowErr(api, id, cleanErr(e)));
  }
  function showRowErr(api, id, text) {
    const row = api.root.querySelector('.ux-dl-row[data-id="' + CSS.escape(id) + '"] .ux-dl-status');
    if (row) { row.textContent = text; row.classList.add('err'); }
  }

  O.register('downloads', {
    width: 380, className: 'ux-dlp',
    render(root, data, api) {
      const st = api._st = { items: new Map(), timer: 0, hover: false };
      for (const r of (data && data.items) || []) st.items.set(r.id, r);
      const all = h('button.k-btn.k-btn-ghost.k-btn-sm', { type: 'button' }, 'Все загрузки');
      all.addEventListener('click', () => { api.invoke('kosmo:commands.run', { id: 'downloads.open' }).catch(warn); api.close(); });
      st.list = h('div.ux-dl-list.ov-scroll');
      root.append(O.ui.header('Загрузки', api, all), st.list);
      st.list.addEventListener('click', (e) => {
        const row = e.target.closest('.ux-dl-row');
        if (!row) return;
        const id = row.dataset.id;
        const btn = e.target.closest('button[data-act]');
        if (btn) { dlAction(api, id, btn.dataset.act); return; }
        const r = st.items.get(id);
        if (r && r.state === 'completed') api.invoke('kosmo:downloads.open', { id }).then(() => api.close()).catch((err) => showRowErr(api, id, cleanErr(err)));
      });
      api.on('kosmo:downloads.changed', (p) => {
        if (!p) return;
        let unseen = false;
        for (const r of p.items || []) { st.items.set(r.id, r); if (r.unseen) unseen = true; }
        for (const id of p.removed || []) st.items.delete(id);
        renderDownloads(api);
        // загрузка завершилась, пока окно открыто, — значит, её уже видели
        if (unseen) api.invoke('kosmo:downloads.markSeen', {}).catch(warn);
      });
      // автопоказ при старте загрузки: закрыть через несколько секунд, если не навели мышь
      if (data && data.auto) {
        root.addEventListener('pointerenter', () => { st.hover = true; clearTimeout(st.timer); });
        st.timer = setTimeout(() => { if (!st.hover) api.close(); }, 6000);
      }
      renderDownloads(api);
    },
    update(data, api) {
      const st = api._st;
      for (const r of (data && data.items) || []) st.items.set(r.id, r);
      renderDownloads(api);
    },
    onHide(api) { if (api._st) clearTimeout(api._st.timer); },
  });
  function renderDownloads(api) {
    const st = api._st;
    const list = Array.from(st.items.values()).sort((a, b) => b.startTime - a.startTime).slice(0, 20);
    U.clear(st.list);
    if (!list.length) { st.list.appendChild(U.empty({ icon: 'download', title: 'Загрузок пока нет', text: 'Скачанные файлы появятся здесь.' })); return; }
    for (const r of list) st.list.appendChild(dlRow(r));
  }
})();
