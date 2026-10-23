// Регрессия контейнеров и изолированных вкладок: node tools/containers-test.mjs [devPort] [cdpPort] [mcpProfile]
// Нужен запущенный dev-экземпляр (--dev --no-restore). Поднимает локальный сайт с cookie на 127.0.0.1 и проверяет:
// изоляцию cookies/localStorage между вкладками, window.open в том же контейнере, автоудаление временного контейнера,
// «Оставить», повтор закрытой вкладки, режим privacy.isolateNewTabs, IPC isolated, MCP-инструменты.
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEV = Number(process.argv[2] || 47430);
const CDP = Number(process.argv[3] || 9343);
const PROFILE = process.argv[4] || '';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

const site = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/set') {
    res.writeHead(200, { 'set-cookie': `acc=${u.searchParams.get('v')}; Path=/; Max-Age=3600`, 'content-type': 'text/html; charset=utf-8' });
    res.end(`<title>set ${u.searchParams.get('v')}</title><a id="pop" href="/echo" target="_blank">pop</a>`);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<title>echo</title><pre id="c">${(req.headers.cookie || '').replace(/</g, '')}</pre>`);
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${site.address().port}`;

async function ev(code) {
  const r = await fetch(`http://127.0.0.1:${DEV}/eval`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  const j = await r.json();
  if (j.error) throw new Error('eval: ' + j.error);
  return j.result;
}
// Проверка возвращает true / данные (успех) или fail(данные) / false (провал).
const fail = (o) => ({ __fail: o });
async function check(name, fn) {
  try {
    const r = await fn();
    const bad = r === false || (r && typeof r === 'object' && '__fail' in r);
    results.push([bad ? 'FAIL' : 'ok', name, r === true || r === false ? '' : JSON.stringify(bad ? r.__fail : r)]);
  }
  catch (e) { results.push(['FAIL', name, e.message]); }
}
const until = async (code, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(code)) return true; await sleep(150); } return false; };
const C = 'ctx.platform.containers';
// Открыть вкладку и дождаться загрузки; → {id, cid}
async function open(code) {
  const r = await ev(`const t = ${code}; return { id: t.id, cid: t.info.containerId }`);
  await until(`const t = ctx.tabs.get(${r.id}); return t && t.wc && !t.wc.isLoading() && t.wc.getURL().startsWith('http')`);
  return r;
}
const js = (id, expr) => ev(`return await ctx.tabs.get(${id}).wc.executeJavaScript(${JSON.stringify(expr)})`);
const temps = () => ev(`return ctx.sessions.containers().filter(c => c.temp).map(c => c.id)`);

await ev(`ctx.settings.set('privacy.isolateNewTabs', false); return true`);
const before = await temps();

