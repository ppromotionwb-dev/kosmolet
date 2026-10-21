// Загрузки. Владелец: ux-chrome. Полный список (последние 200), действия, папка и «спрашивать, куда сохранять».
'use strict';
(function () {
  const U = window.KUI;
  const { h } = U;
  const I = window.KIcons;
  const $ = (id) => document.getElementById(id);

  $('kp-title').append(U.icon('download', 18), 'Загрузки');
  $('dl-search-icon').replaceWith(I.el('search', 14));
  $('dl-open-dir').append(U.icon('folder', 14), 'Открыть папку');
  const listEl = $('dl-list'), prefsEl = $('dl-prefs'), qEl = $('dl-q');

  const items = new Map();
  let q = '';
  let info = { dir: '', ask: false };
  let customDir = '';

  // ---------- форматирование ----------
  const EXT = {
    archive: ['zip', 'rar', '7z', 'gz', 'tgz', 'tar', 'bz2', 'xz'],
    image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'heic'],
    doc: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'ppt', 'pptx', 'txt', 'rtf', 'odt', 'ods', 'md'],
    code: ['js', 'json', 'ts', 'html', 'css', 'xml', 'yml', 'yaml', 'py', 'sh', 'ps1', 'bat'],
    app: ['exe', 'msi', 'apk', 'dmg', 'appx', 'msix'],
    media: ['mp3', 'mp4', 'mov', 'avi', 'mkv', 'wav', 'webm', 'ogg', 'flac'],
  };
  function extOf(name) { const m = /\.([a-z0-9]{1,6})$/i.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; }
  function fileTile(name) {
    const ext = extOf(name);
    let kind = 'other';
    for (const k of Object.keys(EXT)) if (EXT[k].includes(ext)) kind = k;
    return h('span.dl-file', { dataset: { kind } }, ext ? ext.slice(0, 4).toUpperCase() : U.icon('file', 16));
  }
  function status(r) {
    const fb = U.formatBytes;
    if (r.state === 'progressing') {
      const parts = [];
      if (r.paused) parts.push('Пауза');
      parts.push(r.total > 0 ? fb(r.received) + ' из ' + fb(r.total) : fb(r.received));
      if (!r.paused && r.speed > 0) {
        parts.push(fb(r.speed) + '/с');
        if (r.total > 0) parts.push('осталось ' + U.formatMs(((r.total - r.received) / r.speed) * 1000));
      }
      return parts.join(' · ');
    }
    if (r.state === 'completed') return (r.exists === false ? 'Файл удалён или перемещён · ' : '') + fb(r.total || r.received) + ' · ' + U.formatTime(r.endTime || r.startTime);
    if (r.state === 'cancelled') return 'Отменено';
    return 'Прервано' + (r.received ? ' на ' + fb(r.received) : '');
  }
  function shortUrl(u) {
    try { const x = new URL(u); if (x.protocol === 'data:' || x.protocol === 'blob:') return x.protocol.slice(0, -1); return U.hostToUnicode(x.hostname) + x.pathname; } catch (e) { return String(u || ''); }
  }
  const dayFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  function dayTitle(ts) {
    const d = new Date(ts), now = new Date();
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === now.toDateString()) return 'Сегодня';
    if (d.toDateString() === y.toDateString()) return 'Вчера';
    return dayFmt.format(d);
  }
  function clean(e) { return String((e && e.message) || e || '').replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '').replace(/^./, (c) => c.toUpperCase()); }

  // ---------- строки ----------
  function btn(act, icon, text, title) {
    return h('button.k-btn.k-btn-ghost', { type: 'button', title: title || text, dataset: { act } }, U.icon(icon, 14), text);
  }
  function actions(r) {
    if (r.state === 'progressing') return [r.paused ? btn('resume', 'play', 'Продолжить') : btn('pause', 'pause', 'Пауза'), btn('cancel', 'x', 'Отменить')];
    const out = [];
    if (r.state === 'completed' && r.exists !== false) out.push(btn('show', 'folder', 'В папке', 'Показать в папке'));
    else out.push(btn('retry', 'rotate-cw', 'Повторить'));
    out.push(h('button.k-icon-btn', { type: 'button', title: 'Убрать из списка', 'aria-label': 'Убрать из списка', dataset: { act: 'remove' }, html: I.get('x', 15) }));
    return out;
  }
  function row(r) {
    const pct = r.state === 'progressing' && r.total > 0 ? Math.min(100, (r.received / r.total) * 100) : null;
    const done = r.state === 'completed' && r.exists !== false;
    const name = done
      ? h('button.dl-name', { type: 'button', title: 'Открыть ' + (r.path || r.filename), dataset: { act: 'open' } }, r.filename)
      : h('span.dl-name', { title: r.path || r.filename }, r.filename || 'Файл');
    const cls = (r.state === 'cancelled' || r.state === 'interrupted' ? '.failed' : '') + (r.state === 'completed' && r.exists === false ? '.missing' : '');
    return h('div.dl-row' + cls, { dataset: { id: r.id } },
      fileTile(r.filename),
      h('div.dl-body',
        name,
        h('span.dl-url', { title: r.url }, shortUrl(r.url)),
        r.state === 'progressing' ? h('span.dl-bar' + (pct == null ? '.indet' : ''), h('span', { style: pct == null ? null : { width: pct.toFixed(1) + '%' } })) : null,
        h('span.dl-status', status(r))),
      h('div.dl-acts', actions(r)));
  }

  function filtered() {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    return Array.from(items.values())
      .filter((r) => !terms.length || terms.every((t) => (r.filename + ' ' + r.url).toLowerCase().includes(t)))
      .sort((a, b) => b.startTime - a.startTime);
  }

  function render() {
    const list = filtered();
    U.clear(listEl);
    if (!list.length) {
      listEl.appendChild(q
        ? U.empty({ icon: 'search', title: 'Ничего не найдено', text: 'По запросу «' + q + '» загрузок нет.' })
        : U.empty({ icon: 'download', title: 'Загрузок пока нет', text: 'Скачанные файлы появятся здесь. Последние 200 загрузок хранятся в списке.' }));
      return;
    }
    let day = null, card = null;
    for (const r of list) {
      const d = dayTitle(r.startTime);
      if (d !== day) { day = d; card = h('div.dl-card'); listEl.appendChild(h('section.dl-day', h('div.dl-day-title', d), card)); }
      card.appendChild(row(r));
    }
  }

  // точечное обновление строки (прогресс) без перерисовки списка
  function updateRow(r) {
    const old = listEl.querySelector('.dl-row[data-id="' + CSS.escape(r.id) + '"]');
    if (old) old.replaceWith(row(r)); else render();
  }

  function renderPrefs() {
    U.clear(prefsEl);
    const ask = h('input.k-switch', { type: 'checkbox', 'aria-label': 'Спрашивать, куда сохранять' });
    ask.checked = !!info.ask;
    ask.addEventListener('change', () => {
      U.invoke('kosmo:settings.set', { path: 'downloads.ask', value: ask.checked }).catch((e) => { ask.checked = !ask.checked; U.toast(clean(e), { tone: 'danger' }); });
    });
    const change = h('button.k-btn.k-btn-sm', { type: 'button' }, 'Изменить');
    change.addEventListener('click', () => U.invoke('kosmo:downloads.chooseDir', {}).then((p) => { if (p) refresh(); }).catch((e) => U.toast(clean(e), { tone: 'danger' })));
    const reset = customDir ? h('button.k-btn.k-btn-sm.k-btn-ghost', { type: 'button', title: 'Вернуть системную папку «Загрузки»' }, 'Сбросить') : null;
    if (reset) reset.addEventListener('click', () => U.invoke('kosmo:settings.set', { path: 'downloads.dir', value: '' }).then(refresh).catch((e) => U.toast(clean(e), { tone: 'danger' })));
    prefsEl.append(
      h('div.dl-prefs-dir', U.icon('folder', 18), h('div.dl-prefs-path', h('span.k-label', 'Папка для загрузок'), h('span.k-mono', { title: info.dir }, info.dir || '—')), change, reset),
      h('label.dl-prefs-ask', ask, 'Спрашивать, куда сохранять'));
  }

  // ---------- действия ----------
  listEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    const rowEl = e.target.closest('.dl-row');
    if (!b || !rowEl) return;
    const id = rowEl.dataset.id;
    const act = b.dataset.act;
    const ch = { open: 'open', show: 'show', pause: 'pause', resume: 'resume', cancel: 'cancel', remove: 'remove', retry: 'retry' }[act];
    if (!ch) return;
    U.invoke('kosmo:downloads.' + ch, { id }).catch((err) => {
      const s = rowEl.querySelector('.dl-status');
      if (s) { s.textContent = clean(err); s.classList.add('err'); }
      if (act === 'open') refresh();
    });
  });
  $('dl-open-dir').addEventListener('click', () => U.invoke('kosmo:downloads.openDir', {}).catch((e) => U.toast(clean(e), { tone: 'danger' })));
  $('dl-clear').addEventListener('click', () => U.invoke('kosmo:downloads.clear', {}).then((n) => { if (!n) U.toast('Список уже пуст'); }).catch((e) => U.toast(clean(e), { tone: 'danger' })));
  qEl.addEventListener('input', U.debounce(() => { q = qEl.value.trim(); render(); }, 120));
  qEl.addEventListener('keydown', (e) => { if (e.key === 'Escape' && qEl.value) { qEl.value = ''; q = ''; render(); } });

  // ---------- данные ----------
  function refresh() {
    if (!U.hasKosmo) { render(); return Promise.resolve(); }
    return Promise.all([
      U.invoke('kosmo:downloads.list', { checkFiles: true }),
      U.invoke('kosmo:settings.get', { path: 'downloads' }).catch(() => ({})),
    ]).then(([res, s]) => {
      items.clear();
      for (const r of (res && res.items) || []) items.set(r.id, r);
      info = { dir: res.dir, ask: !!res.ask };
      customDir = (s && s.dir) || '';
      renderPrefs();
      render();
    }).catch((e) => {
      U.clear(listEl).appendChild(U.empty({ icon: 'alert-triangle', title: 'Список не загрузился', text: clean(e), tone: 'error' }));
    });
  }

  U.on('kosmo:downloads.changed', (p) => {
    if (!p) return;
    let structural = false;
    for (const r of p.items || []) {
      const had = items.get(r.id);
      // файл проверяем только при первом показе; живые обновления его не знают
      if (had && had.exists !== undefined && r.exists === undefined) r.exists = had.exists;
      items.set(r.id, r);
      if (!had || had.state !== r.state) structural = true; else updateRow(r);
    }
    for (const id of p.removed || []) { items.delete(id); structural = true; }
    if (structural) render();
  });
  U.on('kosmo:settings.changed', (p) => { if (p && (!p.path || String(p.path).indexOf('downloads') === 0)) refresh(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });

  refresh();
})();
