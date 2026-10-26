'use strict';
// Формат пака v1 (решение консилиума, раздел 3): чтение папки пака и проверка kosmo-pack.json и файлов вкладов.
// Модуль без electron: им пользуются загрузчик, установка и будущий pack_validate.
//
// Ошибка проверки — { file, path, message, hint }: файл пака, путь внутри JSON, что не так и как исправить.
// Результат compile() — «скомпилированный» пак для индекса: все декларации разобраны и проверены, код сниппетов
// остаётся в файлах (читается при использовании).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');

const API = 1;
const MANIFEST = 'kosmo-pack.json';
const ID_RE = /^[a-z0-9][a-z0-9-]{0,30}(\.[a-z0-9][a-z0-9-]{0,30}){1,3}$/;
const LOCAL_ID_RE = /^[a-z][a-z0-9_.-]{0,60}$/;
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,6}(-[0-9a-z.-]{1,20})?$/i;
const CAPS = ['ops.read', 'ops.write', 'ops.money', 'snippets', 'capture'];
const RISKS = ['read', 'write', 'money', 'irreversible'];
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];
const SITE_DEFAULTS = ['bangs', 'bookmarks', 'adblockAllow', 'siteThemes', 'capture'];
const CONTRIBUTES = ['siteDefaults', 'snippets', 'scopeSchema', 'identity', 'operations', 'policies', 'agent'];
const TOP_KEYS = ['id', 'name', 'version', 'description', 'engine', 'global', 'protect', 'permissions', 'contributes', '$schema'];
const FIELD_TYPES = ['string', 'number', 'boolean'];
const THEME_KEYS = ['enabled', 'engine', 'brightness', 'contrast', 'sepia', 'grayscale', 'bg', 'text', 'css'];
const POLICY_KINDS = ['maxChangePct', 'skipWhere', 'maxLength'];
const IDENTITY_SOURCES = ['cookie', 'op', 'page'];
const SKIP = new Set(['.git', 'node_modules', '.DS_Store', 'Thumbs.db']);
const LIMITS = { files: 2000, bytes: 20 * 1024 * 1024, file: 2 * 1024 * 1024, snippet: 200 * 1024, claudeMd: 2048, summary: 400, ops: 500, policies: 200, list: 50 };

function isPlain(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function rank(r) { return RISKS.indexOf(r); }
function maxRisk(a, b) { return rank(a) >= rank(b) ? a : b; }

// ---------- хосты и шаблоны адресов ----------
// Хост в манифесте — имя без схемы, порта и пути: «seller.example.test», «*.example.test», «127.0.0.1», «localhost».
// Запись покрывает сам хост и его поддомены («*.» — то же, для наглядности).
function normHost(s) {
  const v = String(s == null ? '' : s).trim().toLowerCase();
  if (!v) return { error: 'пустой хост' };
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(v)) return { error: 'хост со схемой', hint: 'укажите только имя: ' + v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/:?#].*$/, '') };
  if (/[/?#@\s]/.test(v)) return { error: 'в хосте путь или лишние символы', hint: 'только имя хоста, без пути: ' + v.replace(/[/?#].*$/, '') };
  if (/:\d+$/.test(v)) return { error: 'хост с портом', hint: 'порт не указывается: ' + v.replace(/:\d+$/, '') };
  const base = v.replace(/^\*\./, '');
  if (base === '*' || base.includes('*')) return { error: 'маска «*» разрешена только в начале: *.example.test' };
  if (!(base === 'localhost' || /^(\d{1,3}\.){3}\d{1,3}$/.test(base) || /^([a-z0-9-]+\.)+[a-z0-9-]{2,63}$/.test(base))) return { error: 'не похоже на имя хоста: ' + v };
  return { host: base };
}

function covers(base, host) { return !!host && (host === base || host.endsWith('.' + base)); }
function hostCovered(host, hosts) { return (hosts || []).some((b) => covers(b, String(host || '').toLowerCase())); }
function hostOfUrl(u) { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.hostname.toLowerCase() : ''; } catch (_) { return ''; } }

// Шаблон сниппета: «host/путь*» — «127.0.0.1/*», «*.example.test/items/*». Хост без «*.» — точное совпадение.
function parsePattern(p) {
  const s = String(p || '').trim().toLowerCase().replace(/^https?:\/\//, '');
  const i = s.indexOf('/');
  const hostPart = i < 0 ? s : s.slice(0, i);
  const pathPart = i < 0 ? '/*' : s.slice(i);
  const wild = hostPart.startsWith('*.');
  const h = normHost(hostPart);
  if (h.error) return { error: h.error, hint: h.hint };
  const re = new RegExp('^' + pathPart.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  return { host: h.host, wild, re, source: s };
}
function matchPattern(pat, url) {
  let u;
  try { u = new URL(url); } catch (_) { return false; }
  if (!/^https?:$/.test(u.protocol)) return false;
  const host = u.hostname.toLowerCase();
  if (pat.wild ? !covers(pat.host, host) : host !== pat.host) return false;
  return pat.re.test((u.pathname + u.search).toLowerCase());
}

// ---------- файлы пака ----------
function walk(dir, limits) {
  const out = [];
  let bytes = 0;
  const visit = (rel) => {
    const full = path.join(dir, rel);
    for (const e of fs.readdirSync(full, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isSymbolicLink()) throw Object.assign(new Error('в паке символическая ссылка: ' + r), { hint: 'замените ссылку настоящим файлом' });
      if (e.isDirectory()) { visit(r); continue; }
      if (!e.isFile()) continue;
      const st = fs.statSync(path.join(dir, r));
      if (st.size > (limits || LIMITS).file) throw Object.assign(new Error(`файл больше ${Math.round(LIMITS.file / 1024 / 1024)} МБ: ${r}`), { hint: 'большие данные держите в рабочей папке агента, не в паке' });
      bytes += st.size;
      out.push({ rel: r, size: st.size, mtimeMs: st.mtimeMs });
      if (out.length > LIMITS.files) throw Object.assign(new Error(`в паке больше ${LIMITS.files} файлов`), { hint: 'уберите лишнее (сборки, данные, node_modules)' });
      if (bytes > LIMITS.bytes) throw Object.assign(new Error(`пак больше ${LIMITS.bytes / 1024 / 1024} МБ`), { hint: 'уберите лишнее' });
    }
  };
  visit('');
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { files: out, bytes };
}

// Хэш дерева: пути и содержимое файлов (без .git и node_modules). Копия пака хранится в packs/<id>/<treeHash>/.
function treeHash(dir) {
  const { files } = walk(dir);
  const h = crypto.createHash('sha256');
  for (const f of files) {
    const c = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f.rel))).digest('hex');
    h.update(f.rel + '\0' + c + '\n');
  }
  return h.digest('hex').slice(0, 20);
}

// Отпечаток для встроенных паков: пути, размеры и время изменения (дёшево, без чтения файлов).
function stamp(dir) {
  const { files } = walk(dir);
  return crypto.createHash('sha1').update(files.map((f) => `${f.rel}:${f.size}:${Math.round(f.mtimeMs)}`).join('|')).digest('hex').slice(0, 16);
}

// Путь внутри пака: без выхода за папку пака.
function inside(dir, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || path.isAbsolute(rel) || /^[a-z]:/i.test(rel)) return null;
  const full = path.resolve(dir, rel);
  const back = path.relative(dir, full);
  if (!back || back.startsWith('..') || path.isAbsolute(back)) return null;
  return full;
}

