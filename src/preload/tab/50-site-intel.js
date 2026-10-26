'use strict';
// Владелец: site-intel. Действия пользователя на странице (часть tab-preload, изолированный мир, только главный фрейм
// http(s)-страниц): click, submit, Enter в поле, change у select → kosmo-tab:intel.action {kind, label, tag, role, sel}.
// Подпись — доступное имя или текст элемента (≤ 60 символов); значения полей НЕ отправляются (у select — текст
// выбранного пункта). Не чаще 5 сообщений в секунду. Main проверяет и обрезает данные: они недоверенные.
if (!KOSMO.isTop) return;
if (KOSMO.protocol !== 'http:' && KOSMO.protocol !== 'https:') return;

const RATE = 5;
const sent = [];
let last = { kind: '', t: 0 };
const INTERACTIVE = 'a[href],button,input,select,textarea,summary,label,[role=button],[role=link],[role=tab],[role=menuitem],[role=menuitemradio],[role=menuitemcheckbox],[role=option],[role=checkbox],[role=radio],[role=switch],[role=combobox],[onclick],[tabindex]';

function norm(s) { return String(s == null ? '' : s).replace(/[\s ]+/g, ' ').trim(); }
function clip(s, n) { s = norm(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

function realTarget(e) {
  const p = typeof e.composedPath === 'function' ? e.composedPath() : [];
  const t = p && p.length ? p[0] : e.target;
  return t && t.nodeType === 1 ? t : (t && t.parentElement) || null;
}
// ближайший интерактивный предок (с переходом через границы shadow DOM)
function interactive(el) {
  let cur = el;
  for (let i = 0; cur && i < 12; i++) {
    if (cur.nodeType === 1 && cur.matches && cur.matches(INTERACTIVE)) return cur;
    cur = cur.parentElement || (cur.getRootNode && cur.getRootNode().host) || null;
  }
  return el;
}

function implicitRole(el) {
  const tag = el.tagName.toLowerCase();
  if (tag === 'a') return 'link';
  if (tag === 'button' || tag === 'summary') return 'button';
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'input') {
    const t = (el.type || 'text').toLowerCase();
    if (t === 'checkbox' || t === 'radio') return t;
    if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button';
    if (t === 'search') return 'searchbox';
    return 'textbox';
  }
  return '';
}

function byIds(ids) {
  return norm(String(ids || '').split(/\s+/).map((id) => { const x = id && document.getElementById(id); return x ? x.textContent : ''; }).join(' '));
}

function labelOf(el) {
  const aria = norm(el.getAttribute('aria-label')) || byIds(el.getAttribute('aria-labelledby'));
  if (aria) return aria;
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    const t = (el.type || '').toLowerCase();
    if (tag === 'input' && (t === 'submit' || t === 'button' || t === 'reset')) return norm(el.value) || t;
    if (el.id) { try { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l && norm(l.textContent)) return norm(l.textContent); } catch (_) { /* нет */ } }
    const wrap = el.closest('label');
    if (wrap && norm(wrap.textContent)) return norm(wrap.textContent);
    return norm(el.getAttribute('placeholder')) || norm(el.getAttribute('title')) || norm(el.getAttribute('name')) || '';
  }
  const text = norm(el.innerText || el.textContent || '');
  if (text) return text;
  const img = el.querySelector && el.querySelector('img[alt],svg[aria-label],[title]');
  return norm(el.getAttribute('title')) || (img ? norm(img.getAttribute('alt') || img.getAttribute('aria-label') || img.getAttribute('title')) : '');
}

const HASHY = /\d{3,}|^[a-z0-9]{1,3}-[a-z0-9]{5,}$|^_|__|^css-|^sc-|^jsx-/i;
function selectorOf(el) {
  const tag = el.tagName.toLowerCase();
  if (el.id && el.id.length <= 40 && !/\d{4,}/.test(el.id)) return tag + '#' + el.id;
  for (const a of ['data-testid', 'data-test', 'data-qa', 'data-test-id', 'name', 'aria-label']) {
    const v = el.getAttribute(a);
    if (v && v.length <= 40) return tag + '[' + a + '="' + v.replace(/"/g, '\\"') + '"]';
  }
  const cls = Array.from(el.classList || []).filter((c) => c.length <= 32 && !HASHY.test(c)).slice(0, 2);
  return tag + (cls.length ? '.' + cls.join('.') : '');
}

function emit(kind, el, extra) {
  if (!el || el.nodeType !== 1) return;
  const t = Date.now();
  // отправка формы сразу после клика по кнопке или Enter в поле — то же действие
  if (kind === 'submit' && (last.kind === 'click' || last.kind === 'enter') && t - last.t < 600) return;
  last = { kind, t };
  while (sent.length && t - sent[0] > 1000) sent.shift();
  if (sent.length >= RATE) return;
  sent.push(t);
  let label = clip(labelOf(el), 60);
  if (extra) label = clip((label ? label + ': ' : '') + extra, 60);
  try {
    KOSMO.send('kosmo-tab:intel.action', {
      kind, label, tag: el.tagName.toLowerCase().slice(0, 30), role: (el.getAttribute('role') || implicitRole(el)).slice(0, 30), sel: clip(selectorOf(el), 120),
    });
  } catch (_) { /* канал закрыт */ }
}

window.addEventListener('click', (e) => {
  if (!e.isTrusted || e.button !== 0) return;
  const el = interactive(realTarget(e));
  if (!el) return;
  const tag = el.tagName;
  // клик в поле ввода — не действие; select — смотрим change
  if (tag === 'SELECT' || tag === 'TEXTAREA' || (tag === 'INPUT' && !/^(submit|button|reset|image|checkbox|radio)$/i.test(el.type || ''))) return;
  emit('click', el);
}, true);

window.addEventListener('submit', (e) => {
  if (!e.isTrusted) return;
  const f = e.target;
  if (!f || f.tagName !== 'FORM') return;
  const btn = e.submitter && e.submitter.nodeType === 1 ? e.submitter : null;
  emit('submit', btn || f);
}, true);

window.addEventListener('keydown', (e) => {
  if (!e.isTrusted || e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
  const el = realTarget(e);
  if (!el) return;
  const tag = el.tagName;
  if (tag === 'INPUT' && !/^(checkbox|radio|submit|button|reset|image|file)$/i.test(el.type || '')) emit('enter', el);
  else if (el.isContentEditable || (tag === 'TEXTAREA' && (e.ctrlKey || e.metaKey))) emit('enter', el);
}, true);

window.addEventListener('change', (e) => {
  if (!e.isTrusted) return;
  const el = realTarget(e);
  if (!el || el.tagName !== 'SELECT') return;
  const opt = el.selectedOptions && el.selectedOptions[0];
  emit('change', el, opt ? norm(opt.text) : '');
}, true);
