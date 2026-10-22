'use strict';
// Всплывающий слой (ARCHITECTURE §6, §8): прозрачный WebContentsView поверх всего окна.
// modal:true — на всё окно; иначе — по размеру поповера (сообщает overlay через kosmo:overlay.resize) под якорем.

const { EventEmitter } = require('events');

const EDGE = 4; // отступ от края окна

function createOverlay(ctx) {
  const { WebContentsView } = ctx.electron;
  const emitter = new EventEmitter();
  let view = null;
  let loaded = false;
  let state = null; // { type, data, anchor, modal, focus, align, size: {width, height, inset} }
  let openSeq = 0;
  const lastSize = {}; // последний размер по типу — чтобы повторное открытие не мигало

  function ensure() {
    if (view) return view;
    view = new WebContentsView({ webPreferences: ctx.windows.uiWebPreferences('overlay') });
    view.setBackgroundColor('#00000000');
    view.setVisible(false);
    const wc = view.webContents;
    ctx.ipc.registerUi(wc);
    wc.on('did-finish-load', () => { loaded = true; if (state) sendShow(); });
    wc.on('render-process-gone', () => { loaded = false; if (!ctx.quitting) setTimeout(() => { if (view && !wc.isDestroyed()) wc.reload(); }, 300); });
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    emitter.emit('view-created', view, wc);
    wc.loadURL(ctx.windows.uiUrl('overlay/index.html'));
    ctx.windows.layout();
    return view;
  }

  function send(channel, payload) {
    const wc = view && view.webContents;
    if (!wc || wc.isDestroyed()) return;
    wc.send(channel, payload);
  }

  function sendShow() {
    if (!state || !loaded) return;
    send('kosmo:overlay.show', {
      type: state.type, data: state.data, anchor: state.anchor, modal: state.modal, align: state.align, seq: state.seq,
    });
  }

  function place(g) {
    if (!view || !state) return;
    const geo = g || ctx.windows.geometry();
    const { W, H } = geo;
    if (state.modal) {
      view.setBounds({ x: 0, y: 0, width: W, height: H });
      return;
    }
    const size = state.size;
    if (!size) {
      // Размер ещё неизвестен: полоса высотой 1px на всю ширину (за окном или скрытым видом Chromium не рисует,
      // и размер не придёт). Верхний пиксель карточки — прозрачное поле под тень, поэтому полоса не видна.
      const top = Math.max(0, Math.round(((state.anchor && state.anchor.y) || 0) + (state.above ? -1 : ((state.anchor && state.anchor.h) || 0))));
      view.setBounds({ x: 0, y: Math.min(top, Math.max(0, H - 1)), width: Math.max(1, W), height: 1 });
      return;
    }
    const inset = Math.max(0, Math.min(64, Number(size.inset) || 0));
    const a = state.anchor || { x: 0, y: 0, w: 0, h: 0 };
    const w = Math.max(1, Math.min(Math.round(size.width), W));
    let x;
    if (state.align === 'end') x = a.x + (a.w || 0) - w + inset;
    else if (state.align === 'center') x = a.x + (a.w || 0) / 2 - w / 2;
    else x = a.x - inset;
    // above: карточка над якорем (тосты у нижнего края области вкладки), иначе — под ним.
    let y = state.above ? a.y - Math.round(size.height) + inset : a.y + (a.h || 0) - inset;
    x = Math.round(Math.max(EDGE - inset, Math.min(x, W - w - EDGE + inset)));
    x = Math.max(0, Math.min(x, W - w));
    y = Math.round(Math.max(0, y));
    const h = Math.max(1, Math.min(Math.round(size.height), H - y));
    view.setBounds({ x, y, width: w, height: h });
  }

  function open(opts = {}) {
    if (!opts.type) throw new Error('overlay.open: нужен type');
    ensure();
    const prevType = state ? state.type : null;
    const a = opts.anchor || null;
    state = {
      seq: ++openSeq,
      type: String(opts.type),
      data: opts.data === undefined ? null : opts.data,
      anchor: a ? { x: Number(a.x) || 0, y: Number(a.y) || 0, w: Number(a.w || a.width) || 0, h: Number(a.h || a.height) || 0 } : null,
      modal: !!opts.modal,
      focus: opts.focus !== undefined ? !!opts.focus : String(opts.type) !== 'omnibox',
      align: ['start', 'end', 'center'].includes(opts.align) ? opts.align : 'start',
      above: !!opts.above,
      size: null,
      openedAt: Date.now(),
    };
    // Тот же тип и известный размер — оставляем прежний, чтобы не мигать.
    if (prevType === state.type && lastSize[state.type]) state.size = lastSize[state.type];
    place();
    view.setVisible(true);
    ctx.windows.layout();
    if (ctx.windows.setTitleBarDim) ctx.windows.setTitleBarDim(state.modal);
    if (state.focus && view.webContents && !view.webContents.isDestroyed()) view.webContents.focus();
    sendShow();
    broadcastState();
    emitter.emit('opened', state.type, state.data);
    return { seq: state.seq };
  }

  function resize(size) {
    if (!state || !size) return false;
    const width = Number(size.width);
    const height = Number(size.height);
    if (!(width > 0) || !(height > 0)) return false;
    state.size = { width, height, inset: Number(size.inset) || 0 };
    lastSize[state.type] = state.size;
    place();
    return true;
  }

  function close(reason) {
    if (!state) return false;
    const { type } = state;
    state = null;
    if (ctx.windows.setTitleBarDim) ctx.windows.setTitleBarDim(false);
    if (view) {
      view.setVisible(false);
      send('kosmo:overlay.hide', { type, reason: reason || 'close' });
    }
    // Если фокус был в overlay — вернуть его странице или интерфейсу.
    const win = ctx.windows.main;
    const ovWc = view && view.webContents;
    if (win && !win.isDestroyed() && ovWc && !ovWc.isDestroyed() && ovWc.isFocused()) {
      const tab = ctx.tabs.active();
      if (type === 'omnibox' || !tab || !tab.wc) win.webContents.focus(); else tab.wc.focus();
    }
    const payload = { type, reason: reason || 'close', at: Date.now() };
    if (ctx.flags.dev) ctx.log('overlay', 'закрыт:', type, payload.reason);
    ctx.broadcast('kosmo:overlay.closed', payload);
    broadcastState();
    emitter.emit('closed', type, payload.reason);
    return true;
  }

  // Тост интерфейса (UX-5): chrome-тост лежит под видом вкладки и не виден, поэтому показываем его слоем —
  // немодально, без фокуса, по центру у нижнего края области вкладки. Если открыт другой поповер — внутри него.
  function toast(p) {
    const text = String((p && p.text) || '').trim().slice(0, 300);
    if (!text) return false;
    const ms = Math.min(10000, Math.max(1200, Number(p.ms) || 3000));
    const msg = { text, tone: ['danger', 'ok', 'warn'].includes(p.tone) ? p.tone : null, ms, at: Date.now() };
    if (state && state.type !== 'toast') { send('kosmo:overlay.toast', msg); return 'inline'; }
    const g = ctx.windows.geometry();
    if (!g.W || !g.H) return false;
    open({
      type: 'toast', data: msg, focus: false, align: 'center', above: true,
      anchor: { x: Math.round(g.tab.x + g.tab.width / 2), y: Math.max(g.top + 40, g.H - 16), w: 0, h: 0 },
    });
    return true;
  }

  function broadcastState() {
    const s = state ? { open: true, type: state.type, modal: state.modal } : { open: false, type: null, modal: false };
    const win = ctx.windows.main;
    if (win && !win.isDestroyed()) win.webContents.send('kosmo:overlay.state', s);
    if (ctx.panel && ctx.panel.send) ctx.panel.send('kosmo:overlay.state', s);
  }

  function update(type, data) {
    if (!state || (type && state.type !== type)) return false;
    state.data = data;
    send('kosmo:overlay.update', { type: state.type, data });
    return true;
  }

  // Закрытие: фокус вкладки/панели, потеря фокуса окном, ресайз, смена вкладки.
  ctx.bus.once('windows:created', () => {
    ctx.windows.on('blur', () => close('blur'));
    ctx.windows.on('resize', () => close('resize'));
    const win = ctx.windows.main;
    // Клик по интерфейсу при открытом поповере с фокусом (не адресная строка) — закрыть.
    win.webContents.on('focus', () => { if (state && state.focus && !state.modal) close('chrome-focus'); });
  });
  // Фокус вкладки, пришедший сразу после открытия, — эхо предыдущей активации, а не клик по странице.
  ctx.tabs.on('focus', () => { if (state && Date.now() - state.openedAt > 150) close('tab-focus'); });
  ctx.tabs.on('activated', () => close('tab-changed'));
  // Фокус панели или DevTools в панели — тоже «клик мимо».
  const onPanelFocus = () => { if (state && !state.modal && Date.now() - state.openedAt > 150) close('panel-focus'); };
  ctx.panel.on('view-created', (_v, wc) => wc.on('focus', onPanelFocus));
  ctx.panel.on('devtools-view-created', (_v, wc) => wc.on('focus', onPanelFocus));

  return {
    open,
    close,
    isOpen: () => !!state,
    current: () => (state ? { type: state.type, data: state.data, modal: state.modal } : null),
    send: update, // send(type, data) — обновить данные открытого поповера
    update,
    resize,
    toast: (text, opts) => toast(Object.assign({}, opts || {}, { text })),
    ensure,
    warm() { try { ensure(); } catch (e) { ctx.log('overlay', e.message); } },
    view: () => view,
    webContents: () => (view && view.webContents && !view.webContents.isDestroyed() ? view.webContents : null),
    layout(g) { if (view && state) place(g); },
    post: send, // произвольное сообщение в overlay
    on(ev, cb) { emitter.on(ev, cb); return () => emitter.off(ev, cb); },
    off(ev, cb) { emitter.off(ev, cb); },
    emit: (...a) => emitter.emit(...a),
  };
}

