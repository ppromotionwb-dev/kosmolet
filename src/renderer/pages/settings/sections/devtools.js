// Владелец: devtools. Раздел «Инструменты разработчика»: запись сети (settings.devtools.*), DevTools,
// удалённая отладка (порт применяется после перезапуска — main.js читает settings.json до ready).
'use strict';
KSettings.section({
  id: 'devtools', title: 'Инструменты разработчика', icon: 'code', order: 70,
  keywords: 'devtools сеть запись api har отладка cdp remote debugging порт консоль',
  description: 'Встроенный Chrome DevTools, запись запросов для «Сеть и API» и удалённая отладка.',
  render(el, api) {
    const ui = api.ui;
    const h = api.h;
    window.KUI.css('sections/devtools.css');

    el.append(
      ui.group('Запись сети',
        ui.segmented('Что записывать', 'devtools.capture', [['api', 'API'], ['all', 'Всё'], ['off', 'Выключено']],
          'API — XHR, fetch, документы, WebSocket и EventSource. «Всё» добавит скрипты, стили, картинки и шрифты. Тела ответов берутся только по запросу'),
        ui.number('Хранить запросов на вкладку', 'devtools.maxEntries', { min: 100, max: 100000, step: 100, hint: 'Старые записи вытесняются новыми' }),
        ui.toggle('Сохранять журнал при переходах', 'devtools.preserveLog', 'При переходе на другую страницу в списке появляется разделитель. Выключите — список будет очищаться'),
        ui.toggle('Записывать консоль страницы', 'devtools.console', 'Для Claude и журнала консоли. Некоторые антибот-системы замечают включённую консоль отладчика — тогда выключите')
      )
    );

    // ---------- удалённая отладка ----------
    const status = h('div.ks-note');
    const warn = h('div.kdt-warn',
      api.icon('alert-triangle', 16),
      h('div', h('b', 'Опасно на общем компьютере. '), 'Любая программа на этом компьютере сможет управлять браузером через порт: читать страницы, cookies и пароли из открытых вкладок. Включайте, только если это нужно для Puppeteer, Playwright или внешних DevTools.'));
    const warnRow = ui.free(warn);
    const restart = h('button.k-btn', { type: 'button' }, api.icon('rotate-cw', 14), 'Перезапустить Космолёт');
    restart.addEventListener('click', () => {
      restart.disabled = true;
      api.invoke('kosmo:devtools.relaunch').catch((e) => { restart.disabled = false; api.toast(String(e && e.message || e), { tone: 'danger' }); });
    });
    const restartRow = ui.row('Нужен перезапуск', restart, 'Порт откроется или закроется после перезапуска');
    restartRow.hidden = true;

    let info = null;
    function refresh() {
      const on = !!api.get('devtools.remoteDebugging');
      const port = Number(api.get('devtools.remoteDebuggingPort')) || 9222;
      warnRow.hidden = !on;
      if (!info) { status.textContent = ''; return; }
      if (info.fromFlag) status.textContent = `Сейчас: отладка открыта на порту ${info.remotePort} — задан флагом запуска (--cdp-port${info.dev ? ', режим разработки' : ''}), он главнее этой настройки.`;
      else if (info.remotePort) status.textContent = `Сейчас: порт ${info.remotePort} открыт — http://127.0.0.1:${info.remotePort}/json`;
      else status.textContent = 'Сейчас: удалённая отладка выключена.';
      const want = on ? port : null;
      restartRow.hidden = info.fromFlag || want === info.remotePort;
    }
    el.append(ui.group('Удалённая отладка',
      ui.toggle('Открыть порт удалённой отладки', 'devtools.remoteDebugging', 'Chrome DevTools Protocol на 127.0.0.1 — для внешних инструментов'),
      ui.number('Порт', 'devtools.remoteDebuggingPort', { min: 1024, max: 65535 }),
      warnRow,
      ui.free(status),
      restartRow));
    ui.watch('devtools.remoteDebugging', refresh);
    ui.watch('devtools.remoteDebuggingPort', refresh);
    api.invoke('kosmo:devtools.info').then((r) => { info = r; refresh(); }).catch(() => {});

    // знания о сайтах (фича site-intel, sections/site-intel.js)
    if (window.KSiteIntelSettings) { try { window.KSiteIntelSettings.render(el, api); } catch (e) { console.error('[settings] site-intel', e); } }

  }
});
