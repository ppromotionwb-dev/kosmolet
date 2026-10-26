// Прогон сценария интеграции ядра: node tools/smoke.mjs [devPort] [cdpPort]
// Первым делом — чистота ядра (tools/purity-check.mjs): домены сторонних сайтов в src/ и маркеры клиентов.
import { check as purityCheck } from './purity-check.mjs';
const DEV = Number(process.argv[2] || 47430);
const CDP = Number(process.argv[3] || 9343);
const results = [];
const fail = (o) => ({ __fail: o });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ev(code) {
  const r = await fetch(`http://127.0.0.1:${DEV}/eval`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  const j = await r.json();
  if (j.error) throw new Error('eval: ' + j.error);
  return j.result;
}
async function targets() { return (await fetch(`http://127.0.0.1:${CDP}/json`)).json(); }
async function cdpSession(match) {
  const list = await targets();
  const t = typeof match === 'function' ? list.find(match) : list.find((x) => x.type === 'page' && x.url.includes(match));
  if (!t) throw new Error('нет цели ' + match);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0; const pend = new Map(); const msgs = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning', 'assert'].includes(m.params.type)) msgs.push(m.params.type + ': ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
    if (m.method === 'Runtime.exceptionThrown') msgs.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  };
  await new Promise((r) => { ws.onopen = r; });
  const send = (method, params) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  return {
    msgs, send,
    async eval(expr) { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'exc'); return r.result.result.value; },
    async key(code, key, mods = 0, char) { const vk = { Enter: 13, Escape: 27, Tab: 9, F12: 123, KeyT: 84, KeyW: 87, KeyL: 76, KeyF: 70 }[code] || 0; const b = { modifiers: mods, code, key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }; await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...b }); if (char) await send('Input.dispatchKeyEvent', { type: 'char', text: char, ...b }); await send('Input.dispatchKeyEvent', { type: 'keyUp', ...b }); },
    async type(text) { await send('Input.insertText', { text }); },
    async consoleReplay() { await send('Runtime.enable'); await sleep(200); return msgs.slice(); },
    close() { ws.close(); },
  };
}
async function check(name, fn) {
  try { const r = await fn(); const bad = r === false || (r && typeof r === 'object' && '__fail' in r); results.push([bad ? 'FAIL' : 'ok', name, r === true || r === false ? '' : JSON.stringify(bad && r.__fail !== undefined ? r.__fail : r)]); }
  catch (e) { results.push(['FAIL', name, e.message]); }
}
const until = async (code, ms = 8000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await ev(code)) return true; await sleep(150); } return false; };

const chrome = await cdpSession('kosmo://ui/chrome/');
const tabsNow = () => ev('return { ids: ctx.tabs.list().map(t=>t.id), a: ctx.tabs.activeId, urls: ctx.tabs.list().map(t=>t.url) }');

await check('чистота ядра (purity-check)', () => {
  const r = purityCheck();
  return r.problems.length ? fail(r.problems.slice(0, 10).map((p) => `${p.file}:${p.line} ${p.rule} «${p.what}»`)) : { files: r.scanned, markers: r.markers };
});
await check('health/featureErrors', async () => { const h = await (await fetch(`http://127.0.0.1:${DEV}/health`)).json(); return h.ok && h.featureErrors.length === 0 ? true : fail(h); });
await check('старт: замеры', () => ev("return ctx.logs.filter(l=>/через \\d+ мс/.test(l.line)).map(l=>l.line.replace(/ от запуска процесса.*/, ''))"));
await check('chrome: высота и раскладка', async () => {
  const r = await ev('const g=ctx.windows.geometry(); return {top:g.top, tabY:(ctx.windows.activeView||{getBounds:()=>({})}).getBounds().y, tbh: ctx.windows.titleBarHeight}');
  const h = await chrome.eval("Math.ceil(document.getElementById('chrome').getBoundingClientRect().height)");
  return r.top === h && r.tabY === h && r.tbh >= 32 ? { ...r, h } : false;
});
await check('chrome: нативные кнопки не перекрывают полосу', () => chrome.eval("(() => { const r = document.getElementById('tabbar-drag').getBoundingClientRect(); const pr = parseFloat(getComputedStyle(document.getElementById('tabbar')).paddingRight); return pr >= 100 && r.right <= innerWidth - pr + 1 ? {padRight: pr} : false })()"));

