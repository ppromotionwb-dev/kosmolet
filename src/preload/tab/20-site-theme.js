'use strict';
// Владелец: themes. Тёмная тема сайта и свой CSS сайта — в каждом кадре http(s)-страниц.
// Конфигурация — синхронно у main при старте документа (null — темы нет, почти всегда так), дальше живые
// обновления kosmo-tab:site-theme.update без перезагрузки. Движки: dynamic — Dark Reader (грузится лениво
// частью 19-darkreader-lib), filter — CSS-фильтр invert + hue-rotate с обратной инверсией медиа.
// Стоимость на странице без темы: один sendSync и подписка (замер — ctx.themes.measure(true)).
const t0 = performance.now();
const proto = KOSMO.protocol;
if (proto !== 'http:' && proto !== 'https:') return;

const ipc = KOSMO.ipcRenderer;
const wf = KOSMO.webFrame;
const isTop = KOSMO.isTop;

let cfg = null;
try { cfg = ipc.sendSync('kosmo-tab:site-theme.get', { top: isTop }); } catch (e) { cfg = null; }
if (cfg && cfg.error) cfg = null;

const st = {
  key: 'null', css: '', cssKey: null, fcss: '', fcssKey: null, flashKey: null, flashBg: '', holdKey: null,
  drOn: false, drKey: '', waiting: null, pending: false, gen: 0, lastC: null, drMeasured: false
};

function insert(css) { try { return wf.insertCSS(css); } catch (e) { return null; } }
function removeCss(k) { if (k) { try { wf.removeInsertedCSS(k); } catch (e) { /* документ ушёл */ } } }

// Против белой вспышки: фон документа до того, как Dark Reader обработает стили.
function flash(bg) {
  if (st.flashKey && st.flashBg === bg) return;
  removeCss(st.flashKey);
  st.flashBg = bg;
  st.flashKey = insert('html{background-color:' + bg + '!important;color-scheme:dark!important}');
}
function unflash() { removeCss(st.flashKey); st.flashKey = null; st.flashBg = ''; }

function filterCss(c) {
  const t = c.theme || {};
  const f = [
    'invert(100%) hue-rotate(180deg)',
    t.brightness !== 100 ? 'brightness(' + t.brightness + '%)' : '',
    t.contrast !== 100 ? 'contrast(' + t.contrast + '%)' : '',
    t.sepia ? 'sepia(' + t.sepia + '%)' : '',
    t.grayscale ? 'grayscale(' + t.grayscale + '%)' : ''
  ].filter(Boolean).join(' ');
  const back = 'invert(100%) hue-rotate(180deg)';
  return '@media screen{' +
    'html{filter:' + f + '!important;background-color:#fff!important}' +
    'img,video,picture,canvas,embed,object,svg image,iframe[src*="youtube"],iframe[src*="vimeo"],' +
    '[style*="background-image:url"],[style*="background-image: url"],[style*="background:url"],[style*="background: url"]' +
    '{filter:' + back + '!important}' +
    'picture img,picture video{filter:none!important}' +
    'html:has(:fullscreen){filter:none!important}' +
    ':fullscreen,:fullscreen *{filter:none!important}' +
    '}';
}

// Включение на уже загруженной странице: Dark Reader пересчитывает все стили (на тяжёлых сайтах — секунды
// работы потока страницы), и всё это время страница была бы светлой. Поэтому сначала — плоский тёмный
// запасной стиль (у Dark Reader такой есть только для загрузки документа), кадр с ним успевает отрисоваться,
// потом пересчёт, и стиль снимается, когда поток страницы освободится.
function holdDark(c) {
  releaseHold();
  const bg = c.bg || '#181a1b', tx = c.text || '#e8e6e3';
  st.holdKey = insert('html,body,body :not(iframe):not(img):not(video):not(canvas):not(picture):not(svg):not(svg *)' +
    '{background-color:' + bg + '!important;border-color:color-mix(in srgb,' + tx + ' 18%,transparent)!important;color:' + tx + '!important}');
}
function releaseHoldWhenIdle() {
  const my = st.holdKey;
  if (!my) return;
  const done = () => { if (st.holdKey === my) releaseHold(); };
  // два «простоя» подряд: синхронная часть пересчёта и догрузка внешних CSS (они у main в кэше)
  const idle = (fn, t) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: t }) : setTimeout(fn, 200));
  setTimeout(() => idle(() => setTimeout(() => idle(done, 2500), 120), 4000), 60);
}
function releaseHold() { removeCss(st.holdKey); st.holdKey = null; }
// после ближайшего кадра (или через 100 мс, если вкладка скрыта и кадров нет)
function afterPaint(fn) {
  let ran = false;
  const go = () => { if (ran) return; ran = true; fn(); };
  requestAnimationFrame(() => setTimeout(go, 0));
  setTimeout(go, 100);
}

