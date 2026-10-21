// Владелец: devtools. Заглушка core — фича заменяет файл целиком.
// Особый инструмент: main кладёт DevTools-вид поверх тела панели, здесь только подложка.
// API: KPanel.register({id, title, icon, order, mount(el, api), onShow(api), onHide(api)});
// api: invoke, on, activeTab(), onTabChange(cb), toast, empty, h, icon.
'use strict';
KPanel.register({
  id: 'devtools', title: 'DevTools', icon: 'code', order: 10,
  mount(el, api) {
    el.appendChild(api.empty({ icon: 'code', title: 'DevTools', text: 'Скоро здесь будет Chrome DevTools для активной вкладки.' }));
  }
});
