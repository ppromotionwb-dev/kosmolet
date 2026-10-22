// Владелец: tools-pack. Значок в адресной строке, когда на странице сработали автосниппеты:
// какие — в подсказке, красная точка — была ошибка. Нажатие открывает панель «Сниппеты».
'use strict';
(function () {
  const K = window.KChrome;
  const U = window.KUI;
  if (!K || !U) return;

  const runs = new Map(); // tabId → {n, bad, names}
  const btn = K.addOmniboxIcon({
    id: 'tools-auto-snippets', icon: 'zap', title: 'Автосниппеты', hidden: true, order: 420,
    onClick: () => U.fire('kosmo:panel.open', { tool: 'snippets' })
  });

  function paint() {
    const r = runs.get(K.state.activeId);
    if (!r || !r.n) { btn.setVisible(false); return; }
    btn.setVisible(true);
    // значок в адресной строке мелкий — число закрыло бы его; точка только при ошибке, подробности в подсказке
    btn.setBadge(r.bad ? '' : null, 'danger');
    btn.el.style.color = 'var(--k-accent-text)';
    btn.setTitle('Автосниппеты на странице: ' + r.names.join(', ') + (r.bad ? '. С ошибкой: ' + r.bad : '') + '. Нажмите, чтобы открыть');
  }

  U.on('kosmo:snippets.auto', (p) => {
    if (!p || p.tabId == null) return;
    const entries = Array.isArray(p.entries) ? p.entries : [];
    if (!entries.length) runs.delete(p.tabId);
    else runs.set(p.tabId, { n: entries.length, bad: entries.filter((e) => !e.ok).length, names: entries.map((e) => '«' + e.name + '»') });
    paint();
  });
  K.on('active', paint);
  K.on('state', () => {
    const ids = new Set((K.state.tabs || []).map((t) => t.id));
    for (const id of runs.keys()) if (!ids.has(id)) runs.delete(id);
    paint();
  });
})();
