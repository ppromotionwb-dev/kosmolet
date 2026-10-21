// Владелец: claude-terminal. Инструмент «Claude»: вкладки «Терминал» (xterm + node-pty в main, kosmo:term.*)
// и «Журнал» (действия Claude в браузере — данные claude-bridge: kosmo:bridge.status / kosmo:bridge.activity).
// xterm 6 (UMD) и addon-fit грузятся лениво из kosmo://ui/vendor/ при первом показе инструмента.
'use strict';
(function () {
  if (!window.KPanel) return;
  const U = window.KUI;
  const { h } = U;
  U.css('tools/claude.css');

  const VENDOR = '/vendor/@xterm/';
  const FONT = '"Cascadia Code", "Cascadia Mono", Consolas, monospace';
  const PROFILES = [
    { id: 'claude', title: 'Claude', icon: 'claude', hint: 'claude --mcp-config' },
    { id: 'powershell', title: 'PowerShell', icon: 'terminal' },
    { id: 'cmd', title: 'cmd', icon: 'terminal' },
    { id: 'bash', title: 'Git Bash', icon: 'terminal' }
  ];
  const TOOL_RU = { pick_element: 'элемент', send_to_claude: 'отправка' };
  const LOG_LIMIT = 300;
  const LS = 'kosmo.claude.';
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(LS + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch (e) { /* нет хранилища */ } }
  };
  const errMsg = (e) => String((e && e.message) || e || 'ошибка').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  const noHandler = (e) => /No handler registered/i.test(String(e && e.message));

  // ---------- xterm: ленивая загрузка ----------
  let xtermPromise = null;
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('не загрузился ' + src));
      document.head.appendChild(s);
    });
  }
  function loadXterm() {
    if (!xtermPromise) {
      U.css(VENDOR + 'xterm/css/xterm.css');
      xtermPromise = loadScript(VENDOR + 'xterm/lib/xterm.js')
        .then(() => loadScript(VENDOR + 'addon-fit/lib/addon-fit.js'))
        .then(() => {
          const T = window.Terminal;
          const F = window.FitAddon && (window.FitAddon.FitAddon || window.FitAddon);
          if (typeof T !== 'function' || typeof F !== 'function') throw new Error('xterm не инициализировался');
          return { Terminal: T, FitAddon: F };
        });
      xtermPromise.catch(() => { xtermPromise = null; });
    }
    return xtermPromise;
  }

  // ---------- цвета: CSS-переменные → цвета xterm ----------
  const cv = document.createElement('canvas');
  cv.width = cv.height = 1;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const hex2 = (n) => (n < 16 ? '0' : '') + n.toString(16);
  // любая CSS-краска (color-mix, oklab…) → #rrggbb / rgba()
  function toColor(c) {
    cx.clearRect(0, 0, 1, 1);
    cx.fillStyle = '#000';
    cx.fillStyle = c;
    cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data;
    if (d[3] === 255) return '#' + hex2(d[0]) + hex2(d[1]) + hex2(d[2]);
    return 'rgba(' + d[0] + ', ' + d[1] + ', ' + d[2] + ', ' + (d[3] / 255).toFixed(3) + ')';
  }
  const ANSI = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];

  function fmtTime(ts) {
    const d = new Date(ts), now = new Date();
    const p = (n) => (n < 10 ? '0' : '') + n;
    const t = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    return d.toDateString() === now.toDateString() ? t : U.formatDate(ts) + ' ' + t.slice(0, 5);
  }
  function fmtMs(ms) {
    if (ms == null || isNaN(ms)) return '';
    if (ms < 1000) return Math.round(ms) + ' мс';
    return (ms / 1000).toFixed(ms < 10000 ? 1 : 0).replace('.', ',') + ' с';
  }
  function brief(e) {
    const a = e.args || {};
    if (e.tool === 'pick_element') return a.selector ? String(a.selector) : 'выбор элемента';
    if (e.tool === 'send_to_claude') return a.url || 'страница';
    const v = a.url || a.ref || a.selector || a.text || a.keys || a.code || a.query || a.id || a.filter || a.direction || '';
    if (v) return typeof v === 'string' ? v : JSON.stringify(v);
    const keys = Object.keys(a);
    if (!keys.length) return '';
    return keys.slice(0, 3).map((k) => k + '=' + (typeof a[k] === 'string' ? a[k] : JSON.stringify(a[k]))).join(', ');
  }

  let app = null;

  KPanel.register({
    id: 'claude', title: 'Claude', icon: 'claude', order: 50,
    mount(el, api) { app = createApp(el, api); },
    onShow() { if (app) app.shown(true); },
    onHide() { if (app) app.shown(false); }
  });

  function createApp(el, api) {
    el.classList.add('kc');
    const st = {
      view: ls.get('view', 'terminal') === 'log' ? 'log' : 'terminal',
      visible: api.isVisible(),
      sessions: new Map(), order: [], activeId: null,
      attaching: new Map(), orphans: new Map(), pendingCreate: 0, starting: false,
      info: null, infoError: null, loaded: false, wantFocus: false,
      bridge: null, bridgeMissing: false, logLoaded: false, logLoading: false, logError: null, entries: [],
      theme: null
    };

    // ---------- разметка ----------
    const iconBtn = (icon, title, onClick) => {
      const b = h('button.k-icon-btn', { type: 'button', title, 'aria-label': title, html: window.KIcons.get(icon, 16) });
      b.addEventListener('click', onClick);
      return b;
    };
    const tabTerm = h('button.kc-vtab', { type: 'button', role: 'tab' }, 'Терминал');
    const logDot = h('span.kc-vtab-dot', { hidden: true });
    const tabLog = h('button.kc-vtab', { type: 'button', role: 'tab' }, 'Журнал', logDot);
    tabTerm.addEventListener('click', () => setView('terminal'));
    tabLog.addEventListener('click', () => setView('log'));
    const restartBtn = iconBtn('rotate-cw', 'Перезапустить сессию', () => restartActive());
    const cwdBtn = iconBtn('folder', 'Рабочая папка', () => pickCwd());
    const clearBtn = iconBtn('trash', 'Очистить журнал', () => clearLog());
    const termActions = h('div.kc-actions', restartBtn, cwdBtn);
    const logActions = h('div.kc-actions', clearBtn);
    const bar = h('div.kc-bar', h('div.kc-vtabs', { role: 'tablist', 'aria-label': 'Claude' }, tabTerm, tabLog), h('div.kc-grow'), termActions, logActions);

    const strip = h('div.kc-strip', { role: 'tablist', 'aria-label': 'Сессии терминала' });
    const addBtn = h('button.kc-add', { type: 'button', title: 'Новая сессия', 'aria-haspopup': 'menu' }, U.icon('plus', 14), U.icon('chevron-down', 12));
    addBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleMenu(); });
    const stripRow = h('div.kc-strip-row', { hidden: true }, strip, addBtn);
    const emptyEl = h('div.kc-empty', h('span.k-spinner'));
    const stage = h('div.kc-stage.empty', emptyEl);
    const probe = h('span.kc-probe', { 'aria-hidden': 'true' });
    const termPane = h('div.kc-pane', stripRow, stage, probe);

    const statusEl = h('div.kc-status');
    const logList = h('div.kc-log', { role: 'list' });
    const logEmpty = h('div.kc-log-empty', { hidden: true });
    const logScroll = h('div.kc-log-scroll', logList, logEmpty);
    const logPane = h('div.kc-pane', statusEl, logScroll);

    const root = h('div.kc-root', bar, termPane, logPane);
    el.appendChild(root);

    // ---------- вид: терминал / журнал ----------
    function setView(v) {
      st.view = v;
      ls.set('view', v);
      tabTerm.setAttribute('aria-selected', String(v === 'terminal'));
      tabLog.setAttribute('aria-selected', String(v === 'log'));
      termPane.hidden = v !== 'terminal';
      logPane.hidden = v !== 'log';
      termActions.hidden = v !== 'terminal';
      logActions.hidden = v !== 'log';
      closeMenu();
      if (v === 'log') {
        logDot.hidden = true;
        if (!st.logLoaded) loadLog();
      } else {
        termShown(st.wantFocus);
      }
    }
    const termVisible = () => st.visible && st.view === 'terminal';

    // ---------- сведения (папка, профили, claude) ----------
    async function loadInfo() {
      try {
        st.info = await U.invoke('kosmo:term.info', {});
        st.infoError = null;
      } catch (e) { st.infoError = noHandler(e) ? 'Терминал недоступен: модуль не загружен.' : errMsg(e); }
      renderEmpty();
      updateChrome();
    }
    const refreshInfo = U.debounce(loadInfo, 150);

    function linkBtn(text, onClick, disabled, title) {
      const b = h('button.kc-link', { type: 'button', disabled: !!disabled, title: title || null }, text);
      b.addEventListener('click', onClick);
      return b;
    }

    function renderEmpty() {
      U.clear(emptyEl);
      if (st.infoError) {
        emptyEl.appendChild(U.empty({ icon: 'alert-triangle', title: 'Терминал не запускается', text: st.infoError, tone: 'error' }));
        return;
      }
      const i = st.info;
      if (!i) { emptyEl.appendChild(h('span.k-spinner')); return; }
      let text;
      if (!i.mcp) text = 'Мост MCP выключен — Claude запустится без доступа к браузеру. Включить его можно кнопкой Claude на панели.';
      else if (i.access === 'read') text = 'Claude Code подключится к Космолёту по MCP: будет видеть вкладки, сеть и консоль, но ничего не нажимать.';
      else text = 'Claude Code подключится к Космолёту по MCP: будет видеть вкладки, сеть и консоль и сможет действовать в браузере.';
      const startBtn = h('button.k-btn.k-btn-primary.kc-start', { type: 'button' }, U.icon('claude', 16), 'Запустить Claude');
      startBtn.addEventListener('click', () => start('claude'));
      const shells = [];
      for (const p of PROFILES) {
        if (p.id === 'claude') continue;
        const avail = (i.profiles || []).find((x) => x.id === p.id);
        if (shells.length) shells.push(h('span.kc-sep', '·'));
        shells.push(linkBtn(p.title, () => start(p.id), avail && !avail.available, avail && !avail.available ? 'Не найден' : null));
      }
      emptyEl.append(
        h('div.kc-empty-icon', U.icon('claude', 26, { stroke: 1.5 })),
        h('div.kc-empty-title', 'Claude Code в браузере'),
        h('div.kc-empty-text', text),
        startBtn,
        h('div.kc-cwd', h('span', 'Работает в:'), h('span.kc-cwd-path', { title: i.cwd }, i.cwdDisplay || i.cwd), h('span.kc-sep', '·'), linkBtn('сменить', () => pickCwd())),
        h('div.kc-shells', h('span', 'Или оболочка:'), shells)
      );
      if (i.cwdMissing) emptyEl.appendChild(h('div.kc-note', 'Папка из настроек не найдена — используется Рабочий стол.'));
      if (!i.claudeFound) {
        emptyEl.appendChild(h('div.kc-warn', U.icon('alert-triangle', 14),
          h('span', 'Команда «' + i.claudeCommand + '» не найдена. Установите Claude Code (npm i -g @anthropic-ai/claude-code) или укажите путь в настройках, раздел «Claude».')));
      }
    }

    function updateChrome() {
      const has = st.sessions.size > 0;
      stripRow.hidden = !has;
      emptyEl.hidden = has;
      stage.classList.toggle('empty', !has);
      const a = active();
      restartBtn.disabled = !a;
      const i = st.info;
      cwdBtn.title = i ? 'Рабочая папка: ' + (i.cwdDisplay || i.cwd) + ' (для новых сессий)' : 'Рабочая папка';
      cwdBtn.setAttribute('aria-label', cwdBtn.title);
    }

    async function pickCwd() {
      try {
        const r = await U.invoke('kosmo:term.pickCwd', {});
        if (r && r.path) {
          api.toast('Новые сессии откроются в ' + (r.display || r.path));
          loadInfo();
        }
      } catch (e) { api.toast('Не удалось выбрать папку: ' + errMsg(e), { tone: 'danger' }); }
    }

    // ---------- меню «+» ----------
    let menu = null;
    function closeMenu() {
      if (!menu) return;
      menu.remove();
      menu = null;
      addBtn.removeAttribute('aria-expanded');
      document.removeEventListener('pointerdown', onDocDown, true);
    }
    function onDocDown(e) { if (menu && !menu.contains(e.target) && e.target !== addBtn && !addBtn.contains(e.target)) closeMenu(); }
    function toggleMenu() {
      if (menu) { closeMenu(); return; }
      const i = st.info || {};
      const items = PROFILES.map((p) => {
        const avail = (i.profiles || []).find((x) => x.id === p.id);
        const off = avail && !avail.available;
        const b = h('button.kc-menu-item', { type: 'button', role: 'menuitem', disabled: off },
          U.icon(p.icon, 14), h('span.kc-menu-title', p.title), h('span.kc-menu-hint', off ? 'не найден' : (p.hint || '')));
        b.addEventListener('click', () => { closeMenu(); start(p.id); });
        return b;
      });
      menu = h('div.kc-menu', { role: 'menu' }, items);
      menu.addEventListener('keydown', (e) => {
        const list = Array.from(menu.querySelectorAll('.kc-menu-item:not(:disabled)'));
        const idx = list.indexOf(document.activeElement);
        if (e.key === 'ArrowDown') { e.preventDefault(); (list[idx + 1] || list[0]).focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); (list[idx - 1] || list[list.length - 1]).focus(); }
        else if (e.key === 'Escape') { e.preventDefault(); closeMenu(); addBtn.focus(); }
      });
      root.appendChild(menu);
      const r = addBtn.getBoundingClientRect(), rr = root.getBoundingClientRect();
      const w = 220;
      menu.style.top = Math.round(r.bottom - rr.top + 4) + 'px';
      menu.style.left = Math.round(Math.max(6, Math.min(r.left - rr.left, rr.width - w - 6))) + 'px';
      addBtn.setAttribute('aria-expanded', 'true');
      document.addEventListener('pointerdown', onDocDown, true);
      const first = menu.querySelector('.kc-menu-item:not(:disabled)');
      if (first) first.focus();
    }

    // ---------- цвета терминала ----------
    function readTheme() {
      const get = (v) => { probe.style.color = 'var(' + v + ')'; return toColor(getComputedStyle(probe).color); };
      const t = {
        background: get('--kc-term-bg'),
        foreground: get('--kc-term-fg'),
        cursor: get('--kc-cursor'),
        cursorAccent: get('--kc-term-bg'),
        selectionBackground: get('--kc-selection'),
        selectionInactiveBackground: get('--kc-selection-inactive'),
        scrollbarSliderBackground: get('--k-scrollbar'),
        scrollbarSliderHoverBackground: get('--k-scrollbar-hover'),
        scrollbarSliderActiveBackground: get('--k-scrollbar-hover')
      };
      for (const n of ANSI) {
        t[n] = get('--kc-' + n);
        t['bright' + n[0].toUpperCase() + n.slice(1)] = get('--kc-bright-' + n);
      }
      return t;
    }
    const isLight = () => document.documentElement.dataset.scheme === 'light';
    function theme() { if (!st.theme) st.theme = readTheme(); return st.theme; }
    let themeRaf = 0;
    function scheduleTheme() {
      if (themeRaf) return;
      themeRaf = requestAnimationFrame(() => {
        themeRaf = 0;
        const prev = JSON.stringify(st.theme);
        st.theme = readTheme();
        if (JSON.stringify(st.theme) === prev) return;
        for (const s of st.sessions.values()) {
          s.term.options.theme = st.theme;
          s.term.options.minimumContrastRatio = isLight() ? 4.5 : 1;
        }
      });
    }
    if (window.KTheme && typeof window.KTheme.onChange === 'function') window.KTheme.onChange(scheduleTheme);
    new MutationObserver(scheduleTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-scheme', 'style'] });

    // ---------- сессии ----------
    function termOptions() {
      return {
        fontFamily: FONT, fontSize: 13, lineHeight: 1, letterSpacing: 0,
        fontWeight: 'normal', fontWeightBold: '600',
        scrollback: 5000, cursorBlink: true, cursorStyle: 'bar', cursorWidth: 2, cursorInactiveStyle: 'outline',
        allowProposedApi: false, rightClickSelectsWord: false, smoothScrollDuration: 0,
        minimumContrastRatio: isLight() ? 4.5 : 1,
        windowsPty: st.info && st.info.windowsBuild ? { backend: 'conpty', buildNumber: st.info.windowsBuild } : undefined,
        theme: theme()
      };
    }
    function newUnit(X) {
      const term = new X.Terminal(termOptions());
      const fit = new X.FitAddon();
      term.loadAddon(fit);
      const host = h('div.kc-xterm', { hidden: true });
      stage.appendChild(host);
      return { term, fit, host, opened: false };
    }
    function openUnit(u) {
      if (u.opened) return;
      u.host.hidden = false;
      u.term.open(u.host);
      u.opened = true;
      const ta = u.term.textarea;
      if (ta) {
        ta.addEventListener('focus', () => U.send('kosmo:term.focusState', { focused: true }));
        ta.addEventListener('blur', () => U.send('kosmo:term.focusState', { focused: false }));
      }
    }

    const active = () => st.sessions.get(st.activeId) || null;

    function attach(info, unit) {
      const have = st.sessions.get(info.id);
      if (have) { update(have, info); return Promise.resolve(have); }
      if (st.attaching.has(info.id)) return st.attaching.get(info.id);
      const p = (async () => {
        const X = await loadXterm();
        if (st.sessions.has(info.id)) return st.sessions.get(info.id);
        const s = Object.assign(unit || newUnit(X), {
          id: info.id, title: info.title, profile: info.profile, alive: info.alive !== false, exitCode: info.exitCode,
          seq: 0, replaying: true, queue: [], unread: false, sentCols: info.cols, sentRows: info.rows, chip: null, exitNoted: false
        });
        st.sessions.set(s.id, s);
        st.order.push(s.id);
        wire(s);
        s.chip = makeChip(s);
        strip.appendChild(s.chip);
        const o = st.orphans.get(s.id);
        if (o) { s.queue.push(...o.list); st.orphans.delete(s.id); }
        try {
          const r = await U.invoke('kosmo:term.replay', { id: s.id, withSeq: true });
          if (r && typeof r === 'object') {
            if (r.data) s.term.write(r.data);
            s.seq = r.seq || 0;
            if (r.alive === false) { s.alive = false; s.exitCode = r.exitCode; }
          }
        } catch (e) { /* сессию могли закрыть */ }
        s.replaying = false;
        for (const m of s.queue) if (!(m.seq <= s.seq)) { s.term.write(m.data); s.seq = m.seq; }
        s.queue = [];
        if (!s.alive) noteExit(s);
        renderChip(s);
        updateChrome();
        return s;
      })();
      st.attaching.set(info.id, p);
      p.catch((e) => api.toast('Терминал: ' + errMsg(e), { tone: 'danger' })).finally(() => st.attaching.delete(info.id));
      return p;
    }

    function update(s, info) {
      if (info.title && info.title !== s.title) s.title = info.title;
      if (info.alive === false && s.alive) { s.alive = false; s.exitCode = info.exitCode; noteExit(s); }
      renderChip(s);
    }

    function wire(s) {
      s.term.onData((d) => {
        if (!s.alive) { if (/\r/.test(d)) restartSession(s); return; }
        U.send('kosmo:term.write', { id: s.id, data: d });
      });
      s.term.onBinary((d) => { if (s.alive) U.send('kosmo:term.write', { id: s.id, data: d }); });
      s.term.attachCustomKeyEventHandler((e) => onKey(s, e));
      s.host.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (s.term.hasSelection()) copySelection(s); else pasteInto(s);
      });
    }

    function onKey(s, e) {
      const ctrl = e.ctrlKey, shift = e.shiftKey, alt = e.altKey, code = e.code;
      // Shift+Enter у Claude — новая строка в вводе (ESC+CR, как настраивает /terminal-setup)
      if (s.profile === 'claude' && shift && !ctrl && !alt && (code === 'Enter' || code === 'NumpadEnter' || e.key === 'Enter')) {
        if (e.type === 'keydown') { e.preventDefault(); if (s.alive) U.send('kosmo:term.write', { id: s.id, data: '\x1b\r' }); }
        return false;
      }
      if (e.type !== 'keydown') return true;
      if (ctrl && !alt && code === 'KeyC') {
        if (s.term.hasSelection()) { e.preventDefault(); copySelection(s); return false; }
        if (shift) { e.preventDefault(); return false; }
        return true; // ^C — оболочке
      }
      if ((ctrl && !alt && code === 'KeyV') || (shift && !ctrl && !alt && code === 'Insert')) {
        e.preventDefault();
        pasteInto(s);
        return false;
      }
      if (ctrl && !shift && !alt && code === 'Insert') {
        e.preventDefault();
        if (s.term.hasSelection()) copySelection(s);
        return false;
      }
      return true;
    }

    function copySelection(s) {
      const text = s.term.getSelection();
      if (!text) return;
      U.invoke('kosmo:term.clipboard', { text }).catch(() => U.copyText(text, { toast: false }));
      s.term.clearSelection();
    }
    async function pasteInto(s) {
      if (!s.alive) return;
      let text = '';
      try { text = await U.invoke('kosmo:term.clipboard', {}); } catch (e) { try { text = await navigator.clipboard.readText(); } catch (_) { text = ''; } }
      if (text) s.term.paste(String(text));
      s.term.focus();
    }

    function noteExit(s) {
      if (s.exitNoted) return;
      s.exitNoted = true;
      const code = s.exitCode != null ? ' (код ' + s.exitCode + ')' : '';
      s.term.write('\x1b[0m\r\n\x1b[90mСеанс завершён' + code + '. Enter — запустить заново.\x1b[0m\x1b[?25l\r\n');
      renderChip(s);
      if (s.id === st.activeId) updateChrome();
    }

    // ---------- полоса сессий ----------
    function makeChip(s) {
      const x = h('span.kc-chip-x', { role: 'button', title: 'Закрыть сессию', 'aria-label': 'Закрыть сессию', html: window.KIcons.get('x', 12) });
      const chip = h('button.kc-chip', { type: 'button', role: 'tab', dataset: { id: String(s.id) } },
        h('span.kc-chip-ic'), h('span.kc-chip-title'), h('span.kc-chip-dot', { hidden: true }), x);
      chip.addEventListener('click', (e) => {
        if (e.target === x || x.contains(e.target)) { e.stopPropagation(); closeSession(s); return; }
        activate(s.id, { focus: true });
      });
      chip.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); closeSession(s); } });
      chip.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });
      return chip;
    }
    function renderChip(s) {
      if (!s.chip) return;
      const p = PROFILES.find((x) => x.id === s.profile) || PROFILES[1];
      s.chip.querySelector('.kc-chip-ic').innerHTML = window.KIcons.get(p.icon, 14);
      s.chip.querySelector('.kc-chip-title').textContent = s.title;
      s.chip.querySelector('.kc-chip-dot').hidden = !s.unread || s.id === st.activeId;
      s.chip.classList.toggle('dead', !s.alive);
      s.chip.classList.toggle('claude', s.profile === 'claude');
      s.chip.setAttribute('aria-selected', String(s.id === st.activeId));
      s.chip.title = s.title + (s.alive ? '' : ' — завершён');
    }

    function activate(id, opts) {
      opts = opts || {};
      const s = st.sessions.get(id);
      if (!s) return;
      st.activeId = id;
      s.unread = false;
      for (const x of st.sessions.values()) {
        if (x !== s) x.host.hidden = true;
        renderChip(x);
      }
      updateChrome();
      if (s.chip) s.chip.scrollIntoView({ inline: 'nearest', block: 'nearest' });
      if (!termVisible()) { if (opts.focus) st.wantFocus = true; return; }
      s.host.hidden = false;
      openUnit(s);
      fitActive();
      if (opts.focus) s.term.focus();
    }

    // Терминал стал видимым (инструмент показан или переключились на вкладку «Терминал»).
    function termShown(focus) {
      if (!termVisible()) return;
      const s = active();
      if (!s) {
        if (focus) { const b = emptyEl.querySelector('.kc-start'); if (b) b.focus(); }
        st.wantFocus = false;
        return;
      }
      s.host.hidden = false;
      openUnit(s);
      fitActive();
      if (focus || st.wantFocus) s.term.focus();
      st.wantFocus = false;
    }

    function fitActive() {
      const s = active();
      if (!s || !s.opened || !termVisible() || s.host.hidden) return;
      if (!stage.clientWidth || !stage.clientHeight) return;
      let d;
      try { d = s.fit.proposeDimensions(); } catch (e) { return; }
      if (!d || !isFinite(d.cols) || !isFinite(d.rows)) return;
      const cols = Math.max(20, d.cols), rows = Math.max(5, d.rows);
      if (cols !== s.term.cols || rows !== s.term.rows) s.term.resize(cols, rows);
      if (s.alive && (cols !== s.sentCols || rows !== s.sentRows)) {
        s.sentCols = cols;
        s.sentRows = rows;
        U.invoke('kosmo:term.resize', { id: s.id, cols, rows }).catch(() => {});
      }
    }
    const fitSoon = U.debounce(fitActive, 60);
    new ResizeObserver(() => fitSoon()).observe(stage);

    // Новая сессия: xterm создаётся и меряется заранее, чтобы процесс сразу стартовал с нужным размером.
    async function start(profile) {
      if (st.starting) return;
      st.starting = true;
      closeMenu();
      setView('terminal');
      let unit = null;
      st.pendingCreate++;
      try {
        const X = await loadXterm();
        unit = newUnit(X);
        for (const x of st.sessions.values()) x.host.hidden = true;
        stage.classList.remove('empty');
        emptyEl.hidden = true;
        let cols = 100, rows = 30;
        if (termVisible()) {
          openUnit(unit);
          const d = unit.fit.proposeDimensions();
          if (d && isFinite(d.cols) && isFinite(d.rows)) { cols = Math.max(20, d.cols); rows = Math.max(5, d.rows); unit.term.resize(cols, rows); }
        }
        const r = await U.invoke('kosmo:term.create', { profile, cols, rows });
        const s = await attach(r, unit);
        unit = null;
        activate(s.id, { focus: true });
      } catch (e) {
        api.toast(errMsg(e), { tone: 'danger', ms: 4000 });
        if (unit) { try { unit.term.dispose(); } catch (_) { /* уже */ } unit.host.remove(); }
        const a = active();
        if (a) activate(a.id); else updateChrome();
      } finally {
        st.pendingCreate--;
        st.starting = false;
      }
      syncList();
    }

    async function closeSession(s) {
      try { await U.invoke('kosmo:term.kill', { id: s.id }); } catch (e) { /* уже закрыта */ }
      dispose(s);
    }
    function dispose(s) {
      if (!st.sessions.has(s.id)) return;
      const idx = st.order.indexOf(s.id);
      st.sessions.delete(s.id);
      st.order = st.order.filter((x) => x !== s.id);
      try { s.term.dispose(); } catch (e) { /* уже */ }
      s.host.remove();
      if (s.chip) s.chip.remove();
      if (st.activeId === s.id) {
        st.activeId = null;
        const next = st.order[Math.min(idx, st.order.length - 1)];
        if (next != null) activate(next, { focus: true });
        else if (termVisible()) { const b = emptyEl.querySelector('.kc-start'); if (b) b.focus(); }
      }
      if (!st.sessions.size) U.send('kosmo:term.focusState', { focused: false });
      updateChrome();
    }

    async function restartSession(s) {
      if (s.restarting) return;
      s.restarting = true;
      try {
        const r = await U.invoke('kosmo:term.restart', { id: s.id, cols: s.term.cols, rows: s.term.rows });
        s.sentCols = r.cols;
        s.sentRows = r.rows;
        update(s, r);
      } catch (e) {
        api.toast('Не удалось перезапустить: ' + errMsg(e), { tone: 'danger', ms: 4000 });
      } finally {
        s.restarting = false;
      }
    }
    let armTimer = null;
    function restartActive() {
      const s = active();
      if (!s) return;
      // живую сессию — со второго нажатия (чтобы случайно не оборвать разговор с Claude)
      if (s.alive && !restartBtn.classList.contains('armed')) {
        restartBtn.classList.add('armed');
        restartBtn.title = 'Нажмите ещё раз, чтобы перезапустить «' + s.title + '»';
        clearTimeout(armTimer);
        armTimer = setTimeout(disarm, 2500);
        return;
      }
      disarm();
      restartSession(s).then(() => s.term.focus());
    }
    function disarm() {
      clearTimeout(armTimer);
      restartBtn.classList.remove('armed');
      restartBtn.title = 'Перезапустить сессию';
    }

    // Сверка со списком main (на старте, после создания, по событию kosmo:term.sessions).
    function reconcile(list, focusId) {
      if (!Array.isArray(list)) return;
      const ids = new Set(list.map((x) => x.id));
      for (const s of Array.from(st.sessions.values())) if (!ids.has(s.id) && !st.attaching.has(s.id)) dispose(s);
      const jobs = [];
      for (const x of list) {
        const s = st.sessions.get(x.id);
        if (s) update(s, x);
        else if (!st.pendingCreate || st.attaching.has(x.id)) jobs.push(attach(x));
      }
      Promise.all(jobs).then(() => {
        if (!st.activeId && st.sessions.size) {
          const f = focusId != null && st.sessions.has(focusId) ? focusId : st.order[st.order.length - 1];
          activate(f, { focus: false });
        }
        updateChrome();
      }).catch(() => {});
    }
    async function syncList() {
      try { reconcile(await U.invoke('kosmo:term.list', {}), null); } catch (e) { /* нет модуля */ }
    }

    // ---------- события main ----------
    function stash(m) {
      let o = st.orphans.get(m.id);
      if (!o) { o = { t: Date.now(), list: [], size: 0 }; st.orphans.set(m.id, o); }
      o.list.push(m);
      o.size += m.data.length;
      while (o.size > 1024 * 1024 && o.list.length > 1) o.size -= o.list.shift().data.length;
      const now = Date.now();
      for (const [id, x] of st.orphans) if (now - x.t > 15000 && id !== m.id) st.orphans.delete(id);
    }
    api.on('kosmo:term.data', (m) => {
      if (!m || typeof m.data !== 'string') return;
      const s = st.sessions.get(m.id);
      if (!s) { stash(m); return; }
      if (s.replaying) { s.queue.push(m); return; }
      if (m.seq && m.seq <= s.seq) return;
      if (m.seq) s.seq = m.seq;
      s.term.write(m.data);
      if (s.id !== st.activeId && !s.unread) { s.unread = true; renderChip(s); }
    });
    api.on('kosmo:term.exit', (m) => {
      const s = m && st.sessions.get(m.id);
      if (!s) return;
      s.alive = false;
      s.exitCode = m.code;
      noteExit(s);
    });
    api.on('kosmo:term.reset', (m) => {
      const s = m && st.sessions.get(m.id);
      if (!s) return;
      s.term.reset();
      s.term.clear();
      s.alive = true;
      s.exitNoted = false;
      if (m.seq) s.seq = m.seq;
      s.queue = s.queue.filter((x) => x.seq > s.seq);
      renderChip(s);
      updateChrome();
    });
    api.on('kosmo:term.sessions', (m) => { if (m) reconcile(m.sessions, m.focusId); });
    api.on('kosmo:term.show', async (m) => {
      if (st.view !== 'terminal') setView('terminal');
      const id = m && m.id;
      if (id == null) { termShown(!!(m && m.focus)); return; }
      let s = st.sessions.get(id);
      if (!s && st.attaching.has(id)) s = await st.attaching.get(id).catch(() => null);
      if (!s) { await syncList(); s = st.sessions.get(id); if (!s && st.attaching.has(id)) s = await st.attaching.get(id).catch(() => null); }
      if (s) activate(s.id, { focus: !!(m && m.focus) });
    });
    api.on('kosmo:settings.changed', (p) => {
      const path = p && typeof p.path === 'string' ? p.path : '';
      if (path === '' || path === 'claude' || path.startsWith('claude.')) refreshInfo();
    });

    // ---------- журнал ----------
    async function loadLog() {
      if (st.logLoading) return;
      st.logLoading = true;
      if (!st.logLoaded) renderStatus();
      try {
        const [status, entries] = await Promise.all([
          U.invoke('kosmo:bridge.status', {}),
          U.invoke('kosmo:bridge.activity', { limit: 200 })
        ]);
        st.bridge = status;
        st.entries = Array.isArray(entries) ? entries.slice(-LOG_LIMIT) : [];
        st.bridgeMissing = false;
        st.logError = null;
      } catch (e) {
        st.bridgeMissing = noHandler(e);
        st.logError = st.bridgeMissing ? null : errMsg(e);
      }
      st.logLoaded = true;
      st.logLoading = false;
      renderStatus();
      renderLog();
    }

    function renderStatus() {
      U.clear(statusEl);
      if (st.bridgeMissing) {
        statusEl.append(h('span.kc-dot', { dataset: { mode: 'off' } }), h('span.kc-status-mode', 'Мост Claude недоступен'));
        return;
      }
      const b = st.bridge;
      if (!b) { statusEl.append(st.logError ? h('span.kc-status-mode', st.logError) : h('span.k-spinner')); return; }
      let mode = !b.enabled ? 'off' : (b.access === 'read' ? 'read' : 'full');
      let label = { off: 'Мост выключен', read: 'Только чтение', full: 'Полный доступ' }[mode];
      if (b.error) { mode = 'error'; label = 'Ошибка: ' + b.error; }
      statusEl.append(h('span.kc-dot', { dataset: { mode } }), h('span.kc-status-mode', label));
      if (b.url && mode !== 'off') {
        const copy = h('button.k-icon-btn.k-icon-btn-sm', { type: 'button', title: 'Скопировать адрес', html: window.KIcons.get('copy', 13) });
        copy.addEventListener('click', () => U.copyText(b.url, { message: 'Адрес скопирован' }));
        statusEl.append(h('span.kc-sep', '·'), h('span.kc-status-url', { title: b.url }, b.url.replace(/^https?:\/\//, '')), copy);
      }
      if (b.lastCallAt) statusEl.append(h('span.kc-grow'), h('span.kc-status-last', { title: new Date(b.lastCallAt).toLocaleString('ru-RU') }, U.timeAgo(b.lastCallAt)));
    }

    function logRow(e) {
      const ok = e.ok !== false && !e.error;
      const tool = h('span.kc-tool', TOOL_RU[e.tool] || e.tool || '—');
      const main = h('div.kc-row-main', tool, e.by === 'user' ? h('span.kc-by', 'вы') : null, h('span.kc-args', brief(e)));
      const row = h('div.kc-row' + (ok ? '' : '.err'), { role: 'listitem' },
        h('span.kc-time', fmtTime(e.ts)), main,
        h('span.kc-tab', { title: e.tabId != null ? 'Вкладка ' + e.tabId : '' }, e.tabId != null ? '#' + e.tabId : ''),
        h('span.kc-ms', fmtMs(e.ms)),
        h('span.kc-st', { title: ok ? 'Готово' : 'Ошибка' }, U.icon(ok ? 'check' : 'x', 14)));
      if (!ok && e.error) row.appendChild(h('div.kc-row-err', String(e.error)));
      row.addEventListener('click', (ev) => {
        if (window.getSelection && String(window.getSelection())) return;
        const d = row.querySelector('.kc-row-details');
        if (d) { d.remove(); row.classList.remove('open'); return; }
        const parts = [];
        if (e.args && Object.keys(e.args).length) parts.push(JSON.stringify(e.args, null, 2));
        if (e.note) parts.push(String(e.note));
        if (e.error) parts.push('Ошибка: ' + e.error);
        if (!parts.length) parts.push('Без аргументов');
        row.appendChild(h('pre.kc-row-details', parts.join('\n\n')));
        row.classList.add('open');
        ev.stopPropagation();
      });
      return row;
    }

    function renderLog() {
      U.clear(logList);
      const list = st.entries.slice(-200).reverse();
      for (const e of list) logList.appendChild(logRow(e));
      renderLogEmpty();
    }
    function renderLogEmpty() {
      U.clear(logEmpty);
      let node = null;
      if (st.bridgeMissing) node = U.empty({ icon: 'claude', title: 'Мост Claude недоступен', text: 'Журнал появится, когда в Космолёте заработает MCP-мост для Claude.' });
      else if (st.logError && !st.entries.length) node = U.empty({ icon: 'alert-triangle', title: 'Журнал не загрузился', text: st.logError, tone: 'error' });
      else if (!st.entries.length) node = U.empty({ icon: 'list', title: 'Claude пока ничего не делал', text: 'Здесь появятся его действия в браузере: вкладки, клики, ввод, запросы, снимки страниц.' });
      logEmpty.hidden = !node;
      if (node) logEmpty.appendChild(node);
      clearBtn.disabled = !st.entries.length;
    }

    async function clearLog() {
      try { await U.invoke('kosmo:bridge.clearActivity', {}); } catch (e) { api.toast('Не удалось очистить: ' + errMsg(e), { tone: 'danger' }); }
    }

    api.on('kosmo:bridge.activity', (m) => {
      if (!m) return;
      if (m.cleared) { st.entries = []; if (st.logLoaded) renderLog(); return; }
      const e = m.entry;
      if (!e) return;
      st.entries.push(e);
      if (st.entries.length > LOG_LIMIT) st.entries.splice(0, st.entries.length - LOG_LIMIT);
      if (st.logLoaded) {
        logList.insertBefore(logRow(e), logList.firstChild);
        while (logList.childElementCount > 200) logList.lastElementChild.remove();
        renderLogEmpty();
      }
      if (st.view !== 'log' && e.by !== 'user') logDot.hidden = false;
    });
    api.on('kosmo:bridge.status', (b) => {
      if (!b || typeof b !== 'object') return;
      st.bridge = b;
      st.bridgeMissing = false;
      if (st.logLoaded) renderStatus();
    });
    api.on('kosmo:bridge.showLog', () => setView('log'));

    // ---------- старт ----------
    setView(st.view);
    updateChrome();
    (async () => {
      let list = [];
      try {
        [list] = await Promise.all([U.invoke('kosmo:term.list', {}), loadInfo()]);
      } catch (e) {
        st.infoError = noHandler(e) ? 'Терминал недоступен: модуль не загружен.' : errMsg(e);
        renderEmpty();
        return;
      }
      st.loaded = true;
      if (list && list.length) reconcile(list, (list.find((x) => x.focused) || {}).id);
      else {
        // xterm подгружаем заранее, в простое — первый запуск будет мгновенным
        const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 300));
        idle(() => loadXterm().catch(() => {}));
      }
    })();

    return {
      shown(v) {
        st.visible = v;
        if (!v) { closeMenu(); disarm(); return; }
        if (st.view === 'terminal') termShown(true);
        else if (!st.logLoaded) loadLog();
      }
    };
  }
})();
