// Владелец: devtools. Инструмент «Сеть и API»: сниффер запросов активной вкладки (данные — ctx.cdp в main).
// Виртуализированный список (тысячи строк), фильтр-строка с операторами, чипы типов, только JSON, пауза,
// очистка, «сохранять при переходах», HAR. Детали: заголовки, параметры, ответ (дерево JSON с поиском и путями),
// тайминги, сообщения WebSocket. Действия: копировать как fetch/cURL/PowerShell/Python, повторить,
// изменить и отправить (fetch из страницы), отдать Claude, поиск по телам ответов.
'use strict';
(function () {
  const U = window.KUI;
  const D = window.KDev;
  const C = window.KDevCommon;
  const { h } = U;
  U.css('tools/network.css');

  const ROW = 24;
  const OVERSCAN = 10;
  const TEXT_VIEW_LIMIT = 400 * 1024;
  const LS = 'kosmo.net.';
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(LS + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch (e) { /* нет хранилища */ } }
  };

  function fmtMs(ms) {
    if (ms == null || isNaN(ms)) return '—';
    if (ms < 1000) return Math.round(ms) + ' мс';
    if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 2 : 1).replace('.', ',') + ' с';
    return U.formatMs(ms);
  }
  function fmtSize(e) {
    if (e.fromCache && !e.size) return 'кэш';
    if (e.pending && !e.size) return '…';
    return e.size ? U.formatBytes(e.size) : '0 Б';
  }
  function splitUrl(url) {
    try {
      const u = new URL(url);
      if (u.protocol === 'data:') return { host: '', path: url.slice(0, 80), file: 'data:' };
      const p = u.pathname + u.search;
      const file = (u.pathname.split('/').filter(Boolean).pop() || u.host) + u.search;
      return { host: u.host, path: p || '/', file };
    } catch (e) { return { host: '', path: url, file: url }; }
  }
  function timeOf(ts) { const d = new Date(ts); return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0'); }
  function esc(s) { return U.esc(String(s == null ? '' : s)); }

  KPanel.register({
    id: 'network', title: 'Сеть и API', icon: 'activity', order: 20,
    mount(el, api) {
      el.classList.add('kn');
      const st = {
        tabId: null, info: null, all: [], byId: new Map(), rows: [], selId: null,
        filterText: ls.get('filter', ''), kind: ls.get('kind', 'all'), jsonOnly: ls.get('json', false),
        filterFn: null, hits: null, hitQuery: '', detailCache: new Map(), detailTab: ls.get('dtab', 'response'),
        rendered: new Map(), stick: true, visible: false, seqLoad: 0, epoch: 0,
        split: ls.get('split', { h: 300, w: 420 }),
      };

      // ---------- верхняя панель ----------
      const recBtn = D.iconBtn('circle-dot', 'Пауза записи', () => togglePause(), 'kn-rec');
      const clearBtn = D.iconBtn('ban', 'Очистить журнал', () => clearLog());
      const filterIn = h('input.k-input.k-input-sm.kn-filter', {
        type: 'text', spellcheck: 'false', placeholder: 'Фильтр: текст, status:4xx, method:POST, domain:wb.ru, -исключить',
        value: st.filterText, 'aria-label': 'Фильтр запросов'
      });
      const filterBox = h('label.k-search.kn-filter-box', U.icon('filter', 14), filterIn);
      const bodySearchBtn = D.iconBtn('search', 'Поиск по телам ответов', () => toggleBodySearch());
      const moreBtn = D.iconBtn('more-vertical', 'Ещё', (e) => moreMenu(e.currentTarget));
      const bar = h('div.kn-bar', recBtn, clearBtn, h('span.kn-sep'), filterBox, bodySearchBtn, moreBtn);

      const bsIn = h('input.k-input.k-input-sm', { type: 'text', spellcheck: 'false', placeholder: 'Найти в телах ответов (Enter)…', 'aria-label': 'Поиск по телам ответов' });
      const bsInfo = h('span.kn-bs-info');
      const bsClose = D.iconBtn('x', 'Закрыть поиск по ответам', () => toggleBodySearch(false));
      const bsBar = h('div.kn-bsbar', { hidden: true }, h('label.k-search.kn-bs-box', U.icon('file-json', 14), bsIn), bsInfo, bsClose);

      const chipEls = new Map();
      const chips = h('div.kn-chips', { role: 'toolbar', 'aria-label': 'Тип запросов' });
      for (const k of C.KINDS) {
        const b = h('button.kd-pill', { type: 'button', dataset: { kind: k.id } }, k.title, h('span.kd-pill-n'));
        b.addEventListener('click', () => { st.kind = k.id; ls.set('kind', k.id); refilter(); });
        chipEls.set(k.id, b);
        chips.appendChild(b);
      }
      const jsonChip = h('button.kd-pill.kn-json', { type: 'button', title: 'Только ответы JSON' }, U.icon('braces', 12), 'JSON');
      jsonChip.addEventListener('click', () => { st.jsonOnly = !st.jsonOnly; ls.set('json', st.jsonOnly); refilter(); });
      chips.append(h('span.kn-chips-sep'), jsonChip);

      const notice = h('div.kn-notice', { hidden: true });

      // ---------- список ----------
      const head = h('div.kn-head.kn-grid', h('span.c-st', 'Статус'), h('span.c-m', 'Метод'), h('span.c-name', 'Путь'), h('span.c-host', 'Хост'), h('span.c-type', 'Тип'), h('span.c-size', 'Размер'), h('span.c-time', 'Время'));
      const spacer = h('div.kn-spacer');
      const list = h('div.kn-list', { tabindex: '0', role: 'listbox', 'aria-label': 'Запросы' }, spacer);
      const emptyEl = h('div.kn-empty', { hidden: true });
      const listWrap = h('div.kn-listwrap', head, list, emptyEl);

      const splitH = h('div.kn-split', { title: 'Потяните, чтобы изменить размер' });
      const detail = h('div.kn-detail', { hidden: true });
      const main = h('div.kn-main', listWrap, splitH, detail);
      const status = h('div.kn-status');

      el.append(bar, bsBar, chips, notice, main, status);

      // ---------- раскладка деталей: справа на широкой панели, снизу — на узкой ----------
      let side = false;
      function applyLayout() {
        side = el.clientWidth >= 820;
        main.classList.toggle('side', side);
        if (side) { detail.style.width = Math.min(st.split.w, el.clientWidth - 260) + 'px'; detail.style.height = ''; }
        else { detail.style.height = Math.min(st.split.h, Math.max(120, main.clientHeight - 90)) + 'px'; detail.style.width = ''; }
        splitH.hidden = detail.hidden;
        renderList();
      }
      new ResizeObserver(() => applyLayout()).observe(el);
      D.splitter(splitH, {
        get vertical() { return side; },
        get: () => (side ? detail.offsetWidth : detail.offsetHeight),
        set: (v) => { if (side) { st.split.w = v; detail.style.width = v + 'px'; } else { st.split.h = v; detail.style.height = v + 'px'; } renderList(); },
        min: 120, max: () => (side ? el.clientWidth - 220 : main.clientHeight - 60),
        done: () => ls.set('split', st.split)
      });

      // ---------- данные ----------
      function prepEntry(e) { C.prep(e); e._v = (e._v || 0) + 1; e._u = splitUrl(e.url); return e; }

      // keep — тот же журнал после вытеснения старых записей: сохраняем поиск по телам и прокрутку
      function load(snapshot, keep) {
        const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - ROW * 1.5;
        const top = list.scrollTop;
        st.all = []; st.byId.clear(); st.detailCache.clear();
        if (!keep) { st.hits = null; st.hitQuery = ''; bsInfo.textContent = ''; }
        st.info = snapshot;
        for (const e of snapshot.entries || []) { prepEntry(e); st.all.push(e); st.byId.set(e.id, e); }
        if (st.selId && !st.byId.has(st.selId)) closeDetail();
        st.stick = !keep || atBottom;
        clearRendered();
        refilter();
        list.scrollTop = st.stick ? list.scrollHeight : top;
        updateBar();
      }

      function applyBatch(b) {
        if (b.tabId !== st.tabId) return;
        if (b.reset) { watchTab(st.tabId, true, true); return; }
        for (const e of b.add || []) {
          prepEntry(e);
          if (st.byId.has(e.id)) { const i = st.all.indexOf(st.byId.get(e.id)); if (i >= 0) st.all[i] = e; } else st.all.push(e);
          st.byId.set(e.id, e);
        }
        for (const e of b.upd || []) {
          const old = st.byId.get(e.id);
          if (!old) continue;
          e._v = (old._v || 0);
          prepEntry(e);
          const i = st.all.indexOf(old);
          if (i >= 0) st.all[i] = e;
          st.byId.set(e.id, e);
          if (!e.pending) st.detailCache.delete(e.id);
          // детали перерисовываем, только когда запрос завершился или сменился статус (не на каждый кадр WS)
          if (e.id === st.selId && ((old.pending && !e.pending) || old.status !== e.status || old.failed !== e.failed)) refreshDetailHead();
        }
        if (st.info) st.info.total = b.total;
        refilter(true);
      }

      // ---------- фильтр ----------
      function passes(e) {
        if (e.marker) return true;
        if (!C.kindMatches(e.kind, st.kind)) return false;
        if (st.jsonOnly && !C.isJsonMime(e.mime)) return false;
        if (st.filterFn && !st.filterFn(e)) return false;
        if (st.hits && !st.hits.has(e.id)) return false;
        return true;
      }
      function refilter(keepScroll) {
        const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - ROW * 1.5;
        const rows = [];
        const counts = {};
        let lastMarker = null;
        for (const e of st.all) {
          if (e.marker) { lastMarker = e; continue; }
          counts[e.kind === 'media' ? 'other' : e.kind] = (counts[e.kind === 'media' ? 'other' : e.kind] || 0) + 1;
          counts.all = (counts.all || 0) + 1;
          if (!passes(e)) continue;
          if (lastMarker) { rows.push(lastMarker); lastMarker = null; }
          rows.push(e);
        }
        if (lastMarker && rows.length) rows.push(lastMarker);
        else if (lastMarker && !rows.length && st.all.length && st.all[st.all.length - 1] === lastMarker) rows.push(lastMarker);
        st.rows = rows;
        for (const [k, b] of chipEls) {
          b.classList.toggle('on', st.kind === k);
          b.querySelector('.kd-pill-n').textContent = counts[k] ? String(counts[k]) : '';
        }
        jsonChip.classList.toggle('on', st.jsonOnly);
        if (!keepScroll || atBottom) st.stick = true;
        spacer.style.height = (rows.length * ROW) + 'px';
        if (st.stick && (atBottom || !keepScroll)) list.scrollTop = list.scrollHeight;
        renderList();
        renderEmpty();
        renderStatus();
      }
      const applyFilter = U.debounce(() => {
        st.filterText = filterIn.value;
        ls.set('filter', st.filterText);
        st.filterFn = C.compileFilter(st.filterText);
        filterBox.classList.toggle('active', !!st.filterFn);
        refilter();
      }, 120);
      filterIn.addEventListener('input', applyFilter);
      filterIn.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && filterIn.value) { filterIn.value = ''; applyFilter.flush(); e.stopPropagation(); }
        if (e.key === 'ArrowDown') { list.focus(); moveSel(1); e.preventDefault(); }
      });
      st.filterFn = C.compileFilter(st.filterText);
      filterBox.classList.toggle('active', !!st.filterFn);

      // ---------- виртуальный список ----------
      function clearRendered() { for (const r of st.rendered.values()) r.remove(); st.rendered.clear(); }
      function rowEl(e, i) {
        let r;
        if (e.marker) {
          const u = splitUrl(e.url);
          r = h('div.kn-row.marker', { title: e.url }, h('span.kn-mk-line'), h('span.kn-mk-text', 'Переход: ' + U.readableUrl(e.url).replace(/^https?:\/\//, '').replace(/\/$/, '')), h('span.kn-mk-time', timeOf(e.ts).slice(0, 8)), h('span.kn-mk-line'));
        } else {
          const canceled = e.failed && (e.canceled || /CANCEL|ABORT/i.test(e.errorText || ''));
          const tone = canceled ? 'pend' : D.statusTone(e.status, e.failed);
          const stText = e.failed ? (canceled ? 'отмена' : 'ошибка') : e.pending && !e.status ? '…' : String(e.status || '');
          const hit = st.hits && st.hits.get(e.id);
          r = h('div.kn-row.kn-grid', { role: 'option', 'aria-selected': e.id === st.selId ? 'true' : 'false', title: e.method + ' ' + e.url + (e.failed ? '\n' + e.errorText : '') },
            h('span.c-st.kd-st-' + tone, stText),
            h('span.c-m' + (e.method !== 'GET' ? '.mut' : ''), e.method),
            h('span.c-name', h('span.kn-path', e._u.path), h('span.kn-hostin', e._u.host), hit ? h('span.kn-hit', String(hit.count)) : null),
            h('span.c-host', e._u.host),
            h('span.c-type', typeLabel(e)),
            h('span.c-size', fmtSize(e)),
            h('span.c-time', e.pending ? '…' : fmtMs(e.timeMs)));
          if (e.failed) r.classList.add(canceled ? 'canceled' : 'failed');
          if (e.fromCache) r.classList.add('cached');
        }
        r._id = e.id; r._v = e._v; r._i = i;
        r.style.top = (i * ROW) + 'px';
        return r;
      }
      function typeLabel(e) {
        const m = { XHR: 'xhr', Fetch: 'fetch', Document: 'doc', Script: 'js', Stylesheet: 'css', Image: 'img', Font: 'font', WebSocket: 'ws', EventSource: 'sse', Media: 'media', Preflight: 'preflight', Ping: 'ping', Manifest: 'manifest' };
        return m[e.type] || String(e.type || '').toLowerCase();
      }
      let raf = 0;
      function renderList() {
        if (raf) return;
        raf = requestAnimationFrame(() => { raf = 0; doRender(); });
      }
      function doRender() {
        const n = st.rows.length;
        spacer.style.height = (n * ROW) + 'px';
        const top = list.scrollTop, hh = list.clientHeight || 400;
        const a = Math.max(0, Math.floor(top / ROW) - OVERSCAN), b = Math.min(n, Math.ceil((top + hh) / ROW) + OVERSCAN);
        const keep = new Set();
        for (let i = a; i < b; i++) {
          const e = st.rows[i];
          keep.add(e.id);
          const cur = st.rendered.get(e.id);
          if (cur && cur._v === e._v && cur._i === i && cur._sel === (e.id === st.selId) && cur._ep === st.epoch) continue;
          const r = rowEl(e, i);
          r._sel = e.id === st.selId;
          r._ep = st.epoch;
          if (r._sel) r.classList.add('sel');
          if (cur) cur.replaceWith(r); else list.appendChild(r);
          st.rendered.set(e.id, r);
        }
        for (const [id, r] of st.rendered) if (!keep.has(id)) { r.remove(); st.rendered.delete(id); }
      }
      list.addEventListener('scroll', () => {
        st.stick = list.scrollTop + list.clientHeight >= list.scrollHeight - ROW * 1.5;
        renderList();
      }, { passive: true });
      list.addEventListener('click', (ev) => {
        const r = ev.target.closest('.kn-row');
        if (!r || r.classList.contains('marker')) return;
        select(r._id);
      });
      list.addEventListener('contextmenu', (ev) => {
        const r = ev.target.closest('.kn-row');
        if (!r || r.classList.contains('marker')) return;
        ev.preventDefault();
        select(r._id);
        rowMenu(r._id, { x: ev.clientX, y: ev.clientY });
      });
      list.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { moveSel(1); e.preventDefault(); }
        else if (e.key === 'ArrowUp') { moveSel(-1); e.preventDefault(); }
        else if (e.key === 'PageDown') { moveSel(Math.floor(list.clientHeight / ROW)); e.preventDefault(); }
        else if (e.key === 'PageUp') { moveSel(-Math.floor(list.clientHeight / ROW)); e.preventDefault(); }
        else if (e.key === 'Escape') { closeDetail(); e.preventDefault(); }
        else if (e.key === 'End') { const last = st.rows.filter((x) => !x.marker).pop(); if (last) select(last.id); e.preventDefault(); }
        else if (e.key === 'Home') { const first = st.rows.find((x) => !x.marker); if (first) select(first.id); e.preventDefault(); }
      });
      function moveSel(d) {
        const idx = st.rows.findIndex((x) => x.id === st.selId);
        let i = idx < 0 ? (d > 0 ? -1 : st.rows.length) : idx;
        for (let step = 0; step < Math.abs(d) || (st.rows[i] && st.rows[i].marker); step++) {
          i += d > 0 ? 1 : -1;
          if (i < 0 || i >= st.rows.length) { i = Math.max(0, Math.min(st.rows.length - 1, i)); break; }
        }
        const e = st.rows[i];
        if (e && !e.marker) { select(e.id); scrollToRow(i); }
      }
      function scrollToRow(i) {
        const y = i * ROW;
        if (y < list.scrollTop) list.scrollTop = y;
        else if (y + ROW > list.scrollTop + list.clientHeight) list.scrollTop = y + ROW - list.clientHeight;
      }

      function renderEmpty() {
        U.clear(emptyEl);
        const visibleRows = st.rows.filter((x) => !x.marker).length;
        if (visibleRows) { emptyEl.hidden = true; return; }
        emptyEl.hidden = false;
        const info = st.info;
        if (!st.tabId || !info) { emptyEl.appendChild(api.empty({ icon: 'activity', title: 'Нет вкладки', text: 'Откройте страницу, чтобы смотреть её запросы.' })); return; }
        if (info.discarded) { emptyEl.appendChild(api.empty({ icon: 'moon', title: 'Вкладка выгружена', text: 'Откройте её — запись продолжится.' })); return; }
        if (info.mode === 'off') {
          const on = h('button.k-btn.k-btn-primary', { type: 'button' }, 'Записывать эту вкладку');
          on.addEventListener('click', () => api.invoke('kosmo:net.capture', { tabId: st.tabId, mode: 'api' }).then(() => watchTab(st.tabId, true)).catch(fail));
          emptyEl.appendChild(api.empty({ icon: 'activity', title: 'Запись сети выключена', text: 'Включите в настройках «Инструменты разработчика» или только для этой вкладки.', actions: [on] }));
          return;
        }
        const anyReq = st.all.some((x) => !x.marker);
        if (anyReq) {
          const reset = h('button.k-btn', { type: 'button' }, 'Сбросить фильтры');
          reset.addEventListener('click', () => { filterIn.value = ''; st.kind = 'all'; st.jsonOnly = false; st.hits = null; ls.set('kind', 'all'); ls.set('json', false); applyFilter.flush(); toggleBodySearch(false); });
          let text = 'Под фильтр ничего не подходит.';
          if (info.mode === 'api' && ['js', 'css', 'img', 'font'].includes(st.kind)) text = 'В режиме записи «API» скрипты, стили, картинки и шрифты не сохраняются. Переключите запись на «Всё» в меню «Ещё».';
          emptyEl.appendChild(api.empty({ icon: 'filter', title: 'Нет подходящих запросов', text, actions: [reset] }));
          return;
        }
        const reload = h('button.k-btn', { type: 'button' }, U.icon('rotate-cw', 14), 'Обновить страницу');
        reload.addEventListener('click', () => api.invoke('kosmo:tabs.reload', { id: st.tabId }).catch(fail));
        emptyEl.appendChild(api.empty({ icon: 'activity', title: info.paused ? 'Запись на паузе' : 'Запросов пока нет', text: info.paused ? 'Новые запросы не сохраняются, пока пауза включена.' : 'Обновите страницу или поработайте с сайтом — запросы появятся здесь.', actions: info.paused ? [] : [reload] }));
      }

      function renderStatus() {
        const info = st.info || {};
        const reqs = st.all.filter((x) => !x.marker);
        const shown = st.rows.filter((x) => !x.marker);
        let bytes = 0;
        for (const e of shown) bytes += e.size || 0;
        U.clear(status);
        const modeTitle = { off: 'выключена', api: 'API', all: 'всё' }[info.mode] || '—';
        const modeBtn = h('button.kn-mode', { type: 'button', title: 'Режим записи сети' }, U.icon('circle-dot', 11), 'Запись: ' + modeTitle);
        modeBtn.classList.toggle('off', info.mode === 'off' || !!info.paused);
        modeBtn.addEventListener('click', (e) => modeMenu(e.currentTarget));
        U.append(status, [
          h('span', shown.length === reqs.length ? `${reqs.length} ${U.plural(reqs.length, ['запрос', 'запроса', 'запросов'])}` : `${shown.length} из ${reqs.length}`),
          h('span.kn-dot', '·'), h('span', U.formatBytes(bytes)),
          info.paused ? h('span.kn-paused', 'пауза') : null,
          h('span.kn-grow'), modeBtn]);
      }

      function updateBar() {
        const info = st.info || {};
        recBtn.classList.toggle('paused', !!info.paused);
        recBtn.title = info.paused ? 'Продолжить запись' : 'Пауза записи';
        recBtn.setAttribute('aria-pressed', info.paused ? 'true' : 'false');
        notice.hidden = true;
        renderStatus();
      }

      // ---------- действия журнала ----------
      function fail(e) { api.toast(D.errText(e), { tone: 'danger', ms: 3500 }); }
      function togglePause() {
        if (!st.tabId) return;
        const v = !(st.info && st.info.paused);
        api.invoke('kosmo:net.pause', { tabId: st.tabId, paused: v }).then((r) => { if (st.info) st.info.paused = r; updateBar(); renderEmpty(); }).catch(fail);
      }
      function clearLog() {
        if (!st.tabId) return;
        api.invoke('kosmo:net.clear', { tabId: st.tabId }).then(() => { closeDetail(); watchTab(st.tabId, true); }).catch(fail);
      }
      function exportHar(ids) {
        if (!st.tabId) return;
        api.toast('Собираю HAR…');
        api.invoke('kosmo:net.exportHar', { tabId: st.tabId, ids }).then((r) => {
          if (r && r.path) api.toast(`HAR сохранён: ${r.count} ${U.plural(r.count, ['запрос', 'запроса', 'запросов'])}`, { tone: 'ok', ms: 3000 });
        }).catch(fail);
      }
      function moreMenu(anchor) {
        const preserve = !(st.info && st.info.preserve === false);
        D.menu([
          { title: 'Сохранять журнал при переходах', icon: preserve ? 'check' : null, onPick: () => api.invoke('kosmo:settings.set', { path: 'devtools.preserveLog', value: !preserve }).then(() => { if (st.info) st.info.preserve = !preserve; }).catch(fail) },
          { sep: true },
          { title: 'Сохранить HAR (все)', icon: 'download', onPick: () => exportHar(null) },
          { title: 'Сохранить HAR (отфильтрованные)', icon: 'download', disabled: !st.rows.length, onPick: () => exportHar(st.rows.filter((x) => !x.marker).map((x) => x.id)) },
          { sep: true },
          { label: 'Запись сети' },
          ...modeItems()
        ], anchor);
      }
      function modeItems() {
        const g = st.info ? st.info.globalMode : 'api';
        const set = (m) => api.invoke('kosmo:settings.set', { path: 'devtools.capture', value: m }).then(() => setTimeout(() => watchTab(st.tabId, true), 150)).catch(fail);
        return [
          { title: 'API — XHR, fetch, документы, WS', icon: g === 'api' ? 'check' : null, onPick: () => set('api') },
          { title: 'Всё — и скрипты, стили, картинки', icon: g === 'all' ? 'check' : null, onPick: () => set('all') },
          { title: 'Выключена', icon: g === 'off' ? 'check' : null, onPick: () => set('off') }
        ];
      }
      function modeMenu(anchor) { D.menu([{ label: 'Запись сети (для всех вкладок)' }, ...modeItems()], anchor); }

      // ---------- поиск по телам ----------
      function toggleBodySearch(v) {
        const show = v == null ? bsBar.hidden : !!v;
        bsBar.hidden = !show;
        bodySearchBtn.setAttribute('aria-pressed', show ? 'true' : 'false');
        if (show) bsIn.focus();
        else if (st.hits) { st.hits = null; st.hitQuery = ''; bsInfo.textContent = ''; st.epoch++; refilter(); }
      }
      let bsSeq = 0;
      function runBodySearch() {
        const q = bsIn.value.trim();
        if (!q) { st.hits = null; st.hitQuery = ''; bsInfo.textContent = ''; st.epoch++; refilter(); return; }
        const prevHits = st.hits;
        st.hits = null;
        const ids = st.all.filter((e) => !e.marker && passes(e)).map((e) => e.id);
        st.hits = prevHits;
        const my = ++bsSeq;
        bsInfo.textContent = `ищу в ${ids.length}…`;
        bsInfo.classList.add('busy');
        api.invoke('kosmo:net.searchBodies', { tabId: st.tabId, ids, query: q }).then((r) => {
          if (my !== bsSeq) return;
          bsInfo.classList.remove('busy');
          st.hits = new Map(r.matches.map((m) => [m.id, m]));
          st.hitQuery = q;
          st.epoch++;
          bsInfo.textContent = `найдено в ${r.matches.length} из ${r.searched}` + (r.unavailable ? `, без тела ${r.unavailable}` : '');
          refilter();
        }).catch((e) => { bsInfo.classList.remove('busy'); bsInfo.textContent = ''; fail(e); });
      }
      bsIn.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { runBodySearch(); e.preventDefault(); }
        if (e.key === 'Escape') { toggleBodySearch(false); e.stopPropagation(); }
      });

      // ---------- детали ----------
      const dv = { el: detail, entry: null, tab: st.detailTab, mode: 'tabs', bodyCache: null, replay: null };
      function select(id) {
        if (!st.byId.has(id)) return;
        const prev = st.selId;
        st.selId = id;
        for (const r of st.rendered.values()) { const on = r._id === id; if (on !== r._sel) { r._sel = on; r.classList.toggle('sel', on); r.setAttribute('aria-selected', on ? 'true' : 'false'); } }
        if (prev !== id || detail.hidden) openDetail(id);
      }
      function closeDetail() {
        st.selId = null;
        detail.hidden = true;
        splitH.hidden = true;
        dv.entry = null; dv.replay = null; dv.mode = 'tabs';
        for (const r of st.rendered.values()) if (r._sel) { r._sel = false; r.classList.remove('sel'); }
        applyLayout();
      }
      async function getDetail(id) {
        const c = st.detailCache.get(id);
        if (c) return c;
        const d = await api.invoke('kosmo:net.entry', { tabId: st.tabId, id });
        if (d && !d.pending) st.detailCache.set(id, d);
        return d;
      }
      function reqOf(d, headers) {
        return { method: d.method, url: d.url, headers: headers || d.requestHeaders, body: d.postData, responseMime: d.mime };
      }
      let detailSeq = 0;
      function openDetail(id) {
        const e = st.byId.get(id);
        if (!e) return;
        const was = detail.hidden;
        detail.hidden = false;
        if (was) applyLayout();
        dv.mode = 'tabs'; dv.replay = null; dv.bodyCache = null;
        renderDetail(e, null);
        const my = ++detailSeq;
        getDetail(id).then((d) => { if (my === detailSeq && st.selId === id) renderDetail(e, d); }).catch((err) => { if (my === detailSeq) renderDetail(e, { error: D.errText(err) }); });
      }
      function refreshDetailHead() {
        const e = st.byId.get(st.selId);
        if (!e || detail.hidden || dv.mode !== 'tabs') return;
        const my = ++detailSeq;
        st.detailCache.delete(e.id);
        getDetail(e.id).then((d) => { if (my === detailSeq && st.selId === e.id) renderDetail(e, d, true); }).catch(() => {});
      }

      function renderDetail(e, d, keepTab) {
        dv.entry = d && !d.error ? d : null;
        U.clear(detail);
        const tone = D.statusTone(e.status, e.failed);
        const close = D.iconBtn('x', 'Закрыть (Esc)', () => closeDetail());
        const headEl = h('div.kn-dhead',
          h('span.kn-dst.kd-st-' + tone, e.failed ? 'ошибка' : e.pending && !e.status ? '…' : String(e.status)),
          h('span.kn-dm', e.method),
          h('span.kn-durl', { title: e.url }, e._u.host + e._u.path),
          close);
        const copyBtn = h('button.k-btn.k-btn-sm', { type: 'button', disabled: !dv.entry }, U.icon('copy', 13), 'Копировать', U.icon('chevron-down', 12));
        copyBtn.addEventListener('click', () => copyMenu(copyBtn));
        const replayBtn = h('button.k-btn.k-btn-sm', { type: 'button', disabled: !dv.entry || e.kind === 'ws', title: 'Выполнить запрос ещё раз из страницы (её cookies)' }, U.icon('repeat', 13), 'Повторить');
        replayBtn.addEventListener('click', () => replay());
        const editBtn = h('button.k-btn.k-btn-sm', { type: 'button', disabled: !dv.entry || e.kind === 'ws', title: 'Изменить и отправить' }, U.icon('pencil', 13), 'Изменить');
        editBtn.addEventListener('click', () => openEditor());
        const claudeBtn = h('button.k-btn.k-btn-sm', { type: 'button', disabled: !dv.entry, title: 'Сохранить запрос и ответ в markdown для Claude' }, U.icon('claude', 13), 'Claude');
        claudeBtn.addEventListener('click', () => giveClaude());
        const actions = h('div.kn-dactions', copyBtn, replayBtn, editBtn, claudeBtn);
        detail.append(headEl, actions);
        if (!d) { detail.appendChild(h('div.kd-loading', h('span.k-spinner'), 'Загружаю…')); return; }
        if (d.error) { detail.appendChild(api.empty({ icon: 'alert-triangle', title: 'Не удалось открыть запрос', text: d.error, tone: 'error' })); return; }
        const tabs = [['headers', 'Заголовки'], ['params', 'Параметры'], ['response', e.kind === 'ws' ? 'Сообщения' : 'Ответ'], ['timing', 'Тайминги']];
        if (!tabs.some(([k]) => k === dv.tab)) dv.tab = 'response';
        const tabsEl = h('div.k-tabs.kn-dtabs', { role: 'tablist' });
        const bodyEl = h('div.kn-dbody');
        for (const [k, title] of tabs) {
          const b = h('button', { type: 'button', role: 'tab', 'aria-selected': dv.tab === k ? 'true' : 'false' }, title);
          b.addEventListener('click', () => { dv.tab = k; ls.set('dtab', k); for (const x of tabsEl.children) x.setAttribute('aria-selected', x === b ? 'true' : 'false'); renderTab(e, d, bodyEl); });
          tabsEl.appendChild(b);
        }
        detail.append(tabsEl, bodyEl);
        renderTab(e, d, bodyEl);
      }

      function renderTab(e, d, box) {
        U.clear(box);
        box.scrollTop = 0;
        if (dv.tab === 'headers') return renderHeaders(e, d, box);
        if (dv.tab === 'params') return renderParams(e, d, box);
        if (dv.tab === 'timing') return renderTiming(e, d, box);
        if (e.kind === 'ws') return renderFrames(e, d, box);
        return renderResponse(e, d, box);
      }

      function headersText(hh) { return C.headerPairs(hh).map(([k, v]) => k + ': ' + v).join('\n'); }
      function renderHeaders(e, d, box) {
        const general = [['URL', d.url], ['Метод', d.method], ['Статус', d.failed ? 'ошибка: ' + d.errorText : (d.status + ' ' + (d.statusText || '')).trim()]];
        if (d.remote) general.push(['Адрес сервера', d.remote]);
        if (d.protocol) general.push(['Протокол', d.protocol]);
        if (d.fromCache) general.push(['Кэш', 'ответ из кэша']);
        if (d.initiator) general.push(['Инициатор', (d.initiator.url ? d.initiator.url + (d.initiator.line ? ':' + d.initiator.line : '') : d.initiator.type) + (d.initiator.fn ? ' (' + d.initiator.fn + ')' : '')]);
        if (d.priority) general.push(['Приоритет', d.priority]);
        if (d.blockedReason) general.push(['Заблокирован', d.blockedReason]);
        if (d.corsError) general.push(['CORS', d.corsError]);
        if (d.blockedCookies) general.push(['Cookies', 'заблокировано: ' + d.blockedCookies]);
        const copyAll = (hh) => D.iconBtn('copy', 'Копировать все', () => U.copyText(headersText(hh)));
        const resp = C.headerPairs(d.responseHeaders).sort((a, b) => a[0].localeCompare(b[0]));
        const req = C.headerPairs(d.requestHeaders).filter(([k]) => k.charAt(0) !== ':').sort((a, b) => a[0].localeCompare(b[0]));
        box.append(
          D.section('Общее', D.kvTable(general)),
          D.section('Заголовки ответа', D.kvTable(resp, { empty: e.pending ? 'Ответ ещё не получен' : 'Нет заголовков' }), { meta: resp.length, actions: [copyAll(d.responseHeaders)] }),
          D.section('Заголовки запроса', h('div', d.provisionalHeaders && req.length ? h('div.kd-note.kn-prov', U.icon('info', 14), 'Предварительные заголовки: браузер мог добавить cookies и другие при отправке.') : null, D.kvTable(req)), { meta: req.length, actions: [copyAll(d.requestHeaders)] })
        );
      }

      // тело запроса: JSON — деревом, форма — таблицей, остальное — текстом
      function bodyView(text, mime) {
        const j = D.tryJson(text);
        if (j.ok && j.value !== null && typeof j.value === 'object') return { el: D.jsonTree(j.value).el };
        if (/x-www-form-urlencoded/.test(mime || '')) return { el: D.kvTable(C.parseForm(text)) };
        return { el: h('pre.kn-pre', String(text).length > TEXT_VIEW_LIMIT ? String(text).slice(0, TEXT_VIEW_LIMIT) + '\n…' : String(text)) };
      }

      function renderParams(e, d, box) {
        const q = C.parseQuery(d.url);
        box.appendChild(D.section('Параметры адреса', D.kvTable(q, { empty: 'Нет параметров в адресе' }), { meta: q.length || '' }));
        const ct = C.headerGet(d.requestHeaders, 'content-type') || '';
        let bodyEl;
        if (d.postData != null && d.postData !== '') bodyEl = bodyView(d.postData, ct).el;
        else if (d.hasPostData) bodyEl = h('div.kd-kv-empty', 'Тело запроса недоступно (слишком большое или двоичное).');
        else bodyEl = h('div.kd-kv-empty', d.method === 'GET' ? 'У GET-запроса нет тела.' : 'Тела нет.');
        const actions = d.postData ? [D.iconBtn('copy', 'Копировать тело', () => U.copyText(d.postData))] : [];
        box.appendChild(D.section('Тело запроса' + (ct ? ' · ' + ct.split(';')[0] : ''), bodyEl, { actions }));
      }

      function renderTiming(e, d, box) {
        const t = d.timing || { phases: [] };
        const total = t.total || 0;
        const rows = h('div.kn-timing');
        if (!t.phases.length) rows.appendChild(h('div.kd-kv-empty', e.pending ? 'Запрос ещё выполняется.' : e.fromCache ? 'Ответ из кэша — сетевых этапов нет.' : 'Нет данных о таймингах.'));
        const max = Math.max(total, ...t.phases.map((p) => p.start + p.dur), 1);
        for (const p of t.phases) {
          const bar = h('span.kn-tbar.ph-' + p.id, { style: { left: (p.start / max * 100) + '%', width: Math.max(0.6, p.dur / max * 100) + '%' } });
          rows.appendChild(h('div.kn-trow', h('span.kn-tl', p.label), h('span.kn-ttrack', bar), h('span.kn-tv', fmtMs(p.dur))));
        }
        const info = [['Начало', new Date(d.ts).toLocaleString('ru-RU') + '.' + String(d.ts % 1000).padStart(3, '0')], ['Всего', fmtMs(total)]];
        if (t.ttfb != null) info.push(['До первого байта', fmtMs(t.ttfb)]);
        info.push(['Передано', d.size ? U.formatBytes(d.size) : '—']);
        box.append(D.section('Этапы', rows), D.section('Итого', D.kvTable(info, { mono: false, copy: false })));
      }

      function renderFrames(e, d, box) {
        const frames = d.messages || [];
        const refresh = D.iconBtn('rotate-cw', 'Обновить', () => { st.detailCache.delete(e.id); getDetail(e.id).then((nd) => { d.messages = nd.messages; renderTab(e, d, box); }).catch(fail); });
        const list2 = h('div.kn-frames');
        if (!frames.length) list2.appendChild(h('div.kd-kv-empty', 'Сообщений пока нет.'));
        for (const f of frames.slice().reverse()) {
          const j = D.tryJson(f.data);
          const fr = h('div.kn-frame.' + f.dir,
            h('span.kn-fdir', U.icon(f.dir === 'out' ? 'arrow-up' : f.dir === 'in' ? 'arrow-down' : 'alert-circle', 12)),
            h('span.kn-ftime', timeOf(f.ts)),
            f.event ? h('span.kn-fev', f.event) : null,
            h('span.kn-fdata', f.data.length > 300 ? f.data.slice(0, 300) + '…' : f.data),
            h('span.kn-flen', U.formatBytes(f.len)));
          fr.addEventListener('click', () => {
            const open = fr.nextSibling && fr.nextSibling.classList && fr.nextSibling.classList.contains('kn-fbody');
            if (open) { fr.nextSibling.remove(); return; }
            const b = h('div.kn-fbody', j.ok && typeof j.value === 'object' && j.value ? D.jsonTree(j.value).el : h('pre.kn-pre', f.data));
            fr.after(b);
          });
          list2.appendChild(fr);
        }
        box.appendChild(D.section(`Сообщения (последние ${frames.length})`, list2, { meta: d.frames || '', actions: [refresh] }));
      }

      // Ответ: дерево JSON / текст / превью картинки, поиск, путь и копирование
      function renderResponse(e, d, box) {
        if (e.pending) { box.appendChild(h('div.kd-loading', h('span.k-spinner'), 'Ответ ещё загружается…')); return; }
        if (e.failed) { box.appendChild(api.empty({ icon: 'alert-triangle', title: 'Запрос не выполнен', text: e.errorText || 'ошибка', tone: 'error' })); return; }
        if (e.redirect) { box.appendChild(api.empty({ icon: 'arrow-right', title: 'Перенаправление', text: 'Куда: ' + (C.headerGet(d.responseHeaders, 'location') || '—') })); return; }
        const holder = h('div.kn-resp');
        box.appendChild(holder);
        holder.appendChild(h('div.kd-loading', h('span.k-spinner'), 'Загружаю тело…'));
        const id = e.id;
        const p = dv.bodyCache && dv.bodyCache.id === id ? Promise.resolve(dv.bodyCache.r) : api.invoke('kosmo:net.body', { tabId: st.tabId, id });
        p.then((r) => {
          if (st.selId !== id) return;
          dv.bodyCache = { id, r };
          U.clear(holder);
          responseView(holder, r, e.mime || r.mime || '', { searchInit: st.hits && st.hits.get(id) ? st.hitQuery : '' });
        }).catch((err) => {
          if (st.selId !== id) return;
          U.clear(holder);
          holder.appendChild(api.empty({ icon: 'file', title: 'Тело недоступно', text: D.errText(err) }));
        });
      }

      // r = {body, base64Encoded, truncated}; общий вид для ответа, повтора и редактора
      function responseView(holder, r, mime, opts) {
        opts = opts || {};
        const isImg = /^image\//.test(mime);
        const text = r.base64Encoded ? null : String(r.body || '');
        const j = text != null ? D.tryJson(text) : { ok: false };
        const isTree = j.ok && j.value !== null && typeof j.value === 'object';
        const modes = [];
        if (isTree) modes.push(['tree', 'Дерево']);
        if (text != null) modes.push(['text', 'Текст']);
        if (isImg) modes.push(['preview', 'Картинка']);
        if (!modes.length) { holder.appendChild(api.empty({ icon: 'file', title: 'Двоичный ответ', text: (mime || 'тип не указан') + ' · ' + U.formatBytes(Math.floor((r.body || '').length * 3 / 4)) })); return; }
        let mode = isImg ? 'preview' : isTree ? 'tree' : 'text';
        let tree = null;
        const tools = h('div.kn-rtools');
        const content = h('div.kn-rcontent');
        const pathBar = h('div.kn-pathbar', { hidden: true });
        const segEl = D.seg(modes, (m) => { mode = m; segEl.set(m); draw(); }, { small: true, label: 'Вид ответа' });
        const sIn = h('input.k-input.k-input-sm.kn-rsearch', { type: 'text', spellcheck: 'false', placeholder: 'Найти в ответе', value: opts.searchInit || '' });
        const sCount = h('span.kn-rcount');
        const prev = D.iconBtn('chevron-up', 'Предыдущее (Shift+Enter)', () => step(-1));
        const next = D.iconBtn('chevron-down', 'Следующее (Enter)', () => step(1));
        const expand = D.iconBtn('chevrons-up-down', 'Развернуть всё', () => { if (tree) tree.expandAll(4000); });
        const collapse = D.iconBtn('chevrons-down-up', 'Свернуть всё', () => { if (tree) tree.collapseAll(); });
        const copyAll = D.iconBtn('copy', 'Копировать ответ', () => U.copyText(isTree ? JSON.stringify(j.value, null, 2) : text || ''));
        tools.append(segEl, h('label.k-search.kn-rsearch-box', U.icon('search', 13), sIn), sCount, prev, next, h('span.kn-grow'), expand, collapse, copyAll);
        holder.append(tools, content, pathBar);
        if (r.truncated) holder.insertBefore(h('div.kd-note.warn', U.icon('alert-triangle', 14), 'Ответ обрезан — показана только часть.'), content);
        segEl.set(mode);

        function showPath(path, value) {
          const pth = C.jsonPath(path);
          U.clear(pathBar);
          pathBar.hidden = false;
          const vs = typeof value === 'string' ? value : JSON.stringify(value);
          pathBar.append(
            h('code.kn-path-text', { title: pth || '(корень)' }, pth || '(корень)'),
            h('button.k-btn.k-btn-sm.k-btn-ghost', { type: 'button', onClick: () => U.copyText(pth, { message: 'Путь скопирован' }) }, 'Путь'),
            h('button.k-btn.k-btn-sm.k-btn-ghost', { type: 'button', onClick: () => U.copyText(typeof value === 'string' ? value : JSON.stringify(value, null, 2), { message: 'Значение скопировано' }) }, 'Значение'),
            h('span.kn-path-v', { title: vs.slice(0, 500) }, vs.length > 80 ? vs.slice(0, 80) + '…' : vs));
        }
        let textMarks = [], textIdx = -1;
        function draw() {
          U.clear(content);
          tree = null; textMarks = []; textIdx = -1;
          expand.hidden = collapse.hidden = mode !== 'tree';
          sIn.disabled = prev.disabled = next.disabled = mode === 'preview';
          pathBar.hidden = true;
          if (mode === 'tree') {
            tree = D.jsonTree(j.value, { onSelect: showPath });
            content.appendChild(tree.el);
          } else if (mode === 'text') {
            const shown = isTree ? JSON.stringify(j.value, null, 2) : D.prettyBody(text, mime);
            const pre = h('pre.kn-pre');
            pre.textContent = shown.length > TEXT_VIEW_LIMIT ? shown.slice(0, TEXT_VIEW_LIMIT) + '\n… (показано ' + U.formatBytes(TEXT_VIEW_LIMIT) + ')' : shown;
            content.appendChild(pre);
          } else {
            const src = r.base64Encoded ? 'data:' + mime + ';base64,' + r.body : 'data:' + (mime || 'image/svg+xml') + ',' + encodeURIComponent(text || '');
            const img = h('img.kn-img', { src, alt: 'Ответ', draggable: 'false' });
            const meta = h('div.kn-imgmeta');
            img.addEventListener('load', () => { meta.textContent = img.naturalWidth + ' × ' + img.naturalHeight + ' · ' + mime; });
            img.addEventListener('error', () => { meta.textContent = 'Не удалось показать картинку'; });
            content.append(h('div.kn-imgbox', img), meta);
          }
          if (sIn.value) search();
        }
        function search() {
          const q = sIn.value;
          if (mode === 'tree' && tree) {
            const n = tree.search(q);
            sCount.textContent = q ? (n ? '' : 'нет') : '';
            if (n) { const r2 = tree.next(1); sCount.textContent = (r2.index + 1) + ' из ' + r2.total + (n >= 1000 ? '+' : ''); }
          } else if (mode === 'text') {
            const pre = content.querySelector('pre');
            if (!pre) return;
            const raw = pre.textContent;
            textMarks = []; textIdx = -1;
            if (!q) { pre.textContent = raw; sCount.textContent = ''; return; }
            const low = raw.toLowerCase(), ql = q.toLowerCase();
            let html = '', i = 0, k = low.indexOf(ql), n = 0;
            while (k >= 0 && n < 2000) { html += esc(raw.slice(i, k)) + '<mark>' + esc(raw.slice(k, k + q.length)) + '</mark>'; i = k + q.length; k = low.indexOf(ql, i); n++; }
            html += esc(raw.slice(i));
            pre.innerHTML = html;
            textMarks = Array.from(pre.querySelectorAll('mark'));
            sCount.textContent = n ? '' : 'нет';
            if (n) step(1);
          }
        }
        function step(dir) {
          if (mode === 'tree' && tree) { const r2 = tree.next(dir); if (r2.total) sCount.textContent = (r2.index + 1) + ' из ' + r2.total; return; }
          if (!textMarks.length) return;
          if (textMarks[textIdx]) textMarks[textIdx].classList.remove('cur');
          textIdx = (textIdx + (dir < 0 ? -1 : 1) + textMarks.length) % textMarks.length;
          textMarks[textIdx].classList.add('cur');
          textMarks[textIdx].scrollIntoView({ block: 'center' });
          sCount.textContent = (textIdx + 1) + ' из ' + textMarks.length;
        }
        const searchDeb = U.debounce(search, 200);
        sIn.addEventListener('input', searchDeb);
        sIn.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') { searchDeb.cancel(); if (!sCount.textContent || sCount.textContent === 'нет') search(); else step(ev.shiftKey ? -1 : 1); ev.preventDefault(); }
          if (ev.key === 'Escape' && sIn.value) { sIn.value = ''; search(); ev.stopPropagation(); }
        });
        draw();
      }

      // ---------- копирование, повтор, редактор, Claude ----------
      function copyMenu(anchor) {
        const d = dv.entry;
        if (!d) return;
        D.menu(C.CODEGEN.map((g) => ({ title: g.title, icon: g.id === 'url' ? 'link' : 'code', onPick: () => U.copyText(C.codegen(g.id, reqOf(d)), { message: 'Скопировано: ' + g.title }) }))
          .concat([{ sep: true }, { title: 'Ответ', icon: 'file-json', disabled: d.kind === 'ws', onPick: () => copyResponse(d.id) }]), anchor);
      }
      function copyResponse(id) {
        api.invoke('kosmo:net.body', { tabId: st.tabId, id }).then((r) => {
          if (r.base64Encoded) { api.toast('Ответ двоичный — копировать нечего'); return; }
          U.copyText(r.body, { message: 'Ответ скопирован' });
        }).catch(fail);
      }
      function rowMenu(id, at) {
        const e = st.byId.get(id);
        if (!e) return;
        getDetail(id).then((d) => {
          dv.entry = d;
          const host = e._u.host;
          D.menu([
            { label: 'Копировать как' },
            ...C.CODEGEN.map((g) => ({ title: g.title, icon: g.id === 'url' ? 'link' : 'code', onPick: () => U.copyText(C.codegen(g.id, reqOf(d)), { message: 'Скопировано: ' + g.title }) })),
            { title: 'Ответ', icon: 'file-json', disabled: e.kind === 'ws' || e.pending || e.failed, onPick: () => copyResponse(id) },
            { sep: true },
            { title: 'Повторить', icon: 'repeat', disabled: e.kind === 'ws', onPick: () => replay() },
            { title: 'Изменить и отправить', icon: 'pencil', disabled: e.kind === 'ws', onPick: () => openEditor() },
            { title: 'Отдать Claude', icon: 'claude', onPick: () => giveClaude() },
            { sep: true },
            { title: 'Только ' + host, icon: 'filter', disabled: !host, onPick: () => { filterIn.value = 'domain:' + host; applyFilter.flush(); } },
            { title: 'Скрыть ' + host, icon: 'eye-off', disabled: !host, onPick: () => { filterIn.value = (filterIn.value + ' -domain:' + host).trim(); applyFilter.flush(); } }
          ], at);
        }).catch(fail);
      }

      function replay() {
        const d = dv.entry;
        if (!d) return;
        const req = { method: d.method, url: d.url, headers: C.replayHeaders(d.requestHeaders), body: d.postData };
        send(req, 'Повтор');
      }
      function send(req, label) {
        dv.mode = 'result';
        const e = st.byId.get(st.selId);
        U.clear(detail);
        const back = D.iconBtn('arrow-left', 'К запросу', () => { if (e) { dv.mode = 'tabs'; getDetail(e.id).then((d2) => renderDetail(e, d2)).catch(fail); } });
        const headEl = h('div.kn-dhead', back, h('span.kn-dm', req.method), h('span.kn-durl', { title: req.url }, splitUrl(req.url).host + splitUrl(req.url).path), D.iconBtn('x', 'Закрыть', () => closeDetail()));
        const resBox = h('div.kn-dbody.kn-result');
        resBox.appendChild(h('div.kd-loading', h('span.k-spinner'), label + ': отправляю из страницы…'));
        detail.append(headEl, resBox);
        api.invoke('kosmo:net.fetch', Object.assign({ tabId: st.tabId }, req)).then((r) => {
          if (dv.mode !== 'result') return;
          dv.replay = { request: req, response: r };
          renderResult(resBox, req, r, label);
        }).catch((err) => { U.clear(resBox); resBox.appendChild(api.empty({ icon: 'alert-triangle', title: 'Не отправлено', text: D.errText(err), tone: 'error' })); });
      }
      function renderResult(box, req, r, label) {
        U.clear(box);
        const tone = r.error ? 'err' : D.statusTone(r.status, false);
        const claudeBtn = h('button.k-btn.k-btn-sm', { type: 'button' }, U.icon('claude', 13), 'Claude');
        claudeBtn.addEventListener('click', () => giveClaude());
        const editBtn = h('button.k-btn.k-btn-sm', { type: 'button' }, U.icon('pencil', 13), 'Изменить');
        editBtn.addEventListener('click', () => openEditor(req));
        const againBtn = h('button.k-btn.k-btn-sm', { type: 'button' }, U.icon('repeat', 13), 'Ещё раз');
        againBtn.addEventListener('click', () => send(req, label));
        box.appendChild(h('div.kn-rsum',
          h('span.kn-dst.kd-st-' + tone, r.error ? 'ошибка' : String(r.status)),
          h('span', r.error ? r.error : (r.statusText || '') + ' · ' + fmtMs(r.timeMs) + (r.size != null ? ' · ' + U.formatBytes(r.size) : '')),
          h('span.kn-grow'), againBtn, editBtn, claudeBtn));
        if (r.error) {
          box.appendChild(h('div.kd-note.warn', U.icon('alert-triangle', 14), /fetch/i.test(r.error) ? 'Запрос не дошёл: сеть, CORS или политика CSP сайта. Подробности — в консоли DevTools.' : r.error));
          return;
        }
        const rh = C.headerPairs(r.headers);
        const holder = h('div.kn-resp');
        box.append(holder);
        responseView(holder, r, C.headerGet(r.headers, 'content-type') || '');
        box.appendChild(D.section('Заголовки ответа', D.kvTable(rh), { meta: rh.length, collapsed: true }));
      }

      function openEditor(pre) {
        const d = dv.entry;
        if (!d && !pre) return;
        const req = pre || { method: d.method, url: d.url, headers: C.replayHeaders(d.requestHeaders), body: d.postData };
        dv.mode = 'editor';
        const e = st.byId.get(st.selId);
        U.clear(detail);
        const back = D.iconBtn('arrow-left', 'К запросу', () => { if (e) { dv.mode = 'tabs'; getDetail(e.id).then((d2) => renderDetail(e, d2)).catch(fail); } });
        detail.appendChild(h('div.kn-dhead', back, h('span.kn-dtitle', 'Изменить и отправить'), D.iconBtn('x', 'Закрыть', () => closeDetail())));
        const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
        if (!methods.includes(req.method)) methods.push(req.method);
        const mSel = h('select.k-select.k-input-sm.kn-emethod', { 'aria-label': 'Метод' }, methods.map((m) => h('option', { value: m, selected: m === req.method }, m)));
        const urlIn = h('textarea.k-textarea.kn-eurl', { spellcheck: 'false', rows: 2, 'aria-label': 'Адрес' });
        urlIn.value = req.url;
        const hdrIn = h('textarea.k-textarea.kn-ehdr', { spellcheck: 'false', 'aria-label': 'Заголовки', placeholder: 'Имя: значение — по одному на строке' });
        hdrIn.value = C.headerPairs(req.headers).map(([k, v]) => k + ': ' + v).join('\n');
        let bodyText = req.body || '';
        const j = D.tryJson(bodyText);
        if (j.ok && typeof j.value === 'object' && j.value) bodyText = JSON.stringify(j.value, null, 2);
        const bodyIn = h('textarea.k-textarea.kn-ebody', { spellcheck: 'false', 'aria-label': 'Тело', placeholder: 'Тело запроса (для GET и HEAD не отправляется)' });
        bodyIn.value = bodyText;
        const sendBtn = h('button.k-btn.k-btn-primary.k-btn-sm', { type: 'button' }, U.icon('send', 13), 'Отправить');
        const form = h('div.kn-dbody.kn-editor',
          h('div.kn-erow', mSel, urlIn),
          h('label.kn-elabel', 'Заголовки'), hdrIn,
          h('div.kn-ehint', 'Cookie, Origin, Referer и User-Agent браузер подставит сам — как при запросе со страницы.'),
          h('label.kn-elabel', 'Тело'), bodyIn,
          h('div.kn-eactions', sendBtn, h('span.kn-ehint', 'Ctrl+Enter — отправить')));
        detail.appendChild(form);
        const doSend = () => {
          const headers = {};
          for (const line of hdrIn.value.split('\n')) {
            const i = line.indexOf(':', line.startsWith(':') ? 1 : 0);
            if (i <= 0) continue;
            const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim();
            if (k) headers[k] = headers[k] != null ? headers[k] + ', ' + v : v;
          }
          let body = bodyIn.value;
          // JSON, который мы красиво развернули, отправляем компактным
          const jj = D.tryJson(body);
          if (jj.ok && j.ok && typeof jj.value === 'object' && jj.value && req.body && !/\n/.test(req.body)) body = JSON.stringify(jj.value);
          const r2 = { method: mSel.value, url: urlIn.value.trim(), headers, body: ['GET', 'HEAD'].includes(mSel.value) || body === '' ? null : body };
          send(r2, 'Отправка');
        };
        sendBtn.addEventListener('click', doSend);
        form.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { doSend(); ev.preventDefault(); } });
        urlIn.focus();
        urlIn.setSelectionRange(0, 0);
        urlIn.scrollTop = 0;
      }

      function giveClaude() {
        const id = st.selId;
        if (!id) return;
        api.invoke('kosmo:net.toClaude', { tabId: st.tabId, id, replay: dv.mode === 'result' ? dv.replay : null }).then((r) => {
          const name = String(r.path || '').split(/[\\/]/).pop();
          api.toast(r.pasted ? 'Отдано Claude: ' + name : 'Сохранено для Claude: ' + name, { tone: 'ok', ms: 3500 });
        }).catch(fail);
      }

      // ---------- вкладка ----------
      async function watchTab(tabId, force, keep) {
        if (tabId === st.tabId && !force && st.info) return;
        const my = ++st.seqLoad;
        if (tabId !== st.tabId) closeDetail();
        st.tabId = tabId;
        if (tabId == null) { load({ entries: [] }); st.info = null; renderEmpty(); return; }
        try {
          const snap = await api.invoke('kosmo:net.watch', { tabId });
          if (my !== st.seqLoad) return;
          load(snap || { entries: [] }, keep && tabId === st.tabId);
        } catch (e) { if (my === st.seqLoad) { load({ entries: [] }); fail(e); } }
      }
      api.on('kosmo:devtools.net', (b) => { if (st.visible) applyBatch(b); });
      api.onTabChange((tab, info) => {
        if (!st.visible) return;
        if (info.reason === 'activated') watchTab(tab ? tab.id : null);
      });
      api.on('kosmo:settings.changed', (c) => {
        if (!c || !c.path || !/^devtools(\.|$)/.test(c.path) || !st.visible || st.tabId == null) return;
        api.invoke('kosmo:net.list', { tabId: st.tabId }).then((snap) => {
          if (!st.info) return;
          Object.assign(st.info, { mode: snap.mode, globalMode: snap.globalMode, preserve: snap.preserve, attached: snap.attached });
          updateBar(); renderEmpty();
        }).catch(() => {});
      });

      el._show = () => {
        st.visible = true;
        const t = api.activeTab();
        watchTab(t ? t.id : null, true);
        applyLayout();
      };
      el._hide = () => {
        st.visible = false;
        D.closeMenu();
        api.invoke('kosmo:net.watch', { tabId: null }).catch(() => {});
      };
      // Ctrl+F — фильтр, когда фокус в панели
      el.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.code === 'KeyF' && !e.shiftKey) { filterIn.focus(); filterIn.select(); e.preventDefault(); e.stopPropagation(); }
      });
      // для отладки и проверок
      el._state = st;
    },
    onShow(api) { if (api.el && api.el._show) api.el._show(); },
    onHide(api) { if (api.el && api.el._hide) api.el._hide(); }
  });
})();
