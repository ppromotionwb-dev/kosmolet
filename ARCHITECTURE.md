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
    smoke.mjs                  — core: регрессия ядра (27 проверок через CDP и dev-сервер)
    make-icon.js, make-shortcut.ps1 — tools-pack: сборка icon.ico/png и ярлыка
    (подпапки фич: features/ux/, bridge/, devtools/, platform/, tools-pack/ — см. Приложение)
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
        site-intel.js (+ site-intel/shape.js) — site-intel: каталог API сайтов, действия, заметки
    preload/
      ui-preload.js            — core: preload для интерфейса (chrome/panel/overlay)
      tab/                     — части tab-preload (порядок по имени файла)
        00-core.js             — core
        20-site-theme.js       — themes
        30-picker.js           — claude-bridge
        50-site-intel.js       — site-intel
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
  - `--open=<url>` — открыть URL вкладкой (можно несколько; адрес без флага тоже открывается — так его передаёт Windows).
  - Только с `--dev`: `--offscreen` (окно за правым краем экрана, положение не сохраняется; `start-dev.ps1` ставит его по умолчанию, `-OnScreen` — показать на экране), `--ui-root=<папка>` (подмена файлов `kosmo://ui` для тестов). `--selftest` разбирается, но ничего не делает.
- **Dev-сервер** (`dev-server.js`, только с `--dev`, только 127.0.0.1):
  - `GET /health` → `{ok, pid, ready, profile, userData, devPort, cdpPort, mcpPort, featureErrors}`
  - `GET /logs?n=200` → последние строки лога main и консолей интерфейса (`ui:chrome`, `ui:panel`, `ui:overlay`)
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
- `allow`: `'ui'` — наш интерфейс (chrome/panel/overlay webContents); `'internal'` — внутренние страницы `kosmo://<host>/` во вкладках (только хосты newtab, settings, history, downloads, extensions; только главный фрейм); `'internal:<host>'` — одна внутренняя страница (например `'internal:settings'`); `'tab'` — любые страницы во вкладках через tab-preload (НЕДОВЕРЕННЫЕ данные! канал должен начинаться с `kosmo-tab:`).
- **Права внутренних страниц (SEC-1/SEC-2).** Всё читают и пишут только `ui` и `kosmo://settings`. Остальные внутренние страницы читают из настроек только ветки `ui/search/downloads/containers` (без токена), пишут только `downloads.ask` и `downloads.dir=''` (страница downloads); `settings.patch/remove` и все каналы моста Claude (`kosmo:bridge.*`) — только `ui` и settings. Рассылка `kosmo:settings.changed` таким страницам урезана (без токена и чужих веток).
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
- Выгрузка: вкладка неактивна дольше `settings.performance.discardAfterMin` (0 = выкл), не играет звук, не закреплена, не грузится → `discard` (view уничтожается, TabInfo остаётся). Активация → загрузка заново. Таймер не выгружает вкладку с открытыми DevTools (в панели или отдельном окне), с эмуляцией устройства и под guard фичи (`ctx.tabs.addDiscardGuard`); ручная «Выгрузить из памяти» работает всегда.
- Сессия вкладок пишется в `session.json` (url, title, containerId, pinned, favicon, история переходов до 30, активная; `favicons` — data:URL значков ≤ 8 КБ, чтобы при старте не ходить за ними в сеть) с дебаунсом.
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
| site | Сайт | site-intel |

**Внутренние страницы**: `kosmo://newtab/`, `kosmo://settings/`, `kosmo://history/`, `kosmo://downloads/`, `kosmo://extensions/`. Отдаются из `renderer/pages/<host>/` для всех сессий-контейнеров; `kosmo://ui/...` — только для UI-сессии. Ответы с CSP `default-src 'self' kosmo:; img-src * data: blob:; style-src 'self' 'unsafe-inline'` и `frame-ancestors 'none'`. Страница настроек — оболочка core, разделы `settings/sections/<id>.js` регистрируются `KSettings.section({ id, title, icon, order, render(el, api) })`, api: `get(path)`, `set(path, v)`, `on(cb)`, `invoke`.

**Общие ресурсы UI** — `kosmo://ui/shared/...` и для страниц `kosmo://<host>/shared/...` (core обслуживает `shared/` для всех хостов).

---

## 7. Сессии и контейнеры — `ctx.sessions`

