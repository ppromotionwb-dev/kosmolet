// Владелец: themes. Инструмент панели «Тема сайта»: параметры тёмной темы текущего сайта, свой CSS сайта
// (моноширинный редактор, Tab — отступ, применение через 300 мс), список настроенных сайтов.
'use strict';
(function () {
  const U = window.KUI;
  const { h } = U;
  U.css('tools/theme.css');
  window.KIcons.add('moon-fill', '<path fill="currentColor" d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>');
  window.KIcons.add('rotate-ccw', '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>');

  const SLIDERS = [
    { key: 'brightness', label: 'Яркость', min: 50, max: 150 },
    { key: 'contrast', label: 'Контраст', min: 50, max: 150 },
    { key: 'sepia', label: 'Сепия', min: 0, max: 100 },
    { key: 'grayscale', label: 'Оттенки серого', min: 0, max: 100 }
  ];
  const PARAMS = ['engine', 'brightness', 'contrast', 'sepia', 'grayscale', 'bg', 'text'];
  const errText = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');

  function seg(options, onPick, label) {
    const el = h('div.k-seg.kp-seg', { role: 'radiogroup', 'aria-label': label });
    const btns = options.map(([v, text]) => {
      const b = h('button', { type: 'button', role: 'radio', dataset: { v } }, text);
      b.addEventListener('click', () => onPick(v));
      el.appendChild(b);
      return b;
    });
    el.set = (v) => btns.forEach((b) => { const on = b.dataset.v === v; b.classList.toggle('active', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); });
    return el;
  }

  KPanel.register({
    id: 'theme', title: 'Тема сайта', icon: 'palette', order: 60,
    mount(el, api) {
      const st = { s: null, sites: [], seq: 0, dragging: null, pending: {}, cssDirty: false, cssKey: '', shown: false };
      el.classList.add('kp-theme');

      // ---------- шапка: сайт и переключатель ----------
      const siteIcon = h('span.kp-site-ic', U.icon('moon', 18));
      const siteHost = h('div.kp-site-host.k-ellipsis');
      const siteSub = h('div.kp-site-sub');
      const sw = h('input.k-switch', { type: 'checkbox', 'aria-label': 'Тёмная тема на этом сайте' });
      const siteCard = h('section.kp-card.kp-site', siteIcon, h('div.kp-site-text', siteHost, siteSub), sw);
      const note = h('div.kp-note', { hidden: true });

      // ---------- параметры ----------
      const rows = {};
      const sliders = h('div.kp-sliders');
      for (const s of SLIDERS) {
        const range = h('input.kp-range', { type: 'range', min: s.min, max: s.max, step: 1, 'aria-label': s.label });
        const val = h('span.kp-val');
        range.addEventListener('pointerdown', () => { st.dragging = s.key; });
        range.addEventListener('pointerup', () => { if (st.dragging === s.key) setTimeout(() => { st.dragging = null; }, 0); });
        range.addEventListener('input', () => { val.textContent = range.value + '%'; paint(range); queue({ [s.key]: +range.value }); });
        range.addEventListener('change', () => { st.dragging = null; flush(); });
        sliders.appendChild(h('label.kp-slider', h('span.kp-label', s.label), range, val));
        rows[s.key] = { range, val };
      }
      const engine = seg([['dynamic', 'Точный'], ['filter', 'Быстрый']], (v) => send({ engine: v }), 'Движок');
      const bgIn = h('input.k-input.kp-color', { type: 'color', 'aria-label': 'Фон страницы' });
      const textIn = h('input.k-input.kp-color', { type: 'color', 'aria-label': 'Текст страницы' });
      const autoBtn = h('button.k-btn.k-btn-sm.k-btn-ghost', { type: 'button', title: 'Цвета в тон теме интерфейса' }, 'Как у интерфейса');
      bgIn.addEventListener('change', () => send({ bg: bgIn.value }));
      textIn.addEventListener('change', () => send({ text: textIn.value }));
      autoBtn.addEventListener('click', () => send({ bg: null, text: null }));
      const resetBtn = h('button.k-btn.k-btn-sm.k-btn-ghost', { type: 'button', title: 'Вернуть общие параметры из настроек' }, U.icon('rotate-ccw', 14), 'Сбросить');
      resetBtn.addEventListener('click', () => st.s && api.invoke('kosmo:themes.resetSite', { key: st.s.key }).then(load).catch(fail));
      const paramsCard = h('section.kp-card.kp-params',
        h('div.kp-card-head', h('span.k-label', 'Параметры'), resetBtn),
        sliders,
        h('div.kp-row', h('span.kp-label', 'Движок'), engine),
        h('div.kp-row', h('span.kp-label', 'Цвета'), h('div.kp-colors', h('span.kp-cl', 'фон'), bgIn, h('span.kp-cl', 'текст'), textIn, autoBtn)),
        h('div.kp-hint', 'Точный (Dark Reader) пересчитывает цвета сайта, но на тяжёлых сайтах замедляет загрузку. Быстрый инвертирует всю страницу: почти бесплатно, но грубее.'));

      // ---------- свой CSS ----------
      const ta = h('textarea.k-textarea.kp-css', {
        spellcheck: 'false', autocomplete: 'off', wrap: 'off', 'aria-label': 'Свой CSS сайта',
        placeholder: '/* Свой CSS сайта: применяется сразу\n   и всегда — даже без тёмной темы */\n\n.banner { display: none !important; }'
      });
      const cssState = h('span.kp-css-state');
      const cssClear = h('button.k-btn.k-btn-sm.k-btn-ghost', { type: 'button' }, 'Очистить');
      const cssNote = h('div.kp-note.kp-css-note', { hidden: true });
      cssClear.addEventListener('click', () => { if (!ta.value) return; ta.value = ''; st.cssDirty = true; saveCss.flush(); });
      const cssCard = h('section.kp-card.kp-css-card',
        h('div.kp-card-head', h('span.k-label', 'Свой CSS'), cssState, h('span.k-grow'), cssClear),
        cssNote, ta);

      // ---------- список сайтов ----------
      const list = h('div.kp-sites');
      const sitesCount = h('span.kp-count');
      const sitesCard = h('section.kp-card.kp-sites-card', h('div.kp-card-head', h('span.k-label', 'Настроенные сайты'), sitesCount), list);

      const unsupported = h('div.kp-unsupported', { hidden: true });
      el.append(siteCard, note, unsupported, paramsCard, cssCard, sitesCard);

      // ---------- поведение ----------
      sw.addEventListener('change', () => {
        if (!st.s) return;
        api.invoke('kosmo:themes.toggleSite', { key: st.s.key, value: sw.checked }).then(showSite).catch(fail);
      });

      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
          e.preventDefault();
          if (e.shiftKey) outdent(); else indent();
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
          e.preventDefault();
          saveCss.flush();
        }
      });
      ta.addEventListener('input', () => { st.cssDirty = true; setCssState('wait'); saveCss(); });
      ta.addEventListener('blur', () => { if (st.cssDirty) saveCss.flush(); });

      // Отступы через execCommand — чтобы работала отмена (Ctrl+Z).
      function indent() {
        const v = ta.value, a = ta.selectionStart, b = ta.selectionEnd;
        if (a === b || v.slice(a, b).indexOf('\n') < 0) { document.execCommand('insertText', false, '  '); return; }
        const ls = v.lastIndexOf('\n', a - 1) + 1;
        const out = v.slice(ls, b).replace(/(^|\n)/g, '$1  ');
        ta.setSelectionRange(ls, b);
        document.execCommand('insertText', false, out);
        ta.setSelectionRange(ls, ls + out.length);
      }
      function outdent() {
        const v = ta.value, a = ta.selectionStart, b = ta.selectionEnd;
        const ls = v.lastIndexOf('\n', a - 1) + 1;
        const block = v.slice(ls, Math.max(b, a));
        const out = block.replace(/(^|\n) {1,2}/g, '$1');
        if (out === block) return;
        ta.setSelectionRange(ls, ls + block.length);
        document.execCommand('insertText', false, out);
        if (a === b) { const p = Math.max(ls, a - (block.match(/^ {1,2}/) || [''])[0].length); ta.setSelectionRange(p, p); }
        else ta.setSelectionRange(ls, ls + out.length);
      }

      const saveCss = U.debounce(() => {
        if (!st.s || !st.s.supported || !st.cssDirty) return;
        const css = ta.value;
        st.cssDirty = false;
        setCssState('saving');
        api.invoke('kosmo:themes.setSite', { key: st.s.key, patch: { css } })
          .then((s) => { st.cssKey = s.key + '\n' + css; setCssState('ok'); showSite(s, true); })
          .catch((e) => { st.cssDirty = true; setCssState('error', errText(e)); });
      }, 300);

      function setCssState(kind, text) {
        cssState.dataset.kind = kind;
        cssState.textContent = kind === 'wait' ? 'изменён' : kind === 'saving' ? 'применяю…' : kind === 'ok' ? 'применён' : kind === 'error' ? text || 'ошибка' : '';
      }

      function paint(range) { range.style.setProperty('--p', ((range.value - range.min) / (range.max - range.min) * 100) + '%'); }
      function queue(patch) { Object.assign(st.pending, patch); clearTimeout(st.timer); st.timer = setTimeout(flush, 180); }
      function flush() { clearTimeout(st.timer); const p = st.pending; st.pending = {}; if (Object.keys(p).length) send(p); }
      function send(patch) {
        if (!st.s || !st.s.supported) return;
        api.invoke('kosmo:themes.setSite', { key: st.s.key, patch }).then((s) => { if (!st.dragging) showSite(s); }).catch(fail);
      }
      function fail(e) { api.toast('Не получилось: ' + errText(e), { tone: 'danger' }); }

      function showSite(s, keepCss) {
        if (!s) return;
        st.s = s;
        const ok = !!s.supported;
        sw.disabled = !ok;
        paramsCard.hidden = !ok;
        cssCard.hidden = !ok;
        unsupported.hidden = ok;
        if (!ok) {
          U.clear(siteIcon).appendChild(U.icon('orbit', 18));
          const t = api.activeTab();
          siteHost.textContent = t && t.title ? t.title : 'Эта страница';
          siteSub.textContent = 'Тема сайта недоступна';
          siteCard.classList.remove('on');
          note.hidden = true;
          U.clear(unsupported).appendChild(api.empty({ icon: 'moon', title: 'Здесь тема не работает', text: 'Тёмная тема и свой CSS — для обычных сайтов (http и https). Внутренние страницы Космолёта уже в теме интерфейса.' }));
          return;
        }
        siteCard.classList.toggle('on', !!s.dark);
        U.clear(siteIcon).appendChild(U.icon(s.dark ? 'moon-fill' : 'moon', 18));
        siteHost.textContent = s.key;
        siteHost.title = s.host;
        siteSub.textContent = s.dark
          ? 'Тёмная тема включена · ' + (s.params.engine === 'filter' ? 'фильтр' : 'Dark Reader')
          : s.mode === 'off' ? 'Тёмная тема выключена для всех сайтов' : 'Тёмная тема выключена';
        sw.checked = !!s.dark;
        let n = '';
        if (s.inherited) n = 'Настройки берутся у ' + s.matchedKey + '. Любое изменение здесь создаст свои для ' + s.key + '.';
        else if (s.mode === 'all' && s.siteEnabled == null && s.dark) n = 'Включено режимом «все сайты».';
        note.textContent = n;
        note.hidden = !n;
        paramsCard.classList.toggle('off', !s.dark);
        for (const sl of SLIDERS) {
          if (st.dragging === sl.key) continue;
          const r = rows[sl.key];
          const v = Number(s.params[sl.key]);
          r.range.value = String(v);
          r.val.textContent = v + '%';
          paint(r.range);
        }
        engine.set(s.params.engine);
        bgIn.value = s.params.bg;
        textIn.value = s.params.text;
        const own = s.own || {};
        autoBtn.disabled = own.bg == null && own.text == null && !(s.inherited && s.params.bg !== s.auto.bg);
        resetBtn.disabled = !PARAMS.some((k) => own[k] != null);
        // CSS: не перетираем то, что пользователь сейчас печатает
        const key = s.key + '\n' + (s.css || '');
        if (!keepCss && !st.cssDirty && document.activeElement !== ta && key !== st.cssKey) {
          ta.value = s.css || '';
          st.cssKey = key;
          setCssState(s.css ? 'ok' : '');
          if (!s.css) cssState.textContent = '';
        } else if (!keepCss && document.activeElement !== ta && !st.cssDirty) st.cssKey = key;
        cssNote.hidden = !(s.inherited && s.css);
        cssNote.textContent = s.inherited && s.css ? 'CSS от ' + s.matchedKey + '.' : '';
      }

      function renderSites(items) {
        st.sites = items || [];
        sitesCount.textContent = st.sites.length ? String(st.sites.length) : '';
        U.clear(list);
        if (!st.sites.length) {
          list.appendChild(api.empty({ icon: 'moon', title: 'Пока пусто', text: 'Сайты появятся здесь, когда вы включите на них тёмную тему, поменяете параметры или добавите CSS.' }));
          return;
        }
        for (const it of st.sites) {
          const isCur = st.s && st.s.supported && (st.s.matchedKey === it.key || st.s.key === it.key);
          const badges = h('span.kp-badges',
            it.enabled === true ? h('span.k-badge.k-badge-accent', 'тёмная') : it.enabled === false ? h('span.k-badge', 'выкл') : null,
            it.css ? h('span.k-badge', 'CSS') : null,
            it.params.length ? h('span.k-badge', { title: it.params.join(', ') }, 'параметры') : null);
          const open = h('button.kp-site-link.k-ellipsis', { type: 'button', title: 'Открыть https://' + it.key + '/' }, it.key);
          open.addEventListener('click', () => api.invoke('kosmo:tabs.create', { url: 'https://' + it.key + '/' }).catch(fail));
          const reset = h('button.k-icon-btn.k-icon-btn-sm', { type: 'button', title: 'Сбросить параметры (оставить включение и CSS)', disabled: !it.params.length }, U.icon('rotate-ccw', 14));
          reset.addEventListener('click', () => api.invoke('kosmo:themes.resetSite', { key: it.key }).then(load).catch(fail));
          const del = h('button.k-icon-btn.k-icon-btn-sm.kp-del', { type: 'button', title: 'Удалить настройки сайта' }, U.icon('trash', 14));
          del.addEventListener('click', () => {
            if (del.dataset.confirm !== '1') {
              del.dataset.confirm = '1';
              del.title = 'Нажмите ещё раз, чтобы удалить';
              del.classList.add('confirm');
              setTimeout(() => { del.dataset.confirm = ''; del.classList.remove('confirm'); del.title = 'Удалить настройки сайта'; }, 2500);
              return;
            }
            api.invoke('kosmo:themes.removeSite', { key: it.key }).then(load).catch(fail);
          });
          list.appendChild(h('div.kp-site-row' + (isCur ? '.cur' : ''), open, badges, h('span.k-grow'), reset, del));
        }
      }

      function load() {
        const my = ++st.seq;
        const t = api.activeTab();
        const url = t ? t.url : '';
        return Promise.all([
          api.invoke('kosmo:themes.site', { url }),
          api.invoke('kosmo:themes.sites', {})
        ]).then(([s, sites]) => {
          if (my !== st.seq) return;
          showSite(s);
          renderSites(sites);
        }).catch((e) => {
          U.clear(list).appendChild(api.empty({ icon: 'alert-triangle', title: 'Не загрузилось', text: errText(e), tone: 'error' }));
        });
      }

      st.load = load;
      el._kp = st;
      api.onTabChange(() => { if (st.cssDirty) saveCss.flush(); if (api.isVisible()) load(); else st.stale = true; });
      api.on('kosmo:settings.changed', (p) => {
        if (!p || typeof p.path !== 'string') return;
        if (p.path === '' || p.path.startsWith('siteThemes') || p.path.startsWith('ui.theme') || p.path.startsWith('ui.custom')) {
          if (api.isVisible()) load(); else st.stale = true;
        }
      });
      load();
    },
    onShow(api) {
      const st = api.el && api.el._kp;
      if (st && st.stale) { st.stale = false; st.load(); }
    }
  });
})();
