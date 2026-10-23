'use strict';
// Сессии и контейнеры (ARCHITECTURE §7), протокол kosmo://, чистый User-Agent, разрешения по умолчанию.

const fs = require('fs');
const path = require('path');

// Хосты с kosmo API (ARCHITECTURE §4). kosmo://error/ сюда НЕ входит: он показывает адрес из параметров
// (данные от сайта) и API ему не нужен — страница ошибки остаётся без привилегий.
const INTERNAL_HOSTS = ['newtab', 'settings', 'history', 'downloads', 'extensions'];
const UI_PARTITION = 'kosmo-ui';
// Список для setUserAgent: q-веса Chromium добавит сам → «ru-RU,ru;q=0.9,en;q=0.8».
const ACCEPT_LANGUAGES = 'ru-RU,ru,en';
const CONTAINER_ID_RE = /^[a-z0-9_-]{1,40}$/i;
const DEFAULT_CONTAINER_COLOR = '#8a8f98';

// Политика по умолчанию для сайтов (если обработчик фичи не решил).
const DEFAULT_ALLOW = new Set(['clipboard-sanitized-write', 'fullscreen', 'pointerLock']);
// Внутренним страницам и интерфейсу дополнительно можно читать буфер обмена.
const TRUSTED_ALLOW = new Set(['clipboard-sanitized-write', 'clipboard-read', 'fullscreen', 'pointerLock']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};

// crx: — иконки действий расширений в <browser-action-list> (crx://extension-icon/…, фича platform).
const CSP = "default-src 'self' kosmo:; img-src * data: blob: crx:; style-src 'self' 'unsafe-inline' kosmo:; frame-ancestors 'none'";

// Пакеты node_modules, которые интерфейс может грузить как kosmo://ui/vendor/<пакет>/<файл>.
const VENDOR = new Set(['@xterm/xterm', '@xterm/addon-fit']);

function chromeUserAgent() {
  const major = String(process.versions.chrome || '156').split('.')[0];
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

function textResponse(status, text) {
  return new Response(text, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff' },
  });
}

// Безопасно присоединить относительный путь к базе; null — выход за пределы.
function safeJoin(base, rel) {
  if (rel.includes('\0') || rel.includes('\\') || /^[a-z]:/i.test(rel)) return null;
  const norm = path.normalize(rel).replace(/^([/\\])+/, '');
  const full = path.resolve(base, norm);
  const relBack = path.relative(base, full);
  if (relBack.startsWith('..') || path.isAbsolute(relBack)) return null;
  return full;
}

