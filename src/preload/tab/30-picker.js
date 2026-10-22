'use strict';
// Владелец: claude-bridge. Пикер элемента «Показать Claude элемент» (часть tab-preload, изолированный мир).
// main → kosmo-tab:picker.start {} — рамка под курсором, клик выбирает, Esc отменяет;
// main → kosmo-tab:picker.at {x, y} — описать элемент в точке (CSS px окна) без пикера (контекстное меню);
// main → kosmo-tab:picker.stop {} — снять пикер.
// Ответ: kosmo-tab:picker.result {id, selector, xpath, tag, text, outerHTML, attributes, rect, styles, url} | {id, cancelled}.
// Слушатели кликов/клавиш вешаются при старте документа (раньше скриптов сайта) и работают только при активном пикере.
if (!KOSMO.isTop) return;
if (KOSMO.protocol === 'kosmo:' || KOSMO.protocol === 'devtools:' || KOSMO.protocol === 'chrome-extension:') return;

const ipc = KOSMO.ipcRenderer;
const STYLE_KEYS = ['display', 'position', 'box-sizing', 'width', 'height', 'margin', 'padding', 'color', 'background-color',
  'font-family', 'font-size', 'font-weight', 'line-height', 'border', 'border-radius', 'z-index', 'opacity', 'visibility', 'cursor', 'overflow'];
const MAX_TEXT = 2000;
const MAX_HTML = 20000;

let active = null; // { id, host, box, label, current }

function norm(s) { return String(s == null ? '' : s).replace(/[\s ]+/g, ' ').trim(); }

// ---------- элемент под точкой: открытые shadow root и same-origin iframe ----------
function deepAt(x, y) {
  let doc = document, ox = 0, oy = 0, el = null;
  for (let g = 0; g < 20; g++) {
    let e = doc.elementFromPoint(x - ox, y - oy);
    if (!e) return el;
    while (e && e.shadowRoot) {
      const inner = e.shadowRoot.elementFromPoint(x - ox, y - oy);
      if (!inner || inner === e) break;
      e = inner;
    }
    if (active && e === active.host) return el;
    el = e;
    if (e.tagName === 'IFRAME' || e.tagName === 'FRAME') {
      let d = null;
      try { d = e.contentDocument; } catch (_) { d = null; }
      if (!d) return el;
      const r = e.getBoundingClientRect();
      ox += r.left + e.clientLeft; oy += r.top + e.clientTop;
      doc = d;
      continue;
    }
    return el;
  }
  return el;
}

function topRect(el) {
  const r = el.getBoundingClientRect();
  let x = r.left, y = r.top;
  let win = el.ownerDocument && el.ownerDocument.defaultView;
  while (win && win !== window) {
    let fe = null;
    try { fe = win.frameElement; } catch (_) { fe = null; }
    if (!fe) break;
    const fr = fe.getBoundingClientRect();
    x += fr.left + fe.clientLeft; y += fr.top + fe.clientTop;
    win = win.parent;
  }
  return { x: Math.round(x), y: Math.round(y), width: Math.round(r.width), height: Math.round(r.height) };
}