let A, B, M;
await check('изоляция cookies: 2 изолированные + основная', async () => {
  A = await open(`${C}.openIsolated({ url: '${BASE}/set?v=A' }).tab`);
  B = await open(`${C}.openIsolated({ url: '${BASE}/set?v=B' }).tab`);
  M = await open(`ctx.tabs.create({ url: '${BASE}/set?v=M', containerId: 'main' })`);
  const got = {};
  for (const [k, t] of Object.entries({ A, B, M })) got[k] = await js(t.id, 'document.cookie');
  const ok = A.cid !== B.cid && A.cid !== 'main' && B.cid !== 'main' && got.A === 'acc=A' && got.B === 'acc=B' && got.M === 'acc=M';
  return ok ? { A: A.cid, B: B.cid, got } : false;
});
await check('изоляция localStorage', async () => {
  await js(A.id, "localStorage.setItem('k', 'A'), 1");
  await js(B.id, "localStorage.setItem('k', 'B'), 1");
  const a = await js(A.id, "localStorage.getItem('k')"); const b = await js(B.id, "localStorage.getItem('k')"); const m = await js(M.id, "localStorage.getItem('k')");
  return a === 'A' && b === 'B' && m === null ? true : fail({ a, b, m });
});
await check('ссылка target=_blank остаётся в контейнере вкладки', async () => {
  const n0 = await ev('return ctx.tabs.list().length');
  await js(A.id, "document.getElementById('pop').click(), 1");
  await until(`return ctx.tabs.list().length > ${n0}`);
  const p = await ev(`const t = ctx.tabs.all().find(t => t.openerId === ${A.id}); return t ? { id: t.id, cid: t.info.containerId } : null`);
  if (!p) return false;
  await until(`const t = ctx.tabs.get(${p.id}); return t.wc && !t.wc.isLoading() && t.wc.getURL().includes('/echo')`);
  const c = await js(p.id, "document.getElementById('c').textContent");
  await ev(`ctx.tabs.close(${p.id}); return true`);
  return p.cid === A.cid && c === 'acc=A' ? { cookieSeenByServer: c } : fail({ p, c });
});
await check('TabInfo: containerTemp и цвет', async () => {
  const i = await ev(`return ctx.tabs.list().find(t => t.id === ${A.id})`);
  return i.containerTemp === true && /^#/.test(i.containerColor) && /^Изоляция \d+$/.test(i.containerName) ? { name: i.containerName, color: i.containerColor } : fail(i);
});
await check('временный контейнер удаляется с последней вкладкой', async () => {
  // сначала уводим B на /echo: повтор закрытой вкладки не должен сам поставить cookie заново
  await ev(`ctx.tabs.navigate(${B.id}, '${BASE}/echo'); return true`);
  await until(`const t = ctx.tabs.get(${B.id}); return !t.wc.isLoading() && t.wc.getURL().includes('/echo')`);
  await ev(`ctx.tabs.close(${B.id}); return true`);
  const gone = await until(`return !ctx.sessions.exists('${B.cid}')`, 4000);
  return gone ? true : fail(await temps());
});
await check('повтор закрытой вкладки удалённого контейнера → новый изолированный, не основной', async () => {
  const r = await ev(`const t = ctx.tabs.reopenClosed(); return { id: t.id, cid: t.info.containerId, temp: !!ctx.sessions.container(t.info.containerId).temp }`);
  await until(`const t = ctx.tabs.get(${r.id}); return t.wc && !t.wc.isLoading()`);
  const c = await js(r.id, 'document.cookie');
  await ev(`ctx.tabs.close(${r.id}); return true`);
  return r.cid !== 'main' && r.cid !== B.cid && r.temp && c === '' ? r : fail({ r, c });
});
await check('«Оставить» — контейнер переживает закрытие вкладок', async () => {
  await ev(`${C}.keep('${A.cid}', 'WB кабинет 2'); return true`);
  await ev(`ctx.tabs.close(${A.id}); return true`);
  await sleep(800);
  const c = await ev(`return ctx.sessions.containers().find(c => c.id === '${A.cid}') || null`);
  if (!c || c.temp || c.name !== 'WB кабинет 2') return fail({ c });
  const T = await open(`ctx.tabs.create({ url: '${BASE}/echo', containerId: '${A.cid}' })`);
  const cookie = await js(T.id, "document.getElementById('c').textContent");
  await ev(`ctx.tabs.close(${T.id}); return true`);
  return cookie === 'acc=A' ? { cookie } : fail({ cookie });
});
await check('IPC kosmo:tabs.create {isolated:true} из интерфейса', async () => {
  const r = await ev(`const w = ctx.windows.main.webContents; return await w.executeJavaScript("window.kosmo.invoke('kosmo:tabs.create', { isolated: true, url: '${BASE}/echo' })")`);
  const t = await ev(`const i = ctx.tabs.list().find(t => t.id === ${r && r.id}); return i ? { id: i.id, cid: i.containerId, temp: i.containerTemp } : null`);
  if (t) await ev(`ctx.tabs.close(${t.id}); return true`);
  return t && t.temp && t.cid !== 'main' ? t : fail({ r, t });
});
await check('режим «каждая новая вкладка изолированная»: Ctrl+T и «+»', async () => {
  await ev(`ctx.settings.set('privacy.isolateNewTabs', true); return true`);
  const a = await ev(`ctx.commands.run('tab.new'); const t = ctx.tabs.active(); return { id: t.id, cid: t.info.containerId }`);
  const b = await ev(`const w = ctx.windows.main.webContents; const r = await w.executeJavaScript("window.kosmo.invoke('kosmo:tabs.create', {})"); return { id: r.id, cid: r.containerId }`);
  const c = await ev(`const w = ctx.windows.main.webContents; const r = await w.executeJavaScript("window.kosmo.invoke('kosmo:tabs.create', { isolated: false })"); return { id: r.id, cid: r.containerId }`);
  await ev(`ctx.settings.set('privacy.isolateNewTabs', false); ctx.tabs.closeMany([${a.id}, ${b.id}, ${c.id}]); return true`);
  const off = await ev(`ctx.commands.run('tab.new'); const t = ctx.tabs.active(); const r = { id: t.id, cid: t.info.containerId }; ctx.tabs.close(t.id); return r`);
  return a.cid !== 'main' && b.cid !== 'main' && a.cid !== b.cid && c.cid === 'main' && off.cid === 'main' ? { a: a.cid, b: b.cid } : fail({ a, b, c, off });
});
await check('Ctrl+Shift+N зарегистрирован', async () => {
  const c = await ev(`const c = ctx.commands.list().find(c => c.id === 'tab.newIsolated'); return c ? c.keys : null`);
  return Array.isArray(c) && c.includes('Ctrl+Shift+N') ? c : false;
});
await check('проверка настроек: temp у main запрещён', async () => {
  const r = await ev(`const cur = ctx.sessions.containers(); ctx.settings.set('containers', cur.map(c => c.id === 'main' ? Object.assign({}, c, { temp: true }) : c)); return ctx.sessions.container('main').temp || false`);
  return r === false;
});

