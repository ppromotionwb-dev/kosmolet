// Владелец: tools-pack. Инструмент панели «Сниппеты»: свои скрипты + встроенная библиотека, редактор
// (Tab — отступ, Ctrl+Enter — выполнить, Ctrl+S — сохранить, Ctrl+/ — комментарий), вывод (дерево JSON, таблица,
// ошибка со стеком, консоль), автозапуск по сайту и список сработавших автосниппетов на вкладке.
'use strict';
(function () {
  const U = window.KUI;
  const { h } = U;
  U.css('tools/snippets.css');

  const WORLDS = [
    { id: 'isolated', label: 'Изолированный', hint: 'Свой мир: DOM страницы общий, а переменные сайта не видны и не мешают' },
    { id: 'page', label: 'Страница', hint: 'Мир страницы: доступны переменные сайта (window.jQuery, __NEXT_DATA__ и т.п.)' }
  ];
  const NEW_CODE = '// Код выполняется в активной вкладке. Работают await и return.\n// Ctrl+Enter — выполнить, Ctrl+S — сохранить.\nreturn document.title;\n';
  const ROW_LIMIT = 1000;
  const LS = 'kosmo.snippets.';
  const errText = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
  const lsGet = (k, d) => { try { const v = localStorage.getItem(LS + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch (e) { /* нет места */ } };
  const hostOf = (u) => {
    try {
      const x = new URL(u);
      if (x.protocol === 'file:') return decodeURIComponent(x.pathname.split('/').pop() || 'файл');
      return x.hostname || u;
    } catch (e) { return u || ''; }
  };
  const isWeb = (u) => /^(https?|file):/i.test(String(u || ''));
  const worldLabel = (w) => (w === 'page' ? 'мир страницы' : 'изолированный');

  function dot(status) { return h('span.tp-dot', { dataset: { s: status } }); }

  // ---------- таблица → CSV / TSV ----------
  const cellText = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  function toTsv(cols, rows) {
    const esc = (s) => cellText(s).replace(/[\t\r\n]+/g, ' ');
    return [cols.map(esc).join('\t')].concat(rows.map((r) => r.map(esc).join('\t'))).join('\n');
  }
  function toCsv(cols, rows) {
    const esc = (s) => { const t = cellText(s); return /[",\n\r;]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
    return [cols.map(esc).join(',')].concat(rows.map((r) => r.map(esc).join(','))).join('\r\n');
  }

  // ---------- простое дерево JSON (если devtools-common не загружен) ----------
  function fallbackTree(value) {
    return h('pre.tp-pre', JSON.stringify(value, null, 2));
  }

  KPanel.register({
    id: 'snippets', title: 'Сниппеты', icon: 'file-code', order: 70,
    mount(el, api) {
      el.classList.add('tp-snip');
      const st = {
        items: [], builtins: [], loaded: false, error: null,
        view: 'list', cur: null, dirty: false, running: false, result: null,
        q: '', auto: { tabId: null, url: '', entries: [] }, seq: 0,
      };

      // =========================== список ===========================
      const search = h('input.k-input.k-input-sm', { type: 'search', placeholder: 'Найти сниппет', spellcheck: 'false', 'aria-label': 'Найти сниппет' });
      const newBtn = h('button.k-btn.k-btn-sm.k-btn-primary', { type: 'button', title: 'Новый сниппет' }, U.icon('plus', 14), 'Новый');
      const listScroll = h('div.tp-scroll');
      const listView = h('div.tp-view.tp-list-view',
        h('div.tp-toolbar', h('label.k-search.tp-search', U.icon('search', 14), search), newBtn),
        listScroll);

      search.addEventListener('input', () => { st.q = search.value.trim().toLowerCase(); renderList(); });
      search.addEventListener('keydown', (e) => { if (e.key === 'Escape' && search.value) { search.value = ''; st.q = ''; renderList(); e.stopPropagation(); } });
      newBtn.addEventListener('click', () => createNew());

      function match(s) {
        if (!st.q) return true;
        return (s.name + ' ' + (s.desc || '') + ' ' + (s.match || '')).toLowerCase().includes(st.q);
      }

      function runBtn(onClick, title) {
        const b = h('button.k-icon-btn.k-icon-btn-sm.tp-row-act', { type: 'button', title: title || 'Выполнить на активной вкладке', html: window.KIcons.get('play', 14) });
        b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
        return b;
      }

      function snippetRow(s, builtin) {
        const subParts = [];
        if (builtin) { if (s.packName) subParts.push('пак «' + s.packName + '»'); subParts.push(s.desc || ''); }
        else {
          subParts.push(worldLabel(s.world));
          if (s.auto) subParts.push(s.match ? 'авто: ' + s.match : 'авто: сайт не задан');
        }
        const acts = h('span.tp-row-acts');
        acts.appendChild(runBtn(() => runSnippet(s)));
        if (builtin) {
          const cp = h('button.k-icon-btn.k-icon-btn-sm.tp-row-act', { type: 'button', title: 'Копировать в мои', html: window.KIcons.get('copy-plus', 14) });
          cp.addEventListener('click', (e) => { e.stopPropagation(); copyToMine(s); });
          acts.appendChild(cp);
        }
        const row = h('div.k-list-item.tp-row', { tabindex: '0', role: 'button', dataset: { id: s.id } },
          U.icon(builtin ? 'file-code' : s.auto ? 'zap' : 'file-code', 16),
          h('div.k-li-body', h('div.k-li-title', s.name), h('div.k-li-sub', subParts.filter(Boolean).join(' · '))),
          !builtin && s.auto ? h('span.k-badge.k-badge-accent.tp-auto-badge', 'авто') : null,
          acts);
        row.addEventListener('click', () => openEditor(s));
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (e.ctrlKey) runSnippet(s); else openEditor(s); } });
        return row;
      }

      function autoBlock() {
        const a = st.auto;
        const tab = api.activeTab();
        if (!a.entries.length || !tab || a.tabId !== tab.id) return null;
        const box = h('section.tp-sec.tp-auto-sec',
          h('div.tp-sec-head', h('span.k-label', 'Сработали на этой вкладке'), h('span.tp-sec-meta', hostOf(a.url))));
        a.entries.forEach((e, i) => {
          const row = h('div.k-list-item.tp-row.tp-auto-row', { tabindex: '0', role: 'button', title: 'Показать результат' },
            dot(e.ok ? 'ok' : 'bad'),
            h('div.k-li-body', h('div.k-li-title', e.name), h('div.k-li-sub', e.summary || (e.ok ? 'готово' : 'ошибка'))),
            h('span.k-li-meta', e.ms != null ? U.formatMs(e.ms) : ''));
          const open = () => showAutoResult(e, i);
          row.addEventListener('click', open);
          row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') open(); });
          box.appendChild(row);
        });
        return box;
      }

      function renderList() {
        U.clear(listScroll);
        if (!st.loaded) {
          listScroll.appendChild(st.error
            ? api.empty({ icon: 'alert-triangle', title: 'Список не загрузился', text: st.error, tone: 'error', actions: [h('button.k-btn.k-btn-sm', { onClick: load }, 'Повторить')] })
            : h('div.tp-loading', h('span.k-spinner'), 'Загружаю…'));
          return;
        }
        const ab = autoBlock();
        if (ab) listScroll.appendChild(ab);
        const mine = st.items.filter(match);
        const lib = st.builtins.filter(match);
        const secMine = h('section.tp-sec', h('div.tp-sec-head', h('span.k-label', 'Мои сниппеты'), h('span.tp-sec-meta', st.items.length ? String(st.items.length) : '')));
        if (mine.length) mine.forEach((s) => secMine.appendChild(snippetRow(s, false)));
        else if (st.q) secMine.appendChild(h('div.tp-none', 'Ничего не найдено'));
        else secMine.appendChild(h('div.tp-none', 'Своих пока нет. Нажмите «Новый» или скопируйте сниппет из библиотеки.'));
        listScroll.appendChild(secMine);
        const secLib = h('section.tp-sec', h('div.tp-sec-head', h('span.k-label', 'Библиотека'), h('span.tp-sec-meta', 'только чтение')));
        if (lib.length) lib.forEach((s) => secLib.appendChild(snippetRow(s, true)));
        else secLib.appendChild(h('div.tp-none', 'Ничего не найдено'));
        listScroll.appendChild(secLib);
      }

      // =========================== редактор ===========================
      const backBtn = h('button.k-icon-btn.k-icon-btn-sm', { type: 'button', title: 'К списку', html: window.KIcons.get('arrow-left', 16) });
      const nameIn = h('input.tp-name', { type: 'text', spellcheck: 'false', 'aria-label': 'Название сниппета', maxlength: '120' });
      const delBtn = h('button.k-icon-btn.k-icon-btn-sm', { type: 'button', title: 'Удалить сниппет', html: window.KIcons.get('trash', 15) });
      const delConfirm = h('button.k-btn.k-btn-sm.k-btn-danger.tp-del-confirm', { type: 'button', hidden: true }, 'Удалить');
      const edHead = h('div.tp-ed-head', backBtn, nameIn, delConfirm, delBtn);

      const worldSeg = h('div.k-seg.tp-seg', { role: 'radiogroup', 'aria-label': 'Где выполнять' });
      const worldBtns = WORLDS.map((w) => {
        const b = h('button', { type: 'button', role: 'radio', title: w.hint, dataset: { w: w.id } }, w.label);
        b.addEventListener('click', () => { if (!st.cur || st.cur.builtin) return; st.cur.world = w.id; paintWorld(); persistMeta(); });
        worldSeg.appendChild(b);
        return b;
      });
      const autoSw = h('input.k-switch', { type: 'checkbox', 'aria-label': 'Автозапуск' });
      const matchIn = h('input.k-input.k-input-sm.k-mono.tp-match', { type: 'text', spellcheck: 'false', placeholder: 'example.com, *.example.com или example.com/product/*', 'aria-label': 'Сайты для автозапуска' });
      const autoRow = h('label.tp-auto-toggle', { title: 'Выполнять сам при загрузке подходящих страниц' }, autoSw, h('span', 'Автозапуск'));
      const optsEl = h('div.tp-ed-opts', h('div.tp-opt-line', worldSeg, autoRow), matchIn);
      const roBanner = h('div.tp-ro', U.icon('lock', 14), h('span.k-grow', 'Встроенный сниппет — только чтение'),
        h('button.k-btn.k-btn-sm', { type: 'button', onClick: () => st.cur && copyToMine(st.cur) }, U.icon('copy-plus', 14), 'Копировать в мои'));

      const gutter = h('div.tp-gutter', { 'aria-hidden': 'true' });
      const code = h('textarea.tp-code', { spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', wrap: 'off', 'aria-label': 'Код сниппета' });
      const codeBox = h('div.tp-codebox', gutter, code);

      const runMain = h('button.k-btn.k-btn-sm.k-btn-primary', { type: 'button', title: 'Выполнить (Ctrl+Enter)' }, U.icon('play', 14), 'Выполнить');
      const saveBtn = h('button.k-btn.k-btn-sm', { type: 'button', title: 'Сохранить (Ctrl+S)' }, 'Сохранить');
      const target = h('span.tp-target.k-ellipsis');
      const actions = h('div.tp-ed-actions', runMain, saveBtn, target);

      const splitter = h('div.tp-split', { title: 'Потяните, чтобы изменить высоту', role: 'separator', 'aria-orientation': 'horizontal' });
      const outStatus = h('div.tp-out-status');
      const outCopy = h('button.k-icon-btn.k-icon-btn-sm', { type: 'button', title: 'Копировать результат', html: window.KIcons.get('copy', 14), hidden: true });
      const outClear = h('button.k-icon-btn.k-icon-btn-sm', { type: 'button', title: 'Очистить вывод', html: window.KIcons.get('x', 14), hidden: true });
      const outBody = h('div.tp-out-body');
      const out = h('div.tp-out', h('div.tp-out-head', h('span.k-label', 'Результат'), outStatus, h('span.k-grow'), outCopy, outClear), outBody);

      const editView = h('div.tp-view.tp-edit-view', { hidden: true }, edHead, optsEl, roBanner, codeBox, actions, splitter, out);
      el.append(listView, editView);

      // --- высота редактора (перетаскивание разделителя) ---
      let codeH = lsGet('codeH', 0);
      function applyCodeH() { if (codeH > 0) codeBox.style.flexBasis = codeH + 'px'; else codeBox.style.removeProperty('flex-basis'); }
      applyCodeH();
      splitter.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        splitter.setPointerCapture(e.pointerId);
        const y0 = e.clientY, h0 = codeBox.getBoundingClientRect().height;
        const max = editView.getBoundingClientRect().height - 160;
        const move = (ev) => { codeH = Math.round(Math.max(80, Math.min(max, h0 + ev.clientY - y0))); applyCodeH(); };
        const up = () => { splitter.removeEventListener('pointermove', move); splitter.removeEventListener('pointerup', up); splitter.removeEventListener('pointercancel', up); lsSet('codeH', codeH); };
        splitter.addEventListener('pointermove', move);
        splitter.addEventListener('pointerup', up);
        splitter.addEventListener('pointercancel', up);
      });
      splitter.addEventListener('dblclick', () => { codeH = 0; applyCodeH(); lsSet('codeH', 0); });

      // --- номера строк ---
      let gutterLines = 0, errLine = 0;
      function paintGutter() {
        const n = code.value.split('\n').length;
        if (n !== gutterLines) {
          gutterLines = n;
          const frag = document.createDocumentFragment();
          for (let i = 1; i <= n; i++) frag.appendChild(h('div', String(i)));
          U.clear(gutter).appendChild(frag);
        }
        Array.from(gutter.children).forEach((d, i) => d.classList.toggle('err', i + 1 === errLine));
        gutter.scrollTop = code.scrollTop;
      }
      code.addEventListener('scroll', () => { gutter.scrollTop = code.scrollTop; });

      // --- клавиши редактора ---
      function lineStart(v, pos) { return v.lastIndexOf('\n', pos - 1) + 1; }
      function insert(text) { code.focus(); if (!document.execCommand('insertText', false, text)) code.setRangeText(text, code.selectionStart, code.selectionEnd, 'end'); }
      function indentLines(outdent) {
        const v = code.value, s = code.selectionStart, e = code.selectionEnd;
        const a = lineStart(v, s);
        const b = e > s && v[e - 1] === '\n' ? e - 1 : e;
        const block = v.slice(a, b);
        const lines = block.split('\n');
        const next = lines.map((l) => (outdent ? l.replace(/^( {1,2}|\t)/, '') : '  ' + l)).join('\n');
        code.setSelectionRange(a, b);
        insert(next);
        code.setSelectionRange(a, a + next.length);
      }
      function toggleComment() {
        const v = code.value, s = code.selectionStart, e = code.selectionEnd;
        const a = lineStart(v, s);
        let b = v.indexOf('\n', e > s && v[e - 1] === '\n' ? e - 1 : e);
        if (b < 0) b = v.length;
        const lines = v.slice(a, b).split('\n');
        const all = lines.filter((l) => l.trim()).every((l) => /^\s*\/\//.test(l));
        const next = lines.map((l) => (!l.trim() ? l : all ? l.replace(/^(\s*)\/\/ ?/, '$1') : l.replace(/^(\s*)/, '$1// '))).join('\n');
        code.setSelectionRange(a, b);
        insert(next);
        code.setSelectionRange(a, a + next.length);
      }
      code.addEventListener('keydown', (e) => {
        const ctrl = e.ctrlKey || e.metaKey;
        if (ctrl && e.key === 'Enter') { e.preventDefault(); runEditor(); return; }
        if (ctrl && e.code === 'KeyS') { e.preventDefault(); saveCurrent(true); return; }
        if (ctrl && e.code === 'Slash') { e.preventDefault(); if (!code.readOnly) toggleComment(); return; }
        if (code.readOnly) return;
        if (e.key === 'Tab' && !ctrl && !e.altKey) {
          e.preventDefault();
          // есть выделение — сдвигаем строки целиком (выделенный текст не заменяется пробелами)
          if (e.shiftKey || code.selectionEnd > code.selectionStart) indentLines(e.shiftKey);
          else insert('  ');
          return;
        }
        if (e.key === 'Enter' && !ctrl && !e.shiftKey && !e.altKey) {
          const v = code.value, s = code.selectionStart;
          const ls = lineStart(v, s);
          const ind = (/^[ \t]*/.exec(v.slice(ls, s)) || [''])[0];
          const extra = /[{[(]\s*$/.test(v.slice(ls, s)) ? '  ' : '';
          e.preventDefault();
          insert('\n' + ind + extra);
        }
      });
      code.addEventListener('input', () => {
        if (st.cur && !st.cur.builtin) { st.dirty = code.value !== st.cur.code; paintDirty(); }
        if (errLine) errLine = 0;
        paintGutter();
      });
      editView.addEventListener('keydown', (e) => {
        if (e.defaultPrevented) return; // уже обработано редактором кода
        if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') { e.preventDefault(); saveCurrent(true); }
        else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runEditor(); }
      });

      // --- поля сниппета ---
      function paintWorld() { worldBtns.forEach((b) => { const on = st.cur && b.dataset.w === st.cur.world; b.classList.toggle('active', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); }); }
      function paintDirty() {
        saveBtn.hidden = !!(st.cur && st.cur.builtin);
        saveBtn.disabled = !st.cur || st.cur.builtin || !st.dirty;
        saveBtn.textContent = st.dirty ? 'Сохранить' : 'Сохранено';
      }
      function paintAuto() {
        const c = st.cur;
        autoSw.checked = !!(c && c.auto);
        matchIn.hidden = !(c && c.auto);
        if (document.activeElement !== matchIn) matchIn.value = (c && c.match) || '';
      }
      function paintTarget() {
        const t = api.activeTab();
        const ok = t && isWeb(t.url) && !t.discarded;
        target.textContent = t ? (ok ? 'на ' + hostOf(t.url) : t.discarded ? 'вкладка выгружена' : 'вкладка — не сайт') : 'нет вкладки';
        target.title = t ? t.url : '';
        target.classList.toggle('bad', !ok);
        runMain.disabled = st.running || !st.cur || !ok;
      }
      autoSw.addEventListener('change', () => {
        if (!st.cur || st.cur.builtin) return;
        st.cur.auto = autoSw.checked;
        paintAuto();
        if (st.cur.auto && !st.cur.match) { const t = api.activeTab(); if (t && /^https?:/i.test(t.url)) { st.cur.match = hostOf(t.url).replace(/^www\./, ''); matchIn.value = st.cur.match; } matchIn.focus(); }
        persistMeta();
      });
      matchIn.addEventListener('change', () => { if (!st.cur || st.cur.builtin) return; st.cur.match = matchIn.value.trim(); persistMeta(); });
      matchIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); matchIn.blur(); } });
      nameIn.addEventListener('change', () => { if (!st.cur || st.cur.builtin) return; st.cur.name = nameIn.value.trim() || 'Без названия'; nameIn.value = st.cur.name; persistMeta(); });
      nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); code.focus(); } });
      backBtn.addEventListener('click', () => showList());
      saveBtn.addEventListener('click', () => saveCurrent(true));
      runMain.addEventListener('click', () => runEditor());
      let delTimer = 0;
      delBtn.addEventListener('click', () => {
        delConfirm.hidden = false; delBtn.hidden = true;
        clearTimeout(delTimer);
        delTimer = setTimeout(() => { delConfirm.hidden = true; delBtn.hidden = !st.cur || st.cur.builtin; }, 3500);
        delConfirm.focus();
      });
      delConfirm.addEventListener('click', () => {
        clearTimeout(delTimer);
        const c = st.cur;
        if (!c || c.builtin) return;
        api.invoke('kosmo:snippets.remove', { id: c.id }).then(() => {
          st.items = st.items.filter((x) => x.id !== c.id);
          st.dirty = false;
          api.toast('Сниппет «' + c.name + '» удалён');
          showList();
        }).catch((e) => api.toast(errText(e), { tone: 'danger' }));
      });

      // =========================== переходы ===========================
      function showList() {
        if (st.dirty) saveCurrent(false);
        st.view = 'list';
        lsSet('view', { view: 'list' });
        editView.hidden = true;
        listView.hidden = false;
        renderList();
        const row = st.cur && listScroll.querySelector('[data-id="' + CSS.escape(st.cur.id) + '"]');
        if (row) { row.scrollIntoView({ block: 'nearest' }); row.focus({ preventScroll: true }); }
      }
      function openEditor(s, opts) {
        opts = opts || {};
        if (st.dirty && st.cur && (!s || s.id !== st.cur.id)) saveCurrent(false);
        st.cur = Object.assign({}, s);
        st.dirty = false;
        st.view = 'edit';
        lsSet('view', { view: 'edit', id: s.id });
        listView.hidden = true;
        editView.hidden = false;
        nameIn.value = s.name;
        nameIn.readOnly = !!s.builtin;
        code.value = s.code || '';
        code.readOnly = !!s.builtin;
        editView.classList.toggle('ro', !!s.builtin);
        if (!opts.keepOutput) renderOutput(null);
        roBanner.hidden = !s.builtin;
        delBtn.hidden = !!s.builtin; delConfirm.hidden = true;
        worldBtns.forEach((b) => { b.disabled = !!s.builtin; });
        autoSw.disabled = !!s.builtin;
        autoRow.hidden = !!s.builtin;
        errLine = 0; gutterLines = 0;
        paintWorld(); paintAuto(); paintDirty(); paintTarget(); paintGutter();
        code.scrollTop = 0;
        if (!opts.noFocus) setTimeout(() => code.focus({ preventScroll: true }), 0);
      }
      function findById(id) { return st.items.find((x) => x.id === id) || st.builtins.find((x) => x.id === id) || null; }

      // =========================== данные ===========================
      function load() {
        st.error = null;
        return api.invoke('kosmo:snippets.list', {}).then((r) => {
          st.items = (r && r.items) || [];
          st.builtins = (r && r.builtins) || [];
          st.loaded = true;
          if (st.view === 'list') renderList();
        }).catch((e) => { st.error = errText(e); st.loaded = false; renderList(); });
      }

      function persistMeta() {
        const c = st.cur;
        if (!c || c.builtin) return Promise.resolve();
        return save({ id: c.id, name: c.name, code: st.dirty ? c.code : code.value, world: c.world, auto: c.auto, match: c.match }, false);
      }
      function saveCurrent(withToast) {
        const c = st.cur;
        if (!c || c.builtin) return Promise.resolve();
        c.code = code.value;
        return save({ id: c.id, name: nameIn.value.trim() || c.name, code: c.code, world: c.world, auto: c.auto, match: c.match }, withToast).then(() => { st.dirty = false; paintDirty(); });
      }
      function save(s, withToast) {
        return api.invoke('kosmo:snippets.save', { snippet: s }).then((saved) => {
          const i = st.items.findIndex((x) => x.id === saved.id);
          if (i >= 0) st.items[i] = saved; else st.items.push(saved);
          if (st.cur && st.cur.id === saved.id) { st.cur.name = saved.name; st.cur.code = saved.code; st.cur.world = saved.world; st.cur.auto = saved.auto; st.cur.match = saved.match; }
          if (withToast) api.toast('Сохранено');
          return saved;
        }).catch((e) => { api.toast(errText(e), { tone: 'danger' }); throw e; });
      }
      function createNew() {
        save({ name: 'Новый сниппет', code: NEW_CODE, world: 'isolated', auto: false, match: '' }, false).then((s) => {
          openEditor(s);
          setTimeout(() => { nameIn.focus(); nameIn.select(); }, 0);
        }).catch(() => {});
      }
      function copyToMine(b) {
        save({ name: b.name, code: b.code, world: b.world, auto: false, match: '' }, false).then((s) => {
          api.toast('Скопировано в «Мои сниппеты»');
          openEditor(s);
        }).catch(() => {});
      }

      // =========================== выполнение ===========================
      function runEditor() {
        if (!st.cur || st.running) return;
        if (!code.value.trim()) { api.toast('Пустой код'); return; }
        exec({ code: code.value, world: st.cur.world, name: st.cur.name, id: st.cur.id });
      }
      function runSnippet(s) {
        openEditor(s, { noFocus: true });
        exec({ id: s.id });
      }
      function exec(payload) {
        const t = api.activeTab();
        if (!t || !isWeb(t.url)) { renderOutput({ ok: false, error: { name: 'Ошибка', message: 'Активная вкладка — не сайт. Откройте страницу сайта и запустите снова.' } }); return; }
        const seq = ++st.seq;
        st.running = true;
        paintTarget();
        outStatus.replaceChildren(h('span.k-spinner'), h('span', 'Выполняется на ' + hostOf(t.url) + '…'));
        outBody.classList.add('busy');
        api.invoke('kosmo:snippets.run', Object.assign({ tabId: t.id }, payload)).then((r) => {
          if (seq !== st.seq) return;
          renderOutput(r);
        }).catch((e) => {
          if (seq !== st.seq) return;
          renderOutput({ ok: false, error: { name: 'Ошибка', message: errText(e) } });
        }).finally(() => {
          if (seq !== st.seq) return;
          st.running = false;
          outBody.classList.remove('busy');
          paintTarget();
        });
      }

      // =========================== вывод ===========================
      let copyPayload = null;
      outCopy.addEventListener('click', () => { if (copyPayload != null) U.copyText(copyPayload); });
      outClear.addEventListener('click', () => renderOutput(null));

      function renderOutput(r) {
        st.result = r;
        U.clear(outBody);
        copyPayload = null;
        outCopy.hidden = true;
        outClear.hidden = !r;
        if (!r) {
          outStatus.replaceChildren();
          outBody.appendChild(h('div.tp-out-empty', 'Нажмите «Выполнить» или Ctrl+Enter — код выполнится в активной вкладке.'));
          return;
        }
        const time = r.ms != null ? U.formatMs(r.ms) : '';
        outStatus.replaceChildren(...[dot(r.ok ? 'ok' : 'bad'),
          h('span', r.ok ? 'Готово' + (time ? ' за ' + time : '') : (r.error && r.error.name === 'SyntaxError' ? 'Синтаксическая ошибка' : 'Ошибка')),
          r.url ? h('span.tp-out-where', '· ' + hostOf(r.url) + ' · ' + worldLabel(r.world)) : null,
          r.auto ? h('span.tp-out-where', '· автозапуск') : null].filter(Boolean));
        if (Array.isArray(r.logs) && r.logs.length) {
          const box = h('div.tp-logs');
          for (const l of r.logs) box.appendChild(h('div.tp-log', { dataset: { level: l.level } }, l.text));
          outBody.appendChild(box);
        }
        if (!r.ok) {
          const e = r.error || {};
          // первая строка стека V8 повторяет «Имя: сообщение» — показываем только кадры
          let stack = String(e.stack || '');
          const headLine = (e.name ? e.name + ': ' : '') + (e.message || '');
          if (headLine && stack.startsWith(headLine)) stack = stack.slice(headLine.length).replace(/^\n/, '');
          // у синтаксической ошибки в «стеке» строка кода и каретка ^ — отступы там значимы
          if (e.name !== 'SyntaxError') stack = stack.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
          outBody.appendChild(h('div.tp-error', h('div.tp-err-msg', (e.name ? e.name + ': ' : '') + (e.message || 'неизвестная ошибка')), stack ? h('pre.tp-err-stack', stack) : null));
          const m = /сниппет:(\d+):/.exec(e.stack || '') || (e.line ? [0, e.line] : null);
          if (m && st.cur && !st.cur.builtin) { errLine = Number(m[1]); paintGutter(); }
          copyPayload = (e.name ? e.name + ': ' : '') + (e.message || '') + (e.stack ? '\n' + e.stack : '');
          outCopy.hidden = false;
          return;
        }
        renderValue(r.result || { type: 'undefined' });
      }

      function renderValue(res) {
        const t = res.type;
        if (t === 'undefined') {
          outBody.appendChild(h('div.tp-out-empty', 'Выполнено. Значения нет — чтобы увидеть результат, добавьте return.'));
          return;
        }
        if (t === 'string') {
          copyPayload = res.value;
          outCopy.hidden = false;
          outBody.appendChild(h('pre.tp-pre.tp-str', res.value));
          if (res.truncated) outBody.appendChild(h('div.tp-note', 'Строка обрезана до 3 млн символов'));
          return;
        }
        if (t === 'number' || t === 'boolean' || t === 'null') {
          copyPayload = String(res.value);
          outCopy.hidden = false;
          outBody.appendChild(h('div.tp-scalar.k-mono', { dataset: { t } }, String(res.value)));
          return;
        }
        if (t === 'directive') { renderDirective(res.value || {}); return; }
        // json
        copyPayload = JSON.stringify(res.value, null, 2);
        outCopy.hidden = false;
        const KD = window.KDev;
        let tree = null;
        if (KD && typeof KD.jsonTree === 'function') {
          try { tree = KD.jsonTree(res.value, {}); } catch (e) { tree = null; }
        }
        const summary = Array.isArray(res.value) ? 'Массив, элементов: ' + res.value.length : 'Объект, ключей: ' + Object.keys(res.value || {}).length;
        outBody.appendChild(h('div.tp-json-head', h('span', summary),
          tree ? h('button.k-btn.k-btn-sm.k-btn-ghost', { type: 'button', onClick: () => tree.expandAll(3000) }, 'Развернуть всё') : null,
          h('button.k-btn.k-btn-sm.k-btn-ghost', { type: 'button', onClick: () => U.copyText(copyPayload, { message: 'JSON скопирован' }) }, U.icon('copy', 13), 'JSON')));
        outBody.appendChild(h('div.tp-json', tree ? tree.el : fallbackTree(res.value)));
      }

      function renderDirective(d) {
        const kind = d.__kosmo;
        if (kind === 'copy') {
          const text = cellText(d.text);
          U.copyText(text, { message: d.message || 'Скопировано' });
          copyPayload = text;
          outCopy.hidden = false;
          const lines = text.split('\n');
          outBody.append(
            h('div.tp-done', U.icon('check', 14), h('span', d.message || 'Скопировано в буфер обмена'),
              h('button.k-btn.k-btn-sm.k-btn-ghost', { type: 'button', onClick: () => U.copyText(text, { message: d.message || 'Скопировано' }) }, 'Ещё раз')),
            h('pre.tp-pre.tp-preview', lines.slice(0, 30).join('\n') + (lines.length > 30 ? '\n… ещё строк: ' + (lines.length - 30) : '')));
          return;
        }
        if (kind === 'choices') {
          if (d.title) outBody.appendChild(h('div.tp-dir-title', d.title));
          const list = h('div.tp-choices');
          for (const it of d.items || []) {
            const b = h('button.tp-choice', { type: 'button' }, h('span.tp-choice-label', it.label || '—'), it.sub ? h('span.tp-choice-sub', it.sub) : null);
            b.addEventListener('click', () => { U.copyText(cellText(it.text), { message: it.message || 'Скопировано' }); b.classList.add('done'); });
            list.appendChild(b);
          }
          outBody.appendChild(list);
          return;
        }
        if (kind === 'table') {
          const cols = Array.isArray(d.columns) ? d.columns.map(cellText) : [];
          const rows = Array.isArray(d.rows) ? d.rows.map((r) => (Array.isArray(r) ? r : [r])) : [];
          copyPayload = toTsv(cols, rows);
          outCopy.hidden = false;
          const bar = h('div.tp-dir-bar', h('span.tp-dir-title', d.title || ('Строк: ' + rows.length)), h('span.k-grow'),
            h('button.k-btn.k-btn-sm', { type: 'button', title: 'Для вставки в Excel и Google Таблицы', onClick: () => U.copyText(toTsv(cols, rows), { message: 'Таблица скопирована (TSV)' }) }, 'TSV'),
            h('button.k-btn.k-btn-sm', { type: 'button', onClick: () => U.copyText(toCsv(cols, rows), { message: 'Таблица скопирована (CSV)' }) }, 'CSV'));
          if (d.copyColumn != null && cols[d.copyColumn] != null) {
            const ci = Number(d.copyColumn);
            bar.appendChild(h('button.k-btn.k-btn-sm', { type: 'button', title: 'Только значения столбца, по одному в строке', onClick: () => U.copyText(rows.map((r) => cellText(r[ci])).join('\n'), { message: 'Скопировано: ' + rows.length }) }, 'Только «' + cols[ci] + '»'));
          }
          outBody.appendChild(bar);
          const table = h('table.tp-table');
          table.appendChild(h('thead', h('tr', cols.map((c) => h('th', c)))));
          const tb = h('tbody');
          for (const r of rows.slice(0, ROW_LIMIT)) {
            const tr = h('tr');
            for (let i = 0; i < Math.max(cols.length, r.length); i++) {
              const v = cellText(r[i]);
              const cell = /^https?:\/\/\S+$/.test(v)
                ? h('td', h('a', { href: v, target: '_blank', rel: 'noreferrer', title: v }, v))
                : h('td', { title: v.length > 60 ? v : null }, v);
              tr.appendChild(cell);
            }
            tb.appendChild(tr);
          }
          table.appendChild(tb);
          outBody.appendChild(h('div.tp-table-wrap', table));
          if (rows.length > ROW_LIMIT) outBody.appendChild(h('div.tp-note', 'Показаны первые ' + ROW_LIMIT + ' из ' + rows.length + ' строк. Кнопки копируют всё.'));
          if (d.note) outBody.appendChild(h('div.tp-note', String(d.note)));
          return;
        }
        // неизвестная директива — как JSON
        renderValue({ type: 'json', value: d });
      }

      function showAutoResult(e, index) {
        const s = findById(e.id);
        if (s) openEditor(s, { noFocus: true });
        api.invoke('kosmo:snippets.autoResult', { tabId: st.auto.tabId, index }).then((r) => {
          if (r) renderOutput(r);
          else renderOutput({ ok: e.ok, ms: e.ms, result: { type: 'string', value: e.summary || '' }, auto: true });
        }).catch((err) => api.toast(errText(err), { tone: 'danger' }));
      }

      // =========================== события ===========================
      function refreshAuto() {
        const t = api.activeTab();
        if (!t) return;
        api.invoke('kosmo:snippets.autoLog', { tabId: t.id }).then((a) => {
          if (a) st.auto = a;
          if (st.view === 'list') renderList();
        }).catch(() => {});
      }
      api.on('kosmo:snippets.changed', (p) => {
        if (!p || !Array.isArray(p.items)) return;
        st.items = p.items;
        if (st.cur && !st.cur.builtin && !st.items.some((x) => x.id === st.cur.id) && st.view === 'edit') { st.dirty = false; showList(); return; }
        if (st.view === 'list') renderList();
      });
      api.on('kosmo:snippets.auto', (a) => {
        if (!a) return;
        const t = api.activeTab();
        if (t && a.tabId === t.id) { st.auto = a; if (st.view === 'list') renderList(); }
      });
      api.on('kosmo:snippets.ran', (p) => showPicked(p));
      api.onTabChange((t, info) => {
        paintTarget();
        if (info && info.reason === 'activated') { st.auto = { tabId: t ? t.id : null, url: '', entries: [] }; refreshAuto(); }
      });
      api.onTabsState(() => paintTarget());

      function showPicked(p) {
        if (!p || !p.result) return;
        const s = findById(p.id);
        if (s) openEditor(s, { noFocus: true });
        renderOutput(p.result);
      }

      // старт
      const saved = lsGet('view', null);
      load().then(() => {
        refreshAuto();
        if (saved && saved.view === 'edit' && saved.id) { const s = findById(saved.id); if (s) openEditor(s, { noFocus: true }); else renderList(); }
        else renderList();
        api.invoke('kosmo:snippets.takeLast', {}).then(showPicked).catch(() => {});
      });
      renderList();
    }
  });
})();
