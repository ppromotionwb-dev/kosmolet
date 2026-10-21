// Владелец: devtools. Инструмент «Хранилище»: cookies сайта (в сессии контейнера вкладки), localStorage и
// sessionStorage страницы, очистка данных сайта. Данные и запись — в main (kosmo:storage.*).
'use strict';
(function () {
  const U = window.KUI;
  const D = window.KDev;
  const { h } = U;
  U.css('tools/storage.css');

  const SAMESITE = [['unspecified', 'Не задан'], ['lax', 'Lax'], ['strict', 'Strict'], ['no_restriction', 'None']];
  const sameSiteTitle = (v) => (SAMESITE.find((x) => x[0] === v) || [v, v])[1];

  function expiresText(c) {
    if (c.session || !c.expirationDate) return 'сеанс';
    const d = new Date(c.expirationDate * 1000);
    if (isNaN(d)) return '—';
    return d.toLocaleDateString('ru-RU') + ' ' + d.toTimeString().slice(0, 5);
  }
  function toLocalInput(sec) {
    const d = new Date(sec * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  KPanel.register({
    id: 'storage', title: 'Хранилище', icon: 'database', order: 30,
    mount(el, api) {
      el.classList.add('ks');
      const st = { tabId: null, tab: ls('tab', 'cookies'), data: null, web: { local: null, session: null }, filter: '', editing: null, visible: false, seq: 0 };
      function ls(k, d) { try { const v = localStorage.getItem('kosmo.storage.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
      function lsSet(k, v) { try { localStorage.setItem('kosmo.storage.' + k, JSON.stringify(v)); } catch (e) { /* нет */ } }
      const fail = (e) => api.toast(D.errText(e), { tone: 'danger', ms: 3500 });

      // ---------- шапка ----------
      const siteHost = h('div.ks-host.k-ellipsis');
      const siteSub = h('div.ks-sub.k-ellipsis');
      const refreshBtn = D.iconBtn('rotate-cw', 'Обновить', () => load());
      const head = h('div.ks-head', h('span.ks-ic', U.icon('database', 16)), h('div.ks-site', siteHost, siteSub), refreshBtn);

      const tabsEl = h('div.k-tabs.ks-tabs', { role: 'tablist' });
      const tabBtns = {};
      for (const [k, title] of [['cookies', 'Cookies'], ['local', 'localStorage'], ['session', 'sessionStorage']]) {
        const b = h('button', { type: 'button', role: 'tab' }, title, h('span.ks-n'));
        b.addEventListener('click', () => { st.tab = k; lsSet('tab', k); st.editing = null; render(); });
        tabBtns[k] = b;
        tabsEl.appendChild(b);
      }

      const filterIn = h('input.k-input.k-input-sm', { type: 'text', spellcheck: 'false', placeholder: 'Фильтр по имени и значению', 'aria-label': 'Фильтр' });
      filterIn.addEventListener('input', U.debounce(() => { st.filter = filterIn.value.trim().toLowerCase(); renderBody(); }, 100));
      const addBtn = h('button.k-btn.k-btn-sm', { type: 'button' }, U.icon('plus', 13), 'Добавить');
      addBtn.addEventListener('click', () => { st.editing = { isNew: true }; renderBody(); });
      const moreBtn = D.iconBtn('more-vertical', 'Ещё', (e) => moreMenu(e.currentTarget));
      const tools = h('div.ks-tools', h('label.k-search.ks-filter', U.icon('search', 13), filterIn), addBtn, moreBtn);

      const body = h('div.ks-body');
      const foot = h('div.ks-foot');
      el.append(head, tabsEl, tools, body, foot);

      // ---------- загрузка ----------
      async function load() {
        const tabId = st.tabId;
        if (tabId == null) { st.data = null; render(); return; }
        const my = ++st.seq;
        try {
          const [c, l, s] = await Promise.all([
            api.invoke('kosmo:storage.cookies', { tabId }),
            api.invoke('kosmo:storage.web', { tabId, kind: 'local' }).catch((e) => ({ error: D.errText(e), items: [] })),
            api.invoke('kosmo:storage.web', { tabId, kind: 'session' }).catch((e) => ({ error: D.errText(e), items: [] }))
          ]);
          if (my !== st.seq) return;
          st.data = c; st.web.local = l; st.web.session = s;
        } catch (e) {
          if (my !== st.seq) return;
          st.data = { error: D.errText(e), cookies: [] };
        }
        render();
      }

      function render() {
        const c = st.data;
        siteHost.textContent = c && c.host ? c.host : (c && c.url ? U.parseUrl(c.url).display : '—');
        siteSub.textContent = c && c.site ? `cookies домена ${c.site} · контейнер «${c.containerName || c.containerId}»` : '';
        for (const k of Object.keys(tabBtns)) {
          tabBtns[k].setAttribute('aria-selected', st.tab === k ? 'true' : 'false');
          const n = k === 'cookies' ? (c && c.cookies ? c.cookies.length : 0) : (st.web[k] && st.web[k].items ? st.web[k].items.length : 0);
          tabBtns[k].querySelector('.ks-n').textContent = n ? String(n) : '';
        }
        renderBody();
        renderFoot();
      }

      function unsupported() {
        const c = st.data;
        return !c || c.unsupported || c.error;
      }

      function renderBody() {
        U.clear(body);
        const c = st.data;
        tools.hidden = !!unsupported();
        if (st.tabId == null) { body.appendChild(api.empty({ icon: 'database', title: 'Нет вкладки', text: 'Откройте сайт, чтобы смотреть его cookies и хранилище.' })); return; }
        if (!c) { body.appendChild(h('div.kd-loading', h('span.k-spinner'), 'Загружаю…')); return; }
        if (c.error) { body.appendChild(api.empty({ icon: 'alert-triangle', title: 'Не удалось прочитать', text: c.error, tone: 'error' })); return; }
        if (c.unsupported) { body.appendChild(api.empty({ icon: 'database', title: 'Здесь нет хранилища сайта', text: 'Cookies и localStorage есть только у http(s)-страниц.' })); return; }
        if (st.tab === 'cookies') renderCookies(); else renderWeb(st.tab);
      }

      // ---------- cookies ----------
      function renderCookies() {
        const list = (st.data.cookies || []).filter((x) => !st.filter || (x.name + '\n' + x.value + '\n' + x.domain).toLowerCase().includes(st.filter));
        if (st.editing && st.editing.isNew) body.appendChild(cookieEditor(null));
        if (!list.length) {
          body.appendChild(api.empty({ icon: 'cookie', title: st.filter ? 'Ничего не найдено' : 'Cookies нет', text: st.filter ? 'Измените фильтр.' : 'Сайт пока ничего не сохранил.' }));
          return;
        }
        const box = h('div.ks-list');
        for (const ck of list) {
          const key = ck.domain + '|' + ck.path + '|' + ck.name;
          if (st.editing && st.editing.key === key) { box.appendChild(cookieEditor(ck)); continue; }
          box.appendChild(cookieRow(ck, key));
        }
        body.appendChild(box);
      }

      function cookieRow(ck, key) {
        const val = h('span.ks-val', { title: 'Щелчок — изменить значение' }, ck.value === '' ? h('span.ks-emptyv', 'пусто') : ck.value);
        const flags = [];
        if (ck.httpOnly) flags.push(h('span.ks-flag', { title: 'Недоступна скриптам страницы' }, 'HttpOnly'));
        if (ck.secure) flags.push(h('span.ks-flag', { title: 'Только по HTTPS' }, 'Secure'));
        if (ck.sameSite && ck.sameSite !== 'unspecified') flags.push(h('span.ks-flag', 'SameSite=' + sameSiteTitle(ck.sameSite)));
        const edit = D.iconBtn('pencil', 'Изменить', (e) => { e.stopPropagation(); st.editing = { key }; renderBody(); });
        const copy = D.iconBtn('copy', 'Копировать значение', (e) => { e.stopPropagation(); U.copyText(ck.value); });
        const del = D.iconBtn('trash', 'Удалить', (e) => { e.stopPropagation(); removeCookie(ck); });
        const row = h('div.ks-row' + (ck.sent ? '.sent' : ''),
          h('div.ks-line1', h('span.ks-dot', { title: ck.sent ? 'Отправляется на эту страницу' : 'На эту страницу не отправляется' }), h('span.ks-name', { title: ck.name }, ck.name), val, h('span.ks-acts', copy, edit, del)),
          h('div.ks-line2', h('span', ck.domain + ck.path), h('span.ks-sepd', '·'), h('span', { title: 'Истекает' }, expiresText(ck)), flags));
        // правка значения на месте
        val.addEventListener('click', (e) => {
          e.stopPropagation();
          if (val.querySelector('input')) return;
          const inp = h('input.k-input.k-input-sm.ks-inline', { type: 'text', spellcheck: 'false', value: ck.value });
          U.clear(val); val.appendChild(inp); inp.focus(); inp.select();
          let done = false;
          const finish = (save) => {
            if (done) return; done = true;
            if (save && inp.value !== ck.value) saveCookie(Object.assign({}, ck, { value: inp.value }), ck);
            else renderBody();
          };
          inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { finish(true); ev.preventDefault(); } else if (ev.key === 'Escape') { finish(false); ev.stopPropagation(); } });
          inp.addEventListener('blur', () => finish(true));
        });
        return row;
      }

      function cookieEditor(ck) {
        const isNew = !ck;
        const c = st.data;
        const v = ck || { name: '', value: '', domain: c.host, path: '/', hostOnly: true, secure: /^https:/.test(c.url), httpOnly: false, sameSite: 'lax', session: true, expirationDate: null };
        const name = h('input.k-input.k-input-sm', { type: 'text', spellcheck: 'false', value: v.name, placeholder: 'имя' });
        const value = h('textarea.k-textarea.ks-ta', { spellcheck: 'false', rows: 3 });
        value.value = v.value;
        const domainOpts = [[c.host, c.host + ' (только этот хост)'], ['.' + c.site, '.' + c.site + ' (и поддомены)']];
        if (!isNew && !domainOpts.some(([d]) => d === v.domain)) domainOpts.unshift([v.domain, v.domain]);
        const domain = h('select.k-select.k-input-sm', domainOpts.map(([d, t]) => h('option', { value: d, selected: d === v.domain }, t)));
        const pathIn = h('input.k-input.k-input-sm', { type: 'text', spellcheck: 'false', value: v.path || '/' });
        const session = h('input.k-check', { type: 'checkbox', checked: v.session || !v.expirationDate });
        const exp = h('input.k-input.k-input-sm', { type: 'datetime-local', value: v.expirationDate ? toLocalInput(v.expirationDate) : toLocalInput(Date.now() / 1000 + 30 * 86400) });
        exp.disabled = session.checked;
        session.addEventListener('change', () => { exp.disabled = session.checked; });
        const httpOnly = h('input.k-check', { type: 'checkbox', checked: v.httpOnly });
        const secure = h('input.k-check', { type: 'checkbox', checked: v.secure });
        const sameSite = h('select.k-select.k-input-sm', SAMESITE.map(([k, t]) => h('option', { value: k, selected: k === (v.sameSite || 'unspecified') }, t)));
        const save = h('button.k-btn.k-btn-primary.k-btn-sm', { type: 'button' }, isNew ? 'Добавить' : 'Сохранить');
        const cancel = h('button.k-btn.k-btn-sm.k-btn-ghost', { type: 'button' }, 'Отмена');
        const del = isNew ? null : h('button.k-btn.k-btn-sm.k-btn-danger', { type: 'button' }, U.icon('trash', 13), 'Удалить');
        const form = h('div.ks-editor',
          h('div.ks-fgrid',
            h('label', 'Имя'), name,
            h('label', 'Значение'), value,
            h('label', 'Домен'), domain,
            h('label', 'Путь'), pathIn,
            h('label', 'Истекает'), h('div.ks-frow', h('label.ks-chk', session, 'до конца сеанса'), exp),
            h('label', 'Флаги'), h('div.ks-frow', h('label.ks-chk', httpOnly, 'HttpOnly'), h('label.ks-chk', secure, 'Secure'), h('span.ks-flabel', 'SameSite'), sameSite)),
          h('div.ks-factions', save, cancel, h('span.kn-grow'), del));
        save.addEventListener('click', () => {
          const d = domain.value;
          const nc = {
            name: name.value.trim(), value: value.value, domain: d, hostOnly: !d.startsWith('.'), path: pathIn.value.trim() || '/',
            secure: secure.checked, httpOnly: httpOnly.checked, sameSite: sameSite.value, session: session.checked,
            expirationDate: session.checked ? null : Math.round(new Date(exp.value).getTime() / 1000)
          };
          if (!nc.name) { api.toast('Нужно имя cookie', { tone: 'danger' }); name.focus(); return; }
          saveCookie(nc, isNew ? null : ck);
        });
        cancel.addEventListener('click', () => { st.editing = null; renderBody(); });
        if (del) del.addEventListener('click', () => removeCookie(ck));
        form.addEventListener('keydown', (e) => { if (e.key === 'Escape') { st.editing = null; renderBody(); e.stopPropagation(); } if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save.click(); });
        setTimeout(() => (isNew ? name : value).focus(), 0);
        return form;
      }

      function saveCookie(nc, original) {
        api.invoke('kosmo:storage.setCookie', { tabId: st.tabId, cookie: nc, original }).then(() => {
          st.editing = null;
          api.toast(original ? 'Cookie сохранена' : 'Cookie добавлена', { tone: 'ok' });
          load();
        }).catch((e) => { fail(e); renderBody(); });
      }
      function removeCookie(ck) {
        api.invoke('kosmo:storage.removeCookie', { tabId: st.tabId, cookie: ck }).then(() => { st.editing = null; api.toast('Удалено: ' + ck.name); load(); }).catch(fail);
      }

      // ---------- localStorage / sessionStorage ----------
      function renderWeb(kind) {
        const w = st.web[kind];
        if (!w) { body.appendChild(h('div.kd-loading', h('span.k-spinner'), 'Загружаю…')); return; }
        if (w.error) { body.appendChild(api.empty({ icon: 'alert-triangle', title: 'Не удалось прочитать', text: w.error, tone: 'error' })); return; }
        if (w.unsupported) { body.appendChild(api.empty({ icon: 'database', title: 'Нет хранилища', text: 'Только для http(s)-страниц.' })); return; }
        if (st.editing && st.editing.isNew) body.appendChild(webEditor(kind, null));
        const items = (w.items || []).filter(([k, v]) => !st.filter || (k + '\n' + v).toLowerCase().includes(st.filter)).sort((a, b) => a[0].localeCompare(b[0]));
        if (!items.length) {
          body.appendChild(api.empty({ icon: 'database', title: st.filter ? 'Ничего не найдено' : 'Пусто', text: st.filter ? 'Измените фильтр.' : (kind === 'local' ? 'localStorage' : 'sessionStorage') + ' страницы ' + (w.origin || '') + ' пуст.' }));
          return;
        }
        const box = h('div.ks-list');
        for (const it of items) {
          const [k, v, len] = it;
          if (st.editing && st.editing.key === k) { box.appendChild(webEditor(kind, it)); continue; }
          const j = D.tryJson(v);
          const isJson = j.ok && typeof j.value === 'object' && j.value !== null;
          const edit = D.iconBtn('pencil', 'Изменить', (e) => { e.stopPropagation(); st.editing = { key: k }; renderBody(); });
          const copy = D.iconBtn('copy', 'Копировать значение', (e) => { e.stopPropagation(); U.copyText(v); });
          const del = D.iconBtn('trash', 'Удалить', (e) => { e.stopPropagation(); webRemove(kind, k); });
          const row = h('div.ks-row.ks-wrow',
            h('div.ks-line1', h('span.ks-name', { title: k }, k), isJson ? h('span.ks-flag.json', 'JSON') : null, h('span.ks-len', U.formatBytes(len || v.length)), h('span.ks-acts', copy, edit, del)),
            h('div.ks-wval', v.length > 400 ? v.slice(0, 400) + '…' : v));
          row.addEventListener('dblclick', () => { st.editing = { key: k }; renderBody(); });
          box.appendChild(row);
        }
        body.appendChild(box);
      }

      function webEditor(kind, it) {
        const isNew = !it;
        const key = h('input.k-input.k-input-sm', { type: 'text', spellcheck: 'false', value: it ? it[0] : '', placeholder: 'ключ' });
        const val = h('textarea.k-textarea.ks-ta.tall', { spellcheck: 'false' });
        let v = it ? it[1] : '';
        const j = D.tryJson(v);
        const wasCompactJson = j.ok && typeof j.value === 'object' && j.value !== null && !/\n/.test(v);
        if (wasCompactJson) v = JSON.stringify(j.value, null, 2);
        val.value = v;
        const truncated = it && it[2] > it[1].length;
        const save = h('button.k-btn.k-btn-primary.k-btn-sm', { type: 'button', disabled: truncated }, isNew ? 'Добавить' : 'Сохранить');
        const cancel = h('button.k-btn.k-btn-sm.k-btn-ghost', { type: 'button' }, 'Отмена');
        const form = h('div.ks-editor',
          h('div.ks-fgrid', h('label', 'Ключ'), key, h('label', 'Значение'), val),
          truncated ? h('div.kd-note.warn', U.icon('alert-triangle', 14), 'Значение больше 1 МБ — показано начало, сохранение отключено.') : null,
          wasCompactJson ? h('div.ks-hint', 'JSON развёрнут для удобства — сохранится компактно.') : null,
          h('div.ks-factions', save, cancel));
        save.addEventListener('click', () => {
          let value = val.value;
          if (wasCompactJson) { const jj = D.tryJson(value); if (jj.ok) value = JSON.stringify(jj.value); }
          if (!key.value) { api.toast('Нужен ключ', { tone: 'danger' }); key.focus(); return; }
          api.invoke('kosmo:storage.webSet', { tabId: st.tabId, kind, key: key.value, value, oldKey: it ? it[0] : null })
            .then(() => { st.editing = null; api.toast('Сохранено', { tone: 'ok' }); load(); }).catch(fail);
        });
        cancel.addEventListener('click', () => { st.editing = null; renderBody(); });
        form.addEventListener('keydown', (e) => { if (e.key === 'Escape') { st.editing = null; renderBody(); e.stopPropagation(); } if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save.click(); });
        setTimeout(() => (isNew ? key : val).focus(), 0);
        return form;
      }
      function webRemove(kind, k) {
        api.invoke('kosmo:storage.webRemove', { tabId: st.tabId, kind, key: k }).then(() => { api.toast('Удалено: ' + k); load(); }).catch(fail);
      }

      // ---------- меню и очистка ----------
      function moreMenu(anchor) {
        if (st.tab === 'cookies') {
          D.menu([
            { title: 'Копировать как заголовок Cookie:', icon: 'copy', onPick: () => api.invoke('kosmo:storage.cookieHeader', { tabId: st.tabId }).then((s) => (s ? U.copyText('Cookie: ' + s, { message: 'Заголовок Cookie скопирован' }) : api.toast('На эту страницу cookies не отправляются'))).catch(fail) },
            { title: 'Копировать как JSON', icon: 'braces', onPick: () => U.copyText(JSON.stringify((st.data.cookies || []).map((c) => { const o = Object.assign({}, c); delete o.sent; return o; }), null, 2)) },
            { sep: true },
            { title: 'Экспорт в файл JSON…', icon: 'download', onPick: () => api.invoke('kosmo:storage.exportCookies', { tabId: st.tabId }).then((r) => { if (r && r.path) api.toast('Сохранено cookies: ' + r.count, { tone: 'ok' }); }).catch(fail) },
            { title: 'Импорт из файла JSON…', icon: 'upload', onPick: () => api.invoke('kosmo:storage.importCookies', { tabId: st.tabId }).then((r) => { if (r && !r.canceled) { api.toast(`Загружено: ${r.ok}` + (r.fail ? `, с ошибкой: ${r.fail}` : ''), { tone: r.fail ? 'danger' : 'ok' }); load(); } }).catch(fail) },
            { sep: true },
            { title: 'Удалить все cookies домена', icon: 'trash', danger: true, onPick: () => confirmAction('Удалить все cookies домена ' + st.data.site + '?', () => api.invoke('kosmo:storage.clearCookies', { tabId: st.tabId }).then((n) => { api.toast('Удалено cookies: ' + n); load(); })) }
          ], anchor);
        } else {
          const kind = st.tab;
          D.menu([
            { title: 'Копировать всё как JSON', icon: 'braces', onPick: () => { const o = {}; for (const [k, v] of (st.web[kind] && st.web[kind].items) || []) o[k] = v; U.copyText(JSON.stringify(o, null, 2)); } },
            { sep: true },
            { title: 'Очистить ' + (kind === 'local' ? 'localStorage' : 'sessionStorage'), icon: 'trash', danger: true, onPick: () => confirmAction('Очистить ' + (kind === 'local' ? 'localStorage' : 'sessionStorage') + ' страницы?', () => api.invoke('kosmo:storage.webClear', { tabId: st.tabId, kind }).then(() => { api.toast('Очищено'); load(); })) }
          ], anchor);
        }
      }

      // подтверждение в самой панели: вторая кнопка, без системных диалогов
      function confirmAction(text, fn) {
        U.clear(foot);
        const yes = h('button.k-btn.k-btn-sm.ks-danger-solid', { type: 'button' }, 'Да, удалить');
        const no = h('button.k-btn.k-btn-sm.k-btn-ghost', { type: 'button' }, 'Отмена');
        foot.append(h('div.ks-confirm', U.icon('alert-triangle', 14), h('span.ks-ctext', text), yes, no));
        yes.addEventListener('click', () => { Promise.resolve(fn()).catch(fail).finally(renderFoot); });
        no.addEventListener('click', renderFoot);
        yes.focus();
      }
      function renderFoot() {
        U.clear(foot);
        if (unsupported() || st.tabId == null) { foot.hidden = true; return; }
        foot.hidden = false;
        const origin = (() => { try { return new URL(st.data.url).origin; } catch (e) { return ''; } })();
        const clr = h('button.k-btn.k-btn-sm.k-btn-ghost.k-btn-danger', { type: 'button', title: 'Cookies, localStorage, IndexedDB, кэш service worker и т.п. для ' + origin }, U.icon('trash', 13), 'Очистить данные сайта…');
        clr.addEventListener('click', () => confirmAction('Удалить все данные ' + origin + '? Вы выйдете из аккаунта на этом сайте.', () => api.invoke('kosmo:storage.clearSite', { tabId: st.tabId }).then((r) => {
          api.toast('Данные сайта очищены', { tone: 'ok' });
          load();
          const reload = h('button.k-btn.k-btn-sm', { type: 'button' }, U.icon('rotate-cw', 13), 'Обновить страницу');
          reload.addEventListener('click', () => api.invoke('kosmo:tabs.reload', { id: st.tabId }).catch(fail));
          setTimeout(() => { U.clear(foot); foot.append(h('div.ks-confirm.ok', U.icon('check', 14), h('span.ks-ctext', 'Готово. Чтобы сайт это заметил, обновите страницу.'), reload)); }, 0);
        })));
        foot.appendChild(clr);
      }

      // ---------- вкладка ----------
      function follow(tab) {
        const id = tab ? tab.id : null;
        if (id !== st.tabId) { st.tabId = id; st.editing = null; st.data = null; st.web = { local: null, session: null }; render(); }
        load();
      }
      const reloadSoon = U.debounce(() => { if (st.visible && !st.editing) load(); }, 600);
      api.onTabChange((tab, info) => {
        if (!st.visible) return;
        if (info.reason === 'activated') follow(tab);
        else reloadSoon();
      });
      el._show = () => { st.visible = true; follow(api.activeTab()); };
      el._hide = () => { st.visible = false; D.closeMenu(); };
      el._state = st;
      render();
    },
    onShow(api) { if (api.el && api.el._show) api.el._show(); },
    onHide(api) { if (api.el && api.el._hide) api.el._hide(); }
  });
})();
