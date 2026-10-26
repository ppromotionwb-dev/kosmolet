// Владелец: devtools. Общее для инструментов «DevTools», «Сеть и API», «Хранилище», «Устройство».
// Чистая логика (фильтр запросов, типы, генераторы кода) нужна и main (cdp-hub, devtools — require этого файла),
// поэтому файл — UMD: в main module.exports, в панели window.KDevCommon. Хелперы интерфейса (дерево JSON,
// таблица «ключ — значение», меню, разделитель) — только в панели: window.KDev.
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.KDevCommon = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // ---------- типы запросов ----------
  // CDP resourceType → категория для чипов и фильтра type:
  const KIND_BY_TYPE = {
    XHR: 'api', Fetch: 'api', EventSource: 'api',
    Document: 'doc', Script: 'js', Stylesheet: 'css', Image: 'img', Font: 'font', WebSocket: 'ws', Media: 'media'
  };
  function kindOf(type) { return KIND_BY_TYPE[type] || 'other'; }
  // Что хранит режим записи «api» (остальное — только в режиме «all»).
  const API_TYPES = ['XHR', 'Fetch', 'Document', 'EventSource', 'WebSocket', 'Other', 'Preflight'];
  const KINDS = [
    { id: 'all', title: 'Все' }, { id: 'api', title: 'API' }, { id: 'doc', title: 'Документ' }, { id: 'js', title: 'JS' },
    { id: 'css', title: 'CSS' }, { id: 'img', title: 'Картинки' }, { id: 'font', title: 'Шрифты' }, { id: 'ws', title: 'WS' },
    { id: 'other', title: 'Другое' }
  ];
  function kindMatches(kind, want) {
    if (!want || want === 'all') return true;
    if (want === 'other') return kind === 'other' || kind === 'media';
    return kind === want;
  }

  function hostOf(url) { try { return new URL(url).host; } catch (e) { return ''; } }
  function isJsonMime(m) { return /[/+]json\b|^application\/(x-)?json|\bjson$/i.test(String(m || '')); }
  function isTextMime(m) {
    m = String(m || '').toLowerCase();
    return !m || /^text\/|json|xml|javascript|ecmascript|x-www-form-urlencoded|graphql|csv|svg|html|yaml|x-ndjson/.test(m);
  }

  // ---------- фильтр-строка ----------
  // Слова — подстрока адреса (И), /regex/ — регулярное выражение по адресу, «-» в начале — исключение.
  // Операторы: status:4xx|404|>=400|failed|pending, method:POST, domain:example.com (и *.example.com), mime:json,
  // type:api|doc|js|css|img|font|ws|other|xhr…, larger-than:100k. Несколько значений — через запятую.
  function tokenize(s) {
    const out = [];
    const re = /(-?)(?:([a-z-]+):)?("([^"]*)"|\/((?:\\.|[^/])+)\/([a-z]*)|(\S+))/gi;
    let m;
    while ((m = re.exec(String(s || '')))) {
      const neg = m[1] === '-';
      const key = m[2] ? m[2].toLowerCase() : '';
      if (m[5] !== undefined && !key) {
        let rx = null;
        try { rx = new RegExp(m[5], m[6] || 'i'); } catch (e) { rx = null; }
        if (rx) { out.push({ neg, key: 'regex', rx }); continue; }
      }
      const val = m[4] !== undefined ? m[4] : (m[5] !== undefined ? '/' + m[5] + '/' + (m[6] || '') : m[7]);
      if (!key && !val) continue;
      out.push({ neg, key, val: String(val == null ? '' : val) });
    }
    return out;
  }
  const KEYS = new Set(['status', 'method', 'domain', 'host', 'mime', 'type', 'larger-than', 'is', 'scheme']);
  function parseSize(s) {
    const m = /^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/i.exec(String(s || '').trim());
    if (!m) return NaN;
    return parseFloat(m[1]) * ({ '': 1, k: 1024, m: 1048576, g: 1073741824 }[m[2].toLowerCase()]);
  }
  function statusTest(v) {
    v = v.toLowerCase();
    if (v === 'failed' || v === 'error') return (e) => !!e.failed;
    if (v === 'pending') return (e) => !!e.pending;
    let m = /^([1-5])xx$/.exec(v);
    if (m) { const d = +m[1]; return (e) => Math.floor((e.status || 0) / 100) === d; }
    m = /^(>=|<=|>|<)(\d{3})$/.exec(v);
    if (m) {
      const n = +m[2], op = m[1];
      return (e) => { const s = e.status || 0; return s > 0 && (op === '>=' ? s >= n : op === '<=' ? s <= n : op === '>' ? s > n : s < n); };
    }
    if (/^\d{1,3}$/.test(v)) { const n = +v; return (e) => (e.status || 0) === n; }
    return () => false;
  }
  function globRe(g) { return new RegExp('^' + g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i'); }
  function domainTest(v) {
    v = v.toLowerCase().replace(/^\.+/, '');
    if (v.includes('*')) { const re = globRe(v); return (e) => re.test(e._host); }
    return (e) => e._host === v || e._host.endsWith('.' + v) || e._host.split(':')[0] === v;
  }
  function compileTerm(t) {
    if (t.key === 'regex') { const rx = t.rx; return (e) => rx.test(e.url); }
    const key = t.key === 'host' ? 'domain' : t.key;
    if (!key || !KEYS.has(key)) {
      const s = (t.key && !KEYS.has(t.key) ? t.key + ':' : '') + t.val;
      const low = s.toLowerCase();
      return (e) => e._low.includes(low);
    }
    const vals = t.val.split(',').map((x) => x.trim()).filter(Boolean);
    if (!vals.length) return () => true;
    let tests;
    switch (key) {
      case 'status': tests = vals.map(statusTest); break;
      case 'method': tests = vals.map((v) => { const u = v.toUpperCase(); return (e) => String(e.method || '').toUpperCase() === u; }); break;
      case 'domain': tests = vals.map(domainTest); break;
      case 'mime': tests = vals.map((v) => { const l = v.toLowerCase(); return (e) => String(e.mime || '').toLowerCase().includes(l); }); break;
      case 'type': tests = vals.map((v) => { const l = v.toLowerCase(); return (e) => e.kind === l || String(e.type || '').toLowerCase() === l || (l === 'other' && e.kind === 'media'); }); break;
      case 'larger-than': tests = vals.map((v) => { const n = parseSize(v); return (e) => isFinite(n) && (e.size || 0) > n; }); break;
      case 'scheme': tests = vals.map((v) => { const l = v.toLowerCase().replace(/:$/, ''); return (e) => e._low.startsWith(l + ':'); }); break;
      case 'is': tests = vals.map((v) => {
        const l = v.toLowerCase();
        if (l === 'cached' || l === 'from-cache') return (e) => !!e.fromCache;
        if (l === 'failed') return (e) => !!e.failed;
        if (l === 'running' || l === 'pending') return (e) => !!e.pending;
        return () => false;
      }); break;
      default: tests = [() => true];
    }
    return (e) => tests.some((f) => f(e));
  }
  // compileFilter('status:4xx -google') → (entry) => bool. Пустая строка → null (без фильтра).
  function compileFilter(s) {
    const terms = tokenize(s);
    if (!terms.length) return null;
    const fns = terms.map((t) => ({ neg: t.neg, fn: compileTerm(t) }));
    return function (e) {
      if (e._low === undefined) prep(e);
      for (const f of fns) { if (f.fn(e) === f.neg) return false; }
      return true;
    };
  }
  // кэш производных полей записи для фильтра (непубличные, с подчёркиванием)
  function prep(e) {
    Object.defineProperty(e, '_low', { value: String(e.url || '').toLowerCase(), writable: true, configurable: true });
    Object.defineProperty(e, '_host', { value: hostOf(e.url).toLowerCase(), writable: true, configurable: true });
    return e;
  }

  // ---------- заголовки ----------
  // CDP: {name: 'v1\nv2'} → [[name, v1], [name, v2]]
  function headerPairs(h) {
    const out = [];
    if (!h) return out;
    if (Array.isArray(h)) { for (const x of h) if (x && x.name) out.push([String(x.name), String(x.value == null ? '' : x.value)]); return out; }
    for (const k of Object.keys(h)) {
      const v = h[k] == null ? '' : String(h[k]);
      for (const part of v.split('\n')) out.push([k, part]);
    }
    return out;
  }
  function headerGet(h, name) {
    const l = name.toLowerCase();
    for (const [k, v] of headerPairs(h)) if (k.toLowerCase() === l) return v;
    return null;
  }
  // Заголовки, которые fetch из страницы выставить не может (браузер ставит сам).
  const FORBIDDEN = new Set(['accept-charset', 'accept-encoding', 'access-control-request-headers', 'access-control-request-method',
    'connection', 'content-length', 'cookie', 'cookie2', 'date', 'dnt', 'expect', 'host', 'keep-alive', 'origin', 'referer',
    'set-cookie', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'via', 'user-agent', 'priority']);
  function isForbiddenHeader(n) {
    const l = String(n).toLowerCase();
    return l.charAt(0) === ':' || FORBIDDEN.has(l) || l.startsWith('sec-') || l.startsWith('proxy-');
  }
  // Заголовки для повтора запроса из страницы: без запрещённых и псевдозаголовков.
  function replayHeaders(h) {
    const out = {};
    for (const [k, v] of headerPairs(h)) {
      if (isForbiddenHeader(k)) continue;
      const l = k.toLowerCase();
      out[l] = out[l] != null ? out[l] + ', ' + v : v;
    }
    return out;
  }

  // ---------- генераторы кода ----------
  // req = { method, url, headers (объект CDP), body (строка|null), responseMime? }
  function jsonExact(body) {
    if (body == null || body === '') return undefined;
    try { const v = JSON.parse(body); return JSON.stringify(v) === body ? v : undefined; } catch (e) { return undefined; }
  }
  function indentLines(s, pad) { return s.split('\n').map((l, i) => (i ? pad + l : l)).join('\n'); }

  function toFetch(req) {
    const method = String(req.method || 'GET').toUpperCase();
    const headers = {};
    let referrer = null;
    for (const [k, v] of headerPairs(req.headers)) {
      const l = k.toLowerCase();
      if (l === 'referer') { referrer = v; continue; }
      if (isForbiddenHeader(l)) continue;
      headers[l] = headers[l] != null ? headers[l] + ', ' + v : v;
    }
    const lines = [];
    if (method !== 'GET') lines.push('method: ' + JSON.stringify(method));
    if (Object.keys(headers).length) lines.push('headers: ' + indentLines(JSON.stringify(headers, null, 2), '  '));
    const hasBody = req.body != null && req.body !== '' && method !== 'GET' && method !== 'HEAD';
    if (hasBody) {
      const j = jsonExact(req.body);
      lines.push('body: ' + (j !== undefined && typeof j === 'object' && j !== null ? 'JSON.stringify(' + indentLines(JSON.stringify(j, null, 2), '  ') + ')' : JSON.stringify(req.body)));
    }
    if (referrer) lines.push('referrer: ' + JSON.stringify(referrer));
    lines.push('credentials: "include"');
    const parse = isJsonMime(req.responseMime) ? 'r.json()' : 'r.text()';
    return 'fetch(' + JSON.stringify(req.url) + ', {\n  ' + lines.join(',\n  ') + '\n})\n  .then((r) => ' + parse + ')\n  .then((data) => console.log(data));';
  }

  function escPosix(str) {
    str = String(str);
    if (/[\0-\x1F\x7F-\x9F!]|'/.test(str)) {
      const hex = (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0');
      return "$'" + str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/[\0-\x1F\x7F-\x9F!]/g, hex) + "'";
    }
    return "'" + str + "'";
  }
  function escWin(str) {
    // порядок замен важен: \ → \\, " → \", остальное подозрительное — через ^, % перед именем переменной — %^
    return '^"' + String(str).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      .replace(/[^a-zA-Z0-9\s_\-:=+~'/.,?;()*`]/g, '^$&')
      .replace(/%(?=[a-zA-Z0-9_])/g, '%^')
      .replace(/\r?\n/g, '^\n\n') + '^"';
  }
  function toCurl(req, platform) {
    const win = platform === 'cmd';
    const esc = win ? escWin : escPosix;
    const method = String(req.method || 'GET').toUpperCase();
    const parts = ['curl ' + esc(req.url)];
    const hasBody = req.body != null && req.body !== '' && method !== 'GET' && method !== 'HEAD';
    if (!(method === 'GET' && !hasBody) && !(method === 'POST' && hasBody)) parts.push('-X ' + esc(method));
    let compressed = false, cookie = null;
    for (const [k, v] of headerPairs(req.headers)) {
      const l = k.toLowerCase();
      if (l.charAt(0) === ':' || l === 'host' || l === 'content-length') continue;
      if (l === 'accept-encoding') { compressed = true; continue; }
      if (l === 'cookie') { cookie = cookie ? cookie + '; ' + v : v; continue; }
      parts.push('-H ' + esc(k + ': ' + v));
    }
    if (cookie) parts.push('-b ' + esc(cookie));
    if (hasBody) parts.push('--data-raw ' + esc(req.body));
    if (compressed) parts.push('--compressed');
    return parts.join(win ? ' ^\n  ' : ' \\\n  ');
  }

  function escPs(str) {
    return '"' + String(str).replace(/[`$"]/g, '`$&').replace(/[^\x20-\x7E]/g, (c) => '$([char]' + c.charCodeAt(0) + ')') + '"';
  }
  function toPowerShell(req) {
    const method = String(req.method || 'GET').toUpperCase();
    const out = [];
    const headers = [];
    let ua = null, ctype = null, cookie = null;
    for (const [k, v] of headerPairs(req.headers)) {
      const l = k.toLowerCase();
      if (l.charAt(0) === ':' || ['host', 'connection', 'proxy-connection', 'content-length', 'expect', 'range', 'accept-encoding'].includes(l)) continue;
      if (l === 'user-agent') { ua = v; continue; }
      if (l === 'content-type') { ctype = v; continue; }
      if (l === 'cookie') { cookie = cookie ? cookie + '; ' + v : v; continue; }
      headers.push([k, v]);
    }
    let host = '';
    try { host = new URL(req.url).hostname; } catch (e) { host = ''; }
    const needSession = ua || cookie;
    if (needSession) {
      out.push('$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession');
      if (ua) out.push('$session.UserAgent = ' + escPs(ua));
      if (cookie) {
        for (const c of cookie.split(/;\s*/)) {
          const i = c.indexOf('=');
          if (i <= 0) continue;
          out.push('$session.Cookies.Add((New-Object System.Net.Cookie(' + escPs(c.slice(0, i)) + ', ' + escPs(c.slice(i + 1)) + ', "/", ' + escPs(host) + ')))');
        }
      }
    }
    const args = ['Invoke-WebRequest -UseBasicParsing -Uri ' + escPs(req.url)];
    if (method !== 'GET') args.push('-Method ' + escPs(method));
    if (needSession) args.push('-WebSession $session');
    if (headers.length) args.push('-Headers @{\n' + headers.map(([k, v]) => '  ' + escPs(k) + '=' + escPs(v)).join('\n') + '\n}');
    if (ctype) args.push('-ContentType ' + escPs(ctype));
    const hasBody = req.body != null && req.body !== '' && method !== 'GET' && method !== 'HEAD';
    if (hasBody) {
      // PowerShell 5.1 кодирует строку тела в ISO-8859-1 — не-ASCII отправляем байтами UTF-8
      args.push(/[^\x20-\x7E]/.test(req.body) ? '-Body ([System.Text.Encoding]::UTF8.GetBytes(' + escPs(req.body) + '))' : '-Body ' + escPs(req.body));
    }
    out.push(args.join(' `\n'));
    return out.join('\n');
  }

  function pyStr(s) { return JSON.stringify(String(s)); }
  function pyRepr(v, ind) {
    ind = ind || '';
    const next = ind + '    ';
    if (v === null || v === undefined) return 'None';
    if (v === true) return 'True';
    if (v === false) return 'False';
    if (typeof v === 'number') return isFinite(v) ? JSON.stringify(v) : 'None';
    if (typeof v === 'string') return pyStr(v);
    if (Array.isArray(v)) {
      if (!v.length) return '[]';
      return '[\n' + v.map((x) => next + pyRepr(x, next)).join(',\n') + ',\n' + ind + ']';
    }
    const keys = Object.keys(v);
    if (!keys.length) return '{}';
    return '{\n' + keys.map((k) => next + pyStr(k) + ': ' + pyRepr(v[k], next)).join(',\n') + ',\n' + ind + '}';
  }
  function toPython(req) {
    const method = String(req.method || 'GET').toUpperCase();
    const headers = {};
    let cookie = null;
    for (const [k, v] of headerPairs(req.headers)) {
      const l = k.toLowerCase();
      if (l.charAt(0) === ':' || ['host', 'content-length', 'connection', 'accept-encoding'].includes(l)) continue;
      if (l === 'cookie') { cookie = cookie ? cookie + '; ' + v : v; continue; }
      headers[l] = headers[l] != null ? headers[l] + ', ' + v : v;
    }
    const lines = ['import requests', '', 'url = ' + pyStr(req.url)];
    const kw = [];
    if (Object.keys(headers).length) { lines.push('headers = ' + pyRepr(headers)); kw.push('headers=headers'); }
    if (cookie) {
      const c = {};
      for (const part of cookie.split(/;\s*/)) { const i = part.indexOf('='); if (i > 0) c[part.slice(0, i)] = part.slice(i + 1); }
      lines.push('cookies = ' + pyRepr(c));
      kw.push('cookies=cookies');
    }
    const hasBody = req.body != null && req.body !== '' && method !== 'GET' && method !== 'HEAD';
    if (hasBody) {
      const j = jsonExact(req.body);
      const ct = String(headerGet(req.headers, 'content-type') || '');
      if (j !== undefined && typeof j === 'object' && j !== null && /json/i.test(ct || 'json')) { lines.push('json_data = ' + pyRepr(j)); kw.push('json=json_data'); }
      else { lines.push('data = ' + pyStr(req.body)); kw.push('data=data.encode("utf-8")'); }
    }
    lines.push('');
    const fn = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method) ? 'requests.' + method.toLowerCase() + '(url' : 'requests.request(' + pyStr(method) + ', url';
    lines.push('response = ' + fn + (kw.length ? ', ' + kw.join(', ') : '') + ')');
    lines.push('print(response.status_code)');
    lines.push(isJsonMime(req.responseMime) ? 'print(response.json())' : 'print(response.text)');
    return lines.join('\n');
  }

  const CODEGEN = [
    { id: 'url', title: 'Адрес (URL)' },
    { id: 'fetch', title: 'fetch (JavaScript)' },
    { id: 'curl', title: 'cURL (bash)' },
    { id: 'curl-cmd', title: 'cURL (cmd)' },
    { id: 'powershell', title: 'PowerShell' },
    { id: 'python', title: 'Python requests' }
  ];
  function codegen(kind, req) {
    switch (kind) {
      case 'url': return String(req.url || '');
      case 'fetch': return toFetch(req);
      case 'curl': return toCurl(req, 'bash');
      case 'curl-cmd': return toCurl(req, 'cmd');
      case 'powershell': return toPowerShell(req);
      case 'python': return toPython(req);
      default: return '';
    }
  }

  // ---------- форма и query ----------
  function parseQuery(url) {
    const out = [];
    try { new URL(url).searchParams.forEach((v, k) => out.push([k, v])); } catch (e) { /* пусто */ }
    return out;
  }
  function parseForm(body) {
    const out = [];
    try { new URLSearchParams(String(body || '')).forEach((v, k) => out.push([k, v])); } catch (e) { /* пусто */ }
    return out;
  }

  // путь до значения JSON: data.items[3].nmId, ["ключ с пробелом"]
  function jsonPath(parts) {
    let s = '';
    for (const p of parts) {
      if (typeof p === 'number') s += '[' + p + ']';
      else if (/^[A-Za-z_$][\w$]*$/.test(p)) s += (s ? '.' : '') + p;
      else s += '[' + JSON.stringify(p) + ']';
    }
    return s;
  }

  return {
    KINDS, API_TYPES, kindOf, kindMatches, hostOf, isJsonMime, isTextMime,
    tokenize, compileFilter, prep, parseSize,
    headerPairs, headerGet, isForbiddenHeader, replayHeaders,
    CODEGEN, codegen, toFetch, toCurl, toPowerShell, toPython, escPosix, escWin, escPs, pyRepr,
    parseQuery, parseForm, jsonPath
  };
});

// ---------- хелперы интерфейса панели (window.KDev) ----------
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined' || !window.KUI) return;
  const U = window.KUI;
  const { h } = U;
  const C = window.KDevCommon;
  U.css('tools/devtools-common.css');

  // иконки, которых нет в общем наборе
  const I = window.KIcons;
  I.add('circle-dot', '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3" fill="currentColor"/>');
  I.add('ban', '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>');
  I.add('repeat', '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>');
  I.add('rotate-ccw', '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>');
  I.add('chevrons-down-up', '<path d="m7 20 5-5 5 5"/><path d="m7 4 5 5 5-5"/>');
  I.add('chevrons-up-down', '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>');
  I.add('wrap-text', '<path d="M3 6h18"/><path d="M3 12h15a3 3 0 1 1 0 6h-4"/><path d="m16 16-2 2 2 2"/><path d="M3 18h7"/>');
  I.add('file-json', '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 12a1 1 0 0 0-1 1v1a1 1 0 0 1-1 1 1 1 0 0 1 1 1v1a1 1 0 0 0 1 1"/><path d="M14 18a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1 1 1 0 0 1-1-1v-1a1 1 0 0 0-1-1"/>');
  I.add('rotate-device', '<rect width="10" height="16" x="3" y="5" rx="2"/><path d="M17 3a4 4 0 0 1 4 4v1"/><path d="m19 6 2 2 2-2"/>');
  I.add('tablet', '<rect width="16" height="20" x="4" y="2" rx="2"/><path d="M12 18h.01"/>');
  I.add('laptop', '<path d="M18 5a2 2 0 0 1 2 2v8.5H4V7a2 2 0 0 1 2-2z"/><path d="M2 19h20"/>');
  I.add('signal', '<path d="M2 20h.01"/><path d="M7 20v-4"/><path d="M12 20v-8"/><path d="M17 20V8"/><path d="M22 4v16"/>');
  I.add('dock', '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/><path d="m8 9 3 3-3 3"/>');
  I.add('printer', '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect width="12" height="8" x="6" y="14"/>');

  const errText = (e) => String((e && e.message) || e || '').replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');

  // ---------- меню (выпадающий список внутри панели) ----------
  let menuEl = null, menuOff = null;
  function closeMenu() {
    if (menuEl) { menuEl.remove(); menuEl = null; }
    if (menuOff) { menuOff(); menuOff = null; }
  }
  // items: [{title, hint?, icon?, danger?, disabled?, onPick}] | {sep:true}; at: {x, y} или элемент-якорь
  function menu(items, at) {
    closeMenu();
    const el = h('div.kd-menu', { role: 'menu' });
    const btns = [];
    for (const it of items) {
      if (!it) continue;
      if (it.sep) { el.appendChild(h('div.kd-menu-sep')); continue; }
      if (it.label) { el.appendChild(h('div.kd-menu-label', it.label)); continue; }
      const b = h('button.kd-menu-item' + (it.danger ? '.danger' : ''), { type: 'button', role: 'menuitem', disabled: !!it.disabled },
        it.icon ? U.icon(it.icon, 14) : h('span.kd-menu-noicon'), h('span.kd-menu-title', it.title), it.hint ? h('span.kd-menu-hint', it.hint) : null);
      b.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); try { it.onPick && it.onPick(); } catch (err) { console.error(err); } });
      btns.push(b);
      el.appendChild(b);
    }
    document.body.appendChild(el);
    let x, y;
    if (at instanceof Element) { const r = at.getBoundingClientRect(); x = r.left; y = r.bottom + 4; } else { x = at.x; y = at.y; }
    const w = el.offsetWidth, hh = el.offsetHeight;
    x = Math.max(6, Math.min(x, window.innerWidth - w - 6));
    if (y + hh > window.innerHeight - 6) y = Math.max(6, (at instanceof Element ? at.getBoundingClientRect().top - hh - 4 : y - hh));
    el.style.left = x + 'px'; el.style.top = y + 'px';
    menuEl = el;
    const onDown = (e) => { if (!el.contains(e.target)) closeMenu(); };
    const onKey = (e) => {
      if (e.key === 'Escape') { closeMenu(); e.preventDefault(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const live = btns.filter((b) => !b.disabled);
        const i = live.indexOf(document.activeElement);
        const n = e.key === 'ArrowDown' ? (i + 1) % live.length : (i - 1 + live.length) % live.length;
        if (live[n]) live[n].focus();
      }
    };
    setTimeout(() => { document.addEventListener('mousedown', onDown, true); }, 0);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', closeMenu);
    menuOff = () => { document.removeEventListener('mousedown', onDown, true); document.removeEventListener('keydown', onKey, true); window.removeEventListener('blur', closeMenu); };
    const first = btns.find((b) => !b.disabled);
    if (first) first.focus({ preventScroll: true });
    return el;
  }

  // ---------- таблица «ключ — значение» ----------
  // rows: [[k, v]]; opts: {mono, empty, copy: true}
  function kvTable(rows, opts) {
    opts = opts || {};
    if (!rows || !rows.length) return h('div.kd-kv-empty', opts.empty || 'Нет данных');
    const t = h('div.kd-kv' + (opts.mono === false ? '' : '.mono'));
    for (const [k, v] of rows) {
      const ve = h('div.kd-kv-v', String(v == null ? '' : v));
      const ke = h('div.kd-kv-k', { title: String(k) }, String(k));
      if (opts.copy !== false) {
        ve.title = 'Щелчок — копировать значение';
        ve.addEventListener('click', () => { if (!window.getSelection().toString()) U.copyText(String(v == null ? '' : v)); });
      }
      t.append(ke, ve);
    }
    return t;
  }

  function section(title, body, opts) {
    opts = opts || {};
    const head = h('button.kd-sec-head', { type: 'button', 'aria-expanded': opts.collapsed ? 'false' : 'true' },
      U.icon('chevron-down', 14), h('span', title), opts.meta != null ? h('span.kd-sec-meta', String(opts.meta)) : null);
    const bodyEl = h('div.kd-sec-body', { hidden: !!opts.collapsed }, body);
    const el = h('section.kd-sec' + (opts.collapsed ? '.collapsed' : ''), head, bodyEl);
    head.addEventListener('click', () => {
      const c = !el.classList.contains('collapsed');
      el.classList.toggle('collapsed', c);
      bodyEl.hidden = c;
      head.setAttribute('aria-expanded', c ? 'false' : 'true');
      if (opts.onToggle) opts.onToggle(!c);
    });
    if (opts.actions) head.appendChild(h('span.kd-sec-actions', { onClick: (e) => e.stopPropagation() }, opts.actions));
    return el;
  }

  // ---------- дерево JSON ----------
  // jsonTree(value, {onSelect(path, value)}) → {el, search(q) → count, next(dir), expandAll(depth), collapseAll(), selectedPath()}
  const CHUNK = 100;
  function typeOf(v) { return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v; }
  function previewOf(v) {
    const t = typeOf(v);
    if (t === 'array') return 'Array(' + v.length + ')';
    if (t === 'object') {
      const keys = Object.keys(v);
      const s = keys.slice(0, 4).join(', ');
      return '{' + s + (keys.length > 4 ? ', …' : '') + '}';
    }
    return '';
  }
  function scalarEl(v) {
    const t = typeOf(v);
    if (t === 'string') {
      const s = v.length > 3000 ? v.slice(0, 3000) + '…' : v;
      return h('span.jt-v.jt-str', JSON.stringify(s));
    }
    return h('span.jt-v.jt-' + t, String(v));
  }
  function jsonTree(root, opts) {
    opts = opts || {};
    const el = h('div.jt', { tabindex: '0' });
    let selected = null;   // элемент строки
    let matches = [], mIdx = -1, query = '';

    function rowFor(key, value, path, depth) {
      const t = typeOf(value);
      const container = t === 'object' || t === 'array';
      const row = h('div.jt-row', { style: { paddingLeft: (depth * 14 + 4) + 'px' } });
      row._path = path; row._value = value;
      const tw = h('span.jt-tw' + (container ? '' : '.leaf'), container ? U.icon('chevron-right', 12) : null);
      row.appendChild(tw);
      if (key !== null) row.append(h('span.jt-k' + (typeof key === 'number' ? '.idx' : ''), String(key)), h('span.jt-colon', ': '));
      if (container) row.appendChild(h('span.jt-pv', previewOf(value)));
      else row.appendChild(scalarEl(value));
      const wrap = h('div.jt-node', row);
      if (container) {
        wrap._kids = null;
        const toggle = () => setOpen(wrap, !wrap.classList.contains('open'));
        tw.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
        row.addEventListener('dblclick', (e) => { e.preventDefault(); toggle(); });
      }
      row.addEventListener('click', () => select(row));
      wrap._depth = depth;
      return wrap;
    }
    function kidsOf(wrap) {
      const row = wrap.firstChild;
      const v = row._value, path = row._path, depth = wrap._depth + 1;
      const box = h('div.jt-kids');
      if (Array.isArray(v)) {
        const addRange = (from, to, target) => { for (let i = from; i < to; i++) target.appendChild(rowFor(i, v[i], path.concat(i), depth)); };
        if (v.length <= CHUNK) addRange(0, v.length, box);
        else {
          for (let s = 0; s < v.length; s += CHUNK) {
            const e2 = Math.min(v.length, s + CHUNK);
            const g = h('div.jt-node.jt-group');
            const grow = h('div.jt-row', { style: { paddingLeft: (depth * 14 + 4) + 'px' } }, h('span.jt-tw', U.icon('chevron-right', 12)), h('span.jt-pv', '[' + s + ' … ' + (e2 - 1) + ']'));
            g.appendChild(grow);
            g._range = [s, e2];
            g._depth = depth;
            grow.addEventListener('click', () => {
              const open = !g.classList.contains('open');
              g.classList.toggle('open', open);
              if (open && !g._kids) { g._kids = h('div.jt-kids'); addRange(s, e2, g._kids); g.appendChild(g._kids); }
              if (g._kids) g._kids.hidden = !open;
            });
            box.appendChild(g);
          }
        }
      } else {
        for (const k of Object.keys(v)) box.appendChild(rowFor(k, v[k], path.concat(k), depth));
      }
      return box;
    }
    function setOpen(wrap, open) {
      if (!wrap.firstChild || !wrap.firstChild._path) return;
      const t = typeOf(wrap.firstChild._value);
      if (t !== 'object' && t !== 'array') return;
      wrap.classList.toggle('open', open);
      if (open && !wrap._kids) { wrap._kids = kidsOf(wrap); wrap.appendChild(wrap._kids); }
      if (wrap._kids) wrap._kids.hidden = !open;
    }
    function select(row) {
      if (selected) selected.classList.remove('sel');
      selected = row;
      if (row) {
        row.classList.add('sel');
        if (opts.onSelect) opts.onSelect(row._path, row._value);
      }
    }
    const top = typeOf(root);
    if (top === 'object' || top === 'array') {
      const w = rowFor(null, root, [], 0);
      el.appendChild(w);
      setOpen(w, true);
      // второй уровень раскрываем, если он небольшой
      if (w._kids && w._kids.children.length <= 12) for (const c of w._kids.children) if (c.firstChild && c.firstChild._value && typeof c.firstChild._value === 'object' && JSON.stringify(c.firstChild._value).length < 4000) setOpen(c, true);
    } else {
      el.appendChild(rowFor(null, root, [], 0));
    }

    // раскрыть путь и вернуть строку
    function reveal(path) {
      let wrap = el.firstChild;
      for (let i = 0; i < path.length; i++) {
        setOpen(wrap, true);
        const seg = path[i];
        let next = null;
        for (const c of wrap._kids ? wrap._kids.children : []) {
          if (c._range) {
            if (typeof seg === 'number' && seg >= c._range[0] && seg < c._range[1]) {
              c.classList.add('open');
              if (!c._kids) { c._kids = h('div.jt-kids'); const arr = wrap.firstChild._value; for (let j = c._range[0]; j < c._range[1]; j++) c._kids.appendChild(rowFor(j, arr[j], wrap.firstChild._path.concat(j), c._depth)); c.appendChild(c._kids); }
              c._kids.hidden = false;
              for (const cc of c._kids.children) if (cc.firstChild._path[cc.firstChild._path.length - 1] === seg) { next = cc; break; }
              break;
            }
            continue;
          }
          const p = c.firstChild._path;
          if (p[p.length - 1] === seg) { next = c; break; }
        }
        if (!next) return null;
        wrap = next;
      }
      return wrap.firstChild;
    }

    function search(q) {
      query = String(q || '').toLowerCase();
      for (const m of el.querySelectorAll('.jt-row.hit')) m.classList.remove('hit');
      matches = []; mIdx = -1;
      if (!query) return 0;
      const walk = (v, path) => {
        if (matches.length >= 1000) return;
        const t = typeOf(v);
        if (t === 'object' || t === 'array') {
          const keys = Array.isArray(v) ? v.map((_, i) => i) : Object.keys(v);
          for (const k of keys) {
            if (typeof k === 'string' && k.toLowerCase().includes(query)) matches.push(path.concat(k));
            else {
              const c = v[k];
              const ct = typeOf(c);
              if (ct !== 'object' && ct !== 'array' && String(c).toLowerCase().includes(query)) { matches.push(path.concat(k)); continue; }
            }
            walk(v[k], path.concat(k));
          }
        }
      };
      walk(root, []);
      return matches.length;
    }
    function next(dir) {
      if (!matches.length) return { index: -1, total: 0 };
      mIdx = (mIdx + (dir < 0 ? -1 : 1) + matches.length) % matches.length;
      const row = reveal(matches[mIdx]);
      for (const m of el.querySelectorAll('.jt-row.hit')) m.classList.remove('hit');
      if (row) { row.classList.add('hit'); row.scrollIntoView({ block: 'center' }); select(row); }
      return { index: mIdx, total: matches.length };
    }
    function expandAll(maxNodes) {
      let budget = maxNodes || 3000;
      const walk = (wrap) => {
        if (budget <= 0) return;
        const t = wrap.firstChild && typeOf(wrap.firstChild._value);
        if (wrap._range) { if (!wrap.classList.contains('open')) wrap.firstChild.click(); }
        else if (t === 'object' || t === 'array') setOpen(wrap, true);
        budget--;
        if (wrap._kids) for (const c of wrap._kids.children) walk(c);
      };
      walk(el.firstChild);
    }
    function collapseAll() {
      for (const n of el.querySelectorAll('.jt-node.open')) { n.classList.remove('open'); if (n._kids) n._kids.hidden = true; }
      setOpen(el.firstChild, true);
    }
    el.addEventListener('keydown', (e) => {
      if (!selected) return;
      const rows = Array.from(el.querySelectorAll('.jt-row')).filter((r) => r.offsetParent !== null);
      const i = rows.indexOf(selected);
      if (e.key === 'ArrowDown' && rows[i + 1]) { select(rows[i + 1]); rows[i + 1].scrollIntoView({ block: 'nearest' }); e.preventDefault(); }
      else if (e.key === 'ArrowUp' && rows[i - 1]) { select(rows[i - 1]); rows[i - 1].scrollIntoView({ block: 'nearest' }); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { setOpen(selected.parentNode, true); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { setOpen(selected.parentNode, false); e.preventDefault(); }
      else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyC' && !window.getSelection().toString()) {
        const v = selected._value;
        U.copyText(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
        e.preventDefault();
      }
    });
    return {
      el, search, next, expandAll, collapseAll, select,
      selectedPath: () => (selected ? selected._path : null),
      selectedValue: () => (selected ? selected._value : undefined)
    };
  }

  // ---------- разделитель (перетаскивание размера) ----------
  // splitter(handle, {vertical, get(), set(px), min, max})
  function splitter(handle, o) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const start = o.vertical ? e.clientX : e.clientY;
      const base = o.get();
      document.documentElement.classList.add(o.vertical ? 'kd-resizing-x' : 'kd-resizing-y');
      const move = (ev) => {
        const d = (o.vertical ? ev.clientX : ev.clientY) - start;
        const v = Math.round(U.clamp(base - d, o.min || 80, typeof o.max === 'function' ? o.max() : (o.max || 2000)));
        o.set(v);
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        document.documentElement.classList.remove('kd-resizing-x', 'kd-resizing-y');
        if (o.done) o.done();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }

  // ---------- мелочи ----------
  function seg(options, onPick, opts) {
    opts = opts || {};
    const el = h('div.k-seg.kd-seg' + (opts.small ? '.sm' : ''), { role: 'radiogroup', 'aria-label': opts.label || null });
    const btns = options.map(([v, text, title]) => {
      const b = h('button', { type: 'button', role: 'radio', dataset: { v: String(v) }, title: title || null }, text);
      b.addEventListener('click', () => onPick(v));
      el.appendChild(b);
      return b;
    });
    el.set = (v) => btns.forEach((b) => { const on = b.dataset.v === String(v); b.classList.toggle('active', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); });
    return el;
  }
  function iconBtn(icon, title, onClick, cls) {
    const b = h('button.k-icon-btn.k-icon-btn-sm' + (cls ? '.' + cls : ''), { type: 'button', title, 'aria-label': title }, U.icon(icon, 15));
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }
  function statusTone(s, failed) {
    if (failed) return 'err';
    if (!s) return 'pend';
    if (s >= 500) return 'err';
    if (s >= 400) return 'warn';
    if (s >= 300) return 'redir';
    return 'ok';
  }
  function prettyBody(text, mime) {
    if (text == null) return '';
    const s = String(text);
    if (C.isJsonMime(mime) || /^\s*[[{]/.test(s)) {
      try { return JSON.stringify(JSON.parse(s), null, 2); } catch (e) { /* не JSON */ }
    }
    return s;
  }
  function tryJson(text) {
    if (text == null) return { ok: false };
    const s = String(text).trim();
    if (!s || !/^[[{"\d-]|^(true|false|null)$/.test(s)) return { ok: false };
    try { return { ok: true, value: JSON.parse(s) }; } catch (e) { return { ok: false }; }
  }

  window.KDev = { menu, closeMenu, kvTable, section, jsonTree, splitter, seg, iconBtn, statusTone, prettyBody, tryJson, errText };
})();
