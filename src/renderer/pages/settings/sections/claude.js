// Владелец: claude-bridge (MCP, «Отправить в Claude») + поля встроенного терминала (claude.terminalCwd, claude.claudeCommand,
// claude.shell — их читает claude-terminal). Каналы: kosmo:bridge.status / setAccess / regenerateToken / command /
// connectClaudeCode / pickDir / openDir / clearActivity; событие kosmo:bridge.status.
'use strict';
KSettings.section({
  id: 'claude', title: 'Claude', icon: 'claude', order: 60,
  keywords: 'claude mcp токен порт доступ подключение claude code терминал inbox отправить элемент ии агент',
  description: 'Claude видит и управляет вкладками через MCP-сервер Космолёта, получает страницы через «Отправить в Claude» и работает во встроенном терминале.',
  render(el, api) {
    const ui = api.ui;
    const h = api.h;
    const U = window.KUI;
    U.css('sections/claude.css');

    let st = null;

    // ---------- доступ ----------
    const statusText = h('span.kcs-status');
    const statusRow = ui.row('Сервер MCP', statusText, null, { keywords: 'статус адрес' });
    el.append(ui.group('Доступ Claude к браузеру',
      ui.segmented('Режим', 'claude.access', [['off', 'Выключен'], ['read', 'Только чтение'], ['full', 'Полный']],
        'Чтение — вкладки, снимки страниц, HTML, скриншоты, сеть и консоль. Полный — ещё навигация, клики, ввод, JavaScript, запросы от имени страницы и cookies'),
      statusRow));

    // ---------- подключение ----------
    const portRow = ui.number('Порт', 'claude.mcpPort', { min: 1024, max: 65535, hint: 'Только 127.0.0.1. После смены порта подключите Claude Code заново' });
    const portNote = h('div.ks-row-hint.kcs-flag', { hidden: true });
    portRow.querySelector('.ks-row-text').appendChild(portNote);

    const tokenInput = h('input.k-input.k-mono.kcs-token', { type: 'password', readonly: true, spellcheck: 'false', 'aria-label': 'Токен' });
    const eyeBtn = h('button.k-icon-btn', { type: 'button', title: 'Показать токен' });
    eyeBtn.appendChild(api.icon('eye', 16));
    eyeBtn.addEventListener('click', () => {
      const show = tokenInput.type === 'password';
      tokenInput.type = show ? 'text' : 'password';
      eyeBtn.title = show ? 'Скрыть токен' : 'Показать токен';
      eyeBtn.textContent = '';
      eyeBtn.appendChild(api.icon(show ? 'eye-off' : 'eye', 16));
    });
    const copyTokenBtn = h('button.k-icon-btn', { type: 'button', title: 'Скопировать токен' });
    copyTokenBtn.appendChild(api.icon('copy', 16));
    copyTokenBtn.addEventListener('click', () => U.copyText(api.get('claude.token') || '', { message: 'Токен скопирован' }));
    const regenBtn = h('button.k-btn', { type: 'button' }, api.icon('rotate-cw', 14), 'Перевыпустить');
    const regenWarn = h('div.kcs-warn', { hidden: true },
      api.icon('alert-triangle', 16),
      h('div', h('div', 'Старый токен перестанет работать. Claude Code и встроенный терминал нужно будет подключить заново.'),
        h('div.kcs-warn-actions',
          h('button.k-btn.k-btn-danger.k-btn-sm', { type: 'button', onClick: regenerate }, 'Перевыпустить токен'),
          h('button.k-btn.k-btn-ghost.k-btn-sm', { type: 'button', onClick: () => { regenWarn.hidden = true; } }, 'Отмена'))));
    regenBtn.addEventListener('click', () => { regenWarn.hidden = !regenWarn.hidden; });
    const tokenRow = ui.row('Токен', [tokenInput, eyeBtn, copyTokenBtn, regenBtn], 'Claude Code передаёт его в заголовке Authorization: Bearer', { keywords: 'bearer authorization' });
    ui.watch('claude.token', (v) => { tokenInput.value = v || ''; });

    async function regenerate() {
      regenWarn.hidden = true;
      try {
        st = await api.invoke('kosmo:bridge.regenerateToken', {});
        renderStatus();
        refreshCommand();
        api.toast('Новый токен выпущен — подключите Claude Code заново', { tone: 'ok', ms: 3500 });
      } catch (e) { api.toast('Не удалось: ' + errMsg(e), { tone: 'danger' }); }
    }

    // команда и подключение
    const cmdBox = h('code.kcs-cmd.k-mono');
    const showCmd = h('button.k-btn.k-btn-ghost.k-btn-sm', { type: 'button' }, 'Показать');
    const copyCmd = h('button.k-btn.k-btn-sm', { type: 'button' }, api.icon('copy', 14), 'Скопировать');
    let fullCmd = '';
    let cmdShown = false;
    function maskCmd(s) { return s.replace(/(Bearer )([0-9a-f]+)/i, (_m, a, t) => a + t.slice(0, 4) + '…' + t.slice(-4)); }
    function paintCmd() { cmdBox.textContent = fullCmd ? (cmdShown ? fullCmd : maskCmd(fullCmd)) : '—'; showCmd.textContent = cmdShown ? 'Скрыть токен' : 'Показать'; }
    showCmd.addEventListener('click', () => { cmdShown = !cmdShown; paintCmd(); });
    copyCmd.addEventListener('click', () => { if (fullCmd) U.copyText(fullCmd, { message: 'Команда скопирована' }); });
    async function refreshCommand() {
      try { const r = await api.invoke('kosmo:bridge.command', {}); fullCmd = r.command || ''; configPath.textContent = r.configPath || ''; } catch (_) { fullCmd = ''; }
      paintCmd();
    }
    const cmdRow = ui.row('Команда для терминала', h('div.kcs-cmd-wrap', cmdBox, h('div.kcs-cmd-actions', showCmd, copyCmd)),
      'Выполните её сами, если кнопка выше не сработала', { stack: true, keywords: 'claude mcp add команда' });

    const connectBtn = h('button.k-btn.k-btn-primary', { type: 'button' }, api.icon('terminal', 14), 'Подключить к Claude Code');
    const connectOut = h('pre.kcs-out', { hidden: true });
    connectBtn.addEventListener('click', async () => {
      connectBtn.disabled = true;
      const label = Array.from(connectBtn.childNodes);
      connectBtn.textContent = '';
      connectBtn.append(h('span.k-spinner'), 'Подключаю…');
      try {
        const r = await api.invoke('kosmo:bridge.connectClaudeCode', {});
        connectOut.hidden = false;
        connectOut.dataset.tone = r.ok ? 'ok' : 'danger';
        connectOut.textContent = (r.ok ? 'Готово. Перезапустите сессию Claude Code — появятся инструменты kosmolet.\n\n' : '') + (r.output || '');
      } catch (e) {
        connectOut.hidden = false;
        connectOut.dataset.tone = 'danger';
        connectOut.textContent = 'Не удалось: ' + errMsg(e);
      } finally {
        connectBtn.disabled = false;
        connectBtn.textContent = '';
        connectBtn.append(...label);
      }
    });
    const connectRow = ui.row('Claude Code', connectBtn,
      'Добавит сервер kosmolet для всех проектов: claude mcp add --scope user. Если он уже есть — заменит', { keywords: 'подключить claude code mcp add' });

    const configPath = h('code.kcs-path.k-mono');
    const copyConfig = h('button.k-icon-btn', { type: 'button', title: 'Скопировать путь' });
    copyConfig.appendChild(api.icon('copy', 16));
    copyConfig.addEventListener('click', () => U.copyText(configPath.textContent, { message: 'Путь скопирован' }));
    const configRow = ui.row('Файл для --mcp-config', h('div.kcs-inline', configPath, copyConfig),
      'Его использует встроенный терминал: claude --mcp-config <файл>', { stack: true, keywords: 'mcp-config json' });

    // Codex (OpenAI): кнопка пишет в ~/.codex/config.toml только таблицу [mcp_servers.kosmolet] (bridge/codex.js)
    const codexBtn = h('button.k-btn', { type: 'button' }, api.icon('terminal', 14), 'Подключить к Codex');
    const codexOut = h('pre.kcs-out', { hidden: true });
    codexBtn.addEventListener('click', async () => {
      codexBtn.disabled = true;
      const label = Array.from(codexBtn.childNodes);
      codexBtn.textContent = '';
      codexBtn.append(h('span.k-spinner'), 'Подключаю…');
      try {
        const r = await api.invoke('kosmo:bridge.connectCodex', {});
        codexOut.dataset.tone = r.ok ? 'ok' : 'danger';
        codexOut.textContent = (r.output || '').split(/Bearer [0-9a-f]+/i).join('Bearer <token>');
      } catch (e) {
        codexOut.dataset.tone = 'danger';
        codexOut.textContent = 'Не удалось: ' + errMsg(e);
      } finally {
        codexOut.hidden = false;
        codexBtn.disabled = false;
        codexBtn.textContent = '';
        codexBtn.append(...label);
      }
    });
    api.invoke('kosmo:bridge.codexInfo', {}).then((i) => { codexBtn.title = i.found ? 'Codex: ' + i.path : 'Сам codex не найден — для приложения Codex это не важно'; }).catch(() => {});
    const codexRow = ui.row('Codex', codexBtn,
      'Добавит сервер kosmolet в ~/.codex/config.toml — общий для приложения Codex, CLI и плагинов. Остальное в файле не трогает', { keywords: 'codex openai подключить mcp config.toml' });

    el.append(ui.group('Подключение', connectRow, codexRow, cmdRow, portRow, tokenRow, ui.free(regenWarn), configRow));
    codexRow.after(codexOut); // вывод кнопки — сразу под строкой, пока скрыт — места не занимает
    regenWarn.parentElement.classList.add('kcs-warn-holder');

    // ---------- «Отправить в Claude» ----------
    const inboxPath = h('code.kcs-path.k-mono');
    const pickInbox = h('button.k-btn', { type: 'button' }, api.icon('folder', 14), 'Выбрать…');
    const openInbox = h('button.k-icon-btn', { type: 'button', title: 'Открыть папку' });
    openInbox.appendChild(api.icon('external-link', 16));
    const resetInbox = h('button.k-btn.k-btn-ghost.k-btn-sm', { type: 'button', hidden: true }, 'По умолчанию');
    pickInbox.addEventListener('click', () => api.invoke('kosmo:bridge.pickDir', { kind: 'inboxDir' }).then(loadStatus).catch((e) => api.toast(errMsg(e), { tone: 'danger' })));
    openInbox.addEventListener('click', () => api.invoke('kosmo:bridge.openDir', { kind: 'inboxDir' }).catch((e) => api.toast('Не открылась: ' + errMsg(e), { tone: 'danger' })));
    resetInbox.addEventListener('click', () => api.set('claude.inboxDir', '').then(loadStatus).catch(() => {}));
    el.append(ui.group('Отправить в Claude',
      ui.row('Папка для файлов', h('div.kcs-inline', inboxPath, openInbox, pickInbox, resetInbox),
        'Ctrl+Shift+Y сохраняет страницу в markdown: адрес, выделение, выбранный элемент, текст и последние запросы API. Имя файла — дата и сайт', { stack: true, keywords: 'inbox папка markdown отправить' }),
      ui.free(h('div.kcs-keys',
        h('div', h('span.k-kbd', 'Ctrl+Shift+Y'), ' отправить страницу'),
        h('div', h('span.k-kbd', 'Ctrl+Shift+E'), ' показать Claude элемент: наведите и щёлкните, Esc — отмена'),
        h('div.k-faint', 'То же — в контекстном меню страницы и в меню «⋯».')))));

    // ---------- терминал ----------
    const cwdInput = h('input.k-input.ks-text.k-mono', { type: 'text', spellcheck: 'false', 'aria-label': 'Рабочая папка' });
    const pickCwd = h('button.k-btn', { type: 'button' }, api.icon('folder', 14), 'Выбрать…');
    pickCwd.addEventListener('click', () => api.invoke('kosmo:bridge.pickDir', { kind: 'terminalCwd' }).catch((e) => api.toast(errMsg(e), { tone: 'danger' })));
    ui.watch('claude.terminalCwd', (v) => { if (document.activeElement !== cwdInput) cwdInput.value = v || ''; });
    cwdInput.addEventListener('change', () => api.set('claude.terminalCwd', cwdInput.value.trim()).catch(() => {}));
    const cwdRow = ui.row('Рабочая папка', h('div.kcs-inline.kcs-grow', cwdInput, pickCwd), 'Где запускается терминал. Пусто — Рабочий стол', { stack: true, keywords: 'cwd папка терминал' });

    el.append(ui.group('Встроенный терминал',
      cwdRow,
      ui.text('Команда claude', 'claude.claudeCommand', { mono: true, placeholder: 'claude', hint: 'Имя или полный путь к Claude Code. Используется и кнопкой «Подключить»' }),
      ui.text('Команда codex', 'claude.codexCommand', { mono: true, placeholder: 'искать самим', hint: 'Пусто — PATH, потом приложение Codex (%LOCALAPPDATA%\\OpenAI\\Codex\\bin). Или полный путь к codex.exe' }),
      ui.segmented('Оболочка', 'claude.shell', [['powershell', 'PowerShell'], ['cmd', 'cmd'], ['bash', 'Git Bash']], 'В какой оболочке открывается терминал')));

    // ---------- журнал ----------
    const clearBtn = h('button.k-btn', { type: 'button' }, api.icon('trash', 14), 'Очистить');
    clearBtn.addEventListener('click', () => api.invoke('kosmo:bridge.clearActivity', {}).then(() => api.toast('Журнал очищен', { tone: 'ok' })).catch((e) => api.toast(errMsg(e), { tone: 'danger' })));
    const callsText = h('span.k-faint');
    el.append(ui.group('Журнал действий',
      ui.row('Действия Claude', h('div.kcs-inline', callsText, clearBtn), 'Последние 500 вызовов с аргументами (без секретов). Смотреть — панель Claude → «Журнал»', { keywords: 'журнал история действий' })));

    // ---------- состояние ----------
    function errMsg(e) { return String((e && e.message) || e || '').replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ''); }
    function renderStatus() {
      if (!st) { statusText.textContent = 'нет данных'; statusText.dataset.tone = 'danger'; return; }
      let text, tone;
      if (st.access === 'off') { text = 'Выключен'; tone = 'off'; }
      else if (st.error) { text = 'Не запущен: ' + st.error; tone = 'danger'; }
      else if (st.listening) { text = 'Работает · ' + st.url; tone = 'ok'; }
      else { text = 'Запускается…'; tone = 'off'; }
      statusText.textContent = text;
      statusText.dataset.tone = tone;
      portNote.hidden = !st.portFromFlag;
      portNote.textContent = st.portFromFlag ? `Сейчас порт ${st.port} задан флагом --mcp-port и главнее настройки.` : '';
      inboxPath.textContent = st.inboxDir || '';
      inboxPath.title = st.inboxDir || '';
      resetInbox.hidden = !st.inboxCustom;
      cwdInput.placeholder = st.desktopDir || 'Рабочий стол';
      connectBtn.disabled = st.access === 'off';
      callsText.textContent = st.lastCallAt ? 'последнее — ' + U.timeAgo(st.lastCallAt) : 'пока не было';
    }
    async function loadStatus() {
      try { st = await api.invoke('kosmo:bridge.status', {}); } catch (_) { st = null; }
      renderStatus();
    }
    U.on('kosmo:bridge.status', (s) => { if (s) { st = s; renderStatus(); } });
    api.on((_s, path) => {
      if (!path || path === 'claude' || /^claude\.(mcpPort|token|access|claudeCommand)$/.test(path)) refreshCommand();
      if (!path || path === 'claude' || /^claude\.(inboxDir|mcpPort|access)$/.test(path)) loadStatus();
    });
    loadStatus();
    refreshCommand();
  }
});
