// Владелец: ux-chrome. Заглушка core — фича заменит страницу.
'use strict';
(function () {
  const U = window.KUI;
  document.getElementById('kp-title').append(U.icon('download', 18), 'Загрузки');
  document.getElementById('kp-body').appendChild(U.empty({ icon: 'download', title: 'Загрузки', text: 'Скоро здесь будут загруженные файлы.' }));
})();
