'use strict';
// Фича «claude-terminal»: терминал с Claude Code в правой панели (инструмент «Claude», вкладка «Терминал»).
// - сессии node-pty (ConPTY): профили claude | powershell | cmd | bash; node-pty грузится при первом запуске;
// - «Claude» = settings.claude.claudeCommand + --mcp-config <ctx.bridge.mcpConfigPath()> в оболочке settings.claude.shell;
// - вывод копится и раз в 16 мс уходит ТОЛЬКО в панель (kosmo:term.data {id, data, seq}); кольцевой буфер 256 КБ
//   на сессию — для восстановления после перезагрузки панели (kosmo:term.replay);
// - закрытие сессии и выход из приложения убивают всё дерево процессов (taskkill /T /F);
// - пока фокус в терминале, сочетания Ctrl/Alt+буква уходят в оболочку, а не командам браузера (ctx.commands.addBypass).
// API для соседей: ctx.terminal = { pasteToClaude(text) → bool, open(profile) → id, list(), create(), write(), kill(), restart() }.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawnSync } = require('child_process');

const PROFILES = ['claude', 'powershell', 'cmd', 'bash'];
const TITLES = { claude: 'Claude', powershell: 'PowerShell', cmd: 'cmd', bash: 'Git Bash' };
const SHELLS = ['powershell', 'cmd', 'bash'];
const BUFFER_LIMIT = 256 * 1024; // символов вывода на сессию
const FLUSH_MS = 16;
const MAX_SESSIONS = 12;
const WRITE_LIMIT = 1024 * 1024;
const IS_WIN = process.platform === 'win32';
// Переменные, которые не должны утечь в терминал (Electron и вложенный запуск Claude Code).
const STRIP_ENV = /^(ELECTRON_|CLAUDECODE$|CLAUDE_CODE_ENTRYPOINT$|CLAUDE_CODE_SSE_PORT$)/i;

let ptyLib = null;
function pty() {
  if (!ptyLib) ptyLib = require('node-pty');
  return ptyLib;
}

function isFile(p) { try { return fs.statSync(p).isFile(); } catch (_) { return false; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } }

// Разбить строку команды на слова с учётом кавычек: `"C:\a b\claude.exe" --x` → ['C:\a b\claude.exe', '--x'].
function splitArgs(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  return out;
}

// Поиск исполняемого файла: путь как есть или по PATH с расширениями.
function which(bin, exts) {
  if (!bin) return null;
  const hasExt = !!path.extname(bin);
  const variants = (e) => (hasExt ? [bin].concat(exts.map((x) => bin + x)) : exts.map((x) => bin + x));
  if (path.isAbsolute(bin) || /[\\/]/.test(bin)) {
    for (const v of variants()) if (isFile(v)) return path.resolve(v);
    return null;
  }
  const dirs = String(process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    for (const v of variants()) {
      const full = path.join(d.replace(/^"|"$/g, ''), v);
      if (isFile(full)) return full;
    }
  }
  return null;
}

// Метка «claude завершился»: после команды claude оболочка (она остаётся жить: -NoExit, cmd /k, exec bash)
// меняет заголовок консоли на EXIT_TITLE — ConPTY присылает его в выводе как OSC 0. По ней pasteToClaude
// понимает, что в сессии теперь обычная оболочка, и не вставляет туда путь.
const EXIT_TITLE = 'Kosmolet: claude exited';
const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const shQuote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const cmdQuote = (s) => '"' + s + '"';
const toPosix = (p) => String(p).replace(/\\/g, '/');

