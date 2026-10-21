// Владелец: claude-bridge. Кнопка Claude на панели: точка-статус MCP (выкл / чтение / полный; ярче, если Claude
// действовал в последнюю минуту), клик — поповер 'claude' в overlay. Короткие сообщения моста («Элемент передан
// Claude», «Отправлено в Claude») — плашкой рядом с кнопкой: chrome виден только полосой сверху, обычный тост
// внизу окна закрыт страницей.
'use strict';
(function () {
  if (!window.KChrome) return;
  const U = window.KUI;
  const { h } = U;
  U.css('features/claude.css');

  const LIVE_MS = 60000;
  const MODE_TEXT = { off: 'выключен', read: 'только чтение', full: 'полный доступ', error: 'ошибка' };
  let st = null;
  let liveTimer = 0;

  const btn = KChrome.addToolbarButton({
    id: 'claude', icon: 'claude', title: 'Claude', order: 850,
    onClick: (_e, b) => { KChrome.toggleOverlay('claude', { status: st }, b.el, { align: 'end' }); }
  });
  btn.el.classList.add('kcl-btn');
  const dot = h('span.kcl-dot', { 'aria-hidden': 'true' });
  btn.el.appendChild(dot);

  function modeOf(s) {
    if (!s) return 'off';
    if (s.error) return 'error';
    if (s.access === 'off' || !s.listening) return 'off';
    return s.access === 'read' ? 'read' : 'full';
  }

  function render() {
    const mode = modeOf(st);
    btn.el.dataset.mode = mode;
    const last = st && st.lastCallAt ? st.lastCallAt : 0;
    const left = last ? LIVE_MS - (Date.now() - last) : 0;
    const live = mode !== 'off' && mode !== 'error' && left > 0;
    btn.el.classList.toggle('live', live);
    clearTimeout(liveTimer);
    if (live) liveTimer = setTimeout(render, left + 50);
    let title = 'Claude — ' + MODE_TEXT[mode];
    if (mode === 'error' && st) title += ': ' + st.error;
    if (last && mode !== 'off') title += '\nПоследнее действие: ' + U.timeAgo(last);
    btn.setTitle(title);
  }

  // ---------- плашка-сообщение у кнопки ----------
  let chipEl = null, chipTimer = 0;
  function chip(text, tone) {
    if (!text) return;
    if (!chipEl) {
      chipEl = h('div.kcl-chip', { role: 'status', 'aria-live': 'polite' });
      document.body.appendChild(chipEl);
    }
    const r = btn.el.getBoundingClientRect();
    chipEl.textContent = '';
    chipEl.append(U.icon(tone === 'danger' ? 'alert-circle' : tone === 'ok' ? 'check' : 'info', 14), h('span.kcl-chip-text', text));
    if (tone) chipEl.dataset.tone = tone; else delete chipEl.dataset.tone;
    chipEl.style.top = Math.round(r.top + (r.height - 28) / 2) + 'px';
    chipEl.style.right = Math.round(window.innerWidth - r.left + 6) + 'px';
    chipEl.classList.remove('show');
    void chipEl.offsetWidth;
    chipEl.classList.add('show');
    clearTimeout(chipTimer);
    chipTimer = setTimeout(() => chipEl && chipEl.classList.remove('show'), 2600);
  }

  // ---------- события моста ----------
  U.on('kosmo:bridge.status', (s) => { if (s) { st = s; render(); } });
  U.on('kosmo:bridge.activity', (p) => {
    if (!p || !p.entry || p.entry.by === 'user') return;
    if (st) { st.lastCallAt = p.entry.ts; render(); }
  });
  U.on('kosmo:bridge.toast', (p) => { if (p) chip(p.text, p.tone); });
  U.on('kosmo:bridge.picker', (p) => { btn.setPressed(!!(p && p.active)); });
  window.addEventListener('resize', () => { if (chipEl) chipEl.classList.remove('show'); });

  KChrome.ready.then(() => U.invoke('kosmo:bridge.status', {})).then((s) => { if (s) { st = s; render(); } }).catch(() => render());
  render();
})();
