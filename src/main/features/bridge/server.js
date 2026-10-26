'use strict';
// HTTP-сервер MCP (claude-bridge): Streamable HTTP, stateless (новый McpServer+транспорт на запрос), JSON-ответы.
// Слушает только 127.0.0.1:<port>/mcp. Защита: Host только 127.0.0.1/localhost:<port>; любой заголовок Origin — 403
// (сайты и DNS-rebinding); Authorization: Bearer <token> (timingSafeEqual) — иначе 401; тело ≤ 2 МБ.
// SDK (@modelcontextprotocol/sdk + zod, ~0,6 с) подгружается при первом запросе, а не на старте браузера.

const http = require('http');
const crypto = require('crypto');

const BODY_LIMIT = 2 * 1024 * 1024;

function sha(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest(); }

function createServer(ctx, opts) {
  // opts: { getConfig() → {enabled, port, token}, buildServer({agent}) → McpServer, onState(state) }
  let server = null;
  let port = 0;
  let listening = false;
  let error = '';
  let sdk = null;
  let starting = null;
  let requests = 0;

  function loadSdk() {
    if (sdk) return sdk;
    const t0 = Date.now();
    const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
    sdk = { StreamableHTTPServerTransport };
    ctx.log('bridge', `MCP SDK загружен за ${Date.now() - t0} мс`);
    return sdk;
  }

  function json(res, status, obj, headers) {
    // Непрочитанное тело запроса — дочитать в никуда, иначе клиент получит RST вместо ответа.
    if (res.req && !res.req.complete) res.req.resume();
    if (res.headersSent) { try { res.end(); } catch (_) { /* закрыт */ } return; }
    const body = JSON.stringify(obj);
    res.writeHead(status, Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, headers || {}));
    res.end(body);
  }
  function rpcError(res, status, code, message) {
    json(res, status, { jsonrpc: '2.0', error: { code, message }, id: null });
  }

  function checkAuth(req, token) {
    const h = req.headers.authorization;
    if (typeof h !== 'string' || !token) return false;
    const m = /^Bearer\s+(.+)$/i.exec(h.trim());
    if (!m) return false;
    return crypto.timingSafeEqual(sha(m[1].trim()), sha(token));
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const len = Number(req.headers['content-length']);
      if (len > BODY_LIMIT) { const e = new Error('body too large'); e.status = 413; reject(e); return; }
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > BODY_LIMIT) {
          const e = new Error('body too large'); e.status = 413;
          reject(e);
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function handle(req, res) {
    const cfg = opts.getConfig();
    // 1) Host: только наш адрес (защита от DNS-rebinding).
    const host = String(req.headers.host || '').toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      return json(res, 403, { error: 'forbidden host' });
    }
    // 2) Origin: браузерные запросы (сайты) не принимаем вовсе.
    if (req.headers.origin !== undefined) return json(res, 403, { error: 'forbidden origin' });
    const path = String(req.url || '').split('?')[0];
    if (path !== '/mcp' && path !== '/mcp/') return json(res, 404, { error: 'not found' });
    // 3) Токен.
    if (!checkAuth(req, cfg.token)) return json(res, 401, { error: 'unauthorized: Authorization: Bearer <token> required' });
    if (req.method !== 'POST') {
      // stateless: без SSE-потока и сессий
      return json(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }, { allow: 'POST' });
    }
    let raw;
    try { raw = await readBody(req); } catch (e) {
      return json(res, e.status || 400, { error: e.status === 413 ? 'request body too large (limit 2 MB)' : 'bad request body' });
    }
    let body;
    try { body = raw ? JSON.parse(raw) : undefined; } catch (_) { return rpcError(res, 400, -32700, 'Parse error'); }
    requests++;
    const { StreamableHTTPServerTransport } = loadSdk();
    // Какой агент пришёл: Codex подписывается «codex-mcp-client/<версия>» (docs/codex-research.md), Claude Code — «claude…».
    const ua = String(req.headers['user-agent'] || '');
    const agent = /codex/i.test(ua) ? 'codex' : /claude/i.test(ua) ? 'claude' : 'agent';
    const mcp = opts.buildServer({ agent });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close().catch(() => {});
      mcp.close().catch(() => {});
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  function onRequest(req, res) {
    handle(req, res).catch((e) => {
      ctx.log('bridge', 'ошибка запроса MCP:', e);
      if (!res.headersSent) rpcError(res, 500, -32603, 'Internal error: ' + (e && e.message));
      else { try { res.end(); } catch (_) { /* закрыт */ } }
    });
  }

  function state() {
    return { listening, port, error, requests };
  }
  function emit() { try { opts.onState(state()); } catch (e) { ctx.log('bridge', e); } }

  function stop() {
    return new Promise((resolve) => {
      const s = server;
      server = null;
      listening = false;
      if (!s) { resolve(); return; }
      s.close(() => resolve());
      try { s.closeAllConnections(); } catch (_) { /* старый node */ }
      setTimeout(resolve, 500);
    });
  }

  function listen(p) {
    return new Promise((resolve) => {
      const s = http.createServer(onRequest);
      s.keepAliveTimeout = 5000;
      s.headersTimeout = 15000;
      s.requestTimeout = 0; // долгие инструменты (wait_for, загрузка страниц) — не обрывать
      s.on('error', (e) => {
        listening = false;
        error = e.code === 'EADDRINUSE' ? `порт ${p} занят` : (e.message || String(e));
        ctx.log('bridge', `MCP-сервер не запущен на ${p}:`, error);
        if (server === s) server = null;
        resolve(false);
      });
      s.listen(p, '127.0.0.1', () => {
        server = s;
        listening = true;
        error = '';
        ctx.log('bridge', `MCP-сервер слушает http://127.0.0.1:${p}/mcp`);
        resolve(true);
      });
    });
  }

  // Привести сервер к настройкам (включён/порт). Вызывается при старте и при смене настроек.
  async function apply() {
    if (starting) { await starting.catch(() => {}); }
    starting = (async () => {
      const cfg = opts.getConfig();
      if (!cfg.enabled) {
        if (server) { await stop(); ctx.log('bridge', 'MCP-сервер выключен'); }
        port = cfg.port; error = '';
        emit();
        return;
      }
      if (server && listening && port === cfg.port) { emit(); return; }
      if (server) await stop();
      port = cfg.port;
      await listen(cfg.port);
      emit();
    })();
    try { await starting; } finally { starting = null; }
  }

  return {
    apply, stop, state, loadSdk,
    get listening() { return listening; },
    get port() { return port; },
    get error() { return error; },
  };
}

module.exports = { createServer, BODY_LIMIT };
