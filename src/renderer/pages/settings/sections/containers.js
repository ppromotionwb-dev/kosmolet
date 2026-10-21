// Владелец: platform. Заглушка core — фича заменяет файл целиком.
// API: KSettings.section({id, title, icon, order, keywords, description, render(el, api)}); хелперы — api.ui (toggle/select/number/text/color/row/group).
'use strict';
KSettings.section({
  id: 'containers', title: 'Контейнеры', icon: 'layers', order: 40,
  keywords: 'контейнеры сессии кабинеты аккаунты',
  render(el, api) {
    el.appendChild(api.ui.group(null, api.ui.free(api.empty({ icon: 'layers', title: 'Скоро', text: 'Здесь будут настройки: контейнеры: разные кабинеты в изолированных сессиях.' }))));
  }
});