- Контейнер = `{ id, name, color }`, хранится в `settings.containers`. Сессия: `session.fromPartition('persist:c-' + id)`; основной `id:'main'`.
- `ctx.sessions.get(containerId)` → Session (создаёт по требованию). `ctx.sessions.onSession((ses, containerId) => {})` — вызывается для всех существующих и будущих сессий. Здесь фичи вешают блокировщик, расширения, загрузки, разрешения.
- Core в каждой сессии: протокол `kosmo`, `registerPreloadScript({type:'frame', filePath: <собранный tab-preload>})`, чистый User-Agent (без `Electron/` и `kosmolet/` — обычный Chrome 156 Windows), `Accept-Language: ru-RU,ru;q=0.9,en;q=0.8`.
- UI-сессия: `session.fromPartition('kosmo-ui')` (в памяти) — только для chrome/panel/overlay.
- **Изолированные вкладки** (вкладка = свой контейнер, без окон и профилей). Временный контейнер — `{ id: 't…', name: 'Изоляция N', color, temp: true }` в `settings.containers`; сессия `persist:c-<id>` (вход переживает перезапуск, пока жива вкладка). Удаляется с данными через 300 мс после закрытия последней вкладки и при старте, если его вкладки не восстановились. «Оставить» снимает `temp`. Окна и ссылки страницы (`window.open`, target=_blank) остаются в контейнере открывшей вкладки — OAuth и кабинеты работают.
  - Вход: `Ctrl+Shift+N` (команда `tab.newIsolated`), Shift+клик по «+», меню вкладки/чипа «Новый изолированный», правый клик по ссылке «Открыть в изолированной вкладке», IPC `kosmo:tabs.create {isolated: true}`. Режим `privacy.isolateNewTabs` — так открываются ВСЕ новые вкладки интерфейса (Ctrl+T, «+», без `containerId`/opener); `{isolated: false}` или Ctrl+клик по «+» — обычная.
  - API: `ctx.platform.containers.{create({name?, color?, temp=true}), openIsolated({url?, index?, active?, temp?, name?}) → {tab, container}, keep(id, name?), sweep(ids?), remove(id)}`. Ядро: `ctx.sessions.exists(id)`, `resolve(id)` (несуществующий → обработчик `setMissingHandler`, platform открывает в новом временном — повтор закрытой вкладки удалённого контейнера не попадает в основной). TabInfo: `containerTemp`.
  - MCP: `containers_list` (read), `container_create {name?, color?, temporary?}` (full), `tab_open {isolated, containerName, keep}`; `tabs_list` показывает `[id]` контейнера. Для ИИ: один контейнер на кабинет маркетплейса.
  - Регрессия: `node tools/containers-test.mjs <devPort> <cdpPort> [profile]` (14 проверок: cookies/localStorage, window.open, автоудаление, «Оставить», повтор закрытой, режим, IPC, MCP).

## 8–10. Overlay, panel, commands (main)

- `ctx.overlay.open(opts)`, `close()`, `isOpen()`, `send(type, data)`, `toast(text, opts)` (немодальный тост у нижнего края области вкладки; при открытом поповере — внутри него); события `ctx.overlay.on('event', (type, data, name) => {})`. Тосты из chrome (`KUI.toast`) тоже идут через overlay — сам chrome закрыт видом вкладки.
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
  containers: [ { id: 'main', name: 'Основной', color: '#7c6cff' } /* + temp: true у временных (изолированные вкладки) */ ],
  privacy: { adblock: true, adblockAllow: ['seller.wildberries.ru','seller.ozon.ru','partner.market.yandex.ru','localhost'],
             userAgent: 'chrome' /* chrome|custom */, customUA: '', isolateNewTabs: false },
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

