'use strict';
// Инструмент «Хранилище»: cookies сайта в сессии его контейнера, localStorage/sessionStorage страницы,
// очистка данных сайта. Владелец: devtools.

const fs = require('fs');
const WORLD = 1718; // изолированный мир для Web Storage (тот же origin, сайт наш код не видит)
const VALUE_LIMIT = 1024 * 1024;

// Многосоставные публичные суффиксы, которые встречаются чаще всего (без полного PSL).
const MULTI_SUFFIX = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.ru', 'net.ru', 'org.ru', 'pp.ru', 'msk.ru', 'spb.ru', 'com.ua', 'org.ua', 'in.ua',
  'co.jp', 'ne.jp', 'or.jp', 'com.au', 'net.au', 'org.au', 'com.br', 'com.cn', 'com.tr', 'co.kr', 'co.in', 'co.il', 'com.kz',
  'github.io', 'gitlab.io', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'herokuapp.com', 'appspot.com', 'web.app',
  'firebaseapp.com', 'blogspot.com', 'azurewebsites.net', 'cloudfront.net',
]);

function siteOf(host) {
  host = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!host || /^[\d.]+$/.test(host) || host.includes(':') || !host.includes('.')) return host;
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const last2 = parts.slice(-2).join('.');
  if (MULTI_SUFFIX.has(last2)) return parts.slice(-3).join('.');
  return last2;
}