function fixesOf(c) {
  const f = c.fixes || {};
  return {
    invert: Array.isArray(f.invert) ? f.invert : [],
    css: typeof f.css === 'string' ? f.css : '',
    ignoreInlineStyle: Array.isArray(f.ignoreInlineStyle) ? f.ignoreInlineStyle : [],
    ignoreImageAnalysis: Array.isArray(f.ignoreImageAnalysis) ? f.ignoreImageAnalysis : []
  };
}

function enableDynamic(c) {
  const key = JSON.stringify([c.theme, c.fixes || null]);
  if (st.drOn && st.drKey === key) return;
  if (!document.documentElement) {
    // Документ ещё пуст (preload раньше парсера) — ждём <html>, фон уже тёмный.
    if (st.waiting) { st.waiting.c = c; return; }
    const w = { c, mo: null };
    st.waiting = w;
    w.mo = new MutationObserver(() => {
      if (!document.documentElement) return;
      w.mo.disconnect();
      if (st.waiting !== w) return;
      st.waiting = null;
      enableDynamic(w.c);
      if (!st.drOn) unflash();
    });
    w.mo.observe(document, { childList: true });
    return;
  }
  const tDr = performance.now();
  const dr = KOSMO.darkReader && KOSMO.darkReader();
  if (!dr) return;
  st.lastC = c;
  const run = () => {
    const cc = st.lastC;
    try {
      // fixes всегда объект: при fixes = null Dark Reader 4.9 на повторном enable не сбрасывает палитру
      // и цвета не меняются; с объектом смена яркости/контраста/цветов — мгновенная перекраска палитры.
      dr.enable(cc.theme, fixesOf(cc));
      if (cfg && cfg.m && !st.drMeasured) {
        st.drMeasured = true;
        try { KOSMO.send('kosmo-tab:site-theme.metric', { dr: performance.now() - tDr, top: isTop, dark: true }); } catch (e) { /* */ }
      }
    } catch (e) { console.warn('[kosmo] тёмная тема:', e && e.message); }
  };
  const wasOn = st.drOn;
  st.drOn = true;
  st.drKey = key;
  if (!wasOn && document.readyState !== 'loading') {
    holdDark(c);
    const gen = ++st.gen;
    st.pending = true;
    afterPaint(() => {
      if (st.gen !== gen || !st.drOn) return;
      st.pending = false;
      run();
      releaseHoldWhenIdle();
    });
  } else if (!st.pending) {
    run();
  } // иначе отложенное включение ещё впереди — возьмёт свежие параметры из st.lastC
}

function disableDynamic() {
  if (st.waiting) { try { st.waiting.mo.disconnect(); } catch (e) { /* */ } st.waiting = null; }
  releaseHold();
  st.gen++;
  st.pending = false;
  if (!st.drOn) return;
  st.drOn = false;
  st.drKey = '';
  try { KOSMO.darkReader().disable(); } catch (e) { /* */ }
}

function apply(c) {
  if (c && (c.off || c.error)) c = null;
  const key = JSON.stringify(c ? { css: c.css || '', dark: c.dark ? [c.engine, c.theme, c.fixes || null] : 0 } : null);
  if (key === st.key) return;
  st.key = key;

  // свой CSS сайта — только в верхнем кадре, независимо от тёмной темы
  const css = isTop && c && c.css ? String(c.css) : '';
  if (css !== st.css) {
    removeCss(st.cssKey);
    st.css = css;
    st.cssKey = css ? insert(css) : null;
  }

  const dark = !!(c && c.dark);
  const engine = dark ? c.engine : '';

  // filter: инвертируется верхний кадр, вложенные кадры инвертируются вместе с ним
  const fcss = dark && engine === 'filter' && isTop ? filterCss(c) : '';
  if (fcss !== st.fcss) {
    removeCss(st.fcssKey);
    st.fcss = fcss;
    st.fcssKey = fcss ? insert(fcss) : null;
  }

  if (dark && engine === 'dynamic') {
    if (!st.drOn) flash(c.bg || '#181a1b');
    enableDynamic(c);
    if (!st.drOn && !st.waiting) unflash(); // Dark Reader не загрузился — не оставляем тёмный фон под светлой страницей
    else if (document.readyState === 'loading') {
      // фон «против вспышки» снимаем, когда Dark Reader уже обработал стили (у него свой запасной стиль)
      document.addEventListener('DOMContentLoaded', () => setTimeout(() => { if (st.drOn) unflash(); }, 300), { once: true });
    } else if (st.drOn) setTimeout(() => { if (st.drOn) unflash(); }, 300);
  } else {
    disableDynamic();
    unflash();
  }
}

apply(cfg);
ipc.on('kosmo-tab:site-theme.update', (_e, c) => { try { apply(c); } catch (e) { console.warn('[kosmo] тема сайта:', e && e.message); } });

if (cfg && cfg.m) {
  const ms = performance.now() - t0;
  try { KOSMO.send('kosmo-tab:site-theme.metric', { ms, top: isTop, dark: !!cfg.dark, de: !!document.documentElement }); } catch (e) { /* */ }
}