`preload-composer.js` при старте склеивает `src/preload/tab/*.js` (по имени) + части от `ctx.preload.addPart` в `userData/gen/tab-preload.js`. Каждая часть оборачивается в `try { (function(KOSMO){ ... })(KOSMO) } catch(e) {}`; `KOSMO` — общий объект части preload: `{ ipcRenderer, contextBridge, webFrame, isInternal, host, protocol, isTop, INTERNAL_HOSTS, send, invoke, sendSync }` (`send/invoke/sendSync` — только `kosmo-tab:*`). Фактический список частей — в Приложении.
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
  ctx.cdp.entry(tabId, requestId) → Promise<Entry & { requestHeaders, responseHeaders, postData }>
  ctx.cdp.body(tabId, requestId) → { body, base64Encoded, truncated }
  ctx.cdp.console(tabId, { level, limit }) → [{ ts, level, text, url, line }]
  ctx.cdp.send(tabId, method, params) → результат CDP
  ctx.cdp.on('entry', (tabId, entry) => {})  ctx.cdp.clear(tabId)
  Entry = { id, ts, method, url, status, type, mime, size, timeMs, fromCache, initiator, failed, errorText }
  ```
  **Факт:** `entry()` асинхронный (`await ctx.cdp.entry(...)` — тело запроса может дочитываться); есть доп. методы и события — см. Приложение.
- `ctx.cdp.pageFetch(tabId, {url, method, headers, body})` (владелец **devtools**, `cdp-hub.js`) — fetch в контексте страницы (с её cookies) через CDP-мир `kosmolet-fetch`, не ждёт конца загрузки страницы; им пользуется панель «Сеть» («Повторить», «Изменить и отправить»). У моста есть своя обёртка `ctx.bridge.pageFetch` для MCP-инструмента `page_fetch`.

---

## 14. Дизайн интерфейса

- Характер: аккуратный тёмный «космос» по умолчанию — глубокий графитово-синий фон, один акцент (фиолетово-синий `#7c6cff`), много воздуха, мелкая чёткая типографика. Привычная раскладка Chrome (вкладки сверху, адресная строка), без сюрпризов.
- Шрифты системные: `"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif`; моно — `"Cascadia Code", Consolas, monospace`. Никаких внешних шрифтов и CDN.
- Размеры (normal): полоса вкладок 38px, панель 40px, закладки 30px; compact — 32/34/26. Радиусы 8px (кнопки), 10px (поповеры). Иконки 16px, штрих 1.6, стиль lucide (свои inline SVG из `shared/icons.js`).
- Анимации 120–180 мс ease-out, только transform/opacity, уважать `prefers-reduced-motion`.
- **Без «нейрослопа»**: никаких эмодзи в интерфейсе, искорок/✨ у Claude, лишних стрелочек, номерков, подсказок-пузырей поверх всего. Иконка Claude — простой знак (не искорка).
- Все цвета — через переменные `tokens.css`: `--k-bg, --k-bg-elev, --k-bg-sunken, --k-surface, --k-surface-hover, --k-border, --k-border-strong, --k-text, --k-text-dim, --k-text-faint, --k-accent, --k-accent-hover, --k-accent-soft, --k-on-accent, --k-ok, --k-warn, --k-danger, --k-focus, --k-shadow, --k-radius, --k-radius-sm, --k-font, --k-mono, --k-fs, --k-tab-h, --k-bar-h`.
- Тексты — короткие, по-русски, без канцелярита. Состояния: пусто/загрузка/ошибка есть у каждого списка.
- **Факт (после правок 22.10):** в `tokens.css` есть и другие токены (полный список — в файле). Важные добавки: `--k-text-faint` — второстепенный текст с контрастом ≥ 4,5:1; `--k-text-ghost` — только декор (иконки пустых состояний, «+» в сочетаниях), не для текста; `--k-accent-fill` — заливка основной кнопки и счётчиков (theme.js затемняет акцент до контраста ≥ 4,5 с белым); `--k-accent-text`, `--k-backdrop` (затемнение под модальным слоем, им же затемняются нативные кнопки окна), `--k-shadow-pop`.
- **Правило поповеров:** переключатель в шапке поповера фичи означает «этот сайт» (тема, блокировщик); глобальное включение/выключение — кнопкой в подвале («Выключить везде»).
- Сочетания клавиш в интерфейсе — через `KUI.kbd(combo)` (клавиши раздельно, тонкий «+»); шапка «текущий сайт» в инструментах панели — `api.siteHeader({icon, title, sub, actions})`.

## 15. Производительность (бюджет)

- Холодный старт до видимого окна с вкладкой ≤ 1.5 с на этой машине; chrome UI ≤ 150 КБ JS без фреймворков.
- Панель создаётся лениво (при первом открытии); overlay прогревается после загрузки первой вкладки (или через 4 с), чтобы первая подсказка адресной строки не ждала. Панель и overlay — `sandbox:true`, chrome — `sandbox:false` (нужен `electron-chrome-extensions`). Инструменты панели монтируются при первом показе.
- CDP-захват по умолчанию только `api` (XHR/Fetch + документ), тела ответов — лениво (`Network.getResponseBody` по запросу), буфер `maxTotalBufferSize` 64 МБ.
- Никаких setInterval чаще 1 с в фоне; рассылки состояния — с троттлингом.

---

