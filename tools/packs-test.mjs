// Регрессия платформы паков (Блоки A и B): node tools/packs-test.mjs [devPort] [profile] [--shots]
// Нужен dev-экземпляр (--dev --no-restore) с профилем profile (MCP — из .profiles/<profile>/gen/claude-mcp.json).
// Пишет тестовый пак во временную папку и проверяет: ошибки проверки манифеста (файл, путь, подсказка), лист прав
// (утверждение только из overlay, отказ из chrome, вкладки и внутренней страницы), включение по контейнерам, сниппет
// пака только на своём хосте и в своём контейнере (в своём мире), умолчания сайтов и приоритет пользователя, scoped-
// захват сети, обновление с листом разницы, откат, отмену, удаление с данными, связанную папку с перезагрузкой,
// scope контейнеров (поля по схеме, чип), agentAccess в мосте (read / ops / off / потолок), маскировку секретов.
// --shots — снимки раздела «Паки», листа прав и чипа в tools/dev-out/<profile>/.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const SHOTS = process.argv.includes('--shots');
const DEV = Number(args[0] || 47630);
const PROFILE = args[1] || 'platform-a';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tools', 'dev-out', PROFILE);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const SECRET_TOKEN = 'tok_SECRET_9f8e7d6c5b4a3210';
const SECRET_SID = 'SID_SECRET_0123456789abcdef';

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
    results.push([bad ? 'FAIL' : 'ok', name, r === true || r === false ? '' : JSON.stringify(bad ? r.__fail : r).slice(0, 500)]);
  } catch (e) { results.push(['FAIL', name, String(e.message).slice(0, 500)]); }
}
const until = async (code, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await ev(code)) return true; } catch (_) { /* повтор */ } await sleep(150); } return false; };
async function shot(name) {
  fs.mkdirSync(OUT, { recursive: true });
  const r = await fetch(`http://127.0.0.1:${DEV}/shot`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file: path.join(OUT, name) }) });
  const t = await r.text();
  try { const j = JSON.parse(t); return j.file || j.path || t; } catch (_) { return t; }
}

// ---------- тестовый сайт ----------
const site = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname.startsWith('/api/')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: u.pathname, auth: req.headers.authorization ? 'yes' : 'no' }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': [`sid=${SECRET_SID}; Path=/; HttpOnly`, 'pub=visible; Path=/'] });
  res.end(`<!doctype html><meta charset="utf-8"><title>shop ${u.pathname}</title><h1>Лавка</h1><button id="buy">Купить</button><input id="q" aria-label="Поиск">
<script>fetch('/api/me', { headers: { Authorization: 'Bearer ${SECRET_TOKEN}' } });</script>`);
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const PORT = site.address().port;
const BASE = `http://127.0.0.1:${PORT}`;
const OTHER = `http://localhost:${PORT}`;

