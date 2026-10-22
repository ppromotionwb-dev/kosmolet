// Владелец: platform. Раздел «Приватность и блокировка»: блокировщик, исключения, User-Agent,
// очистка кэша и cookies, сохранённые разрешения сайтов.
'use strict';
(function () {
  const U = window.KUI;
  const { h } = U;
  U.css('sections/privacy.css');

  const I = window.KIcons;
  if (I && I.add) {
    if (!I.has('bell')) I.add('bell', '<path d="M10.27 21a2 2 0 0 0 3.46 0"/><path d="M3.26 15.33A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.67C19.41 13.96 18 12.5 18 8A6 6 0 0 0 6 8c0 4.5-1.41 5.96-2.74 7.33"/>');
    if (!I.has('map-pin')) I.add('map-pin', '<path d="M20 10c0 4.99-5.54 10.19-7.4 11.8a1 1 0 0 1-1.2 0C9.54 20.19 4 14.99 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>');
    if (!I.has('video')) I.add('video', '<path d="m16 13 5.22 3.48a.5.5 0 0 0 .78-.42V7.94a.5.5 0 0 0-.76-.43L16 10.5"/><rect x="2" y="6" width="14" height="12" rx="2"/>');
    if (!I.has('mic')) I.add('mic', '<path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/>');
    if (!I.has('music')) I.add('music', '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>');
    if (!I.has('clipboard')) I.add('clipboard', '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>');
  }

  const clean = (e) => String((e && e.message) || e || '').replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '').replace(/^./, (c) => c.toUpperCase());
  const normHost = (s) => {
    let v = String(s || '').trim().toLowerCase();
    v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/[/?#].*$/, '').replace(/^[^@]*@/, '');
    if (!v.startsWith('[')) v = v.replace(/:\d+$/, '');
    return v.replace(/^\*\./, '').replace(/^www\./, '').replace(/\.$/, '');
  };
  const validHost = (v) => /^(localhost|\[[0-9a-f:]+\]|(\d{1,3}\.){3}\d{1,3}|([a-z0-9Ѐ-ӿ_-]+\.)+[a-zЀ-ӿ0-9-]{2,})$/i.test(v);

  KSettings.section({
    id: 'privacy', title: 'Приватность и блокировка', icon: 'shield', order: 50,
    keywords: 'реклама блокировщик adblock трекеры исключения белый список приватность user-agent юзер агент кэш cookies разрешения уведомления камера микрофон геолокация',
    description: 'Встроенный блокировщик рекламы и трекеров, исключения для рабочих кабинетов, User-Agent и разрешения, которые вы дали сайтам.',
    render(el, api) {
      const ui = api.ui;
      const anchor = (text) => h('div.ks-row', { hidden: true, dataset: { search: text } });

      // ---------- блокировщик ----------
      const statusText = h('span.kpv-status');
      const updBtn = h('button.k-btn.k-btn-sm', { type: 'button' }, U.icon('rotate-cw', 14), 'Обновить');
      updBtn.addEventListener('click', () => {
        updBtn.disabled = true;
        statusText.textContent = 'Скачиваю и собираю списки…';
        api.invoke('kosmo:adblock.update', {}).then(showStatus).catch((e) => api.toast(clean(e), { tone: 'danger' })).finally(() => { updBtn.disabled = false; });
      });
      function showStatus(s) {
        if (!s) return;
        if (!s.enabled) statusText.textContent = s.ready ? 'Блокировщик выключен' : 'Блокировщик выключен — списки не загружались';
        else if (s.loading && !s.ready) statusText.textContent = 'Загружаю списки…';
        else if (!s.ready && s.error) statusText.textContent = 'Не загрузились: ' + s.error;
        else if (!s.ready) statusText.textContent = 'Списки загрузятся через пару секунд после старта';
        else statusText.textContent = 'Обновлены ' + U.formatDate(s.updatedAt, true) + ' · ' + U.formatBytes(s.size) + (s.total ? ' · за сеанс заблокировано ' + new Intl.NumberFormat('ru-RU').format(s.total) : '') + (s.loading ? ' · обновляются…' : '');
      }
      el.appendChild(ui.group('Блокировщик рекламы',
        ui.toggle('Блокировать рекламу и трекеры', 'privacy.adblock', 'EasyList, EasyPrivacy и фильтры uBlock Origin — во всех контейнерах. Списки обновляются сами раз в неделю.'),
        ui.row('Списки фильтров', updBtn, statusText, { keywords: 'easylist обновить списки фильтров' })));
      api.invoke('kosmo:adblock.state', {}).then(showStatus).catch(() => {});
      U.on('kosmo:adblock.status', showStatus);

      // ---------- исключения ----------
      const allowList = h('div.kpv-allow');
      const allowInput = h('input.k-input.kpv-allow-input', { type: 'text', placeholder: 'site.ru или адрес страницы', spellcheck: 'false', 'aria-label': 'Добавить сайт в исключения' });
      const allowAdd = h('button.k-btn.k-btn-sm', { type: 'button' }, U.icon('plus', 14), 'Добавить');
      const allowErr = h('div.kpv-err', { hidden: true });
      function allowValues() { const v = api.get('privacy.adblockAllow'); return Array.isArray(v) ? v : []; }
      function renderAllow() {
        U.clear(allowList);
        const vals = allowValues();
        if (!vals.length) { allowList.appendChild(h('div.kpv-empty.k-faint', 'Исключений нет — фильтруются все сайты.')); return; }
        for (const v of vals) {
          const rm = h('button.k-icon-btn.k-icon-btn-sm', { type: 'button', title: 'Убрать из исключений', 'aria-label': 'Убрать ' + v, html: I.get('x', 14) });
          rm.addEventListener('click', () => api.set('privacy.adblockAllow', allowValues().filter((x) => x !== v)).catch(() => {}));
          allowList.appendChild(h('div.kpv-chip', h('span.kpv-chip-text', v), rm));
        }
      }
      function addAllow() {
        const v = normHost(allowInput.value);
        allowErr.hidden = true;
        if (!v) return;
        if (!validHost(v)) { allowErr.textContent = 'Не похоже на адрес сайта: ' + allowInput.value.trim(); allowErr.hidden = false; return; }
        const cur = allowValues();
        if (cur.map(normHost).includes(v)) { allowErr.textContent = v + ' уже в списке'; allowErr.hidden = false; return; }
        api.set('privacy.adblockAllow', cur.concat(v)).then(() => { allowInput.value = ''; }).catch(() => {});
      }
      allowAdd.addEventListener('click', addAllow);
      allowInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addAllow(); } });
      allowInput.addEventListener('input', () => { allowErr.hidden = true; });
      ui.watch('privacy.adblockAllow', renderAllow);
      el.appendChild(ui.group('Исключения',
        ui.free(h('p.kpv-hint', 'Сайты из списка не фильтруются вовсе — для кабинетов маркетплейсов и своих проектов. Поддомены тоже: «ozon.ru» покрывает seller.ozon.ru. Быстрее всего — щитом в адресной строке.')),
        ui.free(allowList),
        ui.free(h('div.kpv-allow-add', allowInput, allowAdd), allowErr),
        anchor('исключения белый список сайты без блокировки кабинеты маркетплейсов localhost')));

      // ---------- User-Agent ----------
      const uaNow = h('div.kpv-ua.k-mono');
      function showUa() {
        api.invoke('kosmo:privacy.uaInfo', {}).then((r) => { if (r) uaNow.textContent = r.current; }).catch(() => {});
      }
      const custom = ui.text('Свой User-Agent', 'privacy.customUA', { placeholder: 'Mozilla/5.0 (…) …', mono: true, stack: true, hint: 'Применяется ко всем контейнерам сразу; открытые страницы увидят его после обновления.' });
      ui.watch('privacy.userAgent', (v) => { custom.hidden = v !== 'custom'; showUa(); });
      ui.watch('privacy.customUA', () => setTimeout(showUa, 50));
      el.appendChild(ui.group('User-Agent',
        ui.segmented('Как представляться сайтам', 'privacy.userAgent', [['chrome', 'Chrome'], ['custom', 'Свой']], 'По умолчанию — обычный Chrome для Windows, без упоминаний Electron'),
        custom,
        ui.free(h('div.kpv-ua-wrap', h('div.kpv-ua-label.k-faint', 'Сейчас сайты видят:'), uaNow)),
        anchor('user-agent юзер агент браузер представляться')));

      // ---------- данные сайтов ----------
      let cookieConfirm = false;
      const cacheBtn = h('button.k-btn', { type: 'button' }, 'Очистить кэш');
      cacheBtn.addEventListener('click', () => {
        cacheBtn.disabled = true;
        api.invoke('kosmo:privacy.clearCache', {}).then(() => api.toast('Кэш очищен во всех контейнерах')).catch((e) => api.toast(clean(e), { tone: 'danger' })).finally(() => { cacheBtn.disabled = false; });
      });
      const cookieBox = h('div.kpv-confirm-box');
      function renderCookie() {
        U.clear(cookieBox);
        if (!cookieConfirm) {
          const b = h('button.k-btn.k-btn-danger', { type: 'button' }, 'Удалить cookies…');
          b.addEventListener('click', () => { cookieConfirm = true; renderCookie(); });
          cookieBox.appendChild(b);
          return;
        }
        const yes = h('button.k-btn.k-btn-danger', { type: 'button' }, 'Удалить');
        const no = h('button.k-btn', { type: 'button' }, 'Отмена');
        no.addEventListener('click', () => { cookieConfirm = false; renderCookie(); });
        yes.addEventListener('click', () => {
          yes.disabled = no.disabled = true;
          api.invoke('kosmo:privacy.clearCookies', {}).then((r) => api.toast('Cookies удалены' + (r && r.containers ? ' в контейнерах: ' + r.containers : '')))
            .catch((e) => api.toast(clean(e), { tone: 'danger' }))
            .finally(() => { cookieConfirm = false; renderCookie(); });
        });
        cookieBox.append(h('span.kpv-confirm-text', 'Выйти со всех сайтов во всех контейнерах?'), no, yes);
      }
      renderCookie();
      el.appendChild(ui.group('Данные сайтов',
        ui.row('Кэш', cacheBtn, 'Картинки, скрипты и стили, сохранённые для ускорения. Входы на сайты останутся.', { keywords: 'очистить кэш' }),
        ui.row('Cookies всех контейнеров', cookieBox, 'Удалит входы на все сайты. Данные одного контейнера — в разделе «Контейнеры».', { keywords: 'cookies куки выйти очистить' })));

      // ---------- разрешения сайтов ----------
      const permBox = h('div.kpv-perms');
      function renderPerms(rows) {
        U.clear(permBox);
        if (!rows || !rows.length) {
          permBox.appendChild(h('div.kpv-empty.k-faint', 'Сохранённых решений нет. Когда сайт попросит камеру, уведомления и т. п., под адресной строкой появится запрос — с галкой «Запомнить» решение попадёт сюда.'));
          return;
        }
        for (const r of rows) {
          const chips = h('div.kpv-pchips');
          for (const it of r.items) {
            const rm = h('button.kpv-pchip-x', { type: 'button', title: 'Забыть решение', 'aria-label': 'Забыть: ' + it.label, html: I.get('x', 12) });
            rm.addEventListener('click', () => api.invoke('kosmo:perm.revoke', { origin: r.origin, key: it.key }).then(loadPerms).catch((e) => api.toast(clean(e), { tone: 'danger' })));
            chips.appendChild(h('span.kpv-pchip' + (it.value === 'allow' ? '.allow' : '.deny'), { title: (it.value === 'allow' ? 'Разрешено: ' : 'Запрещено: ') + it.label },
              U.icon(it.icon || 'shield', 13), h('span', it.label), h('span.kpv-pchip-v', it.value === 'allow' ? 'да' : 'нет'), rm));
          }
          const forget = h('button.k-btn.k-btn-sm.k-btn-ghost', { type: 'button' }, 'Забыть всё');
          forget.addEventListener('click', () => api.invoke('kosmo:perm.revoke', { origin: r.origin }).then(loadPerms).catch((e) => api.toast(clean(e), { tone: 'danger' })));
          permBox.appendChild(h('div.kpv-prow', h('div.kpv-pmain', h('div.kpv-phost', { title: r.origin }, r.host), chips), forget));
        }
      }
      function loadPerms() { return api.invoke('kosmo:perm.list', {}).then(renderPerms).catch((e) => { U.clear(permBox).appendChild(h('div.kpv-err', clean(e))); }); }
      api.on((_s, p) => { if (!p || p === 'sitePermissions' || String(p).startsWith('sitePermissions')) loadPerms(); });
      loadPerms();
      el.appendChild(ui.group('Разрешения сайтов', ui.free(permBox), anchor('разрешения сайтов уведомления камера микрофон местоположение буфер обмена midi экран внешние приложения')));
    }
  });
})();
