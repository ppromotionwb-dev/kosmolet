// Владелец: claude-bridge. Поповер 'claude' под кнопкой Claude: режим доступа MCP (Выкл / Чтение / Полный),
// адрес сервера, последние 8 действий Claude, подключение к Claude Code, команда для копирования, журнал.
// Данные: kosmo:bridge.status / kosmo:bridge.activity; живые обновления — события с теми же именами.
'use strict';
(function () {
  if (!window.KOverlay) return;
  const U = window.KUI;
  const { h } = U;
  U.css('features/claude.css');

  const MODES = [['off', 'Выкл'], ['read', 'Чтение'], ['full', 'Полный']];
  const HINT = {
    off: 'Сервер выключен — Claude не видит браузер.',
    read: 'Claude читает страницы, сеть и консоль, но ничего не нажимает.',
    full: 'Claude читает и действует: вкладки, клики, ввод, запросы.',
  };
  const LIMIT = 8;

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function hms(ts) { const d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
  function brief(e) {
    const a = e.args || {};
    if (e.tool === 'pick_element') return a.selector ? String(a.selector) : 'выбор элемента';
    if (e.tool === 'send_to_claude') return a.url || 'страница';
    const v = a.url || a.ref || a.selector || a.text || a.keys || a.code || a.id || a.filter || a.direction || '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  }
  const TOOL_RU = { pick_element: 'элемент', send_to_claude: 'отправка' };

  KOverlay.register('claude', {
    width: 360,
    className: 'kcl-pop',
    render(root, data, api) {
      let st = (data && data.status) || null;
      let items = [];

      const pill = h('span.kcl-pill');
      const urlText = h('span.kcl-url.k-mono.k-ellipsis');
      const copyUrl = h('button.k-icon-btn.k-icon-btn-sm', { type: 'button', title: 'Скопировать адрес сервера', html: window.KIcons.get('copy', 14) });
      copyUrl.addEventListener('click', () => { if (st) U.copyText(st.url, { toast: false }).then(() => flash(copyUrl)); });

      const head = h('div.kcl-head',
        h('div.kcl-logo', U.icon('claude', 18)),
        h('div.kcl-head-text',
          h('div.kcl-title', 'Claude', pill),
          h('div.kcl-sub', urlText, copyUrl)));

      // режим доступа
      const seg = h('div.k-seg.kcl-seg', { role: 'radiogroup', 'aria-label': 'Доступ Claude' });
      const segBtns = MODES.map(([v, label]) => {
        const b = h('button', { type: 'button', role: 'radio', dataset: { v } }, label);
        b.addEventListener('click', () => setAccess(v));
        seg.appendChild(b);
        return b;
      });
      const hint = h('div.kcl-hint');
      const accessRow = h('div.kcl-section', h('div.kcl-row', h('span.kcl-label', 'Доступ'), seg), hint);

      // журнал
      const list = h('div.kcl-list');
      const logBtn = h('button.k-btn.k-btn-ghost.k-btn-sm', { type: 'button' }, 'Журнал');
      logBtn.addEventListener('click', () => { U.invoke('kosmo:bridge.openLog', {}).catch(() => {}); api.close(); });
      const actSection = h('div.kcl-section', h('div.kcl-row.kcl-row-tight', h('span.kcl-label', 'Последние действия'), logBtn), list);

      // подключение
      const connectBtn = h('button.k-btn.k-btn-primary.k-btn-sm', { type: 'button' }, U.icon('terminal', 14), 'Подключить к Claude Code');
      const copyCmd = h('button.k-btn.k-btn-sm', { type: 'button', title: 'Команда claude mcp add с адресом и токеном' }, U.icon('copy', 14), 'Команда');
      const out = h('pre.kcl-out', { hidden: true });
      connectBtn.addEventListener('click', connect);
      copyCmd.addEventListener('click', async () => {
        try {
          const r = await U.invoke('kosmo:bridge.command', {});
          await U.copyText(r.command, { toast: false });
          flash(copyCmd, 'Скопировано');
        } catch (e) { showOut('Не удалось: ' + e.message, 'danger'); }
      });
      const connSection = h('div.kcl-section', h('div.kcl-actions', connectBtn, copyCmd), out);

      // быстрые действия
      const pickBtn = h('button.kcl-quick', { type: 'button', title: 'Выбрать элемент на странице и передать Claude' }, U.icon('picker', 14), h('span', 'Показать элемент'), h('span.k-kbd', 'Ctrl+Shift+E'));
      const sendBtn = h('button.kcl-quick', { type: 'button', title: 'Сохранить страницу в markdown для Claude' }, U.icon('send', 14), h('span', 'Отправить страницу'), h('span.k-kbd', 'Ctrl+Shift+Y'));
      pickBtn.addEventListener('click', () => { api.close(); U.invoke('kosmo:commands.run', { id: 'claude.pickElement' }).catch(() => {}); });
      sendBtn.addEventListener('click', () => { api.close(); U.invoke('kosmo:commands.run', { id: 'claude.sendPage' }).catch(() => {}); });
      const quick = h('div.kcl-foot', pickBtn, sendBtn);

      root.append(head, accessRow, actSection, connSection, quick);

      function flash(btn, text) {
        btn.classList.add('kcl-done');
        let prev = null;
        if (text) { prev = Array.from(btn.childNodes); btn.textContent = ''; btn.append(U.icon('check', 14), text); }
        setTimeout(() => { btn.classList.remove('kcl-done'); if (prev) { btn.textContent = ''; btn.append(...prev); } }, 1400);
      }
      function showOut(text, tone) {
        out.hidden = false;
        out.textContent = text;
        if (tone) out.dataset.tone = tone; else delete out.dataset.tone;
        api.resize();
      }

      async function setAccess(v) {
        if (st && st.access === v) return;
        if (st) { st.access = v; renderStatus(); }
        try { st = await U.invoke('kosmo:bridge.setAccess', { access: v }); renderStatus(); } catch (e) { showOut('Не сохранилось: ' + e.message, 'danger'); }
      }

      async function connect() {
        connectBtn.disabled = true;
        const label = Array.from(connectBtn.childNodes);
        connectBtn.textContent = '';
        connectBtn.append(h('span.k-spinner'), 'Подключаю…');
        try {
          const r = await U.invoke('kosmo:bridge.connectClaudeCode', {});
          showOut((r.ok ? 'Готово. Перезапустите сессию Claude Code, чтобы появились инструменты kosmolet.\n' : '') + (r.output || ''), r.ok ? 'ok' : 'danger');
        } catch (e) {
          showOut('Не удалось: ' + e.message, 'danger');
        } finally {
          connectBtn.disabled = false;
          connectBtn.textContent = '';
          connectBtn.append(...label);
        }
      }

      function renderStatus() {
        const mode = !st ? 'off' : st.access;
        let tone = 'off', text = 'Выключен';
        if (st && st.error) { tone = 'danger'; text = 'Ошибка'; }
        else if (st && st.listening && mode !== 'off') { tone = mode; text = mode === 'read' ? 'Только чтение' : 'Работает'; }
        pill.textContent = text;
        pill.dataset.tone = tone;
        urlText.textContent = st ? st.url.replace(/^http:\/\//, '') : '—';
        urlText.title = st ? st.url : '';
        for (const b of segBtns) {
          const on = b.dataset.v === mode;
          b.classList.toggle('active', on);
          b.setAttribute('aria-checked', on ? 'true' : 'false');
        }
        hint.textContent = st && st.error ? 'Сервер не запустился: ' + st.error + '. Смените порт в настройках.' : HINT[mode] || '';
        hint.dataset.tone = st && st.error ? 'danger' : '';
        connectBtn.disabled = !st || mode === 'off';
        root.classList.toggle('off', mode === 'off');
      }

      function renderList() {
        U.clear(list);
        const rows = items.slice(-LIMIT).reverse();
        if (!rows.length) {
          list.appendChild(h('div.kcl-empty', 'Claude ещё ничего не делал в браузере.'));
          return;
        }
        for (const e of rows) {
          const bad = e.ok === false;
          const row = h('div.kcl-item' + (bad ? '.bad' : ''), { title: bad && e.error ? e.error : '' },
            h('span.kcl-time', hms(e.ts)),
            h('span.kcl-tool.k-mono', TOOL_RU[e.tool] || e.tool),
            h('span.kcl-arg.k-ellipsis', brief(e)),
            h('span.kcl-ms', e.tabId != null ? '#' + e.tabId : ''),
            U.icon(bad ? 'x' : 'check', 13));
          list.appendChild(row);
        }
      }

      renderStatus();
      list.appendChild(h('div.kcl-empty', h('span.k-spinner'), 'Загрузка…'));
      Promise.all([
        U.invoke('kosmo:bridge.status', {}).catch(() => null),
        U.invoke('kosmo:bridge.activity', { limit: LIMIT }).catch(() => null),
      ]).then(([s, a]) => {
        if (s) st = s;
        items = Array.isArray(a) ? a : [];
        renderStatus();
        if (!a) { U.clear(list); list.appendChild(h('div.kcl-empty.bad', 'Журнал недоступен.')); } else renderList();
        api.resize();
      });

      api.on('kosmo:bridge.status', (s) => { if (s) { st = s; renderStatus(); } });
      api.on('kosmo:bridge.activity', (p) => {
        if (!p) return;
        if (p.cleared) items = [];
        else if (p.entry) { items.push(p.entry); if (items.length > 50) items.splice(0, items.length - 50); }
        renderList();
        api.resize();
      });
    }
  });
})();
