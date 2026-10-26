'use strict';
// tools-pack: выполнение пользовательского JS во вкладке (сниппеты и служебные скрипты рентгена).
// Код оборачивается в async-функцию (работают await и return; одиночное выражение возвращается само),
// результат сериализуется в самой странице (DOM-узлы, Map/Set, циклы, большие массивы), console.* перехватывается.
// Миры: 'page' — главный мир страницы (её переменные), 'isolated' — свой изолированный мир (DOM общий, JS отдельный);
// opts.worldName — имя изолированного мира CDP (сниппеты паков: kosmolet-pack-<id>).

const vm = require('vm');

const WORLD_ID = 1818; // свой изолированный мир (999 — tab-preload, 1717 — pageFetch cdp-hub)
const FILE = 'kosmo-snippet.js';
const CODE_LIMIT = 200 * 1024;
const WEB_RE = /^(https?|file):/i;

// Рантайм внутри страницы: перехват консоли и сериализация результата. Без eval — работает при любой CSP.
const RUNTIME = `{
  fmt(x) {
    try {
      if (typeof x === 'string') return x;
      if (x === undefined) return 'undefined';
      if (typeof x === 'function') return 'ƒ ' + (x.name || '') + '()';
      if (typeof x === 'bigint') return x + 'n';
      if (x instanceof Error) return (x.name || 'Error') + ': ' + x.message;
      if (typeof Element !== 'undefined' && x instanceof Element) return this.node(x);
      const s = JSON.stringify(this.toJ(x, 0, new WeakSet(), { n: 2000 }));
      return s && s.length > 4000 ? s.slice(0, 4000) + '…' : String(s);
    } catch (e) { return String(x); }
  },
  node(n) {
    if (n.nodeType === 1) {
      let s = '<' + n.tagName.toLowerCase();
      if (n.id) s += '#' + n.id;
      const c = typeof n.className === 'string' ? n.className.trim() : '';
      if (c) s += '.' + c.split(/\\s+/).slice(0, 3).join('.');
      return s + '>';
    }
    if (n.nodeType === 3) return '#text ' + JSON.stringify(String(n.data).slice(0, 80));
    if (n.nodeType === 9) return '#document ' + (n.URL || '');
    return '#' + (n.nodeName || 'node');
  },
  toJ(v, depth, seen, budget) {
    if (--budget.n < 0) return '…';
    const t = typeof v;
    if (v === null || t === 'boolean' || t === 'string') return t === 'string' && v.length > 100000 ? v.slice(0, 100000) + '…' : v;
    if (t === 'number') return isFinite(v) ? v : String(v);
    if (t === 'undefined') return 'undefined';
    if (t === 'bigint') return v + 'n';
    if (t === 'symbol') return v.toString();
    if (t === 'function') return 'ƒ ' + (v.name || '') + '()';
    if (depth > 12) return '[…]';
    try {
      if (typeof Node !== 'undefined' && v instanceof Node) return this.node(v);
      if (typeof Window !== 'undefined' && v instanceof Window) return '[Window ' + (v === window ? location.href : '') + ']';
    } catch (e) { /* чужой мир */ }
    if (v instanceof Date) return isNaN(v) ? 'Invalid Date' : v.toISOString();
    if (v instanceof RegExp) return String(v);
    if (v instanceof Error) return { name: v.name, message: String(v.message), stack: String(v.stack || '') };
    if (typeof Promise !== 'undefined' && v instanceof Promise) return '[Promise]';
    if (seen.has(v)) return '[цикл]';
    const orig = v;
    seen.add(orig);
    try {
      if (typeof NodeList !== 'undefined' && (v instanceof NodeList || v instanceof HTMLCollection)) v = Array.from(v);
      if (v instanceof Map) { const o = {}; let i = 0; for (const [k, x] of v) { if (i++ >= 2000) { o['…'] = 'ещё ' + (v.size - 2000); break; } o[typeof k === 'string' ? k : this.fmt(k)] = this.toJ(x, depth + 1, seen, budget); } return o; }
      if (v instanceof Set) v = Array.from(v);
      if (ArrayBuffer.isView(v)) return (v.constructor && v.constructor.name || 'TypedArray') + '(' + v.length + ') ' + JSON.stringify(Array.from(v.slice ? v.slice(0, 64) : [])) + (v.length > 64 ? '…' : '');
      if (v instanceof ArrayBuffer) return 'ArrayBuffer(' + v.byteLength + ')';
      if (Array.isArray(v)) {
        const n = Math.min(v.length, 10000);
        const a = new Array(n);
        for (let i = 0; i < n; i++) a[i] = this.toJ(v[i], depth + 1, seen, budget);
        if (v.length > n) a.push('… ещё ' + (v.length - n));
        return a;
      }
      const o = {};
      let keys;
      try { keys = Object.keys(v); } catch (e) { return '[объект]'; }
      const n = Math.min(keys.length, 2000);
      for (let i = 0; i < n; i++) {
        const k = keys[i];
        let x;
        try { x = v[k]; } catch (e) { x = '[ошибка чтения: ' + e.message + ']'; }
        o[k] = this.toJ(x, depth + 1, seen, budget);
      }
      if (keys.length > n) o['…'] = 'ещё ' + (keys.length - n) + ' ключей';
      return o;
    } finally { seen.delete(orig); }
  },
  ser(v) {
    if (v === undefined) return { type: 'undefined' };
    if (v === null) return { type: 'null', value: null };
    const t = typeof v;
    if (t === 'string') return v.length > 3000000 ? { type: 'string', value: v.slice(0, 3000000), truncated: true } : { type: 'string', value: v };
    if (t === 'number' || t === 'boolean') return { type: t, value: t === 'number' && !isFinite(v) ? String(v) : v };
    if (t === 'bigint') return { type: 'number', value: v + 'n' };
    if (t === 'object' && typeof v.__kosmo === 'string') return { type: 'directive', value: this.toJ(v, 0, new WeakSet(), { n: 400000 }) };
    const value = this.toJ(v, 0, new WeakSet(), { n: 200000 });
    let size = 0;
    try { size = JSON.stringify(value).length; } catch (e) { size = 0; }
    if (size > 3000000) return { type: 'string', value: JSON.stringify(value).slice(0, 3000000), truncated: true };
    return { type: typeof value === 'object' && value !== null ? 'json' : typeof value, value };
  },
  capture() {
    const logs = [];
    const c = console;
    const orig = {};
    const self = this;
    for (const k of ['log', 'info', 'warn', 'error', 'debug', 'table', 'dir']) {
      orig[k] = c[k];
      c[k] = function (...a) {
        try { if (logs.length < 300) logs.push({ level: k === 'table' || k === 'dir' ? 'log' : k, text: a.map((x) => self.fmt(x)).join(' ').slice(0, 20000) }); } catch (e) { /* молча */ }
        try { return orig[k].apply(c, a); } catch (e) { return undefined; }
      };
    }
    return { logs, restore() { for (const k in orig) c[k] = orig[k]; } };
  },
  done(ok, v, cap, t0) {
    cap.restore();
    const ms = Math.round((performance.now() - t0) * 10) / 10;
    if (!ok) {
      const isObj = v !== null && typeof v === 'object';
      return { ok: false, ms, logs: cap.logs, error: { name: isObj && v.name ? String(v.name) : 'Ошибка', message: isObj && v.message !== undefined ? String(v.message) : this.fmt(v), stack: isObj && v.stack ? String(v.stack) : '' } };
    }
    try { return { ok: true, ms, logs: cap.logs, result: this.ser(v) }; } catch (e) {
      return { ok: false, ms, logs: cap.logs, error: { name: 'Ошибка', message: 'Результат не удалось разобрать: ' + e.message, stack: '' } };
    }
  }
}`;

