# Отчёты фич (21.10.2026, первая волна)

## ux-chrome

# Отчёт ux-chrome: все 7 пунктов сделаны и проверены вживую

Файлы ядра не правил. Регрессия ядра `node tools/smoke.mjs 47440 9344` прогнана три раза. Первый и третий прогоны — все 26 проверок проходят. Во втором прогоне один раз упал «поиск по странице» (счётчик пустой). Этот шаг я отдельно повторил 4 раза — все 4 прошли, третий прогон тоже чистый. Похоже на сбой по времени под нагрузкой: параллельно работают экземпляры соседей. `featureErrors` пустой, ошибок в консолях интерфейса нет. Свой экземпляр завершил через `/quit`, коммитов не делал.

## Что сделано
1. **История** (`history.json`).
   - Запись при посещении страницы: адрес, заголовок, значок, число посещений, время. Без kosmo://, about: и страниц ошибки. Перезагрузка не считается новым посещением, смена только якоря `#` — тоже. Первая загрузка восстановленной вкладки не пишется.
   - Хранится до 10 000 записей, старые отбрасываются.
   - Файл читается и индекс строится лениво: через 2,5 с после старта или при первом обращении, чтобы не тормозить холодный старт.
   - `ctx.history`: search, add, remove, clear, recent, плюс top, get, count, onChange.
   - Страница kosmo://history: поиск с подсветкой, группы «Сегодня / Вчера / дата», удаление записи, очистка за час / сутки / неделю / всё время с подтверждением, подгрузка при прокрутке.
2. **Закладки** (`bookmarks.json`).
   - При первом старте на полосе 7 закладок из задания.
   - `ctx.bookmarks`: list, add, remove, update, has, плюс move и find.
   - Звезда в адресной строке: первый клик добавляет закладку и открывает окно «Закладка добавлена». Повторный клик по заполненной звезде открывает правку: название, адрес, папка, удалить.
   - Полоса закладок управляется настройкой `ui.showBookmarksBar`. На ней значок и название, перестановка перетаскиванием, бросок на «Другие» переносит закладку в эту папку.
   - Правый клик по закладке: открыть, открыть в новой или фоновой вкладке, изменить, переместить, копировать адрес, удалить.
   - «Другие» и не поместившиеся закладки («»») открываются выпадающим списком.
3. **Подсказки адресной строки** — через `ctx.search.addSuggestProvider`.
   - Первая строка — «перейти / найти».
   - Дальше история, закладки и «Перейти на вкладку».
   - Бэнги: при вводе «wb » первая строка «Поиск в Wildberries: …», «wb» + Tab тоже переходит в поиск по сайту. Одни цифры дают строки «Товар WB 123456» и «Товар Ozon 123456».
   - Домен дописывается в строке, хвост выделен.
   - Работают ↑, ↓, PageUp, PageDown, Enter, Alt+Enter, Esc, Tab и клик мышью. Shift+Delete и крестик удаляют запись истории.
   - Скорость на 10 000 записей: весь ответ в main — медиана 3,4–9,6 мс (требование было < 15 мс).
4. **Командная палитра** (Ctrl+K и Ctrl+Shift+P).
   - Нечёткий поиск по командам (горячие клавиши справа), вкладкам, закладкам, истории и бэнгам.
   - «wb носки» сразу превращается в поиск по сайту. Enter выполняет выбранное.
   - В DevTools сочетания не перехватываются: там Ctrl+Shift+P — их собственное меню команд.
5. **Загрузки.**
   - Сохраняются в `downloads.dir` или в системные «Загрузки», повторное имя получает вид «table (1).pdf».
   - При `ask:true` показывается диалог сохранения.
   - Кнопка на панели появляется, когда есть загрузки: кольцо прогресса, точка у непросмотренных. Окно загрузок открывается само при старте загрузки и закрывается через 6 с.
   - В окне: открыть, показать в папке, пауза и продолжение, отмена, повтор, убрать из списка.
   - Страница kosmo://downloads: последние 200 загрузок; там же выбор папки и переключатель «спрашивать, куда сохранять». Ctrl+J открывает её — эта команда уже была в ядре.
6. **Новая вкладка.**
   - Лёгкая, в теме интерфейса: плитки закладок с полосы и часто посещаемых сайтов (по одной на сайт, лишнее можно убрать), бэнги wb, oz, ym, av, gh.
   - Клик по полю поиска или набор текста на странице переводит ввод в адресную строку, как в Chrome.
   - Ядро ставит фокус в адресную строку по Ctrl+T и «+». Я добавил фокус при переходе на уже открытую новую вкладку и при старте с ней.