function createStorage(ctx) {
  const { dialog } = ctx.electron;

  function tabCtx(tabId) {
    const tab = tabId != null ? ctx.tabs.get(tabId) : ctx.tabs.active();
    if (!tab) throw new Error('вкладка не найдена');
    const url = tab.wc && !tab.wc.isDestroyed() ? tab.wc.getURL() : tab.info.url;
    let u = null;
    try { u = new URL(url); } catch (_) { u = null; }
    const ses = ctx.sessions.get(tab.info.containerId);
    return { tab, url, u, ses, web: !!u && /^https?:$/.test(u.protocol) };
  }

  function cookieUrl(c) {
    const host = String(c.domain || '').replace(/^\./, '');
    return (c.secure ? 'https://' : 'http://') + host + (c.path || '/');
  }

  // применяется ли cookie к адресу страницы
  function appliesTo(c, u) {
    if (!u) return false;
    const host = u.hostname.toLowerCase();
    const d = String(c.domain || '').toLowerCase();
    const okHost = c.hostOnly ? host === d.replace(/^\./, '') : (host === d.replace(/^\./, '') || host.endsWith(d.startsWith('.') ? d : '.' + d));
    if (!okHost) return false;
    const p = c.path || '/';
    const path = u.pathname || '/';
    const okPath = path === p || path.startsWith(p.endsWith('/') ? p : p + '/');
    if (!okPath) return false;
    if (c.secure && u.protocol !== 'https:') return false;
    return true;
  }

  // cookies.get({domain}) в Electron не находит поддомены (.www.site.ru) — фильтруем сами
  async function siteCookies(ses, site) {
    const all = await ses.cookies.get({});
    // точку снимаем только ведущую: у cookie без Domain (hostOnly) домен без точки — «example.com», «127.0.0.1»
    return all.filter((c) => { const d = String(c.domain || '').toLowerCase().replace(/^\./, ''); return d === site || d.endsWith('.' + site); });
  }

  function norm(c, u) {
    return {
      name: c.name, value: c.value, domain: c.domain, path: c.path || '/', hostOnly: !!c.hostOnly,
      secure: !!c.secure, httpOnly: !!c.httpOnly, session: !!c.session, expirationDate: c.expirationDate || null,
      sameSite: c.sameSite || 'unspecified', sent: appliesTo(c, u),
    };
  }

  async function cookies(p = {}) {
    const t = tabCtx(p.tabId);
    if (!t.web) return { url: t.url, site: '', host: '', containerId: t.tab.info.containerId, containerName: t.tab.info.containerName, cookies: [], unsupported: true };
    const site = siteOf(t.u.hostname);
    const list = await siteCookies(t.ses, site);
    const out = list.map((c) => norm(c, t.u)).sort((a, b) => (b.sent - a.sent) || a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name));
    return { url: t.url, site, host: t.u.hostname, containerId: t.tab.info.containerId, containerName: t.tab.info.containerName, cookies: out };
  }

  async function setCookie(p = {}) {
    const t = tabCtx(p.tabId);
    if (!t.web) throw new Error('cookies есть только у http(s)-страниц');
    const c = p.cookie || {};
    const name = String(c.name == null ? '' : c.name);
    if (!name) throw new Error('нужно имя cookie');
    if (/[;\s=]/.test(name)) throw new Error('имя cookie не может содержать пробелы, «;» и «=»');
    if (/[;\r\n]/.test(String(c.value || ''))) throw new Error('значение не может содержать «;» и перевод строки');
    let domain = String(c.domain || t.u.hostname).trim().toLowerCase();
    const hostOnly = c.hostOnly != null ? !!c.hostOnly : !domain.startsWith('.');
    const path = String(c.path || '/');
    const details = {
      url: cookieUrl({ domain, path, secure: !!c.secure }),
      name, value: String(c.value == null ? '' : c.value), path,
      secure: !!c.secure, httpOnly: !!c.httpOnly,
      sameSite: ['unspecified', 'no_restriction', 'lax', 'strict'].includes(c.sameSite) ? c.sameSite : 'lax',
    };
    if (!hostOnly) details.domain = domain;
    if (c.expirationDate && !c.session) details.expirationDate = Number(c.expirationDate);
    // SameSite=None без Secure браузер не примет
    if (details.sameSite === 'no_restriction' && !details.secure) { details.secure = true; details.url = cookieUrl({ domain, path, secure: true }); }
    // правка: старую (с другим именем/доменом/путём) — удалить
    const o = p.original;
    if (o && (o.name !== details.name || o.domain !== (hostOnly ? domain.replace(/^\./, '') : domain) || (o.path || '/') !== path)) {
      await t.ses.cookies.remove(cookieUrl(o), o.name).catch(() => {});
    }
    await t.ses.cookies.set(details);
    await t.ses.cookies.flushStore().catch(() => {});
    return true;
  }

  async function removeCookie(p = {}) {
    const t = tabCtx(p.tabId);
    const c = p.cookie || {};
    await t.ses.cookies.remove(cookieUrl(c), String(c.name));
    return true;
  }

  async function clearCookies(p = {}) {
    const t = tabCtx(p.tabId);
    if (!t.web) return 0;
    const site = siteOf(t.u.hostname);
    const list = await siteCookies(t.ses, site);
    for (const c of list) await t.ses.cookies.remove(cookieUrl(c), c.name).catch(() => {});
    await t.ses.cookies.flushStore().catch(() => {});
    return list.length;
  }

  // «Cookie: …» — ровно то, что уйдёт на адрес страницы
  async function cookieHeader(p = {}) {
    const t = tabCtx(p.tabId);
    if (!t.web) return '';
    const list = await t.ses.cookies.get({ url: t.url });
    return list.map((c) => c.name + '=' + c.value).join('; ');
  }

  async function exportCookies(p = {}) {
    const data = await cookies(p);
    const json = JSON.stringify(data.cookies.map((c) => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path, hostOnly: c.hostOnly, secure: c.secure, httpOnly: c.httpOnly,
      session: c.session, expirationDate: c.expirationDate || undefined, sameSite: c.sameSite,
    })), null, 2);
    let file = ctx.flags.dev && p.filePath ? String(p.filePath) : null;
    if (!file) {
      const r = await dialog.showSaveDialog(ctx.windows.main, {
        title: 'Сохранить cookies', defaultPath: `cookies-${data.site || 'site'}-${new Date().toISOString().slice(0, 10)}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (r.canceled || !r.filePath) return { canceled: true };
      file = r.filePath;
    }
    await fs.promises.writeFile(file, json, 'utf8');
    return { path: file, count: data.cookies.length };
  }

  async function importCookies(p = {}) {
    const t = tabCtx(p.tabId);
    if (!t.web) throw new Error('cookies есть только у http(s)-страниц');
    let file = ctx.flags.dev && p.filePath ? String(p.filePath) : null;
    if (!file) {
      const r = await dialog.showOpenDialog(ctx.windows.main, { title: 'Загрузить cookies', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (r.canceled || !r.filePaths || !r.filePaths[0]) return { canceled: true };
      file = r.filePaths[0];
    }
    const st = await fs.promises.stat(file);
    if (st.size > 5 * 1024 * 1024) throw new Error('файл больше 5 МБ');
    let arr;
    try { arr = JSON.parse(await fs.promises.readFile(file, 'utf8')); } catch (e) { throw new Error('не JSON: ' + e.message); }
    if (arr && Array.isArray(arr.cookies)) arr = arr.cookies;
    if (!Array.isArray(arr)) throw new Error('ожидается массив cookies');
    let ok = 0, fail = 0;
    for (const c of arr) {
      if (!c || typeof c !== 'object' || !c.name) { fail++; continue; }
      const sameSite = { no_restriction: 'no_restriction', none: 'no_restriction', lax: 'lax', strict: 'strict', unspecified: 'unspecified' }[String(c.sameSite || 'unspecified').toLowerCase()] || 'unspecified';
      const domain = String(c.domain || t.u.hostname);
      try {
        const details = { url: cookieUrl({ domain, path: c.path || '/', secure: !!c.secure || sameSite === 'no_restriction' }), name: String(c.name), value: String(c.value == null ? '' : c.value), path: c.path || '/', secure: !!c.secure || sameSite === 'no_restriction', httpOnly: !!c.httpOnly, sameSite };
        if (!c.hostOnly && domain.startsWith('.')) details.domain = domain;
        if (c.expirationDate && !c.session) details.expirationDate = Number(c.expirationDate);
        await t.ses.cookies.set(details);
        ok++;
      } catch (_) { fail++; }
    }
    await t.ses.cookies.flushStore().catch(() => {});
    return { ok, fail, path: file };
  }

  // ---------- Web Storage ----------
  function kindName(k) { return k === 'session' ? 'sessionStorage' : 'localStorage'; }
  async function inPage(p, code) {
    const t = tabCtx(p.tabId);
    if (!t.tab.wc || t.tab.wc.isDestroyed()) throw new Error('вкладка выгружена — откройте её');
    if (!t.web && !(t.u && t.u.protocol === 'file:')) return { unsupported: true, origin: '', items: [] };
    // Через CDP: executeJavaScriptInIsolatedWorld ждёт конца загрузки страницы (на WB — десятки секунд).
    if (ctx.cdp && typeof ctx.cdp.evalInWorld === 'function') {
      try { return await ctx.cdp.evalInWorld(t.tab.id, code, { world: 'kosmolet-storage', timeoutMs: 15000 }); } catch (e) {
        if (!/отладчик|debugger|attach|выгружена|не найдена/i.test(String(e && e.message))) throw e;
      }
    }
    if (t.tab.wc.isLoadingMainFrame()) throw new Error('страница ещё загружается — откройте инструмент, когда она загрузится');
    return t.tab.wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code }], false);
  }

  async function webList(p = {}) {
    const name = kindName(p.kind);
    const r = await inPage(p, `(() => { try { const s = window.${name}; const out = []; for (let i = 0; i < s.length; i++) { const k = s.key(i); const v = s.getItem(k) || ''; out.push([k, v.length > ${VALUE_LIMIT} ? v.slice(0, ${VALUE_LIMIT}) : v, v.length]); } return { origin: location.origin, items: out }; } catch (e) { return { origin: location.origin, items: [], error: String(e && e.message || e) }; } })()`);
    return r;
  }
  async function webSet(p = {}) {
    const name = kindName(p.kind);
    const key = String(p.key == null ? '' : p.key);
    const value = String(p.value == null ? '' : p.value);
    const old = p.oldKey != null ? String(p.oldKey) : null;
    return inPage(p, `(() => { const s = window.${name}; ${old != null ? `if (${JSON.stringify(old)} !== ${JSON.stringify(key)}) s.removeItem(${JSON.stringify(old)});` : ''} s.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)}); return true; })()`);
  }
  async function webRemove(p = {}) {
    const name = kindName(p.kind);
    return inPage(p, `(() => { window.${name}.removeItem(${JSON.stringify(String(p.key))}); return true; })()`);
  }
  async function webClear(p = {}) {
    const name = kindName(p.kind);
    return inPage(p, `(() => { window.${name}.clear(); return true; })()`);
  }

  async function clearSite(p = {}) {
    const t = tabCtx(p.tabId);
    if (!t.web) throw new Error('нечего очищать: это не сайт');
    const origin = t.u.origin;
    await t.ses.clearStorageData({ origin });
    const n = await clearCookies(p).catch(() => 0);
    return { origin, cookies: n };
  }

  function register() {
    const H = (ch, fn) => ctx.ipc.handle('kosmo:storage.' + ch, (p) => fn(p || {}));
    H('cookies', cookies);
    H('setCookie', setCookie);
    H('removeCookie', removeCookie);
    H('clearCookies', clearCookies);
    H('cookieHeader', cookieHeader);
    H('exportCookies', exportCookies);
    H('importCookies', importCookies);
    H('web', webList);
    H('webSet', webSet);
    H('webRemove', webRemove);
    H('webClear', webClear);
    H('clearSite', clearSite);
  }

  return { register, cookies, setCookie, removeCookie, clearCookies, cookieHeader, webList, webSet, webRemove, webClear, clearSite, siteOf };
}

module.exports = { createStorage, siteOf };