function trimTrailingSemicolons(code) { return String(code).replace(/[\s;]+$/, ''); }

// Синтаксис проверяем в main (vm.Script ничего не выполняет): так видна строка ошибки, а страница с CSP без eval не мешает.
function compileCheck(body) {
  try {
    // eslint-disable-next-line no-new
    new vm.Script('(async () => {\n' + body + '\n})', { filename: FILE, lineOffset: -1 });
    return null;
  } catch (e) {
    const m = /kosmo-snippet\.js:(\d+)/.exec(String(e.stack || ''));
    let line = m ? Number(m[1]) : null;
    const total = body.split('\n').length;
    const lines = String(e.stack || '').split('\n');
    let src = lines.length > 2 ? lines.slice(1, 3).join('\n') : '';
    let where = line ? ` (строка ${line})` : '';
    // Ошибка на закрывающей скобке обёртки — не хватает скобки или кавычки в конце кода.
    if (line && line > total) { where = ' (в конце кода: не закрыта скобка или кавычка?)'; src = ''; line = total; }
    return { name: e.name || 'SyntaxError', message: e.message + where, stack: src, line };
  }
}

// Код → тело async-функции. Одиночное выражение (без return и инструкций) возвращается само, как в консоли.
function prepare(code) {
  const src = String(code == null ? '' : code);
  if (src.length > CODE_LIMIT) return { error: { name: 'Ошибка', message: 'Код длиннее 200 КБ' } };
  if (!src.trim()) return { error: { name: 'Ошибка', message: 'Пустой код' } };
  const expr = trimTrailingSemicolons(src);
  if (expr && !/^\s*[{]/.test(expr) && !compileCheck('return (' + expr + '\n);')) return { body: 'return (' + expr + '\n);', expression: true };
  const err = compileCheck(src);
  if (err) return { error: err };
  return { body: src, expression: false };
}

function buildScript(body) {
  const prefix = '(async () => {\n' +
    'const __kosmoRT = ' + RUNTIME + ';\n' +
    'const __kosmoCap = __kosmoRT.capture();\n' +
    'const __kosmoT0 = performance.now();\n' +
    'try {\n' +
    'const __kosmoV = await (async () => {\n';
  const suffix = '\n})();\n' +
    'return __kosmoRT.done(true, __kosmoV, __kosmoCap, __kosmoT0);\n' +
    '} catch (__kosmoE) {\n' +
    'return __kosmoRT.done(false, __kosmoE, __kosmoCap, __kosmoT0);\n' +
    '}\n' +
    '})()\n//# sourceURL=' + FILE + '\n';
  const offset = prefix.split('\n').length - 1;
  return { script: prefix + body + suffix, offset };
}

// Номера строк в стеке — к строкам пользовательского кода; служебные кадры обёртки убираем.
function mapStack(stack, offset, bodyLines) {
  if (!stack) return '';
  const out = [];
  for (const line of String(stack).split('\n')) {
    if (!line.includes(FILE)) { out.push(line); continue; }
    const m = new RegExp(FILE.replace('.', '\\.') + ':(\\d+):(\\d+)').exec(line);
    if (!m) { out.push(line); continue; }
    const l = Number(m[1]) - offset;
    if (l < 1 || l > bodyLines) continue;
    out.push(line.replace(m[0], `сниппет:${l}:${m[2]}`).replace(/\s*\(?(async )?__kosmo\w*\)?/, ''));
  }
  return out.join('\n').trim();
}

function withTimeout(p, ms, label) {
  let t;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label || `нет ответа за ${Math.round(ms / 1000)} с`)), ms); }),
  ]);
}