// ---------- селектор и XPath ----------
function esc(s) { try { return CSS.escape(s); } catch (_) { return String(s).replace(/[^\w-]/g, '\\$&'); } }
// Без «хэшей» CSS-модулей (catalogCard--KV2df, styles_btn__x7Gq2) и классов состояния.
function goodClass(c) {
  if (!c || c.length >= 40 || /[:[\]/]/.test(c)) return false;
  if (/\d{3,}|^[a-z]{1,2}\d/i.test(c)) return false;
  const tail = /(?:--|__|_)([A-Za-z0-9]{4,7})$/.exec(c);
  if (tail && /[A-Z0-9]/.test(tail[1]) && /[a-z]/.test(tail[1])) return false;
  if (/^(is-|has-)?(active|hover|focus|focused|selected|open|opened|visible|show|shown|hidden)$/i.test(c)) return false;
  return true;
}
function uniqueIn(root, sel, el) {
  try { const l = root.querySelectorAll(sel); return l.length === 1 && l[0] === el; } catch (_) { return false; }
}
function stepFor(el) {
  const tag = el.tagName.toLowerCase();
  if (el.id && !/\d{4,}/.test(el.id) && el.id.length < 60) return '#' + esc(el.id);
  let s = tag;
  const classes = Array.from(el.classList || []).filter(goodClass).slice(0, 2);
  if (classes.length) s += '.' + classes.map(esc).join('.');
  for (const a of ['data-testid', 'data-test', 'data-qa', 'name', 'aria-label', 'type', 'role']) {
    const v = el.getAttribute(a);
    if (v && v.length < 60 && !(a === 'type' && tag !== 'input' && tag !== 'button')) { s += '[' + a + '="' + v.replace(/"/g, '\\"') + '"]'; break; }
  }
  const p = el.parentElement;
  if (p) {
    const same = Array.from(p.children).filter((c) => c.tagName === el.tagName);
    if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(el) + 1) + ')';
  }
  return s;
}
function selectorIn(el, root) {
  const parts = [];
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    const st = stepFor(n);
    parts.unshift(st);
    const sel = parts.join(' > ');
    if (uniqueIn(root, sel, el)) {
      // укоротить: убрать лишние предки с начала
      for (let i = 1; i < parts.length; i++) {
        const shorter = parts.slice(i).join(' > ');
        if (!uniqueIn(root, shorter, el)) return parts.slice(i - 1).join(' > ');
      }
      return parts[parts.length - 1];
    }
    if (st.startsWith('#')) break;
  }
  return parts.join(' > ');
}
function selectorFor(el) {
  const chain = [];
  let cur = el;
  for (let g = 0; cur && g < 10; g++) {
    const root = cur.getRootNode();
    chain.unshift(selectorIn(cur, root));
    if (root && root.host) cur = root.host; else break;
  }
  return chain.join(' >>> ');
}
function xpathFor(el) {
  const parts = [];
  for (let n = el; n && n.nodeType === 1; n = n.parentNode) {
    if (n.getRootNode() !== n.ownerDocument && n.parentNode && n.parentNode.nodeType === 11) { parts.unshift(n.tagName.toLowerCase()); break; }
    let i = 1;
    for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === n.tagName) i++;
    let more = false;
    for (let s = n.nextElementSibling; s; s = s.nextElementSibling) if (s.tagName === n.tagName) { more = true; break; }
    const name = n.namespaceURI && n.namespaceURI !== 'http://www.w3.org/1999/xhtml' ? '*[name()="' + n.tagName + '"]' : n.tagName.toLowerCase();
    parts.unshift(name + (i > 1 || more ? '[' + i + ']' : ''));
  }
  return '/' + parts.join('/');
}

// Тёмная тема браузера (Dark Reader) перекрашивает страницу и добавляет свои атрибуты — это не вёрстка сайта.
function darkThemed() {
  try { return !!document.querySelector('style.darkreader, meta[name="darkreader"]') || document.documentElement.hasAttribute('data-darkreader-mode'); } catch (_) { return false; }
}
function stripDark(html) {
  return String(html).replace(/\s+data-darkreader-[\w-]+="[^"]*"/gi, '').replace(/\s*--darkreader-[\w-]+\s*:[^;"]*;?/gi, '');
}

