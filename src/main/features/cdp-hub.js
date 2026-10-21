'use strict';
// Фича «cdp-hub» (владелец devtools): CDP-захват сети и консоли вкладок, API ctx.cdp (ARCHITECTURE §13).
//
// - debugger.attach('1.3') лениво: на view-created, если settings.devtools.capture !== 'off', иначе по ensure().
// - Network.enable (буфер тел 64 МБ / 8 МБ на ресурс); durable messages (тела переживают переход на другой
//   процесс) — только для вкладки, открытой в «Сеть и API»; Runtime.enable/Log.enable — консоль (devtools.console).
// - Запись: requestWillBeSent/ExtraInfo, responseReceived/ExtraInfo, loadingFinished/Failed, WebSocket и
//   EventSource. Режим 'api' хранит XHR/Fetch/Document/EventSource/WebSocket/Other/Preflight, 'all' — всё.
// - Кольцевой буфер devtools.maxEntries на вкладку; переход основного фрейма — маркер-разделитель
//   (журнал не очищается, если devtools.preserveLog). Тела — лениво (Network.getResponseBody) с LRU-кэшем.
// - Повторное подключение при detach (кроме закрытия вкладки), отключение при выгрузке вкладки.
// - pageFetch — fetch в контексте страницы (её cookies и origin) из изолированного мира.

const path = require('path');
const { EventEmitter } = require('events');

const C = require(path.join(__dirname, '..', '..', 'renderer', 'panel', 'tools', 'devtools-common.js'));

const PROTOCOL = '1.3';
const NET_BUFFER = 64 * 1024 * 1024;
const NET_RESOURCE_BUFFER = 8 * 1024 * 1024;
const POST_DATA_INLINE = 64 * 1024;          // тело запроса прямо в requestWillBeSent; больше — лениво
const CONSOLE_LIMIT = 500;
const CONSOLE_TEXT = 8 * 1024;
const PENDING_EXTRA_LIMIT = 400;
const WS_FRAMES_LIMIT = 300;
const WS_FRAME_TEXT = 64 * 1024;
const BODY_CACHE_BYTES = 48 * 1024 * 1024;
const BODY_LIMIT_DEFAULT = 5 * 1024 * 1024;
const FETCH_BODY_LIMIT = 5 * 1024 * 1024;
const FETCH_REQ_LIMIT = 10 * 1024 * 1024;
const FETCH_WORLD = 1717;                      // свой изолированный мир для pageFetch (999 — preload)
const BATCH_MS = 150;
const API_TYPES = new Set(C.API_TYPES);

function now() { return Date.now(); }
function truncate(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; }

// RemoteObject → текст для журнала консоли
function remoteText(o) {
  if (!o) return '';
  switch (o.type) {
    case 'string': return String(o.value);
    case 'number': case 'boolean': case 'bigint': return o.unserializableValue || String(o.value !== undefined ? o.value : o.description);
    case 'undefined': return 'undefined';
    case 'symbol': case 'function': return o.description || o.type;
    default: break;
  }
  if (o.subtype === 'null') return 'null';
  if (o.subtype === 'error') return o.description || 'Error';
  const p = o.preview;
  if (p && Array.isArray(p.properties)) {
    const items = p.properties.map((x) => (p.subtype === 'array' ? '' : x.name + ': ') + (x.type === 'string' ? JSON.stringify(x.value) : x.value));
    const body = items.join(', ') + (p.overflow ? ', …' : '');
    return p.subtype === 'array' ? '[' + body + ']' : (o.className && o.className !== 'Object' ? o.className + ' ' : '') + '{' + body + '}';
  }
  return o.description || o.className || o.type;
}

function levelOf(t) {
  if (t === 'error' || t === 'assert') return 'error';
  if (t === 'warning' || t === 'warn') return 'warn';
  if (t === 'info') return 'info';
  if (t === 'debug' || t === 'verbose') return 'debug';
  return 'log';
}

