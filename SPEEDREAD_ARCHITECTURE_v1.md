# SpeedRead — архітектура v1.0

Статус: проєктне рішення / implementation handoff. Мета: одна система RSVP-читання для CLI, tmux/термінала, вебу та iPhone, із локальною обробкою тексту й необов'язковою синхронізацією.

## Принципи

1. **Один детермінований TypeScript Core** для сегментації тексту, структури документа, таймінгу, навігації та збереження позиції. Ніяких залежностей від DOM, Node або Swift усередині Core.
2. **Окремі capture adapters**: Claude Code Stop hook, Codex `notify`, stdin, файли, clipboard, iOS Share Extension/Shortcuts. Кожен отримує текст лише з явного, дозволеного джерела.
3. **Окремі presentation adapters**: terminal TUI, responsive web/PWA, iOS shell (SwiftUI + WKWebView). Застосунок на iOS не переписує алгоритми читання на Swift.
4. **Local-first**: кожен клієнт читає вже імпортовані документи офлайн. Міжпристроєва передача — opt-in.
5. **Зв'язування з контекстом**: `last` означає останню завершену відповідь у *визначеній сесії*, а не випадкову відповідь із будь-якого вікна.
6. **Однакові команди**, але різні взаємодії: Play, Pause, back/forward sentence, speed, context, close; клавіші в терміналі й великі сенсорні зони на iPhone.

## Контракт користувацького досвіду

### A. Термінал + Claude Code/Codex

- Модель завершує відповідь, hook/notify надсилає її у локальний SpeedRead Inbox **без автоматичного відкриття** та без передачі мережею.
- `sr last` шукає документ поточної сесії/панелі, за наявності. Якщо контекст неоднозначний — показує короткий селектор джерела, а не вгадує.
- Клавіша в tmux відкриває `display-popup` з reader TUI; поза tmux `sr` відкриває reader на весь екран термінала.
- Читання починається в режимі **Ready**; Space = Play. Esc/Q закриває, позиція зберігається. Повернення в робочу програму без втрати сесії.
- `sr --clipboard`, `some_command | sr`, `sr open file.md` — ручні джерела.

### B. iPhone із довільного застосунку

- **Реалістичний MVP**: виділити/скопіювати текст → Shortcut/відкрити SpeedRead → Paste; якщо інша програма ділиться текстом через меню Share, Shortcut може приймати саме shared input. Для PWA приймання Share Target через Safari на iOS **не вважати підтримуваним**.
- **Нативний реліз**: власний iOS Share Extension приймає text/URL, зберігає у спільному App Group контейнері; застосунок читає імпорт і відкриває Reader. Не припускати, що extension може безумовно форсувати запуск головного застосунку.
- **Імпорт із термінала**: iPhone за бажанням під'єднується до довіреного SpeedRead Bridge через захищену приватну мережу (наприклад Tailscale), вибирає останній документ конкретної сесії, завантажує його локально й читає офлайн.
- iOS не дозволяє довільний overlay над сторонніми застосунками. Робочий режим — окремий fullscreen reader зі швидким переходом назад.

## Схема

```text
[Claude Stop] [Codex notify] [stdin/file] [clipboard] [iOS Share/Shortcut]
       \          |             |           |              /
              [CAPTURE ADAPTERS + SOURCE TAGGING]
                              |
                    [DOCUMENT NORMALIZER]
                   Markdown / Unicode / Blocks
                              |
                   [SPEEDREAD CORE (TS)]
                Segments / Timing / Navigation
                              |
                  [Document + Progress Stores]
                        |             |
                [TUI Adapter]    [Web UI / iOS WKWebView]
                        \             /
                    [OPTIONAL SYNC BRIDGE]
               Local API / Paired Private Devices
```

## Репозиторій

```text
speedread/
  apps/
    cli/              # sr: last, read, file, paste, inbox, pair
    tui/              # Ink/ANSI rendering; tmux popup launcher
    web/              # Responsive React + Vite PWA, offline
    ios/              # SwiftUI shell, WKWebView, Share Extension, App Group
  services/
    bridge/           # Local daemon, queue, API, optional WS
  packages/
    core/             # Pure TS: parser, timeline, state machine, ORP
    protocol/         # TypeScript types + Zod/schema, versioned wire format
    storage/          # Adapter contracts: SQLite / IndexedDB
    capture/          # Input normalization, origin metadata, deduplication
  integrations/
    claude-code/      # Stop hook -> sr capture
    codex/            # notify -> sr capture
    tmux/             # key binding + display-popup
    shortcuts/        # iOS Shortcut install/documentation
  tests/
    fixtures/         # UA, EN, JA, markdown, code, tables, punctuation
  docs/
    UX.md
    ARCHITECTURE.md
    SECURITY.md
```

**Виконання**: Node LTS для CLI/Bridge/TUI; браузер/вбудований WKWebView для web/core. Нативний iOS шар потребує macOS + Xcode або відповідної macOS CI-збірки. Нативна оболонка не є блокером для розробки спільного Core й PWA з Windows.

