// Проверка фичи site-intel (каталог API, привязка к действиям, MCP-инструменты, заметки, режим read).
//   node tools/site-intel-test.mjs [devPort] [profile]              — основной прогон (нужен dev-экземпляр, --no-restore)
//   node tools/site-intel-test.mjs [devPort] [profile] --persist     — после перезапуска: знания и заметка на месте
// Поднимает локальный сайт на 127.0.0.1: кнопки и форма дёргают fetch на /api/items/123?page=2&sort=price,
// /api/items/456?page=3, POST /api/cart (JSON, заголовок x-test-token). Клики — через MCP click и через sendInputEvent
// (как пользователь). Секреты в запросах не должны попасть в файл сайта.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const PERSIST = process.argv.includes('--persist');
const DEV = Number(args[0] || 47620);
const PROFILE = args[1] || 'site-intel';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const SECRET_HDR = 'tok_ABCDEF1234567890abcdefSECRET';
const SECRET_Q = 'abcd1234efgh5678ijkl9012mnop';
const SECRET_NAME = 'Кроссовки-Секретное-Имя';

async function ev(code) {
  const r = await fetch(`http://127.0.0.1:${DEV}/eval`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  const j = await r.json();
  if (j.error) throw new Error('eval: ' + j.error);
  return j.result;
}
const fail = (o) => ({ __fail: o });
async function check(name, fn) {
  try {
    const r = await fn();
    const bad = r === false || (r && typeof r === 'object' && '__fail' in r);
    results.push([bad ? 'FAIL' : 'ok', name, r === true || r === false ? '' : JSON.stringify(bad ? r.__fail : r).slice(0, 400)]);
  } catch (e) { results.push(['FAIL', name, e.message.slice(0, 400)]); }
}
const until = async (code, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(code)) return true; await sleep(150); } return false; };

