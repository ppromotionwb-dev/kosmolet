'use strict';
// Подключение Claude Code к мосту (claude-bridge):
// - команда `claude mcp add --scope user --transport http kosmolet <url> --header "Authorization: Bearer <token>"`
//   (только по нажатию пользователя; если сервер уже есть — `claude mcp remove kosmolet -s user` и добавить заново);
// - userData/gen/claude-mcp.json для `claude --mcp-config` во встроенном терминале.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const NAME = 'kosmolet';

function createConnect(ctx, getConfig) {
  function url() { return `http://127.0.0.1:${getConfig().port}/mcp`; }

  function claudeBin() {
    const c = String(ctx.settings.peek('claude.claudeCommand') || 'claude').trim();
    return c || 'claude';
  }
  // Для cmd.exe: путь с пробелами — в кавычках; кавычки и спецсимволы не пропускаем.
  function quoteBin(b) {
    if (/["&|<>^%\r\n]/.test(b)) throw new Error('недопустимые символы в команде claude: ' + b);
    return /\s/.test(b) ? `"${b}"` : b;
  }

  function addArgs(mask) {
    const { token } = getConfig();
    return ['mcp', 'add', '--scope', 'user', '--transport', 'http', NAME, url(), '--header', `Authorization: Bearer ${mask ? '<token>' : token}`];
  }
  function removeArgs() { return ['mcp', 'remove', NAME, '-s', 'user']; }

  function display(args) {
    return [claudeBin()].concat(args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))).join(' ');
  }
  // Команда для копирования (с настоящим токеном).
  function command() { return display(addArgs(false)); }

  function run(args, timeoutMs = 60000) {
    return new Promise((resolve) => {
      const bin = quoteBin(claudeBin());
      const line = [bin].concat(args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))).join(' ');
      let out = '';
      let child;
      try {
        child = process.platform === 'win32'
          ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { windowsVerbatimArguments: true, windowsHide: true, env: process.env })
          : spawn('/bin/sh', ['-lc', line], { env: process.env });
      } catch (e) { resolve({ code: -1, out: e.message }); return; }
      const t = setTimeout(() => { out += '\n[превышено время ожидания]'; try { child.kill(); } catch (_) { /* уже */ } }, timeoutMs);
      child.stdout.on('data', (d) => { out += d.toString('utf8'); });
      child.stderr.on('data', (d) => { out += d.toString('utf8'); });
      child.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out: out + e.message }); });
      child.on('close', (code) => { clearTimeout(t); resolve({ code, out: out.trim() }); });
    });
  }

  // dryRun: вернуть, что было бы выполнено (для проверок), ничего не запуская.
  async function connectClaudeCode(opts = {}) {
    const steps = [];
    if (opts.dryRun) {
      return {
        ok: true, dryRun: true,
        commands: [display(addArgs(true)), `(если уже есть) ${display(removeArgs())}`, `затем снова ${display(addArgs(true))}`],
        argv: { bin: claudeBin(), add: addArgs(true), remove: removeArgs() },
        output: 'Пробный режим: команды не запускались.',
      };
    }
    ctx.log('bridge', 'подключение Claude Code:', display(addArgs(true)));
    let r = await run(addArgs(false));
    steps.push(r.out);
    if (r.code !== 0 && /already exists/i.test(r.out)) {
      const rm = await run(removeArgs());
      steps.push(rm.out);
      r = await run(addArgs(false));
      steps.push(r.out);
    }
    let output = steps.filter(Boolean).join('\n').replace(new RegExp(getConfig().token || '\\0', 'g'), '<token>');
    if (r.code !== 0 && /not recognized|не является внутренней|not found|ENOENT/i.test(output)) {
      output = `Команда «${claudeBin()}» не найдена. Установите Claude Code или укажите путь к claude в настройках («Команда claude»).\n\n${output}`;
    }
    ctx.log('bridge', `подключение Claude Code: код ${r.code}`);
    return { ok: r.code === 0, code: r.code, output: output || (r.code === 0 ? 'Готово' : 'Ошибка без вывода') };
  }

  function configPath() { return path.join(ctx.paths.userData, 'gen', 'claude-mcp.json'); }
  let lastWritten = '';
  function writeConfig() {
    const { token } = getConfig();
    const data = { mcpServers: { [NAME]: { type: 'http', url: url(), headers: { Authorization: `Bearer ${token}` } } } };
    const text = JSON.stringify(data, null, 2);
    const file = configPath();
    if (text === lastWritten && fs.existsSync(file)) return file;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, text, 'utf8');
      fs.renameSync(tmp, file);
      lastWritten = text;
    } catch (e) { ctx.log('bridge', 'не записан claude-mcp.json:', e.message); }
    return file;
  }

  return { connectClaudeCode, command, display, addArgs, removeArgs, configPath, writeConfig, url, NAME };
}

module.exports = { createConnect };
