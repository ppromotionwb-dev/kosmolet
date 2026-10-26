# Поддержка Codex — разведка (27.10.2026)

Код не менялся. Настоящий `~/.codex` не трогали: все проверки шли во временной папке через `CODEX_HOME`.

## Где лежит CLI Codex

- Рабочий исполняемый файл: `%LOCALAPPDATA%\OpenAI\Codex\bin\<хэш>\codex.exe`. На момент проверки это была `codex-cli 0.163.0-alpha.11.2` с командами `exec`, `mcp add/list/get/remove/login`.
- Имя папки `<хэш>` меняется при обновлениях. Брать нужно самый свежий `bin\*\codex.exe`.
- Учётные данные общие с приложением Codex: `~/.codex/auth.json`.
- Копию из `WindowsApps` запустить нельзя: Permission denied.
- В PATH команды `codex` нет. Глобального npm-пакета `@openai/codex` тоже нет.

## Как Codex подключает MCP

- Приложение, CLI и плагин для редакторов читают один и тот же `~/.codex/config.toml` (или `%CODEX_HOME%`).
- HTTP поддерживается: таблица `[mcp_servers.<имя>]`, в ней `url`, транспорт streamable HTTP. Токен передаётся одним из двух способов:
  - `http_headers = { Authorization = "Bearer …" }`;
  - `bearer_token_env_var = "ИМЯ"` — токен берётся из переменной окружения.
- Есть и другие настройки: `env_http_headers`, `http_headers_helper`, таймауты, `enabled`, `enabled_tools`/`disabled_tools`, режимы подтверждения инструментов.
- Наш MCP-сервер подходит без изменений. С токеном Codex шлёт только POST: `initialize`, `notifications/initialized`, `tools/list`.
- Codex отличается от других клиентов: заголовок `User-Agent: codex-mcp-client/<версия>`, при подключении — `clientInfo {name: "codex-mcp-client", title: "Codex"}`.
- `instructions` сервера Codex читает, но гарантированно видны только первые 512 символов.

### Почему не `codex mcp add --url`

- Флага для заголовка там нет, только `--bearer-token-env-var`.
- Команда перезаписывает таблицу `kosmolet` целиком.
- Она переформатирует соседние записи: у одной пропали `args = []` и комментарий.

### Переопределение через `-c`

Работает без кавычек:

```
-c mcp_servers.kosmolet.url=http://127.0.0.1:PORT/mcp
-c mcp_servers.kosmolet.bearer_token_env_var=KOSMOLET_MCP_TOKEN
```

## План

1. **Кнопка «Подключить к Codex».**
   - Записывает в `config.toml` только таблицу `[mcp_servers.kosmolet]`: `url` и `http_headers.Authorization`.
   - Перед записью делает копию файла, запись атомарная.
   - Остальной файл не трогает. Если разметка странная, например dotted keys или многострочные строки, отказывается писать.
   - Нажимает её только пользователь. После записи приложение Codex нужно перезапустить или открыть новый чат.
2. **Поиск `codex`.**
   - Настройка `codexCommand`; пустое значение — искать автоматически.
   - Порядок поиска: сначала PATH, потом самый свежий `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`.
3. **Профиль «Codex» в терминале панели.**
   - Запуск: `codex.exe -c mcp_servers.kosmolet.url=<url> -c mcp_servers.kosmolet.bearer_token_env_var=KOSMOLET_MCP_TOKEN`, токен передаётся в окружении процесса.
   - В файлах и в командной строке токена нет.
4. **Журнал и подсветка вкладки.**
   - Агент определяется по `User-Agent`/`clientInfo`.
   - В записях журнала поле `agent: 'claude' | 'codex'`, подсветка вкладки показывает, какой агент действовал.
5. **Нейтральные тексты.**
   - В INSTRUCTIONS и сообщениях об ошибках пишем «agent», а не «Claude». Смысл должен укладываться в первые 512 символов.
   - Вкладку «Claude» в панели переименовать в «Агент». Инструкции для агента класть и в `CLAUDE.md`, и в `AGENTS.md`.
6. **Подтверждения в Codex.**
   - У наших инструментов есть `readOnlyHint`, поэтому режим подтверждения «writes» будет спрашивать только для пишущих.
   - По умолчанию ничего не ставим, решает пользователь.

## Источники

- https://learn.chatgpt.com/docs/extend/mcp?surface=cli
- https://learn.chatgpt.com/docs/mcp-server.md
- https://developers.openai.com/codex/app-server

## Сделано (26.10.2026)

- Пункт 1 — `src/main/features/bridge/codex.js` (`upsert` — чистая функция, проверена на соседних записях с комментариями, вложенных `[mcp_servers.kosmolet.*]`, отказе на dotted keys / inline-таблице / многострочных строках; таблица обновляется на своём месте). Кнопка — «Настройки → Claude → Подключение → Подключить к Codex» (IPC `kosmo:bridge.connectCodex`, `kosmo:bridge.codexInfo`). Копия прежнего файла — `config.toml.kosmolet-bak`.
- Пункт 2 — настройка `claude.codexCommand` (пусто = PATH → свежий `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe`).
- Пункт 3 — профиль `codex` в терминале панели (кнопка «Запустить Codex» и пункт меню «+»): `-c mcp_servers.kosmolet.url=…`, `-c …bearer_token_env_var=KOSMOLET_MCP_TOKEN`, токен — в окружении процесса.
- Пункт 4 — `agent: 'claude' | 'codex' | 'agent'` в записях журнала (по User-Agent запроса), метка «Codex» в журнале панели. Подсветка вкладки по агенту — не сделана.
- Пункт 5 (нейтральные тексты, переименование вкладки «Claude», AGENTS.md) и 6 — не делались.
- Проверено: dev-экземпляр с временным `CODEX_HOME` — запись, повтор без изменений, `codex mcp list/get` читают таблицу и `-c`; вызов MCP с UA `codex-mcp-client/…` → `agent: codex`; сессия «Codex» запускает codex.exe; `tools/smoke.mjs` — всё прошло. Настоящий `~/.codex` не трогали. Живой чат Codex с инструментами kosmolet — не проверяли.
