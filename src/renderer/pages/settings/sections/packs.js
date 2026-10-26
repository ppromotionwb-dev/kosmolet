// Владелец: packs. Раздел «Паки»: список паков (встроенные, установленные, связанные папки), права словами,
// включение по контейнерам, установка из папки (лист прав рисует overlay ядра), обновление, откат, удаление.
'use strict';
(function () {
  const U = window.KUI;
  const { h } = U;
  U.css('sections/packs.css');

  const SOURCE = { builtin: 'встроенный', folder: 'установлен', dev: 'связанная папка' };
  const clean = (e) => String((e && e.message) || e || '').replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '').replace(/^./, (c) => c.toUpperCase());
  function initials(name) {
    const w = String(name || '').split(/[\s:·,.-]+/).filter(Boolean);
    return ((w[0] || '?')[0] + (w[1] ? w[1][0] : (w[0] || '')[1] || '')).toUpperCase();
  }

  KSettings.section({
    id: 'packs', title: 'Паки', icon: 'box', order: 45,
    keywords: 'паки пакеты расширения сайты умолчания бэнги закладки операции установить папка связать разработка права контейнеры',
    description: 'Паки добавляют знания о конкретных сайтах: умолчания, скрипты страниц, поля контейнеров и операции. Пак — это декларации: исполняет и рисует их сам Космолёт, своего кода в браузере у пака нет.',
    render(el, api) {
      const ui = api.ui;
      const anchor = (text) => h('div.ks-row', { hidden: true, dataset: { search: text } });
      const listEl = h('div.kpk-list');
      const msg = h('div.kpk-msg', { hidden: true });
      const installBtn = h('button.k-btn.k-btn-primary.k-btn-sm', { type: 'button' }, U.icon('folder', 14), 'Установить из папки…');
      const linkBtn = h('button.k-btn.k-btn-ghost.k-btn-sm', { type: 'button', title: 'Пак работает прямо из папки и перезагружается при изменении файлов. Не включается в защищённых контейнерах.' }, U.icon('link', 14), 'Связать с папкой…');
      el.appendChild(ui.group(null,
        ui.free(h('div.kpk-top', h('div.kpk-top-text', 'Устанавливается копия папки: правки исходника ничего не меняют, пока вы не обновите пак. Перед установкой и при расширении прав Космолёт покажет, что пак сможет делать.'), h('div.kpk-top-btns', linkBtn, installBtn))),
        ui.free(msg, listEl),
        anchor('паки установить из папки связать с папкой обновить откатить удалить права контейнеры встроенный')));

      let state = { packs: [], containers: [], pending: null };
      const open = new Set();
      const confirm = new Map(); // id → 'remove'
      let busy = false;

      function showErrors(title, errors, warnings) {
        U.clear(msg);
        if (!errors || !errors.length) { msg.hidden = true; return; }
        msg.hidden = false;
        msg.append(h('div.kpk-msg-title', U.icon('alert-circle', 16), h('span', title)),
          h('ul.kpk-errs', errors.slice(0, 20).map((e) => h('li',
            h('span.kpk-err-where.k-mono', [e.file, e.path].filter(Boolean).join(' › ') || 'пак'),
            h('span.kpk-err-text', e.message),
            e.hint ? h('span.kpk-err-hint', e.hint) : null))),
          errors.length > 20 ? h('div.k-faint', 'и ещё ' + (errors.length - 20)) : null,
          (warnings || []).length ? h('div.k-faint.kpk-warns', 'Замечания: ' + warnings.map((w) => w.message).join('; ')) : null);
      }

      function afterInstall(r) {
        busy = false;
        installBtn.disabled = false;
        if (!r) return;
        if (r.cancelled) { api.toast('Установка отменена'); return; }
        if (!r.ok) { showErrors('Пак не установлен — исправьте и попробуйте снова:', r.errors, r.warnings); return; }
        showErrors('', []);
        if (r.unchanged) api.toast('Эта версия пака уже установлена');
        else api.toast((r.updated ? 'Пак обновлён: ' : 'Пак установлен: ') + r.pack.name + ' ' + r.pack.version);
        if (r.pack) open.add(r.pack.id);
        load();
      }
      installBtn.addEventListener('click', () => {
        if (busy) return;
        busy = true; installBtn.disabled = true;
        api.invoke('kosmo:packs.pickInstall', {}).then(afterInstall).catch((e) => { busy = false; installBtn.disabled = false; api.toast(clean(e), { tone: 'danger' }); });
      });
      linkBtn.addEventListener('click', () => {
        api.invoke('kosmo:packs.pickLink', {}).then((r) => { if (r) { open.add(r.id); api.toast('Связано: ' + r.name); load(); } }).catch((e) => api.toast(clean(e), { tone: 'danger' }));
      });

      function act(ch, payload, done) {
        return api.invoke(ch, payload).then((r) => { if (done) done(r); load(); return r; }).catch((e) => { api.toast(clean(e), { tone: 'danger', ms: 4500 }); load(); });
      }

      function containersBlock(p) {
        const box = h('div.kpk-ctrs');
        const all = state.containers;
        const g = h('input.k-switch', { type: 'checkbox', 'aria-label': 'Во всех контейнерах' });
        g.checked = !!p.global;
        g.disabled = !p.enabled;
        g.addEventListener('change', () => act('kosmo:packs.setGlobal', { id: p.id, on: g.checked }));
        box.appendChild(h('label.kpk-ctr.kpk-ctr-all', g, h('span', 'Во всех контейнерах, включая новые')));
        for (const c of all) {
          const on = p.containers.ids.includes(c.id);
          const sw = h('input.k-switch', { type: 'checkbox', 'aria-label': 'Включить в контейнере ' + c.name });
          sw.checked = on;
          sw.disabled = !p.enabled || (p.source === 'dev' && c.protect);
          sw.addEventListener('change', () => act('kosmo:packs.enableForContainer', { id: p.id, containerId: c.id, on: sw.checked }));
          box.appendChild(h('label.kpk-ctr' + (p.global ? '.dim' : ''), sw,
            h('span.kpk-cdot', { style: { '--c': c.color } }),
            h('span.k-ellipsis', c.name),
            c.protect ? h('span.k-badge', { title: 'Защищённый контейнер: агент пишет только через операции, секреты скрыты' }, 'защищён') : null,
            p.source === 'dev' && c.protect ? h('span.k-faint.kpk-xs', 'паки из папки сюда не включаются') : null));
        }
        return box;
      }

      function packRow(p) {
        const isOpen = open.has(p.id);
        const sw = h('input.k-switch', { type: 'checkbox', 'aria-label': (p.enabled ? 'Выключить' : 'Включить') + ' пак ' + p.name });
        sw.checked = !!p.enabled;
        sw.disabled = !!(p.errors && p.errors.length);
        sw.addEventListener('click', (e) => e.stopPropagation());
        sw.addEventListener('change', () => act('kosmo:packs.setEnabled', { id: p.id, on: sw.checked }));
        const chev = h('button.k-icon-btn.k-icon-btn-sm.kpk-chev', { type: 'button', 'aria-expanded': isOpen ? 'true' : 'false', title: isOpen ? 'Свернуть' : 'Подробнее', html: window.KIcons.get(isOpen ? 'chevron-up' : 'chevron-down', 14) });
        const meta = [];
        meta.push(p.global && p.enabled ? 'во всех контейнерах' : `включён в ${p.containers.enabled} из ${p.containers.total} ${U.plural(p.containers.total, ['контейнера', 'контейнеров', 'контейнеров'])}`);
        if (p.hosts && p.hosts.length) meta.push(p.hosts.slice(0, 3).join(', ') + (p.hosts.length > 3 ? ' и ещё ' + (p.hosts.length - 3) : ''));
        const head = h('div.kpk-head', { role: 'button', tabindex: '0' },
          h('span.kpk-mark' + (p.enabled ? '' : '.off'), initials(p.name)),
          h('div.kpk-main',
            h('div.kpk-name', h('span.k-ellipsis', p.name), h('span.kpk-ver', p.version), h('span.k-badge' + (p.source === 'dev' ? '.k-badge-accent' : ''), SOURCE[p.source] || p.source)),
            h('div.kpk-meta', h('span.kpk-state.tone-' + (p.state.tone || 'muted'), h('span.kpk-sdot'), p.state.text), h('span.k-faint', meta.join(' · ')))),
          sw, chev);
        const toggle = () => { if (open.has(p.id)) open.delete(p.id); else open.add(p.id); render(); };
        head.addEventListener('click', toggle);
        head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
        const card = h('div.kpk-card' + (isOpen ? '.open' : ''), { dataset: { id: p.id } }, head);
        if (!isOpen) return card;

        const body = h('div.kpk-body');
        if (p.description) body.appendChild(h('p.kpk-desc', p.description));
        if (p.errors && p.errors.length) {
          body.appendChild(h('div.kpk-errbox', h('div.kpk-sub', 'Что не так'), h('ul.kpk-errs', p.errors.slice(0, 12).map((e) => h('li',
            h('span.kpk-err-where.k-mono', [e.file, e.path].filter(Boolean).join(' › ') || 'пак'), h('span.kpk-err-text', e.message), e.hint ? h('span.kpk-err-hint', e.hint) : null)))));
        }
        if (p.phrases && p.phrases.length) {
          body.appendChild(h('div.kpk-sub', 'Что может пак'));
          body.appendChild(h('ul.kpk-phr', p.phrases.map((x) => h('li' + (x.tone === 'warn' ? '.attn' : ''), h('span.kpk-dot'), h('span', x.text)))));
        }
        body.appendChild(h('div.kpk-sub', 'Контейнеры'));
        body.appendChild(containersBlock(p));

        const acts = h('div.kpk-acts');
        if (p.source === 'folder' && p.sourcePath) {
          const b = h('button.k-btn.k-btn-sm', { type: 'button', title: p.sourcePath }, U.icon('rotate-cw', 14), 'Обновить из папки');
          b.addEventListener('click', () => { b.disabled = true; api.invoke('kosmo:packs.update', { id: p.id }).then(afterInstall).catch((e) => { b.disabled = false; api.toast(clean(e), { tone: 'danger' }); }); });
          acts.appendChild(b);
        }
        if (p.prev) {
          const b = h('button.k-btn.k-btn-sm.k-btn-ghost', { type: 'button' }, 'Откатить к ' + p.prev.version);
          b.addEventListener('click', () => act('kosmo:packs.rollback', { id: p.id }, () => api.toast('Пак откачен к ' + p.prev.version)));
          acts.appendChild(b);
        }
        if (p.source === 'dev') {
          const r = h('button.k-btn.k-btn-sm.k-btn-ghost', { type: 'button' }, 'Перезагрузить');
          r.addEventListener('click', () => act('kosmo:packs.reload', { id: p.id }, () => api.toast('Перечитан из папки')));
          acts.appendChild(r);
        }
        const of = h('button.k-btn.k-btn-sm.k-btn-ghost', { type: 'button' }, 'Открыть папку');
        of.addEventListener('click', () => act('kosmo:packs.openFolder', { id: p.id }));
        acts.appendChild(of);
        acts.appendChild(h('span.k-grow'));
        if (p.source === 'dev') {
          const u = h('button.k-btn.k-btn-sm.k-btn-ghost', { type: 'button' }, 'Отвязать');
          u.addEventListener('click', () => act('kosmo:packs.unlink', { path: p.sourcePath }, () => api.toast('Папка отвязана')));
          acts.appendChild(u);
        } else if (p.source === 'folder') {
          if (confirm.get(p.id) === 'remove') {
            const keep = h('button.k-btn.k-btn-sm', { type: 'button' }, 'Удалить, данные оставить');
            const all = h('button.k-btn.k-btn-sm.k-btn-danger', { type: 'button' }, 'Удалить с данными');
            const no = h('button.k-btn.k-btn-sm.k-btn-ghost', { type: 'button' }, 'Отмена');
            keep.addEventListener('click', () => { confirm.delete(p.id); act('kosmo:packs.uninstall', { id: p.id, keepData: true }, () => api.toast('Пак удалён, его данные остались')); });
            all.addEventListener('click', () => { confirm.delete(p.id); act('kosmo:packs.uninstall', { id: p.id, keepData: false }, () => api.toast('Пак удалён вместе с данными')); });
            no.addEventListener('click', () => { confirm.delete(p.id); render(); });
            acts.append(h('span.kpk-confirm', 'Данные контейнеров (поля и правила) останутся с пометкой «пак не установлен».'), no, keep, all);
          } else {
            const d = h('button.k-btn.k-btn-sm.k-btn-ghost.kpk-del', { type: 'button' }, 'Удалить…');
            d.addEventListener('click', () => { confirm.set(p.id, 'remove'); render(); });
            acts.appendChild(d);
          }
        }
        body.appendChild(acts);
        const foot = [];
        if (p.treeHash) foot.push('копия ' + p.treeHash.slice(0, 8));
        if (p.updatedAt) foot.push('обновлён ' + U.formatDate(p.updatedAt, true));
        if (p.counts) {
          const c = p.counts;
          const bits = [];
          if (c.snippets) bits.push('сниппетов ' + c.snippets);
          if (c.operations) bits.push('операций ' + c.operations);
          if (c.policies) bits.push('проверок ' + c.policies);
          if (c.skills) bits.push('скиллов ' + c.skills);
          if (bits.length) foot.push(bits.join(', '));
        }
        if (foot.length) body.appendChild(h('div.kpk-foot.k-faint', foot.join(' · ')));
        card.appendChild(body);
        return card;
      }

      function render() {
        U.clear(listEl);
        if (state.pending) {
          const show = h('button.k-btn.k-btn-sm', { type: 'button' }, 'Показать');
          show.addEventListener('click', () => api.invoke('kosmo:packs.showPending', {}).catch(() => {}));
          listEl.appendChild(h('div.kpk-pending', U.icon('info', 14), h('span.k-grow', `Ждёт вашего решения: «${state.pending.pack.name}» — лист прав открыт поверх браузера.`), show));
        }
        if (!state.packs.length) {
          listEl.appendChild(api.empty({ icon: 'box', title: 'Паков нет', text: 'Установите пак из папки — в ней должен лежать kosmo-pack.json.' }));
          return;
        }
        for (const p of state.packs) listEl.appendChild(packRow(p));
      }

      let seq = 0;
      function load() {
        const my = ++seq;
        return api.invoke('kosmo:packs.list', {}).then((r) => { if (my !== seq || !r) return; state = r; render(); }).catch((e) => {
          U.clear(listEl).appendChild(api.empty({ icon: 'alert-triangle', title: 'Паки не загрузились', text: clean(e), tone: 'error' }));
        });
      }
      const reload = U.debounce(load, 60);
      U.on('kosmo:packs.changed', reload);
      U.on('kosmo:scopes.changed', reload);
      ui.watch('containers', reload);
      load();

      el.appendChild(ui.note('Встроенные паки — часть Космолёта: их можно выключить, но не удалить. Ручные правки (свои бэнги, исключения, темы сайтов) главнее умолчаний пака и при его выключении остаются.'));
    },
  });
})();
