'use strict';
// Фича «site-intel»: чистые функции без состояния — сайт по адресу, шаблон пути, query-параметры с маскировкой,
// «заметные» заголовки (только имена), схема JSON (только ключи и типы) и её компактная запись в TS-подобном виде.

let tldts = null;
try { tldts = require('tldts-experimental'); } catch (_) { tldts = null; }

const MAX_DEPTH = 6;
const MAX_KEYS = 80;
const ARRAY_SAMPLE = 20;
const EXAMPLE_LEN = 40;

function clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// ---------- сайт ----------
const isIp = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':') || h.startsWith('[');

// Регистрируемый домен: seller.wildberries.ru → wildberries.ru; IP и localhost — как есть.
function siteOf(hostOrUrl) {
  let h = String(hostOrUrl || '').trim().toLowerCase();
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(h)) { try { h = new URL(h).hostname; } catch (_) { return ''; } }
  if (h.includes('/')) h = h.split('/')[0];
  if (h.split(':').length === 2) h = h.split(':')[0]; // хост:порт (у IPv6 двоеточий больше)
  h = h.replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (!h) return '';
  if (isIp(h) || !h.includes('.')) return h;
  if (tldts) {
    try { const d = tldts.getDomain(h, { allowPrivateDomains: true }); if (d) return d; } catch (_) { /* запасной путь */ }
  }
  const parts = h.split('.');
  const two = parts.slice(-2).join('.');
  if (parts.length > 2 && /^(com|net|org|co|gov|edu|ac|msk|spb)\.[a-z]{2}$/.test(two)) return parts.slice(-3).join('.');
  return two;
}

// Имя файла сайта: только безопасные символы.
function siteFile(site) { return String(site || '').toLowerCase().replace(/[^a-z0-9.\-]/g, '_').slice(0, 120) || '_'; }

function validSite(s) {
  s = String(s || '').trim().toLowerCase();
  return !!s && s.length <= 253 && /^[a-z0-9.\-_:\[\]]+$/.test(s);
}

// ---------- шаблон пути ----------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE = /^[0-9a-f]{12,}$/i;
const TOKEN_CHARS = /^[A-Za-z0-9_\-.~%=+]+$/;

function segKind(seg) {
  if (!seg) return null;
  let s = seg;
  try { s = decodeURIComponent(seg); } catch (_) { s = seg; }
  if (/^\d+$/.test(s)) return '{id}';
  if (UUID_RE.test(s)) return '{uuid}';
  if (HEX_RE.test(s) && /\d/.test(s) && /[a-f]/i.test(s)) return '{hash}';
  if (looksToken(s)) return '{token}';
  return null;
}

// Длинная строка из букв и цифр без слов-разделителей — токен, ключ, подпись.
function looksToken(s) {
  s = String(s || '');
  if (s.length < 20 || !TOKEN_CHARS.test(s)) return /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/.test(s);
  if (/^eyJ/.test(s)) return true;
  // имена из коротких слов через дефис/точку (settings-front-v2-ru.json.hash) — не токен
  if (s.split(/[-_.~]+/).every((part) => part.length <= 12)) return false;
  const digits = (s.match(/\d/g) || []).length;
  const letters = (s.match(/[A-Za-z]/g) || []).length;
  if (!digits || !letters) return s.length >= 32 && !/[-_.]/.test(s);
  // слова через дефис (u-search-exact-match-v2) — не токен
  if (/^[a-z]+([-_][a-z0-9]+)+$/i.test(s) && digits < 4) return false;
  return digits >= 3 || s.length >= 28;
}

function pathTemplate(pathname) {
  const segs = String(pathname || '/').split('/');
  const out = segs.map((seg) => segKind(seg) || clip(seg, 60));
  let p = out.join('/');
  if (p.length > 300) p = p.slice(0, 300) + '…';
  return p || '/';
}

// ---------- query ----------
const SECRET_NAME_RE = /(^|[_\-.])(token|access[_-]?token|refresh|key|api[_-]?key|apikey|secret|sig|sign|signature|auth|authorization|session|sess|sid|password|passwd|pass|pwd|nonce|jwt|ticket|csrf|xsrf|credential|hmac|otp|code)($|[_\-.])|token|secret|signature|password|apikey|api_key|sessionid|csrf|xsrf|jwt/i;

function maskedValue(v) { return '‹hidden ' + String(v).length + ' chars›'; }

function isSecretParam(name, value) {
  return SECRET_NAME_RE.test(String(name || '')) || looksToken(value);
}

function valueType(v) {
  if (v === '') return 'empty';
  if (/^-?\d+(\.\d+)?$/.test(v)) return 'number';
  if (/^(true|false)$/i.test(v)) return 'bool';
  return 'string';
}

