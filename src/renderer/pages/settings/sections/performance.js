// Владелец: core. Выгрузка неактивных вкладок и восстановление сессии (settings.performance).
'use strict';
KSettings.section({
  id: 'performance', title: 'Производительность', icon: 'gauge', order: 80,
  keywords: 'память выгрузка вкладок сессия восстановление скорость',
  render(el, api) {
    const ui = api.ui;
    el.append(
      ui.group(null,
        ui.number('Выгружать неактивные вкладки через', 'performance.discardAfterMin', { min: 0, max: 1440, unit: 'мин', hint: '0 — не выгружать. Закреплённые и играющие звук не выгружаются' }),
        ui.toggle('Восстанавливать вкладки при запуске', 'performance.restoreSession', 'Вкладки открываются лениво — грузятся при первом переходе')));
  }
});
