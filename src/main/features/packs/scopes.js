'use strict';
// Метаданные контейнеров (scope) — решение консилиума 4.5. Отдельный store userData/scopes.json по containerId:
// в settings остаётся только {id, name, color}, а данные паков (поля по схеме, правила) живут здесь.
//
// scope = { kind, pack, fields, rules, packs[], agentAccess, mark, labels[], protect }
//   pack        — пак, чья схема описывает контейнер (поля fields/rules проверяются по его scopeSchema);
//   packs[]     — паки, включённые в этом контейнере (глобальные паки работают и без этого списка);
//   agentAccess — off | read | ops | full; null — по умолчанию: ops для защищённых, иначе full (глобальный режим моста — потолок);
//   protect     — true/false; null — как объявил пак scope (manifest.protect).
// Здоровье (кто залогинен): ok | login | mismatch | unknown — пока всегда unknown, проверку identity сделает исполнитель.

const ACCESS = ['off', 'read', 'ops', 'full'];
const HEALTH = ['ok', 'login', 'mismatch', 'unknown'];
const KEYS = ['kind', 'pack', 'fields', 'rules', 'packs', 'agentAccess', 'mark', 'labels', 'protect'];

function isPlain(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

function scopeError(message, errors) { return Object.assign(new Error(message), { errors: errors || [] }); }

// Проверка значений полей по схеме пака (string/number/boolean/enum, required). → {values, errors}
function validateFields(schemaPart, input, opts = {}) {
  const props = (schemaPart && schemaPart.properties) || null;
  const errors = [];
  const values = {};
  const src = isPlain(input) ? input : {};
  if (!props) {
    // схемы нет (пак не установлен) — храним как есть, но только простые значения
    for (const [k, v] of Object.entries(src)) {
      if (!/^[a-zA-Z]\w{0,40}$/.test(k)) continue;
      if (typeof v === 'string') values[k] = v.slice(0, 2000);
      else if (typeof v === 'number' && isFinite(v)) values[k] = v;
      else if (typeof v === 'boolean') values[k] = v;
    }
    return { values, errors };
  }
  for (const [name, f] of Object.entries(props)) {
    let v = src[name];
    if (v === undefined || v === null || v === '') {
      if (f.default !== undefined && opts.fillDefaults) v = f.default;
      else {
        if ((schemaPart.required || []).includes(name) && !opts.partial) errors.push({ path: name, message: `«${f.title}» — обязательное поле` });
        continue;
      }
    }
    if (f.type === 'number') {
      const n = typeof v === 'string' ? Number(v.replace(',', '.').trim()) : v;
      if (typeof n !== 'number' || !isFinite(n)) { errors.push({ path: name, message: `«${f.title}» — нужно число` }); continue; }
      if (f.minimum != null && n < f.minimum) { errors.push({ path: name, message: `«${f.title}» — не меньше ${f.minimum}` }); continue; }
      if (f.maximum != null && n > f.maximum) { errors.push({ path: name, message: `«${f.title}» — не больше ${f.maximum}` }); continue; }
      v = n;
    } else if (f.type === 'boolean') {
      if (v === 'true') v = true; else if (v === 'false') v = false;
      if (typeof v !== 'boolean') { errors.push({ path: name, message: `«${f.title}» — да или нет` }); continue; }
    } else {
      if (typeof v === 'number') v = String(v);
      if (typeof v !== 'string') { errors.push({ path: name, message: `«${f.title}» — нужен текст` }); continue; }
      v = v.trim();
      const max = f.maxLength || 500;
      if (v.length > max) { errors.push({ path: name, message: `«${f.title}» — не длиннее ${max} символов` }); continue; }
    }
    if (f.enum && !f.enum.includes(v)) { errors.push({ path: name, message: `«${f.title}» — одно из: ${f.enum.join(', ')}` }); continue; }
    values[name] = v;
  }
  return { values, errors };
}

function fillTemplate(tpl, fields) {
  if (!tpl) return '';
  let missing = 0;
  const parts = String(tpl).split(/(\{[^}]+\})/);
  const out = parts.map((p) => {
    const m = /^\{([^}]+)\}$/.exec(p);
    if (!m) return p;
    const v = fields && fields[m[1]];
    if (v === undefined || v === null || v === '') { missing++; return ''; }
    return String(v);
  }).join('');
  // убрать разделители вокруг пустых полей: «Клиент ·  · кабинет» → «Клиент · кабинет»
  const cleaned = out.replace(/(\s*[·|,/—-]\s*){2,}/g, ' · ').replace(/^\s*[·|,/—-]\s*|\s*[·|,/—-]\s*$/g, '').trim();
  return missing && !cleaned ? '' : cleaned;
}

