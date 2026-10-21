'use strict';
// Реестр команд и горячих клавиш (ARCHITECTURE §10). Клавиши ловятся в before-input-event всех webContents
// по физической клавише (input.code) — работают в любой раскладке. Меню «⋯» и контекстное меню вкладки.

const SOURCES = ['chrome', 'tab', 'panel', 'overlay', 'devtools'];
const MOD_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'];

const KEY_ALIASES = {
  '−': '-', '–': '-', minus: '-', plus: '=', equal: '=', comma: ',', period: '.',
  '←': 'Left', '→': 'Right', '↑': 'Up', '↓': 'Down',
  arrowleft: 'Left', arrowright: 'Right', arrowup: 'Up', arrowdown: 'Down',
  left: 'Left', right: 'Right', up: 'Up', down: 'Down',
  esc: 'Escape', escape: 'Escape', return: 'Enter', enter: 'Enter', space: 'Space', tab: 'Tab',
  pgup: 'PageUp', pageup: 'PageUp', pgdn: 'PageDown', pagedown: 'PageDown',
  del: 'Delete', delete: 'Delete', backspace: 'Backspace', home: 'Home', end: 'End', insert: 'Insert',
};

const CODE_KEYS = {
  Equal: '=', Minus: '-', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'",
  BracketLeft: '[', BracketRight: ']', Backslash: '\\', Backquote: '`',
  ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down',
};

function normKey(k) {
  if (!k) return '';
  if (KEY_ALIASES[k] !== undefined) return KEY_ALIASES[k];
  const low = k.toLowerCase();
  if (KEY_ALIASES[low] !== undefined) return KEY_ALIASES[low];
  if (/^f\d{1,2}$/i.test(k)) return k.toUpperCase();
  if (/^numpad/i.test(k)) return 'Numpad' + k.slice(6).charAt(0).toUpperCase() + k.slice(7);
  if (k.length === 1) return k.toUpperCase();
  return k.charAt(0).toUpperCase() + k.slice(1);
}

// 'Ctrl+Shift+T' → каноническая строка 'Ctrl+Shift+T'.
function normCombo(str) {
  const s = String(str || '').trim();
  if (!s) return '';
  const parts = s === '+' ? ['+'] : s.split('+');
  // 'Ctrl++' → последний пустой элемент означает плюс
  if (s.endsWith('++')) { parts.splice(parts.length - 2, 2, '='); }
  const mods = new Set();
  let key = '';
  for (const raw of parts) {
    const p = raw.trim();
    const l = p.toLowerCase();
    if (['ctrl', 'control', 'cmdorctrl', 'commandorcontrol'].includes(l)) mods.add('Ctrl');
    else if (['alt', 'option'].includes(l)) mods.add('Alt');
    else if (l === 'shift') mods.add('Shift');
    else if (['meta', 'cmd', 'command', 'super', 'win'].includes(l)) mods.add('Meta');
    else key = normKey(p);
  }
  if (!key) return '';
  return MOD_ORDER.filter((m) => mods.has(m)).concat(key).join('+');
}

