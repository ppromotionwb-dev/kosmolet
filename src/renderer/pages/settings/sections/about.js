// Владелец: tools-pack (база — core). «О Космолёте»: версии, папки профиля и Claude с кнопками «Открыть папку», лицензии.
'use strict';
KSettings.section({
  id: 'about', title: 'О Космолёте', icon: 'kosmolet', order: 100,
  keywords: 'версия electron chromium node о программе профиль папка данные лицензии inbox',
  render(el, api) {
    const U = window.KUI;
    const { h } = U;
    U.css('sections/tools-pack.css');
    const errText = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
    // Знак — тот же, что assets/logo.svg (страница настроек не видит папку assets).
    const LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><defs><linearGradient id="a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#272f52"/><stop offset="1" stop-color="#10131e"/></linearGradient><linearGradient id="b" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#6553ff"/><stop offset="1" stop-color="#ab9fff"/></linearGradient><mask id="c" maskUnits="userSpaceOnUse" x="0" y="0" width="256" height="256"><rect width="256" height="256" fill="#fff"/><path d="M230 140A102 38 0 0 1 26 140" transform="rotate(-20 128 140)" fill="none" stroke="#000" stroke-width="32" stroke-linecap="round"/></mask></defs><rect x="8" y="8" width="240" height="240" rx="56" fill="url(#a)"/><rect x="9" y="9" width="238" height="238" rx="55" fill="none" stroke="#9aa6ff" stroke-opacity=".24" stroke-width="2"/><path d="M26 140A102 38 0 0 1 230 140" transform="rotate(-20 128 140)" fill="none" stroke="url(#b)" stroke-width="15" stroke-linecap="round"/><g mask="url(#c)"><g transform="translate(126 120) rotate(28)"><path d="M0 -94L40 54L0 31Z" fill="#fff"/><path d="M0 -94L-40 54L0 31Z" fill="#bcc2f2"/></g></g><path d="M230 140A102 38 0 0 1 26 140" transform="rotate(-20 128 140)" fill="none" stroke="url(#b)" stroke-width="15" stroke-linecap="round"/></svg>';
    const LICENSES = [
      ['Electron', 'MIT', 'https://github.com/electron/electron'],
      ['Chromium', 'BSD-3-Clause и другие', 'https://www.chromium.org/'],
      ['Node.js', 'MIT', 'https://nodejs.org/'],
      ['electron-chrome-extensions', 'GPL-3.0', 'https://github.com/samuelmaddock/electron-browser-shell'],
      ['electron-chrome-web-store', 'MIT', 'https://github.com/samuelmaddock/electron-browser-shell'],
      ['Dark Reader', 'MIT', 'https://github.com/darkreader/darkreader'],
      ['@ghostery/adblocker', 'MPL-2.0', 'https://github.com/ghostery/adblocker'],
      ['node-pty', 'MIT', 'https://github.com/microsoft/node-pty'],
      ['xterm.js', 'MIT', 'https://github.com/xtermjs/xterm.js'],
      ['MCP SDK', 'MIT', 'https://github.com/modelcontextprotocol/typescript-sdk'],
      ['zod', 'MIT', 'https://github.com/colinhacks/zod']
    ];

    const k = window.kosmo || {};
    const v = k.versions || {};
    const mono = (t) => h('span.k-mono.k-dim.tps-path', t || '—');
    const ver = h('span.k-badge.k-badge-accent', 'версия …');
    const logo = h('img.tps-logo', { src: 'data:image/svg+xml,' + encodeURIComponent(LOGO), alt: '', width: '56', height: '56' });
    el.appendChild(api.ui.group(null,
      api.ui.free(h('div.tps-about-head', logo, h('div.k-grow', h('div.k-h2', 'Космолёт'), h('div.k-dim', 'Браузер IT-специалиста: быстрый, удобный Claude, с расширенными DevTools')), ver))));

    const appVer = mono('…');
    el.appendChild(api.ui.group('Версии',
      api.ui.row('Космолёт', appVer),
      api.ui.row('Chromium', mono(v.chrome)),
      api.ui.row('Electron', mono(v.electron)),
      api.ui.row('Node.js', mono(v.node))));

    function folderRow(label, which, hint) {
      const path = mono('…');
      const btn = h('button.k-btn.k-btn-sm', { type: 'button' }, U.icon('folder', 13), 'Открыть папку');
      btn.addEventListener('click', () => {
        api.invoke('kosmo:tools.openFolder', { which }).catch((e) => api.toast(errText(e), { tone: 'danger' }));
      });
      const row = api.ui.row(label, btn, hint, { stack: false, keywords: which });
      row.querySelector('.ks-row-text').appendChild(h('div.tps-path-line', path));
      return { row, path };
    }
    const fUser = folderRow('Профиль', 'userData', 'Настройки, сессия вкладок, история, закладки, сниппеты, расширения');
    const fInbox = folderRow('Файлы для Claude', 'inbox', 'Сюда сохраняются страницы и отчёты «Отправить в Claude». Папку можно сменить в разделе Claude');
    const fSnip = h('span.k-mono.k-dim.tps-path', '…');
    el.appendChild(api.ui.group('Данные', fUser.row, fInbox.row, api.ui.row('Сниппеты хранятся в файле', fSnip)));

    el.appendChild(api.ui.group('Лицензии',
      api.ui.free(h('div.tps-lic',
        LICENSES.map(([name, lic, url]) => h('div.tps-lic-row', h('a', { href: url, target: '_blank', rel: 'noreferrer' }, name), h('span.k-dim', lic))))),
      api.ui.free(h('p.tps-lic-note', 'electron-chrome-extensions распространяется по GPL-3.0: при передаче Космолёта другим людям вместе с ним передаётся и исходный код. Значок и интерфейс Космолёта — часть этого проекта.'))));

    api.invoke('kosmo:app.info', {}).then((info) => {
      if (!info) return;
      ver.textContent = 'версия ' + (info.version || '—');
      appVer.textContent = (info.version || '—') + (info.profile ? ' · профиль ' + info.profile : '') + (info.dev ? ' · режим разработки' : '');
    }).catch(() => { ver.textContent = 'версия —'; });
    api.invoke('kosmo:tools.paths', {}).then((p) => {
      if (!p) return;
      fUser.path.textContent = p.userData || '—';
      fInbox.path.textContent = p.inbox || '—';
      fSnip.textContent = p.snippets || '—';
    }).catch((e) => {
      fUser.path.textContent = fInbox.path.textContent = 'недоступно: ' + errText(e);
    });
  }
});
