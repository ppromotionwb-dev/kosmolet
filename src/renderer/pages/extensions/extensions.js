// Владелец: platform. kosmo://extensions/ — установленные расширения Chrome: список, удалить, перезагрузить,
// «Загрузить распакованное…», «Открыть Chrome Web Store».
'use strict';
(function () {
  const U = window.KUI;
  const { h } = U;
  const $ = (id) => document.getElementById(id);
  const body = $('kp-body');
  const clean = (e) => String((e && e.message) || e || '').replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '').replace(/^./, (c) => c.toUpperCase());

  $('kp-title').append(U.icon('puzzle', 18), 'Расширения');

  const unpackedBtn = h('button.k-btn', { type: 'button', title: 'Папка с manifest.json — для своих и тестовых расширений' }, U.icon('folder', 14), 'Загрузить распакованное…');
  const storeBtn = h('button.k-btn.k-btn-primary', { type: 'button' }, U.icon('external-link', 14), 'Chrome Web Store');
  $('kp-tools').append(unpackedBtn, storeBtn);

  storeBtn.addEventListener('click', () => U.invoke('kosmo:ext.openStore', {}).catch((e) => U.toast(clean(e), { tone: 'danger' })));
  unpackedBtn.addEventListener('click', () => {
    unpackedBtn.disabled = true;
    U.invoke('kosmo:ext.loadUnpacked', {}).then((r) => {
      if (r) U.toast('Загружено: ' + r.name);
      return load();
    }).catch((e) => U.toast('Не загрузилось: ' + clean(e), { tone: 'danger', ms: 4000 })).finally(() => { unpackedBtn.disabled = false; });
  });

  let items = [];
  let confirmId = null;
  const busy = new Set();
  let seq = 0;

  function emptyState() {
    const open = h('button.k-btn.k-btn-primary', { type: 'button' }, U.icon('external-link', 14), 'Открыть Chrome Web Store');
    open.addEventListener('click', () => storeBtn.click());
    return U.empty({
      icon: 'puzzle',
      title: 'Расширений пока нет',
      text: 'Откройте страницу расширения в Chrome Web Store и нажмите «Установить» — оно появится во всех контейнерах, а его кнопка — справа от адресной строки.',
      actions: [open]
    });
  }

  function card(x) {
    const icon = x.icon ? h('img.ke-icon', { src: x.icon, alt: '' }) : h('span.ke-icon.ke-icon-empty', U.icon('puzzle', 22));
    const idEl = h('button.ke-id.k-mono', { type: 'button', title: 'Скопировать id' }, x.id);
    idEl.addEventListener('click', () => U.copyText(x.id, { message: 'id скопирован' }));
    const meta = h('div.ke-meta',
      h('span', 'Версия ' + (x.version || '—')),
      x.unpacked ? h('span.k-badge.k-badge-warn', 'распакованное') : h('span.k-badge', 'Web Store'),
      x.mv ? h('span.ke-mv', 'MV' + x.mv) : null);
    const info = h('div.ke-info',
      h('div.ke-name', x.name),
      x.description ? h('div.ke-desc', x.description) : null,
      meta,
      h('div.ke-idrow', idEl, x.unpacked ? h('span.ke-path.k-ellipsis', { title: x.path }, x.path) : null));

    const actions = h('div.ke-actions');
    const isBusy = busy.has(x.id);
    if (confirmId === x.id) {
      const yes = h('button.k-btn.k-btn-sm.k-btn-danger', { type: 'button' }, 'Удалить');
      const no = h('button.k-btn.k-btn-sm', { type: 'button' }, 'Отмена');
      yes.addEventListener('click', () => act(x, 'remove'));
      no.addEventListener('click', () => { confirmId = null; render(); });
      actions.append(h('span.ke-confirm', x.unpacked ? 'Убрать из Космолёта? Папка останется.' : 'Удалить расширение и его данные?'), no, yes);
    } else {
      if (x.options) {
        const opt = h('button.k-btn.k-btn-sm.k-btn-ghost', { type: 'button', disabled: isBusy }, U.icon('settings', 14), 'Настройки');
        opt.addEventListener('click', () => U.invoke('kosmo:ext.options', { id: x.id }).catch((e) => U.toast(clean(e), { tone: 'danger' })));
        actions.appendChild(opt);
      }
      const rel = h('button.k-icon-btn', { type: 'button', title: 'Перезагрузить', 'aria-label': 'Перезагрузить', disabled: isBusy, html: window.KIcons.get('rotate-cw', 16) });
      rel.addEventListener('click', () => act(x, 'reload'));
      const del = h('button.k-icon-btn.ke-del', { type: 'button', title: 'Удалить', 'aria-label': 'Удалить', disabled: isBusy, html: window.KIcons.get('trash', 16) });
      del.addEventListener('click', () => { confirmId = x.id; render(); });
      actions.append(rel, del);
    }
    return h('div.ke-card' + (isBusy ? '.busy' : ''), { dataset: { id: x.id } }, icon, info, actions);
  }

  function act(x, what) {
    busy.add(x.id);
    confirmId = null;
    render();
    const ch = what === 'remove' ? 'kosmo:ext.remove' : 'kosmo:ext.reload';
    U.invoke(ch, { id: x.id }).then(() => {
      U.toast(what === 'remove' ? 'Удалено: ' + x.name : 'Перезагружено: ' + x.name);
    }).catch((e) => U.toast(clean(e), { tone: 'danger', ms: 4000 })).finally(() => {
      busy.delete(x.id);
      load();
    });
  }

  function render() {
    U.clear(body);
    if (!items.length) { body.appendChild(emptyState()); return; }
    body.appendChild(h('div.ke-intro',
      h('span', 'Установлено ' + items.length + ' ' + U.plural(items.length, ['расширение', 'расширения', 'расширений']) + '. '),
      h('span.k-faint', 'Работают во всех контейнерах; кнопки действий — справа от адресной строки.')));
    body.appendChild(h('div.ke-list', items.map(card)));
    body.appendChild(h('p.ke-note.k-faint', 'Не все API Chrome доступны: например, chrome.webRequest у расширений не срабатывает (сеть фильтрует встроенный блокировщик), declarativeNetRequest не поддерживается.'));
  }

  function load() {
    const my = ++seq;
    return U.invoke('kosmo:ext.list', {}).then((r) => {
      if (my !== seq) return;
      items = (r && r.items) || [];
      render();
    }).catch((e) => {
      if (my !== seq) return;
      U.clear(body).appendChild(U.empty({ icon: 'alert-triangle', title: 'Список не загрузился', text: clean(e), tone: 'error' }));
    });
  }

  body.appendChild(h('div.ke-loading', h('span.k-spinner'), h('span.k-faint', 'Загружаю расширения…')));
  U.on('kosmo:ext.changed', () => { if (!busy.size) load(); });
  load();
})();