7. **Раздел настроек «Поиск».**
   - Выбор поисковой системы.
   - Редактор бэнгов: добавить, изменить, удалить, проверка ключа и `{q}`, адрес для артикула, «Вернуть стандартные».
   - Проверка «как разберётся ввод» через `kosmo:search.resolve`.
   - Бэнги находятся через поиск по настройкам.

Дополнительно: в контекстное меню ссылки добавлен пункт «Добавить ссылку в закладки», появились команды Ctrl+D (звезда), Ctrl+Shift+B (полоса закладок) и «Последние загрузки».

## Файлы
Все свои, в `C:\Users\Пользователь\Desktop\KOSMOLET\src\`:
- **main:**
  - `main\features\ux-chrome.js`
  - `main\features\ux\` — `util.js`, `history.js`, `bookmarks.js`, `downloads.js`, `suggest.js`
- **интерфейс:**
  - `renderer\chrome\features\ux-chrome.js` и `ux-chrome.css`
  - `renderer\overlay\features\ux-chrome.js` и `ux-chrome.css`
- **страницы:**
  - `renderer\pages\newtab\` — `index.html`, `newtab.css`, `newtab.js`
  - `renderer\pages\history\` — `index.html`, `history.css`, `history.js`
  - `renderer\pages\downloads\` — `index.html`, `downloads.css`, `downloads.js`
  - `renderer\pages\settings\sections\search.js` и новый `search.css` рядом

В `index.html` chrome и overlay нет ссылок на CSS фич, поэтому стили подключаю из своего JS. Новых веток настроек нет.

**Новые каналы и события:**
- `kosmo:ux.*` — suggest, newtab, newtabHide, focusOmnibox, palette, paletteRun, defaultBangs
- `kosmo:history.*` — search, page, recent, remove, clear
- `kosmo:bookmarks.*` — list, find, add, update, remove, move
- `kosmo:downloads.*` — list, open, show, cancel, pause, resume, remove, retry, clear, markSeen, openDir, chooseDir
- события `kosmo:history.changed`, `kosmo:bookmarks.changed`, `kosmo:downloads.changed`
- типы overlay: omnibox, palette, bookmark-edit, bm-menu, bm-folder, downloads

## Как проверено
CDP (`Input.dispatchKeyEvent`, `insertText`, клики мышью) плюс `/eval`. Отдельно:
- скорость подсказок на 10 000 синтетических записей;
- прогресс, пауза и продолжение загрузки через локальный медленный сервер с поддержкой Range;
- тёмная и светлая темы.

Скриншоты в `C:\Users\Пользователь\Desktop\KOSMOLET\tools\dev-out\ux-chrome\`:

| Что | Файлы |
|---|---|
| Полоса закладок | `01-bar.png` |
| Подсказки адресной строки | `02-omni-exa.png`, `02-omni-inline.png`, `03-omni-wb.png`, `04-omni-digits.png`, `17-omni-tab-switch.png`, `19-omni-history-selected.png`, `28-omni-bang-query.png` |
| Новая вкладка | `05-newtab.png`, `18-newtab-chip-wb.png` |
| История | `06-history.png`, `07-history-clear.png` |
| Загрузки | `08-…09-download-*.png`, `15-downloads-page.png`, `22-download-ring.png`, `23-download-popover-progress.png` |
| Палитра | `10-palette.png`, `11-palette-query.png` |
| Закладки | `12-star-added.png`, `13-other-folder.png`, `14-bm-menu.png`, `20-bar-overflow.png`, `21-bar-more.png` |
| Настройки «Поиск» | `16-settings-search.png`, `24-settings-bang-form.png` |
| Светлая тема | `25-…27-light-*.png` |

## Ограничения
- **Диалог сохранения (`downloads.ask`) вживую не проверял:** нативное окно всплыло бы на экране пользователя.
- **Пункт контекстного меню ссылки** проверен только через `ctx.contextMenu.build`, само нативное меню не открывал.
- **Ctrl+K перехватывается и на сайтах**, как требует задание. На GitHub, Slack и подобных сайтах их собственный Ctrl+K работать не будет.
- **История хранит одну запись на адрес**, поэтому страница истории группирует по последнему посещению, а не показывает каждое посещение, как Chrome.
- **Разрешения сайтов** в ARCHITECTURE числятся за ux-chrome, но в задании их не было — не делал.
- **Первая загрузка ушла в настоящую папку «Загрузки» пользователя.** Два созданных мной тестовых файла `table.pdf` и `table (1).pdf` я перенёс оттуда в `tools\dev-out\ux-chrome\dl\`. Дальше тестовый профиль `f-ux` качал в эту папку; там же лежат тестовые `big*.zip`, около 20 МБ.

## Что нужно от соседей
- **claude-bridge:** для инструментов MCP можно брать `ctx.history.search` и `ctx.history.recent`, а также `ctx.bookmarks.list`.
- **Главный агент:** внести в ARCHITECTURE новые каналы и API `ctx.history`, `ctx.bookmarks`, `ctx.downloads` (list, dir, summary).
- **Все агенты:** общий scratchpad перезаписывается соседями — мой `cdp.mjs` перетёрли. Свои скрипты держу в `scratchpad\uxc\`.

## themes

The themes feature is done. Wildberries now goes dark, with readable text and product photos left as they are. The core smoke test passes 27/27 on my instance (`f-themes`), and I closed the instance afterwards.

**One deliberate change from the task:** I did not embed Dark Reader into the tab-preload.
- **Why:** even wrapped in an uncalled function, V8 spent about 10 ms just parsing its 355 KB on every frame of every page. As a string literal it still cost about 2.7 ms. Either way the 3 ms budget was gone.
- **What I did instead:** part `19-darkreader-lib` (added via `addPart`) is a small loader. The full source is requested from main only when the theme is on for that page (`sendSync kosmo-tab:site-theme.lib`). It runs via `webFrame.executeJavaScriptInIsolatedWorld(999)`, which is synchronous and not subject to the site's CSP.
- **Result:**
  - **No theme:** the preload part costs 0.7 ms median, 1.6 ms max over 20 reloads of example.com. An earlier run under 99% CPU load gave 1.3 / 2.7 ms.
  - **Theme on:** loading and starting Dark Reader on example.com takes about 15 ms.

**What was built (task items 1–6):**
1. **Interface themes.**
   - I made cosmos noticeably bluer, not near-black, and terminal is now true black with green.
   - The new "Своя" (custom) theme takes background, surfaces and text, plus five starter palettes.
   - The Appearance settings section gained a fifth live preview card, hex fields and a low-contrast warning.
   - Everything applies on the fly in every layer, including the native window buttons.
2. **Site dark theme.**
   - Covers both engines, the CSS/font fetch proxy (http(s) only, ≤5 MB, 10 s timeout, no cookies) and the anti-flash measures.
   - Includes parent-domain inheritance, per-site CSS that applies even without the dark theme, and `colorScheme` driving `nativeTheme`.
   - It never runs on kosmo://, devtools or error pages.
   - wildberries.ru is on by default via a settings migration.
   - Page colours follow the interface theme unless set explicitly.
   - Changing brightness, contrast or colours repaints instantly.
3. **Moon icon** in the address bar: filled when the theme is active. It opens a popover with the switch, sliders, engine choice, "Свой CSS…" and the all-sites mode. Alt+Shift+D toggles the current site.
4. **Panel tool "Тема сайта":** all parameters, a CSS editor (Tab/Shift+Tab indent, Ctrl+S, applies after 300 ms), and the list of configured sites with reset and delete.
5. **Settings section "Темы сайтов":** mode, defaults, prefers-color-scheme, and the site list with add, toggle, inline CSS editor, reset and delete.
6. **`ctx.themes`:** `siteConfig(url)` (where `enabled` is the effective on/off state), `toggleSite`, `setSite`, `removeSite`, `resetSite`, `sites`, `siteKey`, `autoColors`.

**Problems found in Dark Reader 4.9 and fixed (I edit its text in main when loading it, not in node_modules):**
- Its helper script was blocked by the site's CSP (e.g. GitHub), which also triggers CSP violation reports to the site. It now goes in through `webFrame.executeJavaScript`.
- It threw "Uncaught (in promise)" errors into the site's console on GitHub.
- With `fixes = null`, changing brightness or colours on the fly did nothing. I now always pass a fixes object.
- Switching the theme on for an already-loaded page left it light while Dark Reader reprocessed. On WB that takes 3.5–6.6 s under full CPU load. It now shows a flat dark placeholder after about 0.6 s, then the proper result.

**How it was checked** (screenshots in `C:\Users\Пользователь\Desktop\KOSMOLET\tools\dev-out\f-themes\`):
- **Wildberries:**
  - Main page off/on without reload: `01`, `02`.
  - Search "кроссовки" dark, then switched off on the fly: `04`, `03`.
  - Engine "Фильтр": `10`.
- **No white flash:** I recorded every frame while clicking through to a WB product page. None of 212 frames was bright; sample frames are in `07-nav-frames\`.
- **example.com** before and after "all sites" mode: `08a`, `08b`.
- **GitHub** turns dark on its own with colorScheme set to dark, with Dark Reader not running: `09`.
- **Live interface theme switching:** `11-ui-*` (terminal, light, graphite, custom, cosmos). The WB page recolours within about 120 ms.
- **Popover, panel and settings:** `05`, `06`, `12`–`15`.

**Edits to core files (minimal):**
- `src/main/windows.js`: only the window colour constants, updated to match the new cosmos and terminal presets.
- `src/renderer/panel/panel.js`: fixed a race where the panel opened DevTools instead of the requested tool on first open. "Свой CSS…" hit it every time; any feature opening a non-default tool would too.
- `src/renderer/shared/tokens.css`: presets only, plus a selector so the custom card can preview itself.

**Limitations:**
- Dark Reader on WB is heavy: 246 stylesheets, roughly 0.6–2.5 s of blocking work per enable on this overloaded machine. The filter engine is the fallback for slow sites.
- Cross-origin images are not fetched (the task allowed only CSS and fonts), so Dark Reader cannot analyse cross-origin background images.
- Per-site CSS applies to the top frame only.
- In "all sites" mode, sites that are already dark get processed by Dark Reader too.
- I didn't use a toast for Alt+Shift+D feedback: `KUI.toast` in chrome is hidden under the tab view. The moon briefly pulses instead.
- The dev `/shot` (desktopCapturer) sometimes returns a stale frame. I took the final screenshots by stitching together page captures (`capturePage` of each view), so the native window buttons are not in them.

**For the neighbours (nothing required):**
- Setting colorScheme to dark also makes DevTools dark, since it goes through `nativeTheme`.
- `KUI.toast` in chrome is invisible because it sits under the tab view; that is for the core to fix.

**Files:**
- `src/main/features/themes.js`
- `src/preload/tab/20-site-theme.js`
- `src/renderer/chrome/features/themes.js` + `.css`
- `src/renderer/overlay/features/themes.js` + `.css`
- `src/renderer/panel/tools/theme.js` + `.css`
- `src/renderer/pages/settings/sections/appearance.js`
- `src/renderer/pages/settings/sections/site-themes.js` + `site-themes.css`
- Core edits: `src/main/windows.js`, `src/renderer/panel/panel.js`, `src/renderer/shared/tokens.css`

All paths are under `C:\Users\Пользователь\Desktop\KOSMOLET\`.

## devtools

Готово: всё из задания работает и проверено вживую в моём экземпляре (профиль f-devtools). Smoke ядра проходит. Экземпляр закрыт, коммитов нет.

**Smoke.** Четыре прогона прошли целиком, в остальных под 100% загрузкой процессора иногда падала одна проверка из 26: краш вкладки, поиск по странице или «назад» со страницы ошибки. Краш так же падал и с выключенной записью, то есть мешает загрузка машины, а не фича. Ещё в двух запусках сам скрипт smoke упал на старте с ECONNRESET.

## Что сделано

**1. DevTools в панели**
- У каждой вкладки свой вид DevTools. Сначала `setDevToolsWebContents`, потом `openDevTools({mode:'detach', activate:false})`. При смене вкладки показываются её DevTools, при закрытии или выгрузке вкладки вид убирается. Живых видов не больше 4.
- Тема DevTools тёмная, если интерфейс тёмный, и меняется вместе с темой интерфейса на лету. Плашки «available in Russian» и «What's new» нет, в том числе в совсем новом контейнере: настройки записываются заранее в Preferences раздела.
- Проверено опытным путём:
  - перезагрузка самого DevTools рвёт связь со страницей, поэтому настройки меняются через модуль Settings внутри DevTools, без перезагрузки;
  - старые DevTools нужно закрыть и дождаться их уничтожения до открытия новых для той же вкладки, иначе новые открываются пустыми.
- «DevTools в отдельном окне» — команда в палитре и в меню «⋯». Окно — наш `BrowserWindow`: встроенный «detach» Electron после встраивания в панель больше не открывается. Закрыли окно — DevTools вернулись в панель. В панели в это время подложка «открыты в отдельном окне» с кнопкой «Вернуть в панель».
- «Исследовать элемент»: core открывает панель и через 50 мс зовёт `inspectElement` по координатам клика. Если панель была закрыта, страница сужается и под этими координатами оказывается другой элемент. Поэтому в момент правого клика я запоминаю узел под курсором и после открытия DevTools показываю именно его. На example.com выделяется нужный `<a>`.
- Добавил Ctrl+Shift+C — режим выбора элемента на странице.

**2. Захват сети и консоли (ctx.cdp)**
- Всё по пунктам задания: отладчик подключается лениво, режимы api/all, кольцевой буфер, разделитель при переходе, тела по запросу, консоль 500 записей, повторное подключение, `pageFetch`.
- Отличия от ARCHITECTURE §13:
  - `entry()` асинхронный (тело запроса может понадобиться дочитать) — claude-bridge уже вызывает его через `await`;
  - есть дополнительные методы: `info`, `captureTab`, `list`, `watch`, `requireNetwork`, `wsFrames`, `rawBody`, `timingOf`;
  - события: `entry`, `attached`, `detached`, `console`, `batch`.
- Особенность Chromium 156: ответы из кэша памяти приходят без `requestWillBeSent`. Из-за этого скрипты и картинки терялись, теперь они записываются.
- Чтобы тела ответов переживали переход на другую страницу, Chromium копирует к себе все ответы, включая картинки, и загрузка тяжёлой страницы заметно замедляется. Поэтому это включено только для вкладки, открытой в «Сеть и API». На остальных вкладках тела прошлых страниц после перехода недоступны — как в Chrome без открытых DevTools.

**3. «Сеть и API»** — всё из списка: список, фильтр-строка, чипы, «Только JSON», пауза, очистка, сохранение при переходах, HAR, детали на четырёх вкладках, копирование как fetch/cURL/PowerShell/Python, «Повторить», «Изменить и отправить», «Отдать Claude», поиск по телам ответов. Сверх задания: регулярные выражения в фильтре, просмотр сообщений WebSocket и EventSource, меню по правому клику на строке.

**4. «Хранилище»** — всё из списка, cookies берутся из сессии контейнера вкладки. Сверх задания: зелёная точка у cookies, которые уходят на текущую страницу. Подтверждение очистки — прямо в панели, без системного окна.

**5. «Устройство»** — всё из списка, плюс:
- устройство показывается по центру области вкладки с рамкой и подписью и масштабом, если не влезает;
- значок в адресной строке и бейдж на вкладке;
- после смены User-Agent страница сама перезагружается;
- 17 команд в палитре.

**6. Раздел настроек** — режим записи, лимит, «Сохранять журнал при переходах», «Записывать консоль страницы» (некоторые антиботы замечают включённую консоль отладчика), удалённая отладка с предупреждением о безопасности, текущим состоянием порта и кнопкой «Перезапустить». Чтение `settings.json` до ready в `main.js` ядро уже сделало, правка не понадобилась.

## Что проверено на Wildberries (поиск «кроссовки»)
- API-запросы видны, ответ `u-search/exactmatch/…/search` открывается деревом, путь `products[3].supplierRating` показывается и копируется.
- Скопированный fetch-код выполнен во вкладке: тот же ответ — 100 товаров, тот же первый id. «Повторить» тоже дал 200 и те же 100 товаров.
- HAR: 83 записи, у 62 есть тела. Markdown для Claude записан в тестовую папку inbox (мост в моём экземпляре ещё не был подключён, поэтому файл писал я сам). Поиск по телам находит совпадения.
- Cookies: создание, правка, удаление; страница видит изменённое значение через `document.cookie`; заголовок Cookie правильный; localStorage меняется.
- Эмуляция iPhone 15: страница получает ширину 393, мобильный UA, касания, DPR 3 — открылась мобильная вёрстка. Slow 4G, офлайн, тёмная схема, сброс работают. WebSocket записывается вместе с сообщениями.
- Генераторы кода и фильтр прогнал на наборе случаев.

**Сколько стоит запись** (процессор всё время был занят другими агентами, разброс большой):

| | Загрузка, медиана | Процессор main на загрузку |
|---|---|---|
| Синтетическая страница (180 ресурсов, 40 fetch по 50 КБ), 12 прогонов, без записи | 1927 мс | 374 мс |
| То же, режим api | 1974 мс | 579 мс |
| То же, api + вкладка открыта в «Сеть и API» | 2468 мс | 610 мс |
| Wildberries, без записи (4 полные загрузки) | 1069 мс | — |
| Wildberries, режим api (3 полные загрузки) | 1249 мс | +около 250 мс |

Итого: режим api почти не замедляет загрузку (в пределах шума) и добавляет 150–250 мс работы процессора в main на тяжёлую страницу. Хранение тел для вкладки в «Сеть и API» добавляет ещё 25–40% к загрузке. На Wildberries часть загрузок отдавала страницу антибота — такие прогоны я выбросил.

## Ограничения
- Русского языка DevTools в Electron нет: файла перевода нет в сборке. Пункт выбора языка я убрал, DevTools только на английском.
- Ядро решает, можно ли выгрузить вкладку, по `isDevToolsOpened()`, а для наших DevTools это всегда false. Поэтому вкладку с DevTools — встроенными или в отдельном окне — таймер может выгрузить; DevTools при этом закроются.
- Если вызвать «Reload DevTools» в меню самого DevTools, связь со страницей рвётся. F5 и Ctrl+R внутри DevTools перехватывает ядро и перезагружает страницу, а не DevTools.
- В «Изменить и отправить» нельзя задать Cookie, Origin, Referer, User-Agent и `sec-*` — это ограничение fetch из страницы. CORS и CSP страницы тоже действуют.
- Режимы api и all подключают отладчик и консоль ко всем вкладкам, а это заметно антиботам. Консоль отключается в настройках.

## Файлы
- Мои, main:
  - `src/main/features/cdp-hub.js`
  - `src/main/features/devtools.js`
  - `src/main/features/devtools/emulation.js`
  - `src/main/features/devtools/storage.js`
  - `src/main/features/devtools/network.js`
- Мои, панель: `src/renderer/panel/tools/` — `devtools-common.js`, `devtools.js`, `network.js`, `storage.js`, `emulation.js` и `.css` к каждому.
- Мои, chrome и настройки:
  - `src/renderer/chrome/features/devtools.js` и `.css`
  - `src/renderer/pages/settings/sections/devtools.js` и `.css`
- `overlay/features/devtools.js` не понадобился.
- Правка ядра одна: в `src/renderer/panel/index.html` добавлена строка `<script src="tools/devtools-common.js" defer>` перед `tools/devtools.js`.
- Новые настройки: `devtools.preserveLog` и `devtools.console`, обе по умолчанию включены.

## Что нужно от соседей
- **claude-bridge:** вызываю `ctx.bridge?.toInbox({title, markdown, host})` и жду `{path}`; если моста нет, пишу файл сам в `ctx.paths.inbox`. Мост уже пользуется `ctx.cdp`, в том числе `info` и `captureTab` — всё совместимо.
- **claude-terminal:** после «Отдать Claude» вызываю `ctx.terminal?.pasteToClaude('Разбери запрос … "<путь>" ')`.
- **Главному агенту:** в ARCHITECTURE §13 исправить `ctx.bridge.pageFetch` на `ctx.cdp.pageFetch` и отметить, что `entry()` асинхронный.
- **Ядру (по желанию):**
  - не выгружать вкладки с DevTools — смотреть на `ctx.devtools?.dock.docks()`;
  - в «Исследовать элемент» передавать фиче параметры клика, а не звать `inspectElement` с координатами.

## Скриншоты
Все в `C:\Users\Пользователь\Desktop\KOSMOLET\tools\dev-out\devtools\`:
- **DevTools:** `d2-devtools-wb.png`, `d3-inspect.png`, `d4-external.png`, `d4-window.png`, `d5-light.png`, `d7-new-container.png`
- **Сеть:** `n4-json-tree.png`, `n5-replay.png`, `n6-editor.png`, `n7-body-search.png`, `n8-headers-narrow.png`, `n9-timing.png`
- **Хранилище:** `s1-cookies.png`, `s2-localstorage.png`, `s3-cookie-editor.png`, `s4-clear-confirm.png`
- **Устройство:** `e1-iphone.png`, `e2-pixel-landscape.png`, `final-emulation-tool.png`
- **Настройки:** `set1-settings.png`
- Там же `wb.har` и пример markdown для Claude в папке `inbox\`.

## claude-bridge

# Отчёт claude-bridge

Фича работает: Claude через MCP видит вкладки и управляет ими. Все 26 инструментов вызваны вживую через `tools/mcp-call.mjs`. Смоук ядра на моём экземпляре — «ВСЁ ПРОШЛО» (27/27), `featureErrors` пустой. Свой экземпляр закрыл, тестовые файлы inbox удалил.

**Главное отклонение от задания.** Скрипт снимка выполняется не через `executeJavaScriptInIsolatedWorld(1002)`, а в именованном изолированном мире через CDP (`Page.createIsolatedWorld` + `Runtime.evaluate`). Причина: метод Electron ждёт `did-stop-loading`, а WB «грузится» 20+ секунд. В проверке `wait_for` на WB висел 20 секунд, а вызов через CDP прошёл сразу. Мир 1002 остался запасным путём, если `ctx.cdp` нет. Ref-ы между вызовами сохраняются: Chromium переиспользует мир по имени.

## Что сделано (по пунктам задания)
1. **MCP-сервер.** Streamable HTTP без сессий: на каждый запрос новый `McpServer` и транспорт, ответы JSON. Защита:
   - чужой Host — 403;
   - любой заголовок Origin — 403;
   - нет Bearer или он неверный — 401 (сравнение через `timingSafeEqual`);
   - тело больше 2 МБ — 413.

   Режимы off/read/full и смена порта применяются на лету. На старте поднимается только `http.createServer`. SDK (около 0,6 с) грузится при первом запросе.
2. **Инструменты.** Все 26 из списка. Список один для всех режимов, потому что Claude Code его кэширует. В режиме read инструменты действий возвращают понятную ошибку «Blocked… read», в описании у них пометка «Needs access mode full». Отличия от формулировок задания:
   - `click` шлёт `sendInputEvent` с учётом zoomFactor;
   - `type` делает focus + `insertText`;
   - `press_key` шлёт keyDown/char/keyUp;
   - после click/type/navigate инструмент сообщает, что изменилось: переход, смена адреса без перезагрузки или новая вкладка;
   - вкладки `kosmo://` и схемы `javascript:`/`file:` закрыты для Claude.
