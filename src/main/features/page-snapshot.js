'use strict';
// Библиотека снимка страницы для ИИ (владелец claude-bridge). Не фича: её использует claude-bridge.
//
// lib() выполняется в изолированном мире WORLD страницы (webContents.executeJavaScriptInIsolatedWorld):
// DOM общий со страницей, переменные — свои, сайт наш код не видит. Состояние (ref-ы) живёт в мире,
// пока жив документ: ref → WeakRef(элемент), элемент → ref (WeakMap) — у одного элемента ref постоянный.
//
// Методы (run(method, args)): snapshot, find, locate, focus, value, selectOption, info, html, storage,
// check (для wait_for), scrollBy, refFor, selection. Ошибки возвращаются как {__error}.

const WORLD = 1002;
const VERSION = 9;

/* eslint-disable no-var */
function lib(VERSION) {
  if (globalThis.__kosmoSnap && globalThis.__kosmoSnap.v === VERSION) return;
  const S = globalThis.__kosmoSnapState || (globalThis.__kosmoSnapState = { seq: 0, refs: new Map(), ids: new WeakMap() });

  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE', 'BASE', 'PARAM', 'SOURCE', 'TRACK', 'DATALIST', 'OBJECT', 'EMBED', 'MAP']);
  const INLINE = new Set(['inline', 'inline-block', 'inline-flex', 'inline-grid', 'inline-table', 'contents', 'ruby', 'ruby-text', 'table-cell']);
  const INTERACTIVE_SEL = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],[role=textbox],[contenteditable=""],[contenteditable=true],[onclick]';
  const ROLE_KIND = {
    button: 'button', link: 'link', checkbox: 'checkbox', radio: 'radio', switch: 'switch', tab: 'tab',
    menuitem: 'menuitem', menuitemcheckbox: 'menuitem', menuitemradio: 'menuitem', option: 'option',
    combobox: 'combobox', textbox: 'textbox', searchbox: 'textbox', slider: 'slider', spinbutton: 'textbox', treeitem: 'treeitem',
  };
  const TEXT_KINDS = new Set(['textbox', 'combobox']);
  const LABELLED = new Set(['textbox', 'combobox', 'checkbox', 'radio', 'switch', 'select', 'slider', 'file', 'color']);
  const STYLE_KEYS = ['display', 'position', 'color', 'background-color', 'font-size', 'font-weight', 'width', 'height', 'z-index', 'opacity', 'cursor'];

  // ---------- ref-ы ----------
  function refOf(el) {
    let id = S.ids.get(el);
    if (!id) {
      id = 'e' + (++S.seq);
      S.ids.set(el, id);
    }
    S.refs.set(id, new WeakRef(el));
    return id;
  }
  function byRef(id) {
    const key = String(id || '').trim().replace(/^\[|\]$/g, '').replace(/^ref[=:]?/i, '');
    const w = S.refs.get(key);
    const el = w && w.deref();
    if (!el || !el.isConnected) {
      if (w) S.refs.delete(key);
      return null;
    }
    return el;
  }
  // Уборка мёртвых ссылок, чтобы Map не рос на долгоживущих SPA.
  function gcRefs() {
    if (S.refs.size < 4000) return;
    for (const [k, w] of S.refs) { const e = w.deref(); if (!e || !e.isConnected) S.refs.delete(k); }
  }

  // ---------- общие ----------
  const norm = (s) => String(s == null ? '' : s).replace(/[\s ​]+/g, ' ').trim();
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const q = (s) => JSON.stringify(s);
  function shortUrl(href) {
    if (!href) return '';
    let u;
    try { u = new URL(href, location.href); } catch (e) { return clip(String(href), 200); }
    if (/^javascript:/i.test(u.href)) return 'javascript:…';
    let s = u.origin === location.origin ? (u.pathname + u.search + u.hash) : u.href;
    try { s = decodeURI(s); } catch (e) { /* как есть */ }
    return clip(s, 220);
  }
  function styleOf(el) { try { return getComputedStyle(el); } catch (e) { return null; } }

  // Прямоугольник элемента в координатах верхнего окна (с учётом same-origin iframe).
  function topRect(el) {
    const r = el.getBoundingClientRect();
    let x = r.left, y = r.top;
    let win = el.ownerDocument && el.ownerDocument.defaultView;
    while (win && win !== window) {
      let fe = null;
      try { fe = win.frameElement; } catch (e) { fe = null; }
      if (!fe) break;
      const fr = fe.getBoundingClientRect();
      const cs = styleOf(fe);
      x += fr.left + fe.clientLeft + (cs ? parseFloat(cs.paddingLeft) || 0 : 0);
      y += fr.top + fe.clientTop + (cs ? parseFloat(cs.paddingTop) || 0 : 0);
      win = win.parent;
    }
    return { x, y, w: r.width, h: r.height };
  }

  // Элемент под точкой (верхнее окно): проходит открытые shadow root и same-origin iframe.
  function hitTest(x, y) {
    let doc = document, ox = 0, oy = 0, el = null;
    for (let guard = 0; guard < 20; guard++) {
      let e = doc.elementFromPoint(x - ox, y - oy);
      if (!e) return el;
      while (e && e.shadowRoot) {
        const inner = e.shadowRoot.elementFromPoint(x - ox, y - oy);
        if (!inner || inner === e) break;
        e = inner;
      }
      el = e;
      if (e.tagName === 'IFRAME' || e.tagName === 'FRAME') {
        let d = null;
        try { d = e.contentDocument; } catch (_) { d = null; }
        if (!d) return el;
        const r = e.getBoundingClientRect();
        const cs = styleOf(e);
        ox += r.left + e.clientLeft + (cs ? parseFloat(cs.paddingLeft) || 0 : 0);
        oy += r.top + e.clientTop + (cs ? parseFloat(cs.paddingTop) || 0 : 0);
        doc = d;
        continue;
      }
      return el;
    }
    return el;
  }
  // a содержит b, переходя границы shadow DOM и iframe.
  function containsDeep(a, b) {
    for (let n = b, guard = 0; n && guard < 5000; guard++) {
      if (n === a) return true;
      if (n.parentNode) n = n.parentNode;
      else if (n.host) n = n.host;
      else if (n.nodeType === 9) { let fe = null; try { fe = n.defaultView && n.defaultView.frameElement; } catch (e) { fe = null; } n = fe; }
      else n = null;
    }
    return false;
  }
  function isVisible(el) {
    if (!el.isConnected) return false;
    try { if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: false })) return false; } catch (e) { /* старый движок */ }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function inViewport(r) {
    return r.x + r.w > 0 && r.y + r.h > 0 && r.x < innerWidth && r.y < innerHeight;
  }
  function deepActive() {
    let a = document.activeElement;
    for (let g = 0; a && g < 20; g++) {
      if (a.shadowRoot && a.shadowRoot.activeElement) { a = a.shadowRoot.activeElement; continue; }
      if (a.tagName === 'IFRAME') { let d = null; try { d = a.contentDocument; } catch (e) { d = null; } if (d && d.activeElement) { a = d.activeElement; continue; } }
      break;
    }
    return a;
  }

  // ---------- селекторы (с проходом в shadow DOM: "host >>> inner") ----------
  function allRoots(limit) {
    const roots = [document];
    const stack = [document];
    while (stack.length && roots.length < (limit || 500)) {
      const root = stack.pop();
      const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      for (let n = tw.nextNode(); n; n = tw.nextNode()) {
        if (n.shadowRoot) { roots.push(n.shadowRoot); stack.push(n.shadowRoot); }
        if (n.tagName === 'IFRAME') { let d = null; try { d = n.contentDocument; } catch (e) { d = null; } if (d) { roots.push(d); stack.push(d); } }
      }
    }
    return roots;
  }
  function queryAll(sel, limit) {
    sel = String(sel || '').trim();
    if (!sel) throw new Error('empty selector');
    limit = limit || 1000;
    const parts = sel.split('>>>').map((s) => s.trim()).filter(Boolean);
    if (parts.length > 1) {
      let ctxs = [document];
      for (let i = 0; i < parts.length; i++) {
        const next = [];
        for (const c of ctxs) {
          const root = c === document ? document : (c.shadowRoot || c);
          let found;
          try { found = root.querySelectorAll(parts[i]); } catch (e) { throw new Error('invalid selector: ' + parts[i]); }
          for (const f of found) next.push(f);
        }
        ctxs = next;
      }
      return ctxs.slice(0, limit);
    }
    let out;
    try { out = Array.from(document.querySelectorAll(sel)); } catch (e) { throw new Error('invalid selector: ' + sel); }
    if (out.length) return out.slice(0, limit);
    // Нет в документе — ищем в открытых shadow root и same-origin iframe.
    for (const r of allRoots()) {
      if (r === document) continue;
      try { for (const f of r.querySelectorAll(sel)) { out.push(f); if (out.length >= limit) return out; } } catch (e) { /* пропуск */ }
    }
    return out;
  }
  function getEl(a) {
    if (a.ref) {
      const el = byRef(a.ref);
      if (!el) throw new Error('ref ' + a.ref + ' not found: the element is gone or the page changed. Take a new snapshot.');
      return el;
    }
    if (a.selector) {
      const list = queryAll(a.selector, 50);
      if (!list.length) throw new Error('no element matches selector ' + a.selector);
      const vis = list.find(isVisible);
      return vis || list[0];
    }
    throw new Error('ref or selector is required');
  }

  // ---------- имена и описание ----------
  function textOfIds(el, ids) {
    const doc = el.getRootNode && el.getRootNode() || document;
    return ids.split(/\s+/).map((id) => {
      const e = (doc.getElementById ? doc.getElementById(id) : null) || document.getElementById(id);
      return e ? e.textContent : '';
    }).join(' ');
  }
  function labelText(el) {
    let s = '';
    try { if (el.labels && el.labels.length) s = Array.from(el.labels).map((l) => l.innerText || l.textContent).join(' '); } catch (e) { s = ''; }
    return s;
  }
  function innerTextOf(el) {
    let t = '';
    try { t = el.innerText; } catch (e) { t = ''; }
    if (t == null || t === '') t = el.textContent || '';
    return t;
  }
  function nameOf(el, kind, max) {
    let n = '';
    const lb = el.getAttribute('aria-labelledby');
    if (lb) n = norm(textOfIds(el, lb));
    if (!n) n = norm(el.getAttribute('aria-label'));
    if (!n && LABELLED.has(kind)) n = norm(labelText(el));
    if (!n && !TEXT_KINDS.has(kind) && kind !== 'select') n = norm(innerTextOf(el));
    if (!n && el.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(el.type)) n = norm(el.value);
    if (!n) n = norm(el.getAttribute('title'));
    if (!n) { const img = el.querySelector && el.querySelector('img[alt]'); if (img) n = norm(img.alt); }
    if (!n && el.tagName === 'INPUT' && el.type === 'image') n = norm(el.alt);
    if (!n) { const t = el.querySelector && el.querySelector('svg title'); if (t) n = norm(t.textContent); }
    return clip(n, max || 100);
  }

  function kindOf(el, cs, c) {
    const tag = el.tagName;
    switch (tag) {
      case 'A': if (el.hasAttribute('href')) return c && c.inLink ? null : 'link'; break;
      case 'BUTTON': return 'button';
      case 'SUMMARY': return 'button';
      case 'SELECT': return 'select';
      case 'TEXTAREA': return 'textbox';
      case 'INPUT': {
        const t = String(el.type || 'text').toLowerCase();
        if (t === 'hidden') return null;
        if (t === 'button' || t === 'submit' || t === 'reset' || t === 'image') return 'button';
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        if (t === 'range') return 'slider';
        if (t === 'file') return 'file';
        if (t === 'color') return 'color';
        return 'textbox';
      }
      case 'AREA': if (el.hasAttribute('href')) return 'link'; break;
      case 'VIDEO': case 'AUDIO': if (el.hasAttribute('controls')) return 'media'; break;
      default: break;
    }
    const role = (el.getAttribute('role') || '').trim().split(/\s+/)[0];
    if (role && ROLE_KIND[role]) {
      const k = ROLE_KIND[role];
      if ((k === 'link') && c && c.inLink) return null;
      return k;
    }
    if (el.isContentEditable) {
      const p = el.parentElement;
      if (!p || !p.isContentEditable) return 'textbox';
      return null;
    }
    if (c && c.inLink) return null;
    if (el.hasAttribute('onclick')) return 'clickable';
    if (cs && cs.cursor === 'pointer') {
      const p = el.parentElement;
      const pcs = p ? styleOf(p) : null;
      if ((!pcs || pcs.cursor !== 'pointer') && !el.querySelector(INTERACTIVE_SEL)) {
        const r = el.getBoundingClientRect();
        if (r.width >= 4 && r.height >= 4) return 'clickable';
      }
    }
    return null;
  }

  function stateBits(el, kind) {
    const bits = [];
    const tag = el.tagName;
    if (kind === 'link') {
      bits.push('→ ' + shortUrl(el.getAttribute('href') != null ? el.href || el.getAttribute('href') : ''));
      if (el.target === '_blank') bits.push('(new tab)');
    }
    if (TEXT_KINDS.has(kind)) {
      if (tag === 'INPUT' && el.type && el.type !== 'text') bits.push('type=' + el.type);
      if (el.name) bits.push('name=' + clip(el.name, 40));
      if (el.placeholder) bits.push('placeholder=' + q(clip(norm(el.placeholder), 60)));
      let v = tag === 'INPUT' || tag === 'TEXTAREA' ? el.value : (el.isContentEditable ? innerTextOf(el) : '');
      if (tag === 'INPUT' && el.type === 'password') v = v ? '•••' : '';
      if (v) bits.push('value=' + q(clip(norm(v), 120)));
      if (el.readOnly) bits.push('readonly');
      const exp = el.getAttribute('aria-expanded');
      if (exp) bits.push(exp === 'true' ? 'expanded' : 'collapsed');
    }
    if (kind === 'checkbox' || kind === 'radio' || kind === 'switch' || kind === 'menuitem' || kind === 'option' || kind === 'tab') {
      const checked = tag === 'INPUT' ? el.checked : (el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true');
      if (checked) bits.push(kind === 'tab' || kind === 'option' ? 'selected' : 'checked');
      else if (kind === 'checkbox' || kind === 'radio' || kind === 'switch') bits.push('unchecked');
    }
    if (kind === 'select') {
      if (el.name) bits.push('name=' + clip(el.name, 40));
      const opts = Array.from(el.options || []);
      const sel = opts.filter((o) => o.selected).map((o) => q(clip(norm(o.text), 50)));
      bits.push('selected=' + (sel.length ? sel.join(',') : '—'));
      const shown = opts.slice(0, 15).map((o) => q(clip(norm(o.text) || o.value, 40)));
      bits.push('options: ' + shown.join(' | ') + (opts.length > 15 ? ' | …(' + opts.length + ')' : ''));
      if (el.multiple) bits.push('multiple');
    }
    if (kind === 'slider') {
      bits.push('value=' + (tag === 'INPUT' ? el.value : (el.getAttribute('aria-valuenow') || '')));
      if (tag === 'INPUT') bits.push('min=' + el.min + ' max=' + el.max);
    }
    if (kind === 'file' && el.accept) bits.push('accept=' + clip(el.accept, 60));
    if (kind === 'button' || kind === 'menuitem' || kind === 'combobox' || kind === 'clickable') {
      const exp = el.getAttribute('aria-expanded');
      if (exp && kind !== 'combobox') bits.push(exp === 'true' ? 'expanded' : 'collapsed');
      const pr = el.getAttribute('aria-pressed');
      if (pr === 'true') bits.push('pressed');
      if (tag === 'BUTTON' && el.type === 'submit' && el.form) bits.push('submit');
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') bits.push('disabled');
    if (el === deepActive()) bits.push('focused');
    return bits;
  }
  const KIND_LABEL = { clickable: 'clickable', textbox: 'textbox', combobox: 'combobox' };
  function token(el, kind, opts) {
    const id = refOf(el);
    const name = nameOf(el, kind, opts && opts.nameMax);
    let s = '[' + id + '] ' + (KIND_LABEL[kind] || kind);
    if (name) s += ' ' + q(name);
    const bits = stateBits(el, kind);
    if (bits.length) s += ' ' + bits.join(' ');
    return s;
  }
  // Короткое описание любого элемента (find, picked, locate).
  function describe(el) {
    if (!el || el.nodeType !== 1) return '';
    const cs = styleOf(el);
    const kind = kindOf(el, cs, null);
    if (kind) return token(el, kind, { nameMax: 80 });
    const id = refOf(el);
    let s = '[' + id + '] ' + el.tagName.toLowerCase();
    const t = clip(norm(innerTextOf(el)), 80);
    if (t) s += ' ' + q(t);
    return s;
  }

  // ---------- писатель текста ----------
  function Writer(max, mode) {
    this.max = max; this.mode = mode; this.lines = []; this.cur = ''; this.prefix = ''; this.len = 0;
    this.full = false; this.last = ''; this.tokens = 0;
  }
  Writer.prototype.write = function (s) {
    if (this.full || !s) return;
    this.cur += s;
  };
  Writer.prototype.space = function () { if (this.cur && !/\s$/.test(this.cur)) this.cur += ' '; };
  Writer.prototype.newline = function () {
    if (this.full) return;
    const t = norm(this.cur);
    this.cur = '';
    if (!t) return;
    const line = this.prefix + t;
    this.prefix = '';
    if (line === this.last) return;
    this.last = line;
    if (this.len + line.length + 1 > this.max) {
      const room = this.max - this.len;
      if (room > 40) this.lines.push(line.slice(0, room - 1) + '…');
      this.full = true;
      return;
    }
    this.lines.push(line);
    this.len += line.length + 1;
  };
  Writer.prototype.setPrefix = function (p) { this.newline(); this.prefix = p; };
  Writer.prototype.token = function (s, block) {
    this.tokens++;
    if (this.mode === 'interactive' || block) { this.newline(); this.cur = s; this.newline(); return; }
    this.space(); this.cur += s; this.cur += ' ';
  };
  Writer.prototype.line = function (s) { this.newline(); this.cur = s; this.newline(); };

  // ---------- снимок ----------
  function snapshot(a) {
    const t0 = performance.now();
    const mode = a.mode === 'interactive' || a.mode === 'text' ? a.mode : 'full';
    const max = Math.max(1000, Math.min(400000, Number(a.maxChars) || 20000));
    const visibleOnly = !!a.visibleOnly;
    const w = new Writer(max, mode);
    let visited = 0;
    const MAX_NODES = 60000;
    const deadline = t0 + 6000;
    let cut = '';

    function walkChildren(node, c) {
      for (let ch = node.firstChild; ch; ch = ch.nextSibling) {
        if (w.full || cut) return;
        walk(ch, c);
      }
    }
    function children(el, c) {
      if (el.shadowRoot) walkChildren(el.shadowRoot, c);
      else walkChildren(el, c);
    }
    function frame(el, c) {
      let d = null;
      try { d = el.contentDocument; } catch (e) { d = null; }
      const r = el.getBoundingClientRect();
      if (r.width < 24 || r.height < 24) return;
      const src = el.getAttribute('src') || el.src || '';
      if (d && d.body) {
        if (mode !== 'text') w.line('[frame ' + (el.hasAttribute('srcdoc') ? 'srcdoc' : (shortUrl(src) || 'about:blank')) + ']');
        walkChildren(d.body, c);
        w.newline();
        if (mode !== 'text') w.line('[/frame]');
      } else if (mode !== 'text') {
        w.line('[frame cross-origin ' + shortUrl(src) + ' ' + Math.round(r.width) + '×' + Math.round(r.height) + ' — content not accessible]');
      }
    }
    function walk(node, c) {
      if (node.nodeType === 3) {
        if (mode !== 'interactive' || c.heading) {
          const d = node.data;
          if (d && /\S/.test(d)) w.write(d.replace(/[\s ]+/g, ' '));
          else if (d) w.write(' ');
        }
        return;
      }
      if (node.nodeType === 11) { walkChildren(node, c); return; }
      if (node.nodeType !== 1) return;
      const el = node;
      const tag = el.tagName;
      if (SKIP.has(tag)) return;
      if (++visited > MAX_NODES) { cut = 'page has too many elements'; return; }
      if ((visited & 255) === 0 && performance.now() > deadline) { cut = 'time limit reached'; return; }
      if (tag === 'SLOT') {
        const nodes = el.assignedNodes({ flatten: true });
        if (nodes.length) { for (const n of nodes) walk(n, c); } else walkChildren(el, c);
        return;
      }
      if (el.getAttribute('aria-hidden') === 'true' && !el.querySelector('input,select,textarea')) return;
      if (el.hidden && tag !== 'DIALOG') return;
      const cs = styleOf(el);
      if (!cs) return;
      const display = cs.display;
      if (display === 'none') return;
      if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return;
      if (cs.contentVisibility === 'hidden') return;
      const lower = tag.toLowerCase();
      if (lower === 'svg') {
        if (mode === 'full' && !c.inLink) {
          const t = el.querySelector('title');
          const lbl = norm(el.getAttribute('aria-label') || (t && t.textContent) || '');
          if (lbl) { w.space(); w.write('[icon ' + q(clip(lbl, 40)) + '] '); }
        }
        return;
      }
      let rect = null;
      if (display !== 'contents') {
        const r = el.getBoundingClientRect();
        rect = { x: r.left + c.ox, y: r.top + c.oy, w: r.width, h: r.height };
        if (visibleOnly && (rect.w > 0 || rect.h > 0) && cs.position !== 'fixed' && !inViewport(rect)) {
          // целиком вне экрана: потомки с position:fixed встречаются редко — пропускаем
          return;
        }
        if (rect.w === 0 && rect.h === 0 && cs.overflow !== 'visible' && tag !== 'INPUT') return;
      }
      if (tag === 'IFRAME' || tag === 'FRAME') {
        const r = el.getBoundingClientRect();
        let cs2 = cs;
        frame(el, Object.assign({}, c, { ox: c.ox + r.left + el.clientLeft + (parseFloat(cs2.paddingLeft) || 0), oy: c.oy + r.top + el.clientTop + (parseFloat(cs2.paddingTop) || 0) }));
        return;
      }
      if (tag === 'IMG') {
        if (mode === 'full' && !c.inLink && !c.inKind) {
          const alt = norm(el.getAttribute('alt'));
          if (alt.length > 1 && rect && rect.w > 24 && rect.h > 24) { w.space(); w.write('[img ' + q(clip(alt, 80)) + '] '); }
        }
        return;
      }
      if (tag === 'BR') { if (mode !== 'interactive') w.newline(); return; }
      if (tag === 'SELECT' && mode === 'text') {
        const o = el.options && el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
        if (o) { w.space(); w.write(norm(o.text) + ' '); }
        return;
      }
      if (tag === 'HR') { w.newline(); return; }
      if (tag === 'CANVAS' || tag === 'VIDEO' || tag === 'AUDIO') {
        if (mode !== 'text' && rect && rect.w > 40 && rect.h > 40 && !(tag !== 'CANVAS' && el.hasAttribute('controls'))) w.line('[' + lower + ' ' + Math.round(rect.w) + '×' + Math.round(rect.h) + ']');
        if (tag === 'CANVAS' || !el.hasAttribute('controls')) return;
      }
      const block = !INLINE.has(display);
      const kind = mode === 'text' || c.inKind ? null : kindOf(el, cs, c);
      if (block) w.newline();
      let heading = false;
      if (/^H[1-6]$/.test(tag)) { w.setPrefix('#'.repeat(Number(tag[1])) + ' '); heading = true; }
      else if (tag === 'LI' && mode !== 'interactive') w.setPrefix('- ');
      else if ((tag === 'TD' || tag === 'TH') && mode !== 'interactive') { if (norm(w.cur)) w.write(' | '); }
      else if (el.getAttribute('role') === 'heading' && mode !== 'interactive') { const lv = Number(el.getAttribute('aria-level')) || 2; w.setPrefix('#'.repeat(Math.min(6, lv)) + ' '); heading = true; }
      const cc = heading ? Object.assign({}, c, { heading: true }) : c;
      if (kind) {
        const tk = token(el, kind);
        w.token(tk, block && mode !== 'interactive');
        // Длинное содержимое (карточка-ссылка, кнопка-блок) — пройти внутрь за текстом и вложенными элементами.
        if (kind === 'link' || kind === 'clickable' || kind === 'button' || kind === 'tab' || kind === 'option' || kind === 'menuitem' || kind === 'treeitem') {
          const long = norm(innerTextOf(el)).length > 100 || !!el.querySelector('input,select,textarea,button');
          if (long) {
            const nc = Object.assign({}, cc, { inLink: kind === 'link' || kind === 'clickable' || c.inLink });
            children(el, nc);
          }
        }
      } else {
        children(el, cc);
      }
      if (block || heading) w.newline();
    }

    let root = document.body || document.documentElement;
    if (a.selector) root = getEl({ selector: a.selector });
    if (root) walk(root, { ox: 0, oy: 0, inLink: false, inKind: false, heading: false });
    w.newline();
    gcRefs();

    const se = document.scrollingElement || document.documentElement;
    const head = [];
    head.push('Title: ' + (document.title || '(no title)'));
    head.push('URL: ' + location.href);
    head.push('Viewport ' + innerWidth + '×' + innerHeight + ', scroll ' + Math.round(scrollX) + ',' + Math.round(scrollY) +
      ' of ' + se.scrollWidth + '×' + se.scrollHeight + (visibleOnly ? ' (visible part only)' : '') +
      (a.selector ? ' — subtree ' + a.selector : '') + ', mode ' + mode);
    const body = w.lines.join('\n');
    const foot = [];
    if (w.full) foot.push('[truncated at ' + max + ' chars — narrow with visibleOnly=true, selector, mode=interactive, scroll, or find]');
    if (cut) foot.push('[stopped early: ' + cut + ']');
    foot.push('[' + w.tokens + ' refs, ' + visited + ' elements, ' + Math.round(performance.now() - t0) + ' ms]');
    return head.join('\n') + '\n\n' + (body || '(no visible text)') + '\n\n' + foot.join('\n');
  }

  // ---------- поиск ----------
  function find(a) {
    const limit = Math.max(1, Math.min(100, Number(a.limit) || 20));
    const out = [];
    const seen = new Set();
    const push = (el) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      const vis = isVisible(el);
      if (!vis && !a.includeHidden) return;
      let s = describe(el);
      if (!vis) s += ' (hidden)';
      else if (!inViewport(topRect(el))) s += ' (offscreen)';
      out.push(s);
    };
    if (a.selector) {
      for (const el of queryAll(a.selector, 500)) { if (out.length >= limit) break; push(el); }
      return { total: out.length, lines: out };
    }
    const needle = norm(a.text);
    if (!needle) throw new Error('text or selector is required');
    const exact = !!a.exact;
    const lc = needle.toLowerCase();
    const match = (s) => { s = norm(s); return exact ? s === needle : s.toLowerCase().includes(lc); };
    const promote = (el) => {
      for (let p = el, i = 0; p && i < 6; i++, p = p.parentElement) {
        const k = kindOf(p, styleOf(p), null);
        if (k) return p;
      }
      return el;
    };
    for (const root of allRoots()) {
      const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = tw.nextNode(); n && out.length < limit; n = tw.nextNode()) {
        const p = n.parentElement;
        if (!p || SKIP.has(p.tagName)) continue;
        if (!match(exact ? p.textContent : n.data)) continue;
        push(promote(p));
      }
      if (out.length >= limit) break;
      let attrs;
      try { attrs = root.querySelectorAll('[aria-label],[placeholder],[title],[alt],input[type=submit],input[type=button]'); } catch (e) { attrs = []; }
      for (const el of attrs) {
        if (out.length >= limit) break;
        const v = [el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('title'), el.getAttribute('alt'), el.tagName === 'INPUT' ? el.value : ''].filter(Boolean);
        if (v.some(match)) push(promote(el));
      }
    }
    return { total: out.length, lines: out };
  }

  // ---------- действия ----------
  function locate(a) {
    const el = getEl(a);
    if (a.scroll !== false) {
      try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) { el.scrollIntoView(); }
    }
    const r = topRect(el);
    const vis = isVisible(el);
    const pts = [[0.5, 0.5], [0.3, 0.5], [0.7, 0.5], [0.5, 0.3], [0.5, 0.7], [0.15, 0.5], [0.85, 0.5]];
    let x = r.x + r.w / 2, y = r.y + r.h / 2, hit = false, cover = '';
    for (const [fx, fy] of pts) {
      const px = r.x + r.w * fx, py = r.y + r.h * fy;
      if (px < 0 || py < 0 || px >= innerWidth || py >= innerHeight) continue;
      const h = hitTest(px, py);
      if (h && (h === el || containsDeep(el, h))) { x = px; y = py; hit = true; break; }
      if (!cover && h) cover = describe(h);
    }
    return {
      x, y, rect: r, visible: vis, hit, cover: hit ? '' : cover, desc: describe(el), tag: el.tagName.toLowerCase(),
      password: el.tagName === 'INPUT' && el.type === 'password',
      disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'),
      vw: innerWidth, vh: innerHeight,
    };
  }
  function focus(a) {
    const el = getEl(a);
    const tag = el.tagName;
    if (el.disabled) throw new Error('element is disabled: ' + describe(el));
    try { el.focus({ preventScroll: true }); } catch (e) { /* не фокусируемый */ }
    const act = deepActive();
    const focused = act === el || containsDeep(el, act);
    let selected = false;
    if (a.clear) {
      try {
        if (tag === 'INPUT' || tag === 'TEXTAREA') { el.select(); selected = true; }
        else if (el.isContentEditable) {
          const sel = el.ownerDocument.getSelection();
          const range = el.ownerDocument.createRange();
          range.selectNodeContents(el);
          sel.removeAllRanges(); sel.addRange(range);
          selected = true;
        }
      } catch (e) { selected = false; }
    }
    return {
      focused, selected, tag: tag.toLowerCase(), editable: tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable,
      password: tag === 'INPUT' && el.type === 'password', readOnly: !!el.readOnly, desc: describe(el),
    };
  }
  function value(a) {
    const el = getEl(a);
    const tag = el.tagName;
    let v = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ? el.value : innerTextOf(el);
    if (tag === 'INPUT' && el.type === 'password') v = v ? '•'.repeat(Math.min(12, v.length)) : '';
    return { value: clip(String(v == null ? '' : v), 2000), desc: describe(el) };
  }
  function selectOption(a) {
    const el = getEl(a);
    if (el.tagName !== 'SELECT') throw new Error('not a <select>: ' + describe(el) + '. For custom dropdowns click the option instead.');
    const wanted = [].concat(a.values || [], a.value != null ? [a.value] : []).map(String);
    if (!wanted.length && a.index == null) throw new Error('value(s) or index is required');
    const opts = Array.from(el.options);
    const picked = [];
    if (a.index != null) {
      const o = opts[Number(a.index)];
      if (!o) throw new Error('no option at index ' + a.index);
      picked.push(o);
    }
    for (const w of wanted) {
      const o = opts.find((x) => x.value === w) || opts.find((x) => norm(x.text) === norm(w)) || opts.find((x) => norm(x.text).toLowerCase().includes(norm(w).toLowerCase()));
      if (!o) throw new Error('no option ' + q(w) + '. Options: ' + opts.slice(0, 30).map((x) => q(norm(x.text))).join(', '));
      picked.push(o);
    }
    if (!el.multiple && picked.length > 1) picked.splice(1);
    if (el.multiple) for (const o of opts) o.selected = picked.includes(o);
    else el.value = picked[0].value;
    for (const o of picked) o.selected = true;
    el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { selected: picked.map((o) => norm(o.text) + (o.value !== norm(o.text) ? ' (' + o.value + ')' : '')), desc: describe(el) };
  }
  function info() {
    const se = document.scrollingElement || document.documentElement;
    let sel = '';
    try { sel = String(getSelection()); } catch (e) { sel = ''; }
    const act = deepActive();
    return {
      url: location.href, title: document.title, readyState: document.readyState,
      vw: innerWidth, vh: innerHeight, sx: Math.round(scrollX), sy: Math.round(scrollY),
      dw: se.scrollWidth, dh: se.scrollHeight, dpr: devicePixelRatio,
      focused: act && act !== document.body && act !== document.documentElement ? describe(act) : '',
      selection: clip(sel, 20000), lang: document.documentElement.lang || '',
      elements: document.getElementsByTagName('*').length,
    };
  }
  function html(a) {
    const max = Math.max(1000, Math.min(1000000, Number(a.maxChars) || 50000));
    const el = a.ref || a.selector ? getEl(a) : document.documentElement;
    const clone = el.cloneNode(true);
    const rm = a.keepScripts ? 'template' : 'script,style,noscript,template,link[rel=stylesheet],link[rel=preload],link[rel=prefetch],link[rel=modulepreload]';
    if (clone.querySelectorAll) {
      for (const n of clone.querySelectorAll(rm)) n.remove();
      if (!a.keepSvg) for (const s of clone.querySelectorAll('svg')) { while (s.firstChild) s.removeChild(s.firstChild); }
      for (const n of clone.querySelectorAll('*')) {
        for (const at of Array.from(n.attributes)) {
          if (at.value.length > 300 && /^(src|srcset|href|style|d|data-.*|content)$/i.test(at.name)) n.setAttribute(at.name, at.value.slice(0, 120) + '…[' + at.value.length + ' chars]');
        }
      }
    }
    let s = clone.outerHTML || '';
    s = s.replace(/\n\s*\n+/g, '\n');
    const total = s.length;
    return { html: s.length > max ? s.slice(0, max) : s, total, truncated: total > max, desc: el === document.documentElement ? 'document' : describe(el) };
  }
  function storage(a) {
    const st = a.type === 'session' ? sessionStorage : localStorage;
    const max = Math.max(200, Math.min(500000, Number(a.maxChars) || 20000));
    if (a.key != null) {
      const v = st.getItem(String(a.key));
      return { found: v != null, key: String(a.key), value: v == null ? null : (v.length > max ? v.slice(0, max) : v), length: v == null ? 0 : v.length };
    }
    const prefix = a.prefix ? String(a.prefix) : '';
    const items = [];
    for (let i = 0; i < st.length; i++) {
      const k = st.key(i);
      if (prefix && !k.startsWith(prefix)) continue;
      const v = st.getItem(k) || '';
      items.push({ key: k, length: v.length, preview: clip(norm(v), 160) });
    }
    items.sort((x, y) => (x.key < y.key ? -1 : 1));
    return { origin: location.origin, count: st.length, items: items.slice(0, 300) };
  }
  function check(a) {
    if (a.selector) {
      const list = queryAll(a.selector, 20);
      const state = a.state || 'visible';
      if (state === 'attached') return { ok: list.length > 0 };
      if (state === 'detached') return { ok: list.length === 0 };
      const vis = list.some(isVisible);
      return { ok: state === 'hidden' ? !vis : vis, desc: list[0] ? describe(list[0]) : '' };
    }
    if (a.text != null) {
      const body = document.body ? document.body.innerText || '' : '';
      const ok = norm(body).toLowerCase().includes(norm(a.text).toLowerCase());
      return { ok: a.state === 'hidden' ? !ok : ok };
    }
    return { ok: true };
  }
  function scrollBy(a) {
    if (a.ref || a.selector) {
      const el = getEl(a);
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    } else {
      window.scrollBy({ left: Number(a.dx) || 0, top: Number(a.dy) || 0, behavior: 'instant' });
    }
    return info();
  }
  function refFor(a) {
    const el = getEl(a);
    return { ref: refOf(el), desc: describe(el) };
  }
  function styles(a) {
    const el = getEl(a);
    const cs = styleOf(el);
    const out = {};
    for (const k of STYLE_KEYS) out[k] = cs ? cs.getPropertyValue(k) : '';
    return out;
  }

  const API = { snapshot, find, locate, focus, value, selectOption, info, html, storage, check, scrollBy, refFor, styles,
    selection: () => { try { return String(getSelection()); } catch (e) { return ''; } } };
  globalThis.__kosmoSnap = {
    v: VERSION,
    run(method, args) {
      const fn = API[method];
      if (!fn) return { __error: 'unknown method ' + method };
      try { return fn(args || {}); } catch (e) { return { __error: String((e && e.message) || e) }; }
    },
  };
}
/* eslint-enable no-var */

const LIB_SRC = '(' + lib.toString() + ')(' + VERSION + ');';

// Код для executeJavaScriptInIsolatedWorld: определить библиотеку (если ещё нет) и вызвать метод.
function code(method, args) {
  return LIB_SRC + '\n__kosmoSnap.run(' + JSON.stringify(String(method)) + ',' + JSON.stringify(args || {}) + ');';
}

module.exports = { WORLD, VERSION, LIB_SRC, code };
