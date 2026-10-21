'use strict';
// ux-chrome: загрузки. will-download во всех сессиях-контейнерах → settings.downloads.dir или системные «Загрузки»,
// уникальное имя «file (1).ext»; downloads.ask — диалог сохранения. Список — userData/downloads.json (последние 200).

const fs = require('fs');
const path = require('path');

const KEEP = 200;
const EMIT_MS = 400;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

function sanitize(name) {
  let s = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim();
  s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (!s) s = 'download';
  const ext = path.extname(s);
  const base = s.slice(0, s.length - ext.length);
  if (RESERVED.test(base)) s = '_' + s;
  if (s.length > 180) s = s.slice(0, 180 - ext.length) + ext;
  return s;
}

// «file.ext» → «file (1).ext»; .tar.gz и подобные — целиком как расширение.
function splitName(name) {
  const m = /^(.*?)(\.tar\.[a-z0-9]{1,5})$/i.exec(name);
  if (m && m[1]) return [m[1], m[2]];
  const ext = path.extname(name);
  if (!ext || ext === name) return [name, ''];
  return [name.slice(0, -ext.length), ext];
}

function createDownloads(ctx) {
  const { app, shell, dialog } = ctx.electron;
  const store = ctx.store('downloads', { version: 1, items: [] }, { debounceMs: 1000 });
  let data = store.get();
  if (!data || typeof data !== 'object') data = { version: 1, items: [] };
  if (!Array.isArray(data.items)) data.items = [];
  // прерванные прошлым выходом
  for (const r of data.items) {
    if (r.state === 'progressing') { r.state = 'interrupted'; r.paused = false; r.speed = 0; }
    r.session = false;
    r.unseen = false;
  }
  store.set(data);

  const sessionStart = Date.now();
  const live = new Map(); // id → DownloadItem
  const reserved = new Set();
  let seq = 0;
  const pending = new Map();
  let emitTimer = null;

  function dir() {
    const d = ctx.settings.peek('downloads.dir');
    if (typeof d === 'string' && d.trim()) {
      try { if (fs.statSync(d).isDirectory()) return d; } catch (_) { /* нет папки — системная */ }
    }
    try { return app.getPath('downloads'); } catch (_) { return app.getPath('home'); }
  }

  function exists(p) { try { fs.accessSync(p); return true; } catch (_) { return false; } }

  function uniquePath(d, name) {
    const [base, ext] = splitName(name);
    for (let i = 0; i < 10000; i++) {
      const fn = i === 0 ? name : `${base} (${i})${ext}`;
      const p = path.join(d, fn);
      if (!reserved.has(p.toLowerCase()) && !exists(p)) return p;
    }
    return path.join(d, `${base} (${Date.now()})${ext}`);
  }

  function pub(r, checkFile) {
    const o = Object.assign({}, r);
    if (checkFile && r.state === 'completed' && r.path) o.exists = exists(r.path);
    return o;
  }

  function flushEmit() {
    if (emitTimer) { clearTimeout(emitTimer); emitTimer = null; }
    if (!pending.size) return;
    const items = Array.from(pending.values()).map((r) => pub(r));
    pending.clear();
    ctx.broadcast('kosmo:downloads.changed', { items, summary: summary() });
  }
  function emit(r, now, extra) {
    pending.set(r.id, r);
    if (now || extra) {
      flushEmit();
      if (extra) ctx.broadcast('kosmo:downloads.changed', Object.assign({ items: [], summary: summary() }, extra));
      return;
    }
    if (!emitTimer) emitTimer = setTimeout(flushEmit, EMIT_MS);
  }
  function emitRemoved(ids) {
    for (const id of ids) pending.delete(id);
    ctx.broadcast('kosmo:downloads.changed', { items: [], removed: ids, summary: summary() });
  }

  function save() {
    if (data.items.length > KEEP) {
      // живые не выбрасываем
      const keep = [];
      for (const r of data.items) if (keep.length < KEEP || live.has(r.id)) keep.push(r);
      data.items = keep;
    }
    store.set(data);
  }

  function summary() {
    let active = 0, received = 0, total = 0, unknown = false, unseen = 0, sessionCount = 0;
    for (const r of data.items) {
      if (r.session) sessionCount++;
      if (r.unseen) unseen++;
      if (r.state === 'progressing') {
        active++;
        received += r.received || 0;
        if (r.total > 0) total += r.total; else unknown = true;
      }
    }
    return { active, received, total, unknown, unseen, sessionCount, progress: active && total && !unknown ? Math.min(1, received / total) : null };
  }

  // Пустая вкладка, открытая только ради загрузки (target=_blank на файл), — закрыть, как в Chrome.
  function closeBlankTab(wc, url) {
    try {
      if (!wc || wc.isDestroyed() || !ctx.tabs) return;
      const tab = ctx.tabs.fromWebContents(wc);
      if (!tab || tab.openerId == null || Date.now() - tab.createdAt > 15000) return;
      const cur = wc.getURL();
      const n = wc.navigationHistory.getAllEntries().length;
      if (n > 1) return;
      if (cur && cur !== 'about:blank' && cur !== url) return;
      setTimeout(() => { if (ctx.tabs.get(tab.id)) ctx.tabs.close(tab.id); }, 60);
    } catch (_) { /* не критично */ }
  }

  function onWillDownload(item, wc, containerId) {
    const id = 'd' + Date.now().toString(36) + (++seq);
    const ask = !!ctx.settings.peek('downloads.ask');
    const name = sanitize(item.getFilename());
    const d = dir();
    const r = {
      id, url: item.getURL(), filename: name, path: '', mime: item.getMimeType() || '',
      total: item.getTotalBytes() || 0, received: 0, state: 'progressing', paused: false, speed: 0,
      startTime: Date.now(), endTime: 0, containerId: containerId || 'main', session: true, unseen: false,
    };
    if (ask) {
      item.setSaveDialogOptions({ title: 'Сохранить файл', defaultPath: path.join(d, name), buttonLabel: 'Сохранить' });
    } else {
      const p = uniquePath(d, name);
      reserved.add(p.toLowerCase());
      item.setSavePath(p);
      r.path = p;
      r.filename = path.basename(p);
    }
    live.set(id, item);
    data.items.unshift(r);
    save();

    item.on('updated', (_e, state) => {
      const sp = item.getSavePath();
      if (sp && sp !== r.path) { r.path = sp; r.filename = path.basename(sp); }
      r.received = item.getReceivedBytes();
      r.total = item.getTotalBytes() || 0;
      r.state = state === 'interrupted' ? 'interrupted' : 'progressing';
      r.paused = item.isPaused();
      r.speed = r.paused ? 0 : item.getCurrentBytesPerSecond();
      emit(r);
    });
    item.once('done', (_e, state) => {
      live.delete(id);
      if (r.path) reserved.delete(r.path.toLowerCase());
      const sp = item.getSavePath();
      if (sp) { r.path = sp; r.filename = path.basename(sp); }
      r.state = state; // completed | cancelled | interrupted
      r.received = item.getReceivedBytes();
      r.total = item.getTotalBytes() || r.received;
      r.endTime = Date.now();
      r.paused = false;
      r.speed = 0;
      if (state === 'completed') r.unseen = true;
      // отмена в диалоге сохранения — записи не было
      if (state === 'cancelled' && !r.path) {
        const i = data.items.indexOf(r);
        if (i >= 0) data.items.splice(i, 1);
        save();
        emitRemoved([id]);
        return;
      }
      save();
      emit(r, true);
      ctx.log('ux-downloads', `${state === 'completed' ? 'сохранено' : state === 'cancelled' ? 'отменено' : 'прервано'}: ${r.filename}`);
    });
    emit(r, true, { started: id });
    closeBlankTab(wc, r.url);
  }

  ctx.sessions.onSession((ses, containerId) => {
    ses.on('will-download', (_e, item, wc) => {
      try { onWillDownload(item, wc, containerId); } catch (e) { ctx.log('ux-downloads', 'will-download:', e.message); }
    });
  });

  function rec(id) {
    const r = data.items.find((x) => x.id === id);
    if (!r) throw new Error('загрузка не найдена');
    return r;
  }

  async function open(id) {
    const r = rec(id);
    if (r.state !== 'completed' || !r.path) throw new Error('файл ещё не загружен');
    if (!exists(r.path)) throw new Error('файл удалён или перемещён');
    const err = await shell.openPath(r.path);
    if (err) throw new Error(err);
    if (r.unseen) { r.unseen = false; save(); emit(r, true); }
    return true;
  }

  function show(id) {
    const r = rec(id);
    if (r.path && exists(r.path)) { shell.showItemInFolder(r.path); return true; }
    shell.openPath(r.path ? path.dirname(r.path) : dir());
    return true;
  }

  function cancel(id) { const it = live.get(id); if (it) it.cancel(); return !!it; }
  function pause(id) { const it = live.get(id); if (it && !it.isPaused()) it.pause(); const r = rec(id); r.paused = true; r.speed = 0; emit(r, true); return true; }
  function resume(id) {
    const it = live.get(id);
    const r = rec(id);
    if (it && it.canResume()) { it.resume(); r.paused = false; emit(r, true); return true; }
    return retry(id);
  }

  function remove(id) {
    const it = live.get(id);
    if (it) { try { it.cancel(); } catch (_) {} live.delete(id); }
    const i = data.items.findIndex((x) => x.id === id);
    if (i < 0) return false;
    data.items.splice(i, 1);
    save();
    emitRemoved([id]);
    return true;
  }

  function clear() {
    const ids = [];
    data.items = data.items.filter((r) => { if (live.has(r.id)) return true; ids.push(r.id); return false; });
    save();
    if (ids.length) emitRemoved(ids);
    return ids.length;
  }

  function retry(id) {
    const r = rec(id);
    if (!/^(https?|data|blob):/i.test(r.url)) throw new Error('адрес нельзя загрузить заново');
    const ses = ctx.sessions.get(r.containerId || 'main');
    remove(id);
    ses.downloadURL(r.url);
    return true;
  }

  function markSeen() {
    let n = 0;
    for (const r of data.items) if (r.unseen) { r.unseen = false; n++; pending.set(r.id, r); }
    if (n) { save(); flushEmit(); }
    return n;
  }

  function list(opts = {}) {
    return { items: data.items.map((r) => pub(r, !!opts.checkFiles)), summary: summary(), sessionStart, dir: dir(), ask: !!ctx.settings.peek('downloads.ask') };
  }

  async function chooseDir() {
    const win = ctx.windows.main;
    const r = await dialog.showOpenDialog(win, { title: 'Папка для загрузок', defaultPath: dir(), properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return null;
    ctx.settings.set('downloads.dir', r.filePaths[0]);
    return r.filePaths[0];
  }

  function openDir() { shell.openPath(dir()); return true; }

  return { list, open, show, cancel, pause, resume, remove, clear, retry, markSeen, chooseDir, openDir, dir, summary, uniquePath, sanitize };
}

module.exports = { createDownloads, sanitize };
