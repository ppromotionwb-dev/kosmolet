// Владелец: devtools. Инструмент «DevTools»: сам Chrome DevTools — отдельный вид, который main кладёт поверх
// тела панели (ниже шапки). Здесь — подложка с состояниями: загрузка, DevTools в отдельном окне, вкладка выгружена.
'use strict';
(function () {
  const U = window.KUI;
  const { h } = U;
  U.css('tools/devtools.css');

  KPanel.register({
    id: 'devtools', title: 'DevTools', icon: 'code', order: 10,
    mount(el, api) {
      el.classList.add('kdt');
      const box = h('div.kdt-box');
      el.appendChild(box);
      let state = null;

      function render(st) {
        state = st || { state: 'none' };
        U.clear(box);
        switch (state.state) {
          case 'loading':
          case 'ready':
            box.appendChild(h('div.kd-loading', h('span.k-spinner'), 'Загружаю DevTools…'));
            break;
          case 'external': {
            const back = h('button.k-btn.k-btn-primary', { type: 'button' }, U.icon('dock', 14), 'Вернуть в панель');
            back.addEventListener('click', () => api.invoke('kosmo:devtools.dockBack', { tabId: state.tabId }).catch((e) => api.toast(window.KDev.errText(e), { tone: 'danger' })));
            box.appendChild(api.empty({ icon: 'external-link', title: 'DevTools открыты в отдельном окне', text: 'Закройте окно DevTools или верните их сюда.', actions: [back] }));
            break;
          }
          case 'unloaded':
            box.appendChild(api.empty({ icon: 'moon', title: 'Вкладка выгружена', text: 'Откройте вкладку — DevTools появятся здесь.' }));
            break;
          default:
            box.appendChild(api.empty({ icon: 'code', title: 'Нет страницы', text: 'Откройте вкладку, чтобы исследовать её.' }));
        }
      }
      api.on('kosmo:devtools.dock', render);
      el._refresh = () => api.invoke('kosmo:devtools.state').then(render).catch(() => render(null));
      render({ state: 'loading' });
      el._refresh();
    },
    onShow(api) { if (api.el && api.el._refresh) api.el._refresh(); }
  });
})();
