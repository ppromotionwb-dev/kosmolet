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
    out(`${ts} [${scope}] ${line}\n`);
  }

  // Вывод лога. В dev stdout перенаправлен в файл (start-dev.ps1), и синхронная запись каждой строки
  // стоила десятки мс потока main (PERF-17): копим строки и пишем одним асинхронным вызовом,
  // по одному за раз (порядок сохраняется); остаток — синхронно при выходе.
  const fs = require('fs');
  let pending = '';
  let inFlight = false;
  let flushTimer = null;
  function pump() {
    flushTimer = null;
    if (inFlight || !pending) return;
    const chunk = pending;
    pending = '';
    inFlight = true;
    fs.write(1, chunk, (err) => {
      inFlight = false;
      if (err) { /* stdout закрыт — молча */ }
      if (pending && !flushTimer) flushTimer = setTimeout(pump, 0);
    });
  }
  function out(s) {
    // eslint-disable-next-line no-console
    if (!flags || !flags.dev) { console.log(s.slice(0, -1)); return; }
    pending += s;
    if (pending.length > 1 << 20) pending = pending.slice(-(1 << 20)); // не копить бесконечно, если stdout встал
    if (!flushTimer && !inFlight) { flushTimer = setTimeout(pump, 30); if (flushTimer.unref) flushTimer.unref(); }
  }
  process.on('exit', () => { if (pending) { try { fs.writeSync(1, pending); } catch (_) { /* нет stdout */ } pending = ''; } });

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
