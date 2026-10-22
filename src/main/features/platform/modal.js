'use strict';
// Очередь модальных окон фичи в overlay (вход на сайт по HTTP Basic, подтверждение установки расширения).
// Показывается одно окно за раз. Ответ приходит через kosmo:platform.modalRespond {id, result}.
// Окно закрылось без ответа: при потере фокуса окном / ресайзе — показываем снова, когда окно вернётся
// (keepOnBlur); в остальных случаях (Esc, смена вкладки, другой поповер) — отмена.

function createModal(ctx) {
  const queue = [];   // {id, type, data, resolve, keepOnBlur, tabId}
  let current = null; // показанное (или временно скрытое) окно
  let hidden = false; // текущее скрыто, ждём возможности показать снова
  let answering = false;
  let seq = 0;
  let resizeTimer = null;

  function ask(type, data, opts = {}) {
    return new Promise((resolve) => {
      queue.push({ id: 'm' + (++seq), type, data: data || {}, resolve, keepOnBlur: !!opts.keepOnBlur, tabId: opts.tabId || null, onShow: opts.onShow });
      pump();
    });
  }

  function show(item) {
    hidden = false;
    if (item.onShow) { try { item.onShow(); } catch (_) { /* ignore */ } }
    try {
      ctx.overlay.open({ type: item.type, data: Object.assign({}, item.data, { modalId: item.id }), modal: true });
    } catch (e) {
      ctx.log('platform', 'modal:', e.message);
      finish(item, null);
    }
  }

  function pump() {
    if (current || !queue.length) return;
    current = queue.shift();
    show(current);
  }

  function finish(item, result) {
    if (!item) return;
    if (current === item) { current = null; hidden = false; }
    const i = queue.indexOf(item);
    if (i >= 0) queue.splice(i, 1);
    try { item.resolve(result); } catch (_) { /* ignore */ }
    setTimeout(pump, 0);
  }

  function respond(id, result) {
    const item = current && current.id === id ? current : queue.find((q) => q.id === id);
    if (!item) return false;
    answering = true;
    try {
      finish(item, result == null ? null : result);
      if (ctx.overlay.isOpen() && ctx.overlay.current() && ctx.overlay.current().type === item.type) ctx.overlay.close('answered');
    } finally { answering = false; }
    return true;
  }

  // Отменить ожидающие окна (например, вкладка закрылась).
  function cancelWhere(pred) {
    for (const q of queue.slice()) if (pred(q)) finish(q, null);
    if (current && pred(current)) {
      const c = current;
      finish(c, null);
      if (!hidden && ctx.overlay.current() && ctx.overlay.current().type === c.type) ctx.overlay.close('cancelled');
    }
  }

  ctx.overlay.on('closed', (type, reason) => {
    if (!current || answering || hidden || type !== current.type) return;
    if (current.keepOnBlur && (reason === 'blur' || reason === 'resize')) { hidden = true; return; }
    finish(current, null);
  });
  // Поверх модального открыли другой поповер — наше окно спрятано, вернём после его закрытия.
  ctx.overlay.on('opened', (type) => {
    if (current && !hidden && type !== current.type) hidden = true;
  });
  ctx.overlay.on('closed', (type) => {
    if (current && hidden && type !== current.type) setTimeout(() => { if (current && hidden && !ctx.overlay.isOpen()) show(current); }, 50);
  });
  ctx.bus.once('windows:created', () => {
    ctx.windows.on('focus', () => { if (current && hidden) setTimeout(() => { if (current && hidden && !ctx.overlay.isOpen()) show(current); }, 80); });
    ctx.windows.on('resize', () => {
      if (!current || !hidden) return;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => { if (current && hidden && !ctx.overlay.isOpen()) show(current); }, 250);
    });
  });

  return { ask, respond, cancelWhere, current: () => current };
}

module.exports = { createModal };