// ---------- MCP ----------
const gen = JSON.parse(fs.readFileSync(path.join(ROOT, '.profiles', PROFILE, 'gen', 'claude-mcp.json'), 'utf8')).mcpServers.kosmolet;
const token = String(gen.headers.Authorization).replace(/^Bearer\s+/i, '');
const client = new Client({ name: 'site-intel-test', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(gen.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
async function mcp(tool, a = {}) {
  const r = await client.callTool({ name: tool, arguments: a }, undefined, { timeout: 60000 });
  const text = (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  return { text, error: !!r.isError };
}

function report() {
  const bad = results.filter((r) => r[0] !== 'ok').length;
  for (const r of results) console.log(`${r[0] === 'ok' ? 'ok  ' : 'FAIL'} ${r[1]}${r[2] ? ' — ' + r[2] : ''}`);
  console.log(`\n${results.length - bad}/${results.length} проверок пройдено`);
  process.exitCode = bad ? 1 : 0;
}

if (PERSIST) {
  await check('после перезапуска: каталог 127.0.0.1 на месте', async () => {
    const c = await ev(`return ctx.siteIntel.catalog('127.0.0.1')`);
    return c.total >= 3 ? { total: c.total } : fail(c);
  });
  await check('после перезапуска: заметка на месте', async () => {
    const n = await ev(`return ctx.siteIntel.notes('127.0.0.1')`);
    return n.some((x) => x.tags.includes('persist')) ? { notes: n.length } : fail(n);
  });
  await check('после перезапуска: site_api_catalog по сайту', async () => {
    const r = await mcp('site_api_catalog', { site: '127.0.0.1' });
    return /\/api\/items\/\{id\}/.test(r.text) ? true : fail(r.text);
  });
  await client.close();
  report();
} else {
  // ---------- тестовый сайт ----------
  const PAGE = `<!doctype html><meta charset="utf-8"><title>site-intel test</title>
<body>
<button id="b1" onclick="loadItem(123, 2)">Товар 123</button>
<button id="b2" onclick="loadItem2()">Товар 456</button>
<form id="cart"><input name="qty" value="2" aria-label="Количество"><button id="buy" type="submit">В корзину</button></form>
<select id="sort" aria-label="Сортировка" onchange="sortBy(this.value)"><option value="price">По цене</option><option value="name">По имени</option></select>
<div id="log"></div>
<script>
const TOKEN = ${JSON.stringify(SECRET_HDR)};
function log(s) { document.getElementById('log').textContent += s + ' '; }
function loadItem(id, page) { return fetch('/api/items/' + id + '?page=' + page + '&sort=price', { headers: { 'x-test-token': TOKEN } }).then(r => r.json()).then(j => log('item' + j.id)); }
function loadItem2() { return fetch('/api/items/456?page=3&sort=price&access_token=${SECRET_Q}', { headers: { 'x-test-token': TOKEN } }).then(r => r.json()).then(j => log('item' + j.id)); }
function sortBy(v) { return fetch('/api/items/789?page=1&sort=' + v, { headers: { 'x-test-token': TOKEN } }).then(r => r.json()); }
document.getElementById('cart').addEventListener('submit', (e) => {
  e.preventDefault();
  fetch('/api/cart', { method: 'POST', headers: { 'content-type': 'application/json', 'x-test-token': TOKEN }, body: JSON.stringify({ sku: 123, qty: 2, opts: { gift: true, note: 'секретная записка' } }) }).then(r => r.json()).then(() => log('cart'));
});
setTimeout(() => fetch('/api/config').then(r => r.json()), 50);
</script>`;
  const site = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = (o) => { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); };
    if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE); return; }
    let m;
    if ((m = /^\/api\/items\/(\d+)$/.exec(u.pathname))) return json({ id: Number(m[1]), name: SECRET_NAME, price: 1990, tags: ['a', 'b'], seller: { id: 7, name: 'Продавец', rating: 4.8 }, sizes: [{ size: '42', stock: 3 }] });
    if (u.pathname === '/api/cart' && req.method === 'POST') { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => json({ ok: true, items: [{ sku: 123, qty: 2 }], total: 3980 })); return; }
    if (u.pathname === '/api/config') return json({ flags: { newCart: true }, version: '1.2.3' });
    res.writeHead(404); res.end('nf');
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const PORT = site.address().port;
  const BASE = `http://127.0.0.1:${PORT}`;
  const HOST = `127.0.0.1:${PORT}`;

  await ev(`ctx.settings.set('claude.access', 'full'); ctx.settings.set('siteIntel.enabled', true); return true`);
  // чистый старт для сайта 127.0.0.1
  await ev(`ctx.siteIntel.forget('127.0.0.1'); return true`);
  const tabId = await ev(`const t = ctx.tabs.create({ url: ${JSON.stringify(BASE + '/')}, active: true }); return t.id`);
  await until(`const t = ctx.tabs.get(${tabId}); return t && t.wc && !t.wc.isLoading() && t.wc.getURL().startsWith('http')`);
  await sleep(800);

  // клик как пользователь: sendInputEvent по центру элемента
  async function userClick(sel) {
    const r = await ev(`const t = ctx.tabs.get(${tabId}); return await t.wc.executeJavaScript('(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()')`);
    await ev(`const t = ctx.tabs.get(${tabId}); const wc = t.wc; const z = wc.getZoomFactor();
      wc.sendInputEvent({ type: 'mouseMove', x: Math.round(${r.x} * z), y: Math.round(${r.y} * z) });
      wc.sendInputEvent({ type: 'mouseDown', x: Math.round(${r.x} * z), y: Math.round(${r.y} * z), button: 'left', clickCount: 1 });
      wc.sendInputEvent({ type: 'mouseUp', x: Math.round(${r.x} * z), y: Math.round(${r.y} * z), button: 'left', clickCount: 1 });
      return true`);
  }

  await check('MCP click по «Товар 123»', async () => { const r = await mcp('click', { tabId, selector: '#b1' }); return r.error ? fail(r.text) : true; });
  await sleep(2300);
  await check('клик пользователя по «Товар 456» (sendInputEvent)', async () => { await userClick('#b2'); return true; });
  await sleep(2300);
  await check('отправка формы пользователем (клик по «В корзину»)', async () => { await userClick('#buy'); return true; });
  await sleep(2300);
  await check('MCP select_option «По имени»', async () => { const r = await mcp('select_option', { tabId, selector: '#sort', value: 'name' }); return r.error ? fail(r.text) : true; });
  await sleep(2600);
  await ev(`ctx.siteIntel.flush(); return true`);

  const cat = await ev(`return ctx.siteIntel.catalog('127.0.0.1')`);
  const keyItems = `GET ${HOST}/api/items/{id}`;
  const keyCart = `POST ${HOST}/api/cart`;
  const ep = await ev(`return ctx.siteIntel.endpoint('127.0.0.1', ${JSON.stringify(keyItems)})`);
  const cart = await ev(`return ctx.siteIntel.endpoint('127.0.0.1', ${JSON.stringify(keyCart)})`);

  await check('сайт = регистрируемый домен (seller.wildberries.ru → wildberries.ru)', async () => {
    const r = await ev(`return [ctx.siteIntel.siteOf('seller.wildberries.ru'), ctx.siteIntel.siteOf('https://www.wildberries.ru/catalog'), ctx.siteIntel.siteOf('${HOST}')]`);
    return r[0] === 'wildberries.ru' && r[1] === 'wildberries.ru' && r[2] === '127.0.0.1' ? r : fail(r);
  });
  await check('каталог: эндпоинты items/{id}, cart, config', async () => {
    const keys = cat.items.map((x) => x.key);
    return keys.includes(keyItems) && keys.includes(keyCart) && keys.includes(`GET ${HOST}/api/config`) ? keys : fail(keys);
  });
  await check('шаблон пути: 123/456/789 → {id}, ×3', async () => (ep && ep.count >= 3 && ep.path === '/api/items/{id}' ? { count: ep.count } : fail(ep && { count: ep.count, path: ep.path })));
  await check('query: page меняется (число), sort с примерами', async () => {
    const p = ep.params.find((x) => x.name === 'page');
    const s = ep.params.find((x) => x.name === 'sort');
    return p && p.varies && p.type === 'number' && p.examples.includes('2') && p.examples.includes('3') && s && s.examples.includes('price') ? { page: p, sort: s } : fail(ep.params);
  });
  await check('маскировка: access_token скрыт', async () => {
    const t = ep.params.find((x) => x.name === 'access_token');
    return t && t.masked && t.examples.every((x) => /^‹hidden/.test(x)) ? t : fail(t);
  });
  await check('заголовки: x-test-token (только имя), авторизация — токен в заголовке', async () => (ep.headers.some((h) => h.name === 'x-test-token') && /x-test-token/.test(ep.auth) ? { auth: ep.auth } : fail({ headers: ep.headers, auth: ep.auth })));
  await check('схема ответа items: seller.rating, sizes[], без значений', async () => (/seller: \{[\s\S]*rating: number/.test(ep.resSchema) && /sizes: Array<\{/.test(ep.resSchema) && !ep.resSchema.includes('Продавец') ? true : fail(ep.resSchema)));
  await check('схема тела POST /api/cart: sku number, opts.gift boolean', async () => (cart && /sku: number/.test(cart.reqSchema) && /gift: boolean/.test(cart.reqSchema) && cart.reqType === 'application/json' && /total: number/.test(cart.resSchema) ? true : fail(cart)));
  await check('файл сайта без секретов и значений', async () => {
    const file = await ev(`return require('path').join(ctx.siteIntel.dir, '127.0.0.1.json')`);
    const text = fs.readFileSync(file, 'utf8');
    const leaks = [SECRET_HDR, SECRET_Q, SECRET_NAME, 'секретная записка', 'Продавец', '1990', '3980'].filter((s) => text.includes(s));
    return leaks.length ? fail(leaks) : { bytes: text.length };
  });
  await check('действие Claude: «Товар 123» → items (claude)', async () => {
    const a = ep.actions.find((x) => x.label === 'Товар 123');
    return a && a.claude >= 1 ? a : fail(ep.actions);
  });
  await check('действие пользователя: «Товар 456» → items (user)', async () => {
    const a = ep.actions.find((x) => x.label === 'Товар 456');
    return a && a.user >= 1 && !a.claude ? a : fail(ep.actions);
  });
  await check('действие пользователя: «В корзину» → POST cart', async () => {
    const a = cart.actions.find((x) => x.label === 'В корзину');
    return a && a.user >= 1 ? a : fail(cart.actions);
  });
  await check('select_option Claude → items (sort=name)', async () => {
    const a = ep.actions.find((x) => /name|По имени|Сортировка/.test(x.label));
    return a && a.claude >= 1 ? a : fail(ep.actions);
  });
  await check('config при загрузке не привязан к действиям', async () => {
    const c = await ev(`return ctx.siteIntel.endpoint('127.0.0.1', 'GET ${HOST}/api/config')`);
    return c && !c.actions.length ? true : fail(c && c.actions);
  });
  await check('инициатор: JS-стек сохранён (до 5 кадров)', async () => {
    const r = await ev(`const l = ctx.cdp.network(${tabId}, { filter: '/api/cart' }); const e = l[l.length - 1]; return e && e.initiator`);
    return r && Array.isArray(r.stack) && r.stack.length >= 1 && r.stack.length <= 5 && r.url ? r.stack.map((f) => f.fn + ':' + f.line) : fail(r);
  });

  // ---------- MCP-инструменты ----------
  const list = await client.listTools();
  await check('MCP: инструменты site-intel в списке', async () => {
    const names = list.tools.map((t) => t.name);
    const need = ['site_api_catalog', 'site_api_endpoint', 'request_initiator', 'recent_actions', 'site_notes', 'site_note_add', 'site_note_remove'];
    const miss = need.filter((n) => !names.includes(n));
    return miss.length ? fail(miss) : true;
  });
  await check('MCP: INSTRUCTIONS упоминают каталог и заметки', async () => { const i = client.getInstructions() || ''; return /site_api_catalog/.test(i) && /site_note_add/.test(i) ? true : fail(i.slice(0, 200)); });
  await check('MCP site_api_catalog {} (активная вкладка)', async () => {
    const r = await mcp('site_api_catalog', {});
    return !r.error && /GET 127\.0\.0\.1:\d+ \/api\/items\/\{id\}\?page=\{n\}&sort=\{q\}/.test(r.text) && /by: «Товар/.test(r.text) && /auth: x-test-token/.test(r.text) ? r.text.split('\n').slice(0, 3) : fail(r.text);
  });
  await check('MCP site_api_catalog filter+method', async () => {
    const r = await mcp('site_api_catalog', { site: '127.0.0.1', method: 'POST' });
    return !r.error && /POST .*\/api\/cart/.test(r.text) && !/GET /.test(r.text.split('\n').slice(1).join('\n')) ? true : fail(r.text);
  });
  await check('MCP site_api_endpoint {key}', async () => {
    const r = await mcp('site_api_endpoint', { key: keyItems });
    return !r.error && /Response schema/.test(r.text) && /page_fetch \{/.test(r.text) && /x-test-token/.test(r.text) && /network_request \{"tabId"/.test(r.text) && !r.text.includes(SECRET_HDR) ? r.text.split('\n').length + ' строк' : fail(r.text);
  });
  await check('MCP site_api_endpoint {index: 1}', async () => { const r = await mcp('site_api_endpoint', { index: 1 }); return !r.error && /^#1 /.test(r.text) ? true : fail(r.text); });
  await check('MCP request_initiator (cart → «В корзину», стек)', async () => {
    const id = await ev(`const l = ctx.cdp.network(${tabId}, { filter: '/api/cart' }); return l[l.length - 1].id`);
    const r = await mcp('request_initiator', { tabId, id });
    return !r.error && /Action: user (click|submit) «В корзину»/.test(r.text) && /JS stack/.test(r.text) ? r.text.split('\n').slice(0, 4) : fail(r.text);
  });
  await check('MCP recent_actions', async () => {
    const r = await mcp('recent_actions', { tabId });
    return !r.error && /claude click «Товар 123»/.test(r.text) && /user click «Товар 456»/.test(r.text) && /\/api\/items\//.test(r.text) ? true : fail(r.text);
  });
  let noteId = '';
  await check('MCP site_note_add / site_notes', async () => {
    const a = await mcp('site_note_add', { text: 'Товары: GET /api/items/{id}?page=N, нужен x-test-token', tags: ['api', 'persist'] });
    noteId = (/\[(n[a-z0-9]+)\]/.exec(a.text) || [])[1] || '';
    const r = await mcp('site_notes', {});
    return !a.error && noteId && r.text.includes(noteId) && /claude/.test(r.text) && /tags: api, persist/.test(r.text) ? true : fail([a.text, r.text]);
  });
  await check('MCP site_note_remove', async () => {
    const a = await mcp('site_note_add', { text: 'временная', tags: ['tmp'] });
    const id = (/\[(n[a-z0-9]+)\]/.exec(a.text) || [])[1];
    const r = await mcp('site_note_remove', { id });
    const n = await ev(`return ctx.siteIntel.notes('127.0.0.1').map(x => x.id)`);
    return !r.error && !n.includes(id) && n.includes(noteId) ? true : fail([r.text, n]);
  });
  await check('MCP заметка: слишком длинная — ошибка', async () => { const r = await mcp('site_note_add', { text: 'x'.repeat(2001) }); return r.error ? true : fail(r.text); });
  await check('MCP подсказка в tabs_list / page_info / snapshot', async () => {
    const a = await mcp('tabs_list', {});
    const b = await mcp('page_info', { tabId });
    const c = await mcp('snapshot', { tabId, mode: 'interactive' });
    const re = /Site knowledge \(127\.0\.0\.1\): \d+ API endpoints, 1 note — see site_api_catalog \/ site_notes/;
    return re.test(a.text) && re.test(b.text) && re.test(c.text) ? true : fail([a.text.slice(-200), b.text.slice(-200), c.text.slice(0, 200)]);
  });

  // ---------- режим read ----------
  await ev(`ctx.settings.set('claude.access', 'read'); return true`);
  await check('режим read: каталог и заметки работают, click запрещён', async () => {
    const a = await mcp('site_api_catalog', {});
    const b = await mcp('site_note_add', { text: 'из режима read', tags: ['tmp'] });
    const id = (/\[(n[a-z0-9]+)\]/.exec(b.text) || [])[1];
    const c = id ? await mcp('site_note_remove', { id }) : { error: true, text: 'нет id' };
    const d = await mcp('click', { tabId, selector: '#b1' });
    return !a.error && !b.error && !c.error && d.error && /read/.test(d.text) ? true : fail([a.text.slice(0, 80), b.text, c.text, d.text]);
  });
  await ev(`ctx.settings.set('claude.access', 'full'); return true`);

  // ---------- недоверенные данные из вкладки ----------
  await check('kosmo-tab:intel.action: обрезка и лимит 5/с', async () => {
    const r = await ev(`const { ipcMain } = require('electron'); const t = ctx.tabs.get(${tabId});
      const before = ctx.siteIntel.recentActions(${tabId}, 50).length;
      const evt = { sender: t.wc, senderFrame: t.wc.mainFrame };
      for (let i = 0; i < 20; i++) ipcMain.emit('kosmo-tab:intel.action', evt, { kind: 'click', label: 'Я'.repeat(500), tag: 'script<x>', role: 'button', sel: 's'.repeat(999) });
      ipcMain.emit('kosmo-tab:intel.action', evt, { kind: 'eval', label: 'x' });
      const all = ctx.siteIntel.recentActions(${tabId}, 50);
      const added = all.slice(before);
      return { added: added.length, label: added[0] && added[0].label.length, tag: added[0] && added[0].tag, sel: added[0] && added[0].sel.length };`);
    return r.added <= 5 && r.added >= 1 && r.label <= 60 && r.tag === '' && r.sel <= 120 ? r : fail(r);
  });

  // ---------- панель «Сайт» (IPC интерфейса) ----------
  await check('IPC summary/endpoint: шаблон fetch', async () => {
    const r = await ev(`const c = ctx.siteIntel.endpoint('127.0.0.1', ${JSON.stringify(keyCart)}); return c.fetchTemplate`);
    return /await fetch\("http:\/\/127\.0\.0\.1:\d+\/api\/cart"/.test(r) && /"x-test-token": "<значение из запроса>"/.test(r) && /"body": "\{\\"sku\\":0/.test(r) ? true : fail(r);
  });
  await check('выключение siteIntel.enabled: новые запросы не пишутся', async () => {
    await ev(`ctx.settings.set('siteIntel.enabled', false); return true`);
    const before = (await ev(`return ctx.siteIntel.endpoint('127.0.0.1', ${JSON.stringify(keyItems)})`)).count;
    await ev(`return await ctx.tabs.get(${tabId}).wc.executeJavaScript('loadItem(999, 9)')`);
    await sleep(900);
    const after = (await ev(`return ctx.siteIntel.endpoint('127.0.0.1', ${JSON.stringify(keyItems)})`)).count;
    await ev(`ctx.settings.set('siteIntel.enabled', true); return true`);
    return before === after ? { before, after } : fail({ before, after });
  });
  await check('исключения: сайт в exclude не пишется', async () => {
    await ev(`ctx.settings.set('siteIntel.exclude', ['127.0.0.1']); return true`);
    const before = (await ev(`return ctx.siteIntel.endpoint('127.0.0.1', ${JSON.stringify(keyItems)})`)).count;
    await ev(`return await ctx.tabs.get(${tabId}).wc.executeJavaScript('loadItem(998, 8)')`);
    await sleep(900);
    const after = (await ev(`return ctx.siteIntel.endpoint('127.0.0.1', ${JSON.stringify(keyItems)})`)).count;
    await ev(`ctx.settings.set('siteIntel.exclude', []); return true`);
    return before === after ? { before, after } : fail({ before, after });
  });

  await ev(`ctx.siteIntel.flush(); return true`);
  const stats = await ev(`return ctx.siteIntel.stats()`);
  console.log('stats:', JSON.stringify(stats));
  await client.close();
  site.close();
  report();
}
