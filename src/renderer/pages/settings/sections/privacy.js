// Владелец: platform. Заглушка core — фича заменяет файл целиком.
// API: KSettings.section({id, title, icon, order, keywords, description, render(el, api)}); хелперы — api.ui (toggle/select/number/text/color/row/group).
'use strict';
KSettings.section({
  id: 'privacy', title: 'Приватность и блокировка', icon: 'shield', order: 50,
  keywords: 'реклама блокировщик adblock приватность user-agent разрешения',
  render(el, api) {
    el.appendChild(api.ui.group(null, api.ui.free(api.empty({ icon: 'shield', title: 'Скоро', text: 'Здесь будут настройки: блокировщик рекламы, исключения, User-Agent и разрешения сайтов.' }))));
  }
});
