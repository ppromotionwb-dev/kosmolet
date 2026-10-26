'use strict';
// Права пака человеческим языком (лист установки) и лист разницы при обновлении (решение консилиума, 3 и 4.8).
// Пак даёт данные — фразы и разницу строит ядро; рисует их overlay ядра.

const RISK_RANK = { read: 0, write: 1, money: 2, irreversible: 3 };

function list(arr, n = 6) {
  const a = Array.from(new Set(arr || []));
  if (!a.length) return '';
  return a.length > n ? a.slice(0, n).join(', ') + ` и ещё ${a.length - n}` : a.join(', ');
}

function opsBy(pack, pred) { return (pack.operations || []).filter(pred); }
const isWrite = (o) => RISK_RANK[o.risk] >= 1 && !(o.riskIfClaimGranted === 'read');

// Семантическая выжимка прав — по ней строятся и фразы, и разница.
function facts(pack) {
  const p = pack || {};
  const perm = p.permissions || {};
  const sd = p.siteDefaults || {};
  return {
    hosts: (perm.hosts || []).slice(),
    caps: (perm.capabilities || []).slice(),
    readClaims: (perm.readClaims || []).slice(),
    writeOps: opsBy(p, (o) => isWrite(o) && o.risk === 'write').map((o) => o.id),
    moneyOps: opsBy(p, (o) => o.risk === 'money').map((o) => o.id),
    irreversibleOps: opsBy(p, (o) => o.risk === 'irreversible').map((o) => o.id),
    readOps: opsBy(p, (o) => !isWrite(o)).map((o) => o.id),
    opTitles: Object.fromEntries((p.operations || []).map((o) => [o.id, o.title || o.id])),
    writeHosts: Array.from(new Set(opsBy(p, isWrite).map((o) => o.host).filter(Boolean))),
    snippetHosts: Array.from(new Set((p.snippets || []).filter((s) => s.run !== 'manual').flatMap((s) => s.match.map((m) => m.replace(/\/.*$/, ''))))),
    manualHosts: Array.from(new Set((p.snippets || []).filter((s) => s.run === 'manual').flatMap((s) => s.match.map((m) => m.replace(/\/.*$/, ''))))),
    manualNames: (p.snippets || []).filter((s) => s.run === 'manual').map((s) => s.name),
    snippets: (p.snippets || []).map((s) => s.file),
    capture: (sd.capture || []).slice(),
    bangs: (sd.bangs || []).map((b) => b.key),
    bookmarks: (sd.bookmarks || []).map((b) => b.title),
    adblockAllow: (sd.adblockAllow || []).slice(),
    siteThemes: Object.keys(sd.siteThemes || {}),
    fields: p.scopeSchema ? Object.values(p.scopeSchema.properties || {}).map((f) => f.title) : [],
    scopeTitle: p.scopeSchema ? (p.scopeSchema.title || p.scopeSchema.kind) : '',
    identity: !!p.identity,
    policies: (p.policies || []).length,
    agentSummary: p.agent ? p.agent.summary || '' : '',
    agentMd: p.agent ? p.agent.claudeMd || '' : '',
    skills: p.agent ? (p.agent.skills || []).slice() : [],
    protect: !!p.protect,
    global: !!p.global,
  };
}