## Дані й протокол

Документи — immutable (повторний імпорт того самого повідомлення дедуплікується за source + sourceId/content hash). Позиція читання — окрема змінна сутність.

```ts
type Source = 'claude' | 'codex' | 'clipboard' | 'file' | 'share' | 'manual';

type ReaderDocument = {
  schema: 1;
  id: string;
  source: Source;
  sourceSessionId?: string;  // Claude session або Codex thread
  sourceMessageId?: string;
  sourcePaneId?: string;     // tmux, коли доступний
  title?: string;
  text: string;              // canonical UTF-8 plain/markdown
  format: 'plain' | 'markdown';
  localeHint?: string;
  createdAt: string;         // ISO-8601
  contentHash: string;
  privacy: 'local' | 'sync-allowed';
};

type ReadingProgress = {
  documentId: string;
  segmentIndex: number;
  wpm: number;
  status: 'ready' | 'playing' | 'paused' | 'finished';
  revision: number;
  updatedAt: string;
  deviceId: string;
};
```

У мережі передавати документ JSON через HTTPS API (тексти — в тілі запиту/відповіді, **не** в URL/query). Мінімальний протокол v1:

- `GET /v1/sessions` — дозволені локальним користувачем джерела;
- `GET /v1/documents?sessionId=...` — метадані документів;
- `GET /v1/documents/:id` — повний документ після авторизації;
- `POST /v1/import` — явний імпорт (короткий-lived/pairing auth);
- `PUT /v1/progress/:id` — позиція з `revision` і `deviceId` (потрібна поведінка при конфлікті);
- `GET /v1/health` — health only, без секретів.

Початковий локальний Bridge можна реалізувати через Unix socket / Windows named pipe; мережева HTTP-обгортка — окремий opt-in модуль. Не відкривати API на `0.0.0.0` за замовчуванням.

## Стан рідера

```text
EMPTY -> READY -> PLAYING <-> PAUSED -> FINISHED
            ^        |            |
            +--------+------------+
                 seek / reopen
```

- `PLAYING` — єдиний стан, де рухається монотонний таймер.
- `ready` і `paused` показують поточне слово, а на утримання/за запитом — повне речення.
- Нова відповідь у Inbox **не збиває** поточне читання, максимум ненав'язливий індикатор «+1».
- Якщо програма втратила фокус або iOS перейшов у background, **автопауза** (можна конфігурувати на desktop). Після повернення — Resume.
- `Escape` або закриття не видаляє документ; запам'ятовує поточну позицію.

## Reader Engine

- Parse Markdown у AST, класифікувати: paragraph, heading, quote, list, inline code, fenced code, table, link. Текст, структура, offsets зберігаються; не розглядати все як `text.split(/\s+/)`.
- `Intl.Segmenter` або сумісна реалізація, з явними тестами для української, англійської, японської, цифр, емодзі, змішаних скриптів та пунктуації.
- Орієнтовне базове інтервальне читання: `intervalMs = 60000 / wpm`, з вагами на розділових знаках, довгих словах і межах блоків. Коефіцієнти — налаштування, не магічні константи.
- Відображення з оптичною точкою фіксації (ORP) у сталому x, без стрибків рядка за довжиною слова. Опційне підсвічування опорної літери.
- Навігація за сегментом / реченням / блоком. При переході до коду/таблиці — context card з ручним переходом далі, а не поодинокі хаотичні слова.
- Базові налаштування з окремими профілями: `Focus` (високий WPM, короткі паузи), `Comprehension` (більші паузи), `Technical` (код/таблиці як блоки).
- Режим TTS — можливий **інший renderer** у майбутньому. Не змішувати розрахунок RSVP WPM із синтезом голосу.

## Інтерфейс керування

| Дія | Terminal/TUI | iPhone |
|---|---|---|
| Відкрити поточну відповідь | tmux hotkey або `sr last` | Share Sheet / Shortcuts / Inbox |
| Play / Pause | Space | центральна зона |
| Назад на речення | `J` / Left з модифікатором | ліва зона / swipe right |
| Уперед на речення | `K` / Right з модифікатором | права зона / swipe left |
| WPM | `+` / `-` | слайдер на паузі / регульований жест |
| Context | `C` | утримування по центру |
| Вийти | Esc / Q | закрити / системний back |
| Прогрес | зберегти автоматично | зберегти автоматично |

Узгодити конкретні клавіші після першого usability-тесту; не займати бездумно системні комбінації термінала. Сенсорні жести не повинні випадково міняти WPM.

## Як працює вибір `last`

