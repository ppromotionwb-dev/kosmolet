'use strict';
// Настройки: схема и дефолты (ARCHITECTURE §11), миграции, валидация типов, set по пути, рассылка изменений.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { clone, isPlainObject } = require('./store');

const VERSION = 2;

// Общие бэнги ядра (без сайтов-магазинов: сайтовые приходят из паков, слой «пользователь > пак > ядро»).
// chip — показывать быстрой кнопкой на новой вкладке.
const DEFAULT_BANGS = [
  { key: 'g', name: 'Google', url: 'https://www.google.com/search?q={q}' },
  { key: 'я', name: 'Яндекс', url: 'https://yandex.ru/search/?text={q}' },
  { key: 'ya', name: 'Яндекс', url: 'https://yandex.ru/search/?text={q}' },
  { key: 'ddg', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q={q}' },
  { key: 'gh', name: 'GitHub', url: 'https://github.com/search?q={q}&type=repositories', chip: true },
  { key: 'npm', name: 'npm', url: 'https://www.npmjs.com/search?q={q}' },
  { key: 'mdn', name: 'MDN', url: 'https://developer.mozilla.org/ru/search?q={q}' },
  { key: 'so', name: 'Stack Overflow', url: 'https://stackoverflow.com/search?q={q}' },
  { key: 'yt', name: 'YouTube', url: 'https://www.youtube.com/results?search_query={q}' },
  { key: 'tr', name: 'Переводчик', url: 'https://translate.yandex.ru/?text={q}' },
];

const DEFAULTS = {
  version: VERSION,
  ui: {
    theme: 'cosmos', accent: '#7c6cff', density: 'normal', fontSize: 13, showBookmarksBar: true,
    panelWidth: 460, panelTool: 'devtools',
    custom: { bg: '#12141c', surface: '#1e2130', text: '#e5e7f0' },
  },
  siteThemes: {
    mode: 'list',
    defaults: { engine: 'dynamic', brightness: 100, contrast: 100, sepia: 0, grayscale: 0, bg: '#14161c', text: '#e6e6ea' },
    sites: {},
  },
  search: { engine: 'google', bangs: DEFAULT_BANGS },
  containers: [{ id: 'main', name: 'Основной', color: '#7c6cff' }],
  privacy: {
    adblock: true,
    adblockAllow: ['localhost'], // + исключения из паков (нижний слой, см. ctx.packs.layer)
    userAgent: 'chrome', customUA: '',
    isolateNewTabs: false, // Ctrl+T и «+» открывают изолированную вкладку (свой временный контейнер)
  },
  performance: { discardAfterMin: 30, restoreSession: true },
  downloads: { dir: '', ask: false },
  claude: {
    mcpEnabled: true, mcpPort: 47321, token: '', access: 'full',
    inboxDir: '', terminalCwd: '', claudeCommand: 'claude',
  },
  // capture: scoped — подробно только на хостах захвата паков и во вкладке «Сеть и API», остальное — лёгкий режим API.
  // Порт удалённой отладки в настройках не хранится: только флаг запуска --cdp-port / --remote-debugging-port.
  devtools: { capture: 'scoped', maxEntries: 1500 },
  sitePermissions: {},
};

const ENUMS = {
  'ui.theme': ['cosmos', 'graphite', 'light', 'terminal', 'custom'],
  'ui.density': ['compact', 'normal'],
  'siteThemes.mode': ['off', 'all', 'list'],
  'siteThemes.defaults.engine': ['dynamic', 'filter'],
  'search.engine': ['google', 'yandex', 'ddg', 'bing'],
  'privacy.userAgent': ['chrome', 'custom'],
  'claude.access': ['off', 'read', 'full'],
  'devtools.capture': ['off', 'scoped', 'api', 'all'],
};

const RANGES = {
  'ui.fontSize': [10, 20],
  'ui.panelWidth': [240, 10000],
  'siteThemes.defaults.brightness': [0, 200],
  'siteThemes.defaults.contrast': [0, 200],
  'siteThemes.defaults.sepia': [0, 100],
  'siteThemes.defaults.grayscale': [0, 100],
  'performance.discardAfterMin': [0, 1440],
  'claude.mcpPort': [1024, 65535],
  'devtools.maxEntries': [100, 100000],
};

// Ветки-словари: ключи произвольные (домены, origin'ы), значения — любые JSON.
const MAPS = new Set(['siteThemes.sites', 'sitePermissions']);

// Особые валидаторы массивов.
const ARRAY_VALIDATORS = {
  'search.bangs': (arr) => arr.map((b) => {
    if (!isPlainObject(b)) throw new Error('бэнг должен быть объектом');
    const key = String(b.key || '').trim().toLowerCase();
    if (!key || /\s/.test(key) || key.length > 24) throw new Error('неверный ключ бэнга: ' + b.key);
    const url = String(b.url || '');
    if (!/^https?:\/\//i.test(url) || !url.includes('{q}')) throw new Error(`бэнг ${key}: url должен быть http(s) и содержать {q}`);
    const out = Object.assign({}, b, { key, name: String(b.name || key), url });
    if (b.numericUrl) {
      if (!/^https?:\/\//i.test(b.numericUrl) || !String(b.numericUrl).includes('{q}')) throw new Error(`бэнг ${key}: numericUrl должен содержать {q}`);
      out.numericUrl = String(b.numericUrl);
    } else delete out.numericUrl;
    return out;
  }),
  'containers': (arr) => {
    const seen = new Set();
    const out = arr.map((c) => {
      if (!isPlainObject(c)) throw new Error('контейнер должен быть объектом');
      const id = String(c.id || '');
      if (!/^[a-z0-9_-]{1,40}$/i.test(id)) throw new Error('неверный id контейнера: ' + id);
      if (seen.has(id)) throw new Error('повтор id контейнера: ' + id);
      seen.add(id);
      const o = Object.assign({}, c, { id, name: String(c.name || id), color: String(c.color || '#7c6cff') });
      // temp — временный контейнер изолированной вкладки (удаляется с последней вкладкой); основной — никогда
      if (o.temp && id !== 'main') o.temp = true; else delete o.temp;
      return o;
    });
    if (!seen.has('main')) out.unshift(clone(DEFAULTS.containers[0]));
    return out;
  },
  'privacy.adblockAllow': (arr) => arr.map((s) => String(s).trim()).filter(Boolean),
};

// Строки, которые попадают в запуск программ и открытие путей (SEC-1): проверяем содержимое, а не только тип.
const CMD_META_RE = /["`&|<>^%;\r\n\t\0]/;
function statOf(p) { try { return fs.statSync(p); } catch (_) { return null; } }
// '' (по умолчанию) или абсолютный путь к папке; существующий файл не годится (иначе «открыть папку» запустит его).
function dirOrEmpty(v, p) {
  const s = v.trim();
  if (!s) return '';
  if (/[\0\r\n<>"|?*]/.test(s.replace(/^[a-z]:/i, ''))) throw new Error(`${p}: недопустимые символы в пути`);
  if (!path.isAbsolute(s)) throw new Error(`${p}: нужен полный путь к папке`);
  const st = statOf(s);
  if (st && !st.isDirectory()) throw new Error(`${p}: это файл, а нужна папка`);
  return s;
}
const STRING_VALIDATORS = {
  // Имя команды claude (без аргументов) или полный путь к существующему файлу; без спецсимволов оболочки.
  'claude.claudeCommand': (v, p) => {
    const s = v.trim();
    if (!s) return 'claude';
    if (CMD_META_RE.test(s)) throw new Error(`${p}: недопустимые символы в команде`);
    if (path.isAbsolute(s)) {
      const st = statOf(s);
      if (!st || !st.isFile()) throw new Error(`${p}: файл не найден`);
      return s;
    }
    if (!/^claude[\w.-]{0,60}$/i.test(s)) throw new Error(`${p}: укажите claude или полный путь к Claude Code`);
    return s;
  },
  'claude.inboxDir': dirOrEmpty,
  'claude.terminalCwd': dirOrEmpty,
  'downloads.dir': dirOrEmpty,
};

function splitPath(p) {
  if (Array.isArray(p)) return p.map(String);
  if (p == null || p === '') return [];
  return String(p).split('.');
}

function joinPath(keys) { return keys.join('.'); }

function getAt(obj, keys) {
  let cur = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}

function setAt(obj, keys, value) {
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (!isPlainObject(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

// Дозаполнить отсутствующие ключи дефолтами (не трогая словари и массивы).
function deepFill(target, defaults, prefix = '') {
  let changed = false;
  for (const [k, dv] of Object.entries(defaults)) {
    const p = prefix ? prefix + '.' + k : k;
    if (!(k in target) || target[k] === undefined) {
      target[k] = clone(dv);
      changed = true;
    } else if (isPlainObject(dv) && !MAPS.has(p)) {
      if (!isPlainObject(target[k])) { target[k] = clone(dv); changed = true; } else if (deepFill(target[k], dv, p)) changed = true;
    }
  }
  return changed;
}

function deepMergeDefaults(target, extra) {
  for (const [k, v] of Object.entries(extra)) {
    if (isPlainObject(v) && isPlainObject(target[k])) deepMergeDefaults(target[k], v);
    else if (!(k in target)) target[k] = clone(v);
  }
}

const MIGRATIONS = {
  // 1: начальная версия схемы.
  // 2: платформа паков. Порт удалённой отладки больше не настройка (только флаг запуска); запись сети по умолчанию —
  //    scoped (прежнее значение по умолчанию api переводится; явно выбранные all/off не трогаем).
  //    Сайтовые бэнги, исключения блокировщика и тема сайта, совпадающие со стартовым паком, пак забирает себе сам
  //    при первом включении (features/packs: adopt) — здесь про сайты ничего не знаем.
  2(d) {
    if (isPlainObject(d.devtools)) {
      delete d.devtools.remoteDebugging;
      delete d.devtools.remoteDebuggingPort;
      if (d.devtools.capture === 'api') d.devtools.capture = 'scoped';
    }
    // быстрые кнопки новой вкладки теперь — флаг chip у бэнга (раньше список ключей был зашит в ux-chrome)
    if (isPlainObject(d.search) && Array.isArray(d.search.bangs)) {
      for (const b of d.search.bangs) {
        const def = DEFAULT_BANGS.find((x) => x.chip && isPlainObject(b) && x.key === b.key && x.url === b.url);
        if (def && b.chip == null) b.chip = true;
      }
    }
    return d;
  },
};

function createSettings(ctx) {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(100);
  const store = ctx.store('settings', {}, { mergeDefaults: false });
  let data = store.get();
  if (!isPlainObject(data)) data = {};

  // Миграции по версии.
  let changed = false;
  const from = typeof data.version === 'number' ? data.version : 0;
  for (let v = from + 1; v <= VERSION; v++) {
    if (MIGRATIONS[v]) { data = MIGRATIONS[v](data) || data; }
    changed = true;
  }
  if (deepFill(data, DEFAULTS)) changed = true;
  data.version = VERSION;
  if (!data.claude.token) {
    data.claude.token = crypto.randomBytes(24).toString('hex');
    changed = true;
  }
  store.set(data);
  if (changed) store.flush();

  // Переопределения из флагов (не сохраняются).
  const overrides = new Map();
  if (ctx.flags && ctx.flags.mcpPort) overrides.set('claude.mcpPort', ctx.flags.mcpPort);

  function withOverrides(obj, baseKeys) {
    for (const [p, v] of overrides) {
      const keys = p.split('.');
      // Подходит, если базовый путь — префикс пути переопределения.
      if (baseKeys.length > keys.length) continue;
      if (!baseKeys.every((k, i) => keys[i] === k)) continue;
      const rest = keys.slice(baseKeys.length);
      if (rest.length === 0) return clone(v);
      if (isPlainObject(obj)) setAt(obj, rest, clone(v));
    }
    return obj;
  }

  function get(path) {
    const keys = splitPath(path);
    const v = keys.length ? getAt(data, keys) : data;
    return withOverrides(clone(v), keys);
  }

  // Без копии — для горячих путей (не мутировать!).
  function peek(path) {
    const keys = splitPath(path);
    const p = joinPath(keys);
    if (overrides.has(p)) return overrides.get(p);
    return keys.length ? getAt(data, keys) : data;
  }

  function isUnderMap(keys) {
    for (let i = 1; i <= keys.length; i++) {
      if (MAPS.has(joinPath(keys.slice(0, i))) && i < keys.length) return true;
    }
    return false;
  }

  function coerce(value, def, p) {
    if (typeof def === 'number') {
      if (typeof value === 'string' && value.trim() !== '' && !isNaN(Number(value))) value = Number(value);
      if (typeof value !== 'number' || !isFinite(value)) throw new Error(`${p}: ожидается число`);
      const r = RANGES[p];
      if (r) value = Math.min(r[1], Math.max(r[0], value));
      return value;
    }
    if (typeof def === 'boolean') {
      if (value === 'true') value = true;
      else if (value === 'false') value = false;
      if (typeof value !== 'boolean') throw new Error(`${p}: ожидается true/false`);
      return value;
    }
    if (typeof def === 'string') {
      if (typeof value === 'number') value = String(value);
      if (typeof value !== 'string') throw new Error(`${p}: ожидается строка`);
      if (ENUMS[p] && !ENUMS[p].includes(value)) throw new Error(`${p}: допустимо ${ENUMS[p].join('|')}`);
      if (value.length > 200000) throw new Error(`${p}: слишком длинная строка`);
      if (STRING_VALIDATORS[p]) return STRING_VALIDATORS[p](value, p);
      return value;
    }
    if (Array.isArray(def)) {
      if (!Array.isArray(value)) throw new Error(`${p}: ожидается массив`);
      const fn = ARRAY_VALIDATORS[p];
      return fn ? fn(clone(value)) : clone(value);
    }
    return clone(value);
  }

  // Возвращает итоговое (провалидированное) значение для записи по пути keys.
  function validate(keys, value) {
    const p = joinPath(keys);
    if (value === undefined) throw new Error(`${p}: значение не задано`);
    try { JSON.stringify(value); } catch (e) { throw new Error(`${p}: значение не сериализуется`); }
    if (keys[0] === 'version') throw new Error('version менять нельзя');
    if (isUnderMap(keys) || MAPS.has(p)) {
      if (MAPS.has(p) && !isPlainObject(value)) throw new Error(`${p}: ожидается объект`);
      return clone(value);
    }
    const def = getAt(DEFAULTS, keys);
    if (def === undefined) {
      // Новый ключ (фича расширяет свою ветку) — тип не ограничиваем.
      return clone(value);
    }
    if (isPlainObject(def)) {
      if (!isPlainObject(value)) throw new Error(`${p}: ожидается объект`);
      // Слияние по известным ключам с проверкой каждого.
      const cur = clone(getAt(data, keys)) || {};
      for (const [k, v] of Object.entries(value)) cur[k] = validate(keys.concat(k), v);
      return cur;
    }
    return coerce(value, def, p);
  }

  // Внутренние страницы, кроме kosmo://settings, получают только безопасные ветки (без токена, команд и разрешений).
  function pageView() {
    const out = {};
    for (const k of PAGE_READ) out[k] = get(k);
    return out;
  }

  function emitChange(p, value) {
    emitter.emit('change', p, value);
    if (!ctx.broadcast) return;
    const full = { path: p, value, settings: get() };
    let forPages; // считаем один раз на рассылку
    ctx.broadcast('kosmo:settings.changed', full, {
      forInternal(host) {
        if (host === 'settings') return full;
        if (!pageReadable(p)) return null;
        if (!forPages) forPages = { path: p, value, settings: pageView() };
        return forPages;
      },
    });
  }

  function set(path, value) {
    const keys = splitPath(path);
    if (!keys.length) throw new Error('пустой путь');
    const v = validate(keys, value);
    const prev = getAt(data, keys);
    if (JSON.stringify(prev) === JSON.stringify(v)) return clone(v);
    setAt(data, keys, v);
    store.set(data);
    emitChange(joinPath(keys), clone(v));
    return clone(v);
  }

  // Глубокое слияние частичного объекта; каждый лист — через set (словари и массивы — целиком).
  function patch(obj) {
    if (!isPlainObject(obj)) throw new Error('patch: ожидается объект');
    const walk = (o, keys) => {
      for (const [k, v] of Object.entries(o)) {
        const kk = keys.concat(k);
        const p = joinPath(kk);
        const def = getAt(DEFAULTS, kk);
        if (isPlainObject(v) && isPlainObject(def) && !MAPS.has(p)) walk(v, kk);
        else set(kk, v);
      }
    };
    walk(obj, []);
    return get();
  }

  // Удалить ключ (для словарей: siteThemes.sites[домен], sitePermissions[origin]).
  function remove(path) {
    const keys = splitPath(path);
    if (keys.length < 2) throw new Error('remove: слишком короткий путь');
    const parent = getAt(data, keys.slice(0, -1));
    const last = keys[keys.length - 1];
    if (!isPlainObject(parent) || !(last in parent)) return false;
    if (getAt(DEFAULTS, keys) !== undefined) throw new Error('нельзя удалить ключ схемы: ' + joinPath(keys));
    delete parent[last];
    store.set(data);
    emitChange(joinPath(keys), undefined);
    return true;
  }

  // Фича регистрирует дефолты своей ветки (и, по желанию, enum/диапазоны/словари).
  function addDefaults(extra, opts = {}) {
    deepMergeDefaults(DEFAULTS, extra);
    Object.assign(ENUMS, opts.enums || {});
    Object.assign(RANGES, opts.ranges || {});
    for (const m of opts.maps || []) MAPS.add(m);
    if (deepFill(data, DEFAULTS)) store.set(data);
  }

  return {
    get, peek, set, patch, remove, addDefaults, pageView,
    on(event, cb) { emitter.on(event, cb); return () => emitter.off(event, cb); },
    off(event, cb) { emitter.off(event, cb); },
    schema: { version: VERSION, defaults: DEFAULTS, enums: ENUMS, ranges: RANGES, maps: MAPS },
    store,
  };
}

// ---------- права внутренних страниц (SEC-1) ----------
// Интерфейс (ui) и kosmo://settings читают и пишут всё. Остальные внутренние страницы (newtab, history, downloads,
// extensions) читают только ветки PAGE_READ, а пишут только свои ключи из PAGE_WRITE.
const PAGE_READ = ['ui', 'search', 'downloads', 'containers'];
const PAGE_WRITE = {
  downloads: {
    'downloads.ask': (v) => typeof v === 'boolean',
    'downloads.dir': (v) => v === '', // «Сбросить»; выбор папки — через диалог в main
  },
};

function pageReadable(p) {
  const keys = splitPath(p);
  return !keys.length || PAGE_READ.includes(keys[0]);
}

function isPrivileged(meta) {
  return !!meta && (meta.kind === 'ui' || (meta.kind === 'internal' && meta.host === 'settings'));
}

function deny(what) { throw new Error(`${what}: недоступно с этой страницы`); }

function registerSettingsIpc(ctx) {
  const allow = { allow: ['ui', 'internal'] };
  const strict = { allow: ['ui', 'internal:settings'] };
  const pathOf = (p) => (typeof p === 'string' || Array.isArray(p) ? p : p && p.path);
  ctx.ipc.handle('kosmo:settings.get', (p, meta) => {
    const at = pathOf(p);
    if (isPrivileged(meta)) return ctx.settings.get(at);
    const keys = splitPath(at);
    if (!keys.length) return ctx.settings.pageView();
    if (!PAGE_READ.includes(keys[0])) deny('settings.get ' + joinPath(keys));
    return ctx.settings.get(keys);
  }, allow);
  ctx.ipc.handle('kosmo:settings.set', (p, meta) => {
    if (!p || p.path == null) throw new Error('нужен {path, value}');
    if (!isPrivileged(meta)) {
      const key = joinPath(splitPath(p.path));
      const rule = (PAGE_WRITE[meta && meta.host] || {})[key];
      if (!rule || !rule(p.value)) deny('settings.set ' + key);
    }
    return ctx.settings.set(p.path, p.value);
  }, allow);
  // {patch: {...}} или сам объект изменений
  ctx.ipc.handle('kosmo:settings.patch', (p) => {
    const obj = p && isPlainObject(p.patch) && Object.keys(p).length === 1 ? p.patch : p;
    return ctx.settings.patch(obj || {});
  }, strict);
  ctx.ipc.handle('kosmo:settings.remove', (p) => ctx.settings.remove(pathOf(p)), strict);
}

module.exports = { createSettings, registerSettingsIpc, DEFAULTS, DEFAULT_BANGS, splitPath, getAt };
