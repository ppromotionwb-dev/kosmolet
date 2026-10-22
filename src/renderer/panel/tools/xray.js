// Владелец: tools-pack. Инструмент панели «Рентген»: SEO, технологии, скорость, сервер и заголовки безопасности
// активной страницы. Анализ — в main (kosmo:xray.run); здесь отрисовка, отчёт в Markdown и «Отправить в Claude».
'use strict';
(function () {
  const U = window.KUI;
  const { h } = U;
  U.css('tools/snippets.css'); // точки статуса и общие мелочи
  U.css('tools/xray.css');

  const STATUS_MD = { ok: 'ок', warn: 'внимание', bad: 'плохо', info: 'инфо' };
  const STATUS_TITLE = { ok: 'Хорошо', warn: 'Есть замечание', bad: 'Проблема', info: 'Для сведения' };
  const errText = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '');
  const isWeb = (u) => /^(https?|file):/i.test(String(u || ''));
  const noHash = (u) => String(u || '').split('#')[0];
  const LS = 'kosmo.xray.collapsed';
  const lsGet = () => { try { return JSON.parse(localStorage.getItem(LS) || '{}') || {}; } catch (e) { return {}; } };
  const lsSet = (v) => { try { localStorage.setItem(LS, JSON.stringify(v)); } catch (e) { /* нет места */ } };

  // ---------- Markdown ----------
  function mdEsc(s) { return String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' '); }
  function toMarkdown(rep) {
    const out = [];
    const d = new Date(rep.at);
    out.push('# Рентген: ' + (rep.title || rep.host || rep.url), '', '- Адрес: ' + rep.url, '- Время: ' + d.toLocaleString('ru-RU'));
    const cnt = counts(rep);
    out.push('- Итог: проблем ' + cnt.bad + ', замечаний ' + cnt.warn + ', в порядке ' + cnt.ok);
    for (const n of rep.notes || []) out.push('- Примечание: ' + n);
    for (const s of rep.sections) {
      out.push('', '## ' + s.title, '');
      for (const it of s.items) {
        out.push('- [' + STATUS_MD[it.status || 'info'] + '] **' + it.label + '**: ' + String(it.value || '').replace(/\n/g, ' ') + (it.hint ? ' — ' + it.hint : ''));
        if (it.list && it.list.length) for (const l of it.list) out.push('  - ' + String(l).replace(/\n/g, ' '));
        if (it.outline && it.outline.length) for (const o of it.outline.slice(0, 120)) out.push('  ' + '  '.repeat(Math.max(0, o.level - 1)) + '- H' + o.level + ': ' + o.text);
        if (it.rows && it.rows.length) {
          const cols = it.columns || it.rows[0].map((_, i) => 'Столбец ' + (i + 1));
          out.push('', '  | ' + cols.map(mdEsc).join(' | ') + ' |', '  |' + cols.map(() => '---').join('|') + '|');
          for (const r of it.rows) out.push('  | ' + r.map(mdEsc).join(' | ') + ' |');
          out.push('');
        }
      }
    }
    out.push('');
    return out.join('\n');
  }
  function counts(rep) {
    const c = { ok: 0, warn: 0, bad: 0, info: 0 };
    for (const s of rep.sections) for (const it of s.items) c[it.status || 'info']++;
    return c;
  }

  KPanel.register({
    id: 'xray', title: 'Рентген', icon: 'scan', order: 80,
    mount(el, api) {
      el.classList.add('tp-xr');
      const st = { rep: null, loading: false, error: null, seq: 0, key: '', pendingKey: '', collapsed: lsGet() };

      const btn = (ic, title, onClick) => { const b = h('button.k-icon-btn.k-icon-btn-sm', { type: 'button', title, 'aria-label': title, html: window.KIcons.get(ic, 15) }); b.addEventListener('click', onClick); return b; };
      const refreshBtn = btn('rotate-cw', 'Обновить', () => run(true));
      const copyBtn = btn('copy', 'Копировать отчёт (Markdown)', () => { if (st.rep) U.copyText(toMarkdown(st.rep), { message: 'Отчёт скопирован (Markdown)' }); });
      const claudeBtn = btn('claude', 'Отправить в Claude', () => sendToClaude());
      // общая шапка «текущий сайт» панели (api.siteHeader); запасной вариант — своя, как раньше
      const site = api.siteHeader ? api.siteHeader({ icon: 'scan', title: 'Рентген страницы', actions: [refreshBtn, copyBtn, claudeBtn] }) : null;
      const hostEl = site ? null : h('div.tp-xr-host.k-ellipsis', 'Рентген страницы');
      const urlEl = site ? null : h('div.tp-xr-url.k-ellipsis');
      const head = site ? site.el : h('header.tp-xr-head', h('span.tp-xr-ic', U.icon('scan', 18)), h('div.tp-xr-titles', hostEl, urlEl), refreshBtn, copyBtn, claudeBtn);
      if (site) head.classList.add('tp-xr-site');
      const summary = h('div.tp-xr-summary');
      const body = h('div.tp-xr-body');
      el.append(head, summary, body);

      function setHead(t) {
        const url = st.rep ? st.rep.url : t ? t.url : '';
        let host = '';
        try { host = new URL(url).hostname; } catch (e) { host = ''; }
        if (site) site.set({ title: host || (t && t.title) || 'Рентген страницы', sub: url ? decodeSafe(url) : '', subTitle: url });
        else {
          hostEl.textContent = host || (t && t.title) || 'Рентген страницы';
          urlEl.textContent = url ? decodeSafe(url) : '';
          urlEl.title = url;
        }
        copyBtn.disabled = claudeBtn.disabled = !st.rep || st.loading;
        refreshBtn.disabled = st.loading || !t || !isWeb(t.url);
      }
      function decodeSafe(u) { try { return decodeURI(u); } catch (e) { return u; } }

      function renderSummary() {
        U.clear(summary);
        if (!st.rep) { summary.hidden = true; return; }
        summary.hidden = false;
        const c = counts(st.rep);
        const chip = (s, n, label) => h('span.tp-xr-chip', { title: STATUS_TITLE[s] }, h('span.tp-dot', { dataset: { s } }), h('b', String(n)), label);
        summary.append(
          chip('bad', c.bad, U.plural(c.bad, ['проблема', 'проблемы', 'проблем'])),
          chip('warn', c.warn, U.plural(c.warn, ['замечание', 'замечания', 'замечаний'])),
          chip('ok', c.ok, 'в порядке'),
          h('span.k-grow'),
          h('span.tp-xr-when', { title: new Date(st.rep.at).toLocaleString('ru-RU') }, U.timeAgo(st.rep.at) + ' · ' + U.formatMs(st.rep.ms)));
      }

      function itemRow(it) {
        const hasDetails = (it.list && it.list.length) || (it.rows && it.rows.length) || (it.outline && it.outline.length);
        const row = h('div.tp-xr-item' + (hasDetails ? '.has-details' : ''), { dataset: { s: it.status || 'info' } });
        const main = h('div.tp-xr-line',
          h('span.tp-dot', { dataset: { s: it.status || 'info' }, title: STATUS_TITLE[it.status || 'info'] }),
          h('span.tp-xr-label', it.label),
          h('span.tp-xr-value', String(it.value == null ? '' : it.value), it.hint ? h('span.tp-xr-hint', ' — ' + it.hint) : null),
          hasDetails ? h('span.tp-xr-chev', U.icon('chevron-down', 14)) : null);
        row.appendChild(main);
        if (hasDetails) {
          let details = null;
          main.setAttribute('role', 'button');
          main.tabIndex = 0;
          const toggle = () => {
            if (!details) { details = buildDetails(it); row.appendChild(details); }
            const open = !row.classList.contains('open');
            row.classList.toggle('open', open);
            details.hidden = !open;
          };
          main.addEventListener('click', (e) => { if (window.getSelection().toString()) return; if (e.target.closest('a')) return; toggle(); });
          main.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
        }
        return row;
      }
      function linkish(text) {
        const s = String(text);
        const m = /(https?:\/\/[^\s]+)/.exec(s);
        if (!m) return s;
        return [s.slice(0, m.index), h('a', { href: m[1], target: '_blank', rel: 'noreferrer' }, m[1]), s.slice(m.index + m[1].length)];
      }
      function buildDetails(it) {
        const d = h('div.tp-xr-details');
        if (it.outline && it.outline.length) {
          const ol = h('div.tp-xr-outline');
          for (const o of it.outline) ol.appendChild(h('div', { dataset: { l: String(o.level) } }, h('span.tp-xr-h', 'H' + o.level), o.text || '(пусто)'));
          d.appendChild(ol);
        }
        if (it.list && it.list.length) {
          const ul = h('ul.tp-xr-list');
          for (const l of it.list) ul.appendChild(h('li', linkish(l)));
          d.appendChild(ul);
        }
        if (it.rows && it.rows.length) {
          const t = h('table.tp-table');
          if (it.columns) t.appendChild(h('thead', h('tr', it.columns.map((c) => h('th', c)))));
          const tb = h('tbody');
          for (const r of it.rows) tb.appendChild(h('tr', r.map((c) => h('td', { title: String(c).length > 50 ? String(c) : null }, linkish(c)))));
          t.appendChild(tb);
          d.appendChild(h('div.tp-table-wrap', t));
        }
        return d;
      }

      function render() {
        U.clear(body);
        const t = api.activeTab();
        setHead(t);
        renderSummary();
        body.classList.toggle('busy', st.loading && !!st.rep);
        if (st.loading && !st.rep) { body.appendChild(h('div.tp-loading', h('span.k-spinner'), 'Смотрю страницу…')); return; }
        if (!st.rep) {
          if (st.error) {
            body.appendChild(api.empty({ icon: 'alert-triangle', title: 'Не удалось проверить страницу', text: st.error, tone: 'error', actions: [h('button.k-btn.k-btn-sm', { type: 'button', onClick: () => run(true) }, 'Повторить')] }));
          } else if (!t || !isWeb(t.url)) {
            body.appendChild(api.empty({ icon: 'scan', title: 'Откройте сайт', text: 'Рентген показывает SEO, технологии, скорость и заголовки безопасности страницы сайта.' }));
          } else if (t.discarded) {
            body.appendChild(api.empty({ icon: 'scan', title: 'Вкладка выгружена', text: 'Откройте её — страница загрузится, и рентген запустится сам.' }));
          } else {
            body.appendChild(h('div.tp-loading', h('span.k-spinner'), t.loading ? 'Жду загрузки страницы…' : 'Смотрю страницу…'));
          }
          return;
        }
        if (st.error) body.appendChild(h('div.tp-xr-note.bad', 'Обновить не удалось: ' + st.error));
        for (const n of st.rep.notes || []) body.appendChild(h('div.tp-xr-note', n));
        for (const s of st.rep.sections) {
          const c = { ok: 0, warn: 0, bad: 0 };
          for (const it of s.items) if (c[it.status] != null) c[it.status]++;
          const collapsed = !!st.collapsed[s.id];
          const sec = h('section.tp-xr-sec' + (collapsed ? '.collapsed' : ''), { dataset: { id: s.id } });
          const hd = h('button.tp-xr-sec-head', { type: 'button', 'aria-expanded': collapsed ? 'false' : 'true' },
            U.icon('chevron-down', 14), h('span.tp-xr-sec-title', s.title), h('span.k-grow'),
            c.bad ? h('span.tp-xr-count', { dataset: { s: 'bad' } }, String(c.bad)) : null,
            c.warn ? h('span.tp-xr-count', { dataset: { s: 'warn' } }, String(c.warn)) : null,
            !c.bad && !c.warn && c.ok ? h('span.tp-xr-count', { dataset: { s: 'ok' } }, String(c.ok)) : null);
          hd.addEventListener('click', () => {
            const v = !sec.classList.contains('collapsed');
            sec.classList.toggle('collapsed', v);
            hd.setAttribute('aria-expanded', v ? 'false' : 'true');
            st.collapsed[s.id] = v; lsSet(st.collapsed);
          });
          const items = h('div.tp-xr-items');
          let group = null;
          for (const it of s.items) {
            if (it.group && it.group !== group) { group = it.group; items.appendChild(h('div.tp-xr-group.k-label', group)); }
            items.appendChild(itemRow(it));
          }
          sec.append(hd, items);
          body.appendChild(sec);
        }
      }

      function keyOf(t) { return t ? t.id + '|' + noHash(t.url) : ''; }

      function run(force) {
        const t = api.activeTab();
        if (!t || !isWeb(t.url) || t.discarded) { st.rep = null; st.error = null; st.loading = false; st.key = ''; render(); return; }
        const key = keyOf(t);
        if (!force && st.rep && st.key === key) { render(); return; }
        if (t.loading) { st.pendingKey = key; if (st.key !== key) { st.rep = null; st.error = null; } render(); return; }
        const seq = ++st.seq;
        st.loading = true;
        st.pendingKey = '';
        if (st.key !== key) st.rep = null;
        st.error = null;
        render();
        api.invoke('kosmo:xray.run', { tabId: t.id }).then((rep) => {
          if (seq !== st.seq) return;
          st.rep = rep; st.key = key; st.error = null;
        }).catch((e) => {
          if (seq !== st.seq) return;
          st.error = errText(e);
          if (st.key !== key) st.rep = null;
        }).finally(() => {
          if (seq !== st.seq) return;
          st.loading = false;
          render();
        });
      }

      function sendToClaude() {
        if (!st.rep) return;
        claudeBtn.disabled = true;
        api.invoke('kosmo:xray.toClaude', { markdown: toMarkdown(st.rep), title: null, host: st.rep.host }).then((r) => {
          api.toast(r && r.pasted ? 'Отчёт отправлен в Claude: путь вставлен в терминал' : 'Отчёт сохранён для Claude, путь скопирован', { ms: 3200 });
        }).catch((e) => api.toast(errText(e), { tone: 'danger', ms: 3500 })).finally(() => { claudeBtn.disabled = !st.rep; });
      }

      const later = U.debounce(() => { if (api.isVisible()) run(false); }, 350);
      api.onTabChange((t, info) => {
        if (!api.isVisible()) return;
        if (info && info.reason === 'navigated') { st.rep = null; st.key = ''; }
        render();
        later();
      });
      api.onTabsState(() => {
        if (!api.isVisible()) return;
        const t = api.activeTab();
        if (st.pendingKey && t && !t.loading && keyOf(t) === st.pendingKey) later();
        else setHead(t);
      });
      el._xrShow = () => run(false);
      // таймер «N минут назад» — только пока виден, раз в 30 с
      setInterval(() => { if (api.isVisible() && st.rep) renderSummary(); }, 30000);
    },
    onShow(api) {
      const el = api.el;
      if (el && el._xrShow) el._xrShow();
    }
  });
})();
