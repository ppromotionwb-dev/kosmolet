'use strict';
// Журнал действий Claude (claude-bridge): последние 500 вызовов → userData/claude-activity.json + событие kosmo:bridge.activity.
// Запись: {ts, tool, args (обрезанно, без секретов), tabId, ok, ms, error?, by?: 'claude'|'user', note?}.

const LIMIT = 500;
const SECRET_KEY = /token|password|passwd|secret|authorization|cookie|api[-_]?key|session/i;

function clipStr(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Аргументы для журнала: строки обрезаны, секретные ключи скрыты, вложенность ограничена.
function sanitize(v, depth = 0, key = '') {
  if (key && SECRET_KEY.test(key)) return v == null || v === '' ? v : '•••';
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return clipStr(v, key === 'code' ? 300 : 200);
  if (depth >= 3) return '…';
  if (Array.isArray(v)) return v.slice(0, 10).map((x) => sanitize(x, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    let n = 0;
    for (const [k, x] of Object.entries(v)) {
      if (n++ >= 20) { out['…'] = '…'; break; }
      out[k] = sanitize(x, depth + 1, k);
    }
    return out;
  }
  return String(v);
}

function createActivity(ctx) {
  let store = null;
  let entries = null;
  let calls = 0;
  let lastCallAt = 0;

  function load() {
    if (entries) return entries;
    store = ctx.store('claude-activity', { entries: [] }, { debounceMs: 1500, pretty: false });
    const d = store.get();
    entries = Array.isArray(d && d.entries) ? d.entries.slice(-LIMIT) : [];
    const last = entries.length ? entries[entries.length - 1] : null;
    if (last && last.by !== 'user') lastCallAt = last.ts || 0;
    return entries;
  }

  function add(entry) {
    load();
    const e = Object.assign({ ts: Date.now() }, entry);
    if (e.args !== undefined) e.args = sanitize(e.args);
    if (e.error) e.error = clipStr(e.error, 500);
    entries.push(e);
    if (entries.length > LIMIT) entries.splice(0, entries.length - LIMIT);
    if (e.by !== 'user') { calls++; lastCallAt = e.ts; }
    store.set({ entries });
    ctx.broadcast('kosmo:bridge.activity', { entry: e });
    return e;
  }

  function list(limit) {
    load();
    const n = Math.max(1, Math.min(LIMIT, Number(limit) || 100));
    return entries.slice(-n);
  }

  function clear() {
    load();
    entries.length = 0;
    store.set({ entries });
    ctx.broadcast('kosmo:bridge.activity', { cleared: true });
    return true;
  }

  return {
    add, list, clear, sanitize,
    get calls() { return calls; },
    get lastCallAt() { load(); return lastCallAt; },
  };
}

module.exports = { createActivity, sanitize };
