// Владелец: packs. Панель «Данные контейнера» в разделе «Контейнеры»: пак схемы, поля и правила по scopeSchema пака
// (форма строится по схеме: string / number / boolean / enum, обязательные поля), доступ агента, защита, марка, метки.
// window.KContainerScope.panel(container, api, {onClose}) → элемент. Данные — kosmo:scopes.* (store scopes.json).
'use strict';
(function () {
  const U = window.KUI;
  const { h } = U;
  U.css('sections/container-scope.css');

  const ACCESS = [
    ['', 'По умолчанию'], ['off', 'Выкл'], ['read', 'Чтение'], ['ops', 'Операции'], ['full', 'Полный'],
  ];
  const ACCESS_HINT = {
    off: 'Агент не видит вкладки этого контейнера.',
    read: 'Агент читает: снимок, скриншот, сеть, переходы по адресу и GET-запросы. Кликать, вводить и выполнять JS не может.',
    ops: 'Как «Чтение», а изменения — только через операции паков с вашим утверждением.',
    full: 'Агент может всё, что разрешает общий режим Claude.',
  };
  const clean = (e) => String((e && e.message) || e || '').replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '').replace(/^./, (c) => c.toUpperCase());

  let schemasCache = null;
  function schemas(api) {
    if (!schemasCache) schemasCache = api.invoke('kosmo:scopes.schemas', {}).catch(() => []);
    return schemasCache;
  }
  U.on('kosmo:packs.changed', () => { schemasCache = null; });

  // Поле формы по описанию схемы. → {el, get()}
  function fieldInput(name, f, value) {
    let input;
    if (f.enum) {
      input = h('select.k-select', { 'aria-label': f.title },
        h('option', { value: '' }, '—'),
        f.enum.map((v, i) => h('option', { value: String(i) }, f.enumTitles ? f.enumTitles[i] : String(v))));
      const idx = f.enum.indexOf(value);
      input.value = idx >= 0 ? String(idx) : '';
      return { el: input, get: () => (input.value === '' ? null : f.enum[Number(input.value)]) };
    }
    if (f.type === 'boolean') {
      input = h('input.k-switch', { type: 'checkbox', 'aria-label': f.title });
      input.checked = value === true;
      return { el: input, get: () => input.checked };
    }
    input = h('input.k-input', { type: f.type === 'number' ? 'number' : (f.secret ? 'password' : 'text'), spellcheck: 'false', 'aria-label': f.title, value: value == null ? '' : String(value) });
    if (f.type === 'number') { if (f.minimum != null) input.min = f.minimum; if (f.maximum != null) input.max = f.maximum; input.step = 'any'; }
    if (f.maxLength) input.maxLength = f.maxLength;
    return { el: input, get: () => (input.value.trim() === '' ? null : (f.type === 'number' ? Number(input.value) : input.value)) };
  }

  function formFor(part, values, required) {
    const props = (part && part.properties) || {};
    const getters = {};
    const rows = [];
    for (const [name, f] of Object.entries(props)) {
      const fi = fieldInput(name, f, values ? values[name] : undefined);
      getters[name] = fi.get;
      const req = (required || []).includes(name);
      rows.push(h('label.kcs-field' + (f.type === 'boolean' ? '.inline' : ''), { dataset: { field: name } },
        h('span.kcs-flabel', f.title, req ? h('span.kcs-req', { title: 'Обязательное поле' }, ' *') : null),
        fi.el,
        f.description ? h('span.kcs-fhint', f.description) : null));
    }
    return { rows, read() { const o = {}; for (const [k, g] of Object.entries(getters)) { const v = g(); if (v !== null && v !== undefined) o[k] = v; } return o; } };
  }

  function panel(container, api, opts) {
    opts = opts || {};
    const box = h('div.kcs');
    const body = h('div.kcs-body', h('div.kcs-loading.k-faint', 'Загружаю…'));
    box.appendChild(body);

    Promise.all([api.invoke('kosmo:scopes.get', { id: container.id }), schemas(api)]).then(([scope, list]) => build(scope, list || [])).catch((e) => {
      U.clear(body).appendChild(h('div.kcs-err', clean(e)));
    });

    function build(scope, list) {
      U.clear(body);
      let packId = scope.pack || '';
      const packSel = h('select.k-select', { 'aria-label': 'Пак' }, h('option', { value: '' }, 'Без пака'),
        list.map((s) => h('option', { value: s.pack }, s.name + (s.schema && s.schema.title ? ' — ' + s.schema.title : ''))));
      if (scope.pack && !list.some((s) => s.pack === scope.pack)) packSel.appendChild(h('option', { value: scope.pack }, scope.pack + ' (пак не установлен)'));
      packSel.value = packId;
      const fieldsBox = h('div.kcs-grid');
      const rulesBox = h('div.kcs-grid');
      const rulesWrap = h('div.kcs-section', h('div.kcs-sub', 'Правила'), rulesBox);
      let fForm = null; let rForm = null;
      function paintForms() {
        const s = list.find((x) => x.pack === packId);
        const schema = s ? s.schema : null;
        U.clear(fieldsBox); U.clear(rulesBox);
        if (!packId) { fieldsBox.appendChild(h('div.k-faint.kcs-note', 'Выберите пак со схемой — появятся поля контейнера (клиент, кабинет, правила).')); fForm = null; rForm = null; rulesWrap.hidden = true; return; }
        if (!schema) { fieldsBox.appendChild(h('div.k-faint.kcs-note', 'Пак не установлен или выключен: поля сохранены, но не проверяются.')); fForm = null; rForm = null; rulesWrap.hidden = true; return; }
        const same = packId === scope.pack;
        fForm = formFor(schema, same ? scope.fields : {}, schema.required);
        fForm.rows.forEach((r) => fieldsBox.appendChild(r));
        const rp = schema.rules || {};
        rForm = Object.keys(rp.properties || {}).length ? formFor(rp, same ? scope.rules : {}, rp.required) : null;
        if (rForm) rForm.rows.forEach((r) => rulesBox.appendChild(r));
        rulesWrap.hidden = !rForm;
      }
      packSel.addEventListener('change', () => { packId = packSel.value; paintForms(); });

      // доступ агента
      let access = scope.agentAccessRaw || '';
      const seg = h('div.k-seg', { role: 'radiogroup', 'aria-label': 'Доступ агента' });
      const accHint = h('div.kcs-fhint');
      const segBtns = ACCESS.map(([v, label]) => {
        const b = h('button', { type: 'button', role: 'radio' }, label);
        b.addEventListener('click', () => { access = v; paintAccess(); });
        seg.appendChild(b);
        return b;
      });
      const protect = h('input.k-switch', { type: 'checkbox', 'aria-label': 'Защищённый контейнер' });
      let protectRaw = scope.protectRaw;
      protect.checked = !!scope.protect;
      protect.addEventListener('change', () => { protectRaw = protect.checked; paintAccess(); });
      function paintAccess() {
        segBtns.forEach((b, i) => { const on = ACCESS[i][0] === access; b.classList.toggle('active', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); });
        const effProtect = protectRaw == null ? scope.protect : protectRaw;
        const eff = access || (effProtect ? 'ops' : 'full');
        accHint.textContent = (access ? '' : 'Сейчас: ' + ACCESS.find((x) => x[0] === eff)[1].toLowerCase() + '. ') + ACCESS_HINT[eff];
      }
      paintAccess();

      const mark = h('input.k-input.kcs-mark', { type: 'text', maxLength: 2, spellcheck: 'false', value: scope.mark || '', placeholder: 'АБ', 'aria-label': 'Марка — 1–2 буквы' });
      const labels = h('input.k-input', { type: 'text', spellcheck: 'false', value: (scope.labels || []).join(', '), placeholder: 'через запятую', 'aria-label': 'Метки' });
      const err = h('div.kcs-err', { hidden: true });
      const save = h('button.k-btn.k-btn-sm.k-btn-primary', { type: 'button' }, 'Сохранить');
      const close = h('button.k-btn.k-btn-sm', { type: 'button' }, 'Закрыть');
      const clear = h('button.k-btn.k-btn-sm.k-btn-ghost', { type: 'button', title: 'Удалить все данные контейнера (поля, правила, доступ агента)' }, 'Очистить данные');

      save.addEventListener('click', () => {
        err.hidden = true;
        body.querySelectorAll('.kcs-field.bad').forEach((x) => x.classList.remove('bad'));
        const patch = {
          pack: packId || null,
          agentAccess: access || null,
          protect: protectRaw == null ? null : protectRaw,
          mark: mark.value.trim() || null,
          labels: labels.value.split(',').map((x) => x.trim()).filter(Boolean),
        };
        if (fForm) patch.fields = fForm.read();
        if (rForm) patch.rules = rForm.read();
        patch.replace = true;
        save.disabled = true;
        api.invoke('kosmo:scopes.patch', { id: container.id, patch }).then(() => {
          api.toast('Данные контейнера «' + container.name + '» сохранены');
          if (opts.onSaved) opts.onSaved();
        }).catch((e) => {
          err.textContent = clean(e);
          err.hidden = false;
          for (const m of String(e && e.message || '').matchAll(/«([^»]+)»/g)) {
            const f = Array.from(body.querySelectorAll('.kcs-field')).find((x) => x.querySelector('.kcs-flabel') && x.querySelector('.kcs-flabel').textContent.replace(/\s*\*$/, '') === m[1]);
            if (f) f.classList.add('bad');
          }
        }).finally(() => { save.disabled = false; });
      });
      close.addEventListener('click', () => { if (opts.onClose) opts.onClose(); });
      clear.addEventListener('click', () => {
        if (clear.dataset.confirm !== '1') { clear.dataset.confirm = '1'; clear.textContent = 'Точно очистить?'; setTimeout(() => { clear.dataset.confirm = ''; clear.textContent = 'Очистить данные'; }, 2500); return; }
        api.invoke('kosmo:scopes.set', { id: container.id, scope: null }).then(() => { api.toast('Данные контейнера очищены'); if (opts.onSaved) opts.onSaved(); }).catch((e) => api.toast(clean(e), { tone: 'danger' }));
      });

      body.append(
        h('div.kcs-section',
          h('label.kcs-field', h('span.kcs-flabel', 'Пак контейнера'), packSel, h('span.kcs-fhint', 'Пак описывает, какие поля и правила есть у контейнера, и рисует по ним чип в адресной строке.')),
          fieldsBox),
        rulesWrap,
        h('div.kcs-section',
          h('div.kcs-sub', 'Агент'),
          h('div.kcs-field', h('span.kcs-flabel', 'Доступ агента'), seg, accHint),
          h('label.kcs-field.inline', h('span.kcs-flabel', 'Защищённый контейнер'), protect, h('span.kcs-fhint', 'Агент по умолчанию пишет только через операции; значения заголовков авторизации и HttpOnly-cookie ему не показываются.'))),
        h('div.kcs-section.kcs-row2',
          h('label.kcs-field', h('span.kcs-flabel', 'Марка'), mark),
          h('label.kcs-field.grow', h('span.kcs-flabel', 'Метки'), labels)),
        err,
        h('div.kcs-foot', clear, h('span.k-grow'), close, save));
      paintForms();
      if (!scope.packInstalled && scope.pack) body.prepend(h('div.kcs-warn', 'Пак «' + scope.pack + '» не установлен — данные сохранены, но не проверяются.'));
    }
    return box;
  }

  window.KContainerScope = { panel };
})();
