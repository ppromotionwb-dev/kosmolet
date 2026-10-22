'use strict';
// Фича «themes»: оформление браузера и тёмная тема для любого сайта.
// - Темы интерфейса: пресеты в shared/tokens.css, применяет shared/theme.js (core) во всех слоях на лету;
//   цвета нативных кнопок окна берёт ядро (windows.js). Здесь — только цвета сайтов «в тон интерфейсу».
// - Тёмная тема сайтов: движок Dark Reader (dynamic) или CSS-фильтр (filter), свой CSS сайта,
//   prefers-color-scheme (nativeTheme.themeSource).
// - Исходник Dark Reader (~350 КБ) в tab-preload НЕ встраивается: даже как невызванная функция он стоил бы
//   ~10 мс разбора V8 на каждом кадре каждой страницы. Часть '19-darkreader-lib' — маленький загрузчик: исходник
//   запрашивается у main (sendSync) только когда тема включена и исполняется в мире preload (world 999).
//
// Ключ сайта — хост без www. Совпадение по родительским доменам: seller.wildberries.ru наследует wildberries.ru,
// если своей записи нет. Записи: settings.siteThemes.sites[ключ] = { enabled, engine, brightness, contrast, sepia,
// grayscale, bg, text, css } — всё, кроме enabled, необязательно (нет — берётся из defaults).

const fs = require('fs');
const path = require('path');
const dns = require('dns');

const ENGINES = ['dynamic', 'filter'];
const SCHEMES = ['system', 'dark', 'light'];
const PARAM_KEYS = ['engine', 'brightness', 'contrast', 'sepia', 'grayscale', 'bg', 'text'];
const RANGE = { brightness: [30, 200], contrast: [30, 200], sepia: [0, 100], grayscale: [0, 100] };
const BASE_DEFAULTS = { engine: 'dynamic', brightness: 100, contrast: 100, sepia: 0, grayscale: 0, bg: '', text: '' };
const CSS_LIMIT = 200000;
const HEX_RE = /^#[0-9a-f]{6}$/i;

// Цвета страниц «в тон интерфейсу» (settings.siteThemes.defaults.bg/text = '').
const AUTO_COLORS = {
  cosmos: { bg: '#171b28', text: '#e3e6f0' },
  graphite: { bg: '#1b1b1e', text: '#e6e6e8' },
  light: { bg: '#1b1d23', text: '#e4e5ea' },
  terminal: { bg: '#060a07', text: '#c8ead2' },
};

// Небольшие правки под конкретные сайты (DynamicThemeFix Dark Reader).
const SITE_FIXES = {};

// Безопасность прокси загрузки: данные недоверенные, только http(s), CSS и шрифты, ≤ 5 МБ, 10 с.
// Хост проверяется на каждом шаге (и каждый редирект), имя — по его адресам из DNS: локальные и служебные сети — отказ.
const FETCH_LIMIT = 5 * 1024 * 1024;
const FETCH_TIMEOUT = 10000;
const MAX_REDIRECTS = 5;
const FETCH_CONCURRENCY = 6;
const FETCH_QUEUE_LIMIT = 200;
const MAX_URL = 8192;
const FONT_TYPES = new Set([
  'application/font-woff', 'application/font-woff2', 'application/x-font-woff', 'application/x-font-ttf',
  'application/x-font-otf', 'application/x-font-opentype', 'application/font-sfnt', 'application/vnd.ms-fontobject',
  'application/x-font-truetype', 'application/font-ttf', 'application/font-otf',
]);

// Загрузчик Dark Reader — часть tab-preload '19-darkreader-lib'. Работает в изолированном мире preload.
const LOADER_CODE = `
// Владелец: themes. Ленивый загрузчик Dark Reader (исходник — у main, только когда тема включена).
let dr = null;
const IMG_RE = /\\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|cur)([?#]|$)/i;
function b64ToBytes(s) { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
const got = new Map(); // url → Promise<ответ main> (в пределах документа: повторный enable не ходит в сеть)
function fetcher(url) {
  url = String(url || '');
  if (IMG_RE.test(url) || url.indexOf('data:') === 0) return Promise.reject(new Error('kosmo: загружаются только CSS и шрифты'));
  let p = got.get(url);
  if (!p) {
    p = KOSMO.invoke('kosmo-tab:site-theme.fetch', { url });
    got.set(url, p);
    p.then((r) => { if (!r || !r.ok) got.delete(url); }, () => got.delete(url));
  }
  return p.then((r) => {
    if (!r || !r.ok) throw new Error('kosmo: ' + ((r && r.error) || 'не загружено'));
    const body = r.b64 != null ? b64ToBytes(r.b64) : String(r.text || '');
    return new Response(body, { status: 200, headers: { 'content-type': r.type || 'text/css' } });
  });
}
KOSMO.darkReader = function () {
  if (dr) return dr;
  const src = KOSMO.sendSync('kosmo-tab:site-theme.lib', null);
  if (typeof src !== 'string' || !src) return null;
  // proxy Dark Reader для главного мира: исполняем без <script> (CSP сайта и отчёты о нарушениях не задеваются)
  globalThis.__kosmoMainWorld = (code) => { try { KOSMO.webFrame.executeJavaScript(String(code)).catch(() => {}); } catch (e) {} };
  KOSMO.webFrame.executeJavaScriptInIsolatedWorld(999, [{ code: src }]);
  const lib = globalThis.__kosmoDarkReader;
  if (!lib || typeof lib.enable !== 'function') return null;
  try { lib.setFetchMethod(fetcher); } catch (e) {}
  dr = lib;
  return dr;
};
`;