// ---------- тестовый пак ----------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kosmo-packs-test-'));
function writePack(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}
function manifest(over = {}) {
  return Object.assign({
    id: 'test.shop', name: 'Тестовая лавка', version: '0.1.0', engine: { api: 1 }, protect: true,
    permissions: { hosts: ['127.0.0.1'], capabilities: ['ops.read', 'ops.write', 'snippets', 'capture'], readClaims: ['item.list'] },
    contributes: {
      siteDefaults: {
        bangs: [{ key: 'tsh', name: 'Тест-лавка', url: `${BASE}/search?q={q}`, chip: true }],
        bookmarks: [{ title: 'Лавка', url: `${BASE}/` }],
        adblockAllow: ['127.0.0.1'],
        siteThemes: { '127.0.0.1': { enabled: true, engine: 'filter' } },
        capture: ['127.0.0.1'],
      },
      snippets: [{ file: 'snippets/mark.js', match: ['127.0.0.1/*'] }],
      scopeSchema: 'scopes/shop.schema.json', identity: 'scopes/identity.json',
      operations: 'ops/*.op.json', policies: 'policies/*.json',
      agent: { summary: 'Тестовая лавка: правка товаров через операции', claudeMd: 'agent/CLAUDE.fragment.md', skills: 'agent/skills/' },
    },
  }, over);
}
const COMMON = {
  'snippets/mark.js': "document.documentElement.dataset.kpackTest = (document.documentElement.dataset.kpackTest || '') + 'x';\nwindow.__kpackWorld = 'pack';\n",
  'scopes/shop.schema.json': {
    kind: 'shop', title: 'Магазин', label: '{client} · {market}', account: '{account}',
    properties: { client: { type: 'string', title: 'Клиент' }, market: { type: 'string', title: 'Площадка', enum: ['A', 'B'] }, account: { type: 'string', title: 'Кабинет' }, limit: { type: 'number', title: 'Лимит' } },
    required: ['client'],
    rules: { properties: { maxPricePct: { type: 'number', title: 'Макс. изменение цены, %' } } },
  },
  'scopes/identity.json': { source: 'cookie', cookie: 'shop_acc', field: 'fields.account', sessionProbe: { status: [401] } },
  'ops/item.get.op.json': { id: 'item.get', title: 'Товар', host: '127.0.0.1', risk: 'read', request: { method: 'GET', url: '/api/items/{id}' } },
  'ops/item.list.op.json': { id: 'item.list', title: 'Список товаров', host: '127.0.0.1', risk: 'read', request: { method: 'POST', url: '/api/items/search', body: { page: 1 } }, paginate: { kind: 'offset', param: 'page', size: 50, items: '$.items' } },
  'ops/item.update.op.json': {
    id: 'item.update', title: 'Обновить товар', host: '127.0.0.1', risk: 'write', read: 'item.get',
    request: { method: 'POST', url: '/api/items/{id}', headers: { 'X-CSRF': { $cookie: 'csrf' }, 'X-Shop': { $scope: 'fields.account' }, Authorization: { $seen: 'Authorization', maxAgeSec: 600 }, 'X-Token': { $storage: 'local', key: 'token' } }, body: { $from: 'before', $patch: { title: '{title}' } } },
    success: { status: [200], json: { '$.error': false } }, rowErrors: '$.errors[*]', preview: { key: 'id', fields: ['title'], money: [] }, idempotent: true, rate: { perMin: 30 }, retry: { on: [429, 502], max: 3 },
  },
  'policies/limits.json': [{ id: 'price.max', kind: 'maxChangePct', field: 'price', value: { $scope: 'rules.maxPricePct' } }],
  'agent/CLAUDE.fragment.md': '# Тестовая лавка\nПиши только через op_run.\n',
  'agent/skills/bulk-edit/SKILL.md': '---\nname: bulk-edit\ndescription: массовая правка\n---\nТекст скилла.\n',
};
const V1 = writePack(path.join(TMP, 'v1'), Object.assign({ 'kosmo-pack.json': manifest() }, COMMON));
const V2 = writePack(path.join(TMP, 'v2'), Object.assign({}, COMMON, {
  'kosmo-pack.json': manifest({ version: '0.2.0', permissions: { hosts: ['127.0.0.1', 'localhost'], capabilities: ['ops.read', 'ops.write', 'snippets', 'capture'], readClaims: ['item.list'] } }),
  'ops/item.delete.op.json': { id: 'item.delete', title: 'Удалить товар', host: '127.0.0.1', request: { method: 'DELETE', url: '/api/items/{id}' } },
  'agent/CLAUDE.fragment.md': '# Тестовая лавка\nПиши только через op_run. Удаление — только по просьбе.\n',
}));
const V3 = writePack(path.join(TMP, 'v3'), Object.assign({}, COMMON, {
  'kosmo-pack.json': manifest({ version: '0.3.0', permissions: { hosts: ['127.0.0.1', 'localhost'], capabilities: ['ops.read', 'ops.write', 'snippets', 'capture'], readClaims: ['item.list'] } }),
  'ops/item.delete.op.json': { id: 'item.delete', title: 'Удалить товар', host: '127.0.0.1', request: { method: 'DELETE', url: '/api/items/{id}' } },
  'agent/CLAUDE.fragment.md': '# Тестовая лавка\nПиши только через op_run. Удаление — только по просьбе.\n',
  'snippets/mark.js': "document.documentElement.dataset.kpackTest = (document.documentElement.dataset.kpackTest || '') + 'x';\nwindow.__kpackWorld = 'pack';\n// v3\n",
}));
const BAD = writePack(path.join(TMP, 'bad'), {
  'kosmo-pack.json': {
    id: 'BadId', name: 'Плохой', version: '1', engine: { api: 2 },
    permissions: { hosts: ['https://shop.example.test/x'], capabilities: ['snippets', 'teleport'], readClaims: ['item.get'] },
    contributes: { snippets: [{ file: 'snippets/none.js', match: ['other.example.test/*'] }], operations: 'ops/*.op.json', views: {} },
  },
  'ops/item.get.op.json': { id: 'item.get', title: 'Товар', host: 'evil.example.test', request: { method: 'GET', url: '/api/x' } },
});
const DEVDIR = writePack(path.join(TMP, 'dev'), {
  'kosmo-pack.json': { id: 'test.dev', name: 'Пак в разработке', version: '0.0.1', engine: { api: 1 }, permissions: { hosts: ['127.0.0.1'], capabilities: ['snippets'] }, contributes: { snippets: [{ file: 's.js', match: ['127.0.0.1/*'], run: 'manual', name: 'dev-сниппет' }] } },
  's.js': "return document.title;\n",
});

