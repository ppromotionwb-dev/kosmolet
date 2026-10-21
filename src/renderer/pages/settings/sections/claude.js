// Владелец: claude-bridge (MCP) + claude-terminal (терминал). Заглушка core — фича заменяет файл целиком.
// API: KSettings.section({id, title, icon, order, keywords, description, render(el, api)}); хелперы — api.ui (toggle/select/number/text/color/row/group).
'use strict';
KSettings.section({
  id: 'claude', title: 'Claude', icon: 'claude', order: 60,
  keywords: 'claude mcp токен терминал ии',
  render(el, api) {
    el.appendChild(api.ui.group(null, api.ui.free(api.empty({ icon: 'claude', title: 'Скоро', text: 'Здесь будут настройки: подключение Claude: MCP-сервер, доступ, токен и встроенный терминал.' }))));
  }
});
