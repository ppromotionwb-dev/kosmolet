// Владелец: tools-pack. Всплывающее окно «Выполнить сниппет…» (команда палитры snippets.run):
// поиск по своим и встроенным сниппетам, ↑↓ и Enter. Выполнение — в main, результат — в панели «Сниппеты».
'use strict';
(function () {
  const U = window.KUI;
  const { h } = U;
  const O = window.KOverlay;
  if (!O) return;
  U.css('features/tools-pack.css');

  function rank(q, s) {
    if (!q) return 1;
    const t = (s.name + ' ' + (s.desc || '') + ' ' + (s.match || '')).toLowerCase();
    const i = t.indexOf(q);
    if (i < 0) return -1;
    return 1000 - i + (i === 0 || /[\s«(:—-]/.test(t[i - 1]) ? 300 : 0);
  }

  O.register('tools-snippet-pick', {
    align: 'top', width: 'min(560px, 100%)', className: 'tp-pick',
    render(root, data, api) {
      data = data || {};
      const st = { q: '', items: [], sel: 0 };
      const input = h('input.tp-pick-input', {
        type: 'text', autofocus: true, spellcheck: 'false', autocomplete: 'off',
        placeholder: data.host ? 'Сниппет для ' + data.host : 'Найти сниппет', 'aria-label': 'Найти сниппет'
      });
      const list = h('div.tp-pick-list.ov-scroll', { role: 'listbox' });
      root.append(...[
        h('div.tp-pick-head', U.icon('file-code', 16), input, h('span.k-kbd', 'Esc')),
        data.canRun ? null : h('div.tp-pick-warn', U.icon('info', 14), 'Активная вкладка — не сайт. Сниппет выполнится с ошибкой; откройте страницу сайта.'),
        list,
        h('div.tp-pick-foot', h('span', h('span.k-kbd', 'Enter'), ' выполнить'), h('span', h('span.k-kbd', '↑'), h('span.k-kbd', '↓'), ' выбрать'), h('span.k-grow'),
          h('button.k-btn.k-btn-sm.k-btn-ghost', { type: 'button', onClick: () => { api.invoke('kosmo:panel.open', { tool: 'snippets' }).catch(() => {}); api.close(); } }, 'Открыть панель'))
      ].filter(Boolean));

      function compute() {
        const q = st.q.trim().toLowerCase();
        const mine = (data.items || []).map((s) => ({ s, g: 'Мои', r: rank(q, s) })).filter((x) => x.r >= 0);
        const lib = (data.builtins || []).map((s) => ({ s, g: 'Библиотека', r: rank(q, s) })).filter((x) => x.r >= 0);
        if (q) { mine.sort((a, b) => b.r - a.r); lib.sort((a, b) => b.r - a.r); }
        st.items = mine.concat(lib);
        if (st.sel >= st.items.length) st.sel = 0;
        paint();
      }
      function paint() {
        U.clear(list);
        if (!st.items.length) {
          list.appendChild(U.empty({ icon: 'search', title: 'Ничего не найдено', text: (data.items || []).length ? 'Попробуйте другое слово.' : 'Своих сниппетов пока нет — создайте их в панели «Сниппеты».' }));
          return;
        }
        let group = null;
        st.items.forEach((x, i) => {
          if (x.g !== group) { group = x.g; list.appendChild(h('div.tp-pick-group.k-label', group)); }
          const s = x.s;
          const sub = s.desc || [s.world === 'page' ? 'мир страницы' : 'изолированный', s.auto ? 'авто: ' + (s.match || '—') : ''].filter(Boolean).join(' · ');
          list.appendChild(h('div.tp-pick-row' + (i === st.sel ? '.sel' : ''), { role: 'option', dataset: { i: String(i) } },
            U.icon(s.auto ? 'zap' : 'file-code', 16),
            h('span.tp-pick-text', h('span.tp-pick-title', s.name), h('span.tp-pick-sub', sub))));
        });
        const sel = list.querySelector('.tp-pick-row.sel');
        if (sel) sel.scrollIntoView({ block: 'nearest' });
      }
      function setSel(i) {
        st.sel = i;
        list.querySelectorAll('.tp-pick-row').forEach((r) => r.classList.toggle('sel', Number(r.dataset.i) === i));
        const sel = list.querySelector('.tp-pick-row.sel');
        if (sel) sel.scrollIntoView({ block: 'nearest' });
      }
      function pick(x) {
        if (!x) return;
        api.invoke('kosmo:snippets.runPicked', { id: x.s.id }).catch((e) => { console.warn('[tools-pack]', e); api.close(); });
      }
      input.addEventListener('input', () => { st.q = input.value; st.sel = 0; compute(); });
      input.addEventListener('keydown', (e) => {
        const n = st.items.length;
        if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) { e.preventDefault(); if (n) setSel((st.sel + 1) % n); }
        else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) { e.preventDefault(); if (n) setSel((st.sel - 1 + n) % n); }
        else if (e.key === 'Enter') { e.preventDefault(); pick(st.items[st.sel]); }
      });
      list.addEventListener('click', (e) => { const r = e.target.closest('.tp-pick-row'); if (r) pick(st.items[Number(r.dataset.i)]); });
      list.addEventListener('pointermove', (e) => { const r = e.target.closest('.tp-pick-row'); if (r && Number(r.dataset.i) !== st.sel) setSel(Number(r.dataset.i)); });
      compute();
    }
  });
})();
