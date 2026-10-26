// Владелец: ux-chrome. Раздел «Поиск»: поисковик по умолчанию, редактор бэнгов, проверка «как разберётся ввод».
'use strict';
(function () {
  const U = window.KUI;
  const { h } = U;
  U.css('sections/search.css');

  const ENGINES = [['google', 'Google'], ['yandex', 'Яндекс'], ['ddg', 'DuckDuckGo'], ['bing', 'Bing']];
  const KIND = { url: 'Адрес', search: 'Поиск', bang: 'Бэнг', internal: 'Страница Космолёта' };
  const EXAMPLES = ['gh electron', 'npm react', 'github.com', 'localhost:3000', 'как сварить борщ'];

  function clean(e) { return String((e && e.message) || e || '').replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '').replace(/^./, (c) => c.toUpperCase()); }

  // Проверка бэнга; others — остальные бэнги (для уникальности ключа). Возвращает текст ошибки или ''.
  function validate(b, others) {
    const key = String(b.key || '').trim().toLowerCase();
    if (!key) return 'Укажите ключ';
    if (/\s/.test(key)) return 'Ключ — одно слово без пробелов';
    if (key.length > 24) return 'Ключ длиннее 24 символов';
    if (others.some((o) => o.key === key)) return 'Бэнг «' + key + '» уже есть';
    const url = String(b.url || '').trim();
    if (!/^https?:\/\//i.test(url)) return 'Адрес должен начинаться с http:// или https://';
    if (!url.includes('{q}')) return 'В адресе нужен {q} — на его место встанет запрос';
    const num = String(b.numericUrl || '').trim();
    if (num && (!/^https?:\/\//i.test(num) || !num.includes('{q}'))) return 'Адрес для артикула: http(s) и {q}';
    return '';
  }

  KSettings.section({
    id: 'search', title: 'Поиск', icon: 'search', order: 30,
    keywords: 'поисковик бэнги google яндекс duckduckgo bing подсказки адресная строка',
    description: 'Куда уходит запрос из адресной строки и бэнги — короткие ключи для поиска по сайтам: «gh electron», «npm react». Паки добавляют свои бэнги — они ниже, в «Из паков».',
    render(el, api) {
      const ui = api.ui;

      // ---------- поисковик ----------
      el.appendChild(ui.group(null,
        ui.select('Поисковая система', 'search.engine', ENGINES, 'Если ввод не похож на адрес и не начинается с бэнга')));

      // ---------- проверка ввода ----------
      const input = h('input.k-input.ss-try-input', { type: 'text', spellcheck: 'false', placeholder: 'Например: gh electron', 'aria-label': 'Проверить ввод' });
      const result = h('div.ss-try-result');
      const chips = h('div.ss-try-chips', EXAMPLES.map((x) => {
        const b = h('button.k-btn.k-btn-sm.k-btn-ghost', { type: 'button' }, x);
        b.addEventListener('click', () => { input.value = x; check(); input.focus(); });
        return b;
      }));
      let seq = 0;
      function check() {
        const v = input.value.trim();
        const my = ++seq;
        if (!v) { U.clear(result).appendChild(h('span.k-faint', 'Введите текст — покажу, что откроется.')); return; }
        api.invoke('kosmo:search.resolve', { input: v }).then((r) => {
          if (my !== seq || !r) return;
          const label = KIND[r.kind] || r.kind;
          const extra = r.kind === 'bang' ? ' ' + r.bang + (r.query ? ' · запрос «' + r.query + '»' : ' · без запроса — главная сайта') : '';
          U.clear(result).append(
            h('span.k-badge' + (r.kind === 'bang' ? '.k-badge-accent' : r.kind === 'url' ? '.k-badge-ok' : ''), label + extra),
            h('span.ss-try-url.k-mono', { title: r.url }, r.url));
        }).catch((e) => { if (my === seq) U.clear(result).appendChild(h('span.ss-err', clean(e))); });
      }
      input.addEventListener('input', U.debounce(check, 120));
      check();
      // невидимые «якоря» для поиска по настройкам: группа без .ks-row иначе скрывается целиком
      const anchor = (text) => h('div.ks-row', { hidden: true, dataset: { search: text } });
      el.appendChild(ui.group('Как разберётся ввод',
        ui.free(h('div.ss-try', input, result, chips)),
        anchor('проверка как разберётся ввод адрес поиск бэнг')));

      // ---------- бэнги ----------
      const listBox = h('div.ss-bangs');
      const addBtn = h('button.k-btn.k-btn-sm.k-btn-primary', { type: 'button' }, U.icon('plus', 14), 'Добавить');
      const resetBtn = h('button.k-btn.k-btn-sm.k-btn-ghost', { type: 'button', title: 'Вернуть набор бэнгов по умолчанию' }, 'Вернуть стандартные');
      const head = h('div.ss-bangs-head',
        h('div.ss-bangs-hint', 'Введите ключ и пробел в адресной строке: ', h('span.k-kbd', 'gh'), ' ', h('span.k-faint', 'electron'), '. Если у бэнга есть адрес для артикула, одни цифры откроют товар.'),
        h('div.k-row', resetBtn, addBtn));
      const bangAnchor = anchor('бэнги');
      el.appendChild(ui.group('Бэнги', ui.free(head), ui.free(listBox), bangAnchor));
      // бэнги паков — нижний слой: свой бэнг с тем же ключом главнее; скрытый не работает, пока не вернёте
      const packBox = h('div.ss-bangs.ss-pack-bangs');
      const packAnchor = anchor('бэнги паков');
      const packGroup = ui.group('Из паков', ui.free(packBox), packAnchor);
      packGroup.hidden = true;
      el.appendChild(packGroup);
      let packItems = [];
      function loadPackBangs() {
        return api.invoke('kosmo:packs.layer', { type: 'bangs' }).then((r) => { packItems = (r && r.items) || []; renderPack(); }).catch(() => {});
      }
      function renderPack() {
        U.clear(packBox);
        packGroup.hidden = !packItems.length;
        const own = new Set(bangs().map((b) => b.key));
        packAnchor.dataset.search = ('бэнги паков ' + packItems.map((x) => x.key + ' ' + (x.value.name || '')).join(' ')).toLowerCase();
        for (const it of packItems) {
          const b = it.value;
          const over = own.has(b.key);
          const acts = h('div.ss-bang-acts');
          if (!over) {
            const edit = h('button.k-icon-btn', { type: 'button', title: 'Изменить (станет вашим бэнгом)', 'aria-label': 'Изменить', html: window.KIcons.get('pencil', 14) });
            edit.addEventListener('click', () => {
              const nb = { key: b.key, name: b.name, url: b.url };
              if (b.numericUrl) nb.numericUrl = b.numericUrl;
              if (b.short) nb.short = b.short;
              if (b.chip) nb.chip = true;
              save(bangs().concat(nb)).then(() => { editing = b.key; render(); renderPack(); }).catch(() => {});
            });
            const hide = h('button.k-btn.k-btn-sm.k-btn-ghost', { type: 'button', title: it.hidden ? 'Снова включить бэнг пака' : 'Не использовать этот бэнг пака' }, it.hidden ? 'Вернуть' : 'Скрыть');
            hide.addEventListener('click', () => api.invoke('kosmo:packs.hide', { type: 'bangs', key: b.key, hidden: !it.hidden }).then(loadPackBangs).catch((e) => U.toast(clean(e), { tone: 'danger' })));
            acts.append(edit, hide);
          }
          packBox.appendChild(h('div.ss-bang' + (it.hidden || over ? '.dim' : ''), { dataset: { key: b.key } },
            h('span.k-kbd.ss-key', b.key),
            h('div.ss-bang-text',
              h('div.ss-bang-name', b.name || b.key, h('span.k-badge.ss-num', { title: 'Бэнг из пака' }, 'пак «' + it.packName + '»'), over ? h('span.k-faint.ss-over', 'перекрыт вашим') : it.hidden ? h('span.k-faint.ss-over', 'скрыт') : null),
              h('div.ss-bang-url.k-mono', { title: b.url }, b.url)),
            acts));
        }
      }
      U.on('kosmo:packs.changed', loadPackBangs);
      loadPackBangs();

      let editing = null; // key | '+new'
      const bangs = () => (Array.isArray(api.get('search.bangs')) ? api.get('search.bangs') : []);

      function save(list) { return api.set('search.bangs', list).then(() => { editing = null; render(); }); }

      function form(b, idx) {
        const isNew = idx < 0;
        const f = {
          key: h('input.k-input.k-mono', { type: 'text', value: b.key || '', placeholder: 'gh', spellcheck: 'false', 'aria-label': 'Ключ' }),
          name: h('input.k-input', { type: 'text', value: b.name || '', placeholder: 'GitHub', spellcheck: 'false', 'aria-label': 'Название' }),
          url: h('input.k-input.k-mono', { type: 'text', value: b.url || '', placeholder: 'https://example.com/search?q={q}', spellcheck: 'false', 'aria-label': 'Адрес поиска' }),
          numericUrl: h('input.k-input.k-mono', { type: 'text', value: b.numericUrl || '', placeholder: 'необязательно: https://example.com/item/{q}', spellcheck: 'false', 'aria-label': 'Адрес для артикула' }),
        };
        const err = h('div.ss-err', { hidden: true });
        const ok = h('button.k-btn.k-btn-sm.k-btn-primary', { type: 'button' }, isNew ? 'Добавить' : 'Сохранить');
        const cancel = h('button.k-btn.k-btn-sm', { type: 'button' }, 'Отмена');
        const submit = () => {
          const nb = { key: f.key.value.trim().toLowerCase().replace(/^!/, ''), name: f.name.value.trim(), url: f.url.value.trim() };
          if (f.numericUrl.value.trim()) nb.numericUrl = f.numericUrl.value.trim();
          if (!nb.name) nb.name = nb.key;
          const all = bangs();
          const others = all.filter((_, i) => i !== idx);
          const msg = validate(nb, others);
          if (msg) { err.textContent = msg; err.hidden = false; return; }
          const list = all.slice();
          if (isNew) list.push(nb); else list[idx] = nb;
          ok.disabled = true;
          save(list).catch((e) => { ok.disabled = false; err.textContent = clean(e); err.hidden = false; });
        };
        ok.addEventListener('click', submit);
        cancel.addEventListener('click', () => { editing = null; render(); });
        const box = h('div.ss-form',
          h('div.ss-form-grid',
            h('label.ss-field', h('span', 'Ключ'), f.key),
            h('label.ss-field', h('span', 'Название'), f.name),
            h('label.ss-field.wide', h('span', 'Адрес поиска, {q} — запрос'), f.url),
            h('label.ss-field.wide', h('span', 'Адрес для артикула (если ввели только цифры)'), f.numericUrl)),
          err,
          h('div.ss-form-foot', cancel, ok));
        box.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); submit(); }
          else if (e.key === 'Escape') { e.preventDefault(); editing = null; render(); }
        });
        setTimeout(() => (isNew ? f.key : f.name).focus(), 0);
        return box;
      }

      function rowEl(b, idx) {
        const edit = h('button.k-icon-btn', { type: 'button', title: 'Изменить', 'aria-label': 'Изменить', html: window.KIcons.get('pencil', 14) });
        const del = h('button.k-icon-btn', { type: 'button', title: 'Удалить', 'aria-label': 'Удалить', html: window.KIcons.get('trash', 14) });
        edit.addEventListener('click', () => { editing = b.key; render(); });
        del.addEventListener('click', () => {
          const list = bangs().filter((_, i) => i !== idx);
          save(list).then(() => U.toast('Бэнг «' + b.key + '» удалён')).catch(() => {});
        });
        return h('div.ss-bang', { dataset: { key: b.key } },
          h('span.k-kbd.ss-key', b.key),
          h('div.ss-bang-text',
            h('div.ss-bang-name', b.name || b.key, b.numericUrl ? h('span.k-badge.ss-num', { title: 'Одни цифры откроют товар: ' + b.numericUrl }, 'артикул') : null),
            h('div.ss-bang-url.k-mono', { title: b.url }, b.url)),
          h('div.ss-bang-acts', edit, del));
      }

      function render() {
        U.clear(listBox);
        const list = bangs();
        bangAnchor.dataset.search = ('бэнги ' + list.map((b) => b.key + ' ' + (b.name || '')).join(' ')).toLowerCase();
        if (editing === '+new') listBox.appendChild(form({}, -1));
        if (!list.length && editing !== '+new') {
          listBox.appendChild(U.empty({ icon: 'search', title: 'Бэнгов нет', text: 'Добавьте свой или верните стандартный набор.' }));
          return;
        }
        list.forEach((b, i) => listBox.appendChild(editing === b.key ? form(b, i) : rowEl(b, i)));
      }

      addBtn.addEventListener('click', () => { editing = '+new'; render(); });
      resetBtn.addEventListener('click', () => {
        api.invoke('kosmo:ux.defaultBangs', {}).then((def) => {
          if (!Array.isArray(def)) return;
          // свои бэнги с новыми ключами сохраняем, стандартные — как по умолчанию
          const keys = new Set(def.map((b) => b.key));
          const own = bangs().filter((b) => !keys.has(b.key));
          return save(def.concat(own)).then(() => U.toast('Стандартные бэнги восстановлены'));
        }).catch((e) => U.toast(clean(e), { tone: 'danger' }));
      });
      ui.watch('search.bangs', () => { if (!editing) render(); renderPack(); });
    },
  });
})();
