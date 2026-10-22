'use strict';
// Пикер элемента «Показать Claude элемент» — сторона main (claude-bridge).
// start(tabId) → kosmo-tab:picker.start во вкладку; at(tab, x, y) → описать элемент в точке (контекстное меню).
// Ответ из вкладки kosmo-tab:picker.result — недоверенные данные: принимаем только ожидаемый id от главного фрейма
// этой вкладки, обрезаем размеры. Последний выбранный элемент доступен через last() (инструмент picked_element).

const crypto = require('crypto');

const LIMITS = { text: 2000, html: 20000, selector: 2000, xpath: 2000, attr: 500, attrs: 40, style: 200 };
const PICK_TIMEOUT = 2 * 60 * 1000;

function str(v, n) {
  if (v == null) return '';
  const s = String(v);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function createPicker(ctx, deps) {
  const { activity } = deps;
  let pending = null; // { id, tabId, mode: 'pick'|'at', timer, startedAt }
  let lastPicked = null;

  function frameIsMain(meta) {
    try {
      const wc = meta.webContents;
      return !!(wc && wc.mainFrame && meta.frameUrl === wc.mainFrame.url);
    } catch (_) { return false; }
  }

  function clean(p, tab) {
    const attrs = {};
    let n = 0;
    if (p.attributes && typeof p.attributes === 'object') {
      for (const [k, v] of Object.entries(p.attributes)) {
        if (n++ >= LIMITS.attrs) break;
        attrs[str(k, 100)] = str(v, LIMITS.attr);
      }
    }
    const styles = {};
    if (p.styles && typeof p.styles === 'object') {
      for (const [k, v] of Object.entries(p.styles).slice(0, 30)) styles[str(k, 60)] = str(v, LIMITS.style);
    }
    const r = p.rect && typeof p.rect === 'object' ? p.rect : {};
    const num = (x) => (Number.isFinite(Number(x)) ? Math.round(Number(x)) : 0);
    const wcUrl = tab.wc && !tab.wc.isDestroyed() ? tab.wc.getURL() : tab.info.url;
    return {
      ts: Date.now(),
      tabId: tab.id,
      url: wcUrl,
      title: str(p.title || tab.info.title, 300),
      selector: str(p.selector, LIMITS.selector),
      xpath: str(p.xpath, LIMITS.xpath),
      tag: str(p.tag, 40).toLowerCase(),
      text: str(p.text, LIMITS.text),
      outerHTML: str(p.outerHTML, LIMITS.html),
      htmlLength: num(p.htmlLength) || String(p.outerHTML || '').length,
      attributes: attrs,
      rect: { x: num(r.x), y: num(r.y), width: num(r.width), height: num(r.height) },
      styles,
      value: p.value == null ? undefined : str(p.value, 500),
      inShadow: !!p.inShadow,
      inFrame: !!p.inFrame,
      themed: !!p.themed,
    };
  }

  function finish(result) {
    const pend = pending;
    pending = null;
    if (pend && pend.timer) clearTimeout(pend.timer);
    ctx.broadcast('kosmo:bridge.picker', { active: false, tabId: pend ? pend.tabId : null });
    return pend;
  }

  function onResult(p, meta) {
    if (!pending || !meta || !meta.tab || meta.tab.id !== pending.tabId) return;
    if (!p || typeof p !== 'object' || p.id !== pending.id) return;
    if (!frameIsMain(meta)) return;
    const pend = finish();
    const tab = meta.tab;
    if (p.cancelled) {
      if (pend.mode === 'pick') ctx.broadcast('kosmo:bridge.toast', { text: 'Выбор элемента отменён', tone: null });
      return;
    }
    if (p.error) {
      ctx.broadcast('kosmo:bridge.toast', { text: 'Не удалось выбрать элемент', tone: 'danger' });
      return;
    }
    lastPicked = clean(p, tab);
    activity.add({
      tool: 'pick_element', by: 'user', tabId: tab.id, tabTitle: String(tab.info.title || '').slice(0, 80) || undefined, ok: true, ms: Date.now() - pend.startedAt,
      args: { selector: lastPicked.selector, tag: lastPicked.tag }, note: lastPicked.url,
    });
    try { ctx.tabs.markClaude(tab.id); } catch (_) { /* закрыта */ }
    ctx.broadcast('kosmo:bridge.picked', { tabId: tab.id, tag: lastPicked.tag, selector: lastPicked.selector, text: str(lastPicked.text, 120) });
    ctx.broadcast('kosmo:bridge.toast', { text: 'Элемент передан Claude', tone: 'ok' });
  }

  function webTab(tabId) {
    const tab = tabId != null ? ctx.tabs.get(tabId) : ctx.tabs.active();
    if (!tab || !tab.wc || tab.wc.isDestroyed()) throw new Error('нет вкладки');
    const url = tab.wc.getURL();
    if (!/^(https?|file|data|about):/i.test(url)) throw new Error('на этой странице выбор элемента недоступен');
    return tab;
  }

  function begin(tab, mode) {
    if (pending) cancel('restart');
    const id = crypto.randomBytes(8).toString('hex');
    pending = { id, tabId: tab.id, mode, startedAt: Date.now(), timer: null };
    pending.timer = setTimeout(() => cancel('timeout'), mode === 'pick' ? PICK_TIMEOUT : 5000);
    return id;
  }

  function start(tabId) {
    const tab = webTab(tabId);
    if (pending && pending.mode === 'pick' && pending.tabId === tab.id) { cancel('toggle'); return { active: false }; }
    const id = begin(tab, 'pick');
    const accent = ctx.settings.peek('ui.accent');
    tab.wc.send('kosmo-tab:picker.start', { id, accent });
    // Esc и клавиши должны попасть в страницу, а не в адресную строку.
    try { ctx.tabs.focus(tab.id); } catch (_) { /* нет фокуса */ }
    ctx.broadcast('kosmo:bridge.picker', { active: true, tabId: tab.id });
    return { active: true, tabId: tab.id };
  }

  // Элемент в точке (координаты из context-menu — DIP вида; в CSS px делим на масштаб страницы и эмуляции устройства).
  function at(tab, x, y) {
    tab = webTab(tab && tab.id);
    // zoom вкладки, а при эмуляции устройства — с её масштабом вписывания (ctx.devtools.emu.viewFactor)
    const zoom = tab.wc.getZoomFactor() || 1;
    let z = zoom;
    try { const e = ctx.devtools && ctx.devtools.emu; const f = e && typeof e.viewFactor === 'function' ? Number(e.viewFactor(tab.id, zoom)) : 0; if (f > 0) z = f; } catch (_) { z = zoom; }
    const id = begin(tab, 'at');
    tab.wc.send('kosmo-tab:picker.at', { id, x: x / z, y: y / z });
    return { tabId: tab.id };
  }

  function cancel(reason) {
    if (!pending) return false;
    const pend = pending;
    const tab = ctx.tabs.get(pend.tabId);
    finish();
    if (tab && tab.wc && !tab.wc.isDestroyed()) { try { tab.wc.send('kosmo-tab:picker.stop', {}); } catch (_) { /* закрыта */ } }
    if (reason === 'timeout' && pend.mode === 'pick') ctx.broadcast('kosmo:bridge.toast', { text: 'Выбор элемента отменён', tone: null });
    return true;
  }

  function init() {
    ctx.ipc.on('kosmo-tab:picker.result', onResult, { allow: ['tab'] });
    ctx.tabs.on('activated', () => { if (pending && pending.mode === 'pick') cancel('tab-changed'); });
    ctx.tabs.on('closed', (t) => { if (pending && pending.tabId === t.id) cancel('closed'); });
  }

  return {
    init, start, at, cancel,
    last: () => lastPicked,
    isActive: () => !!(pending && pending.mode === 'pick'),
  };
}

module.exports = { createPicker };
