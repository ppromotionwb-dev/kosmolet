// Владелец: themes. Заглушка core — фича заменяет файл целиком.
// API: KSettings.section({id, title, icon, order, keywords, description, render(el, api)}); хелперы — api.ui (toggle/select/number/text/color/row/group).
'use strict';
KSettings.section({
  id: 'site-themes', title: 'Темы сайтов', icon: 'moon', order: 20,
  keywords: 'тёмная тема сайтов dark reader css яркость контраст',
  render(el, api) {
    el.appendChild(api.ui.group(null, api.ui.free(api.empty({ icon: 'moon', title: 'Скоро', text: 'Здесь будут настройки: тёмная тема для любого сайта, яркость, контраст и свой CSS.' }))));
  }
});