## Приложение: фактические API и каналы фич

Сводка на 22.10.2026 по `docs/features-reports.md`, отчётам починщиков и коду (site-intel — 26.10.2026). При расхождении верен код. Порядок init фич (`main.js`): `platform, themes, cdp-hub, devtools, site-intel, ux-chrome, claude-bridge, claude-terminal, tools-pack`.

### А1. API фич в ctx

| Ключ | Владелец | Методы |
|---|---|---|
| `ctx.history` | ux-chrome | `search(q, limit)`, `add(entry)`, `remove(url)`, `clear(opts)`, `recent(limit)`, `top(limit)`, `get(url)`, `count()`, `onChange(cb)`. Одна запись на адрес, до 10 000; файл пишется не чаще раза в 15 с |
| `ctx.bookmarks` | ux-chrome | `list(folder)`, `add(o)`, `remove(idOrUrl)`, `update(id, patch)`, `move(id, index, folder)`, `has(url)`, `find(url)` |
| `ctx.downloads` | ux-chrome | `list()`, `dir()`, `summary()` |
| `ctx.themes` | themes | `siteConfig(url)` (`enabled` — итоговое вкл/выкл, `params.engine`), `toggleSite(host, v)`, `setSite(host, patch)`, `removeSite`, `resetSite`, `sites()`, `siteKey(hostOrUrl)`, `autoColors()`; dev: `measure`, `metrics`, `fetchStats` |
| `ctx.cdp` | devtools (`cdp-hub.js`) | §13 плюс: **`entry()` — Promise**, `body()` — Promise; `pageFetch(tabId, {url, method, headers, body, timeoutMs})` → `{ok, status, statusText, headers, body, base64Encoded, size, truncated, timeMs, url, redirected}`; `evalInWorld(tabId, expr, {world: 'page' или имя, timeoutMs, userGesture})` — Page.createIsolatedWorld + Runtime.evaluate, не ждёт конца загрузки; `info`, `list`, `watch(tabId, on)`, `setPaused`, `requireNetwork(tabId, on)`, `captureTab`, `wsFrames`, `raw`, `rawBody`, `postData`, `timingOf`, `isAttached`, `flush`. События `on('entry' / 'batch' / 'console' / 'attached' / 'detached' / 'cleared')` |
| `ctx.devtools` | devtools | `dock` (`docks()`, `openWindow`, `dockBack`, `pickElement`, `inspectAt(tabId, {x, y})`, `noteMenu`, `state`); `emu` (`get`, `set(tabId, patch)`, `reset`, `isActive(tabId)`, `summary`, `inputScale`, `viewFactor(tabId, zoom)`, `DEVICES`, `NETWORKS`); `storage`; `net`. Живых встроенных DevTools не больше 2, скрытые закрываются через 45 с |
| `ctx.bridge` | claude-bridge | `toInbox({title, markdown, host})` → `{path}`, `mcpConfigPath()`, `status()`, `pageFetch(tabId, o)`, `sendPage(tabId)`, `pick(tabId)`, `lastPicked()`, `activity(limit)`, `connectClaudeCode({dryRun})`, `command()`, `url()`, `tools()`, `callTool(name, args)` (отладка) |
| `ctx.terminal` | claude-terminal | `pasteToClaude(text)` → bool (только в живую сессию Claude с bracketed paste), `open(profile)` → id (`claude`, `powershell`, `cmd`, `bash`), `create(o)`, `list()`, `write`, `kill(id)`, `restart(id, o)`, `show`, `info`, `describe(profile)` |
| `ctx.adblock` | platform | `isEnabledFor(url)`, `blockedCount(tabId)`, `status()`, `update()` |
| `ctx.extensions` | platform | `list()`, `install(id, containerId)`, `remove(id)`, `instance(containerId)` |
| `ctx.platform` | platform | `{modal, adblock, extensions, permissions, containers}` — внутренние модули (`permissions.queue()`, `respond`, `revoke`, `listSaved`, `cancelTab`) |
| `ctx.siteIntel` | site-intel | `enabled()`, `siteOf(hostOrUrl)` (регистрируемый домен, tldts с частными суффиксами), `siteForUrl(url)`, `siteForTab(tabId)`, `resolveSite({site?, tabId?})`, `noteAction(tabId, label, source: 'claude'\|'user', {kind})`, `catalog(site, {filter, method, limit})` → `{total, matched, items: [{index, key, method, host, path, query, count, last, auth, actions}]}`, `endpoint(site, key \| index)` → карточка (`params`, `reqSchema`/`resSchema` TS-подобным текстом, `headers`, `neededHeaders`, `auth`, `actions`, `initiators`, `pages`, `sample` — живой `{tab, id}` в буфере cdp, `exampleUrl`, `fetchTemplate`, `bodySkeleton`), `initiator(tabId, requestId)`, `recentActions(tabId, limit)`, `notes(site)`, `addNote(site, {text, tags, author})`, `updateNote`, `removeNote`, `forget(site)`, `sites()`, `clearAll()`, `counts(site)`, `hint(url)` (строка «Site knowledge…» для MCP), `stats()`, `flush()` |
| `ctx.toolsPack` | tools-pack | `snippets()`, `builtins()`, `runSnippet(tabId, code, world)` → `{ok, ms, logs, result, error, world, url}`, `xray(tabId)` → `{sections, notes, …}`, `matchUrl(pattern, url)` |

