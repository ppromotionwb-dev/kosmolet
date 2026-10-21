// Владелец: ux-chrome. Подсказки адресной строки (overlay 'omnibox'), звезда закладки, полоса закладок, кнопка загрузок.
// API core: window.KChrome (omnibox.onInput/onKey/onBlur, addOmniboxIcon, addToolbarButton, addBar, openOverlay, toggleOverlay).
'use strict';
(function () {
  const K = window.KChrome;
  const U = window.KUI;
  if (!K || !U) return;
  const { h, invoke, on } = U;

  // свои стили; полосу закладок показываем, когда стили загрузились (без вспышки)
  let cssReady = false;
  const cssLink = h('link', { rel: 'stylesheet', href: 'features/ux-chrome.css' });
  cssLink.addEventListener('load', () => { cssReady = true; renderBarVisibility(); });
  cssLink.addEventListener('error', () => { cssReady = true; renderBarVisibility(); });
  document.head.appendChild(cssLink);

  window.KIcons.add('app-window', '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M10 4v4"/><path d="M2 8h20"/><path d="M6 4v4"/>');
  window.KIcons.add('chevrons-right', '<path d="m6 17 5-5-5-5"/><path d="m13 17 5-5-5-5"/>');

  const isWeb = (u) => /^(https?|file):/i.test(String(u || ''));
  function urlKey(u) {
    let s = String(u || '').trim();
    try { const x = new URL(s); x.hash = ''; s = x.href; } catch (e) { s = s.replace(/#.*$/, ''); }
    return s.replace(/\/+$/, '');
  }
  function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }
  const warn = (e) => console.warn('[ux-chrome]', e && e.message ? e.message : e);

  // =====================================================================
  // Подсказки адресной строки
  // =====================================================================
  const omni = K.omnibox;
  const sug = { seq: 0, open: false, items: [], forInput: null, sel: 0, typed: '', inline: null, blurTimer: 0 };

  function anchorRect() { return omni.rect(); }

  function closeSug(reason) {
    clearTimeout(sug.blurTimer);
    const was = sug.open;
    sug.open = false;
    sug.items = [];
    sug.forInput = null;
    sug.seq++;
    if (was && K.state.overlay && K.state.overlay.open && K.state.overlay.type === 'omnibox') K.closeOverlay();
    if (reason !== 'keep-inline') sug.inline = null;
  }

  function showSug() {
    const r = anchorRect();
    const data = { items: sug.items, sel: sug.sel, width: r.w, typed: sug.typed };
    const ov = K.state.overlay || {};
    if (sug.open && ov.open && ov.type === 'omnibox') {
      invoke('kosmo:overlay.update', { type: 'omnibox', data }).catch(warn);
    } else {
      sug.open = true;
      K.openOverlay('omnibox', data, r, { focus: false }).catch(warn);
    }
  }

  function setInline(typed, text, url) {
    const el = omni.el;
    const full = typed + text.slice(typed.length);
    el.value = full;
    try { el.setSelectionRange(typed.length, full.length, 'forward'); } catch (e) { /* ignore */ }
    sug.inline = { text: full, url, typed };
  }

  function query(value, allowInline) {
    const seq = ++sug.seq;
    sug.typed = value;
    if (!value.trim()) { closeSug(); return; }
    invoke('kosmo:ux.suggest', { input: value, inline: !!allowInline }).then((res) => {
      if (seq !== sug.seq || !omni.isFocused() || sug.typed !== value || !res) return;
      const items = Array.isArray(res.items) ? res.items : [];
      if (!items.length) { closeSug('keep-inline'); return; }
      if (allowInline && res.inline && res.inline.text && res.inline.text.toLowerCase().startsWith(value.toLowerCase())) {
        const el = omni.el;
        // пользователь мог успеть дописать — тогда значение уже другое
        if (el.value === value || (sug.inline && el.value === sug.inline.text)) setInline(value, res.inline.text, res.inline.url);
      } else if (sug.inline && !res.inline) {
        // дополнение больше не подходит — убрать хвост
        const el = omni.el;
        if (el.value === sug.inline.text) { el.value = value; el.setSelectionRange(value.length, value.length); }
        sug.inline = null;
      }
      sug.items = items;
      sug.forInput = value;
      sug.sel = 0;
      showSug();
    }).catch(warn);
  }

  // текст адресной строки для текущей страницы (как core показывает его при фокусе)
  function pageText() {
    const a = K.activeTab();
    return a && a.url && !/^kosmo:\/\/newtab\/?(index\.html)?([?#].*)?$/i.test(a.url) ? U.readableUrl(a.url) : '';
  }

  omni.onInput((value, e) => {
    clearTimeout(sug.blurTimer);
    if (!omni.isFocused()) return;
    // revert() core (второй Esc, переход на вкладку) возвращает адрес страницы — это не ввод
    if (!e && value === pageText()) { closeSug(); return; }
    const el = omni.el;
    const typing = !!(e && e.inputType && e.inputType.indexOf('insert') === 0 && !e.isComposing);
    const atEnd = el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
    const allowInline = typing && atEnd;
    // «липкое» дополнение: следующая буква совпала с хвостом — дописываем сразу, без ожидания ответа
    if (allowInline && sug.inline && value.length < sug.inline.text.length && sug.inline.text.toLowerCase().startsWith(value.toLowerCase())) {
      setInline(value, sug.inline.text, sug.inline.url);
    } else {
      sug.inline = null;
    }
    query(value, allowInline);
  });

  function restoreTyped() {
    const t = sug.typed;
    omni.setValue(t, { silent: true, select: false });
    if (sug.inline && sug.inline.typed === t) setInline(t, sug.inline.text, sug.inline.url);
  }

  function move(d) {
    const n = sug.items.length;
    if (!n) return;
    sug.sel = (sug.sel + d + n) % n;
    const it = sug.items[sug.sel];
    if (sug.sel === 0) restoreTyped();
    else omni.setValue(it.fill || it.title || '', { silent: true, select: false });
    K.overlayEvent('omnibox', 'select', sug.sel);
  }

  function pick(i, opts) {
    opts = opts || {};
    const it = sug.items[i];
    if (!it) return;
    if (it.type === 'bangkey' && it.insert) {
      if (!omni.isFocused()) omni.focus({ select: false });
      omni.setValue(it.insert, { select: false });
      return;
    }
    closeSug();
    if (it.type === 'tab' && it.tabId != null && !opts.newTab) {
      omni.revert();
      omni.blur(false);
      K.activateTab(it.tabId);
      return;
    }
    const target = it.url || it.fill || it.title;
    if (!target) return;
    omni.navigate(target, { newTab: !!opts.newTab, background: !!opts.background });
  }

  function removeRow(i) {
    const it = sug.items[i];
    if (!it || !it.removable || !it.url) return;
    invoke('kosmo:history.remove', { url: it.url }).then(() => {
      if (!omni.isFocused()) return;
      sug.items.splice(i, 1);
      if (sug.sel >= sug.items.length) sug.sel = Math.max(0, sug.items.length - 1);
      if (sug.sel === 0) restoreTyped();
      // перезапросить — на место удалённой может прийти другая
      query(sug.typed, false);
    }).catch(warn);
  }

  omni.onKey((e) => {
    if (e.isComposing) return false;
    const hasList = sug.open && sug.items.length > 0;
    if (!hasList) {
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && omni.getValue().trim()) {
        e.preventDefault();
        query(sug.inline ? sug.inline.typed : omni.getValue(), false);
        return true;
      }
      return false;
    }
    const fresh = sug.forInput === sug.typed;
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); move(1); return true;
      case 'ArrowUp': e.preventDefault(); move(-1); return true;
      case 'PageDown': e.preventDefault(); move(sug.items.length - 1 - sug.sel); return true;
      case 'PageUp': e.preventDefault(); move(-sug.sel); return true;
      case 'Tab': {
        if (e.ctrlKey || e.altKey || e.metaKey) return false;
        e.preventDefault();
        const it = sug.items[sug.sel];
        if (!e.shiftKey && it && it.type === 'bangkey' && it.insert) { omni.setValue(it.insert, { select: false }); return true; }
        // «wb» + Tab — поиск по сайту, даже если строка бэнга не выделена (как ключевые слова в Chrome)
        if (!e.shiftKey && sug.sel === 0) {
          const typed = sug.typed.trim().toLowerCase();
          const bk = sug.items.find((x) => x.type === 'bangkey' && x.insert && String(x.bang || '').toLowerCase() === typed.replace(/^!/, ''));
          if (bk) { omni.setValue(bk.insert, { select: false }); return true; }
        }
        if (!e.shiftKey && sug.sel === 0 && sug.inline && omni.el.value === sug.inline.text && omni.el.selectionStart < omni.el.value.length) {
          // принять дополнение
          const full = sug.inline.text;
          sug.inline = null;
          omni.setValue(full, { select: false });
          return true;
        }
        move(e.shiftKey ? -1 : 1);
        return true;
      }
      case 'Enter': {
        if (!fresh) { closeSug('keep-inline'); return false; }
        if (e.ctrlKey) {
          // Ctrl+Enter — «www.…com» от core: без нашего хвоста
          if (sug.inline) { omni.setValue(sug.inline.typed, { silent: true, select: false }); }
          closeSug();
          return false;
        }
        e.preventDefault();
        pick(sug.sel, { newTab: e.altKey });
        return true;
      }
      case 'Escape': {
        e.preventDefault();
        if (sug.sel !== 0 || sug.inline) { omni.setValue(sug.typed, { silent: true, select: false }); }
        closeSug();
        return true;
      }
      case 'Delete': {
        if (!e.shiftKey) return false;
        const it = sug.items[sug.sel];
        if (it && it.removable) { e.preventDefault(); removeRow(sug.sel); return true; }
        return false;
      }
      default: return false;
    }
  });

  omni.onBlur(() => {
    clearTimeout(sug.blurTimer);
    // клик по строке в overlay забирает фокус у адресной строки — ждём событие pick
    sug.blurTimer = setTimeout(() => { if (!omni.isFocused()) closeSug(); }, 300);
  });
  omni.onFocus(() => clearTimeout(sug.blurTimer));

  K.onOverlay('omnibox', (name, data) => {
    data = data || {};
    if (name === 'pick') { clearTimeout(sug.blurTimer); pick(Number(data.index), { newTab: !!data.newTab, background: !!data.background }); }
    else if (name === 'remove') { clearTimeout(sug.blurTimer); if (!omni.isFocused()) omni.focus({ select: false }); removeRow(Number(data.index)); }
  });
  K.on('overlay-state', (s) => { if (!s || !s.open || s.type !== 'omnibox') sug.open = false; });
  K.on('overlay-closed', (type) => { if (type === 'omnibox') { sug.open = false; } });
  K.on('active', () => { closeSug(); setTimeout(focusIfNewtab, 0); });

  // На новой вкладке фокус — в адресной строке (core ставит его по Ctrl+T и «+»; здесь — переход на уже открытую
  // новую вкладку, закрытие вкладки и старт с новой вкладкой).
  function focusIfNewtab() {
    const a = K.activeTab();
    const ov = K.state.overlay || {};
    if (!a || !/^kosmo:\/\/newtab\/?(index\.html)?([?#].*)?$/i.test(a.url || '') || omni.isFocused() || (ov.open && ov.type !== 'omnibox')) return;
    omni.focus({ select: true });
  }

  // =====================================================================
  // Закладки: данные
  // =====================================================================
  let bookmarks = [];
  const bmByKey = new Map();
  function setBookmarks(list) {
    bookmarks = Array.isArray(list) ? list : [];
    bmByKey.clear();
    for (const b of bookmarks) if (!bmByKey.has(urlKey(b.url))) bmByKey.set(urlKey(b.url), b);
    renderStar();
    renderBar();
  }
  const findBm = (url) => bmByKey.get(urlKey(url)) || null;
  const bmById = (id) => bookmarks.find((b) => b.id === id) || null;
  on('kosmo:bookmarks.changed', (p) => { if (p && Array.isArray(p.items)) setBookmarks(p.items); });

  // =====================================================================
  // Звезда в адресной строке
  // =====================================================================
  const star = K.addOmniboxIcon({ id: 'ux-star', icon: 'star', title: 'Добавить в закладки (Ctrl+D)', order: 800, hidden: true, onClick: () => starClick() });
  let starKey = '';
  function renderStar() {
    const a = K.activeTab();
    const url = a && a.url;
    const can = !!(url && isWeb(url) && !(a && a.error));
    const b = can ? findBm(url) : null;
    const key = (can ? 1 : 0) + '|' + (b ? b.id : '');
    if (key === starKey) return;
    starKey = key;
    star.setVisible(can);
    star.setIcon(b ? 'star-filled' : 'star');
    star.el.classList.toggle('ux-starred', !!b);
    star.setTitle(b ? 'Изменить закладку (Ctrl+D)' : 'Добавить в закладки (Ctrl+D)');
  }
  function starClick() {
    const a = K.activeTab();
    if (!a || !isWeb(a.url)) return;
    const ov = K.state.overlay || {};
    if (ov.open && ov.type === 'bookmark-edit') { K.closeOverlay(); return; }
    const b = findBm(a.url);
    if (b) { K.toggleOverlay('bookmark-edit', { bookmark: b }, star.el, { align: 'end' }); return; }
    invoke('kosmo:bookmarks.add', { url: a.url, title: a.title, folder: 'bar', favicon: /^https?:/i.test(a.favicon || '') ? a.favicon : undefined }).then((nb) => {
      if (!nb) return;
      if (!findBm(nb.url)) setBookmarks(bookmarks.concat([nb]));
      K.openOverlay('bookmark-edit', { bookmark: nb, added: true }, star.el, { align: 'end' }).catch(warn);
    }).catch(warn);
  }

  // =====================================================================
  // Полоса закладок
  // =====================================================================
  const itemsEl = h('div.ux-bm-items');
  const moreBtn = h('button.ux-bm-btn.ux-bm-more', { tabindex: '-1', title: 'Остальные закладки', hidden: true, html: window.KIcons.get('chevrons-right', 14) });
  const otherBtn = h('button.ux-bm-btn.ux-bm-other', { tabindex: '-1', title: 'Другие закладки', hidden: true }, U.icon('folder', 14), h('span', 'Другие'));
  const emptyEl = h('div.ux-bm-empty', 'Нажмите на звезду в адресной строке, чтобы добавить закладку сюда');
  const barEl = h('div.ux-bm-bar', { role: 'toolbar', 'aria-label': 'Закладки' }, itemsEl, emptyEl, moreBtn, otherBtn);
  const bar = K.addBar({ id: 'bookmarks', el: barEl, order: 10, hidden: true });
  let hiddenIds = [];

  function renderBarVisibility() {
    const s = K.state.settings;
    const want = !(s && s.ui && s.ui.showBookmarksBar === false);
    if (!cssReady || !s) { if (bar.isVisible()) bar.hide(); return; }
    if (want !== bar.isVisible()) bar.toggle(want);
    if (want) layoutBar();
  }

  function letterTile(b) {
    const t = (b.title || hostOf(b.url) || '?').trim();
    const ch = (t.match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase();
    return h('span.ux-bm-letter', ch);
  }
  function iconFor(b) {
    if (!b.favicon) return letterTile(b);
    const box = h('span.ux-bm-ic');
    const img = h('img', { alt: '', draggable: 'false', decoding: 'async', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => { box.replaceWith(letterTile(b)); }, { once: true });
    img.src = b.favicon;
    box.appendChild(img);
    return box;
  }

  let barSig = '';
  function renderBar() {
    const barItems = bookmarks.filter((b) => b.folder === 'bar');
    const other = bookmarks.filter((b) => b.folder === 'other');
    const sig = JSON.stringify(barItems.map((b) => [b.id, b.title, b.favicon, b.url])) + '|' + other.length;
    if (sig === barSig) return;
    barSig = sig;
    U.clear(itemsEl);
    for (const b of barItems) {
      const el = h('button.ux-bm-item', { tabindex: '-1', title: (b.title || '') + '\n' + b.url, dataset: { id: b.id } },
        iconFor(b), h('span.ux-bm-title', b.title || hostOf(b.url)));
      itemsEl.appendChild(el);
    }
    emptyEl.hidden = barItems.length > 0;
    otherBtn.hidden = other.length === 0;
    layoutBar();
  }

  function layoutBar() {
    if (!bar.isVisible()) return;
    const kids = Array.from(itemsEl.children);
    for (const k of kids) k.hidden = false;
    moreBtn.hidden = true;
    const avail = itemsEl.clientWidth;
    hiddenIds = [];
    if (!avail) return;
    let over = false;
    for (const k of kids) {
      if (!over && k.offsetLeft + k.offsetWidth > avail) over = true;
      if (over) { k.hidden = true; hiddenIds.push(k.dataset.id); }
    }
    moreBtn.hidden = !hiddenIds.length;
    // кнопка «»» сама занимает место — проверим ещё раз
    if (hiddenIds.length) {
      const avail2 = itemsEl.clientWidth;
      for (let i = kids.length - 1; i >= 0; i--) {
        const k = kids[i];
        if (k.hidden) continue;
        if (k.offsetLeft + k.offsetWidth > avail2) { k.hidden = true; hiddenIds.unshift(k.dataset.id); } else break;
      }
    }
  }
  const layoutSoon = U.rafThrottle(layoutBar);
  new ResizeObserver(layoutSoon).observe(barEl);
  window.addEventListener('resize', () => setTimeout(layoutBar, 0));

  function openBm(b, mode) {
    if (!b) return;
    if (mode === 'bg') invoke('kosmo:tabs.create', { url: b.url, background: true }).catch(warn);
    else if (mode === 'new') invoke('kosmo:tabs.create', { url: b.url, active: true }).catch(warn);
    else omni.navigate(b.url);
  }

  let suppressClick = false;
  itemsEl.addEventListener('click', (e) => {
    const el = e.target.closest('.ux-bm-item');
    if (!el || suppressClick) return;
    openBm(bmById(el.dataset.id), e.ctrlKey || e.metaKey ? 'bg' : e.shiftKey ? 'new' : 'cur');
  });
  itemsEl.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    const el = e.target.closest('.ux-bm-item');
    if (el) { e.preventDefault(); openBm(bmById(el.dataset.id), 'bg'); }
  });
  itemsEl.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
  barEl.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const el = e.target.closest('.ux-bm-item');
    const b = el && bmById(el.dataset.id);
    if (!b) return;
    K.openOverlay('bm-menu', { bookmark: b }, K.rectOf(el), { align: 'start' }).catch(warn);
  });
  moreBtn.addEventListener('click', () => {
    const items = hiddenIds.map(bmById).filter(Boolean);
    K.toggleOverlay('bm-folder', { title: 'Ещё на полосе', folder: 'bar', ids: hiddenIds.slice(), items }, moreBtn, { align: 'end' });
  });
  otherBtn.addEventListener('click', () => {
    K.toggleOverlay('bm-folder', { title: 'Другие закладки', folder: 'other', items: bookmarks.filter((b) => b.folder === 'other') }, otherBtn, { align: 'end' });
  });

  // перетаскивание: перестановка на полосе, бросок на «Другие» — перенос в папку
  let drag = null;
  itemsEl.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.ux-bm-item');
    if (!el || e.button !== 0) return;
    drag = { id: el.dataset.id, el, x: e.clientX, pid: e.pointerId, started: false, toOther: false };
  });
  itemsEl.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pid) return;
    if (!drag.started) {
      if (Math.abs(e.clientX - drag.x) < 5) return;
      drag.started = true;
      // захват на контейнере: перестановка самого элемента в DOM сняла бы захват с него
      try { itemsEl.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      drag.el.classList.add('dragging');
      barEl.classList.add('dragging');
    }
    const ob = otherBtn.getBoundingClientRect();
    drag.toOther = !otherBtn.hidden && e.clientX >= ob.left && e.clientX <= ob.right;
    otherBtn.classList.toggle('drop', drag.toOther);
    if (drag.toOther) return;
    const kids = Array.from(itemsEl.children).filter((k) => !k.hidden && k !== drag.el);
    let before = null;
    for (const k of kids) {
      const r = k.getBoundingClientRect();
      if (e.clientX < r.left + r.width / 2) { before = k; break; }
    }
    if (before) { if (drag.el.nextSibling !== before) itemsEl.insertBefore(drag.el, before); }
    else {
      const lastVisible = kids[kids.length - 1];
      const after = lastVisible ? lastVisible.nextSibling : null;
      if (drag.el !== (lastVisible ? lastVisible.nextSibling : itemsEl.firstChild)) itemsEl.insertBefore(drag.el, after);
    }
  });
  function endDrag(commit) {
    const d = drag;
    drag = null;
    if (!d || !d.started) return;
    d.el.classList.remove('dragging');
    barEl.classList.remove('dragging');
    otherBtn.classList.remove('drop');
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    if (!commit) { barSig = ''; renderBar(); return; }
    if (d.toOther) { invoke('kosmo:bookmarks.move', { id: d.id, index: 1e9, folder: 'other' }).catch(warn); return; }
    const index = Array.from(itemsEl.children).indexOf(d.el);
    invoke('kosmo:bookmarks.move', { id: d.id, index, folder: 'bar' }).catch((e) => { warn(e); barSig = ''; renderBar(); });
  }
  itemsEl.addEventListener('pointerup', (e) => { if (drag && e.pointerId === drag.pid) endDrag(true); });
  itemsEl.addEventListener('pointercancel', () => endDrag(false));
  itemsEl.addEventListener('lostpointercapture', () => { if (drag && drag.started) endDrag(true); });

  // =====================================================================
  // Загрузки: кнопка с кольцом прогресса
  // =====================================================================
  const downloads = new Map(); // id → запись
  let dlSummary = { active: 0, sessionCount: 0, unseen: 0, progress: null };
  const dlBtn = K.addToolbarButton({ id: 'ux-downloads', icon: 'download', title: 'Загрузки (Ctrl+J — все)', order: 300, hidden: true, onClick: () => openDownloads(false) });
  dlBtn.el.classList.add('ux-dl-btn');

  const R = 10;
  const C = 2 * Math.PI * R;
  function ringSvg(p) {
    const arrow = '<path d="M12 7.5v7"/><path d="m9 11.8 3 3 3-3"/>';
    const track = '<circle class="ux-ring-track" cx="12" cy="12" r="' + R + '" stroke-width="2"/>';
    let val;
    if (p == null) val = '<circle class="ux-ring-val ux-ring-spin" cx="12" cy="12" r="' + R + '" stroke-width="2" stroke-dasharray="' + (C * 0.28).toFixed(2) + ' ' + C.toFixed(2) + '"/>';
    else val = '<circle class="ux-ring-val" cx="12" cy="12" r="' + R + '" stroke-width="2" stroke-dasharray="' + C.toFixed(2) + '" stroke-dashoffset="' + (C * (1 - Math.max(0.02, p))).toFixed(2) + '" transform="rotate(-90 12 12)"/>';
    return '<svg class="k-ic" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + track + val + arrow + '</svg>';
  }
  let dlKey = '';
  function renderDl() {
    const s = dlSummary;
    const visible = s.sessionCount > 0 || s.active > 0;
    const active = s.active > 0;
    const pct = active && s.progress != null ? Math.round(s.progress * 50) / 50 : null;
    const key = [visible, active, pct, s.unseen > 0].join('|');
    if (key === dlKey) return;
    dlKey = key;
    dlBtn.setVisible(visible);
    dlBtn.setIcon(active ? ringSvg(pct) : 'download');
    dlBtn.el.classList.toggle('active', active);
    dlBtn.setBadge(!active && s.unseen > 0 ? '' : null);
    dlBtn.setTitle(active ? (s.active === 1 ? 'Идёт загрузка' : 'Идут загрузки: ' + s.active) + (pct != null ? ', ' + Math.round(pct * 100) + '%' : '') : 'Загрузки');
  }
  function mergeDl(p) {
    if (!p) return;
    if (Array.isArray(p.items)) for (const it of p.items) downloads.set(it.id, it);
    if (Array.isArray(p.removed)) for (const id of p.removed) downloads.delete(id);
    if (p.summary) dlSummary = p.summary;
    renderDl();
  }
  function dlList() {
    return Array.from(downloads.values()).sort((a, b) => b.startTime - a.startTime);
  }
  function openDownloads(auto) {
    const ov = K.state.overlay || {};
    if (auto) {
      if (ov.open) return;
      K.openOverlay('downloads', { items: dlList().slice(0, 30), auto: true }, dlBtn.el, { align: 'end', focus: false }).catch(warn);
    } else {
      K.toggleOverlay('downloads', { items: dlList().slice(0, 30) }, dlBtn.el, { align: 'end' });
    }
    if (dlSummary.unseen) invoke('kosmo:downloads.markSeen', {}).catch(warn);
  }
  on('kosmo:downloads.changed', (p) => {
    mergeDl(p);
    if (p && p.started) setTimeout(() => openDownloads(true), 30);
  });

  // =====================================================================
  // Подписки и старт
  // =====================================================================
  K.on('state', () => renderStar());
  K.on('settings', (s, path) => {
    if (!path || path === 'ui' || String(path).indexOf('ui.showBookmarksBar') === 0 || path === '') renderBarVisibility();
  });
  K.on('command', (name) => {
    if (name === 'ux.star') starClick();
    else if (name === 'ux.downloads') openDownloads(false);
  });

  Promise.resolve(K.ready).then(() => {
    renderBarVisibility();
    setTimeout(focusIfNewtab, 0);
    invoke('kosmo:bookmarks.list', {}).then(setBookmarks).catch(warn);
    invoke('kosmo:downloads.list', {}).then((r) => {
      if (!r) return;
      for (const it of r.items || []) downloads.set(it.id, it);
      dlSummary = r.summary || dlSummary;
      renderDl();
    }).catch(warn);
  });
  renderStar();
})();
