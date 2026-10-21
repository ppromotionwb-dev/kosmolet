// Владелец: ux-chrome. Заглушка core — фича заменяет файл целиком.
// API: KSettings.section({id, title, icon, order, keywords, description, render(el, api)}); хелперы — api.ui (toggle/select/number/text/color/row/group).
'use strict';
KSettings.section({
  id: 'search', title: 'Поиск', icon: 'search', order: 30,
  keywords: 'поисковик бэнги google яндекс подсказки',
  render(el, api) {
    el.appendChild(api.ui.group(null, api.ui.free(api.empty({ icon: 'search', title: 'Скоро', text: 'Здесь будут настройки: поисковая система по умолчанию и бэнги (wb, oz, ym…).' }))));
  }
});