1. Якщо є explicit document id — відкриваємо саме його.
2. Якщо є `sourceSessionId` (з прив'язки до активного tmux-pane/CLI-сесії) — остання завершена відповідь цієї сесії.
3. Якщо є кілька активних сесій, але немає точної прив'язки — короткий список останніх 3–5 документів із назвами й часом.
4. Якщо не знайдено жодного — ручний імпорт (clipboard/file), без вигаданого тексту.

Окремий `sr inbox` для повернення до вже збережених відповідей. Можна обмежувати зберігання TTL і кількістю документів.

## Приватність і безпека

- Система не читає довільні чужі застосунки і не запитує доступ до всього екрана для перехоплення тексту.
- Captures із Claude/Codex за замовчуванням потрапляють **лише** у локальний Inbox; синхронізація за явною дією або явним opt-in per source.
- Не логувати вміст повідомлень і не класти текст у URL, історію shell, telemetry, crash logs. Не приймати довільні shell-команди через API.
- Bridge на `localhost`/локальному IPC за замовчуванням; доступ із телефона — тільки після pairing, через захищену мережу та обмежений токен; revoke/unpair.
- Sensitive-project mode: вимкнути capture hooks, cloud/remote sync; не зберігати секрети. Реалізувати source allowlist/exclusions, no-capture toggle.
- Через обмеження iOS background роботи RSVP-читання розраховане на активний екран. Background audio TTS — окрема задача.

## Робочі фази

**Phase 0 — Core + UX contract**
- TS parser/timeline/state machine; 30–50 fixtures; стабільні tests; JSON schema; reader Web demo; базові профілі.

**Phase 1 — Terminal end-to-end**
- `sr` CLI, TUI, tmux popup, Claude Stop, Codex notify, Inbox, SQLite; ручний fallback через clipboard. Відкривати не ту сесію — blocker bug.

**Phase 2 — Mobile without native build**
- Responsive offline PWA, IndexedDB, iOS Shortcuts: clipboard/manual paste, shared text where supported; окремий приватний bridge через paired network. Тест у метро/нестабільній мережі.

**Phase 3 — Native iPhone ergonomics**
- SwiftUI/WKWebView із тим самим bundled web/Core; Share Extension + App Group; app shortcuts, deep links; offline import; TestFlight після iOS signing.

**Phase 4 — Optional refinements**
- Sync progress із конфліктами, multi-device queue, browser extension, context/technical reader, optional TTS.

## Acceptance criteria v1

1. UA/EN/JA Unicode стабільний на обох клієнтах; пунктуація, markdown і код не ламають навігацію.
2. Одна й та сама структура документа на CLI і iPhone дає однакові сегменти, інтервали і ORP.
3. Відповідь Codex/Claude можна прочитати через **одне викликання**, без ручного копіювання; `last` без хибних сесій.
4. Після паузи/закриття позиція відновлюється; новий текст не перериває попереднього.
5. На iPhone текст, імпортований локально, читається в airplane mode.
6. Remote доступ вимкнений за замовчуванням, захист по токену і мережі ввімкнений за opt-in.
7. Web/iOS оболонка й TUI можуть відрізнятися в оформленні, але працюють на одному Core.

## Відомі обмеження / залежності

- Safari iOS не є Web Share Target: для повністю безшовної Share Sheet інтеграції потрібна нативна extension.
- iOS не дозволяє звичайному застосунку малювати вікно над будь-яким стороннім застосунком.
- Native iOS development потребує macOS/Xcode або macOS CI; PWA + Core на Windows розробляються без цього.
- Tmux popup доступний лише там, де реально працює tmux; у нативній Windows PowerShell — CLI/TUI без popup (або WSL).
- Claude `Stop.last_assistant_message` та Codex `notify.last-assistant-message` треба під'єднувати за актуальними офіційними схемами; інтеграції мають мати версіоновані адаптери і тести.

## Технічні рішення, зафіксовані для v1

- TypeScript Core + React Web (Vite) + Node CLI/Bridge/TUI + lightweight SwiftUI/WKWebView iOS.
- Immutable document model, independent per-device reading progress, SQLite/IndexedDB adapters.
- Capture hooks лише локальні за замовчуванням; remote sync opt-in.
- Один monorepo; не підтримувати три незалежні реалізації engine.

## Для першого кодування

Почати не з мобільної обгортки, а з **контракту core** та автоматизованих unit tests. Потім реалізувати один reference reader у Web і TUI, аби відразу перевірити однаковість сегментації/таймінгу. Далі додати capture session routing, hook adapters, offline PWA, і тільки потім native bridge.

## Підтвердження джерел (станом на 2026-11)

- Claude Code hooks reference: https://code.claude.com/docs/en/hooks
- Codex configuration / notify: https://learn.chatgpt.com/docs/config-file/config-advanced
- Apple Shortcuts Share Sheet: https://support.apple.com/en-ie/guide/shortcuts/apd163eb9f95/ios
- Apple App Groups: https://developer.apple.com/documentation/xcode/configuring-app-groups
- Web Share Target compat: https://web-platform-dx.github.io/web-features-explorer/features/app-share-targets/
- tmux display-popup: https://github.com/tmux/tmux/blob/master/cmd-display-menu.c
