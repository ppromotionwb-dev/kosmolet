'use strict';
// Dev-управление (ARCHITECTURE §2): только с --dev, только 127.0.0.1.
// GET /health, GET /logs, POST /eval {code}, POST /shot {file?}, POST /quit.

const http = require('http');
const fs = require('fs');
const path = require('path');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const BODY_LIMIT = 8 * 1024 * 1024;

// JSON без падений на циклах, BigInt, Buffer, webContents и т.п.
function toJSONSafe(value, depth = 0, seen = new WeakSet()) {
  if (value === undefined) return null;
  if (value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return `[function ${value.name || ''}]`;
  if (typeof value === 'symbol') return value.toString();
  if (value instanceof Error) return { error: value.message, stack: value.stack };
  if (Buffer.isBuffer(value)) return { buffer: value.length };
  if (depth > 8) return '[глубоко]';
  if (seen.has(value)) return '[цикл]';
  seen.add(value);
  const name = value.constructor && value.constructor.name;
  if (name === 'WebContents') return { webContentsId: value.id, url: value.isDestroyed() ? null : value.getURL() };
  if (name === 'BrowserWindow') return { browserWindowId: value.id };
  if (name === 'WebContentsView' || name === 'View') return { view: name };
  if (name === 'Session') return { session: true };
  if (name === 'NativeImage') return { nativeImage: value.getSize() };
  if (value instanceof Map) return toJSONSafe(Object.fromEntries(value), depth + 1, seen);
  if (value instanceof Set) return toJSONSafe(Array.from(value), depth + 1, seen);
  if (Array.isArray(value)) return value.map((v) => toJSONSafe(v, depth + 1, seen));
  if (typeof value.toJSON === 'function') { try { return toJSONSafe(value.toJSON(), depth + 1, seen); } catch (_) { /* дальше */ } }
  const out = {};
  for (const k of Object.keys(value)) {
    if (k.startsWith('_')) continue;
    try { out[k] = toJSONSafe(value[k], depth + 1, seen); } catch (e) { out[k] = '[ошибка: ' + e.message + ']'; }
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > BODY_LIMIT) { reject(new Error('слишком большое тело запроса')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try { resolve(JSON.parse(text)); } catch (e) { reject(new Error('тело должно быть JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

// Наложить bitmap src (BGRA) на dst в точке (x, y) с альфа-смешиванием.
function blit(dst, dw, dh, src, sw, sh, x, y) {
  for (let j = 0; j < sh; j++) {
    const dy = y + j;
    if (dy < 0 || dy >= dh) continue;
    for (let i = 0; i < sw; i++) {
      const dx = x + i;
      if (dx < 0 || dx >= dw) continue;
      const s = (j * sw + i) * 4;
      const d = (dy * dw + dx) * 4;
      const a = src[s + 3];
      if (a === 255) { dst[d] = src[s]; dst[d + 1] = src[s + 1]; dst[d + 2] = src[s + 2]; dst[d + 3] = 255; } else if (a > 0) {
        const k = a / 255;
        dst[d] = src[s] * k + dst[d] * (1 - k);
        dst[d + 1] = src[s + 1] * k + dst[d + 1] * (1 - k);
        dst[d + 2] = src[s + 2] * k + dst[d + 2] * (1 - k);
        dst[d + 3] = 255;
      }
    }
  }
}

function createDevServer(ctx) {
  const { desktopCapturer, nativeImage, screen } = ctx.electron;
  const port = ctx.flags.devPort;
  let server = null;

  async function shotDesktop(win) {
    const id = win.getMediaSourceId();
    const b = win.getBounds();
    const scale = screen.getDisplayMatching(b).scaleFactor || 1;
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: Math.round(b.width * scale), height: Math.round(b.height * scale) },
      fetchWindowIcons: false,
    });
    const src = sources.find((s) => s.id === id);
    if (!src || src.thumbnail.isEmpty()) throw new Error('окно не найдено среди источников desktopCapturer');
    return src.thumbnail;
  }

  // Запасной путь: собрать картинку из capturePage окна и видов.
  async function shotComposite(win) {
    const [W, H] = win.getContentSize();
    const base = await win.webContents.capturePage();
    const bs = base.getSize();
    const scale = bs.width / W || 1;
    const dw = bs.width;
    const dh = bs.height;
    const dst = Buffer.from(base.toBitmap());
    for (const v of win.contentView.children) {
      if (!v.webContents || !v.getVisible()) continue;
      const r = v.getBounds();
      if (r.width < 2 || r.height < 2) continue;
      let img;
      try { img = await v.webContents.capturePage(); } catch (_) { continue; }
      if (img.isEmpty()) continue;
      const target = img.resize({ width: Math.round(r.width * scale), height: Math.round(r.height * scale) });
      const s = target.getSize();
      blit(dst, dw, dh, target.toBitmap(), s.width, s.height, Math.round(r.x * scale), Math.round(r.y * scale));
    }
    return nativeImage.createFromBitmap(dst, { width: dw, height: dh, scaleFactor: scale });
  }

  async function shot(file) {
    const win = ctx.windows.main;
    if (!win || win.isDestroyed()) throw new Error('нет окна');
    if (!win.isVisible()) win.showInactive();
    let img = null;
    let method = 'desktopCapturer';
    try { img = await shotDesktop(win); } catch (e) {
      ctx.log('dev', 'desktopCapturer:', e.message, '— запасной путь capturePage');
      method = 'capturePage';
      img = await shotComposite(win);
    }
    const out = file ? path.resolve(ctx.paths.root, file) : path.join(ctx.paths.devOut, `shot-${Date.now()}.png`);
    await fs.promises.mkdir(path.dirname(out), { recursive: true });
    await fs.promises.writeFile(out, img.toPNG());
    return { file: out, size: img.getSize(), method };
  }

  async function handle(req, res) {
    // Только локальные запросы без Origin (защита от страниц в браузере и DNS-rebinding).
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    if (!['127.0.0.1', 'localhost'].includes(host) || req.headers.origin) return send(res, 403, { error: 'запрещено' });
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, {
          ok: true, pid: process.pid, ready: !!ctx.ready, profile: ctx.flags.profile || null, userData: ctx.paths.userData,
          devPort: port, cdpPort: ctx.flags.cdpPort || null, mcpPort: ctx.settings.peek('claude.mcpPort'),
          featureErrors: ctx.featureErrors.map((e) => ({ id: e.id, phase: e.phase, message: e.message })),
        });
      }
      if (req.method === 'GET' && url.pathname === '/logs') {
        const n = Math.min(1000, Number(url.searchParams.get('n')) || 200);
        return send(res, 200, { logs: ctx.logs.slice(-n) });
      }
      if (req.method !== 'POST') return send(res, 404, { error: 'нет такого пути' });
      if (!/application\/json/i.test(String(req.headers['content-type'] || ''))) return send(res, 415, { error: 'нужен content-type: application/json' });
      const body = await readBody(req);
      if (url.pathname === '/eval') {
        const code = String(body.code || '');
        try {
          const fn = new AsyncFunction('ctx', 'electron', 'require', code);
          const result = await fn(ctx, ctx.electron, require);
          return send(res, 200, { result: toJSONSafe(result) });
        } catch (e) {
          return send(res, 200, { error: e && e.message ? e.message : String(e), stack: e && e.stack });
        }
      }
      if (url.pathname === '/shot') return send(res, 200, await shot(body.file));
      if (url.pathname === '/quit') {
        send(res, 200, { ok: true });
        setTimeout(() => ctx.app.quit(), 50);
        return undefined;
      }
      return send(res, 404, { error: 'нет такого пути' });
    } catch (e) {
      return send(res, 500, { error: e.message, stack: e.stack });
    }
  }

  function start() {
    server = http.createServer((req, res) => { handle(req, res).catch((e) => send(res, 500, { error: e.message })); });
    server.on('error', (e) => ctx.log('dev', 'dev-сервер:', e.message));
    server.listen(port, '127.0.0.1', () => ctx.log('dev', `dev-сервер: http://127.0.0.1:${port}`));
    return server;
  }

  function stop() { if (server) { server.close(); server = null; } }

  return { start, stop, shot, toJSONSafe };
}

module.exports = { createDevServer, toJSONSafe };
