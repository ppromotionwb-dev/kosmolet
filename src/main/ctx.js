'use strict';
// Общий объект main-процесса (ARCHITECTURE §3).

const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const { createStoreFactory } = require('./store');

const LOG_LIMIT = 1000;

function createCtx({ app, electron, flags, paths }) {
  const bus = new EventEmitter();
  bus.setMaxListeners(200);
  const logs = [];

  function log(scope, ...args) {
    const line = args.map((a) => {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === 'object') { try { return JSON.stringify(a); } catch (_) { return String(a); } }
      return String(a);
    }).join(' ');
    const t = new Date();
    const ts = t.toTimeString().slice(0, 8) + '.' + String(t.getMilliseconds()).padStart(3, '0');
    logs.push({ ts: t.getTime(), scope, line });
    if (logs.length > LOG_LIMIT) logs.splice(0, logs.length - LOG_LIMIT);
    // eslint-disable-next-line no-console
    console.log(`${ts} [${scope}] ${line}`);
  }

  const ctx = {
    app,
    electron,
    flags,
    paths,
    bus,
    log,
    logs,
    featureErrors: [],
    features: {},
    ready: false,
    quitting: false,
    store: createStoreFactory(paths.userData, log),
    settings: null,
    ipc: null,
    windows: null,
    tabs: null,
    sessions: null,
    permissions: null,
    overlay: null,
    panel: null,
    commands: null,
    contextMenu: null,
    search: null,
    preload: null,
    uiPreload: null,
    broadcast: () => {},
  };

  // inbox зависит от настроек — вычисляем при обращении.
  Object.defineProperty(paths, 'inbox', {
    enumerable: true,
    get() {
      const dir = ctx.settings && ctx.settings.peek('claude.inboxDir');
      if (dir) return dir;
      let docs;
      try { docs = app.getPath('documents'); } catch (_) { docs = path.join(os.homedir(), 'Documents'); }
      return path.join(docs, 'Космолёт', 'claude-inbox');
    },
  });

  return ctx;
}

module.exports = { createCtx };
