// Владелец: tools-pack. Заглушка core — фича заменяет файл целиком.
// API: KPanel.register({id, title, icon, order, mount(el, api), onShow(api), onHide(api)});
// api: invoke, on, activeTab(), onTabChange(cb), toast, empty, h, icon.
'use strict';
KPanel.register({
  id: 'snippets', title: 'Сниппеты', icon: 'file-code', order: 70,
  mount(el, api) {
    el.appendChild(api.empty({ icon: 'file-code', title: 'Сниппеты', text: 'Скоро здесь будет сниппеты JavaScript для запуска на странице.' }));
  }
});