function initials(label) {
  const words = String(label || '').split(/[\s·|,/—-]+/).filter(Boolean);
  if (!words.length) return '';
  const a = words[0][0] || '';
  const b = words.length > 1 ? words[1][0] : (words[0][1] || '');
  return (a + b).toUpperCase();
}

function createScopes(ctx, deps) {
  const log = (...a) => ctx.log('scopes', ...a);
  const store = ctx.store('scopes', { version: 1, scopes: {} });
  const listeners = new Set();
  const health = new Map(); // containerId → {state, at, detail}
  let data = store.get();
  if (!isPlain(data) || !isPlain(data.scopes)) { data = { version: 1, scopes: {} }; store.set(data); }

  const packs = () => deps.packs(); // ctx.packs (создаётся рядом, ссылка — лениво)
  const containerIds = () => new Set(ctx.sessions.containers().map((c) => c.id));

  function packSchema(packId) {
    const P = packs();
    return P && packId ? P.scopeSchema(packId) : null;
  }

  function normalize(cid, input, prev, opts = {}) {
    const src = isPlain(input) ? input : {};
    const errors = [];
    const out = {};
    if (src.kind != null && src.kind !== '') {
      if (typeof src.kind !== 'string' || !/^[a-z][\w-]{0,30}$/.test(src.kind)) errors.push({ path: 'kind', message: 'kind — короткое имя латиницей' });
      else out.kind = src.kind;
    }
    if (src.pack != null && src.pack !== '') {
      if (typeof src.pack !== 'string' || src.pack.length > 80) errors.push({ path: 'pack', message: 'pack — id пака' });
      else out.pack = src.pack;
    }
    const schema = out.pack ? packSchema(out.pack) : null;
    if (schema && !out.kind) out.kind = schema.kind;
    if (src.fields != null) {
      const r = validateFields(schema, src.fields, { partial: opts.checkRequired === false });
      errors.push(...r.errors.map((e) => Object.assign(e, { path: 'fields.' + e.path })));
      out.fields = r.values;
    }
    if (src.rules != null) {
      const r = validateFields(schema ? schema.rules : null, src.rules, { partial: true });
      errors.push(...r.errors.map((e) => Object.assign(e, { path: 'rules.' + e.path })));
      out.rules = r.values;
    }
    if (src.packs != null) {
      if (!Array.isArray(src.packs) || src.packs.some((x) => typeof x !== 'string' || x.length > 80)) errors.push({ path: 'packs', message: 'packs — список id паков' });
      else out.packs = Array.from(new Set(src.packs)).slice(0, 50);
    }
    if (src.agentAccess != null && src.agentAccess !== '') {
      if (!ACCESS.includes(src.agentAccess)) errors.push({ path: 'agentAccess', message: 'доступ агента: ' + ACCESS.join(', ') });
      else out.agentAccess = src.agentAccess;
    }
    if (src.mark != null && src.mark !== '') {
      const m = String(src.mark).trim();
      if (!m || Array.from(m).length > 2) errors.push({ path: 'mark', message: 'марка — 1–2 буквы' });
      else out.mark = m.toUpperCase();
    }
    if (src.labels != null) {
      if (!Array.isArray(src.labels)) errors.push({ path: 'labels', message: 'метки — список' });
      else out.labels = Array.from(new Set(src.labels.map((x) => String(x).trim().slice(0, 30)).filter(Boolean))).slice(0, 10);
    }
    if (src.protect != null) {
      if (typeof src.protect !== 'boolean') errors.push({ path: 'protect', message: 'protect — да или нет' });
      else out.protect = src.protect;
    }
    for (const k of Object.keys(src)) if (!KEYS.includes(k)) errors.push({ path: k, message: 'неизвестное поле scope', hint: 'есть: ' + KEYS.join(', ') });
    // пак схемы включаем в контейнере
    if (out.pack && !(out.packs || (prev && prev.packs) || []).includes(out.pack)) out.packs = (out.packs || (prev && prev.packs) || []).concat(out.pack);
    if (errors.length) throw scopeError('Данные контейнера не сохранены: ' + errors.map((e) => e.message).join('; '), errors);
    return out;
  }

  function emit(cid) {
    for (const fn of listeners) { try { fn(cid); } catch (e) { log(e); } }
    ctx.bus.emit('scopes:changed', cid);
    ctx.broadcast('kosmo:scopes.changed', { id: cid });
  }

  function raw(cid) { return data.scopes[cid] ? clone(data.scopes[cid]) : null; }

  function save() { store.set(data); }

  function set(cid, scope) {
    cid = String(cid || '');
    if (!containerIds().has(cid)) throw new Error('нет такого контейнера: ' + cid);
    if (scope == null) { delete data.scopes[cid]; save(); emit(cid); return null; }
    const v = normalize(cid, scope, null);
    data.scopes[cid] = v;
    save();
    emit(cid);
    return get(cid);
  }

  function patch(cid, p) {
    cid = String(cid || '');
    if (!containerIds().has(cid)) throw new Error('нет такого контейнера: ' + cid);
    if (!isPlain(p)) throw new Error('patch: ожидается объект');
    const cur = raw(cid) || {};
    const next = Object.assign({}, cur);
    for (const [k, v] of Object.entries(p)) {
      if (v === null || v === undefined) delete next[k];
      else if ((k === 'fields' || k === 'rules') && isPlain(v) && p.replace !== true) next[k] = Object.assign({}, cur[k] || {}, v);
      else next[k] = v;
    }
    delete next.replace;
    // смена пака: поля прежней схемы не переносим
    if ('pack' in p && p.pack !== cur.pack) { if (!('fields' in p)) delete next.fields; if (!('rules' in p)) delete next.rules; if (!('kind' in p)) delete next.kind; }
    const v = normalize(cid, next, cur, { checkRequired: 'fields' in p || 'pack' in p });
    if (!Object.keys(v).length) delete data.scopes[cid]; else data.scopes[cid] = v;
    save();
    emit(cid);
    return get(cid);
  }

  // Защищён ли контейнер: явный флаг scope или protect пака схемы.
  function isProtected(cid) {
    const s = data.scopes[cid];
    if (!s) return false;
    if (typeof s.protect === 'boolean') return s.protect;
    const P = packs();
    const meta = P && s.pack ? P.get(s.pack) : null;
    return !!(meta && meta.protect);
  }

  function agentAccess(cid) {
    const s = data.scopes[cid];
    if (s && s.agentAccess) return s.agentAccess;
    return isProtected(cid) ? 'ops' : 'full';
  }

  function healthOf(cid) {
    const h = health.get(cid);
    return h ? Object.assign({}, h) : { state: 'unknown', at: 0, detail: '' };
  }

  // Для исполнителя (следующий этап): результат проверки identity.
  function setHealth(cid, state, detail) {
    if (!HEALTH.includes(state)) throw new Error('состояние: ' + HEALTH.join(', '));
    health.set(cid, { state, at: Date.now(), detail: String(detail || '').slice(0, 300) });
    emit(cid);
    return healthOf(cid);
  }

  // Чип в адресной строке: марка, «поле · поле» по шаблону label схемы, аккаунт тихим текстом. null — обычный чип.
  function chip(cid) {
    const s = data.scopes[cid];
    if (!s || !s.pack) return null;
    const schema = packSchema(s.pack);
    if (!schema || !schema.label) return null;
    const label = fillTemplate(schema.label, s.fields || {});
    if (!label) return null;
    const account = fillTemplate(schema.account, s.fields || {});
    return {
      mark: s.mark || initials(label),
      label,
      account,
      access: agentAccess(cid),
      protect: isProtected(cid),
      health: healthOf(cid).state,
    };
  }

  function get(cid) {
    cid = String(cid || '');
    const s = data.scopes[cid] || {};
    const P = packs();
    const installed = !s.pack || !P ? true : !!P.get(s.pack);
    return {
      containerId: cid,
      kind: s.kind || '',
      pack: s.pack || null,
      packInstalled: installed, // false — «пак не установлен» (данные остаются)
      fields: clone(s.fields || {}),
      rules: clone(s.rules || {}),
      packs: (s.packs || []).slice(),
      agentAccess: agentAccess(cid),
      agentAccessRaw: s.agentAccess || null,
      mark: s.mark || '',
      labels: (s.labels || []).slice(),
      protect: isProtected(cid),
      protectRaw: typeof s.protect === 'boolean' ? s.protect : null,
      health: healthOf(cid),
      chip: chip(cid),
      exists: !!data.scopes[cid],
    };
  }

  function list() { return ctx.sessions.containers().map((c) => Object.assign(get(c.id), { name: c.name, color: c.color, temp: !!c.temp })); }

  // Контейнер удалён — его scope тоже.
  ctx.settings.on('change', (p) => {
    if (p !== 'containers') return;
    const live = containerIds();
    let changed = false;
    for (const id of Object.keys(data.scopes)) if (!live.has(id)) { delete data.scopes[id]; health.delete(id); changed = true; }
    if (changed) save();
  });

  return {
    get, raw, set, patch, list, chip, agentAccess, isProtected,
    health: healthOf, setHealth,
    validateFields: (packId, fields, opts) => validateFields(packSchema(packId), fields, opts),
    onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    ACCESS, HEALTH,
  };
}

module.exports = { createScopes, validateFields, fillTemplate, ACCESS, HEALTH };