// «ops/*.op.json» → список файлов (поддерживается маска только в имени файла).
function globFiles(dir, pattern) {
  const p = String(pattern || '').replace(/\\/g, '/');
  const slash = p.lastIndexOf('/');
  const sub = slash >= 0 ? p.slice(0, slash) : '';
  const name = slash >= 0 ? p.slice(slash + 1) : p;
  if (sub.includes('*')) return null;
  const base = sub ? inside(dir, sub) : dir;
  if (!base) return null;
  let list;
  try { list = fs.readdirSync(base, { withFileTypes: true }); } catch (_) { return []; }
  const re = new RegExp('^' + name.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
  return list.filter((e) => e.isFile() && re.test(e.name)).map((e) => (sub ? sub + '/' : '') + e.name).sort();
}

// ---------- проверка ----------
function createCheck() {
  const errors = [];
  const warnings = [];
  return {
    errors, warnings,
    err(file, p, message, hint) { errors.push({ file, path: p || '', message, hint: hint || '' }); },
    warn(file, p, message, hint) { warnings.push({ file, path: p || '', message, hint: hint || '' }); },
  };
}

function readJson(dir, rel, C, where) {
  const full = inside(dir, rel);
  if (!full) { C.err(MANIFEST, where, 'путь выходит за папку пака или пустой: ' + rel, 'пути — относительно папки пака, без «..»'); return null; }
  let text;
  try { text = fs.readFileSync(full, 'utf8'); } catch (_) { C.err(rel, '', 'файл не найден', `создайте ${rel} или уберите ссылку из ${where}`); return null; }
  try { return JSON.parse(text.replace(/^﻿/, '')); } catch (e) {
    C.err(rel, '', 'неверный JSON: ' + e.message, 'проверьте запятые и кавычки');
    return null;
  }
}

function str(v, max) { return typeof v === 'string' && v.trim() && v.length <= max; }

function checkHostList(list, file, p, C, hosts, opts = {}) {
  const out = [];
  if (!Array.isArray(list)) { C.err(file, p, 'ожидается массив хостов', 'например ["seller.example.test"]'); return out; }
  list.forEach((h, i) => {
    const r = normHost(h);
    if (r.error) { C.err(file, `${p}[${i}]`, r.error, r.hint); return; }
    if (hosts && !hostCovered(r.host, hosts)) { C.err(file, `${p}[${i}]`, `хост ${r.host} не объявлен в permissions.hosts`, `добавьте его в permissions.hosts${opts.what ? ' или уберите из ' + opts.what : ''}`); return; }
    if (!out.includes(r.host)) out.push(r.host);
  });
  return out;
}

function checkSiteDefaults(sd, hosts, caps, C) {
  const F = MANIFEST;
  const out = { bangs: [], bookmarks: [], adblockAllow: [], siteThemes: {}, capture: [] };
  if (sd == null) return out;
  if (!isPlain(sd)) { C.err(F, 'contributes.siteDefaults', 'ожидается объект'); return out; }
  for (const k of Object.keys(sd)) if (!SITE_DEFAULTS.includes(k)) C.err(F, 'contributes.siteDefaults.' + k, 'неизвестный вклад', 'есть: ' + SITE_DEFAULTS.join(', '));
  const urlOk = (u, p, needQ) => {
    if (typeof u !== 'string' || !/^https?:\/\//i.test(u)) { C.err(F, p, 'нужен адрес http(s)'); return false; }
    if (needQ && !u.includes('{q}')) { C.err(F, p, 'в адресе нужен {q} — на его место встанет запрос'); return false; }
    const host = hostOfUrl(u.split('{q}').join('x'));
    if (!host) { C.err(F, p, 'адрес не разобрался: ' + u); return false; }
    if (!hostCovered(host, hosts)) { C.err(F, p, `хост ${host} не объявлен в permissions.hosts`, 'добавьте его в permissions.hosts'); return false; }
    return true;
  };
  if (sd.bangs != null) {
    if (!Array.isArray(sd.bangs) || sd.bangs.length > LIMITS.list) C.err(F, 'contributes.siteDefaults.bangs', `ожидается массив (до ${LIMITS.list})`);
    else sd.bangs.forEach((b, i) => {
      const p = `contributes.siteDefaults.bangs[${i}]`;
      if (!isPlain(b)) { C.err(F, p, 'бэнг — объект {key, name, url}'); return; }
      const key = String(b.key || '').trim().toLowerCase();
      if (!key || /\s/.test(key) || key.length > 24) { C.err(F, p + '.key', 'ключ — одно слово до 24 символов'); return; }
      if (out.bangs.some((x) => x.key === key)) { C.err(F, p + '.key', 'повтор ключа ' + key); return; }
      if (!urlOk(b.url, p + '.url', true)) return;
      if (b.numericUrl != null && !urlOk(b.numericUrl, p + '.numericUrl', true)) return;
      const o = { key, name: str(b.name, 60) ? b.name.trim() : key, url: b.url };
      if (b.numericUrl) o.numericUrl = b.numericUrl;
      if (str(b.short, 24)) o.short = b.short.trim();
      if (b.chip === true) o.chip = true;
      out.bangs.push(o);
    });
  }
  if (sd.bookmarks != null) {
    if (!Array.isArray(sd.bookmarks) || sd.bookmarks.length > LIMITS.list) C.err(F, 'contributes.siteDefaults.bookmarks', `ожидается массив (до ${LIMITS.list})`);
    else sd.bookmarks.forEach((b, i) => {
      const p = `contributes.siteDefaults.bookmarks[${i}]`;
      if (!isPlain(b) || !str(b.title, 300)) { C.err(F, p, 'закладка — {title, url}'); return; }
      if (!urlOk(b.url, p + '.url', false)) return;
      out.bookmarks.push({ title: b.title.trim(), url: b.url });
    });
  }
  if (sd.adblockAllow != null) out.adblockAllow = checkHostList(sd.adblockAllow, F, 'contributes.siteDefaults.adblockAllow', C, hosts, { what: 'adblockAllow' });
  if (sd.capture != null) {
    out.capture = checkHostList(sd.capture, F, 'contributes.siteDefaults.capture', C, hosts, { what: 'capture' });
    if (out.capture.length && !caps.includes('capture')) C.err(F, 'permissions.capabilities', 'вклад capture требует права «capture»', 'добавьте "capture" в permissions.capabilities');
  }
  if (sd.siteThemes != null) {
    if (!isPlain(sd.siteThemes)) C.err(F, 'contributes.siteDefaults.siteThemes', 'ожидается объект { "хост": {enabled, engine, …} }');
    else for (const [k, v] of Object.entries(sd.siteThemes)) {
      const p = 'contributes.siteDefaults.siteThemes.' + k;
      const r = normHost(k);
      if (r.error) { C.err(F, p, r.error, r.hint); continue; }
      if (!hostCovered(r.host, hosts)) { C.err(F, p, `хост ${r.host} не объявлен в permissions.hosts`); continue; }
      if (!isPlain(v)) { C.err(F, p, 'ожидается объект {enabled, engine, brightness, …}'); continue; }
      const e = {};
      for (const [kk, vv] of Object.entries(v)) {
        if (!THEME_KEYS.includes(kk)) { C.err(F, p + '.' + kk, 'неизвестный параметр темы', 'есть: ' + THEME_KEYS.join(', ')); continue; }
        if (kk === 'enabled' && typeof vv !== 'boolean') { C.err(F, p + '.enabled', 'ожидается true/false'); continue; }
        if (kk === 'engine' && !['dynamic', 'filter'].includes(vv)) { C.err(F, p + '.engine', 'движок: dynamic или filter'); continue; }
        if (['brightness', 'contrast', 'sepia', 'grayscale'].includes(kk) && (typeof vv !== 'number' || vv < 0 || vv > 200)) { C.err(F, p + '.' + kk, 'число 0–200'); continue; }
        if ((kk === 'bg' || kk === 'text') && !/^#[0-9a-f]{6}$/i.test(String(vv))) { C.err(F, p + '.' + kk, 'цвет #rrggbb'); continue; }
        if (kk === 'css' && (typeof vv !== 'string' || vv.length > 200000)) { C.err(F, p + '.css', 'строка CSS до 200 000 знаков'); continue; }
        e[kk] = vv;
      }
      out.siteThemes[r.host] = e;
    }
  }
  return out;
}

function checkSnippets(list, dir, hosts, caps, C) {
  const F = MANIFEST;
  const out = [];
  if (list == null) return out;
  if (!Array.isArray(list) || list.length > 20) { C.err(F, 'contributes.snippets', 'ожидается массив (до 20)'); return out; }
  if (list.length && !caps.includes('snippets')) C.err(F, 'permissions.capabilities', 'сниппеты требуют права «snippets»', 'добавьте "snippets" в permissions.capabilities');
  list.forEach((s, i) => {
    const p = `contributes.snippets[${i}]`;
    if (!isPlain(s)) { C.err(F, p, 'сниппет — {file, match}'); return; }
    const full = inside(dir, s.file);
    if (!full) { C.err(F, p + '.file', 'нужен путь к .js внутри пака', 'например "snippets/ids.js"'); return; }
    let code;
    try { code = fs.readFileSync(full, 'utf8'); } catch (_) { C.err(s.file, '', 'файл сниппета не найден', `создайте ${s.file}`); return; }
    if (code.length > LIMITS.snippet) { C.err(s.file, '', 'сниппет длиннее 200 КБ'); return; }
    try { new vm.Script('(async () => {\n' + code + '\n})', { filename: s.file }); } catch (e) { C.err(s.file, '', 'синтаксическая ошибка: ' + e.message); return; }
    const match = Array.isArray(s.match) ? s.match : (typeof s.match === 'string' ? [s.match] : null);
    if (!match || !match.length) { C.err(F, p + '.match', 'нужны шаблоны адресов', 'например ["seller.example.test/*"]'); return; }
    const pats = [];
    match.forEach((m, j) => {
      const pt = parsePattern(m);
      if (pt.error) { C.err(F, `${p}.match[${j}]`, pt.error, pt.hint); return; }
      if (!hostCovered(pt.host, hosts)) { C.err(F, `${p}.match[${j}]`, `хост ${pt.host} не объявлен в permissions.hosts`, 'сниппет работает только на хостах манифеста'); return; }
      pats.push(pt.source);
    });
    if (pats.length !== match.length) return;
    const run = s.run == null ? 'auto' : s.run;
    if (!['auto', 'manual'].includes(run)) { C.err(F, p + '.run', 'run: auto (сам при загрузке) или manual (из библиотеки сниппетов)'); return; }
    out.push({
      file: String(s.file).replace(/\\/g, '/'), match: pats, run,
      name: str(s.name, 120) ? s.name.trim() : path.basename(String(s.file)),
      desc: str(s.desc, 300) ? s.desc.trim() : '',
      size: code.length,
    });
  });
  return out;
}

function checkFieldSchema(obj, file, p, C) {
  const out = { properties: {}, required: [] };
  if (obj == null) return out;
  if (!isPlain(obj) || !isPlain(obj.properties)) { C.err(file, p, 'ожидается {properties: {...}, required: [...]}'); return out; }
  for (const [name, d] of Object.entries(obj.properties)) {
    const pp = `${p}.properties.${name}`;
    if (!/^[a-zA-Z][\w]{0,40}$/.test(name)) { C.err(file, pp, 'имя поля — латиница, цифры, _ (до 40)'); continue; }
    if (!isPlain(d)) { C.err(file, pp, 'описание поля — объект {type, title}'); continue; }
    const type = d.type || (Array.isArray(d.enum) ? 'string' : null);
    if (!FIELD_TYPES.includes(type)) { C.err(file, pp + '.type', 'тип поля: string, number или boolean (enum — список значений)'); continue; }
    const f = { type, title: str(d.title, 80) ? d.title.trim() : name };
    if (str(d.description, 300)) f.description = d.description.trim();
    if (d.enum != null) {
      if (!Array.isArray(d.enum) || !d.enum.length || d.enum.length > 100 || d.enum.some((x) => typeof x !== type)) { C.err(file, pp + '.enum', `enum — непустой список значений типа ${type}`); continue; }
      f.enum = d.enum.slice();
      if (Array.isArray(d.enumTitles) && d.enumTitles.length === d.enum.length) f.enumTitles = d.enumTitles.map(String);
    }
    if (d.default !== undefined) {
      if (typeof d.default !== type || (f.enum && !f.enum.includes(d.default))) C.err(file, pp + '.default', 'значение по умолчанию не подходит к типу или enum');
      else f.default = d.default;
    }
    if (type === 'number') { if (typeof d.minimum === 'number') f.minimum = d.minimum; if (typeof d.maximum === 'number') f.maximum = d.maximum; }
    if (type === 'string' && typeof d.maxLength === 'number') f.maxLength = Math.max(1, Math.min(2000, d.maxLength));
    if (d.secret === true) f.secret = true;
    out.properties[name] = f;
  }
  if (obj.required != null) {
    if (!Array.isArray(obj.required)) C.err(file, p + '.required', 'required — список имён полей');
    else for (const r of obj.required) {
      if (!out.properties[r]) C.err(file, p + '.required', `обязательное поле ${r} не описано в properties`, 'есть: ' + Object.keys(out.properties).join(', '));
      else out.required.push(r);
    }
  }
  return out;
}

function checkScopeSchema(rel, dir, C) {
  if (rel == null) return null;
  const raw = readJson(dir, rel, C, 'contributes.scopeSchema');
  if (!raw) return null;
  if (!isPlain(raw)) { C.err(rel, '', 'ожидается объект'); return null; }
  const kind = raw.kind;
  if (typeof kind !== 'string' || !/^[a-z][\w-]{0,30}$/.test(kind)) C.err(rel, 'kind', 'kind — короткое имя вида контейнера', 'например "shop"');
  const fields = checkFieldSchema({ properties: raw.properties || {}, required: raw.required }, rel, '', C);
  const rules = raw.rules != null ? checkFieldSchema(raw.rules, rel, 'rules', C) : { properties: {}, required: [] };
  const tpl = (t, p) => {
    if (t == null) return '';
    if (!str(t, 200)) { C.err(rel, p, 'шаблон — строка с {поле}', 'например "{client} · {platform}"'); return ''; }
    for (const m of t.matchAll(/\{([^}]+)\}/g)) if (!fields.properties[m[1]]) C.err(rel, p, `в шаблоне поле {${m[1]}}, его нет в properties`);
    return t;
  };
  return {
    kind: typeof kind === 'string' ? kind : '',
    title: str(raw.title, 80) ? raw.title.trim() : '',
    label: tpl(raw.label, 'label'),
    account: tpl(raw.account, 'account'),
    properties: fields.properties, required: fields.required, rules,
    file: rel,
  };
}

function checkIdentity(rel, dir, schema, opIds, C) {
  if (rel == null) return null;
  const raw = readJson(dir, rel, C, 'contributes.identity');
  if (!raw) return null;
  if (!isPlain(raw)) { C.err(rel, '', 'ожидается объект {source, field, …}'); return null; }
  const out = { file: rel };
  if (!IDENTITY_SOURCES.includes(raw.source)) C.err(rel, 'source', 'источник: cookie, op или page', 'cookie — значение cookie, op — поле ответа операции чтения, page — атрибут страницы');
  else out.source = raw.source;
  if (raw.source === 'cookie' && !str(raw.cookie, 200)) C.err(rel, 'cookie', 'для source "cookie" нужно имя cookie');
  if (raw.source === 'op') {
    if (!str(raw.op, 80)) C.err(rel, 'op', 'для source "op" нужна операция чтения');
    else if (!opIds.has(raw.op)) C.err(rel, 'op', `операции ${raw.op} в паке нет`, 'есть: ' + Array.from(opIds).join(', '));
    if (!str(raw.path, 200)) C.err(rel, 'path', 'для source "op" нужен путь в ответе', 'например "$.data.sellerId"');
  }
  if (raw.source === 'page' && !str(raw.selector, 300) && !str(raw.attr, 200)) C.err(rel, 'selector', 'для source "page" нужен selector и/или attr');
  for (const k of ['cookie', 'op', 'path', 'selector', 'attr']) if (typeof raw[k] === 'string') out[k] = raw[k];
  if (typeof raw.field !== 'string' || !/^fields\.[a-zA-Z]\w*$/.test(raw.field)) C.err(rel, 'field', 'field — поле scope для сверки, например "fields.accountId"');
  else {
    out.field = raw.field;
    const f = raw.field.slice(7);
    if (schema && !schema.properties[f]) C.err(rel, 'field', `поля ${f} нет в схеме scope`, 'есть: ' + Object.keys(schema.properties).join(', '));
  }
  if (raw.sessionProbe != null) {
    const sp = raw.sessionProbe;
    if (!isPlain(sp)) C.err(rel, 'sessionProbe', 'ожидается {status: [401], redirectIncludes: "/login"}');
    else {
      out.sessionProbe = {};
      if (sp.status != null) { if (Array.isArray(sp.status) && sp.status.every((x) => Number.isInteger(x) && x >= 100 && x < 600)) out.sessionProbe.status = sp.status.slice(); else C.err(rel, 'sessionProbe.status', 'список HTTP-кодов'); }
      if (sp.redirectIncludes != null) { if (str(sp.redirectIncludes, 300)) out.sessionProbe.redirectIncludes = sp.redirectIncludes; else C.err(rel, 'sessionProbe.redirectIncludes', 'подстрока адреса страницы входа'); }
    }
  }
  return out;
}

const HEADER_SOURCES = ['$cookie', '$scope', '$seen', '$storage'];
function checkValueSource(v, file, p, C, op) {
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return;
  if (!isPlain(v)) { C.err(file, p, 'значение — строка или источник {$cookie|$scope|$seen|$storage}'); return; }
  const keys = Object.keys(v).filter((k) => k.startsWith('$'));
  if (keys.length !== 1 || !HEADER_SOURCES.includes(keys[0])) { C.err(file, p, 'один источник: $cookie, $scope, $seen или $storage', 'например {"$cookie": "csrf"}'); return; }
  const k = keys[0];
  if (k === '$scope' && !/^(fields|rules)\.[a-zA-Z]\w*$/.test(String(v.$scope))) C.err(file, p + '.$scope', 'путь в scope: fields.<поле> или rules.<поле>');
  if (k === '$storage' && (!['local', 'session'].includes(v.$storage) || !str(v.key, 200))) C.err(file, p, '$storage: "local" или "session" и key');
  if (k === '$seen' && v.maxAgeSec != null && !(Number(v.maxAgeSec) > 0)) C.err(file, p + '.maxAgeSec', 'maxAgeSec — число секунд');
  if ((k === '$cookie' || k === '$seen') && !str(v[k], 200)) C.err(file, p + '.' + k, 'нужно имя cookie или заголовка');
  if (op) op.sources.add(k);
}

function checkOperation(raw, rel, hosts, C) {
  if (!isPlain(raw)) { C.err(rel, '', 'операция — объект {id, title, host, risk, request}'); return null; }
  const op = { file: rel, sources: new Set() };
  if (typeof raw.id !== 'string' || !LOCAL_ID_RE.test(raw.id)) { C.err(rel, 'id', 'id операции — латиница, цифры, точки', 'например "item.update"'); return null; }
  op.id = raw.id;
  op.title = str(raw.title, 120) ? raw.title.trim() : raw.id;
  if (typeof raw.scope === 'string') op.scope = raw.scope;
  const h = normHost(raw.host);
  if (h.error) C.err(rel, 'host', h.error, h.hint);
  else if (!hostCovered(h.host, hosts)) C.err(rel, 'host', `хост ${h.host} не объявлен в permissions.hosts`);
  else op.host = h.host;
  const req = raw.request;
  if (!isPlain(req)) { C.err(rel, 'request', 'нужен request {method, url}'); return null; }
  const method = String(req.method || 'GET').toUpperCase();
  if (!METHODS.includes(method)) C.err(rel, 'request.method', 'метод: ' + METHODS.join(', '));
  op.method = method;
  if (typeof req.url !== 'string' || !(req.url.startsWith('/') || /^https:\/\//.test(req.url))) C.err(rel, 'request.url', 'адрес: путь от хоста операции ("/api/items/{id}") или https://');
  else {
    if (/^https:\/\//.test(req.url)) { const uh = hostOfUrl(req.url.replace(/\{[^}]*\}/g, 'x')); if (!hostCovered(uh, hosts)) C.err(rel, 'request.url', `хост ${uh} не объявлен в permissions.hosts`); }
    op.url = req.url;
  }
  if (req.headers != null) {
    if (!isPlain(req.headers)) C.err(rel, 'request.headers', 'ожидается объект');
    else for (const [k, v] of Object.entries(req.headers)) checkValueSource(v, rel, 'request.headers.' + k, C, op);
  }
  if (req.query != null) {
    if (!isPlain(req.query)) C.err(rel, 'request.query', 'ожидается объект');
    else for (const [k, v] of Object.entries(req.query)) checkValueSource(v, rel, 'request.query.' + k, C, op);
  }
  op.read = typeof raw.read === 'string' ? raw.read : null;
  if (req.body != null) {
    if (isPlain(req.body) && req.body.$from != null) {
      if (req.body.$from !== 'before') C.err(rel, 'request.body.$from', '$from: "before" — объект, прочитанный операцией read');
      if (!op.read) C.err(rel, 'read', 'чтение-изменение-запись ($from: before) требует операцию read', 'укажите "read": "<id операции чтения>"');
      if (req.body.$patch != null && !isPlain(req.body.$patch)) C.err(rel, 'request.body.$patch', '$patch — объект с полями для замены');
      op.readModifyWrite = true;
    }
  }
  if (raw.risk != null && !RISKS.includes(raw.risk)) C.err(rel, 'risk', 'класс риска: ' + RISKS.join(', '));
  op.riskDeclared = RISKS.includes(raw.risk) ? raw.risk : 'read';
  op.riskCore = method === 'GET' || method === 'HEAD' ? 'read' : method === 'DELETE' ? 'irreversible' : 'write';
  if (raw.success != null) {
    if (!isPlain(raw.success)) C.err(rel, 'success', 'success — {status: [200], json: {"$.error": false}}');
    else if (raw.success.status != null && !(Array.isArray(raw.success.status) && raw.success.status.every((x) => Number.isInteger(x)))) C.err(rel, 'success.status', 'список HTTP-кодов');
    else op.success = raw.success;
  }
  if (raw.rowErrors != null) { if (str(raw.rowErrors, 300)) op.rowErrors = raw.rowErrors; else C.err(rel, 'rowErrors', 'путь JSON к ошибкам строк, например "$.data.errors[*]"'); }
  if (raw.preview != null) {
    const pv = raw.preview;
    if (!isPlain(pv) || !str(pv.key, 80) || (pv.fields != null && !Array.isArray(pv.fields)) || (pv.money != null && !Array.isArray(pv.money))) C.err(rel, 'preview', 'preview — {key, fields: [...], money: [...]}');
    else op.preview = { key: pv.key, fields: (pv.fields || []).map(String), money: (pv.money || []).map(String) };
  }
  if (op.preview && op.preview.money.length && rank(op.riskDeclared) < rank('money')) op.riskDeclared = 'money'; // поля денег поднимают риск
  if (raw.paginate != null) {
    const pg = raw.paginate;
    if (!isPlain(pg) || !['offset', 'cursor'].includes(pg.kind) || !str(pg.param, 80) || !str(pg.items, 200)) C.err(rel, 'paginate', 'paginate — {kind: "offset"|"cursor", param, size?, items}');
    else op.paginate = { kind: pg.kind, param: pg.param, size: Number(pg.size) || null, items: pg.items, cursor: typeof pg.cursor === 'string' ? pg.cursor : undefined };
  }
  if (raw.input != null) {
    if (isPlain(raw.input) && typeof raw.input.$ref === 'string') op.inputRef = raw.input.$ref;
    else if (isPlain(raw.input)) op.input = raw.input;
    else C.err(rel, 'input', 'input — схема или {"$ref": "schemas/x.json"}');
  }
  op.idempotent = raw.idempotent === true;
  if (raw.rate != null) { if (isPlain(raw.rate) && Number(raw.rate.perMin) > 0) op.rate = { perMin: Number(raw.rate.perMin) }; else C.err(rel, 'rate', 'rate — {perMin: 30}'); }
  if (raw.retry != null) {
    if (isPlain(raw.retry) && Array.isArray(raw.retry.on) && raw.retry.on.every((x) => Number.isInteger(x))) op.retry = { on: raw.retry.on.slice(), max: Math.max(0, Math.min(10, Number(raw.retry.max) || 3)) };
    else C.err(rel, 'retry', 'retry — {on: [429, 502], max: 3}');
  }
  op.request = req;
  op.saveTo = raw.saveTo === true;
  return op;
}

function checkOperations(spec, dir, hosts, caps, readClaims, C) {
  const F = MANIFEST;
  if (spec == null) return [];
  let files;
  if (typeof spec === 'string') files = globFiles(dir, spec);
  else if (Array.isArray(spec)) files = spec.map(String);
  if (!files) { C.err(F, 'contributes.operations', 'маска файлов операций, например "ops/*.op.json"'); return []; }
  if (files.length > LIMITS.ops) { C.err(F, 'contributes.operations', `больше ${LIMITS.ops} операций`); return []; }
  if (!files.length) C.warn(F, 'contributes.operations', 'по маске не нашлось ни одного файла операций');
  const ops = [];
  for (const rel of files) {
    const raw = readJson(dir, rel, C, 'contributes.operations');
    if (!raw) continue;
    const op = checkOperation(raw, rel, hosts, C);
    if (!op) continue;
    if (ops.some((o) => o.id === op.id)) { C.err(rel, 'id', 'повтор id операции ' + op.id); continue; }
    if (op.inputRef && !inside(dir, op.inputRef)) C.err(rel, 'input.$ref', 'схема входа вне папки пака');
    else if (op.inputRef) { const s = readJson(dir, op.inputRef, C, rel + ' input.$ref'); if (s) op.input = s; }
    ops.push(op);
  }
  const ids = new Set(ops.map((o) => o.id));
  for (const op of ops) {
    if (op.read && !ids.has(op.read)) C.err(op.file, 'read', `операции чтения ${op.read} нет в паке`, 'есть: ' + Array.from(ids).join(', '));
    op.readClaim = readClaims.includes(op.id);
    if (op.readClaim && op.method !== 'POST') C.err(F, 'permissions.readClaims', `${op.id}: чтением можно назвать только POST-операцию`, 'GET и так чтение; PUT/PATCH/DELETE — всегда запись');
    // Класс риска считает ядро: не-GET — минимум write, DELETE — irreversible; пак может только поднять.
    // POST, объявленный чтением в readClaims, станет чтением только после согласия человека (granted.readClaims).
    op.risk = maxRisk(op.riskDeclared, op.riskCore);
    if (op.readClaim && op.riskDeclared === 'read' && op.method === 'POST') op.riskIfClaimGranted = 'read';
    const need = op.risk === 'read' || op.riskIfClaimGranted === 'read' ? 'ops.read' : op.risk === 'money' ? 'ops.money' : 'ops.write';
    if (!caps.includes(need)) C.err(F, 'permissions.capabilities', `операция ${op.id} (${op.risk}) требует права «${need}»`, `добавьте "${need}" в permissions.capabilities`);
    op.sources = Array.from(op.sources);
  }
  for (const rc of readClaims) if (!ids.has(rc)) C.err(F, 'permissions.readClaims', `в readClaims операция ${rc}, её нет в паке`);
  return ops;
}

function checkPolicies(spec, dir, opIds, C) {
  const F = MANIFEST;
  if (spec == null) return [];
  const files = typeof spec === 'string' ? globFiles(dir, spec) : Array.isArray(spec) ? spec.map(String) : null;
  if (!files) { C.err(F, 'contributes.policies', 'маска файлов проверок, например "policies/*.json"'); return []; }
  const out = [];
  for (const rel of files) {
    const raw = readJson(dir, rel, C, 'contributes.policies');
    if (!raw) continue;
    const list = Array.isArray(raw) ? raw : [raw];
    list.forEach((pl, i) => {
      const p = Array.isArray(raw) ? `[${i}]` : '';
      if (!isPlain(pl)) { C.err(rel, p, 'проверка — объект {id, kind, …}'); return; }
      if (typeof pl.id !== 'string' || !LOCAL_ID_RE.test(pl.id)) { C.err(rel, p + '.id', 'id проверки — латиница, цифры, точки'); return; }
      if (!POLICY_KINDS.includes(pl.kind)) { C.err(rel, p + '.kind', 'вид проверки: ' + POLICY_KINDS.join(', ')); return; }
      if (pl.kind !== 'skipWhere' && !str(pl.field, 80)) { C.err(rel, p + '.field', 'нужно поле строки, которое проверяется'); return; }
      if (pl.value != null && !(typeof pl.value === 'number' || (isPlain(pl.value) && /^rules\.[a-zA-Z]\w*$/.test(String(pl.value.$scope))))) { C.err(rel, p + '.value', 'value — число или {"$scope": "rules.<поле>"}'); return; }
      if (pl.ops != null && (!Array.isArray(pl.ops) || pl.ops.some((o) => !opIds.has(o)))) { C.err(rel, p + '.ops', 'ops — список id операций пака'); return; }
      if (out.length >= LIMITS.policies) return;
      out.push({ id: pl.id, kind: pl.kind, field: pl.field || null, value: pl.value == null ? null : pl.value, where: isPlain(pl.where) ? pl.where : null, ops: pl.ops || null, title: str(pl.title, 120) ? pl.title.trim() : pl.id, file: rel });
    });
  }
  return out;
}

function checkAgent(a, dir, C) {
  const F = MANIFEST;
  if (a == null) return null;
  if (!isPlain(a)) { C.err(F, 'contributes.agent', 'ожидается {summary, skills, claudeMd}'); return null; }
  const out = { summary: '', skills: [], claudeMd: null };
  if (a.summary != null) { if (typeof a.summary === 'string' && a.summary.length <= LIMITS.summary) out.summary = a.summary.trim(); else C.err(F, 'contributes.agent.summary', `summary — строка до ${LIMITS.summary} символов`); }
  if (a.claudeMd != null) {
    const full = inside(dir, a.claudeMd);
    let t = null;
    try { t = full ? fs.readFileSync(full, 'utf8') : null; } catch (_) { t = null; }
    if (t == null) C.err(F, 'contributes.agent.claudeMd', 'файл не найден: ' + a.claudeMd);
    else if (Buffer.byteLength(t) > LIMITS.claudeMd) C.err(a.claudeMd, '', 'фрагмент CLAUDE.md больше 2 КБ', 'подробности — в скиллы');
    else out.claudeMd = t;
  }
  if (a.skills != null) {
    const base = inside(dir, String(a.skills).replace(/\/+$/, ''));
    let list = [];
    try { list = base ? fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()) : null; } catch (_) { list = null; }
    if (!list) C.err(F, 'contributes.agent.skills', 'папка скиллов не найдена: ' + a.skills);
    else for (const e of list) {
      if (!fs.existsSync(path.join(base, e.name, 'SKILL.md'))) C.err(String(a.skills).replace(/\/+$/, '') + '/' + e.name, '', 'в папке скилла нет SKILL.md');
      else out.skills.push(e.name);
    }
    out.skillsDir = String(a.skills).replace(/\/+$/, '');
  }
  return out;
}

// Прочитать и проверить пак в папке dir. → { ok, errors, warnings, pack }
function compile(dir) {
  const C = createCheck();
  const F = MANIFEST;
  let raw;
  try {
    const st = fs.statSync(dir);
    if (!st.isDirectory()) throw new Error('не папка');
  } catch (_) { C.err('', '', 'папка пака не найдена: ' + dir); return { ok: false, errors: C.errors, warnings: C.warnings, pack: null }; }
  let size;
  try { size = walk(dir); } catch (e) { C.err('', '', e.message, e.hint); return { ok: false, errors: C.errors, warnings: C.warnings, pack: null }; }
  try { raw = JSON.parse(fs.readFileSync(path.join(dir, F), 'utf8').replace(/^﻿/, '')); } catch (e) {
    if (e.code === 'ENOENT') C.err(F, '', 'в папке нет kosmo-pack.json', 'манифест пака лежит в корне папки');
    else C.err(F, '', 'неверный JSON: ' + e.message, 'проверьте запятые и кавычки');
    return { ok: false, errors: C.errors, warnings: C.warnings, pack: null };
  }
  if (!isPlain(raw)) { C.err(F, '', 'манифест — объект'); return { ok: false, errors: C.errors, warnings: C.warnings, pack: null }; }
  for (const k of Object.keys(raw)) if (!TOP_KEYS.includes(k)) C.err(F, k, 'неизвестное поле манифеста', 'есть: ' + TOP_KEYS.filter((x) => x !== '$schema').join(', '));
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) C.err(F, 'id', 'id пака — с пространством имён через точку, латиница', 'например "demo.shop" или "acme.marketplace-tools"');
  if (!str(raw.name, 60)) C.err(F, 'name', 'нужно название до 60 символов');
  if (typeof raw.version !== 'string' || !VERSION_RE.test(raw.version)) C.err(F, 'version', 'версия вида 1.2.3', 'например "0.1.0"');
  if (raw.description != null && !str(raw.description, 300)) C.err(F, 'description', 'описание — строка до 300 символов');
  if (!isPlain(raw.engine) || raw.engine.api !== API) C.err(F, 'engine.api', `пак для API ${isPlain(raw.engine) ? raw.engine.api : '?'}, ядро поддерживает ${API}`, `укажите "engine": {"api": ${API}}`);
  if (raw.global != null && typeof raw.global !== 'boolean') C.err(F, 'global', 'global — true или false');
  if (raw.protect != null && typeof raw.protect !== 'boolean') C.err(F, 'protect', 'protect — true или false');
  const perm = isPlain(raw.permissions) ? raw.permissions : null;
  if (!perm) C.err(F, 'permissions', 'нужен объект permissions {hosts, capabilities, readClaims}');
  const hosts = perm && perm.hosts != null ? checkHostList(perm.hosts, F, 'permissions.hosts', C, null) : [];
  let caps = [];
  if (perm && perm.capabilities != null) {
    if (!Array.isArray(perm.capabilities)) C.err(F, 'permissions.capabilities', 'список прав');
    else perm.capabilities.forEach((c, i) => { if (!CAPS.includes(c)) C.err(F, `permissions.capabilities[${i}]`, 'неизвестное право ' + c, 'есть: ' + CAPS.join(', ')); else if (!caps.includes(c)) caps.push(c); });
  }
  let readClaims = [];
  if (perm && perm.readClaims != null) {
    if (!Array.isArray(perm.readClaims) || perm.readClaims.some((x) => typeof x !== 'string')) C.err(F, 'permissions.readClaims', 'список id операций');
    else readClaims = perm.readClaims.slice();
  }
  if (perm) for (const k of Object.keys(perm)) if (!['hosts', 'capabilities', 'readClaims'].includes(k)) C.err(F, 'permissions.' + k, 'неизвестное поле', 'есть: hosts, capabilities, readClaims');
  const con = raw.contributes == null ? {} : raw.contributes;
  if (!isPlain(con)) C.err(F, 'contributes', 'ожидается объект');
  for (const k of Object.keys(isPlain(con) ? con : {})) if (!CONTRIBUTES.includes(k)) C.err(F, 'contributes.' + k, 'неизвестный вклад (в v1 его нет)', 'есть: ' + CONTRIBUTES.join(', '));
  const c = isPlain(con) ? con : {};

  const siteDefaults = checkSiteDefaults(c.siteDefaults, hosts, caps, C);
  const snippets = checkSnippets(c.snippets, dir, hosts, caps, C);
  const scopeSchema = checkScopeSchema(c.scopeSchema, dir, C);
  const operations = checkOperations(c.operations, dir, hosts, caps, readClaims, C);
  const opIds = new Set(operations.map((o) => o.id));
  const identity = checkIdentity(c.identity, dir, scopeSchema, opIds, C);
  const policies = checkPolicies(c.policies, dir, opIds, C);
  const agent = checkAgent(c.agent, dir, C);
  if (caps.some((x) => x.startsWith('ops.')) && !operations.length) C.warn(F, 'permissions.capabilities', 'права на операции есть, а операций нет');

  const pack = {
    id: raw.id, name: typeof raw.name === 'string' ? raw.name.trim() : raw.id, version: raw.version,
    description: typeof raw.description === 'string' ? raw.description.trim() : '',
    api: API, global: raw.global === true, protect: raw.protect === true,
    permissions: { hosts, capabilities: caps, readClaims },
    siteDefaults, snippets, scopeSchema, identity, operations, policies, agent,
    files: size.files.length, bytes: size.bytes,
  };
  return { ok: C.errors.length === 0, errors: C.errors, warnings: C.warnings, pack };
}

module.exports = {
  API, MANIFEST, RISKS, CAPS, LIMITS, ID_RE,
  compile, treeHash, stamp, walk, inside, normHost, covers, hostCovered, hostOfUrl, parsePattern, matchPattern, maxRisk,
};
