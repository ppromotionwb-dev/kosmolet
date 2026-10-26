'use strict';
// Фича «tools-pack»: сниппеты (свои + встроенная библиотека, автозапуск по сайту), «Рентген» страницы,
// память процессов для настроек, пути профиля, значок Космолёта для внутренних страниц.
//
// IPC (интерфейс):
//   kosmo:snippets.list → {items, builtins}            kosmo:snippets.save {snippet} → snippet
//   kosmo:snippets.remove {id}                          kosmo:snippets.run {id? | code, world, name?, tabId?} → результат
//   kosmo:snippets.autoLog {tabId?} → {tabId, url, entries}   kosmo:snippets.autoResult {tabId, index} → результат
//   kosmo:snippets.runPicked {id} (из палитры)          kosmo:snippets.takeLast → последний запуск из палитры
//   kosmo:xray.run {tabId?} → отчёт                    kosmo:xray.toClaude {markdown, title, host} → {path, pasted}
//   kosmo:tools.metrics (+int) → {processes, tabs, totalKB}   kosmo:tools.discardTab {id} (+int)
//   kosmo:tools.paths (+int) → {userData, inbox, …}     kosmo:tools.openFolder {which} (+int)
// События: kosmo:snippets.changed {items}, kosmo:snippets.auto {tabId, url, entries}, kosmo:snippets.ran {id, result}.
// API соседям: ctx.toolsPack = { runSnippet(tabId, code, world), xray(tabId), snippets() }.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const runner = require('./tools-pack/runner');
const library = require('./tools-pack/library');
// Рентген (44 КБ) нужен только при первом запуске — не грузим его на холодном старте (PERF-12).
let xrayMod = null;
const xray = { run: (...a) => (xrayMod || (xrayMod = require('./tools-pack/xray'))).run(...a) };

const AUTO_TIMEOUT = 15000;
const AUTO_LOG_LIMIT = 30;
const NAME_LIMIT = 120;
const MATCH_LIMIT = 1000;
const ID_RE = /^s-[a-z0-9]{6,24}$/;
const UI_NAMES = { chrome: 'Окно и вкладки (интерфейс)', panel: 'Боковая панель', overlay: 'Всплывающие окна' };

function str(v, max) { const s = v == null ? '' : String(v); return max && s.length > max ? s.slice(0, max) : s; }
function newId() { return 's-' + crypto.randomBytes(6).toString('hex'); }

