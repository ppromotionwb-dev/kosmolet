// Владелец: devtools. Заглушка core — фича заменяет файл целиком.
// API: KPanel.register({id, title, icon, order, mount(el, api), onShow(api), onHide(api)});
// api: invoke, on, activeTab(), onTabChange(cb), toast, empty, h, icon.
'use strict';
KPanel.register({
  id: 'emulation', title: 'Устройство', icon: 'smartphone', order: 40,
  mount(el, api) {
    el.appendChild(api.empty({ icon: 'smartphone', title: 'Устройство', text: 'Скоро здесь будет эмуляция устройств и сети.' }));
  }
});