function isWebUrl(url) { return WEB_RE.test(String(url || '')); }

// Выполнение через CDP (ctx.cdp.evalInWorld, подключает tools-pack.js): webContents.executeJavaScript* в Electron
// ждёт конца загрузки страницы — на «вечно грузящихся» страницах сниппет и рентген висели. Запасной путь — Electron.
let getCdp = null;
function useCdp(fn) { getCdp = typeof fn === 'function' ? fn : null; }
async function exec(tab, code, o) {
  const cdp = o.cdp !== false && getCdp && getCdp();
  if (cdp && typeof cdp.evalInWorld === 'function') {
    try {
      return await cdp.evalInWorld(tab.id, code, { world: o.world === 'page' ? 'page' : (o.worldName || 'kosmolet-snippet'), userGesture: !!o.userGesture, timeoutMs: o.timeoutMs, timeoutText: o.timeoutText });
    } catch (e) {
      if (!/отладчик|debugger|attach|выгружена|не найдена|нет основного фрейма/i.test(String(e && e.message))) throw e;
    }
  }
  const wc = tab.wc;
  const p = o.world === 'page'
    ? wc.executeJavaScript(code, !!o.userGesture)
    : wc.executeJavaScriptInIsolatedWorld(WORLD_ID, [o.url ? { code, url: o.url } : { code }], !!o.userGesture);
  return withTimeout(Promise.resolve(p), o.timeoutMs, o.timeoutText);
}

