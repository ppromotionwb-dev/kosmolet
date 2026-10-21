'use strict';
// Сборка tab-preload (ARCHITECTURE §12): src/preload/tab/*.js + части от ctx.preload.addPart → userData/gen/tab-preload.js.
// Все части сортируются по имени вместе с файлами (имя части как имя файла: '19-darkreader-lib').

const fs = require('fs');
const path = require('path');
const { INTERNAL_HOSTS } = require('./sessions');

function createPreloadComposer(ctx) {
  const dir = path.join(ctx.paths.src, 'preload', 'tab');
  const outFile = path.join(ctx.paths.userData, 'gen', 'tab-preload.js');
  const extra = new Map(); // name → { file?, code?, raw }
  let built = false;

  // addPart(name, filePath) | addPart(name, { code }) | addPart(name, { file, raw: true })
  function addPart(name, src) {
    name = String(name || '').trim();
    if (!name) throw new Error('preload.addPart: нужно имя части');
    let part;
    if (typeof src === 'string') part = { file: src, raw: false };
    else if (src && typeof src === 'object' && (typeof src.code === 'string' || typeof src.file === 'string')) {
      part = { file: src.file, code: src.code, raw: !!src.raw };
    } else throw new Error('preload.addPart: нужен путь к файлу или { code }');
    if (built) ctx.log('preload', `часть ${name} добавлена после сборки — попадёт только после rebuild()`);
    extra.set(name, part);
  }

  function removePart(name) { return extra.delete(String(name)); }

  function collect() {
    const parts = [];
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')); } catch (_) { files = []; }
    for (const f of files) parts.push({ name: f, file: path.join(dir, f), raw: false });
    for (const [name, p] of extra) parts.push(Object.assign({ name }, p));
    parts.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return parts;
  }

  function header() {
    return [
      '// Собрано preload-composer.js при старте Космолёта — не править вручную.',
      "const { ipcRenderer, contextBridge, webFrame } = require('electron');",
      'const KOSMO = (function () {',
      `  const INTERNAL_HOSTS = ${JSON.stringify(INTERNAL_HOSTS)};`,
      "  let url = null; try { url = new URL(location.href); } catch (e) {}",
      "  const protocol = url ? url.protocol : '';",
      "  const host = url ? url.hostname : '';",
      '  let isTop = true; try { isTop = window.top === window; } catch (e) { isTop = false; }',
      "  const isInternal = protocol === 'kosmo:' && INTERNAL_HOSTS.indexOf(host) >= 0 && isTop;",
      "  const okTab = (ch) => typeof ch === 'string' && ch.indexOf('kosmo-tab:') === 0;",
      '  return {',
      '    ipcRenderer, contextBridge, webFrame, isInternal, host, protocol, isTop, INTERNAL_HOSTS,',
      "    send(ch, p) { if (!okTab(ch)) throw new Error('канал не разрешён: ' + ch); ipcRenderer.send(ch, p); },",
      "    invoke(ch, p) { if (!okTab(ch)) return Promise.reject(new Error('канал не разрешён: ' + ch)); return ipcRenderer.invoke(ch, p); },",
      "    sendSync(ch, p) { if (!okTab(ch)) throw new Error('канал не разрешён: ' + ch); return ipcRenderer.sendSync(ch, p); },",
      '  };',
      '})();',
      '',
    ].join('\n');
  }

  function wrap(name, code, raw) {
    const label = JSON.stringify(name);
    if (raw) return `// ---- часть ${name} (raw) ----\n${code}\n`;
    return `// ---- часть ${name} ----\ntry { (function (KOSMO) {\n${code}\n})(KOSMO); } catch (e) { console.error('[kosmo preload] ' + ${label}, e); }\n`;
  }

  function build() {
    const out = [header()];
    const used = [];
    for (const p of collect()) {
      let code = p.code;
      if (code == null) {
        try { code = fs.readFileSync(p.file, 'utf8'); } catch (e) {
          ctx.log('preload', `не прочитана часть ${p.name}:`, e.message);
          continue;
        }
      }
      // Части не должны ломать соседей синтаксисом — проверяем заранее.
      try {
        // eslint-disable-next-line no-new-func
        new Function('KOSMO', 'require', code);
      } catch (e) {
        if (!p.raw) {
          ctx.log('preload', `синтаксическая ошибка в части ${p.name}, пропущена:`, e.message);
          continue;
        }
      }
      out.push(wrap(p.name, code, p.raw));
      used.push(p.name);
    }
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const tmp = outFile + '.tmp';
    fs.writeFileSync(tmp, out.join('\n'), 'utf8');
    fs.renameSync(tmp, outFile);
    built = true;
    ctx.log('preload', `собран tab-preload: ${used.join(', ')}`);
    return outFile;
  }

  return {
    addPart,
    removePart,
    build,
    rebuild: build,
    path: outFile,
    parts: () => collect().map((p) => p.name),
    get built() { return built; },
  };
}

module.exports = { createPreloadComposer };
