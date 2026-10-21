// История посещений. Владелец: ux-chrome.
// Поиск, группы по дням, удаление записи, очистка за период (с подтверждением), постраничная подгрузка.
'use strict';
(function () {
  const U = window.KUI;
  const { h } = U;
  const I = window.KIcons;
  const $ = (id) => document.getElementById(id);
  const PAGE = 150;

  $('kp-title').append(U.icon('history', 18), 'История');
  $('hs-search-icon').replaceWith(I.el('search', 14));
  const qEl = $('hs-q'), listEl = $('hs-list'), moreEl = $('hs-more'), sumEl = $('hs-summary');

  const st = { q: '', offset: 0, total: 0, loaded: 0, loading: false, done: false, gen: 0, lastDay: null, lastCard: null };

  // ---------- форматирование ----------
  const dayFmt = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
  const dayFmtY = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  function dayKey(ts) { const d = new Date(ts); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); }
  function dayTitle(ts) {
    const d = new Date(ts);
    const now = new Date();
    const y = new Date(now); y.setDate(now.getDate() - 1);
    const full = (d.getFullYear() === now.getFullYear() ? dayFmt : dayFmtY).format(d);
    if (d.toDateString() === now.toDateString()) return ['Сегодня', full];
    if (d.toDateString() === y.toDateString()) return ['Вчера', full];
    return [full.charAt(0).toUpperCase() + full.slice(1), ''];
  }
  function hostOf(u) {
    try { const x = new URL(u); return x.protocol === 'file:' ? 'файл' : U.hostToUnicode(x.hostname).replace(/^www\./, ''); } catch (e) { return ''; }
  }
  function favicon(e) {
    const box = h('span.hs-fav');
    const letter = () => h('span.hs-letter', ((e.title || hostOf(e.url) || '?').match(/[\p{L}\p{N}]/u) || ['?'])[0].toUpperCase());
    if (e.favicon && /^(https?:|data:image\/)/i.test(e.favicon)) {
      const img = h('img', { alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
      img.addEventListener('error', () => { U.clear(box).appendChild(letter()); }, { once: true });
      img.src = e.favicon;
      box.appendChild(img);
    } else box.appendChild(letter());
    return box;
  }
  function highlight(text, q) {
    const frag = document.createDocumentFragment();
    const s = String(text || '');
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) { frag.appendChild(document.createTextNode(s)); return frag; }
    const low = s.toLowerCase();
    const marks = new Array(s.length).fill(false);
    for (const t of terms) { let i = low.indexOf(t); let n = 0; while (i >= 0 && n++ < 20) { for (let j = i; j < i + t.length; j++) marks[j] = true; i = low.indexOf(t, i + t.length); } }
    let i = 0;
    while (i < s.length) { const m = marks[i]; let j = i; while (j < s.length && marks[j] === m) j++; frag.appendChild(m ? h('mark.hs-hl', s.slice(i, j)) : document.createTextNode(s.slice(i, j))); i = j; }
    return frag;
  }

  // ---------- строки ----------
  function row(e) {
    const title = e.title || hostOf(e.url) || e.url;
    const del = h('button.k-icon-btn.k-icon-btn-sm.hs-del', { type: 'button', title: 'Удалить из истории', 'aria-label': 'Удалить из истории', html: I.get('x', 14) });
    const r = h('div.hs-row', { dataset: { url: e.url } },
      h('span.hs-time', U.formatTime(e.lastVisit)),
      favicon(e),
      h('span.hs-main',
        h('a.hs-title', { href: e.url, title: title + '\n' + e.url }, highlight(title, st.q)),
        h('span.hs-host', highlight(hostOf(e.url), st.q))),
      e.visitCount > 1 ? h('span.k-badge.hs-count', { title: 'Посещений: ' + e.visitCount }, '×' + e.visitCount) : null,
      del);
    del.addEventListener('click', () => removeRow(r, e.url));
    return r;
  }

  function removeRow(r, url) {
    U.invoke('kosmo:history.remove', { url }).then(() => {
      r.classList.add('removing');
      setTimeout(() => {
        const card = r.parentNode;
        r.remove();
        if (card && !card.children.length) card.closest('.hs-day').remove();
        st.total = Math.max(0, st.total - 1);
        renderSummary();
        if (!listEl.querySelector('.hs-row')) renderEmpty();
      }, 160);
    }).catch((err) => U.toast('Не удалось удалить: ' + clean(err), { tone: 'danger' }));
  }

  function append(items) {
    for (const e of items) {
      const k = dayKey(e.lastVisit);
      if (k !== st.lastDay) {
        const [a, b] = dayTitle(e.lastVisit);
        st.lastCard = h('div.hs-card');
        listEl.appendChild(h('section.hs-day', h('div.hs-day-title', a, b ? h('span.k-faint', b) : null), st.lastCard));
        st.lastDay = k;
      }
      st.lastCard.appendChild(row(e));
    }
  }

  function renderSummary() {
    sumEl.hidden = !st.q;
    if (st.q) sumEl.textContent = st.total ? 'Найдено: ' + st.total + ' ' + U.plural(st.total, ['страница', 'страницы', 'страниц']) : '';
  }

  function renderEmpty() {
    U.clear(listEl);
    if (st.q) listEl.appendChild(U.empty({ icon: 'search', title: 'Ничего не найдено', text: 'По запросу «' + st.q + '» в истории ничего нет.' }));
    else listEl.appendChild(U.empty({ icon: 'history', title: 'История пуста', text: 'Здесь появятся страницы, которые вы открываете.' }));
    sumEl.hidden = true;
  }

  function clean(e) { return String((e && e.message) || e || '').replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, ''); }

  // ---------- загрузка ----------
  function load(reset) {
    if (!U.hasKosmo) { renderEmpty(); return; }
    if (reset) {
      st.gen++; st.offset = 0; st.loaded = 0; st.done = false; st.lastDay = null; st.lastCard = null; st.loading = false;
    }
    if (st.loading || st.done) return;
    st.loading = true;
    const gen = st.gen;
    if (reset && !listEl.children.length) { U.clear(moreEl).appendChild(h('span.k-spinner')); }
    U.invoke('kosmo:history.page', { q: st.q, offset: st.offset, limit: PAGE }).then((res) => {
      if (gen !== st.gen) return;
      st.loading = false;
      if (reset) U.clear(listEl);
      st.total = res.total;
      const items = res.items || [];
      st.offset += items.length;
      st.done = st.offset >= res.total || !items.length;
      U.clear(moreEl);
      if (!st.offset) { renderEmpty(); return; }
      append(items);
      renderSummary();
      if (!st.done) moreEl.appendChild(h('span.k-spinner'));
    }).catch((err) => {
      if (gen !== st.gen) return;
      st.loading = false;
      U.clear(moreEl);
      U.clear(listEl).appendChild(U.empty({ icon: 'alert-triangle', title: 'История не загрузилась', text: clean(err), tone: 'error' }));
    });
  }

  // подгрузка при прокрутке к концу
  new IntersectionObserver((entries) => {
    if (entries.some((x) => x.isIntersecting) && !st.done && !st.loading) load(false);
  }, { rootMargin: '600px 0px' }).observe(moreEl);

  qEl.addEventListener('input', U.debounce(() => { st.q = qEl.value.trim(); load(true); window.scrollTo(0, 0); }, 150));
  qEl.addEventListener('keydown', (e) => { if (e.key === 'Escape' && qEl.value) { qEl.value = ''; st.q = ''; load(true); } });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey && e.key.toLowerCase() === 'f') || (e.key === '/' && document.activeElement === document.body)) { e.preventDefault(); qEl.focus(); qEl.select(); }
  });

  // ---------- очистка ----------
  function openClear() {
    if (document.querySelector('.kp-modal-back')) return;
    const sel = h('select.k-select', { 'aria-label': 'Период' },
      h('option', { value: 'hour' }, 'За последний час'),
      h('option', { value: 'day' }, 'За последние сутки'),
      h('option', { value: 'week' }, 'За последнюю неделю'),
      h('option', { value: 'all' }, 'За всё время'));
    sel.value = 'all';
    const cancel = h('button.k-btn', { type: 'button' }, 'Отмена');
    const ok = h('button.k-btn.k-btn-danger', { type: 'button' }, U.icon('trash', 14), 'Удалить');
    const back = h('div.kp-modal-back', h('div.kp-modal', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Очистить историю' },
      h('div.kp-modal-body', h('div.k-h2', 'Очистить историю'), h('p', 'Записи о посещённых страницах будут удалены. Закладки и список загрузок останутся.'), sel),
      h('div.kp-modal-foot', cancel, ok)));
    const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); if (location.hash === '#clear') history.replaceState(null, '', location.pathname); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    document.addEventListener('keydown', onKey, true);
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    cancel.addEventListener('click', close);
    ok.addEventListener('click', () => {
      const now = Date.now();
      const since = { hour: now - 3600000, day: now - 86400000, week: now - 7 * 86400000, all: 0 }[sel.value];
      ok.disabled = true;
      U.invoke('kosmo:history.clear', { since }).then((n) => {
        close();
        U.toast(n ? 'Удалено: ' + n + ' ' + U.plural(n, ['запись', 'записи', 'записей']) : 'Нечего удалять', { tone: 'ok' });
        load(true);
      }).catch((err) => { ok.disabled = false; U.toast('Не удалось очистить: ' + clean(err), { tone: 'danger' }); });
    });
    document.body.appendChild(back);
    sel.focus();
  }
  $('hs-clear').addEventListener('click', openClear);

  // живое обновление: новые посещения, пока смотрим начало списка
  const refresh = U.debounce(() => { if (window.scrollY < 300 && !document.querySelector('.kp-modal-back')) load(true); }, 800);
  U.on('kosmo:history.changed', (p) => { if (p && (p.reason === 'visit' || p.reason === 'clear' || p.reason === 'remove')) refresh(); });

  load(true);
  if (location.hash === '#clear') setTimeout(openClear, 50);
})();
