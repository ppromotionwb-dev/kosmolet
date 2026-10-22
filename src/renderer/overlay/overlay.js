// Космолёт — всплывающий слой (window.KOverlay). Владелец: core.
// main показывает слой: kosmo:overlay.show {type, data, anchor, modal}; скрывает: kosmo:overlay.hide {}.
// Немодальный: карточка в 8px полях под тень, размер сообщается в main (kosmo:overlay.resize) автоматически.
'use strict';
(function () {
  const U = window.KUI;
  const { h, fire, invoke, on } = U;
  const PAD = 8;
  const root = document.getElementById('root');
  const types = new Map();
  let cur = null;      // текущее окно
  let pending = null;  // show пришёл раньше, чем фича зарегистрировала тип

  function register(type, def) {
    if (!type || !def || typeof def.render !== 'function') throw new Error('KOverlay.register: нужен type и render()');
    types.set(type, def);
    if (pending && pending.type === type) { const p = pending; pending = null; show(p); }
  }

  function makeApi(o) {
    const offs = [];
    const api = {
      type: o.type, data: o.data, anchor: o.anchor, modal: o.modal, root: null,
      close() { hide(); fire('kosmo:overlay.close', {}); },
      resize() { scheduleResize(); },
      emit(name, data) { return fire('kosmo:overlay.event', { type: o.type, name, data }); },
      invoke, send: U.send, fire,
      on(channel, cb) { const off = on(channel, cb); offs.push(off); return off; },
      setAlign(a) { if (o.wrap && o.modal) o.wrap.dataset.align = a === 'top' ? 'top' : 'center'; },
      toast: U.toast, h, icon: U.icon,
      _offs: offs
    };
    return api;
  }

  function teardown() {
    if (!cur) return;
    const c = cur;
    cur = null;
    try { if (c.ro) c.ro.disconnect(); } catch (e) { /* ignore */ }
    for (const off of c.api._offs) { try { off(); } catch (e) { /* ignore */ } }
    try { if (c.def && c.def.onHide) c.def.onHide(c.api); } catch (e) { console.error('[overlay]', c.type, e); }
    U.clear(root);
    document.documentElement.classList.remove('modal');
  }

  function show(p) {
    if (!p || !p.type) return;
    const def = types.get(p.type);
    const modal = !!p.modal;
    if (cur && cur.type === p.type && cur.modal === modal && def && def.update) {
      cur.data = cur.api.data = p.data;
      cur.anchor = cur.api.anchor = p.anchor;
      try { def.update(p.data, cur.api); } catch (e) { console.error('[overlay]', p.type, e); }
      scheduleResize();
      return;
    }
    teardown();
    if (!def) {
      // фича ещё не загрузилась — подождём регистрацию, иначе покажем заглушку
      pending = p;
      setTimeout(() => { if (pending === p) { pending = null; types.set(p.type, unknownType(p.type)); show(p); types.delete(p.type); } }, 400);
      return;
    }
    const card = h('div.ov-card', { tabindex: '-1', dataset: { type: p.type } });
    if (def.className) card.className += ' ' + def.className;
    if (def.width) card.style.width = typeof def.width === 'number' ? def.width + 'px' : def.width;
    let wrap;
    if (modal) {
      wrap = h('div.ov-modal', { dataset: { align: def.align === 'top' ? 'top' : 'center' } }, card);
      document.documentElement.classList.add('modal');
    } else {
      wrap = h('div.ov-pop', card);
    }
    root.appendChild(wrap);
    const o = { type: p.type, def, data: p.data, anchor: p.anchor || null, modal, card, wrap, ro: null };
    o.api = makeApi(o);
    o.api.root = card;
    cur = o;
    try { def.render(card, p.data, o.api); } catch (e) {
      console.error('[overlay]', p.type, e);
      U.clear(card).appendChild(U.empty({ icon: 'alert-triangle', title: 'Окно не открылось', text: String(e && e.message || e), tone: 'error' }));
    }
    if (!modal) { o.ro = new ResizeObserver(scheduleResize); o.ro.observe(card); }
    measure();
    // фокус: элемент с autofocus или сама карточка (кроме omnibox и тоста — фокус остаётся, где был)
    if (p.type !== 'omnibox' && p.type !== 'toast') {
      requestAnimationFrame(() => {
        if (cur !== o) return;
        const af = card.querySelector('[autofocus]');
        (af || card).focus({ preventScroll: true });
      });
    }
  }

  // размер меряем таймером, не rAF: пока вид скрыт или окно перекрыто, кадры не идут, а main ждёт размер, чтобы показать вид
  let resizeTimer = 0, lastSize = '';
  function scheduleResize() {
    if (resizeTimer) return;
    resizeTimer = setTimeout(measure, 0);
  }
  function measure() {
    clearTimeout(resizeTimer);
    resizeTimer = 0;
    if (!cur || cur.modal) return;
    const r = cur.card.getBoundingClientRect();
    const width = Math.ceil(r.width) + PAD * 2, height = Math.ceil(r.height) + PAD * 2;
    const key = width + 'x' + height;
    if (key === lastSize) return;
    lastSize = key;
    fire('kosmo:overlay.resize', { width, height, inset: PAD });
  }

  function hide() { pending = null; lastSize = ''; teardown(); }

  function unknownType(type) {
    return {
      render(el) {
        el.style.width = '300px';
        el.appendChild(U.empty({ icon: 'info', title: 'Окно недоступно', text: 'Тип «' + type + '» не зарегистрирован.' }));
      }
    };
  }

  // клавиши и клик мимо
  document.addEventListener('keydown', (e) => {
    if (!cur) return;
    if (cur.def.onKey) { try { if (cur.def.onKey(e, cur.api) === true || e.defaultPrevented) return; } catch (err) { console.error(err); } }
    if (e.key === 'Escape') { e.preventDefault(); cur.api.close(); }
  }, true);
  document.addEventListener('pointerdown', (e) => {
    if (!cur) return;
    if (!cur.card.contains(e.target)) { e.preventDefault(); cur.api.close(); }
  }, true);

  on('kosmo:overlay.show', show);
  on('kosmo:overlay.hide', hide);
  // main.overlay.send(type, data) — новые данные для открытого окна
  on('kosmo:overlay.update', (p) => {
    if (!p || !cur || (p.type && p.type !== cur.type)) return;
    cur.data = cur.api.data = p.data;
    if (cur.def.update) { try { cur.def.update(p.data, cur.api); } catch (e) { console.error('[overlay]', cur.type, e); } }
    else { U.clear(cur.card); try { cur.def.render(cur.card, p.data, cur.api); } catch (e) { console.error('[overlay]', cur.type, e); } }
    scheduleResize();
  });
  on('kosmo:overlay.event', (e) => {
    if (!e || !cur || (e.type && e.type !== cur.type)) return;
    if (cur.def.onEvent) { try { cur.def.onEvent(e.name, e.data, cur.api); } catch (err) { console.error('[overlay]', cur.type, err); } }
  });

  // ---------- готовые части для фич ----------
  const ui = {
    header(title, api, extra) {
      return h('div.ov-head', h('div.ov-title.k-ellipsis', title), extra || null,
        api ? h('button.k-icon-btn.k-icon-btn-sm', { title: 'Закрыть (Esc)', html: window.KIcons.get('x', 14), onClick: () => api.close() }) : null);
    },
    // menu(items, {onPick}) — items: {id, icon, title, sub, meta, kbd, danger, disabled, onClick} | 'sep' | {label}
    // стрелки ↑↓ и Enter работают, когда карточка в фокусе
    menu(items, opts) {
      opts = opts || {};
      const list = h('div.ov-menu', { role: 'menu' });
      const btns = [];
      for (const it of items) {
        if (it === 'sep' || it === '-') { list.appendChild(h('div.ov-menu-sep')); continue; }
        if (it && it.label && !it.title) { list.appendChild(h('div.ov-menu-label.k-label', it.label)); continue; }
        const b = h('button.ov-menu-item' + (it.danger ? '.danger' : ''), { role: 'menuitem', disabled: !!it.disabled, tabindex: '-1' },
          it.icon ? U.icon(it.icon) : null,
          h('span.ov-mi-body', h('span.ov-mi-title', it.title), it.sub ? h('span.ov-mi-sub', it.sub) : null),
          it.meta ? h('span.ov-mi-meta', it.meta) : null,
          it.kbd ? (U.kbd ? U.kbd(it.kbd) : h('span.k-kbd', it.kbd)) : null);
        b.addEventListener('click', (e) => { if (it.onClick) it.onClick(e, it); if (opts.onPick) opts.onPick(it, e); });
        b.addEventListener('pointermove', () => setHl(btns.indexOf(b)));
        btns.push(b);
        list.appendChild(b);
      }
      let hl = -1;
      function setHl(i) {
        if (hl >= 0 && btns[hl]) btns[hl].classList.remove('hl');
        hl = i;
        if (hl >= 0 && btns[hl]) { btns[hl].classList.add('hl'); btns[hl].scrollIntoView({ block: 'nearest' }); }
      }
      list.addEventListener('keydown', (e) => {
        if (!btns.length) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); setHl((hl + 1) % btns.length); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setHl(hl <= 0 ? btns.length - 1 : hl - 1); }
        else if (e.key === 'Enter' && hl >= 0) { e.preventDefault(); btns[hl].click(); }
      });
      list.tabIndex = -1;
      list.setHighlight = setHl;
      return list;
    }
  };

  // Тост интерфейса (KUI.toast из chrome): немодальный, без фокуса, закрывается сам. Клик — закрыть.
  let toastTimer = 0;
  function toastRender(el, data, api) {
    clearTimeout(toastTimer);
    data = data || {};
    U.clear(el);
    el.dataset.tone = data.tone || '';
    el.appendChild(h('div.ov-toast-text', String(data.text || '')));
    el.onclick = () => api.close();
    toastTimer = setTimeout(() => { if (cur && cur.type === 'toast') api.close(); }, Number(data.ms) || 3000);
  }
  register('toast', {
    className: 'ov-toast',
    render: toastRender,
    update: (data, api) => toastRender(api.root, data, api),
    onHide() { clearTimeout(toastTimer); toastTimer = 0; }
  });
  // Тост, пока открыт другой поповер (main не заменяет его): обычный KUI.toast внутри слоя.
  on('kosmo:overlay.toast', (m) => { if (m && m.text) U.toast(m.text, { tone: m.tone || null, ms: m.ms }); });

  // тестовый тип для проверки слоя
  register('demo', {
    render(el, data, api) {
      data = data || {};
      el.style.width = (data.width || 320) + 'px';
      const menu = ui.menu([
        { icon: 'globe', title: 'Обычный пункт', sub: 'с подписью' },
        { icon: 'copy', title: 'Копировать', kbd: 'Ctrl+C' },
        'sep',
        { icon: 'trash', title: 'Удалить', danger: true }
      ], { onPick: (it) => { api.emit('pick', it.title); api.close(); } });
      el.append(
        ui.header(data.title || 'Проверка слоя', api),
        h('div.ov-body.k-dim', data.text || 'Всплывающее окно поверх страницы. Esc или клик мимо закрывает.'),
        menu,
        h('div.ov-foot',
          h('button.k-btn', { onClick: () => api.close() }, 'Отмена'),
          h('button.k-btn.k-btn-primary', { autofocus: true, onClick: () => { api.emit('ok', null); api.close(); } }, 'Готово')));
    },
    update(data, api) { api.root.querySelector('.ov-title').textContent = (data && data.title) || 'Проверка слоя'; },
    onEvent(name, data, api) { if (name === 'title') api.root.querySelector('.ov-title').textContent = String(data); }
  });

  window.KOverlay = {
    register,
    has: (type) => types.has(type),
    current: () => (cur ? { type: cur.type, data: cur.data, anchor: cur.anchor, modal: cur.modal } : null),
    close: () => { if (cur) cur.api.close(); },
    ui,
    PAD
  };
})();