function keyFromInput(input) {
  const code = input.code || '';
  let key = '';
  if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
  else if (/^Digit\d$/.test(code)) key = code.slice(5);
  else if (/^F\d{1,2}$/.test(code)) key = code;
  else if (/^Numpad/.test(code)) key = code;
  else if (CODE_KEYS[code]) key = CODE_KEYS[code];
  else if (['Escape', 'Tab', 'Enter', 'Space', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown', 'Insert'].includes(code)) key = code;
  else key = normKey(input.key || '');
  return key;
}

function comboFromInput(input) {
  const key = keyFromInput(input);
  if (!key || ['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return '';
  const mods = [];
  if (input.control) mods.push('Ctrl');
  if (input.alt) mods.push('Alt');
  if (input.shift) mods.push('Shift');
  if (input.meta) mods.push('Meta');
  return mods.concat(key).join('+');
}

// Каноническая комбинация → акселератор Electron (только для подписи в меню).
function toAccelerator(combo) {
  if (!combo) return undefined;
  const map = { '=': '=', '-': '-', Left: 'Left', Right: 'Right', Up: 'Up', Down: 'Down', NumpadAdd: 'numadd', NumpadSubtract: 'numsub', Numpad0: 'num0' };
  const parts = combo.split('+');
  const key = parts.pop();
  return parts.concat(map[key] || key).join('+');
}

function createCommands(ctx) {
  const commands = new Map();
  const bindings = new Map(); // combo → [id]
  const attached = new WeakSet();

  function rebuildBindings() {
    bindings.clear();
    for (const c of commands.values()) {
      for (const k of c.keys) {
        if (!bindings.has(k)) bindings.set(k, []);
        bindings.get(k).push(c.id);
      }
    }
  }

  function register(def) {
    if (!def || !def.id || typeof def.run !== 'function') throw new Error('commands.register: нужны id и run');
    const keys = (Array.isArray(def.keys) ? def.keys : def.keys ? [def.keys] : []).map(normCombo).filter(Boolean);
    const cmd = {
      id: String(def.id),
      title: String(def.title || def.id),
      category: def.category || 'Общее',
      keys,
      when: typeof def.when === 'function' ? def.when : null,
      run: def.run,
      scopes: Array.isArray(def.scopes) ? def.scopes.filter((s) => SOURCES.includes(s)) : SOURCES,
      repeat: def.repeat !== false,
      passThrough: !!def.passThrough,
      hidden: !!def.hidden,
      appMenu: def.appMenu && typeof def.appMenu === 'object' ? { section: String(def.appMenu.section || 'tools'), order: Number(def.appMenu.order) || 100 } : null,
    };
    if (commands.has(cmd.id)) ctx.log('commands', `команда ${cmd.id} перерегистрирована`);
    commands.set(cmd.id, cmd);
    rebuildBindings();
    return () => unregister(cmd.id);
  }

  function unregister(id) {
    if (commands.delete(id)) rebuildBindings();
  }

  function enabled(c) {
    if (!c.when) return true;
    try { return !!c.when(); } catch (_) { return false; }
  }

  function run(id, args) {
    const c = commands.get(id);
    if (!c) throw new Error('нет команды ' + id);
    if (!enabled(c)) return null;
    try {
      const r = c.run(args || {}, ctx);
      if (r && typeof r.catch === 'function') r.catch((e) => ctx.log('commands', id, e));
      return r;
    } catch (e) {
      ctx.log('commands', id, e);
      throw e;
    }
  }

  function list() {
    return Array.from(commands.values()).filter((c) => !c.hidden).map((c) => ({
      id: c.id, title: c.title, category: c.category, keys: c.keys.slice(), enabled: enabled(c), appMenu: c.appMenu,
    }));
  }

  function match(input, source) {
    if (input.type !== 'keyDown' || input.isComposing) return null;
    const combo = comboFromInput(input);
    if (!combo) return null;
    const ids = bindings.get(combo);
    if (!ids) return null;
    for (let i = ids.length - 1; i >= 0; i--) {
      const c = commands.get(ids[i]);
      if (c && c.scopes.includes(source) && enabled(c)) return c;
    }
    return null;
  }

  // Подключить горячие клавиши к webContents. source: chrome|tab|panel|overlay|devtools.
  function attach(wc, source, extra) {
    if (!wc || attached.has(wc)) return;
    attached.add(wc);
    wc.on('before-input-event', (event, input) => {
      const c = match(input, source);
      if (!c) return;
      if (!c.passThrough) event.preventDefault();
      if (input.isAutoRepeat && !c.repeat) return;
      const args = Object.assign({ source, webContents: wc, combo: comboFromInput(input) }, extra || {});
      if (source === 'tab' && ctx.tabs) args.tab = ctx.tabs.fromWebContents(wc);
      // Выполняем после возврата из обработчика события ввода.
      setImmediate(() => { try { run(c.id, args); } catch (_) { /* уже в логе */ } });
    });
  }

  // ---------- базовые команды ----------

  const T = () => ctx.tabs;
  const activeTab = () => T().active();
  const focusChrome = () => { const w = ctx.windows.main; if (w && !w.isDestroyed()) w.webContents.focus(); };
  const chromeCmd = (name, extra) => {
    focusChrome();
    // Сначала отложенное состояние вкладок: иначе chrome получит команду раньше смены активной вкладки
    // и сам снимет фокус с адресной строки при переключении (Ctrl+T).
    if (ctx.tabs) ctx.tabs.broadcastState(true);
    ctx.broadcast('kosmo:chrome.command', Object.assign({ name }, extra || {}));
  };
  const openPage = (url) => T().openOrActivate(url);

  function registerBase() {
    register({
      id: 'tab.new', title: 'Новая вкладка', category: 'Вкладки', keys: ['Ctrl+T'], appMenu: { section: 'new', order: 10 },
      run: (a) => { T().create({ url: T().NEWTAB, containerId: a && a.containerId }); chromeCmd('focusOmnibox'); },
    });
    register({ id: 'tab.close', title: 'Закрыть вкладку', category: 'Вкладки', keys: ['Ctrl+W', 'Ctrl+F4'], run: () => { const t = activeTab(); if (t) T().close(t.id); } });
    register({ id: 'tab.reopen', title: 'Открыть заново закрытую вкладку', category: 'Вкладки', keys: ['Ctrl+Shift+T'], run: () => T().reopenClosed() });
    register({ id: 'tab.next', title: 'Следующая вкладка', category: 'Вкладки', keys: ['Ctrl+Tab', 'Ctrl+PageDown'], run: () => T().activateOffset(1) });
    register({ id: 'tab.prev', title: 'Предыдущая вкладка', category: 'Вкладки', keys: ['Ctrl+Shift+Tab', 'Ctrl+PageUp'], run: () => T().activateOffset(-1) });
    for (let i = 1; i <= 8; i++) {
      register({ id: 'tab.select' + i, title: `Вкладка ${i}`, category: 'Вкладки', keys: ['Ctrl+' + i], hidden: true, run: () => T().activateIndex(i - 1) });
    }
    register({ id: 'tab.selectLast', title: 'Последняя вкладка', category: 'Вкладки', keys: ['Ctrl+9'], hidden: true, run: () => T().activateIndex(-1) });
    register({ id: 'tab.duplicate', title: 'Дублировать вкладку', category: 'Вкладки', run: () => { const t = activeTab(); if (t) T().duplicate(t.id); } });
    register({ id: 'tab.pin', title: 'Закрепить или открепить вкладку', category: 'Вкладки', run: () => { const t = activeTab(); if (t) T().pin(t.id); } });
    register({ id: 'tab.mute', title: 'Выключить или включить звук вкладки', category: 'Вкладки', run: () => { const t = activeTab(); if (t) T().mute(t.id); } });

    register({ id: 'omnibox.focus', title: 'Адресная строка', category: 'Навигация', keys: ['Ctrl+L', 'F6', 'Alt+D'], run: () => chromeCmd('focusOmnibox') });
    register({ id: 'nav.reload', title: 'Обновить', category: 'Навигация', keys: ['F5', 'Ctrl+R'], run: () => { const t = activeTab(); if (t) T().reload(t.id, false); } });
    register({ id: 'nav.hardReload', title: 'Обновить без кэша', category: 'Навигация', keys: ['Ctrl+Shift+R', 'Ctrl+F5', 'Shift+F5'], run: () => { const t = activeTab(); if (t) T().reload(t.id, true); } });
    register({ id: 'nav.back', title: 'Назад', category: 'Навигация', keys: ['Alt+Left'], scopes: ['chrome', 'tab', 'overlay'], run: () => { const t = activeTab(); if (t) T().back(t.id); } });
    register({ id: 'nav.forward', title: 'Вперёд', category: 'Навигация', keys: ['Alt+Right'], scopes: ['chrome', 'tab', 'overlay'], run: () => { const t = activeTab(); if (t) T().forward(t.id); } });
    register({ id: 'nav.stop', title: 'Остановить загрузку', category: 'Навигация', run: () => { const t = activeTab(); if (t) T().stop(t.id); } });

    register({ id: 'zoom.in', title: 'Увеличить масштаб', category: 'Вид', keys: ['Ctrl+=', 'Ctrl+Shift+=', 'Ctrl+NumpadAdd'], run: () => { const t = activeTab(); if (t) T().zoom(t.id, 'in'); } });
    register({ id: 'zoom.out', title: 'Уменьшить масштаб', category: 'Вид', keys: ['Ctrl+-', 'Ctrl+Shift+-', 'Ctrl+NumpadSubtract'], run: () => { const t = activeTab(); if (t) T().zoom(t.id, 'out'); } });
    register({ id: 'zoom.reset', title: 'Масштаб 100%', category: 'Вид', keys: ['Ctrl+0', 'Ctrl+Numpad0'], run: () => { const t = activeTab(); if (t) T().zoom(t.id, 'reset'); } });
    register({ id: 'window.fullscreen', title: 'Во весь экран', category: 'Вид', keys: ['F11'], repeat: false, run: () => ctx.windows.toggleFullscreen() });
    register({
      id: 'fullscreen.exitHtml', title: 'Выйти из полноэкранного режима', category: 'Вид', keys: ['Escape'], scopes: ['tab'], hidden: true, passThrough: true,
      when: () => ctx.windows.layoutState().fullscreenKind === 'html',
      run: () => ctx.windows.exitHtmlFullscreen(),
    });

    register({
      id: 'devtools.toggle', title: 'Инструменты разработчика', category: 'Разработка', keys: ['F12', 'Ctrl+Shift+I'], repeat: false,
      appMenu: { section: 'tools', order: 10 }, run: () => ctx.panel.toggle('devtools'),
    });
    register({ id: 'panel.toggle', title: 'Боковая панель', category: 'Вид', repeat: false, run: () => ctx.panel.toggle() });
    register({ id: 'find.open', title: 'Найти на странице', category: 'Страница', keys: ['Ctrl+F'], scopes: ['chrome', 'tab', 'overlay'], run: () => chromeCmd('openFind') });
    register({ id: 'find.next', title: 'Найти далее', category: 'Страница', keys: ['F3', 'Ctrl+G'], scopes: ['chrome', 'tab', 'overlay'], hidden: true, run: () => chromeCmd('findNext') });
    register({ id: 'find.prev', title: 'Найти назад', category: 'Страница', keys: ['Shift+F3', 'Ctrl+Shift+G'], scopes: ['chrome', 'tab', 'overlay'], hidden: true, run: () => chromeCmd('findPrev') });
    register({
      id: 'page.viewSource', title: 'Просмотр кода страницы', category: 'Разработка', keys: ['Ctrl+U'], scopes: ['chrome', 'tab'],
      run: () => { const t = activeTab(); if (t && /^https?:/i.test(t.info.url)) T().create({ url: 'view-source:' + t.info.url, openerId: t.id }); },
    });
    register({ id: 'page.print', title: 'Печать', category: 'Страница', keys: ['Ctrl+P'], scopes: ['chrome', 'tab'], run: () => { const t = activeTab(); if (t && t.wc) t.wc.print({}, () => {}); } });

    register({ id: 'settings.open', title: 'Настройки', category: 'Браузер', keys: ['Ctrl+,'], appMenu: { section: 'app', order: 10 }, run: () => openPage('kosmo://settings/') });
    register({ id: 'history.open', title: 'История', category: 'Браузер', keys: ['Ctrl+H'], appMenu: { section: 'pages', order: 10 }, run: () => openPage('kosmo://history/') });
    register({ id: 'downloads.open', title: 'Загрузки', category: 'Браузер', keys: ['Ctrl+J'], appMenu: { section: 'pages', order: 20 }, run: () => openPage('kosmo://downloads/') });
    register({ id: 'extensions.open', title: 'Расширения', category: 'Браузер', appMenu: { section: 'pages', order: 30 }, run: () => openPage('kosmo://extensions/') });
    register({ id: 'app.about', title: 'О Космолёте', category: 'Браузер', appMenu: { section: 'app', order: 20 }, run: () => showAbout() });
    register({ id: 'app.quit', title: 'Выход', category: 'Браузер', keys: ['Ctrl+Shift+Q'], repeat: false, appMenu: { section: 'app', order: 30 }, run: () => ctx.app.quit() });
    if (ctx.flags.dev) {
      register({
        id: 'ui.inspect', title: 'Исследовать интерфейс', category: 'Разработка', keys: ['Ctrl+Alt+Shift+I'], repeat: false,
        run: (a) => {
          const wc = a && a.webContents && a.source !== 'tab' ? a.webContents : ctx.windows.main.webContents;
          wc.openDevTools({ mode: 'detach' });
        },
      });
    }
  }

  function showAbout() {
    const { dialog } = ctx.electron;
    const v = process.versions;
    dialog.showMessageBox(ctx.windows.main, {
      type: 'info',
      title: 'О Космолёте',
      message: `Космолёт ${ctx.app.getVersion()}`,
      detail: `Браузер IT-специалиста.\nElectron ${v.electron}, Chromium ${v.chrome}, Node ${v.node}.\nПрофиль: ${ctx.paths.userData}`,
      buttons: ['Закрыть'],
      noLink: true,
    }).catch(() => {});
  }

  // ---------- меню «⋯» ----------

  function itemFor(c) {
    return {
      label: c.title,
      accelerator: toAccelerator(c.keys[0]),
      registerAccelerator: false,
      enabled: enabled(c),
      click: () => { try { run(c.id, { source: 'menu' }); } catch (_) {} },
    };
  }

  function containerSubmenu(onPick) {
    return ctx.sessions.containers().map((c) => ({ label: c.name, click: () => onPick(c.id) }));
  }

  function appMenuTemplate() {
    const sections = { new: [], pages: [], zoom: [], tools: [], app: [] };
    const order = ['new', 'pages', 'zoom', 'tools', 'app'];
    for (const c of commands.values()) {
      if (!c.appMenu) continue;
      const s = sections[c.appMenu.section] ? c.appMenu.section : 'tools';
      sections[s].push({ order: c.appMenu.order, item: itemFor(c) });
    }
    sections.new.push({
      order: 20,
      item: { label: 'Новая вкладка в контейнере', submenu: containerSubmenu((id) => { T().create({ url: T().NEWTAB, containerId: id }); chromeCmd('focusOmnibox'); }) },
    });
    const t = activeTab();
    const z = t && t.wc && !t.wc.isDestroyed() ? Math.round(t.wc.getZoomFactor() * 100) : 100;
    const zc = (id) => commands.get(id);
    sections.zoom.push(
      { order: 10, item: Object.assign(itemFor(zc('zoom.out')), { label: 'Уменьшить масштаб' }) },
      { order: 20, item: { label: `Масштаб: ${z}%`, enabled: z !== 100, click: () => run('zoom.reset') } },
      { order: 30, item: Object.assign(itemFor(zc('zoom.in')), { label: 'Увеличить масштаб' }) },
    );
    const tpl = [];
    for (const s of order) {
      const items = sections[s].sort((a, b) => a.order - b.order).map((x) => x.item);
      if (!items.length) continue;
      if (tpl.length) tpl.push({ type: 'separator' });
      tpl.push(...items);
    }
    return tpl;
  }

  function popup(template, p) {
    const { Menu } = ctx.electron;
    const menu = Menu.buildFromTemplate(template);
    const opts = { window: ctx.windows.main };
    if (p && typeof p.x === 'number' && typeof p.y === 'number') { opts.x = Math.round(p.x); opts.y = Math.round(p.y); }
    menu.popup(opts);
    return true;
  }

  // ---------- контекстное меню вкладки ----------

  function tabMenuTemplate(id) {
    const tab = T().get(id);
    if (!tab) return [];
    const all = T().all();
    const idx = all.indexOf(tab);
    const right = all.slice(idx + 1).filter((t) => !t.info.pinned);
    const others = all.filter((t) => t !== tab && !t.info.pinned);
    return [
      { label: 'Новая вкладка справа', click: () => T().create({ url: T().NEWTAB, index: idx + 1, containerId: tab.info.containerId }) },
      { type: 'separator' },
      { label: 'Обновить', click: () => T().reload(tab.id) },
      { label: 'Дублировать', click: () => T().duplicate(tab.id) },
      { label: tab.info.pinned ? 'Открепить' : 'Закрепить', click: () => T().pin(tab.id) },
      { label: tab.info.muted ? 'Включить звук' : 'Без звука', click: () => T().mute(tab.id) },
      { label: 'Выгрузить из памяти', enabled: !!tab.view && tab.id !== T().activeId, click: () => T().discard(tab.id) },
      { type: 'separator' },
      { label: 'Закрыть', accelerator: 'Ctrl+W', registerAccelerator: false, click: () => T().close(tab.id) },
      { label: 'Закрыть другие', enabled: others.length > 0, click: () => T().closeMany(others.map((t) => t.id)) },
      { label: 'Закрыть справа', enabled: right.length > 0, click: () => T().closeMany(right.map((t) => t.id)) },
      { type: 'separator' },
      { label: 'Открыть заново закрытую', accelerator: 'Ctrl+Shift+T', registerAccelerator: false, enabled: T().closedCount > 0, click: () => T().reopenClosed() },
    ];
  }

  return {
    register, unregister, run, list, attach, match,
    get: (id) => commands.get(id) || null,
    registerBase,
    appMenuTemplate,
    tabMenuTemplate,
    popup,
    normCombo,
    comboFromInput,
    toAccelerator,
  };
}

function registerCommandsIpc(ctx) {
  const C = ctx.commands;
  ctx.ipc.handle('kosmo:commands.list', () => C.list(), { allow: ['ui', 'internal'] });
  ctx.ipc.handle('kosmo:commands.run', (p = {}) => {
    const r = C.run(String(p.id || ''), Object.assign({}, p.args || {}, { source: 'ipc' }));
    // Результат команды может быть несериализуемым (Tab и т.п.).
    try { return r === undefined ? null : JSON.parse(JSON.stringify(r, (k, v) => (k === '_mgr' || k === 'view' || k === 'wc' ? undefined : v))); } catch (_) { return null; }
  });
  ctx.ipc.handle('kosmo:app.menu', (p = {}) => C.popup(C.appMenuTemplate(), p));
  ctx.ipc.handle('kosmo:tabs.contextMenu', (p = {}) => C.popup(C.tabMenuTemplate(Number(p.id)), p));
}

module.exports = { createCommands, registerCommandsIpc, normCombo, comboFromInput };
