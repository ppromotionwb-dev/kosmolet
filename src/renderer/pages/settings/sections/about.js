// Владелец: core. О программе: версии.
'use strict';
KSettings.section({
  id: 'about', title: 'О Космолёте', icon: 'orbit', order: 100,
  keywords: 'версия electron chromium node о программе профиль',
  render(el, api) {
    const { h } = window.KUI;
    const k = window.kosmo || {};
    const v = k.versions || {};
    const mono = (t) => h('span.k-mono.k-dim', t || '—');
    const ver = mono(v.app);
    const profile = mono('');
    profile.style.cssText = 'overflow-wrap:anywhere;text-align:right;user-select:text';
    el.append(
      api.ui.group(null,
        api.ui.free(h('div.k-row', { style: 'gap:14px' },
          h('span', { style: 'color:var(--k-accent-text)', html: window.KIcons.get('orbit', 36, { stroke: 1.4 }) }),
          h('div', h('div.k-h2', 'Космолёт'), h('div.k-dim', 'Браузер IT-специалиста')))),
        api.ui.row('Версия', ver),
        api.ui.row('Chromium', mono(v.chrome)),
        api.ui.row('Electron', mono(v.electron)),
        api.ui.row('Node.js', mono(v.node)),
        api.ui.row('Профиль', profile)));
    // версии приложения в preload внутренних страниц нет — спрашиваем main
    api.invoke('kosmo:app.info', {}).then((info) => {
      if (!info) return;
      ver.textContent = info.version || '—';
      profile.textContent = info.userData || '—';
      profile.title = info.userData || '';
    }).catch(() => {});
  }
});