**Точки расширения ядра, добавленные фичами и починщиками:**
- `ctx.commands.addBypass((input, source, wc, cmd) => bool)` — клавиша уходит в webContents, команда не выполняется (терминал: Ctrl/Alt+буква; DevTools: Ctrl+L). `comboFromInput(input)` экспортируется из `commands.js`.
- `ctx.commands.addTabMenuProvider((tab) => MenuItemOptions[])` — пункты в меню вкладки после «Выгрузить из памяти».
- `ctx.tabs.addDiscardGuard((tab) => bool)` → отписка; `ctx.tabs.discardBlocked(tab)`. Ещё у вкладок: `markClaude`, `realizeActive`, `openOrActivate`, `flushSession`, `focus`, события `focus` и `target-url`; поля TabInfo `containerName`, `active`, `index`, `error`.
- `ctx.overlay.toast(text, opts)`; `ctx.windows.setTitleBarColors(c | null)`, `setTitleBarDim(on)`, `uiUrl()`; `ctx.panel.createDevtoolsView()`, `setDevtoolsView(v)`, `devtoolsViewIfCreated`.
- `ctx.permissions.setHandler((kind, info) => bool | undefined | Promise)`, `ctx.uiPreload.addModule(path)` (только в init), `ctx.sessions.addVendor(pkg)`, `ctx.settings.addDefaults(obj, {enums})`, `ctx.settings.peek(path)`, `ctx.contextMenu.build(...)` (для проверок).
- Интерфейс: `KChrome.toggleOverlay(type, data, anchor, opts)`, `KUI.kbd(combo)`, `KUI.setToastHandler(fn)`, в api `KPanel` — `siteHeader({icon, title, sub, subTitle, actions})`, `KOverlay.ui.header/menu`, тип overlay `toast`.

**Ветки настроек от фич:** `siteIntel` (`enabled: true`, `exclude: []` — сайты/хосты без сбора, поддомены входят), `claude.shell` (powershell, cmd, bash), `devtools.preserveLog`, `devtools.console`, `siteThemes.colorScheme` (system, dark, light), `siteThemes.rev` (миграции; rev 2 — wildberries.ru на движке `filter`). Значения `claude.claudeCommand` (`claude…` без аргументов или существующий абсолютный .exe/.cmd/.bat/.com), `claude.inboxDir`, `claude.terminalCwd`, `downloads.dir` (`''` или абсолютная папка) проверяются при записи.

### А2. Каналы IPC по фичам

