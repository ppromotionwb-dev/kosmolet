// Владелец: devtools. Заглушка core — фича заменяет файл целиком.
// API: KPanel.register({id, title, icon, order, mount(el, api), onShow(api), onHide(api)});
// api: invoke, on, activeTab(), onTabChange(cb), toast, empty, h, icon.
'use strict';
KPanel.register({
  id: 'network', title: 'Сеть и API', icon: 'activity', order: 20,
  mount(el, api) {
    el.appendChild(api.empty({ icon: 'activity', title: 'Сеть и API', text: 'Скоро здесь будет сниффер запросов: JSON, копирование как fetch/curl/PowerShell, повтор.' }));
  }
});