// Выполнить код во вкладке. → {ok, ms, logs, result?, error?, world, url, expression}
async function runInTab(tab, code, opts = {}) {
  const world = opts.world === 'page' ? 'page' : 'isolated';
  const wc = tab && tab.wc;
  if (!wc || wc.isDestroyed()) return { ok: false, world, error: { name: 'Ошибка', message: 'Вкладка выгружена — откройте её, чтобы она загрузилась' } };
  const url = wc.getURL();
  if (!isWebUrl(url)) return { ok: false, world, url, error: { name: 'Ошибка', message: 'Сниппеты работают на сайтах (http, https, file), а не на служебных страницах' } };
  const prep = prepare(code);
  if (prep.error) return { ok: false, world, url, error: prep.error, syntax: true };
  const { script, offset } = buildScript(prep.body);
  const bodyLines = prep.body.split('\n').length;
  const t0 = Date.now();
  let r;
  try {
    r = await exec(tab, script, {
      world, worldName: opts.worldName, url: FILE, userGesture: opts.userGesture !== false, timeoutMs: opts.timeoutMs || 60000, cdp: opts.cdp,
      timeoutText: opts.timeoutMs ? `нет ответа за ${Math.round(opts.timeoutMs / 1000)} с — код продолжает работать на странице` : 'нет ответа за 60 с — код продолжает работать на странице',
    });
  } catch (e) {
    return { ok: false, world, url, ms: Date.now() - t0, error: { name: 'Ошибка', message: String(e && e.message || e).replace(/^Error: /, '') } };
  }
  if (!r || typeof r !== 'object') return { ok: false, world, url, ms: Date.now() - t0, error: { name: 'Ошибка', message: 'Страница не вернула ответ (возможно, она перезагрузилась)' } };
  const out = { ok: !!r.ok, world, url, ms: r.ms, totalMs: Date.now() - t0, logs: Array.isArray(r.logs) ? r.logs : [], expression: prep.expression };
  if (r.ok) out.result = r.result;
  else out.error = { name: r.error && r.error.name, message: r.error && r.error.message, stack: mapStack(r.error && r.error.stack, offset, bodyLines) };
  return out;
}

// Служебный скрипт (рентген): без обёртки сниппета, результат — как есть (должен быть сериализуемым).
async function evalRaw(tab, code, opts = {}) {
  const wc = tab && tab.wc;
  if (!wc || wc.isDestroyed()) throw new Error('вкладка выгружена');
  const ms = opts.timeoutMs || 15000;
  return exec(tab, code, { world: opts.world === 'page' ? 'page' : 'isolated', userGesture: false, timeoutMs: ms, timeoutText: `нет ответа за ${Math.round(ms / 1000)} с` });
}

module.exports = { runInTab, evalRaw, prepare, buildScript, mapStack, isWebUrl, useCdp, WORLD_ID, CODE_LIMIT };
