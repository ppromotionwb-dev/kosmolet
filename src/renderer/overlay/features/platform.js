// Владелец: platform. Окна overlay: поповер блокировщика ('adblock'), вход на сайт по HTTP ('platform-auth'),
// подтверждение установки расширения ('platform-install').
'use strict';
(function () {
  const U = window.KUI;
  const { h } = U;
  if (!window.KOverlay) return;
  U.css('features/platform.css');

  const nf = new Intl.NumberFormat('ru-RU');
  const clean = (e) => String((e && e.message) || e || '').replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');

  // =====================================================================
  // Поповер блокировщика
  // =====================================================================
  KOverlay.register('adblock', {
    width: 320,
    render(root, data, api) {
      const st = { data: data || {}, s: null, seq: 0, busy: false };
      root.classList.add('kpo-pop');

      // Шапка как у поповера «Тёмная тема»: переключатель справа — для ЭТОГО сайта. Общее выключение — в подвале.
      const ic = h('span.kpo-ic', U.icon('shield', 18));
      const sub = h('div.kpo-sub.k-ellipsis');
      const siteSw = h('input.k-switch', { type: 'checkbox', 'aria-label': 'Блокировка на этом сайте' });
      const head = h('div.kpo-head', ic, h('div.kpo-head-text', h('div.kpo-title', 'Блокировщик рекламы'), sub), siteSw);

      const numPage = h('div.kpo-num');
      const numTotal = h('div.kpo-num');
      const stats = h('div.kpo-stats',
        h('div.kpo-stat', numPage, h('div.kpo-stat-label', 'на странице')),
        h('div.kpo-stat', numTotal, h('div.kpo-stat-label', 'за сеанс')));

      const note = h('div.kpo-note', { hidden: true });
      const settingsBtn = h('button.k-btn.k-btn-sm.k-btn-ghost', { type: 'button' }, U.icon('settings', 14), 'Исключения и настройки');
      settingsBtn.addEventListener('click', () => { api.invoke('kosmo:tabs.create', { url: 'kosmo://settings/#privacy' }).catch(() => {}); api.close(); });
      const globalBtn = h('button.k-btn.k-btn-sm.k-btn-ghost', { type: 'button' });
      const foot = h('div.kpo-foot', settingsBtn, h('span.k-grow'), globalBtn);
      root.append(head, stats, note, foot);

      globalBtn.addEventListener('click', () => {
        if (!st.s) return;
        api.invoke('kosmo:adblock.setEnabled', { value: !st.s.enabled }).then(() => load()).catch(err);
      });
      siteSw.addEventListener('change', () => {
        if (!st.s || !st.s.host) return;
        st.busy = true;
        api.invoke('kosmo:adblock.setSite', { tabId: st.data.tabId, host: st.s.host, block: siteSw.checked, reload: true })
          .then((s) => { st.busy = false; show(s); })
          .catch((e) => { st.busy = false; err(e); load(); });
      });

      function err(e) { api.toast('Не получилось: ' + clean(e), { tone: 'danger' }); }

      function show(s) {
        if (!s) return;
        st.s = s;
        const site = (s.siteKey || s.host || '').replace(/^www\./, '');
        sub.textContent = !s.enabled ? 'Выключен на всех сайтах' : !s.host ? 'Недоступен на этой странице' : site;
        sub.title = s.host || '';
        siteSw.checked = !!(s.enabled && s.host && !s.allowed);
        siteSw.disabled = !s.enabled || !s.host || st.busy;
        siteSw.title = !s.enabled ? 'Блокировщик выключен на всех сайтах — включите его в подвале' : 'Блокировка на ' + site + ' (страница обновится)';
        root.classList.toggle('off', !s.active);
        U.clear(ic).appendChild(U.icon(s.active ? 'shield' : 'shield-off', 18));
        numPage.textContent = nf.format(s.blocked || 0);
        numTotal.textContent = nf.format(s.total || 0);
        stats.classList.toggle('dim', !s.active);
        globalBtn.textContent = s.enabled ? 'Выключить везде' : 'Включить везде';
        globalBtn.classList.toggle('k-btn-ghost', !!s.enabled);
        globalBtn.classList.toggle('k-btn-primary', !s.enabled);
        let n = '';
        if (s.enabled && !s.ready && s.error) n = 'Ошибка загрузки списков: ' + s.error + '. Попробую ещё раз через полчаса.';
        else if (s.enabled && !s.ready) n = 'Первый запуск: списки скачиваются в фоне, это займёт несколько секунд.';
        else if (s.enabled && s.allowed) n = s.allowEntry && s.allowEntry !== site ? 'В исключениях как ' + s.allowEntry + ': реклама и трекеры здесь не режутся.' : 'Сайт в исключениях: реклама и трекеры здесь не режутся.';
        else if (!s.enabled) n = 'Реклама и трекеры не блокируются ни на одном сайте.';
        note.textContent = n;
        note.hidden = !n;
        api.resize();
      }

      function load() {
        const my = ++st.seq;
        return api.invoke('kosmo:adblock.state', { tabId: st.data.tabId }).then((s) => { if (my === st.seq) show(s); }).catch(err);
      }
      api.on('kosmo:adblock.counts', (p) => {
        if (!st.s || !p || !p.changes) return;
        const v = p.changes[String(st.data.tabId)];
        if (v !== undefined) st.s.blocked = v;
        if (p.total !== undefined) st.s.total = p.total;
        numPage.textContent = nf.format(st.s.blocked || 0);
        numTotal.textContent = nf.format(st.s.total || 0);
      });
      api.on('kosmo:adblock.status', () => load());
      st.reload = (d) => { st.data = d || st.data; load(); };
      root._kpo = st;
      load();
    },
    update(data, api) { const st = api.root && api.root._kpo; if (st) st.reload(data); }
  });

  // =====================================================================
  // Вход на сайт (HTTP Basic / Digest / прокси)
  // =====================================================================
  KOverlay.register('platform-auth', {
    width: 380,
    render(root, data, api) {
      data = data || {};
      root.classList.add('kpo-modal');
      let done = false;
      const host = data.host + (data.port && data.port !== 80 && data.port !== 443 ? ':' + data.port : '');
      const title = data.isProxy ? 'Вход на прокси-сервер' : 'Вход на сайт';
      const user = h('input.k-input', { type: 'text', autocomplete: 'username', spellcheck: 'false', 'aria-label': 'Имя пользователя', autofocus: true });
      const pass = h('input.k-input', { type: 'password', autocomplete: 'current-password', 'aria-label': 'Пароль' });
      const ok = h('button.k-btn.k-btn-primary', { type: 'submit' }, 'Войти');
      const cancel = h('button.k-btn', { type: 'button' }, 'Отмена');
      const form = h('form.kpo-form',
        h('div.kpo-mhead', h('span.kpo-ic', U.icon(data.isProxy ? 'server' : 'key', 18)), h('div', h('div.kpo-title', title), h('div.kpo-sub.k-ellipsis', { title: data.url || host }, host))),
        data.realm ? h('div.kpo-realm', 'Сайт пишет: «' + data.realm + '»') : null,
        !data.secure && !data.isProxy && !/^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?)$|\.localhost$/i.test(data.host || '') ? h('div.kpo-warn', U.icon('alert-triangle', 14), h('span', 'Соединение не защищено — пароль уйдёт открытым текстом')) : null,
        h('label.kpo-field', h('span', 'Имя пользователя'), user),
        h('label.kpo-field', h('span', 'Пароль'), pass),
        h('div.kpo-mfoot', cancel, ok));
      root.appendChild(form);

      function answer(result) {
        if (done) return;
        done = true;
        api.invoke('kosmo:platform.modalRespond', { id: data.modalId, result }).then((ok) => { if (!ok) api.close(); }, () => api.close()); // закрывает main
      }
      form.addEventListener('submit', (e) => { e.preventDefault(); answer({ username: user.value, password: pass.value }); });
      cancel.addEventListener('click', () => answer(null));
      requestAnimationFrame(() => user.focus());
    }
  });

  // =====================================================================
  // Установка расширения из Chrome Web Store
  // =====================================================================
  const PERM_RU = {
    tabs: 'видеть адреса и заголовки вкладок', storage: 'хранить свои данные', activeTab: 'доступ к текущей вкладке по клику',
    scripting: 'запускать скрипты на страницах', cookies: 'читать и менять cookies', history: 'читать историю',
    bookmarks: 'читать и менять закладки', downloads: 'управлять загрузками', notifications: 'показывать уведомления',
    contextMenus: 'добавлять пункты в контекстное меню', webRequest: 'видеть сетевые запросы', declarativeNetRequest: 'блокировать и менять запросы',
    clipboardRead: 'читать буфер обмена', clipboardWrite: 'писать в буфер обмена', management: 'управлять расширениями',
    nativeMessaging: 'общаться с программами на компьютере', proxy: 'менять прокси', privacy: 'менять настройки приватности',
    geolocation: 'знать местоположение', webNavigation: 'видеть переходы по страницам', alarms: 'запускаться по таймеру', unlimitedStorage: 'хранить данные без ограничения объёма',
    fontSettings: 'менять настройки шрифтов', offscreen: 'работать в фоновом документе', sidePanel: 'открывать боковую панель',
    tabGroups: 'управлять группами вкладок', identity: 'входить через аккаунт Google', webRequestBlocking: 'блокировать запросы',
    declarativeNetRequestWithHostAccess: 'менять запросы на разрешённых сайтах', declarativeNetRequestFeedback: 'видеть, что заблокировано',
    contentSettings: 'менять настройки сайтов', debugger: 'подключаться к вкладкам как отладчик', topSites: 'видеть часто посещаемые сайты',
    sessions: 'видеть недавно закрытые вкладки', tts: 'озвучивать текст', pageCapture: 'сохранять страницы', favicon: 'видеть значки сайтов',
    search: 'искать через поисковик', idle: 'знать, что компьютер простаивает', power: 'не давать компьютеру уснуть', desktopCapture: 'снимать экран',
    background: 'работать в фоне', userScripts: 'запускать пользовательские скрипты', browsingData: 'удалять данные браузера', readingList: 'управлять списком для чтения',
    'system.display': 'видеть параметры экранов', 'system.cpu': 'видеть данные о процессоре', 'system.memory': 'видеть данные о памяти', contextualIdentities: 'видеть контейнеры'
  };
  KOverlay.register('platform-install', {
    width: 400,
    render(root, data, api) {
      data = data || {};
      root.classList.add('kpo-modal');
      let done = false;
      const icon = data.icon ? h('img.kpo-ext-icon', { src: data.icon, alt: '' }) : h('span.kpo-ic', U.icon('puzzle', 20));
      const perms = (data.permissions || []).map((p) => PERM_RU[p] || p);
      const list = h('ul.kpo-perms');
      if (data.allSites) list.appendChild(h('li.strong', 'читать и менять данные на всех сайтах'));
      else if (data.hosts && data.hosts.length) list.appendChild(h('li', 'данные на сайтах: ' + data.hosts.slice(0, 4).join(', ') + (data.hosts.length > 4 ? '…' : '')));
      for (const p of perms.slice(0, 10)) list.appendChild(h('li', p));
      const ok = h('button.k-btn.k-btn-primary', { type: 'button', autofocus: true }, 'Установить');
      const cancel = h('button.k-btn', { type: 'button' }, 'Отмена');
      root.append(
        h('div.kpo-mhead', icon, h('div', h('div.kpo-title', 'Установить «' + (data.name || data.id) + '»?'), h('div.kpo-sub', data.version ? 'Версия ' + data.version + ' · Chrome Web Store' : 'Chrome Web Store'))),
        list.childNodes.length ? h('div.kpo-perms-wrap', h('div.kpo-label', 'Расширение сможет:'), list) : h('div.kpo-realm', 'Особых разрешений не просит.'),
        h('div.kpo-note', 'Расширение появится во всех контейнерах. Удалить — на странице «Расширения».'),
        h('div.kpo-mfoot', cancel, ok));
      function answer(allow) {
        if (done) return;
        done = true;
        api.invoke('kosmo:platform.modalRespond', { id: data.modalId, result: { allow } }).then((ok) => { if (!ok) api.close(); }, () => api.close());
      }
      ok.addEventListener('click', () => answer(true));
      cancel.addEventListener('click', () => answer(false));
    }
  });
})();
