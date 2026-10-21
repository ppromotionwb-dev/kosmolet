// Владелец: ux-chrome. Заглушка core — фича заменит страницу.
'use strict';
(function () {
  const U = window.KUI;
  document.getElementById('kp-title').append(U.icon('history', 18), 'История');
  document.getElementById('kp-body').appendChild(U.empty({ icon: 'history', title: 'История', text: 'Скоро здесь будет история посещений с поиском.' }));
})();