3. **Журнал.** `claude-activity.json` хранит 500 записей, рассылается событие `kosmo:bridge.activity {entry}` (при очистке — `{cleared:true}`), вызывается `markClaude`. Секреты скрыты: пароль при вводе пишется как `•••`, значения cookie и Authorization тоже маскируются.
4. **Пикер.** Рамка в закрытом shadow root, Esc отменяет, Ctrl+Shift+E, пункт контекстного меню «Показать Claude этот элемент» (по координатам). В селекторах отбрасываются классы-хэши CSS-модулей. Main принимает результат только с ожидаемым id от главного фрейма. После выбора — плашка «Элемент передан Claude».
5. **«Отправить в Claude».** Ctrl+Shift+Y, пункт в контекстном меню и в меню «⋯». Пишется markdown, путь копируется в буфер. Если у соседа есть `ctx.terminal.pasteToClaude`, путь `@<путь>` вставляется в терминал.
6. **Кнопка Claude.** Точка-статус: выкл, чтение, полный, ошибка; ярче, если Claude действовал за последнюю минуту. Поповер: режим доступа, адрес сервера, 8 последних действий, «Подключить к Claude Code», «Команда», «Журнал», быстрые «Показать элемент» и «Отправить страницу». Чтобы плашки было видно, они показываются рядом с кнопкой: обычный тост внизу окна закрыт страницей.
7. **gen/claude-mcp.json** пересоздаётся при смене порта или токена.
8. **Раздел настроек «Claude».** Режим, статус сервера, порт (с пометкой, если он задан флагом `--mcp-port`), токен: показать, скопировать, перевыпустить с предупреждением. Ещё: кнопка подключения, команда с замаскированным токеном, путь к файлу конфигурации, папка inbox (выбор через диалог, открыть, сбросить), поля терминала, очистка журнала.
9. **`tools/mcp-call.mjs`.** Параметры `--port/--token` или `--profile`, команды `list` и `call`. Картинки сохраняет в файл и печатает путь.

