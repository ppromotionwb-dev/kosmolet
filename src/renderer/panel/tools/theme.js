// Владелец: themes. Заглушка core — фича заменяет файл целиком.
// API: KPanel.register({id, title, icon, order, mount(el, api), onShow(api), onHide(api)});
// api: invoke, on, activeTab(), onTabChange(cb), toast, empty, h, icon.
'use strict';
KPanel.register({
  id: 'theme', title: 'Тема сайта', icon: 'palette', order: 60,
  mount(el, api) {
    el.appendChild(api.empty({ icon: 'palette', title: 'Тема сайта', text: 'Скоро здесь будет тёмная тема и свой CSS для этого сайта.' }));
  }
});