| Фича | Запросы (`invoke`) | События main → UI |
|---|---|---|
| core (сверх §4) | `kosmo:settings.remove`, `kosmo:app.info`, `kosmo:panel.state`, `kosmo:overlay.toast`, `kosmo:overlay.update`, `kosmo:tabs.closeOthers/closeRight/discard/focus/contextMenu`, `kosmo:containers.list` | `kosmo:chrome.command`, `kosmo:find.result`, `kosmo:overlay.show/hide/closed/state/toast` |
| ux-chrome | `kosmo:ux.*` (suggest, newtab, newtabHide, focusOmnibox, palette, paletteRun, defaultBangs), `kosmo:history.*` (search, page, recent, remove, clear), `kosmo:bookmarks.*` (list, find, add, update, remove, move), `kosmo:downloads.*` (list, open, show, cancel, pause, resume, remove, retry, clear, markSeen, openDir, chooseDir) | `kosmo:history.changed`, `kosmo:bookmarks.changed`, `kosmo:downloads.changed`. Типы overlay: omnibox, palette, bookmark-edit, bm-menu, bm-folder, downloads |
| themes | `kosmo:themes.*` (site, setSite, toggleSite, removeSite, resetSite, sites, autoColors); из вкладок: `kosmo-tab:site-theme.get` и `.lib` (sendSync), `.fetch` (прокси CSS и шрифтов: только http(s), без локальных и частных адресов, редиректы перепроверяются, до 5 МБ и 10 с), `.metric` | `kosmo:themes.changed`, `kosmo:themes.toggled`; во вкладку `kosmo-tab:site-theme.update` |
| devtools | `kosmo:devtools.*` (state, openWindow, dockBack, pick, info, relaunch), `kosmo:emu.*` (get, set, reset), `kosmo:net.*` (list, entry, body, fetch, clear, pause, capture, watch, exportHar, searchBodies, toClaude), `kosmo:storage.*` (cookies, setCookie, removeCookie, clearCookies, cookieHeader, exportCookies, importCookies, web, webSet, webRemove, webClear, clearSite) | `kosmo:devtools.dock`, `kosmo:devtools.emu`, `kosmo:devtools.stage`, `kosmo:devtools.net` |
| claude-bridge | `kosmo:bridge.*` (status, activity, clearActivity, setAccess, connectClaudeCode, command, regenerateToken, tools, openLog, pickDir, openDir, pick, sendToClaude) — из внутренних страниц только settings; из вкладок `kosmo-tab:picker.result` | `kosmo:bridge.activity` (`{entry}` или `{cleared:true}`), `kosmo:bridge.status`, `kosmo:bridge.toast`, `kosmo:bridge.picker`, `kosmo:bridge.picked`, `kosmo:bridge.showLog`; во вкладку `kosmo-tab:picker.start/at/stop` |
| claude-terminal | `kosmo:term.*` (create, list, write, resize, kill, restart, replay `{withSeq}`, info, clipboard, pickCwd; `focusState` — через send) | `kosmo:term.data`, `kosmo:term.exit`, `kosmo:term.sessions`, `kosmo:term.reset`, `kosmo:term.show` |
| platform | `kosmo:ext.*` (list, state, reload, remove, options, loadUnpacked, openFolder, openStore), `kosmo:adblock.*` (state, setEnabled, setSite, update), `kosmo:perm.*` (list, respond, revoke), `kosmo:containers.*` (stats, clearData, remove, chipMenu, newTab), `kosmo:privacy.*` (clearCache, clearCookies, uaInfo), `kosmo:platform.modalRespond` | `kosmo:adblock.counts`, `kosmo:adblock.status`, `kosmo:ext.changed`, `kosmo:perm.queue` |
| tools-pack | `kosmo:snippets.*` (list, save, remove, run, runPicked, takeLast, autoLog, autoResult), `kosmo:xray.*` (run, toClaude), `kosmo:tools.*` (metrics, discardTab, paths, openFolder — открыты и внутренним страницам) | `kosmo:snippets.changed`, `kosmo:snippets.auto`, `kosmo:snippets.ran` |
| site-intel | `kosmo:siteIntel.*` (summary `{tabId?}` → `{site, enabled, excluded, capture, total, items, notes}`, endpoint `{site, key}`, noteAdd/noteUpdate/noteRemove (автор `user`), forget, sites, clearAll, actions) — для `ui` и `kosmo://settings`; из вкладок `kosmo-tab:intel.action {kind: click\|submit\|enter\|change, label ≤ 60, tag, role, sel ≤ 120}` (недоверенные: проверка, обрезка, ≤ 5/с на вкладку, только главный фрейм того же origin) | `kosmo:siteIntel.changed {site, forgotten?}` (не чаще раза в секунду на сайт) |

### А3. Изолированные миры

| Мир | Кто | Зачем |
|---|---|---|
| 999 (мир preload) | core, themes | tab-preload; Dark Reader исполняется в нём (`executeJavaScriptInIsolatedWorld(999)`), его помощник — в главном мире через `webFrame.executeJavaScript` |
| CDP `kosmolet-snapshot` (запасной 1002) | claude-bridge | снимок страницы и ref-ы (`page-snapshot.js`, VERSION 11) |
| CDP `kosmolet-eval` (запасной 1003) | claude-bridge | `eval_js` |
| CDP `kosmolet-fetch` (запасные 1717 в cdp-hub и 1004 в мосте) | devtools, claude-bridge | `ctx.cdp.pageFetch`, `page_fetch` |
| CDP `kosmolet-storage` (запасной 1718) | devtools | localStorage и sessionStorage в «Хранилище» |
| CDP `kosmolet-snippet` (запасной 1818) | tools-pack | сниппеты в режиме «Изолированный» и Рентген; режим «Страница» — главный мир |
| CDP `kosmolet-cdp` | devtools | мир по умолчанию у `ctx.cdp.evalInWorld` |