// match: подстрока адреса | маска хоста (*.example.com) | маска адреса (example.com/product/*) | * — все сайты. Несколько — через запятую или пробел.
function globRe(g, prefix) {
  return new RegExp('^' + (prefix || '') + g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
}
function matchUrl(match, url) {
  const pats = str(match).split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  if (!pats.length) return false;
  let u;
  try { u = new URL(url); } catch (_) { return false; }
  const host = u.hostname.toLowerCase();
  const rest = (u.host + u.pathname + u.search).toLowerCase();
  return pats.some((raw) => {
    const p = raw.toLowerCase().replace(/^https?:\/\//, '');
    if (p === '*' || p === '<all_urls>') return true;
    if (p.includes('*')) {
      if (p.includes('/')) return globRe(p, '(?:[^/]*\\.)?').test(rest);
      if (p.startsWith('*.') && host === p.slice(2)) return true;
      return globRe(p).test(host);
    }
    return url.toLowerCase().includes(p);
  });
}

function summarize(r) {
  if (!r) return '';
  if (!r.ok) return r.error ? str(r.error.message, 160) : 'ошибка';
  const res = r.result || {};
  if (res.type === 'undefined') return 'готово';
  if (res.type === 'string') return str(res.value, 160);
  if (res.type === 'directive' && res.value) {
    const v = res.value;
    if (v.__kosmo === 'table') return str(v.title || `строк: ${(v.rows || []).length}`, 160);
    if (v.__kosmo === 'copy') return str(v.message || 'скопировано', 160);
    if (v.__kosmo === 'choices') return str(v.title || 'список', 160);
    return str(v.text || v.title || v.__kosmo, 160);
  }
  if (res.type === 'json') return Array.isArray(res.value) ? `массив (${res.value.length})` : 'объект';
  return str(res.value, 160);
}

function init(ctx) {
  const store = ctx.store('snippets', { version: 1, items: [] });
  runner.useCdp(() => ctx.cdp); // сниппеты и рентген — через CDP, без ожидания конца загрузки (см. runner.exec)

  // ---------- хранилище ----------
  function clean(s, prev) {
    if (!s || typeof s !== 'object') throw new Error('нужен сниппет');
    const out = {
      id: prev ? prev.id : newId(),
      name: str(s.name, NAME_LIMIT).trim() || 'Без названия',
      code: str(s.code),
      world: s.world === 'page' ? 'page' : 'isolated',
      auto: !!s.auto,
      match: str(s.match, MATCH_LIMIT).trim(),
      createdAt: prev && prev.createdAt ? prev.createdAt : Date.now(),
      updatedAt: Date.now(),
    };
    if (out.code.length > runner.CODE_LIMIT) throw new Error('код длиннее 200 КБ');
    return out;
  }
  function all() {
    const d = store.get();
    return Array.isArray(d && d.items) ? d.items.filter((x) => x && ID_RE.test(String(x.id))) : [];
  }
  // Библиотека: встроенные сниппеты + ручные сниппеты включённых паков (мир пака, только его хосты и контейнеры).
  function packLib() { try { return ctx.packs ? ctx.packs.librarySnippets() : []; } catch (_) { return []; } }
  function builtins() { return library.BUILTINS.concat(packLib()); }
  function find(id) { const k = String(id || ''); return all().find((x) => x.id === k) || library.get(k) || packLib().find((x) => x.id === k) || null; }
  function broadcastList() { ctx.broadcast('kosmo:snippets.changed', { items: all() }); }
  function save(s) {
    const items = all();
    const i = s && s.id ? items.findIndex((x) => x.id === s.id) : -1;
    const v = clean(s, i >= 0 ? items[i] : null);
    if (i >= 0) items[i] = v; else items.push(v);
    store.set({ version: 1, items });
    broadcastList();
    return v;
  }
  function remove(id) {
    const items = all();
    const next = items.filter((x) => x.id !== id);
    if (next.length === items.length) return false;
    store.set({ version: 1, items: next });
    broadcastList();
    return true;
  }

  // ---------- выполнение ----------
  function tabFor(tabId) {
    const t = tabId != null ? ctx.tabs.get(tabId) : ctx.tabs.active();
    if (!t) throw new Error('Нет вкладки');
    return t;
  }
  async function run(p = {}) {
    const tab = tabFor(p.tabId);
    let code, world, name, id = null, packWorld;
    if (p.code != null) {
      code = str(p.code); world = p.world; name = str(p.name, NAME_LIMIT); id = p.id ? str(p.id, 120) : null;
      const s = id && id.startsWith('pack:') ? find(id) : null;
      if (s && s.pack) { // сниппет пака из редактора: те же ограничения, что и по id
        const why = ctx.packs.checkSnippetRun(s, tab);
        if (why) throw new Error(why);
        code = s.code; world = 'isolated'; packWorld = s.worldName;
      }
    }
    else {
      const s = find(str(p.id, 120));
      if (!s) throw new Error('Сниппет не найден');
      ({ code, world, name } = s); id = s.id;
      if (s.pack) {
        const why = ctx.packs.checkSnippetRun(s, tab);
        if (why) throw new Error(why);
        packWorld = s.worldName;
      }
    }
    const r = await runner.runInTab(tab, code, { world, worldName: packWorld, timeoutMs: Number(p.timeoutMs) || undefined });
    return Object.assign(r, { tabId: tab.id, id, name, at: Date.now() });
  }

  // ---------- автозапуск ----------
  const autoLog = new Map(); // tabId → {url, entries, full}
  function autoPayload(tabId) {
    const rec = autoLog.get(tabId);
    return { tabId, url: rec ? rec.url : '', entries: rec ? rec.entries : [] };
  }
  function broadcastAuto(tabId) { ctx.broadcast('kosmo:snippets.auto', autoPayload(tabId)); }
  async function onDomReady(tab, wc) {
    if (wc.isDestroyed()) return;
    const url = wc.getURL();
    const autos = runner.isWebUrl(url) ? all().filter((s) => s.auto && s.code.trim() && matchUrl(s.match, url)) : [];
    const had = autoLog.has(tab.id);
    if (!autos.length) { if (had) { autoLog.delete(tab.id); broadcastAuto(tab.id); } return; }
    const rec = { url, entries: [], full: [] };
    autoLog.set(tab.id, rec);
    broadcastAuto(tab.id);
    for (const s of autos) {
      if (tab.wc !== wc || wc.isDestroyed() || autoLog.get(tab.id) !== rec) return; // ушли со страницы
      // cdp: false — как раньше, после загрузки страницы (Electron ждёт did-stop-loading)
      const r = await runner.runInTab(tab, s.code, { world: s.world, timeoutMs: AUTO_TIMEOUT, userGesture: false, cdp: false });
      if (autoLog.get(tab.id) !== rec) return;
      rec.entries.push({ id: s.id, name: s.name, at: Date.now(), ok: !!r.ok, ms: r.ms, summary: summarize(r), logs: (r.logs || []).length });
      rec.full.push(Object.assign(r, { tabId: tab.id, id: s.id, name: s.name, at: Date.now(), auto: true }));
      if (rec.entries.length > AUTO_LOG_LIMIT) { rec.entries.shift(); rec.full.shift(); }
      // страница ушла или упала во время выполнения — это не ошибка сниппета, в лог не пишем
      if (!r.ok && !/disposed|destroyed|выгружена/i.test(String(r.error && r.error.message))) ctx.log('tools-pack', `автосниппет «${s.name}» на ${url}: ${r.error && r.error.message}`);
      broadcastAuto(tab.id);
    }
  }
  ctx.tabs.on('view-created', (tab, wc) => {
    wc.on('dom-ready', () => { onDomReady(tab, wc).catch((e) => ctx.log('tools-pack', 'автозапуск:', e)); });
  });
  ctx.tabs.on('closed', (tab) => { autoLog.delete(tab.id); });

  // ---------- палитра: «Выполнить сниппет…» ----------
  let lastPicked = null;
  function openPicker() {
    const t = ctx.tabs.active();
    const url = t ? t.info.url : '';
    let host = '';
    try { host = new URL(url).hostname; } catch (_) { /* нет */ }
    ctx.overlay.open({
      type: 'tools-snippet-pick', modal: true, focus: true,
      data: {
        items: all().map((s) => ({ id: s.id, name: s.name, world: s.world, auto: s.auto, match: s.match })),
        builtins: builtins().map((s) => ({ id: s.id, name: s.name, desc: s.desc, world: s.world, pack: s.packName || undefined })),
        host, canRun: runner.isWebUrl(url),
      },
    });
  }
  async function runPicked(id) {
    ctx.overlay.close('snippet-picked');
    ctx.panel.open('snippets');
    const s = find(id);
    let result;
    try { result = await run({ id }); } catch (e) { result = { ok: false, error: { name: 'Ошибка', message: e.message }, id, name: s ? s.name : id, at: Date.now() }; }
    lastPicked = { id, result, at: Date.now() };
    ctx.broadcast('kosmo:snippets.ran', lastPicked);
    return true;
  }

  // ---------- Рентген → Claude ----------
  async function toClaude(p = {}) {
    const B = ctx.bridge;
    if (!B || typeof B.toInbox !== 'function') throw new Error('Мост Claude недоступен');
    const md = str(p.markdown, 2 * 1024 * 1024);
    if (!md.trim()) throw new Error('Пустой отчёт');
    const out = await B.toInbox({ title: str(p.title, 300) || null, markdown: md, host: str(p.host, 200) });
    try { ctx.electron.clipboard.writeText(out.path); } catch (_) { /* буфер занят */ }
    let pasted = false;
    const T = ctx.terminal;
    if (T && typeof T.pasteToClaude === 'function') { try { pasted = !!(await T.pasteToClaude('@' + out.path + ' ')); } catch (_) { pasted = false; } }
    return { path: out.path, pasted };
  }

  // ---------- память процессов ----------
  function metrics() {
    const { app, webContents } = ctx.electron;
    const procs = app.getAppMetrics();
    const owners = new Map();
    const push = (pid, o) => { if (!pid) return; if (!owners.has(pid)) owners.set(pid, []); owners.get(pid).push(o); };
    const pidOf = (wc) => { try { return wc && !wc.isDestroyed() ? wc.getOSProcessId() : 0; } catch (_) { return 0; } };
    const known = new Set();
    const tabPid = new Map();
    for (const t of ctx.tabs.all()) {
      const wc = t.wc;
      const pid = pidOf(wc);
      if (wc) known.add(wc.id);
      tabPid.set(t.id, pid);
      push(pid, { kind: 'tab', tabId: t.id, title: t.info.title || t.info.url });
    }
    const win = ctx.windows.main;
    const ui = [['chrome', win && !win.isDestroyed() ? win.webContents : null], ['panel', ctx.panel.webContents()], ['overlay', ctx.overlay.webContents()]];
    for (const [name, wc] of ui) { if (!wc) continue; known.add(wc.id); push(pidOf(wc), { kind: 'ui', title: UI_NAMES[name] }); }
    for (const wc of webContents.getAllWebContents()) {
      if (known.has(wc.id) || wc.isDestroyed()) continue;
      const url = wc.getURL();
      let title = wc.getTitle() || url || 'Служебная страница';
      if (/^devtools:/i.test(url)) title = 'DevTools';
      else if (/^chrome-extension:/i.test(url)) title = 'Расширение: ' + (wc.getTitle() || url.split('/')[2]);
      push(pidOf(wc), { kind: 'other', title: str(title, 120) });
    }
    const processes = procs.map((p) => ({
      pid: p.pid, type: p.type, name: p.name || p.serviceName || '',
      memKB: p.memory ? p.memory.workingSetSize : 0,
      privKB: p.memory && p.memory.privateBytes != null ? p.memory.privateBytes : null,
      cpu: p.cpu ? Math.round(p.cpu.percentCPUUsage * 10) / 10 : 0,
      owners: owners.get(p.pid) || [],
    }));
    const byPid = new Map(processes.map((p) => [p.pid, p]));
    const tabs = ctx.tabs.list().map((i) => {
      const pid = tabPid.get(i.id) || 0;
      const proc = byPid.get(pid);
      return {
        id: i.id, title: i.title || i.url, url: i.url, favicon: /^https?:|^data:image\//i.test(i.favicon || '') ? i.favicon : '', active: i.active, pinned: i.pinned,
        audible: i.audible, discarded: !!i.discarded, pid, memKB: proc ? proc.memKB : 0,
        shared: proc ? proc.owners.filter((o) => o.kind === 'tab').length : 0,
      };
    });
    return { processes, tabs, totalKB: processes.reduce((s, p) => s + (p.memKB || 0), 0), at: Date.now() };
  }

  // ---------- пути ----------
  function paths() {
    return {
      userData: ctx.paths.userData,
      inbox: ctx.paths.inbox,
      snippets: store.file,
      settings: path.join(ctx.paths.userData, 'settings.json'),
      project: ctx.paths.root,
    };
  }
  async function openFolder(which) {
    const p = paths();
    const dir = { userData: p.userData, inbox: p.inbox, project: p.project }[which];
    if (!dir) throw new Error('неизвестная папка');
    await fs.promises.mkdir(dir, { recursive: true }).catch(() => {});
    const err = await ctx.electron.shell.openPath(dir);
    if (err) throw new Error(err);
    return true;
  }

  // ---------- IPC ----------
  const H = (ch, fn, allow) => ctx.ipc.handle(ch, fn, { allow: allow || ['ui'] });
  H('kosmo:snippets.list', () => ({ items: all(), builtins: builtins() }));
  H('kosmo:snippets.save', (p = {}) => save(p.snippet || p));
  H('kosmo:snippets.remove', (p = {}) => remove(str(p.id, 64)));
  H('kosmo:snippets.run', (p = {}) => run(p));
  H('kosmo:snippets.autoLog', (p = {}) => autoPayload(p.tabId != null ? Number(p.tabId) : ctx.tabs.activeId));
  H('kosmo:snippets.autoResult', (p = {}) => {
    const rec = autoLog.get(Number(p.tabId));
    return rec && rec.full[Number(p.index)] ? rec.full[Number(p.index)] : null;
  });
  H('kosmo:snippets.runPicked', (p = {}) => { runPicked(str(p.id, 120)).catch((e) => ctx.log('tools-pack', e)); return true; });
  H('kosmo:snippets.takeLast', () => {
    const l = lastPicked;
    lastPicked = null;
    return l && Date.now() - l.at < 60000 ? l : null;
  });
  H('kosmo:xray.run', (p = {}) => xray.run(ctx, tabFor(p.tabId != null ? Number(p.tabId) : null)));
  H('kosmo:xray.toClaude', (p = {}) => toClaude(p));
  H('kosmo:tools.metrics', () => metrics(), ['ui', 'internal']);
  H('kosmo:tools.discardTab', (p = {}) => ctx.tabs.discard(Number(p.id)), ['ui', 'internal']);
  H('kosmo:tools.paths', () => paths(), ['ui', 'internal']);
  H('kosmo:tools.openFolder', (p = {}) => openFolder(str(p.which, 32)), ['ui', 'internal']);

  // ---------- команды ----------
  ctx.commands.register({ id: 'snippets.open', title: 'Сниппеты', category: 'Разработка', appMenu: { section: 'tools', order: 40 }, run: () => ctx.panel.open('snippets') });
  ctx.commands.register({ id: 'snippets.run', title: 'Выполнить сниппет…', category: 'Разработка', run: () => openPicker() });
  ctx.commands.register({ id: 'xray.open', title: 'Рентген страницы', category: 'Разработка', appMenu: { section: 'tools', order: 41 }, run: () => ctx.panel.open('xray') });

  // ---------- значок Космолёта на внутренних страницах (kosmo://settings и др.) ----------
  try {
    const svg = fs.readFileSync(path.join(ctx.paths.root, 'assets', 'logo-small.svg'), 'utf8');
    const icon = 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
    ctx.preload.addPart('41-tools-favicon', {
      code: [
        "if (KOSMO.protocol !== 'kosmo:' || !KOSMO.isTop || KOSMO.host === 'error') return;",
        'const put = () => {',
        "  if (document.querySelector('link[rel~=\"icon\"]')) return;",
        "  const l = document.createElement('link');",
        "  l.rel = 'icon'; l.type = 'image/svg+xml'; l.href = " + JSON.stringify(icon) + ';',
        '  (document.head || document.documentElement).appendChild(l);',
        '};',
        "if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', put, { once: true }); else put();",
      ].join('\n'),
    });
  } catch (e) { ctx.log('tools-pack', 'значок для kosmo:// не подключён:', e.message); }

  // ---------- окно на панели задач Windows ----------
  // Иконку окна ставит core (windows.js: assets/icon.ico). Здесь — данные для закрепления на панели задач:
  // без них закреплённый значок запускал бы голый electron.exe (демо Electron), а не Космолёт.
  ctx.bus.on('windows:created', (win) => {
    if (process.platform !== 'win32' || !win || typeof win.setAppDetails !== 'function') return;
    const ico = path.join(ctx.paths.root, 'assets', 'icon.ico');
    try {
      win.setAppDetails({
        appId: 'Kosmolet',
        appIconPath: fs.existsSync(ico) ? ico : '',
        appIconIndex: 0,
        relaunchCommand: `"${process.execPath}" "${ctx.paths.root}"`,
        relaunchDisplayName: 'Космолёт',
      });
    } catch (e) { ctx.log('tools-pack', 'setAppDetails:', e.message); }
  });

  ctx.toolsPack = {
    snippets: () => all(),
    builtins: () => builtins(),
    runSnippet: (tabId, code, world) => runner.runInTab(tabFor(tabId), code, { world }),
    xray: (tabId) => xray.run(ctx, tabFor(tabId)),
    matchUrl,
  };
}

module.exports = { id: 'tools-pack', init, matchUrl };