if (PROFILE) {
  // асинхронно: тестовый сайт живёт в этом же процессе и должен отвечать, пока идёт вызов
  const run = promisify(execFile);
  const mcp = async (tool, args) => (await run(process.execPath, [path.join(ROOT, 'tools', 'mcp-call.mjs'), '--profile', PROFILE, 'call', tool, JSON.stringify(args)], { encoding: 'utf8' })).stdout;
  const NAME = 'Ozon кабинет ' + Date.now().toString(36);
  await check('MCP container_create + tab_open container', async () => {
    const out = await mcp('container_create', { name: NAME });
    const id = (out.match(/\[([a-z0-9_-]+)\]/i) || [])[1];
    const o = await mcp('tab_open', { url: `${BASE}/set?v=O3`, container: id });
    const tid = Number((o.match(/tab \[(\d+)\]/) || [])[1]);
    const cid = await ev(`return ctx.tabs.get(${tid}).info.containerId`);
    const list = await mcp('containers_list', {});
    await ev(`ctx.tabs.close(${tid}); await ctx.platform.containers.remove('${id}'); return true`);
    return cid === id && list.includes(NAME) ? { id } : fail({ out, o, cid });
  });
  await check('MCP tab_open isolated', async () => {
    const o = await mcp('tab_open', { url: `${BASE}/echo`, isolated: true });
    const tid = Number((o.match(/tab \[(\d+)\]/) || [])[1]);
    const i = await ev(`return ctx.tabs.list().find(t => t.id === ${tid})`);
    const tl = await mcp('tabs_list', {});
    await ev(`ctx.tabs.close(${tid}); return true`);
    return i && i.containerTemp && /new temporary container/.test(o) && tl.includes(`[${i.containerId}] temporary`) ? { o: o.trim() } : fail({ o, i });
  });
}

// уборка: созданные тестом контейнеры
await ev(`for (const t of ctx.tabs.all()) if (t.info.containerId !== 'main') ctx.tabs.close(t.id); return true`);
await check('после теста временных контейнеров не осталось', async () => {
  await sleep(1000);
  const left = (await temps()).filter((id) => !before.includes(id));
  return left.length === 0 ? true : fail(left);
});
await ev(`const keepIds = ${JSON.stringify(A ? [A.cid] : [])}; for (const id of keepIds) if (ctx.sessions.exists(id)) await ctx.platform.containers.remove(id); return true`).catch(() => {});

site.close();
let fails = 0;
for (const [st, name, info] of results) { if (st !== 'ok') fails++; console.log(`${st.padEnd(4)} ${name}${info ? '  ' + info : ''}`); }
console.log(`\n${results.length - fails}/${results.length} ok`);
process.exit(fails ? 1 : 0);
