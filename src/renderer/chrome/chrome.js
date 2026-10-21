// Космолёт — верх окна: вкладки, навигация, адресная строка, слоты для фич (window.KChrome). Владелец: core.
// Состояние приходит из main (kosmo:tabs.state); DOM вкладок обновляется точечно по id, без пересоздания.
'use strict';
(function () {
  const U = window.KUI;
  const { h, invoke, fire, send, on, parseUrl, readableUrl, esc, clamp, emitter, rafThrottle } = U;
  const svg = (name, size) => window.KIcons.get(name, size || 16);
  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const bus = emitter();

  const TAB_MIN = 36, TAB_MAX = 220, NARROW = 96, TINY = 58, CLAUDE_GLOW_MS = 3000;
  const NEWTAB_RE = /^kosmo:\/\/newtab\/?(index\.html)?([?#].*)?$/i;

  // ---------- состояние ----------
  const state = {
    tabs: [], activeId: null, settings: null,
    layout: { panelOpen: false, panelWidth: 460, panelTool: null, fullscreen: false, maximized: false },
    overlay: { open: false, type: null, modal: false },
    get active() { return infoById.get(this.activeId) || null; }
  };
  const infoById = new Map();
  const chromeEl = $('chrome');
  let lastH = '';        // последняя отправленная высота chrome
  let measureTimer = 0;

  // ---------- вкладки ----------
  const tabsEl = $('tabs');
  const tabbarEl = $('tabbar');
  const newTabBtn = $('new-tab');
  newTabBtn.innerHTML = svg('plus');
  const views = new Map(); // id → view
  let freezeWidth = false;   // после закрытия мышью ширина держится, пока курсор над полосой
  let orderLock = null;      // {id, index, until} — не дёргать порядок, пока main не применил move
  let drag = null;

  function idOf(el) { const t = el && el.closest('.tab'); return t ? t.dataset.id : null; }
  function sameId(a, b) { return a != null && b != null && String(a) === String(b); }
  function realId(strId) { const v = views.get(String(strId)); return v ? v.info.id : strId; }

  function createView(info) {
    const iconEl = h('span.tab-icon');
    const titleEl = h('span.tab-title');
    const badgesEl = h('span.tab-badges');
    const audioEl = h('button.tab-btn.tab-audio', { tabindex: '-1', hidden: true });
    const closeEl = h('button.tab-btn.tab-close', { tabindex: '-1', title: 'Закрыть (Ctrl+W)', 'aria-label': 'Закрыть вкладку', html: svg('x', 14) });
    const el = h('div.tab.entering', { role: 'tab', dataset: { id: String(info.id) } },
      h('div.tab-bg'), h('div.tab-glow'), h('div.tab-stripe'), h('div.tab-sep'),
      h('div.tab-content', iconEl, titleEl, badgesEl, audioEl, closeEl));
    el.addEventListener('animationend', () => el.classList.remove('entering'), { once: true });
    const v = { id: String(info.id), el, iconEl, titleEl, badgesEl, audioEl, closeEl, p: {}, info, glowTimer: 0 };
    audioEl.addEventListener('click', (e) => { e.stopPropagation(); invoke('kosmo:tabs.mute', { id: v.info.id, muted: !v.info.muted }).catch(warn); });
    closeEl.addEventListener('click', (e) => { e.stopPropagation(); closeTab(v.info.id, true); });
    views.set(v.id, v);
    return v;
  }

  function tabTitle(info) {
    if (info.title) return info.title;
    if (!info.url || NEWTAB_RE.test(info.url)) return 'Новая вкладка';
    const p = parseUrl(info.url);
    return p.hostU || info.url;
  }

  function iconKey(info) {
    if (info.crashed) return 'crashed';
    if (info.loading && !info.discarded) return 'loading';
    if (info.favicon) return 'fav:' + info.favicon;
    if (info.url && /^kosmo:/i.test(info.url)) return 'internal';
    return 'globe';
  }

  function renderIcon(v, key) {
    const box = v.iconEl;
    U.clear(box);
    if (key === 'loading') box.appendChild(h('span.k-spinner'));
    else if (key === 'crashed') box.innerHTML = svg('alert-triangle');
    else if (key === 'internal') box.innerHTML = svg('orbit');
    else if (key === 'globe') box.innerHTML = svg('globe');
    else {
      const img = h('img', { alt: '', draggable: 'false', decoding: 'async', referrerpolicy: 'no-referrer' });
      img.addEventListener('error', () => { if (v.p.icon === key) { box.innerHTML = svg('globe'); } }, { once: true });
      img.src = key.slice(4);
      box.appendChild(img);
    }
  }

  function renderBadges(v, badges) {
    U.clear(v.badgesEl);
    if (!badges || typeof badges !== 'object') return;
    for (const k of Object.keys(badges)) {
      let b = badges[k];
      if (b === null || b === undefined || b === false || b === '' || b === 0) continue;
      if (typeof b !== 'object') b = b === true ? { dot: true } : { text: String(b) };
      const el = h('span.tab-badge' + (b.dot ? '.dot' : ''), {
        title: b.title || null, dataset: b.tone ? { tone: b.tone } : null, html: b.icon ? svg(b.icon, 10) : null
      });
      if (b.text != null && !b.dot) el.appendChild(document.createTextNode(String(b.text).slice(0, 6)));
      v.badgesEl.appendChild(el);
    }
  }

  function updateView(v, info) {
    const p = v.p, el = v.el;
    v.info = info;
    const set = (k, val, fn) => { if (p[k] !== val) { p[k] = val; fn(val); } };
    set('pinned', !!info.pinned, (x) => el.classList.toggle('pinned', x));
    set('discarded', !!info.discarded, (x) => el.classList.toggle('discarded', x));
    set('crashed', !!info.crashed, (x) => el.classList.toggle('crashed', x));
    set('title', tabTitle(info), (x) => { v.titleEl.textContent = x; });
    set('tip', tabTitle(info) + (info.url && !NEWTAB_RE.test(info.url) ? '\n' + readableUrl(info.url) : '') + (info.crashed ? '\nВкладка упала' : ''), (x) => { el.title = x; });
    set('icon', iconKey(info), (x) => renderIcon(v, x));
    const color = info.containerId && info.containerId !== 'main' && info.containerColor ? info.containerColor : '';
    set('color', color, (x) => { if (x) el.style.setProperty('--tab-color', x); else el.style.removeProperty('--tab-color'); });
    const audio = info.muted ? 'muted' : info.audible ? 'on' : '';
    set('audio', audio, (x) => {
      v.audioEl.hidden = !x;
      v.audioEl.classList.toggle('muted', x === 'muted');
      v.audioEl.innerHTML = svg(x === 'muted' ? 'volume-x' : 'volume', 14);
      v.audioEl.title = x === 'muted' ? 'Включить звук' : 'Выключить звук';
    });
    let bk = '';
    try { bk = info.badges ? JSON.stringify(info.badges) : ''; } catch (e) { bk = ''; }
    set('badges', bk, () => renderBadges(v, info.badges));
    set('claudeAt', info.claudeActiveAt || 0, (at) => {
      clearTimeout(v.glowTimer);
      const left = at ? CLAUDE_GLOW_MS - (Date.now() - at) : 0;
      el.classList.toggle('claude', left > 0);
      if (left > 0) v.glowTimer = setTimeout(() => el.classList.remove('claude'), left);
    });
  }

  function reconcile() {
    const seen = new Set();
    let prevEl = null;
    const lockActive = orderLock && Date.now() < orderLock.until;
    if (orderLock && !lockActive) orderLock = null;
    let pinnedCount = 0;
    const wanted = [];
    for (const info of state.tabs) {
      const id = String(info.id);
      seen.add(id);
      let v = views.get(id);
      if (!v) v = createView(info);
      updateView(v, info);
      if (info.pinned) pinnedCount++;
      wanted.push(v);
    }
    // удалённые
    for (const [id, v] of views) {
      if (!seen.has(id)) { clearTimeout(v.glowTimer); v.el.remove(); views.delete(id); }
    }
    // порядок: минимальные перестановки; во время перетаскивания и до подтверждения move — не трогаем
    const skipOrder = !!(drag && drag.started) || (lockActive && wanted.findIndex((v) => sameId(v.id, orderLock.id)) !== orderLock.index);
    if (!skipOrder) {
      if (lockActive) orderLock = null;
      for (const v of wanted) {
        const expectedNext = prevEl ? prevEl.nextSibling : tabsEl.firstChild;
        if (expectedNext !== v.el) tabsEl.insertBefore(v.el, expectedNext);
        prevEl = v.el;
      }
    } else {
      for (const v of wanted) if (!v.el.parentNode) tabsEl.appendChild(v.el);
    }
    // активная
    for (const v of wanted) {
      const act = sameId(v.id, state.activeId);
      if (v.p.active !== act) { v.p.active = act; v.el.classList.toggle('active', act); v.el.setAttribute('aria-selected', act ? 'true' : 'false'); }
    }
    const shape = wanted.length + ':' + pinnedCount;
    if (shape !== reconcile.shape) { reconcile.shape = shape; layoutTabs(); }
  }

  // ширина вкладок как в Chrome: делим доступное место, от TAB_MIN до TAB_MAX
  function layoutTabs() {
    if (freezeWidth) return;
    const cs = getComputedStyle(tabbarEl);
    const padR = parseFloat(cs.paddingRight) || 0;
    const btnW = newTabBtn.offsetWidth + 4;
    const avail = tabbarEl.clientWidth - padR - btnW - 48 /* место для перетаскивания окна */ - 16 /* поля #tabs */;
    let pinned = 0, normal = 0;
    for (const t of state.tabs) { if (t.pinned) pinned++; else normal++; }
    const pinW = parseFloat(getComputedStyle(root).getPropertyValue('--pin-w')) || 40;
    let w = TAB_MAX;
    if (normal > 0) w = clamp(Math.floor((avail - pinned * pinW) / normal), TAB_MIN, TAB_MAX);
    tabsEl.style.setProperty('--tab-w', w + 'px');
    tabsEl.classList.toggle('narrow', w < NARROW);
    tabsEl.classList.toggle('tiny', w < TINY);
    scrollActiveIntoView();
  }
  const layoutSoon = rafThrottle(layoutTabs);
  new ResizeObserver(layoutSoon).observe(tabbarEl);

  function scrollActiveIntoView() {
    const v = views.get(String(state.activeId));
    if (!v || tabsEl.scrollWidth <= tabsEl.clientWidth) return;
    const l = v.el.offsetLeft, r = l + v.el.offsetWidth;
    if (l < tabsEl.scrollLeft + 8) tabsEl.scrollLeft = l - 8;
    else if (r > tabsEl.scrollLeft + tabsEl.clientWidth - 8) tabsEl.scrollLeft = r - tabsEl.clientWidth + 8;
  }

  function activateTab(id) {
    if (!sameId(id, state.activeId)) {
      const prev = state.activeId;
      state.activeId = id;
      reconcile();
      onActiveChanged(prev);
    }
    invoke('kosmo:tabs.activate', { id }).catch(warn);
  }
  function closeTab(id, byMouse) {
    if (byMouse) { freezeWidth = true; }
    invoke('kosmo:tabs.close', { id }).catch(warn);
  }
  function newTab(opts) {
    return invoke('kosmo:tabs.create', Object.assign({ active: true }, opts || {})).then((t) => {
      if (!opts || !opts.url) omnibox.focus({ select: true });
      return t;
    }).catch(warn);
  }

  tabbarEl.addEventListener('pointerleave', () => { if (freezeWidth) { freezeWidth = false; layoutTabs(); } });
  newTabBtn.addEventListener('click', () => newTab());
  tabsEl.addEventListener('dblclick', (e) => { if (e.target === tabsEl) newTab(); });
  tabsEl.addEventListener('wheel', (e) => {
    if (tabsEl.scrollWidth <= tabsEl.clientWidth) return;
    tabsEl.scrollLeft += e.deltaY || e.deltaX;
    e.preventDefault();
  }, { passive: false });
  tabsEl.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return;
    const id = idOf(e.target);
    if (id != null) { e.preventDefault(); closeTab(realId(id), true); }
  });
  tabsEl.addEventListener('contextmenu', (e) => {
    const id = idOf(e.target);
    e.preventDefault();
    if (id != null) invoke('kosmo:tabs.contextMenu', { id: realId(id) }).catch(warn);
  });

  // ---------- перетаскивание вкладок (pointer events) ----------
  tabsEl.addEventListener('pointerdown', (e) => {
    const tabEl = e.target.closest('.tab');
    if (!tabEl) return;
    if (e.button === 1) { e.preventDefault(); return; } // без автопрокрутки
    if (e.button !== 0 || e.target.closest('.tab-btn')) return;
    const id = realId(tabEl.dataset.id);
    activateTab(id);
    drag = { id, el: tabEl, startX: e.clientX, pointerId: e.pointerId, started: false };
    try { tabEl.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  });
  tabsEl.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX;
    if (!drag.started) {
      if (Math.abs(dx) < 5) return;
      startDrag();
    }
    moveDrag(dx);
  });
  tabsEl.addEventListener('pointerup', (e) => { if (drag && e.pointerId === drag.pointerId) endDrag(true); });
  tabsEl.addEventListener('pointercancel', (e) => { if (drag && e.pointerId === drag.pointerId) endDrag(false); });
  tabsEl.addEventListener('lostpointercapture', () => { if (drag) endDrag(drag.started); });

  function startDrag() {
    const pinned = drag.el.classList.contains('pinned');
    const group = Array.from(tabsEl.children).filter((el) => el.classList.contains('pinned') === pinned);
    drag.started = true;
    drag.group = group.map((el) => ({ el, left: el.offsetLeft, width: el.offsetWidth }));
    drag.from = group.indexOf(drag.el);
    drag.to = drag.from;
    drag.offset = pinned ? 0 : Array.from(tabsEl.children).filter((el) => el.classList.contains('pinned')).length;
    drag.el.classList.add('dragging');
    for (const g of drag.group) if (g.el !== drag.el) g.el.classList.add('shifting');
  }
  function moveDrag(dx) {
    const g = drag.group, me = g[drag.from];
    const minX = g[0].left - me.left, maxX = g[g.length - 1].left + g[g.length - 1].width - (me.left + me.width);
    dx = clamp(dx, minX, maxX);
    drag.el.style.transform = 'translateX(' + dx + 'px)';
    const center = me.left + dx + me.width / 2;
    let to = 0;
    for (let i = 0; i < g.length; i++) {
      if (i === drag.from) continue;
      if (g[i].left + g[i].width / 2 < center) to++;
    }
    if (to !== drag.to) {
      drag.to = to;
      for (let i = 0; i < g.length; i++) {
        if (i === drag.from) continue;
        let shift = 0;
        if (drag.from < to && i > drag.from && i <= to) shift = -me.width;
        else if (drag.from > to && i >= to && i < drag.from) shift = me.width;
        g[i].el.style.transform = shift ? 'translateX(' + shift + 'px)' : '';
      }
    }
  }
  function endDrag(commit) {
    const d = drag;
    drag = null;
    if (!d || !d.started) return;
    for (const g of d.group) { g.el.classList.remove('shifting'); g.el.style.transform = ''; }
    d.el.classList.remove('dragging');
    if (commit && d.to !== d.from) {
      const ref = d.to > d.from ? d.group[d.to].el.nextSibling : d.group[d.to].el;
      tabsEl.insertBefore(d.el, ref);
      const index = d.offset + d.to;
      orderLock = { id: d.id, index, until: Date.now() + 600 };
      // локально тоже переставляем, чтобы следующий state не вернул старый порядок до ответа main
      const i = state.tabs.findIndex((t) => sameId(t.id, d.id));
      if (i >= 0) { const [t] = state.tabs.splice(i, 1); state.tabs.splice(index, 0, t); }
      invoke('kosmo:tabs.move', { id: d.id, index }).catch(warn);
    } else {
      reconcile();
    }
  }

  // ---------- навигация ----------
  const backBtn = $('nav-back'), fwdBtn = $('nav-forward'), reloadBtn = $('nav-reload');
  backBtn.innerHTML = svg('arrow-left');
  fwdBtn.innerHTML = svg('arrow-right');
  reloadBtn.innerHTML = svg('rotate-cw');
  backBtn.addEventListener('click', () => invoke('kosmo:tabs.back', {}).catch(warn));
  fwdBtn.addEventListener('click', () => invoke('kosmo:tabs.forward', {}).catch(warn));
  reloadBtn.addEventListener('click', (e) => {
    const a = state.active;
    if (a && a.loading && !a.crashed) invoke('kosmo:tabs.stop', {}).catch(warn);
    else invoke('kosmo:tabs.reload', { hard: e.shiftKey || e.ctrlKey }).catch(warn);
  });
  let navKey = '';
  function renderNav() {
    const a = state.active;
    const key = a ? [!!a.canGoBack, !!a.canGoForward, !!(a.loading && !a.crashed)].join() : '';
    if (key === navKey) return;
    navKey = key;
    backBtn.disabled = !(a && a.canGoBack);
    fwdBtn.disabled = !(a && a.canGoForward);
    const loading = !!(a && a.loading && !a.crashed);
    reloadBtn.innerHTML = svg(loading ? 'x' : 'rotate-cw');
    reloadBtn.title = loading ? 'Остановить (Esc)' : 'Обновить (F5), с Shift — без кэша';
    reloadBtn.setAttribute('aria-label', loading ? 'Остановить' : 'Обновить');
  }

  // ---------- адресная строка ----------
  const omni = {
    box: $('omnibox'), input: $('omni-input'), display: $('omni-display'), chip: $('omni-security'),
    field: document.querySelector('#omnibox .omni-field'),
    focused: false, editing: false, shownUrl: null, chipKey: '',
    drafts: new Map(), cbs: { input: new Set(), key: new Set(), focus: new Set(), blur: new Set() }
  };
  function callAll(set, ...args) {
    let handled = false;
    for (const cb of Array.from(set)) { try { if (cb(...args) === true) handled = true; } catch (e) { console.error('[chrome] omnibox', e); } }
    return handled;
  }
  function urlText(info) {
    if (!info || !info.url || NEWTAB_RE.test(info.url)) return '';
    return readableUrl(info.url);
  }
  function renderDisplay(info) {
    const url = info && info.url;
    if (!url || NEWTAB_RE.test(url)) { omni.display.innerHTML = ''; omni.box.classList.remove('has-display'); return; }
    const p = parseUrl(url);
    let html;
    if (p.host) {
      const scheme = p.scheme === 'https' ? '' : '<span class="s">' + esc(p.scheme) + '://</span>';
      html = scheme + '<span class="h">' + esc(p.hostU) + '</span><span class="s">' + esc(p.rest) + '</span>';
    } else {
      html = '<span class="h">' + esc(p.display) + '</span>';
    }
    omni.display.innerHTML = html;
    omni.box.classList.add('has-display');
  }
  function chipInfo(info) {
    if (!info) return { kind: 'empty', icon: 'search', title: '' };
    if (info.crashed) return { kind: 'crashed', icon: 'alert-triangle', label: 'Упала', title: 'Вкладка упала' };
    const url = info.url || '';
    if (!url || NEWTAB_RE.test(url)) return { kind: 'empty', icon: 'search', title: 'Поиск или адрес' };
    // страница не загрузилась: замок «Защищено» здесь вводил бы в заблуждение
    if (info.error) return { kind: 'error', icon: 'info', title: 'Страница не загрузилась' };
    const p = parseUrl(url);
    if (p.internal) return { kind: 'internal', icon: 'orbit', label: 'Космолёт', title: 'Внутренняя страница Космолёта' };
    if (p.scheme === 'https') return { kind: 'secure', icon: 'lock', title: 'Защищённое соединение' };
    if (p.scheme === 'http' && p.local) return { kind: 'local', icon: 'server', title: 'Локальный адрес' };
    if (p.scheme === 'http') return { kind: 'insecure', icon: 'alert-triangle', label: 'Не защищено', title: 'Соединение не защищено: данные передаются открытым текстом' };
    if (p.scheme === 'file') return { kind: 'file', icon: 'file', title: 'Локальный файл' };
    return { kind: 'other', icon: 'info', title: url.split(':')[0] };
  }
  function renderChip(info) {
    const c = chipInfo(info);
    const key = c.kind + '|' + (c.label || '');
    if (key === omni.chipKey) return;
    omni.chipKey = key;
    omni.chip.dataset.kind = c.kind;
    omni.chip.title = c.title || '';
    omni.chip.innerHTML = svg(c.icon) + (c.label ? '<span class="omni-chip-label">' + esc(c.label) + '</span>' : '');
  }
  function renderOmnibox(force) {
    const a = state.active;
    renderChip(a);
    omni.box.classList.toggle('crashed', !!(a && a.crashed));
    const url = a ? a.url || '' : '';
    if (omni.focused && !force) return;
    const draft = a ? omni.drafts.get(String(a.id)) : undefined;
    if (draft !== undefined) {
      if (omni.input.value !== draft) omni.input.value = draft;
      omni.editing = true;
      omni.box.classList.remove('has-display');
      omni.shownUrl = null;
      return;
    }
    omni.editing = false;
    if (omni.shownUrl === url && !force) return;
    omni.shownUrl = url;
    omni.input.value = urlText(a);
    renderDisplay(a);
  }

  omni.field.addEventListener('mousedown', (e) => {
    if (omni.focused || e.button !== 0) return;
    e.preventDefault(); // первый клик выделяет всё, как в Chrome
    omnibox.focus({ select: true });
  });
  omni.box.addEventListener('mousedown', (e) => {
    if (e.target === omni.box) { e.preventDefault(); omnibox.focus({ select: !omni.focused }); }
  });
  // focus/blur могут не прийти, если окно неактивно, — поэтому вход/выход идемпотентны и вызываются и напрямую
  function enterFocus() {
    if (omni.focused) return;
    omni.focused = true;
    omni.box.classList.add('focused');
    if (!omni.editing) omni.input.value = urlText(state.active);
    callAll(omni.cbs.focus);
  }
  function leaveFocus() {
    if (!omni.focused) return;
    omni.focused = false;
    omni.box.classList.remove('focused');
    omni.input.setSelectionRange(0, 0);
    omni.input.scrollLeft = 0;
    callAll(omni.cbs.blur);
    renderOmnibox(true);
  }
  omni.input.addEventListener('focus', enterFocus);
  omni.input.addEventListener('blur', leaveFocus);
  omni.input.addEventListener('input', (e) => {
    omni.editing = true;
    const a = state.active;
    if (a) omni.drafts.set(String(a.id), omni.input.value);
    callAll(omni.cbs.input, omni.input.value, e);
  });
  omni.input.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (callAll(omni.cbs.key, e) || e.defaultPrevented) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      let text = omni.input.value.trim();
      if (!text) return;
      if (e.ctrlKey && /^[\w-]+$/.test(text)) text = 'www.' + text + '.com';
      omnibox.navigate(text, { newTab: e.altKey });
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (omni.editing && omni.input.value !== urlText(state.active)) omnibox.revert();
      else omnibox.blur(true);
    }
  });
  omni.chip.addEventListener('click', () => bus.emit('security', { tab: state.active, el: omni.chip }));

  const omnibox = {
    get el() { return omni.input; },
    root: omni.box, field: omni.field, chip: omni.chip,
    onInput(cb) { omni.cbs.input.add(cb); return () => omni.cbs.input.delete(cb); },
    onKey(cb) { omni.cbs.key.add(cb); return () => omni.cbs.key.delete(cb); },
    onFocus(cb) { omni.cbs.focus.add(cb); return () => omni.cbs.focus.delete(cb); },
    onBlur(cb) { omni.cbs.blur.add(cb); return () => omni.cbs.blur.delete(cb); },
    getValue() { return omni.input.value; },
    // setValue(text, {select, edited=true, silent}) — edited: считать пользовательским вводом (сохраняется как черновик вкладки)
    setValue(text, opts) {
      opts = opts || {};
      omni.input.value = text == null ? '' : String(text);
      const edited = opts.edited !== false;
      omni.editing = edited;
      const a = state.active;
      if (a) { if (edited) omni.drafts.set(String(a.id), omni.input.value); else omni.drafts.delete(String(a.id)); }
      omni.box.classList.remove('has-display');
      if (opts.select) omni.input.select();
      else if (omni.focused) omni.input.setSelectionRange(omni.input.value.length, omni.input.value.length);
      if (!opts.silent && edited) callAll(omni.cbs.input, omni.input.value, null);
    },
    focus(opts) {
      opts = opts || {};
      omni.input.focus();
      if (document.activeElement === omni.input) enterFocus();
      if (opts.select !== false) omni.input.select();
    },
    blur(toPage) {
      omni.input.blur();
      leaveFocus();
      if (toPage) focusPage();
    },
    revert() {
      const a = state.active;
      if (a) omni.drafts.delete(String(a.id));
      omni.editing = false;
      omni.input.value = urlText(a);
      if (omni.focused) omni.input.select(); else renderOmnibox(true);
      callAll(omni.cbs.input, omni.input.value, null);
    },
    isFocused() { return omni.focused; },
    isEditing() { return omni.editing; },
    rect() { return rectOf(omni.box); },
    // navigate(input, {newTab, background}) — сырой текст: main сам решает URL/поиск/бэнг
    async navigate(text, opts) {
      opts = opts || {};
      const a = state.active;
      if (a) omni.drafts.delete(String(a.id));
      omni.editing = false;
      omni.input.blur();
      leaveFocus();
      try {
        if (opts.newTab || !a) {
          const t = await invoke('kosmo:tabs.create', { active: !opts.background });
          return await invoke('kosmo:tabs.navigate', { id: t && t.id, input: text, url: text });
        }
        const r = await invoke('kosmo:tabs.navigate', { input: text, url: text });
        if (r && r.url && !omni.focused) { omni.input.value = readableUrl(r.url); renderDisplay({ url: r.url }); omni.shownUrl = r.url; }
        return r;
      } catch (e) { warn(e); U.toast('Не удалось открыть адрес', { tone: 'danger' }); }
    }
  };

  // масштаб в адресной строке
  const zoomBtn = h('button.omni-zoom', { hidden: true, tabindex: '-1', dataset: { order: '990' } });
  zoomBtn.addEventListener('click', () => invoke('kosmo:tabs.zoom', { delta: 0, zoom: 'reset' }).catch(warn));
  $('slot-omnibox-right').appendChild(zoomBtn);
  // zoom: множитель (1 = 100%) или проценты (>5)
  function zoomPercent(z) {
    z = Number(z);
    if (!isFinite(z) || z <= 0) return 100;
    return Math.round(z > 5 ? z : z * 100);
  }
  function renderZoom() {
    const a = state.active;
    const pct = a ? zoomPercent(a.zoom) : 100;
    zoomBtn.hidden = pct === 100;
    if (!zoomBtn.hidden) { zoomBtn.textContent = pct + '%'; zoomBtn.title = 'Масштаб ' + pct + '%. Нажмите, чтобы сбросить (Ctrl+0)'; }
  }

  // ---------- слоты и расширение для фич ----------
  const SLOTS = { tabstrip: 'tabstrip', tabs: 'tabs', tabbar: 'tabbar', nav: 'nav', omnibox: 'omnibox', toolbar: 'toolbar',
    'omnibox-right': 'slot-omnibox-right', 'toolbar-right': 'slot-toolbar-right', bars: 'slot-bars', chrome: 'chrome' };
  function slot(name) {
    name = String(name || '').replace(/^#/, '').replace(/^slot-/, '');
    return $(SLOTS[name] || name);
  }
  function insertOrdered(parent, el, order) {
    el.dataset.order = String(order);
    const next = Array.from(parent.children).find((c) => c !== el && Number(c.dataset.order || 500) > order);
    parent.insertBefore(el, next || null);
  }
  function makeButton(cls, o, parent, defOrder) {
    const btn = h('button.k-icon-btn' + cls, { title: o.title || '', 'aria-label': o.title || o.id, tabindex: '-1', dataset: { id: o.id } });
    const iconBox = h('span', { style: 'display:contents' });
    btn.appendChild(iconBox);
    let badge = null;
    const handle = {
      el: btn, id: o.id,
      setIcon(name) { iconBox.innerHTML = name && name.trim().startsWith('<') ? name : svg(name || 'square'); return handle; },
      setTitle(t) { btn.title = t || ''; btn.setAttribute('aria-label', t || o.id); return handle; },
      setPressed(v) { btn.setAttribute('aria-pressed', v ? 'true' : 'false'); return handle; },
      setActive(v) { return handle.setPressed(v); },
      setDisabled(v) { btn.disabled = !!v; return handle; },
      setVisible(v) { btn.hidden = !v; return handle; },
      // setBadge(null) — убрать; setBadge('') — точка; setBadge('3', 'warn')
      setBadge(text, tone) {
        if (text === null || text === undefined || text === false) { if (badge) { badge.remove(); badge = null; } return handle; }
        if (!badge) { badge = h('span.k-badge-dot'); btn.appendChild(badge); }
        badge.textContent = String(text);
        if (tone) badge.dataset.tone = tone; else delete badge.dataset.tone;
        return handle;
      },
      remove() { btn.remove(); }
    };
    handle.setIcon(o.icon);
    if (o.pressed !== undefined) handle.setPressed(o.pressed);
    if (o.badge !== undefined) handle.setBadge(o.badge, o.badgeTone);
    if (o.hidden) btn.hidden = true;
    if (o.disabled) btn.disabled = true;
    if (o.onClick) btn.addEventListener('click', (e) => { try { o.onClick(e, handle); } catch (err) { console.error('[chrome]', o.id, err); } });
    if (o.onContextMenu) btn.addEventListener('contextmenu', (e) => { e.preventDefault(); o.onContextMenu(e, handle); });
    if (o.onAuxClick) btn.addEventListener('auxclick', (e) => o.onAuxClick(e, handle));
    const old = parent.querySelector(':scope > [data-id="' + CSS.escape(o.id) + '"]');
    if (old) old.remove();
    insertOrdered(parent, btn, o.order != null ? o.order : defOrder);
    return handle;
  }
  function addToolbarButton(o) { return makeButton('.tb-btn', o, slot('toolbar-right'), 500); }
  function addOmniboxIcon(o) { return makeButton('.omni-icon', o, slot('omnibox-right'), 500); }

  const bars = new Map();
  function addBar(o) {
    const el = o.el || h('div');
    el.dataset.barId = o.id;
    if (!o.plain) el.classList.add('k-chrome-bar');
    if (bars.has(o.id)) bars.get(o.id).remove();
    if (o.hidden) el.hidden = true;
    insertOrdered(slot('bars'), el, o.order != null ? o.order : 500);
    const handle = {
      el, id: o.id,
      show() { el.hidden = false; remeasureSoon(); return handle; },
      hide() { el.hidden = true; remeasureSoon(); return handle; },
      toggle(v) { el.hidden = v === undefined ? !el.hidden : !v; remeasureSoon(); return handle; },
      isVisible() { return !el.hidden; },
      remove() { el.remove(); bars.delete(o.id); remeasureSoon(); }
    };
    bars.set(o.id, handle);
    remeasureSoon();
    return handle;
  }

  function rectOf(a) {
    if (!a) return null;
    if (a instanceof Element) {
      const r = a.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    }
    return { x: Math.round(a.x || a.left || 0), y: Math.round(a.y || a.top || 0), w: Math.round(a.w || a.width || 0), h: Math.round(a.h || a.height || 0) };
  }
  // openOverlay(type, data, anchorEl|rect|null, {modal, focus}) → Promise
  function openOverlay(type, data, anchorEl, opts) {
    opts = opts || {};
    const payload = {
      type, data: data === undefined ? null : data,
      anchor: rectOf(anchorEl) || { x: 0, y: 0, w: 0, h: 0 },
      modal: !!opts.modal,
      focus: opts.focus !== undefined ? !!opts.focus : type !== 'omnibox'
    };
    if (opts.align) payload.align = opts.align; // 'start' | 'end' | 'center' — выравнивание по якорю
    return invoke('kosmo:overlay.open', payload);
  }
  function closeOverlay() { return fire('kosmo:overlay.close', {}); }
  // Кнопка-переключатель поповера. Клик по кнопке при открытом поповере сначала даёт фокус chrome,
  // main закрывает поповер ('chrome-focus') ещё на mousedown — и обычный click открыл бы его снова.
  let lastOverlayClose = { type: null, at: 0 };
  function toggleOverlay(type, data, anchorEl, opts) {
    if (state.overlay.open && state.overlay.type === type) return closeOverlay();
    if (lastOverlayClose.type === type && Date.now() - lastOverlayClose.at < 400) return Promise.resolve(null);
    return openOverlay(type, data, anchorEl, opts);
  }
  function overlayEvent(type, name, data) { return fire('kosmo:overlay.event', { type, name, data }); }
  function onOverlay(type, cb) { return bus.on('overlay', (t, name, data) => { if (!type || t === type) cb(name, data, t); }); }

  // ---------- основные кнопки справа ----------
  const panelBtn = addToolbarButton({
    id: 'panel', icon: 'panel-right', title: 'Инструменты (F12)', order: 900,
    onClick: () => fire('kosmo:panel.toggle', {})
  });
  addToolbarButton({
    id: 'menu', icon: 'more-horizontal', title: 'Меню', order: 1000,
    onClick: (e, b) => {
      const r = b.el.getBoundingClientRect();
      fire('kosmo:app.menu', { x: Math.round(r.left), y: Math.round(r.bottom + 2), anchor: rectOf(b.el) });
    }
  });

  // ---------- поиск по странице ----------
  const find = (function () {
    const input = h('input', { type: 'text', spellcheck: 'false', placeholder: 'Найти на странице', 'aria-label': 'Найти на странице' });
    const count = h('span.find-count');
    const prevB = h('button.k-icon-btn', { title: 'Предыдущее (Shift+Enter)', tabindex: '-1', html: svg('chevron-up') });
    const nextB = h('button.k-icon-btn', { title: 'Следующее (Enter)', tabindex: '-1', html: svg('chevron-down') });
    const closeB = h('button.k-icon-btn', { title: 'Закрыть (Esc)', tabindex: '-1', html: svg('x') });
    const el = h('div.find-bar', h('div.find-box', h('span.k-faint', { html: svg('search', 14) }), input, count, prevB, nextB), closeB);
    const bar = addBar({ id: 'find', el, order: 100, hidden: true });
    const perTab = new Map(); // id → {open, text, result}
    let tabId = null;
    const st = () => { const k = String(tabId); if (!perTab.has(k)) perTab.set(k, { open: false, text: '', result: null }); return perTab.get(k); };

    function renderCount() {
      const s = st(), r = s.result;
      count.classList.remove('none');
      if (!s.text) { count.textContent = ''; return; }
      if (!r) { count.textContent = ''; return; }
      if (!r.matches) { count.textContent = 'Нет совпадений'; count.classList.add('none'); return; }
      count.textContent = (r.activeMatchOrdinal || 0) + ' из ' + r.matches;
    }
    function run(findNext, forward) {
      const s = st();
      s.text = input.value;
      if (!s.text) { s.result = null; renderCount(); invoke('kosmo:tabs.stopFind', { id: tabId }).catch(() => {}); return; }
      invoke('kosmo:tabs.find', { id: tabId, text: s.text, forward: forward !== false, findNext: !!findNext }).catch(warn);
    }
    input.addEventListener('input', () => run(false, true));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); if (input.value) run(true, !e.shiftKey); }
      else if (e.key === 'Escape') { e.preventDefault(); api.close(); }
    });
    prevB.addEventListener('click', () => { if (input.value) run(true, false); });
    nextB.addEventListener('click', () => { if (input.value) run(true, true); });
    closeB.addEventListener('click', () => api.close());

    const api = {
      bar,
      open(text) {
        tabId = state.activeId;
        const s = st();
        s.open = true;
        if (typeof text === 'string' && text) input.value = text;
        else if (!input.value && s.text) input.value = s.text;
        bar.show();
        input.focus(); input.select();
        if (input.value) run(false, true);
      },
      close(keepFocus) {
        const s = st();
        s.open = false; s.result = null;
        bar.hide();
        invoke('kosmo:tabs.stopFind', { id: tabId }).catch(() => {});
        if (!keepFocus) focusPage();
      },
      next(forward) { if (!bar.isVisible()) return api.open(); if (input.value) run(true, forward !== false); },
      isOpen() { return bar.isVisible(); },
      onResult(r) {
        if (!r) return;
        const k = String(r.tabId);
        const s = perTab.get(k);
        if (!s) return;
        s.result = Object.assign({}, s.result || {}, r);
        if (sameId(r.tabId, tabId)) renderCount();
      },
      onActive(id) {
        if (sameId(id, tabId)) return;
        tabId = id;
        const s = st();
        input.value = s.text || '';
        bar.toggle(s.open);
        renderCount();
      },
      onClosed(ids) { for (const k of Array.from(perTab.keys())) if (!ids.has(k)) perTab.delete(k); }
    };
    return api;
  })();

  // ---------- вкладка упала ----------
  const crash = (function () {
    const btn = h('button.k-btn.k-btn-sm.k-btn-primary', { html: svg('rotate-cw', 14) }, 'Перезагрузить');
    const el = h('div.crash-bar', { role: 'alert' },
      h('span', { html: svg('alert-triangle') }),
      h('div.crash-text', h('b', 'Вкладка упала'), h('span.k-dim', 'Страница перестала отвечать или ей не хватило памяти.')),
      btn);
    const bar = addBar({ id: 'crash', el, order: 50, hidden: true });
    btn.addEventListener('click', () => { const a = state.active; if (a) invoke('kosmo:tabs.reload', { id: a.id }).catch(warn); });
    return { render() { const a = state.active; bar.toggle(!!(a && a.crashed)); } };
  })();

  // ---------- высота chrome → main ----------
  function reportHeight() {
    const fs = root.classList.contains('fullscreen');
    const hgt = fs ? 0 : Math.ceil(chromeEl.getBoundingClientRect().height);
    const tbh = fs ? 0 : Math.round(tabbarEl.getBoundingClientRect().height); // высота нативных кнопок окна
    const key = hgt + ':' + tbh;
    if (key === lastH) return;
    lastH = key;
    const payload = { height: hgt };
    if (tbh) payload.titleBarHeight = tbh;
    fire('kosmo:layout.setChromeHeight', payload);
  }
  new ResizeObserver(reportHeight).observe(chromeEl);
  // ResizeObserver молчит, пока окно перекрыто, — поэтому меряем ещё и по событиям (layout считается синхронно)
  function remeasureSoon() {
    if (measureTimer) return;
    measureTimer = setTimeout(() => { measureTimer = 0; reportHeight(); layoutTabs(); }, 0);
  }
  if (window.KTheme) window.KTheme.onChange(remeasureSoon);

  // ---------- события main ----------
  function onActiveChanged(prevId) {
    const a = state.active;
    if (omni.focused && !sameId(prevId, state.activeId)) {
      // переключились при фокусе в адресной строке: черновик уходящей вкладки сохраняем
      omni.input.blur();
      leaveFocus();
    }
    find.onActive(state.activeId);
    scrollActiveIntoView();
    bus.emit('active', a, prevId);
  }

  function applyTabsState(p) {
    if (!p || !Array.isArray(p.tabs)) return;
    const prevActive = state.activeId;
    const prevUrl = state.active ? state.active.url : null;
    state.tabs = p.tabs;
    if (p.activeId !== undefined) state.activeId = p.activeId;
    infoById.clear();
    for (const t of p.tabs) infoById.set(t.id, t);
    if (state.activeId != null && !infoById.has(state.activeId)) {
      // id мог прийти строкой/числом
      for (const t of p.tabs) if (sameId(t.id, state.activeId)) { state.activeId = t.id; break; }
    }
    const ids = new Set(p.tabs.map((t) => String(t.id)));
    for (const k of Array.from(omni.drafts.keys())) if (!ids.has(k)) omni.drafts.delete(k);
    find.onClosed(ids);
    reconcile();
    const a = state.active;
    const activeChanged = !sameId(prevActive, state.activeId);
    // навигация во вкладке сбрасывает её черновик
    if (!activeChanged && a && prevUrl !== a.url) omni.drafts.delete(String(a.id));
    renderNav();
    renderOmnibox(activeChanged);
    renderZoom();
    crash.render();
    if (activeChanged) onActiveChanged(prevActive);
    bus.emit('state', state, { activeChanged, prevActiveId: prevActive });
  }

  function applyLayout(l) {
    if (!l || typeof l !== 'object') return;
    Object.assign(state.layout, l);
    root.classList.toggle('fullscreen', !!state.layout.fullscreen);
    root.classList.toggle('maximized', !!state.layout.maximized);
    panelBtn.setPressed(!!state.layout.panelOpen);
    reportHeight();
    bus.emit('layout', state.layout);
  }

  function applySettings(settings, path, value) {
    if (!settings || typeof settings !== 'object') return;
    state.settings = settings;
    bus.emit('settings', settings, path, value);
  }

  function onCommand(c) {
    if (!c || !c.name) return;
    const args = c.args && typeof c.args === 'object' ? c.args : c; // core-main кладёт аргументы рядом с name
    switch (c.name) {
      case 'focusOmnibox':
        omnibox.focus({ select: true });
        if (typeof args.text === 'string') omnibox.setValue(args.text, { select: false });
        break;
      case 'openFind': find.open(args.text); break;
      case 'closeFind': find.close(); break;
      case 'findNext': find.next(true); break;
      case 'findPrev': find.next(false); break;
      case 'newTab': newTab(args); break;
      default: break;
    }
    bus.emit('command', c.name, args);
  }

  on('kosmo:tabs.state', applyTabsState);
  on('kosmo:layout.state', applyLayout);
  on('kosmo:settings.changed', (p) => {
    if (!p) return;
    if (p.settings) applySettings(p.settings, p.path, p.value);
    else if (state.settings && p.path) { U.setPath(state.settings, p.path, p.value); applySettings(state.settings, p.path, p.value); }
  });
  on('kosmo:chrome.command', onCommand);
  on('kosmo:find.result', (r) => { find.onResult(r); bus.emit('find', r); });
  on('kosmo:overlay.event', (e) => { if (e) bus.emit('overlay', e.type, e.name, e.data); });
  on('kosmo:overlay.closed', (e) => {
    state.overlay = { open: false, type: null, modal: false };
    if (e && e.reason === 'chrome-focus') lastOverlayClose = { type: e.type, at: Date.now() };
    bus.emit('overlay-closed', e && e.type, e && e.reason);
  });
  on('kosmo:overlay.state', (e) => { if (e) { state.overlay = e; bus.emit('overlay-state', e); } });

  function warn(e) { console.warn('[chrome]', e && e.message ? e.message : e); }
  function focusPage() {
    if (state.activeId == null) return;
    invoke('kosmo:tabs.focus', { id: state.activeId }).catch(() => invoke('kosmo:tabs.activate', { id: state.activeId }).catch(() => {}));
  }

  // цвета для нативных кнопок окна (main может спросить через executeJavaScript)
  function titlebarColors() {
    const cs = getComputedStyle(root);
    // computed-цвет может быть oklab()/color() (color-mix) — переводим в #rrggbb через canvas
    const probe = (v) => { const d = h('div', { style: 'position:absolute;visibility:hidden;color:' + v }); document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return toHex(c); };
    return { color: probe(cs.getPropertyValue('--k-bg-sunken').trim()), symbolColor: probe(cs.getPropertyValue('--k-text').trim()), height: parseInt(cs.getPropertyValue('--k-tab-h'), 10) || 38 };
  }
  let hexCtx = null;
  function toHex(c) {
    if (!hexCtx) { const cv = document.createElement('canvas'); cv.width = cv.height = 1; hexCtx = cv.getContext('2d', { willReadFrequently: true }); }
    hexCtx.clearRect(0, 0, 1, 1);
    hexCtx.fillStyle = '#000';
    hexCtx.fillStyle = String(c);
    hexCtx.fillRect(0, 0, 1, 1);
    const d = hexCtx.getImageData(0, 0, 1, 1).data;
    return '#' + [d[0], d[1], d[2]].map((x) => x.toString(16).padStart(2, '0')).join('');
  }

  // ---------- старт ----------
  const ready = (async () => {
    if (!U.hasKosmo) return;
    invoke('kosmo:layout.get', {}).then(applyLayout).catch(() => {});
    invoke('kosmo:tabs.list', {}).then((r) => { if (r && Array.isArray(r.tabs) && !state.tabs.length) applyTabsState(r); }).catch(() => {});
    try {
      const s = await invoke('kosmo:settings.get', {});
      applySettings(s, '', s);
    } catch (e) { warn(e); }
  })();
  renderNav();
  renderOmnibox(true);
  reportHeight();

  window.KChrome = {
    state,
    slot, addToolbarButton, addOmniboxIcon, addBar,
    bar(id) { return bars.get(id) || null; },
    on: bus.on,
    omnibox, find,
    openOverlay, closeOverlay, toggleOverlay, overlayEvent, onOverlay,
    activeTab: () => state.active,
    tab: (id) => { for (const t of state.tabs) if (sameId(t.id, id)) return t; return null; },
    tabEl: (id) => { const v = views.get(String(id)); return v ? v.el : null; },
    newTab, closeTab: (id) => closeTab(id, false), activateTab,
    rectOf, titlebarColors,
    invoke, send, fire, kosmo: U.kosmo, h, icon: U.icon, toast: U.toast,
    ready
  };
})();
