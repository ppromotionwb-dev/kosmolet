// Космолёт — применение темы интерфейса к <html> (window.KTheme). Владелец: core.
// Подключать в <head> БЕЗ defer — до отрисовки, чтобы не мигало.
// Источники (по порядку): параметры адреса ?theme=&accent=&density=&fs=, кэш localStorage, затем settings.ui из main.
// Слушает kosmo:settings.changed. Работает на chrome/panel/overlay и внутренних страницах; без window.kosmo — только кэш/параметры.
'use strict';
(function () {
  const root = document.documentElement;
  const PRESETS = [
    { id: 'cosmos', title: 'Космос', accent: '#7c6cff', scheme: 'dark' },
    { id: 'graphite', title: 'Графит', accent: '#7c6cff', scheme: 'dark' },
    { id: 'light', title: 'Светлая', accent: '#6a5af0', scheme: 'light' },
    { id: 'terminal', title: 'Терминал', accent: '#3ddc84', scheme: 'dark' }
  ];
  const IDS = ['cosmos', 'graphite', 'light', 'terminal', 'custom'];
  const CACHE_KEY = 'kosmo.ui';
  const subs = new Set();
  let current = {};
  let lastKey = '';

  function parseColor(c) {
    if (typeof c !== 'string') return null;
    let m = c.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (m) {
      let hex = m[1];
      if (hex.length === 3) hex = hex.split('').map((x) => x + x).join('');
      return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
    }
    m = c.trim().match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i);
    if (m) return [+m[1], +m[2], +m[3]];
    return null;
  }
  function luminance(rgb) {
    const ch = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  }
  // текст на акценте: белый, пока акцент не слишком светлый
  function onAccent(color) {
    const rgb = parseColor(color);
    if (!rgb) return '#ffffff';
    return luminance(rgb) > 0.4 ? '#0e1016' : '#ffffff';
  }
  function setVar(name, value) {
    if (value === null || value === undefined || value === '') root.style.removeProperty(name);
    else root.style.setProperty(name, value);
  }

  function apply(ui) {
    ui = ui && typeof ui === 'object' ? ui : {};
    const theme = IDS.indexOf(ui.theme) >= 0 ? ui.theme : 'cosmos';
    const density = ui.density === 'compact' ? 'compact' : 'normal';
    const accent = parseColor(ui.accent) ? ui.accent : null;
    const fs = Number(ui.fontSize);
    const custom = theme === 'custom' && ui.custom && typeof ui.custom === 'object' ? ui.custom : null;
    const key = JSON.stringify([theme, density, accent, fs, custom]);
    current = ui;
    if (key === lastKey) return;
    lastKey = key;

    let scheme = theme === 'light' ? 'light' : 'dark';
    if (custom) {
      setVar('--k-bg', parseColor(custom.bg) ? custom.bg : null);
      setVar('--k-surface', parseColor(custom.surface) ? custom.surface : null);
      setVar('--k-text', parseColor(custom.text) ? custom.text : null);
      const bg = parseColor(custom.bg);
      if (bg) scheme = luminance(bg) > 0.45 ? 'light' : 'dark';
    } else {
      setVar('--k-bg', null); setVar('--k-surface', null); setVar('--k-text', null);
    }
    root.dataset.theme = theme;
    root.dataset.scheme = scheme;
    root.dataset.density = density;
    setVar('--k-accent', accent);
    setVar('--k-on-accent', accent ? onAccent(accent) : null);
    setVar('--k-fs', fs >= 10 && fs <= 22 ? fs + 'px' : null);

    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ theme, density, accent, fontSize: fs || undefined, custom })); } catch (e) { /* нет хранилища */ }
    for (const cb of Array.from(subs)) { try { cb(current); } catch (e) { console.error('[theme]', e); } }
  }

  // 1) мгновенно: параметры адреса или кэш
  (function initial() {
    let ui = null;
    try { ui = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (e) { ui = null; }
    try {
      const q = new URLSearchParams(location.search);
      if (q.has('theme') || q.has('accent') || q.has('density')) {
        ui = Object.assign({}, ui || {});
        if (q.get('theme')) ui.theme = q.get('theme');
        if (q.get('accent')) ui.accent = q.get('accent');
        if (q.get('density')) ui.density = q.get('density');
        if (q.get('fs')) ui.fontSize = +q.get('fs');
      }
    } catch (e) { /* ignore */ }
    apply(ui || {});
  })();

  // 2) настоящие настройки из main
  const k = window.kosmo;
  if (k && typeof k.invoke === 'function') {
    k.invoke('kosmo:settings.get', { path: 'ui' }).then((ui) => { if (ui && typeof ui === 'object') apply(ui); }).catch(() => {});
    try {
      k.on('kosmo:settings.changed', (p) => {
        if (!p) return;
        if (p.settings && p.settings.ui) apply(p.settings.ui);
        else if (typeof p.path === 'string' && (p.path === '' || p.path === 'ui' || p.path.startsWith('ui.'))) {
          k.invoke('kosmo:settings.get', { path: 'ui' }).then(apply).catch(() => {});
        }
      });
    } catch (e) { /* ignore */ }
  }

  window.KTheme = {
    presets: PRESETS,
    apply,
    get: () => current,
    onAccent,
    luminance: (c) => { const rgb = parseColor(c); return rgb ? luminance(rgb) : null; },
    onChange(cb) { subs.add(cb); return () => subs.delete(cb); }
  };
})();
