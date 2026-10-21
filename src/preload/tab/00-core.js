'use strict';
// Часть tab-preload от core: window.kosmo только для внутренних страниц kosmo://<хост>/ (ARCHITECTURE §12).
// На обычных сайтах в главный мир страницы ничего не выставляется.
if (!KOSMO.isInternal) return;

const ipc = KOSMO.ipcRenderer;
const ok = (ch) => typeof ch === 'string' && ch.indexOf('kosmo:') === 0;

KOSMO.contextBridge.exposeInMainWorld('kosmo', {
  invoke(channel, payload) {
    if (!ok(channel)) return Promise.reject(new Error('канал не разрешён: ' + channel));
    return ipc.invoke(channel, payload);
  },
  send(channel, payload) {
    if (!ok(channel)) throw new Error('канал не разрешён: ' + channel);
    ipc.send(channel, payload);
  },
  on(channel, cb) {
    if (!ok(channel) || typeof cb !== 'function') throw new Error('канал не разрешён: ' + channel);
    const listener = (_e, payload) => { try { cb(payload); } catch (e) { console.error('[kosmo]', channel, e); } };
    ipc.on(channel, listener);
    return () => ipc.removeListener(channel, listener);
  },
  kind: 'internal',
  host: KOSMO.host,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
});
