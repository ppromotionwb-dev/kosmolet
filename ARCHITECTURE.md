# Космолёт — архитектура (контракт для разработки)

Браузер IT-специалиста на Electron 45 (Chromium 156, Node 24). Цели в порядке важности:
1. **Быстрый и лёгкий** — без фреймворков в интерфейсе, ленивое всё, блокировщик рекламы, выгрузка неактивных вкладок.
2. **Удобен Claude** — встроенный MCP-сервер (Claude видит и управляет вкладками через код страниц), терминал с Claude прямо в браузере, «Отправить в Claude».
3. **Расширенные DevTools** — встроенный Chrome DevTools в боковой панели + свой API-сниффер (JSON, copy as fetch/curl/PowerShell, повтор запроса), хранилище/cookies, эмуляция устройств и сети, сниппеты, SEO/тех-рентген.
4. **Оформление** — темы интерфейса + тёмная тема для ЛЮБОГО сайта (движок Dark Reader), свой CSS на сайт.
5. Нужное для работы: поиск с «бэнгами» (`wb`, `oz`, `ym`…), маркетплейсы на быстрых кнопках, контейнеры (разные кабинеты в разных изолированных сессиях одновременно), расширения Chrome (из Chrome Web Store), загрузки.

> **Фактическое API ядра** (точные сигнатуры KChrome/KOverlay/KPanel/KSettings, payload'ы всех каналов IPC, отклонения от этого документа и подводные камни) — в [docs/core-reports.md](docs/core-reports.md). При расхождении верно то, что там и в коде.

Язык интерфейса — **русский**. Код — CommonJS в main, ванильный JS в интерфейсе. **Никакой сборки** (кроме того, что main сам собирает tab-preload при старте). Без TypeScript.

---

## 1. Раскладка файлов и владельцы

```
KOSMOLET/
  package.json                 — core
  ARCHITECTURE.md              — этот файл (правит только главный агент)
  README.md                    — tools-pack (для пользователя, по-русски)
  Запустить Космолёт.bat       — core
  assets/                      — tools-pack (иконка icon.png/icon.ico, logo.svg)
  tools/
    dev.mjs                    — core: CLI к dev-серверу (eval/shot/quit/health)
    start-dev.ps1              — core: запуск dev-экземпляра с профилем и портами
    mcp-call.mjs               — claude-bridge: CLI-клиент MCP для проверок
  src/
    main/
      main.js                  — core: bootstrap, флаги, порядок init модулей
      ctx.js                   — core: создание ctx (см. §3)
      store.js                 — core: JSON-хранилища с атомарной записью
      settings.js              — core: схема настроек, дефолты, миграции
      ipc.js                   — core: роутер IPC с проверкой отправителя
      windows.js               — core: окно, раскладка видов (layout)
      tabs.js                  — core: TabManager
      sessions.js              — core: контейнеры/сессии, протокол kosmo://, UA
      overlay.js               — core: всплывающий слой (overlay view)
      panel.js                 — core: правая панель (panel view + место под DevTools)
      commands.js              — core: реестр команд и горячих клавиш
      context-menu.js          — core: контекстное меню страницы (точки расширения)
      search.js                — core (база) → ux-chrome (бэнги/подсказки)
      preload-composer.js      — core: собирает tab-preload из частей
      dev-server.js            — core: dev-управление (только с --dev)
      features/                — модули фич, у каждого init(ctx)
        ux-chrome.js           — ux-chrome: история, закладки, подсказки, загрузки, разрешения, палитра
        themes.js              — themes: темы интерфейса и сайтов
        devtools.js            — devtools: док DevTools, эмуляция
        cdp-hub.js             — devtools: CDP-захват сети/консоли (API в ctx.cdp)
        claude-bridge.js       — claude-bridge: MCP-сервер, инструменты, отправка в Claude
        page-snapshot.js       — claude-bridge: скрипт снимка страницы для ИИ
        claude-terminal.js     — claude-terminal: node-pty, запуск claude, подключение
        platform.js            — platform: расширения, блокировщик, контейнеры, UA
        tools-pack.js          — tools-pack: сниппеты, рентген
    preload/
      ui-preload.js            — core: preload для интерфейса (chrome/panel/overlay)
      tab/                     — части tab-preload (порядок по имени файла)
        00-core.js             — core
        20-site-theme.js       — themes
        30-picker.js           — claude-bridge
    renderer/
      shared/
        tokens.css             — core (переменные), themes (пресеты)
        base.css               — core: сброс, кнопки, поля, скроллбары
        icons.js               — core: набор SVG-иконок (window.KIcons)
        theme.js               — core: применяет тему интерфейса (data-theme) + слушает изменения
        kui.js                 — core: мелкие хелперы (h(), toast(), copy())
      chrome/                  — верх окна: вкладки, адресная строка, панель
        index.html, chrome.css, chrome.js   — core
        features/*.js          — по фиче на файл: owner = фича (см. §6)
      overlay/                 — всплывающий слой
        index.html, overlay.css, overlay.js — core
        features/*.js          — owner = фича
      panel/                   — правая панель инструментов
        index.html, panel.css, panel.js     — core
        tools/<id>.js (+ .css) — owner = фича
      pages/                   — внутренние страницы kosmo://<host>/
        newtab/                — ux-chrome
        settings/index.html, settings.js, settings.css — core (оболочка)
        settings/sections/<id>.js — owner = фича
        history/               — ux-chrome
        downloads/             — ux-chrome
        extensions/            — platform
```

**Правило совместной работы.** Фича-агент пишет ТОЛЬКО свои файлы. Если нужна правка в файлах core — минимальная, аддитивная, перед правкой перечитать файл, в отчёте перечислить. Чужие фича-файлы не трогать.

---

## 2. Запуск, флаги, dev-режим

- `npm start` → обычный запуск. Профиль: `%APPDATA%/Kosmolet` (userData).
- Флаги командной строки (парсит core, доступны в `ctx.flags`):
  - `--dev` — dev-режим: включает dev-сервер и remote debugging.
  - `--profile=<name>` — userData = `<project>/.profiles/<name>` (для параллельных тестовых экземпляров; single-instance lock — на userData).
  - `--dev-port=<n>` (по умолчанию 47399) — dev-сервер.
  - `--cdp-port=<n>` (по умолчанию 9333 в dev) — `remote-debugging-port`.
  - `--mcp-port=<n>` — переопределяет `settings.claude.mcpPort` (не сохраняется).
  - `--no-restore` — не восстанавливать сессию вкладок.
  - `--open=<url>` — открыть URL вкладкой (можно несколько).
- **Dev-сервер** (`dev-server.js`, только с `--dev`, только 127.0.0.1):
  - `GET /health` → `{ok, pid, ready}`
  - `POST /eval {code}` → выполняет `async (ctx, electron, require) => { <code> }` в main, возвращает JSON результата (ошибка → `{error, stack}`).
  - `POST /shot {file?}` → PNG всего окна как видит пользователь (desktopCapturer по `win.getMediaSourceId()`; запасной путь — композит capturePage видов). Возвращает путь (по умолчанию `tools/dev-out/shot-<время>.png`).
  - `POST /quit`.
- `tools/start-dev.ps1 -Profile <name> -DevPort <n> -McpPort <n> -CdpPort <n> [-Open <url>]` — стартует detached, ждёт `/health`, печатает PID. Окно показывается **без фокуса** (`showInactive`).
- `node tools/dev.mjs --port <n> eval "<code>" | shot [file] | quit | health`.
- **Параллельные агенты:** у каждого свой профиль и порты (выдаются в задании). Завершать только СВОЙ экземпляр (`/quit` или kill своего PID). Никогда `taskkill /im electron.exe`.

---

## 3. ctx — общий объект main-процесса

Создаётся в `ctx.js`, передаётся в `init(ctx)` каждой фичи. Фичи могут добавлять свои API в ctx (`ctx.cdp`, `ctx.bridge`, `ctx.themes`, `ctx.history`…) — только под своим ключом.

```js
ctx = {
  app, electron,                 // модули electron
  flags,                         // разобранные флаги (§2)
  paths: { root, src, renderer, userData, devOut, inbox },  // inbox = settings.claude.inboxDir
  bus,                           // EventEmitter для межмодульных событий
  log(scope, ...args),           // консольный лог с префиксом [scope]
  store,                         // createStore(name, defaults) → { get(), set(obj), patch(fn|obj), on('change', cb), flush() }
  settings,                      // { get(path?), set(path, value), patch(obj), on('change', (path, value) => {}), schema }
  ipc,                           // §4
  windows,                       // { main: BrowserWindow, layout(), chromeHeight, setChromeHeight(px) }
  tabs,                          // §5
  sessions,                      // §7
  overlay,                       // §8
  panel,                         // §9
  commands,                      // §10
  contextMenu,                   // { addProvider((params, tab) => MenuItemOptions[]) } — пункты добавляются в конец секций
  search,                        // { resolve(input) → {url, kind: 'url'|'search'|'bang'|'internal'}, suggest(input) → [] , addSuggestProvider(fn) }
  preload,                       // { addPart(name, filePath) } — до сборки (вызывать в init синхронно)
  broadcast(channel, payload),   // отправить во все UI webContents (chrome, panel, overlay) и внутренние страницы
}
```

Порядок старта (`main.js`): флаги → `app.setPath('userData')` при `--profile` → `protocol.registerSchemesAsPrivileged` (kosmo) → single-instance lock → `app.whenReady` → ctx → settings → sessions → **init фич синхронной фазой** (регистрация частей preload, команд, IPC, onSession-хуков) → сборка tab-preload → окно и UI → восстановление вкладок → `bus.emit('ready')`. Каждая фича инициализируется в try/catch: падение одной фичи не роняет браузер (ошибка в лог + `ctx.featureErrors`).

Фича-модуль:
```js
module.exports = { id: 'themes', init(ctx) { ... }, async start(ctx) { /* после ready, опционально */ } };
```

---

## 4. IPC

Все каналы начинаются с `kosmo:`. Формат имени: `kosmo:<область>.<действие>` (`kosmo:tabs.create`).

**Main:** `ctx.ipc.handle(channel, async (payload, meta) => result, { allow: ['ui'] })`
- `allow`: `'ui'` — наш интерфейс (chrome/panel/overlay webContents); `'internal'` — внутренние страницы `kosmo://<host>/` во вкладках (только хосты newtab, settings, history, downloads, extensions); `'tab'` — любые страницы во вкладках через tab-preload (НЕДОВЕРЕННЫЕ данные! канал должен начинаться с `kosmo-tab:`).
- `meta = { kind: 'ui'|'internal'|'tab', webContents, tab /* если из вкладки */, frameUrl }`.
- Роутер проверяет отправителя по `event.sender` и `event.senderFrame.url`; чужой — отказ с ошибкой.
- `ctx.ipc.on(channel, fn, opts)` — для send без ответа. `ctx.ipc.handleSync(channel, fn, opts)` — для sendSync (только `kosmo-tab:*`, быстрые ответы).

**Renderer (ui-preload и 00-core для внутренних страниц)** — `window.kosmo`:
```js
kosmo.invoke(channel, payload)   // Promise; только 'kosmo:*'
kosmo.send(channel, payload)
kosmo.on(channel, cb) → off()    // подписка на события main → renderer
kosmo.platform, kosmo.versions
```
**События main → UI**: `ctx.broadcast(channel, payload)`. Стандартные:
- `kosmo:tabs.state` → `{ tabs: TabInfo[], activeId }` (полный список, троттлинг ~16 мс)
- `kosmo:settings.changed` → `{ path, value, settings }`
- `kosmo:layout.state` → `{ panelOpen, panelWidth, panelTool, fullscreen }`

Базовые каналы core: `kosmo:tabs.*` (create, close, activate, navigate, back, forward, reload, stop, move, pin, mute, duplicate, reopenClosed, zoom, find, stopFind), `kosmo:settings.get|set|patch`, `kosmo:layout.setChromeHeight`, `kosmo:panel.toggle|open|close|setWidth|setTool`, `kosmo:overlay.open|close|resize|event`, `kosmo:commands.list|run`, `kosmo:search.suggest`, `kosmo:app.menu` (меню «⋯»).

---

## 5. Вкладки — `ctx.tabs` (TabManager)

```js
TabInfo = { id, containerId, containerColor, url, title, favicon, loading, pinned, muted, audible,
            zoom, discarded, canGoBack, canGoForward, crashed, claudeActiveAt, badges: {} }
ctx.tabs.list() → TabInfo[]        ctx.tabs.get(id) → Tab   ctx.tabs.active() → Tab
ctx.tabs.create({ url, containerId='main', active=true, index, pinned, openerId, lazy }) → Tab
ctx.tabs.close(id)  activate(id)  navigate(id, url)  move(id, index)  duplicate(id)  reopenClosed()
ctx.tabs.discard(id)  ctx.tabs.setBadge(id, key, value)  // badges видны в полосе вкладок (например claude, adblock)
ctx.tabs.on(event, cb)  // 'created'(tab) 'view-created'(tab, webContents) 'view-destroyed'(tab)
                        // 'activated'(tab, prevTab) 'closed'(tab) 'navigated'(tab, url) 'updated'(tab) 'loaded'(tab)
Tab = { id, info /*TabInfo*/, view /*WebContentsView|null*/, wc /*webContents|null*/, ensureView() }
```
- Одна вкладка = один `WebContentsView` с `session = ctx.sessions.get(containerId)`, `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, `backgroundThrottling: true`, `spellcheck: false`.
- `window.open`/target=_blank → `setWindowOpenHandler` возвращает `{action:'allow', createWindow: opts => новая вкладка в том же контейнере (сохраняет opener)}`; ссылки с Ctrl/средней кнопкой — фоновая вкладка.
- Ленивое восстановление: восстановленные вкладки создаются `lazy` (без view) — view создаётся при первой активации.
- Выгрузка: вкладка неактивна дольше `settings.performance.discardAfterMin` (0 = выкл), не играет звук, не закреплена → `discard` (view уничтожается, TabInfo остаётся). Активация → загрузка заново.
- Сессия вкладок пишется в `session.json` (url, title, containerId, pinned, активная) с дебаунсом.
- Закрытые вкладки — стек из 25 для Ctrl+Shift+T.
- Навигация во вкладке на `kosmo://` с http(s)-страницы блокируется (`will-navigate`); `kosmo://ui/*` во вкладках не обслуживается.

---

## 6. Интерфейс: chrome / overlay / panel / страницы

**Слои окна** (`windows.js`): `BrowserWindow` (frameless, `titleBarStyle:'hidden'`, `titleBarOverlay` — нативные кнопки Windows, цвет синхронизируется с темой) — его собственный webContents рисует **chrome** (полоса вкладок = область перетаскивания окна, панель навигации, полоса закладок, полосы-уведомления). Поверх — дочерние `WebContentsView`: активная вкладка, панель (`panel`), DevTools (`devtools`), **overlay** (самый верхний).

Геометрия: `chromeH` сообщает chrome (`kosmo:layout.setChromeHeight`, ResizeObserver). Вкладка: `{x:0, y:chromeH, w: W - panelW, h: H - chromeH}`. Панель: `{x: W - panelW, y: chromeH, w: panelW, h: H - chromeH}`. HTML5-fullscreen → chromeH=0, панель скрыта.

**chrome** (`renderer/chrome`): `index.html` содержит слоты:
- `#tabstrip` (core), `#nav` (назад/вперёд/обновить — core), `#omnibox` (core),
- `#slot-omnibox-right` (иконки внутри адресной строки: звезда закладки, тема сайта, щит блокировщика…),
- `#slot-toolbar-right` (кнопки: расширения, загрузки, Claude, панель, меню «⋯»),
- `#slot-bars` (полосы под панелью: закладки, поиск по странице, запрос разрешения).
Фича подключает `chrome/features/<id>.js` (+css) — core перечисляет их в index.html заранее: `ux-chrome.js`, `themes.js`, `platform.js`, `claude.js`, `devtools.js`, `tools-pack.js`. Скрипт фичи использует `window.KChrome` (API core): `KChrome.slot(name)`, `KChrome.addToolbarButton({id, icon, title, onClick, order})`, `KChrome.addOmniboxIcon({...})`, `KChrome.addBar({id, el, order})`, `KChrome.state` (tabs, activeId, settings), `KChrome.on('state'|'settings', cb)`, `KChrome.openOverlay(type, data, anchorEl)`.

**overlay** (`renderer/overlay`): прозрачный WebContentsView для всплывающих окон, которые должны перекрывать страницу (выпадающий список адресной строки, командная палитра, поповеры загрузок/темы/Claude). `ctx.overlay.open({type, data, anchor:{x,y,w,h}, modal})`: `modal:true` → слой на всё окно с затемнением (палитра), иначе слой ровно по размеру поповера под якорем (overlay сообщает свой размер через `kosmo:overlay.resize`). Закрытие: Esc, клик мимо (blur окна chrome / фокус вкладки), `kosmo:overlay.close`. Overlay **не забирает фокус** у адресной строки для `type:'omnibox'` (клавиши обрабатывает chrome и шлёт `kosmo:overlay.event`). Регистрация типов: `KOverlay.register(type, { render(root, data, api), update(data) })` в `overlay/features/<id>.js`.

**panel** (`renderer/panel`): правая панель инструментов. Шапка — вкладки инструментов; слева край 5px — перетаскивание ширины. Инструменты регистрируются `KPanel.register({ id, title, icon, order, mount(el, api), onShow(), onHide() })` в `panel/tools/<id>.js`. Инструмент `devtools` особый: при его активации main показывает `devtools`-view на месте тела панели (ниже шапки 36px). Список инструментов и владельцев:
| id | Название | Владелец |
|---|---|---|
| devtools | DevTools | devtools |
| network | Сеть и API | devtools |
| storage | Хранилище | devtools |
| emulation | Устройство | devtools |
| claude | Claude | claude-terminal (терминал) + claude-bridge (журнал действий — подвкладка) |
| theme | Тема сайта | themes |
| snippets | Сниппеты | tools-pack |
| xray | Рентген | tools-pack |

**Внутренние страницы**: `kosmo://newtab/`, `kosmo://settings/`, `kosmo://history/`, `kosmo://downloads/`, `kosmo://extensions/`. Отдаются из `renderer/pages/<host>/` для всех сессий-контейнеров; `kosmo://ui/...` — только для UI-сессии. Ответы с CSP `default-src 'self' kosmo:; img-src * data: blob:; style-src 'self' 'unsafe-inline'` и `frame-ancestors 'none'`. Страница настроек — оболочка core, разделы `settings/sections/<id>.js` регистрируются `KSettings.section({ id, title, icon, order, render(el, api) })`, api: `get(path)`, `set(path, v)`, `on(cb)`, `invoke`.

**Общие ресурсы UI** — `kosmo://ui/shared/...` и для страниц `kosmo://<host>/shared/...` (core обслуживает `shared/` для всех хостов).

---

## 7. Сессии и контейнеры — `ctx.sessions`

- Контейнер = `{ id, name, color }`, хранится в `settings.containers`. Сессия: `session.fromPartition('persist:c-' + id)`; основной `id:'main'`.
- `ctx.sessions.get(containerId)` → Session (создаёт по требованию). `ctx.sessions.onSession((ses, containerId) => {})` — вызывается для всех существующих и будущих сессий. Здесь фичи вешают блокировщик, расширения, загрузки, разрешения.
- Core в каждой сессии: протокол `kosmo`, `registerPreloadScript({type:'frame', filePath: <собранный tab-preload>})`, чистый User-Agent (без `Electron/` и `kosmolet/` — обычный Chrome 156 Windows), `Accept-Language: ru-RU,ru;q=0.9,en;q=0.8`.
- UI-сессия: `session.fromPartition('kosmo-ui')` (в памяти) — только для chrome/panel/overlay.

## 8–10. Overlay, panel, commands (main)

- `ctx.overlay.open(opts)`, `close()`, `isOpen()`, `send(type, data)`; события `ctx.overlay.on('event', (type, data) => {})`.
- `ctx.panel.open(toolId?)`, `close()`, `toggle(toolId?)`, `isOpen()`, `tool()`, `setWidth(px)`, `devtoolsView` (WebContentsView для DevTools — его настраивает фича devtools), `send(channel, payload)`; события `'tool-changed'`, `'opened'`, `'closed'`. Ширина в `settings.ui.panelWidth`.
- `ctx.commands.register({ id, title, keys?: ['Ctrl+K'], category, when?: () => bool, run: (args, ctx) => {} })`, `run(id, args)`, `list()`. Горячие клавиши ловятся в `before-input-event` ВСЕХ webContents (chrome, вкладки, панель, overlay). Core регистрирует базовые: новая вкладка Ctrl+T, закрыть Ctrl+W, восстановить Ctrl+Shift+T, след./пред. Ctrl+Tab/Ctrl+Shift+Tab, Ctrl+1..9, адресная строка Ctrl+L/F6/Alt+D, обновить F5/Ctrl+R, жёсткое Ctrl+Shift+R/Ctrl+F5, назад/вперёд Alt+←/→, масштаб Ctrl+=/−/0, панель F12 (DevTools) и Ctrl+Shift+I, поиск по странице Ctrl+F, полноэкранный F11, настройки Ctrl+,.

---

## 11. Настройки (`settings.json`) — схема и дефолты

```js
{
  ui: { theme: 'cosmos' /* cosmos|graphite|light|terminal|custom */, accent: '#7c6cff', density: 'normal' /* compact|normal */,
        fontSize: 13, showBookmarksBar: true, panelWidth: 460, panelTool: 'devtools', custom: { bg, surface, text } },
  siteThemes: { mode: 'list' /* off|all|list */,
                defaults: { engine: 'dynamic' /* dynamic|filter */, brightness: 100, contrast: 100, sepia: 0, grayscale: 0,
                            bg: '#14161c', text: '#e6e6ea' },
                sites: { /* 'wildberries.ru': { enabled: true, brightness?, contrast?, sepia?, css: '' } */ } },
  search: { engine: 'google' /* google|yandex|ddg|bing */, bangs: [ /* {key, name, url:'...{q}', numericUrl?:'...{q}'} */ ] },
  containers: [ { id: 'main', name: 'Основной', color: '#7c6cff' } ],
  privacy: { adblock: true, adblockAllow: ['seller.wildberries.ru','seller.ozon.ru','partner.market.yandex.ru','localhost'],
             userAgent: 'chrome' /* chrome|custom */, customUA: '' },
  performance: { discardAfterMin: 30, restoreSession: true },
  downloads: { dir: '' /* '' = системная «Загрузки» */, ask: false },
  claude: { mcpEnabled: true, mcpPort: 47321, token: '' /* генерируется при первом старте */, access: 'full' /* off|read|full */,
            inboxDir: '' /* '' = Документы/Космолёт/claude-inbox */, terminalCwd: '' /* '' = Рабочий стол */, claudeCommand: 'claude' },
  devtools: { capture: 'api' /* off|api|all */, maxEntries: 1500, remoteDebugging: false, remoteDebuggingPort: 9222 },
  sitePermissions: { /* 'origin': { notifications: 'allow'|'deny', ... } */ }
}
```
Фича может добавлять ключи только в своей ветке (новые ветки — в отчёте). `settings.set` валидирует тип по дефолту.

Прочие хранилища (userData): `session.json` (core), `history.json`, `bookmarks.json` (ux-chrome), `snippets.json` (tools-pack), `adblock-engine.bin` (platform), `extensions/` (platform), `claude-activity.json` (claude-bridge), `gen/tab-preload.js` (core).

---

## 12. tab-preload (страницы во вкладках)

`preload-composer.js` при старте склеивает `src/preload/tab/*.js` (по имени) + части от `ctx.preload.addPart` в `userData/gen/tab-preload.js`. Каждая часть оборачивается в `try { (function(KOSMO){ ... })(KOSMO) } catch(e) {}`; `KOSMO` — общий объект части preload: `{ ipcRenderer, contextBridge, webFrame, isInternal, host }`.
- Preload работает в **изолированном мире** с `sandbox:true`: `require('electron')` → только `ipcRenderer, contextBridge, webFrame`. Модули node_modules недоступны — библиотеки (Dark Reader) встраиваются текстом через `addPart`.
- `00-core.js`: если `location.protocol === 'kosmo:'` и хост в списке внутренних — `contextBridge.exposeInMainWorld('kosmo', {...})`. На обычных сайтах в главный мир страницы НИЧЕГО не выставляется.
- Каналы из вкладок — только `kosmo-tab:*`, данные недоверенные, main проверяет и ограничивает размеры.

---

## 13. Claude-мост (MCP) — договорённости

- HTTP MCP (Streamable HTTP, `@modelcontextprotocol/sdk`) на `127.0.0.1:<mcpPort>/mcp`. Обязательный `Authorization: Bearer <token>`. Запросы с заголовком `Origin` (кроме отсутствующего) или с `Host` не 127.0.0.1/localhost — отказ (защита от сайтов и DNS-rebinding).
- Режимы доступа: `off` (сервер выключен), `read` (только чтение: список вкладок, снимок, HTML, скриншот, сеть, консоль), `full` (+ навигация, клики, ввод, eval, fetch_in_page, cookies).
- Каждый вызов пишется в журнал (время, инструмент, кратко аргументы, вкладка, результат ok/ошибка) → панель Claude, а вкладка получает `claudeActiveAt` (полоса вкладок подсвечивает её ~3 с).
- Подключение: `claude mcp add --scope user --transport http kosmolet http://127.0.0.1:<port>/mcp --header "Authorization: Bearer <token>"` (кнопка в настройках, только по нажатию пользователя) и `userData/gen/claude-mcp.json` для `claude --mcp-config` во встроенном терминале.
- `ctx.cdp` (владелец devtools) — API для моста:
  ```js
  ctx.cdp.ensure(tabId) → Promise<void>           // подключить debugger к вкладке
  ctx.cdp.network(tabId, { filter, type /* api|all|doc|js|css|img */, limit }) → Entry[]
  ctx.cdp.entry(tabId, requestId) → Entry & { requestHeaders, responseHeaders, postData }
  ctx.cdp.body(tabId, requestId) → { body, base64Encoded, truncated }
  ctx.cdp.console(tabId, { level, limit }) → [{ ts, level, text, url, line }]
  ctx.cdp.send(tabId, method, params) → результат CDP
  ctx.cdp.on('entry', (tabId, entry) => {})  ctx.cdp.clear(tabId)
  Entry = { id, ts, method, url, status, type, mime, size, timeMs, fromCache, initiator, failed, errorText }
  ```
- `ctx.bridge.pageFetch(tabId, {url, method, headers, body})` (владелец claude-bridge) — fetch в контексте страницы (с её cookies), используется и панелью «Сеть» для повтора запроса.

---

## 14. Дизайн интерфейса

- Характер: аккуратный тёмный «космос» по умолчанию — глубокий графитово-синий фон, один акцент (фиолетово-синий `#7c6cff`), много воздуха, мелкая чёткая типографика. Привычная раскладка Chrome (вкладки сверху, адресная строка), без сюрпризов.
- Шрифты системные: `"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`; моно — `"Cascadia Code", Consolas, monospace`. Никаких внешних шрифтов и CDN.
- Размеры (normal): полоса вкладок 38px, панель 40px, закладки 30px; compact — 32/34/26. Радиусы 8px (кнопки), 10px (поповеры). Иконки 16px, штрих 1.6, стиль lucide (свои inline SVG из `shared/icons.js`).
- Анимации 120–180 мс ease-out, только transform/opacity, уважать `prefers-reduced-motion`.
- **Без «нейрослопа»**: никаких эмодзи в интерфейсе, искорок/✨ у Claude, лишних стрелочек, номерков, подсказок-пузырей поверх всего. Иконка Claude — простой знак (не искорка).
- Все цвета — через переменные `tokens.css`: `--k-bg, --k-bg-elev, --k-bg-sunken, --k-surface, --k-surface-hover, --k-border, --k-border-strong, --k-text, --k-text-dim, --k-text-faint, --k-accent, --k-accent-hover, --k-accent-soft, --k-on-accent, --k-ok, --k-warn, --k-danger, --k-focus, --k-shadow, --k-radius, --k-radius-sm, --k-font, --k-mono, --k-fs, --k-tab-h, --k-bar-h`.
- Тексты — короткие, по-русски, без канцелярита. Состояния: пусто/загрузка/ошибка есть у каждого списка.

## 15. Производительность (бюджет)

- Холодный старт до видимого окна с вкладкой ≤ 1.5 с на этой машине; chrome UI ≤ 150 КБ JS без фреймворков.
- Панель и overlay создаются лениво (при первом открытии). Инструменты панели монтируются при первом показе.
- CDP-захват по умолчанию только `api` (XHR/Fetch + документ), тела ответов — лениво (`Network.getResponseBody` по запросу), буфер `maxTotalBufferSize` 64 МБ.
- Никаких setInterval чаще 1 с в фоне; рассылки состояния — с троттлингом.