Запасные числовые миры — путь Electron (`executeJavaScriptInIsolatedWorld`): он ждёт конца загрузки страницы. Основной путь — CDP. Автосниппеты намеренно идут путём Electron (после загрузки).

### А4. tab-preload (`userData/gen/tab-preload.js`)

| Часть | Владелец | Что делает |
|---|---|---|
| `00-core.js` | core | `window.kosmo` только для главного фрейма внутренних хостов |
| `19-darkreader-lib` (addPart) | themes | загрузчик: исходник Dark Reader (355 КБ) берётся из main через sendSync, только если тема включена |
| `20-site-theme.js` | themes | тёмная тема сайта (движки dynamic и filter), свой CSS, защита от белой вспышки |
| `30-picker.js` | claude-bridge | пикер «Показать Claude элемент» (рамка в закрытом shadow root) |
| `41-tools-favicon` (addPart) | tools-pack | знак Космолёта как значок внутренних страниц |
| `50-site-intel.js` | site-intel | только главный фрейм http(s): доверенные (`isTrusted`) click по интерактивному элементу, submit формы (без дубля сразу после клика/Enter), Enter в поле, change у select → `kosmo-tab:intel.action`; подпись — доступное имя или текст (значения полей не отправляются, у select — текст пункта), короткий селектор, не чаще 5/с |

Отдельные frame-preload сессий (не части tab-preload): `kosmo-adblock-cosmetic` — своя копия косметики ghostery (`features/platform/adblock-cosmetic-preload.js`, без `unload`), и preload-скрипты `electron-chrome-extensions` и Web Store. В ui-preload фичи добавляют модули через `ctx.uiPreload.addModule` (platform: `ui-preload-actions.js` для `<browser-action-list>`).

### А5. Хранилища в userData

| Файл | Владелец |
|---|---|
| `settings.json`, `session.json`, `window-state.json`, `gen/tab-preload.js`, `gen/compile-cache/` (кэш компиляции модулей main) | core |
| `history.json`, `bookmarks.json`, `downloads.json` | ux-chrome |
| `claude-activity.json` (500 записей), `gen/claude-mcp.json` (адрес и токен для `claude --mcp-config` и `mcp-call.mjs --profile`) | claude-bridge |
| `adblock-engine.bin` (обновление раз в 7 дней), `extensions/`, `extensions-unpacked.json`, `containers-purge.json` | platform |
| `snippets.json` | tools-pack |
| `site-intel/<site>.json` — по файлу на сайт: `{v, site, created, updated, endpoints: {"METHOD host/path": {...}}, notes: []}`; атомарная запись (tmp + rename) с дебаунсом 1,5 с, синхронный сброс при выходе, в памяти до 16 сайтов | site-intel |
| `main-stdout.log`, `main-stderr.log` (только при запуске через `start-dev.ps1`) | dev |

Вне userData: inbox Claude — `settings.claude.inboxDir` или `Документы\Космолёт\claude-inbox`; загрузки — `settings.downloads.dir` или системная папка «Загрузки». Cookies и кэш контейнеров — `Partitions/c-<id>` (Chromium).

### А6. Dev и проверки

- Флаги: `--dev`, `--profile`, `--dev-port`, `--cdp-port`, `--mcp-port`, `--no-restore`, `--open`; только в dev — `--offscreen`, `--ui-root`. В dev отключена окклюзия окон (`CalculateNativeWinOcclusion`), лог main копится и пишется асинхронно (остаток — при выходе), есть команда «Исследовать интерфейс» `Ctrl+Alt+Shift+I`.
- `tools/start-dev.ps1 … [-OnScreen] [-NoRestore] [-Open <url>] [-UiRoot <папка>]`; `tools/dev.mjs --port <n> eval "<код>" | eval --file <путь> | shot [файл] | logs [n] | quit | health`; `tools/smoke.mjs <dev> <cdp>`; `tools/mcp-call.mjs --profile <p>` (или `--port`, `--token`) `list | call <tool> '<json>'`.
- Особенности проверок: `render-process-gone` после `forcefullyCrashRenderer` на этой машине приходит через 0,4–19 с (smoke ждёт до 25 с); тест `toggleOverlay` в smoke чувствителен к загрузке CPU (паузы 100–300 мс).

