// Владелец: core (база); фича themes расширяет раздел (свои цвета custom, темы сайтов — в site-themes.js).
// Тема интерфейса (4 пресета), акцент, плотность, размер шрифта.
'use strict';
(function () {
  const U = window.KUI;
  const { h } = U;
  const svg = (n, s) => window.KIcons.get(n, s || 16);
  const ACCENTS = ['#7c6cff', '#4f8cff', '#22b8cf', '#3ddc84', '#e9b04f', '#ff7a45', '#ef5d8f', '#a86bff'];
  const PRESETS = (window.KTheme && window.KTheme.presets) || [
    { id: 'cosmos', title: 'Космос', accent: '#7c6cff' }, { id: 'graphite', title: 'Графит', accent: '#7c6cff' },
    { id: 'light', title: 'Светлая', accent: '#6a5af0' }, { id: 'terminal', title: 'Терминал', accent: '#3ddc84' }
  ];
  const presetAccents = new Set(PRESETS.map((p) => p.accent.toLowerCase()));

  function preview(id) {
    return h('div.ks-prev', { dataset: { themePreview: id } },
      h('div.ks-prev-strip', h('div.ks-prev-tab'), h('div.ks-prev-tab.off'), h('div.ks-prev-tab.off')),
      h('div.ks-prev-bar', h('span.ks-prev-dot'), h('span.ks-prev-dot'), h('span.ks-prev-omni')),
      h('div.ks-prev-page', h('div.ks-prev-line.t'), h('div.ks-prev-line'), h('div.ks-prev-line.s'), h('div.ks-prev-btn')));
  }

  KSettings.section({
    id: 'appearance', title: 'Оформление', icon: 'palette', order: 10,
    keywords: 'тема интерфейса цвет акцент плотность шрифт тёмная светлая',
    description: 'Как выглядит сам браузер. Тёмная тема для сайтов — в разделе «Темы сайтов».',
    render(el, api) {
      const ui = api.ui;

      // темы
      const grid = h('div.ks-themes', { role: 'radiogroup', 'aria-label': 'Тема интерфейса' });
      const cards = PRESETS.map((p) => {
        const card = h('button.ks-theme', { type: 'button', role: 'radio', dataset: { id: p.id } },
          preview(p.id),
          h('span.ks-theme-name', h('span', p.title), h('span', { html: svg('check', 14) })));
        card.addEventListener('click', async () => {
          if (api.get('ui.theme') === p.id) return;
          const accent = String(api.get('ui.accent') || '').toLowerCase();
          await api.set('ui.theme', p.id).catch(() => {});
          // акцент «по умолчанию» меняем вместе с темой, свой — не трогаем
          if (!accent || presetAccents.has(accent)) api.set('ui.accent', p.accent).catch(() => {});
        });
        grid.appendChild(card);
        return card;
      });
      ui.watch('ui.theme', (v) => cards.forEach((c) => c.setAttribute('aria-checked', c.dataset.id === (v || 'cosmos') ? 'true' : 'false')));
      const themeRow = h('div', { dataset: { search: 'тема интерфейса космос графит светлая терминал' } });
      themeRow.className = 'ks-row stack';
      themeRow.style.padding = '0';
      themeRow.appendChild(grid);

      // акцент: первым — цвет темы по умолчанию, дальше палитра
      const sw = h('div.ks-swatches', { role: 'radiogroup', 'aria-label': 'Акцент' });
      const custom = h('input.k-input', { type: 'color', title: 'Свой цвет', 'aria-label': 'Свой цвет акцента' });
      custom.addEventListener('change', () => api.set('ui.accent', custom.value).catch(() => {}));
      let swatches = [];
      function markAccent() {
        const cur = String(api.get('ui.accent') || '').toLowerCase();
        swatches.forEach((b) => b.setAttribute('aria-checked', b.dataset.color === cur ? 'true' : 'false'));
        if (/^#[0-9a-f]{6}$/.test(cur)) custom.value = cur;
      }
      function buildSwatches() {
        const preset = PRESETS.find((p) => p.id === (api.get('ui.theme') || 'cosmos'));
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
        sw.appendChild(custom);
        markAccent();
      }
      ui.watch('ui.theme', buildSwatches);
      ui.watch('ui.accent', markAccent);

      el.append(
        ui.group('Тема интерфейса', themeRow),
        ui.group(null,
          ui.row('Акцент', sw, 'Цвет выделения, активной вкладки и кнопок'),
          ui.segmented('Плотность', 'ui.density', [['normal', 'Обычная'], ['compact', 'Компактная']], 'Компактная — ниже вкладки и панели'),
          ui.number('Размер шрифта', 'ui.fontSize', { min: 11, max: 16, unit: 'px', hint: 'Текст интерфейса; страницы сайтов не меняются' })),
        ui.group(null,
          ui.toggle('Полоса закладок', 'ui.showBookmarksBar', 'Под адресной строкой')));
    }
  });
})();
