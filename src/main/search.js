'use strict';
// Разбор ввода адресной строки (ARCHITECTURE §3): адрес, внутренняя страница, бэнг или поиск; базовые подсказки.

const ENGINES = {
  google: { name: 'Google', url: 'https://www.google.com/search?q={q}' },
  yandex: { name: 'Яндекс', url: 'https://yandex.ru/search/?text={q}' },
  ddg: { name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q={q}' },
  bing: { name: 'Bing', url: 'https://www.bing.com/search?q={q}' },
};

const SCHEME_RE = /^(https?|kosmo|file|about|view-source|data|chrome|chrome-extension|devtools|ftp|ws|wss|mailto):/i;
// Похоже на имя файла, а не на домен (node.js, readme.md…).
const FILE_EXT = new Set(['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'md', 'txt', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'cs', 'cpp', 'h', 'c',
  'html', 'htm', 'css', 'scss', 'less', 'vue', 'svelte', 'php', 'sh', 'ps1', 'bat', 'exe', 'dll', 'zip', 'rar', '7z', 'png', 'jpg', 'jpeg', 'gif',
  'svg', 'webp', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'yml', 'yaml', 'toml', 'ini', 'log', 'lock', 'map', 'wasm', 'mp3', 'mp4', 'mov']);

function fill(tpl, q) { return tpl.split('{q}').join(encodeURIComponent(q)); }

function isIPv4(host) {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return !!m && m.slice(1).every((x) => Number(x) <= 255);
}

// Хост[:порт][/путь] без схемы → схема или null.
function guessUrl(s) {
  if (/\s/.test(s)) return null;
  const m = s.match(/^([^/?#]+)([/?#].*)?$/);
  if (!m) return null;
  const hostPort = m[1];
  const rest = m[2] || '';
  if (hostPort.includes('@')) return null; // почта или учётные данные — ищем
  const hp = hostPort.match(/^(\[[0-9a-f:.]+\]|[^:]+)(?::(\d{1,5}))?$/i);
  if (!hp) return null;
  const host = hp[1].toLowerCase();
  const port = hp[2];
  if (host === 'localhost' || host.endsWith('.localhost')) return 'http://' + s;
  if (isIPv4(host) || host.startsWith('[')) return 'http://' + s;
  if (port && /^[a-z0-9-]+$/i.test(host)) return 'http://' + s; // myhost:8080
  if (!host.includes('.') || host.startsWith('.') || host.endsWith('.') || host.includes('..')) return null;
  const labels = host.split('.');
  if (!labels.every((l) => /^[\p{L}\p{N}-]+$/u.test(l) && !l.startsWith('-') && !l.endsWith('-'))) return null;
  const tld = labels[labels.length - 1];
  if (!/^(\p{L}{2,63}|xn--[a-z0-9-]+)$/iu.test(tld)) return null;
  // node.js — файл, а не сайт; но node.js/docs или с портом — адрес.
  if (FILE_EXT.has(tld) && !rest && !port) return null;
  return 'https://' + s;
}

function createSearch(ctx) {
  const providers = [];

  // Бэнги — слои «пользователь > пак > ядро»: settings.search.bangs (там же общие бэнги ядра) поверх бэнгов
  // включённых паков (ctx.packs.bangs(), без скрытых пользователем). Ключ пользователя перекрывает ключ пака.
  function bangs() {
    const b = ctx.settings.peek('search.bangs');
    const own = Array.isArray(b) ? b : [];
    let fromPacks = [];
    try { fromPacks = ctx.packs ? ctx.packs.bangs() : []; } catch (_) { fromPacks = []; }
    if (!fromPacks.length) return own;
    const keys = new Set(own.map((x) => x.key));
    return own.concat(fromPacks.filter((x) => !keys.has(x.key)));
  }

  function engine() {
    const id = ctx.settings.peek('search.engine');
    return Object.assign({ id: ENGINES[id] ? id : 'google' }, ENGINES[id] || ENGINES.google);
  }

  function searchUrl(q) { return fill(engine().url, q); }

  function findBang(key) {
    const k = String(key || '').toLowerCase();
    return bangs().find((b) => b.key === k) || null;
  }

  function bangUrl(b, q) {
    if (!q) {
      try { return new URL(b.url.replace('{q}', '')).origin + '/'; } catch (_) { return fill(b.url, ''); }
    }
    if (b.numericUrl && /^\d+$/.test(q)) return fill(b.numericUrl, q);
    return fill(b.url, q);
  }

  function resolve(input) {
    const s = String(input == null ? '' : input).trim();
    if (!s) return { url: 'kosmo://newtab/', kind: 'internal' };
    if (/^about:blank$/i.test(s)) return { url: 'about:blank', kind: 'url' };
    if (SCHEME_RE.test(s)) {
      try {
        const u = new URL(s);
        if (u.protocol === 'kosmo:') return { url: u.pathname ? u.href : u.href + '/', kind: 'internal' };
        return { url: u.href, kind: 'url' };
      } catch (_) { /* не адрес — поиск ниже */ }
    }
    // Бэнг: «gh electron», «!g запрос», «<ключ> 123456» (числовой адрес бэнга, если есть).
    const m = s.match(/^!?(\S+)(?:\s+([\s\S]*))?$/);
    if (m) {
      const b = findBang(m[1]);
      if (b && (m[2] !== undefined || s.startsWith('!'))) {
        const q = (m[2] || '').trim();
        return { url: bangUrl(b, q), kind: 'bang', bang: b.key, query: q };
      }
    }
    const guessed = guessUrl(s);
    if (guessed) {
      try { return { url: new URL(guessed).href, kind: 'url' }; } catch (_) { /* поиск */ }
    }
    return { url: searchUrl(s), kind: 'search', query: s };
  }

  function addSuggestProvider(fn) {
    if (typeof fn !== 'function') throw new Error('addSuggestProvider: нужна функция');
    providers.push(fn);
    return () => { const i = providers.indexOf(fn); if (i >= 0) providers.splice(i, 1); };
  }

  function withTimeout(p, ms) {
    return Promise.race([Promise.resolve(p), new Promise((r) => setTimeout(() => r([]), ms))]);
  }

  async function suggest(input) {
    const s = String(input == null ? '' : input);
    const q = s.trim();
    const items = [];
    if (!q) return items;
    const r = resolve(q);
    const go = { type: r.kind === 'search' ? 'search' : r.kind === 'bang' ? 'bang' : 'url', title: q, url: r.url, kind: r.kind, score: 1000 };
    if (r.kind === 'search') go.subtitle = 'Поиск в ' + engine().name;
    else if (r.kind === 'bang') { const b = findBang(r.bang); go.subtitle = b ? (r.query ? 'Поиск в ' + b.name : b.name) : ''; go.bang = r.bang; }
    items.push(go);

    // Бэнги по началу ключа (пока введено одно слово).
    if (!/\s/.test(q) && r.kind !== 'bang') {
      const k = q.replace(/^!/, '').toLowerCase();
      for (const b of bangs()) {
        if (b.key.startsWith(k) && items.filter((i) => i.type === 'bang').length < 3) {
          items.push({ type: 'bang', title: b.key + ' — ' + b.name, subtitle: 'Бэнг: ' + b.key + ' <запрос>', bang: b.key, insert: b.key + ' ', url: bangUrl(b, ''), score: 600 });
        }
      }
    }

    // Открытые вкладки.
    const low = q.toLowerCase();
    let n = 0;
    for (const t of ctx.tabs ? ctx.tabs.list() : []) {
      if (n >= 3) break;
      if (t.active) continue;
      const hay = (t.title + ' ' + t.url).toLowerCase();
      if (hay.includes(low)) {
        items.push({ type: 'tab', title: t.title || t.url, subtitle: 'Перейти на вкладку', url: t.url, tabId: t.id, favicon: t.favicon, score: 700 });
        n++;
      }
    }

    const extra = await Promise.all(providers.map((fn) => withTimeout((async () => fn(q, ctx))().catch((e) => {
      ctx.log('search', 'провайдер подсказок:', e && e.message);
      return [];
    }), 400)));
    for (const list of extra) if (Array.isArray(list)) for (const it of list) if (it && typeof it === 'object') items.push(it);

    // Сортировка по score (стабильная), без дублей адресов.
    const seen = new Set();
    return items
      .map((it, i) => ({ it, i }))
      .sort((a, b) => (Number(b.it.score) || 0) - (Number(a.it.score) || 0) || a.i - b.i)
      .map((x) => x.it)
      .filter((it) => {
        const key = it.type + '|' + (it.tabId || it.url || it.title);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 12);
  }

  return { resolve, suggest, addSuggestProvider, searchUrl, engine, engines: ENGINES, bangs, findBang, guessUrl };
}

function registerSearchIpc(ctx) {
  ctx.ipc.handle('kosmo:search.suggest', (p) => ctx.search.suggest(typeof p === 'string' ? p : p && p.input), { allow: ['ui', 'internal'] });
  ctx.ipc.handle('kosmo:search.resolve', (p) => ctx.search.resolve(typeof p === 'string' ? p : p && p.input), { allow: ['ui', 'internal'] });
}

module.exports = { createSearch, registerSearchIpc, guessUrl, ENGINES };
