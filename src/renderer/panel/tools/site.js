// Владелец: site-intel. Инструмент панели «Сайт»: что браузер знает о сайте активной вкладки —
// каталог API (метод, шаблон, ×N, действия), карточка эндпоинта (параметры, схемы, заголовки, «Копировать как fetch»),
// заметки (свои и Claude) и «Забыть сайт». Данные — kosmo:siteIntel.* в main, обновление по kosmo:siteIntel.changed.
'use strict';
(function () {
  const U = window.KUI;
  const { h } = U;
  U.css('tools/site.css');

  const errText = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
  const isWeb = (u) => /^https?:/i.test(String(u || ''));
  const AUTHOR = { claude: 'Claude', user: 'Вы' };

  KPanel.register({
    id: 'site', title: 'Сайт', icon: 'database', order: 85,
    mount(el, api) {
      el.classList.add('si');
      const st = { tab: null, data: null, view: 'api', card: null, cardKey: '', filter: '', loading: false, seq: 0, editing: null, confirmForget: 0 };

      const btn = (ic, title, onClick, cls) => {
        const b = h('button.k-icon-btn.k-icon-btn-sm' + (cls || ''), { type: 'button', title, 'aria-label': title, html: window.KIcons.get(ic, 15) });
        b.addEventListener('click', onClick);
        return b;
      };
      const refreshBtn = btn('rotate-cw', 'Обновить', () => load());
      const forgetBtn = h('button.k-btn.k-btn-sm.k-btn-ghost.si-forget', { type: 'button', title: 'Удалить всё, что браузер знает об этом сайте' }, U.icon('trash', 14), h('span', 'Забыть сайт'));
      forgetBtn.addEventListener('click', onForget);
      const site = api.siteHeader({ icon: 'database', title: 'Сайт', actions: [refreshBtn, forgetBtn] });
      site.el.classList.add('si-head');

      const tabsSeg = h('div.k-seg.si-seg', { role: 'tablist', 'aria-label': 'Раздел' });
      const segBtns = {};
      for (const [v, label] of [['api', 'API'], ['notes', 'Заметки']]) {
        const b = h('button', { type: 'button', role: 'tab', dataset: { v } }, label, h('span.si-seg-n'));
        b.addEventListener('click', () => { st.view = v; st.card = null; render(); });
        tabsSeg.appendChild(b);
        segBtns[v] = b;
      }
      const filterIn = h('input.k-input.k-input-sm.si-filter', { type: 'search', placeholder: 'Фильтр: путь, параметр, действие', spellcheck: 'false', 'aria-label': 'Фильтр эндпоинтов' });
      filterIn.addEventListener('input', U.debounce(() => { st.filter = filterIn.value.trim().toLowerCase(); render(); }, 120));
      const bar = h('div.si-bar', tabsSeg, filterIn);
      const body = h('div.si-body');
      el.append(site.el, bar, body);

      // ---------- загрузка ----------
      async function load(quiet) {
        const t = api.activeTab();
        st.tab = t;
        const seq = ++st.seq;
        if (!t || !isWeb(t.url)) { st.data = null; render(); return; }
        if (!quiet) { st.loading = true; body.classList.add('busy'); }
        try {
          const d = await api.invoke('kosmo:siteIntel.summary', { tabId: t.id });
          if (seq !== st.seq) return;
          if (st.data && d && st.data.site !== d.site) { st.card = null; st.editing = null; }
          st.data = d;
          if (st.card && st.cardKey) {
            const c = await api.invoke('kosmo:siteIntel.endpoint', { site: d.site, key: st.cardKey }).catch(() => null);
            if (seq !== st.seq) return;
            st.card = c;
          }
        } catch (e) {
          if (seq !== st.seq) return;
          st.data = { error: errText(e) };
        } finally {
          if (seq === st.seq) { st.loading = false; body.classList.remove('busy'); }
        }
        render();
      }

      // ---------- отрисовка ----------
      function render() {
        const d = st.data;
        const t = st.tab;
        const host = t && isWeb(t.url) ? (U.parseUrl(t.url) || {}).host || '' : '';
        site.set({ title: d && d.site ? d.site : (host || 'Сайт'), sub: d && d.site ? `${d.total || 0} ${U.plural(d.total || 0, ['эндпоинт', 'эндпоинта', 'эндпоинтов'])} · ${(d.notes || []).length} ${U.plural((d.notes || []).length, ['заметка', 'заметки', 'заметок'])}` : '' });
        forgetBtn.disabled = !(d && d.site && (d.total || (d.notes || []).length));
        refreshBtn.disabled = !t || !isWeb(t.url);
        for (const [v, b] of Object.entries(segBtns)) {
          const on = st.view === v;
          b.classList.toggle('active', on);
          b.setAttribute('aria-selected', on ? 'true' : 'false');
        }
        segBtns.api.querySelector('.si-seg-n').textContent = d && d.total ? String(d.total) : '';
        segBtns.notes.querySelector('.si-seg-n').textContent = d && d.notes && d.notes.length ? String(d.notes.length) : '';
        filterIn.hidden = st.view !== 'api' || !!st.card;
        bar.hidden = !d || !d.site;
        U.clear(body);
        if (!t || !isWeb(t.url)) { body.appendChild(U.empty({ icon: 'globe', title: 'Откройте сайт', text: 'Здесь будет то, что браузер узнал о сайте активной вкладки: его API и заметки.' })); return; }
        if (!d) { body.appendChild(h('div.si-loading', h('span.k-spinner'))); return; }
        if (d.error) { body.appendChild(U.empty({ icon: 'alert-triangle', title: 'Не удалось загрузить', text: d.error, tone: 'error' })); return; }
        if (st.view === 'notes') return renderNotes();
        if (st.card) return renderCard(st.card);
        renderList();
      }

      function notice() {
        const d = st.data;
        if (!d.enabled) return h('div.si-note', U.icon('info', 14), h('span', 'Сбор каталога API выключен в настройках: «Инструменты разработчика».'));
        if (d.excluded) return h('div.si-note', U.icon('info', 14), h('span', 'Сайт в исключениях — новые запросы не записываются.'));
        if (d.capture === 'off') return h('div.si-note', U.icon('info', 14), h('span', 'Запись сети выключена для этой вкладки — каталог не пополняется.'));
        return null;
      }

      function methodBadge(m) { return h('span.si-method', { dataset: { m } }, m); }

      function renderList() {
        const d = st.data;
        const n = notice();
        if (n) body.appendChild(n);
        if (!d.items.length) {
          body.appendChild(U.empty({ icon: 'database', title: 'Запросов пока нет', text: 'Пользуйтесь сайтом как обычно: API-запросы страницы (XHR и fetch) появятся здесь и сохранятся между сессиями.' }));
          return;
        }
        const f = st.filter;
        const items = f ? d.items.filter((it) => (it.key + ' ' + it.query + ' ' + it.actions.map((a) => a.label).join(' ')).toLowerCase().includes(f)) : d.items;
        if (!items.length) { body.appendChild(U.empty({ icon: 'filter', title: 'Ничего не найдено', text: 'Измените фильтр.' })); return; }
        const list = h('div.si-list', { role: 'list' });
        for (const it of items) {
          const row = h('button.si-row', { type: 'button', role: 'listitem', title: it.key + it.query },
            h('div.si-row-top', methodBadge(it.method), h('span.si-path.k-mono', safeDecode(it.path), h('span.si-q', safeDecode(it.query))), h('span.si-count', '×' + it.count)),
            h('div.si-row-sub',
              h('span.si-host.k-ellipsis', it.host),
              h('span.si-when', U.timeAgo(it.last)),
              it.auth ? h('span.si-auth', it.auth) : null,
              it.actions.length ? h('span.si-acts', it.actions.slice(0, 2).map((a) => h('span.si-chip', { title: chipTitle(a) }, a.label))) : null));
          row.addEventListener('click', () => openCard(it.key));
          list.appendChild(row);
        }
        body.appendChild(list);
      }
      function safeDecode(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }
      function chipTitle(a) { return `${a.label}: ${a.n} раз` + (a.claude ? ` (Claude: ${a.claude})` : ''); }

      async function openCard(key) {
        const d = st.data;
        try {
          const c = await api.invoke('kosmo:siteIntel.endpoint', { site: d.site, key });
          if (!c) { api.toast('Эндпоинт не найден', { tone: 'danger' }); return; }
          st.card = c; st.cardKey = key;
          render();
          body.scrollTop = 0;
        } catch (e) { api.toast(errText(e), { tone: 'danger' }); }
      }

      function section(title, ...children) {
        const kids = children.flat().filter(Boolean);
        if (!kids.length) return null;
        return h('section.si-sec', h('div.si-sec-title.k-label', title), kids);
      }
      function mono(text) { return h('pre.si-mono', text); }

      function renderCard(c) {
        const back = h('button.k-btn.k-btn-sm.k-btn-ghost.si-back', { type: 'button' }, U.icon('arrow-left', 14), 'Все эндпоинты');
        back.addEventListener('click', () => { st.card = null; st.cardKey = ''; render(); });
        const copy = h('button.k-btn.k-btn-sm', { type: 'button', title: 'Шаблон вызова для консоли: значения заголовков подставьте из запроса' }, U.icon('copy', 14), 'Копировать как fetch');
        copy.addEventListener('click', () => U.copyText(c.fetchTemplate, { message: 'Шаблон fetch скопирован' }));
        const statuses = Object.entries(c.status || {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ×${n}`).join(', ');
        const head = h('div.si-card-head',
          h('div.si-card-line', methodBadge(c.method), h('span.si-card-path.k-mono', c.host + safeDecode(c.path))),
          h('div.si-card-meta', `${c.count} ${U.plural(c.count, ['вызов', 'вызова', 'вызовов'])} · последний ${U.timeAgo(c.last)} · ${statuses}`),
          h('div.si-card-actions', back, h('span.k-grow'), copy));

        const params = c.params.length ? h('table.si-table',
          h('thead', h('tr', h('th', 'Параметр'), h('th', 'Примеры'), h('th', ''))),
          h('tbody', c.params.map((p) => h('tr',
            h('td.k-mono', p.name + (p.optional ? '?' : '')),
            h('td.si-ex', p.examples.length ? p.examples.join(', ') : '—'),
            h('td.si-flags', p.masked ? h('span.k-badge.k-badge-warn', 'скрыто') : null, p.varies ? h('span.si-flag', 'меняется') : h('span.si-flag', 'постоянный')))))) : h('div.si-faint', 'Без параметров');

        const acts = c.actions.length ? h('div.si-chips', c.actions.map((a) => h('span.si-chip', { title: chipTitle(a) }, a.label, h('b', ' ×' + a.n), a.claude ? h('span.si-src', a.user ? ' · Claude ' + a.claude : ' · Claude') : null)))
          : h('div.si-faint', 'Не связан с действиями: вызывается при загрузке страницы или по таймеру');

        const card = h('div.si-card',
          head,
          section('Параметры запроса', params),
          section('Авторизация и заголовки',
            h('div.si-kv', h('span.si-k', 'Авторизация'), h('span', c.auth || 'не видно')),
            c.headers.length ? h('div.si-kv', h('span.si-k', 'Заголовки'), h('span.si-chips', c.headers.map((x) => h('span.si-chip.k-mono', x.name)))) : null,
            h('div.si-faint', 'Хранятся только имена заголовков, без значений.')),
          c.reqSchema ? section('Тело запроса' + (c.reqType ? ' · ' + c.reqType : ''), mono(c.reqSchema)) : null,
          section('Ответ', c.resSchema ? mono(c.resSchema) : h('div.si-faint', 'Схема появится после первого JSON-ответа (до 1 МБ).')),
          section('Вызывается действиями', acts),
          c.initiators.length ? section('Код страницы', mono(c.initiators.map((x) => `${x.where}  ×${x.n}`).join('\n'))) : null,
          c.pages.length ? section('Страницы', mono(c.pages.map((x) => x.page).join('\n'))) : null,
          section('Шаблон fetch', mono(c.fetchTemplate)));
        body.appendChild(card);
      }

      // ---------- заметки ----------
      function renderNotes() {
        const d = st.data;
        const ta = h('textarea.k-textarea.si-note-text', { placeholder: 'Заметка о сайте: что где лежит, какие запросы работают…', maxlength: 2000, rows: 3, 'aria-label': 'Текст заметки' });
        const tags = h('input.k-input.k-input-sm.si-tags', { type: 'text', placeholder: 'Метки через запятую', spellcheck: 'false', 'aria-label': 'Метки' });
        const add = h('button.k-btn.k-btn-sm.k-btn-primary', { type: 'button' }, U.icon('plus', 14), 'Добавить');
        add.addEventListener('click', async () => {
          const text = ta.value.trim();
          if (!text) { ta.focus(); return; }
          add.disabled = true;
          try { await api.invoke('kosmo:siteIntel.noteAdd', { site: d.site, text, tags: tags.value }); ta.value = ''; tags.value = ''; await load(true); } catch (e) { api.toast(errText(e), { tone: 'danger' }); } finally { add.disabled = false; }
        });
        ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); add.click(); } });
        body.appendChild(h('div.si-note-form', ta, h('div.si-note-form-row', tags, add)));
        const notes = (d.notes || []).slice().sort((a, b) => b.updated - a.updated);
        if (!notes.length) {
          body.appendChild(U.empty({ icon: 'file-text', title: 'Заметок нет', text: 'Claude сохраняет сюда находки о сайте, а вы можете добавить свои.' }));
          return;
        }
        const list = h('div.si-notes');
        for (const n of notes) list.appendChild(noteItem(n));
        body.appendChild(list);
      }

      function noteItem(n) {
        const d = st.data;
        const item = h('article.si-note-item', { dataset: { author: n.author } });
        if (st.editing === n.id) {
          const ta = h('textarea.k-textarea.si-note-text', { maxlength: 2000, rows: 4, 'aria-label': 'Текст заметки' });
          ta.value = n.text;
          const tags = h('input.k-input.k-input-sm.si-tags', { type: 'text', value: (n.tags || []).join(', '), 'aria-label': 'Метки' });
          const save = h('button.k-btn.k-btn-sm.k-btn-primary', { type: 'button' }, 'Сохранить');
          const cancel = h('button.k-btn.k-btn-sm.k-btn-ghost', { type: 'button' }, 'Отмена');
          save.addEventListener('click', async () => {
            try { await api.invoke('kosmo:siteIntel.noteUpdate', { site: d.site, id: n.id, text: ta.value, tags: tags.value }); st.editing = null; await load(true); } catch (e) { api.toast(errText(e), { tone: 'danger' }); }
          });
          cancel.addEventListener('click', () => { st.editing = null; render(); });
          item.append(ta, h('div.si-note-form-row', tags, cancel, save));
          setTimeout(() => ta.focus(), 0);
          return item;
        }
        const edit = btn('pencil', 'Изменить', () => { st.editing = n.id; render(); });
        const del = btn('trash', 'Удалить', async () => {
          if (!del.classList.contains('armed')) {
            del.classList.add('armed'); del.title = 'Нажмите ещё раз, чтобы удалить';
            setTimeout(() => { del.classList.remove('armed'); del.title = 'Удалить'; }, 3000);
            return;
          }
          try { await api.invoke('kosmo:siteIntel.noteRemove', { site: d.site, id: n.id }); await load(true); } catch (e) { api.toast(errText(e), { tone: 'danger' }); }
        }, '.si-del');
        item.append(
          h('div.si-note-meta',
            h('span.si-author', { dataset: { author: n.author } }, n.author === 'claude' ? U.icon('claude', 12) : U.icon('user', 12), AUTHOR[n.author] || n.author),
            h('span.si-when', { title: new Date(n.updated).toLocaleString('ru-RU') }, U.timeAgo(n.updated)),
            (n.tags || []).map((t) => h('span.si-tag', t)),
            h('span.k-grow'), edit, del),
          h('div.si-note-body', n.text));
        return item;
      }

      // ---------- забыть сайт ----------
      async function onForget() {
        const d = st.data;
        if (!d || !d.site) return;
        if (Date.now() - st.confirmForget > 3000) {
          st.confirmForget = Date.now();
          forgetBtn.classList.add('armed');
          forgetBtn.lastChild.textContent = 'Точно забыть?';
          setTimeout(() => { if (Date.now() - st.confirmForget >= 2900) { forgetBtn.classList.remove('armed'); forgetBtn.lastChild.textContent = 'Забыть сайт'; } }, 3000);
          return;
        }
        st.confirmForget = 0;
        forgetBtn.classList.remove('armed');
        forgetBtn.lastChild.textContent = 'Забыть сайт';
        try { await api.invoke('kosmo:siteIntel.forget', { site: d.site }); st.card = null; api.toast('Данные сайта удалены'); await load(); } catch (e) { api.toast(errText(e), { tone: 'danger' }); }
      }

      // ---------- события ----------
      const reload = U.debounce(() => { if (api.isVisible() && st.editing == null) load(true); }, 800);
      api.on('kosmo:siteIntel.changed', (p) => { if (p && st.data && p.site === st.data.site) reload(); });
      api.onTabChange(() => { if (api.isVisible()) load(); else st.stale = true; });
      st.show = () => { load(); };
      el._siShow = st.show;
      load();
    },
    onShow(api) { if (api.el && api.el._siShow) api.el._siShow(); },
  });
})();