function checkArg(a, what) {
  if (/["\r\n\0]/.test(a)) throw new Error(`${what}: недопустимые символы (кавычки или перевод строки)`);
  return a;
}

// ConPTY. PowerShell и cmd запускаются через conpty.dll + OpenConsole.exe из node-pty, а не через системный
// ConPTY Windows 10: системный оставляет висеть conhost.exe после того, как оболочка сама завершилась (exit),
// и не понимает win32-input-mode. Если conpty.dll не запустился — системный ConPTY. Git Bash — системный.
// Windows PowerShell 5.1 со встроенным PSReadLine 2.0.0 теряет символы, которые ConPTY превращает в нажатия
// «Shift+клавиша» по раскладке (заглавные А, О, Ж, Э… и №): срабатывает чужой обработчик клавиш.
// Обход для PowerShell: каждый символ вне ASCII отправляется событием клавиши без модификаторов
// (win32-input-mode: ESC [ Vk ; Sc ; Uc ; Kd ; Cs ; Rc _ с Vk=0). Программы, читающие консоль (claude, node),
// получают тот же символ.
let dllCache;
function conptyDllAvailable() {
  if (dllCache !== undefined) return dllCache;
  dllCache = false;
  try {
    const root = path.dirname(require.resolve('node-pty/package.json'));
    for (const d of [path.join(root, 'build', 'Release', 'conpty'), path.join(root, 'prebuilds', 'win32-' + process.arch, 'conpty')]) {
      if (isFile(path.join(d, 'conpty.dll')) && isFile(path.join(d, 'OpenConsole.exe'))) { dllCache = true; break; }
    }
  } catch (_) { /* нет node-pty — запуск всё равно упадёт с понятной ошибкой */ }
  return dllCache;
}

const NON_ASCII = /[^\x00-\x7f]/;
function encodeWin32Input(data) {
  if (!NON_ASCII.test(data)) return data;
  let out = '';
  for (let i = 0; i < data.length; i++) {
    const code = data.charCodeAt(i);
    if (code < 0x80) { out += data[i]; continue; }
    out += `\x1b[0;0;${code};1;0;1_\x1b[0;0;${code};0;0;1_`;
  }
  return out;
}

function init(ctx) {
  const S = ctx.settings;
  // claude.shell объявляет и claude-bridge (раздел настроек «Claude») — повтор безопасен, нужен, если моста нет.
  if (typeof S.addDefaults === 'function') S.addDefaults({ claude: { shell: 'powershell' } }, { enums: { 'claude.shell': SHELLS } });

  const sessions = new Map(); // id → сессия
  let nextId = 1;
  let focusId = null; // какую сессию панель должна показать при загрузке
  let flushTimer = null;
  let termFocused = false; // фокус ввода в xterm панели (для горячих клавиш)
  let quitting = false;
  let gitBashCache;

  // ---------- окружение и оболочки ----------

  function desktopDir() { try { return ctx.app.getPath('desktop'); } catch (_) { return os.homedir(); } }

  function effectiveCwd(override) {
    for (const c of [override, S.peek('claude.terminalCwd')]) {
      if (typeof c === 'string' && c.trim() && isDir(c.trim())) return path.resolve(c.trim());
    }
    const d = desktopDir();
    return isDir(d) ? d : os.homedir();
  }

  function displayPath(p) {
    const home = os.homedir();
    if (p && home && p.toLowerCase().startsWith(home.toLowerCase())) return '~' + p.slice(home.length);
    return p;
  }

  function makeEnv() {
    const env = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (STRIP_ENV.test(k) || v == null) continue;
      env[k] = String(v);
    }
    env.TERM = 'xterm-256color';
    env.COLORTERM = 'truecolor';
    env.TERM_PROGRAM = 'Kosmolet';
    return env;
  }

  function powershellPath() {
    const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    const p = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return isFile(p) ? p : 'powershell.exe';
  }
  function cmdPath() {
    const c = process.env.ComSpec;
    if (c && isFile(c)) return c;
    const p = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
    return isFile(p) ? p : 'cmd.exe';
  }
  function gitBashPath() {
    if (gitBashCache !== undefined) return gitBashCache;
    const c = ['C:\\Program Files\\Git\\bin\\bash.exe'];
    for (const base of [process.env.ProgramW6432, process.env.ProgramFiles, process.env['ProgramFiles(x86)'],
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]) {
      if (base) c.push(path.join(base, 'Git', 'bin', 'bash.exe'));
    }
    const git = which('git', ['.exe']);
    if (git) {
      c.push(path.resolve(path.dirname(git), '..', 'bin', 'bash.exe')); // …\Git\cmd\git.exe
      c.push(path.resolve(path.dirname(git), '..', '..', 'bin', 'bash.exe')); // …\Git\mingw64\bin\git.exe
    }
    gitBashCache = IS_WIN ? (c.find(isFile) || null) : null;
    return gitBashCache;
  }

  function shellSetting() {
    const s = S.peek('claude.shell');
    return SHELLS.includes(s) ? s : 'powershell';
  }

  function mcpEnabled() {
    return S.peek('claude.mcpEnabled') !== false && S.peek('claude.access') !== 'off';
  }

  // Файл MCP-конфига для `claude --mcp-config`: от claude-bridge, а если моста нет — свой того же формата.
  function mcpConfigPath() {
    const b = ctx.bridge;
    if (b && typeof b.mcpConfigPath === 'function') {
      try { const p = b.mcpConfigPath(); if (p) return p; } catch (e) { ctx.log('terminal', 'mcpConfigPath:', e.message); }
    }
    const port = Number(S.peek('claude.mcpPort')) || 47321;
    const token = String(S.peek('claude.token') || '');
    const file = path.join(ctx.paths.userData, 'gen', 'claude-mcp.json');
    const data = { mcpServers: { kosmolet: { type: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${token}` } } } };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) { ctx.log('terminal', 'не записан claude-mcp.json:', e.message); return null; }
    return file;
  }

  // Что запускать для Claude: бинарник (с поиском по PATH) и аргументы.
  function claudeSpec(shell) {
    const raw = String(S.peek('claude.claudeCommand') || '').trim() || 'claude';
    let bin = raw;
    let extra = [];
    if (!isFile(raw)) {
      const t = splitArgs(raw);
      if (t.length) { bin = t[0]; extra = t.slice(1); }
    }
    const exts = !IS_WIN ? [''] : shell === 'bash' ? ['', '.exe'] : ['.exe', '.cmd', '.bat', '.com'];
    const resolved = which(bin, exts);
    const args = extra.slice();
    const cfg = mcpEnabled() ? mcpConfigPath() : null;
    if (cfg) args.push('--mcp-config', cfg);
    return { bin, resolved, args, cfg };
  }

  // Профиль → {file, args, title}. args — массив (node-pty сам экранирует) или строка (командная строка как есть).
  function buildSpawn(profile, opts = {}) {
    const isClaude = profile === 'claude';
    const shell = isClaude ? shellSetting() : profile;
    const c = isClaude ? claudeSpec(shell) : null;
    // для проверок: заменить запуск claude своей командой (например, «claude --version»)
    if (c && Array.isArray(opts.claudeArgs)) c.args = opts.claudeArgs.map(String);
    if (!IS_WIN) {
      const sh = process.env.SHELL || '/bin/bash';
      if (!c) return { file: sh, args: ['-l', '-i'], shell: 'sh' };
      const line = [c.resolved || c.bin].concat(c.args).map(shQuote).join(' ');
      return { file: sh, args: ['-l', '-i', '-c', `${line}; printf '\\033]0;%s\\007' ${shQuote(EXIT_TITLE)}; exec ${shQuote(sh)} -l -i`], shell: 'sh', claude: c };
    }
    if (shell === 'powershell') {
      const file = powershellPath();
      if (!c) return { file, args: ['-NoLogo'], shell };
      const bin = checkArg(c.resolved || c.bin, 'команда claude');
      const line = '& ' + [bin].concat(c.args.map((a) => checkArg(a, 'аргумент claude'))).map(psQuote).join(' ')
        + `; $Host.UI.RawUI.WindowTitle = ${psQuote(EXIT_TITLE)}`;
      return { file, args: ['-NoLogo', '-NoExit', '-Command', line], shell, claude: c };
    }
    if (shell === 'cmd') {
      const file = cmdPath();
      if (!c) return { file, args: [], shell };
      const bad = (a) => { checkArg(a, 'команда claude'); if (/%/.test(a)) throw new Error('символ % в команде claude не поддерживается в cmd'); return a; };
      const line = [bad(c.resolved || c.bin)].concat(c.args.map(bad)).map(cmdQuote).join(' ');
      // /s /k ""bin" "a" "b" & title …" — cmd снимает внешние кавычки и выполняет строку, потом остаётся открытым
      return { file, args: `/s /k "${line} & title ${EXIT_TITLE}"`, shell, claude: c };
    }
    // Git Bash
    const file = gitBashPath();
    if (!file) throw new Error('Git Bash не найден. Установите Git for Windows (git-scm.com).');
    if (!c) return { file, args: ['--login', '-i'], shell };
    const bin = c.resolved ? toPosix(c.resolved) : c.bin;
    const line = [bin].concat(c.args.map((a) => (isFile(a) ? toPosix(a) : a))).map(shQuote).join(' ');
    return { file, args: ['--login', '-i', '-c', `${line}; printf '\\033]0;%s\\007' ${shQuote(EXIT_TITLE)}; exec bash --login -i`], shell, claude: c };
  }

  // ---------- сессии ----------

  function uniqueTitle(profile) {
    const base = TITLES[profile] || profile;
    const used = new Set(Array.from(sessions.values()).map((s) => s.title));
    if (!used.has(base)) return base;
    for (let i = 2; i < 100; i++) if (!used.has(`${base} ${i}`)) return `${base} ${i}`;
    return base;
  }

  function info(s) {
    return {
      id: s.id, title: s.title, profile: s.profile, alive: s.alive, exitCode: s.exitCode,
      pid: s.pid, cwd: s.cwd, cols: s.cols, rows: s.rows, createdAt: s.createdAt, shell: s.shell, conptyDll: !!s.conptyDll,
      focused: s.id === focusId,
    };
  }
  function list() { return Array.from(sessions.values()).map(info); }

  function toPanel(channel, payload) {
    if (quitting) return;
    try { ctx.panel.send(channel, payload); } catch (_) { /* панели нет */ }
  }
  let sessionsTimer = null;
  function emitSessions() {
    if (sessionsTimer) return;
    sessionsTimer = setTimeout(() => { sessionsTimer = null; toPanel('kosmo:term.sessions', { sessions: list(), focusId }); }, 0);
  }

  // ---- вывод: батч раз в 16 мс + кольцевой буфер ----
  function pushBuffer(s, data) {
    s.chunks.push(data);
    s.size += data.length;
    while (s.size > BUFFER_LIMIT && s.chunks.length > 1) { s.size -= s.chunks.shift().length; s.dropped = true; }
    if (s.size > BUFFER_LIMIT) {
      const c = s.chunks[0];
      s.chunks[0] = c.slice(c.length - BUFFER_LIMIT);
      s.size = s.chunks[0].length;
      s.dropped = true;
    }
  }
  function bufferText(s) {
    let t = s.chunks.join('');
    s.chunks = t ? [t] : [];
    if (s.dropped) {
      // начало обрезано — пропускаем до первой новой строки, чтобы не начать с половины escape-последовательности
      const nl = t.indexOf('\n');
      if (nl >= 0 && nl < 8192) t = t.slice(nl + 1);
      else if (/^[\udc00-\udfff]/.test(t)) t = t.slice(1);
    }
    return t;
  }
  function flushOne(s) {
    if (!s.pending) return;
    const data = s.pending;
    s.pending = '';
    pushBuffer(s, data);
    s.seq++;
    toPanel('kosmo:term.data', { id: s.id, data, seq: s.seq });
  }
  function flushAll() {
    flushTimer = null;
    for (const s of sessions.values()) flushOne(s);
  }
  function scheduleFlush() { if (!flushTimer) flushTimer = setTimeout(flushAll, FLUSH_MS); }

  function onData(s, p, data) {
    if (s.pty !== p) return;
    s.pending += data;
    // режим bracketed paste приложения (DECSET 2004) — для pasteToClaude
    if (data.indexOf('\x1b[?2004') >= 0) {
      const re = /\x1b\[\?2004([hl])/g;
      let m, last = null;
      while ((m = re.exec(data))) last = m[1];
      if (last) s.bracketed = last === 'h';
    }
    // claude завершился (метка EXIT_TITLE, см. buildSpawn): дальше в сессии обычная оболочка
    if (s.profile === 'claude' && !s.claudeExited) {
      const tail = (s.markTail || '') + data;
      if (tail.indexOf(EXIT_TITLE) >= 0) {
        s.claudeExited = true;
        s.bracketed = false;
        ctx.log('terminal', `сессия ${s.id}: claude завершился, в сессии осталась оболочка`);
        emitSessions();
      }
      s.markTail = tail.slice(-EXIT_TITLE.length);
    }
    if (s.pending.length > 512 * 1024) flushOne(s); else scheduleFlush();
  }

  function onExit(s, p, ev) {
    if (s.pty !== p) return;
    flushOne(s);
    s.alive = false;
    s.exitCode = ev && typeof ev.exitCode === 'number' ? ev.exitCode : null;
    s.pty = null;
    disposeListeners(s);
    releaseConout(p);
    ctx.log('terminal', `сессия ${s.id} (${s.title}) завершилась, код ${s.exitCode}`);
    toPanel('kosmo:term.exit', { id: s.id, code: s.exitCode });
    emitSessions();
  }

  // node-pty 1.1 после естественного выхода процесса не останавливает поток (worker) чтения вывода —
  // он освобождается только в kill(). Закрываем сами, иначе на каждую завершившуюся сессию висит worker.
  function releaseConout(p) {
    try {
      const w = p && p._agent && p._agent._conoutSocketWorker;
      if (w && typeof w.dispose === 'function') w.dispose();
    } catch (e) { ctx.log('terminal', 'conout:', e.message); }
  }

  function disposeListeners(s) {
    for (const d of s.disposers.splice(0)) { try { d.dispose(); } catch (_) { /* уже */ } }
  }

  function spawnInto(s, opts = {}) {
    const spec = buildSpawn(s.profile, opts);
    const cols = clampInt(opts.cols, 20, 500, s.cols || 100);
    const rows = clampInt(opts.rows, 5, 300, s.rows || 30);
    const base = { name: 'xterm-256color', cols, rows, cwd: s.cwd, env: makeEnv(), useConpty: true };
    // conpty.dll из node-pty (см. выше); не вышло — системный ConPTY. Git Bash — всегда системный:
    // под новым ConPTY bash из MSYS2 теряет первый символ, набранный после изменения размера.
    let useDll = IS_WIN && conptyDllAvailable() && (opts.conptyDll === true || (opts.conptyDll !== false && spec.shell !== 'bash'));
    let p;
    try {
      p = pty().spawn(spec.file, spec.args, Object.assign({ useConptyDll: useDll }, base));
    } catch (e) {
      if (!useDll) throw new Error(`Не удалось запустить ${path.basename(spec.file)}: ${e.message}`);
      ctx.log('terminal', 'conpty.dll не сработал, системный ConPTY:', e.message);
      useDll = false;
      try {
        p = pty().spawn(spec.file, spec.args, base);
      } catch (e2) {
        throw new Error(`Не удалось запустить ${path.basename(spec.file)}: ${e2.message}`);
      }
    }
    s.pty = p;
    s.conptyDll = useDll;
    s.encodeInput = useDll && spec.shell === 'powershell'; // обход PSReadLine 2.0 (см. encodeWin32Input)
    s.pid = p.pid;
    s.cols = cols;
    s.rows = rows;
    s.alive = true;
    s.exitCode = null;
    s.bracketed = false;
    s.claudeExited = false;
    s.markTail = '';
    s.shell = spec.shell;
    s.spec = { file: spec.file, args: spec.args, claude: spec.claude ? { bin: spec.claude.bin, resolved: spec.claude.resolved, args: spec.claude.args } : null };
    s.disposers.push(p.onData((d) => onData(s, p, d)));
    s.disposers.push(p.onExit((ev) => onExit(s, p, ev)));
    // без своего обработчика node-pty бросает ошибку сокета наверх
    if (typeof p.on === 'function') { try { p.on('error', (e) => ctx.log('terminal', `сессия ${s.id}:`, e && e.message)); } catch (_) { /* нет EventEmitter */ } }
    ctx.log('terminal', `сессия ${s.id} (${s.title}) запущена: pid ${p.pid}, ${path.basename(spec.file)}, ${cols}×${rows}, ${useDll ? 'conpty.dll' : 'ConPTY Windows'}, ${s.cwd}`);
  }

  function clampInt(v, min, max, def) {
    const n = Math.round(Number(v));
    if (!isFinite(n) || n <= 0) return def;
    return Math.min(max, Math.max(min, n));
  }

  function create(o = {}) {
    const profile = PROFILES.includes(o.profile) ? o.profile : 'claude';
    if (sessions.size >= MAX_SESSIONS) throw new Error(`Слишком много сессий (максимум ${MAX_SESSIONS}). Закройте ненужные.`);
    const s = {
      id: nextId++, profile, title: uniqueTitle(profile), cwd: effectiveCwd(o.cwd),
      pty: null, pid: 0, alive: false, exitCode: null, cols: 0, rows: 0, shell: '',
      chunks: [], size: 0, dropped: false, pending: '', seq: 0, bracketed: false,
      disposers: [], createdAt: Date.now(), lastUsed: Date.now(), spec: null,
    };
    spawnInto(s, o); // ошибка запуска → исключение, сессия не добавляется
    sessions.set(s.id, s);
    focusId = s.id;
    emitSessions();
    return info(s);
  }

  function get(id) {
    const s = sessions.get(Number(id));
    if (!s) throw new Error('нет такой сессии терминала: ' + id);
    return s;
  }

  function write(id, data) {
    const s = sessions.get(Number(id));
    if (!s || !s.alive || !s.pty) return false;
    if (typeof data !== 'string' || !data) return false;
    if (data.length > WRITE_LIMIT) data = data.slice(0, WRITE_LIMIT);
    s.lastUsed = Date.now();
    return ptyWrite(s, data);
  }

  function ptyWrite(s, data) {
    try { s.pty.write(s.encodeInput ? encodeWin32Input(data) : data); } catch (e) { ctx.log('terminal', `запись в ${s.id}:`, e.message); return false; }
    return true;
  }

  function resize(id, cols, rows) {
    const s = get(id);
    cols = clampInt(cols, 2, 500, s.cols);
    rows = clampInt(rows, 1, 300, s.rows);
    if (cols === s.cols && rows === s.rows) return { cols, rows };
    s.cols = cols;
    s.rows = rows;
    if (s.alive && s.pty) { try { s.pty.resize(cols, rows); } catch (e) { ctx.log('terminal', `ресайз ${s.id}:`, e.message); } }
    return { cols, rows };
  }

  // Убить дерево процессов оболочки (claude, node, …). sync — при выходе из приложения.
  function killTree(pids, sync) {
    pids = pids.filter((x) => Number(x) > 0);
    if (!pids.length) return;
    if (IS_WIN) {
      const args = ['/T', '/F'];
      for (const pid of pids) args.push('/PID', String(pid));
      if (sync) {
        try { spawnSync('taskkill.exe', args, { windowsHide: true, timeout: 5000, stdio: 'ignore' }); } catch (_) { /* уже нет */ }
      } else {
        execFile('taskkill.exe', args, { windowsHide: true, timeout: 10000 }, () => {});
      }
    } else {
      for (const pid of pids) { try { process.kill(-pid, 'SIGKILL'); } catch (_) { try { process.kill(pid, 'SIGKILL'); } catch (__) { /* уже */ } } }
    }
  }

  // Остановить процесс сессии (без удаления сессии).
  function stopPty(s, sync) {
    const p = s.pty;
    disposeListeners(s);
    s.pty = null;
    s.alive = false;
    if (!p) return;
    killTree([p.pid], sync);
    if (!sync || s.conptyDll) { try { p.kill(); } catch (_) { /* уже завершён */ } }
    if (!sync && s.conptyDll) releaseConout(p); // conpty.dll: node-pty ждёт данных, которых уже не будет
  }

  function kill(id) {
    const s = sessions.get(Number(id));
    if (!s) return false;
    stopPty(s, false);
    sessions.delete(s.id);
    if (focusId === s.id) focusId = null;
    ctx.log('terminal', `сессия ${s.id} (${s.title}) закрыта`);
    emitSessions();
    return true;
  }

  function restart(id, o = {}) {
    const s = get(id);
    stopPty(s, false);
    s.pending = '';
    s.chunks = [];
    s.size = 0;
    s.dropped = false;
    // сброс экрана в панели уходит раньше любого вывода нового процесса (порядок сообщений сохраняется)
    toPanel('kosmo:term.reset', { id: s.id, seq: s.seq });
    s.cwd = effectiveCwd(o.cwd || s.cwd);
    try {
      spawnInto(s, o);
    } catch (e) {
      s.alive = false;
      emitSessions();
      throw e;
    }
    s.lastUsed = Date.now();
    emitSessions();
    return info(s);
  }

  function replay(id, withSeq) {
    const s = get(id);
    flushOne(s); // недосланное — событием раньше ответа
    const data = bufferText(s);
    return withSeq ? { data, seq: s.seq, alive: s.alive, exitCode: s.exitCode } : data;
  }

  function killAll(sync) {
    const list = Array.from(sessions.values());
    const pids = [];
    for (const s of list) {
      if (s.pty) pids.push(s.pty.pid);
      disposeListeners(s);
    }
    if (sync) {
      killTree(pids, true);
      for (const s of list) {
        // conpty.dll: закрыть псевдоконсоль, чтобы OpenConsole.exe завершился вместе с нами (без форка помощника)
        if (s.pty && s.conptyDll) { try { s.pty.kill(); } catch (_) { /* уже */ } }
        s.pty = null;
        s.alive = false;
      }
    } else {
      for (const s of list) stopPty(s, false);
    }
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  }

  // Показать сессию в панели (и, по желанию, перевести туда фокус ввода).
  function show(id, focus) {
    focusId = id;
    try { ctx.panel.open('claude'); } catch (e) { ctx.log('terminal', e.message); }
    toPanel('kosmo:term.show', { id, focus: !!focus });
    if (focus) {
      const wc = ctx.panel.webContents && ctx.panel.webContents();
      if (wc && !wc.isDestroyed()) wc.focus();
    }
  }

  // Сам claude ещё работает в сессии, а не осталась оболочка после его выхода (/exit, падение, --version):
  // Claude Code включает bracketed paste (DECSET 2004), Windows PowerShell и cmd — нет. Bash (readline) включает
  // его на каждом приглашении, поэтому bash-сессия после метки выхода claude (EXIT_TITLE) больше не Claude.
  function claudeRunning(s) {
    if (!s || s.profile !== 'claude' || !s.alive || !s.pty) return false;
    if (!s.bracketed) return false;
    if (s.claudeExited && (s.shell === 'bash' || s.shell === 'sh')) return false;
    return true;
  }

  function lastClaude() {
    let best = null;
    for (const s of sessions.values()) {
      if (!claudeRunning(s)) continue;
      if (!best || s.lastUsed > best.lastUsed) best = s;
    }
    return best;
  }

  // Вставить текст в ввод последней живой Claude-сессии без Enter.
  function pasteToClaude(text) {
    const s = lastClaude();
    if (!s) return false;
    let t = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
    if (!t) return false;
    // приложение включило bracketed paste — вставка целиком; иначе переводы строк не отправляем (они бы нажали Enter)
    t = s.bracketed ? '\x1b[200~' + t + '\x1b[201~' : t.replace(/\n+/g, ' ');
    if (!ptyWrite(s, t)) return false;
    s.lastUsed = Date.now();
    show(s.id, true);
    return true;
  }

  function estimateSize() {
    let cols = 100, rows = 30;
    try {
      const b = ctx.panel.bounds;
      const w = (b && b.width) || Number(S.peek('ui.panelWidth')) || 460;
      const hgt = b && b.height ? b.height : 700;
      cols = Math.max(40, Math.floor((w - 30) / 7.7));
      rows = Math.max(10, Math.floor((hgt - 36 - 70 - 12) / 17));
    } catch (_) { /* по умолчанию */ }
    return { cols, rows };
  }

  function open(profile) {
    const r = create(Object.assign({ profile: PROFILES.includes(profile) ? profile : 'claude' }, estimateSize()));
    show(r.id, true);
    return r.id;
  }

  function terminalInfo() {
    const shell = shellSetting();
    const c = claudeSpec(shell);
    const cwd = effectiveCwd();
    const setting = String(S.peek('claude.terminalCwd') || '');
    const bash = IS_WIN ? gitBashPath() : null;
    let build = 0;
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(os.release());
    if (m) build = Number(m[3]);
    return {
      cwd, cwdDisplay: displayPath(cwd), cwdName: path.basename(cwd) || cwd,
      cwdSetting: setting, cwdMissing: !!setting && !isDir(setting), desktop: desktopDir(),
      shell, claudeCommand: String(S.peek('claude.claudeCommand') || 'claude'),
      claudeFound: !!c.resolved, claudePath: c.resolved, mcp: !!c.cfg, access: S.peek('claude.access') || 'full',
      gitBash: bash,
      profiles: PROFILES.map((id) => ({ id, title: TITLES[id], available: id !== 'bash' || !!bash || !IS_WIN })),
      platform: process.platform, windowsBuild: IS_WIN ? build : 0,
    };
  }

  // ---------- IPC (только интерфейс) ----------
  const I = ctx.ipc;
  I.handle('kosmo:term.create', (p = {}) => create(p || {}));
  I.on('kosmo:term.write', (p) => { if (p) write(p.id, p.data); });
  I.handle('kosmo:term.write', (p = {}) => write(p && p.id, p && p.data));
  I.handle('kosmo:term.resize', (p = {}) => resize(p.id, p.cols, p.rows));
  I.on('kosmo:term.resize', (p) => { try { if (p) resize(p.id, p.cols, p.rows); } catch (_) { /* нет сессии */ } });
  I.handle('kosmo:term.kill', (p = {}) => kill(p && p.id));
  I.handle('kosmo:term.restart', (p = {}) => restart(p && p.id, p || {}));
  I.handle('kosmo:term.list', () => list());
  I.handle('kosmo:term.replay', (p = {}) => replay(p && p.id, !!(p && p.withSeq)));
  I.handle('kosmo:term.info', () => terminalInfo());
  I.handle('kosmo:term.pickCwd', async () => {
    const cur = effectiveCwd();
    const r = await ctx.electron.dialog.showOpenDialog(ctx.windows.main, {
      title: 'Рабочая папка терминала',
      defaultPath: cur,
      properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { path: null };
    S.set('claude.terminalCwd', r.filePaths[0]);
    return { path: r.filePaths[0], display: displayPath(r.filePaths[0]) };
  });
  // Буфер обмена через main: работает при любом фокусе и без разрешений страницы.
  I.handle('kosmo:term.clipboard', (p = {}) => {
    const cb = ctx.electron.clipboard;
    if (p && typeof p.text === 'string') { cb.writeText(p.text); return true; }
    return cb.readText();
  });
  I.on('kosmo:term.focusState', (p, meta) => { termFocused = !!(p && p.focused) && !!meta && meta.kind === 'ui'; });

  // Пока фокус в терминале: Ctrl/Alt+клавиша (без Shift) — оболочке (Ctrl+R, Ctrl+L, Ctrl+W, Ctrl+T, Ctrl+D…).
  // Браузеру остаются F-клавиши, Ctrl+Shift+…, Ctrl+Tab, Ctrl+PageUp/PageDown, Ctrl+1…9.
  function shellOwnsKey(input) {
    const combo = ctx.commands.comboFromInput ? ctx.commands.comboFromInput(input) : '';
    if (!combo) return false;
    const parts = combo.split('+');
    const key = parts.pop();
    if (parts.includes('Shift') || parts.includes('Meta')) return false;
    if (!parts.includes('Ctrl') && !parts.includes('Alt')) return false;
    if (/^F\d{1,2}$/.test(key) || key === 'Tab' || key === 'PageUp' || key === 'PageDown' || /^[1-9]$/.test(key)) return false;
    return true;
  }
  if (ctx.commands && typeof ctx.commands.addBypass === 'function') {
    ctx.commands.addBypass((input, source, wc) => {
      if (source !== 'panel' || !termFocused) return false;
      const pw = ctx.panel.webContents && ctx.panel.webContents();
      return !!pw && wc === pw && shellOwnsKey(input);
    });
  }
  // Панель перезагрузилась или пересоздана — фокус терминала сбрасывается.
  ctx.panel.on('view-created', (_v, wc) => {
    termFocused = false;
    wc.on('did-start-loading', () => { termFocused = false; });
  });
  // Прогрев: node-pty (нативный модуль) и проверка conpty.dll — пока пользователь смотрит на пустой терминал,
  // а не в момент нажатия «Запустить» (первая сессия иначе блокирует main на ~0,8 с).
  let warmed = false;
  const warm = () => {
    if (warmed || sessions.size || ctx.panel.tool() !== 'claude') return;
    warmed = true;
    setTimeout(() => {
      if (sessions.size) return;
      const t0 = Date.now();
      try { pty(); if (IS_WIN) conptyDllAvailable(); } catch (e) { ctx.log('terminal', 'прогрев node-pty:', e.message); return; }
      ctx.log('terminal', `node-pty загружен заранее за ${Date.now() - t0} мс`);
    }, 300);
  };
  ctx.panel.on('opened', warm);
  ctx.panel.on('tool-changed', warm);

  // ---------- команды ----------
  ctx.commands.register({
    id: 'claude.terminal', title: 'Терминал Claude', category: 'Claude', repeat: false,
    appMenu: { section: 'tools', order: 59 },
    run: () => {
      const s = lastClaude() || Array.from(sessions.values()).pop();
      if (s) show(s.id, true); else { ctx.panel.open('claude'); toPanel('kosmo:term.show', { id: null, focus: true }); }
    },
  });
  ctx.commands.register({
    id: 'claude.terminalNew', title: 'Новая сессия Claude', category: 'Claude', repeat: false,
    run: () => { try { open('claude'); } catch (e) { ctx.log('terminal', e.message); } },
  });

  // ---------- выход ----------
  const onQuit = () => {
    if (quitting) return;
    quitting = true;
    if (sessions.size) ctx.log('terminal', `выход: завершаю ${sessions.size} сесс.`);
    killAll(true);
  };
  ctx.app.on('before-quit', onQuit);
  process.once('exit', onQuit);

  ctx.terminal = {
    pasteToClaude,
    open,
    create: (o) => create(o || {}),
    list,
    write,
    kill,
    restart: (id, o) => restart(id, o || {}),
    show,
    info: terminalInfo,
    // для проверок: что будет запущено (без запуска)
    describe: (profile, o) => { const sp = buildSpawn(profile, o || {}); return { file: sp.file, args: sp.args, shell: sp.shell, claude: sp.claude || null }; },
    _session: (id) => sessions.get(Number(id)) || null,
    get focused() { return termFocused; },
  };
}

module.exports = { id: 'claude-terminal', init };
