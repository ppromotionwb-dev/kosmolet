// Владелец: platform. Раздел «Контейнеры»: добавить, переименовать, цвет, очистить данные, удалить.
// «Данные…» — метаданные контейнера (scope: пак, поля по схеме, доступ агента, защита) — панель packs (container-scope.js).
'use strict';
(function () {
  const U = window.KUI;
  const { h } = U;
  U.css('sections/containers.css');

  // Цвета контейнеров — данные пользователя (метка вкладки), не цвета интерфейса.
  const PALETTE = [
    ['#7c6cff', 'Фиолетовый'], ['#4c8dff', 'Синий'], ['#22b8cf', 'Бирюзовый'], ['#43c98a', 'Зелёный'],
    ['#e9b04f', 'Жёлтый'], ['#ff8a3d', 'Оранжевый'], ['#ef6b6b', 'Красный'], ['#e86bb6', 'Розовый'], ['#8a8f98', 'Серый']
  ];
  const clean = (e) => String((e && e.message) || e || '').replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '').replace(/^./, (c) => c.toUpperCase());

  KSettings.section({
    id: 'containers', title: 'Контейнеры', icon: 'layers', order: 40,
    keywords: 'контейнеры сессии кабинеты аккаунты изоляция cookies вход цвет',
    description: 'Разные кабинеты в одном окне: у каждого контейнера свои cookies, вход на сайты, кэш и данные расширений. Вкладки контейнера помечены его цветом.',
    render(el, api) {
      const ui = api.ui;
      const listEl = h('div.kc-list');
      const addBtn = h('button.k-btn.k-btn-sm.k-btn-primary', { type: 'button' }, U.icon('plus', 14), 'Добавить контейнер');
      const anchor = (text) => h('div.ks-row', { hidden: true, dataset: { search: text } });
      // без подписи группы: заголовок страницы уже «Контейнеры»
      el.appendChild(ui.group(null, ui.free(listEl), ui.free(h('div.kc-foot', h('span.k-faint', 'Открыть в контейнере — правый клик по ссылке или вкладке, а также меню «⋯» → «Новая вкладка в контейнере».'), addBtn)),
        anchor('контейнеры добавить переименовать цвет удалить очистить данные')));
      el.appendChild(ui.group('Изолированные вкладки',
        ui.toggle('Каждая новая вкладка — изолированная', 'privacy.isolateNewTabs', 'Ctrl+T и «+» открывают вкладку в своём временном контейнере: отдельный вход, cookies и кэш без новых окон и профилей. Ссылки и окна, открытые со страницы, остаются в её контейнере.'),
        anchor('изолированная вкладка временный контейнер отдельный вход кабинет Ctrl+Shift+N')));
      el.appendChild(ui.note('Изолированная вкладка без этого режима — Ctrl+Shift+N или Shift+клик по «+». Временный контейнер удаляется вместе с данными, когда закрыта его последняя вкладка; чтобы сохранить вход, нажмите «Оставить» (или в меню чипа контейнера в адресной строке).'));

      let counts = {};
      let openMenu = null;   // id контейнера с открытой палитрой
      let confirm = null;    // {id, kind: 'clear'|'remove'}
      const busy = new Set();
      let editing = null;    // id, чьё имя сейчас редактируется (не перерисовывать поле)
      let scopeOpen = null;  // id с открытой панелью «Данные контейнера»
      let scopes = {};       // id → scope (kosmo:scopes.list)
      const ACCESS_RU = { off: 'агенту закрыт', read: 'агент: чтение', ops: 'агент: операции', full: '' };
      function loadScopes() {
        return api.invoke('kosmo:scopes.list', {}).then((list) => {
          const next = {};
          for (const x of list || []) next[x.containerId] = x;
          const changed = JSON.stringify(next) !== JSON.stringify(scopes);
          scopes = next;
          if (changed) render();
        }).catch(() => {});
      }

      function list() { const v = api.get('containers'); return Array.isArray(v) && v.length ? v : [{ id: 'main', name: 'Основной', color: '#7c6cff' }]; }

      function save(next) { return api.set('containers', next).catch(() => {}); }

      function rename(id, name) {
        name = String(name || '').trim().slice(0, 40);
        const cur = list();
        const c = cur.find((x) => x.id === id);
        if (!c || !name || name === c.name) { render(); return; }
        save(cur.map((x) => (x.id === id ? Object.assign({}, x, { name }) : x)));
      }
      function recolor(id, color) {
        openMenu = null;
        save(list().map((x) => (x.id === id ? Object.assign({}, x, { color }) : x)));
      }

      function add() {
        const cur = list();
        const used = new Set(cur.map((c) => c.color));
        const color = (PALETTE.find((p) => !used.has(p[0])) || PALETTE[cur.length % PALETTE.length])[0];
        let n = cur.length; let name;
        do { name = 'Контейнер ' + n; n++; } while (cur.some((c) => c.name === name));
        const id = 'c' + Date.now().toString(36) + Math.floor(Math.random() * 36).toString(36);
        editing = null;
        save(cur.concat({ id, name, color })).then(() => setTimeout(() => {
          const input = listEl.querySelector('[data-id="' + id + '"] .kc-name');
          if (input) { input.focus(); input.select(); }
        }, 20));
      }
      addBtn.addEventListener('click', add);

      function run(id, kind) {
        busy.add(id);
        confirm = null;
        render();
        const ch = kind === 'remove' ? 'kosmo:containers.remove' : 'kosmo:containers.clearData';
        api.invoke(ch, { id }).then((r) => {
          if (kind === 'remove') api.toast(r && r.closed ? 'Контейнер удалён, закрыто вкладок: ' + r.closed : 'Контейнер удалён');
          else api.toast('Данные контейнера очищены');
        }).catch((e) => api.toast(clean(e), { tone: 'danger', ms: 4000 })).finally(() => { busy.delete(id); render(); });
      }

      function swatches(c) {
        const box = h('div.kc-palette.ks-swatches', { role: 'radiogroup', 'aria-label': 'Цвет контейнера' });
        for (const [color, title] of PALETTE) {
          const b = h('button.ks-swatch', { type: 'button', role: 'radio', title, style: { '--sw': color }, 'aria-checked': c.color.toLowerCase() === color ? 'true' : 'false', html: window.KIcons.get('check', 12, { stroke: 2.4 }) });
          b.addEventListener('click', () => recolor(c.id, color));
          box.appendChild(b);
        }
        return box;
      }

      function row(c) {
        const n = counts[c.id] || 0;
        const isMain = c.id === 'main';
        const color = h('button.kc-color', { type: 'button', title: 'Сменить цвет', 'aria-label': 'Сменить цвет контейнера', style: { '--kc': c.color }, 'aria-expanded': openMenu === c.id ? 'true' : 'false' });
        color.addEventListener('click', () => { openMenu = openMenu === c.id ? null : c.id; confirm = null; render(); });
        const name = h('input.k-input.kc-name', { type: 'text', value: c.name, maxlength: '40', spellcheck: 'false', 'aria-label': 'Название контейнера' });
        let committed = false;
        name.addEventListener('focus', () => { editing = c.id; committed = false; });
        name.addEventListener('blur', () => {
          if (committed) return;
          committed = true;
          editing = null;
          // после события blur: перерисовка списка удаляет это поле, внутри обработчика так нельзя
          setTimeout(() => rename(c.id, name.value), 0);
        });
        name.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); name.blur(); }
          else if (e.key === 'Escape') { name.value = c.name; name.blur(); }
        });
        const meta = h('span.kc-meta', n ? n + ' ' + U.plural(n, ['вкладка', 'вкладки', 'вкладок']) : 'нет вкладок');
        const tags = isMain ? h('span.k-badge', 'по умолчанию') : c.temp ? h('span.k-badge', { title: 'Удалится вместе с данными, когда закроется последняя вкладка' }, 'временный') : null;
        const sc = scopes[c.id];
        const scTags = [];
        if (sc && sc.chip) scTags.push(h('span.kc-scope', { title: 'Чип в адресной строке' }, h('span.kc-smark', { style: { '--kc': c.color } }, sc.chip.mark), sc.chip.label + (sc.chip.account ? ' · ' + sc.chip.account : '')));
        if (sc && sc.protect) scTags.push(h('span.k-badge', { title: 'Агент пишет только через операции, секреты скрыты' }, 'защищён'));
        if (sc && ACCESS_RU[sc.agentAccess]) scTags.push(h('span.k-badge', ACCESS_RU[sc.agentAccess]));

        const actions = h('div.kc-actions');
        const isBusy = busy.has(c.id);
        if (confirm && confirm.id === c.id) {
          const text = confirm.kind === 'remove'
            ? (n ? 'Закрыть ' + n + ' ' + U.plural(n, ['вкладку', 'вкладки', 'вкладок']) + ' и удалить контейнер с данными?' : 'Удалить контейнер вместе с cookies и данными сайтов?')
            : 'Удалить cookies, вход на сайты и кэш этого контейнера?';
          const yes = h('button.k-btn.k-btn-sm.k-btn-danger', { type: 'button' }, confirm.kind === 'remove' ? 'Удалить' : 'Очистить');
          const no = h('button.k-btn.k-btn-sm', { type: 'button' }, 'Отмена');
          const kind = confirm.kind;
          yes.addEventListener('click', () => run(c.id, kind));
          no.addEventListener('click', () => { confirm = null; render(); });
          actions.append(h('span.kc-confirm', text), no, yes);
        } else {
          // действия подписаны словами: значки «+», печенька и корзина без подписей были непонятны
          const tab = h('button.k-btn.k-btn-sm.k-btn-ghost', { type: 'button', title: 'Открыть новую вкладку в этом контейнере', disabled: isBusy }, U.icon('plus', 14), 'Новая вкладка');
          tab.addEventListener('click', () => api.invoke('kosmo:containers.newTab', { id: c.id }).catch((e) => api.toast(clean(e), { tone: 'danger' })));
          const data = h('button.k-btn.k-btn-sm.k-btn-ghost', { type: 'button', title: 'Пак, поля и правила контейнера, доступ агента', 'aria-expanded': scopeOpen === c.id ? 'true' : 'false', disabled: isBusy || !window.KContainerScope }, 'Данные…');
          data.addEventListener('click', () => { scopeOpen = scopeOpen === c.id ? null : c.id; openMenu = null; confirm = null; render(); });
          actions.appendChild(data);
          const clear = h('button.k-btn.k-btn-sm.k-btn-ghost', { type: 'button', title: 'Удалить cookies, вход на сайты и кэш этого контейнера', disabled: isBusy }, 'Очистить данные…');
          clear.addEventListener('click', () => { confirm = { id: c.id, kind: 'clear' }; openMenu = null; render(); });
          actions.append(tab, clear);
          if (c.temp) {
            const keepBtn = h('button.k-btn.k-btn-sm.k-btn-ghost', { type: 'button', title: 'Не удалять контейнер и вход при закрытии вкладок', disabled: isBusy }, 'Оставить');
            keepBtn.addEventListener('click', () => save(list().map((x) => { if (x.id !== c.id) return x; const o = Object.assign({}, x); delete o.temp; return o; })));
            actions.appendChild(keepBtn);
          }
          if (!isMain) {
            const del = h('button.k-btn.k-btn-sm.k-btn-ghost.kc-del', { type: 'button', title: 'Удалить контейнер вместе с его данными', disabled: isBusy }, 'Удалить…');
            del.addEventListener('click', () => { confirm = { id: c.id, kind: 'remove' }; openMenu = null; render(); });
            actions.appendChild(del);
          } else {
            // место под «Удалить…», чтобы кнопки строк стояли столбцами
            actions.appendChild(h('span.k-btn.k-btn-sm.k-btn-ghost.kc-del-gap', { 'aria-hidden': 'true' }, 'Удалить…'));
          }
        }
        const top = h('div.kc-row' + (isBusy ? '.busy' : ''), { dataset: { id: c.id } }, color, h('div.kc-main', name, h('div.kc-sub', meta, tags, scTags)), actions);
        const scopeEl = scopeOpen === c.id && window.KContainerScope
          ? window.KContainerScope.panel(c, api, { onClose: () => { scopeOpen = null; render(); }, onSaved: () => { loadScopes(); } })
          : null;
        return h('div.kc-item', top, openMenu === c.id ? swatches(c) : null, scopeEl);
      }

      let renderTimer = 0;
      function render() {
        if (renderTimer) return;
        renderTimer = setTimeout(() => {
          renderTimer = 0;
          if (editing && document.activeElement && document.activeElement.classList.contains('kc-name')) return;
          // открытую форму данных не перерисовываем, пока в ней фокус (печатают)
          if (scopeOpen && document.activeElement && document.activeElement.closest && document.activeElement.closest('.kcs')) return;
          U.clear(listEl);
          for (const c of list()) listEl.appendChild(row(c));
        }, 0);
      }

      function recount(tabs) {
        const next = {};
        for (const t of tabs || []) next[t.containerId || 'main'] = (next[t.containerId || 'main'] || 0) + 1;
        const changed = JSON.stringify(next) !== JSON.stringify(counts);
        counts = next;
        if (changed) render();
      }

      ui.watch('containers', () => { render(); loadScopes(); });
      U.on('kosmo:scopes.changed', () => loadScopes());
      U.on('kosmo:packs.changed', () => loadScopes());
      U.on('kosmo:tabs.state', (p) => recount(p && p.tabs));
      api.invoke('kosmo:tabs.list', {}).then((p) => recount(p && p.tabs)).catch(() => {});
      render();

      el.appendChild(ui.note('Удалённый контейнер забирает с собой свои cookies и данные сайтов; папка стирается полностью при следующем запуске.'));
    }
  });
})();
