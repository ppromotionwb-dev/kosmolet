'use strict';
// tools-pack: встроенная библиотека сниппетов (только чтение; «Копировать в мои» делает редактируемую копию).
// Сниппеты записаны обычными функциями — в редактор попадает их тело (fn.toString()), без экранирования.
// Особые результаты понимает панель «Сниппеты»:
//   {__kosmo:'table', title, columns, rows, copyColumn?} — таблица с кнопками «CSV»/«TSV»;
//   {__kosmo:'copy', text, message} — скопировать текст в буфер;
//   {__kosmo:'choices', title, items:[{label, sub, text, message}]} — список, по нажатию копирует text.

const LIB = [
  {
    id: 'lib-links', name: 'Все ссылки страницы', world: 'isolated',
    desc: 'Таблица адресов и текстов ссылок, копирование в CSV',
    fn: async function () {
      // Все ссылки страницы: адрес, текст и сколько раз встречается. Кнопки «CSV» и «TSV» копируют таблицу.
      const seen = new Map();
      for (const a of document.querySelectorAll('a[href]')) {
        const url = a.href;
        if (!/^https?:/i.test(url)) continue;
        const text = (a.innerText || a.textContent || a.title || a.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        const row = seen.get(url);
        if (row) { row[2]++; if (!row[1] && text) row[1] = text; } else seen.set(url, [url, text, 1]);
      }
      const rows = [...seen.values()];
      if (!rows.length) return 'Ссылок на странице нет';
      return { __kosmo: 'table', title: 'Ссылок: ' + rows.length, columns: ['Адрес', 'Текст', 'Раз'], rows };
    },
  },
  {
    id: 'lib-table-tsv', name: 'Таблица в буфер (TSV)', world: 'isolated',
    desc: 'Копирует таблицу для вставки в Excel или Google Таблицы',
    fn: async function () {
      // Таблица в буфер обмена (TSV): вставляется в Excel и Google Таблицы по ячейкам.
      // TABLE = 0 — показать все таблицы и выбрать нужную; 1, 2… — сразу скопировать таблицу с этим номером.
      const TABLE = 0;
      const tables = [...document.querySelectorAll('table')].filter((t) => t.rows.length > 0);
      if (!tables.length) return 'На странице нет таблиц <table>';
      const cell = (c) => (c.innerText || c.textContent || '').replace(/\s+/g, ' ').trim();
      const toTsv = (t) => [...t.rows].map((r) => [...r.cells].map(cell).join('\t')).join('\n');
      const plural = (n, f) => { const m = n % 100, d = n % 10; return n + ' ' + (m > 10 && m < 20 ? f[2] : d === 1 ? f[0] : d > 1 && d < 5 ? f[1] : f[2]); };
      const info = (t, i) => {
        const cap = t.caption ? cell(t.caption) : '';
        const cols = Math.max(...[...t.rows].map((r) => r.cells.length));
        const head = [...t.rows[0].cells].map(cell).filter(Boolean).slice(0, 4).join(' · ');
        const rows = plural(t.rows.length, ['строка', 'строки', 'строк']);
        return {
          label: 'Таблица ' + (i + 1) + (cap ? ': ' + cap : ''),
          sub: rows + ' × ' + plural(cols, ['столбец', 'столбца', 'столбцов']) + (head ? ' — ' + head : ''),
          text: toTsv(t),
          message: 'Таблица ' + (i + 1) + ' скопирована (' + rows + ')',
        };
      };
      if (TABLE > 0) {
        if (!tables[TABLE - 1]) return 'Таблицы №' + TABLE + ' нет, всего таблиц: ' + tables.length;
        const t = info(tables[TABLE - 1], TABLE - 1);
        return { __kosmo: 'copy', text: t.text, message: t.message };
      }
      if (tables.length === 1) {
        const t = info(tables[0], 0);
        return { __kosmo: 'copy', text: t.text, message: t.message };
      }
      return { __kosmo: 'choices', title: 'Таблиц: ' + tables.length + '. Нажмите на нужную — она скопируется', items: tables.map(info) };
    },
  },
  {
    id: 'lib-unblock', name: 'Разблокировать копирование и ПКМ', world: 'page',
    desc: 'Снимает запреты на выделение, копирование и контекстное меню',
    fn: async function () {
      // Снимает запреты сайта на выделение, копирование, вставку и контекстное меню. Действует до перезагрузки.
      const TYPES = ['copy', 'cut', 'paste', 'contextmenu', 'selectstart', 'dragstart', 'beforecopy'];
      const KEYS = ['c', 'x', 'v', 'a', 'с', 'ч', 'м', 'ф']; // и в русской раскладке
      if (!window.__kosmoUnblock) {
        window.__kosmoUnblock = true;
        for (const t of TYPES) window.addEventListener(t, (e) => e.stopImmediatePropagation(), true);
        const preventDefault = Event.prototype.preventDefault;
        Event.prototype.preventDefault = function () {
          if (TYPES.includes(this.type)) return undefined;
          if (this.type === 'keydown' && (this.ctrlKey || this.metaKey) && KEYS.includes(String(this.key).toLowerCase())) return undefined;
          return preventDefault.call(this);
        };
      }
      const sheet = new CSSStyleSheet();
      sheet.replaceSync('*, *::before, *::after { user-select: text !important; -webkit-user-select: text !important; }');
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      let cleared = 0;
      const els = [document, document.documentElement, document.body, ...document.querySelectorAll('[oncopy],[oncut],[onpaste],[oncontextmenu],[onselectstart],[ondragstart],[onmousedown]')];
      for (const el of els) {
        if (!el) continue;
        for (const t of TYPES.concat('mousedown')) if (el['on' + t]) { el['on' + t] = null; cleared++; }
      }
      return 'Выделение, копирование и ПКМ разблокированы' + (cleared ? ' (снято обработчиков: ' + cleared + ')' : '') + '. Действует до перезагрузки страницы.';
    },
  },
  {
    id: 'lib-hidden-fields', name: 'Показать скрытые поля форм', world: 'isolated',
    desc: 'Делает input type=hidden видимыми и выводит их значения',
    fn: async function () {
      // Показывает скрытые поля форм (input type=hidden) и выводит таблицу. Повторный запуск снова их скрывает.
      const shown = document.querySelectorAll('input[data-kosmo-hidden]');
      if (shown.length) {
        for (const el of shown) {
          el.type = 'hidden';
          el.removeAttribute('data-kosmo-hidden');
          el.style.removeProperty('outline');
          el.style.removeProperty('outline-offset');
        }
        return 'Скрытые поля снова скрыты (' + shown.length + ')';
      }
      const rows = [];
      for (const el of document.querySelectorAll('input[type="hidden" i]')) {
        const form = el.form;
        rows.push([el.name || el.id || '(без имени)', el.value, form ? (form.getAttribute('action') || location.pathname) : '—']);
        el.setAttribute('data-kosmo-hidden', '1');
        el.type = 'text';
        el.title = (el.name || el.id || '') + ' — скрытое поле';
        el.style.setProperty('outline', '2px dashed #e9b04f', 'important');
        el.style.setProperty('outline-offset', '1px', 'important');
      }
      if (!rows.length) return 'Скрытых полей на странице нет';
      return { __kosmo: 'table', title: 'Скрытых полей: ' + rows.length + ' (подсвечены на странице)', columns: ['Имя', 'Значение', 'Форма'], rows };
    },
  },
  {
    id: 'lib-img-alt', name: 'Картинки без alt — подсветить', world: 'isolated',
    desc: 'Красная рамка — нет alt, жёлтая — пустой alt',
    fn: async function () {
      // Подсвечивает картинки без alt (красным) и с пустым alt (жёлтым; подходит только для декоративных).
      // Повторный запуск снимает подсветку.
      const marked = document.querySelectorAll('img[data-kosmo-alt]');
      if (marked.length) {
        for (const img of marked) {
          img.style.removeProperty('outline');
          img.style.removeProperty('outline-offset');
          img.removeAttribute('data-kosmo-alt');
        }
        return 'Подсветка снята';
      }
      const rows = [];
      let total = 0;
      for (const img of document.querySelectorAll('img')) {
        total++;
        const alt = img.getAttribute('alt');
        if (alt !== null && alt.trim()) continue;
        const empty = alt !== null;
        img.setAttribute('data-kosmo-alt', empty ? 'empty' : 'none');
        img.style.setProperty('outline', '3px solid ' + (empty ? '#e9b04f' : '#ef6b6b'), 'important');
        img.style.setProperty('outline-offset', '-3px', 'important');
        rows.push([img.currentSrc || img.src || '(нет src)', empty ? 'пустой alt' : 'нет alt', img.naturalWidth ? img.naturalWidth + '×' + img.naturalHeight : '—']);
      }
      if (!total) return 'На странице нет картинок <img>';
      if (!rows.length) return 'У всех картинок есть alt (' + total + ')';
      const none = rows.filter((r) => r[1] === 'нет alt').length;
      return { __kosmo: 'table', title: 'Без alt: ' + none + ', с пустым alt: ' + (rows.length - none) + ' из ' + total, columns: ['Картинка', 'Проблема', 'Размер'], rows };
    },
  },
  {
    id: 'lib-images', name: 'Все картинки (URL)', world: 'isolated',
    desc: 'img, srcset, picture, фоновые картинки CSS и og:image',
    fn: async function () {
      // Все картинки страницы: <img> (и самый крупный вариант из srcset), <picture>, фоновые картинки CSS, og:image.
      const map = new Map();
      const abs = (u) => { try { return new URL(u, location.href).href; } catch (e) { return u; } };
      const add = (raw, kind, size) => {
        if (!raw) return;
        const url = abs(String(raw).trim());
        const shown = url.startsWith('data:') ? url.slice(0, 40) + '… (' + (url.length < 1024 ? url.length + ' Б' : Math.round(url.length / 1024) + ' КБ') + ')' : url;
        const row = map.get(url);
        if (row) {
          if (!row[1].includes(kind)) row[1] += ', ' + kind;
          if (row[2] === '—' && size) row[2] = size;
        } else map.set(url, [shown, kind, size || '—']);
      };
      const largest = (srcset) => {
        let best = null, w = -1;
        for (const part of String(srcset || '').split(/,\s+/)) {
          const [u, d] = part.trim().split(/\s+/);
          const n = parseFloat(d) || 1;
          if (u && n > w) { w = n; best = u; }
        }
        return best;
      };
      for (const img of document.images) {
        add(img.currentSrc || img.src, 'img', img.naturalWidth ? img.naturalWidth + '×' + img.naturalHeight : '');
        if (img.srcset) add(largest(img.srcset), 'srcset', '');
      }
      for (const s of document.querySelectorAll('picture source[srcset]')) add(largest(s.srcset), 'picture', '');
      const els = document.querySelectorAll('body *');
      for (let i = 0; i < els.length && i < 8000; i++) {
        const bg = getComputedStyle(els[i]).backgroundImage;
        if (!bg || bg === 'none') continue;
        for (const m of bg.matchAll(/url\(["']?([^"')]+)["']?\)/g)) add(m[1], 'фон CSS', '');
      }
      const og = document.querySelector('meta[property="og:image" i]');
      if (og) add(og.content, 'og:image', '');
      const rows = [...map.values()];
      if (!rows.length) return 'Картинок не найдено';
      return { __kosmo: 'table', title: 'Картинок: ' + rows.length, columns: ['Адрес', 'Где', 'Размер'], rows };
    },
  },
  {
    id: 'lib-meta', name: 'Мета-теги и JSON-LD', world: 'isolated',
    desc: 'meta, canonical, hreflang, иконки и разметка JSON-LD',
    fn: async function () {
      // Мета-теги, canonical, hreflang, иконки и разметка JSON-LD — деревом.
      const meta = {};
      for (const m of document.querySelectorAll('meta')) {
        const key = m.getAttribute('name') || m.getAttribute('property') || m.getAttribute('http-equiv') || m.getAttribute('itemprop') || (m.hasAttribute('charset') ? 'charset' : '');
        if (!key) continue;
        const val = m.hasAttribute('charset') ? m.getAttribute('charset') : (m.getAttribute('content') || '');
        meta[key] = key in meta ? [].concat(meta[key], val) : val;
      }
      const links = [...document.querySelectorAll('link[rel~="canonical" i], link[rel~="alternate" i], link[rel~="icon" i], link[rel~="manifest" i]')]
        .map((l) => ({ rel: l.getAttribute('rel'), href: l.href, hreflang: l.hreflang || undefined, type: l.type || undefined }));
      const jsonLd = [...document.querySelectorAll('script[type="application/ld+json" i]')].map((s, i) => {
        try { return JSON.parse(s.textContent); } catch (e) { return { 'ошибка разбора': e.message, 'блок': i + 1, 'начало': s.textContent.trim().slice(0, 300) }; }
      });
      return { title: document.title, lang: document.documentElement.lang || null, meta, links, jsonLd };
    },
  },
  {
    id: 'lib-no-anim', name: 'Выключить анимации', world: 'isolated',
    desc: 'CSS-анимации, переходы и плавная прокрутка — выкл/вкл',
    fn: async function () {
      // Выключает CSS-анимации, переходы и плавную прокрутку. Повторный запуск включает обратно.
      const root = document.documentElement;
      if (root.hasAttribute('data-kosmo-noanim')) {
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== window.__kosmoNoAnim);
        root.removeAttribute('data-kosmo-noanim');
        return 'Анимации снова включены';
      }
      const sheet = new CSSStyleSheet();
      sheet.replaceSync('*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; animation-iteration-count: 1 !important; transition: none !important; scroll-behavior: auto !important; }');
      window.__kosmoNoAnim = sheet;
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      root.setAttribute('data-kosmo-noanim', '');
      let stopped = 0;
      for (const a of document.getAnimations()) {
        try { a.finish(); stopped++; } catch (e) { try { a.cancel(); stopped++; } catch (e2) { /* уже остановлена */ } }
      }
      return 'Анимации выключены' + (stopped ? ' (остановлено: ' + stopped + ')' : '') + '. Повторный запуск включит их обратно.';
    },
  },
  {
    id: 'lib-design-mode', name: 'Режим редактирования страницы (designMode)', world: 'isolated',
    desc: 'Любой текст на странице можно править мышкой',
    fn: async function () {
      // Режим редактирования: любой текст на странице правится прямо на месте. Повторный запуск выключает.
      const on = document.designMode !== 'on';
      document.designMode = on ? 'on' : 'off';
      return on ? 'Режим редактирования включён — щёлкните по тексту и правьте. Запустите ещё раз, чтобы выключить.' : 'Режим редактирования выключен';
    },
  },
  {
    id: 'lib-localstorage', name: 'localStorage в JSON', world: 'isolated',
    desc: 'Всё содержимое localStorage сайта деревом',
    fn: async function () {
      // Содержимое localStorage этого сайта; значения в формате JSON разобраны.
      const out = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        const v = localStorage.getItem(k);
        try { out[k] = JSON.parse(v); } catch (e) { out[k] = v; }
      }
      if (!Object.keys(out).length) return 'localStorage пуст';
      return out;
    },
  },
  {
    id: 'lib-cookies', name: 'Cookies страницы (document.cookie)', world: 'isolated',
    desc: 'Cookies, видимые странице (без HttpOnly)',
    fn: async function () {
      // Cookies, доступные странице через document.cookie. HttpOnly-cookies сюда не попадают — они в панели «Хранилище».
      const raw = document.cookie;
      if (!raw) return 'document.cookie пуст. HttpOnly-cookies смотрите в панели «Хранилище».';
      const rows = raw.split(/;\s*/).map((p) => {
        const i = p.indexOf('=');
        let value = i < 0 ? '' : p.slice(i + 1);
        try { value = decodeURIComponent(value); } catch (e) { /* как есть */ }
        return [i < 0 ? p : p.slice(0, i), value];
      });
      return { __kosmo: 'table', title: 'Cookies: ' + rows.length + ' (без HttpOnly)', columns: ['Имя', 'Значение'], rows };
    },
  },
];

// Тело функции без внешних скобок и общего отступа.
function bodyOf(fn) {
  const src = fn.toString();
  const inner = src.slice(src.indexOf('{') + 1, src.lastIndexOf('}'));
  const lines = inner.replace(/^\s*\n/, '').replace(/\s+$/, '').split('\n');
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  return lines.map((l) => l.slice(indent)).join('\n') + '\n';
}

const BUILTINS = LIB.map((s) => Object.freeze({ id: s.id, name: s.name, desc: s.desc, world: s.world, code: bodyOf(s.fn), builtin: true }));

module.exports = { BUILTINS, get: (id) => BUILTINS.find((s) => s.id === id) || null };