// ---------- MCP ----------
const gen = JSON.parse(fs.readFileSync(path.join(ROOT, '.profiles', PROFILE, 'gen', 'claude-mcp.json'), 'utf8')).mcpServers.kosmolet;
const token = String(gen.headers.Authorization).replace(/^Bearer\s+/i, '');
const client = new Client({ name: 'packs-test', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(gen.url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
async function mcp(tool, a = {}) {
  const r = await client.callTool({ name: tool, arguments: a }, undefined, { timeout: 60000 });
  return { text: (r.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'), error: !!r.isError };
}

// Утвердить/отклонить лист из overlay (как кнопка в окне утверждения).
async function respond(approve) {
  if (!(await until('return !!ctx.packs.pendingSheet()', 15000))) throw new Error('лист прав не появился');
  const id = await ev('return ctx.packs.pendingSheet().id');
  return ev(`let wc = ctx.overlay.webContents(); if (!wc) { ctx.overlay.ensure(); await new Promise((r) => setTimeout(r, 1500)); wc = ctx.overlay.webContents(); }
    for (let i = 0; i < 40 && wc.isLoading(); i++) await new Promise((r) => setTimeout(r, 100));
    return await wc.executeJavaScript(${JSON.stringify(`window.kosmo.invoke('kosmo:packs.sheetRespond', { id: '${id}', approve: ${approve} })`)})`);
}
const startInstall = (dir) => ev(`globalThis.__pk = ctx.packs.installFromFolder(${JSON.stringify(dir)}); globalThis.__pk.then((r) => { globalThis.__pkr = r; }); return true`);
const installResult = () => ev('return await globalThis.__pk');
async function openTab(url, cid) {
  const id = await ev(`return ctx.tabs.create({ url: ${JSON.stringify(url)}, containerId: ${JSON.stringify(cid)}, active: true }).id`);
  await until(`const t = ctx.tabs.get(${id}); return t && t.wc && !t.wc.isLoading() && t.wc.getURL().startsWith('http')`, 15000);
  return id;
}
const pageJs = (id, expr) => ev(`return await ctx.tabs.get(${id}).wc.executeJavaScript(${JSON.stringify(expr)})`);

// чистое состояние
await ev(`for (const id of ['test.shop']) { try { ctx.packs.uninstall(id, { keepData: false }); } catch (_) {} } for (const f of (ctx.settings.get('packs.devFolders') || [])) ctx.packs.unlinkFolder(f); ctx.settings.set('claude.access', 'full'); ctx.settings.set('search.bangs', ctx.settings.get('search.bangs').filter((b) => b.key !== 'tsh')); try { ctx.themes.removeSite('127.0.0.1'); } catch (_) {} ctx.settings.set('packs.hidden', { bangs: [], adblockAllow: [], siteThemes: [] }); return true`);
const C = await ev(`const C = ctx.platform.containers; const a = C.create({ name: 'Лавка А', temp: false }); const b = C.create({ name: 'Лавка Б', temp: false }); return { a: a.id, b: b.id }`);
const tabs = [];

// ===== Блок A: проверка манифеста =====
await check('проверка: ошибки с файлом, путём и подсказкой', async () => {
  const r = await ev(`return await ctx.packs.installFromFolder(${JSON.stringify(BAD)})`);
  const paths = (r.errors || []).map((e) => `${e.file}|${e.path}`);
  const want = ['kosmo-pack.json|id', 'kosmo-pack.json|version', 'kosmo-pack.json|engine.api', 'kosmo-pack.json|permissions.hosts[0]', 'kosmo-pack.json|permissions.capabilities[1]', 'kosmo-pack.json|contributes.views', 'ops/item.get.op.json|host'];
  const missing = want.filter((w) => !paths.includes(w));
  const hint = (r.errors || []).find((e) => e.path === 'permissions.hosts[0]');
  const snippet = (r.errors || []).some((e) => /snippets\/none\.js/.test(e.file + e.message + e.hint));
  return !r.ok && !missing.length && hint && /shop\.example\.test/.test(hint.hint) && snippet && !(await ev('return !!ctx.packs.pendingSheet()'))
    ? { errors: r.errors.length } : fail({ missing, paths });
});
await check('проверка: встроенный стартовый пак валиден и включён', async () => {
  const r = await ev(`return { v: ctx.packs.validateFolder(require('path').join(ctx.paths.root, 'packs', 'builtin', 'marketplaces-starter')), i: ctx.packs.info('kosmolet.marketplaces-starter') }`);
  return r.v.ok && r.i.enabled && r.i.global && r.i.source === 'builtin' ? { phrases: r.v.phrases.length } : fail(r);
});

// ===== лист прав =====
await check('установка: лист прав открыт, права словами', async () => {
  await startInstall(V1);
  if (!(await until('return !!ctx.packs.pendingSheet()', 15000))) return fail('нет листа');
  const p = await ev('return ctx.packs.pendingSheet()');
  const text = p.items.join('\n');
  return p.kind === 'install' && /Отправляет изменения на 127\.0\.0\.1 — только после вашего утверждения/.test(text) && /Считает чтением POST-запросы: Список товаров/.test(text) && /Бэнги в адресной строке: tsh/.test(text)
    ? { items: p.items.length } : fail(p);
});
if (SHOTS) await check('снимок: лист прав', async () => { await ev('ctx.packs.showPending(); return 1'); await sleep(1200); return { file: await shot('pack-sheet.png') }; });
await check('лист прав: отказ из chrome, из вкладки настроек и с сайта', async () => {
  const id = await ev('return ctx.packs.pendingSheet().id');
  const call = `window.kosmo ? window.kosmo.invoke('kosmo:packs.sheetRespond', { id: '${id}', approve: true }).then(() => 'accepted', (e) => 'denied: ' + e.message) : 'no kosmo'`;
  const chrome = await ev(`return await ctx.windows.main.webContents.executeJavaScript(${JSON.stringify(call)})`);
  const sid = await ev(`const t = ctx.tabs.create({ url: 'kosmo://settings/#packs', active: false }); await new Promise((r) => t.wc.once('did-finish-load', r)); return t.id`);
  const settings = await pageJs(sid, call);
  await ev(`ctx.tabs.close(${sid}); return 1`);
  const web = await openTab(BASE + '/x', C.b); // не основной контейнер: cookies тестового сайта не должны остаться в профиле
  const site = await pageJs(web, `typeof window.kosmo`);
  await ev(`ctx.tabs.close(${web}); return 1`);
  const still = await ev('return !!ctx.packs.pendingSheet()');
  return /^denied/.test(chrome) && /^denied/.test(settings) && site === 'undefined' && still ? { chrome: chrome.slice(0, 90), settings: settings.slice(0, 90) } : fail({ chrome, settings, site, still });
});
await check('установка: утверждение из overlay → копия, lock, индекс', async () => {
  const ok = await respond(true);
  const r = await installResult();
  const st = await ev(`const fs = require('fs'), path = require('path'); const l = ctx.store('packs.lock').get().packs['test.shop'];
    const idx = JSON.parse(fs.readFileSync(path.join(ctx.paths.gen, 'packs-index.json'), 'utf8'));
    return { l, copy: fs.existsSync(path.join(ctx.paths.userData, 'packs', 'test.shop', l.treeHash, 'kosmo-pack.json')), inIndex: !!idx.packs['test.shop'], info: ctx.packs.info('test.shop') }`);
  return ok === true && r.ok && st.copy && st.inIndex && st.l.version === '0.1.0' && st.l.granted.readClaims.includes('item.list') && st.info.containers.enabled === 0
    ? { hash: st.l.treeHash, state: st.info.state.text } : fail({ ok, r, st });
});
await check('установка: правка исходной папки ничего не меняет', async () => {
  fs.appendFileSync(path.join(V1, 'snippets', 'mark.js'), '\n// правка исходника\n');
  await sleep(400);
  const r = await ev(`const i = ctx.packs.info('test.shop'); return { dir: i.dir, has: require('fs').readFileSync(require('path').join(i.dir, 'snippets', 'mark.js'), 'utf8').includes('правка исходника') }`);
  return !r.has && !r.dir.startsWith(V1) ? true : fail(r);
});

// ===== включение по контейнерам =====
await check('включение по контейнерам', async () => {
  const r = await ev(`ctx.packs.enableForContainer('test.shop', ${JSON.stringify(C.a)}, true);
    return { a: ctx.packs.isEnabled('test.shop', ${JSON.stringify(C.a)}), b: ctx.packs.isEnabled('test.shop', ${JSON.stringify(C.b)}), main: ctx.packs.isEnabled('test.shop', 'main'), info: ctx.packs.info('test.shop').containers, starterB: ctx.packs.isEnabled('kosmolet.marketplaces-starter', ${JSON.stringify(C.b)}) }`);
  return r.a && !r.b && !r.main && r.info.enabled === 1 && r.starterB ? r.info : fail(r);
});

// ===== сниппет пака =====
await check('сниппет: свой хост и контейнер, свой мир', async () => {
  const t1 = await openTab(BASE + '/a', C.a); tabs.push(t1);
  const ok1 = await until(`return (await ctx.tabs.get(${t1}).wc.executeJavaScript("document.documentElement.dataset.kpackTest || ''")) === 'x'`, 10000);
  const world = await pageJs(t1, 'typeof window.__kpackWorld');
  const t2 = await openTab(OTHER + '/b', C.a); tabs.push(t2);
  const t3 = await openTab(BASE + '/c', C.b); tabs.push(t3);
  await sleep(1500);
  const other = await pageJs(t2, "document.documentElement.dataset.kpackTest || ''");
  const otherCtr = await pageJs(t3, "document.documentElement.dataset.kpackTest || ''");
  const log = await ev(`return ctx.packs.snippetLog(${t1})`);
  return ok1 && world === 'undefined' && other === '' && otherCtr === '' && log && log.entries[0].ok ? { log: log.entries.map((e) => e.pack + '/' + e.file + ' ' + e.ms + 'ms') } : fail({ ok1, world, other, otherCtr, log });
});

// ===== умолчания сайтов =====
await check('умолчания: бэнг, закладка, исключение, тема — из пака', async () => {
  const r = await ev(`return { bang: ctx.search.resolve('tsh чай'), bm: ctx.bookmarks.has(${JSON.stringify(BASE + '/')}), allow: ctx.adblock.status().allowList, theme: ctx.themes.siteConfig(${JSON.stringify(BASE + '/')}) }`);
  return r.bang.kind === 'bang' && r.bang.url.startsWith(BASE + '/search') && r.bm && r.allow.includes('127.0.0.1') && r.theme.enabled && r.theme.params.engine === 'filter' && r.theme.pack === 'test.shop'
    ? true : fail(r);
});
await check('умолчания: пользователь главнее пака, выключение пака не стирает правки', async () => {
  const r = await ev(`const S = ctx.settings;
    S.set('search.bangs', S.get('search.bangs').concat({ key: 'tsh', name: 'Мой', url: 'https://example.com/?q={q}' }));
    ctx.themes.toggleSite('127.0.0.1', false);
    const userWins = ctx.search.resolve('tsh чай').url.startsWith('https://example.com/');
    const themeUser = ctx.themes.siteConfig(${JSON.stringify(BASE + '/')}).enabled;
    ctx.packs.setEnabled('test.shop', false);
    const off = { bang: ctx.search.resolve('tsh чай').url, allow: ctx.adblock.status().allowList.includes('127.0.0.1'), site: !!(S.get('siteThemes.sites') || {})['127.0.0.1'], wbStill: ctx.search.resolve('wb x').kind };
    ctx.packs.setEnabled('test.shop', true);
    S.set('search.bangs', S.get('search.bangs').filter((b) => b.key !== 'tsh'));
    ctx.themes.removeSite('127.0.0.1');
    const back = ctx.search.resolve('tsh чай').url.startsWith(${JSON.stringify(BASE)});
    ctx.packs.hide('bangs', 'tsh', true);
    const hidden = ctx.search.resolve('tsh чай').kind;
    ctx.packs.hide('bangs', 'tsh', false);
    return { userWins, themeUser, off, back, hidden }`);
  return r.userWins && r.themeUser === false && r.off.bang.startsWith('https://example.com/') && !r.off.allow && r.off.site && r.off.wbStill === 'bang' && r.back && r.hidden === 'search' ? true : fail(r);
});
await check('умолчания: щит адресной строки знает исключение пака', async () => {
  // своё исключение localhost тоже покрывает 127.0.0.1 — на время проверки убираем его
  const st = await ev(`const S = ctx.settings; const own = S.get('privacy.adblockAllow'); S.set('privacy.adblockAllow', own.filter((x) => x !== 'localhost'));
    const r = ctx.platform.adblock.tabState(ctx.tabs.get(${tabs[0]}));
    ctx.platform.adblock.setSite('127.0.0.1', true);
    const blocked = ctx.platform.adblock.tabState(ctx.tabs.get(${tabs[0]}));
    const hidden = ctx.settings.get('packs.hidden.adblockAllow');
    ctx.platform.adblock.setSite('127.0.0.1', false);
    const back = ctx.platform.adblock.tabState(ctx.tabs.get(${tabs[0]}));
    S.set('privacy.adblockAllow', own);
    return { allowed: r.allowed, entry: r.allowEntry, blocked: blocked.allowed, hidden, back: back.allowed, own: S.get('privacy.adblockAllow') }`);
  return st.allowed && st.entry === '127.0.0.1' && !st.blocked && st.hidden.includes('127.0.0.1') && st.back && !st.own.includes('127.0.0.1') ? true : fail(st);
});

// ===== захват сети scoped =====
await check('захват scoped: полный буфер только на хосте пака в его контейнере', async () => {
  const r = await ev(`return [${tabs.join(',')}].map((id) => ({ id, mode: ctx.cdp.info(id).mode, tier: ctx.cdp.info(id).tier }))`);
  return r[0].mode === 'scoped' && r[0].tier === 'full' && r[1].tier === 'light' && r[2].tier === 'light' ? r.map((x) => x.tier) : fail(r);
});

// ===== Блок B: scope =====
await check('scope: поля по схеме, ошибки, чип', async () => {
  const bad = await ev(`try { ctx.scopes.patch(${JSON.stringify(C.a)}, { pack: 'test.shop', fields: { market: 'Z' } }); return 'saved'; } catch (e) { return { message: e.message, errors: e.errors }; }`);
  const ok = await ev(`return ctx.scopes.patch(${JSON.stringify(C.a)}, { pack: 'test.shop', fields: { client: 'Лавка', market: 'A', account: '777', limit: '15' }, rules: { maxPricePct: 15 }, mark: 'лв' })`);
  const tab = await ev(`await new Promise((r) => setTimeout(r, 100)); return ctx.tabs.list().find((t) => t.id === ${tabs[0]}).containerChip`);
  const badMsgs = bad.errors ? bad.errors.map((e) => e.path).join(',') : '';
  return /fields\.client/.test(badMsgs) && /fields\.market/.test(badMsgs) && ok.fields.limit === 15 && ok.agentAccess === 'ops' && ok.protect === true && ok.chip.label === 'Лавка · A' && ok.chip.account === '777' && ok.chip.mark === 'ЛВ' && ok.health.state === 'unknown' && tab && tab.label === 'Лавка · A'
    ? { chip: ok.chip } : fail({ bad, ok, tab });
});
await check('scope: чип в адресной строке', async () => {
  await ev(`ctx.tabs.activate(${tabs[0]}); return 1`);
  const ok = await until(`return await ctx.windows.main.webContents.executeJavaScript("(() => { const c = document.querySelector('.kp-container.scoped'); return !!c && !c.hidden && c.querySelector('.kp-cname').textContent === 'Лавка · A' && c.querySelector('.kp-cmark').textContent === 'ЛВ' && c.querySelector('.kp-cacc').textContent === '777'; })()")`, 5000);
  return ok ? true : fail(await ev(`return await ctx.windows.main.webContents.executeJavaScript("document.querySelector('.kp-container') ? document.querySelector('.kp-container').outerHTML : 'нет'")`));
});
if (SHOTS) await check('снимок: чип контейнера', async () => ({ file: await shot('chip.png') }));
await check('scope: IPC только для интерфейса и настроек', async () => {
  const call = `window.kosmo.invoke('kosmo:scopes.get', { id: '${C.a}' }).then((s) => 'ok ' + s.chip.label, (e) => 'denied: ' + e.message)`;
  const s = await ev(`const t = ctx.tabs.create({ url: 'kosmo://settings/', active: false }); await new Promise((r) => t.wc.once('did-finish-load', r)); const v = await t.wc.executeJavaScript(${JSON.stringify(call)}); ctx.tabs.close(t.id); return v`);
  const n = await ev(`const t = ctx.tabs.create({ url: 'kosmo://history/', active: false }); await new Promise((r) => t.wc.once('did-finish-load', r)); const v = await t.wc.executeJavaScript(${JSON.stringify(call)}); ctx.tabs.close(t.id); return v`);
  return /^ok Лавка/.test(s) && /^denied/.test(n) ? true : fail({ s, n });
});

// ===== agentAccess в мосте =====
await check('мост: контейнер ops — отказ «ops-only: use op_run», чтение работает', async () => {
  const t = tabs[0];
  const click = await mcp('click', { tabId: t, selector: '#buy' });
  const typ = await mcp('type', { tabId: t, selector: '#q', text: 'x' });
  const js = await mcp('eval_js', { tabId: t, code: '1+1' });
  const post = await mcp('page_fetch', { tabId: t, url: '/api/items/1', method: 'POST', body: '{}' });
  const get = await mcp('page_fetch', { tabId: t, url: '/api/items/1' });
  const cset = await mcp('cookies_set', { container: C.a, url: BASE, name: 'x', value: '1' });
  const snap = await mcp('snapshot', { tabId: t, mode: 'interactive' });
  const nav = await mcp('navigate', { tabId: t, url: BASE + '/a?nav=1' });
  const bad = [click, typ, js, post, cset].filter((r) => !(r.error && /ops-only: use op_run/.test(r.text)));
  return !bad.length && !get.error && /HTTP 200/.test(get.text) && !snap.error && !nav.error ? true : fail({ bad: bad.map((r) => r.text.slice(0, 120)), get: get.text.slice(0, 80), snap: snap.error, nav: nav.text.slice(0, 80) });
});
await check('мост: read и off по контейнеру, глобальный режим — потолок', async () => {
  const t = tabs[2];
  await ev(`ctx.scopes.patch(${JSON.stringify(C.b)}, { agentAccess: 'read' }); return 1`);
  const rd = await mcp('click', { tabId: t, selector: 'h1' });
  const rdSnap = await mcp('snapshot', { tabId: t, mode: 'text' });
  await ev(`ctx.scopes.patch(${JSON.stringify(C.b)}, { agentAccess: 'off' }); return 1`);
  const off = await mcp('snapshot', { tabId: t });
  const list = await mcp('containers_list', {});
  await ev(`ctx.scopes.patch(${JSON.stringify(C.b)}, { agentAccess: 'full' }); ctx.settings.set('claude.access', 'read'); return 1`);
  const ceiling = await mcp('click', { tabId: t, selector: 'h1' });
  await ev(`ctx.settings.set('claude.access', 'full'); return 1`);
  const full = await mcp('click', { tabId: t, selector: 'h1' });
  return rd.error && /read-only/.test(rd.text) && !rdSnap.error && off.error && /is off/.test(off.text) && ceiling.error && /access mode is "read"/.test(ceiling.text) && !full.error && /agent: ops, protected, Лавка · A · 777/.test(list.text)
    ? true : fail({ rd: rd.text.slice(0, 100), off: off.text.slice(0, 100), ceiling: ceiling.text.slice(0, 100), full: full.text.slice(0, 100), list: list.text });
});
await check('мост: маскировка секретов в защищённом контейнере', async () => {
  const t = tabs[0];
  await ev(`ctx.tabs.reload(${t}); return 1`);
  await until(`const t = ctx.tabs.get(${t}); return t.wc && !t.wc.isLoading()`, 10000);
  await sleep(800);
  const list = await mcp('network_requests', { tabId: t, filter: '/api/me' });
  const id = (/#(\S+) GET/.exec(list.text) || [])[1];
  const req = id ? await mcp('network_request', { tabId: t, id, body: false }) : { text: 'нет запроса: ' + list.text };
  const ck = await mcp('cookies_get', { tabId: t });
  const ckOpen = await mcp('cookies_get', { tabId: tabs[2] });
  const okReq = /‹secret header:authorization›/i.test(req.text) && !req.text.includes(SECRET_TOKEN);
  const okCk = ck.text.includes('‹secret cookie:sid›') && !ck.text.includes(SECRET_SID) && ck.text.includes('pub=visible');
  return okReq && okCk && ckOpen.text.includes(SECRET_SID) ? true : fail({ req: req.text.slice(0, 600), ck: ck.text.slice(0, 300) });
});

// ===== обновление, откат, отмена =====
await check('обновление: лист разницы (новые сайты, операции, инструкции)', async () => {
  await startInstall(V2);
  if (!(await until('return !!ctx.packs.pendingSheet()', 15000))) return fail('нет листа');
  const p = await ev('return ctx.packs.pendingSheet()');
  const text = p.items.join('\n');
  const ok = p.kind === 'update' && p.extended && /Новые сайты: localhost/.test(text) && /Новые необратимые операции: Удалить товар/.test(text) && /Изменились инструкции для Claude/.test(text);
  const resp = await respond(true);
  const r = await installResult();
  const l = await ev(`return ctx.store('packs.lock').get().packs['test.shop']`);
  return ok && resp && r.ok && r.updated && l.version === '0.2.0' && l.history.length === 1 && l.history[0].version === '0.1.0' ? { items: p.items } : fail({ p, r, l });
});
await check('обновление без новых прав — «одной строкой»', async () => {
  await startInstall(V3);
  if (!(await until('return !!ctx.packs.pendingSheet()', 15000))) return fail('нет листа');
  const p = await ev('return ctx.packs.pendingSheet()');
  await respond(true);
  const r = await installResult();
  return !p.extended && /права не расширяются/.test(p.summary) && r.ok && r.pack.version === '0.3.0' ? { summary: p.summary, items: p.items } : fail({ p, r });
});
await check('отмена установки ничего не меняет', async () => {
  await startInstall(V1);
  await respond(false);
  const r = await installResult();
  const v = await ev(`return ctx.packs.info('test.shop').version`);
  return r.cancelled && v === '0.3.0' ? true : fail({ r, v });
});
await check('откат к предыдущей копии и обратно', async () => {
  const a = await ev(`return ctx.packs.rollback('test.shop').pack.version`);
  const ops = await ev(`return ctx.packs.operations(${JSON.stringify(C.a)}).map((o) => o.id + ':' + o.risk)`);
  const b = await ev(`return ctx.packs.rollback('test.shop').pack.version`);
  return a === '0.2.0' && b === '0.3.0' && ops.includes('test.shop/item.list:read') && ops.includes('test.shop/item.update:write') && ops.includes('test.shop/item.delete:irreversible') ? { ops } : fail({ a, b, ops });
});
await check('для исполнителя: операции, схема, identity, политики', async () => {
  const r = await ev(`return { op: ctx.packs.operation('test.shop/item.update'), schema: ctx.packs.scopeSchema('test.shop'), id: ctx.packs.identity('test.shop'), pol: ctx.packs.policies('test.shop'), agent: ctx.packs.agent('test.shop') }`);
  return r.op && r.op.risk === 'write' && r.op.op.readModifyWrite && r.op.op.sources.includes('$seen') && r.schema.kind === 'shop' && r.id.source === 'cookie' && r.pol[0].kind === 'maxChangePct' && r.agent.skills[0] === 'bulk-edit' ? true : fail(r);
});

// ===== связанная папка =====
await check('связанная папка: dev-пак, не в защищённом контейнере, перезагрузка по изменению', async () => {
  const i = await ev(`return ctx.packs.linkFolder(${JSON.stringify(DEVDIR)})`);
  const prot = await ev(`try { ctx.packs.enableForContainer('dev:test.dev', ${JSON.stringify(C.a)}, true); return 'enabled'; } catch (e) { return e.message; }`);
  const okB = await ev(`ctx.packs.enableForContainer('dev:test.dev', ${JSON.stringify(C.b)}, true); return ctx.packs.isEnabled('dev:test.dev', ${JSON.stringify(C.b)})`);
  const lib = await ev(`return ctx.toolsPack.builtins().filter((s) => s.pack === 'dev:test.dev').map((s) => s.name)`);
  const m = JSON.parse(fs.readFileSync(path.join(DEVDIR, 'kosmo-pack.json'), 'utf8'));
  m.version = '0.0.2';
  fs.writeFileSync(path.join(DEVDIR, 'kosmo-pack.json'), JSON.stringify(m, null, 2));
  const reloaded = await until(`return ctx.packs.info('dev:test.dev').version === '0.0.2'`, 8000);
  fs.writeFileSync(path.join(DEVDIR, 'kosmo-pack.json'), '{ broken');
  const broken = await until(`return ctx.packs.info('dev:test.dev').errors.length > 0`, 8000);
  m.version = '0.0.3';
  fs.writeFileSync(path.join(DEVDIR, 'kosmo-pack.json'), JSON.stringify(m, null, 2));
  const fixed = await until(`const i = ctx.packs.info('dev:test.dev'); return i.version === '0.0.3' && !i.errors.length`, 8000);
  const un = await ev(`ctx.packs.unlinkFolder(${JSON.stringify(DEVDIR)}); return !ctx.packs.info('dev:test.dev')`);
  return i.source === 'dev' && /защищённых/.test(prot) && okB && lib.includes('dev-сниппет') && reloaded && broken && fixed && un ? true : fail({ i: i.source, prot, okB, lib, reloaded, broken, fixed, un });
});

if (SHOTS) await check('снимок: раздел «Паки»', async () => {
  const sid = await ev(`const t = ctx.tabs.create({ url: 'kosmo://settings/#packs', active: true }); await new Promise((r) => t.wc.once('did-finish-load', r)); return t.id`);
  await sleep(900);
  await pageJs(sid, "document.querySelectorAll('.kpk-card .kpk-head').forEach((h) => h.click()); 1");
  await sleep(700);
  const f1 = await shot('packs-section.png');
  await pageJs(sid, "document.querySelector('.kpk-card[data-id=\"test.shop\"]').scrollIntoView(); 1");
  await sleep(400);
  const f2 = await shot('packs-section-test.png');
  await pageJs(sid, "location.hash = '#containers'; 1");
  await sleep(700);
  await pageJs(sid, `(() => { const r = document.querySelector('.kc-row[data-id="${C.a}"]'); const b = Array.from(r.querySelectorAll('button')).find((x) => x.textContent === 'Данные…'); b.click(); return 1; })()`);
  await sleep(900);
  const f3 = await shot('container-scope.png');
  const errs = await pageJs(sid, 'document.querySelectorAll(".k-empty[data-tone=error], .ks-section .k-error").length');
  await ev(`ctx.tabs.close(${sid}); return 1`);
  return { files: [f1, f2, f3], errs };
});

// ===== удаление =====
await check('удаление с данными; scope остаётся с пометкой «пак не установлен»', async () => {
  const r = await ev(`const fs = require('fs'), path = require('path');
    const d = ctx.packs.dataDir('test.shop'); fs.writeFileSync(path.join(d, 'state.json'), '{}');
    ctx.packs.uninstall('test.shop', { keepData: false });
    return { data: fs.existsSync(d), copies: fs.existsSync(path.join(ctx.paths.userData, 'packs', 'test.shop')), lock: !!ctx.store('packs.lock').get().packs['test.shop'], info: ctx.packs.info('test.shop'), scope: ctx.scopes.get(${JSON.stringify(C.a)}), bang: ctx.search.resolve('tsh x').kind, snip: ctx.packs.isEnabled('test.shop', ${JSON.stringify(C.a)}) }`);
  return !r.data && !r.copies && !r.lock && r.info === null && r.scope.pack === 'test.shop' && r.scope.packInstalled === false && r.scope.chip === null && r.bang === 'search' && !r.snip ? true : fail(r);
});

// ---------- уборка ----------
await ev(`for (const id of [${tabs.join(',')}]) { try { ctx.tabs.close(id); } catch (_) {} } return 1`);
await ev(`for (const id of [${JSON.stringify(C.a)}, ${JSON.stringify(C.b)}]) { try { await ctx.platform.containers.remove(id); } catch (_) {} } return 1`);
await check('логи без ошибок паков', async () => {
  const bad = await ev(`return ctx.logs.filter((l) => /^(packs|scopes)$/.test(l.scope) && /ошибк|не удалось|error/i.test(l.line) && !/с ошибками|ошибки: \\d/.test(l.line)).map((l) => l.line)`);
  return bad.length ? fail(bad) : true;
});
await client.close();
site.close();
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* занято */ }
const bad = results.filter((r) => r[0] !== 'ok').length;
for (const r of results) console.log(`${r[0] === 'ok' ? 'ok  ' : 'FAIL'} ${r[1]}${r[2] ? ' — ' + r[2] : ''}`);
console.log(`\n${results.length - bad}/${results.length} проверок пройдено`);
process.exitCode = bad ? 1 : 0;
