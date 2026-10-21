#!/usr/bin/env node
// CLI-клиент MCP моста Космолёта (claude-bridge) для проверок.
//   node tools/mcp-call.mjs --port N --token T list
//   node tools/mcp-call.mjs --port N --token T call <tool> '<json>'
//   node tools/mcp-call.mjs --profile f-bridge call snapshot '{"mode":"interactive"}'   (порт и токен — из .profiles/<p>/settings.json)
// Опции: --out <папка> (куда сохранять картинки, по умолчанию tools/dev-out/mcp), --raw (печатать JSON ответа), --url <полный адрес>.
// Картинки из ответа сохраняются в файлы, печатается путь. Код выхода 1 — ошибка инструмента или соединения.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = { port: null, token: process.env.KOSMO_MCP_TOKEN || null, profile: null, out: path.join(ROOT, 'tools', 'dev-out', 'mcp'), raw: false, url: null };
const rest = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const eq = a.indexOf('=');
  const key = a.startsWith('--') ? (eq > 0 ? a.slice(2, eq) : a.slice(2)) : null;
  const val = () => (eq > 0 ? a.slice(eq + 1) : argv[++i]);
  if (key === 'port') opt.port = Number(val());
  else if (key === 'token') opt.token = val();
  else if (key === 'profile') opt.profile = val();
  else if (key === 'out') opt.out = path.resolve(val());
  else if (key === 'url') opt.url = val();
  else if (key === 'raw') opt.raw = true;
  else rest.push(a);
}

if (opt.profile) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(ROOT, '.profiles', opt.profile, 'settings.json'), 'utf8'));
    if (!opt.token) opt.token = s.claude && s.claude.token;
    if (!opt.port) opt.port = s.claude && s.claude.mcpPort;
  } catch (e) { console.error('не прочитаны настройки профиля:', e.message); process.exit(2); }
}

const [cmd, ...params] = rest;
const usage = 'Использование: node tools/mcp-call.mjs --port N --token T list | call <tool> [\'<json>\']  (или --profile <имя>)';
if (!cmd || !['list', 'call'].includes(cmd)) { console.error(usage); process.exit(2); }
const url = opt.url || `http://127.0.0.1:${opt.port || 47321}/mcp`;
if (!opt.token) { console.error('нужен --token (или --profile, или переменная KOSMO_MCP_TOKEN)'); process.exit(2); }

const client = new Client({ name: 'kosmolet-mcp-call', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${opt.token}` } } });

function saveImage(item, i) {
  fs.mkdirSync(opt.out, { recursive: true });
  const ext = (item.mimeType || 'image/png').split('/')[1].replace('jpeg', 'jpg');
  const file = path.join(opt.out, `shot-${new Date().toISOString().replace(/[:.]/g, '-')}-${i}.${ext}`);
  fs.writeFileSync(file, Buffer.from(item.data, 'base64'));
  return file;
}

let exitCode = 0;
try {
  await client.connect(transport);
  if (cmd === 'list') {
    const r = await client.listTools();
    if (opt.raw) console.log(JSON.stringify(r, null, 2));
    else {
      const ins = client.getInstructions && client.getInstructions();
      if (ins) console.log('Инструкции сервера:\n' + ins + '\n');
      console.log(`${r.tools.length} инструментов:`);
      for (const t of r.tools) {
        const props = Object.keys((t.inputSchema && t.inputSchema.properties) || {});
        const req = (t.inputSchema && t.inputSchema.required) || [];
        console.log(`- ${t.name}(${props.map((p) => (req.includes(p) ? p : p + '?')).join(', ')})`);
        console.log(`    ${t.description}`);
      }
    }
  } else {
    const name = params[0];
    if (!name) { console.error(usage); process.exit(2); }
    let args = {};
    if (params[1]) {
      try { args = JSON.parse(params[1]); } catch (e) { console.error('аргументы — не JSON:', e.message); process.exit(2); }
    }
    const t0 = Date.now();
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
    const ms = Date.now() - t0;
    if (opt.raw) {
      const copy = JSON.parse(JSON.stringify(r));
      for (const c of copy.content || []) if (c.type === 'image') c.data = `<${c.data.length} base64 chars>`;
      console.log(JSON.stringify(copy, null, 2));
    }
    let i = 0;
    for (const c of r.content || []) {
      if (c.type === 'text') { if (!opt.raw) console.log(c.text); }
      else if (c.type === 'image') console.log(`[картинка ${c.mimeType}, ${Math.round(c.data.length * 3 / 4 / 1024)} КБ] → ${saveImage(c, i++)}`);
      else if (!opt.raw) console.log(JSON.stringify(c));
    }
    console.error(`(${name}: ${ms} мс${r.isError ? ', ОШИБКА' : ''})`);
    if (r.isError) exitCode = 1;
  }
} catch (e) {
  console.error('Ошибка MCP:', e && e.message ? e.message : e);
  exitCode = 1;
} finally {
  try { await client.close(); } catch (_) { /* уже закрыт */ }
}
// Без process.exit: на Windows он роняет libuv при закрытии сокетов (assert в async.c).
process.exitCode = exitCode;