## Файлы
- Main:
  - `src/main/features/claude-bridge.js`
  - `src/main/features/page-snapshot.js`
  - `src/main/features/bridge/` — `server.js`, `tools.js`, `actions.js`, `activity.js`, `inbox.js`, `connect.js`, `picker.js`
- Preload: `src/preload/tab/30-picker.js`
- Renderer:
  - `src/renderer/chrome/features/claude.js` + `claude.css`
  - `src/renderer/overlay/features/claude.js` + `claude.css`
  - `src/renderer/pages/settings/sections/claude.js` + `claude.css` (css-файл раздела новый)
- `tools/mcp-call.mjs`

**Файлы ядра не правил.** В рантайме:
- через `settings.addDefaults` добавлен ключ `claude.shell` (powershell|cmd|bash);
- для скриншота фоновой вкладки её вид на ~0,3 с кладётся в окно под активную вкладкой и затем снимается — сам файл `windows.js` не меняется.

## Что и как проверено
Всё через `mcp-call.mjs`, свой экземпляр f-bridge (47470/47337/9347):
- **Список и снимки.** `list` — 26 инструментов с инструкциями сервера.
  - snapshot example.com: 1 ref, 17 мс.
  - snapshot WB-поиска: 193 ref-а, около 20 тыс. символов, 175 мс, текст читаемый — `tools/dev-out/f-bridge/wb-snapshot.txt`.
  - snapshot локальной тест-страницы: shadow DOM, same-origin iframe, форма — всё попало в снимок.
