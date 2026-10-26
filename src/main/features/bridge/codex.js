'use strict';
// Подключение Codex (OpenAI) к мосту (claude-bridge). Разведка — docs/codex-research.md.
// - «Подключить к Codex»: в ~/.codex/config.toml (или %CODEX_HOME%) пишется ТОЛЬКО таблица [mcp_servers.kosmolet]
//   (url + http_headers.Authorization); остальной файл не трогается, перед записью — копия .kosmolet-bak, запись атомарная.
//   Странная разметка (многострочные строки, dotted keys вида mcp_servers.kosmolet.x = …, inline-таблица kosmolet = {…}) —
//   отказ без записи. `codex mcp add` не используем: он переписывает соседние записи.
// - findCodex(): настройка claude.codexCommand → PATH → самый свежий %LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe.
// - terminalArgs(): для профиля «Codex» в терминале — `-c mcp_servers.kosmolet.url=…` и
//   `-c mcp_servers.kosmolet.bearer_token_env_var=KOSMOLET_MCP_TOKEN`; токен — только в окружении процесса.

const fs = require('fs');
const os = require('os');
const path = require('path');

const NAME = 'kosmolet';
const TOKEN_ENV = 'KOSMOLET_MCP_TOKEN';
const IS_WIN = process.platform === 'win32';

function isFile(p) { try { return fs.statSync(p).isFile(); } catch (_) { return false; } }

function codexHome() {
  const h = String(process.env.CODEX_HOME || '').trim();
  return h || path.join(os.homedir(), '.codex');
}
function configFile() { return path.join(codexHome(), 'config.toml'); }

// ---------- поиск codex ----------

function whichPath(names) {
  const dirs = String(process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    for (const n of names) {
      const full = path.join(d.replace(/^"|"$/g, ''), n);
      if (isFile(full)) return full;
    }
  }
  return null;
}

// Приложение Codex для Windows кладёт CLI в %LOCALAPPDATA%\OpenAI\Codex\bin\<хэш>\codex.exe; <хэш> меняется при
// обновлениях — берём самый свежий. Копия в WindowsApps не запускается (Permission denied).
function newestBundled() {
  if (!IS_WIN || !process.env.LOCALAPPDATA) return null;
  const bin = path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
  let best = null;
  let bestAt = -1;
  let dirs = [];
  try { dirs = fs.readdirSync(bin); } catch (_) { return null; }
  for (const d of dirs) {
    const exe = path.join(bin, d, 'codex.exe');
    try {
      const st = fs.statSync(exe);
      if (st.isFile() && st.mtimeMs > bestAt) { best = exe; bestAt = st.mtimeMs; }
    } catch (_) { /* нет файла */ }
  }
  return best;
}

// → { path, source: 'setting'|'path'|'bundled' } или null
function findCodex(setting) {
  const s = String(setting || '').trim();
  if (s) {
    if (path.isAbsolute(s)) return isFile(s) ? { path: s, source: 'setting' } : null;
    const p = whichPath(IS_WIN ? [s + '.exe', s + '.cmd', s] : [s]);
    return p ? { path: p, source: 'setting' } : null;
  }
  const p = whichPath(IS_WIN ? ['codex.exe', 'codex.cmd'] : ['codex']);
  if (p) return { path: p, source: 'path' };
  const b = newestBundled();
  return b ? { path: b, source: 'bundled' } : null;
}

// ---------- config.toml ----------

