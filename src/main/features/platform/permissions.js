'use strict';
// Разрешения сайтов: полоса-запрос под панелью («<сайт> запрашивает доступ: камера» [Разрешить] [Запретить]
// + «Запомнить»), решения — settings.sitePermissions[origin][ключ] = 'allow' | 'deny'.
// Ключи: notifications, geolocation, camera, microphone, midi, clipboard-read, display-capture, idle-detection,
// storage-access, local-network, external:<схема> (ссылки tg:, mailto:, zoommtg: …).
// Несколько запросов — очередь (по вкладкам; полоса показывает запрос активной вкладки).

const { originKey, hostOfOrigin, errText } = require('./util');

const KINDS = {
  notifications: { label: 'уведомления', icon: 'bell' },
  geolocation: { label: 'местоположение', icon: 'map-pin' },
  camera: { label: 'камера', icon: 'video' },
  microphone: { label: 'микрофон', icon: 'mic' },
  midi: { label: 'MIDI-устройства', icon: 'music' },
  'clipboard-read': { label: 'чтение буфера обмена', icon: 'clipboard' },
  'display-capture': { label: 'показ экрана', icon: 'monitor' },
  'idle-detection': { label: 'отслеживание бездействия', icon: 'eye' },
  'storage-access': { label: 'свои cookies на других сайтах', icon: 'cookie' },
  'local-network': { label: 'устройства в локальной сети', icon: 'server' },
};

// Электроновское имя разрешения → наши ключи (без media — у него камера/микрофон по details).
const MAP = {
  notifications: ['notifications'],
  geolocation: ['geolocation'],
  'geolocation-approximate': ['geolocation'],
  midi: ['midi'],
  midiSysex: ['midi'],
  'clipboard-read': ['clipboard-read'],
  'deprecated-sync-clipboard-read': ['clipboard-read'],
  'idle-detection': ['idle-detection'],
  'storage-access': ['storage-access'],
  'top-level-storage-access': ['storage-access'],
  'local-network-access': ['local-network'],
  'local-network': ['local-network'],
  'loopback-network': ['local-network'],
};

// Схемы, которые не отдаём системе ни при каком ответе (либо наши, либо известные векторы атак).
const BLOCKED_SCHEMES = new Set([
  'http', 'https', 'file', 'javascript', 'vbscript', 'data', 'blob', 'about', 'ftp', 'ws', 'wss', 'kosmo', 'chrome',
  'chrome-extension', 'devtools', 'view-source', 'filesystem', 'ms-msdt', 'search-ms', 'search', 'ms-officecmd',
  'hcp', 'shell', 'mk', 'res', 'its', 'ms-its', 'mhtml', 'ms-cxh', 'ms-cxh-full', 'ms-appinstaller', 'jar',
]);

function kindInfo(key) {
  if (key.startsWith('external:')) return { key, label: 'открыть приложение «' + key.slice(9) + ':»', icon: 'external-link', external: key.slice(9) };
  const k = KINDS[key] || { label: key, icon: 'shield' };
  return { key, label: k.label, icon: k.icon };
}

