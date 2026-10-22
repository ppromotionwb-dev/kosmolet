'use strict';
// Эмуляция устройства и сети для вкладки (инструмент «Устройство»). Владелец: devtools.
// Всё через CDP (ctx.cdp.send): Emulation.setDeviceMetricsOverride (+scale, чтобы устройство влезло в область
// вкладки), touch, UA (+ Client Hints), сеть (Network.emulateNetworkConditionsByRule / запасной — устаревший
// emulateNetworkConditions), кэш, CPU, prefers-color-scheme и print. Устройство рисуется по центру области
// вкладки: после каждой раскладки окна (ctx.windows 'layout') вид вкладки ужимается до размера устройства,
// а chrome рисует под ним рамку и подпись (событие kosmo:devtools.stage).

const PAD = 20;          // отступ устройства от краёв области вкладки
const CAPTION_H = 26;    // место под подпись снизу

function chromeMajor() { return String(process.versions.chrome || '156').split('.')[0]; }

function androidUA(model) {
  return `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor()}.0.0.0 Mobile Safari/537.36`;
}
function androidMeta(model, version) {
  const v = chromeMajor();
  return {
    brands: [{ brand: 'Chromium', version: v }, { brand: 'Google Chrome', version: v }, { brand: 'Not?A_Brand', version: '99' }],
    fullVersionList: [{ brand: 'Chromium', version: v + '.0.0.0' }, { brand: 'Google Chrome', version: v + '.0.0.0' }, { brand: 'Not?A_Brand', version: '99.0.0.0' }],
    platform: 'Android', platformVersion: version, architecture: '', model, mobile: true, bitness: '', wow64: false,
  };
}
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

const DEVICES = [
  { id: 'iphone15', title: 'iPhone 15', w: 393, h: 852, dpr: 3, mobile: true, touch: true, ua: IOS_UA, platform: 'iPhone', icon: 'smartphone', group: 'phone' },
  { id: 'pixel8', title: 'Pixel 8', w: 412, h: 915, dpr: 2.625, mobile: true, touch: true, ua: androidUA('Pixel 8'), meta: androidMeta('Pixel 8', '14.0.0'), platform: 'Linux armv81', icon: 'smartphone', group: 'phone' },
  { id: 'galaxys24', title: 'Galaxy S24', w: 360, h: 780, dpr: 3, mobile: true, touch: true, ua: androidUA('SM-S921B'), meta: androidMeta('SM-S921B', '14.0.0'), platform: 'Linux armv81', icon: 'smartphone', group: 'phone' },
  { id: 'ipad', title: 'iPad', w: 820, h: 1180, dpr: 2, mobile: true, touch: true, ua: IPAD_UA, platform: 'iPad', icon: 'tablet', group: 'tablet' },
  { id: 'laptop', title: 'Ноутбук', w: 1366, h: 768, dpr: 1, mobile: false, touch: false, ua: null, icon: 'laptop', group: 'desktop' },
  { id: 'fullhd', title: 'Full HD', w: 1920, h: 1080, dpr: 1, mobile: false, touch: false, ua: null, icon: 'monitor', group: 'desktop' },
];

// Пропускная способность — байт/с (как в CDP), задержка — мс. Значения как в Chrome DevTools.
const NETWORKS = [
  { id: 'none', title: 'Без ограничений' },
  { id: 'fast4g', title: 'Fast 4G', latency: 165, down: 1012500, up: 168750 },
  { id: 'slow4g', title: 'Slow 4G', latency: 562.5, down: 180000, up: 84375 },
  { id: '3g', title: '3G', latency: 2000, down: 50000, up: 50000 },
  { id: 'offline', title: 'Офлайн', offline: true },
  { id: 'custom', title: 'Своя' },
];

