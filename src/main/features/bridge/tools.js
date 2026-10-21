'use strict';
// Инструменты MCP моста (claude-bridge). Описания — по-английски (их читает Claude), результаты — компактный текст.
// Список инструментов один для всех режимов (Claude Code кэширует список), режим доступа проверяется при вызове:
// read — только инструменты чтения, full — всё.

const READ = 'read';
const FULL = 'full';

const INSTRUCTIONS = [
  'Космолёт (Kosmolet) is the user\'s own browser; these tools see and control its real tabs, with the user\'s logins.',
  'tabId is optional everywhere: by default the active tab is used (tabs_list shows ids).',
  'Typical loop: snapshot -> act by ref (click/type/select_option) -> snapshot again. Refs like e12 come from snapshot/find/picked_element and stay valid for the same element until the page navigates or re-renders it.',
  'click/type/press_key send real (trusted) input events and report navigation or new tabs.',
  'For site data prefer network_requests/network_request (what the page already loaded) or page_fetch (fetch inside the page with its cookies) over scraping HTML.',
  'picked_element returns the element the user pointed at with the picker (Ctrl+Shift+E).',
  'The user sets the access mode: read = only reading tools, full = everything.',
].join('\n');

function clip(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function fmtBytes(n) {
  if (n == null || isNaN(n)) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
function readableUrl(u) { try { return decodeURI(u); } catch (_) { return String(u || ''); } }
function fmtTime(ts) {
  const d = new Date(ts);
  const p = (x, n = 2) => String(x).padStart(n, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
function truncNote(text, max, what) {
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n…[${what || 'truncated'}: showing ${max} of ${text.length} chars; raise maxChars to see more]`;
}

// Сериализатор результата eval_js (выполняется в странице).
const SERIALIZER = `function (v) {
  const seen = new WeakSet();
  const walk = (x, d) => {
    if (x === undefined) return { __u: 1 };
    if (x === null || typeof x === 'boolean' || typeof x === 'string') return x;
    if (typeof x === 'number') return isFinite(x) ? x : String(x);
    if (typeof x === 'bigint') return x.toString() + 'n';
    if (typeof x === 'symbol') return x.toString();
    if (typeof x === 'function') return '[Function ' + (x.name || 'anonymous') + ']';
    if (typeof Node !== 'undefined' && x instanceof Node) {
      if (x.nodeType === 1) return '<' + x.tagName.toLowerCase() + (x.id ? '#' + x.id : '') + (x.classList && x.classList.length ? '.' + Array.from(x.classList).slice(0, 3).join('.') : '') + '>';
      if (x.nodeType === 3) return '#text ' + JSON.stringify(String(x.data).slice(0, 200));
      return '[' + (x.nodeName || 'Node') + ']';
    }
    if (x instanceof Error) return { error: x.name + ': ' + x.message };
    if (x instanceof Date) return x.toISOString();
    if (x instanceof RegExp) return String(x);
    if (seen.has(x)) return '[Circular]';
    if (d > 7) return '[…]';
    seen.add(x);
    if (Array.isArray(x) || (typeof NodeList !== 'undefined' && x instanceof NodeList) || (typeof HTMLCollection !== 'undefined' && x instanceof HTMLCollection)) {
      const a = Array.from(x); const out = a.slice(0, 1000).map((y) => walk(y, d + 1));
      if (a.length > 1000) out.push('…(' + a.length + ' items)');
      return out;
    }
    if (x instanceof Map) return { '[Map]': walk(Array.from(x.entries()).slice(0, 500), d + 1) };
    if (x instanceof Set) return { '[Set]': walk(Array.from(x.values()).slice(0, 500), d + 1) };
    if (ArrayBuffer.isView(x)) return '[' + x.constructor.name + ' ' + x.length + ']';
    const o = {}; let n = 0;
    for (const k in x) { if (n++ >= 500) { o['…'] = 'more keys'; break; } let val; try { val = x[k]; } catch (e) { val = '[unreadable]'; } o[k] = walk(val, d + 1); }
    return o;
  };
  const r = walk(v, 0);
  if (r && r.__u === 1) return 'undefined';
  const s = JSON.stringify(r, (k, val) => (val && val.__u === 1 ? '[undefined]' : val), 2);
  return s === undefined ? 'undefined' : s;
}`;

function createTools(ctx, deps) {
  const { actions: A, activity, picker, getAccess } = deps;
  let defs = null;

  function result(r) {
    if (r && typeof r === 'object' && Array.isArray(r.content)) return r;
    return { content: [{ type: 'text', text: String(r == null ? 'OK' : r) }] };
  }

  // ---------- вызов с журналом ----------
  async function invoke(d, args) {
    const t0 = Date.now();
    const call = {
      tabId: null,
      logArgs: args,
      tab(t) { call.tabId = t.id; try { ctx.tabs.markClaude(t.id); } catch (_) { /* закрыта */ } return t; },
    };
    let res;
    let err = null;
    try {
      const mode = getAccess();
      if (mode === 'off') throw new Error('Космолёт: Claude access is off. Ask the user to enable it (Claude button in the toolbar).');
      if (d.access === FULL && mode !== FULL) {
        throw new Error(`Blocked: Космолёт access mode is "read" (read-only), so ${d.name} is not allowed. Ask the user to switch Claude access to "full" in the browser (Claude button in the toolbar) if this action is needed.`);
      }
      res = result(await d.run(args || {}, call));
    } catch (e) {
      err = e;
      res = { content: [{ type: 'text', text: String((e && e.message) || e) }], isError: true };
    }
    if (call.tabId != null) { try { ctx.tabs.markClaude(call.tabId); } catch (_) { /* закрыта */ } }
    activity.add({ tool: d.name, args: call.logArgs, tabId: call.tabId, ok: !err, ms: Date.now() - t0, error: err ? String(err.message || err) : undefined });
    return res;
  }

  // ---------- общие куски ----------
  async function webTab(args, call, opts) {
    const tab = call.tab(await A.liveTab(args.tabId, Object.assign({ web: true }, opts)));
    A.assertWebPage(tab);
    return tab;
  }
  function tabLine(t) {
    const flags = [];
    if (t.containerId && t.containerId !== 'main') flags.push('container ' + (t.containerName || t.containerId));
    if (t.loading) flags.push('loading');
    if (t.discarded) flags.push('unloaded');
    if (t.pinned) flags.push('pinned');
    if (t.audible) flags.push('playing audio');
    if (t.crashed) flags.push('crashed');
    if (t.error) flags.push('load error ' + t.error);
    return `${t.active ? '*' : ' '} [${t.id}] ${clip(t.title || '(no title)', 90)} — ${clip(readableUrl(t.url), 200)}${flags.length ? ' (' + flags.join(', ') + ')' : ''}`;
  }
  function resolveContainer(c) {
    if (c == null || c === '') return undefined;
    const list = ctx.sessions.containers();
    const s = String(c).toLowerCase();
    const hit = list.find((x) => x.id.toLowerCase() === s) || list.find((x) => String(x.name).toLowerCase() === s);
    if (!hit) throw new Error(`unknown container "${c}". Available: ${list.map((x) => `${x.id} (${x.name})`).join(', ')}`);
    return hit.id;
  }
  function checkUrl(u) {
    const s = String(u || '').trim();
    if (!s) throw new Error('url is required');
    if (/^(kosmo|javascript|devtools|chrome|chrome-extension|view-source|file):/i.test(s) && !/^kosmo:\/\/newtab\/?$/i.test(s)) {
      throw new Error('this URL scheme is not allowed for Claude: ' + s.split(':')[0]);
    }
    return s;
  }
  async function target(tab, args, needVisible = true) {
    if (args.ref || args.selector) {
      const loc = await A.lib(tab, 'locate', { ref: args.ref, selector: args.selector });
      if (needVisible && !loc.visible) throw new Error(`element is not visible: ${loc.desc}. Scroll, open its container, or pick another element.`);
      if (needVisible && (loc.x < 0 || loc.y < 0 || loc.x >= loc.vw || loc.y >= loc.vh)) throw new Error(`element is outside the viewport after scrolling: ${loc.desc}`);
      return loc;
    }
    if (typeof args.x === 'number' && typeof args.y === 'number') return { x: args.x, y: args.y, hit: true, desc: `point (${args.x}, ${args.y})` };
    throw new Error('ref, selector or x+y is required');
  }
  function mods(list) {
    const map = { control: 'control', ctrl: 'control', shift: 'shift', alt: 'alt', meta: 'meta' };
    return (list || []).map((m) => map[String(m).toLowerCase()]).filter(Boolean);
  }
  async function cdpReady(tab) {
    if (!ctx.cdp || typeof ctx.cdp.network !== 'function') throw new Error('network capture is not available in this build (devtools feature missing)');
    try { await ctx.cdp.ensure(tab.id); } catch (e) { throw new Error('could not attach to the tab: ' + e.message); }
    let note = '';
    try {
      const inf = typeof ctx.cdp.info === 'function' ? ctx.cdp.info(tab.id) : null;
      if (inf && inf.mode === 'off' && typeof ctx.cdp.captureTab === 'function') {
        await ctx.cdp.captureTab(tab.id, 'api');
        note = 'Network capture was off for this tab; it is on now — reload the page or repeat the action to record requests.';
      }
    } catch (_) { /* не критично */ }
    return note;
  }
  function sessionFor(args) {
    let containerId = 'main';
    if (args.tabId != null) containerId = A.getTab(args.tabId).info.containerId;
    else if (args.container) containerId = resolveContainer(args.container);
    else { const a = ctx.tabs.active(); if (a) containerId = a.info.containerId; }
    return { ses: ctx.sessions.get(containerId), containerId };
  }

  // ---------- определения ----------
  function build() {
    if (defs) return defs;
    const z = require('zod');
    const tabId = z.number().optional().describe('Tab id from tabs_list; default: the active tab');
    const ref = z.string().optional().describe('Element ref from snapshot/find, e.g. "e12"');
    const selector = z.string().optional().describe('CSS selector (use "host >>> inner" to pierce shadow DOM)');
    const maxChars = (d) => z.number().optional().describe(`Max characters of output (default ${d})`);

    defs = [
      // ===== чтение =====
      {
        name: 'tabs_list', access: READ,
        description: 'List open tabs: id, title, URL, state. The active tab is marked with *. Example: {}',
        input: {},
        annotations: { readOnlyHint: true },
        async run() {
          const list = ctx.tabs.list();
          const lines = list.map(tabLine);
          return `${list.length} tabs (* = active, ids are stable while the tab lives):\n${lines.join('\n')}`;
        },
      },
      {
        name: 'page_info', access: READ,
        description: 'Basic facts about a tab: URL, title, loading state, container, zoom, viewport and document size, scroll position, focused element, selected text. Example: {"tabId": 3}',
        input: { tabId },
        annotations: { readOnlyHint: true },
        async run(args, call) {
          const tab = call.tab(A.getTab(args.tabId));
          const i = ctx.tabs.list().find((x) => x.id === tab.id) || tab.info;
          const lines = [
            `Tab [${tab.id}] ${i.active ? '(active)' : '(background)'}`,
            `URL: ${i.url}`,
            `Title: ${i.title || '(no title)'}`,
            `Loading: ${i.loading ? 'yes' : 'no'}${i.discarded ? ' (tab is unloaded from memory; it loads on first use)' : ''}${i.crashed ? ' (crashed)' : ''}`,
            `Container: ${i.containerName || i.containerId} (${i.containerId})`,
            `Zoom: ${Math.round((tab.wc && !tab.wc.isDestroyed() ? tab.wc.getZoomFactor() : i.zoom || 1) * 100)}%`,
            `History: back ${i.canGoBack ? 'yes' : 'no'}, forward ${i.canGoForward ? 'yes' : 'no'}`,
          ];
          if (tab.wc && !tab.wc.isDestroyed() && !/^(kosmo|devtools|chrome):/i.test(tab.wc.getURL())) {
            try {
              const p = await A.lib(tab, 'info', {}, 5000);
              lines.push(`Ready state: ${p.readyState}`);
              lines.push(`Viewport: ${p.vw}×${p.vh} CSS px, device pixel ratio ${p.dpr}`);
              lines.push(`Document: ${p.dw}×${p.dh}, scroll ${p.sx},${p.sy}`);
              lines.push(`Elements: ${p.elements}${p.lang ? ', lang ' + p.lang : ''}`);
              if (p.focused) lines.push(`Focused: ${p.focused}`);
              if (p.selection) lines.push(`Selected text: ${clip(p.selection.replace(/\s+/g, ' '), 300)}`);
            } catch (e) { lines.push(`(page details unavailable: ${e.message})`); }
          }
          return lines.join('\n');
        },
      },
      {
        name: 'snapshot', access: READ,
        description: 'Readable snapshot of the page for AI: title, URL, the visible text in reading order and every interactive element with a ref, e.g. [e12] button "Купить", [e13] link "Docs" → /docs, [e14] textbox "Search" name=q value="" placeholder="...", select with options, checkboxes. Includes open shadow roots and same-origin iframes. Modes: full (text + elements, default), interactive (elements and headings only), text (text only). Example: {"mode": "interactive", "visibleOnly": true}',
        input: {
          tabId,
          mode: z.enum(['full', 'interactive', 'text']).optional().describe('full (default) | interactive | text'),
          visibleOnly: z.boolean().optional().describe('Only what is inside the viewport now (default false = whole page)'),
          selector: z.string().optional().describe('Snapshot only this subtree, e.g. "main" or "#content"'),
          maxChars: maxChars(20000),
        },
        annotations: { readOnlyHint: true },
        async run(args, call) {
          const tab = await webTab(args, call);
          const text = await A.lib(tab, 'snapshot', { mode: args.mode, visibleOnly: args.visibleOnly, selector: args.selector, maxChars: args.maxChars || 20000 }, 20000);
          return `Tab [${tab.id}]\n${text}`;
        },
      },
      {
        name: 'get_html', access: READ,
        description: 'HTML of the whole document or of one element (by ref or selector). Scripts, styles and SVG internals are stripped by default; long attribute values are shortened. Example: {"selector": "#price"}',
        input: {
          tabId, ref, selector,
          keepScripts: z.boolean().optional().describe('Keep <script>/<style> (default false)'),
          keepSvg: z.boolean().optional().describe('Keep SVG contents (default false)'),
          maxChars: maxChars(30000),
        },
        annotations: { readOnlyHint: true },
        async run(args, call) {
          const tab = await webTab(args, call);
          const r = await A.lib(tab, 'html', { ref: args.ref, selector: args.selector, keepScripts: args.keepScripts, keepSvg: args.keepSvg, maxChars: args.maxChars || 30000 }, 20000);
          return `HTML of ${r.desc} (${r.total} chars${r.truncated ? ', truncated' : ''}):\n${r.html}${r.truncated ? `\n…[truncated at ${args.maxChars || 30000} of ${r.total} chars]` : ''}`;
        },
      },
      {
        name: 'find', access: READ,
        description: 'Find elements by visible text (also aria-label, placeholder, title, alt) or by CSS selector and get their refs for click/type. Text search is case-insensitive substring unless exact=true. Example: {"text": "В корзину"} or {"selector": "button[type=submit]"}',
        input: {
          tabId,
          text: z.string().optional().describe('Text to look for'),
          selector: z.string().optional().describe('CSS selector'),
          exact: z.boolean().optional().describe('Exact text match (default false)'),
          includeHidden: z.boolean().optional().describe('Also list hidden elements (default false)'),
          limit: z.number().optional().describe('Max results (default 20)'),
        },
        annotations: { readOnlyHint: true },
        async run(args, call) {
          const tab = await webTab(args, call);
          if (!args.text && !args.selector) throw new Error('text or selector is required');
          const r = await A.lib(tab, 'find', args, 15000);
          if (!r.lines.length) return `Nothing found for ${args.selector ? 'selector ' + args.selector : JSON.stringify(args.text)}.`;
          return `${r.lines.length} match(es):\n${r.lines.join('\n')}`;
        },
      },
      {
        name: 'screenshot', access: READ,
        description: 'JPEG screenshot of the visible area (default), the full page (fullPage=true) or one element (ref/selector). Width is limited to 1600 px. Example: {"fullPage": true}',
        input: {
          tabId, ref, selector,
          fullPage: z.boolean().optional().describe('Capture the whole page height (up to 12000 px)'),
          quality: z.number().optional().describe('JPEG quality 30–95 (default 75)'),
          maxWidth: z.number().optional().describe('Max image width (default and max 1600)'),
        },
        annotations: { readOnlyHint: true },
        async run(args, call) {
          const tab = await webTab(args, call);
          let clipRect = null;
          let what = args.fullPage ? 'full page' : 'viewport';
          if (args.ref || args.selector) {
            const loc = await A.lib(tab, 'locate', { ref: args.ref, selector: args.selector });
            await A.sleep(250);
            clipRect = { x: loc.rect.x, y: loc.rect.y, w: loc.rect.w, h: loc.rect.h, vw: loc.vw };
            what = loc.desc;
          }
          const shot = await A.capture(tab, { fullPage: !!args.fullPage && !clipRect, clip: clipRect, quality: args.quality, maxWidth: args.maxWidth });
          return {
            content: [
              { type: 'image', data: shot.data, mimeType: 'image/jpeg' },
              { type: 'text', text: `Screenshot of ${what}, tab [${tab.id}] ${tab.wc.getURL()} — ${shot.width}×${shot.height}, ${fmtBytes(shot.bytes)}${shot.note}` },
            ],
          };
        },
      },
      {
        name: 'network_requests', access: READ,
        description: 'Requests the page made (from the built-in network capture): id, method, status, type, size, time, URL; newest last. By default only API calls (XHR/fetch) and documents. Use network_request with an id for headers and body. Example: {"filter": "search", "limit": 30}',
        input: {
          tabId,
          filter: z.string().optional().describe('Substring of URL (supports the Network panel filter syntax, e.g. "status:200 method:POST")'),
          type: z.enum(['api', 'all', 'doc', 'js', 'css', 'img', 'media', 'font', 'ws', 'other']).optional().describe('Kind of requests (default api)'),
          limit: z.number().optional().describe('Max entries (default 50)'),
        },
        annotations: { readOnlyHint: true },
        async run(args, call) {
          const tab = call.tab(await A.liveTab(args.tabId));
          const note = await cdpReady(tab);
          const list = ctx.cdp.network(tab.id, { filter: args.filter, type: args.type || 'api', limit: Math.max(1, Math.min(500, args.limit || 50)) });
          const lines = list.map((e) => {
            const st = e.failed ? 'FAIL ' + clip(e.errorText || '', 30) : e.pending ? '…' : String(e.status || '—');
            return `#${e.id} ${e.method || 'GET'} ${st} ${e.type || ''} ${fmtBytes(e.size)} ${e.timeMs != null ? Math.round(e.timeMs) + 'ms' : ''}${e.fromCache ? ' (cache)' : ''} ${clip(readableUrl(e.url), 220)}`;
          });
          const head = `${list.length} request(s) in tab [${tab.id}]${args.filter ? ` matching "${args.filter}"` : ''}, type ${args.type || 'api'}${note ? '\n' + note : ''}`;
          return lines.length ? `${head}:\n${lines.join('\n')}` : `${head}. Nothing captured yet — reload the page or repeat the action, then call again.`;
        },
      },
      {
        name: 'network_request', access: READ,
        description: 'Details of one captured request: request/response headers, POST body, timing and the response body (text, truncated). Example: {"id": "123"}',
        input: {
          tabId,
          id: z.union([z.string(), z.number()]).describe('Request id from network_requests (without #)'),
          body: z.boolean().optional().describe('Include the response body (default true)'),
          maxChars: maxChars(20000),
        },
        annotations: { readOnlyHint: true },
        async run(args, call) {
          const tab = call.tab(await A.liveTab(args.tabId));
          await cdpReady(tab);
          const id = String(args.id).replace(/^#/, '');
          const e = await ctx.cdp.entry(tab.id, id);
          if (!e) throw new Error(`request #${id} not found in tab [${tab.id}] (the log may have been cleared); list them with network_requests`);
          const max = args.maxChars || 20000;
          const hdr = (h) => Object.entries(h || {}).map(([k, v]) => `  ${k}: ${clip(v, 2000)}`).join('\n') || '  (none)';
          const out = [
            `${e.method} ${e.url}`,
            `Status: ${e.failed ? 'failed — ' + (e.errorText || '') : (e.status || '—') + ' ' + (e.statusText || '')}${e.pending ? ' (pending)' : ''}`,
            `Type: ${e.type || ''} ${e.mime || ''}, size ${fmtBytes(e.size)}, time ${e.timeMs != null ? Math.round(e.timeMs) + ' ms' : '—'}${e.fromCache ? ', from cache' : ''}`,
            `Request headers${e.provisionalHeaders ? ' (provisional)' : ''}:\n${hdr(e.requestHeaders)}`,
          ];
          if (e.postData) out.push(`Request body:\n${truncNote(String(e.postData), Math.min(max, 20000))}`);
          out.push(`Response headers:\n${hdr(e.responseHeaders)}`);
          if (args.body !== false && !e.failed && !e.pending) {
            try {
              const b = await ctx.cdp.body(tab.id, id);
              if (b.base64Encoded) out.push(`Response body: binary, ${fmtBytes(Math.floor((b.body || '').length * 3 / 4))} (base64 not shown)`);
              else out.push(`Response body:\n${truncNote(b.body || '', max)}${b.truncated ? '\n…[body truncated by capture]' : ''}`);
            } catch (err) { out.push(`Response body: unavailable (${err.message})`); }
          }
          return out.join('\n');
        },
      },
      {
        name: 'console_logs', access: READ,
        description: 'Recent console messages of the page (log/info/warn/error), oldest first. Example: {"level": "error", "limit": 20}',
        input: {
          tabId,
          level: z.enum(['debug', 'log', 'info', 'warn', 'error']).optional().describe('Minimum level (default: all)'),
          filter: z.string().optional().describe('Substring filter'),
          limit: z.number().optional().describe('Max messages (default 50)'),
        },
        annotations: { readOnlyHint: true },
        async run(args, call) {
          const tab = call.tab(await A.liveTab(args.tabId));
          if (!ctx.cdp || typeof ctx.cdp.console !== 'function') throw new Error('console capture is not available in this build');
          try { await ctx.cdp.ensure(tab.id); } catch (_) { /* покажем что есть */ }
          let list = ctx.cdp.console(tab.id, { level: args.level, limit: 500 });
          list = list.filter((m) => !/^Electron Security Warning/.test(String(m.text)));
          if (args.filter) { const f = String(args.filter).toLowerCase(); list = list.filter((m) => String(m.text).toLowerCase().includes(f)); }
          list = list.slice(-Math.max(1, Math.min(500, args.limit || 50)));
          if (!list.length) return `No console messages${args.level ? ' at level ' + args.level + '+' : ''} in tab [${tab.id}].`;
          return list.map((m) => `${fmtTime(m.ts)} [${m.level}] ${clip(m.text, 1500)}${m.url ? ` (${clip(m.url, 120)}${m.line ? ':' + m.line : ''})` : ''}`).join('\n');
        },
      },
      {
        name: 'picked_element', access: READ,
        description: 'The element the user last pointed at with "Show Claude an element" (Ctrl+Shift+E or the context menu): selector, XPath, text, attributes, size, key styles, outerHTML and a ref usable with click/type. Example: {}',
        input: {},
        annotations: { readOnlyHint: true },
        async run(args, call) {
          const p = picker.last();
          if (!p) return 'Nothing picked yet. Ask the user to press Ctrl+Shift+E in Космолёт and click an element (or right-click → "Показать Claude этот элемент").';
          let ref = '';
          const tab = ctx.tabs.get(p.tabId);
          if (tab) call.tab(tab);
          if (tab && tab.wc && !tab.wc.isDestroyed() && tab.wc.getURL() === p.url && p.selector) {
            try { const r = await A.lib(tab, 'refFor', { selector: p.selector }, 5000); ref = r.ref; } catch (_) { ref = ''; }
          }
          const attrs = Object.entries(p.attributes || {}).map(([k, v]) => `  ${k}="${clip(v, 300)}"`).join('\n');
          const styles = Object.entries(p.styles || {}).filter(([, v]) => v !== '' && v != null).map(([k, v]) => `${k}: ${v}`).join('; ');
          return [
            `Picked ${new Date(p.ts).toLocaleString('ru-RU')} in tab [${p.tabId}]${tab ? '' : ' (tab closed)'}: ${p.url}`,
            ref ? `Ref: ${ref} (valid on the current page)` : 'Ref: — (page changed since picking; use the selector)',
            `Selector: ${p.selector}`,
            `XPath: ${p.xpath}`,
            `Tag: ${p.tag}${p.inShadow ? ' (inside shadow DOM)' : ''}${p.inFrame ? ' (inside an iframe)' : ''}`,
            `Box: x=${p.rect.x} y=${p.rect.y} ${p.rect.width}×${p.rect.height} (viewport CSS px at pick time)`,
            p.value != null ? `Value: ${JSON.stringify(p.value)}` : null,
            `Text: ${p.text ? JSON.stringify(p.text) : '(empty)'}`,
            attrs ? `Attributes:\n${attrs}` : 'Attributes: (none)',
            styles ? `Styles: ${styles}` : null,
            `outerHTML (${p.htmlLength} chars${p.htmlLength > p.outerHTML.length ? ', truncated' : ''}):\n${p.outerHTML}`,
          ].filter(Boolean).join('\n');
        },
      },

      // ===== действия =====
      {
        name: 'tab_open', access: FULL,
        description: 'Open a URL (or search text) in a new tab and wait for it to load. container = container id or name for a separate login (cookies). Example: {"url": "https://www.wildberries.ru", "background": false}',
        input: {
          url: z.string().describe('URL or search query'),
          container: z.string().optional().describe('Container id or name (default: main)'),
          background: z.boolean().optional().describe('Open without switching to it (default false)'),
          wait: z.boolean().optional().describe('Wait for load (default true)'),
        },
        async run(args, call) {
          const url = checkUrl(args.url);
          const containerId = resolveContainer(args.container);
          const t = call.tab(ctx.tabs.create({ url, containerId, active: !args.background }));
          if (args.wait !== false) { await A.sleep(200); await A.waitLoad(t, 20000); }
          const wc = t.wc;
          const live = wc && !wc.isDestroyed();
          const u = (live && wc.getURL()) || t.info.url || url;
          const title = live ? wc.getTitle() : '';
          return `Opened tab [${t.id}]${args.background ? ' in background' : ''}: ${readableUrl(u)}${title && title !== u ? ` — "${title}"` : ''}${live && wc.isLoading() ? ' (still loading)' : ''}`;
        },
      },
      {
        name: 'tab_select', access: FULL,
        description: 'Make a tab active (visible to the user). Example: {"tabId": 4}',
        input: { tabId: z.number().describe('Tab id') },
        async run(args, call) {
          const t = call.tab(A.getTab(args.tabId));
          ctx.tabs.activate(t.id, { focus: false });
          return `Tab [${t.id}] is active: ${t.info.url}`;
        },
      },
      {
        name: 'tab_close', access: FULL,
        description: 'Close a tab. Example: {"tabId": 4}',
        input: { tabId: z.number().describe('Tab id') },
        annotations: { destructiveHint: true },
        async run(args, call) {
          const t = A.getTab(args.tabId);
          call.tabId = t.id;
          const url = t.info.url;
          ctx.tabs.close(t.id);
          return `Closed tab [${t.id}] ${url}`;
        },
      },
      {
        name: 'navigate', access: FULL,
        description: 'Go to a URL in a tab (search text works too), or "back", "forward", "reload". Waits for load by default. Example: {"url": "https://example.com"} or {"url": "back"}',
        input: {
          tabId,
          url: z.string().describe('URL, search text, or back | forward | reload'),
          wait: z.enum(['load', 'domcontentloaded', 'commit', 'none']).optional().describe('What to wait for (default load)'),
          timeout: z.number().optional().describe('Max wait in ms (default 20000)'),
        },
        async run(args, call) {
          const tab = call.tab(await A.liveTab(args.tabId));
          const u = String(args.url || '').trim();
          const wc = tab.wc;
          const nav = A.watchNav(tab);
          const low = u.toLowerCase();
          if (low === 'back') { if (!wc.navigationHistory.canGoBack()) { nav.off(); throw new Error('no page to go back to'); } ctx.tabs.back(tab.id); }
          else if (low === 'forward') { if (!wc.navigationHistory.canGoForward()) { nav.off(); throw new Error('no page to go forward to'); } ctx.tabs.forward(tab.id); }
          else if (low === 'reload') ctx.tabs.reload(tab.id, false);
          else { try { checkUrl(u); } catch (e) { nav.off(); throw e; } ctx.tabs.navigate(tab.id, u); }
          if (args.wait === 'none') { const r = nav.settle({ quiet: 300, extra: 0, timeout: 0 }); return (await r).lines.join('\n'); }
          const timeout = Math.max(1000, Math.min(120000, args.timeout || 20000));
          const r = await nav.settle({ quiet: 300, extra: 300, timeout, wait: args.wait === 'commit' ? 'commit' : 'load' });
          if (args.wait === 'domcontentloaded' || args.wait === 'load' || !args.wait) await A.waitLoad(tab, Math.max(0, timeout - 300), args.wait || 'load');
          const lines = r.lines.slice();
          if (!r.navigated && !r.lines.some((l) => /failed/.test(l))) lines.unshift(`Now at ${readableUrl(wc.getURL())} — "${wc.getTitle()}"`);
          if (wc.isLoading()) lines.push('(page is still loading)');
          return lines.join('\n');
        },
      },
      {
        name: 'click', access: FULL,
        description: 'Click an element by ref (preferred) or selector, or a point x,y (CSS px in the viewport). Scrolls it into view and sends real mouse events. Reports navigation / new tab. Example: {"ref": "e12"} or {"selector": "button.buy", "button": "right"}',
        input: {
          tabId, ref, selector,
          x: z.number().optional().describe('Viewport X in CSS px (with y, instead of ref)'),
          y: z.number().optional().describe('Viewport Y in CSS px'),
          button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button (default left)'),
          clickCount: z.number().optional().describe('2 for double click'),
          modifiers: z.array(z.enum(['Control', 'Shift', 'Alt', 'Meta'])).optional().describe('Held keys, e.g. ["Control"] to open a link in a background tab'),
          waitMs: z.number().optional().describe('How long to wait for a resulting navigation (default 10000)'),
        },
        async run(args, call) {
          const tab = await webTab(args, call);
          const loc = await target(tab, args);
          const warn = [];
          if (loc.disabled) warn.push('Note: the element looks disabled.');
          if (!loc.hit && loc.cover) warn.push(`Warning: another element covers it: ${loc.cover} — the click may land there.`);
          const nav = A.watchNav(tab);
          A.mouse(tab, loc.x, loc.y, { button: args.button, clickCount: args.clickCount, modifiers: mods(args.modifiers) });
          const r = await nav.settle({ quiet: 300, extra: 700, timeout: Math.max(0, Math.min(60000, args.waitMs != null ? args.waitMs : 10000)) });
          return [`Clicked ${loc.desc} at (${Math.round(loc.x)}, ${Math.round(loc.y)}).`, ...warn, ...r.lines].join('\n');
        },
      },
      {
        name: 'type', access: FULL,
        description: 'Type text into an input/textarea/contenteditable (by ref or selector; without them — into the focused element). clear=true replaces the current value, submit=true presses Enter afterwards. Uses real text input events. Example: {"ref": "e7", "text": "кроссовки", "clear": true, "submit": true}',
        input: {
          tabId, ref, selector,
          text: z.string().describe('Text to type'),
          clear: z.boolean().optional().describe('Replace existing value (default false)'),
          submit: z.boolean().optional().describe('Press Enter after typing (default false)'),
        },
        async run(args, call) {
          const tab = await webTab(args, call);
          const text = String(args.text == null ? '' : args.text);
          call.logArgs = Object.assign({}, args, { text: clip(text, 80) });
          let desc = 'the focused element';
          let password = false;
          if (args.ref || args.selector) {
            const loc = await A.lib(tab, 'locate', { ref: args.ref, selector: args.selector });
            password = loc.password;
            if (password) call.logArgs.text = '•••';
            let f = await A.lib(tab, 'focus', { ref: args.ref, selector: args.selector, clear: args.clear });
            if (!f.focused && loc.visible) {
              A.mouse(tab, loc.x, loc.y, {});
              await A.sleep(150);
              f = await A.lib(tab, 'focus', { ref: args.ref, selector: args.selector, clear: args.clear });
            }
            if (!f.focused) throw new Error(`could not focus ${f.desc}`);
            if (f.readOnly) throw new Error(`element is read-only: ${f.desc}`);
            if (args.clear && !f.selected) { A.key(tab, 'Control+A'); await A.sleep(30); }
            desc = f.desc;
          } else if (args.clear) {
            A.key(tab, 'Control+A');
            await A.sleep(30);
          }
          if (text) await tab.wc.insertText(text);
          else if (args.clear) A.key(tab, 'Delete');
          await A.sleep(60);
          const lines = [`Typed ${password ? text.length + ' chars (hidden)' : JSON.stringify(clip(text, 200))} into ${desc}.`];
          if (args.ref || args.selector) {
            try { const v = await A.lib(tab, 'value', { ref: args.ref, selector: args.selector }, 5000); lines.push(`Value now: ${JSON.stringify(clip(v.value, 300))}`); } catch (_) { /* элемент мог исчезнуть */ }
          }
          if (args.submit) {
            const nav = A.watchNav(tab);
            A.key(tab, 'Enter');
            const r = await nav.settle({ quiet: 400, extra: 1200, timeout: 15000 });
            lines.push('Pressed Enter.', ...r.lines);
          }
          return lines.join('\n');
        },
      },
      {
        name: 'press_key', access: FULL,
        description: 'Press keys in the page (focused element). One combo or several separated by spaces: "Enter", "Escape", "Tab", "ArrowDown ArrowDown Enter", "Control+A", "Shift+Tab", "PageDown". Example: {"keys": "Control+A"}',
        input: {
          tabId,
          keys: z.string().describe('Key or combos separated by spaces'),
          repeat: z.number().optional().describe('Repeat the whole sequence N times (default 1)'),
        },
        async run(args, call) {
          const tab = await webTab(args, call);
          const raw = String(args.keys || '');
          const seq = raw.trim() ? raw.trim().split(/\s+/) : (raw ? ['Space'] : []);
          if (!seq.length) throw new Error('keys is required');
          const parsed = seq.map((k) => A.parseCombo(k));
          const n = Math.max(1, Math.min(50, args.repeat || 1));
          const nav = A.watchNav(tab);
          const done = [];
          for (let i = 0; i < n; i++) {
            for (const k of parsed) { done.push(A.key(tab, k)); await A.sleep(25); }
          }
          const r = await nav.settle({ quiet: 250, extra: 500, timeout: 10000 });
          return [`Pressed ${done.length > 12 ? done.slice(0, 12).join(' ') + ' …(' + done.length + ')' : done.join(' ')}.`, ...r.lines].join('\n');
        },
      },
      {
        name: 'scroll', access: FULL,
        description: 'Scroll the page: direction down/up/left/right by amount px (default ~80% of the viewport), top/bottom, or bring an element (ref/selector) into view. Uses real mouse wheel events (lazy-loading lists react). Example: {"direction": "down"} or {"ref": "e40"}',
        input: {
          tabId, ref, selector,
          direction: z.enum(['down', 'up', 'left', 'right', 'top', 'bottom']).optional().describe('Default down'),
          amount: z.number().optional().describe('Pixels to scroll'),
        },
        async run(args, call) {
          const tab = await webTab(args, call);
          const before = await A.lib(tab, 'info', {}, 5000);
          let after;
          if (args.ref || args.selector) {
            after = await A.lib(tab, 'scrollBy', { ref: args.ref, selector: args.selector });
          } else {
            const dir = args.direction || 'down';
            if (dir === 'top' || dir === 'bottom') {
              after = await A.lib(tab, 'scrollBy', { dy: dir === 'top' ? -before.dh : before.dh });
            } else {
              const amt = Math.max(1, Number(args.amount) || Math.round((dir === 'left' || dir === 'right' ? before.vw : before.vh) * 0.8));
              const dx = dir === 'left' ? -amt : dir === 'right' ? amt : 0;
              const dy = dir === 'up' ? -amt : dir === 'down' ? amt : 0;
              A.wheel(tab, before.vw / 2, before.vh / 2, dx, dy);
              await A.sleep(350);
              after = await A.lib(tab, 'info', {}, 5000);
              if (after.sx === before.sx && after.sy === before.sy) {
                after = await A.lib(tab, 'scrollBy', { dx, dy });
              }
            }
          }
          await A.sleep(150);
          const atBottom = after.sy + after.vh >= after.dh - 2;
          return `Scrolled: now at ${after.sx},${after.sy} (viewport ${after.vw}×${after.vh}, document ${after.dw}×${after.dh})${atBottom ? ', at the bottom' : ''}${after.sy === 0 ? ', at the top' : ''}.`;
        },
      },
      {
        name: 'hover', access: FULL,
        description: 'Move the mouse over an element (ref/selector) or a point x,y to reveal menus/tooltips. Example: {"ref": "e5"}',
        input: {
          tabId, ref, selector,
          x: z.number().optional().describe('Viewport X in CSS px'),
          y: z.number().optional().describe('Viewport Y in CSS px'),
        },
        async run(args, call) {
          const tab = await webTab(args, call);
          const loc = await target(tab, args);
          A.mouse(tab, loc.x, loc.y, { move: true });
          await A.sleep(300);
          return `Hovering ${loc.desc} at (${Math.round(loc.x)}, ${Math.round(loc.y)}).${!loc.hit && loc.cover ? `\nWarning: covered by ${loc.cover}.` : ''}`;
        },
      },
      {
        name: 'select_option', access: FULL,
        description: 'Choose option(s) in a native <select> by value or visible text (or index). For custom dropdowns use click instead. Example: {"ref": "e9", "value": "Москва"}',
        input: {
          tabId, ref, selector,
          value: z.string().optional().describe('Option value or text'),
          values: z.array(z.string()).optional().describe('Several values for <select multiple>'),
          index: z.number().optional().describe('Option index (0-based)'),
        },
        async run(args, call) {
          const tab = await webTab(args, call);
          const r = await A.lib(tab, 'selectOption', args);
          return `Selected ${r.selected.map((s) => JSON.stringify(s)).join(', ')} in ${r.desc}.`;
        },
      },
      {
        name: 'wait_for', access: FULL,
        description: 'Wait until a condition holds: selector appears (state visible|attached|hidden|detached), text appears on the page, the URL changes (urlChange=true or urlIncludes), or the network is idle; or just wait time ms. Example: {"selector": ".product-card", "timeout": 15000} or {"networkIdle": true}',
        input: {
          tabId, selector,
          text: z.string().optional().describe('Text that must appear (state hidden: disappear)'),
          state: z.enum(['visible', 'attached', 'hidden', 'detached']).optional().describe('For selector/text (default visible)'),
          urlChange: z.boolean().optional().describe('Wait until the URL differs from the current one'),
          urlIncludes: z.string().optional().describe('Wait until the URL contains this'),
          networkIdle: z.boolean().optional().describe('Wait until no requests for 500 ms'),
          time: z.number().optional().describe('Just wait this many ms'),
          timeout: z.number().optional().describe('Max wait in ms (default 10000, max 60000)'),
        },
        annotations: { readOnlyHint: true },
        async run(args, call) {
          const tab = call.tab(await A.liveTab(args.tabId));
          const wc = tab.wc;
          const t0 = Date.now();
          if (args.time && !args.selector && args.text == null && !args.urlChange && !args.urlIncludes && !args.networkIdle) {
            await A.sleep(Math.max(0, Math.min(60000, args.time)));
            return `Waited ${Math.max(0, Math.min(60000, args.time))} ms.`;
          }
          if (!args.selector && args.text == null && !args.urlChange && !args.urlIncludes && !args.networkIdle) throw new Error('nothing to wait for: give selector, text, urlChange, urlIncludes, networkIdle or time');
          const timeout = Math.max(100, Math.min(60000, args.timeout || 10000));
          const startUrl = wc.getURL();
          let quietSince = Date.now();
          let lastSeq = -1;
          const wants = [];
          if (args.selector) wants.push(`selector ${args.selector} ${args.state || 'visible'}`);
          if (args.text != null) wants.push(`text ${JSON.stringify(args.text)}${args.state === 'hidden' ? ' gone' : ''}`);
          if (args.urlChange) wants.push('URL change');
          if (args.urlIncludes) wants.push(`URL contains ${args.urlIncludes}`);
          if (args.networkIdle) wants.push('network idle');
          let lastErr = '';
          while (Date.now() - t0 < timeout) {
            if (wc.isDestroyed()) throw new Error('tab was closed');
            let ok = true;
            const url = wc.getURL();
            if (args.urlChange && url === startUrl) ok = false;
            if (ok && args.urlIncludes && !url.includes(args.urlIncludes)) ok = false;
            if (ok && args.networkIdle) {
              let pending = 0, seq = 0;
              if (ctx.cdp && typeof ctx.cdp.network === 'function') {
                const list = ctx.cdp.network(tab.id, { type: 'all', limit: 300 });
                for (const e of list) { if (e.pending && Date.now() - e.ts < 30000) pending++; seq = Math.max(seq, e.seq || 0); }
              }
              if (seq !== lastSeq || pending || wc.isLoading()) { lastSeq = seq; quietSince = Date.now(); ok = false; }
              else if (Date.now() - quietSince < 500) ok = false;
            }
            if (ok && (args.selector || args.text != null)) {
              try {
                const r = await A.lib(tab, 'check', { selector: args.selector, text: args.text, state: args.state }, 5000);
                ok = !!r.ok;
                lastErr = '';
              } catch (e) { ok = false; lastErr = e.message; }
            }
            if (ok) return `Condition met after ${((Date.now() - t0) / 1000).toFixed(1)} s: ${wants.join(', ')}. URL: ${wc.getURL()}`;
            await A.sleep(250);
          }
          throw new Error(`Timed out after ${(timeout / 1000).toFixed(1)} s waiting for ${wants.join(', ')}. URL: ${wc.getURL()}${lastErr ? ' (' + lastErr + ')' : ''}`);
        },
      },
      {
        name: 'eval_js', access: FULL,
        description: 'Run JavaScript in the page and return the result as JSON (DOM nodes are described, cycles cut). Supports await; use return for statements, or give a single expression. world=page (default, sees page variables) or isolated (clean context, same DOM). Example: {"code": "return [...document.querySelectorAll(\'h2\')].map(h => h.textContent)"} or {"code": "await fetch(\'/api/x\').then(r => r.status)"}',
        input: {
          tabId,
          code: z.string().describe('JavaScript (expression or function body with return)'),
          world: z.enum(['page', 'isolated']).optional().describe('Default page'),
          timeout: z.number().optional().describe('Max ms (default 30000)'),
          maxChars: maxChars(20000),
        },
        async run(args, call) {
          const tab = await webTab(args, call);
          const src = String(args.code || '');
          if (!src.trim()) throw new Error('code is required');
          let body;
          try {
            // eslint-disable-next-line no-new-func
            new Function(`return (async () => (${src}\n))`);
            body = `return (${src}\n);`;
          } catch (_) {
            try {
              // eslint-disable-next-line no-new-func
              new Function(`return (async () => {${src}\n})`);
              body = src;
            } catch (e) { throw new Error('syntax error: ' + e.message); }
          }
          const wrapped = `(async () => { const __ser = ${SERIALIZER}; try { const __v = await (async () => {\n${body}\n})(); return { ok: true, value: __ser(__v) }; } catch (e) { return { ok: false, error: String((e && (e.stack || e.message)) || e) }; } })()`;
          const timeout = Math.max(500, Math.min(120000, args.timeout || 30000));
          const p = args.world === 'isolated'
            ? A.evalWorld(tab, 'kosmolet-eval', wrapped, timeout + 1000, 1003)
            : tab.wc.mainFrame.executeJavaScript(wrapped, true);
          const r = await A.withTimeout(Promise.resolve(p), timeout, `script did not finish in ${timeout} ms`);
          if (!r) throw new Error('script returned nothing (the page may have navigated)');
          if (!r.ok) throw new Error('JS error: ' + clip(r.error, 3000));
          return truncNote(String(r.value), args.maxChars || 20000);
        },
      },
      {
        name: 'page_fetch', access: FULL,
        description: 'fetch() from inside the page: same origin, cookies and session as the site (good for its JSON APIs). Returns status, main headers and body text (truncated). Example: {"url": "/api/v1/user", "method": "GET"} or {"url": "https://api.site.ru/x", "method": "POST", "headers": {"content-type": "application/json"}, "body": "{\\"q\\":1}"}',
        input: {
          tabId,
          url: z.string().describe('Absolute or page-relative URL'),
          method: z.string().optional().describe('Default GET'),
          headers: z.record(z.string(), z.string()).optional().describe('Request headers'),
          body: z.string().optional().describe('Request body (string)'),
          credentials: z.enum(['include', 'same-origin', 'omit']).optional().describe('Default include'),
          timeoutMs: z.number().optional().describe('Default 30000'),
          maxChars: maxChars(20000),
        },
        async run(args, call) {
          const tab = await webTab(args, call);
          call.logArgs = Object.assign({}, args, { body: args.body ? clip(args.body, 120) : undefined });
          const r = await A.pageFetch(tab.id, { url: args.url, method: args.method, headers: args.headers, body: args.body, credentials: args.credentials, timeoutMs: args.timeoutMs });
          if (r.error && !r.status) throw new Error('fetch failed: ' + r.error);
          const h = r.headers || {};
          const keep = ['content-type', 'content-length', 'location', 'set-cookie', 'cache-control', 'x-request-id'];
          const hl = keep.filter((k) => h[k] != null).map((k) => `${k}: ${clip(h[k], 300)}`);
          const body = r.base64Encoded ? `(binary, ${fmtBytes(r.size)}, base64 not shown)` : truncNote(String(r.body || ''), args.maxChars || 20000);
          return [`HTTP ${r.status} ${r.statusText || ''} — ${r.timeMs != null ? Math.round(r.timeMs) + ' ms' : ''}${r.url ? ', ' + r.url : ''}${r.redirected ? ' (redirected)' : ''}`, ...hl, r.truncated ? '(body truncated at 5 MB)' : null, '', body].filter((x) => x !== null).join('\n');
        },
      },
      {
        name: 'cookies_get', access: FULL,
        description: 'Cookies of the tab\'s container for a URL or domain (default: the tab\'s URL), including HttpOnly. Example: {"domain": "wildberries.ru"} or {"url": "https://www.ozon.ru", "name": "__Secure-access-token"}',
        input: {
          tabId,
          url: z.string().optional().describe('URL whose cookies to read'),
          domain: z.string().optional().describe('Domain (matches subdomains)'),
          name: z.string().optional().describe('Only this cookie'),
          container: z.string().optional().describe('Container id/name instead of a tab'),
        },
        async run(args, call) {
          const { ses, containerId } = sessionFor(args);
          const filter = {};
          if (args.url) filter.url = args.url;
          else if (args.domain) filter.domain = String(args.domain).replace(/^\./, '');
          else { const t = call.tab(A.getTab(args.tabId)); filter.url = t.wc && !t.wc.isDestroyed() ? t.wc.getURL() : t.info.url; }
          if (args.name) filter.name = args.name;
          const list = await ses.cookies.get(filter);
          if (!list.length) return `No cookies for ${filter.url || filter.domain}${args.name ? ' named ' + args.name : ''} (container ${containerId}).`;
          const lines = list.map((c) => {
            const bits = [`domain=${c.domain}`, `path=${c.path}`];
            if (c.expirationDate) bits.push('expires=' + new Date(c.expirationDate * 1000).toISOString().slice(0, 19).replace('T', ' '));
            else bits.push('session');
            if (c.httpOnly) bits.push('HttpOnly');
            if (c.secure) bits.push('Secure');
            if (c.sameSite && c.sameSite !== 'unspecified') bits.push('SameSite=' + c.sameSite);
            return `${c.name}=${clip(c.value, 400)}; ${bits.join('; ')}`;
          });
          return `${list.length} cookie(s), container ${containerId}:\n${lines.join('\n')}`;
        },
      },
      {
        name: 'cookies_set', access: FULL,
        description: 'Set a cookie in the tab\'s container. Example: {"url": "https://example.com", "name": "a", "value": "1", "expirationDate": 1893456000}',
        input: {
          tabId,
          url: z.string().describe('URL the cookie belongs to'),
          name: z.string(), value: z.string(),
          domain: z.string().optional(), path: z.string().optional(),
          secure: z.boolean().optional(), httpOnly: z.boolean().optional(),
          expirationDate: z.number().optional().describe('Unix time in seconds; omit for a session cookie'),
          sameSite: z.enum(['unspecified', 'no_restriction', 'lax', 'strict']).optional(),
          container: z.string().optional().describe('Container id/name instead of a tab'),
        },
        async run(args, call) {
          const { ses, containerId } = sessionFor(args);
          if (args.tabId != null) call.tab(A.getTab(args.tabId));
          call.logArgs = Object.assign({}, args, { value: '•••' });
          const d = { url: args.url, name: args.name, value: args.value };
          for (const k of ['domain', 'path', 'secure', 'httpOnly', 'expirationDate', 'sameSite']) if (args[k] !== undefined) d[k] = args[k];
          await ses.cookies.set(d);
          return `Cookie ${args.name} set for ${args.url} (container ${containerId}).`;
        },
      },
      {
        name: 'storage_get', access: FULL,
        description: 'Read localStorage or sessionStorage of the page: one key (full value) or the list of keys with previews. Example: {"type": "local"} or {"key": "user-settings"}',
        input: {
          tabId,
          type: z.enum(['local', 'session']).optional().describe('Default local'),
          key: z.string().optional().describe('Read one key'),
          prefix: z.string().optional().describe('Only keys starting with this'),
          maxChars: maxChars(20000),
        },
        annotations: { readOnlyHint: true },
        async run(args, call) {
          const tab = await webTab(args, call);
          const r = await A.lib(tab, 'storage', { type: args.type, key: args.key, prefix: args.prefix, maxChars: args.maxChars || 20000 });
          const kind = args.type === 'session' ? 'sessionStorage' : 'localStorage';
          if (args.key != null) return r.found ? `${kind}[${JSON.stringify(r.key)}] (${r.length} chars):\n${r.value}${r.length > r.value.length ? '\n…[truncated]' : ''}` : `${kind} has no key ${JSON.stringify(r.key)}.`;
          if (!r.items.length) return `${kind} of ${r.origin} is empty${args.prefix ? ' for prefix ' + args.prefix : ''}.`;
          return `${kind} of ${r.origin}: ${r.count} key(s)${args.prefix ? `, ${r.items.length} with prefix ${args.prefix}` : ''}\n${r.items.map((i) => `${i.key} (${i.length}): ${i.preview}`).join('\n')}`;
        },
      },
    ];
    return defs;
  }

  // Новый McpServer на запрос (stateless).
  function buildServer() {
    const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
    const list = build();
    const server = new McpServer({ name: 'kosmolet', title: 'Космолёт', version: ctx.app.getVersion() }, { instructions: INSTRUCTIONS });
    for (const d of list) {
      const config = { description: d.access === FULL ? d.description + ' Needs access mode full.' : d.description, inputSchema: d.input };
      if (d.annotations) config.annotations = d.annotations;
      server.registerTool(d.name, config, (args) => invoke(d, args));
    }
    return server;
  }

  function names() { return build().map((d) => ({ name: d.name, access: d.access })); }

  return { buildServer, names, invoke: (name, args) => { const d = build().find((x) => x.name === name); if (!d) throw new Error('no tool ' + name); return invoke(d, args); } };
}

module.exports = { createTools, INSTRUCTIONS };
