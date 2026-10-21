# Отчёты ядра (21.10.2026)

Фактическое API ядра — дополнение к ARCHITECTURE.md. При расхождении верно то, что здесь (и в коде).

## core-main

Отчёт core-main. Main-процесс и preload готовы и проверены на живом экземпляре (профиль `core-main`, порты 47410/47331/9341). Исключений в main нет, `featureErrors` пустой. Свой экземпляр я завершил через `/quit`, других electron.exe не запущено.

## Файлы
- С прошлой попытки уже были `ctx.js`, `settings.js`, `store.js`. Сверил их с контрактом и оставил. Единственная правка: `kosmo:settings.patch` теперь принимает и `{patch:{…}}`, так его вызывает core-ui.
- Создал:
  - в `src/main/`: `main.js`, `ipc.js`, `windows.js`, `tabs.js`, `sessions.js` (там же протокол kosmo://), `overlay.js`, `panel.js`, `commands.js`, `context-menu.js`, `search.js`, `preload-composer.js`, `dev-server.js`;
  - в `src/main/features/`: заглушки 8 фич и `page-snapshot.js` (там `{}`);
  - `src/preload/ui-preload.js`, `src/preload/tab/00-core.js`;
  - `tools/dev.mjs`, `tools/start-dev.ps1` (с BOM, иначе PowerShell 5.1 ломает кириллицу), `Запустить Космолёт.bat` (внутри только ASCII).
- `package.json` уже соответствовал. Скрипт `selftest` оставил, флаг `--selftest` разбирается в `ctx.flags`, но ничего не делает.
- Файлы renderer не трогал, заглушки не понадобились: core-ui уже всё выложил.

## Отклонения и решения по дырам в контракте
1. **Порядок частей tab-preload.** Части из `addPart` сортируются по имени вместе с файлами (`'19-darkreader-lib'` встанет перед `20-site-theme.js`). Есть `addPart(name, {code})`, `{file|code, raw:true}` (без обёртки, для UMD-библиотек), `removePart`, `rebuild`. Часть с синтаксической ошибкой пропускается с записью в лог. В KOSMO добавлены `send/invoke/sendSync`, работают только с `kosmo-tab:*`.
2. **Внутренние хосты.** В список добавлен `error`. Права `internal` выдаются только главному фрейму. Внутренняя странице доступны и каналы `kosmo-tab:*`.
3. **Сторонние модули интерфейса.** `kosmo://ui/vendor/<пакет>/…` отдаёт файлы из node_modules по белому списку (`@xterm/xterm`, `@xterm/addon-fit`), расширяется через `ctx.sessions.addVendor`. Иначе xterm в панель не загрузить.
4. **`ctx.uiPreload.addModule(m)`.** Фичи регистрируют в `init` модули для `ui-preload` (например `electron-chrome-extensions/preload`).
5. **Ускорение старта.** View активной вкладки создаётся после `dom-ready` интерфейса, запасной таймер 1,5 с. В тесте A/B окно появлялось за 1,2–1,5 с против 2,7–3,2 с без этого.
6. **Overlay** прогревается после первой загруженной вкладки (или через 4 с), а не строго при первом открытии.
7. **В dev отключена окклюзия окон** (`CalculateNativeWinOcclusion`). Без этого окно, показанное без фокуса и перекрытое другими, не рисует вкладки, и скриншоты выходят пустыми.
8. **Закрыта последняя вкладка** — открывается новая, окно остаётся. Закреплённые вкладки «Закрыть другие/справа» не трогают.
9. **Страница ошибки.** Служебные записи вокруг неё удаляются из истории (`removeEntryAtIndex`), «назад/вперёд» и повтор работают чисто. Редирект на kosmo:// режется всегда.
10. **DevTools в панели.** WebContents для DevTools одноразовый, поэтому есть `ctx.panel.createDevtoolsView()` и `setDevtoolsView(v)`, плюс `devtoolsViewIfCreated`.
11. **Контекстное меню.** Пункт провайдера может указать `section`: link, image, media, selection, editable, page или tools; по умолчанию page. Пункт показывается, только если его секция относится к месту клика.
12. **Accept-Language** передаётся как `'ru-RU,ru,en'`. Chromium сам добавляет веса, при варианте из контракта они удваивались.
13. **Флаг `--ui-root=<папка>`** (только с `--dev`): подменяет файлы `kosmo://ui` для тестов.
14. **Дополнительные поля и API.** В TabInfo добавлены `containerName`, `active`, `index`. Добавлены `ctx.tabs.markClaude(id)`, `realizeActive`, `openOrActivate`, `flushSession`. У вкладок есть события `focus` и `target-url`.
15. **Права по умолчанию.** Сайтам: `clipboard-sanitized-write`, `fullscreen`, `pointerLock`. Интерфейсу и внутренним страницам дополнительно `clipboard-read`. Обработчик фичи: `ctx.permissions.setHandler((kind:'request'|'check', info) => bool | undefined | Promise)`, где `info = {webContents, permission, details, origin, containerId, session, tab, defaultDecision}`.

## IPC (allow по умолчанию `ui`; `+int` — также внутренние страницы)
**Вкладки.** Если `id` не указан — активная вкладка; для внутренней страницы — её собственная.
- `kosmo:tabs.list` +int → `{tabs, activeId}`
- `tabs.create` +int `{url?, containerId?, active?, background?, index?, pinned?, openerId?}` → TabInfo
- `tabs.close` +int `{id}` или `{ids:[]}`
- `tabs.closeOthers` +int `{id}`, `tabs.closeRight` +int `{id}`
- `tabs.activate` +int `{id}` или `{index}` (−1 — последняя) или `{offset}`
- `tabs.navigate` +int `{id?, url | input}` → `{url, kind}`
- `tabs.back`, `tabs.forward`, `tabs.stop` +int `{id?}`
- `tabs.reload` +int `{id?, hard?}`
- `tabs.move` `{id, index}`
- `tabs.pin` `{id?, pinned?}`, `tabs.mute` `{id?, muted?}` (без значения — переключение)
- `tabs.duplicate` +int `{id?}`, `tabs.reopenClosed` +int
- `tabs.zoom` +int `{id?, zoom:'in'|'out'|'reset'|число}` → коэффициент
- `tabs.find` `{id?, text, forward?, findNext?, matchCase?}` → `{requestId}`
- `tabs.stopFind` `{id?, action?}`, `tabs.discard` `{id}`, `tabs.focus` `{id?}`
- `tabs.contextMenu` `{id, x?, y?}`

**Остальные каналы**
- `kosmo:settings.get` +int `{path?}` или строка; `settings.set` +int `{path, value}`; `settings.patch` +int `{patch}` или объект; `settings.remove` +int `{path}`
- `kosmo:layout.setChromeHeight` `{height, titleBarHeight?}` или число; `layout.get` +int
- `kosmo:window.toggleFullscreen`
- `kosmo:panel.toggle|open` `{tool?}`, `panel.close`, `panel.setTool` `{tool}`, `panel.setWidth` `{width}` (также через send), `panel.state` → `{open, tool, width}`
- `kosmo:overlay.open` `{type, data, anchor:{x,y,w,h}, modal?, focus?, align?:'start'|'end'|'center'}`
- `overlay.close` `{reason?}`
- `overlay.resize` `{width, height, inset?}` (handle и send)
- `overlay.update` `{type, data}`
- `overlay.event` `{type, name, data}` (handle и send). От chrome/панели уходит в overlay; от overlay — в chrome и панель плюс `ctx.overlay.on('event', (type, data, name))`
- `kosmo:commands.list` +int → `[{id, title, category, keys, enabled, appMenu}]`; `commands.run` `{id, args?}`
- `kosmo:app.menu` `{x, y}`, `kosmo:app.info` +int, `kosmo:app.quit`, `kosmo:containers.list` +int
- `kosmo:search.suggest` +int `{input}` → `[{type, title, subtitle?, url?, tabId?, bang?, insert?, favicon?, score}]`; `search.resolve` +int `{input}`

**Main → renderer**
- `kosmo:tabs.state` `{tabs, activeId}` (троттлинг 16 мс)
- `kosmo:settings.changed` `{path, value, settings}`
- `kosmo:layout.state` `{panelOpen, panelWidth, panelTool, fullscreen, fullscreenKind, chromeHeight, titleBarHeight, maximized}`
- `kosmo:chrome.command` `{name: 'focusOmnibox' | 'openFind' | 'findNext' | 'findPrev'}`
- `kosmo:find.result` `{tabId, requestId, activeMatchOrdinal, matches, finalUpdate}`
- `kosmo:overlay.closed` `{type, reason, at}` (рассылка)
- в overlay: `kosmo:overlay.show` `{type, data, anchor, modal, align, seq}`, `overlay.hide` `{type, reason}`, `overlay.update` `{type, data}`
- в chrome и панель: `kosmo:overlay.state` `{open, type, modal}`
- в панель: `kosmo:panel.state`

## Что проверено (через dev-сервер)
- **Старт и dev-сервер.** `/health`, `/eval`, `/shot` (desktopCapturer), `/logs`, `/quit` работают. `return ctx.tabs.create({url:"https://example.com"}).id` возвращает id, заголовок вкладки «Example Domain».
- **Сайты и внутренние страницы.** UA чистый: `Chrome/156.0.0.0`, без Electron. Sandbox-preload исполняется и на `kosmo://settings`, и на example.com (тестовая часть прислала `kosmo-tab:` из обеих). `typeof window.kosmo` на settings — `object|internal`, на example.com — `undefined`.
- **Протокол и защита.** Протокол отдаёт правильные MIME и CSP. `kosmo://ui` из вкладки даёт 404, три варианта path traversal дают 404, vendor работает по белому списку. Переход http→kosmo:// и `window.open('kosmo://…')` блокируются. Внутренняя страница получает отказ на UI-канал.
- **Открытие вкладок.** `window.open` открывает вкладку с сохранённым opener сразу после родителя. Ctrl+клик открывает фоновую вкладку.
- **Вкладки и сессия.** Страница ошибки показывает исходный адрес, история после неё чистая, повтор работает. Выгрузка и восстановление сохраняют историю, включая `navigationHistory.restore`, выгрузка по таймеру срабатывает. Сессия переживает закрытие окна (14 из 14 вкладок) и восстанавливается лениво.
- **Окно и панель.** Краш вкладки ставит `crashed`, reload его снимает. HTML5-fullscreen входит и выходит по Esc. Панель зажимается в 320..(W−400), DevTools-вид встаёт ниже шапки, F12 работает изнутри DevTools.
- **Overlay.** Позиция по якорю с `align:'end'` и inset верная, модальный режим — на всё окно, relay событий проходит в обе стороны.
- **Горячие клавиши** через sendInputEvent: Ctrl+T, Ctrl+W, F12, Ctrl+L, Ctrl+F, Ctrl+=, Ctrl+0.
- **Прочее.** 40 вариантов `search.resolve` (бэнги, числовые артикулы wb и oz, `.рф`, localhost, IPv4 и IPv6, `node.js` уходит в поиск). Шаблоны контекстного меню, меню «⋯» и меню вкладки собираются. Второй запуск и `.bat` передают адрес в уже открытое окно. Права по умолчанию и делегирование фиче работают.
- **Время до показа окна:** 0,9–2,4 с при посторонней нагрузке на CPU около 45%. Голый Electron на этой машине — 0,6–1,25 с. Бюджет 1,5 с выполняется не всегда.

## Известные проблемы и замечания
- **Нативные меню** (`popup`) визуально не проверял, чтобы не всплывали на экране пользователя. Проверена только сборка шаблонов.
- **Буфер обмена.** Тест `navigator.clipboard.writeText` на example.com записал строку `kosmo-test` и мог заменить содержимое системного буфера.
- **Окно было на экране во время тестов.** Похоже, кто-то кликал по нему: переключал вкладки и тему на `graphite`. Тестовый профиль `core-main` изменён: добавлен контейнер `work`.
- **`capturePage` и выгрузка.** У неактивной (отсоединённой) вкладки `capturePage`, скорее всего, не сработает; на это стоит обратить внимание claude-bridge. Вкладка с открытыми DevTools не выгружается. Отладчик `cdp-hub` выгрузке не мешает.
- **Фокус после активации.** Событие фокуса вкладки, пришедшее в первые 150 мс после открытия поповера, игнорируется, иначе поповер сразу закрывался.
- **Замечания по файлам core-ui:**
  - `overlay/overlay.js` регистрирует в рабочем коде тип `demo`;
  - `fire` сначала пробует invoke и только потом send. Для `overlay.event` я добавил handle, так что лишнего круга с ошибкой больше нет;
  - `navigator.languages` показывает `ru,en-US`, это локаль Chromium; заголовок Accept-Language при этом правильный.

## core-ui

# Отчёт core-ui: весь renderer готов, проверен в харнессе и в настоящем Космолёте

Интерфейс собран целиком: полоса вкладок, адресная строка, всплывающий слой, правая панель, настройки, страница ошибки и заглушки для фич. Всё проверено на снимках и вживую через своё ядро core-main (профиль core-ui, порт 47420). Ошибок в консоли интерфейса нет, мой тестовый экземпляр закрыт через `/quit`.

## Главное для core-main: 4 расхождения с каналами из задания

Renderer сейчас понимает оба варианта, но договориться нужно:
1. **`kosmo:overlay.event`.** Main пересылает только `{type, data}` и теряет `name`. Из-за этого события overlay ↔ chrome (`onEvent(name)`, `onOverlay`) доходят без имени. **Это нужно исправить в main/overlay.js**, обходного пути в renderer нет.
2. **`kosmo:tabs.navigate`.** Main читает `p.url`, а в задании поле `input`. Шлю оба: `{input, url: input}`.
3. **`kosmo:tabs.zoom`.** Main читает `p.zoom` (`'in'|'out'|'reset'|число`), а в задании `delta`. Шлю `{delta: 0, zoom: 'reset'}`.
4. **`kosmo:chrome.command`.** Main кладёт аргументы рядом с `name`, а не в `args`. Renderer принимает оба вида.

## Другие отклонения и решения
- **Двойной клик по пустому месту полосы → новая вкладка работает только на узких полях у вкладок.** Пустое место — область перетаскивания окна, а Windows такие клики в страницу не передаёт: двойной клик там разворачивает окно. Выбрал перетаскивание окна. Если нужна новая вкладка, это решается в main.
- **Не-модальный overlay оставляет вокруг карточки поле 8px под тень.** Размер отправляю как `{width, height, inset: 8}`, это совпадает с `place()` в main.
- **Размер overlay и высоту chrome меряю ещё и таймером, а не только `ResizeObserver`/`requestAnimationFrame`.** Пока окно перекрыто, кадры не идут: из-за этого overlay оставался высотой 1px, а высота chrome не обновлялась после смены плотности.
- **Полосу поиска по странице и полосу «Вкладка упала» сделал в core.** Ни одна фича их не брала, а каналы и команды `openFind`/`findNext`/`findPrev` уже есть в main.
- **Разделы настроек «Производительность», «Горячие клавиши» и «О Космолёте» сделал рабочими** (их владелец — core). Остальные шесть разделов — заглушки.
- **Добавил к контракту:**
  - `shared/page.css` — общая раскладка внутренних страниц;
  - токен `--k-shadow-pop`;
  - хелперы `KUI.empty()` и `KUI.fire()`: `fire` вызывает invoke, а если в main канал повешен через `ipc.on`, переключается на send.
- **Свои вызовы к main сверх списка:** `kosmo:tabs.list`, `kosmo:layout.get`, `kosmo:tabs.focus` (фокус страницы, запасной вариант — activate), подписки на `kosmo:overlay.update`, `kosmo:overlay.closed` и `kosmo:overlay.state`. Высоту шлю как `{height, titleBarHeight}`. Минимальная ширина панели 320, как `PANEL_MIN` в main.
- **Ограничения при выборе темы:** пресет меняет акцент только если акцент был «пресетным».

## Что проверено
**Харнесс** `tools/dev-out/ui-harness/` (поддельный kosmo API; снимки в `tools/dev-out/shots/`):
- вкладки во всех состояниях: закреплённые, загрузка, контейнер, звук и без звука, Claude-подсветка, бейджи, упавшая, выгруженная;
- сжатие при 35 вкладках;
- перетаскивание настоящими событиями мыши, `move` с правильным index;
- темы cosmos/graphite/light/terminal и плотность compact;
- поиск по странице, масштаб, «Не защищено»;
- настройки, включая поиск и тост ошибки;
- панель, overlay (поповер, модальный в обеих темах), ошибки -105/-102/-202, новая вкладка.

**Настоящий main:**
- окно с нативными кнопками;
- страница настроек и панель;
- страница ошибки во вкладке;
- Ctrl+L → ввод «gh electron» → Enter → поиск по GitHub;
- перетаскивание вкладки, изменение ширины панели (460 → 580);
- поповер с выравниванием `end`;
- light/compact: высоты 67 и 32 приходят в main.

## Известные проблемы
- **Снимок `/shot` (desktopCapturer) отдаёт старую картинку, когда окно перекрыто.** Все виды в этот момент `hidden`. Для проверок снимаю каждый вид отдельно скриптом `tools/dev-out/cap.js`. Чинится на стороне dev-server.
- **Во время одного снимка я поднял тестовое окно поверх остальных.** После этого у профиля сменились акцент, раздел настроек и инструмент панели — похоже, кто-то кликал в окне. Тему, плотность, акцент, шрифт и ширину панели я вернул к значениям по умолчанию; инструмент панели остался `xray`.
- На внутренних страницах `kosmo.versions.app` нет, поэтому версия в «О Космолёте» показывает «—».
- Подложка инструмента devtools видна, пока фича devtools не накрывает её своим видом.

## API для фич (точные сигнатуры)
**`KChrome`**
- `slot(name)` — `'omnibox-right' | 'toolbar-right' | 'bars' | 'tabstrip' | 'nav' | 'omnibox' | 'toolbar'`.
- `addToolbarButton({id, icon, title, onClick(ev, handle), order=500, badge?, badgeTone?, pressed?, hidden?, onContextMenu?})` и `addOmniboxIcon({...})` возвращают handle: `{el, setIcon, setTitle, setPressed, setBadge(text|null, tone), setDisabled, setVisible, remove}`. Свои кнопки core: панель (order 900) и «⋯» (1000).
- `addBar({id, el, order=500, hidden?, plain?})` → `{el, show, hide, toggle(v), isVisible, remove}`.
- `state`: `{tabs, activeId, active, settings, layout, overlay}`.
- `on(evt, cb)` → функция отписки. События: `'state'`, `'active'`, `'settings'`, `'layout'`, `'command'(name, args)`, `'overlay'(type, name, data)`, `'overlay-closed'`, `'security'({tab, el})`, `'find'`.
- `omnibox`: `{el, root, onInput(cb), onKey(cb → true = обработано), onFocus, onBlur, getValue, setValue(text, {select, edited, silent}), focus({select}), blur(toPage), revert, navigate(text, {newTab, background}), isFocused, isEditing, rect()}`.
- `find`: `{open(text), close(keepFocus), next(forward), isOpen}`.
- `openOverlay(type, data, anchorEl|rect, {modal, focus, align})`, `closeOverlay()`, `overlayEvent(type, name, data)`, `onOverlay(type, cb(name, data))`.
- Прочее: `activeTab()`, `tab(id)`, `tabEl(id)`, `newTab(opts)`, `closeTab(id)`, `activateTab(id)`, `titlebarColors()`, `invoke`, `fire`, `ready`.

**`KOverlay`**
- `register(type, {render(root, data, api), update?(data, api), onEvent?(name, data, api), onKey?(e, api), onHide?(api), align?: 'top'|'center', width?, className?})`.
- api: `{close, resize, emit(name, data), invoke, on, setAlign, toast, h, icon, data, anchor, modal, root}`.
- Готовые части: `KOverlay.ui.header(title, api)` и `KOverlay.ui.menu(items, {onPick})` (стрелки и Enter работают). Тестовый тип — `'demo'`.

**`KPanel`**
- `register({id, title, icon, order, mount(el, api), onShow(api), onHide(api)})`.
- api: `{invoke, on, activeTab(), tabs(), onTabChange(cb(tab, {reason: 'activated'|'navigated', prevId})), onTabsState, onLayout, isVisible, close, setTool, toast, empty, h, icon}`.
- Также `KPanel.show(id)` и `KPanel.active()`.

**`KSettings`**
- `section({id, title, icon, order, keywords?, description?, render(el, api)})`.
- api: `{get(path) — синхронно, set(path, v) → Promise (тост и откат при ошибке), patch, on(cb), all, invoke, ui}`.
- `KSettings.ui`: `row(label, control, hint, {stack, keywords})`, `group(title, ...rows)`, `free(...)`, `note`, `toggle(label, path, hint)`, `select(label, path, options, hint)`, `segmented(...)`, `number(label, path, {min, max, step, unit, hint})`, `text(label, path, {placeholder, hint, mono, multiline})`, `color(label, path, hint)`, `button(label, text, onClick, hint, {primary, danger, icon})`, `watch(path, fn)`.

**Общие:** `KUI` (`h`, `empty`, `toast`, `copyText`, `debounce`, `formatBytes`, `timeAgo`, `parseUrl`, `fire`…), `KIcons.get(name, size, {stroke})` / `el` / `add`, `KTheme` (`presets`, `onChange`, `onAccent`).

## Файлы
Все в `C:\Users\Пользователь\Desktop\KOSMOLET\src\renderer\`:
- **`shared\`** — `tokens.css`, `base.css`, `icons.js`, `kui.js`, `theme.js`, `page.css`;
- **`chrome\`** — `index.html`, `chrome.css`, `chrome.js`, `features\*.js` (6 заглушек);
- **`overlay\`** — `index.html`, `overlay.css`, `overlay.js`, `features\*.js` (6 заглушек);
- **`panel\`** — `index.html`, `panel.css`, `panel.js`, `tools\*.js` (8 заглушек);
- **`pages\`**:
  - `settings\` — `index.html`, `settings.css`, `settings.js`, `sections\*.js` (10 разделов);
  - `error\` — `index.html`, `error.css`, `error.js`;
  - `newtab\`, `history\`, `downloads\`, `extensions\` — заглушки.

Тестовые инструменты (в .gitignore): `C:\Users\Пользователь\Desktop\KOSMOLET\tools\dev-out\ui-harness\main.js`, `C:\Users\Пользователь\Desktop\KOSMOLET\tools\dev-out\ui-harness\preload.js`, `C:\Users\Пользователь\Desktop\KOSMOLET\tools\dev-out\cap.js`. Снимки лежат в `C:\Users\Пользователь\Desktop\KOSMOLET\tools\dev-out\shots\`.

Весь JS интерфейса chrome вместе с shared — 88 КБ (бюджет 150 КБ). Файлы main и preload я не трогал, коммитов не делал.

## core-integrate

## Отчёт core-int: ядро «Космолёта» работает целиком

Полный сценарий интеграции прошёл: 27 проверок из 27, ошибок в консолях интерфейса и в логе main нет, `featureErrors` пустой. Я гонял свой экземпляр (профиль `core-int`, порты 47430/9343/47333) и в конце закрыл его через `/quit`. Других процессов Electron не трогал, коммитов не делал.

### 1. Каналы IPC
- Все 40 каналов, которые вызывает renderer, есть в main, данные совместимы.
- Четыре расхождения из отчёта core-ui core-main уже закрыл:
  - `overlay.event` передаёт `name`;
  - `tabs.navigate` принимает и `url`, и `input`;
  - `tabs.zoom` принимает `zoom`;
  - в `chrome.command` аргументы идут рядом с `name`, renderer понимает оба вида.
- Править контракт не пришлось.

### 2. Что не работало и что исправил
1. **Ctrl+T и кнопка «+» не ставили фокус в адресную строку.** Причин две:
   - команда `focusOmnibox` приходила в chrome раньше нового `tabs.state`, и chrome при смене активной вкладки сам снимал фокус;
   - Chromium отдавал фокус новой вкладке после загрузки (`focusOnNavigation`).

   Исправления:
   - `commands.js`: перед командой chrome отправляется состояние вкладок;
   - `tabs.js`: ответы IPC вкладок отправляют `tabs.state` до ответа;
   - `tabs.js`: у вкладок `focusOnNavigation:false`, фокус ставится явно в `activate()` и в `navigate()`;
   - `windows.js`: у panel и overlay тоже `focusOnNavigation:false`, иначе прогрев overlay отнимал фокус.
2. **Сайт мог прочитать файлы `kosmo://` через `fetch`.** `fetch('kosmo://settings/index.html')` с example.com отдавал 200. Обработчик протокола не видит ни Origin, ни referrer, поэтому в `main.js` у схемы теперь `corsEnabled:false`. Сайту отказ; внутри `kosmo://` same-origin `fetch` и ES-модули проверил — работают.
3. **Страница ошибки имела `window.kosmo`** с правами внутренней страницы, хотя показывает адрес, пришедший от сайта. А кнопка «Повторить» делала `location.replace(url)` для любой схемы.
   - `sessions.js`: хост `error` убран из `INTERNAL_HOSTS`, теперь как в §4 ARCHITECTURE;
   - `error.js`: повтор только для http(s), file и ftp;
   - `tabs.js`: тема передаётся в адресе страницы ошибки, потому что API у неё больше нет.
4. **На странице ошибки адресная строка показывала замок «Защищено».** В `tabs.js` в TabInfo добавлено поле `error` (код ошибки или 0), в `chrome.js` вместо замка значок info.
5. **Настройки открывались второй вкладкой**, если в адресе был `#раздел`. В `tabs.js` `openOrActivate` теперь сравнивает адреса без `#`.
6. **Вспышка темы по умолчанию при старте.** UI-сессия живёт в памяти, и кэш темы в localStorage после перезапуска пуст. В `windows.js` добавлен `ctx.windows.uiUrl()`: chrome, panel и overlay грузятся с `?theme=&accent=&density=&fs=`.
7. **Нативные кнопки окна в своей теме (custom) не совпадали по цвету с полосой вкладок.**
   - `windows.js`: цвета берутся из `KChrome.titlebarColors()`, `setTitleBarColors(null)` возвращает цвета по теме;
   - `chrome.js`: цвет переводится в `#rrggbb` через canvas (color-mix давал oklab), символы цвета `--k-text`.
8. **Скрытый overlay применял смену темы с задержкой.** В `windows.js` у overlay `backgroundThrottling:false`.
9. **Поповер с кнопкой-переключателем открывался заново.** Повторный клик по той же кнопке сначала закрывал поповер по фокусу chrome, а click сразу открывал снова. В `chrome.js` добавлен `KChrome.toggleOverlay(type, data, anchor, opts)`.
10. **Два хранилища на один файл перезаписывали друг друга** при повторном вызове `ctx.store('x')`. В `store.js` теперь один экземпляр на файл.
11. **Мелочи интерфейса:**
    - `panel.js`: панель создаётся лениво и до первой рассылки не видела вкладок, теперь сама запрашивает `tabs.list`;
    - `panel.js` (main): пустой DevTools-вид прозрачный, а не белый;
    - `chrome.css`: иконка «Перезагрузить» в полосе «Вкладка упала» была красной;
    - `settings.css`: при открытой панели пункты меню настроек обрезались, теперь переносятся;
    - `about.js`: «О Космолёте» берёт версию и профиль из `kosmo:app.info` (раньше версия была «—»).
12. **Для тестов и разработки:**
    - флаг `--offscreen` в `main.js`, в `windows.js` окно ставится за правый край экрана, положение не сохраняется;
    - `start-dev.ps1` запускает так по умолчанию, ключ `-OnScreen` показывает окно на экране; `/shot` при этом работает;
    - в dev предупреждения и ошибки консолей chrome, panel и overlay пишутся в `/logs` как `ui:chrome`, `ui:panel`, `ui:overlay`;
    - в лог пишутся замеры старта.
13. **Уборка:** удалил `tools/dev-out/ui-harness/` и `tools/dev-out/cap.js`. Скриншоты core-ui (`shots/`, `final.png`) оставил.

### 3. Что проверено
Всё ниже, кроме пометки в п. 6, проходит:
- **Старт и окно.** Старт без ошибок. Высота chrome 79 (compact 67, с полосой поиска 114), вкладка встаёт ровно под chrome. Нативные кнопки занимают 137 px справа и полосу не перекрывают.
- **Адресная строка.**
  - «example.com» открывает сайт;
  - «wb кроссовки» — поиск Wildberries;
  - «oz 123456» — товар Ozon (Ozon сам перекидывает на поиск, такого товара нет);
  - «как сварить борщ» — поиск Google.
- **Вкладки.**
  - Ctrl+T, Ctrl+W, Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+Shift+T;
  - закрепление, звук, дублирование, `move` через IPC, перетаскивание мышью;
  - масштаб Ctrl+= и сброс кнопкой в адресной строке.
- **Панель.**
  - F12 и кнопка открывают и закрывают;
  - смена инструментов;
  - `setWidth` 560/600;
  - вид DevTools встаёт ровно на 36 px ниже шапки.
- **Overlay.**
  - `demo` немодальный встаёт под «⋯» с `align:end`;
  - модальный закрывает всё окно;
  - закрывается по Esc, по клику мимо, по фокусу вкладки и по смене вкладки.
- **Настройки.** 10 разделов. Смена темы cosmos → light → terminal → cosmos применяется сразу в chrome, панели, overlay и настройках, цвет нативных кнопок меняется вместе с ней.
- **Безопасность.**
  - на example.com `window.kosmo` нет, переход и `window.open` на `kosmo://settings` блокируются, `fetch` на `kosmo://` блокируется;
  - `kosmo://ui/chrome/index.html` во вкладке отвечает «Не найдено»;
  - `../../main/main.js` в прямом и закодированном виде отвечает «Не найдено».
- **Ошибки и падения.**
  - ошибки -105 (`.invalid`, ответ DNS здесь идёт 10–20 с) и -312 показывают страницу ошибки; повтор и «назад» работают, в истории ровно две записи;
  - упавшая вкладка показывает полосу «Вкладка упала», перезагрузка её снимает.
- **Выгрузка и сессия.**
  - выгрузка и возврат вкладки сохраняют историю;
  - после перезапуска вкладки восстанавливаются лениво: view получает только активная.
- **Поиск по странице.** Счётчик «1 из 2».

### 4. Время старта (от запуска процесса)
| Этап | Обычная нагрузка CPU (28–34%) | Под нагрузкой (55–77%) |
|---|---|---|
| app ready | 160–200 мс | 160–200 мс |
| chrome загружен (`did-finish-load`) | 915–1557 мс | 2333–3582 мс |
| окно показано | на 10–25 мс позже chrome (0,94–1,65 с) | на 10–25 мс позже chrome |
| первая вкладка загружена | 2,2 с (внутренняя), 2,5–3,3 с (example.com, с сетью) | 4,6 с |

Бюджет 1,5 с выполняется только при обычной нагрузке. Наш код здесь почти ни при чём:
- протокол отдаёт файл за 3–5 мс;
- тёплая перезагрузка chrome занимает 100–145 мс до DOMContentLoaded.

Остальное — запуск процессов Chromium и первая компиляция JS.

### 5. Скриншоты
Все в `C:\Users\Пользователь\Desktop\KOSMOLET\tools\dev-out\core\`:
- **Обязательные:**
  - `01-main-3tabs.png` (example.com, wildberries.ru, kosmo://settings);
  - `02-panel.png`;
  - `03-light.png`;
  - `04-compact.png`;
  - `05-overlay-modal.png`.
- **Дополнительные:**
  - `06-find.png`, `07-settings-narrow.png`, `08-settings-about.png`;
  - `10-devtools-panel.png`, `20-overlay-popover.png`, `31-terminal.png`;
  - `40-error-page.png`, `41-crashed.png`, `42-error-light.png`, `43-custom.png`.

### 6. Что осталось
1. **Фокус от реальных кликов не проверен.** Закрытие поповера кликом по странице, фоновая вкладка по Ctrl+клику, фокус после F12 проверял через `webContents.focus()`. Окно стояло за экраном без фокуса, чтобы не мешать пользователю.
2. **Нативные меню не проверены на вид:** «⋯», меню вкладки, контекстное меню страницы. Они всплыли бы на экране пользователя.
3. **Тяжёлая страница, загруженная в фоне** (WB), первые 0,4–0,8 с после показа белая. `capturePage` на ней до первого кадра падает с `UnknownVizError`.
4. **`desktopCapturer` иногда не находит окно за экраном.** Тогда `/shot` собирает снимок через `capturePage`, и нативных кнопок на нём нет. Повтор помогает.
5. **Сайт по-прежнему может подключить файл `kosmo://` тегом `<script>` или `<img>`.** Данных так не получить (они только через IPC с проверкой отправителя), но наличие Космолёта определить можно.
6. **Страница ошибки не меняет тему на лету** — тема берётся из адреса в момент показа.
7. **F11 и HTML5-полноэкранный режим заново не проверял** (их проверил core-main): окно за экраном переехало бы на экран.

### 7. Подводные камни API для фич-агентов
- **Overlay.**
  - Тип `omnibox` фокус не берёт, остальные берут. Значит, клик по chrome закрывает поповер по причине `chrome-focus` ещё на mousedown, поэтому для кнопок-переключателей нужен `KChrome.toggleOverlay`.
  - Поповер закрывается при потере фокуса окном (в том числе от нативного меню или диалога), при ресайзе, смене вкладки, фокусе вкладки или панели. Модальный от клика по chrome не закрывается.
  - Карточке нужна явная ширина (`def.width` или `el.style.width`), размер overlay сообщает сам.
  - Данные в открытый поповер: `ctx.overlay.update(type, data)`.
  - События в обе стороны: `KChrome.overlayEvent` ↔ `api.emit` и `ctx.overlay.on('event', (type, data, name))`.
- **titleBarOverlay.**
  - Нативные кнопки занимают около 140 px справа на высоту полосы вкладок (38 или 32). Туда ничего не ставить.
  - Всё кликабельное в полосе вкладок должно иметь `-webkit-app-region:no-drag`. Двойной клик по области перетаскивания разворачивает окно, `dblclick` туда не приходит.
  - Модальный overlay кнопки окна не затемняет.
  - themes: `ctx.windows.setTitleBarColors({color, symbolColor})` отключает автоматическую смену цвета, `setTitleBarColors(null)` её возвращает. Для своей темы (custom) core берёт цвета сам.
- **Preload.**
  - Части `ctx.preload.addPart` регистрировать синхронно в `init`, иначе нужен `rebuild()`.
  - Изолированный мир, sandbox, `require` только для `electron`.
  - Часть с синтаксической ошибкой пропускается, `import` и `await` на верхнем уровне нельзя.
  - Модули для ui-preload (`ctx.uiPreload.addModule`) подключать только в `init`: аргументы задаются при создании окна.
- **`kosmo://`.**
  - API есть только у newtab, settings, history, downloads и extensions. Новый хост нужно добавить в `INTERNAL_HOSTS` (это core).
  - CSP запрещает встроенные `<script>` и `onclick=`, `eval` и `fetch` наружу. Всё внешнее — через IPC в main.
- **Фокус.** У вкладок `focusOnNavigation:false`, сфокусировать страницу: `ctx.tabs.focus(id)`.
- **Хранилища.** `ctx.store(name)` теперь всегда возвращает один и тот же объект.
- **claude-bridge.** У отсоединённой или только что показанной вкладки `capturePage` падает. Лучше снимать через CDP `Page.captureScreenshot` или ждать первого кадра.
- **devtools.**
  - На каждую вкладку свой вид: `ctx.panel.createDevtoolsView()` и `setDevtoolsView()`. Геттер `devtoolsView` создаёт вид лениво.
  - DevTools по умолчанию светлые и на английском, показывают плашку «available in Russian» — настроить.
- **Отладка.** Консоли интерфейса видны в `/logs`, интерфейсом можно управлять через CDP (`/json`, `Input.*`).

### 8. Что стоит внести в ARCHITECTURE.md (это делает главный агент)
- §2: флаг `--offscreen` и ключ `-OnScreen` у `start-dev.ps1`.
- §3: одно хранилище на файл, `ctx.windows.uiUrl`, `setTitleBarColors(null)`.
- §5: поле `TabInfo.error` и `focusOnNavigation:false` у вкладок.
- §6: `KChrome.toggleOverlay`; у схемы `kosmo` `corsEnabled:false`; `kosmo://error` без API.

Скрипт сценария на 27 проверок (CDP + dev-сервер) лежит вне проекта: `C:\Users\73B5~1\AppData\Local\Temp\claude\C--Users--------------Desktop\1fd84f7c-a399-4d3c-8fbd-d3a744dbfdf8\scratchpad\scenario.mjs`. Его можно перенести в `tools/` как smoke-тест. Тестовый профиль `.profiles\core-int` остался, он в `.gitignore`.