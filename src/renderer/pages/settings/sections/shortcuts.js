// Владелец: core. Список команд и горячих клавиш (kosmo:commands.list), только просмотр.
'use strict';
KSettings.section({
  id: 'shortcuts', title: 'Горячие клавиши', icon: 'keyboard', order: 90,
  keywords: 'клавиши сочетания команды хоткеи',
  render(el, api) {
    const { h } = window.KUI;
    const holder = api.ui.group(null, api.ui.free(h('div.k-row.k-dim', h('span.k-spinner'), 'Загружаю…')));
    el.appendChild(holder);
    const keyEls = (keys) => h('span.ks-keys', (keys || []).map((k) => h('span.k-kbd', k)));
    api.invoke('kosmo:commands.list', {}).then((list) => {
      holder.remove();
      list = Array.isArray(list) ? list.filter((c) => c && c.title) : [];
      if (!list.length) { el.appendChild(api.ui.group(null, api.ui.free(api.empty({ icon: 'keyboard', title: 'Команд пока нет' })))); return; }
      const byCat = new Map();
      for (const c of list) {
        const cat = c.category || 'Прочее';
        if (!byCat.has(cat)) byCat.set(cat, []);
        byCat.get(cat).push(c);
      }
      for (const [cat, cmds] of byCat) {
        cmds.sort((a, b) => (b.keys && b.keys.length ? 1 : 0) - (a.keys && a.keys.length ? 1 : 0));
        el.appendChild(api.ui.group(cat, cmds.map((c) => api.ui.row(c.title, c.keys && c.keys.length ? keyEls(c.keys) : h('span.k-faint.k-small', '—'), null, { keywords: (c.keys || []).join(' ') + ' ' + c.id }))));
      }
    }).catch((e) => {
      holder.remove();
      el.appendChild(api.ui.group(null, api.ui.free(api.empty({ icon: 'alert-triangle', title: 'Не удалось получить список', text: String(e && e.message || e), tone: 'error' }))));
    });
  }
});
