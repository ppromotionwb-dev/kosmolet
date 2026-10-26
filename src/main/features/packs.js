'use strict';
// Фича «packs» — платформа паков (решение консилиума, разделы 3–4): загрузчик деклараций, установка копией по хэшу,
// лист прав и лист разницы (рисует overlay ядра), связанные папки для разработки, умолчания сайтов «пользователь >
// пак > ядро», сниппеты паков в изолированном мире, метаданные контейнеров (ctx.scopes).
//
// Пак — папка с kosmo-pack.json (формат и проверка — packs/manifest.js). Своего кода в main у пака нет: ядро читает
// декларации и само их исполняет. Операции, политики, identity и scopeSchema здесь только загружаются и проверяются —
// исполнять их будет исполнитель (следующий этап); для него — ctx.packs.operations(containerId) и т. п.
//
// Хранилища (userData): packs/<id>/<treeHash>/ — копии установленных паков (загрузка только оттуда);
// packs.lock.json — {id, version, treeHash, granted, enabled, global, history[]}; gen/packs-index.json — индекс,
// который ядро читает на старте (≤ 5 мс); pack-data/<id>/ — данные пака (при обновлении не трогаются);
// scopes.json — метаданные контейнеров (packs/scopes.js). Встроенные паки — <проект>/packs/builtin/<папка>/.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const M = require('./packs/manifest');
const perms = require('./packs/perms');
const { createScopes } = require('./packs/scopes');

const INDEX_V = 1;
const DEV_PREFIX = 'dev:';
const SHEET = 'pack-sheet';
const KEEP_HISTORY = 2;
const SNIPPET_TIMEOUT = 15000;
const SNIPPET_LOG = 20;
const HIDE_TYPES = ['bangs', 'adblockAllow', 'siteThemes'];
const LAYER_TYPES = ['bangs', 'bookmarks', 'adblockAllow', 'siteThemes', 'capture'];

function isPlain(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { /* занято — уберётся позже */ } }
function hostOf(u) { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.hostname.toLowerCase() : ''; } catch (_) { return ''; } }
function normAllow(s) { return String(s || '').trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/^\*\./, '').replace(/^www\./, ''); }
function worldName(id) { return 'kosmolet-pack-' + id; }

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
  try { fs.renameSync(tmp, file); } catch (e) { fs.copyFileSync(tmp, file); fs.unlinkSync(tmp); }
}