function createSessions(ctx) {
  const { session, app } = ctx.electron;
  const sessions = new Map(); // containerId → Session
  const hooks = [];
  const preloadRegistered = new WeakSet();
  let preloadPath = null;
  let uiSession = null;
  let permHandler = null;
  let missingHandler = null;

  const rendererRoot = ctx.paths.renderer;
  const uiOverride = ctx.flags.dev && ctx.flags.uiRoot ? path.resolve(ctx.flags.uiRoot) : null;
  const nodeModules = path.join(ctx.paths.root, 'node_modules');

  function userAgent() {
    const p = ctx.settings.peek('privacy') || {};
    if (p.userAgent === 'custom' && typeof p.customUA === 'string' && p.customUA.trim()) return p.customUA.trim();
    return chromeUserAgent();
  }

  app.userAgentFallback = chromeUserAgent();

  // --- протокол kosmo:// ---

  function resolveFile(url, isUi) {
    const host = url.hostname;
    let p;
    try { p = decodeURIComponent(url.pathname); } catch (_) { return null; }
    if (p.startsWith('/shared/')) return { base: path.join(rendererRoot, 'shared'), rel: p.slice('/shared/'.length) };
    if (host === 'ui') {
      if (!isUi) return null;
      if (p.startsWith('/vendor/')) {
        const parts = p.slice('/vendor/'.length).split('/');
        const pkg = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
        if (!VENDOR.has(pkg)) return null;
        const rest = parts.slice(pkg.split('/').length).join('/');
        return { base: path.join(nodeModules, ...pkg.split('/')), rel: rest };
      }
      return { base: rendererRoot, rel: p.slice(1), override: uiOverride };
    }
    if (!/^[a-z0-9-]{1,40}$/.test(host)) return null;
    return { base: path.join(rendererRoot, 'pages', host), rel: p.slice(1) };
  }

  async function statSafe(f) { try { return await fs.promises.stat(f); } catch (_) { return null; } }

  async function findFile(base, rel) {
    let full = safeJoin(base, rel);
    if (!full) return null;
    let st = await statSafe(full);
    if (st && st.isDirectory()) { full = path.join(full, 'index.html'); st = await statSafe(full); }
    if (!st || !st.isFile()) return null;
    return full;
  }

  async function serve(request, isUi) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return textResponse(405, 'Метод не поддерживается');
    let url;
    try { url = new URL(request.url); } catch (_) { return textResponse(400, 'Неверный адрес'); }
    const target = resolveFile(url, isUi);
    if (!target) return textResponse(404, 'Не найдено');
    let rel = target.rel;
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    let file = null;
    if (target.override) file = await findFile(target.override, rel);
    if (!file) file = await findFile(target.base, rel);
    if (!file) return textResponse(404, 'Не найдено: ' + url.pathname);
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const headers = {
      'content-type': type,
      'content-security-policy': CSP,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-cache',
    };
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
    const body = await fs.promises.readFile(file);
    return new Response(body, { status: 200, headers });
  }

  function handleProtocol(ses, isUi) {
    try {
      ses.protocol.handle('kosmo', (req) => serve(req, isUi).catch((e) => {
        ctx.log('kosmo://', req.url, e.message);
        return textResponse(500, 'Ошибка: ' + e.message);
      }));
    } catch (e) {
      ctx.log('sessions', 'не удалось зарегистрировать kosmo://', e.message);
    }
  }

  // --- разрешения ---

  function originOf(u) { try { return new URL(u).origin; } catch (_) { return ''; } }

  function isTrustedContents(wc, url) {
    if (wc && ctx.ipc && ctx.ipc.isUi(wc)) return true;
    return !!url && ctx.ipc && ctx.ipc.isInternalUrl(url);
  }

  function setupPermissions(ses, containerId) {
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      const url = (details && (details.requestingUrl || details.securityOrigin)) || (wc && !wc.isDestroyed() ? wc.getURL() : '');
      const trusted = isTrustedContents(wc, url);
      const def = (trusted ? TRUSTED_ALLOW : DEFAULT_ALLOW).has(permission);
      if (permHandler && !trusted) {
        const info = {
          webContents: wc, permission, details, origin: originOf(url), containerId, session: ses,
          tab: ctx.tabs && wc ? ctx.tabs.fromWebContents(wc) : null, defaultDecision: def,
        };
        try {
          const r = permHandler('request', info);
          if (r && typeof r.then === 'function') {
            r.then((v) => callback(v === undefined || v === null ? def : !!v), () => callback(def));
            return;
          }
          if (r !== undefined && r !== null) { callback(!!r); return; }
        } catch (e) { ctx.log('permissions', e); }
      }
      callback(def);
    });
    ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
      const url = (details && details.requestingUrl) || requestingOrigin || '';
      const trusted = isTrustedContents(wc, url);
      const def = (trusted ? TRUSTED_ALLOW : DEFAULT_ALLOW).has(permission);
      if (permHandler && !trusted) {
        try {
          const r = permHandler('check', {
            webContents: wc, permission, details, origin: requestingOrigin || originOf(url), containerId, session: ses,
            tab: ctx.tabs && wc ? ctx.tabs.fromWebContents(wc) : null, defaultDecision: def,
          });
          if (typeof r === 'boolean') return r;
        } catch (e) { ctx.log('permissions', e); }
      }
      return def;
    });
  }

  ctx.permissions = {
    // fn(kind: 'request'|'check', info) → true/false; undefined — политика по умолчанию. Для 'request' можно вернуть Promise.
    setHandler(fn) { permHandler = typeof fn === 'function' ? fn : null; },
    defaults: DEFAULT_ALLOW,
  };

  // --- сессии ---

  function registerPreload(ses) {
    if (!preloadPath || preloadRegistered.has(ses)) return;
    try {
      ses.registerPreloadScript({ type: 'frame', id: 'kosmo-tab-preload', filePath: preloadPath });
      preloadRegistered.add(ses);
    } catch (e) {
      ctx.log('sessions', 'registerPreloadScript:', e.message);
    }
  }

  function setupSession(ses, containerId) {
    handleProtocol(ses, false);
    ses.setUserAgent(userAgent(), ACCEPT_LANGUAGES);
    try { ses.setSpellCheckerEnabled(false); } catch (_) {}
    setupPermissions(ses, containerId);
    registerPreload(ses);
    for (const fn of hooks) {
      try { fn(ses, containerId); } catch (e) { ctx.log('sessions', 'onSession hook:', e); }
    }
  }

  function containers() {
    const list = ctx.settings.peek('containers');
    return Array.isArray(list) && list.length ? list : [{ id: 'main', name: 'Основной', color: '#7c6cff' }];
  }

  function container(id) {
    return containers().find((c) => c.id === id) || { id, name: id, color: DEFAULT_CONTAINER_COLOR };
  }

  function normalizeId(id) {
    const s = String(id || 'main');
    return CONTAINER_ID_RE.test(s) ? s : 'main';
  }

  function exists(id) { return id === 'main' || containers().some((c) => c.id === id); }

  // id контейнера для новой вкладки: существующий — как есть; удалённый — решает обработчик фичи
  // (platform открывает в новом изолированном), без обработчика — основной.
  function resolve(containerId) {
    const id = normalizeId(containerId);
    if (exists(id)) return id;
    if (missingHandler) {
      try { const r = missingHandler(id); if (r && exists(r)) return r; } catch (e) { ctx.log('sessions', 'нет контейнера:', e); }
    }
    return 'main';
  }

  function get(containerId) {
    const id = normalizeId(containerId);
    let ses = sessions.get(id);
    if (ses) return ses;
    ses = session.fromPartition('persist:c-' + id);
    sessions.set(id, ses);
    setupSession(ses, id);
    return ses;
  }

  function ui() {
    if (uiSession) return uiSession;
    uiSession = session.fromPartition(UI_PARTITION);
    handleProtocol(uiSession, true);
    try { uiSession.setSpellCheckerEnabled(false); } catch (_) {}
    const allowUi = (wc, permission) => TRUSTED_ALLOW.has(permission);
    uiSession.setPermissionRequestHandler((wc, permission, cb) => cb(allowUi(wc, permission)));
    uiSession.setPermissionCheckHandler((wc, permission) => allowUi(wc, permission));
    return uiSession;
  }

  function onSession(fn) {
    hooks.push(fn);
    for (const [id, ses] of sessions) {
      try { fn(ses, id); } catch (e) { ctx.log('sessions', 'onSession hook:', e); }
    }
    return () => { const i = hooks.indexOf(fn); if (i >= 0) hooks.splice(i, 1); };
  }

  function setPreloadPath(p) {
    preloadPath = p;
    for (const ses of sessions.values()) registerPreload(ses);
  }

  function applyUserAgent() {
    const ua = userAgent();
    for (const ses of sessions.values()) ses.setUserAgent(ua, ACCEPT_LANGUAGES);
  }

  ctx.settings.on('change', (p) => {
    if (p === 'privacy' || p.startsWith('privacy.userAgent') || p.startsWith('privacy.customUA')) applyUserAgent();
  });

  return {
    get,
    ui,
    onSession,
    containers,
    container,
    normalizeId,
    exists,
    resolve,
    setMissingHandler(fn) { missingHandler = typeof fn === 'function' ? fn : null; },
    partition: (id) => 'persist:c-' + normalizeId(id),
    all: () => Array.from(sessions, ([id, ses]) => ({ id, session: ses })),
    idOf(ses) { for (const [id, s] of sessions) if (s === ses) return id; return null; },
    userAgent,
    chromeUserAgent,
    acceptLanguages: ACCEPT_LANGUAGES,
    setPreloadPath,
    addVendor(pkg) { VENDOR.add(String(pkg)); },
    INTERNAL_HOSTS,
  };
}

module.exports = { createSessions, INTERNAL_HOSTS, UI_PARTITION, CSP, chromeUserAgent };
