'use strict';
// ux-chrome: помощники для адресов (показ, нормализация, сравнение).

const { domainToUnicode } = require('url');

function safeDecode(s) {
  try { return decodeURI(s); } catch (_) { return s; }
}

// Разбор адреса для показа и поиска. disp — без схемы https и без «/» в конце корня.
function describe(url) {
  const r = { url, scheme: '', host: '', hostBare: '', disp: '', dispBare: '', path: '', root: false };
  let u;
  try { u = new URL(url); } catch (_) { r.disp = r.dispBare = String(url || ''); return r; }
  r.scheme = u.protocol.replace(/:$/, '');
  if (r.scheme === 'file') {
    r.path = safeDecode(u.pathname);
    r.disp = r.dispBare = 'file://' + r.path;
    return r;
  }
  let host = u.hostname;
  try { host = domainToUnicode(u.hostname) || u.hostname; } catch (_) { /* как есть */ }
  host = host.toLowerCase();
  const hostPort = host + (u.port ? ':' + u.port : '');
  let rest = safeDecode(u.pathname + u.search + u.hash);
  if (rest === '/') rest = '';
  r.host = hostPort;
  r.hostBare = hostPort.replace(/^www\./, '');
  r.path = rest;
  r.root = !rest;
  r.disp = hostPort + rest;
  r.dispBare = r.hostBare + rest;
  return r;
}

// Строка для показа пользователю: https и «/» корня скрыты, остальные схемы видны.
function shown(url) {
  const d = describe(url);
  if (!d.scheme) return String(url || '');
  if (d.scheme === 'https') return d.disp;
  if (d.scheme === 'http') return 'http://' + d.disp;
  return safeDecode(String(url));
}

// Ключ сравнения адресов (закладки, дубли подсказок): без #, без «/» в конце, хост в нижнем регистре.
function urlKey(url) {
  let s = String(url || '').trim();
  try {
    const u = new URL(s);
    u.hash = '';
    s = u.href;
  } catch (_) { s = s.replace(/#.*$/, ''); }
  return s.replace(/\/+$/, '');
}

function stripHash(url) { return String(url || '').replace(/#.*$/, ''); }

function isWebUrl(url) { return /^(https?|file):/i.test(String(url || '')); }

function originOf(url) { try { return new URL(url).origin; } catch (_) { return ''; } }

function now() { return Date.now(); }

module.exports = { describe, shown, urlKey, stripHash, isWebUrl, originOf, safeDecode, now };
