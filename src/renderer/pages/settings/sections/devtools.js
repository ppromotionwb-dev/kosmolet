// Владелец: devtools. Заглушка core — фича заменяет файл целиком.
// API: KSettings.section({id, title, icon, order, keywords, description, render(el, api)}); хелперы — api.ui (toggle/select/number/text/color/row/group).
'use strict';
KSettings.section({
  id: 'devtools', title: 'Инструменты разработчика', icon: 'code', order: 70,
  keywords: 'devtools сеть отладка cdp',
  render(el, api) {
    el.appendChild(api.ui.group(null, api.ui.free(api.empty({ icon: 'code', title: 'Скоро', text: 'Здесь будут настройки: захват сети, буфер запросов и удалённая отладка.' }))));
  }
});
