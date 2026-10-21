// Владелец: themes. Поповер «Тёмная тема» под луной адресной строки (тип 'site-theme').
// Данные: {url, tabId}. Состояние сайта — kosmo:themes.site, изменения — kosmo:themes.setSite / toggleSite.
'use strict';
(function () {
  const U = window.KUI;
  const { h } = U;
  if (!window.KOverlay) return;
  U.css('features/themes.css');
  window.KIcons.add('moon-fill', '<path fill="currentColor" d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>');

  const SLIDERS = [
    { key: 'brightness', label: 'Яркость', min: 50, max: 150 },
    { key: 'contrast', label: 'Контраст', min: 50, max: 150 },
    { key: 'sepia', label: 'Сепия', min: 0, max: 100 }
  ];
  const MODES = [['off', 'Выкл'], ['list', 'Выбранные'], ['all', 'Все']];
  const ENGINES = [['dynamic', 'Динамический'], ['filter', 'Фильтр']];

  function seg(options, onPick, label) {
    const el = h('div.k-seg.kt-seg', { role: 'radiogroup', 'aria-label': label });
    const btns = options.map(([v, text]) => {
      const b = h('button', { type: 'button', role: 'radio', dataset: { v } }, text);
      b.addEventListener('click', () => onPick(v));
      el.appendChild(b);
      return b;
    });
    el.set = (v) => btns.forEach((b) => { const on = b.dataset.v === v; b.classList.toggle('active', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); });
    return el;
  }

  KOverlay.register('site-theme', {
    width: 320,
    render(root, data, api) {
      const ctx = { data: data || {}, state: null, dragging: null, pending: {}, seq: 0 };
      root.classList.add('kt-pop');

      const icon = h('span.kt-ic', U.icon('moon', 18));
      const title = h('div.kt-title', 'Тёмная тема');
      const sub = h('div.kt-sub.k-ellipsis');
      const sw = h('input.k-switch', { type: 'checkbox', 'aria-label': 'Тёмная тема на этом сайте' });
      const head = h('div.kt-head', icon, h('div.kt-head-text', title, sub), sw);
      const note = h('div.kt-note', { hidden: true });

      const rows = {};
      const sliders = h('div.kt-sliders');
      for (const s of SLIDERS) {
        const range = h('input.kt-range', { type: 'range', min: s.min, max: s.max, step: 1, 'aria-label': s.label });
        const val = h('span.kt-val');
        range.addEventListener('pointerdown', () => { ctx.dragging = s.key; });
        range.addEventListener('pointerup', () => { if (ctx.dragging === s.key) setTimeout(() => { ctx.dragging = null; }, 0); });
        range.addEventListener('input', () => { val.textContent = range.value + '%'; paint(range); queue(s.key, +range.value); });
        range.addEventListener('change', () => { ctx.dragging = null; flush(); });
        sliders.appendChild(h('label.kt-slider', h('span.kt-label', s.label), range, val));
        rows[s.key] = { range, val };
      }
      const engine = seg(ENGINES, (v) => send({ engine: v }), 'Движок');
      const engineRow = h('div.kt-row', { title: 'Динамический — Dark Reader пересчитывает цвета сайта. Фильтр — инверсия всей страницы: быстрее, но грубее.' }, h('span.kt-label', 'Движок'), engine);
      const params = h('div.kt-params', sliders, engineRow);

      const mode = seg(MODES, (v) => api.invoke('kosmo:settings.set', { path: 'siteThemes.mode', value: v }).then(load).catch(err), 'Тёмная тема для сайтов');
      const modeRow = h('div.kt-row.kt-mode', { title: 'Выкл — тёмная тема нигде. Выбранные — только на включённых сайтах. Все — везде, кроме выключенных вручную.' }, h('span.kt-label', 'Для сайтов'), mode);

      const cssBtn = h('button.k-btn.k-btn-sm', { type: 'button' }, U.icon('braces', 14), 'Свой CSS…');
      cssBtn.addEventListener('click', () => { api.fire('kosmo:panel.open', { tool: 'theme' }); api.close(); });
      const resetBtn = h('button.k-btn.k-btn-sm.k-btn-ghost', { type: 'button', title: 'Вернуть общие яркость, контраст и движок' }, 'Сбросить');
      resetBtn.addEventListener('click', () => {
        if (!ctx.state) return;
        api.invoke('kosmo:themes.resetSite', { key: ctx.state.key }).then(show).catch(err);
      });
      const foot = h('div.kt-foot', cssBtn, h('span.k-grow'), resetBtn);

      const body = h('div.kt-body', note, params, modeRow);
      const loading = h('div.kt-loading', h('span.k-spinner'));
      root.append(head, loading, body, foot);
      body.hidden = true; foot.hidden = true;

      sw.addEventListener('change', () => {
        if (!ctx.state) return;
        api.invoke('kosmo:themes.toggleSite', { key: ctx.state.key, value: sw.checked }).then(show).catch(err);
      });

      function paint(range) {
        const p = (range.value - range.min) / (range.max - range.min) * 100;
        range.style.setProperty('--p', p + '%');
      }

      function queue(key, v) {
        ctx.pending[key] = v;
        clearTimeout(ctx.timer);
        ctx.timer = setTimeout(flush, 180);
      }
      function flush() {
        clearTimeout(ctx.timer);
        const patch = ctx.pending;
        ctx.pending = {};
        if (Object.keys(patch).length) send(patch);
      }
      function send(patch) {
        if (!ctx.state) return;
        api.invoke('kosmo:themes.setSite', { key: ctx.state.key, patch }).then((s) => { if (!ctx.dragging) show(s); }).catch(err);
      }
      function err(e) {
        const m = String((e && e.message) || e).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
        api.toast('Не получилось: ' + m, { tone: 'danger' });
      }

      function show(s) {
        if (!s) return;
        ctx.state = s;
        loading.hidden = true;
        if (!s.supported) {
          body.hidden = true; foot.hidden = true;
          sw.disabled = true;
          sub.textContent = 'Недоступна на этой странице';
          U.clear(icon).appendChild(U.icon('moon', 18));
          root.classList.remove('on');
          api.resize();
          return;
        }
        body.hidden = false; foot.hidden = false;
        sw.disabled = false;
        sw.checked = !!s.dark;
        sub.textContent = s.host.replace(/^www\./, '');
        sub.title = s.host;
        root.classList.toggle('on', !!s.dark);
        U.clear(icon).appendChild(U.icon(s.dark ? 'moon-fill' : 'moon', 18));
        let n = '';
        if (s.mode === 'off') n = 'Тёмная тема выключена для всех сайтов — включите здесь, и сайт попадёт в список.';
        else if (s.inherited) n = 'Настройки как у ' + s.matchedKey + '. Изменения создадут свои для ' + s.key + '.';
        else if (s.mode === 'all' && s.siteEnabled == null) n = 'Включено для всех сайтов.';
        note.textContent = n;
        note.hidden = !n;
        for (const sl of SLIDERS) {
          const r = rows[sl.key];
          if (ctx.dragging === sl.key) continue;
          const v = Number(s.params[sl.key]);
          r.range.value = String(v);
          r.val.textContent = v + '%';
          paint(r.range);
        }
        engine.set(s.params.engine);
        mode.set(s.mode);
        params.classList.toggle('off', !s.dark);
        const own = s.own || {};
        resetBtn.disabled = !['engine', 'brightness', 'contrast', 'sepia', 'grayscale', 'bg', 'text'].some((k) => own[k] != null);
        cssBtn.lastChild.textContent = s.css ? 'Свой CSS (есть)' : 'Свой CSS…';
        api.resize();
      }

      function load() {
        const my = ++ctx.seq;
        return api.invoke('kosmo:themes.site', { url: ctx.data.url, tabId: ctx.data.tabId }).then((s) => { if (my === ctx.seq) show(s); }).catch(err);
      }

      api.on('kosmo:settings.changed', (p) => {
        if (p && typeof p.path === 'string' && (p.path === '' || p.path.startsWith('siteThemes') || p.path.startsWith('ui'))) load();
      });
      ctx.reload = (d) => { ctx.data = d || ctx.data; load(); };
      root._kt = ctx;
      load();
    },
    update(data, api) {
      const ctx = api.root && api.root._kt;
      if (ctx) ctx.reload(data);
    }
  });
})();
