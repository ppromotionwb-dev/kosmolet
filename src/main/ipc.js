'use strict';
// Роутер IPC с проверкой отправителя (ARCHITECTURE §4).
// kind: 'ui' — chrome/panel/overlay; 'internal' — kosmo://<внутренний хост>/ во вкладке; 'tab' — любая страница вкладки.
// allow может сузить внутренние страницы до хоста: 'internal:settings' (meta.host — хост страницы).

const { ipcMain } = require('electron');
const { INTERNAL_HOSTS } = require('./sessions');

const TAB_PAYLOAD_LIMIT = 1024 * 1024; // 1 МБ на сообщение из вкладки

function createIpc(ctx) {
  const uiContents = new Set(); // id webContents нашего интерфейса
  const handlers = new Map(); // channel → { fn, allow }
  const listeners = new Map(); // channel → [{ fn, allow }]
  const syncHandlers = new Map();

  function registerUi(wc) {
    if (!wc) return;
    const id = wc.id;
    uiContents.add(id);
    wc.once('destroyed', () => uiContents.delete(id));
  }

  function isUi(wc) { return !!wc && uiContents.has(wc.id); }

  function parseUrl(u) { try { return new URL(u); } catch (_) { return null; } }

  function isInternalUrl(u) {
    const url = typeof u === 'string' ? parseUrl(u) : u;
    return !!url && url.protocol === 'kosmo:' && INTERNAL_HOSTS.includes(url.hostname);
  }

  // Определить, кто прислал сообщение. null — неизвестный отправитель.
  function classify(event) {
    const wc = event.sender;
    if (!wc || wc.isDestroyed()) return null;
    let frameUrl = '';
    try { frameUrl = event.senderFrame ? event.senderFrame.url : ''; } catch (_) { frameUrl = ''; }
    const meta = { kind: null, webContents: wc, tab: null, frameUrl };
    if (isUi(wc)) {
      const u = parseUrl(frameUrl);
      // UI-страницы — только kosmo://ui/ (в devtools-виде или после навигации — отказ).
      if (u && u.protocol === 'kosmo:' && u.hostname === 'ui') { meta.kind = 'ui'; return meta; }
      return null;
    }
    const tab = ctx.tabs && ctx.tabs.fromWebContents(wc);
    if (!tab) return null;
    meta.tab = tab;
    const f = event.senderFrame;
    const mf = wc.mainFrame;
    const isMain = !!(f && mf && f.processId === mf.processId && f.routingId === mf.routingId);
    meta.kind = isMain && isInternalUrl(frameUrl) ? 'internal' : 'tab';
    // Хост внутренней страницы (settings, history…): для прав по странице — allow: ['internal:settings'].
    if (meta.kind === 'internal') { const u = parseUrl(frameUrl); meta.host = u ? u.hostname : ''; }
    return meta;
  }

  function checkAllowed(channel, allow, meta) {
    if (!meta) throw new Error(`IPC ${channel}: неизвестный отправитель`);
    // Внутренняя страница может пользоваться и каналами вкладок.
    if (allow.includes(meta.kind)) return;
    if (meta.kind === 'internal' && meta.host && allow.includes('internal:' + meta.host)) return;
    if (meta.kind === 'internal' && allow.includes('tab')) return;
    throw new Error(`IPC ${channel}: отказано (${meta.kind})`);
  }

  function checkPayload(channel, meta, payload) {
    if (meta.kind !== 'tab') return;
    let size = 0;
    try { size = payload === undefined ? 0 : JSON.stringify(payload).length; } catch (_) { throw new Error(`IPC ${channel}: данные не сериализуются`); }
    if (size > TAB_PAYLOAD_LIMIT) throw new Error(`IPC ${channel}: слишком большие данные`);
  }

  function normAllow(channel, opts, def) {
    const allow = (opts && opts.allow) || def;
    if (!Array.isArray(allow) || !allow.length) throw new Error(`IPC ${channel}: пустой allow`);
    if (channel.startsWith('kosmo-tab:')) return allow;
    if (!channel.startsWith('kosmo:')) throw new Error(`IPC ${channel}: канал должен начинаться с kosmo: или kosmo-tab:`);
    if (allow.includes('tab')) throw new Error(`IPC ${channel}: 'tab' разрешён только для каналов kosmo-tab:*`);
    return allow;
  }

  function handle(channel, fn, opts) {
    const allow = normAllow(channel, opts, ['ui']);
    if (handlers.has(channel)) throw new Error(`IPC ${channel}: обработчик уже зарегистрирован`);
    handlers.set(channel, { fn, allow });
    ipcMain.handle(channel, async (event, payload) => {
      const meta = classify(event);
      checkAllowed(channel, allow, meta);
      checkPayload(channel, meta, payload);
      return fn(payload, meta);
    });
  }

  function removeHandler(channel) {
    if (!handlers.has(channel)) return;
    handlers.delete(channel);
    ipcMain.removeHandler(channel);
  }

  function on(channel, fn, opts) {
    const allow = normAllow(channel, opts, ['ui']);
    let list = listeners.get(channel);
    if (!list) {
      list = [];
      listeners.set(channel, list);
      ipcMain.on(channel, (event, payload) => {
        const meta = classify(event);
        for (const l of list.slice()) {
          try {
            checkAllowed(channel, l.allow, meta);
            checkPayload(channel, meta, payload);
            const r = l.fn(payload, meta);
            if (r && typeof r.catch === 'function') r.catch((e) => ctx.log('ipc', channel, e));
          } catch (e) {
            ctx.log('ipc', channel, e.message);
          }
        }
      });
    }
    const entry = { fn, allow };
    list.push(entry);
    return () => { const i = list.indexOf(entry); if (i >= 0) list.splice(i, 1); };
  }

  function handleSync(channel, fn, opts) {
    if (!channel.startsWith('kosmo-tab:')) throw new Error(`IPC ${channel}: sendSync только для kosmo-tab:*`);
    const allow = normAllow(channel, opts, ['tab']);
    if (syncHandlers.has(channel)) throw new Error(`IPC ${channel}: обработчик уже зарегистрирован`);
    syncHandlers.set(channel, fn);
    ipcMain.on(channel, (event, payload) => {
      try {
        const meta = classify(event);
        checkAllowed(channel, allow, meta);
        checkPayload(channel, meta, payload);
        const r = fn(payload, meta);
        event.returnValue = r === undefined ? null : r;
      } catch (e) {
        event.returnValue = { error: e.message };
      }
    });
  }

  return { handle, removeHandler, on, handleSync, registerUi, isUi, isInternalUrl, classify };
}

module.exports = { createIpc };
