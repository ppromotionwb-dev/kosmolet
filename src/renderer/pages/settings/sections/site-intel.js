// Владелец: site-intel. Группа «Знания о сайтах» в разделе «Инструменты разработчика» (раздел devtools вызывает
// KSiteIntelSettings.render(el, api) в конце своего render): сбор каталога API, исключения, список сайтов и очистка.
'use strict';
window.KSiteIntelSettings = {
  render(el, api) {
    const ui = api.ui;
    const h = api.h;
    const U = window.KUI;
    U.css('sections/site-intel.css');
    const errText = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');

    // исключения: по одному сайту в строке
    const ta = h('textarea.k-textarea.k-mono.ksi-exclude', { rows: 3, spellcheck: 'false', placeholder: 'bank.ru\nmail.example.com', 'aria-label': 'Исключения' });
    ui.watch('siteIntel.exclude', (v) => { if (document.activeElement !== ta) ta.value = Array.isArray(v) ? v.join('\n') : ''; });
    ta.addEventListener('change', () => {
      const list = Array.from(new Set(ta.value.split(/[\n,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))).slice(0, 200);
      api.set('siteIntel.exclude', list).catch(() => {});
    });

    const list = h('div.ksi-sites');
    const clearAll = h('button.k-btn.k-btn-sm.k-btn-danger', { type: 'button' }, U.icon('trash', 14), 'Очистить всё');
    let armedAll = 0;
    clearAll.addEventListener('click', async () => {
      if (Date.now() - armedAll > 3000) { armedAll = Date.now(); clearAll.lastChild.textContent = 'Точно удалить всё?'; setTimeout(() => { clearAll.lastChild.textContent = 'Очистить всё'; }, 3000); return; }
      armedAll = 0;
      try { await api.invoke('kosmo:siteIntel.clearAll'); api.toast('Знания о сайтах удалены'); refresh(); } catch (e) { api.toast(errText(e), { tone: 'danger' }); }
    });

    async function refresh() {
      let r;
      try { r = await api.invoke('kosmo:siteIntel.sites'); } catch (e) { U.clear(list); list.appendChild(h('div.ks-note', 'Не удалось получить список: ' + errText(e))); return; }
      U.clear(list);
      const sites = (r && r.sites) || [];
      clearAll.hidden = !sites.length;
      if (!sites.length) { list.appendChild(h('div.ksi-empty', 'Пока пусто: сайты появятся, когда страницы начнут делать API-запросы.')); return; }
      const total = sites.reduce((s, x) => s + (x.bytes || 0), 0);
      list.appendChild(h('div.ksi-total', `${sites.length} ${U.plural(sites.length, ['сайт', 'сайта', 'сайтов'])} · ${U.formatBytes(total)}`));
      for (const s of sites) {
        const del = h('button.k-btn.k-btn-sm.k-btn-ghost', { type: 'button', title: 'Удалить всё, что браузер знает об этом сайте' }, 'Очистить');
        del.addEventListener('click', async () => {
          try { await api.invoke('kosmo:siteIntel.forget', { site: s.site }); refresh(); } catch (e) { api.toast(errText(e), { tone: 'danger' }); }
        });
        list.appendChild(h('div.ksi-site',
          h('div.ksi-site-text',
            h('div.ksi-site-name.k-ellipsis', s.site),
            h('div.ksi-site-sub', `${s.endpoints} API · ${s.notes} ${U.plural(s.notes, ['заметка', 'заметки', 'заметок'])} · ${U.formatBytes(s.bytes || 0)} · ${U.timeAgo(s.updated)}`)),
          del));
      }
    }

    el.append(ui.group('Знания о сайтах',
      ui.toggle('Собирать каталог API сайтов', 'siteIntel.enabled', 'Браузер запоминает, какие API вызывает сайт, с какими параметрами и после каких кнопок — для Claude и инструмента «Сайт». Только имена и типы полей, без значений и паролей; всё хранится на этом компьютере'),
      ui.row('Не собирать на сайтах', ta, 'По одному сайту в строке, поддомены входят', { stack: true }),
      ui.row('Собранные сайты', clearAll, 'Заметки Claude удаляются вместе с сайтом', { stack: false }),
      ui.free(list)));
    refresh();
  },
};
