#!/usr/bin/env node
// Ставит git-хук pre-commit: перед каждым коммитом — tools/purity-check.mjs --staged (домены сторонних сайтов в ядре
// и маркеры клиентов из .purity-markers.txt). Запуск: node tools/install-hooks.mjs. Повторный запуск безопасен.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARK = '# kosmolet:purity-check';

function hooksDir() {
  try {
    const custom = execFileSync('git', ['config', 'core.hooksPath'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (custom) return path.resolve(ROOT, custom);
  } catch (_) { /* не задан */ }
  const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], { cwd: ROOT, encoding: 'utf8' }).trim();
  return path.resolve(ROOT, gitDir, 'hooks');
}

const dir = hooksDir();
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, 'pre-commit');
const body = [
  '#!/bin/sh',
  MARK,
  '# Поставлен tools/install-hooks.mjs. Чистота ядра: без доменов сторонних сайтов в src/ и без имён клиентов.',
  'node tools/purity-check.mjs --staged --quiet || {',
  '  echo "Коммит остановлен: purity-check нашёл нарушения (см. выше)."',
  '  exit 1',
  '}',
  '',
].join('\n');

let prev = '';
try { prev = fs.readFileSync(file, 'utf8'); } catch (_) { /* нет */ }
if (prev && !prev.includes(MARK)) {
  fs.copyFileSync(file, file + '.before-kosmolet');
  console.log('Прежний pre-commit сохранён как pre-commit.before-kosmolet');
}
fs.writeFileSync(file, body, { encoding: 'utf8' });
try { fs.chmodSync(file, 0o755); } catch (_) { /* Windows */ }
console.log('pre-commit установлен: ' + file);