function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }
function isPlain(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }

function hostOf(url) {
  try {
    const u = new URL(String(url || ''));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.hostname.toLowerCase();
  } catch (_) { return ''; }
}

function siteKey(host) {
  let h = String(host || '').trim().toLowerCase().replace(/\.$/, '');
  if (/^https?:\/\//.test(h)) h = hostOf(h);
  if (h.startsWith('www.') && h.split('.').length > 2) h = h.slice(4);
  return h;
}

function isIp(h) { return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':') || h.startsWith('['); }

// wildberries.ru → [wildberries.ru]; seller.wildberries.ru → [seller.wildberries.ru, wildberries.ru]
function candidates(key) {
  if (!key || isIp(key) || !key.includes('.')) return key ? [key] : [];
  const parts = key.split('.');
  const out = [];
  for (let i = 0; i <= parts.length - 2; i++) out.push(parts.slice(i).join('.'));
  return out;
}

// ---------- локальные адреса (прокси загрузки не должен ходить в localhost и локальную сеть) ----------
// Хост без скобок IPv6 и без точки в конце (localhost. = localhost).
function normHost(h) { return String(h || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, ''); }

function parseV4(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.every((x) => x <= 255) ? p : null;
}

function privateV4([a, b, c]) {
  return a === 0 || a === 10 || a === 127 || a >= 224 || // эта сеть, частная, loopback, multicast/резерв/broadcast
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
}