// Фразы для листа установки: [{id, group, text, tone}] — tone: 'warn' для записи, денег и снятия защиты.
function phrases(pack) {
  const f = facts(pack);
  const out = [];
  const add = (id, group, text, tone) => out.push({ id, group, text, tone: tone || '' });
  add('hosts', 'Сайты', f.hosts.length ? 'Работает с сайтами: ' + list(f.hosts, 8) : 'Не работает ни с одним сайтом');
  if (f.caps.includes('ops.read') || f.readOps.length) add('ops.read', 'Данные', 'Читает данные через свои операции — без утверждения, в журнал');
  if (f.writeOps.length || f.caps.includes('ops.write')) {
    add('ops.write', 'Запись', `Отправляет изменения на ${list(f.writeHosts, 4) || list(f.hosts, 4)} — только после вашего утверждения`, 'warn');
    if (f.writeOps.length) add('ops.write.list', 'Запись', 'Операции записи: ' + list(f.writeOps.map((id) => f.opTitles[id]), 5));
  }
  if (f.moneyOps.length || f.caps.includes('ops.money')) add('ops.money', 'Запись', 'Может менять цены и суммы' + (f.moneyOps.length ? ' (' + list(f.moneyOps.map((id) => f.opTitles[id]), 4) + ')' : '') + ' — кнопка утверждения с удержанием', 'warn');
  if (f.irreversibleOps.length) add('ops.irreversible', 'Запись', 'Необратимые операции: ' + list(f.irreversibleOps.map((id) => f.opTitles[id]), 4) + ' — каждый раз с удержанием', 'warn');
  if (f.readClaims.length) add('readClaims', 'Данные', 'Считает чтением POST-запросы: ' + list(f.readClaims.map((id) => f.opTitles[id] || id), 4) + ' — они пойдут без утверждения', 'warn');
  if (f.snippetHosts.length) add('snippets', 'Страницы', `Сам запускает свои скрипты на ${list(f.snippetHosts, 4)} — в отдельном мире, только в контейнерах, где пак включён`);
  if (f.manualNames.length) add('snippets.manual', 'Страницы', `Сниппеты в библиотеке: ${list(f.manualNames, 4)} — запускаются по вашей команде, только на ${list(f.manualHosts, 4)}`);
  if (f.capture.length) add('capture', 'Сеть', 'Подробно записывает запросы на ' + list(f.capture, 4) + ' — для операций и каталога API');
  if (f.bangs.length) add('bangs', 'Умолчания', 'Бэнги в адресной строке: ' + list(f.bangs, 8));
  if (f.bookmarks.length) add('bookmarks', 'Умолчания', 'Закладки на полосе: ' + list(f.bookmarks, 5));
  if (f.adblockAllow.length) add('adblockAllow', 'Умолчания', 'Не блокирует рекламу на ' + list(f.adblockAllow, 4), 'warn');
  if (f.siteThemes.length) add('siteThemes', 'Умолчания', 'Тёмная тема по умолчанию на ' + list(f.siteThemes, 4));
  if (f.fields.length) add('scope', 'Контейнеры', `Поля контейнера «${f.scopeTitle}»: ${list(f.fields, 6)}`);
  if (f.identity) add('identity', 'Контейнеры', 'Проверяет, кто вошёл в кабинет — только чтением');
  if (f.protect) add('protect', 'Контейнеры', 'Контейнеры пака защищены: агент пишет в них только через операции, секреты скрыты');
  if (f.policies) add('policies', 'Запись', `Проверки строк перед записью: ${f.policies}`);
  if (f.skills.length || f.agentMd || f.agentSummary) add('agent', 'Агент', 'Инструкции для Claude' + (f.skills.length ? ' и скиллы: ' + list(f.skills, 4) : ''));
  add('global', 'Контейнеры', f.global ? 'Включается во всех контейнерах' : 'Включается в контейнерах, которые вы выберете');
  return out;
}

