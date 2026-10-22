// Космолёт — оболочка страницы настроек (window.KSettings). Владелец: core.
// Разделы — в sections/<id>.js: KSettings.section({id, title, icon, order, keywords?, description?, render(el, api)}).
// api: get(path) (синхронно, из кэша), set(path, value) → Promise, patch(obj), on(cb) → off, invoke, toast, ui (хелперы ниже).
'use strict';
(function () {
  const U = window.KUI;
  const { h, invoke, on, emitter, getPath, setPath, clamp } = U;
  const svg = (n, s) => window.KIcons.get(n, s || 16);
  const $ = (id) => document.getElementById(id);

  const navEl = $('ks-nav'), contentEl = $('ks-content'), mainEl = $('ks-main'), qEl = $('ks-q');
  $('ks-logo').innerHTML = svg('kosmolet', 20);
  $('ks-search-icon').replaceWith(window.KIcons.el('search', 14));

  const bus = emitter();
  const sections = new Map(); // id → {def, nav, el, rendered}
  let settings = {};
  let started = false;
  let activeId = null;
  let query = '';

  // ---------- данные ----------
  function get(path) { return getPath(settings, path); }
  function set(path, value) {
    const old = get(path);
    setPath(settings, path, value);
    bus.emit('change', settings, path, value);
    if (!U.hasKosmo) return Promise.resolve(value);
    return invoke('kosmo:settings.set', { path, value }).catch((e) => {
      U.toast(errText(e), { tone: 'danger', ms: 3500 });
      setPath(settings, path, old);
      bus.emit('change', settings, path, old);
      throw e;
    });
  }
  function patch(obj) {
    if (!U.hasKosmo) { deepMerge(settings, obj); bus.emit('change', settings, '', obj); return Promise.resolve(); }
    return invoke('kosmo:settings.patch', { patch: obj }).catch((e) => { U.toast(errText(e), { tone: 'danger', ms: 3500 }); throw e; });
  }
  function deepMerge(t, s) {
    for (const k of Object.keys(s)) {
      if (s[k] && typeof s[k] === 'object' && !Array.isArray(s[k]) && t[k] && typeof t[k] === 'object') deepMerge(t[k], s[k]);
      else t[k] = s[k];
    }
  }
  function errText(e) {
    const m = String((e && e.message) || e || '');
    return 'Не сохранилось: ' + m.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
  }

  const api = {
    get, set, patch,
    on(cb) { return bus.on('change', cb); },
    all: () => settings,
    invoke, toast: U.toast, h, icon: U.icon, empty: U.empty,
    open: (id) => select(id),
    get ui() { return ui; }
  };

  // ---------- хелперы разделов ----------
  // каждый элемент управления сам следит за своим путём
  function watch(path, fn) {
    fn(get(path));
    bus.on('change', (_s, p) => { if (!p || p === path || path.startsWith(p + '.') || p.startsWith(path + '.')) fn(get(path)); });
  }
  function searchText(...parts) { return parts.filter(Boolean).join(' ').toLowerCase(); }

  const ui = {
    // row(label, control, hint, {stack, keywords}) — строка: подпись слева, управление справа
    row(label, control, hint, opts) {
      opts = opts || {};
      return h('div.ks-row' + (opts.stack ? '.stack' : ''), { dataset: { search: searchText(label, hint, opts.keywords) } },
        h('div.ks-row-text', h('div.ks-row-label', label), hint ? h('div.ks-row-hint', hint) : null),
        h('div.ks-row-control', control));
    },
    group(title, ...children) {
      return h('section.ks-group', title ? h('div.ks-group-title.k-label', title) : null, children);
    },
    // произвольный блок внутри группы (без подписи слева)
    free(...children) { return h('div.ks-free', children); },
    note(text) { return h('p.ks-note', text); },
    toggle(label, path, hint) {
      const input = h('input.k-switch', { type: 'checkbox', 'aria-label': label });
      watch(path, (v) => { input.checked = !!v; });
      input.addEventListener('change', () => set(path, input.checked).catch(() => {}));
      return ui.row(label, input, hint);
    },
    // options: ['a','b'] | [['a','Подпись']] | [{value, label}]
    select(label, path, options, hint) {
      const opts = normOptions(options);
      const sel = h('select.k-select', { 'aria-label': label }, opts.map((o, i) => h('option', { value: String(i) }, o.label)));
      watch(path, (v) => { const i = opts.findIndex((o) => o.value === v); sel.value = String(i >= 0 ? i : 0); });
      sel.addEventListener('change', () => set(path, opts[+sel.value].value).catch(() => {}));
      return ui.row(label, sel, hint);
    },
    segmented(label, path, options, hint) {
      const opts = normOptions(options);
      const seg = h('div.k-seg', { role: 'radiogroup', 'aria-label': label });
      const btns = opts.map((o) => {
        const b = h('button', { type: 'button', role: 'radio' }, o.icon ? U.icon(o.icon, 14) : null, o.label);
        b.addEventListener('click', () => set(path, o.value).catch(() => {}));
        seg.appendChild(b);
        return b;
      });
      watch(path, (v) => btns.forEach((b, i) => {
        const on = opts[i].value === v;
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.classList.toggle('active', on);
      }));
      return ui.row(label, seg, hint);
    },
    // number(label, path, {min, max, step, unit, hint})
    number(label, path, o) {
      o = o || {};
      const input = h('input.k-input', { type: 'number', min: o.min, max: o.max, step: o.step || 1, 'aria-label': label });
      watch(path, (v) => { if (document.activeElement !== input) input.value = v == null ? '' : v; });
      const commit = () => {
        let v = Number(input.value);
        if (!isFinite(v) || input.value === '') { input.value = get(path); return; }
        if (o.min != null || o.max != null) v = clamp(v, o.min != null ? o.min : -Infinity, o.max != null ? o.max : Infinity);
        if (!o.step || Number.isInteger(o.step)) v = Math.round(v);
        input.value = v;
        if (v !== get(path)) set(path, v).catch(() => {});
      };
      input.addEventListener('change', commit);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); });
      return ui.row(label, [input, o.unit ? h('span.ks-unit', o.unit) : null], o.hint);
    },
    // text(label, path, {placeholder, hint, mono, multiline, stack})
    text(label, path, o) {
      o = o || {};
      const input = o.multiline
        ? h('textarea.k-textarea.ks-text' + (o.mono ? '.k-mono' : ''), { placeholder: o.placeholder || '', spellcheck: 'false', 'aria-label': label })
        : h('input.k-input.ks-text' + (o.mono ? '.k-mono' : ''), { type: 'text', placeholder: o.placeholder || '', spellcheck: 'false', 'aria-label': label });
      if (o.width) input.style.width = typeof o.width === 'number' ? o.width + 'px' : o.width;
      watch(path, (v) => { if (document.activeElement !== input) input.value = v == null ? '' : String(v); });
      const commit = () => { const v = input.value; if (v !== (get(path) == null ? '' : String(get(path)))) set(path, v).catch(() => {}); };
      input.addEventListener('change', commit);
      if (!o.multiline) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commit(); input.blur(); } });
      return ui.row(label, input, o.hint, { stack: o.stack || o.multiline });
    },
    color(label, path, hint) {
      const input = h('input.k-input', { type: 'color', 'aria-label': label });
      const val = h('span.ks-color-value');
      watch(path, (v) => { if (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v)) input.value = v; val.textContent = v || ''; });
      input.addEventListener('input', () => { val.textContent = input.value; });
      input.addEventListener('change', () => set(path, input.value).catch(() => {}));
      return ui.row(label, [val, input], hint);
    },
    // button(label, text, onClick, hint, {primary, danger, icon})
    button(label, text, onClick, hint, o) {
      o = o || {};
      const b = h('button.k-btn' + (o.primary ? '.k-btn-primary' : '') + (o.danger ? '.k-btn-danger' : ''), { type: 'button' }, o.icon ? U.icon(o.icon, 14) : null, text);
      b.addEventListener('click', (e) => onClick(e, b));
      return ui.row(label, b, hint);
    },
    watch
  };
  function normOptions(options) {
    return (options || []).map((o) => {
      if (Array.isArray(o)) return { value: o[0], label: String(o[1] != null ? o[1] : o[0]) };
      if (o && typeof o === 'object') return { value: o.value, label: String(o.label != null ? o.label : o.value), icon: o.icon };
      return { value: o, label: String(o) };
    });
  }

  // ---------- реестр разделов ----------
  function section(def) {
    if (!def || !def.id || typeof def.render !== 'function') throw new Error('KSettings.section: нужен id и render()');
    const old = sections.get(def.id);
    if (old) { old.nav.remove(); if (old.el) old.el.remove(); }
    const nav = h('a.k-list-item.ks-nav-item', { href: '#' + def.id, dataset: { id: def.id } },
      U.icon(def.icon || 'settings'), h('span.k-ellipsis', def.title || def.id));
    nav.addEventListener('click', (e) => { e.preventDefault(); if (query) { qEl.value = ''; setQuery(''); } select(def.id); });
    const s = { def, nav, el: null, rendered: false, order: def.order != null ? def.order : 500 };
    sections.set(def.id, s);
    // по порядку
    const next = Array.from(navEl.children).find((c) => (sections.get(c.dataset.id) || {}).order > s.order);
    navEl.insertBefore(nav, next || null);
    if (started) {
      if (query) setQuery(query);
      else if (activeId === def.id || !activeId) select(activeId || def.id);
    }
    return api;
  }

  function ensureRendered(s) {
    if (s.rendered) return s.el;
    s.rendered = true;
    const body = h('div.ks-section-body');
    s.el = h('section.ks-section', { dataset: { id: s.def.id }, hidden: true },
      h('header.ks-section-head', h('div',
        h('h1.k-h1', s.def.title || s.def.id),
        s.def.description ? h('p.ks-section-desc', s.def.description) : null)),
      body);
    // порядок в DOM — как в навигации
    const ordered = Array.from(sections.values()).sort((a, b) => a.order - b.order);
    const after = ordered.slice(ordered.indexOf(s) + 1).find((x) => x.el && x.el.parentNode);
    contentEl.insertBefore(s.el, after ? after.el : null);
    try { s.def.render(body, api); } catch (e) {
      console.error('[settings]', s.def.id, e);
      body.appendChild(U.empty({ icon: 'alert-triangle', title: 'Раздел не открылся', text: String(e && e.message || e), tone: 'error' }));
    }
    return s.el;
  }

  function select(id) {
    let s = sections.get(id);
    if (!s) s = Array.from(sections.values()).sort((a, b) => a.order - b.order)[0];
    if (!s) return;
    activeId = s.def.id;
    if (query) return;
    for (const x of sections.values()) {
      x.nav.setAttribute('aria-current', x === s ? 'true' : 'false');
      if (x.el) x.el.hidden = x !== s;
    }
    ensureRendered(s).hidden = false;
    mainEl.scrollTop = 0;
    if (location.hash.slice(1) !== activeId) history.replaceState(null, '', '#' + activeId);
    document.title = (s.def.title || 'Настройки') + ' — Настройки';
  }

  // ---------- поиск ----------
  function setQuery(q) {
    query = q.trim().toLowerCase();
    if (!query) {
      for (const s of sections.values()) {
        s.nav.classList.remove('dim');
        if (s.el) s.el.querySelectorAll('.ks-search-hidden').forEach((el) => el.classList.remove('ks-search-hidden'));
      }
      const empty = contentEl.querySelector('.ks-noresults');
      if (empty) empty.remove();
      select(activeId);
      return;
    }
    let any = false;
    for (const s of Array.from(sections.values()).sort((a, b) => a.order - b.order)) {
      const el = ensureRendered(s);
      const titleHit = searchText(s.def.title, s.def.keywords, s.def.description).includes(query);
      let hits = 0;
      el.querySelectorAll('.ks-row').forEach((row) => {
        const hit = titleHit || (row.dataset.search || row.textContent.toLowerCase()).includes(query);
        row.classList.toggle('ks-search-hidden', !hit);
        if (hit) hits++;
      });
      el.querySelectorAll('.ks-group').forEach((g) => {
        const vis = titleHit || g.querySelector('.ks-row:not(.ks-search-hidden)');
        g.classList.toggle('ks-search-hidden', !vis);
      });
      // свободные блоки (без строк) показываем только при совпадении заголовка раздела
      el.querySelectorAll('.ks-free, .ks-note').forEach((f) => f.classList.toggle('ks-search-hidden', !titleHit && !f.textContent.toLowerCase().includes(query)));
      const show = titleHit || hits > 0;
      el.hidden = !show;
      s.nav.classList.toggle('dim', !show);
      s.nav.setAttribute('aria-current', 'false');
      if (show) any = true;
    }
    let empty = contentEl.querySelector('.ks-noresults');
    if (!any && !empty) {
      empty = U.empty({ icon: 'search', title: 'Ничего не найдено', text: 'Попробуйте другое слово.' });
      empty.classList.add('ks-noresults');
      contentEl.appendChild(empty);
    } else if (any && empty) empty.remove();
    mainEl.scrollTop = 0;
  }
  qEl.addEventListener('input', U.debounce(() => setQuery(qEl.value), 80));
  qEl.addEventListener('keydown', (e) => { if (e.key === 'Escape' && qEl.value) { qEl.value = ''; setQuery(''); } });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey && e.key.toLowerCase() === 'f') || (e.key === '/' && document.activeElement === document.body)) { e.preventDefault(); qEl.focus(); qEl.select(); }
  });
  window.addEventListener('hashchange', () => { const id = location.hash.slice(1); if (id && id !== activeId) select(id); });

  // ---------- старт ----------
  on('kosmo:settings.changed', (p) => {
    if (!p) return;
    if (p.settings && typeof p.settings === 'object') settings = p.settings;
    else if (p.path) setPath(settings, p.path, p.value);
    bus.emit('change', settings, p.path || '', p.value);
  });

  async function start() {
    if (U.hasKosmo) {
      try { settings = (await invoke('kosmo:settings.get', {})) || {}; } catch (e) {
        console.error('[settings]', e);
        contentEl.appendChild(U.empty({ icon: 'alert-triangle', title: 'Настройки не загрузились', text: errText(e).replace(/^Не сохранилось: /, ''), tone: 'error' }));
      }
    }
    started = true;
    select(location.hash.slice(1) || null);
  }
  // разделы подключены defer-скриптами после этого файла — стартуем, когда все зарегистрируются
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else setTimeout(start, 0);

  window.KSettings = { section, ui, api, open: select, get, set, on: api.on };
})();
