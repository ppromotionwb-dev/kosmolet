'use strict';
// HTTP Basic/Digest-авторизация (и прокси): событие login у webContents вкладки → модальное окно overlay
// с логином и паролем. Ввод делает пользователь; пароль не пишется ни в лог, ни на диск.

function createAuth(ctx, modal) {
  const pending = new Map(); // ключ (вкладка+хост+realm) → [callback]

  function keyOf(tabId, a) { return [tabId, a.isProxy ? 'p' : 's', a.host, a.port, a.realm].join('|'); }

  function callAll(key, user, pass) {
    const cbs = pending.get(key) || [];
    pending.delete(key);
    for (const cb of cbs) {
      try { if (user == null) cb(); else cb(user, pass); } catch (_) { /* вкладка уже закрыта */ }
    }
  }

  ctx.tabs.on('view-created', (tab, wc) => {
    wc.on('login', (event, details, authInfo, callback) => {
      event.preventDefault();
      const a = authInfo || {};
      const key = keyOf(tab.id, a);
      if (pending.has(key)) { pending.get(key).push(callback); return; } // тот же вопрос от нескольких ресурсов
      pending.set(key, [callback]);
      let url = '';
      try { url = details && details.url ? String(details.url) : ''; } catch (_) { url = ''; }
      modal.ask('platform-auth', {
        host: String(a.host || ''),
        port: Number(a.port) || 0,
        realm: String(a.realm || '').slice(0, 200),
        scheme: String(a.scheme || '').toLowerCase(),
        isProxy: !!a.isProxy,
        url: url.slice(0, 500),
        secure: /^https:/i.test(url),
      }, {
        keepOnBlur: true,
        tabId: tab.id,
        // окно относится к вкладке — показываем его над ней
        onShow: () => { if (ctx.tabs.activeId !== tab.id && ctx.tabs.get(tab.id)) ctx.tabs.activate(tab.id); },
      }).then((r) => {
        if (r && typeof r.username === 'string') callAll(key, r.username.slice(0, 1024), String(r.password || '').slice(0, 4096));
        else callAll(key, null);
      });
    });
  });

  ctx.tabs.on('closed', (tab) => {
    modal.cancelWhere((q) => q.type === 'platform-auth' && q.tabId === tab.id);
    for (const k of Array.from(pending.keys())) if (k.startsWith(tab.id + '|')) callAll(k, null);
  });

  return { pendingCount: () => pending.size };
}

module.exports = { createAuth };