function createPermissions(ctx) {
  const { shell, desktopCapturer } = ctx.electron;
  const log = (...a) => ctx.log('permissions', ...a);
  const queue = []; // {id, tabId, origin, host, kinds, external, resolvers:[], createdAt, display}
  let seq = 0;
  let qTimer = null;

  // ---------- сохранённые решения ----------
  function all() {
    const v = ctx.settings.peek('sitePermissions');
    return v && typeof v === 'object' ? v : {};
  }
  function decision(origin, key) {
    const o = all()[origin];
    const v = o && typeof o === 'object' ? o[key] : undefined;
    return v === 'allow' || v === 'deny' ? v : undefined;
  }
  function save(origin, keys, value) {
    if (!origin || !keys.length) return;
    const cur = ctx.settings.get('sitePermissions') || {};
    const rec = Object.assign({}, cur[origin] || {});
    for (const k of keys) rec[k] = value;
    rec._at = Date.now();
    cur[origin] = rec;
    ctx.settings.set('sitePermissions', cur);
  }
  function revoke(origin, key) {
    const cur = ctx.settings.get('sitePermissions') || {};
    if (!cur[origin]) return false;
    if (key) {
      const rec = Object.assign({}, cur[origin]);
      delete rec[key];
      if (!Object.keys(rec).some((k) => !k.startsWith('_'))) delete cur[origin]; else cur[origin] = rec;
    } else delete cur[origin];
    ctx.settings.set('sitePermissions', cur);
    return true;
  }
  function listSaved() {
    const out = [];
    for (const [origin, rec] of Object.entries(all())) {
      if (!rec || typeof rec !== 'object') continue;
      const items = Object.keys(rec).filter((k) => !k.startsWith('_') && (rec[k] === 'allow' || rec[k] === 'deny'))
        .map((k) => Object.assign(kindInfo(k), { value: rec[k] }));
      if (items.length) out.push({ origin, host: hostOfOrigin(origin), at: rec._at || 0, items });
    }
    out.sort((a, b) => a.host.localeCompare(b.host));
    return out;
  }

  // ---------- разбор запроса ----------
  function keysFor(permission, details) {
    if (permission === 'media') {
      const types = (details && Array.isArray(details.mediaTypes) && details.mediaTypes) || [];
      const keys = [];
      if (types.includes('video')) keys.push('camera');
      if (types.includes('audio')) keys.push('microphone');
      return keys.length ? keys : null;
    }
    if (permission === 'openExternal') {
      const url = details && details.externalURL;
      let scheme = '';
      try { scheme = new URL(url).protocol.replace(/:$/, '').toLowerCase(); } catch (_) { scheme = ''; }
      return scheme ? ['external:' + scheme] : null;
    }
    return MAP[permission] || null;
  }

  function checkKeys(permission, details) {
    if (permission === 'media') {
      const t = details && details.mediaType;
      if (t === 'video') return ['camera'];
      if (t === 'audio') return ['microphone'];
      return null;
    }
    return MAP[permission] || null;
  }

  // ---------- очередь ----------
  function publicItem(q) {
    return {
      id: q.id, tabId: q.tabId, origin: q.origin, host: q.host, external: q.external || null,
      kinds: q.kinds.map(kindInfo), remember: q.rememberable !== false, sources: q.sources || null,
    };
  }
  function broadcastQueue() {
    if (qTimer) return;
    qTimer = setTimeout(() => {
      qTimer = null;
      ctx.broadcast('kosmo:perm.queue', { items: queue.map(publicItem) });
    }, 10);
  }

  function enqueue(o) {
    // Повторный такой же запрос (сайт спросил ещё раз, пока полоса висит) — тот же ответ.
    const same = queue.find((q) => q.tabId === o.tabId && q.origin === o.origin && q.kinds.join() === o.kinds.join() && (q.external || '') === (o.external || ''));
    if (same) return new Promise((resolve) => same.resolvers.push(resolve));
    return new Promise((resolve) => {
      queue.push(Object.assign({ id: 'p' + (++seq), resolvers: [resolve], createdAt: Date.now() }, o));
      broadcastQueue();
    });
  }

  function settle(q, result) {
    const i = queue.indexOf(q);
    if (i >= 0) queue.splice(i, 1);
    for (const r of q.resolvers) { try { r(result); } catch (_) { /* ignore */ } }
    broadcastQueue();
  }

  function respond(id, allow, remember, extra) {
    const q = queue.find((x) => x.id === id);
    if (!q) return false;
    allow = !!allow;
    if (remember && q.rememberable !== false) save(q.origin, q.kinds, allow ? 'allow' : 'deny');
    if (q.external) {
      if (allow) openExternal(q.externalUrl);
      settle(q, false); // Electron сам ничего не открывает — открываем мы (с проверкой схемы)
      return true;
    }
    settle(q, q.display ? { allow, sourceId: extra && extra.sourceId } : allow);
    return true;
  }

  function cancelTab(tabId, before) {
    for (const q of queue.slice()) {
      if (q.tabId !== tabId) continue;
      if (before && q.createdAt > before) continue;
      settle(q, q.external ? false : (q.display ? { allow: false } : false));
    }
  }

  function openExternal(url) {
    let scheme = '';
    try { scheme = new URL(url).protocol.replace(/:$/, '').toLowerCase(); } catch (_) { return false; }
    if (!scheme || BLOCKED_SCHEMES.has(scheme)) { log('схема не открывается:', scheme); return false; }
    shell.openExternal(url).catch((e) => log('не открылось:', errText(e)));
    return true;
  }

  // ---------- обработчик ядра ----------
  function onRequest(info) {
    const { permission, details } = info;
    if (permission === 'display-capture') return true; // спрашиваем в setDisplayMediaRequestHandler (там выбор экрана)
    const keys = keysFor(permission, details);
    if (!keys) return undefined;
    const origin = originKey(info.origin, details && details.requestingUrl);
    if (!origin || origin.startsWith('chrome-extension://')) return undefined;

    if (permission === 'openExternal') {
      const url = String((details && details.externalURL) || '');
      const scheme = keys[0].slice(9);
      if (BLOCKED_SCHEMES.has(scheme)) { log('запрещённая схема:', scheme); return false; }
      const d = decision(origin, keys[0]);
      if (d === 'allow') { openExternal(url); return false; }
      if (d === 'deny' || !info.tab) return false;
      return enqueue({ tabId: info.tab.id, origin, host: hostOfOrigin(origin), kinds: keys, external: scheme, externalUrl: url }).then(() => false);
    }

    let unknown = [];
    for (const k of keys) {
      const d = decision(origin, k);
      if (d === 'deny') return false;
      if (d !== 'allow') unknown.push(k);
    }
    if (!unknown.length) return true;
    if (!info.tab) return false; // не вкладка (попап расширения, служебное окно) — спросить негде
    return enqueue({ tabId: info.tab.id, origin, host: hostOfOrigin(origin), kinds: unknown });
  }

  function onCheck(info) {
    const keys = checkKeys(info.permission, info.details);
    if (!keys) return undefined;
    const origin = originKey(info.origin, info.details && info.details.requestingUrl);
    if (!origin) return undefined;
    let any = false;
    for (const k of keys) {
      const d = decision(origin, k);
      if (d === 'deny') return false;
      if (d === 'allow') any = true; else return undefined;
    }
    return any ? true : undefined;
  }

  ctx.permissions.setHandler((kind, info) => {
    try { return kind === 'check' ? onCheck(info) : onRequest(info); } catch (e) { log(errText(e)); return undefined; }
  });

  // getDisplayMedia: спрашиваем на полосе с выбором экрана/окна. «Запомнить» здесь нет — как в Chrome, каждый раз.
  async function onDisplayMedia(request, callback, containerId) {
    try {
      const frame = request.frame;
      let wc = null;
      try { wc = frame ? ctx.electron.webContents.fromFrame(frame) : null; } catch (_) { wc = null; }
      const tab = wc ? ctx.tabs.fromWebContents(wc) : null;
      const origin = originKey(request.securityOrigin, frame && frame.url);
      if (!tab || !origin) { callback({}); return; }
      if (decision(origin, 'display-capture') === 'deny') { callback({}); return; }
      let sources = [];
      try {
        sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
      } catch (e) { log('источники экрана:', errText(e)); }
      if (!sources.length) { callback({}); return; }
      const list = sources.slice(0, 40).map((s) => ({ id: s.id, name: s.id.startsWith('screen:') ? (sources.filter((x) => x.id.startsWith('screen:')).length > 1 ? s.name : 'Весь экран') : s.name }));
      const r = await enqueue({ tabId: tab.id, origin, host: hostOfOrigin(origin), kinds: ['display-capture'], display: true, rememberable: false, sources: list, containerId });
      if (!r || !r.allow) { callback({}); return; }
      const src = sources.find((s) => s.id === r.sourceId) || sources[0];
      const streams = { video: src };
      if (request.audioRequested && src.id.startsWith('screen:')) streams.audio = 'loopback';
      callback(streams);
    } catch (e) {
      log('показ экрана:', errText(e));
      try { callback({}); } catch (_) { /* ignore */ }
    }
  }

  ctx.sessions.onSession((ses, cid) => {
    try { ses.setDisplayMediaRequestHandler((req, cb) => onDisplayMedia(req, cb, cid)); } catch (e) { log('setDisplayMediaRequestHandler:', errText(e)); }
  });

  // Закрыли вкладку / ушли на другую страницу — её вопросы снимаются (ответ «нет», без запоминания).
  ctx.tabs.on('closed', (tab) => cancelTab(tab.id));
  ctx.tabs.on('view-created', (tab, wc) => {
    wc.on('did-navigate', () => cancelTab(tab.id, Date.now()));
  });

  return {
    respond, revoke, listSaved, cancelTab,
    queue: () => queue.map(publicItem),
    KINDS,
  };
}

module.exports = { createPermissions, KINDS };