function createHub(ctx) {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);
  const states = new Map();      // tabId → state
  const watched = new Set();     // вкладки, для которых нужны пакеты изменений (панель «Сеть»)
  const bodyCache = new Map();   // `${tabId}:${id}` → {body, base64Encoded, bytes}
  let bodyBytes = 0;
  const S = ctx.settings;

  const setting = (k, d) => { const v = S.peek('devtools.' + k); return v === undefined ? d : v; };
  const captureMode = () => { const m = setting('capture', 'api'); return m === 'off' || m === 'all' ? m : 'api'; };
  const maxEntries = () => Math.max(100, Math.min(100000, Number(setting('maxEntries', 1500)) || 1500));

  function stateOf(tabId, create) {
    const id = Number(tabId);
    let st = states.get(id);
    if (!st && create) {
      st = {
        tabId: id, wc: null, attached: false, attaching: null, netOn: false, consoleOn: false, mode: null,
        entries: [], byId: new Map(), live: new Map(), extra: new Map(), console: [],
        paused: false, seq: 0, navSeq: 0, hop: 0, mainFrameId: null,
        dirty: new Map(), added: [], reset: false, batchTimer: null, onMessage: null, onDetach: null, closed: false,
        modeOverride: null, netNeeded: false, durable: false,
      };
      states.set(id, st);
    }
    return st || null;
  }
  const tabMode = (st) => st.modeOverride || captureMode();

  // ---------- подключение ----------

  function wcOf(tabId) {
    const tab = ctx.tabs.get(tabId);
    const wc = tab && tab.wc;
    return wc && !wc.isDestroyed() ? wc : null;
  }

  function cmd(st, method, params) {
    const wc = st.wc;
    if (!wc || wc.isDestroyed() || !st.attached) return Promise.reject(new Error('отладчик не подключён'));
    return wc.debugger.sendCommand(method, params || {});
  }

  async function attach(st) {
    const wc = st.wc;
    if (!wc || wc.isDestroyed()) throw new Error('у вкладки нет страницы (выгружена)');
    if (st.attached) return;
    if (st.attaching) return st.attaching;
    st.attaching = (async () => {
      const dbg = wc.debugger;
      if (!dbg.isAttached()) {
        try { dbg.attach(PROTOCOL); } catch (e) { throw new Error('не удалось подключить отладчик: ' + e.message); }
      }
      st.attached = true;
      st.onMessage = (_e, method, params, sessionId) => { if (!sessionId) onMessage(st, method, params); };
      st.onDetach = (_e, reason) => onDetach(st, wc, reason);
      dbg.on('message', st.onMessage);
      dbg.on('detach', st.onDetach);
      // Network.enable уходит синхронно (до loadURL новой вкладки) — документ попадает в журнал.
      const domains = applyDomains(st);
      const tree = dbg.sendCommand('Page.getFrameTree').then((ft) => {
        st.mainFrameId = ft && ft.frameTree && ft.frameTree.frame ? ft.frameTree.frame.id : st.mainFrameId;
      }, () => {});
      await Promise.all([domains, tree]);
      emitter.emit('attached', st.tabId, wc);
    })();
    try { await st.attaching; } catch (e) { st.attached = false; unhook(st, wc); throw e; } finally { st.attaching = null; }
  }

  function unhook(st, wc) {
    if (!wc || wc.isDestroyed()) return;
    if (st.onMessage) wc.debugger.removeListener('message', st.onMessage);
    if (st.onDetach) wc.debugger.removeListener('detach', st.onDetach);
    st.onMessage = st.onDetach = null;
  }

  // Включить/выключить домены по режиму записи и настройке консоли.
  async function applyDomains(st) {
    if (!st.attached) return;
    const mode = tabMode(st);
    // сеть нужна и без записи — эмуляции (ограничение скорости, отключение кэша)
    const wantNet = mode !== 'off' || st.netNeeded;
    const wantConsole = mode !== 'off' && setting('console', true) !== false;
    st.mode = mode;
    try {
      if (wantNet && !st.netOn) {
        st.durable = false;
        const durable = watched.has(st.tabId) ? setDurable(st, true) : null;
        await cmd(st, 'Network.enable', { maxTotalBufferSize: NET_BUFFER, maxResourceBufferSize: NET_RESOURCE_BUFFER, maxPostDataSize: POST_DATA_INLINE });
        st.netOn = true;
        await durable;
      } else if (!wantNet && st.netOn) {
        st.netOn = false;
        await cmd(st, 'Network.disable').catch(() => {});
      }
      if (wantConsole && !st.consoleOn) {
        st.consoleOn = true;
        await Promise.all([cmd(st, 'Runtime.enable'), cmd(st, 'Log.enable')]);
      } else if (!wantConsole && st.consoleOn) {
        st.consoleOn = false;
        await Promise.all([cmd(st, 'Runtime.disable').catch(() => {}), cmd(st, 'Log.disable').catch(() => {})]);
      }
    } catch (e) {
      ctx.log('cdp', `вкладка ${st.tabId}: домены CDP:`, e.message);
    }
  }

  // Durable messages: Chromium хранит тела вне процесса страницы, и они переживают переход на другой сайт.
  // Это копия КАЖДОГО ответа (и картинок): на странице из 180 ресурсов +25–40% к загрузке (замер 21.10.2026),
  // поэтому включаем только для вкладки, которую сейчас смотрят в «Сеть и API».
  function setDurable(st, on) {
    on = !!on;
    if (st.durable === on) return Promise.resolve();
    st.durable = on;
    return cmd(st, 'Network.configureDurableMessages', on ? { maxTotalBufferSize: NET_BUFFER, maxResourceBufferSize: NET_RESOURCE_BUFFER } : {}).catch(() => {});
  }

  function onDetach(st, wc, reason) {
    unhook(st, wc);
    st.attached = false; st.netOn = false; st.consoleOn = false;
    for (const e of st.live.values()) if (e.state === 'pending') { e.state = 'failed'; e.failed = true; e.errorText = 'отладчик отключён'; markDirty(st, e); }
    st.live.clear();
    emitter.emit('detached', st.tabId, reason);
    if (st.closed || ctx.quitting || !wc || wc.isDestroyed() || st.wc !== wc) return;
    // Отключили не мы (сбой процесса и т.п.) — подключаемся снова.
    ctx.log('cdp', `вкладка ${st.tabId}: отладчик отключён (${reason}), подключаю снова`);
    setTimeout(() => {
      if (st.closed || st.wc !== wc || wc.isDestroyed() || st.attached) return;
      attach(st).catch((e) => ctx.log('cdp', `вкладка ${st.tabId}: повторное подключение:`, e.message));
    }, 400);
  }

  function detach(st) {
    const wc = st.wc;
    unhook(st, wc);
    if (wc && !wc.isDestroyed() && st.attached) { try { wc.debugger.detach(); } catch (_) { /* уже */ } }
    st.attached = false; st.netOn = false; st.consoleOn = false;
  }

  // ---------- запись ----------

  function scheduleBatch(st) {
    if (st.batchTimer || !watched.has(st.tabId)) return;
    st.batchTimer = setTimeout(() => flushBatch(st), BATCH_MS);
  }
  function flushBatch(st) {
    if (st.batchTimer) { clearTimeout(st.batchTimer); st.batchTimer = null; }
    if (!watched.has(st.tabId)) { st.dirty.clear(); st.added = []; st.reset = false; return; }
    const reset = st.reset;
    const addedIds = new Set(st.added.map((e) => e.id));
    const add = st.added.filter((e) => st.byId.get(e.id) === e).map(pub);
    const upd = [];
    for (const e of st.dirty.values()) if (!addedIds.has(e.id) && st.byId.get(e.id) === e) upd.push(pub(e));
    st.added = []; st.dirty.clear(); st.reset = false;
    if (!reset && !add.length && !upd.length) return;
    emitter.emit('batch', st.tabId, { reset, add, upd, total: st.entries.length });
  }
  // событие контракта ctx.cdp.on('entry') — только если кто-то слушает (без лишних копий записи)
  function emitEntry(st, e) {
    if (emitter.listenerCount('entry')) emitter.emit('entry', st.tabId, pub(e));
  }
  function markDirty(st, e) {
    if (!watched.has(st.tabId)) return;
    st.dirty.set(e.id, e);
    scheduleBatch(st);
  }

  function push(st, e) {
    st.entries.push(e);
    st.byId.set(e.id, e);
    if (watched.has(st.tabId)) { st.added.push(e); scheduleBatch(st); }
    const max = maxEntries();
    if (st.entries.length > max + Math.max(20, Math.floor(max / 20))) {
      const drop = st.entries.splice(0, st.entries.length - max);
      for (const d of drop) {
        st.byId.delete(d.id);
        if (st.live.get(d.rid) === d) st.live.delete(d.rid);
        dropBody(st.tabId, d.id);
      }
      if (watched.has(st.tabId)) { st.reset = true; scheduleBatch(st); }
    }
  }

  function clear(tabId) {
    const st = stateOf(tabId, false);
    if (!st) return false;
    for (const e of st.entries) dropBody(st.tabId, e.id);
    st.entries = []; st.byId.clear(); st.live.clear(); st.extra.clear(); st.console = [];
    st.added = []; st.dirty.clear();
    if (watched.has(st.tabId)) { st.reset = true; flushBatch(st); }
    emitter.emit('cleared', st.tabId);
    return true;
  }

  function addMarker(st, url) {
    st.navSeq++;
    const e = { id: 'nav:' + st.navSeq + ':' + (++st.seq), rid: null, seq: st.seq, marker: true, ts: now(), url: String(url || ''), state: 'done' };
    push(st, e);
  }

  function takeExtra(st, rid) {
    const x = st.extra.get(rid);
    if (x) st.extra.delete(rid);
    return x || null;
  }
  function stashExtra(st, rid, key, value) {
    const e = st.live.get(rid);
    if (e) { applyExtra(e, key, value); markDirty(st, e); return; }
    let x = st.extra.get(rid);
    if (!x) {
      x = {};
      st.extra.set(rid, x);
      if (st.extra.size > PENDING_EXTRA_LIMIT) st.extra.delete(st.extra.keys().next().value);
    }
    x[key] = value;
  }
  function applyExtra(e, key, v) {
    if (key === 'req') {
      e.reqHeadersExtra = v.headers || null;
      if (Array.isArray(v.associatedCookies)) e.blockedReqCookies = v.associatedCookies.filter((c) => c.blockedReasons && c.blockedReasons.length).length;
    } else if (key === 'resp') {
      e.respHeadersExtra = v.headers || null;
      if (v.statusCode && !e.status) e.status = v.statusCode;
      if (Array.isArray(v.blockedCookies)) e.blockedRespCookies = v.blockedCookies.length;
    }
  }

  function shouldCapture(st, type, url) {
    const mode = tabMode(st);
    if (mode === 'off') return false;
    if (mode === 'all') return true;
    // data: и blob: (картинки из CSS, иконки) — шум для режима API
    if (url && /^(data|blob):/i.test(url)) return false;
    return API_TYPES.has(type);
  }

  function initiatorOf(i) {
    if (!i) return null;
    const out = { type: i.type };
    let frame = null;
    if (i.stack && Array.isArray(i.stack.callFrames) && i.stack.callFrames.length) frame = i.stack.callFrames[0];
    else if (i.stack && i.stack.parent && i.stack.parent.callFrames && i.stack.parent.callFrames.length) frame = i.stack.parent.callFrames[0];
    if (frame) { out.url = frame.url; out.line = (frame.lineNumber || 0) + 1; out.fn = frame.functionName || ''; }
    else if (i.url) { out.url = i.url; if (i.lineNumber != null) out.line = i.lineNumber + 1; }
    return out;
  }

  function finishRedirect(st, prev, p) {
    const r = p.redirectResponse;
    prev.status = r.status; prev.statusText = r.statusText || '';
    prev.mime = r.mimeType || prev.mime;
    prev.respHeaders = r.headers || null;
    prev.timing = r.timing || prev.timing;
    prev.protocol = r.protocol || prev.protocol;
    prev.remote = r.remoteIPAddress ? r.remoteIPAddress + (r.remotePort ? ':' + r.remotePort : '') : prev.remote;
    prev.fromCache = prev.fromCache || !!(r.fromDiskCache || r.fromServiceWorker || r.fromPrefetchCache);
    prev.size = r.encodedDataLength || prev.size || 0;
    prev.tEnd = p.timestamp;
    prev.timeMs = Math.max(0, (p.timestamp - prev.t0) * 1000);
    prev.state = 'done';
    prev.redirect = true;
    st.live.delete(prev.rid);
    markDirty(st, prev);
    emitEntry(st, prev);
  }

  function postDataInline(req) {
    if (typeof req.postData === 'string') return req.postData;
    if (Array.isArray(req.postDataEntries) && req.postDataEntries.length) {
      try { return Buffer.concat(req.postDataEntries.map((x) => Buffer.from(x.bytes || '', 'base64'))).toString('utf8'); } catch (_) { return null; }
    }
    return null;
  }

  function onRequest(st, p) {
    const type = p.type || 'Other';
    const req = p.request || {};
    const rid = p.requestId;
    // Переход основного фрейма → разделитель (или очистка без «сохранять журнал»).
    const isNav = type === 'Document' && rid === p.loaderId && !p.redirectResponse && (!st.mainFrameId || p.frameId === st.mainFrameId);
    if (isNav) {
      if (!st.mainFrameId && p.frameId) st.mainFrameId = p.frameId;
      // ответ уходящей страницы получен, а loadingFinished так и не пришёл (бывает у первой загрузки
      // свежей вкладки) — закрываем запись, чтобы не висела «в процессе»
      for (const le of Array.from(st.live.values())) {
        if (le.status > 0 && le.state === 'pending' && le.kind !== 'ws' && le.kind !== 'api') {
          le.state = 'done'; if (le.tResp != null && le.t0 != null) le.timeMs = Math.max(0, (le.tResp - le.t0) * 1000);
          st.live.delete(le.rid); markDirty(st, le);
        }
      }
      if (setting('preserveLog', true) === false) clear(st.tabId);
      addMarker(st, req.url);
      if (setting('preserveLog', true) === false) st.console = [];
    }
    let hop = 0;
    if (p.redirectResponse) {
      const prev = st.live.get(rid);
      if (prev) { finishRedirect(st, prev, p); hop = (prev.hop || 0) + 1; }
    }
    if (st.paused || !shouldCapture(st, type, req.url)) { st.extra.delete(rid); return; }
    const e = {
      id: hop ? rid + '~' + hop : rid, rid, hop, seq: ++st.seq,
      ts: p.wallTime ? Math.round(p.wallTime * 1000) : now(), t0: p.timestamp,
      method: req.method || 'GET', url: req.url + (req.urlFragment || ''), status: 0, statusText: '',
      type, kind: C.kindOf(type), mime: '', size: 0, timeMs: null, fromCache: false,
      initiator: initiatorOf(p.initiator), failed: false, errorText: '', state: 'pending',
      reqHeaders: req.headers || null, reqHeadersExtra: null, respHeaders: null, respHeadersExtra: null,
      postData: postDataInline(req),
      hasPostData: !!req.hasPostData, frameId: p.frameId || null, isNav,
      timing: null, protocol: '', remote: '', priority: req.initialPriority || '',
    };
    const x = takeExtra(st, rid);
    if (x) { if (x.req) applyExtra(e, 'req', x.req); if (x.resp) applyExtra(e, 'resp', x.resp); }
    st.live.set(rid, e);
    push(st, e);
  }

  function onResponse(st, p) {
    let e = st.live.get(p.requestId);
    const r = p.response || {};
    // ответ без requestWillBeSent — ресурс из кэша памяти (Chromium шлёт только responseReceived/loadingFinished)
    if (!e && !st.byId.has(p.requestId) && !st.paused && r.url && shouldCapture(st, p.type || 'Other', r.url)) {
      const type = p.type || 'Other';
      e = {
        id: p.requestId, rid: p.requestId, hop: 0, seq: ++st.seq, ts: now(), t0: p.timestamp,
        method: (r.requestHeaders && r.requestHeaders[':method']) || 'GET', url: r.url, status: 0, statusText: '',
        type, kind: C.kindOf(type), mime: '', size: 0, timeMs: null, fromCache: true,
        initiator: null, failed: false, errorText: '', state: 'pending',
        reqHeaders: r.requestHeaders || null, reqHeadersExtra: null, respHeaders: null, respHeadersExtra: null,
        postData: null, hasPostData: false, frameId: p.frameId || null, isNav: false,
        timing: null, protocol: '', remote: '', priority: '', memoryCache: true,
      };
      const x = takeExtra(st, p.requestId);
      if (x) { if (x.req) applyExtra(e, 'req', x.req); if (x.resp) applyExtra(e, 'resp', x.resp); }
      st.live.set(p.requestId, e);
      push(st, e);
    }
    if (!e) return;
    e.status = r.status || e.status; e.statusText = r.statusText || '';
    e.mime = r.mimeType || '';
    e.respHeaders = r.headers || null;
    if (r.requestHeaders && !e.reqHeadersExtra) e.reqHeadersExtra = r.requestHeaders;
    e.protocol = r.protocol || '';
    e.remote = r.remoteIPAddress ? (r.remoteIPAddress.includes(':') ? '[' + r.remoteIPAddress + ']' : r.remoteIPAddress) + (r.remotePort ? ':' + r.remotePort : '') : '';
    e.fromCache = e.fromCache || !!(r.fromDiskCache || r.fromServiceWorker || r.fromPrefetchCache);
    e.timing = r.timing || null;
    e.tResp = p.timestamp;
    if (p.type && p.type !== e.type) { e.type = p.type; e.kind = C.kindOf(p.type); }
    if (r.encodedDataLength) e.size = r.encodedDataLength;
    markDirty(st, e);
  }

  function onFinished(st, p) {
    st.extra.delete(p.requestId);
    const e = st.live.get(p.requestId);
    if (!e) return;
    e.size = p.encodedDataLength || e.size || 0;
    e.tEnd = p.timestamp;
    e.timeMs = Math.max(0, (p.timestamp - e.t0) * 1000);
    e.state = 'done';
    st.live.delete(p.requestId);
    markDirty(st, e);
    emitEntry(st, e);
  }

  function onFailed(st, p) {
    st.extra.delete(p.requestId);
    const e = st.live.get(p.requestId);
    if (!e) return;
    e.failed = true;
    e.errorText = p.errorText || 'ошибка';
    if (p.canceled) e.canceled = true;
    if (p.blockedReason) e.blockedReason = p.blockedReason;
    if (p.corsErrorStatus && p.corsErrorStatus.corsError) e.corsError = p.corsErrorStatus.corsError;
    e.tEnd = p.timestamp;
    e.timeMs = Math.max(0, (p.timestamp - e.t0) * 1000);
    e.state = 'failed';
    if (p.type && p.type !== e.type) { e.type = p.type; e.kind = C.kindOf(p.type); }
    st.live.delete(p.requestId);
    markDirty(st, e);
    emitEntry(st, e);
  }

  // WebSocket / EventSource
  function wsFrame(st, rid, dir, ts, data, opcode, extra) {
    const e = st.live.get(rid) || st.byId.get(rid);
    if (!e) return;
    if (!e.frames) e.frames = [];
    const text = typeof data === 'string' ? data : '';
    e.frames.push(Object.assign({ dir, ts: ts ? Math.round(ts * 1000) : now(), opcode: opcode || 1, len: text.length, data: truncate(text, WS_FRAME_TEXT) }, extra || {}));
    if (e.frames.length > WS_FRAMES_LIMIT) e.frames.splice(0, e.frames.length - WS_FRAMES_LIMIT);
    e.frameCount = (e.frameCount || 0) + 1;
    e.size = (e.size || 0) + text.length;
    markDirty(st, e);
  }

  function onConsole(st, item) {
    if (!st.consoleOn) return;
    st.console.push(item);
    if (st.console.length > CONSOLE_LIMIT) st.console.splice(0, st.console.length - CONSOLE_LIMIT);
    emitter.emit('console', st.tabId, item);
  }

  function onMessage(st, method, p) {
    try {
      switch (method) {
        case 'Network.requestWillBeSent': onRequest(st, p); break;
        case 'Network.requestWillBeSentExtraInfo': stashExtra(st, p.requestId, 'req', p); break;
        case 'Network.responseReceivedExtraInfo': stashExtra(st, p.requestId, 'resp', p); break;
        case 'Network.responseReceived': onResponse(st, p); break;
        case 'Network.loadingFinished': onFinished(st, p); break;
        case 'Network.loadingFailed': onFailed(st, p); break;
        case 'Network.requestServedFromCache': { const e = st.live.get(p.requestId); if (e) { e.fromCache = true; markDirty(st, e); } break; }
        case 'Network.webSocketCreated': {
          if (st.paused || !shouldCapture(st, 'WebSocket')) break;
          const e = {
            id: p.requestId, rid: p.requestId, hop: 0, seq: ++st.seq, ts: now(), t0: null, method: 'GET', url: p.url, status: 0, statusText: '',
            type: 'WebSocket', kind: 'ws', mime: '', size: 0, timeMs: null, fromCache: false, initiator: initiatorOf(p.initiator),
            failed: false, errorText: '', state: 'pending', reqHeaders: null, reqHeadersExtra: null, respHeaders: null, respHeadersExtra: null,
            postData: null, hasPostData: false, frames: [], frameCount: 0, timing: null, protocol: 'websocket', remote: '',
          };
          st.live.set(p.requestId, e);
          push(st, e);
          break;
        }
        case 'Network.webSocketWillSendHandshakeRequest': {
          const e = st.live.get(p.requestId);
          if (e) { e.t0 = p.timestamp; if (p.wallTime) e.ts = Math.round(p.wallTime * 1000); e.reqHeaders = (p.request && p.request.headers) || null; markDirty(st, e); }
          break;
        }
        case 'Network.webSocketHandshakeResponseReceived': {
          const e = st.live.get(p.requestId);
          if (e) {
            const r = p.response || {};
            e.status = r.status || 101; e.statusText = r.statusText || '';
            e.respHeaders = r.headers || null;
            if (r.requestHeaders) e.reqHeadersExtra = r.requestHeaders;
            if (e.t0 != null) e.timeMs = Math.max(0, (p.timestamp - e.t0) * 1000);
            markDirty(st, e);
          }
          break;
        }
        case 'Network.webSocketFrameSent': wsFrame(st, p.requestId, 'out', p.timestamp, p.response && p.response.payloadData, p.response && p.response.opcode); break;
        case 'Network.webSocketFrameReceived': wsFrame(st, p.requestId, 'in', p.timestamp, p.response && p.response.payloadData, p.response && p.response.opcode); break;
        case 'Network.webSocketFrameError': wsFrame(st, p.requestId, 'err', p.timestamp, p.errorMessage, 0); break;
        case 'Network.webSocketClosed': {
          const e = st.live.get(p.requestId);
          if (e) { e.state = 'done'; if (e.t0 != null) e.timeMs = Math.max(0, (p.timestamp - e.t0) * 1000); e.closed = true; st.live.delete(p.requestId); markDirty(st, e); emitEntry(st, e); }
          break;
        }
        case 'Network.eventSourceMessageReceived': wsFrame(st, p.requestId, 'in', p.timestamp, p.data, 1, { event: p.eventName || 'message', eventId: p.eventId || '' }); break;

        case 'Runtime.consoleAPICalled': {
          // предупреждение Electron о CSP в dev-сборке — не про сайт
          if (p.type === 'warning' && p.args && p.args[0] && /^%cElectron Security Warning|^Electron Security Warning/.test(String(p.args[0].value || ''))) break;
          const cf = p.stackTrace && p.stackTrace.callFrames && p.stackTrace.callFrames[0];
          const args = Array.isArray(p.args) ? p.args : [];
          let text = args.map(remoteText).join(' ');
          if (p.type === 'assert') text = 'Assertion failed: ' + text;
          onConsole(st, { ts: p.timestamp ? Math.round(p.timestamp) : now(), level: levelOf(p.type), text: truncate(text, CONSOLE_TEXT), url: cf ? cf.url : '', line: cf ? cf.lineNumber + 1 : 0, source: 'console' });
          break;
        }
        case 'Runtime.exceptionThrown': {
          const d = p.exceptionDetails || {};
          const text = (d.exception && d.exception.description) || d.text || 'Uncaught';
          onConsole(st, { ts: p.timestamp ? Math.round(p.timestamp) : now(), level: 'error', text: truncate(/^Uncaught/.test(d.text || '') && !/^Uncaught/.test(text) ? 'Uncaught ' + text : text, CONSOLE_TEXT), url: d.url || '', line: (d.lineNumber || 0) + 1, source: 'exception' });
          break;
        }
        case 'Log.entryAdded': {
          const en = p.entry || {};
          onConsole(st, { ts: en.timestamp ? Math.round(en.timestamp) : now(), level: levelOf(en.level), text: truncate(en.text || '', CONSOLE_TEXT), url: en.url || '', line: en.lineNumber != null ? en.lineNumber + 1 : 0, source: en.source || 'other' });
          break;
        }
        default: break;
      }
    } catch (err) {
      ctx.log('cdp', `вкладка ${st.tabId}: ${method}:`, err);
    }
  }

  // ---------- представление ----------

  function pub(e) {
    if (e.marker) return { id: e.id, seq: e.seq, marker: true, ts: e.ts, url: e.url };
    return {
      id: e.id, seq: e.seq, ts: e.ts, method: e.method, url: e.url, status: e.status, statusText: e.statusText,
      type: e.type, kind: e.kind, mime: e.mime, size: e.size, timeMs: e.timeMs == null ? null : Math.round(e.timeMs * 10) / 10,
      fromCache: e.fromCache, initiator: e.initiator, failed: e.failed, errorText: e.errorText, pending: e.state === 'pending',
      redirect: !!e.redirect, frames: e.frameCount || 0, hasPostData: !!(e.hasPostData || e.postData), canceled: !!e.canceled,
    };
  }

  function timingOf(e) {
    const t = e.timing;
    const total = e.timeMs != null ? e.timeMs : null;
    if (!t || e.t0 == null) return { total, phases: [] };
    const base = (t.requestTime - e.t0) * 1000; // от начала запроса до requestTime
    const ph = [];
    const add = (id, label, a, b) => { if (a >= 0 && b >= 0 && b >= a) ph.push({ id, label, start: base + a, dur: b - a }); };
    if (base > 0.05) ph.push({ id: 'queue', label: 'Очередь', start: 0, dur: base });
    add('dns', 'DNS', t.dnsStart, t.dnsEnd);
    if (t.connectStart >= 0) {
      const sslA = t.sslStart, sslB = t.sslEnd;
      if (sslA >= 0) { add('connect', 'Соединение', t.connectStart, sslA); add('ssl', 'TLS', sslA, sslB); } else add('connect', 'Соединение', t.connectStart, t.connectEnd);
    }
    add('send', 'Отправка', t.sendStart, t.sendEnd);
    const hdr = t.receiveHeadersEnd >= 0 ? t.receiveHeadersEnd : t.receiveHeadersStart;
    add('wait', 'Ожидание ответа', t.sendEnd, hdr);
    if (e.tEnd != null && hdr >= 0) {
      const endRel = (e.tEnd - t.requestTime) * 1000;
      if (endRel >= hdr) ph.push({ id: 'download', label: 'Загрузка', start: base + hdr, dur: endRel - hdr });
    }
    return { total, phases: ph, ttfb: hdr >= 0 ? base + hdr : null };
  }

  async function postDataOf(st, e) {
    if (e.postData != null) return e.postData;
    if (!e.hasPostData) return null;
    if (!st.attached || e.hop) return null;
    try {
      const r = await cmd(st, 'Network.getRequestPostData', { requestId: e.rid });
      e.postData = r && typeof r.postData === 'string' ? r.postData : null;
      if (r && r.base64Encoded && e.postData) { try { e.postData = Buffer.from(e.postData, 'base64').toString('utf8'); } catch (_) { /* как есть */ } }
    } catch (_) { e.postData = null; }
    return e.postData;
  }

  // ---------- тела ответов ----------

  function dropBody(tabId, id) {
    const k = tabId + ':' + id;
    const b = bodyCache.get(k);
    if (b) { bodyBytes -= b.bytes; bodyCache.delete(k); }
  }
  function cacheBody(tabId, id, r) {
    const k = tabId + ':' + id;
    dropBody(tabId, id);
    const bytes = (r.body ? r.body.length : 0) * (r.base64Encoded ? 1 : 2);
    if (bytes > BODY_CACHE_BYTES / 4) return;
    bodyCache.set(k, { body: r.body, base64Encoded: r.base64Encoded, bytes });
    bodyBytes += bytes;
    while (bodyBytes > BODY_CACHE_BYTES && bodyCache.size) {
      const first = bodyCache.keys().next().value;
      bodyBytes -= bodyCache.get(first).bytes;
      bodyCache.delete(first);
    }
  }

  async function rawBody(tabId, id) {
    const st = stateOf(tabId, false);
    if (!st) throw new Error('нет записей для вкладки');
    const e = st.byId.get(String(id));
    if (!e || e.marker) throw new Error('запрос не найден');
    const k = st.tabId + ':' + e.id;
    const hit = bodyCache.get(k);
    if (hit) { bodyCache.delete(k); bodyCache.set(k, hit); return hit; }
    if (e.kind === 'ws') throw new Error('у WebSocket нет тела — смотрите сообщения');
    if (e.redirect) throw new Error('у перенаправления нет тела');
    if (e.state === 'pending') throw new Error('ответ ещё загружается');
    if (e.failed) throw new Error('запрос не выполнен: ' + (e.errorText || 'ошибка'));
    if (!st.attached) throw new Error('тело недоступно: отладчик не подключён');
    let r;
    try { r = await cmd(st, 'Network.getResponseBody', { requestId: e.rid }); } catch (err) {
      const m = String(err && err.message || err);
      if (/No resource|No data found/i.test(m)) throw new Error('тело уже недоступно: страница перешла дальше или буфер переполнен');
      throw new Error('тело недоступно: ' + m);
    }
    const out = { body: r && typeof r.body === 'string' ? r.body : '', base64Encoded: !!(r && r.base64Encoded) };
    cacheBody(st.tabId, e.id, out);
    return out;
  }

  // ---------- API ----------

  async function ensure(tabId) {
    const st = stateOf(tabId, true);
    const wc = wcOf(tabId);
    if (!wc) throw new Error('вкладка не найдена или выгружена');
    if (st.wc !== wc) { if (st.wc) detach(st); st.wc = wc; }
    await attach(st);
  }

  function network(tabId, opts = {}) {
    const st = stateOf(tabId, false);
    if (!st) return [];
    const type = opts.type && opts.type !== 'all' ? String(opts.type) : null;
    const f = opts.filter ? C.compileFilter(String(opts.filter)) : null;
    const limit = Math.max(1, Math.min(100000, Number(opts.limit) || 200));
    const out = [];
    for (let i = st.entries.length - 1; i >= 0 && out.length < limit; i--) {
      const e = st.entries[i];
      if (e.marker) { if (opts.markers) out.push(pub(e)); continue; }
      if (type && !C.kindMatches(e.kind, type) && e.type.toLowerCase() !== type.toLowerCase()) continue;
      const p = pub(e);
      if (f && !f(p)) continue;
      out.push(p);
    }
    return out.reverse();
  }

  async function entry(tabId, id) {
    const st = stateOf(tabId, false);
    if (!st) return null;
    const e = st.byId.get(String(id));
    if (!e || e.marker) return null;
    const postData = await postDataOf(st, e);
    return Object.assign(pub(e), {
      requestHeaders: e.reqHeadersExtra || e.reqHeaders || {},
      responseHeaders: e.respHeadersExtra || e.respHeaders || {},
      provisionalHeaders: !e.reqHeadersExtra,
      postData,
      protocol: e.protocol, remote: e.remote, priority: e.priority,
      timing: timingOf(e),
      blockedReason: e.blockedReason || '', corsError: e.corsError || '', canceled: !!e.canceled,
      blockedCookies: (e.blockedReqCookies || 0) + (e.blockedRespCookies || 0),
    });
  }

  async function body(tabId, id, opts = {}) {
    const r = await rawBody(tabId, id);
    const limit = Number(opts.limit) || BODY_LIMIT_DEFAULT;
    let b = r.body || '';
    let truncated = false;
    if (r.base64Encoded) {
      const bytes = Math.floor(b.length * 3 / 4);
      if (bytes > limit) { b = b.slice(0, Math.floor(limit / 3) * 4); truncated = true; }
    } else if (b.length > limit) { b = b.slice(0, limit); truncated = true; }
    return { body: b, base64Encoded: r.base64Encoded, truncated };
  }

  function consoleList(tabId, opts = {}) {
    const st = stateOf(tabId, false);
    if (!st) return [];
    const levels = { debug: 0, log: 1, info: 1, warn: 2, error: 3 };
    const min = opts.level && levels[opts.level] != null ? levels[opts.level] : -1;
    const limit = Math.max(1, Math.min(CONSOLE_LIMIT, Number(opts.limit) || 100));
    const out = [];
    for (let i = st.console.length - 1; i >= 0 && out.length < limit; i--) {
      const c = st.console[i];
      if (min >= 0 && (levels[c.level] == null ? 1 : levels[c.level]) < min) continue;
      out.push({ ts: c.ts, level: c.level, text: c.text, url: c.url, line: c.line });
    }
    return out.reverse();
  }

  async function send(tabId, method, params) {
    if (typeof method !== 'string' || !/^[A-Z][A-Za-z]*\.[a-zA-Z]+$/.test(method)) throw new Error('неверный метод CDP: ' + method);
    await ensure(tabId);
    const st = stateOf(tabId, false);
    return cmd(st, method, params || {});
  }

  // fetch в контексте страницы: её cookies, origin и CSP; изолированный мир — сайт не видит наш код.
  async function pageFetch(tabId, o = {}) {
    const wc = wcOf(tabId);
    if (!wc) throw new Error('вкладка не найдена или выгружена');
    const pageUrl = wc.getURL();
    if (!/^https?:/i.test(pageUrl)) throw new Error('fetch из страницы доступен только на http(s)-сайтах');
    let url;
    try { url = new URL(String(o.url || ''), pageUrl).href; } catch (_) { throw new Error('неверный адрес: ' + o.url); }
    if (!/^https?:/i.test(url)) throw new Error('только http(s)-адреса');
    const method = String(o.method || 'GET').toUpperCase();
    if (!/^[A-Z]{1,16}$/.test(method)) throw new Error('неверный метод: ' + o.method);
    const headers = {};
    if (o.headers && typeof o.headers === 'object') {
      for (const [k, v] of Array.isArray(o.headers) ? o.headers : Object.entries(o.headers)) {
        if (!k || /[\r\n:]/.test(String(k).slice(1))) continue;
        if (String(k).charAt(0) === ':') continue;
        headers[String(k)] = String(v == null ? '' : v);
      }
    }
    let reqBody = o.body == null ? null : String(o.body);
    if (reqBody != null && reqBody.length > FETCH_REQ_LIMIT) throw new Error('слишком большое тело запроса');
    if (method === 'GET' || method === 'HEAD') reqBody = null;
    const credentials = ['include', 'same-origin', 'omit'].includes(o.credentials) ? o.credentials : 'include';
    const timeoutMs = Math.max(1000, Math.min(300000, Number(o.timeoutMs) || 30000));
    const opts = { url, method, headers, body: reqBody, credentials, timeoutMs, limit: FETCH_BODY_LIMIT };
    const code = `(async (o) => {
      const t0 = performance.now();
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), o.timeoutMs);
      try {
        const init = { method: o.method, headers: o.headers, credentials: o.credentials, signal: ac.signal, cache: 'no-store' };
        if (o.body != null) init.body = o.body;
        const r = await fetch(o.url, init);
        const headers = {};
        r.headers.forEach((v, k) => { headers[k] = headers[k] != null ? headers[k] + '\\n' + v : v; });
        const ct = (r.headers.get('content-type') || '').toLowerCase();
        const textual = !ct || /^text\\/|json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|csv|svg|html|yaml/.test(ct);
        const chunks = []; let size = 0, truncated = false;
        if (r.body) {
          const rd = r.body.getReader();
          for (;;) {
            const { done, value } = await rd.read();
            if (done) break;
            const room = o.limit - size;
            if (value.length > room) { chunks.push(value.subarray(0, room)); size += room; truncated = true; try { await rd.cancel(); } catch (e) {} break; }
            chunks.push(value); size += value.length;
          }
        }
        const all = new Uint8Array(size); let off = 0;
        for (const c of chunks) { all.set(c, off); off += c.length; }
        let body, base64Encoded = false;
        if (textual) body = new TextDecoder().decode(all);
        else { let s = ''; for (let i = 0; i < all.length; i += 0x8000) s += String.fromCharCode.apply(null, all.subarray(i, i + 0x8000)); body = btoa(s); base64Encoded = true; }
        clearTimeout(timer);
        return { ok: r.ok, status: r.status, statusText: r.statusText, url: r.url, redirected: r.redirected, headers, body, base64Encoded, truncated, size, timeMs: Math.round((performance.now() - t0) * 10) / 10 };
      } catch (e) {
        clearTimeout(timer);
        const msg = e && e.name === 'AbortError' ? 'превышено время ожидания (' + o.timeoutMs + ' мс)' : String((e && e.message) || e);
        return { ok: false, status: 0, statusText: '', headers: {}, body: '', truncated: false, timeMs: Math.round((performance.now() - t0) * 10) / 10, error: msg };
      }
    })(${JSON.stringify(opts)})`;
    let r;
    try { r = await wc.executeJavaScriptInIsolatedWorld(FETCH_WORLD, [{ code }], false); } catch (e) {
      return { ok: false, status: 0, statusText: '', headers: {}, body: '', truncated: false, timeMs: 0, error: 'страница не выполнила запрос: ' + e.message };
    }
    if (!r || typeof r !== 'object') return { ok: false, status: 0, statusText: '', headers: {}, body: '', truncated: false, timeMs: 0, error: 'пустой ответ' };
    return r;
  }

  function setPaused(tabId, v) {
    const st = stateOf(tabId, true);
    st.paused = !!v;
    return st.paused;
  }

  function info(tabId) {
    const st = stateOf(tabId, false);
    const mode = st ? tabMode(st) : captureMode();
    return {
      tabId: Number(tabId), attached: !!(st && st.attached), capturing: !!(st && st.netOn), mode, globalMode: captureMode(),
      override: st ? st.modeOverride : null, paused: !!(st && st.paused), preserve: setting('preserveLog', true) !== false,
      total: st ? st.entries.filter((e) => !e.marker).length : 0, console: setting('console', true) !== false,
    };
  }

  // Включить запись для одной вкладки, даже если в настройках «выкл.» (кнопка в панели «Сеть»).
  async function captureTab(tabId, mode) {
    const st = stateOf(tabId, true);
    st.modeOverride = mode === 'api' || mode === 'all' || mode === 'off' ? mode : null;
    await ensure(tabId);
    await applyDomains(st);
    return info(tabId);
  }

  // Network-домен без записи (эмуляция сети/кэша при capture 'off').
  function requireNetwork(tabId, on) {
    const st = stateOf(tabId, true);
    if (st.netNeeded === !!on) return;
    st.netNeeded = !!on;
    if (st.attached) applyDomains(st);
  }

  function watch(tabId, on) {
    const id = Number(tabId);
    if (on) watched.add(id); else watched.delete(id);
    const st = stateOf(id, false);
    if (st && st.attached && st.netOn) setDurable(st, !!on);
    if (st && !on) { if (st.batchTimer) { clearTimeout(st.batchTimer); st.batchTimer = null; } st.dirty.clear(); st.added = []; st.reset = false; }
  }

  function list(tabId) {
    const st = stateOf(tabId, false);
    return st ? st.entries.map(pub) : [];
  }

  function wsFrames(tabId, id) {
    const st = stateOf(tabId, false);
    const e = st && st.byId.get(String(id));
    return e && e.frames ? e.frames.slice() : [];
  }

  // Внутренняя запись целиком (для HAR и «Отдать Claude»).
  function raw(tabId, id) {
    const st = stateOf(tabId, false);
    return st ? st.byId.get(String(id)) || null : null;
  }

  // ---------- жизненный цикл вкладок ----------

  ctx.tabs.on('view-created', (tab, wc) => {
    const st = stateOf(tab.id, true);
    st.wc = wc; st.attached = false; st.netOn = false; st.consoleOn = false; st.mainFrameId = null;
    if (tabMode(st) !== 'off') {
      // Синхронно до первой загрузки (loadURL вызывается сразу после события) — чтобы записать документ.
      attach(st).catch((e) => ctx.log('cdp', `вкладка ${tab.id}:`, e.message));
    }
  });
  ctx.tabs.on('view-destroyed', (tab) => {
    const st = stateOf(tab.id, false);
    if (!st) return;
    detach(st);
    st.wc = null;
    st.live.clear(); st.extra.clear();
    for (const e of st.entries) dropBody(st.tabId, e.id);
  });
  ctx.tabs.on('closed', (tab) => {
    const st = stateOf(tab.id, false);
    if (!st) return;
    st.closed = true;
    if (st.batchTimer) clearTimeout(st.batchTimer);
    detach(st);
    for (const e of st.entries) dropBody(st.tabId, e.id);
    states.delete(st.tabId);
    watched.delete(st.tabId);
  });

  S.on('change', (p) => {
    if (!(p === 'devtools' || p.startsWith('devtools.capture') || p.startsWith('devtools.console'))) return;
    for (const st of states.values()) {
      if (!st.wc || st.wc.isDestroyed()) continue;
      const mode = tabMode(st);
      if (mode !== 'off' && !st.attached) attach(st).catch(() => {});
      else if (st.attached) applyDomains(st);
    }
  });

  return {
    ensure, network, entry, body, console: consoleList, send, pageFetch, clear,
    on(ev, cb) { emitter.on(ev, cb); return () => emitter.off(ev, cb); },
    off(ev, cb) { emitter.off(ev, cb); },
    // дополнительно (панель «Сеть», devtools):
    info, list, watch, setPaused, requireNetwork, captureTab, wsFrames, raw, postData: async (tabId, id) => { const st = stateOf(tabId, false); const e = st && st.byId.get(String(id)); return e ? postDataOf(st, e) : null; },
    rawBody, timingOf, isAttached: (tabId) => { const st = stateOf(tabId, false); return !!(st && st.attached); },
    flush: (tabId) => { const st = stateOf(tabId, false); if (st) flushBatch(st); },
  };
}

module.exports = {
  id: 'cdp-hub',
  init(ctx) {
    ctx.settings.addDefaults({ devtools: { preserveLog: true, console: true } });
    ctx.cdp = createHub(ctx);
  },
};
