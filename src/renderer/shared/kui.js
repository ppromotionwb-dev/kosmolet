// Космолёт — мелкие хелперы интерфейса (window.KUI). Владелец: core.
// Работает и без window.kosmo (например, на странице ошибки): invoke отклоняется, on — пустышка.
'use strict';
(function () {
  // ---------- мост к main ----------
  const hasKosmo = typeof window.kosmo === 'object' && window.kosmo && typeof window.kosmo.invoke === 'function';
  const kosmo = hasKosmo ? window.kosmo : {
    invoke: () => Promise.reject(new Error('kosmo API недоступен')),
    send: () => {},
    on: () => () => {},
    platform: navigator.platform, versions: {}
  };

  function invoke(channel, payload) { return kosmo.invoke(channel, payload); }
  function send(channel, payload) { try { kosmo.send(channel, payload); } catch (e) { console.warn('[kui] send', channel, e); } }
  // «выстрелить» без ожидания ответа: invoke, а если в main канал повешен через ipc.on (нет handler) — send
  const sendOnly = new Set();
  function fire(channel, payload) {
    if (!hasKosmo) return Promise.resolve();
    if (sendOnly.has(channel)) { send(channel, payload); return Promise.resolve(); }
    return kosmo.invoke(channel, payload).catch((e) => {
      if (/No handler registered/i.test(String(e && e.message))) { sendOnly.add(channel); send(channel, payload); return; }
      console.warn('[kui]', channel, e && e.message);
    });
  }
  function on(channel, cb) {
    try {
      const off = kosmo.on(channel, cb);
      return typeof off === 'function' ? off : () => {};
    } catch (e) { console.warn('[kui] on', channel, e); return () => {}; }
  }

  // ---------- DOM ----------
  // h('div.cls1.cls2#id', {attrs}, ...children)
  // attrs: class, style (строка|объект), dataset, html (innerHTML), text, onClick и прочие on* (addEventListener),
  // ref (функция, получит элемент), прочее — setAttribute; true → пустой атрибут, false/null/undefined — пропуск.
  function h(tag, attrs, ...children) {
    let id = null, classes = null;
    if (tag.indexOf('.') >= 0 || tag.indexOf('#') >= 0) {
      const parts = tag.split(/(?=[.#])/);
      tag = parts[0] || 'div';
      for (let i = 1; i < parts.length; i++) {
        const p = parts[i];
        if (p[0] === '#') id = p.slice(1); else (classes || (classes = [])).push(p.slice(1));
      }
    }
    const el = document.createElement(tag);
    if (id) el.id = id;
    if (classes) el.className = classes.join(' ');
    if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { children.unshift(attrs); attrs = null; }
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class' || k === 'className') { el.className = classes ? classes.join(' ') + ' ' + v : v; }
        else if (k === 'style') { if (typeof v === 'string') el.style.cssText = v; else for (const s in v) { if (s.startsWith('--')) el.style.setProperty(s, v[s]); else el.style[s] = v[s]; } }
        else if (k === 'dataset') { for (const d in v) el.dataset[d] = v[d]; }
        else if (k === 'html') { el.innerHTML = v; }
        else if (k === 'text') { el.textContent = v; }
        else if (k === 'ref') { v(el); }
        else if (k.length > 2 && k[0] === 'o' && k[1] === 'n' && typeof v === 'function') { el.addEventListener(k.slice(2).toLowerCase(), v); }
        else if (k === 'value' && 'value' in el) { el.value = v; }
        else if ((k === 'checked' || k === 'disabled' || k === 'selected') && k in el) { el[k] = !!v; }
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    append(el, children);
    return el;
  }
  function append(el, children) {
    for (const c of children) {
      if (c === null || c === undefined || c === false || c === true) continue;
      if (Array.isArray(c)) append(el, c);
      else if (c instanceof Node) el.appendChild(c);
      else el.appendChild(document.createTextNode(String(c)));
    }
    return el;
  }
  function icon(name, size, opts) { return window.KIcons ? window.KIcons.el(name, size, opts) : document.createElement('span'); }
  // пустое состояние: empty({icon, title, text, actions: [Node], tone: 'error'})
  function empty(o) {
    o = o || {};
    return h('div.k-empty' + (o.tone === 'error' ? '.k-error' : ''),
      o.icon ? icon(o.icon, 28, { stroke: 1.5 }) : null,
      o.title ? h('div.k-empty-title', o.title) : null,
      o.text ? h('div.k-empty-text', o.text) : null,
      o.actions && o.actions.length ? h('div.k-empty-actions', o.actions) : null);
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // подключить css один раз (для фич, которым нужен свой файл стилей)
  const cssLoaded = new Set();
  function css(href) {
    const abs = new URL(href, document.baseURI).href;
    if (cssLoaded.has(abs)) return;
    cssLoaded.add(abs);
    document.head.appendChild(h('link', { rel: 'stylesheet', href: abs }));
  }

  // ---------- тосты ----------
  let toastHost = null;
  function toast(text, opts) {
    opts = opts || {};
    if (!toastHost) {
      toastHost = h('div.k-toast-host', { role: 'status', 'aria-live': 'polite' });
      document.body.appendChild(toastHost);
    }
    const t = h('div.k-toast', { dataset: opts.tone ? { tone: opts.tone } : null }, text);
    toastHost.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    const ms = opts.ms || 2200;
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 220);
    }, ms);
    return t;
  }

  // ---------- буфер обмена ----------
  async function copyText(text, opts) {
    text = String(text == null ? '' : text);
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (e) { /* запасной путь ниже */ }
    if (!ok) {
      const ta = h('textarea', { style: 'position:fixed;left:-9999px;top:0;opacity:0' });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove();
    }
    if (!opts || opts.toast !== false) toast(ok ? ((opts && opts.message) || 'Скопировано') : 'Не удалось скопировать', { tone: ok ? null : 'danger' });
    return ok;
  }

  // ---------- тайминги ----------
  function debounce(fn, ms) {
    let t = null;
    const d = function (...args) { clearTimeout(t); t = setTimeout(() => { t = null; fn.apply(this, args); }, ms); };
    d.cancel = () => { clearTimeout(t); t = null; };
    d.flush = function (...args) { clearTimeout(t); t = null; fn.apply(this, args); };
    return d;
  }
  function throttle(fn, ms) {
    let last = 0, t = null, lastArgs = null;
    return function (...args) {
      lastArgs = args;
      const now = Date.now();
      const left = ms - (now - last);
      if (left <= 0) { last = now; fn.apply(this, args); }
      else if (!t) t = setTimeout(() => { t = null; last = Date.now(); fn.apply(this, lastArgs); }, left);
    };
  }
  // не чаще раза за кадр
  function rafThrottle(fn) {
    let id = 0, lastArgs = null;
    const r = function (...args) { lastArgs = args; if (!id) id = requestAnimationFrame(() => { id = 0; fn.apply(this, lastArgs); }); };
    r.cancel = () => { if (id) cancelAnimationFrame(id); id = 0; };
    return r;
  }

  // ---------- форматирование ----------
  function plural(n, forms) {
    n = Math.abs(n) % 100;
    const n1 = n % 10;
    if (n > 10 && n < 20) return forms[2];
    if (n1 > 1 && n1 < 5) return forms[1];
    if (n1 === 1) return forms[0];
    return forms[2];
  }
  const nf1 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 });
  function formatBytes(bytes) {
    if (bytes == null || isNaN(bytes)) return '—';
    if (bytes < 1024) return bytes + ' Б';
    const units = ['КБ', 'МБ', 'ГБ', 'ТБ'];
    let v = bytes / 1024, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return nf1.format(v >= 100 ? Math.round(v) : v) + ' ' + units[i];
  }
  function formatMs(ms) {
    if (ms == null || isNaN(ms)) return '—';
    if (ms < 1000) return Math.round(ms) + ' мс';
    if (ms < 60000) return nf1.format(ms / 1000) + ' с';
    const m = Math.floor(ms / 60000), s = Math.round((ms % 60000) / 1000);
    return m + ' мин' + (s ? ' ' + s + ' с' : '');
  }
  const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function formatTime(ts) { const d = new Date(ts); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function formatDate(ts, withTime) {
    const d = new Date(ts), now = new Date();
    let s = d.getDate() + ' ' + MONTHS[d.getMonth()];
    if (d.getFullYear() !== now.getFullYear()) s += ' ' + d.getFullYear();
    if (withTime) s += ', ' + formatTime(ts);
    return s;
  }
  // «только что», «5 минут назад», «вчера в 14:20», «12 окт»
  function timeAgo(ts, now) {
    if (!ts) return '';
    now = now || Date.now();
    const diff = Math.max(0, now - ts);
    const sec = Math.floor(diff / 1000);
    if (sec < 45) return 'только что';
    const min = Math.round(sec / 60);
    if (min < 60) return min + ' ' + plural(min, ['минуту', 'минуты', 'минут']) + ' назад';
    const hr = Math.round(min / 60);
    const d = new Date(ts), n = new Date(now);
    const sameDay = d.toDateString() === n.toDateString();
    if (hr < 12 || sameDay) return hr + ' ' + plural(hr, ['час', 'часа', 'часов']) + ' назад';
    const y = new Date(n); y.setDate(n.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return 'вчера в ' + formatTime(ts);
    const days = Math.round(diff / 86400000);
    if (days < 7) return days + ' ' + plural(days, ['день', 'дня', 'дней']) + ' назад';
    return formatDate(ts);
  }

  // ---------- URL ----------
  // punycode → Unicode (только для показа). Смешение латиницы с другими письменностями оставляем как xn-- (защита от подмены).
  function punyDecode(input) {
    const base = 36, tMin = 1, tMax = 26, skew = 38, damp = 700;
    const digit = (c) => c >= 48 && c < 58 ? c - 22 : c >= 65 && c < 91 ? c - 65 : c >= 97 && c < 123 ? c - 97 : base;
    const adapt = (delta, num, first) => {
      let k = 0;
      delta = first ? Math.floor(delta / damp) : delta >> 1;
      delta += Math.floor(delta / num);
      for (; delta > ((base - tMin) * tMax) >> 1; k += base) delta = Math.floor(delta / (base - tMin));
      return Math.floor(k + (base - tMin + 1) * delta / (delta + skew));
    };
    const out = [];
    let b = input.lastIndexOf('-'); if (b < 0) b = 0;
    for (let j = 0; j < b; j++) out.push(input.charCodeAt(j));
    let i = 0, n = 128, bias = 72;
    for (let idx = b > 0 ? b + 1 : 0; idx < input.length;) {
      const oldi = i;
      for (let w = 1, k = base; ; k += base) {
        if (idx >= input.length) throw new Error('bad');
        const d = digit(input.charCodeAt(idx++));
        if (d >= base) throw new Error('bad');
        i += d * w;
        const t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);
        if (d < t) break;
        w *= base - t;
      }
      const len = out.length + 1;
      bias = adapt(i - oldi, len, oldi === 0);
      n += Math.floor(i / len);
      i %= len;
      out.splice(i++, 0, n);
    }
    return String.fromCodePoint(...out);
  }
  function hostToUnicode(host) {
    if (!host || host.indexOf('xn--') < 0) return host;
    return host.split('.').map((label) => {
      if (!label.toLowerCase().startsWith('xn--')) return label;
      try {
        const dec = punyDecode(label.slice(4).toLowerCase());
        if (/[a-z]/i.test(dec) && /[^\x00-\x7f]/.test(dec)) return label;
        return dec;
      } catch (e) { return label; }
    }).join('.');
  }
  function safeDecode(s) { try { return decodeURI(s); } catch (e) { return s; } }

  // Разбор URL для показа: { scheme, host, hostU, rest, secure, local, internal, display }
  function parseUrl(url) {
    const r = { url: url || '', scheme: '', host: '', hostU: '', rest: '', secure: false, local: false, internal: false, display: url || '' };
    if (!url) return r;
    let u;
    try { u = new URL(url); } catch (e) { return r; }
    r.scheme = u.protocol.replace(/:$/, '');
    r.host = u.host;
    r.hostU = hostToUnicode(u.hostname) + (u.port ? ':' + u.port : '');
    r.secure = r.scheme === 'https' || r.scheme === 'wss';
    r.internal = r.scheme === 'kosmo';
    const hn = u.hostname;
    r.local = hn === 'localhost' || hn === '127.0.0.1' || hn === '[::1]' || hn.endsWith('.localhost') || hn.endsWith('.test') || /^127\./.test(hn);
    if (r.scheme === 'http' || r.scheme === 'https' || r.scheme === 'kosmo' || r.scheme === 'ws' || r.scheme === 'wss') {
      let rest = u.pathname + u.search + u.hash;
      if (rest === '/') rest = '';
      r.rest = safeDecode(rest);
      r.display = (r.scheme === 'https' ? '' : r.scheme + '://') + r.hostU + r.rest;
    } else {
      r.display = safeDecode(url);
    }
    return r;
  }
  // полный URL в читаемом виде (Unicode-домен, декодированный путь) — для адресной строки в фокусе
  function readableUrl(url) {
    try {
      const u = new URL(url);
      if (!u.host) return safeDecode(url);
      const auth = u.username ? u.username + (u.password ? ':' + u.password : '') + '@' : '';
      return u.protocol + '//' + auth + hostToUnicode(u.hostname) + (u.port ? ':' + u.port : '') + safeDecode(u.pathname + u.search + u.hash);
    } catch (e) { return url || ''; }
  }

  // ---------- объекты ----------
  function getPath(obj, path) {
    if (!path) return obj;
    const parts = Array.isArray(path) ? path : String(path).split('.');
    let cur = obj;
    for (const p of parts) { if (cur == null) return undefined; cur = cur[p]; }
    return cur;
  }
  function setPath(obj, path, value) {
    const parts = String(path).split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
    return obj;
  }
  function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

  // простая шина событий
  function emitter() {
    const map = new Map();
    return {
      on(evt, cb) { if (!map.has(evt)) map.set(evt, new Set()); map.get(evt).add(cb); return () => map.get(evt).delete(cb); },
      emit(evt, ...args) {
        const set = map.get(evt); if (!set) return;
        for (const cb of Array.from(set)) { try { cb(...args); } catch (e) { console.error('[kui] обработчик', evt, e); } }
      }
    };
  }

  window.KUI = {
    kosmo, hasKosmo, invoke, send, fire, on,
    h, append, icon, empty, clear, esc, css,
    toast, copyText,
    debounce, throttle, rafThrottle,
    plural, formatBytes, formatMs, formatTime, formatDate, timeAgo,
    hostToUnicode, parseUrl, readableUrl,
    getPath, setPath, clamp, emitter
  };
})();
