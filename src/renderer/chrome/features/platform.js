// Владелец: platform. Верх окна: кнопки действий расширений (<browser-action-list>), щит блокировщика
// и чип контейнера в адресной строке, полоса-запрос разрешений сайта под панелью.
'use strict';
(function () {
  const K = window.KChrome;
  const U = window.KUI;
  if (!K || !U) return;
  const { h } = U;
  U.css('features/platform.css');

  const I = window.KIcons;
  if (I && I.add) {
    if (!I.has('bell')) I.add('bell', '<path d="M10.27 21a2 2 0 0 0 3.46 0"/><path d="M3.26 15.33A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.67C19.41 13.96 18 12.5 18 8A6 6 0 0 0 6 8c0 4.5-1.41 5.96-2.74 7.33"/>');
    if (!I.has('map-pin')) I.add('map-pin', '<path d="M20 10c0 4.99-5.54 10.19-7.4 11.8a1 1 0 0 1-1.2 0C9.54 20.19 4 14.99 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>');
    if (!I.has('video')) I.add('video', '<path d="m16 13 5.22 3.48a.5.5 0 0 0 .78-.42V7.94a.5.5 0 0 0-.76-.43L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>');
    if (!I.has('mic')) I.add('mic', '<path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/>');
    if (!I.has('music')) I.add('music', '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>');
    if (!I.has('clipboard')) I.add('clipboard', '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>');
  }

  const isWeb = (url) => /^https?:\/\//i.test(url || '');
  const hostOf = (url) => { try { return new URL(url).hostname; } catch (e) { return ''; } };
  const warn = (e) => console.warn('[platform]', e && e.message ? e.message : e);

  // =====================================================================
  // Кнопки действий расширений
  // =====================================================================
  const actions = (function () {
    const toolbar = K.slot('toolbar-right');
    const wrap = h('div.kp-actions', { dataset: { order: '250' }, hidden: true });
    // место по порядку среди кнопок панели (загрузки — 300, Claude — 850, панель — 900, меню — 1000)
    const next = Array.from(toolbar.children).find((c) => Number(c.dataset.order || 500) > 250);
    toolbar.insertBefore(wrap, next || null);
    let list = null;
    let partition = '';
    let hasActions = false;
    let mo = null;

    function syncEmpty() {
      const n = list && list.shadowRoot ? list.shadowRoot.querySelectorAll('.action').length : 0;
      wrap.hidden = !n;
    }

    function mount(part) {
      if (list && partition === part) return;
      partition = part;
      if (mo) { mo.disconnect(); mo = null; }
      if (list) list.remove();
      if (!window.customElements || !customElements.get('browser-action-list')) { list = null; return; }
      // Новый элемент на смену контейнера: у <browser-action-list> подписка на обновления берётся при подключении.
      list = document.createElement('browser-action-list');
      list.setAttribute('partition', part);
      list.setAttribute('alignment', 'bottom left');
      wrap.appendChild(list);
      if (list.shadowRoot) {
        mo = new MutationObserver(syncEmpty);
        mo.observe(list.shadowRoot, { childList: true });
      }
      syncEmpty();
    }

    function unmount() {
      if (mo) { mo.disconnect(); mo = null; }
      if (list) { list.remove(); list = null; }
      partition = '';
      wrap.hidden = true;
    }

    function render() {
      if (!hasActions) { unmount(); return; }
      const a = K.activeTab();
      const cid = (a && a.containerId) || 'main';
      mount('persist:c-' + cid);
    }

    function apply(st) {
      hasActions = !!(st && st.ready && st.actions > 0);
      render();
    }

    U.on('kosmo:ext.changed', apply);
    K.on('active', render);
    const load = () => K.invoke('kosmo:ext.state', {}).then(apply).catch(() => {});
    if (K.ready && K.ready.then) K.ready.then(load); else load();
    return { render };
  })();

  // =====================================================================
  // Щит блокировщика
  // =====================================================================
  const shield = (function () {
    const counts = new Map(); // tabId → n
    let status = { enabled: true, ready: false };
    let allow = [];

    const btn = K.addOmniboxIcon({
      id: 'adblock', icon: 'shield', order: 700, hidden: true, title: 'Блокировщик рекламы',
      onClick: (e, b) => {
        const a = K.activeTab();
        if (!a) return;
        K.toggleOverlay('adblock', { tabId: a.id, url: a.url }, b.el, { align: 'end' });
      }
    });
    btn.el.classList.add('kp-shield');

    const norm = (s) => String(s || '').trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/^\*\./, '').replace(/^www\./, '');
    function allowed(host) {
      const local = host === 'localhost' || /\.localhost$/.test(host) || /^127\./.test(host) || host === '[::1]';
      return allow.some((e) => e && (host === e || host.endsWith('.' + e) || (e === 'localhost' && local)));
    }
    function readSettings(s) {
      const p = (s && s.privacy) || {};
      status.enabled = p.adblock !== false;
      allow = (Array.isArray(p.adblockAllow) ? p.adblockAllow : []).map(norm).filter(Boolean);
    }

    let lastKey = '';
    function render() {
      const a = K.activeTab();
      const web = !!(a && isWeb(a.url) && !a.error);
      const host = web ? hostOf(a.url).toLowerCase() : '';
      const off = !status.enabled || (host && allowed(host));
      const n = web ? counts.get(String(a.id)) || 0 : 0;
      const key = [web, host, off, n, status.ready].join('|');
      if (key === lastKey) return;
      lastKey = key;
      btn.setVisible(web);
      if (!web) return;
      // Без числа на иконке (в 8px оно нечитаемо и закрывало щит): щит с галочкой — что-то заблокировано,
      // само число — в подсказке и крупно в поповере.
      btn.setIcon(off ? 'shield-off' : n > 0 ? 'shield-check' : 'shield');
      btn.el.classList.toggle('off', !!off);
      btn.setBadge(null);
      const site = host.replace(/^www\./, '');
      btn.setTitle(!status.enabled ? 'Блокировщик рекламы выключен'
        : off ? 'Блокировка на ' + site + ' выключена'
          : n ? 'Заблокировано на странице: ' + n : 'Блокировщик рекламы: ' + site);
    }

    U.on('kosmo:adblock.counts', (p) => {
      if (!p || !p.changes) return;
      for (const k of Object.keys(p.changes)) counts.set(String(k), Number(p.changes[k]) || 0);
      render();
    });
    U.on('kosmo:adblock.status', (s) => { if (s) { status = Object.assign(status, s); render(); } });
    K.on('settings', (s) => { readSettings(s); render(); });
    K.on('state', (st) => {
      const ids = new Set((st && st.tabs || []).map((t) => String(t.id)));
      for (const k of Array.from(counts.keys())) if (!ids.has(k)) counts.delete(k);
      render();
    });
    K.on('active', render);
    const load = () => {
      readSettings(K.state.settings);
      K.invoke('kosmo:adblock.counts', {}).then((p) => {
        if (p && p.changes) for (const k of Object.keys(p.changes)) counts.set(String(k), Number(p.changes[k]) || 0);
        render();
      }).catch(() => {});
      K.invoke('kosmo:adblock.state', {}).then((s) => { if (s) { status = Object.assign(status, s); render(); } }).catch(() => {});
    };
    if (K.ready && K.ready.then) K.ready.then(load); else load();
    render();
    return { render };
  })();

  // =====================================================================
  // Чип контейнера в адресной строке
  // =====================================================================
  (function () {
    const dot = h('span.kp-cdot');
    const name = h('span.kp-cname.k-ellipsis');
    const chip = h('button.kp-container', { type: 'button', tabindex: '-1', hidden: true, dataset: { order: '1000', id: 'container' } }, dot, name);
    const slot = K.slot('omnibox-right');
    const next = Array.from(slot.children).find((c) => Number(c.dataset.order || 500) > 1000);
    slot.insertBefore(chip, next || null);
    chip.addEventListener('click', () => {
      const r = chip.getBoundingClientRect();
      K.fire('kosmo:containers.chipMenu', { x: Math.round(r.left), y: Math.round(r.bottom + 4) });
    });
    let key = '';
    function render() {
      const a = K.activeTab();
      const show = !!(a && a.containerId && a.containerId !== 'main');
      const k = show ? [a.containerId, a.containerName, a.containerColor].join('|') : '';
      if (k === key) return;
      key = k;
      chip.hidden = !show;
      if (!show) return;
      chip.style.setProperty('--kp-c', a.containerColor || 'var(--k-accent)');
      name.textContent = a.containerName || a.containerId;
      chip.title = 'Контейнер «' + (a.containerName || a.containerId) + '»: свои cookies и вход на сайты';
    }
    K.on('state', render);
    K.on('active', render);
    render();
  })();

  // =====================================================================
  // Полоса-запрос разрешения сайта
  // =====================================================================
  (function () {
    let items = [];
    let shownId = null;
    const remember = {}; // id запроса → состояние галки

    const icon = h('span.kp-perm-ic');
    const text = h('div.kp-perm-text');
    const more = h('span.kp-perm-more');
    const select = h('select.k-select.kp-perm-src', { 'aria-label': 'Что показать', hidden: true });
    const rememberBox = h('input.k-check', { type: 'checkbox', checked: true, 'aria-label': 'Запомнить решение для сайта' });
    const rememberLabel = h('label.kp-perm-remember', rememberBox, h('span', 'Запомнить'));
    const allowBtn = h('button.k-btn.k-btn-sm.k-btn-primary', { type: 'button' }, 'Разрешить');
    const denyBtn = h('button.k-btn.k-btn-sm', { type: 'button' }, 'Запретить');
    const closeBtn = h('button.k-icon-btn.k-icon-btn-sm', { type: 'button', title: 'Закрыть: запретить без запоминания', html: I.get('x', 14) });
    const el = h('div.kp-perm', { role: 'alertdialog', 'aria-live': 'polite' },
      icon, h('div.kp-perm-body', text, more), select, rememberLabel, denyBtn, allowBtn, closeBtn);
    const bar = K.addBar({ id: 'platform-permission', el, order: 60, hidden: true });

    rememberBox.addEventListener('change', () => { if (shownId) remember[shownId] = rememberBox.checked; });

    function respond(allow, rememberIt) {
      const it = items.find((x) => x.id === shownId);
      if (!it) return;
      const payload = { id: it.id, allow, remember: rememberIt };
      if (it.sources && allow) payload.sourceId = select.value;
      items = items.filter((x) => x.id !== it.id);
      render();
      K.invoke('kosmo:perm.respond', payload).catch(warn);
    }
    allowBtn.addEventListener('click', () => respond(true, rememberBox.checked));
    denyBtn.addEventListener('click', () => respond(false, rememberBox.checked));
    closeBtn.addEventListener('click', () => respond(false, false));

    function kindsText(kinds) {
      const labels = kinds.map((k) => k.label);
      if (labels.length <= 1) return labels[0] || '';
      return labels.slice(0, -1).join(', ') + ' и ' + labels[labels.length - 1];
    }

    function render() {
      const a = K.activeTab();
      const mine = a ? items.filter((x) => String(x.tabId) === String(a.id)) : [];
      const it = mine[0];
      if (!it) { shownId = null; bar.hide(); return; }
      if (it.id !== shownId) {
        shownId = it.id;
        U.clear(icon).appendChild(U.icon((it.kinds[0] && it.kinds[0].icon) || 'shield', 16));
        U.clear(text);
        const host = h('b', it.host || it.origin);
        if (it.external) {
          // полный адрес ссылки, а не только схема: видно, что именно получит приложение
          const full = it.externalUrl || it.external + ':';
          text.append(host, ' хочет открыть внешнее приложение: ', h('span.kp-perm-scheme', full.length > 90 ? full.slice(0, 90) + '…' : full));
          allowBtn.textContent = 'Открыть';
        } else if (it.sources) {
          text.append(host, ' хочет показать ваш экран');
          allowBtn.textContent = 'Показать';
        } else {
          text.append(host, ' запрашивает доступ: ', h('span.kp-perm-kind', kindsText(it.kinds)));
          allowBtn.textContent = 'Разрешить';
        }
        select.hidden = !it.sources;
        U.clear(select);
        if (it.sources) for (const s of it.sources) select.appendChild(h('option', { value: s.id }, s.name));
        rememberLabel.hidden = it.remember === false;
        rememberBox.checked = remember[it.id] !== undefined ? remember[it.id] : true;
        el.title = it.external && it.externalUrl ? it.externalUrl : it.origin;
      }
      more.textContent = mine.length > 1 ? 'ещё ' + (mine.length - 1) : '';
      more.hidden = mine.length < 2;
      bar.show();
    }

    U.on('kosmo:perm.queue', (p) => { items = (p && Array.isArray(p.items)) ? p.items : []; render(); });
    K.on('active', render);
    K.on('state', render);
    const load = () => K.invoke('kosmo:perm.queue', {}).then((p) => { items = (p && p.items) || []; render(); }).catch(() => {});
    if (K.ready && K.ready.then) K.ready.then(load); else load();
  })();
})();
