// Владелец: themes. Раздел «Темы сайтов»: режим тёмной темы, параметры по умолчанию, prefers-color-scheme,
// список сайтов (включить/выключить, свой CSS, сброс, удаление, добавление).
'use strict';
(function () {
  const U = window.KUI;
  const { h } = U;
  U.css('sections/site-themes.css');
  const HEX = /^#[0-9a-f]{6}$/i;
  const SLIDERS = [
    { key: 'brightness', label: 'Яркость', min: 50, max: 150 },
    { key: 'contrast', label: 'Контраст', min: 50, max: 150 },
    { key: 'sepia', label: 'Сепия', min: 0, max: 100 },
    { key: 'grayscale', label: 'Оттенки серого', min: 0, max: 100 }
  ];
  const errText = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');

  function range(label, path, o, api) {
    const input = h('input.kst-range', { type: 'range', min: o.min, max: o.max, step: 1, 'aria-label': label });
    const val = h('span.kst-val');
    const paint = () => input.style.setProperty('--p', ((input.value - o.min) / (o.max - o.min) * 100) + '%');
    let dragging = false;
    const save = U.debounce(() => api.set(path, Number(input.value)).catch(() => {}), 250);
    input.addEventListener('pointerdown', () => { dragging = true; });
    input.addEventListener('input', () => { val.textContent = input.value + '%'; paint(); save(); });
    input.addEventListener('change', () => { dragging = false; save.flush(); });
    api.ui.watch(path, (v) => {
      if (dragging) return;
      const n = Number(v);
      input.value = String(isFinite(n) ? n : o.min);
      val.textContent = input.value + '%';
      paint();
    });
    return api.ui.row(label, h('div.kst-range-box', input, val), o.hint);
  }

  KSettings.section({
    id: 'site-themes', title: 'Темы сайтов', icon: 'moon', order: 20,
    keywords: 'тёмная тема сайтов dark reader css яркость контраст сепия фильтр prefers-color-scheme wildberries',
    description: 'Тёмная тема для любого сайта — даже для тех, где своей нет. Быстро: луна в адресной строке или Alt+Shift+D.',
    render(el, api) {
      const ui = api.ui;

      // ---------- режим ----------
      const modeGroup = ui.group(null,
        ui.segmented('Тёмная тема', 'siteThemes.mode', [['off', 'Выключена'], ['list', 'Выбранные сайты'], ['all', 'Все сайты']],
          '«Все сайты» — кроме тех, где вы её выключили'),
        ui.segmented('Тема для самих сайтов', 'siteThemes.colorScheme', [['system', 'Как в Windows'], ['dark', 'Тёмная'], ['light', 'Светлая']],
          'Что сайты видят в prefers-color-scheme. GitHub, MDN, YouTube и многие другие переключаются сами — им Dark Reader не нужен'));

      // ---------- параметры по умолчанию ----------
      const defGroup = ui.group('Параметры по умолчанию');
      defGroup.appendChild(ui.segmented('Движок', 'siteThemes.defaults.engine', [['dynamic', 'Точный'], ['filter', 'Быстрый']],
        'Точный (Dark Reader) пересчитывает цвета сайта, но на тяжёлых сайтах замедляет загрузку. Быстрый инвертирует страницу целиком: почти бесплатно, но грубее'));
      for (const s of SLIDERS) defGroup.appendChild(range(s.label, 'siteThemes.defaults.' + s.key, s, api));

      // цвета страниц: '' — в тон теме интерфейса
      const autoSw = h('input.k-switch', { type: 'checkbox', 'aria-label': 'Цвета в тон интерфейсу' });
      const bgIn = h('input.k-input', { type: 'color', 'aria-label': 'Фон страниц' });
      const textIn = h('input.k-input', { type: 'color', 'aria-label': 'Текст страниц' });
      const sample = h('div.kst-sample', h('b', 'Аа'), ' Пример текста на тёмном фоне');
      const colorsRow = ui.row('Свои цвета', h('div.kst-colors', h('span.kst-cl', 'фон'), bgIn, h('span.kst-cl', 'текст'), textIn), 'Фон и текст, к которым Dark Reader приводит страницы');
      defGroup.appendChild(ui.row('Цвета в тон интерфейсу', autoSw, 'Фон страниц подбирается под тему браузера'));
      defGroup.appendChild(colorsRow);
      defGroup.appendChild(ui.free(sample));
      let auto = { bg: '#171b28', text: '#e3e6f0' };
      function refreshColors() {
        const d = api.get('siteThemes.defaults') || {};
        const isAuto = !HEX.test(d.bg || '') && !HEX.test(d.text || '');
        autoSw.checked = isAuto;
        colorsRow.hidden = isAuto;
        const bg = HEX.test(d.bg || '') ? d.bg : auto.bg;
        const tx = HEX.test(d.text || '') ? d.text : auto.text;
        bgIn.value = bg; textIn.value = tx;
        sample.style.background = bg; sample.style.color = tx;
      }
      function loadAuto() { return api.invoke('kosmo:themes.autoColors', {}).then((c) => { if (c) auto = c; refreshColors(); }).catch(() => refreshColors()); }
      autoSw.addEventListener('change', () => {
        if (autoSw.checked) api.patch({ siteThemes: { defaults: { bg: '', text: '' } } }).catch(() => {});
        else api.patch({ siteThemes: { defaults: { bg: auto.bg, text: auto.text } } }).catch(() => {});
      });
      bgIn.addEventListener('input', () => { sample.style.background = bgIn.value; });
      textIn.addEventListener('input', () => { sample.style.color = textIn.value; });
      bgIn.addEventListener('change', () => api.set('siteThemes.defaults.bg', bgIn.value).catch(() => {}));
      textIn.addEventListener('change', () => api.set('siteThemes.defaults.text', textIn.value).catch(() => {}));
      ui.watch('siteThemes.defaults', refreshColors);
      ui.watch('ui.theme', loadAuto);
      ui.watch('ui.custom', loadAuto);

      // ---------- сайты ----------
      const addIn = h('input.k-input.kst-add-in', { type: 'text', spellcheck: 'false', placeholder: 'например, ozon.ru', 'aria-label': 'Адрес сайта' });
      const addBtn = h('button.k-btn.k-btn-primary', { type: 'button' }, U.icon('plus', 14), 'Добавить');
      const add = () => {
        const v = addIn.value.trim();
        if (!v) { addIn.focus(); return; }
        api.invoke('kosmo:themes.toggleSite', { key: v, value: true })
          .then((s) => { addIn.value = ''; api.toast('Тёмная тема на ' + s.key + ' включена'); })
          .catch((e) => api.toast(errText(e), { tone: 'danger' }));
      };
      addBtn.addEventListener('click', add);
      addIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
      const list = h('div.kst-sites');
      const sitesGroup = ui.group('Сайты',
        ui.row('Добавить сайт', h('div.kst-add', addIn, addBtn), 'Поддомены наследуют настройки: seller.wildberries.ru берёт их у wildberries.ru'));
      sitesGroup.appendChild(ui.free(list));
      const open = new Set(); // ключи с открытым редактором CSS
      const editors = new Map();

      function siteRow(key, e, mode) {
        e = e && typeof e === 'object' ? e : {};
        const dark = mode === 'off' ? false : mode === 'all' ? e.enabled !== false : e.enabled === true;
        const sw = h('input.k-switch', { type: 'checkbox', 'aria-label': 'Тёмная тема на ' + key });
        sw.checked = dark;
        sw.disabled = mode === 'off';
        sw.addEventListener('change', () => api.invoke('kosmo:themes.toggleSite', { key, value: sw.checked }).catch((er) => api.toast(errText(er), { tone: 'danger' })));
        const params = ['engine', 'brightness', 'contrast', 'sepia', 'grayscale', 'bg', 'text'].filter((k) => e[k] != null && e[k] !== '');
        const desc = [];
        if (e.engine === 'filter') desc.push('фильтр');
        if (e.brightness != null) desc.push('яркость ' + e.brightness + '%');
        if (e.contrast != null) desc.push('контраст ' + e.contrast + '%');
        if (e.sepia) desc.push('сепия ' + e.sepia + '%');
        if (e.grayscale) desc.push('серый ' + e.grayscale + '%');
        if (e.bg || e.text) desc.push('свои цвета');
        const cssLen = typeof e.css === 'string' ? e.css.length : 0;
        const cssBtn = h('button.k-btn.k-btn-sm' + (cssLen ? '' : '.k-btn-ghost'), { type: 'button', 'aria-expanded': open.has(key) ? 'true' : 'false' },
          U.icon('braces', 14), cssLen ? 'CSS' : 'Добавить CSS');
        const reset = h('button.k-icon-btn.k-icon-btn-sm', { type: 'button', title: 'Сбросить параметры (оставить включение и CSS)', disabled: !params.length }, U.icon('rotate-cw', 14));
        reset.addEventListener('click', () => api.invoke('kosmo:themes.resetSite', { key }).catch((er) => api.toast(errText(er), { tone: 'danger' })));
        const del = h('button.k-icon-btn.k-icon-btn-sm.kst-del', { type: 'button', title: 'Удалить настройки сайта' }, U.icon('trash', 14));
        del.addEventListener('click', () => {
          if (del.dataset.confirm !== '1') {
            del.dataset.confirm = '1'; del.classList.add('confirm'); del.title = 'Нажмите ещё раз, чтобы удалить';
            setTimeout(() => { del.dataset.confirm = ''; del.classList.remove('confirm'); del.title = 'Удалить настройки сайта'; }, 2500);
            return;
          }
          open.delete(key);
          api.invoke('kosmo:themes.removeSite', { key }).then(() => api.toast('Настройки ' + key + ' удалены')).catch((er) => api.toast(errText(er), { tone: 'danger' }));
        });
        const row = h('div.kst-site',
          h('div.kst-site-main',
            h('div.kst-site-text', h('div.kst-site-key.k-ellipsis', key), h('div.kst-site-desc.k-ellipsis', desc.length ? desc.join(' · ') : (dark ? 'тёмная тема' : 'без тёмной темы'))),
            cssBtn, reset, del, sw));
        // редактор CSS — по кнопке
        let ed = editors.get(key);
        if (!ed) {
          const ta = h('textarea.k-textarea.kst-css', { spellcheck: 'false', wrap: 'off', placeholder: '/* CSS для ' + key + ' — применяется всегда, сразу */', 'aria-label': 'CSS для ' + key });
          const state = h('span.kst-css-state');
          const save = U.debounce(() => {
            const css = ta.value;
            state.textContent = 'применяю…';
            api.invoke('kosmo:themes.setSite', { key, patch: { css } })
              .then(() => { if (ta.value === css) ed.dirty = false; state.textContent = 'применён'; state.dataset.kind = 'ok'; })
              .catch((er) => { state.textContent = errText(er); state.dataset.kind = 'error'; });
          }, 300);
          ta.addEventListener('input', () => { ed.dirty = true; state.textContent = 'изменён'; state.dataset.kind = ''; save(); });
          ta.addEventListener('keydown', (ev) => { if (ev.key === 'Tab' && !ev.ctrlKey && !ev.altKey && !ev.shiftKey) { ev.preventDefault(); document.execCommand('insertText', false, '  '); } });
          ed = { box: h('div.kst-css-box', ta, h('div.kst-css-foot', state, h('span.k-grow'), h('span.k-faint.k-xs', 'Tab — отступ, сохраняется само'))), ta, dirty: false };
          editors.set(key, ed);
        }
        // то, что пользователь печатает, не перетираем ответом настроек
        if (!ed.dirty && key !== focusedKey) ed.ta.value = e.css || '';
        ed.box.hidden = !open.has(key);
        row.appendChild(ed.box);
        cssBtn.addEventListener('click', () => {
          if (open.has(key)) open.delete(key); else open.add(key);
          ed.box.hidden = !open.has(key);
          cssBtn.setAttribute('aria-expanded', open.has(key) ? 'true' : 'false');
          if (open.has(key)) ed.ta.focus();
        });
        return row;
      }

      let focusedKey = null;
      function renderSites() {
        const sites = api.get('siteThemes.sites') || {};
        const mode = api.get('siteThemes.mode') || 'list';
        const keys = Object.keys(sites).sort();
        // редактор в фокусе после перерисовки возвращаем в фокус (с тем же выделением)
        const focused = keys.find((k) => editors.get(k) && document.activeElement === editors.get(k).ta) || null;
        const sel = focused ? [editors.get(focused).ta.selectionStart, editors.get(focused).ta.selectionEnd, editors.get(focused).ta.scrollTop] : null;
        focusedKey = focused;
        for (const k of Array.from(editors.keys())) if (!(k in sites)) editors.delete(k);
        U.clear(list);
        if (!keys.length) {
          list.appendChild(api.empty({ icon: 'moon', title: 'Сайтов пока нет', text: 'Включите тёмную тему луной в адресной строке или добавьте адрес выше.' }));
          return;
        }
        for (const k of keys) {
          const r = siteRow(k, sites[k], mode);
          r.dataset.key = k;
          list.appendChild(r);
        }
        if (focused && editors.get(focused)) {
          const ta = editors.get(focused).ta;
          ta.focus({ preventScroll: true });
          ta.setSelectionRange(sel[0], sel[1]);
          ta.scrollTop = sel[2];
        }
        focusedKey = null;
      }
      ui.watch('siteThemes.sites', renderSites);
      ui.watch('siteThemes.mode', renderSites);

      el.append(modeGroup, defGroup, sitesGroup);
      loadAuto();
    }
  });
})();
