#!/usr/bin/env node
// Проверка чистоты ядра (решение «Космолёт — платформа»): в коде нет ничего про конкретные сайты и клиентов.
//
//   node tools/purity-check.mjs            — весь рабочий каталог (файлы git: отслеживаемые + новые неигнорируемые)
//   node tools/purity-check.mjs --staged   — только подготовленное к коммиту (содержимое из индекса git), для pre-commit
//   node tools/purity-check.mjs --quiet    — печатать только нарушения
//
// Правило 1 — домены сторонних сайтов (список DOMAIN_PATTERNS ниже) запрещены в DOMAIN_ROOTS. Исключения — явный
// список путей DOMAIN_ALLOW: встроенный стартовый пак (это и есть место для сайтового) и тесты.
// Правило 2 — маркеры клиентов из локального файла .purity-markers.txt (он в .gitignore; по строке на маркер,
// # — комментарий) запрещены во ВСЕХ файлах git: в коде, документации, тестах. Сам файл маркеров не проверяется.
// Код выхода: 0 — чисто, 1 — есть нарушения, 2 — ошибка запуска.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---------- правило 1: домены сторонних сайтов ----------
// Подстроки без учёта регистра (латиница и кириллица) + отдельные слова с учётом регистра.
const DOMAIN_PATTERNS = [
  'wildberries', 'wbbasket', 'wbstatic', 'wbcontent', 'wb.ru', 'вайлдберриз',
  'ozon', 'озон',
  'market.yandex', 'yandex.market', 'маркет.яндекс',
  'avito', 'авито',
  'megamarket', 'lamoda', 'aliexpress', 'kazanexpress', 'uzum.uz',
  'pult-agenta',
];
const DOMAIN_WORDS = ['WB']; // с учётом регистра, как отдельное слово
// Где действует правило 1.
const DOMAIN_ROOTS = ['src/', 'packs/', 'tools/'];
// Явно разрешённые пути (префикс или точное имя).
const DOMAIN_ALLOW = [
  'packs/builtin/marketplaces-starter/', // встроенный стартовый пак — сюда и уходит всё сайтовое
  'tools/purity-check.mjs',              // сам список
  'tools/smoke.mjs',                     // тесты: проверяют бэнги стартового пака
  'tools/packs-test.mjs',
  'tools/site-intel-test.mjs',
  'tools/containers-test.mjs',
];

// ---------- правило 2: маркеры клиентов ----------
const MARKERS_FILE = '.purity-markers.txt';

const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.txt', '.html', '.htm', '.css', '.ps1', '.bat', '.cmd', '.sh', '.yml', '.yaml', '.svg', '.xml', '.csv', '']);
const SKIP_DIRS = ['node_modules/', '.profiles/', 'tools/dev-out/', 'tools/selftest-out/', '.git/'];
const MAX_BYTES = 4 * 1024 * 1024;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const STAGED = args.has('--staged');
const QUIET = args.has('--quiet');

function git(argv) {
  return execFileSync('git', argv, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}

function lines(s) { return String(s || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean); }
const norm = (p) => p.replace(/\\/g, '/');

// Список файлов: из git (с учётом .gitignore), без git — обход каталога.
function fileList() {
  if (STAGED) return lines(git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'])).map(norm);
  try {
    const tracked = lines(git(['ls-files']));
    const fresh = lines(git(['ls-files', '--others', '--exclude-standard']));
    return Array.from(new Set(tracked.concat(fresh))).map(norm).filter((f) => fs.existsSync(path.join(ROOT, f)));
  } catch (_) {
    const out = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = norm(path.join(dir, e.name));
        if (SKIP_DIRS.some((s) => (rel + '/').startsWith(s)) || e.name === 'docs' && dir === '') continue;
        if (e.isDirectory()) walk(rel); else out.push(rel);
      }
    };
    walk('');
    return out;
  }
}

function readContent(rel) {
  if (STAGED) {
    try { return git(['show', ':' + rel]); } catch (_) { return null; }
  }
  const full = path.join(ROOT, rel);
  let st;
  try { st = fs.statSync(full); } catch (_) { return null; }
  if (!st.isFile() || st.size > MAX_BYTES) return null;
  const buf = fs.readFileSync(full);
  if (buf.includes(0)) return null; // двоичный
  return buf.toString('utf8');
}

function loadMarkers() {
  let raw = '';
  try { raw = fs.readFileSync(path.join(ROOT, MARKERS_FILE), 'utf8'); } catch (_) { return null; }
  return raw.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#')).map((s) => s.toLowerCase());
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
const DOMAIN_RE = new RegExp(DOMAIN_PATTERNS.map(escapeRe).join('|'), 'i');
const WORD_RE = new RegExp('(^|[^A-Za-z0-9_])(' + DOMAIN_WORDS.map(escapeRe).join('|') + ')(?![A-Za-z0-9_])');

function domainScoped(rel) {
  if (!DOMAIN_ROOTS.some((r) => rel.startsWith(r))) return false;
  return !DOMAIN_ALLOW.some((a) => (a.endsWith('/') ? rel.startsWith(a) : rel === a));
}

export function check() {
  const files = fileList().filter((f) => !SKIP_DIRS.some((s) => f.startsWith(s)) && f !== MARKERS_FILE && TEXT_EXT.has(path.extname(f).toLowerCase()));
  const markers = loadMarkers();
  const problems = [];
  let scanned = 0;
  for (const rel of files) {
    const scoped = domainScoped(rel);
    if (!scoped && !(markers && markers.length)) continue;
    const text = readContent(rel);
    if (text == null) continue;
    scanned++;
    const rows = text.split('\n');
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const low = row.toLowerCase();
      const hit = markers && markers.length ? markers.filter((mk) => low.includes(mk)) : [];
      if (scoped) {
        const m = DOMAIN_RE.exec(row) || WORD_RE.exec(row);
        // строку с маркером клиента целиком не показываем
        if (m) problems.push({ rule: 'домен', file: rel, line: i + 1, what: (m[2] || m[0]).trim(), text: hit.length ? '' : row.trim().slice(0, 160) });
      }
      // сам маркер не печатаем (вывод попадает в логи) — только его номер в .purity-markers.txt
      for (const mk of hit) problems.push({ rule: 'маркер клиента', file: rel, line: i + 1, what: '№' + (markers.indexOf(mk) + 1) + ' из ' + MARKERS_FILE, text: '' });
    }
  }
  return { problems, scanned, markers: markers ? markers.length : null };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let r;
  try { r = check(); } catch (e) { console.error('purity-check: не удалось проверить:', e.message); process.exit(2); }
  for (const p of r.problems) {
    // текст строки с маркером клиента не печатаем: вывод может попасть в лог или чат
    console.log(`${p.file}:${p.line}  ${p.rule} «${p.what}»${p.text ? '  — ' + p.text : ''}`);
  }
  if (!QUIET || r.problems.length) {
    const mk = r.markers == null ? `нет файла ${MARKERS_FILE} — маркеры клиентов не проверены` : `маркеров клиентов: ${r.markers}`;
    console.log(r.problems.length
      ? `purity-check: нарушений ${r.problems.length} (файлов проверено ${r.scanned}; ${mk}). Сайтовое — в паки, имена клиентов — никуда.`
      : `purity-check: чисто (файлов проверено ${r.scanned}; ${mk})`);
  }
  process.exit(r.problems.length ? 1 : 0);
}
