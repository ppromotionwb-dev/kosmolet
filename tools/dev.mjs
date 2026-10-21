#!/usr/bin/env node
// CLI к dev-серверу Космолёта (ARCHITECTURE §2).
// node tools/dev.mjs --port <n> eval "<code>" | eval --file <path> | eval - (код из stdin) | shot [file] | quit | health | logs [n]
import fs from 'node:fs';

const args = process.argv.slice(2);
let port = 47399;
const rest = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--port' || a === '-p') { port = Number(args[++i]); continue; }
  if (a.startsWith('--port=')) { port = Number(a.slice(7)); continue; }
  rest.push(a);
}
const [cmd, ...params] = rest;

async function call(method, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { status: res.status, text }; }
}

function readStdin() {
  return new Promise((resolve) => {
    let s = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { s += c; });
    process.stdin.on('end', () => resolve(s));
  });
}

async function main() {
  let out;
  switch (cmd) {
    case 'health': out = await call('GET', '/health'); break;
    case 'logs': out = await call('GET', '/logs?n=' + (Number(params[0]) || 200)); break;
    case 'eval': {
      let code;
      if (params[0] === '--file') code = fs.readFileSync(params[1], 'utf8');
      else if (params[0] === '-' || params.length === 0) code = await readStdin();
      else code = params.join(' ');
      out = await call('POST', '/eval', { code });
      break;
    }
    case 'shot': out = await call('POST', '/shot', params[0] ? { file: params[0] } : {}); break;
    case 'quit': out = await call('POST', '/quit', {}); break;
    default:
      console.error('Использование: node tools/dev.mjs --port <n> eval "<code>" | eval --file <path> | eval - | shot [file] | quit | health | logs [n]');
      process.exit(2);
  }
  if (cmd === 'logs' && out && Array.isArray(out.logs)) {
    for (const l of out.logs) console.log(new Date(l.ts).toTimeString().slice(0, 8), `[${l.scope}]`, l.line);
  } else {
    console.log(JSON.stringify(out, null, 2));
  }
  if (out && out.error) process.exit(1);
}

main().catch((e) => {
  console.error('dev-сервер недоступен:', e.cause ? e.cause.code || e.cause.message : e.message);
  process.exit(1);
});
