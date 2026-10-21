// Новая вкладка — заглушка core (владелец страницы: ux-chrome). Ввод уходит в kosmo:tabs.navigate — main решает: адрес, поиск или бэнг.
'use strict';
(function () {
  const U = window.KUI;
  document.getElementById('nt-logo').innerHTML = window.KIcons.get('orbit', 44, { stroke: 1.3 });
  document.getElementById('nt-icon').innerHTML = window.KIcons.get('search', 18);
  const q = document.getElementById('nt-q');
  document.getElementById('nt-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = q.value.trim();
    if (!input) return;
    if (U.hasKosmo) {
      U.invoke('kosmo:tabs.navigate', { input, url: input }).catch(() => U.toast('Не удалось открыть', { tone: 'danger' }));
    } else {
      // без API: похоже на адрес — открыть, иначе поиск
      const looksUrl = /^[a-z][\w+.-]*:\/\//i.test(input) || (/^[^\s]+\.[a-zа-я]{2,}(\/|$)/i.test(input));
      location.href = looksUrl ? (/^[a-z][\w+.-]*:\/\//i.test(input) ? input : 'https://' + input) : 'https://www.google.com/search?q=' + encodeURIComponent(input);
    }
  });
})();