function describe(el) {
  const attrs = {};
  let count = 0;
  for (const a of Array.from(el.attributes || [])) {
    if (/^data-darkreader-/i.test(a.name)) continue;
    if (count++ >= 40) break;
    const v = a.name === 'style' ? stripDark(a.value).trim() : a.value;
    if (a.name === 'style' && !v) continue;
    attrs[a.name] = v.length > 500 ? v.slice(0, 500) + '…' : v;
  }
  let text = '';
  try { text = el.innerText; } catch (_) { text = ''; }
  if (!text) text = el.textContent || '';
  text = norm(text);
  const themed = darkThemed();
  let html = el.outerHTML || '';
  if (themed) html = stripDark(html);
  const styles = {};
  let cs = null;
  try { cs = getComputedStyle(el); } catch (_) { cs = null; }
  if (cs) for (const k of STYLE_KEYS) styles[k] = cs.getPropertyValue(k);
  let value;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') value = el.type === 'password' ? '' : String(el.value || '').slice(0, 500);
  return {
    selector: selectorFor(el),
    xpath: xpathFor(el),
    tag: el.tagName.toLowerCase(),
    text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '…' : text,
    outerHTML: html.length > MAX_HTML ? html.slice(0, MAX_HTML) + '…' : html,
    htmlLength: html.length,
    attributes: attrs,
    rect: topRect(el),
    styles,
    value,
    inShadow: el.getRootNode() !== el.ownerDocument,
    inFrame: el.ownerDocument !== document,
    themed,
    url: location.href,
    title: document.title,
  };
}

function send(payload) {
  try { ipc.send('kosmo-tab:picker.result', payload); } catch (_) { /* документ закрывается */ }
}

// ---------- интерфейс пикера (закрытый shadow root) ----------
const CSS_TEXT = [
  ':host{all:initial}',
  '.layer{position:fixed;inset:0;pointer-events:none;z-index:2147483647;font:12px/1.3 "Segoe UI",system-ui,sans-serif}',
  '.box{position:fixed;left:0;top:0;width:0;height:0;box-sizing:border-box;border:2px solid var(--a,#7c6cff);background:color-mix(in srgb,var(--a,#7c6cff) 14%,transparent);border-radius:3px;display:none;transition:transform 60ms linear,width 60ms linear,height 60ms linear}',
  '.label{position:fixed;left:0;top:0;display:none;max-width:60vw;padding:3px 7px;border-radius:5px;background:#1b2031;color:#e4e7f2;border:1px solid rgba(150,165,235,.3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 2px 8px rgba(0,0,0,.35)}',
  '.label b{color:color-mix(in oklab,var(--a,#7c6cff),white 35%);font-weight:600}',
  '.label i{color:#a2a9c4;font-style:normal}',
  '.hint{position:fixed;top:10px;left:50%;transform:translateX(-50%);padding:6px 12px;border-radius:999px;background:#1b2031;color:#e4e7f2;border:1px solid rgba(150,165,235,.3);box-shadow:0 4px 14px rgba(0,0,0,.35)}',
  '.hint span{color:#a2a9c4}',
  '@media (prefers-reduced-motion: reduce){.box{transition:none}}',
].join('\n');

function buildUi(accent) {
  const host = document.createElement('kosmo-picker');
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = CSS_TEXT;
  const layer = document.createElement('div');
  layer.className = 'layer';
  if (accent) layer.style.setProperty('--a', accent);
  const box = document.createElement('div');
  box.className = 'box';
  const label = document.createElement('div');
  label.className = 'label';
  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent = 'Выберите элемент для Claude ';
  const sub = document.createElement('span');
  sub.textContent = '· Esc — отмена';
  hint.appendChild(sub);
  layer.append(box, label, hint);
  root.append(style, layer);
  (document.documentElement || document).appendChild(host);
  return { host, box, label };
}

function labelFor(el, r) {
  const tag = el.tagName.toLowerCase();
  const cls = Array.from(el.classList || []).slice(0, 2).map((c) => '.' + c).join('');
  const id = el.id ? '#' + el.id : '';
  return { name: tag + id + cls, size: Math.round(r.width) + '×' + Math.round(r.height) };
}

