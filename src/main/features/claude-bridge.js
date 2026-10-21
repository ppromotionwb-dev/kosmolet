'use strict';
// Фича «claude-bridge»: Claude видит и управляет браузером через MCP (ARCHITECTURE §13).
// - MCP-сервер Streamable HTTP на 127.0.0.1:<claude.mcpPort>/mcp (bridge/server.js), инструменты — bridge/tools.js,
//   снимок страницы и ref-ы — page-snapshot.js (изолированный мир 1002), ввод — bridge/actions.js;
// - журнал действий (claude-activity.json, событие kosmo:bridge.activity) — bridge/activity.js;
// - пикер «Показать Claude элемент» (Ctrl+Shift+E, контекстное меню) — bridge/picker.js + preload/tab/30-picker.js;
// - «Отправить в Claude» (Ctrl+Shift+Y, контекстное меню, меню «⋯») — bridge/inbox.js;
// - подключение Claude Code и gen/claude-mcp.json — bridge/connect.js.
// API для соседей: ctx.bridge.{toInbox, mcpConfigPath, status, pageFetch, sendPage, lastPicked, activity}.
// На старте только http.createServer; SDK MCP грузится при первом запросе.

const crypto = require('crypto');
const fs = require('fs');

const { createActivity } = require('./bridge/activity');
const { createServer } = require('./bridge/server');
const { createActions } = require('./bridge/actions');
const { createTools } = require('./bridge/tools');
const { createInbox } = require('./bridge/inbox');
const { createConnect } = require('./bridge/connect');
const { createPicker } = require('./bridge/picker');

const ACCESS = ['off', 'read', 'full'];
let internal = null; // модули для start()
const SHELLS = ['powershell', 'cmd', 'bash'];