// Разница прав old → next. extended — права расширились (нужен полный лист), иначе обновление «одной строкой».
function diff(oldPack, nextPack) {
  const a = facts(oldPack);
  const b = facts(nextPack);
  const items = [];
  const added = (x, y) => y.filter((v) => !x.includes(v));
  const removed = (x, y) => x.filter((v) => !y.includes(v));
  const push = (text, kind, tone) => items.push({ text, kind, tone: tone || '' });
  let extended = false;
  const ext = (cond) => { if (cond) extended = true; return cond; };

  const nh = added(a.hosts, b.hosts);
  if (ext(nh.length)) push('Новые сайты: ' + list(nh), 'new', 'warn');
  const rh = removed(a.hosts, b.hosts);
  if (rh.length) push('Больше не работает с: ' + list(rh), 'removed');
  const capName = { 'ops.read': 'чтение через операции', 'ops.write': 'запись через операции', 'ops.money': 'изменение цен и сумм', snippets: 'скрипты на страницах', capture: 'подробная запись сети' };
  const nc = added(a.caps, b.caps);
  if (ext(nc.length)) push('Новые права: ' + list(nc.map((c) => capName[c] || c)), 'new', 'warn');
  const rc = removed(a.caps, b.caps);
  if (rc.length) push('Убраны права: ' + list(rc.map((c) => capName[c] || c)), 'removed');
  const nrc = added(a.readClaims, b.readClaims);
  if (ext(nrc.length)) push('Новые POST-запросы, которые пак считает чтением: ' + list(nrc.map((id) => b.opTitles[id] || id)), 'new', 'warn');
  const nw = added(a.writeOps, b.writeOps);
  if (ext(nw.length)) push('Новые операции записи: ' + list(nw.map((id) => b.opTitles[id] || id)), 'new', 'warn');
  const nm = added(a.moneyOps, b.moneyOps);
  if (ext(nm.length)) push('Новые операции с деньгами: ' + list(nm.map((id) => b.opTitles[id] || id)), 'new', 'warn');
  const ni = added(a.irreversibleOps, b.irreversibleOps);
  if (ext(ni.length)) push('Новые необратимые операции: ' + list(ni.map((id) => b.opTitles[id] || id)), 'new', 'warn');
  const ro = removed(a.writeOps.concat(a.moneyOps, a.irreversibleOps), b.writeOps.concat(b.moneyOps, b.irreversibleOps));
  if (ro.length) push('Убраны операции записи: ' + list(ro.map((id) => a.opTitles[id] || id)), 'removed');
  const nsh = added(a.snippetHosts, b.snippetHosts);
  if (ext(nsh.length)) push('Скрипты на новых сайтах: ' + list(nsh), 'new', 'warn');
  else if (JSON.stringify(a.snippets) !== JSON.stringify(b.snippets)) push('Изменился набор скриптов страниц', 'changed');
  const ncap = added(a.capture, b.capture);
  if (ext(ncap.length)) push('Подробная запись сети на новых сайтах: ' + list(ncap), 'new');
  const nab = added(a.adblockAllow, b.adblockAllow);
  if (ext(nab.length)) push('Новые исключения блокировщика: ' + list(nab), 'new', 'warn');
  const nb = added(a.bangs, b.bangs);
  if (nb.length) push('Новые бэнги: ' + list(nb), 'new');
  const nbm = added(a.bookmarks, b.bookmarks);
  if (nbm.length) push('Новые закладки (добавятся только при первой установке): ' + list(nbm), 'new');
  const nth = added(a.siteThemes, b.siteThemes);
  if (nth.length) push('Тёмная тема по умолчанию на новых сайтах: ' + list(nth), 'new');
  if (a.protect && !b.protect && ext(true)) push('Пак больше не защищает свои контейнеры', 'changed', 'warn');
  if (!a.global && b.global && ext(true)) push('Пак станет работать во всех контейнерах', 'changed', 'warn');
  // Инструкции агенту — тоже код: любое изменение текста показывается.
  if (ext(a.agentMd !== b.agentMd || a.agentSummary !== b.agentSummary)) push('Изменились инструкции для Claude', 'changed', 'warn');
  const nsk = added(a.skills, b.skills);
  if (ext(nsk.length)) push('Новые скиллы для Claude: ' + list(nsk), 'new');
  if (JSON.stringify(a.fields) !== JSON.stringify(b.fields)) push('Изменились поля контейнера', 'changed');
  if (a.policies !== b.policies) push(`Проверки строк: было ${a.policies}, стало ${b.policies}`, 'changed');
  return { items, extended };
}

module.exports = { phrases, diff, facts, list };
