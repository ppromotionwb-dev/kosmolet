// Владелец: devtools. В chrome: значок эмуляции в адресной строке (открывает «Устройство») и «сцена» эмуляции —
// рамка и подпись вокруг устройства, которое main рисует по центру области вкладки (kosmo:devtools.stage).
'use strict';
(function () {
  const U = window.KUI;
  const { h } = U;
  if (!window.KChrome) return;

  // ---------- значок эмуляции ----------
  // планшета нет в общем наборе (в панели его добавляет devtools-common) — бейдж вкладки и значок рисуются здесь
  if (window.KIcons && !window.KIcons.has('tablet')) window.KIcons.add('tablet', '<rect width="16" height="20" x="4" y="2" rx="2"/><path d="M12 18h.01"/>');
  // Активное состояние — акцентным цветом, как у луны темы и звезды закладки (подложка «нажата» выглядела как наведение).
  const icon = KChrome.addOmniboxIcon({
    id: 'devtools-emulation', icon: 'smartphone', title: 'Эмуляция устройства', order: 300, hidden: true,
    onClick: () => KChrome.invoke('kosmo:panel.open', { tool: 'emulation' }).catch(() => {})
  });
  icon.el.classList.add('kdt-emu', 'on');
  function syncIcon() {
    const a = KChrome.state.active;
    const b = a && a.badges && a.badges.emulation;
    icon.setVisible(!!b);
    if (b) { icon.setIcon(b.icon || 'smartphone'); icon.setTitle((b.title || 'Эмуляция') + ' — настроить'); }
  }
  KChrome.on('state', syncIcon);
  KChrome.on('active', syncIcon);

  // ---------- сцена ----------
  U.css('features/devtools.css');
  const cap = h('div.kdt-cap');
  const stage = h('div#kdt-stage', h('div.kdt-frame'), cap);
  document.body.appendChild(stage);

  function render(s) {
    if (!s || !s.rect) { stage.classList.remove('on'); return; }
    const r = s.rect;
    stage.style.left = r.x + 'px'; stage.style.top = r.y + 'px';
    stage.style.width = r.width + 'px'; stage.style.height = r.height + 'px';
    U.clear(cap);
    U.append(cap, [U.icon(s.w > s.h ? 'rotate-device' : 'smartphone', 13), h('b', s.title), h('span', s.w + ' × ' + s.h), s.scale < 1 ? h('span', '· ' + Math.round(s.scale * 100) + '%') : null]);
    stage.classList.add('on');
  }
  U.on('kosmo:devtools.stage', render);
  if (window.KIcons && !window.KIcons.has('rotate-device')) window.KIcons.add('rotate-device', '<rect width="10" height="16" x="3" y="5" rx="2"/><path d="M17 3a4 4 0 0 1 4 4v1"/><path d="m19 6 2 2 2-2"/>');
})();