### А7. Знания о сайтах (site-intel)

- **Источник:** `ctx.cdp.on('entry')` (завершённые запросы всех вкладок и контейнеров). Берутся XHR/Fetch (и Other с JSON) с ответом JSON/текст (или 204), без трекеров (google-analytics, mc.yandex и т. п.), не из исключений. Обработка отложена на 350 мс (ждём IPC о действии) и идёт пачками вне обработчика CDP.
- **Сайт** — регистрируемый домен страницы вкладки (не запроса): запросы www.wildberries.ru к static-basket-01.wbbasket.ru попадают в каталог wildberries.ru. **Ключ эндпоинта** — `METHOD host/шаблон-пути`; сегменты-числа → `{id}`, UUID → `{uuid}`, hex ≥ 12 → `{hash}`, длинные токены (≥ 20 символов, буквы+цифры одним куском, JWT) → `{token}`.
- **По эндпоинту:** query-параметры (имя, тип, до 3 примеров ≤ 40 символов, «меняется»; параметры-секреты и значения-токены маскируются `‹hidden N chars›`), content-type запроса, схемы тела запроса и ответа (ключи и типы, массивы — форма элемента, глубина ≤ 6, ≤ 80 ключей, словари с id-ключами → `Record<string, T>`, необязательные ключи отмечаются `?`), счётчики статусов/mime/типов, `count`, `first/last`, страницы (шаблоны, до 8), 5 последних `{tab, id}` образцов, имена «заметных» заголовков (не стандартные, без `sec-*` и псевдозаголовков), авторизация (cookie / bearer / basic / заголовки-токены — только факт и имена), действия (подпись → `{n, user, claude}`), верхний кадр JS-инициатора. Лимиты: 300 эндпоинтов на сайт (вытесняется давно не виденный), 200 заметок, заметка ≤ 2000 символов.
- **Тела ответов** — лениво через `ctx.cdp.body`: JSON (или text/plain, начинающийся с `{`/`[`), ≤ 1 МБ, первые 3 образца на эндпоинт, затем не чаще раза в сутки, очередь ≤ 40, не чаще 4 в секунду. Значения из тел не сохраняются.
- **Действия:** часть preload `50-site-intel.js` (пользователь) и `noteAction(..., 'claude')` из инструментов моста click / type / press_key / select_option (до отправки ввода). Настоящий ввод Claude страница тоже видит — событие страницы в течение 1,5 с после действия Claude сливается с ним (подпись берётся со страницы). Запросы, начатые в течение 2 с после действия (допуск −300 мс) в той же вкладке, привязываются к последнему такому действию. Журнал вкладки — 50 действий по 40 запросов, только в памяти.
- **Правка ядра (cdp-hub):** `initiatorOf` дополнительно кладёт `initiator.stack` — до 5 верхних кадров `{url, line, col, fn, async?}` с асинхронными родителями; прежние поля `type/url/line/fn` без изменений.
- **MCP** (bridge/tools.js, все READ): `site_api_catalog {site?|tabId?, filter?, method?, limit?}`, `site_api_endpoint {site?, key|index}` (с готовым вызовом `page_fetch` и id живого образца для `network_request`), `request_initiator {id, tabId?}`, `recent_actions {tabId?, limit?}`, `site_notes {site?}`, `site_note_add {site?, text, tags?}`, `site_note_remove {site?, id}` (запись заметок разрешена в режиме read — это память агента). `tabs_list`, `page_info`, `snapshot` добавляют строку `Site knowledge (<site>): N API endpoints, M notes — see site_api_catalog / site_notes`. INSTRUCTIONS сервера: сначала каталог и заметки, прямые вызовы API предпочтительнее кликов.
- **Интерфейс:** инструмент панели `site` (`panel/tools/site.js/.css`), группа «Знания о сайтах» в разделе настроек devtools (`settings/sections/site-intel.js/.css`, вызывается из `sections/devtools.js` через `window.KSiteIntelSettings.render`).
- **Проверка:** `node tools/site-intel-test.mjs <devPort> <profile>` (36 проверок: шаблоны, схемы, маскировка, привязка к кликам MCP и `sendInputEvent`, все MCP-инструменты, режим read, недоверенный IPC, вкл/выкл, исключения), после перезапуска — с `--persist`.