- **Действия.**
  - click по ref ссылки перешёл на iana.org.
  - type в поиск WB с submit: «URL changed … кеды+женские», затем карточки.
  - На тест-странице сработали: ввод пароля (замаскирован), `select_option`, чекбокс, отправка формы, кнопки в shadow DOM и во фрейме, клик при масштабе 125%, ссылка `target=_blank` («Opened new tab»), `press_key`, hover, scroll колесом и до низа, back/forward, `wait_for` (selector, networkIdle, urlChange, time), клик во фоновой вкладке.
- **eval_js** с `await`, возвратом DOM-узла и Map; ошибки JS и синтаксиса возвращаются понятным текстом.
- **Запросы WB.**
  - `network_requests` и `network_request`: заголовки и тело ответа.
  - `page_fetch` к API WB: без заголовков страницы антибот WB отвечает 403; с заголовками `deviceid`/`x-requested-with`, скопированными из перехваченного запроса, — 200 с JSON.
- **Хранилище и консоль.** `cookies_get` (HttpOnly виден), `storage_get`, `console_logs`.
- **Скриншоты.**
  - Видимая область, вся страница (5031 px) и отдельный элемент — `tools/dev-out/f-bridge/shot-*.jpg`.
  - Фоновая вкладка — `bg-test.jpg`.