const HEADER = /^\s*\[\[?\s*([^\]]*?)\s*\]\]?\s*(#.*)?$/;

// Имя таблицы без кавычек вокруг частей: mcp_servers."kosmolet" → mcp_servers.kosmolet
function normTable(name) {
  return String(name).split('.').map((p) => p.trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')).join('.');
}
const isOurs = (t) => t === `mcp_servers.${NAME}` || t.startsWith(`mcp_servers.${NAME}.`);

function tomlString(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function ourBlock(url, token) {
  return [
    `[mcp_servers.${NAME}]`,
    '# Космолёт — браузер с инструментами для агента. Записано кнопкой «Подключить к Codex» в Космолёте.',
    `url = ${tomlString(url)}`,
    `http_headers = { Authorization = ${tomlString('Bearer ' + token)} }`,
  ].join('\n');
}

// Чистая функция: текст config.toml → новый текст. Бросает ошибку, если разметку не понимаем.
function upsert(text, url, token) {
  const src = String(text || '').replace(/^﻿/, '');
  if (/"""|'''/.test(src)) throw new Error('в config.toml есть многострочные строки — правьте файл вручную');
  const eol = /\r\n/.test(src) ? '\r\n' : '\n';
  const lines = src.split(/\r?\n/);
  const out = [];
  let table = '';
  let skipping = false;
  let at = -1; // где стояла наша таблица — новую ставим туда же, а не в конец (Codex дописывает свои секции после)
  for (const line of lines) {
    const m = line.match(HEADER);
    if (m) {
      table = normTable(m[1]);
      skipping = isOurs(table);
      if (skipping) { if (at < 0) at = out.length; continue; }
    } else if (!skipping) {
      // dotted keys и inline-таблицы, которые тоже задают mcp_servers.kosmolet
      const key = (line.match(/^\s*([A-Za-z0-9_."'-]+)\s*=/) || [])[1];
      if (key) {
        const full = normTable(table ? `${table}.${key}` : key);
        if (isOurs(full)) throw new Error('mcp_servers.kosmolet в config.toml задан не таблицей — правьте файл вручную');
      }
    }
    if (!skipping) out.push(line);
  }
  const block = ourBlock(url, token).split('\n');
  if (at >= 0) {
    out.splice(at, 0, ...block, '');
    while (out.length && !out[out.length - 1].trim()) out.pop();
    return out.join(eol) + eol;
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  const head = out.length ? out.join(eol) + eol + eol : '';
  return head + block.join(eol) + eol;
}

function createCodex(ctx, getConfig) {
  function url() { return `http://127.0.0.1:${getConfig().port}/mcp`; }
  function setting() { return ctx.settings.peek('claude.codexCommand') || ''; }
  function find() { return findCodex(setting()); }

  // Подключить Codex: записать таблицу в config.toml. dryRun — показать, что будет записано, с маской токена.
  function connect(opts = {}) {
    const file = configFile();
    const { token } = getConfig();
    let before = '';
    try { before = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') return { ok: false, output: `Не прочитать ${file}: ${e.message}` }; }
    let after;
    try { after = upsert(before, url(), token); } catch (e) {
      return { ok: false, refused: true, path: file, output: `Не записал: ${e.message}.\n\nДобавьте в ${file} сами:\n\n${ourBlock(url(), '<token>')}` };
    }
    const found = find();
    const note = found ? `Codex: ${found.path}` : 'Сам codex не найден — это не мешает: config.toml общий для приложения Codex, CLI и плагинов редакторов.';
    if (opts.dryRun) return { ok: true, dryRun: true, path: file, output: after.split(token).join('<token>'), note };
    if (after === before) return { ok: true, path: file, output: `Уже подключено: ${file}\n${note}` };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (before) fs.writeFileSync(file + '.kosmolet-bak', before, 'utf8');
      const tmp = file + '.kosmolet-tmp';
      fs.writeFileSync(tmp, after, 'utf8');
      fs.renameSync(tmp, file);
    } catch (e) {
      return { ok: false, path: file, output: `Не записал ${file}: ${e.message}` };
    }
    ctx.log('bridge', 'подключение Codex: записана таблица mcp_servers.kosmolet в', file);
    return {
      ok: true, path: file,
      output: `Записано в ${file}${before ? ` (прежний файл — ${path.basename(file)}.kosmolet-bak)` : ''}.\n` +
        'Перезапустите приложение Codex или откройте новый чат — появятся инструменты kosmolet.\n' + note,
    };
  }

  // Аргументы и окружение для `codex` во встроенном терминале (токена нет ни в файле, ни в командной строке).
  function terminalArgs() {
    return {
      args: ['-c', `mcp_servers.${NAME}.url=${url()}`, '-c', `mcp_servers.${NAME}.bearer_token_env_var=${TOKEN_ENV}`],
      env: { [TOKEN_ENV]: String(getConfig().token || '') },
    };
  }

  return { connect, find, terminalArgs, configFile, url };
}

module.exports = { createCodex, findCodex, upsert, ourBlock, codexHome, TOKEN_ENV };