const DEFAULT_STATE = () => ({
  device: null,                 // id пресета или 'custom'
  custom: { w: 400, h: 800, dpr: 2, mobile: true, touch: true },
  rotate: false,
  net: 'none',
  netCustom: { latency: 100, down: 2000, up: 1000 }, // кбит/с
  noCache: false,
  cpu: 1,
  scheme: '',                   // '' | 'dark' | 'light'
  print: false,
});

function createEmulation(ctx) {
  const states = new Map();   // tabId → state
  const applied = new Map();  // tabId → {ua, scale}
  let stageSent = null;

  function stateOf(tabId) { return states.get(Number(tabId)) || null; }
  function isActive(s) { return !!s && (!!s.device || s.net !== 'none' || s.noCache || s.cpu > 1 || !!s.scheme || s.print); }

  function deviceOf(s) {
    if (!s || !s.device) return null;
    if (s.device === 'custom') {
      const c = s.custom;
      return {
        id: 'custom', title: 'Свой размер', w: clampInt(c.w, 50, 4000), h: clampInt(c.h, 50, 4000), dpr: clampNum(c.dpr, 0.5, 4),
        mobile: !!c.mobile, touch: !!c.touch, ua: c.mobile ? androidUA('K') : null, meta: c.mobile ? androidMeta('K', '14.0.0') : null,
        platform: c.mobile ? 'Linux armv81' : null,
      };
    }
    return DEVICES.find((d) => d.id === s.device) || null;
  }
  function clampInt(v, a, b) { v = Math.round(Number(v) || 0); return Math.min(b, Math.max(a, v)); }
  function clampNum(v, a, b) { v = Number(v) || 1; return Math.min(b, Math.max(a, v)); }
  function dims(s) {
    const d = deviceOf(s);
    if (!d) return null;
    return s.rotate ? { w: d.h, h: d.w, d } : { w: d.w, h: d.h, d };
  }

  // Масштаб, чтобы устройство поместилось в область вкладки.
  function fit(s) {
    const dm = dims(s);
    if (!dm) return null;
    const g = ctx.windows.geometry();
    const availW = Math.max(100, g.tab.width - PAD * 2);
    const availH = Math.max(100, g.tab.height - PAD * 2 - CAPTION_H);
    const scale = Math.min(1, availW / dm.w, availH / dm.h);
    const w = Math.max(1, Math.round(dm.w * scale)), h = Math.max(1, Math.round(dm.h * scale));
    const x = g.tab.x + Math.round((g.tab.width - w) / 2);
    const y = g.tab.y + Math.max(PAD, Math.round((g.tab.height - CAPTION_H - h) / 2));
    return { scale: Math.round(scale * 1000) / 1000, rect: { x, y, width: w, height: h }, dm };
  }

  function summary(s) {
    if (!isActive(s)) return '';
    const parts = [];
    const d = deviceOf(s);
    if (d) parts.push(d.id === 'custom' ? `${dims(s).w}×${dims(s).h}` : d.title);
    if (s.net !== 'none') { const n = NETWORKS.find((x) => x.id === s.net); parts.push(n ? n.title : s.net); }
    if (s.noCache) parts.push('без кэша');
    if (s.cpu > 1) parts.push('CPU ×' + s.cpu);
    if (s.scheme) parts.push(s.scheme === 'dark' ? 'тёмная схема' : 'светлая схема');
    if (s.print) parts.push('печать');
    return parts.join(', ');
  }

  function badge(tabId) {
    const s = stateOf(tabId);
    const sum = summary(s);
    const d = s && deviceOf(s);
    // значок — по тому, что эмулируется: устройство (телефон/планшет/монитор), иначе сеть, процессор или медиа
    let icon = 'sliders';
    if (d) icon = d.group === 'tablet' ? 'tablet' : d.group === 'desktop' ? 'monitor' : 'smartphone';
    else if (s && s.net === 'offline') icon = 'wifi-off';
    else if (s && (s.net !== 'none' || s.noCache)) icon = 'gauge';
    else if (s && s.cpu > 1) icon = 'cpu';
    ctx.tabs.setBadge(tabId, 'emulation', sum ? { icon, tone: 'accent', title: 'Эмуляция: ' + sum } : null);
  }

  async function send(tabId, method, params) {
    try { return await ctx.cdp.send(tabId, method, params); } catch (e) { ctx.log('emulation', `вкладка ${tabId}: ${method}:`, e.message); throw e; }
  }

  async function applyNetwork(tabId, s) {
    let c;
    if (s.net === 'none') c = null;
    else if (s.net === 'offline') c = { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 };
    else if (s.net === 'custom') {
      const n = s.netCustom;
      c = { offline: false, latency: Math.max(0, Number(n.latency) || 0), downloadThroughput: Math.max(1, (Number(n.down) || 0) * 1000 / 8), uploadThroughput: Math.max(1, (Number(n.up) || 0) * 1000 / 8) };
    } else {
      const p = NETWORKS.find((x) => x.id === s.net);
      c = p ? { offline: false, latency: p.latency, downloadThroughput: p.down, uploadThroughput: p.up } : null;
    }
    try {
      await ctx.cdp.send(tabId, 'Network.emulateNetworkConditionsByRule', {
        matchedNetworkConditions: c ? [{ urlPattern: '', latency: c.latency, downloadThroughput: c.downloadThroughput, uploadThroughput: c.uploadThroughput, offline: !!c.offline }] : [],
      });
      await ctx.cdp.send(tabId, 'Network.overrideNetworkState', c
        ? { offline: !!c.offline, latency: c.latency, downloadThroughput: c.downloadThroughput, uploadThroughput: c.uploadThroughput }
        : { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    } catch (_) {
      await send(tabId, 'Network.emulateNetworkConditions', c || { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    }
  }

  // Применить всё состояние к вкладке. reloadOnUa — перезагрузить, если сменился User-Agent.
  async function apply(tabId, opts = {}) {
    tabId = Number(tabId);
    const s = stateOf(tabId) || DEFAULT_STATE();
    const tab = ctx.tabs.get(tabId);
    if (!tab || !tab.wc || tab.wc.isDestroyed()) { badge(tabId); return; }
    const needNet = s.net !== 'none' || s.noCache;
    ctx.cdp.requireNetwork(tabId, needNet || !!applied.get(tabId)?.net);
    await ctx.cdp.ensure(tabId);
    const prev = applied.get(tabId) || {};
    const d = deviceOf(s);
    const f = fit(s);
    if (d && f) {
      const dm = f.dm;
      await send(tabId, 'Emulation.setDeviceMetricsOverride', {
        width: dm.w, height: dm.h, deviceScaleFactor: d.dpr, mobile: !!d.mobile, scale: f.scale,
        screenWidth: dm.w, screenHeight: dm.h,
        screenOrientation: s.rotate ? { type: 'landscapePrimary', angle: 90 } : { type: 'portraitPrimary', angle: 0 },
      });
      await send(tabId, 'Emulation.setTouchEmulationEnabled', { enabled: !!d.touch, maxTouchPoints: d.touch ? 5 : 1 });
      await send(tabId, 'Emulation.setEmitTouchEventsForMouse', { enabled: !!d.touch, configuration: d.mobile ? 'mobile' : 'desktop' }).catch(() => {});
    } else if (prev.device) {
      await send(tabId, 'Emulation.clearDeviceMetricsOverride', {}).catch(() => {});
      await send(tabId, 'Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
      await send(tabId, 'Emulation.setEmitTouchEventsForMouse', { enabled: false }).catch(() => {});
    }
    const ua = d && d.ua ? d.ua : '';
    if (ua !== (prev.ua || '')) {
      const p = { userAgent: ua }; // пустая строка снимает подмену
      if (ua && d.platform) p.platform = d.platform;
      if (ua && d.meta) p.userAgentMetadata = d.meta;
      await send(tabId, 'Emulation.setUserAgentOverride', p).catch(() => {});
    }
    if (needNet || prev.net) await applyNetwork(tabId, s).catch(() => {});
    if (s.noCache || prev.noCache) await send(tabId, 'Network.setCacheDisabled', { cacheDisabled: !!s.noCache }).catch(() => {});
    if ((s.cpu || 1) !== (prev.cpu || 1)) await send(tabId, 'Emulation.setCPUThrottlingRate', { rate: Math.max(1, Number(s.cpu) || 1) }).catch(() => {});
    if (s.scheme || s.print || prev.media) {
      await send(tabId, 'Emulation.setEmulatedMedia', { media: s.print ? 'print' : '', features: [{ name: 'prefers-color-scheme', value: s.scheme || '' }] }).catch(() => {});
    }
    applied.set(tabId, { device: !!d, mobile: !!(d && d.mobile), ua, net: needNet, noCache: s.noCache, cpu: s.cpu || 1, media: !!(s.scheme || s.print), scale: f ? f.scale : null });
    badge(tabId);
    if (tabId === ctx.tabs.activeId) ctx.windows.layout();
    const url = tab.wc.getURL();
    if (opts.reloadOnUa !== false && ua !== (prev.ua || '') && /^https?:/i.test(url)) tab.wc.reload();
  }

  function get(tabId) {
    const s = stateOf(tabId) || DEFAULT_STATE();
    const f = fit(s);
    return Object.assign({}, s, { tabId: Number(tabId), active: isActive(s), summary: summary(s), scale: f ? f.scale : null, size: f ? { w: f.dm.w, h: f.dm.h } : null });
  }

  function patchState(tabId, patch) {
    tabId = Number(tabId);
    const s = stateOf(tabId) || DEFAULT_STATE();
    const p = patch || {};
    if ('device' in p) s.device = p.device === null || p.device === '' ? null : String(p.device);
    if (p.custom && typeof p.custom === 'object') Object.assign(s.custom, p.custom);
    if ('rotate' in p) s.rotate = !!p.rotate;
    if ('net' in p && NETWORKS.some((n) => n.id === p.net)) s.net = p.net;
    if (p.netCustom && typeof p.netCustom === 'object') Object.assign(s.netCustom, p.netCustom);
    if ('noCache' in p) s.noCache = !!p.noCache;
    if ('cpu' in p) s.cpu = [1, 2, 4, 6, 20].includes(Number(p.cpu)) ? Number(p.cpu) : 1;
    if ('scheme' in p) s.scheme = p.scheme === 'dark' || p.scheme === 'light' ? p.scheme : '';
    if ('print' in p) s.print = !!p.print;
    if (s.device && s.device !== 'custom' && !DEVICES.some((d) => d.id === s.device)) s.device = null;
    states.set(tabId, s);
    return s;
  }

  function notify(tabId) { try { ctx.panel.send('kosmo:devtools.emu', get(tabId)); } catch (_) { /* панели нет */ } }

  async function set(tabId, patch) {
    patchState(tabId, patch);
    try { await apply(tabId); } finally { notify(tabId); }
    return get(tabId);
  }

  async function reset(tabId) {
    tabId = Number(tabId);
    states.set(tabId, DEFAULT_STATE());
    await apply(tabId);
    states.delete(tabId);
    applied.delete(tabId);
    ctx.cdp.requireNetwork(tabId, false);
    badge(tabId);
    notify(tabId);
    return get(tabId);
  }

  // ---------- раскладка: устройство по центру области вкладки ----------
  let refitTimer = null;
  function onLayout() {
    const tab = ctx.tabs.active();
    const s = tab && stateOf(tab.id);
    const f = s && s.device ? fit(s) : null;
    if (f && tab.view) {
      tab.view.setBounds(f.rect);
      const a = applied.get(tab.id);
      if (a && a.scale !== f.scale) {
        clearTimeout(refitTimer);
        refitTimer = setTimeout(() => apply(tab.id, { reloadOnUa: false }).catch(() => {}), 120);
      }
    }
    sendStage(f && tab ? { tabId: tab.id, rect: f.rect, title: deviceOf(s).id === 'custom' ? 'Свой размер' : deviceOf(s).title, w: f.dm.w, h: f.dm.h, scale: f.scale, rotate: s.rotate } : null);
  }
  function sendStage(st) {
    const key = JSON.stringify(st);
    if (key === stageSent) return;
    stageSent = key;
    const win = ctx.windows.main;
    if (win && !win.isDestroyed()) win.webContents.send('kosmo:devtools.stage', st);
  }

  ctx.windows.on('layout', onLayout);
  ctx.tabs.on('activated', () => setImmediate(onLayout));
  // переподключение отладчика (сбой, новый вид после выгрузки) — эмуляция применяется заново
  ctx.cdp.on('attached', (tabId) => {
    if (!isActive(stateOf(tabId))) return;
    applied.delete(Number(tabId));
    apply(tabId, { reloadOnUa: false }).catch(() => {});
  });
  // Новый вид вкладки (после выгрузки или сбоя). При выключенной записи сети отладчик сам не подключится и
  // эмуляция тихо пропала бы — подключаем (дальше её применит обработчик 'attached'). User-Agent отправляем
  // сразу, синхронно: core вызывает loadURL сразу после события, и первый запрос должен уйти уже с ним.
  ctx.tabs.on('view-created', (tab, wc) => {
    const s = stateOf(tab.id);
    if (!isActive(s)) return;
    applied.delete(tab.id);
    ctx.cdp.requireNetwork(tab.id, s.net !== 'none' || s.noCache);
    ctx.cdp.ensure(tab.id).catch((e) => ctx.log('emulation', `вкладка ${tab.id}: подключение для эмуляции:`, e.message));
    const d = deviceOf(s);
    try {
      if (d && d.ua && wc.debugger.isAttached()) {
        const p = { userAgent: d.ua };
        if (d.platform) p.platform = d.platform;
        if (d.meta) p.userAgentMetadata = d.meta;
        wc.debugger.sendCommand('Emulation.setUserAgentOverride', p).catch(() => {});
      }
    } catch (_) { /* отладчик недоступен — UA применится вместе с остальным */ }
  });
  ctx.tabs.on('view-destroyed', (tab) => { applied.delete(tab.id); });
  ctx.tabs.on('closed', (tab) => { states.delete(tab.id); applied.delete(tab.id); });

  // Масштаб, с которым эмулируемое устройство нарисовано в виде вкладки (Emulation.setDeviceMetricsOverride scale).
  // При эмуляции устройства масштаб страницы (zoom) Chromium не применяет (innerWidth = ширина устройства при
  // любом zoom), поэтому координаты вида (DIP: sendInputEvent, context-menu) = CSS px × этот масштаб.
  // Без эмуляции устройства — null (тогда действует обычный zoom вкладки).
  function inputScale(tabId) {
    const a = applied.get(Number(tabId));
    return a && a.device && a.scale > 0 ? a.scale : null;
  }
  // DIP вида вкладки на 1 CSS px страницы (без учёта pinch-zoom страницы). Без эмуляции — zoom вкладки.
  // Мобильная эмуляция: Chromium сам сбрасывает zoom страницы в 1 (как DevTools в режиме устройства) — только
  // масштаб вписывания. Настольная (Ноутбук, Full HD): zoom действует, × масштаб вписывания (проверено вживую).
  function viewFactor(tabId, zoom) {
    const z = Number(zoom) > 0 ? Number(zoom) : 1;
    const a = applied.get(Number(tabId));
    if (!a || !a.device || !(a.scale > 0)) return z;
    return a.mobile ? a.scale : a.scale * z;
  }

  return { DEVICES, NETWORKS, get, set, reset, apply, inputScale, viewFactor, isActive: (id) => isActive(stateOf(id)), summary: (id) => summary(stateOf(id)) };
}

module.exports = { createEmulation, DEVICES, NETWORKS };