// Ctrl+T → адресная строка в фокусе → ввод
for (const [q, re] of [['example.com', /^https:\/\/example\.com\/$/], ['wb кроссовки', /wildberries\.ru\/catalog\/0\/search\.aspx\?search=/], ['oz 123456', /ozon\.ru\/(product\/123456|search\/.*123456)/], ['как сварить борщ', /google\.com\/search\?q=/]]) {
  await check('омнибокс: ' + q, async () => {
    await chrome.key('KeyT', 't', 2);
    await sleep(500);
    const f = await chrome.eval('KChrome.omnibox.isFocused()');
    if (!f) return fail({ focused: false });
    await chrome.type(q);
    await chrome.key('Enter', 'Enter', 0, '\r');
    const ok = await until(`const t=ctx.tabs.active(); return t && ${re}.test(t.wc ? t.wc.getURL() : '')`, 8000);
    return ok ? true : fail(await ev('return ctx.tabs.active().wc.getURL()'));
  });
}
await check('Ctrl+W закрывает', async () => { const a = await tabsNow(); await chrome.key('KeyW', 'w', 2); await sleep(400); const b = await tabsNow(); return b.ids.length === a.ids.length - 1 && !b.ids.includes(a.a); });
await check('Ctrl+Shift+T возвращает', async () => { const a = await tabsNow(); await chrome.key('KeyT', 'T', 10); await sleep(600); const b = await tabsNow(); return b.ids.length === a.ids.length + 1; });
await check('Ctrl+Tab / Ctrl+Shift+Tab', async () => { const a = await tabsNow(); await chrome.key('Tab', 'Tab', 2); await sleep(300); const b = await tabsNow(); await chrome.key('Tab', 'Tab', 10); await sleep(300); const c = await tabsNow(); return b.a !== a.a && c.a === a.a; });
await check('pin/mute/duplicate/move (IPC из chrome)', async () => {
  const ids = (await tabsNow()).ids;
  const r = await chrome.eval(`(async () => ({ pin: await KChrome.invoke('kosmo:tabs.pin', {id:${ids[1]}}), mute: await KChrome.invoke('kosmo:tabs.mute', {id:${ids[2]}}), dup: (await KChrome.invoke('kosmo:tabs.duplicate', {id:${ids[2]}})).id, move: await KChrome.invoke('kosmo:tabs.move', {id:${ids[2]}, index: 3}) }))()`);
  await sleep(300);
  const dom = await chrome.eval("Array.from(document.querySelectorAll('#tabs .tab')).map(e=>e.dataset.id + (e.classList.contains('pinned')?'p':''))");
  const st = await ev('return ctx.tabs.list().map(t=>t.id + (t.pinned?"p":""))');
  const unpin = await chrome.eval(`KChrome.invoke('kosmo:tabs.pin', {id:${ids[1]}, pinned:false})`);
  return r.pin === true && r.mute === true && JSON.stringify(dom) === JSON.stringify(st) && st[0] === ids[1] + 'p' ? { ...r, order: st } : fail({ r, dom, st });
});
await check('панель: F12 открывает/закрывает', async () => {
  await chrome.key('F12', 'F12'); await sleep(700);
  const a = await ev('return ctx.panel.state()');
  await chrome.key('F12', 'F12'); await sleep(400);
  const b = await ev('return ctx.panel.isOpen()');
  return a.open && a.tool === 'devtools' && !b ? a : fail({ a, b });
});
await check('панель: кнопка, инструменты, ширина, DevTools под шапкой', async () => {
  await chrome.eval("document.querySelector('#slot-toolbar-right [data-id=panel]').click()"); await sleep(700);
  const panel = await cdpSession('kosmo://ui/panel/');
  await panel.eval("document.querySelector('.tool-tab[data-id=network]').click()"); await sleep(300);
  const t1 = await ev('return ctx.panel.tool()');
  await panel.eval("KUI.fire('kosmo:panel.setWidth', {width: 560})"); await sleep(500);
  const w = await ev('return {w: ctx.panel.state().width, g: ctx.windows.geometry().panel.width, s: ctx.settings.get("ui.panelWidth")}');
  await panel.eval("document.querySelector('.tool-tab[data-id=devtools]').click()"); await sleep(300);
  const dv = await ev('const v=ctx.panel.devtoolsView; ctx.windows.layout(); const b=v.getBounds(), p=ctx.windows.geometry().panel; return {dy: b.y - p.y, h: p.height - b.height, x: b.x === p.x, inTree: ctx.windows.main.contentView.children.includes(v)}');
  const cons = panel.msgs.slice(); panel.close();
  await chrome.eval("document.querySelector('#slot-toolbar-right [data-id=panel]').click()"); await sleep(400);
  const closed = !(await ev('return ctx.panel.isOpen()'));
  return t1 === 'network' && w.w === 560 && w.g === 560 && dv.dy === 36 && dv.h === 36 && dv.inTree && closed ? { t1, w, dv } : fail({ t1, w, dv, closed, cons });
});
await check('overlay: немодальный под якорем, Esc', async () => {
  await chrome.eval("KChrome.openOverlay('demo', {}, document.querySelector('[data-id=menu]'), {align:'end'})"); await sleep(600);
  const r = await ev('const v=ctx.overlay.view(); return {b: v.getBounds(), vis: v.getVisible(), W: ctx.windows.geometry().W}');
  const a = await chrome.eval("(() => { const r = document.querySelector('[data-id=menu]').getBoundingClientRect(); return {right: Math.round(r.right), bottom: Math.round(r.bottom)} })()");
  const ov = await cdpSession('kosmo://ui/overlay/');
  await ov.key('Escape', 'Escape'); await sleep(300); ov.close();
  const closed = !(await ev('return ctx.overlay.isOpen()'));
  const okPos = r.vis && r.b.x + r.b.width - 8 === a.right && r.b.y + 8 === a.bottom;
  return okPos && closed ? { b: r.b } : fail({ r, a, closed });
});
await check('overlay: модальный на всё окно, клик мимо', async () => {
  await chrome.eval("KChrome.openOverlay('demo', {}, null, {modal:true})"); await sleep(500);
  const r = await ev('const v=ctx.overlay.view(); const g=ctx.windows.geometry(); return {b: v.getBounds(), W: g.W, H: g.H}');
  const ov = await cdpSession('kosmo://ui/overlay/');
  await ov.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 20, y: r.H - 20, button: 'left', clickCount: 1 });
  await ov.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 20, y: r.H - 20, button: 'left', clickCount: 1 });
  await sleep(300); ov.close();
  const closed = !(await ev('return ctx.overlay.isOpen()'));
  return r.b.width === r.W && r.b.height === r.H && closed ? true : fail({ r, closed });
});
await check('overlay: закрытие фокусом вкладки и сменой вкладки', async () => {
  await chrome.eval("KChrome.openOverlay('demo', {}, document.querySelector('[data-id=menu]'), {align:'end'})"); await sleep(400);
  const a = await ev('ctx.tabs.active().wc.focus(); await new Promise(r=>setTimeout(r,200)); return ctx.overlay.isOpen()');
  await chrome.eval("KChrome.openOverlay('demo', {}, document.querySelector('[data-id=menu]'), {align:'end'})"); await sleep(400);
  const b = await ev('ctx.tabs.activateOffset(1); await new Promise(r=>setTimeout(r,200)); return ctx.overlay.isOpen()');
  return !a && !b;
});
await check('overlay: toggleOverlay не открывает заново после chrome-focus', async () => {
  await chrome.eval("KChrome.toggleOverlay('demo', {}, document.querySelector('[data-id=menu]'), {align:'end'})"); await sleep(400);
  const r = await ev(`const w=ctx.windows.main.webContents; w.focus(); await new Promise(r=>setTimeout(r,100)); await w.executeJavaScript("KChrome.toggleOverlay('demo', {}, document.querySelector('[data-id=menu]'), {align:'end'})"); await new Promise(r=>setTimeout(r,300)); return ctx.overlay.isOpen()`);
  return r === false;
});
await check('настройки: разделы и смена темы везде + кнопки окна', async () => {
  await ev("ctx.commands.run('settings.open'); return 1"); await sleep(1200);
  await ev("ctx.panel.open('network'); return 1"); await sleep(700);
  const set = await cdpSession((t) => t.type === 'page' && t.url.startsWith('kosmo://settings/'));
  const nav = await set.eval("document.querySelectorAll('#ks-nav .ks-nav-item').length");
  await set.eval("document.querySelector('.ks-nav-item[data-id=appearance]').click()"); await sleep(300);
  const out = {};
  for (const th of ['light', 'terminal', 'cosmos']) {
    await set.eval(`document.querySelector('.ks-theme[data-id=${th}]').click()`); await sleep(500);
    const tb = await ev('return ctx.windows.titleBarColors.color');
    const views = [];
    for (const u of ['kosmo://ui/chrome/', 'kosmo://ui/panel/', 'kosmo://ui/overlay/']) { const s = await cdpSession(u); let v; for (let i = 0; i < 20; i++) { v = await s.eval('document.documentElement.dataset.theme'); if (v === th) break; await sleep(100); } views.push(v); s.close(); }
    views.push(await set.eval('document.documentElement.dataset.theme'));
    const strip = await chrome.eval("getComputedStyle(document.getElementById('tabbar')).backgroundColor");
    out[th] = { tb, views: views.join(','), strip };
    if (!views.every((v) => v === th)) { set.close(); return fail(out); }
  }
  const cons = set.msgs.slice(); set.close();
  await ev('ctx.panel.close(); return 1');
  return nav >= 10 && cons.length === 0 ? out : fail({ nav, out, cons });
});
await check('безопасность', async () => {
  const r = await ev(`
    const t = ctx.tabs.create({url:'https://example.com/?sec'}); await new Promise(r=>t.wc.once('did-finish-load', r));
    const x = (c) => t.wc.executeJavaScript(c).catch(e=>'err '+e.message);
    const r = {};
    r.kosmo = await x('typeof window.kosmo');
    r.nav = await x("location.href='kosmo://settings/'; new Promise(r=>setTimeout(()=>r(location.href),600))");
    r.open = await x("String(window.open('kosmo://settings/'))");
    r.fetch = await x("fetch('kosmo://settings/index.html').then(x=>'read '+x.status).catch(e=>'blocked')");
    ctx.tabs.navigate(t.id, 'kosmo://ui/chrome/index.html'); await new Promise(r=>setTimeout(r,700));
    r.ui = await x('document.body.innerText.slice(0,20)');
    ctx.tabs.navigate(t.id, 'kosmo://settings/../../main/main.js'); await new Promise(r=>setTimeout(r,700));
    r.trav = await x('document.body.innerText.slice(0,30)');
    ctx.tabs.navigate(t.id, 'kosmo://settings/..%2F..%2F..%2Fmain%2Fmain.js'); await new Promise(r=>setTimeout(r,700));
    r.trav2 = await x('document.body.innerText.slice(0,12)');
    ctx.tabs.close(t.id);
    return r;`);
  return r.kosmo === 'undefined' && /example\.com/.test(r.nav) && r.open === 'null' && r.fetch === 'blocked' && /^Не найдено/.test(r.ui) && /^Не найдено/.test(r.trav) && /^Не найдено/.test(r.trav2) ? true : fail(r);
});
for (const [bad, wait] of [['http://127.0.0.1:1/', 10000], ['https://nonexistent.kosmolet-test.invalid/', 45000]]) await check('ошибка загрузки ' + bad + ' → страница ошибки, повтор, назад', async () => {
  const id = await ev("const t=ctx.tabs.create({url:'https://example.com/'}); await new Promise(r=>t.wc.once('did-finish-load', r)); ctx.tabs.navigate(t.id,'" + bad + "'); return t.id");
  const ok = await until(`return ctx.tabs.get(${id}).info.error !== 0 && ctx.tabs.get(${id}).wc.getURL().startsWith('kosmo://error/')`, wait);
  await sleep(500);
  const chip = await chrome.eval("document.getElementById('omni-security').dataset.kind");
  const omni = await chrome.eval("KChrome.omnibox.getValue()");
  const r = await ev(`const t=ctx.tabs.get(${id}); ctx.tabs.reload(t.id); await new Promise(r=>setTimeout(r,500)); const ok = await (async()=>{for(let i=0;i<180;i++){ if (t.wc.getURL().startsWith('kosmo://error/') && !t.info.loading) return true; await new Promise(r=>setTimeout(r,250)); } return false})(); const hist = t.wc.navigationHistory.getAllEntries().map(e=>e.url.slice(0,30)); ctx.tabs.back(t.id); await new Promise(r=>setTimeout(r,1200)); const back = t.wc.getURL(); ctx.tabs.close(t.id); return {ok, hist, back}`);
  return ok && chip === 'error' && omni.includes(new URL(bad).hostname) && r.hist.length === 2 && r.back === 'https://example.com/' ? { chip, hist: r.hist } : fail({ ok, chip, omni, r });
});
await check('краш вкладки → полоса, перезагрузка', async () => {
  const id = await ev("const t=ctx.tabs.create({url:'https://example.com/?crash'}); await new Promise(r=>t.wc.once('did-finish-load', r)); t.wc.forcefullyCrashRenderer(); return t.id");
  // render-process-gone на этой машине приходит через 0,4–19 с после forcefullyCrashRenderer (крах обрабатывает ОС, под нагрузкой дольше) — ждём до 25 с.
  const crashed = await until(`return ctx.tabs.get(${id}).info.crashed`, 25000);
  await sleep(300);
  const bar = await chrome.eval("!document.querySelector('[data-bar-id=crash]').hidden");
  await chrome.eval("document.querySelector('[data-bar-id=crash] button').click()");
  const back = await until(`const t=ctx.tabs.get(${id}); return !t.info.crashed && !t.info.loading && t.wc.getURL().includes('crash')`, 8000);
  await sleep(300);
  const bar2 = await chrome.eval("!document.querySelector('[data-bar-id=crash]').hidden");
  await ev(`ctx.tabs.close(${id}); return 1`);
  return crashed && bar && back && !bar2 ? true : fail({ crashed, bar, back, bar2 });
});
await check('выгрузка и возврат вкладки', async () => {
  const r = await ev(`const t=ctx.tabs.create({url:'https://example.com/?d=1'}); await new Promise(r=>t.wc.once('did-finish-load', r)); ctx.tabs.navigate(t.id,'https://example.com/?d=2'); await new Promise(r=>t.wc.once('did-finish-load', r));
    const other = ctx.tabs.all().find(x=>x.id!==t.id); ctx.tabs.activate(other.id);
    const ok = ctx.tabs.discard(t.id); const d = {view: !!t.view, discarded: t.info.discarded};
    ctx.tabs.activate(t.id); await new Promise(r=>setTimeout(r,1500));
    const res = {ok, d, view: !!t.view, url: t.wc.getURL(), hist: t.wc.navigationHistory.getAllEntries().map(e=>e.url), idx: t.wc.navigationHistory.getActiveIndex()};
    ctx.tabs.close(t.id); return res;`);
  return r.ok && !r.d.view && r.d.discarded && r.view && r.url.endsWith('?d=2') && r.hist.length === 2 && r.idx === 1 ? true : fail(r);
});
await check('поиск по странице', async () => {
  await ev(`const t=ctx.tabs.create({url:'https://example.com/'}); await new Promise(r=>t.wc.once('did-finish-load', r)); return 1`);
  await ev("ctx.commands.run('find.open'); return 1"); await sleep(300);
  await chrome.type('domain'); await sleep(700);
  const c = await chrome.eval("document.querySelector('.find-count').textContent");
  await chrome.key('Escape', 'Escape'); await sleep(300);
  const hidden = await chrome.eval("document.querySelector('[data-bar-id=find]').hidden");
  await ev('ctx.tabs.close(ctx.tabs.activeId); return 1');
  return /^1 из \d+$/.test(c) && hidden ? c : fail({ c, hidden });
});
await check('консоли интерфейса без ошибок', async () => {
  const out = {};
  for (const u of ['kosmo://ui/chrome/', 'kosmo://ui/panel/', 'kosmo://ui/overlay/']) { const s = await cdpSession(u); out[u] = await s.consoleReplay(); s.close(); }
  const logs = await ev("return ctx.logs.filter(l=>/^ui:|ipc|необработ|ошибка/.test(l.scope + ' ' + l.line) && !/ошибка загрузки/.test(l.line)).map(l=>l.scope+': '+l.line)");
  return Object.values(out).every((m) => m.length === 0) && logs.length === 0 ? true : fail({ out, logs });
});
chrome.close();
for (const r of results) console.log(r[0].padEnd(4), r[1], r[2] ? '— ' + r[2].slice(0, 400) : '');
console.log(results.filter((r) => r[0] === 'FAIL').length ? 'ЕСТЬ ОШИБКИ' : 'ВСЁ ПРОШЛО');
process.exit(0);
