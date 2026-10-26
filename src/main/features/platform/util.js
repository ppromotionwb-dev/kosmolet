'use strict';
// Общие помощники фичи platform: хосты, белые списки, origin'ы.

// Хост http(s)-адреса в нижнем регистре; '' — не http(s) или не разобрался.
function hostOf(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.hostname.toLowerCase().replace(/\.$/, '');
  } catch (_) { return ''; }
}

// Запись белого списка: «https://shop.example.com/x» → «shop.example.com», «*.site.ru» → «site.ru».
function normHostEntry(s) {
  let v = String(s == null ? '' : s).trim().toLowerCase();
  if (!v) return '';
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  v = v.replace(/[/?#].*$/, '');
  v = v.replace(/^[^@]*@/, '');
  if (v.startsWith('[')) { const i = v.indexOf(']'); v = i > 0 ? v.slice(0, i + 1) : v; } else v = v.replace(/:\d+$/, '');
  v = v.replace(/^\*\./, '').replace(/^www\./, '').replace(/\.$/, '');
  if (!/^[a-z0-9.\-_[\]:Ѐ-ӿ]+$/i.test(v)) return '';
  return v;
}

const LOCAL_ALIASES = ['localhost', '127.0.0.1', '[::1]', '::1'];

function isLocalHost(host) {
  return host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || host === '[::1]' || host === '::1';
}

// host совпадает с записью или её поддомен; запись «localhost» покрывает и 127.0.0.1 / [::1].
function matchHost(host, entry) {
  if (!host || !entry) return false;
  if (host === entry || host.endsWith('.' + entry)) return true;
  if (entry === 'localhost' && isLocalHost(host)) return true;
  // домен в Unicode и punycode — сравниваем как есть, URL сам приводит к punycode
  return false;
}

function matchList(host, list) {
  if (!host || !Array.isArray(list)) return '';
  for (const e of list) if (matchHost(host, e)) return e;
  return '';
}

// Ключ origin'а для решений по разрешениям: «https://site.ru», для file:// — «file://».
function originKey(origin, fallbackUrl) {
  let o = typeof origin === 'string' ? origin : '';
  if (!o || o === 'null') {
    try {
      const u = new URL(fallbackUrl || '');
      if (u.protocol === 'file:') return 'file://';
      o = u.origin;
    } catch (_) { return ''; }
  }
  if (o === 'null') return '';
  return o.replace(/\/$/, '');
}

function hostOfOrigin(origin) {
  if (!origin) return '';
  if (origin === 'file://') return 'локальный файл';
  try { return new URL(origin).host; } catch (_) { return origin; }
}

function clampStr(v, n) { return String(v == null ? '' : v).slice(0, n || 2048); }

function errText(e) { return String((e && e.message) || e || 'ошибка'); }

module.exports = { hostOf, normHostEntry, matchHost, matchList, isLocalHost, originKey, hostOfOrigin, clampStr, errText, LOCAL_ALIASES };