function init(ctx) {
  const log = (...a) => ctx.log('packs', ...a);
  const S = ctx.settings;
  const USER_DIR = path.join(ctx.paths.userData, 'packs');
  const DATA_DIR = path.join(ctx.paths.userData, 'pack-data');
  const BUILTIN_DIR = path.join(ctx.paths.root, 'packs', 'builtin');
  const INDEX_FILE = path.join(ctx.paths.gen || path.join(ctx.paths.userData, 'gen'), 'packs-index.json');
  const freshProfile = !fs.existsSync(path.join(ctx.paths.userData, 'bookmarks.json'));

  S.addDefaults({ packs: { devFolders: [], hidden: { bangs: [], adblockAllow: [], siteThemes: [] } } });

  const lockStore = ctx.store('packs.lock', { version: 1, packs: {} });
  const lockData = () => { const d = lockStore.get(); if (!isPlain(d.packs)) d.packs = {}; return d; };
  const lockOf = (id) => lockData().packs[id] || null;
  function setLock(id, entry) { const d = lockData(); if (entry) d.packs[id] = entry; else delete d.packs[id]; lockStore.set(d); }

  const packs = new Map(); // id → { id, meta, dir, source: builtin|folder|dev, stamp?, errors?, devPath?, loadedAt }
  const devState = new Map(); // dev:id → { enabled, global }
  const listeners = new Set();
  const stats = { indexMs: 0, count: 0, rebuilt: false };
  let scopes = null;

  // ---------- индекс ----------
  function writeIndex() {
    const out = { v: INDEX_V, at: Date.now(), packs: {} };
    for (const e of packs.values()) {
      if (e.source === 'dev' || !e.meta) continue;
      out.packs[e.id] = { meta: e.meta, dir: e.dir, source: e.source, stamp: e.stamp || null };
    }
    try { writeJsonAtomic(INDEX_FILE, out); } catch (err) { log('индекс не записан:', err.message); }
  }

  function grantedOf(meta) {
    return { hosts: meta.permissions.hosts.slice(), capabilities: meta.permissions.capabilities.slice(), readClaims: meta.permissions.readClaims.slice(), at: Date.now() };
  }

  function loadAtStart() {
    const t0 = process.hrtime.bigint();
    let idx = null;
    try { idx = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')); } catch (_) { idx = null; }
    const fromIndex = idx && idx.v === INDEX_V && isPlain(idx.packs) ? idx.packs : {};
    let dirty = !idx;
    // встроенные: по отпечатку (пути, размеры, время) — пересобираем только изменённые
    let builtinNames = [];
    try { builtinNames = fs.readdirSync(BUILTIN_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch (_) { builtinNames = []; }
    const seenBuiltin = new Set();
    for (const name of builtinNames) {
      const dir = path.join(BUILTIN_DIR, name);
      // из индекса — сразу; отпечаток файлов сверяется после старта (verifyBuiltins), чтобы не тратить бюджет 5 мс
      const hit = Object.values(fromIndex).find((x) => x && x.source === 'builtin' && x.dir === dir && x.meta);
      if (hit) { packs.set(hit.meta.id, { id: hit.meta.id, meta: hit.meta, dir, source: 'builtin', stamp: hit.stamp, loadedAt: Date.now() }); seenBuiltin.add(hit.meta.id); continue; }
      let st;
      try { st = M.stamp(dir); } catch (e) { log(`встроенный пак ${name}:`, e.message); continue; }
      const r = M.compile(dir);
      dirty = true; stats.rebuilt = true;
      if (!r.ok) { log(`встроенный пак ${name} с ошибками:`, JSON.stringify(r.errors.slice(0, 5))); continue; }
      packs.set(r.pack.id, { id: r.pack.id, meta: r.pack, dir, source: 'builtin', stamp: st, loadedAt: Date.now() });
      seenBuiltin.add(r.pack.id);
    }
    // установленные: из индекса (папка копии должна существовать), иначе — по lock
    const locks = lockData().packs;
    for (const [id, l] of Object.entries(locks)) {
      if (l.source !== 'folder') continue;
      const dir = path.join(USER_DIR, id, l.treeHash);
      const hit = fromIndex[id];
      if (hit && hit.dir === dir && hit.meta && hit.meta.version === l.version) {
        packs.set(id, { id, meta: hit.meta, dir, source: 'folder', loadedAt: Date.now() });
        continue;
      }
      dirty = true; stats.rebuilt = true;
      if (!fs.existsSync(dir)) { log(`копия пака ${id} не найдена (${dir}) — пак выключен`); packs.set(id, { id, meta: null, dir, source: 'folder', errors: [{ file: '', path: '', message: 'копия пака не найдена', hint: 'установите пак заново' }] }); continue; }
      const r = M.compile(dir);
      packs.set(id, r.ok ? { id, meta: r.pack, dir, source: 'folder', loadedAt: Date.now() } : { id, meta: r.pack, dir, source: 'folder', errors: r.errors });
    }
    stats.indexMs = Number(process.hrtime.bigint() - t0) / 1e6;
    stats.count = packs.size;
    // lock для встроенных: включены, права — все объявленные (это часть приложения)
    for (const id of seenBuiltin) {
      const e = packs.get(id);
      const l = lockOf(id);
      if (!l) {
        setLock(id, { id, version: e.meta.version, source: 'builtin', enabled: true, global: null, granted: grantedOf(e.meta), history: [], seeded: !freshProfile, adopted: false, installedAt: Date.now(), updatedAt: Date.now() });
      } else if (l.version !== e.meta.version || JSON.stringify(l.granted && l.granted.hosts) !== JSON.stringify(e.meta.permissions.hosts)) {
        setLock(id, Object.assign({}, l, { version: e.meta.version, granted: grantedOf(e.meta), updatedAt: Date.now() }));
      }
    }
    if (dirty) writeIndex();
    log(`индекс паков: ${packs.size} пак(ов) за ${stats.indexMs.toFixed(2)} мс${stats.rebuilt ? ' (пересобран)' : ''}`);
  }

  // Встроенные паки меняются только с приложением (или при разработке): сверка отпечатка — после старта.
  function verifyBuiltins() {
    let changed = 0;
    for (const e of Array.from(packs.values())) {
      if (e.source !== 'builtin') continue;
      let st;
      try { st = M.stamp(e.dir); } catch (err) { log('встроенный пак:', err.message); continue; }
      if (st === e.stamp) continue;
      const r = M.compile(e.dir);
      if (!r.ok) { log(`встроенный пак ${e.id} с ошибками:`, JSON.stringify(r.errors.slice(0, 5))); continue; }
      e.meta = r.pack; e.stamp = st; e.loadedAt = Date.now();
      const l = lockOf(e.id);
      if (l) setLock(e.id, Object.assign({}, l, { version: r.pack.version, granted: grantedOf(r.pack), updatedAt: Date.now() }));
      changed++;
    }
    if (changed) { writeIndex(); emitChange('builtin'); log(`встроенные паки пересобраны: ${changed}`); }
  }

  // ---------- активность и включение ----------
  function entry(id) { return packs.get(String(id || '')) || null; }
  function isDev(id) { return String(id).startsWith(DEV_PREFIX); }
  function enabledFlag(e) {
    if (!e || !e.meta || (e.errors && e.errors.length)) return false;
    if (e.source === 'dev') { const d = devState.get(e.id); return !d || d.enabled !== false; }
    const l = lockOf(e.id);
    return !!(l && l.enabled !== false);
  }
  function globalFlag(e) {
    if (!e || !e.meta) return false;
    if (e.source === 'dev') { const d = devState.get(e.id); return d && typeof d.global === 'boolean' ? d.global : !!e.meta.global; }
    const l = lockOf(e.id);
    return l && typeof l.global === 'boolean' ? l.global : !!e.meta.global;
  }
  function active() { return Array.from(packs.values()).filter(enabledFlag); }

  function isEnabled(id, containerId) {
    const e = entry(id);
    if (!enabledFlag(e)) return false;
    const cid = String(containerId || 'main');
    // пак из связанной папки не работает в защищённых контейнерах (реальные клиенты), пока его не установят
    if (e.source === 'dev' && scopes && scopes.isProtected(cid)) return false;
    if (globalFlag(e)) return true;
    const raw = scopes ? scopes.raw(cid) : null;
    return !!(raw && Array.isArray(raw.packs) && raw.packs.includes(e.id));
  }
  function enabledIn(containerId) { return active().filter((e) => isEnabled(e.id, containerId)); }
  // Пак действует хоть где-то: глобальный или включён хотя бы в одном контейнере.
  function anywhere(e) { return enabledFlag(e) && (globalFlag(e) || ctx.sessions.containers().some((c) => isEnabled(e.id, c.id))); }

  // ---------- события ----------
  let layerCache = null;
  function emitChange(reason) {
    layerCache = null;
    for (const fn of listeners) { try { fn(reason); } catch (e) { log(e); } }
    ctx.bus.emit('packs:changed', reason);
    ctx.broadcast('kosmo:packs.changed', { reason: reason || '', at: Date.now() });
  }

  // ---------- умолчания сайтов: слой «пользователь > пак > ядро» ----------
  function hidden(type) { const h = S.peek('packs.hidden') || {}; return Array.isArray(h[type]) ? h[type] : []; }
  function computeLayers() {
    const out = { bangs: [], bookmarks: [], adblockAllow: [], siteThemes: [], capture: [] };
    const seen = { bangs: new Set(), bookmarks: new Set(), adblockAllow: new Set(), siteThemes: new Set(), capture: new Set() };
    for (const e of active()) {
      if (!anywhere(e)) continue;
      const sd = e.meta.siteDefaults || {};
      const tag = { pack: e.id, packName: e.meta.name };
      for (const b of sd.bangs || []) if (!seen.bangs.has(b.key)) { seen.bangs.add(b.key); out.bangs.push(Object.assign({ key: b.key, value: Object.assign({}, b, tag) }, tag)); }
      for (const b of sd.bookmarks || []) if (!seen.bookmarks.has(b.url)) { seen.bookmarks.add(b.url); out.bookmarks.push(Object.assign({ key: b.url, value: Object.assign({}, b) }, tag)); }
      for (const h of sd.adblockAllow || []) if (!seen.adblockAllow.has(h)) { seen.adblockAllow.add(h); out.adblockAllow.push(Object.assign({ key: h, value: h }, tag)); }
      for (const [h, v] of Object.entries(sd.siteThemes || {})) if (!seen.siteThemes.has(h)) { seen.siteThemes.add(h); out.siteThemes.push(Object.assign({ key: h, value: Object.assign({}, v) }, tag)); }
      for (const h of sd.capture || []) if (!seen.capture.has(h)) { seen.capture.add(h); out.capture.push(Object.assign({ key: h, value: h }, tag)); }
    }
    return out;
  }
  function layersAll() { if (!layerCache) layerCache = computeLayers(); return layerCache; }
  // Вклад паков в слой type без скрытых пользователем ключей (withHidden — со скрытыми и флагом hidden).
  function layer(type, opts = {}) {
    if (!LAYER_TYPES.includes(type)) throw new Error('неизвестный слой: ' + type);
    const h = HIDE_TYPES.includes(type) ? hidden(type) : [];
    const items = layersAll()[type].map((x) => Object.assign({}, x, { hidden: h.includes(x.key) }));
    return opts.withHidden ? items : items.filter((x) => !x.hidden);
  }
  function hide(type, key, on) {
    if (!HIDE_TYPES.includes(type)) throw new Error('скрыть можно: ' + HIDE_TYPES.join(', '));
    const k = String(key || '').slice(0, 300);
    const cur = hidden(type);
    const next = on === false ? cur.filter((x) => x !== k) : Array.from(new Set(cur.concat(k)));
    S.set(['packs', 'hidden', type], next);
    return next;
  }
  S.on('change', (p) => { if (p === 'packs' || String(p).startsWith('packs.hidden')) { layerCache = null; ctx.bus.emit('packs:changed', 'hidden'); } });

  // Встроенный пак «забирает» значения пользователя, совпадающие с его умолчаниями (это прежние умолчания ядра):
  // поведение не меняется, но теперь ими управляет пак. Один раз на пак.
  function adopt(e) {
    const sd = e.meta.siteDefaults || {};
    let n = 0;
    try {
      const bangs = S.get('search.bangs') || [];
      const same = (u, p) => u.key === p.key && u.url === p.url && String(u.numericUrl || '') === String(p.numericUrl || '');
      const keep = bangs.filter((u) => !(sd.bangs || []).some((p) => same(u, p)));
      // свой бэнг с тем же ключом остаётся своим; быстрой кнопкой он был и раньше — сохраняем это
      let chips = 0;
      for (const u of keep) { const p = (sd.bangs || []).find((x) => x.key === u.key); if (p && p.chip && u.chip == null) { u.chip = true; chips++; } }
      if (keep.length !== bangs.length || chips) { S.set('search.bangs', keep); n += bangs.length - keep.length; }
      const allow = S.get('privacy.adblockAllow') || [];
      const packAllow = new Set((sd.adblockAllow || []).map(normAllow));
      const keepA = allow.filter((h) => !packAllow.has(normAllow(h)));
      if (keepA.length !== allow.length) { S.set('privacy.adblockAllow', keepA); n += allow.length - keepA.length; }
      const sites = S.get('siteThemes.sites') || {};
      for (const [h, v] of Object.entries(sd.siteThemes || {})) {
        if (sites[h] && JSON.stringify(sortKeys(sites[h])) === JSON.stringify(sortKeys(v))) { S.remove(['siteThemes', 'sites', h]); n++; }
      }
    } catch (err) { log('перенос умолчаний в пак:', err.message); }
    const l = lockOf(e.id);
    if (l) setLock(e.id, Object.assign({}, l, { adopted: true }));
    if (n) log(`пак ${e.id} взял на себя ${n} значени(й) пользователя, совпавших с его умолчаниями`);
  }
  function sortKeys(o) { return Object.keys(o || {}).sort().reduce((a, k) => { a[k] = o[k]; return a; }, {}); }

  function seedBookmarks(e) {
    const l = lockOf(e.id);
    if (!l || l.seeded || !ctx.bookmarks) return;
    const list = (e.meta.siteDefaults && e.meta.siteDefaults.bookmarks) || [];
    let i = 0;
    for (const b of list) {
      try { if (!ctx.bookmarks.has(b.url)) ctx.bookmarks.add({ url: b.url, title: b.title, folder: 'bar', index: i }); i++; } catch (err) { log('закладка пака:', err.message); }
    }
    setLock(e.id, Object.assign({}, l, { seeded: true }));
  }

  // ---------- сниппеты пака ----------
  const codeCache = new Map(); // file → {mtimeMs, code}
  function snippetCode(e, file) {
    const full = M.inside(e.dir, file);
    if (!full) throw new Error('путь сниппета вне пака');
    const st = fs.statSync(full);
    const hit = codeCache.get(full);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.code;
    const code = fs.readFileSync(full, 'utf8');
    codeCache.set(full, { mtimeMs: st.mtimeMs, code });
    return code;
  }
  const snippetLog = new Map(); // tabId → {url, entries}
  async function injectSnippets(tab, wc) {
    if (!wc || wc.isDestroyed()) return;
    const url = wc.getURL();
    const host = hostOf(url);
    const cid = tab.info.containerId;
    const rec = { url, entries: [] };
    if (!host) { snippetLog.delete(tab.id); return; }
    const jobs = [];
    for (const e of enabledIn(cid)) {
      if (!M.hostCovered(host, e.meta.permissions.hosts)) continue; // только хосты манифеста
      for (const s of e.meta.snippets || []) {
        if (s.run !== 'auto') continue;
        if (!s.match.some((m) => { const p = M.parsePattern(m); return !p.error && M.matchPattern(p, url); })) continue;
        jobs.push({ e, s });
      }
    }
    if (!jobs.length) { snippetLog.delete(tab.id); return; }
    snippetLog.set(tab.id, rec);
    for (const { e, s } of jobs) {
      if (tab.wc !== wc || wc.isDestroyed() || wc.getURL() !== url) return;
      const t0 = Date.now();
      const item = { pack: e.id, file: s.file, name: s.name, at: t0, ok: false, ms: 0, error: '' };
      try {
        if (!ctx.cdp || typeof ctx.cdp.evalInWorld !== 'function') throw new Error('нет CDP');
        const code = snippetCode(e, s.file);
        const wrapped = `(async () => {\n${code}\n})().then(() => ({ ok: true }), (e) => ({ ok: false, error: String((e && e.message) || e) }))\n//# sourceURL=kosmo-pack/${e.id}/${s.file}`;
        const r = await ctx.cdp.evalInWorld(tab.id, wrapped, { world: worldName(e.id), timeoutMs: SNIPPET_TIMEOUT });
        item.ok = !!(r && r.ok);
        if (r && r.error) item.error = String(r.error).slice(0, 300);
      } catch (err) { item.error = String(err && err.message || err).slice(0, 300); }
      item.ms = Date.now() - t0;
      rec.entries.push(item);
      if (rec.entries.length > SNIPPET_LOG) rec.entries.shift();
      if (!item.ok && !/destroyed|navigat|выгружена/i.test(item.error)) log(`сниппет ${e.id}/${s.file} на ${url}: ${item.error}`);
    }
  }
  ctx.tabs.on('view-created', (tab, wc) => {
    wc.on('dom-ready', () => { injectSnippets(tab, wc).catch((err) => log('сниппеты:', err.message)); });
  });
  ctx.tabs.on('closed', (tab) => snippetLog.delete(tab.id));

  // Ручные сниппеты пака — в библиотеку «Сниппеты» (tools-pack). Выполняются в мире пака, только на его хостах.
  function librarySnippets() {
    const out = [];
    for (const e of active()) {
      if (!anywhere(e)) continue;
      (e.meta.snippets || []).forEach((s, i) => {
        if (s.run !== 'manual') return;
        let code = '';
        try { code = snippetCode(e, s.file); } catch (_) { return; }
        out.push({ id: `pack:${e.id}:${i}`, name: s.name, desc: s.desc || '', world: 'isolated', code, builtin: true, pack: e.id, packName: e.meta.name, hosts: e.meta.permissions.hosts.slice(), worldName: worldName(e.id) });
      });
    }
    return out;
  }
  function checkSnippetRun(snippet, tab) {
    if (!snippet || !snippet.pack) return null;
    const host = hostOf(tab && tab.wc && !tab.wc.isDestroyed() ? tab.wc.getURL() : tab && tab.info.url);
    if (!M.hostCovered(host, snippet.hosts)) return `Сниппет пака «${snippet.packName}» работает только на ${snippet.hosts.join(', ')}`;
    if (!isEnabled(snippet.pack, tab.info.containerId)) return `Пак «${snippet.packName}» не включён в этом контейнере`;
    return null;
  }

  // ---------- лист прав и разницы (overlay) ----------
  const sheetQueue = [];
  let sheet = null; // {id, data, resolve, hidden}
  let answering = false;
  function requestApproval(data) {
    return new Promise((resolve) => {
      sheetQueue.push({ id: 'ps' + crypto.randomBytes(6).toString('hex'), data, resolve, hidden: false });
      pumpSheet();
    });
  }
  function showSheet() {
    if (!sheet) return;
    sheet.hidden = false;
    try { ctx.overlay.open({ type: SHEET, modal: true, data: Object.assign({}, sheet.data, { sheetId: sheet.id }) }); } catch (e) { log('лист прав:', e.message); }
  }
  function pumpSheet() {
    if (sheet || !sheetQueue.length) return;
    sheet = sheetQueue.shift();
    showSheet();
    ctx.broadcast('kosmo:packs.changed', { reason: 'sheet', at: Date.now() });
  }
  function finishSheet(approve, reason) {
    const s = sheet;
    if (!s) return false;
    sheet = null;
    try { s.resolve(!!approve); } catch (_) { /* ignore */ }
    log(`лист ${s.data.kind === 'update' ? 'разницы' : 'прав'} «${s.data.pack.name}»: ${approve ? 'утверждён' : 'отклонён'}${reason ? ' (' + reason + ')' : ''}`);
    setTimeout(pumpSheet, 0);
    ctx.broadcast('kosmo:packs.changed', { reason: 'sheet', at: Date.now() });
    return true;
  }
  // Отмена — только явная (Esc, клик мимо, «Отмена»: причина 'close'). Остальное (смена вкладки, фокус, ресайз, потеря
  // фокуса окном) прячет лист, и он возвращается сам: решение по правам не должно теряться от случайного клика.
  ctx.overlay.on('closed', (type, reason) => {
    if (!sheet || answering || type !== SHEET || sheet.hidden) return;
    if (reason === 'close') { finishSheet(false, reason); return; }
    sheet.hidden = true;
    if (reason !== 'blur' && reason !== 'resize') setTimeout(() => { if (sheet && sheet.hidden && !ctx.overlay.isOpen()) showSheet(); }, 300);
  });
  ctx.overlay.on('opened', (type) => { if (sheet && !sheet.hidden && type !== SHEET) sheet.hidden = true; });
  ctx.overlay.on('closed', (type) => { if (sheet && sheet.hidden && type !== SHEET) setTimeout(() => { if (sheet && sheet.hidden && !ctx.overlay.isOpen()) showSheet(); }, 60); });
  ctx.bus.once('windows:created', () => {
    ctx.windows.on('focus', () => { if (sheet && sheet.hidden) setTimeout(() => { if (sheet && sheet.hidden && !ctx.overlay.isOpen()) showSheet(); }, 80); });
  });
  // Ответ принимается ТОЛЬКО от overlay ядра: инструменты моста адресуют вкладки, страницы — свои каналы, агент
  // нажать «Установить» не может.
  function respondSheet(p, meta) {
    const ov = ctx.overlay.webContents();
    if (!ov || !meta || meta.webContents !== ov) throw new Error('утверждение принимается только из окна утверждения Космолёта');
    if (!sheet || String(p && p.id) !== sheet.id) return false;
    answering = true;
    try {
      finishSheet(!!(p && p.approve), 'ответ');
      const cur = ctx.overlay.current();
      if (cur && cur.type === SHEET) ctx.overlay.close('answered');
    } finally { answering = false; }
    return true;
  }
  function pendingSheet() {
    return sheet ? { id: sheet.id, kind: sheet.data.kind, pack: sheet.data.pack, hidden: sheet.hidden, extended: !!sheet.data.extended, summary: sheet.data.summary || '', items: (sheet.data.items || []).map((x) => x.text) } : null;
  }
  function showPending() { if (sheet) showSheet(); return pendingSheet(); }

  function sheetData(meta, prevMeta, source) {
    const base = { pack: { id: meta.id, name: meta.name, version: meta.version, description: meta.description, fromVersion: prevMeta ? prevMeta.version : null }, source };
    if (!prevMeta) {
      return Object.assign(base, { kind: 'install', items: perms.phrases(meta), extended: true, summary: meta.global ? 'Пак будет работать во всех контейнерах.' : 'После установки включите пак в нужных контейнерах.' });
    }
    const d = perms.diff(prevMeta, meta);
    return Object.assign(base, {
      kind: 'update', items: d.items, extended: d.extended,
      summary: d.extended ? 'Права пака расширяются — проверьте новое.' : `Обновление ${prevMeta.version} → ${meta.version}, права не расширяются.`,
      all: perms.phrases(meta),
    });
  }

  // ---------- установка, обновление, удаление, откат ----------
  function fail(errors, warnings) { return { ok: false, errors: errors || [], warnings: warnings || [] }; }

  async function installFromFolder(src, opts = {}) {
    const from = path.resolve(String(src || ''));
    if (!src || !fs.existsSync(from) || !fs.statSync(from).isDirectory()) return fail([{ file: '', path: '', message: 'папка не найдена: ' + from, hint: 'укажите папку, где лежит kosmo-pack.json' }]);
    const rel = path.relative(USER_DIR, from);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return fail([{ file: '', path: '', message: 'это копия уже установленного пака', hint: 'устанавливайте из исходной папки' }]);
    try { M.walk(from); } catch (e) { return fail([{ file: '', path: '', message: e.message, hint: e.hint || '' }]); }
    const stage = path.join(USER_DIR, '.staging', crypto.randomBytes(6).toString('hex'));
    try {
      fs.mkdirSync(path.dirname(stage), { recursive: true });
      fs.cpSync(from, stage, { recursive: true, filter: (s) => !['.git', 'node_modules'].includes(path.basename(s)) });
    } catch (e) { rmrf(stage); return fail([{ file: '', path: '', message: 'не удалось скопировать папку: ' + e.message }]); }
    // Проверка и хэш — по скопированному: утверждается ровно то, что будет загружаться.
    const r = M.compile(stage);
    if (!r.ok) { rmrf(stage); return fail(r.errors, r.warnings); }
    const meta = r.pack;
    const id = meta.id;
    const cur = entry(id);
    if (cur && cur.source === 'builtin') { rmrf(stage); return fail([{ file: M.MANIFEST, path: 'id', message: `id ${id} занят встроенным паком`, hint: 'выберите другое пространство имён' }]); }
    const hash = M.treeHash(stage);
    const l = lockOf(id);
    if (l && l.treeHash === hash && cur && cur.meta) { rmrf(stage); return { ok: true, unchanged: true, pack: info(id), warnings: r.warnings }; }
    const prevMeta = cur && cur.meta && !(cur.errors && cur.errors.length) ? cur.meta : null;
    const approved = await requestApproval(sheetData(meta, prevMeta, from));
    if (!approved) { rmrf(stage); return { ok: false, cancelled: true, errors: [] }; }
    const dst = path.join(USER_DIR, id, hash);
    try {
      if (fs.existsSync(dst)) rmrf(stage);
      else { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.renameSync(stage, dst); }
    } catch (e) { rmrf(stage); return fail([{ file: '', path: '', message: 'не удалось сохранить копию пака: ' + e.message }]); }
    const now = Date.now();
    const history = l ? [{ treeHash: l.treeHash, version: l.version, granted: l.granted, at: l.updatedAt || l.installedAt || now }].concat(l.history || []).slice(0, KEEP_HISTORY) : [];
    setLock(id, {
      id, version: meta.version, treeHash: hash, source: 'folder', sourcePath: from,
      enabled: l ? l.enabled !== false : true, global: l ? l.global : null,
      granted: grantedOf(meta), history, seeded: l ? !!l.seeded : false, adopted: true,
      installedAt: l ? l.installedAt : now, updatedAt: now,
    });
    pruneCopies(id);
    packs.set(id, { id, meta, dir: dst, source: 'folder', loadedAt: now });
    writeIndex();
    seedBookmarks(packs.get(id));
    emitChange(l ? 'update' : 'install');
    log(`${l ? 'обновлён' : 'установлен'} пак ${id} ${meta.version} (${hash})`);
    return { ok: true, updated: !!l, pack: info(id), warnings: r.warnings };
  }

  // Оставить текущую и KEEP_HISTORY предыдущих копий.
  function pruneCopies(id) {
    const l = lockOf(id);
    if (!l) return;
    const keep = new Set([l.treeHash].concat((l.history || []).map((h) => h.treeHash)));
    let names = [];
    try { names = fs.readdirSync(path.join(USER_DIR, id)); } catch (_) { return; }
    for (const n of names) if (!keep.has(n)) rmrf(path.join(USER_DIR, id, n));
  }

  function uninstall(id, opts = {}) {
    const e = entry(id);
    if (!e) throw new Error('пак не найден: ' + id);
    if (e.source === 'builtin') throw new Error('встроенный пак удалить нельзя — его можно выключить');
    if (e.source === 'dev') { unlinkFolder(e.devPath); return { ok: true }; }
    setLock(id, null);
    packs.delete(id);
    rmrf(path.join(USER_DIR, id));
    if (!opts.keepData) rmrf(path.join(DATA_DIR, id));
    writeIndex();
    emitChange('uninstall');
    log(`удалён пак ${id}${opts.keepData ? ' (данные оставлены)' : ' вместе с данными'}`);
    return { ok: true };
  }

  // Откат к предыдущей копии (и обратно: текущая становится предыдущей).
  function rollback(id) {
    const e = entry(id);
    const l = lockOf(id);
    if (!e || !l || e.source !== 'folder') throw new Error('откатить можно только установленный пак');
    const prev = (l.history || [])[0];
    if (!prev) throw new Error('предыдущей версии нет');
    const dir = path.join(USER_DIR, id, prev.treeHash);
    if (!fs.existsSync(dir)) throw new Error('копия предыдущей версии не найдена');
    const r = M.compile(dir);
    if (!r.ok) throw new Error('предыдущая версия не проходит проверку: ' + r.errors.map((x) => x.message).join('; '));
    const now = Date.now();
    const history = [{ treeHash: l.treeHash, version: l.version, granted: l.granted, at: l.updatedAt || now }].concat((l.history || []).slice(1)).slice(0, KEEP_HISTORY);
    setLock(id, Object.assign({}, l, { version: prev.version, treeHash: prev.treeHash, granted: prev.granted || grantedOf(r.pack), history, updatedAt: now }));
    packs.set(id, { id, meta: r.pack, dir, source: 'folder', loadedAt: now });
    writeIndex();
    emitChange('rollback');
    log(`пак ${id} откачен к ${prev.version}`);
    return { ok: true, pack: info(id) };
  }

  function setEnabled(id, on) {
    const e = entry(id);
    if (!e) throw new Error('пак не найден: ' + id);
    if (e.source === 'dev') devState.set(e.id, Object.assign({}, devState.get(e.id), { enabled: !!on }));
    else setLock(e.id, Object.assign({}, lockOf(e.id), { enabled: !!on }));
    emitChange('enabled');
    return info(id);
  }

  function setGlobal(id, on) {
    const e = entry(id);
    if (!e) throw new Error('пак не найден: ' + id);
    if (e.source === 'dev') devState.set(e.id, Object.assign({}, devState.get(e.id), { global: !!on }));
    else setLock(e.id, Object.assign({}, lockOf(e.id), { global: !!on }));
    emitChange('global');
    return info(id);
  }

  function enableForContainer(id, containerId, on) {
    const e = entry(id);
    if (!e) throw new Error('пак не найден: ' + id);
    const cid = String(containerId || '');
    if (!ctx.sessions.containers().some((c) => c.id === cid)) throw new Error('нет такого контейнера: ' + cid);
    if (on && e.source === 'dev' && scopes.isProtected(cid)) throw new Error('пак из связанной папки не включается в защищённых контейнерах — сначала установите его');
    if (!on && globalFlag(e)) {
      // глобальный пак выключаем в одном контейнере: дальше он работает по списку контейнеров
      for (const c of ctx.sessions.containers()) if (c.id !== cid) addToScope(c.id, e.id);
      if (e.source === 'dev') devState.set(e.id, Object.assign({}, devState.get(e.id), { global: false }));
      else setLock(e.id, Object.assign({}, lockOf(e.id), { global: false }));
    }
    if (on) addToScope(cid, e.id); else removeFromScope(cid, e.id);
    emitChange('containers');
    return info(id);
  }
  function addToScope(cid, id) { const r = scopes.raw(cid) || {}; const list = r.packs || []; if (!list.includes(id)) scopes.patch(cid, { packs: list.concat(id) }); }
  function removeFromScope(cid, id) { const r = scopes.raw(cid); if (r && (r.packs || []).includes(id)) scopes.patch(cid, { packs: r.packs.filter((x) => x !== id) }); }

  // ---------- связанные папки (разработка) ----------
  const watchers = new Map(); // path → {watcher, timer}
  function devFolders() {
    const list = (S.peek('packs.devFolders') || []).concat((ctx.flags.packDev || []).map((p) => path.resolve(process.cwd(), p)));
    return Array.from(new Set(list.map((p) => path.resolve(String(p)))));
  }
  function loadDev(folder) {
    const r = M.compile(folder);
    const prev = Array.from(packs.values()).find((v) => v.source === 'dev' && v.devPath === folder) || null;
    // манифест не читается (сломан JSON) — оставляем прежний id и последние рабочие декларации, показываем ошибки
    const baseId = r.pack && r.pack.id ? r.pack.id : prev && prev.meta ? prev.meta.baseId : path.basename(folder);
    const id = DEV_PREFIX + baseId;
    const meta = r.pack ? Object.assign({}, r.pack, { id, baseId, name: r.pack.name }) : prev ? prev.meta : null;
    for (const [k, v] of packs) if (v.source === 'dev' && v.devPath === folder && k !== id) packs.delete(k);
    packs.set(id, { id, meta, dir: folder, source: 'dev', devPath: folder, errors: r.ok ? null : r.errors, warnings: r.warnings, loadedAt: Date.now() });
    codeCache.clear();
    return id;
  }
  function watchDev(folder) {
    if (watchers.has(folder)) return;
    let timer = null;
    let w = null;
    try {
      w = fs.watch(folder, { recursive: true }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          const id = loadDev(folder);
          const e = entry(id);
          log(`связанная папка ${folder}: ${e && e.errors ? 'ошибки: ' + e.errors.length : 'перезагружен ' + id}`);
          emitChange('dev-reload');
        }, 300);
      });
      w.on('error', () => {});
    } catch (e) { log('слежение за папкой не включилось:', e.message); }
    watchers.set(folder, { watcher: w, get timer() { return timer; } });
  }
  function linkFolder(folder) {
    const p = path.resolve(String(folder || ''));
    if (!fs.existsSync(path.join(p, M.MANIFEST))) throw new Error('в папке нет kosmo-pack.json');
    const list = (S.get('packs.devFolders') || []).filter((x) => path.resolve(x) !== p).concat(p);
    S.set('packs.devFolders', list);
    const id = loadDev(p);
    watchDev(p);
    emitChange('dev-link');
    return info(id);
  }
  function unlinkFolder(folder) {
    const p = path.resolve(String(folder || ''));
    S.set('packs.devFolders', (S.get('packs.devFolders') || []).filter((x) => path.resolve(x) !== p));
    const w = watchers.get(p);
    if (w) { try { w.watcher && w.watcher.close(); } catch (_) { /* ignore */ } watchers.delete(p); }
    for (const [k, v] of packs) if (v.source === 'dev' && v.devPath === p) packs.delete(k);
    emitChange('dev-unlink');
    return true;
  }
  function reload(id) {
    const e = entry(id);
    if (!e) throw new Error('пак не найден: ' + id);
    if (e.source === 'dev') loadDev(e.devPath);
    else if (e.source === 'builtin') { const r = M.compile(e.dir); if (r.ok) { e.meta = r.pack; e.stamp = M.stamp(e.dir); writeIndex(); } }
    emitChange('reload');
    return info(id);
  }

  // ---------- сведения для интерфейса ----------
  function containersCount(e) {
    const all = ctx.sessions.containers();
    const ids = all.filter((c) => isEnabled(e.id, c.id)).map((c) => c.id);
    return { enabled: ids.length, total: all.length, ids };
  }
  function stateOf(e) {
    if (e.errors && e.errors.length) return { text: `Не загружен: ${e.errors.length} ${e.errors.length === 1 ? 'ошибка' : 'ошибок'} в паке`, tone: 'danger' };
    if (!enabledFlag(e)) return { text: 'Выключен', tone: 'muted' };
    const c = containersCount(e);
    if (!c.enabled) return { text: 'Не включён ни в одном контейнере', tone: 'warn' };
    if (e.source === 'dev') return { text: 'Связанная папка, перезагружен ' + new Date(e.loadedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }), tone: 'accent' };
    return { text: 'Работает', tone: 'ok' };
  }
  function info(id) {
    const e = entry(id);
    if (!e) return null;
    const m = e.meta || {};
    const l = e.source === 'dev' ? null : lockOf(e.id);
    const prev = l && l.history && l.history[0] ? { version: l.history[0].version, treeHash: l.history[0].treeHash } : null;
    return {
      id: e.id, name: m.name || e.id, version: m.version || '', description: m.description || '',
      source: e.source, sourcePath: e.source === 'dev' ? e.devPath : l ? l.sourcePath || null : null, dir: e.dir,
      enabled: enabledFlag(e), global: globalFlag(e), globalDefault: !!m.global, protect: !!m.protect,
      containers: containersCount(e), state: stateOf(e),
      errors: e.errors || [], warnings: e.warnings || [],
      prev, treeHash: l ? l.treeHash || null : null, installedAt: l ? l.installedAt : null, updatedAt: l ? l.updatedAt : null,
      phrases: e.meta ? perms.phrases(e.meta) : [],
      hosts: m.permissions ? m.permissions.hosts : [],
      scope: m.scopeSchema ? { kind: m.scopeSchema.kind, title: m.scopeSchema.title || m.scopeSchema.kind } : null,
      counts: { snippets: (m.snippets || []).length, operations: (m.operations || []).length, policies: (m.policies || []).length, skills: m.agent ? (m.agent.skills || []).length : 0 },
    };
  }
  function list() {
    const order = { builtin: 0, folder: 1, dev: 2 };
    return Array.from(packs.values()).sort((a, b) => (order[a.source] - order[b.source]) || String(a.id).localeCompare(b.id)).map((e) => info(e.id));
  }

  // ---------- для исполнителя (следующий этап) ----------
  function opRisk(e, op) {
    const l = e.source === 'dev' ? null : lockOf(e.id);
    const granted = l && l.granted ? l.granted.readClaims || [] : (e.source === 'builtin' ? e.meta.permissions.readClaims : []);
    return op.riskIfClaimGranted === 'read' && granted.includes(op.id) ? 'read' : op.risk;
  }
  function operations(containerId) {
    const out = [];
    for (const e of containerId ? enabledIn(containerId) : active()) {
      for (const op of e.meta.operations || []) out.push({ id: `${e.id}/${op.id}`, pack: e.id, packName: e.meta.name, title: op.title, risk: opRisk(e, op), op: clone(op) });
    }
    return out;
  }
  function operation(nsId) {
    const s = String(nsId || '');
    const i = s.lastIndexOf('/');
    if (i < 0) return null;
    const e = entry(s.slice(0, i));
    if (!e || !e.meta) return null;
    const op = (e.meta.operations || []).find((o) => o.id === s.slice(i + 1));
    return op ? { id: s, pack: e.id, risk: opRisk(e, op), op: clone(op), dir: e.dir } : null;
  }
  const part = (key) => (packId) => { const e = entry(packId); return e && e.meta ? clone(e.meta[key]) || null : null; };

  function contributions(type) {
    const out = [];
    for (const e of active()) {
      const m = e.meta;
      let v;
      if (LAYER_TYPES.includes(type)) v = (m.siteDefaults || {})[type];
      else if (type === 'siteDefaults') v = m.siteDefaults;
      else v = m[type];
      if (v == null || (Array.isArray(v) && !v.length) || (isPlain(v) && !Object.keys(v).length)) continue;
      out.push({ pack: e.id, packName: m.name, value: clone(v) });
    }
    return out;
  }

  function captureHosts(containerId) {
    const out = new Set();
    for (const e of enabledIn(containerId)) for (const h of (e.meta.siteDefaults && e.meta.siteDefaults.capture) || []) out.add(h);
    return Array.from(out);
  }
  function isCaptureHost(containerId, host) { return !!host && M.hostCovered(String(host).toLowerCase(), captureHosts(containerId)); }

  function dataDir(id) {
    const e = entry(id);
    if (!e) throw new Error('пак не найден: ' + id);
    const d = path.join(DATA_DIR, e.source === 'dev' ? e.meta.baseId || e.id.slice(DEV_PREFIX.length) : e.id);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  function validateFolder(folder) {
    const r = M.compile(path.resolve(String(folder || '')));
    return { ok: r.ok, errors: r.errors, warnings: r.warnings, phrases: r.pack && r.ok ? perms.phrases(r.pack) : [], pack: r.pack ? { id: r.pack.id, name: r.pack.name, version: r.pack.version } : null };
  }

  // ---------- старт ----------
  loadAtStart();
  for (const f of devFolders()) {
    if (!fs.existsSync(path.join(f, M.MANIFEST))) { log('связанная папка без kosmo-pack.json:', f); continue; }
    const id = loadDev(f);
    watchDev(f);
    log(`связанная папка: ${id} из ${f}`);
  }

  scopes = createScopes(ctx, { packs: () => ctx.packs });
  ctx.scopes = scopes;
  scopes.onChange(() => { layerCache = null; ctx.bus.emit('packs:changed', 'scopes'); });

  ctx.packs = {
    list, get: (id) => { const e = entry(id); return e && e.meta && !(e.errors && e.errors.length) ? clone(e.meta) : null; }, info,
    installFromFolder, uninstall, rollback, setEnabled, setGlobal, enableForContainer, isEnabled,
    contributions, layer, hide, onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    operations, operation, scopeSchema: part('scopeSchema'), identity: part('identity'), policies: part('policies'), agent: part('agent'),
    captureHosts, isCaptureHost, librarySnippets, checkSnippetRun, snippetLog: (tabId) => clone(snippetLog.get(Number(tabId)) || null),
    linkFolder, unlinkFolder, reload, validateFolder, dataDir, pendingSheet, showPending, respondSheet,
    stats: () => Object.assign({}, stats), worldName,
    // умолчания сайтов для потребителей ядра
    bangs: () => layer('bangs').map((x) => x.value),
    adblockAllow: () => layer('adblockAllow').map((x) => x.key),
    siteThemes: () => Object.fromEntries(layer('siteThemes').map((x) => [x.key, Object.assign({}, x.value, { _pack: x.pack })])),
  };

  // встроенные паки забирают совпавшие значения пользователя (один раз)
  for (const e of packs.values()) {
    if (e.source !== 'builtin' || !e.meta) continue;
    const l = lockOf(e.id);
    if (l && !l.adopted) adopt(e);
  }
  ctx.bus.once('ready', () => {
    for (const e of active()) { try { seedBookmarks(e); } catch (err) { log('закладки пака:', err.message); } }
    setTimeout(verifyBuiltins, 1500);
  });

  registerIpc(ctx, { list, info, installFromFolder, uninstall, rollback, setEnabled, setGlobal, enableForContainer, layer, hide, respondSheet, linkFolder, unlinkFolder, validateFolder, reload, scopes, lockOf });

  ctx.bus.once('ready', () => {
    // новые/удалённые контейнеры меняют «включён в N из M» — интерфейс перечитает список
    ctx.settings.on('change', (p) => { if (p === 'containers') emitChange('containers'); });
  });
}