function init(ctx) {
  const S = ctx.settings;
  S.addDefaults({ claude: { shell: 'powershell' } }, { enums: { 'claude.shell': SHELLS } });

  const getAccess = () => {
    const a = S.peek('claude.access');
    return ACCESS.includes(a) ? a : 'full';
  };
  const getConfig = () => ({
    enabled: S.peek('claude.mcpEnabled') !== false && getAccess() !== 'off',
    port: Number(S.peek('claude.mcpPort')) || 47321,
    token: String(S.peek('claude.token') || ''),
  });

  const activity = createActivity(ctx);
  const actions = createActions(ctx);
  const picker = createPicker(ctx, { activity });
  const tools = createTools(ctx, { actions, activity, picker, getAccess });
  const inbox = createInbox(ctx, { actions, picker, activity });
  const connect = createConnect(ctx, getConfig);
  const server = createServer(ctx, {
    getConfig,
    buildServer: () => tools.buildServer(),
    onState: () => broadcastStatus(),
  });

  function desktopDir() { try { return ctx.app.getPath('desktop'); } catch (_) { return ''; } }

  function status() {
    const cfg = getConfig();
    const st = server.state();
    return {
      enabled: cfg.enabled && st.listening,
      access: getAccess(),
      port: cfg.port,
      url: connect.url(),
      listening: st.listening,
      error: cfg.enabled ? st.error : '',
      requests: st.requests,
      lastCallAt: activity.lastCallAt,
      calls: activity.calls,
      portFromFlag: !!ctx.flags.mcpPort,
      configPath: connect.configPath(),
      inboxDir: inbox.dir(),
      inboxCustom: !!S.peek('claude.inboxDir'),
      desktopDir: desktopDir(),
      pickerActive: picker.isActive(),
    };
  }
  let statusTimer = null;
  function broadcastStatus() {
    if (statusTimer) return;
    statusTimer = setTimeout(() => { statusTimer = null; ctx.broadcast('kosmo:bridge.status', status()); }, 50);
  }
  // После каждого вызова — обновить статус (точка на кнопке «ярче»).
  const addEntry = activity.add;
  activity.add = (e) => { const r = addEntry(e); broadcastStatus(); return r; };

  async function sendPage(tabId, extra) {
    const r = await inbox.sendPage(tabId, extra);
    ctx.broadcast('kosmo:bridge.toast', { text: r.pasted ? 'Отправлено в Claude' : 'Сохранено для Claude, путь скопирован', tone: 'ok', path: r.path });
    return r;
  }
  function sendPageSafe(tabId, extra) {
    return sendPage(tabId, extra).catch((e) => {
      ctx.log('bridge', 'отправка в Claude:', e);
      ctx.broadcast('kosmo:bridge.toast', { text: 'Не удалось отправить: ' + e.message, tone: 'danger' });
      return null;
    });
  }
  function pickSafe(tabId) {
    try { return picker.start(tabId); } catch (e) {
      ctx.broadcast('kosmo:bridge.toast', { text: 'Выбор элемента: ' + e.message, tone: 'danger' });
      return null;
    }
  }

  ctx.bridge = {
    toInbox: (o) => inbox.toInbox(o),
    mcpConfigPath: () => connect.writeConfig(),
    status,
    pageFetch: (tabId, o) => actions.pageFetch(tabId, o),
    sendPage,
    pick: (tabId) => picker.start(tabId),
    lastPicked: () => picker.last(),
    activity: (limit) => activity.list(limit),
    connectClaudeCode: (o) => connect.connectClaudeCode(o),
    command: () => connect.command(),
    url: () => connect.url(),
    tools: () => tools.names(),
    callTool: (name, args) => tools.invoke(name, args), // для отладки из dev-сервера
  };

  // ---------- IPC ----------
  const both = { allow: ['ui', 'internal'] };
  ctx.ipc.handle('kosmo:bridge.status', () => status(), both);
  ctx.ipc.handle('kosmo:bridge.activity', (p = {}) => activity.list(p && p.limit), both);
  ctx.ipc.handle('kosmo:bridge.clearActivity', () => activity.clear(), both);
  ctx.ipc.handle('kosmo:bridge.setAccess', (p = {}) => {
    const a = p && p.access;
    if (!ACCESS.includes(a)) throw new Error('режим доступа: off | read | full');
    S.set('claude.access', a);
    return status();
  }, both);
  ctx.ipc.handle('kosmo:bridge.connectClaudeCode', (p = {}) => connect.connectClaudeCode({ dryRun: !!(p && p.dryRun) }), both);
  ctx.ipc.handle('kosmo:bridge.command', () => ({ command: connect.command(), url: connect.url(), configPath: connect.writeConfig() }), both);
  ctx.ipc.handle('kosmo:bridge.regenerateToken', () => {
    S.set('claude.token', crypto.randomBytes(24).toString('hex'));
    return status();
  }, both);
  ctx.ipc.handle('kosmo:bridge.tools', () => tools.names(), both);
  // Панель Claude → вкладка «Журнал» (панель создаётся лениво — событие чуть позже открытия).
  ctx.ipc.handle('kosmo:bridge.openLog', () => {
    ctx.panel.open('claude');
    setTimeout(() => ctx.broadcast('kosmo:bridge.showLog', {}), 250);
    return true;
  }, both);
  ctx.ipc.handle('kosmo:bridge.pickDir', async (p = {}) => {
    const kind = p && p.kind === 'terminalCwd' ? 'terminalCwd' : 'inboxDir';
    const cur = kind === 'inboxDir' ? inbox.dir() : (S.peek('claude.terminalCwd') || desktopDir());
    const r = await ctx.electron.dialog.showOpenDialog(ctx.windows.main, {
      title: kind === 'inboxDir' ? 'Папка для файлов Claude' : 'Рабочая папка терминала',
      defaultPath: cur && fs.existsSync(cur) ? cur : undefined,
      properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { path: null };
    S.set('claude.' + kind, r.filePaths[0]);
    return { path: r.filePaths[0] };
  }, both);
  ctx.ipc.handle('kosmo:bridge.openDir', async (p = {}) => {
    const kind = p && p.kind === 'terminalCwd' ? 'terminalCwd' : 'inboxDir';
    const dir = kind === 'inboxDir' ? inbox.dir() : (S.peek('claude.terminalCwd') || desktopDir());
    await fs.promises.mkdir(dir, { recursive: true }).catch(() => {});
    const err = await ctx.electron.shell.openPath(dir);
    if (err) throw new Error(err);
    return true;
  }, both);
  ctx.ipc.handle('kosmo:bridge.sendToClaude', (p = {}) => sendPage(p && p.tabId != null ? p.tabId : undefined));
  ctx.ipc.handle('kosmo:bridge.pick', (p = {}) => picker.start(p && p.tabId != null ? p.tabId : undefined));
  picker.init();

  // ---------- команды ----------
  ctx.commands.register({
    id: 'claude.pickElement', title: 'Показать Claude элемент', category: 'Claude', keys: ['Ctrl+Shift+E'], repeat: false,
    appMenu: { section: 'tools', order: 60 },
    run: () => pickSafe(),
  });
  ctx.commands.register({
    id: 'claude.sendPage', title: 'Отправить в Claude', category: 'Claude', keys: ['Ctrl+Shift+Y'], repeat: false,
    appMenu: { section: 'tools', order: 61 },
    run: () => sendPageSafe(),
  });

  // ---------- контекстное меню страницы ----------
  ctx.contextMenu.addProvider((params, tab) => {
    if (!tab || !tab.wc || tab.wc.isDestroyed()) return [];
    const url = tab.wc.getURL();
    if (!/^(https?|file):/i.test(url)) return [];
    const x = params.x, y = params.y;
    const sel = String(params.selectionText || '');
    return [
      { section: 'tools', label: 'Показать Claude этот элемент', click: () => { try { picker.at(tab, x, y); } catch (e) { ctx.log('bridge', e.message); } } },
      { section: 'tools', label: sel.trim() ? 'Отправить в Claude (с выделением)' : 'Отправить в Claude', click: () => sendPageSafe(tab.id, { selection: sel }) },
    ];
  });

  // ---------- настройки на лету ----------
  S.on('change', (p) => {
    if (!(p === 'claude' || String(p).startsWith('claude.'))) return;
    if (p === 'claude' || /^claude\.(access|mcpEnabled|mcpPort)$/.test(p)) server.apply().catch((e) => ctx.log('bridge', e));
    if (p === 'claude' || /^claude\.(token|mcpPort)$/.test(p)) connect.writeConfig();
    broadcastStatus();
  });

  ctx.app.on('will-quit', () => { server.stop(); });

  internal = { server, connect };
}

async function start(ctx) {
  if (!internal) return;
  internal.connect.writeConfig();
  await internal.server.apply();
}

module.exports = { id: 'claude-bridge', init, start };
