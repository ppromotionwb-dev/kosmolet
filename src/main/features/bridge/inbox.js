'use strict';
// «Отправить в Claude» (claude-bridge): markdown-файл в папку inbox (settings.claude.inboxDir или
// Документы/Космолёт/claude-inbox), имя ГГГГ-ММ-ДД_ЧЧ-ММ-СС_<хост>.md.

const fs = require('fs');
const path = require('path');

function pad(n) { return String(n).padStart(2, '0'); }
function stamp(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}
function human(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function safeHost(h) {
  const s = String(h || '').toLowerCase().replace(/^www\./, '').replace(/[^a-z0-9.\-а-яё]/gi, '_').replace(/_+/g, '_').slice(0, 60);
  return s || 'page';
}
function hostOf(url) { try { return new URL(url).hostname; } catch (_) { return ''; } }
function fence(text, lang) {
  const t = String(text || '');
  let f = '```';
  while (t.includes(f)) f += '`';
  return `${f}${lang || ''}\n${t}\n${f}`;
}
function clip(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) + `\n…[обрезано: ${s.length} символов]` : s;
}

function createInbox(ctx, deps) {
  const { actions: A, picker, activity } = deps;

  function dir() { return ctx.paths.inbox; }

  async function toInbox({ title, markdown, host } = {}) {
    const d = dir();
    await fs.promises.mkdir(d, { recursive: true });
    const now = new Date();
    const base = `${stamp(now)}_${safeHost(host)}`;
    let file = path.join(d, base + '.md');
    for (let i = 2; i < 100 && fs.existsSync(file); i++) file = path.join(d, `${base}-${i}.md`);
    let md = String(markdown || '');
    if (title && !/^#\s/.test(md)) md = `# ${title}\n\n${md}`;
    await fs.promises.writeFile(file, md, 'utf8');
    ctx.log('bridge', 'в inbox:', file);
    return { path: file };
  }

  // Собрать markdown страницы: адрес, время, выделение, выбранный элемент, текст страницы, последние API-запросы.
  async function pageMarkdown(tab, extra = {}) {
    const wc = tab.wc;
    const url = wc && !wc.isDestroyed() ? wc.getURL() : tab.info.url;
    const title = (wc && !wc.isDestroyed() ? wc.getTitle() : tab.info.title) || url;
    const now = new Date();
    let shown = url;
    try { shown = decodeURI(url); } catch (_) { /* как есть */ }
    const parts = [`# ${title}`, '', `- Адрес: ${shown}`, `- Время: ${human(now)}`, `- Вкладка: ${tab.id}, контейнер ${tab.info.containerName || tab.info.containerId}`];
    const web = wc && !wc.isDestroyed() && /^(https?|file|data):/i.test(url);
    let selection = extra.selection || '';
    if (!selection && web) { try { selection = await A.lib(tab, 'selection', {}, 4000); } catch (_) { selection = ''; } }
    if (selection && selection.trim()) parts.push('', '## Выделенный текст', '', fence(clip(selection.trim(), 20000)));
    const p = picker.last();
    if (p && p.tabId === tab.id && p.url === url) {
      parts.push('', '## Выбранный элемент', '', `- Селектор: \`${p.selector}\``, `- XPath: \`${p.xpath}\``, `- Тег: ${p.tag}, ${p.rect.width}×${p.rect.height}`);
      if (p.text) parts.push('', 'Текст:', '', fence(clip(p.text, 2000)));
      parts.push('', 'HTML:', '', fence(clip(p.outerHTML, 8000), 'html'));
    }
    if (web) {
      try {
        const text = await A.lib(tab, 'snapshot', { mode: 'text', maxChars: 15000 }, 15000);
        parts.push('', '## Текст страницы', '', fence(text.replace(/^[\s\S]*?\n\n/, '').replace(/(\n\[[^\n]*\])+\s*$/, '').trim()));
      } catch (e) { parts.push('', '## Текст страницы', '', `_не удалось снять: ${e.message}_`); }
    }
    if (ctx.cdp && typeof ctx.cdp.network === 'function') {
      let list = [];
      try { list = ctx.cdp.network(tab.id, { type: 'api', limit: 30 }); } catch (_) { list = []; }
      if (list.length) {
        parts.push('', `## Последние запросы API (${list.length})`, '', '| # | Метод | Статус | Тип | Размер | URL |', '|---|---|---|---|---|---|');
        for (const e of list) {
          const st = e.failed ? 'ошибка' : e.pending ? '…' : String(e.status || '—');
          const u = String(e.url || '').replace(/\|/g, '%7C');
          parts.push(`| ${e.id} | ${e.method || ''} | ${st} | ${e.type || ''} | ${e.size != null ? e.size : ''} | ${u.length > 300 ? u.slice(0, 300) + '…' : u} |`);
        }
      }
    }
    parts.push('');
    return { markdown: parts.join('\n'), title, url, host: hostOf(url) };
  }

  async function sendPage(tabId, extra = {}) {
    const tab = await A.liveTab(tabId);
    const t0 = Date.now();
    const md = await pageMarkdown(tab, extra);
    const out = await toInbox({ title: null, markdown: md.markdown, host: md.host });
    try { ctx.electron.clipboard.writeText(out.path); } catch (_) { /* буфер занят */ }
    let pasted = false;
    const term = ctx.terminal;
    if (term && typeof term.pasteToClaude === 'function') {
      try { pasted = !!(await term.pasteToClaude('@' + out.path + ' ')); } catch (_) { pasted = false; }
    }
    activity.add({ tool: 'send_to_claude', by: 'user', args: { url: md.url }, tabId: tab.id, tabTitle: String(tab.info.title || '').slice(0, 80) || undefined, ok: true, ms: Date.now() - t0, note: out.path });
    return { path: out.path, pasted, url: md.url };
  }

  return { toInbox, sendPage, pageMarkdown, dir };
}

module.exports = { createInbox, stamp };