function registerIpc(ctx, A) {
  const settingsOnly = { allow: ['ui', 'internal:settings'] };
  const H = (ch, fn, opts) => ctx.ipc.handle(ch, fn, opts || settingsOnly);
  const str = (v, n) => String(v == null ? '' : v).slice(0, n || 400);
  H('kosmo:packs.list', () => ({ packs: A.list(), containers: ctx.sessions.containers().map((c) => ({ id: c.id, name: c.name, color: c.color, temp: !!c.temp, protect: A.scopes.isProtected(c.id) })), devFolders: ctx.settings.get('packs.devFolders') || [], pending: ctx.packs.pendingSheet() }));
  H('kosmo:packs.get', (p = {}) => A.info(str(p.id, 120)));
  H('kosmo:packs.showPending', () => ctx.packs.showPending());
  H('kosmo:packs.installFromFolder', (p = {}) => A.installFromFolder(str(p.path, 2000)));
  H('kosmo:packs.update', (p = {}) => {
    const l = A.lockOf(str(p.id, 120));
    if (!l || !l.sourcePath) throw new Error('у пака нет исходной папки — установите его заново');
    return A.installFromFolder(l.sourcePath);
  });
  H('kosmo:packs.pickInstall', async () => {
    const r = await ctx.electron.dialog.showOpenDialog(ctx.windows.main, { title: 'Папка пака (с kosmo-pack.json)', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, cancelled: true, errors: [] };
    return A.installFromFolder(r.filePaths[0]);
  });
  H('kosmo:packs.pickLink', async () => {
    const r = await ctx.electron.dialog.showOpenDialog(ctx.windows.main, { title: 'Связать с папкой пака (разработка)', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return null;
    return A.linkFolder(r.filePaths[0]);
  });
  H('kosmo:packs.unlink', (p = {}) => A.unlinkFolder(str(p.path, 2000)));
  H('kosmo:packs.uninstall', (p = {}) => A.uninstall(str(p.id, 120), { keepData: p.keepData !== false }));
  H('kosmo:packs.rollback', (p = {}) => A.rollback(str(p.id, 120)));
  H('kosmo:packs.reload', (p = {}) => A.reload(str(p.id, 120)));
  H('kosmo:packs.setEnabled', (p = {}) => A.setEnabled(str(p.id, 120), !!p.on));
  H('kosmo:packs.setGlobal', (p = {}) => A.setGlobal(str(p.id, 120), !!p.on));
  H('kosmo:packs.enableForContainer', (p = {}) => A.enableForContainer(str(p.id, 120), str(p.containerId, 40), !!p.on));
  H('kosmo:packs.validate', (p = {}) => A.validateFolder(str(p.path, 2000)));
  H('kosmo:packs.layer', (p = {}) => ({ items: A.layer(str(p.type, 40), { withHidden: true }) }));
  H('kosmo:packs.hide', (p = {}) => A.hide(str(p.type, 40), str(p.key, 300), p.hidden !== false));
  H('kosmo:packs.openFolder', async (p = {}) => {
    const i = A.info(str(p.id, 120));
    if (!i) throw new Error('пак не найден');
    const err = await ctx.electron.shell.openPath(i.dir);
    if (err) throw new Error(err);
    return true;
  });
  // Лист прав / разницы: только overlay (проверка отправителя — в respondSheet).
  ctx.ipc.handle('kosmo:packs.sheetRespond', (p, meta) => A.respondSheet(p, meta), { allow: ['ui'] });

  // ---------- scope контейнеров ----------
  const cid = (p) => str(p && (p.id || p.containerId), 40);
  H('kosmo:scopes.list', () => A.scopes.list());
  H('kosmo:scopes.get', (p = {}) => A.scopes.get(cid(p)));
  H('kosmo:scopes.set', (p = {}) => A.scopes.set(cid(p), p.scope == null ? null : p.scope));
  H('kosmo:scopes.patch', (p = {}) => A.scopes.patch(cid(p), p.patch || {}));
  H('kosmo:scopes.schemas', () => ctx.packs.list().filter((x) => x.scope && x.enabled).map((x) => ({ pack: x.id, name: x.name, source: x.source, schema: ctx.packs.scopeSchema(x.id) })));
}

module.exports = { id: 'packs', init };