function registerOverlayIpc(ctx) {
  const O = ctx.overlay;
  ctx.ipc.handle('kosmo:overlay.open', (p = {}) => O.open(p));
  ctx.ipc.handle('kosmo:overlay.close', (p = {}) => O.close(p && p.reason));
  ctx.ipc.handle('kosmo:overlay.resize', (p = {}) => O.resize(p));
  ctx.ipc.handle('kosmo:overlay.update', (p = {}) => O.update(p.type, p.data));
  // Relay событий: chrome/panel → overlay, overlay → chrome и панель (+ слушатели main). Принимается и send, и invoke.
  const relay = (p, meta) => {
    if (!p || typeof p !== 'object') return false;
    const msg = { type: p.type, name: p.name === undefined ? null : p.name, data: p.data === undefined ? null : p.data };
    const ovWc = O.webContents();
    if (ovWc && meta.webContents === ovWc) {
      const win = ctx.windows.main;
      if (win && !win.isDestroyed()) win.webContents.send('kosmo:overlay.event', msg);
      if (ctx.panel) ctx.panel.send('kosmo:overlay.event', msg);
      O.emit('event', msg.type, msg.data, msg.name);
    } else {
      O.post('kosmo:overlay.event', msg);
    }
    return true;
  };
  ctx.ipc.on('kosmo:overlay.event', relay);
  ctx.ipc.handle('kosmo:overlay.event', relay);
  ctx.ipc.on('kosmo:overlay.resize', (p) => O.resize(p));
  ctx.ipc.handle('kosmo:overlay.toast', (p = {}) => O.toast(p.text, p));
  ctx.ipc.on('kosmo:overlay.toast', (p = {}) => O.toast(p.text, p));
}

module.exports = { createOverlay, registerOverlayIpc };
