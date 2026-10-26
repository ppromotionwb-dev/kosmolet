// Владелец: devtools. Раздел «Инструменты разработчика»: запись сети (settings.devtools.*), DevTools,
// удалённая отладка (только подсказка: порт открывается флагом запуска --remote-debugging-port / --cdp-port).
'use strict';
KSettings.section({
  id: 'devtools', title: 'Инструменты разработчика', icon: 'code', order: 70,
  keywords: 'devtools сеть запись api har отладка cdp remote debugging порт консоль',
  description: 'Встроенный Chrome DevTools, запись запросов для «Сеть и API» и как включить удалённую отладку.',
  render(el, api) {
    const ui = api.ui;
    const h = api.h;
    window.KUI.css('sections/devtools.css');

    el.append(
      ui.group('Запись сети',
        ui.segmented('Что записывать', 'devtools.capture', [['scoped', 'По пакам'], ['api', 'API'], ['all', 'Всё'], ['off', 'Выключено']],
          '«По пакам» — подробно на сайтах, которые объявили включённые паки, и во вкладке, открытой в «Сеть и API»; на остальных — API с малым буфером. API — XHR, fetch, документы, WebSocket и EventSource везде. «Всё» добавит скрипты, стили, картинки и шрифты. Тела ответов берутся только по запросу'),
        ui.number('Хранить запросов на вкладку', 'devtools.maxEntries', { min: 100, max: 100000, step: 100, hint: 'Старые записи вытесняются новыми' }),
        ui.toggle('Сохранять журнал при переходах', 'devtools.preserveLog', 'При переходе на другую страницу в списке появляется разделитель. Выключите — список будет очищаться'),
        ui.toggle('Записывать консоль страницы', 'devtools.console', 'Для Claude и журнала консоли. Некоторые антибот-системы замечают включённую консоль отладчика — тогда выключите')
      )
    );

    // ---------- удалённая отладка ----------
    // Порт открывается только флагом запуска: настройка в профиле позволяла любой программе включить CDP без пароля.
    const status = h('div.ks-note');
    const how = h('div.kdt-how',
      h('div', 'Порт Chrome DevTools Protocol открывается только флагом запуска — для Puppeteer, Playwright и внешних DevTools:'),
      h('code.k-mono.kdt-cmd', 'electron . --remote-debugging-port=9222'),
      h('div.k-faint', 'Или --cdp-port=9222. В режиме разработки (--dev) порт открыт всегда. Любая программа на компьютере сможет управлять браузером через этот порт, поэтому для рабочего профиля его лучше не открывать.'));
    el.append(ui.group('Удалённая отладка', ui.free(how), ui.free(status)));
    api.invoke('kosmo:devtools.info').then((info) => {
      if (!info) return;
      status.textContent = info.remotePort
        ? `Сейчас: порт ${info.remotePort} открыт флагом запуска${info.dev ? ' (режим разработки)' : ''} — http://127.0.0.1:${info.remotePort}/json`
        : 'Сейчас: удалённая отладка выключена.';
    }).catch(() => {});

    // знания о сайтах (фича site-intel, sections/site-intel.js)
    if (window.KSiteIntelSettings) { try { window.KSiteIntelSettings.render(el, api); } catch (e) { console.error('[settings] site-intel', e); } }

  }
});
