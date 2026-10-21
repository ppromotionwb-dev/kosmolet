// Владелец: claude-terminal (терминал) + claude-bridge (журнал действий — подвкладка). Заглушка core — фича заменяет файл целиком.
// API: KPanel.register({id, title, icon, order, mount(el, api), onShow(api), onHide(api)});
// api: invoke, on, activeTab(), onTabChange(cb), toast, empty, h, icon.
'use strict';
KPanel.register({
  id: 'claude', title: 'Claude', icon: 'claude', order: 50,
  mount(el, api) {
    el.appendChild(api.empty({ icon: 'claude', title: 'Claude', text: 'Скоро здесь будет терминал с Claude и журнал его действий в браузере.' }));
  }
});
