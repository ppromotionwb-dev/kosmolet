'use strict';
// Preload интерфейса (chrome / panel / overlay): window.kosmo, только каналы kosmo:* (ARCHITECTURE §4).
// chrome: sandbox:false — чтобы фичи могли подключать свои модули (ctx.uiPreload.addModule), например
// electron-chrome-extensions/preload. Панель и overlay — sandbox:true: модулей им не передаём, require только 'electron'.

const { contextBridge, ipcRenderer } = require('electron');

function arg(name) {
  const prefix = '--' + name + '=';
  const a = process.argv.find((x) => x.startsWith(prefix));
  return a ? a.slice(prefix.length) : '';
}

const ok = (ch) => typeof ch === 'string' && ch.startsWith('kosmo:');

const view = arg('kosmo-view') || 'ui';
const appVersion = arg('kosmo-app-version');

contextBridge.exposeInMainWorld('kosmo', {
  invoke(channel, payload) {
    if (!ok(channel)) return Promise.reject(new Error('канал не разрешён: ' + channel));
    return ipcRenderer.invoke(channel, payload);
  },
  send(channel, payload) {
    if (!ok(channel)) throw new Error('канал не разрешён: ' + channel);
    ipcRenderer.send(channel, payload);
  },
  on(channel, cb) {
    if (!ok(channel) || typeof cb !== 'function') throw new Error('канал не разрешён: ' + channel);
    const listener = (_e, payload) => { try { cb(payload); } catch (e) { console.error('[kosmo]', channel, e); } };
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  kind: 'ui',
  view, // 'chrome' | 'panel' | 'overlay'
  platform: process.platform,
  versions: {
    app: appVersion,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});

// Дополнительные модули preload от фич (пути/имена модулей, JSON в аргументе).
let extra = [];
try { extra = JSON.parse(decodeURIComponent(arg('kosmo-ui-modules') || '%5B%5D')); } catch (_) { extra = []; }
for (const m of extra) {
  try { require(m); } catch (e) { console.error('[kosmo ui-preload] модуль', m, e); }
}
