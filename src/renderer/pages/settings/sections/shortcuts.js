// Владелец: tools-pack (база — core). «Горячие клавиши»: все команды из kosmo:commands.list по категориям,
// служебные сочетания, которых нет в списке команд, и поиск по названию или клавише.
'use strict';
KSettings.section({
  id: 'shortcuts', title: 'Горячие клавиши', icon: 'keyboard', order: 90,
  keywords: 'клавиши сочетания команды хоткеи палитра',
  description: 'Любую команду, даже без сочетания, можно найти и выполнить в командной палитре — Ctrl+K.',
  render(el, api) {
    const U = window.KUI;
    const { h } = U;
    U.css('sections/tools-pack.css');
    const errText = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');

    const CAT_ORDER = ['Вкладки', 'Навигация', 'Страница', 'Вид', 'Браузер', 'Claude', 'Разработка', 'Оформление'];
    // Сочетания, которых нет среди видимых команд (скрытые команды ядра и клавиши отдельных окон).
    const EXTRA = [
      { category: 'Вкладки', title: 'Вкладка 1–8', keys: ['Ctrl+1 … Ctrl+8'] },
      { category: 'Вкладки', title: 'Последняя вкладка', keys: ['Ctrl+9'] },
      { category: 'Вкладки', title: 'Открыть ссылку в фоновой вкладке', keys: ['Ctrl+клик', 'средняя кнопка'] },
      { category: 'Страница', title: 'Следующее совпадение при поиске', keys: ['F3', 'Ctrl+G', 'Enter'] },
      { category: 'Страница', title: 'Предыдущее совпадение', keys: ['Shift+F3', 'Ctrl+Shift+G', 'Shift+Enter'] },
      { category: 'Вид', title: 'Выйти из полноэкранного видео', keys: ['Esc'] },
      { category: 'Редактор сниппетов', title: 'Выполнить', keys: ['Ctrl+Enter'] },
      { category: 'Редактор сниппетов', title: 'Сохранить', keys: ['Ctrl+S'] },
      { category: 'Редактор сниппетов', title: 'Отступ / убрать отступ', keys: ['Tab', 'Shift+Tab'] },
      { category: 'Редактор сниппетов', title: 'Закомментировать строки', keys: ['Ctrl+/'] }
    ];
    const KEY_NAMES = { Left: '←', Right: '→', Up: '↑', Down: '↓', PageUp: 'PgUp', PageDown: 'PgDn', Escape: 'Esc', NumpadAdd: 'Num +', NumpadSubtract: 'Num −', Numpad0: 'Num 0', '-': '−' };
    function comboEl(combo) {
      if (/\s|…|клик|кнопка/.test(combo)) return h('span.tps-combo', h('span.k-kbd', combo));
      const parts = combo.split('+');
      if (combo.endsWith('++')) parts.splice(parts.length - 2, 2, '+');
      return h('span.tps-combo', parts.map((p, i) => [i ? h('span.tps-plus', '+') : null, h('span.k-kbd', KEY_NAMES[p] || p)]));
    }

    const search = h('input.k-input', { type: 'search', placeholder: 'Команда или клавиша, например Ctrl+Shift', spellcheck: 'false', 'aria-label': 'Найти сочетание' });
    const holder = h('div', api.ui.group(null, api.ui.free(h('div.k-row.k-dim', h('span.k-spinner'), 'Загружаю…'))));
    el.append(h('label.k-search.tps-sc-search', U.icon('search', 14), search), holder);

    let groups = [];
    function render() {
      const q = search.value.trim().toLowerCase().replace(/\s+/g, '');
      U.clear(holder);
      let shown = 0;
      for (const g of groups) {
        const rows = g.items.filter((c) => !q || (c.title + c.id + c.keys.join(' ')).toLowerCase().replace(/\s+/g, '').includes(q));
        if (!rows.length) continue;
        shown += rows.length;
        const withKeys = rows.filter((c) => c.keys.length);
        const noKeys = rows.filter((c) => !c.keys.length);
        const grp = api.ui.group(g.name, withKeys.map((c) => api.ui.row(c.title, h('span.ks-keys', c.keys.map(comboEl)), null, { keywords: c.keys.join(' ') + ' ' + c.id })));
        if (noKeys.length) {
          grp.appendChild(api.ui.row('Без сочетания — через палитру Ctrl+K', h('span'), noKeys.map((c) => c.title).join(' · '), { keywords: noKeys.map((c) => c.title + ' ' + c.id).join(' ') }));
          grp.lastChild.classList.add('tps-nokeys');
        }
        holder.appendChild(grp);
      }
      if (!shown) holder.appendChild(api.ui.group(null, api.ui.free(api.empty({ icon: 'search', title: 'Ничего не найдено', text: 'Попробуйте название команды или клавишу.' }))));
    }
    search.addEventListener('input', U.debounce(render, 60));
    search.addEventListener('keydown', (e) => { if (e.key === 'Escape' && search.value) { search.value = ''; render(); e.stopPropagation(); } });

    api.invoke('kosmo:commands.list', {}).then((list) => {
      list = Array.isArray(list) ? list.filter((c) => c && c.title) : [];
      const all = list.map((c) => ({ id: c.id, title: c.title, category: c.category || 'Прочее', keys: Array.isArray(c.keys) ? c.keys : [] }))
        .concat(EXTRA.map((c, i) => ({ id: 'extra' + i, title: c.title, category: c.category, keys: c.keys })));
      const by = new Map();
      for (const c of all) { if (!by.has(c.category)) by.set(c.category, []); by.get(c.category).push(c); }
      const rank = (n) => { const i = CAT_ORDER.indexOf(n); return i < 0 ? (n === 'Редактор сниппетов' ? 99 : 50) : i; };
      groups = Array.from(by, ([name, items]) => ({ name, items: items.sort((a, b) => (b.keys.length ? 1 : 0) - (a.keys.length ? 1 : 0)) }))
        .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name, 'ru'));
      render();
    }).catch((e) => {
      U.clear(holder).appendChild(api.ui.group(null, api.ui.free(api.empty({ icon: 'alert-triangle', title: 'Не удалось получить список', text: errText(e), tone: 'error' }))));
    });
  }
});