function highlight(el) {
  if (!active) return;
  active.current = el;
  if (!el) { active.box.style.display = 'none'; active.label.style.display = 'none'; return; }
  const r = topRect(el);
  const b = active.box;
  b.style.display = 'block';
  b.style.transform = 'translate(' + r.x + 'px,' + r.y + 'px)';
  b.style.width = Math.max(2, r.width) + 'px';
  b.style.height = Math.max(2, r.height) + 'px';
  const l = active.label;
  const t = labelFor(el, r);
  l.textContent = '';
  const nb = document.createElement('b');
  nb.textContent = t.name.length > 80 ? t.name.slice(0, 79) + '…' : t.name;
  const sz = document.createElement('i');
  sz.textContent = '  ' + t.size;
  l.append(nb, sz);
  l.style.display = 'block';
  const above = r.y - 26;
  const top = above >= 4 ? above : Math.min(window.innerHeight - 26, r.y + r.height + 4);
  l.style.transform = 'translate(' + Math.max(4, Math.min(r.x, window.innerWidth - 220)) + 'px,' + Math.max(4, top) + 'px)';
}

let lastX = -1, lastY = -1;
function onMove(e) {
  if (!active) return;
  lastX = e.clientX; lastY = e.clientY;
  const el = deepAt(e.clientX, e.clientY);
  if (el !== active.current) highlight(el);
}
function onScroll() {
  if (!active || lastX < 0) return;
  highlight(deepAt(lastX, lastY));
}
function block(e) {
  if (!active) return;
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
}
function onClick(e) {
  if (!active) return;
  block(e);
  if (e.button !== 0) return;
  const el = deepAt(e.clientX, e.clientY) || active.current;
  finish(el);
}
function onKey(e) {
  if (!active) return;
  if (e.key === 'Escape') { block(e); finish(null); return; }
  if (e.key === 'Enter' && active.current) { block(e); finish(active.current); }
}

function start(p) {
  if (active) stop();
  if (!document.documentElement) return;
  const accent = p && typeof p.accent === 'string' && /^#[0-9a-f]{6}$/i.test(p.accent) ? p.accent : null;
  const ui = buildUi(accent);
  active = { id: p && p.id, host: ui.host, box: ui.box, label: ui.label, current: null };
  if (lastX >= 0) highlight(deepAt(lastX, lastY));
}
function stop() {
  if (!active) return;
  try { active.host.remove(); } catch (_) { /* уже нет */ }
  active = null;
}
function finish(el) {
  const id = active && active.id;
  stop();
  if (!el) { send({ id, cancelled: true }); return; }
  let data;
  try { data = describe(el); } catch (err) { send({ id, error: String((err && err.message) || err) }); return; }
  data.id = id;
  send(data);
}

// Свои слушатели — раньше скриптов страницы (preload выполняется до них), в фазе перехвата на window.
for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'dblclick', 'auxclick', 'contextmenu']) {
  window.addEventListener(t, block, true);
}
window.addEventListener('click', onClick, true);
window.addEventListener('mousemove', onMove, true);
window.addEventListener('keydown', onKey, true);
window.addEventListener('keyup', (e) => { if (active && (e.key === 'Escape' || e.key === 'Enter')) block(e); }, true);
window.addEventListener('scroll', onScroll, true);
window.addEventListener('pagehide', () => { if (active) { const id = active.id; stop(); send({ id, cancelled: true, reason: 'navigation' }); } });

ipc.on('kosmo-tab:picker.start', (_e, p) => start(p || {}));
ipc.on('kosmo-tab:picker.stop', () => stop());
ipc.on('kosmo-tab:picker.at', (_e, p) => {
  let x = Number(p && p.x), y = Number(p && p.y);
  // координаты от main — CSS px окна; при масштабе страницы (pinch, мобильная вёрстка без meta viewport)
  // переводим в координаты layout viewport, как clientX
  const vv = window.visualViewport;
  if (vv && vv.scale > 0 && (vv.scale !== 1 || vv.offsetLeft || vv.offsetTop)) { x = x / vv.scale + vv.offsetLeft; y = y / vv.scale + vv.offsetTop; }
  const el = isFinite(x) && isFinite(y) ? deepAt(x, y) : null;
  if (!el) { send({ id: p && p.id, error: 'element not found' }); return; }
  let data;
  try { data = describe(el); } catch (err) { send({ id: p && p.id, error: String((err && err.message) || err) }); return; }
  data.id = p && p.id;
  send(data);
});
