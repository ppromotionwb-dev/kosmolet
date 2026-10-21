// Владелец: themes (база — core). Раздел «Оформление»: тема интерфейса (4 пресета + своя), свои цвета с превью,
// акцент, плотность, размер шрифта. Применяется на лету во всех слоях (shared/theme.js слушает настройки).
// Тёмная тема для сайтов — в разделе «Темы сайтов» (site-themes.js).
'use strict';
(function () {
  const U = window.KUI;
  const { h } = U;
  U.css('sections/site-themes.css');
  const svg = (n, s) => window.KIcons.get(n, s || 16);
  const ACCENTS = ['#7c6cff', '#4f8cff', '#22b8cf', '#3ddc84', '#e9b04f', '#ff7a45', '#ef5d8f', '#a86bff'];
  const PRESETS = ((window.KTheme && window.KTheme.presets) || [
    { id: 'cosmos', title: 'Космос', accent: '#7c6cff' }, { id: 'graphite', title: 'Графит', accent: '#7c6cff' },
    { id: 'light', title: 'Светлая', accent: '#6a5af0' }, { id: 'terminal', title: 'Терминал', accent: '#3ddc84' }
  ]).concat([{ id: 'custom', title: 'Своя', accent: null }]);
  const presetAccents = new Set(PRESETS.filter((p) => p.accent).map((p) => p.accent.toLowerCase()));
  const CUSTOM_DEFAULT = { bg: '#12141c', surface: '#1e2130', text: '#e5e7f0' };
  // Готовые основы для своей темы — отправная точка, дальше любые цвета.
  const CUSTOM_STARTS = [
    { title: 'Ночь', bg: '#0e1525', surface: '#18223a', text: '#dfe6f5' },
    { title: 'Уголь', bg: '#141414', surface: '#222222', text: '#ececec' },
    { title: 'Шоколад', bg: '#1d1714', surface: '#2b221d', text: '#efe4da' },
    { title: 'Хвоя', bg: '#0f1a16', surface: '#1a2a24', text: '#dcefe6' },
    { title: 'Бумага', bg: '#f4efe6', surface: '#e8e1d4', text: '#2a241c' }
  ];
  const HEX = /^#[0-9a-f]{6}$/i;

  function lum(hex) {
    if (!HEX.test(hex || '')) return null;
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function contrast(a, b) {
    const x = lum(a), y = lum(b);
    if (x == null || y == null) return null;
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }

  function preview(id) {
    return h('div.ks-prev', { dataset: { themePreview: id } },
      h('div.ks-prev-strip', h('div.ks-prev-tab'), h('div.ks-prev-tab.off'), h('div.ks-prev-tab.off')),
      h('div.ks-prev-bar', h('span.ks-prev-dot'), h('span.ks-prev-dot'), h('span.ks-prev-omni')),
      h('div.ks-prev-page', h('div.ks-prev-line.t'), h('div.ks-prev-line'), h('div.ks-prev-line.s'), h('div.ks-prev-btn')));
  }
  // превью своей темы — палитра из settings.ui.custom прямо на элементе
  function paintCustom(el, c) {
    c = Object.assign({}, CUSTOM_DEFAULT, c || {});
    el.style.setProperty('--k-bg', c.bg);
    el.style.setProperty('--k-surface', c.surface);
    el.style.setProperty('--k-text', c.text);
    const l = lum(c.bg);
    el.dataset.scheme = l != null && l > 0.45 ? 'light' : 'dark';
    el.style.colorScheme = el.dataset.scheme;
  }

  KSettings.section({
    id: 'appearance', title: 'Оформление', icon: 'palette', order: 10,
    keywords: 'тема интерфейса цвет акцент плотность шрифт тёмная светлая своя космос графит терминал',
    description: 'Как выглядит сам браузер. Меняется сразу во всех окнах. Тёмная тема для сайтов — в разделе «Темы сайтов».',
    render(el, api) {
      const ui = api.ui;

      // ---------- темы ----------
      const grid = h('div.ks-themes.kst-themes', { role: 'radiogroup', 'aria-label': 'Тема интерфейса' });
      let customPrev = null;
      const cards = PRESETS.map((p) => {
        const prev = preview(p.id);
        if (p.id === 'custom') customPrev = prev;
        else prev.style.setProperty('--k-accent', p.accent); // превью — с акцентом самого пресета
        const card = h('button.ks-theme', { type: 'button', role: 'radio', dataset: { id: p.id } },
          prev, h('span.ks-theme-name', h('span', p.title), h('span', { html: svg('check', 14) })));
        card.addEventListener('click', async () => {
          if (api.get('ui.theme') === p.id) return;
          const accent = String(api.get('ui.accent') || '').toLowerCase();
          if (p.id === 'custom') {
            const cur = api.get('ui.custom') || {};
            if (!HEX.test(cur.bg || '')) await api.set('ui.custom', Object.assign({}, CUSTOM_DEFAULT)).catch(() => {});
          }
          await api.set('ui.theme', p.id).catch(() => {});
          // акцент «по умолчанию» меняем вместе с темой, свой — не трогаем
          if (p.accent && (!accent || presetAccents.has(accent))) api.set('ui.accent', p.accent).catch(() => {});
        });
        grid.appendChild(card);
        return card;
      });
      ui.watch('ui.theme', (v) => cards.forEach((c) => c.setAttribute('aria-checked', c.dataset.id === (v || 'cosmos') ? 'true' : 'false')));
      ui.watch('ui.custom', (c) => { if (customPrev) paintCustom(customPrev, c); });
      const themeRow = h('div.ks-row.stack', { dataset: { search: 'тема интерфейса космос графит светлая терминал своя' }, style: 'padding:0' }, grid);

      // ---------- свои цвета ----------
      const customGroup = ui.group('Свои цвета');
      customGroup.classList.add('kst-custom');
      const fields = [
        ['bg', 'Фон', 'Окно, вкладки и панели — от него считаются оттенки'],
        ['surface', 'Поверхности', 'Кнопки, поля, карточки'],
        ['text', 'Текст', 'Основной текст; приглушённый считается сам']
      ];
      const inputs = {};
      for (const [k, label, hint] of fields) {
        const input = h('input.k-input', { type: 'color', 'aria-label': label });
        const hex = h('input.k-input.k-mono.kst-hex', { type: 'text', spellcheck: 'false', maxlength: 7, 'aria-label': label + ', код цвета' });
        const commit = (v) => {
          v = String(v || '').trim().toLowerCase();
          if (/^[0-9a-f]{6}$/i.test(v)) v = '#' + v;
          if (!HEX.test(v)) { hex.value = (api.get('ui.custom') || {})[k] || ''; return; }
          const next = Object.assign({}, CUSTOM_DEFAULT, api.get('ui.custom') || {}, { [k]: v });
          api.set('ui.custom', next).catch(() => {});
        };
        input.addEventListener('input', () => { hex.value = input.value; if (customPrev) paintCustom(customPrev, Object.assign({}, api.get('ui.custom') || {}, { [k]: input.value })); });
        input.addEventListener('change', () => commit(input.value));
        hex.addEventListener('change', () => commit(hex.value));
        hex.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commit(hex.value); hex.blur(); } });
        inputs[k] = { input, hex };
        customGroup.appendChild(ui.row(label, h('div.kst-color', hex, input), hint));
      }
      const warn = h('div.kst-warn', { hidden: true });
      const starts = h('div.kst-starts');
      for (const s of CUSTOM_STARTS) {
        const b = h('button.kst-start', { type: 'button', title: s.title, style: { '--sb': s.bg, '--ss': s.surface, '--st': s.text } }, h('span.kst-start-dot'), s.title);
        b.addEventListener('click', () => api.set('ui.custom', { bg: s.bg, surface: s.surface, text: s.text }).catch(() => {}));
        starts.appendChild(b);
      }
      customGroup.appendChild(ui.row('Основа', starts, 'Начните с готовой и подправьте', { stack: true }));
      customGroup.appendChild(ui.free(warn));
      ui.watch('ui.custom', (c) => {
        c = Object.assign({}, CUSTOM_DEFAULT, c || {});
        for (const k of Object.keys(inputs)) {
          if (document.activeElement !== inputs[k].hex) inputs[k].hex.value = c[k];
          if (HEX.test(c[k])) inputs[k].input.value = c[k];
        }
        const r = contrast(c.text, c.bg);
        const r2 = contrast(c.text, c.surface);
        const bad = r != null && (r < 4.5 || (r2 != null && r2 < 3.5));
        warn.hidden = !bad;
        warn.textContent = bad ? 'Текст плохо читается на этом фоне (контраст ' + (Math.round(Math.min(r, r2 || r) * 10) / 10) + ':1, нужно от 4,5:1).' : '';
      });
      ui.watch('ui.theme', (v) => { customGroup.hidden = v !== 'custom'; });

      // ---------- акцент ----------
      const sw = h('div.ks-swatches', { role: 'radiogroup', 'aria-label': 'Акцент' });
      const customAccent = h('input.k-input', { type: 'color', title: 'Свой цвет', 'aria-label': 'Свой цвет акцента' });
      customAccent.addEventListener('change', () => api.set('ui.accent', customAccent.value).catch(() => {}));
      let swatches = [];
      function markAccent() {
        const cur = String(api.get('ui.accent') || '').toLowerCase();
        swatches.forEach((b) => b.setAttribute('aria-checked', b.dataset.color === cur ? 'true' : 'false'));
        if (/^#[0-9a-f]{6}$/.test(cur)) customAccent.value = cur;
      }
      function buildSwatches() {
        const preset = PRESETS.find((p) => p.id === (api.get('ui.theme') || 'cosmos') && p.accent);
        const list = [];
        if (preset) list.push(preset.accent.toLowerCase());
        for (const c of ACCENTS) if (!list.includes(c)) list.push(c);
        U.clear(sw);
        swatches = list.map((c, i) => {
          const b = h('button.ks-swatch', {
            type: 'button', role: 'radio', title: i === 0 && preset ? 'Цвет темы «' + preset.title + '»' : c, dataset: { color: c },
            style: { '--sw': c, '--on': window.KTheme ? window.KTheme.onAccent(c) : null }, html: svg('check', 12)
          });
          b.addEventListener('click', () => api.set('ui.accent', c).catch(() => {}));
          sw.appendChild(b);
          return b;
        });
        sw.appendChild(customAccent);
        markAccent();
      }
      ui.watch('ui.theme', buildSwatches);
      ui.watch('ui.accent', markAccent);

      el.append(
        ui.group('Тема интерфейса', themeRow),
        customGroup,
        ui.group(null,
          ui.row('Акцент', sw, 'Цвет выделения, активной вкладки и кнопок'),
          ui.segmented('Плотность', 'ui.density', [['normal', 'Обычная'], ['compact', 'Компактная']], 'Компактная — ниже вкладки и панели'),
          ui.number('Размер шрифта', 'ui.fontSize', { min: 11, max: 16, unit: 'px', hint: 'Текст интерфейса; страницы сайтов не меняются' })),
        ui.group(null,
          ui.toggle('Полоса закладок', 'ui.showBookmarksBar', 'Под адресной строкой')));
    }
  });
})();