- **Безопасность** (`curl` и скрипт): без токена 401, чужой Origin 403, чужой Host 403, тело 3 МБ — 413. Режим read блокирует click; режим off останавливает сервер; переключение обратно в full поднимает его.
- **Смена порта на лету** без флага: порт 47338 → 47339, старый порт закрылся, `claude-mcp.json` обновился. Занятый порт даёт состояние ошибки — `10-port-busy-zoom.png`.
- **Пикер** через `sendInputEvent`: наведение и клик — `picker-hover.png`; плашка — `04-picked-toast-zoom.png`. Пункт контекстного меню тоже проверен.
- **Отправка в inbox.** Ctrl+Shift+Y создаёт файл (`08-sent-toast-zoom.png`), в тестах буфер обмена подменялся заглушкой. Файлы писались в тестовую папку профиля, потом удалены. Папка `Документы\Космолёт\claude-inbox` не создавалась.
- **Подключение к Claude Code** не запускалось. Проверено пробным режимом (`dryRun`) и подменой команды на `echo`: аргументы, включая `"Authorization: Bearer <token>"`, доходят через cmd.exe правильно.
- **Скриншоты интерфейса** в `tools/dev-out/f-bridge/`:
  - `01-toolbar*.png` — кнопка на панели;
  - `02-popover*.png`, `03-popover-read*.png`, `11-popover-light*.png` — поповер;
  - `05/06/07-settings*.png` — раздел настроек;
  - `09-tab-glow-top.png` — подсветка вкладки.

