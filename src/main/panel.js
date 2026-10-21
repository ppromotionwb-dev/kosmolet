'use strict';
// Правая панель инструментов (ARCHITECTURE §6, §9): view панели + место под DevTools (ниже шапки 36px).

const { EventEmitter } = require('events');
const { PANEL_MIN, TAB_MIN } = require('./windows');

const HEADER_H = 36;

function createPanel(ctx) {
  const { WebContentsView } = ctx.electron;
  const emitter = new EventEmitter();
  let view = null;
  let open = false;
  let tool = String(ctx.settings.peek('ui.panelTool') || 'devtools');
  let devtoolsView = null;
  let lastBounds = null;
  let widthSaveTimer = null;
  let liveWidth = null; // ширина во время перетаскивания (ещё не записана в настройки)

  function ensure() {
    if (view) return view;
    view = new WebContentsView({ webPreferences: ctx.windows.uiWebPreferences('panel') });
    const wc = view.webContents;
    ctx.ipc.registerUi(wc);
    wc.on('did-finish-load', sendState);
    wc.on('render-process-gone', () => { if (!ctx.quitting) setTimeout(() => { if (view && !wc.isDestroyed()) wc.reload(); }, 300); });
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) ctx.tabs.create({ url });
      return { action: 'deny' };
    });
    emitter.emit('view-created', view, wc);
    wc.loadURL(ctx.windows.uiUrl('panel/index.html'));
    return view;
  }

  // Пустой WebContentsView для DevTools — его настраивает фича devtools (setDevToolsWebContents).
  function createDevtoolsView() {
    const v = new WebContentsView();
    // Пока DevTools грузятся (или если вид ещё пуст) — видна подложка панели, а не белый прямоугольник.
    v.setBackgroundColor('#00000000');
    emitter.emit('devtools-view-created', v, v.webContents);
    return v;
  }

  function getDevtoolsView() {
    if (!devtoolsView) devtoolsView = createDevtoolsView();
    return devtoolsView;
  }

  // Подменить view DevTools (DevTools-webContents одноразовый: на каждую вкладку — свой).
  function setDevtoolsView(v) {
    const old = devtoolsView;
    devtoolsView = v || null;
    ctx.windows.layout();
    return old;
  }

  function state() {
    const { width } = ctx.windows.contentSize();
    return { open, tool, width: clampWidth(currentWidth(), width) };
  }

  function sendState() {
    send('kosmo:panel.state', state());
  }

  function send(channel, payload) {
    if (!view || view.webContents.isDestroyed()) return;
    view.webContents.send(channel, payload);
  }

  function currentWidth() { return liveWidth != null ? liveWidth : Number(ctx.settings.peek('ui.panelWidth')) || 460; }

  function clampWidth(w, W) {
    const max = Math.max(PANEL_MIN, (W || 0) - TAB_MIN);
    return Math.round(Math.min(Math.max(Number(w) || 0, PANEL_MIN), max));
  }

  function changed() {
    ctx.windows.layout();
    ctx.windows.sendLayoutState();
    sendState();
  }

  function openPanel(toolId) {
    if (toolId) setTool(toolId, true);
    ensure();
    if (!open) {
      open = true;
      changed();
      emitter.emit('opened', tool);
    } else changed();
    return state();
  }

  function close() {
    if (!open) return state();
    // Фокус был в панели — после закрытия вернуть его странице.
    const hadFocus = !!((view && view.webContents.isFocused()) || (devtoolsView && devtoolsView.webContents.isFocused()));
    open = false;
    changed();
    emitter.emit('closed', tool);
    const tab = ctx.tabs.active();
    if (hadFocus && tab && tab.wc) tab.wc.focus();
    return state();
  }

  function toggle(toolId) {
    if (open && (!toolId || toolId === tool)) return close();
    return openPanel(toolId);
  }

  function setTool(id, silent) {
    id = String(id || '').trim();
    if (!id || id === tool) return state();
    const prev = tool;
    tool = id;
    try { ctx.settings.set('ui.panelTool', id); } catch (e) { ctx.log('panel', e.message); }
    emitter.emit('tool-changed', tool, prev);
    if (!silent) changed();
    return state();
  }

  function setWidth(px) {
    const { width: W } = ctx.windows.contentSize();
    const w = clampWidth(px, W);
    // При перетаскивании приходит много событий: раскладка сразу, запись в настройки — с задержкой.
    liveWidth = w;
    ctx.windows.layout();
    if (widthSaveTimer) clearTimeout(widthSaveTimer);
    widthSaveTimer = setTimeout(() => {
      widthSaveTimer = null;
      try { ctx.settings.set('ui.panelWidth', w); } catch (e) { ctx.log('panel', e.message); }
      liveWidth = null;
      ctx.windows.sendLayoutState();
      sendState();
    }, 250);
    return w;
  }

  function views() {
    if (!open || !view || ctx.windows.isFullscreen()) return [];
    const out = [view];
    if (tool === 'devtools' && devtoolsView) out.push(devtoolsView);
    return out;
  }

  function layout(bounds, isOpen) {
    lastBounds = bounds;
    if (!view || !isOpen) return;
    view.setBounds(bounds);
    if (devtoolsView && tool === 'devtools') {
      devtoolsView.setBounds({ x: bounds.x, y: bounds.y + HEADER_H, width: bounds.width, height: Math.max(0, bounds.height - HEADER_H) });
    }
  }

  return {
    open: openPanel,
    close,
    toggle,
    isOpen: () => open,
    tool: () => tool,
    setTool: (id) => setTool(id, false),
    setWidth,
    desiredWidth: currentWidth,
    state,
    send,
    views,
    layout,
    ensure,
    view: () => view,
    webContents: () => (view ? view.webContents : null),
    get devtoolsView() { return getDevtoolsView(); },
    get devtoolsViewIfCreated() { return devtoolsView; },
    createDevtoolsView,
    setDevtoolsView,
    get bounds() { return lastBounds; },
    HEADER_H,
    on(ev, cb) { emitter.on(ev, cb); return () => emitter.off(ev, cb); },
    off(ev, cb) { emitter.off(ev, cb); },
  };
}

function registerPanelIpc(ctx) {
  const P = ctx.panel;
  const toolOf = (p) => (typeof p === 'string' ? p : p && (p.tool || p.toolId || p.id));
  ctx.ipc.handle('kosmo:panel.toggle', (p) => P.toggle(toolOf(p)));
  ctx.ipc.handle('kosmo:panel.open', (p) => P.open(toolOf(p)));
  ctx.ipc.handle('kosmo:panel.close', () => P.close());
  ctx.ipc.handle('kosmo:panel.setWidth', (p) => P.setWidth(typeof p === 'number' ? p : p && p.width));
  ctx.ipc.handle('kosmo:panel.setTool', (p) => P.setTool(toolOf(p)));
  ctx.ipc.handle('kosmo:panel.state', () => P.state());
  ctx.ipc.on('kosmo:panel.setWidth', (p) => P.setWidth(typeof p === 'number' ? p : p && p.width));
}

module.exports = { createPanel, registerPanelIpc, HEADER_H };
