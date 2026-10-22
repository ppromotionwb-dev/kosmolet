'use strict';
// Модуль ui-preload (ctx.uiPreload.addModule): элемент <browser-action-list> из electron-chrome-extensions —
// только в chrome (верх окна), в панели и overlay он не нужен.
if (process.argv.includes('--kosmo-view=chrome')) {
  try {
    require('electron-chrome-extensions/browser-action').injectBrowserAction();
  } catch (e) {
    console.error('[platform] browser-action', e);
  }
}
