// Владелец: platform. Заглушка core — фича заменит страницу.
'use strict';
(function () {
  const U = window.KUI;
  document.getElementById('kp-title').append(U.icon('puzzle', 18), 'Расширения');
  document.getElementById('kp-body').appendChild(U.empty({ icon: 'puzzle', title: 'Расширения', text: 'Скоро здесь будут расширения Chrome из Chrome Web Store.' }));
})();