// IPv6 → 8 слов по 16 бит (IPv4 в конце адреса тоже разбирается), null — не адрес.
function parseV6(s) {
  s = String(s || '').replace(/%.*$/, '');
  if (!s.includes(':')) return null;
  let tail = [];
  const m4 = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (m4) {
    const p = parseV4(m4[1]);
    if (!p) return null;
    tail = [(p[0] << 8) | p[1], (p[2] << 8) | p[3]];
    s = s.slice(0, s.length - m4[1].length);
    if (!s.endsWith('::')) s = s.slice(0, -1);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const words = (x) => (x === '' ? [] : x.split(':').map((w) => (/^[0-9a-f]{1,4}$/i.test(w) ? parseInt(w, 16) : NaN)));
  const head = words(halves[0]);
  const back = halves.length === 2 ? words(halves[1]) : [];
  const all = head.concat(back, tail);
  if (all.some(Number.isNaN)) return null;
  if (halves.length === 1) return all.length === 8 ? all : null;
  const zeros = 8 - all.length;
  return zeros >= 1 ? head.concat(new Array(zeros).fill(0), back, tail) : null;
}

function privateV6(w) {
  const zero = (from, to) => w.slice(from, to).every((x) => x === 0);
  const v4 = (i) => [w[i] >> 8, w[i] & 255, w[i + 1] >> 8, w[i + 1] & 255];
  if (zero(0, 5) && w[5] === 0xffff) return privateV4(v4(6)); // ::ffff:a.b.c.d (IPv4-mapped)
  if (zero(0, 6)) return true; // ::, ::1, ::a.b.c.d (IPv4-compatible)
  if (w[0] === 0x64 && w[1] === 0xff9b) return privateV4(v4(6)); // NAT64
  if (w[0] === 0x2002) return privateV4(v4(1)); // 6to4
  if (w[0] === 0x2001 && (w[1] === 0 || w[1] === 0xdb8)) return true; // Teredo, документация
  if ((w[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 — уникальные локальные
  if ((w[0] & 0xffc0) === 0xfe80 || (w[0] & 0xffc0) === 0xfec0) return true; // link-local, site-local
  return (w[0] & 0xff00) === 0xff00 || (w[0] === 0x100 && zero(1, 4)); // multicast, discard-only
}

function isIpLiteral(h) { h = normHost(h); return !!parseV4(h) || h.includes(':'); }

// Адрес (из URL или из DNS) в локальной/служебной сети. Неразборчивое — считаем локальным.
function isPrivateIp(ip) {
  const s = normHost(ip);
  const v4 = parseV4(s);
  if (v4) return privateV4(v4);
  const v6 = parseV6(s);
  return v6 ? privateV6(v6) : true;
}

// Хост по строке: IP-адрес, localhost-имена, служебные зоны и имена без точки (компьютеры локальной сети).
// Имена, которые резолвятся в локальные адреса (127.0.0.1.nip.io), ловит проверка по DNS в прокси загрузки.
function isPrivateHost(h) {
  h = normHost(h);
  if (!h) return true;
  if (isIpLiteral(h)) return isPrivateIp(h);
  if (/^(0x[0-9a-f]+|\d+)$/i.test(h) || !h.includes('.')) return true;
  return h === 'localhost' || /\.(localhost|local|internal|intranet|lan|home|corp|test|home\.arpa)$/.test(h);
}

function luminance(hex) {
  if (!HEX_RE.test(String(hex || ''))) return null;
  const n = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * n[0] + 0.7152 * n[1] + 0.0722 * n[2];
}

module.exports = {
  id: 'themes',

  init(ctx) {
    const { nativeTheme } = ctx.electron;
    const S = ctx.settings;
    const log = (...a) => ctx.log('themes', ...a);

    // ---------- настройки ----------
    S.addDefaults({ siteThemes: { colorScheme: 'system', rev: 0 } }, {
      enums: { 'siteThemes.colorScheme': SCHEMES },
      ranges: { 'siteThemes.defaults.brightness': RANGE.brightness, 'siteThemes.defaults.contrast': RANGE.contrast },
    });
    // Ревизии ветки: 1 — wildberries.ru включён, цвета страниц по умолчанию «в тон интерфейсу».
    // 2 — на wildberries.ru по умолчанию движок «Быстрый» (filter): Dark Reader на WB (≈250 таблиц стилей) замедлял
    //     загрузку в 2–4 раза (LCP 3 → 11 с, +200 МБ на вкладку). Явно выбранный движок не трогаем.
    try {
      const rev = Number(S.peek('siteThemes.rev')) || 0;
      if (rev < 1) {
        const sites = S.peek('siteThemes.sites') || {};
        if (!sites['wildberries.ru']) S.set(['siteThemes', 'sites', 'wildberries.ru'], { enabled: true });
        const d = S.peek('siteThemes.defaults') || {};
        if (d.bg === '#14161c') S.set('siteThemes.defaults.bg', '');
        if (d.text === '#e6e6ea') S.set('siteThemes.defaults.text', '');
        S.set('siteThemes.rev', 1);
      }
      if (rev < 2) {
        const wb = (S.peek('siteThemes.sites') || {})['wildberries.ru'];
        if (isPlain(wb) && wb.engine == null) S.set(['siteThemes', 'sites', 'wildberries.ru'], Object.assign({}, wb, { engine: 'filter' }));
        S.set('siteThemes.rev', 2);
      }
    } catch (e) { log('миграция настроек:', e.message); }

    // ---------- вычисление конфигурации ----------
    function autoColors() {
      const ui = S.peek('ui') || {};
      if (ui.theme === 'custom' && ui.custom && HEX_RE.test(ui.custom.bg || '')) {
        const l = luminance(ui.custom.bg);
        if (l != null && l < 0.12 && HEX_RE.test(ui.custom.text || '')) return { bg: ui.custom.bg, text: ui.custom.text };
      }
      return AUTO_COLORS[ui.theme] || AUTO_COLORS.cosmos;
    }

    function defaults() {
      const d = Object.assign({}, BASE_DEFAULTS, S.peek('siteThemes.defaults') || {});
      if (!ENGINES.includes(d.engine)) d.engine = 'dynamic';
      return d;
    }

    function match(sites, key) {
      for (const k of candidates(key)) {
        if (isPlain(sites[k])) return { key: k, entry: sites[k] };
      }
      return null;
    }

    // Полное состояние темы для адреса (для интерфейса и для вкладок).
    function resolve(url) {
      const host = hostOf(url);
      if (!host) return { supported: false, url: String(url || ''), dark: false, enabled: false, css: '' };
      const key = siteKey(host);
      const st = S.peek('siteThemes') || {};
      const sites = isPlain(st.sites) ? st.sites : {};
      const m = match(sites, key);
      const entry = m ? m.entry : null;
      const mode = ['off', 'all', 'list'].includes(st.mode) ? st.mode : 'list';
      let dark;
      if (mode === 'off') dark = false;
      else if (mode === 'all') dark = !(entry && entry.enabled === false);
      else dark = !!(entry && entry.enabled === true);
      const d = defaults();
      const params = {};
      for (const k of PARAM_KEYS) params[k] = entry && entry[k] != null && entry[k] !== '' ? entry[k] : d[k];
      if (!ENGINES.includes(params.engine)) params.engine = 'dynamic';
      const auto = autoColors();
      if (!HEX_RE.test(params.bg || '')) params.bg = auto.bg;
      if (!HEX_RE.test(params.text || '')) params.text = auto.text;
      return {
        supported: true,
        host,
        key,
        matchedKey: m ? m.key : null,
        inherited: !!m && m.key !== key,
        own: m && m.key === key ? Object.assign({}, entry) : null,
        mode,
        dark,
        enabled: dark, // итог: тёмная тема на этом сайте включена (= dark)
        siteEnabled: entry && typeof entry.enabled === 'boolean' ? entry.enabled : null, // своё значение записи
        params,
        defaults: d,
        auto,
        css: entry && typeof entry.css === 'string' ? entry.css : '',
        colorScheme: SCHEMES.includes(st.colorScheme) ? st.colorScheme : 'system',
      };
    }

    function fixesFor(key) {
      for (const k of candidates(key)) if (SITE_FIXES[k]) return SITE_FIXES[k];
      return null;
    }

    // То, что получает preload вкладки (null — ничего не делать).
    function payload(r) {
      if (!r || !r.supported || (!r.dark && !r.css)) return null;
      const out = { css: r.css || '' };
      if (r.dark) {
        const p = r.params;
        out.dark = 1;
        out.engine = p.engine;
        out.bg = p.bg;
        out.text = p.text;
        out.theme = {
          mode: 1, brightness: p.brightness, contrast: p.contrast, sepia: p.sepia, grayscale: p.grayscale,
          darkSchemeBackgroundColor: p.bg, darkSchemeTextColor: p.text,
        };
        const fx = fixesFor(r.key);
        if (fx) out.fixes = fx;
      }
      return out;
    }

    // ---------- изменение записей сайтов ----------
    function cleanPatch(p) {
      const out = {};
      if (!isPlain(p)) return out;
      if ('enabled' in p) out.enabled = p.enabled == null ? null : !!p.enabled;
      if ('engine' in p) out.engine = ENGINES.includes(p.engine) ? p.engine : null;
      for (const k of Object.keys(RANGE)) {
        if (!(k in p)) continue;
        const n = Number(p[k]);
        out[k] = p[k] == null || p[k] === '' || !isFinite(n) ? null : Math.round(clamp(n, RANGE[k][0], RANGE[k][1]));
      }
      for (const k of ['bg', 'text']) {
        if (!(k in p)) continue;
        out[k] = typeof p[k] === 'string' && HEX_RE.test(p[k]) ? p[k].toLowerCase() : null;
      }
      if ('css' in p) {
        const css = typeof p.css === 'string' ? p.css : '';
        if (css.length > CSS_LIMIT) throw new Error('CSS слишком длинный (больше 200 000 знаков)');
        out.css = css;
      }
      return out;
    }

    function writeSite(key, entry) {
      if (!key) throw new Error('нет адреса сайта');
      if (entry == null) return S.remove(['siteThemes', 'sites', key]);
      return S.set(['siteThemes', 'sites', key], entry);
    }

    function normKey(hostOrUrl) {
      const s = String(hostOrUrl || '').trim();
      const k = siteKey(/^[a-z]+:\/\//i.test(s) ? hostOf(s) : s);
      if (!k || k.length > 253 || !/^[a-z0-9.\-[\]:_]+$/i.test(k)) throw new Error('неверный адрес сайта: ' + s);
      return k;
    }

    // setSite(host, patch): своя запись для host (если её не было — копия унаследованной). null в patch — убрать ключ.
    function setSite(hostOrUrl, patch) {
      const key = normKey(hostOrUrl);
      const p = cleanPatch(patch);
      const sites = S.peek('siteThemes.sites') || {};
      let entry;
      if (isPlain(sites[key])) entry = Object.assign({}, sites[key]);
      else {
        const m = match(sites, key);
        entry = m ? Object.assign({}, m.entry) : {};
      }
      for (const [k, v] of Object.entries(p)) {
        if (v === null) delete entry[k]; else entry[k] = v;
      }
      if (entry.css === '') delete entry.css;
      writeSite(key, entry);
      return resolve('https://' + key + '/');
    }

    function toggleSite(hostOrUrl, value) {
      const key = normKey(hostOrUrl);
      const r = resolve('https://' + key + '/');
      const next = typeof value === 'boolean' ? value : !r.dark;
      const mode = r.mode;
      if (mode === 'off' && next) S.set('siteThemes.mode', 'list');
      return setSite(key, { enabled: next });
    }

    function removeSite(hostOrUrl) {
      const key = normKey(hostOrUrl);
      return writeSite(key, null);
    }

    // Сбросить параметры (яркость, движок, цвета) к общим, оставив включение и CSS.
    function resetSite(hostOrUrl) {
      const key = normKey(hostOrUrl);
      const sites = S.peek('siteThemes.sites') || {};
      if (!isPlain(sites[key])) return resolve('https://' + key + '/');
      const entry = Object.assign({}, sites[key]);
      for (const k of PARAM_KEYS) delete entry[k];
      writeSite(key, entry);
      return resolve('https://' + key + '/');
    }

    function listSites() {
      const sites = S.peek('siteThemes.sites') || {};
      return Object.keys(sites).sort().map((key) => {
        const e = isPlain(sites[key]) ? sites[key] : {};
        const params = PARAM_KEYS.filter((k) => e[k] != null && e[k] !== '');
        return { key, enabled: typeof e.enabled === 'boolean' ? e.enabled : null, css: typeof e.css === 'string' ? e.css.length : 0, params };
      });
    }

    // ---------- вкладки: применение на лету ----------
    const UPDATE = 'kosmo-tab:site-theme.update';
    const viewBg = new Map(); // tab.id → цвет фона вида, который мы поставили

    function sendToFrames(wc, cfg) {
      let frames = [];
      try { frames = wc.mainFrame ? wc.mainFrame.framesInSubtree : []; } catch (_) { frames = []; }
      for (const f of frames) {
        try { if (!f.isDestroyed || !f.isDestroyed()) f.send(UPDATE, cfg); } catch (_) { /* кадр ушёл */ }
      }
    }

    // Фон самого вида вкладки (виден до первой отрисовки документа): тёмный для тёмных сайтов.
    function setViewBg(tab, url) {
      if (!tab || !tab.view) return;
      const r = resolve(url);
      const want = r.supported && r.dark ? r.params.bg : null;
      const had = viewBg.get(tab.id) || null;
      if (want === had) return;
      try {
        tab.view.setBackgroundColor(want || '#ffffff');
        if (want) viewBg.set(tab.id, want); else viewBg.delete(tab.id);
      } catch (_) { /* вид уничтожен */ }
    }

    function pushTab(tab) {
      const wc = tab && tab.wc;
      if (!wc || wc.isDestroyed()) return;
      const url = wc.getURL();
      setViewBg(tab, url);
      if (!hostOf(url)) return;
      sendToFrames(wc, payload(resolve(url)) || { off: 1 });
    }

    let pushTimer = null;
    function schedulePush() {
      if (pushTimer) return;
      pushTimer = setTimeout(() => {
        pushTimer = null;
        for (const t of ctx.tabs.all()) pushTab(t);
        ctx.broadcast('kosmo:themes.changed', { at: Date.now() });
      }, 30);
    }

    S.on('change', (p) => {
      p = String(p || '');
      if (p === '' || p === 'siteThemes' || p.startsWith('siteThemes.')) {
        if (p === '' || p === 'siteThemes' || p.startsWith('siteThemes.colorScheme')) applyColorScheme();
        schedulePush();
      } else if (p === 'ui' || p.startsWith('ui.theme') || p.startsWith('ui.custom')) {
        schedulePush(); // цвета страниц «в тон интерфейсу»
      }
    });

    ctx.tabs.on('view-created', (tab, wc) => {
      wc.on('did-start-navigation', (details) => {
        if (!details || !details.isMainFrame || details.isSameDocument) return;
        setViewBg(tab, details.url);
      });
    });
    ctx.tabs.on('view-destroyed', (tab) => viewBg.delete(tab.id));
    ctx.tabs.on('closed', (tab) => viewBg.delete(tab.id));

    // ---------- prefers-color-scheme ----------
    function applyColorScheme() {
      const v = S.peek('siteThemes.colorScheme');
      const src = SCHEMES.includes(v) ? v : 'system';
      try { if (nativeTheme.themeSource !== src) nativeTheme.themeSource = src; } catch (e) { log('nativeTheme:', e.message); }
    }
    applyColorScheme();

    // ---------- tab-preload ----------
    ctx.preload.addPart('19-darkreader-lib', { code: LOADER_CODE });

    const metrics = [];
    let measure = false;

    ctx.ipc.handleSync('kosmo-tab:site-theme.get', (p, meta) => {
      const top = !!(p && p.top);
      let url = top ? meta.frameUrl : '';
      if (!url) { try { url = meta.webContents.getURL(); } catch (_) { url = ''; } }
      const out = payload(resolve(url));
      if (measure) return Object.assign({ m: 1 }, out || {});
      return out;
    }, { allow: ['tab'] });

    // Исходник Dark Reader — один раз читаем и готовим, отдаём только вкладкам с включённой темой.
    let libSource = null;
    function darkReaderSource() {
      if (libSource) return libSource;
      const file = path.join(ctx.paths.root, 'node_modules', 'darkreader', 'darkreader.js');
      let src = fs.readFileSync(file, 'utf8');
      // proxy в главный мир — без <script> (не упираемся в CSP сайта)
      const re = /const proxyScript = createOrUpdateScript\("darkreader--proxy"\);\s*proxyScript\.append\(\s*(`[^`]*`)\s*\);\s*document\.head\.insertBefore\(proxyScript, rootVarsStyle\.nextSibling\);\s*proxyScript\.remove\(\);/;
      if (re.test(src)) src = src.replace(re, (_m, tpl) => `if (globalThis.__kosmoMainWorld) globalThis.__kosmoMainWorld(${tpl});`);
      else log('Dark Reader: не найдено место вставки proxy — будет <script>');
      // отказы прокси (картинки) не сыплем в консоль страницы
      src = src.replace(/(\} catch \(error\) \{\s*)console\.error\(error\);(\s*messageListeners\.forEach)/, '$1$2');
      // анализ встроенных SVG без обработчика ошибки давал «Uncaught (in promise)» в консоли сайта
      src = src.replace('getImageDetails(dataURL).then((details) => {', 'getImageDetails(dataURL).catch(() => null).then((details) => { if (!details) return;');
      // data:-адреса без base64 Dark Reader переводит в blob через fetch() — CSP сайта (connect-src) его режет.
      // Декодируем сами, без сети.
      src = src.replace(/const response = await fetch\(dataURL\);\s*blob = await response\.blob\(\);/,
        "try { const c = dataURL.indexOf(','); const type = dataURL.slice(5, c).split(';')[0] || 'text/plain'; blob = new Blob([decodeURIComponent(dataURL.slice(c + 1))], { type }); } catch (e) { return null; }");
      // Без <meta name="darkreader"> в DOM сайта: метку видят SEO-сниппеты, Рентген, снимок для Claude и сами сайты.
      // Её роль — уступить другому экземпляру Dark Reader (расширение): теперь уступаем по появлению его метки.
      const reMarker = /function createDarkReaderInstanceMarker\(\) \{[^}]*?document\.head\.appendChild\(metaElement\);\s*\}/;
      const reListener = /function addMetaListener\(\) \{\s*metaObserver = new MutationObserver\(\(\) => \{\s*if \(document\.querySelector\('meta\[name="darkreader-lock"\]'\)\) \{/;
      const reRemove = /(["']\.darkreader--root-vars["']),\s*'meta\[name="darkreader"\]'/;
      if (reMarker.test(src) && reListener.test(src) && reRemove.test(src)) {
        src = src.replace(reMarker, 'function createDarkReaderInstanceMarker() {}')
          .replace(reListener, 'function addMetaListener() { if (metaObserver) metaObserver.disconnect(); metaObserver = new MutationObserver(() => { if (document.querySelector(\'meta[name="darkreader-lock"], meta[name="darkreader"]\')) {')
          .replace(reRemove, '$1');
      } else log('Dark Reader: метка <meta name="darkreader"> не убрана — не найдено место правки');
      libSource = '(function () { var exports = {}; var module = { exports: exports }; var define;\n' + src +
        '\n;globalThis.__kosmoDarkReader = module.exports && module.exports.enable ? module.exports : exports; })();';
      return libSource;
    }

    ctx.ipc.handleSync('kosmo-tab:site-theme.lib', (_p, meta) => {
      // Отдаём только туда, где тема действительно включена.
      let url = '';
      try { url = meta.webContents.getURL(); } catch (_) { url = ''; }
      const r = resolve(meta.frameUrl || url);
      const r2 = resolve(url);
      if (!((r.supported && r.dark) || (r2.supported && r2.dark))) return null;
      try { return darkReaderSource(); } catch (e) { log('Dark Reader не прочитан:', e.message); return null; }
    }, { allow: ['tab'] });

    ctx.ipc.on('kosmo-tab:site-theme.metric', (p, meta) => {
      if (!measure || !isPlain(p)) return;
      metrics.push({ ms: Number(p.ms) || 0, dr: Number(p.dr) || 0, top: !!p.top, dark: !!p.dark, de: !!p.de, url: String(meta.frameUrl || '').slice(0, 200), at: Date.now() });
      if (metrics.length > 500) metrics.splice(0, metrics.length - 500);
    }, { allow: ['tab'] });

    // ---------- прокси загрузки для Dark Reader ----------
    const fetchStats = { ok: 0, failed: 0, cached: 0, bytes: 0, errors: [] };
    const inflight = new Map(); // wc.id → число запросов
    const queues = new Map(); // wc.id → [resolve]
    // Кэш CSS между документами (переходы по сайту не ждут сеть). Запросы без cookies — ответы общие.
    const CACHE_LIMIT = 24 * 1024 * 1024;
    const CACHE_TTL = 15 * 60 * 1000;
    const cssCache = new Map(); // url → { text, size, at }
    let cacheSize = 0;
    function cacheGet(url) {
      const e = cssCache.get(url);
      if (!e) return null;
      if (Date.now() - e.at > CACHE_TTL) { cssCache.delete(url); cacheSize -= e.size; return null; }
      cssCache.delete(url); cssCache.set(url, e); // свежий в конец
      return e.text;
    }
    function cachePut(url, text) {
      const size = text.length * 2;
      if (size > CACHE_LIMIT / 4) return;
      const old = cssCache.get(url);
      if (old) { cssCache.delete(url); cacheSize -= old.size; }
      cssCache.set(url, { text, size, at: Date.now() });
      cacheSize += size;
      for (const [k, e] of cssCache) { if (cacheSize <= CACHE_LIMIT) break; cssCache.delete(k); cacheSize -= e.size; }
    }

    function acquire(id) {
      const n = inflight.get(id) || 0;
      if (n < FETCH_CONCURRENCY) { inflight.set(id, n + 1); return Promise.resolve(); }
      const q = queues.get(id) || [];
      if (q.length >= FETCH_QUEUE_LIMIT) return Promise.reject(new Error('слишком много запросов'));
      queues.set(id, q);
      return new Promise((res) => q.push(res));
    }
    function release(id) {
      const q = queues.get(id);
      if (q && q.length) { q.shift()(); return; }
      const n = (inflight.get(id) || 1) - 1;
      if (n <= 0) { inflight.delete(id); queues.delete(id); } else inflight.set(id, n);
    }

    // Проверка цели перед КАЖДЫМ запросом (и после каждого редиректа): только http(s), без пароля в адресе,
    // не локальный хост и ни один из его адресов в DNS не локальный. Резолв — тем же резолвером Chromium,
    // что и сам запрос (его кэш), чтобы ответ DNS между проверкой и запросом не подменили.
    async function checkTarget(ses, u, pageLocal) {
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('только http(s)');
      if (u.username || u.password) throw new Error('адрес с паролем');
      if (pageLocal) return; // страница сама локальная (разработка) — её локальные стили можно
      const host = normHost(u.hostname);
      if (isPrivateHost(host)) throw new Error('локальный адрес');
      if (isIpLiteral(host)) return;
      let addrs;
      try {
        addrs = typeof ses.resolveHost === 'function'
          ? ((await ses.resolveHost(host)).endpoints || []).map((e) => e.address)
          : (await dns.promises.lookup(host, { all: true, verbatim: true })).map((e) => e.address);
      } catch (_) { throw new Error('адрес не найден'); }
      if (!addrs.length) throw new Error('адрес не найден');
      if (addrs.some(isPrivateIp)) throw new Error('локальный адрес');
    }

    const hval = (v) => String(Array.isArray(v) ? v[0] : v == null ? '' : v);

    // Один запрос без перехода по редиректу: {redirect: url} или {type, isCss, buf}.
    function requestOnce(ses, href, signal) {
      return new Promise((resolveP, rejectP) => {
        let done = false;
        let req = null;
        let location = null;
        const finish = (fn, v) => { if (done) return; done = true; signal.removeEventListener('abort', onAbort); fn(v); };
        const fail = (err) => { try { if (req) req.abort(); } catch (_) { /* уже закрыт */ } finish(rejectP, err); };
        function onAbort() { fail(Object.assign(new Error('таймаут 10 с'), { name: 'AbortError' })); }
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort);
        try {
          req = ctx.electron.net.request({
            url: href, method: 'GET', session: ses, credentials: 'omit', useSessionCookies: false,
            redirect: 'manual', bypassCustomProtocolHandlers: true,
          });
          req.setHeader('accept', 'text/css,*/*;q=0.1');
        } catch (e) { finish(rejectP, e); return; }
        // Редирект не продолжаем: новый адрес проверим и запросим заново (followRedirect нельзя отложить до DNS).
        req.on('redirect', (_status, _method, url) => { location = url; });
        req.on('response', (res) => {
          const status = res.statusCode;
          if (status < 200 || status >= 300) { fail(new Error('ответ ' + status)); return; }
          const type = hval(res.headers['content-type']).toLowerCase().split(';')[0].trim();
          const isCss = type === 'text/css';
          const isFont = type.startsWith('font/') || FONT_TYPES.has(type);
          if (!isCss && !isFont) { fail(new Error('не CSS и не шрифт: ' + (type || 'без типа'))); return; }
          if (Number(hval(res.headers['content-length'])) > FETCH_LIMIT) { fail(new Error('больше 5 МБ')); return; }
          const chunks = [];
          let size = 0;
          res.on('data', (c) => {
            if (done) return;
            size += c.length;
            if (size > FETCH_LIMIT) { fail(new Error('больше 5 МБ')); return; }
            chunks.push(c);
          });
          res.on('end', () => finish(resolveP, { type, isCss, buf: Buffer.concat(chunks) }));
          res.on('aborted', () => fail(new Error('ответ прерван')));
          res.on('error', (e) => fail(e));
        });
        req.on('error', (e) => { if (location) finish(resolveP, { redirect: location }); else finish(rejectP, e); });
        req.on('abort', () => finish(rejectP, new Error('запрос прерван')));
        req.end();
      });
    }

    async function fetchChecked(ses, u, signal, pageLocal) {
      for (let hop = 0; ; hop++) {
        await checkTarget(ses, u, pageLocal);
        const res = await requestOnce(ses, u.href, signal);
        if (!res.redirect) return res;
        if (hop >= MAX_REDIRECTS) throw new Error('слишком много перенаправлений');
        try { u = new URL(res.redirect, u); } catch (_) { throw new Error('неверное перенаправление'); }
      }
    }

    ctx.ipc.handle('kosmo-tab:site-theme.fetch', async (p, meta) => {
      const url = String((p && p.url) || '');
      try {
        if (!url || url.length > MAX_URL) throw new Error('неверный адрес');
        let u;
        try { u = new URL(url); } catch (_) { throw new Error('неверный адрес'); }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('только http(s)');
        if (u.username || u.password) throw new Error('адрес с паролем');
        const wc = meta.webContents;
        if (!meta.tab || !wc || wc.isDestroyed()) throw new Error('нет вкладки');
        // Только для страниц, где тёмная тема (dynamic) действительно включена.
        const pageUrl = wc.getURL();
        const r = resolve(pageUrl);
        if (!r.supported || !r.dark || r.params.engine !== 'dynamic') throw new Error('тема не включена');
        // Локальные адреса — только если и сама страница локальная.
        const pageLocal = isPrivateHost(hostOf(pageUrl));
        if (!pageLocal && isPrivateHost(u.hostname)) throw new Error('локальный адрес');
        const hit = cacheGet(u.href);
        if (hit != null) { fetchStats.cached++; return { ok: true, type: 'text/css', text: hit }; }
        const wid = wc.id;
        const ses = wc.session;
        await acquire(wid);
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT);
        try {
          const res = await fetchChecked(ses, u, ac.signal, pageLocal);
          fetchStats.ok++; fetchStats.bytes += res.buf.length;
          if (!res.isCss) return { ok: true, type: res.type, b64: res.buf.toString('base64') };
          const text = res.buf.toString('utf8');
          // в общий кэш — только то, что прошло полную проверку адресов (не «локальная страница → локальный CSS»)
          if (!pageLocal) cachePut(u.href, text);
          return { ok: true, type: 'text/css', text };
        } finally {
          clearTimeout(timer);
          release(wid);
        }
      } catch (e) {
        const error = e && e.name === 'AbortError' ? 'таймаут 10 с' : String((e && e.message) || e).slice(0, 200);
        fetchStats.failed++;
        fetchStats.errors.push(error + ' — ' + url.slice(0, 160));
        if (fetchStats.errors.length > 30) fetchStats.errors.shift();
        return { ok: false, error };
      }
    }, { allow: ['tab'] });

    // ---------- IPC интерфейса ----------
    const both = { allow: ['ui', 'internal'] };
    const urlOf = (p) => {
      if (p && typeof p.url === 'string' && p.url) return p.url;
      if (p && p.tabId != null) { const t = ctx.tabs.get(p.tabId); if (t) return t.info.url; }
      const a = ctx.tabs.active();
      return a ? a.info.url : '';
    };
    ctx.ipc.handle('kosmo:themes.site', (p) => resolve(urlOf(p)), both);
    ctx.ipc.handle('kosmo:themes.setSite', (p = {}) => setSite(p.key || p.host || urlOf(p), p.patch || {}), both);
    ctx.ipc.handle('kosmo:themes.toggleSite', (p = {}) => toggleSite(p.key || p.host || urlOf(p), typeof p.value === 'boolean' ? p.value : undefined), both);
    ctx.ipc.handle('kosmo:themes.removeSite', (p = {}) => removeSite(p.key || p.host), both);
    ctx.ipc.handle('kosmo:themes.resetSite', (p = {}) => resetSite(p.key || p.host), both);
    ctx.ipc.handle('kosmo:themes.sites', () => listSites(), both);
    ctx.ipc.handle('kosmo:themes.autoColors', () => autoColors(), both);

    // ---------- команды ----------
    const activeHttp = () => { const t = ctx.tabs.active(); return t && hostOf(t.info.url) ? t : null; };
    ctx.commands.register({
      id: 'themes.toggleSite', title: 'Тёмная тема на этом сайте (вкл./выкл.)', category: 'Оформление', keys: ['Alt+Shift+D'], repeat: false,
      when: () => !!activeHttp(),
      run: () => {
        const t = activeHttp();
        if (!t) return null;
        const r = toggleSite(t.info.url);
        ctx.broadcast('kosmo:themes.toggled', { key: r.key, host: r.host, dark: r.dark });
        return { key: r.key, dark: r.dark };
      },
    });
    ctx.commands.register({
      id: 'themes.toggleAll', title: 'Тёмная тема для всех сайтов (вкл./выкл.)', category: 'Оформление',
      run: () => {
        const mode = S.peek('siteThemes.mode') === 'all' ? 'list' : 'all';
        S.set('siteThemes.mode', mode);
        ctx.broadcast('kosmo:themes.toggled', { all: true, mode });
        return { mode };
      },
    });
    ctx.commands.register({
      id: 'themes.editCss', title: 'Свой CSS для сайта', category: 'Оформление',
      run: () => ctx.panel.open('theme'),
    });

    // ---------- API для других фич ----------
    ctx.themes = {
      siteConfig: (url) => resolve(url),
      toggleSite: (host, value) => toggleSite(host, value),
      setSite: (host, patch) => setSite(host, patch),
      removeSite: (host) => removeSite(host),
      resetSite: (host) => resetSite(host),
      sites: () => listSites(),
      siteKey: (hostOrUrl) => siteKey(/^[a-z]+:\/\//i.test(String(hostOrUrl)) ? hostOf(hostOrUrl) : hostOrUrl),
      autoColors,
      // dev: замеры preload (performance.now в части 20-site-theme.js)
      measure(on) { measure = !!on; if (on) metrics.length = 0; return measure; },
      metrics: () => metrics.slice(),
      fetchStats: () => JSON.parse(JSON.stringify(fetchStats)),
    };
  },

  async start() {},
};