// Обновить описание query-параметров эндпоинта по одному адресу.
function mergeQuery(q, searchParams, limitParams = 40) {
  const seen = new Set();
  for (const [name0, value0] of searchParams) {
    const name = clip(name0, 60);
    if (seen.has(name)) continue;
    seen.add(name);
    let p = q[name];
    if (!p) {
      if (Object.keys(q).length >= limitParams) continue;
      p = q[name] = { n: 0, ex: [], varies: false, type: '', masked: false };
    }
    p.n++;
    const value = String(value0);
    const secret = isSecretParam(name, value);
    if (secret) p.masked = true;
    const t = valueType(value);
    p.type = !p.type ? t : (p.type === t ? p.type : (p.type === 'empty' ? t : (t === 'empty' ? p.type : 'string')));
    const shown = secret ? maskedValue(value) : clip(value, EXAMPLE_LEN);
    // меняется ли значение: сравниваем отпечаток полного значения, а не обрезанный пример
    const fp = hashStr(value);
    if (p.fp == null) p.fp = fp;
    else if (p.fp !== fp) p.varies = true;
    if (p.masked) p.ex = p.ex.filter((x) => /^‹hidden/.test(x));
    if (!p.ex.includes(shown)) {
      p.ex.unshift(shown);
      if (p.ex.length > 3) p.ex.length = 3;
    } else if (p.ex[0] !== shown) {
      p.ex.splice(p.ex.indexOf(shown), 1);
      p.ex.unshift(shown);
    }
  }
  return q;
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

// ---------- заголовки ----------
const STD_HEADERS = new Set([
  'accept', 'accept-encoding', 'accept-language', 'cache-control', 'connection', 'content-length', 'content-type', 'cookie',
  'dnt', 'host', 'origin', 'pragma', 'referer', 'referrer-policy', 'te', 'upgrade-insecure-requests', 'user-agent', 'priority',
  'if-none-match', 'if-modified-since', 'if-match', 'if-unmodified-since', 'if-range', 'range', 'keep-alive', 'purpose',
  'x-client-data', 'expect', 'trailer', 'transfer-encoding', 'via', 'save-data', 'device-memory', 'downlink', 'ect', 'rtt', 'viewport-width', 'dpr', 'width',
]);
const AUTHISH_RE = /token|auth|session|csrf|xsrf|api-?key|secret|signature|jwt|bearer|credential|device-?id|deviceid/i;

function headerNames(headers) {
  const out = [];
  for (const k of Object.keys(headers || {})) {
    const n = String(k).toLowerCase().trim();
    if (!n || n.startsWith(':') || n.startsWith('sec-') || STD_HEADERS.has(n)) continue;
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]{1,80}$/.test(n)) continue;
    out.push(n);
    if (out.length >= 24) break;
  }
  return out;
}

// cookie / bearer / токен в заголовке. Значения не сохраняются — только факт и имена.
function authOf(headers) {
  const r = { cookie: false, bearer: false, basic: false, headers: [] };
  for (const [k, v] of Object.entries(headers || {})) {
    const n = String(k).toLowerCase();
    if (n.startsWith(':')) continue; // псевдозаголовки HTTP/2 (:authority, :path)
    if (n === 'cookie' && String(v || '').trim()) r.cookie = true;
    else if (n === 'authorization') {
      const s = String(v || '').trim();
      if (/^bearer\s/i.test(s)) r.bearer = true;
      else if (/^basic\s/i.test(s)) r.basic = true;
      else if (s) r.headers.push('authorization');
    } else if (!STD_HEADERS.has(n) && !n.startsWith('sec-') && AUTHISH_RE.test(n)) r.headers.push(n);
  }
  return r;
}

function authText(a) {
  if (!a) return '';
  const parts = [];
  if (a.cookie) parts.push('cookie');
  if (a.bearer) parts.push('bearer');
  if (a.basic) parts.push('basic');
  for (const h of Object.keys(a.headers || {}).sort((x, y) => a.headers[y] - a.headers[x]).slice(0, 4)) parts.push(h);
  return parts.join(' + ');
}

// ---------- схема JSON ----------
function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return t;
  return t === 'object' ? 'object' : 'unknown';
}

const ID_KEY_RE = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,})$/i;

function infer(v, depth = 0) {
  const t = typeOf(v);
  const node = { t: [t], p: 1 };
  if (t === 'array') {
    let item = null;
    const n = Math.min(v.length, ARRAY_SAMPLE);
    for (let i = 0; i < n; i++) item = item ? merge(item, infer(v[i], depth + 1), depth + 1) : infer(v[i], depth + 1);
    if (item) node.i = item;
    if (depth >= MAX_DEPTH) { delete node.i; node.deep = 1; }
  } else if (t === 'object') {
    node.c = 1;
    if (depth >= MAX_DEPTH) { node.deep = 1; return node; }
    const keys = Object.keys(v);
    if (keys.length >= 8 && keys.filter((k) => ID_KEY_RE.test(k)).length >= keys.length * 0.8) {
      // словарь вида {"123": {...}, "456": {...}} — одна схема значения
      let m = null;
      for (const k of keys.slice(0, ARRAY_SAMPLE)) m = m ? merge(m, infer(v[k], depth + 1), depth + 1) : infer(v[k], depth + 1);
      node.map = m;
      return node;
    }
    node.k = {};
    let more = 0;
    for (const k of keys) {
      if (Object.keys(node.k).length >= MAX_KEYS) { more++; continue; }
      node.k[clip(k, 80)] = infer(v[k], depth + 1);
    }
    if (more) node.more = more;
  }
  return node;
}

