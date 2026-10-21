// Владелец: themes. Луна в адресной строке: подсвечена, когда на сайте включена тёмная тема;
// клик — поповер «Тёмная тема» (overlay, тип 'site-theme'). Alt+Shift+D переключает тему сайта (команда в main).
'use strict';
(function () {
  const K = window.KChrome;
  const U = window.KUI;
  if (!K || !U) return;
  U.css('features/themes.css');

  window.KIcons.add('moon-fill', '<path fill="currentColor" d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>');

  // Та же логика, что в main (features/themes.js → resolve), — чтобы луна не ждала IPC при каждой смене вкладки.
  function hostOf(url) {
    try { const u = new URL(url); return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.toLowerCase() : ''; } catch (e) { return ''; }
  }
  function siteKey(h) { h = h.replace(/\.$/, ''); return h.startsWith('www.') && h.split('.').length > 2 ? h.slice(4) : h; }
  function candidates(key) {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(key) || key.indexOf(':') >= 0 || key.indexOf('[') === 0 || key.indexOf('.') < 0) return [key];
    const p = key.split('.'); const out = [];
    for (let i = 0; i <= p.length - 2; i++) out.push(p.slice(i).join('.'));
    return out;
  }
  function stateFor(url, settings) {
    const host = hostOf(url || '');
    if (!host) return null;
    const key = siteKey(host);
    const st = (settings && settings.siteThemes) || {};
    const sites = st.sites && typeof st.sites === 'object' ? st.sites : {};
    let entry = null;
    for (const k of candidates(key)) { if (sites[k] && typeof sites[k] === 'object') { entry = sites[k]; break; } }
    const mode = st.mode || 'list';
    const dark = mode === 'off' ? false : mode === 'all' ? !(entry && entry.enabled === false) : !!(entry && entry.enabled === true);
    return { host, key, dark, css: !!(entry && entry.css) };
  }

  const btn = K.addOmniboxIcon({
    id: 'site-theme', icon: 'moon', order: 300, hidden: true,
    title: 'Тёмная тема сайта (Alt+Shift+D)',
    onClick: (e, b) => {
      const a = K.activeTab();
      if (!a) return;
      K.toggleOverlay('site-theme', { url: a.url, tabId: a.id }, b.el, { align: 'end' });
    }
  });
  btn.el.classList.add('kt-moon');

  let lastKey = '';
  function render() {
    const a = K.activeTab();
    const s = a && !a.error ? stateFor(a.url, K.state.settings) : null;
    const key = s ? [s.key, s.dark, s.css].join('|') : '';
    if (key === lastKey) return;
    lastKey = key;
    btn.setVisible(!!s);
    if (!s) return;
    btn.setIcon(s.dark ? 'moon-fill' : 'moon');
    btn.setPressed(s.dark);
    btn.el.classList.toggle('on', s.dark);
    btn.setTitle((s.dark ? 'Тёмная тема на ' + s.key + ' включена' : 'Тёмная тема на ' + s.key) + (s.css ? ', есть свой CSS' : '') + ' (Alt+Shift+D)');
  }

  K.on('state', render);
  K.on('settings', render);
  K.on('active', render);
  if (K.ready && K.ready.then) K.ready.then(render);
  render();

  // Отклик на Alt+Shift+D и команду «для всех сайтов»: луна коротко «вспыхивает»
  // (тост chrome здесь не подходит — нижняя часть окна chrome закрыта видом вкладки).
  U.on('kosmo:themes.toggled', () => {
    render();
    btn.el.classList.remove('pulse');
    void btn.el.offsetWidth;
    btn.el.classList.add('pulse');
  });
  btn.el.addEventListener('animationend', () => btn.el.classList.remove('pulse'));
})();
