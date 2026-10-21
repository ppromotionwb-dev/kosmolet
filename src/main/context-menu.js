'use strict';
// Нативное контекстное меню страницы (ARCHITECTURE §3): секции и точки расширения.
// Провайдер: addProvider((params, tab) => MenuItemOptions[]). Пункт может указать section:
// 'link' | 'image' | 'media' | 'selection' | 'editable' | 'page' | 'tools' (по умолчанию 'page').

const SECTIONS = ['link', 'image', 'media', 'selection', 'editable', 'page', 'tools'];

function shorten(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function createContextMenu(ctx) {
  const providers = [];
  const { Menu, clipboard } = ctx.electron;

  function addProvider(fn) {
    if (typeof fn !== 'function') throw new Error('contextMenu.addProvider: нужна функция');
    providers.push(fn);
    return () => { const i = providers.indexOf(fn); if (i >= 0) providers.splice(i, 1); };
  }

  const T = () => ctx.tabs;

  function openTab(url, tab, opts = {}) {
    return T().create(Object.assign({
      url, openerId: tab ? tab.id : undefined, containerId: tab ? tab.info.containerId : undefined, active: false,
    }, opts));
  }

  function editableItems(p, wc) {
    const f = p.editFlags || {};
    return [
      { label: 'Отменить', accelerator: 'Ctrl+Z', registerAccelerator: false, enabled: !!f.canUndo, click: () => wc.undo() },
      { label: 'Повторить', accelerator: 'Ctrl+Y', registerAccelerator: false, enabled: !!f.canRedo, click: () => wc.redo() },
      { type: 'separator' },
      { label: 'Вырезать', accelerator: 'Ctrl+X', registerAccelerator: false, enabled: !!f.canCut, click: () => wc.cut() },
      { label: 'Копировать', accelerator: 'Ctrl+C', registerAccelerator: false, enabled: !!f.canCopy, click: () => wc.copy() },
      { label: 'Вставить', accelerator: 'Ctrl+V', registerAccelerator: false, enabled: !!f.canPaste, click: () => wc.paste() },
      { label: 'Вставить как текст', accelerator: 'Ctrl+Shift+V', registerAccelerator: false, enabled: !!f.canPaste, click: () => wc.pasteAndMatchStyle() },
      { label: 'Удалить', enabled: !!f.canDelete, click: () => wc.delete() },
      { type: 'separator' },
      { label: 'Выделить всё', accelerator: 'Ctrl+A', registerAccelerator: false, enabled: f.canSelectAll !== false, click: () => wc.selectAll() },
    ];
  }

  function build(p, tab, wc, isUi) {
    const sec = {};
    for (const s of SECTIONS) sec[s] = [];
    const sel = (p.selectionText || '').trim();

    if (!isUi && p.linkURL && !/^javascript:/i.test(p.linkURL)) {
      const link = p.linkURL;
      sec.link.push(
        { label: 'Открыть в новой вкладке', click: () => openTab(link, tab) },
        { label: 'Открыть в новой активной вкладке', click: () => openTab(link, tab, { active: true }) },
        {
          label: 'Открыть в контейнере',
          submenu: ctx.sessions.containers().map((c) => ({
            label: c.name + (tab && c.id === tab.info.containerId ? ' (текущий)' : ''),
            click: () => openTab(link, tab, { containerId: c.id, openerId: undefined, active: true }),
          })),
        },
        { type: 'separator' },
        { label: 'Копировать адрес ссылки', click: () => clipboard.writeText(link) },
      );
      if (p.linkText && p.linkText.trim() && p.linkText.trim() !== link) {
        sec.link.push({ label: 'Копировать текст ссылки', click: () => clipboard.writeText(p.linkText.trim()) });
      }
    }

    if (!isUi && p.mediaType === 'image' && p.srcURL) {
      const src = p.srcURL;
      sec.image.push(
        { label: 'Открыть картинку в новой вкладке', click: () => openTab(src, tab) },
        { label: 'Копировать картинку', click: () => wc.copyImageAt(p.x, p.y) },
        { label: 'Копировать адрес картинки', click: () => clipboard.writeText(src) },
        { label: 'Сохранить картинку как…', click: () => wc.downloadURL(src) },
      );
    } else if (!isUi && (p.mediaType === 'video' || p.mediaType === 'audio') && p.srcURL && !/^blob:/i.test(p.srcURL)) {
      const src = p.srcURL;
      sec.media.push(
        { label: p.mediaType === 'video' ? 'Открыть видео в новой вкладке' : 'Открыть аудио в новой вкладке', click: () => openTab(src, tab) },
        { label: 'Копировать адрес', click: () => clipboard.writeText(src) },
        { label: 'Сохранить как…', click: () => wc.downloadURL(src) },
      );
    }

    if (p.isEditable) {
      sec.editable.push(...editableItems(p, wc));
    } else if (sel) {
      sec.selection.push({ label: 'Копировать', accelerator: 'Ctrl+C', registerAccelerator: false, click: () => wc.copy() });
      if (!isUi) {
        const eng = ctx.search.engine();
        sec.selection.push({
          label: `Найти в ${eng.name}: «${shorten(sel, 32)}»`,
          click: () => openTab(ctx.search.searchUrl(sel), tab, { active: true }),
        });
        const r = ctx.search.resolve(sel);
        if (r.kind === 'url' && !/\s/.test(sel)) {
          sec.selection.push({ label: `Перейти: ${shorten(sel, 40)}`, click: () => openTab(r.url, tab, { active: true }) });
        }
      }
    }

    if (!isUi && !p.linkURL && !p.isEditable && !sel && p.mediaType === 'none') {
      const h = wc.navigationHistory;
      sec.page.push(
        { label: 'Назад', enabled: h.canGoBack(), click: () => h.goBack() },
        { label: 'Вперёд', enabled: h.canGoForward(), click: () => h.goForward() },
        { label: 'Обновить', click: () => (tab ? T().reload(tab.id) : wc.reload()) },
        { type: 'separator' },
        { label: 'Копировать адрес страницы', click: () => clipboard.writeText(tab ? tab.info.url : wc.getURL()) },
      );
    }

    if (!isUi) {
      const pageUrl = p.pageURL || wc.getURL();
      if (/^https?:/i.test(pageUrl)) {
        sec.tools.push({ label: 'Просмотр кода страницы', click: () => openTab('view-source:' + pageUrl, tab, { active: true }) });
      }
      sec.tools.push({
        label: 'Исследовать элемент',
        click: () => {
          // Сначала панель (фича devtools подключит DevTools к вкладке), затем выбор элемента.
          try { ctx.panel.open('devtools'); } catch (e) { ctx.log('context-menu', e.message); }
          setTimeout(() => { if (!wc.isDestroyed()) wc.inspectElement(p.x, p.y); }, 50);
        },
      });
    } else if (ctx.flags.dev) {
      sec.tools.push({ label: 'Исследовать элемент интерфейса', click: () => wc.inspectElement(p.x, p.y) });
    }

    // Пункты фич — в конец своих секций (только если секция относится к месту клика).
    const active = {
      link: !!p.linkURL, image: p.mediaType === 'image', media: p.mediaType === 'video' || p.mediaType === 'audio',
      selection: !!sel && !p.isEditable, editable: !!p.isEditable, page: true, tools: true,
    };
    if (!isUi) {
      for (const fn of providers) {
        let items;
        try { items = fn(p, tab); } catch (e) { ctx.log('context-menu', 'провайдер:', e); continue; }
        if (!Array.isArray(items)) continue;
        for (const it of items) {
          if (!it || typeof it !== 'object') continue;
          const s = SECTIONS.includes(it.section) ? it.section : 'page';
          if (!active[s]) continue; // пункт для ссылки без ссылки и т.п.
          const item = Object.assign({}, it);
          delete item.section;
          sec[s].push(item);
        }
      }
    }

    const tpl = [];
    for (const s of SECTIONS) {
      const items = sec[s];
      // Убрать разделители по краям секции.
      while (items.length && items[0].type === 'separator') items.shift();
      while (items.length && items[items.length - 1].type === 'separator') items.pop();
      if (!items.length) continue;
      if (tpl.length) tpl.push({ type: 'separator' });
      tpl.push(...items);
    }
    return tpl;
  }

  function show(p, tab, wc, isUi) {
    const tpl = build(p, tab, wc, isUi);
    if (!tpl.length) return;
    const menu = Menu.buildFromTemplate(tpl);
    const win = ctx.windows.main;
    menu.popup({ window: win || undefined, frame: p.frame || undefined });
  }

  function attach(wc, kind) {
    wc.on('context-menu', (_e, params) => {
      const tab = kind === 'tab' ? T().fromWebContents(wc) : null;
      try { show(params, tab, wc, kind !== 'tab'); } catch (e) { ctx.log('context-menu', e); }
    });
  }

  return { addProvider, attach, build, show, SECTIONS };
}

module.exports = { createContextMenu };
