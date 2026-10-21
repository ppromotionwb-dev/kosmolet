// Владелец: devtools. Инструмент «Устройство»: эмуляция устройства (размер, DPR, мобильный UA и касания,
// поворот), сети (скорость, офлайн), кэша, процессора, prefers-color-scheme и печати. Всё — для активной
// вкладки, применяет main (kosmo:emu.*) через CDP. Вкладка с эмуляцией помечена значком.
'use strict';
(function () {
  const U = window.KUI;
  const D = window.KDev;
  const { h } = U;
  U.css('tools/emulation.css');

  KPanel.register({
    id: 'emulation', title: 'Устройство', icon: 'smartphone', order: 40,
    mount(el, api) {
      el.classList.add('ke');
      const st = { tabId: null, s: null, visible: false, busy: false, seq: 0 };
      const fail = (e) => api.toast(D.errText(e), { tone: 'danger', ms: 3500 });

      const note = h('div.kd-note.ke-note', { hidden: true });
      // ---------- устройство ----------
      const devGrid = h('div.ke-devs', { role: 'radiogroup', 'aria-label': 'Устройство' });
      const rotateBtn = h('button.k-btn.k-btn-sm', { type: 'button', title: 'Повернуть' }, U.icon('rotate-device', 14), 'Повернуть');
      rotateBtn.addEventListener('click', () => set({ rotate: !(st.s && st.s.rotate) }));
      const devInfo = h('div.ke-devinfo');
      const cw = h('input.k-input.k-input-sm.ke-num', { type: 'number', min: 50, max: 4000, step: 1, 'aria-label': 'Ширина' });
      const ch = h('input.k-input.k-input-sm.ke-num', { type: 'number', min: 50, max: 4000, step: 1, 'aria-label': 'Высота' });
      const cdpr = h('input.k-input.k-input-sm.ke-num.sm', { type: 'number', min: 0.5, max: 4, step: 0.25, 'aria-label': 'Плотность пикселей' });
      const cmob = h('input.k-check', { type: 'checkbox', 'aria-label': 'Мобильный' });
      const capply = h('button.k-btn.k-btn-sm', { type: 'button' }, 'Применить');
      const applyCustom = () => set({ device: 'custom', custom: { w: +cw.value, h: +ch.value, dpr: +cdpr.value, mobile: cmob.checked, touch: cmob.checked } });
      capply.addEventListener('click', applyCustom);
      for (const i of [cw, ch, cdpr]) i.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyCustom(); });
      const customRow = h('div.ke-custom',
        h('span.ke-lbl', 'Свой'), cw, h('span.ke-x', '×'), ch, h('span.ke-lbl.sm', 'DPR'), cdpr,
        h('label.ke-chk', cmob, 'мобильный'), capply);
      const devSec = card('Устройство', 'smartphone', [devGrid, customRow, h('div.ke-devfoot', devInfo, rotateBtn)]);

      // ---------- сеть ----------
      const netSeg = h('div.ke-chips', { role: 'radiogroup', 'aria-label': 'Сеть' });
      const lat = h('input.k-input.k-input-sm.ke-num', { type: 'number', min: 0, max: 60000, step: 10, 'aria-label': 'Задержка, мс' });
      const down = h('input.k-input.k-input-sm.ke-num', { type: 'number', min: 1, max: 1000000, step: 100, 'aria-label': 'Загрузка, кбит/с' });
      const up = h('input.k-input.k-input-sm.ke-num', { type: 'number', min: 1, max: 1000000, step: 100, 'aria-label': 'Отдача, кбит/с' });
      const napply = h('button.k-btn.k-btn-sm', { type: 'button' }, 'Применить');
      const applyNet = () => set({ net: 'custom', netCustom: { latency: +lat.value, down: +down.value, up: +up.value } });
      napply.addEventListener('click', applyNet);
      const netCustom = h('div.ke-netcustom', { hidden: true },
        h('label.ke-field', h('span', 'Задержка, мс'), lat), h('label.ke-field', h('span', 'Загрузка, кбит/с'), down), h('label.ke-field', h('span', 'Отдача, кбит/с'), up), napply);
      const noCache = h('input.k-switch', { type: 'checkbox', 'aria-label': 'Отключить кэш' });
      noCache.addEventListener('change', () => set({ noCache: noCache.checked }));
      const netSec = card('Сеть', 'signal', [netSeg, netCustom, h('label.ke-row', h('span.ke-rowt', 'Отключить кэш', h('span.ke-hint', 'запросы идут мимо кэша, пока открыта эта вкладка')), noCache)]);

      // ---------- процессор и медиа ----------
      const cpuSeg = D.seg([[1, 'Без замедления'], [4, '×4'], [6, '×6']], (v) => set({ cpu: v }), { label: 'Замедление процессора' });
      const schemeSeg = D.seg([['', 'Как у системы'], ['dark', 'Тёмная'], ['light', 'Светлая']], (v) => set({ scheme: v }), { label: 'prefers-color-scheme' });
      const print = h('input.k-switch', { type: 'checkbox', 'aria-label': 'Печать' });
      print.addEventListener('change', () => set({ print: print.checked }));
      const cpuSec = card('Процессор', 'cpu', [h('div.ke-row', h('span.ke-rowt', 'Замедление', h('span.ke-hint', 'как на слабом телефоне')), cpuSeg)]);
      const mediaSec = card('Медиа', 'contrast', [
        h('div.ke-row', h('span.ke-rowt', 'prefers-color-scheme'), schemeSeg),
        h('label.ke-row', h('span.ke-rowt', 'Режим печати', h('span.ke-hint', '@media print')), print)
      ]);

      const resetBtn = h('button.k-btn.k-btn-sm', { type: 'button' }, U.icon('rotate-ccw', 13), 'Сбросить всё');
      resetBtn.addEventListener('click', () => {
        if (st.tabId == null) return;
        api.invoke('kosmo:emu.reset', { tabId: st.tabId }).then((s) => { st.s = Object.assign(st.s || {}, s); render(); api.toast('Эмуляция выключена'); }).catch(fail);
      });
      const summary = h('div.ke-sum');
      const foot = h('div.ke-foot', summary, resetBtn);
      const scroll = h('div.ke-scroll', note, devSec, netSec, cpuSec, mediaSec);
      el.append(scroll, foot);

      function card(title, icon, children) {
        return h('section.ke-card', h('div.ke-card-head', U.icon(icon, 14), h('span', title)), children);
      }

      // ---------- данные ----------
      function set(patch) {
        if (st.tabId == null || st.busy) return;
        st.busy = true;
        el.classList.add('busy');
        api.invoke('kosmo:emu.set', { tabId: st.tabId, patch }).then((s) => { st.s = Object.assign(st.s || {}, s); render(); })
          .catch((e) => { fail(e); load(); })
          .finally(() => { st.busy = false; el.classList.remove('busy'); });
      }
      function load() {
        const my = ++st.seq;
        if (st.tabId == null) { st.s = null; render(); return; }
        api.invoke('kosmo:emu.get', { tabId: st.tabId }).then((s) => { if (my === st.seq) { st.s = s; render(); } }).catch(fail);
      }

      function render() {
        const s = st.s;
        const tab = api.activeTab();
        const web = !!tab && /^https?:/i.test(tab.url || '');
        note.hidden = web || st.tabId == null;
        U.clear(note);
        if (!note.hidden) note.append(U.icon('info', 14), h('span', 'Эмуляция работает на обычных сайтах (http/https).'));
        el.classList.toggle('off', !web);
        if (!s) return;
        // устройства
        U.clear(devGrid);
        const items = [{ id: '', title: 'Без эмуляции', sub: 'размер окна', icon: 'monitor' }].concat(s.devices.map((d) => ({ id: d.id, title: d.title, sub: d.w + '×' + d.h + (d.dpr !== 1 ? ' · ' + String(d.dpr).replace('.', ',') + 'x' : ''), icon: d.icon })));
        for (const it of items) {
          const on = (s.device || '') === it.id;
          const b = h('button.ke-dev' + (on ? '.on' : ''), { type: 'button', role: 'radio', 'aria-checked': on ? 'true' : 'false', disabled: !web },
            U.icon(it.icon, 18), h('span.ke-dev-t', it.title), h('span.ke-dev-s', it.sub));
          b.addEventListener('click', () => set({ device: it.id || null, rotate: false }));
          devGrid.appendChild(b);
        }
        const c = s.custom || {};
        if (document.activeElement !== cw) cw.value = c.w;
        if (document.activeElement !== ch) ch.value = c.h;
        if (document.activeElement !== cdpr) cdpr.value = c.dpr;
        cmob.checked = !!c.mobile;
        customRow.classList.toggle('on', s.device === 'custom');
        for (const x of [cw, ch, cdpr, cmob, capply]) x.disabled = !web;
        rotateBtn.disabled = !s.device || !web;
        rotateBtn.classList.toggle('active', !!s.rotate);
        devInfo.textContent = s.device && s.size ? `${s.size.w}×${s.size.h}` + (s.scale && s.scale < 1 ? ` · показано в ${Math.round(s.scale * 100)}%` : '') : 'Страница в размере окна';
        // сеть
        U.clear(netSeg);
        for (const n of s.networks) {
          const on = s.net === n.id;
          const b = h('button.kd-pill' + (on ? '.on' : ''), { type: 'button', role: 'radio', 'aria-checked': on ? 'true' : 'false', disabled: !web }, n.id === 'offline' ? U.icon('wifi-off', 12) : null, n.title);
          b.addEventListener('click', () => { if (n.id === 'custom') { netCustom.hidden = false; lat.focus(); return; } set({ net: n.id }); });
          netSeg.appendChild(b);
        }
        netCustom.hidden = s.net !== 'custom' && netCustom.hidden;
        const nc = s.netCustom || {};
        if (document.activeElement !== lat) lat.value = nc.latency;
        if (document.activeElement !== down) down.value = nc.down;
        if (document.activeElement !== up) up.value = nc.up;
        noCache.checked = !!s.noCache; noCache.disabled = !web;
        cpuSeg.set(s.cpu || 1);
        schemeSeg.set(s.scheme || '');
        print.checked = !!s.print; print.disabled = !web;
        for (const b of el.querySelectorAll('.kd-seg button')) b.disabled = !web;
        summary.textContent = s.active ? 'Включено: ' + s.summary : 'Эмуляция выключена';
        summary.classList.toggle('on', !!s.active);
        resetBtn.disabled = !s.active;
      }

      function follow(tab) {
        const id = tab ? tab.id : null;
        if (id !== st.tabId) { st.tabId = id; st.s = null; }
        load();
      }
      api.on('kosmo:devtools.emu', (s) => { if (s && s.tabId === st.tabId) { st.s = Object.assign(st.s || {}, s); render(); } });
      api.onTabChange((tab, info) => { if (st.visible) { if (info.reason === 'activated') follow(tab); else render(); } });
      api.onLayout(() => { if (st.visible && st.s && st.s.device) load(); });
      el._show = () => { st.visible = true; follow(api.activeTab()); };
      el._hide = () => { st.visible = false; };
    },
    onShow(api) { if (api.el && api.el._show) api.el._show(); },
    onHide(api) { if (api.el && api.el._hide) api.el._hide(); }
  });
})();
