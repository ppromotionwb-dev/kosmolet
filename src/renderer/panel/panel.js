// Космолёт — правая панель инструментов (window.KPanel). Владелец: core.
// Инструменты регистрируются в panel/tools/<id>.js: KPanel.register({id, title, icon, order, mount(el, api), onShow(api), onHide(api)}).
// mount — лениво, при первом показе. Активный инструмент синхронизируется с main: kosmo:panel.setTool ↔ kosmo:layout.state.
'use strict';
(function () {
  const U = window.KUI;
  const { h, invoke, fire, on, clamp, rafThrottle, emitter } = U;
  const svg = (n, s) => window.KIcons.get(n, s || 16);
  const $ = (id) => document.getElementById(id);
  const docEl = document.documentElement;
  const MIN_W = 320, DEFAULT_W = 460; // MIN_W = PANEL_MIN в main/windows.js

  const tabsEl = $('tool-tabs'), bodyEl = $('body'), titleEl = $('tool-title'), closeBtn = $('panel-close');
  closeBtn.innerHTML = svg('x');
  closeBtn.addEventListener('click', () => fire('kosmo:panel.close', {}));

  const bus = emitter();
  const tools = new Map(); // id → {def, btn, el, api, mounted}
  let activeId = null;     // показанный инструмент
  let wantedId = null;     // запрошенный main, но ещё не зарегистрированный
  let visible = true;      // панель видна (layout.panelOpen)
  let initPending = U.hasKosmo; // ждём ui.panelTool из настроек
  const tabs = { list: [], activeId: null, activeUrl: null };
  const layout = { panelOpen: true, panelWidth: DEFAULT_W, panelTool: null };

  function activeTab() {
    for (const t of tabs.list) if (String(t.id) === String(tabs.activeId)) return t;
    return null;
  }

  // Общая шапка «текущий сайт» для инструментов (UX-16): иконка 32px в квадрате, хост, подзаголовок, кнопки справа.
  // siteHeader({icon, title, sub, subTitle, actions: [Node]}) → {el, set({...}), actions}
  function siteHeader(o) {
    const ic = h('span.kp-site-ic');
    const title = h('div.kp-site-title.k-ellipsis');
    const sub = h('div.kp-site-sub.k-ellipsis');
    const actions = h('div.kp-site-actions');
    const el = h('header.kp-site', ic, h('div.kp-site-text', title, sub), actions);
    function set(p) {
      p = p || {};
      if (p.icon !== undefined) { U.clear(ic); if (p.icon) ic.appendChild(typeof p.icon === 'string' ? U.icon(p.icon, 18) : p.icon); }
      if (p.title !== undefined) title.textContent = p.title || '';
      if (p.sub !== undefined) { sub.textContent = p.sub || ''; sub.hidden = !p.sub; }
      if (p.subTitle !== undefined) sub.title = p.subTitle || '';
      if (Array.isArray(p.actions)) { U.clear(actions); for (const a of p.actions) if (a) actions.appendChild(a); }
    }
    set(Object.assign({ sub: '' }, o || {}));
    return { el, set, actions };
  }

  function makeApi(t) {
    const offs = [];
    return {
      id: t.def.id, el: null,
      invoke, send: U.send, fire,
      on(channel, cb) { const off = on(channel, cb); offs.push(off); return off; },
      activeTab, tabs: () => tabs.list,
      // cb(tab, {reason: 'activated'|'navigated', prevId}) — смена активной вкладки или её адреса
      onTabChange(cb) { const off = bus.on('tab', cb); offs.push(off); return off; },
      onTabsState(cb) { const off = bus.on('tabs', cb); offs.push(off); return off; },
      onLayout(cb) { const off = bus.on('layout', cb); offs.push(off); return off; },
      isVisible: () => visible && activeId === t.def.id,
      close: () => fire('kosmo:panel.close', {}),
      setTool: (id) => show(id),
      toast: U.toast, h, icon: U.icon, empty: U.empty, siteHeader,
      _offs: offs
    };
  }

  function register(def) {
    if (!def || !def.id) throw new Error('KPanel.register: нужен id');
    const old = tools.get(def.id);
    if (old) { old.btn.remove(); if (old.el) old.el.remove(); }
    const btn = h('button.tool-tab', {
      role: 'tab', title: def.title || def.id, 'aria-label': def.title || def.id, tabindex: '-1',
      dataset: { id: def.id, order: String(def.order != null ? def.order : 500) }, html: svg(def.icon || 'square')
    });
    btn.addEventListener('click', () => show(def.id));
    const t = { def, btn, el: null, api: null, mounted: false };
    t.api = makeApi(t);
    tools.set(def.id, t);
    const order = Number(btn.dataset.order);
    const next = Array.from(tabsEl.children).find((c) => Number(c.dataset.order) > order);
    tabsEl.insertBefore(btn, next || null);
    if (wantedId === def.id || (!activeId && !wantedId && !initPending)) show(def.id, { fromMain: true });
    else if (old && activeId === def.id) { activeId = null; show(def.id, { fromMain: true }); }
    return t.api;
  }

  function mount(t) {
    if (t.mounted) return;
    t.mounted = true;
    t.el = h('div.tool-body', { dataset: { tool: t.def.id }, hidden: true });
    t.api.el = t.el;
    bodyEl.appendChild(t.el);
    if (typeof t.def.mount === 'function') {
      try { t.def.mount(t.el, t.api); } catch (e) {
        console.error('[panel]', t.def.id, e);
        t.el.appendChild(U.empty({ icon: 'alert-triangle', title: 'Инструмент не запустился', text: String(e && e.message || e), tone: 'error' }));
      }
    }
  }

  function callHook(t, name) {
    if (t && t.def && typeof t.def[name] === 'function') { try { t.def[name](t.api); } catch (e) { console.error('[panel]', t.def.id, name, e); } }
  }

  // show(id, {fromMain}) — показать инструмент; без fromMain сообщает выбор в main
  function show(id, opts) {
    opts = opts || {};
    const t = tools.get(id);
    if (!t) { wantedId = id; return; }
    wantedId = null;
    if (activeId === id) { if (!opts.fromMain) fire('kosmo:panel.setTool', { tool: id }); return; }
    const prev = tools.get(activeId);
    if (prev) {
      prev.btn.setAttribute('aria-selected', 'false');
      if (prev.el) prev.el.hidden = true;
      if (visible) callHook(prev, 'onHide');
    }
    activeId = id;
    t.btn.setAttribute('aria-selected', 'true');
    titleEl.textContent = t.def.title || id;
    bodyEl.classList.toggle('devtools', id === 'devtools');
    mount(t);
    t.el.hidden = false;
    if (visible) callHook(t, 'onShow');
    const r = t.btn.getBoundingClientRect(), pr = tabsEl.getBoundingClientRect();
    if (r.left < pr.left || r.right > pr.right) t.btn.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    if (!opts.fromMain) fire('kosmo:panel.setTool', { tool: id });
  }

  function setVisible(v) {
    if (v === visible) return;
    visible = v;
    const t = tools.get(activeId);
    if (t) callHook(t, v ? 'onShow' : 'onHide');
  }

  // ---------- изменение ширины за левый край ----------
  const resizer = $('resizer');
  let rs = null;
  const sendWidth = rafThrottle((w) => fire('kosmo:panel.setWidth', { width: w }));
  function maxWidth() { return Math.max(MIN_W, (screen.availWidth || 1600) - 320); }
  resizer.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    // screenX: вид панели сдвигается во время перетаскивания, clientX «плывёт»
    rs = { startX: e.screenX, startW: window.innerWidth, id: e.pointerId, w: window.innerWidth };
    resizer.setPointerCapture(e.pointerId);
    docEl.classList.add('resizing');
  });
  resizer.addEventListener('pointermove', (e) => {
    if (!rs || e.pointerId !== rs.id) return;
    const w = Math.round(clamp(rs.startW + (rs.startX - e.screenX), MIN_W, maxWidth()));
    if (w === rs.w) return;
    rs.w = w;
    sendWidth(w);
  });
  function endResize() {
    if (!rs) return;
    const w = rs.w;
    rs = null;
    docEl.classList.remove('resizing');
    sendWidth.cancel();
    fire('kosmo:panel.setWidth', { width: w });
  }
  resizer.addEventListener('pointerup', endResize);
  resizer.addEventListener('pointercancel', endResize);
  resizer.addEventListener('lostpointercapture', endResize);
  resizer.addEventListener('dblclick', () => fire('kosmo:panel.setWidth', { width: DEFAULT_W }));

  // ---------- события main ----------
  on('kosmo:layout.state', (l) => {
    if (!l) return;
    Object.assign(layout, l);
    if (l.panelOpen !== undefined) setVisible(!!l.panelOpen && !l.fullscreen);
    if (l.panelTool && l.panelTool !== activeId) show(l.panelTool, { fromMain: true });
    bus.emit('layout', layout);
  });
  on('kosmo:tabs.state', applyTabs);
  function applyTabs(p) {
    if (!p || !Array.isArray(p.tabs)) return;
    const prevId = tabs.activeId, prevUrl = tabs.activeUrl;
    tabs.list = p.tabs;
    if (p.activeId !== undefined) tabs.activeId = p.activeId;
    const a = activeTab();
    tabs.activeUrl = a ? a.url : null;
    bus.emit('tabs', tabs.list, tabs.activeId);
    if (String(prevId) !== String(tabs.activeId)) bus.emit('tab', a, { reason: 'activated', prevId });
    else if (a && prevUrl !== a.url) bus.emit('tab', a, { reason: 'navigated', prevId });
  }

  // первый инструмент — тот, что сейчас выбран в main (kosmo:panel.state), а не первый зарегистрированный.
  // Ждём DOMContentLoaded: он наступает после ВСЕХ defer-скриптов инструментов. readyState во время их выполнения
  // уже 'interactive', и ответ main мог прийти между скриптами — тогда панель откатывалась на DevTools.
  if (U.hasKosmo) {
    let scriptsDone = document.readyState === 'complete';
    let mainTool;            // undefined — ответа ещё нет
    const pick = () => {
      if (!scriptsDone || mainTool === undefined) return;
      initPending = false;
      if (activeId) return;
      if (typeof mainTool === 'string' && tools.has(mainTool)) show(mainTool, { fromMain: true });
      else if (wantedId && tools.has(wantedId)) show(wantedId, { fromMain: true });
      else show(firstTool(), { fromMain: true });
    };
    if (!scriptsDone) document.addEventListener('DOMContentLoaded', () => { scriptsDone = true; pick(); }, { once: true });
    // панель создаётся лениво, когда вкладки уже есть: до первого kosmo:tabs.state берём список сами
    invoke('kosmo:tabs.list', {}).then((r) => { if (r && !tabs.list.length) applyTabs(r); }).catch(() => {});
    invoke('kosmo:layout.get', {}).then((l) => { if (l) { Object.assign(layout, l); if (l.panelOpen !== undefined) setVisible(!!l.panelOpen); } }).catch(() => {});
    invoke('kosmo:panel.state', {})
      .then((st) => (st && typeof st.tool === 'string' ? st.tool : invoke('kosmo:settings.get', { path: 'ui.panelTool' })))
      .then((tool) => { mainTool = typeof tool === 'string' ? tool : null; pick(); })
      .catch(() => { mainTool = null; pick(); });
  }
  function firstTool() { const b = tabsEl.firstElementChild; return b ? b.dataset.id : null; }

  window.KPanel = {
    register, show,
    active: () => activeId,
    tools: () => Array.from(tools.values()).map((t) => ({ id: t.def.id, title: t.def.title, icon: t.def.icon, order: t.def.order })),
    activeTab, tabs: () => tabs.list,
    isVisible: () => visible
  };
})();
