'use strict';
// IPC инструмента «Сеть и API»: список и детали запросов (из ctx.cdp), тела, повтор (pageFetch),
// экспорт HAR, «Отдать Claude», поиск по телам ответов. Владелец: devtools.

const fs = require('fs');
const path = require('path');
const C = require(path.join(__dirname, '..', '..', '..', 'renderer', 'panel', 'tools', 'devtools-common.js'));

const HAR_BODY_LIMIT = 2 * 1024 * 1024;
const HAR_TOTAL_LIMIT = 64 * 1024 * 1024;
const MD_BODY_LIMIT = 200 * 1024;
const SEARCH_LIMIT_IDS = 3000;

function pad2(n) { return String(n).padStart(2, '0'); }
function stamp(d) { d = d || new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}`; }
function slug(s, n) { return String(s || '').replace(/^https?:\/\//, '').replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, n || 60) || 'request'; }

async function pool(items, n, fn) {
  let i = 0;
  const run = async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
}

function decodeBody(r) {
  if (!r) return '';
  if (!r.base64Encoded) return r.body || '';
  try { return Buffer.from(r.body || '', 'base64').toString('utf8'); } catch (_) { return ''; }
}

function createNetwork(ctx) {
  const { dialog } = ctx.electron;
  let watchedTab = null;

  function tabIdOf(p) {
    if (p && p.tabId != null) return Number(p.tabId);
    return ctx.tabs.activeId;
  }

  function snapshot(tabId) {
    const tab = ctx.tabs.get(tabId);
    return Object.assign(ctx.cdp.info(tabId), {
      url: tab ? tab.info.url : '', title: tab ? tab.info.title : '', discarded: !!(tab && !tab.wc),
      entries: ctx.cdp.list(tabId),
    });
  }

  // панель «Сеть» следит за одной вкладкой: получает пакеты изменений kosmo:devtools.net
  async function watch(p) {
    const id = p && p.tabId != null ? Number(p.tabId) : null;
    if (watchedTab != null && watchedTab !== id) ctx.cdp.watch(watchedTab, false);
    watchedTab = id;
    if (id == null) return null;
    ctx.cdp.watch(id, true);
    // запись включена, а отладчик ещё не подключён (вкладку открыли до включения записи и т.п.)
    const info = ctx.cdp.info(id);
    if (info.mode !== 'off' && !info.attached && ctx.tabs.get(id) && ctx.tabs.get(id).wc) { try { await ctx.cdp.ensure(id); } catch (_) { /* выгружена */ } }
    return snapshot(id);
  }

  async function detail(p) {
    const tabId = tabIdOf(p);
    const e = await ctx.cdp.entry(tabId, p.id);
    if (!e) throw new Error('запрос не найден (журнал очищен?)');
    if (e.kind === 'ws') e.messages = ctx.cdp.wsFrames(tabId, p.id);
    return e;
  }

  async function body(p) {
    const tabId = tabIdOf(p);
    const r = await ctx.cdp.body(tabId, p.id, { limit: 16 * 1024 * 1024 });
    // бинарный ответ с текстовым типом (бывает у JSON с BOM и т.п.) — отдаём текстом
    const e = ctx.cdp.raw(tabId, p.id);
    if (r.base64Encoded && e && C.isTextMime(e.mime) && !/^image\//.test(e.mime)) {
      return { body: decodeBody(r), base64Encoded: false, truncated: r.truncated, mime: e.mime };
    }
    return Object.assign(r, { mime: e ? e.mime : '' });
  }

  // ---------- HAR ----------
  function harHeaders(h) { return C.headerPairs(h).filter(([k]) => k.charAt(0) !== ':').map(([name, value]) => ({ name, value })); }
  function harTimings(e) {
    const t = ctx.cdp.timingOf(e);
    const by = {};
    for (const ph of t.phases) by[ph.id] = Math.round(ph.dur * 1000) / 1000;
    return {
      blocked: by.queue != null ? by.queue : -1, dns: by.dns != null ? by.dns : -1, connect: by.connect != null ? by.connect + (by.ssl || 0) : -1,
      ssl: by.ssl != null ? by.ssl : -1, send: by.send || 0, wait: by.wait || 0, receive: by.download || 0,
    };
  }
  async function buildHar(tabId, ids) {
    const tab = ctx.tabs.get(tabId);
    const list = ctx.cdp.list(tabId).filter((e) => !e.marker && (!ids || ids.includes(e.id)));
    let total = 0;
    const bodies = new Map();
    const want = list.filter((e) => !e.pending && !e.failed && !e.redirect && e.kind !== 'ws' && (C.isTextMime(e.mime) || /^image\//.test(e.mime)) && (e.size || 0) < HAR_BODY_LIMIT * 2);
    await pool(want, 6, async (e) => {
      if (total > HAR_TOTAL_LIMIT) return;
      try {
        const r = await ctx.cdp.rawBody(tabId, e.id);
        const len = (r.body || '').length;
        if (len > HAR_BODY_LIMIT) return;
        total += len;
        bodies.set(e.id, r);
      } catch (_) { /* недоступно */ }
    });
    const entries = [];
    for (const p of list) {
      const e = ctx.cdp.raw(tabId, p.id);
      if (!e) continue;
      const reqH = e.reqHeadersExtra || e.reqHeaders || {};
      const resH = e.respHeadersExtra || e.respHeaders || {};
      const post = await ctx.cdp.postData(tabId, e.id);
      const b = bodies.get(e.id);
      const content = { size: e.size || 0, mimeType: e.mime || 'x-unknown' };
      if (b) { content.text = b.body; if (b.base64Encoded) content.encoding = 'base64'; }
      const loc = C.headerGet(resH, 'location');
      entries.push({
        pageref: 'page_1',
        startedDateTime: new Date(e.ts).toISOString(),
        time: e.timeMs != null ? Math.round(e.timeMs * 1000) / 1000 : -1,
        request: {
          method: e.method, url: e.url, httpVersion: e.protocol || 'http/1.1', headers: harHeaders(reqH),
          queryString: C.parseQuery(e.url).map(([name, value]) => ({ name, value })), cookies: [], headersSize: -1,
          bodySize: post ? Buffer.byteLength(post) : 0,
          postData: post != null ? { mimeType: C.headerGet(reqH, 'content-type') || '', text: post } : undefined,
        },
        response: {
          status: e.status || 0, statusText: e.statusText || '', httpVersion: e.protocol || 'http/1.1', headers: harHeaders(resH),
          cookies: [], content, redirectURL: loc || '', headersSize: -1, bodySize: e.size || -1, _error: e.failed ? e.errorText : undefined,
        },
        cache: {}, timings: harTimings(e), serverIPAddress: (e.remote || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, ''),
        _resourceType: String(e.type || '').toLowerCase(), _fromCache: e.fromCache ? 'disk' : undefined,
      });
    }
    return {
      log: {
        version: '1.2', creator: { name: 'Космолёт', version: ctx.app.getVersion() },
        pages: [{ startedDateTime: new Date(list.length ? list[0].ts : Date.now()).toISOString(), id: 'page_1', title: tab ? tab.info.url : '', pageTimings: {} }],
        entries,
      },
    };
  }
  async function exportHar(p) {
    const tabId = tabIdOf(p);
    const tab = ctx.tabs.get(tabId);
    let host = 'page';
    try { host = new URL(tab.info.url).hostname || 'page'; } catch (_) { /* как есть */ }
    let file = ctx.flags.dev && p.filePath ? String(p.filePath) : null;
    if (!file) {
      const r = await dialog.showSaveDialog(ctx.windows.main, {
        title: 'Сохранить HAR', defaultPath: path.join(ctx.app.getPath('downloads'), `${host}_${stamp()}.har`),
        filters: [{ name: 'HAR', extensions: ['har'] }, { name: 'JSON', extensions: ['json'] }],
      });
      if (r.canceled || !r.filePath) return { canceled: true };
      file = r.filePath;
    }
    const har = await buildHar(tabId, Array.isArray(p.ids) ? p.ids.map(String) : null);
    await fs.promises.writeFile(file, JSON.stringify(har, null, 1), 'utf8');
    return { path: file, count: har.log.entries.length };
  }

  // ---------- повтор ----------
  async function fetchInPage(p) {
    const tabId = tabIdOf(p);
    return ctx.cdp.pageFetch(tabId, { url: p.url, method: p.method, headers: p.headers, body: p.body, credentials: p.credentials, timeoutMs: p.timeoutMs });
  }

  // ---------- «Отдать Claude» ----------
  function fence(text, lang) {
    const s = String(text == null ? '' : text);
    let f = '```';
    while (s.includes(f)) f += '`';
    return f + (lang || '') + '\n' + s + '\n' + f;
  }
  function cut(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + `\n… (обрезано: показано ${n} из ${s.length} символов)` : s; }
  function bodyBlock(text, mime) {
    const t = String(text || '');
    if (C.isJsonMime(mime) || /^\s*[[{]/.test(t)) {
      try { return fence(cut(JSON.stringify(JSON.parse(t), null, 2), MD_BODY_LIMIT), 'json'); } catch (_) { /* не JSON */ }
    }
    const lang = /html/.test(mime) ? 'html' : /xml/.test(mime) ? 'xml' : /javascript/.test(mime) ? 'js' : /css/.test(mime) ? 'css' : '';
    return fence(cut(t, MD_BODY_LIMIT), lang);
  }
  function headersBlock(h) { return fence(C.headerPairs(h).map(([k, v]) => k + ': ' + v).join('\n') || '(нет)', 'http'); }

  async function toClaude(p) {
    const tabId = tabIdOf(p);
    const tab = ctx.tabs.get(tabId);
    const e = await ctx.cdp.entry(tabId, p.id);
    if (!e) throw new Error('запрос не найден');
    let respText = null, respNote = '';
    if (e.kind === 'ws') {
      const frames = ctx.cdp.wsFrames(tabId, p.id).slice(-50);
      respText = frames.map((f) => (f.dir === 'out' ? '→ ' : f.dir === 'in' ? '← ' : '! ') + f.data).join('\n');
    } else {
      try { const r = await ctx.cdp.body(tabId, p.id, { limit: 4 * 1024 * 1024 }); respText = r.base64Encoded ? null : r.body; if (r.base64Encoded) respNote = 'двоичные данные (' + e.mime + '), тело не включено'; } catch (err) { respNote = err.message; }
    }
    let host = '', pathPart = e.url;
    try { const u = new URL(e.url); host = u.host; pathPart = u.pathname + u.search; } catch (_) { /* как есть */ }
    const req = { method: e.method, url: e.url, headers: e.requestHeaders, body: e.postData, responseMime: e.mime };
    const md = [];
    const shortPath = pathPart.split('?')[0];
    md.push(`# ${e.method} ${shortPath.length > 160 ? shortPath.slice(0, 159) + '…' : shortPath}`);
    md.push('');
    md.push(`- Хост: \`${host}\``);
    md.push(`- Страница: ${tab ? (tab.info.title ? tab.info.title + ' — ' : '') + tab.info.url : '—'}`);
    md.push(`- Время: ${new Date(e.ts).toLocaleString('ru-RU')}`);
    md.push(`- Ответ: ${e.failed ? 'ошибка ' + e.errorText : e.status + ' ' + (e.statusText || '')} · ${e.mime || 'тип не указан'} · ${e.size || 0} Б · ${e.timeMs != null ? Math.round(e.timeMs) + ' мс' : '—'}`);
    md.push('');
    md.push('## Запрос');
    md.push('');
    md.push(fence(e.method + ' ' + e.url, 'http'));
    md.push('');
    md.push('### Заголовки запроса' + (e.provisionalHeaders ? ' (предварительные — браузер мог добавить cookies и др.)' : ''));
    md.push(headersBlock(e.requestHeaders));
    const q = C.parseQuery(e.url);
    if (q.length) { md.push(''); md.push('### Параметры адреса'); md.push(''); md.push('| Параметр | Значение |'); md.push('|---|---|'); for (const [k, v] of q) md.push(`| ${k.replace(/\|/g, '\\|')} | ${String(v).replace(/\|/g, '\\|').slice(0, 500)} |`); }
    if (e.postData) { md.push(''); md.push('### Тело запроса'); md.push(bodyBlock(e.postData, C.headerGet(e.requestHeaders, 'content-type') || '')); }
    md.push('');
    md.push('## Ответ');
    md.push('');
    md.push('### Заголовки ответа');
    md.push(headersBlock(e.responseHeaders));
    md.push('');
    md.push(e.kind === 'ws' ? '### Сообщения (последние 50)' : '### Тело ответа');
    md.push(respText != null ? bodyBlock(respText, e.mime) : '_' + (respNote || 'тело недоступно') + '_');
    if (p.replay && typeof p.replay === 'object') {
      const rp = p.replay;
      md.push('');
      md.push('## Повтор из Космолёта');
      md.push('');
      if (rp.request) md.push(fence(String(rp.request.method || 'GET') + ' ' + rp.request.url + '\n' + C.headerPairs(rp.request.headers).map(([k, v]) => k + ': ' + v).join('\n') + (rp.request.body ? '\n\n' + cut(rp.request.body, 20000) : ''), 'http'));
      if (rp.response) {
        md.push(`Статус: ${rp.response.error ? 'ошибка ' + rp.response.error : rp.response.status + ' ' + (rp.response.statusText || '')} · ${rp.response.timeMs} мс`);
        if (!rp.response.base64Encoded) md.push(bodyBlock(rp.response.body, C.headerGet(rp.response.headers, 'content-type') || ''));
      }
    }
    md.push('');
    md.push('## Повторить');
    md.push('');
    md.push(fence(C.toCurl(Object.assign({}, req, { headers: C.replayHeaders(e.requestHeaders) }), 'bash'), 'bash'));
    md.push('');
    md.push(fence(C.toFetch(req), 'js'));
    const markdown = md.join('\n') + '\n';
    const title = `${e.method} ${host}${pathPart.split('?')[0]}`.slice(0, 120);
    let out = null;
    const bridge = ctx.bridge;
    if (bridge && typeof bridge.toInbox === 'function') {
      try { out = await bridge.toInbox({ title, markdown, host }); } catch (err) { ctx.log('devtools', 'bridge.toInbox:', err.message); out = null; }
    }
    if (!out || !out.path) {
      const dir = ctx.paths.inbox;
      await fs.promises.mkdir(dir, { recursive: true });
      const file = path.join(dir, `${stamp()}_${slug(host, 40)}_${e.method}_${slug(pathPart.split('?')[0], 40)}.md`);
      await fs.promises.writeFile(file, markdown, 'utf8');
      out = { path: file };
    }
    let pasted = false;
    const term = ctx.terminal;
    if (p.paste !== false && term && typeof term.pasteToClaude === 'function') {
      try { pasted = !!(await term.pasteToClaude(`Разбери запрос ${e.method} ${host}: "${out.path}" `)); } catch (_) { pasted = false; }
    }
    return { path: out.path, pasted, viaBridge: !!(bridge && typeof bridge.toInbox === 'function') };
  }

  // ---------- поиск по телам ----------
  async function searchBodies(p) {
    const tabId = tabIdOf(p);
    const q = String(p.query || '');
    if (!q) return { matches: [], searched: 0, unavailable: 0 };
    let rx = null;
    if (p.regex) { try { rx = new RegExp(q, p.caseSensitive ? 'g' : 'gi'); } catch (e) { throw new Error('неверное регулярное выражение: ' + e.message); } }
    const needle = p.caseSensitive ? q : q.toLowerCase();
    const ids = (Array.isArray(p.ids) ? p.ids.map(String) : ctx.cdp.list(tabId).filter((e) => !e.marker).map((e) => e.id)).slice(-SEARCH_LIMIT_IDS);
    const matches = [];
    let searched = 0, unavailable = 0;
    await pool(ids, 6, async (id) => {
      const e = ctx.cdp.raw(tabId, id);
      if (!e || e.marker || e.state === 'pending' || e.failed || e.redirect) return;
      // у этих ответов тела нет по определению — не считаем «недоступными»
      if (e.method === 'OPTIONS' || e.method === 'HEAD' || [204, 205, 304].includes(e.status) || (e.status >= 100 && e.status < 200 && e.kind !== 'ws')) return;
      let text;
      if (e.kind === 'ws') text = (e.frames || []).map((f) => f.data).join('\n');
      else {
        if (!C.isTextMime(e.mime) || /^image\//.test(e.mime)) return;
        try { text = decodeBody(await ctx.cdp.rawBody(tabId, id)); } catch (_) { unavailable++; return; }
      }
      searched++;
      let count = 0, first = -1;
      if (rx) { rx.lastIndex = 0; let m; while ((m = rx.exec(text)) && count < 1000) { if (first < 0) first = m.index; count++; if (!m[0]) rx.lastIndex++; } }
      else {
        const hay = p.caseSensitive ? text : text.toLowerCase();
        let i = hay.indexOf(needle);
        first = i;
        while (i >= 0 && count < 1000) { count++; i = hay.indexOf(needle, i + Math.max(1, needle.length)); }
      }
      if (count) {
        const a = Math.max(0, first - 40), b = Math.min(text.length, first + q.length + 60);
        matches.push({ id, count, snippet: (a ? '…' : '') + text.slice(a, b).replace(/\s+/g, ' ') + (b < text.length ? '…' : ''), at: first - a + (a ? 1 : 0) });
      }
    });
    return { matches, searched, unavailable };
  }

  function register() {
    const H = (ch, fn) => ctx.ipc.handle('kosmo:net.' + ch, (p) => fn(p || {}));
    H('watch', watch);
    H('list', (p) => snapshot(tabIdOf(p)));
    H('entry', detail);
    H('body', body);
    H('clear', (p) => ctx.cdp.clear(tabIdOf(p)));
    H('pause', (p) => ctx.cdp.setPaused(tabIdOf(p), !!p.paused));
    H('capture', (p) => ctx.cdp.captureTab(tabIdOf(p), p.mode));
    H('exportHar', exportHar);
    H('fetch', fetchInPage);
    H('toClaude', toClaude);
    H('searchBodies', searchBodies);
    ctx.cdp.on('batch', (tabId, b) => {
      if (tabId !== watchedTab) return;
      ctx.panel.send('kosmo:devtools.net', Object.assign({ tabId }, b));
    });
    // панель закрыли или перезагрузили — пакеты больше не нужны
    ctx.panel.on('closed', () => { if (watchedTab != null) ctx.cdp.watch(watchedTab, false); watchedTab = null; });
  }

  return { register, buildHar, toClaude, searchBodies, exportHar };
}

module.exports = { createNetwork };
