// Владелец: tools-pack (база — core). «Производительность»: выгрузка неактивных вкладок, восстановление сессии,
// память процессов (app.getAppMetrics) по вкладкам с кнопкой «Выгрузить».
'use strict';
KSettings.section({
  id: 'performance', title: 'Производительность', icon: 'gauge', order: 80,
  keywords: 'память выгрузка вкладок сессия восстановление скорость процессы оперативная ram cpu',
  render(el, api) {
    const U = window.KUI;
    const { h } = U;
    const ui = api.ui;
    U.css('sections/tools-pack.css');
    const errText = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
    const mb = (kb) => U.formatBytes((kb || 0) * 1024);
    const hostOf = (u) => { try { const x = new URL(u); return x.protocol === 'kosmo:' ? 'Космолёт' : x.hostname || u; } catch (e) { return u || ''; } };

    el.append(
      ui.group(null,
        ui.number('Выгружать неактивные вкладки через', 'performance.discardAfterMin', { min: 0, max: 1440, unit: 'мин', hint: '0 — не выгружать. Закреплённые, играющие звук и с открытыми DevTools не выгружаются' }),
        ui.toggle('Восстанавливать вкладки при запуске', 'performance.restoreSession', 'Вкладки открываются лениво — грузятся при первом переходе на них')));

    // ---------- память ----------
    const total = h('div.tps-mem-total', h('span.k-spinner'), 'Считаю память…');
    const refresh = h('button.k-btn.k-btn-sm', { type: 'button', title: 'Обновить сейчас' }, U.icon('rotate-cw', 13), 'Обновить');
    const tabsBox = h('div.tps-mem-list');
    const procBox = h('div.tps-mem-list.tps-mem-procs');
    const procToggle = h('button.tps-linkbtn', { type: 'button' }, 'Показать процессы браузера');
    procBox.hidden = true;
    procToggle.addEventListener('click', () => { procBox.hidden = !procBox.hidden; procToggle.textContent = procBox.hidden ? 'Показать процессы браузера' : 'Скрыть процессы браузера'; });
    const group = ui.group('Память',
      ui.free(h('div.tps-mem-head', total, h('span.k-grow'), refresh)),
      ui.free(tabsBox),
      ui.free(h('div.tps-mem-foot', procToggle, h('span.tps-mem-note', 'Обновляется раз в 3 с, пока раздел открыт')), procBox));
    group.classList.add('tps-mem');
    el.appendChild(group);

    const TYPE = { Browser: 'Основной процесс', GPU: 'Графика (GPU)', Utility: 'Служебный', Tab: 'Страница', Zygote: 'Zygote', 'Sandbox helper': 'Песочница', 'Pepper Plugin': 'Плагин', Unknown: 'Прочее' };
    const UTIL = { 'Network Service': 'Сеть', 'Audio Service': 'Звук', 'Storage Service': 'Хранилище', 'Video Capture': 'Захват видео', 'Data Decoder Service': 'Разбор данных', 'Unzipper': 'Распаковка' };
    function procTitle(p) {
      if (p.type === 'Utility') return UTIL[p.name] || ('Служебный: ' + (p.name || 'без имени'));
      if (p.type === 'Tab') {
        const tabs = p.owners.filter((o) => o.kind === 'tab');
        const other = p.owners.filter((o) => o.kind !== 'tab');
        if (tabs.length) return tabs.length === 1 ? 'Вкладка: ' + tabs[0].title : 'Вкладки (' + tabs.length + '): ' + tabs.map((o) => o.title).join(', ');
        if (other.length) return other.map((o) => o.title).join(', ');
        return 'Страница';
      }
      return TYPE[p.type] || p.type;
    }

    let busy = false, lastOk = 0;
    function load() {
      if (busy) return;
      busy = true;
      api.invoke('kosmo:tools.metrics', {}).then(renderMem).catch((e) => {
        if (!lastOk) { U.clear(tabsBox).appendChild(api.empty({ icon: 'alert-triangle', title: 'Не удалось получить данные о памяти', text: errText(e), tone: 'error' })); total.textContent = ''; }
      }).finally(() => { busy = false; });
    }
    function renderMem(m) {
      lastOk = Date.now();
      const tabs = (m.tabs || []).slice().sort((a, b) => (a.discarded - b.discarded) || (b.memKB - a.memKB));
      const live = tabs.filter((t) => !t.discarded).length;
      total.replaceChildren(h('b', mb(m.totalKB)), h('span', ' всего · процессов ' + (m.processes || []).length + ' · вкладок в памяти ' + live + ' из ' + tabs.length));
      U.clear(tabsBox);
      if (!tabs.length) tabsBox.appendChild(h('div.tps-none', 'Вкладок нет'));
      const max = Math.max(1, ...tabs.map((t) => t.memKB || 0));
      for (const t of tabs) {
        const fav = t.favicon ? h('img.tps-fav', { src: t.favicon, alt: '', referrerpolicy: 'no-referrer' }) : h('span.tps-fav', U.icon(/^kosmo:/.test(t.url) ? 'orbit' : 'globe', 14));
        if (t.favicon) fav.addEventListener('error', () => fav.replaceWith(h('span.tps-fav', U.icon('globe', 14))), { once: true });
        const sub = [hostOf(t.url)];
        if (t.active) sub.push('активная');
        if (t.pinned) sub.push('закреплена');
        if (t.audible) sub.push('играет звук');
        if (t.discarded) sub.push('выгружена');
        else if (t.shared > 1) sub.push('процесс общий с ещё ' + (t.shared - 1));
        const btn = h('button.k-btn.k-btn-sm', { type: 'button', disabled: t.discarded || t.active, title: t.active ? 'Активную вкладку выгрузить нельзя' : t.discarded ? 'Уже выгружена' : 'Освободить память — страница загрузится заново при переходе' }, t.discarded ? 'Выгружена' : 'Выгрузить');
        btn.addEventListener('click', () => {
          btn.disabled = true;
          api.invoke('kosmo:tools.discardTab', { id: t.id }).then((ok) => { if (!ok) api.toast('Эту вкладку выгрузить нельзя'); setTimeout(load, 300); }).catch((e) => { api.toast(errText(e), { tone: 'danger' }); btn.disabled = false; });
        });
        tabsBox.appendChild(h('div.tps-mem-row' + (t.discarded ? '.off' : ''),
          fav,
          h('div.tps-mem-text', h('div.tps-mem-title.k-ellipsis', { title: t.url }, t.title || t.url), h('div.tps-mem-sub.k-ellipsis', sub.join(' · '))),
          h('div.tps-mem-val', t.discarded ? h('span.k-faint', '—') : [h('span', mb(t.memKB)), h('span.tps-bar', h('span', { style: { width: Math.max(3, Math.round((t.memKB / max) * 100)) + '%' } }))]),
          btn));
      }
      U.clear(procBox);
      const procs = (m.processes || []).slice().sort((a, b) => b.memKB - a.memKB);
      for (const p of procs) {
        procBox.appendChild(h('div.tps-proc',
          h('span.tps-proc-title.k-ellipsis', { title: procTitle(p) }, procTitle(p)),
          h('span.tps-proc-meta', 'PID ' + p.pid),
          h('span.tps-proc-meta', p.cpu ? p.cpu.toString().replace('.', ',') + '% ЦП' : ''),
          h('span.tps-proc-mem', mb(p.memKB))));
      }
    }
    refresh.addEventListener('click', load);
    load();
    const timer = setInterval(() => {
      if (!el.isConnected) { clearInterval(timer); return; }
      const sec = el.closest('.ks-section');
      if (document.visibilityState === 'visible' && sec && !sec.hidden) load();
    }, 3000);
  }
});