function merge(a, b, depth = 0) {
  if (!a) return b;
  if (!b) return a;
  const out = a;
  for (const t of b.t) if (!out.t.includes(t)) out.t.push(t);
  out.p = (out.p || 0) + (b.p || 0);
  if (b.deep) out.deep = 1;
  if (b.i) out.i = out.i ? merge(out.i, b.i, depth + 1) : b.i;
  if (b.c) out.c = (out.c || 0) + b.c;
  if (b.map || out.map) {
    let m = out.map || null;
    if (b.map) m = m ? merge(m, b.map, depth + 1) : b.map;
    // объект, который раньше был со своими ключами, а теперь словарь — сливаем значения ключей в словарь
    if (out.k) { for (const k of Object.keys(out.k)) m = merge(m, out.k[k], depth + 1); delete out.k; }
    if (b.k) for (const k of Object.keys(b.k)) m = merge(m, b.k[k], depth + 1);
    out.map = m;
  } else if (b.k) {
    if (!out.k) out.k = {};
    for (const k of Object.keys(b.k)) {
      if (out.k[k]) out.k[k] = merge(out.k[k], b.k[k], depth + 1);
      else if (Object.keys(out.k).length < MAX_KEYS) out.k[k] = b.k[k];
      else out.more = (out.more || 0) + 1;
    }
  }
  if (b.more) out.more = Math.max(out.more || 0, b.more);
  return out;
}

function schemaFrom(value) { return infer(value, 0); }

const SCALAR = { string: 'string', number: 'number', boolean: 'boolean', null: 'null', unknown: 'unknown' };
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// TS-подобная запись: { data: { products: Array<{ id: number; name?: string | null }> } }
function render(node, opts = {}) {
  const indent = opts.indent == null ? '  ' : opts.indent;
  const maxChars = opts.maxChars || 8000;
  let out = '';
  let cut = false;
  function typeText(n, lvl) {
    if (!n) return 'unknown';
    const parts = [];
    for (const t of n.t) {
      if (t === 'object') parts.push(objText(n, lvl));
      else if (t === 'array') parts.push(arrText(n, lvl));
      else parts.push(SCALAR[t] || t);
    }
    return parts.length ? parts.join(' | ') : 'unknown';
  }
  function arrText(n, lvl) {
    if (n.deep) return 'unknown[] /* depth limit */';
    if (!n.i) return 'unknown[] /* only empty arrays seen */';
    const inner = typeText(n.i, lvl);
    return /^[a-z]+$/.test(inner) ? inner + '[]' : 'Array<' + inner + '>';
  }
  function objText(n, lvl) {
    if (n.deep) return 'object /* depth limit */';
    if (n.map) return 'Record<string, ' + typeText(n.map, lvl) + '>';
    const keys = n.k ? Object.keys(n.k) : [];
    if (!keys.length) return n.more ? '{ /* ' + n.more + ' keys */ }' : '{}';
    const pad = indent.repeat(lvl + 1);
    const lines = keys.map((k) => {
      const ch = n.k[k];
      const opt = n.c && (ch.p || 0) < n.c ? '?' : '';
      return pad + (IDENT_RE.test(k) ? k : JSON.stringify(k)) + opt + ': ' + typeText(ch, lvl + 1) + ';';
    });
    if (n.more) lines.push(pad + '/* +' + n.more + ' more keys */');
    if (!indent) return '{ ' + lines.map((l) => l.trim()).join(' ') + ' }';
    return '{\n' + lines.join('\n') + '\n' + indent.repeat(lvl) + '}';
  }
  out = typeText(node, 0);
  if (out.length > maxChars) { out = out.slice(0, maxChars); cut = true; }
  return cut ? out + '\n/* …truncated */' : out;
}

// Пример тела по схеме (для подсказки page_fetch): пустые значения нужных типов.
function skeleton(node, depth = 0) {
  if (!node || depth > MAX_DEPTH) return null;
  const t = node.t.find((x) => x !== 'null') || node.t[0];
  if (t === 'string') return '';
  if (t === 'number') return 0;
  if (t === 'boolean') return false;
  if (t === 'array') return node.i ? [skeleton(node.i, depth + 1)] : [];
  if (t === 'object') {
    if (node.map) return {};
    const o = {};
    for (const k of Object.keys(node.k || {})) {
      if (node.c && (node.k[k].p || 0) < node.c) continue; // необязательные пропускаем
      o[k] = skeleton(node.k[k], depth + 1);
    }
    return o;
  }
  return null;
}

module.exports = {
  siteOf, siteFile, validSite, pathTemplate, segKind, looksToken, mergeQuery, isSecretParam, maskedValue,
  headerNames, authOf, authText, schemaFrom, merge, render, skeleton, clip, hashStr,
  LIMITS: { MAX_DEPTH, MAX_KEYS, EXAMPLE_LEN },
};
