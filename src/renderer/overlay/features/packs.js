// Владелец: packs. Лист прав при установке пака и лист разницы при обновлении ('pack-sheet').
// Рисует ядро по данным main (пак даёт только декларации). Ответ — kosmo:packs.sheetRespond, main принимает его
// только от этого слоя (overlay), поэтому ни страница, ни агент нажать «Установить» не могут.
'use strict';
(function () {
  const U = window.KUI;
  const { h } = U;
  if (!window.KOverlay) return;
  U.css('features/packs.css');

  const GROUP_ORDER = ['Сайты', 'Данные', 'Запись', 'Страницы', 'Сеть', 'Умолчания', 'Контейнеры', 'Агент'];
  const KIND = { new: 'новое', removed: 'убрано', changed: 'изменено' };

  function initials(name) {
    const w = String(name || '').split(/[\s:·,.-]+/).filter(Boolean);
    return ((w[0] || '?')[0] + (w[1] ? w[1][0] : (w[0] || '')[1] || '')).toUpperCase();
  }

  function installList(items) {
    const box = h('div.kpk-groups');
    const groups = new Map();
    for (const it of items || []) {
      if (!groups.has(it.group)) groups.set(it.group, []);
      groups.get(it.group).push(it);
    }
    const names = Array.from(groups.keys()).sort((a, b) => (GROUP_ORDER.indexOf(a) + 99) % 99 - (GROUP_ORDER.indexOf(b) + 99) % 99);
    for (const g of names) {
      box.appendChild(h('div.kpk-group',
        h('div.kpk-glabel', g),
        h('ul.kpk-items', groups.get(g).map((it) => h('li.kpk-item' + (it.tone === 'warn' ? '.attn' : ''), h('span.kpk-dot'), h('span', it.text))))));
    }
    return box;
  }

  function diffList(items) {
    if (!items || !items.length) return h('div.kpk-same', 'Права и умолчания не меняются.');
    return h('ul.kpk-items.kpk-diff', items.map((it) => h('li.kpk-item.kind-' + it.kind + (it.tone === 'warn' ? '.attn' : ''),
      h('span.kpk-badge', KIND[it.kind] || ''), h('span', it.text))));
  }

  KOverlay.register('pack-sheet', {
    width: 480,
    className: 'kpk-sheet',
    render(root, data, api) {
      data = data || {};
      const p = data.pack || {};
      const upd = data.kind === 'update';
      let done = false;
      const title = (upd ? 'Обновить «' : 'Установить «') + (p.name || p.id) + '»?';
      const sub = upd ? `версия ${p.fromVersion} → ${p.version}` : `версия ${p.version}`;
      const ok = h('button.k-btn.k-btn-primary', { type: 'button' }, upd ? 'Обновить' : 'Установить');
      const cancel = h('button.k-btn', { type: 'button' }, 'Отмена');
      const body = h('div.kpk-body');
      if (p.description && !upd) body.appendChild(h('p.kpk-desc', p.description));
      if (data.summary) body.appendChild(h('div.kpk-summary' + (upd && data.extended ? '.attn' : ''), data.summary));
      body.appendChild(upd ? diffList(data.items) : installList(data.items));
      if (upd && Array.isArray(data.all) && data.all.length) {
        const more = h('details.kpk-more', h('summary', 'Все права пака после обновления'), installList(data.all));
        body.appendChild(more);
      }
      root.append(
        h('div.kpk-head',
          h('span.kpk-mark', initials(p.name || p.id)),
          h('div.kpk-htext', h('div.kpk-title', title), h('div.kpk-sub.k-ellipsis', { title: data.source || '' }, sub + (data.source ? ' · ' + data.source : '')))),
        body,
        h('div.kpk-foot',
          h('div.kpk-note', 'Пак — это декларации: его исполняет и рисует Космолёт. Своего кода в браузере у пака нет.'),
          h('div.kpk-btns', cancel, ok)));
      function answer(approve) {
        if (done) return;
        done = true;
        ok.disabled = true; cancel.disabled = true;
        api.invoke('kosmo:packs.sheetRespond', { id: data.sheetId, approve }).then((r) => { if (!r) api.close(); }, () => api.close());
      }
      ok.addEventListener('click', () => answer(true));
      cancel.addEventListener('click', () => answer(false));
    },
  });
})();