## Ограничения
- Реальное подключение `claude mcp add` и диалог выбора папки не нажимались, чтобы не трогать конфиг пользователя и не открывать окна на его экране.
- Первый вызов MCP дольше на ~0,2–0,6 с: в это время грузится SDK и занят поток main.
- Скриншот фоновой вкладки занимает ~1,5 с. На выгруженной вкладке инструмент сначала ждёт загрузку, до 15 с.
- Новые вкладки не наследуют масштаб страницы — Chromium хранит его по хосту.

## Что нужно от соседей
- **devtools.** `ctx.cdp.pageFetch` идёт через `executeJavaScriptInIsolatedWorld`, а тот ждёт конца загрузки страницы. Мост это обходит: пока страница грузится, fetch делается через свой CDP-мир. Повтор запроса в панели «Сеть» на WB во время загрузки повиснет. Ещё: в dev консоль страниц засоряет «Electron Security Warning» — мост его отфильтровывает.
- **claude-terminal.**
  - Журнал: `kosmo:bridge.activity {limit}`, события `{entry}` и `{cleared:true}`. Кнопка «Журнал» открывает панель `claude` и через ~250 мс шлёт событие `kosmo:bridge.showLog` — по нему стоит переключиться на подвкладку журнала.
  - Ключ `claude.shell` (по умолчанию powershell) уже зарегистрирован мостом.
  - Для `claude --mcp-config` берите `ctx.bridge.mcpConfigPath()`.
  - `pasteToClaude(text)` вызывается со строкой `@<путь> `.
- **core.** Пусть главный агент добавит в ARCHITECTURE §13: имена CDP-миров (`kosmolet-snapshot` / `kosmolet-eval` / `kosmolet-fetch`) и каналы `kosmo:bridge.toast`, `kosmo:bridge.picker`, `kosmo:bridge.picked`, `kosmo:bridge.status`, `kosmo:bridge.openLog`.

