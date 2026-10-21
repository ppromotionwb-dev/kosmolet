// Владелец: devtools. Заглушка core — фича заменяет файл целиком.
// API: KPanel.register({id, title, icon, order, mount(el, api), onShow(api), onHide(api)});
// api: invoke, on, activeTab(), onTabChange(cb), toast, empty, h, icon.
'use strict';
KPanel.register({
  id: 'storage', title: 'Хранилище', icon: 'database', order: 30,
  mount(el, api) {
    el.appendChild(api.empty({ icon: 'database', title: 'Хранилище', text: 'Скоро здесь будет cookies, localStorage, sessionStorage и IndexedDB сайта.' }));
  }
});
