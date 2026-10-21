// Владелец: tools-pack. Заглушка core — фича заменяет файл целиком.
// API: KPanel.register({id, title, icon, order, mount(el, api), onShow(api), onHide(api)});
// api: invoke, on, activeTab(), onTabChange(cb), toast, empty, h, icon.
'use strict';
KPanel.register({
  id: 'xray', title: 'Рентген', icon: 'scan', order: 80,
  mount(el, api) {
    el.appendChild(api.empty({ icon: 'scan', title: 'Рентген', text: 'Скоро здесь будет SEO и технический рентген страницы.' }));
  }
});
