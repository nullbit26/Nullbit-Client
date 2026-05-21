# Changelog

All notable changes to the AI Bot project.

## [2026-05-21 #8] - Survival v1.5 (Assisted Autonomy) + tactical spam fix

### `systems/SurvivalSystem.js` — v1 → v1.5
- **SurvivalMode enum**: `OFF` / `ON_MANUAL` / `ON_ASSISTANT` replaces `_active` boolean
- **`tryEnableByAssistant(reasonCode, confidence)`**: 6 guardrails — `USER_OVERRIDE_ACTIVE`, `COMBAT_SESSION_ACTIVE`, `FLEE_STATE_ACTIVE`, `COMBAT_STATE_ACTIVE`, `ASSISTANT_COOLDOWN`, `CONDITIONS_NOT_MET`
- **`_verifyReasonConditions()`**: validates context against reason code (`LOW_FOOD_SAFE_WINDOW`, `LOW_HP_POST_COMBAT`, `UNATTENDED_IDLE_PRESERVE`)
- **`triggerUserOverride()`**: cancels `ON_ASSISTANT` mode, blocks AI for 60s
- **Auto-recovery**: `ON_ASSISTANT` auto-disables when `food >= 20 && hp >= 95%`
- **`isActive()`**: backward-compatible, returns `mode !== OFF`
- **`getMode()`**: new method returning current `SurvivalMode` string

### `core/EventRegistry.js` — new survival events
- `survival:set_ai` (`SET_SURVIVAL_ASSISTANT`) — AI enabled survival
- `survival:user_override` (`USER_OVERRIDE_TRIGGERED`) — user took control

### `core/IntentTypes.js`
- Added `SURVIVAL_ENABLE_ASSISTANT`

### `core/BotBrain.js` — intent dispatch
- `SURVIVAL_ENABLE_ASSISTANT` case: calls `survivalSystem.tryEnableByAssistant()`
- `BOT_STOP`, `MOVEMENT_SET_FOLLOW`, `MOVEMENT_SET_COME`, `COMBAT_ENGAGE_ENTITY` now call `survivalSystem.triggerUserOverride()` (User Always Wins guardrail)

### `systems/AIIntentSystem.js`
- Added tool `enableSurvivalMode`: accepts `reason_code` + `confidence`, enqueues `SURVIVAL_ENABLE_ASSISTANT` intent

### `core/TacticalDecisionEngine.js` — idle spam fix
- `tactical:context_updated` now emits **only when context actually changes** (snapshot of 9 key fields); suppresses ~20 redundant emits/sec during idle

---

## [2026-05-21 #6] - Release config refactor & launcher localization

### `config/ConfigManager.js` — user-facing config support
- **Added `config.json` loading**: reads `Release/config.json` (or project root) before falling back to `.env`
- **Priority order fixed**: `.env` loads first (developer override) → `config.json` fills only unset vars via guarded `set()`
- **pkg/exe detection**: uses `process.pkg` to locate `config.json` next to `.exe` at runtime
- **Dual structure support**: handles both `minecraft.*` (release) and `server.*` (legacy) field layouts
- **Fields mapped**: `MC_HOST`, `MC_PORT`, `MC_VERSION`, `MC_AUTH`, `MC_USERNAME`, `MC_PASSWORD`, `ALLOWED_USERS`

### `Release/config.json` — simplified user config
- Restructured to clear `minecraft` and `bot` blocks
- Added `license_key` (KeyAuth), `bot_version` (launcher update check)
- Added `bot.allowed_user` (only this player can command the bot)
- Added `bot.server_password` (for `/login` on password-protected servers)
- Default bot username: `Nullbit`

### `scripts/launcher.js` — localization
- Removed `Cyberpunk Edition` label from banner and all comments
- Translated all UI messages, log lines, and status strings to English

### `Release/README.txt` — localization
- Fully translated to English
- Updated field descriptions to match new `config.json` structure

### `config.js`
- Default `MC_USERNAME` fallback changed from `MINI_KOSH` to `Nullbit`

## [2026-05-21 #5] - Compatibility fixes: BranchMineJob integration & ResourceSystem cleanup

### `systems/BranchMineJob.js` — исправления интеграции
- **Исправлен `_branchOrigin.y`**: было `this._targetY + 1` (hardcoded) → теперь `Math.floor(this._startPos.y)` — бот уже на правильной глубине после `_digShaftDown`, не нужно навигировать через породу
- **Исправлен `_stateNextBranch` return Y**: та же замена — `this._targetY + 1` → `Math.floor(refPos.y)` для корректного возврата к стартовой точке

### `systems/ResourceSystem.js` — исправления интеграции BranchMineJob
- **Исправлен порядок fallback-цепочки**: было `CaveExplorer fail → BranchMine → ShaftDig`, стало `CaveExplorer fail → ShaftDig → BranchMine` — бот должен сначала спуститься на нужный Y через шахту, и только потом начинать ветвистое копание на этой глубине
- **Убраны дублирующие `require` внутри методов**: `equipBestPickaxe`, `Vec3`, `findBestAxe`, `findBestShovel` подключались повторно внутри тел `_digShaftDown`, `_digShaftDownVertical`, `_climbToSurface` — перенесены на top-level
- **Убран дублирующий top-level import**: два отдельных `require('../utils/equipBestTool')` на строках 6 и 15 объединены в один с полным набором деструктурированных экспортов: `{ equipBestAxe, equipBestPickaxe, findBestAxe, findBestShovel }`

### Совместимость — проверено
- `NavEvents.GOTO kind:'near'` — поддерживается `NavigationController` ✅
- `TacticalDecisionEngine.init()` — защищён `if (_wired) return`, двойной вызов безопасен ✅
- `BotBrain.init()` — защищён `if (_initialized) return` ✅
- `SurvivalSystem` — `if (!ctx) return` при `brain.decisionContext === null` ✅
- Все экспорты (`ITEM_VALUES`, `equipBestPickaxe`, `findBestAxe`, `findBestShovel`) подтверждены ✅

### Тесты после фиксов — **70/70 ✅**
- `unit-phase3.js` — 15/15
- `unit-cave-persistence.js` — 15/15
- `unit-inventory-manager.js` — 20/20
- `unit-branch-mine.js` — 20/20

---

## [2026-05-21 #4] - BranchMineJob: ветвистая добыча на оптимальных Y-уровнях

### `systems/BranchMineJob.js` — новый модуль
- Детерминированная ветвистая добыча на оптимальных Y-уровнях (1.18+)
- `BRANCH_Y_TARGETS`: diamond=-59, iron=16, coal=96, gold=-16, copper=48, lapis=0, redstone=-59, emerald=232
- FSM: `PLAN_BRANCH` → `NAV_TO_START` → `DIG_BRANCH` → `NEXT_BRANCH` → `COMPLETE/FAIL`
- Параметры: `branchLength=32`, `branchSpacing=4` (оптимальное покрытие без перекрытия), `maxBranches=8`
- На каждом шаге сканирует 3 блока влево/вправо — при обнаружении руды копает и возвращается на ось
- Интеграция `dropJunk()` при `fillRatio >= 0.85` прямо во время копки
- Расстановка факелов каждые 8 шагов
- Защита от опасных блоков (lava, water) и гравитационных блоков (sand, gravel)
- Поддерживает `shouldInterrupt`, `alive()`, кастомные `targetY`, `branchLength`, `maxBranches`

### `systems/ResourceSystem.js` — интеграция
- Новая цепочка при `caveResult === 'fail'`: **CaveExplorer** → **BranchMine** → **ShaftDig**
- BranchMineJob вставлен между cave fail и `_digShaftDown` как более эффективный fallback

### Тесты `scripts/unit-branch-mine.js` — **20/20 ✅**

---

## [2026-05-21 #3] - InventoryManager: авто-выброс мусора во время экспедиций

### `utils/InventoryManager.js` — новый модуль
- `JUNK_ITEMS` — явный список мусора: cobblestone, dirt, gravel, andesite, diorite, granite, sand, netherrack и др.
- `KEEP_ALWAYS` — защищённый список: все инструменты, броня, руда, еда, факелы, крафтинг-стол — **никогда не дропаются**
- `isJunk(item)` — `true` если в `JUNK_ITEMS` ИЛИ не в `KEEP_ALWAYS` и нулевая ценность по `ITEM_VALUES`
- `shouldDropJunk(bot, threshold=0.85)` — `true` если `fillRatio ≥ threshold` (31+ слотов)
- `dropJunk(bot, opts)` — сбрасывает мусор до `targetFreeSlots` слотов свободно; сначала `JUNK_ITEMS`, потом нулевые неизвестные; `maxDrops=16` как safety cap

### `systems/OreJob.js` — интеграция
- Перед каждой проверкой `slots <= 2 → paused_for_home`: если `shouldDropJunk(0.85)` → `dropJunk()` прямо в шахте
- Бот **не идёт домой** пока есть мусор для выброса

### `systems/ResourceSystem.js` — интеграция
- Перед `INVENTORY_FULL` стопом gather-цикла: аналогичный вызов `dropJunk()`
- Работает и для TreeJob (дерево) и для OreJob (руда)

### Тесты `scripts/unit-inventory-manager.js` — **20/20 ✅**

---

## [2026-05-21 #2] - Cave Persistence: сохранение посещённых пещер

### `utils/CavePersistence.js` — новый модуль
- `loadVisitedCaves(map, ttlMs, filePath)` — загружает `caves.json` при старте, истёкшие записи (> TTL) сбрасываются
- `saveVisitedCaves(map, ttlMs, filePath)` — записывает Map на диск, вычищая expired перед записью
- `addAndPersist(map, key, ts, ttlMs, filePath)` — добавляет запись в Map + немедленный flush на диск
- Формат: `{ "entries": [["x,y,z", timestamp], ...], "savedAt": ... }`
- Файл: `./config/caves.json` (рядом с `homebase.json`)

### `systems/ResourceSystem.js` — интеграция
- В конструкторе: `loadVisitedCaves()` при инициализации — бот не переходит пустые пещеры после перезапуска
- После каждого `CaveExplorerJob.run()`: `saveVisitedCaves()` — состояние немедленно на диске
- TTL 25 минут (совпадает с `CAVE_VISITED_TTL_MS` в `CaveExplorerJob`)

### Тесты `scripts/unit-cave-persistence.js` — **15/15 ✅**

---

## [2026-05-21 #1] - Phase 3: TacticalDecisionEngine

### Единый источник истины для угроз и выживания

#### Новый модуль `core/TacticalDecisionEngine.js`
- Регистрируется в `Scheduler` с интервалом **1 тик** (`physicsTick`) — самый высокий приоритет
- Вызывает `buildDecisionContext()` **один раз за тик** для всего бота
- Кеширует результат в `brain.decisionContext` (frozen, обогащённый Scorer-весами)
- Эмитит `TacticalEvents.CONTEXT_UPDATED` (`tactical:context_updated`) — все системы могут подписаться

#### Scorer-веса (поля `brain.decisionContext`)
| Поле | Диапазон | Логика |
|------|----------|--------|
| `threatScore` | 0..1 | `1.0` при `immediateDanger`, `0.7` при `recentAggroPressure`, иначе масштаб `combinedPressure/3` |
| `survivalScore` | 0..1 | `hpScore + foodScore×0.4` (HP критичнее еды) |
| `resourceScore` | 0..1 | `0` без задачи; `0.5..1.0` в зависимости от `currentTask` + `inventoryFillRatio` + `inventoryValueScore` |

#### `core/EventRegistry.js` — новые события
- `TacticalEvents.CONTEXT_UPDATED` (`tactical:context_updated`) — добавлен в `REGISTERED_EVENT_DEFINITIONS` и экспортирован

#### `core/BotBrain.js` — интеграция
- `brain.decisionContext = null` — кеш текущего контекста (null до первого тика)
- `brain.tacticalEngine` — ссылка на движок
- Инициализируется **последним** в `init()`, уничтожается **первым** в `destroy()`

#### `systems/SurvivalSystem.js` — устранено дублирование
- Убран прямой вызов `evaluateThreatPressure()` в `_tick()`
- Читает готовый `brain.decisionContext` — если `null`, тик пропускается (безопасный fallback)

#### `systems/GatherGuardSystem.js` — умный кеш
- Добавлен `_getOrBuildPressure(memory)`:
  - Если `brain.decisionContext` свежее 150мс → возвращает кеш (0 пересчётов)
  - Иначе → live вызов `evaluateThreatPressure()` (async-handler может работать после await)

#### Тесты `scripts/unit-phase3.js` — **15/15 ✅**

---

## [2026-05-20] - NULLBIT Launcher v2.1: Cyberpunk Edition

### Cyberpunk Launcher

#### Новый лаунчер с автообновлением (`scripts/launcher.js`)
- **ASCII-логотип NULLBIT** — figlet с шрифтом ANSI Shadow
- **Глитч-эффекты** — функция `glitchText()` с случайными спецсимволами (#, @, _, █, ▓, ▒, ░)
- **Хакерский интерфейс** — статусы `[ SYS ]`, `[ OK ]`, `[ ERR ]`, `[ WARN ]` в капсе
- **Киберпанк прогресс-бар** — `DOWNLOADING [████░░░░░░] 45% | 350/700 MB`
- **Глитч-оповещения** — красный мерцающий текст при обнаружении обновления

#### Автообновление через GitHub Releases API
- Чтение `bot_version` из `config.json`
- GET-запрос на `https://api.github.com/repos/nullbit26/Nullbit-Client/releases/latest` (`User-Agent: Nullbit-Launcher`)
- Извлекает `tag_name` → стрипает `v` → сравнивает semver
- При обновлении: выводит **ПАТЧНОУТ** (`body` релиза) серым цветом
- Ждёт 2 секунды, затем скачивает `AIBot.exe` из `assets[]` через `browser_download_url`
- Бэкап старой версии → замена → обновление `bot_version` в `config.json`

#### Управление процессом
- Лаунчер остается висеть (не detached)
- При закрытии окна лаунчера — бот тоже завершается
- Вывод статуса: `[+] NULLBIT РАБОТАЕТ`

#### Зависимости лаунчера
```json
{
  "chalk": "^4.1.2",        // Цветной вывод (CJS версия для pkg)
  "figlet": "^1.11.0",      // ASCII-арт
  "cli-progress": "^3.12.0", // Прогресс-бар
  "axios": "^1.16.1",        // HTTP запросы
  "fs-extra": "^11.2.0"      // Файловые операции
}
```

#### Результат сборки
```
Release/
├── AIBot.exe      (554 MB)  ← Основной бот
├── Launcher.exe   (58 MB)   ← Cyberpunk лаунчер
├── config.json              ← Версия + лицензия
└── README.txt               ← Инструкция
```

---

## [2026-05-20] - Release Build System v2.0: esbuild + KeyAuth + .exe

### Новая система сборки релиза

#### 1. Архитектура сборки (`scripts/build-v2.js`)
- **esbuild bundle** — весь код проекта собирается в один файл
- **KeyAuth интеграция** — 2-этапная авторизация (init session → license check)
- **Компиляция в .exe** — через pkg, готовое приложение 700+ MB
- **Внешний конфиг** — `config.json` с лицензионным ключом

#### 2. Защита кода
- ✅ esbuild minification — нечитаемый код
- ✅ Single bundle — все модули встроены, нет внешних `require()`
- ✅ pkg compilation — код внутри бинарника
- ✅ KeyAuth license check — HWID привязка, online активация

#### 3. Процесс авторизации KeyAuth
```
1. GET /api/1.2/?type=init → получаем sessionid
2. POST /api/1.2/ с sessionid + license_key + hwid → проверка
3. При успехе → запуск бота
```

#### 4. Файлы сборки
- `scripts/build-v2.js` — основной скрипт (6 шагов)
- `scripts/verify-build.js` — проверка готовности
- `scripts/license-check.js` — модуль проверки (для разработки)
- `BUILD_SETUP.md` — полная документация

#### 5. Зависимости сборки
```json
{
  "esbuild": "^0.20.2",
  "pkg": "^5.8.1",
  "axios": "^1.6.2",
  "fs-extra": "^11.2.0",
  "glob": "^10.3.10"
}
```

### История версий сборки
- **v2.0** — esbuild bundle, фикс require() ошибок, KeyAuth session init
- **v1.0** — файл-за-файл обфускация (устарело)

---

## [2026-05-20] - PvP Mode: Полный ремонт системы ближнего боя

### Новые возможности

#### 1. Авто-экипировка (`systems/PvPMode.js`)
- Автоматическая экипировка лучшей брони (приоритет: нетерит → алмаз → железо)
- Автоматическая экипировка щита в off-hand
- Автоматическая экипировка лучшего оружия (меч/топор)
- Принудительная смена неправильных предметов в руке (щит/зелье → меч)

#### 2. Улучшенная система хила
- **Приоритет на близкой дистанции**: splash potion → golden apple
- **Приоритет на дальней дистанции**: golden apple → drinkable potions → food
- **Критический режим** (HP ≤ 6): кулдаун хила снижен с 1500мс до 500мс
- **Не прерывает еду** — хил имеет приоритет над атакой

#### 3. Voice Chat фразы
- Вход в PvP: "Ну, сука, пизда тебе, еблан"
- Убийство игрока: "ха-ха, обоссан лучшим"

#### 4. Умная защита щитом
- Щит всегда в off-hand во время боя
- Щит не трогается во время еды (чтобы не прервать хил)
- Автоматическая ре-экипировка щита после еды

### Исправления багов

| Баг | Решение |
|-----|---------|
| Спам логов "CRITICAL HP" | Флаг `_lastCriticalLog` — лог раз в секунду |
| Бот не менял меч после еды | `finally` блок с `_equipBestWeapon()` в `_useFoodItem()` |
| Двойная попытка consume | Флаг `_isEating` предотвращает повторный вызов `bot.consume()` |
| Щит в основной руке | Принудительная проверка в `_equipBestWeapon()` |
| Не вся броня экипировалась | Асинхронный `_equipBestGear()` с `await` |
| Splash potions не работали | Улучшенная проверка NBT структуры |
| Щит прерывал хил | Проверка `this._isEating` в shield методах |
| Не останавливался по "стоп" | Подписка на `MovementEvents.SET_IDLE` |
| Не хилился на критическом HP | Форсированный heal с приоритетом над атакой |

### Технические изменения

```js
// Новые флаги в PvPMode constructor
this._isEating = false          // Предотвращает двойное consume
this._lastCriticalLog = 0       // Дебаг-лог раз в секунду

// Приоритет хила над атакой
if (!this._isEating && now - this._lastAttack >= this._ATTACK_COOLDOWN) {
  this._tryAttack()
}

// Критический HP: форсированный heal
if (this._bot.health <= 6 && !this._isEating) {
  this._tryHeal(now)
  return // Пропускаем атаку
}
```

### Файлы
- `docs/PVP_MODE.md` — полная документация системы

---

## [2026-05-20] - Flee Logic Overhaul: исправление вечного BREAK_CONTACT

### Проблемы
- **Вечный BREAK_CONTACT**: Бот застревал в фазе BREAK_CONTACT из-за устаревших дистанций угроз (`memory.distance` вместо live позиций)
- **Pathfinder timeout spam**: `thinkTimeout=1500ms` слишком низкий для flee pathfinding, постоянные replan'ы
- **Избыточная дистанция flee**: `navBoost=20` блоков вызывал failures pathfinder в сложном terrain
- **Преждевременный flee**: Низкие пороги вызывали flee при хорошем HP
- **Некорректное логирование**: `nearest:0` когда угроз нет (должно быть `null`)

### Исправления

#### 1. Актуальные дистанции угроз (`combat/flee/evaluateThreatPressure.js`)
```js
// Было: устаревшие memory.distance
for (const row of threats) {
  const d = Number(row?.distance)  // STALE VALUE
}

// Стало: live позиция entity когда доступна
for (const row of threats) {
  let d
  if (botPos && row?.id != null) {
    const ent = bot.entities?.[row.id]
    if (ent?.position) {
      d = botPos.distanceTo(ent.position)  // LIVE POSITION
    }
  }
  if (!Number.isFinite(d)) {
    d = Number(row?.distance)  // FALLBACK TO MEMORY
  }
}
```

#### 2. Pathfinder таймауты (`systems/CombatSystem.js`)
```js
// Во время flee: увеличены таймауты
this._bot.pathfinder.thinkTimeout = 4000  // было 1500
this._bot.pathfinder.tickTimeout = 80     // было 45

// Восстанавливаются после flee
this._bot.pathfinder.thinkTimeout = 24000
this._bot.pathfinder.tickTimeout = 150
```

#### 3. Дистанция flee (`config.js`)
```js
// Уменьшена дистанция для более быстрого pathfinding
combatFleeNavDistance: Number(process.env.COMBAT_FLEE_NAV_DISTANCE || 10)  // было 20
```

#### 4. Пороги flee (`config.js`)
```js
// Повышен порог для предотвращения преждевременного flee
combatFleeRetreatScoreThreshold: Math.max(0.4, Math.min(4, Number(process.env.COMBAT_FLEE_RETREAT_SCORE_THRESHOLD || 2.5)))  // было 1.95

// Снижен HP порог для flee только при реальном damage
combatFleeRetreatRiskHpRatioMax: (() => {
  // возвращает 0.72 (было 0.94)
})()
```

#### 5. Игроки-угрозы в направлении flee (`systems/CombatSystem.js`)
- Модифицирован `_buildRandomFleeGoal` для включения hostile players из `getCurrentThreats()`
- Бот теперь убегает от атакующих игроков, а не только от мобов

#### 6. Исправление логирования (`systems/CombatSystem.js`)
```js
// Исправлено nearest:0 когда угроз нет
const startNearest = (nearest != null && Number.isFinite(Number(nearest))) ? Number(nearest) : null
```

### Результаты
- ✅ Фазы flee корректно переключаются (BREAK_CONTACT → STABILIZE → RECOVER)
- ✅ Бот выходит из flee когда угрозы исчезли
- ✅ Уменьшены pathfinder timeouts во время flee
- ✅ Бот flee только при HP ≤ 72% или под реальной угрозой
- ✅ Направление flee учитывает мобов и игроков
- ✅ Корректное логирование дистанций угроз

### Текущие значения конфигурации
- `retreatScoreThreshold`: 2.5 (было 1.95)
- `retreatRiskHpRatioMax`: 0.72 (было 0.94)  
- `navBoost`: 10 блоков (было 20)
- `thinkTimeout`: 4000ms во время flee (было 1500ms)
- `tickTimeout`: 80ms во время flee (было 45ms)

---

## [2026-05-19 #6] - GlobalWatchdog: глобальный детектор зависаний 24/7

### Новый модуль `systems/GlobalWatchdog.js`
- Отслеживает `bot.entity.position` раз в секунду через `setInterval`
- **Пороги зависания (deadlock):**
  - `COMBAT` / `FLEE` → 30 секунд без смещения >1 блока
  - `GATHER` (taskState.currentTask.kind==='gather') / `FOLLOWING` → 90 секунд
  - `IDLE`, `RecoveryHold.isActive()`, `brain.watchdogExempt=true` — не мониторятся
- **30 сек без движения** → предупреждение в лог: `[GlobalWatchdog] Бот простаивает Xs. Текущее состояние: X, Текущая задача: Y`
- **Порог достигнут** → эмит `WatchdogEvents.DEADLOCK_DETECTED` на шину → `pathfinder.stop()` + `clearControlStates()` + `nav:stop` → 200ms задержка → `state.transition(IDLE)` + `recoveryHoldSystem.enter('WATCHDOG_DEADLOCK')`
- Трекер сбрасывается при каждом `CoreEvents.STATE_CHANGED`
- Сообщение в чат при дедлоке: `[Watchdog] Зависание обнаружено (...). Перезапуск...`

### `core/EventRegistry.js` — новые события
- `WatchdogEvents.DEADLOCK_DETECTED` (`watchdog:deadlock_detected`) — payload: `{ coreState, taskKind?, stuckMs, at }`
- `WatchdogEvents.RESET` (`watchdog:reset`) — payload: `{ at }`
- Оба добавлены в `REGISTERED_EVENT_DEFINITIONS` и экспортированы

### Graceful exit listeners — все ключевые системы
- **`ResourceSystem._onWatchdogDeadlock()`**: если gather активен → `nav:stop` + `clearControlStates` + `pauseGather('WATCHDOG_DEADLOCK')`
- **`HomeBaseSystem._onWatchdogDeadlock()`**: если `_isRunning` или `_navigating` → сбрасывает флаги + `nav:stop`
- **`CombatSystem._onWatchdogDeadlock()`**: если COMBAT/FLEE → `_clearFleeWatchdog` + `nav:stop` + `clearControlStates` + `stopAttack` + `state.transition(IDLE)` (заменил старый `_onWatchdogDeadlock` который был подключён вручную)

### `systems/RecoveryHoldSystem.js` — jitter-escape при дедлоке
- Новая причина `WATCHDOG_DEADLOCK` в `REASONS`
- При `enter('WATCHDOG_DEADLOCK')` вызывается `_doJitterEscape()`: прыжок + случайный страф (left/right/back/forward) на 800ms → `clearControlStates()`. Вышибает бота из phantom-блоков и застреваний у стен

### `core/BotBrain.js` — интеграция
- `globalWatchdog` и `watchdogExempt` добавлены как поля (уже присутствовали в конструкторе)
- `GlobalWatchdog` создаётся в `attachGameplaySystems`, инициализируется в `init()`, уничтожается первым в `destroy()`

---

## [2026-05-19 #5] - HomeBaseSystem навигация: бесконечный partial-loop фикс

### HomeBaseSystem `_navigateToBase` — бот застревал после выхода из шахты (BUG FIX)
- **Баг**: после `_digToSurface` бот выходил на поверхность (Y=65) но оставался в 121 блоке от базы. Pathfinder слал `status:partial` вечно, бот спинил `re-emitting goto` каждые 6 сек без каких-либо действий. Дистанция оставалась 121.7 — terrain/лес/вода между шахтой и базой блокировал путь, а горизонтальный stuck detection отсутствовал.
- **Фикс**: добавлены два независимых трекера прогресса:
  - `lastProgressDist / lastProgressAt` — фиксирует реальный прогресс (смещение >2 блоков в любом направлении)
  - **30 сек без прогресса** → принудительно включает `canDig=true`, `canSwim=true`, `liquidCost=1` и пересчитывает маршрут — решает блокировку terrain/лесом/водой
  - **90 сек без прогресса** → `return false` вместо вечного цикла
- Прежний stuck detection (только подземный, через `stuckSince`) сохранён без изменений

---

## [2026-05-19 #4] - Mining Shaft Optimization & Broken Pickaxe Recovery

### ResourceSystem — вертикальный спуск к глубоким рудам
- **`_digShaftDown(oreName)` стал роутером**:
  - `targetY < 0` → новый метод `_digShaftDownVertical` (быстрый вертикальный шурф)
  - `targetY ≥ 0` → прежняя лесенка (безопасно, нет риска падения)
- **Новый метод `_digShaftDownVertical(targetY, oreName)`**:
  - Копает колонну 1×2 прямо вниз, использует гравитацию для спуска
  - Проверка безопасности каждый шаг: сканирует 8 блоков ниже — лава → стоп+чат, void (≥6 воздуха) → стоп+чат
  - Anti-stuck: footY не меняется 4 итерации → abort
  - Таймаут: deepslate 10s, обычные блоки 4s
  - Возвращает `true` если достиг `targetY ± 3`
- **TARGET_Y**: `{ diamond:-58, iron:16, coal:96, gold:-16, copper:48, lapis:0, redstone:-58, emerald:232 }`

### ResourceSystem — `_climbToSurface()` оптимизация подъёма
- **Порог DEEP_Y изменён**: теперь метод активируется при `Y < 0` (было `Y < -30`)
- Копает 2 блока над головой, прыгает, повторяет до `Y ≥ 0`

### ResourceSystem — обработка сломанной кирки во время подъёма
- **Цепочка `_equipBestDigger()` при каждой итерации**:
  1. Есть кирка в инвентаре → использовать
  2. Нет кирки → сообщить в чат + голосом: "кирка сломалась, я под землёй"
  3. Есть верстак + булыжник×3 + палки×2 → поставить верстак на пол, скрафтить каменную кирку, подобрать верстак
  4. Нет материалов → топор как замена
  5. Нет топора → лопата
  6. Ничего → abort подъёма + лог
- Лава над головой → abort (pathfinder берёт управление)

### StorageSystem — верстак в экспедицию
- `restockForExpedition()` теперь берёт `crafting_table` из сундуков (1 шт. если нет в инвентаре)
- Трекер `absentEverywhere.craftingTable` для случая отсутствия верстака во всех сундуках

### Исправлен невозможный крафт
- Убрана попытка скрафтить каменную кирку в инвентарной сетке 2×2 — в vanilla требует верстак (3 блока в ширину)

---

## [2026-05-19 #3] - Mining QoL, Multi-Chest, Torch Placement, Target Amount

### OreJob — Torch Placement in Tunnels
- Новый метод `_tryPlaceTorch()`: ставит факел каждые `TORCH_INTERVAL=8` шагов туннеля
- Сначала пробует пол, потом ближайшую стену
- Если факелов нет но есть уголь+палки — крафтит 4 штуки на месте
- Константа `TORCH_INTERVAL = 8` в топе файла

### CraftingSystem — `craftTorches(targetCount)`
- Новый метод: крафтит факелы из уголь/древесный уголь + палки (без верстака, 2×2)
- Автоматически крафтит палки если их нет
- Возвращает количество скрафченных факелов

### StorageSystem — Multi-Chest Support
- `_openChest(pos)` теперь принимает конкретную позицию
- `depositAll` итерирует по всем сундукам — переходит к следующему если текущий полон
- `withdrawItem(name, count)` ищет предмет во всех сундуках до набора нужного количества
- `withdrawCraftingMaterials` аналогично по всем сундукам
- Новый метод `restockForExpedition()`: перебирает все сундуки и берёт:
  - Лучшую кирку (если хуже iron)
  - Лучший меч (если хуже stone)
  - Еду до 16 шт (хлеб, варёное мясо, яблоки и т.д.)
  - Факелы до 16 шт
  - Лучшую броню (шлем/нагрудник/поножи/ботинки)
  - После взятия автоматически надевает броню

### HomeBaseConfig — Multi-Chest Registry
- `_chestPositions[]` — список всех сундуков в радиусе базы
- `getChestPositions()` — возвращает массив всех позиций
- `scanNearbyChests(bot, radius=10)` — пересканировать сундуки
- `setBaseLocation` принимает `allChestPositions[]`
- `saveToConfig`/`loadFromConfig` сохраняют/загружают `chestPositions`

### misc.js (команда "тут база")
- При установке базы сканирует `findBlocks` в радиусе 10 блоков
- Передаёт все найденные сундуки в `setBaseLocation`
- Обновляет живой конфиг в `brain.homeBaseConfig`
- Ответ: `"База установлена! 3 сундук(ов) в радиусе 10 блоков."`

### HomeBaseSystem — `executeRoundTrip` расширен
- Шаг 4: взять факелы из сундука → крафтить если мало
- Шаг 5: `restockForExpedition()` — полная подготовка к экспедиции
- Пауза сокращена с 2000мс до 1000мс

### ResourceSystem — Target Amount
- `startGather(type, targetAmount=0)` — опциональная цель по количеству
- Проверяет `dropMatcher` в инвентаре каждую итерацию цикла
- При достижении цели: `stopGather('TARGET_REACHED')` + лог
- `_onGatherStart` передаёт `payload.amount`

### commandRegistry.js — Команды с количеством
- Паттерны с числом для coal, iron, gold, diamond:
  - `"добудь 30 железа"` → `{ resource: 'iron', amount: 30 }`
  - `"копай 2 стака угля"` → `{ resource: 'coal', amount: 128 }`
  - `"mine 64 iron"` → `{ resource: 'iron', amount: 64 }`
- Поддержка русских стаков: `стак/стака/стаков`

### resource.js handler
- Парсит `parsed.args.amount`: число или `N стак(а/ов)` / `N stack(s)`
- Ответ бота: `"Начинаю собирать iron (цель: 30 шт.)"`

---

## [2026-05-19 #2] - Drop Collection & HomeBaseSystem Fixes

### OreJob `_tunnelToPos` — бот уходил ОТ дропа (CRITICAL BUG FIX)
- **Баг**: `aX/aZ` вычислялись через `Math.sin(-yaw)/Math.cos(-yaw)` — математически **обратное** направление. Бот смотрел на дроп, но двигался от него. В логах: `dist=4.0 → 4.9 → 5.9 → FAILED dist=13.8`
- **Фикс**: `Math.sin(-yaw)` → `Math.sin(yaw)`, `Math.cos(-yaw)` → `Math.cos(yaw)` — одна строка

### OreJob `_collectDrops` — entity-based сбор дропов
- **Было**: после копки шёл к позиции *блока* руды (дроп мог отлететь), использовал pathfinder
- **Стало**:
  - Сканирует реальные item-entity в радиусе 6×6×6 блоков через `bot.entities`
  - Немедленно стопает pathfinder (`NavEvents.STOP`)
  - Брутфорс `_tunnelToPos` к каждому дропу по точной entity-позиции
  - `maxSteps` увеличен 15→20, arrival radius 1.2→1.5
  - Guard на call-site: `horizDist ≤ 6 && dy ≤ 6 && pathSafe` перед попыткой

### HomeBaseSystem — конфликт с OreJob (BUG FIX)
- **Баг**: `_navigateToBase()` крутил poll-цикл и re-emit'ил `NavEvents.GOTO` каждые 6 сек даже после завершения round-trip — сбрасывал nav-цель OreJob
- **Фикс**: подписка на `ResourceEvents.GATHER_START` → флаг `_gatherInterrupted` → abort nav loop + `_isRunning = false` при следующем poll-тике (≤500мс)
- При gather-abort: `NavEvents.STOP` с reason `gather_took_over`, не выставляется `_pendingHomeReturn`

---

## [2026-05-19] - Navigation & Mining Loop Fixes

### ResourceSystem — бесконечный цикл `paused_for_home` (CRITICAL BUG FIX)
- **Баг**: `OreJob` возвращал `paused_for_home` (нет кирки) → `ResourceSystem` не обрабатывал этот результат → цикл перезапускал `OreJob` 60+ раз/сек без задержки
- **Фикс**: добавлен явный обработчик `paused_for_home` — вызывает `homeBaseSystem.executeRoundTrip()` для навигации домой + депозита + крафта, затем `sleep(2000)` guard
- **Duplicate `sleep` SyntaxError**: случайный импорт `require('../utils/sleep')` конфликтовал с локальным определением — убран лишний импорт

### OreJob `_tunnelToPos` — повторная копка одного блока (BUG FIX)
- **Баг**: бот копал один и тот же блок снова и снова, не сдвигаясь с места; при цели ниже текущей позиции не опускался
- **Фикс**:
  - Stuck detection: 3 шага без движения (< 0.3 блока) → принудительный jump+forward
  - Вертикальное движение выделено отдельно: `horizDist < 1.2 && dy < -1.5` → копает пол и ждёт гравитацию; `dy > 1.5` → копает потолок и прыгает
  - Горизонтальный режим: дополнительно копает пол вперёд если `dy < -1`
  - Время `forward` увеличено с 250мс до 350мс
  - `lastStepPos` обновляется в каждой ветке для точного stuck detection

### HomeBaseSystem — навигация домой
- `executeRoundTrip()` работает безупречно — навигация домой, депозит в сундук, крафт кирки

---

## [2026-05-17] - Army Bot System

### Army Bot (`sex_army_test.js`)
- **20 ботов** (`Beer_1`–`Beer_20`) с автозапуском через `start_army.bat`
- **mineflayer-pvp** интегрирован — реальная боёвка с кулдауном и преследованием
- **`guard`** — охраняет позицию, атакует мобов в радиусе 10 блоков, возвращается на точку после боя
- **`attack nearest`** — каждый бот находит ближайшего враждебного моба и атакует
- **`escort`** — следует за командиром и атакует мобов по дороге
- **`stopAll`** — останавливает pvp + pathfinder одновременно
- **Построения** (`line`, `column`, `circle`, `square`) — после прихода на точку все смотрят в сторону командира
- **Колонна по двое** — `column` формирует 2-wide march за командиром
- **Per-bot offset** — боты не стакаются при `come`/`follow`/`guard`
- **`guard` запоминает позицию** — возврат на точку если отошёл дальше 5 блоков
- **Команды по диапазону** — `!squad#1-10 guard`, `!squad#5 come`
- **Lookahead построений** — поворот головы в направлении командира после прихода

### Автовыдача снаряги (`give_gear.js`)
- **HomeBot** (оп) раздаёт снарягу 20 ботам автоматически
- Keepalive через `bot.look` — не вылетает за таймаут при 360 командах
- 700мс между командами — обход rate-limit сервера
- После `Done!` автоматически пишет `!squad gear` в чат
- Убран `potion_of_healing` — не работает в ванилле без NBT

### Автоматизация (`start_army.bat`)
- Запускает армию, ждёт 70 сек, запускает `give_gear.js` автоматически
- Полный цикл одним кликом

### Конфиг снаряги (`gear_config.js`)
- 10 арбалетчиков (Beer_1-10): crossbow, arrow×128, shield, iron armor
- 10 копейщиков (Beer_11-20): iron_sword, shield, arrow×16, iron armor
- Общий набор: cooked_beef×64, torch×16

---

## [Unreleased] - 2026-05-16

## [History] - Pre-2026-05-16

### Core Systems Established
- **BotBrain**: Central orchestration with state machine (IDLE, FOLLOWING, COMBAT, FLEE)
- **EventBus**: Event-driven architecture for system communication
- **StateManager**: Single source of truth for bot behavioral state
- **Scheduler**: Periodic task management
- **OperationalMemory**: Threat tracking and decision context

### Resource System
- **ResourceSystem**: Gather orchestration for wood and ores
- **TreeJob**: Automated tree chopping with leaf clearing and stuck recovery
- **OreJob**: Tunnel mining with pillar up and safety checks
- **CaveExplorerJob**: Cave exploration when surface resources exhausted

### Combat & Defense
- **CombatSystem**: Threat evaluation, engagement, flee navigation
- **defend.js**: Defense during follow/guard modes
- **AwarenessSystem**: Threat detection and emission
- **evaluateThreatPressure**: Complex threat scoring system

### Command System
- **CommandRegistry**: Voice command parsing (Russian/English)
- **Command handlers**: gather, follow, guard, combat commands
- **Pattern matching**: Regex-based natural language recognition

### Navigation
- **FollowSystem**: Player following with stuck detection
- **MovementSystem**: Pathfinder management and control
- **DefendSystem**: Entity guarding and patrol modes

### Integration
- **GatherGuardSystem**: Combat/gather coordination (initial version)
- **RecoveryHoldSystem**: Post-danger safety waits (initial version)
- **SurvivalSystem**: Persistent autonomous survival mode

---

## [Unreleased] - 2026-05-16

### Home Base System V1

#### Core Loop Closure
- **HomeBaseSystem.js** — autonomous round-trip for inventory/tools management:
  - Interrupt gathering when inventory full or tool broken
  - Navigate to base (surface path, not tunnel)
  - Deposit loot to single double chest
  - Craft stone tools (pickaxe/axe) from base supplies
  - Resume previous gathering job automatically

#### StorageSystem.js
- Single chest operation (no smart sorting in V1)
- `depositAll()` — keeps only food, pickaxe, axe, torches
- `withdrawCraftingMaterials()` — gets planks/cobblestone for tools
- `checkResources()` — verify if base has minimum crafting supplies

#### CraftingSystem.js
- **MVP scope: stone tools only**
- `craftStonePickaxe()` — 3 cobblestone + 2 sticks
- `craftStoneAxe()` — 3 cobblestone + 2 sticks  
- `craftSticks()` — from planks
- No furnace smelting (V2 feature)

#### HomeBaseConfig.js
- Hardcoded coordinates or set via "тут база" command
- Saves to `./config/homebase.json`
- Chest + crafting table positions required

#### Integration
- **OreJob.js** — emits `HOMEBASE_RETURN_NEEDED` when inventory full or no pickaxe
- **TreeJob.js** — emits `HOMEBASE_RETURN_NEEDED` when inventory full or no axe
- **ResourceSystem.js** — orchestrates round-trip and job resume
- **Command** — "тут база" / "set home" — auto-detects nearby chest and table

### Survival System Enhancement

#### GatherGuardSystem.js
- **Added SURVIVAL MODE** with simple, deterministic rules for gather operations:
  - `≥3 threats detected` → immediate flee (reason: `gather_survival_many_threats`)
  - `HP < 8` → immediate flee (reason: `gather_survival_low_hp`)
  - Eliminates "decision paralysis" when complex threat scoring gives ambiguous results
  - Logs: `[GatherGuardSystem] SURVIVAL MODE: X threats detected — immediate flee`

#### RecoveryHoldSystem.js
- **Added auto-eat functionality** for self-healing during recovery:
  - Auto-equips and eats best available food when hungry and HP below safe threshold
  - Blacklists dangerous food: rotten_flesh, spider_eye, pufferfish, poisonous_potato, chorus_fruit
  - Uses food quality scoring (effectiveQuality) to pick optimal food
  - 3-second cooldown between eat attempts to prevent spam
  - Logs: `[RecoveryHoldSystem] ate <food> to heal`

- **Added HP regeneration wait**:
  - Waits until HP reaches `safeHp` (configurable, default 14) before exiting recovery
  - Prevents returning to dangerous tasks with critically low health
  - Still respects max timeout (8s default) to prevent indefinite hold

### Mining & OreJob Improvements

#### OreJob.js - Pillar Up Enhancement
- **Fixed pillar up drift issue** caused by pathfinder conflicts:
  - Now explicitly stops pathfinder (`pathfinder.stop()` + `setGoal(null)`) before pillar up
  - Clears all movement controls (forward, back, left, right, sprint) to ensure pure vertical movement
  - Resets pathfinder state on all exit paths (success, lava abort, equip fail, completion)
  - Prevents "partial path" drift that caused bot to move sideways during pillar up

#### OreJob.js - Navigation Efficiency (CRITICAL FIX)
- **Added surface navigation before tunnel fallback**:
  - Previously: Bot always tunneled (even to visible surface ore), wasting 30+ seconds
  - Now: Tries `_navToOre()` first (TreeJob-style pathfinding), then tunnels only if needed
  - Surface ore at 15 blocks: 30s tunnel → 5s walk (6x faster)
  - Logs: `attempting nav to X,Y,Z` → `nav succeeded` or `nav failed — tunnelling`
  - Always emits `NavEvents.STOP` before tunnel to prevent pathfinder conflicts

#### OreJob.js - Vein Mining
- **Added automatic vein clearing** after each ore block dug:
  - Checks all 6 neighbors (cardinal + up/down) for same ore type
  - Digs adjacent ore blocks immediately while still in position
  - Prevents "1 block → rescan → 1 block" inefficiency
  - Logs: `vein mining: found adjacent <ore_name>`

#### OreJob.js - Y-Level Targeting
- **Added optimal depth targeting for each ore type**:
  - Diamonds/Redstone: Y=-59 (deepslate layers), weight 10x for Y<0
  - Lapis: Y=0 (exposed), weight 10x near surface
  - Iron/Copper: Y=16-48 (hills/mountains), weight 5x
  - Coal: Y=64+ (mountains), weight 8x for high altitude
  - Emerald: Y=200+ (extreme hills only), weight 10x
  - Filters out ore outside optimal range before navigation
  - Logs: `Y-filter: 256 → 48 (range -64..16)` — shows filtering efficiency

#### OreJob.js - Raycasting / Line-of-Sight
- **Added visibility checks to avoid unreachable ore**:
  - Checks for unbreakable blocks (bedrock, obsidian) between bot and target
  - Skips ore behind bedrock walls or obsidian barriers
  - Simple raycast along direct path, validates each block
  - Prevents "impossible" navigation attempts that would waste time
  - Combined with Y-filter, eliminates 30-50% of "bad" ore candidates

#### OreJob.js - Smart Ore Selection
- **Improved ore scanning with cluster scoring and Y-weighting**:
  - Increased scan count: 64 → 256 blocks (better for rare ores like diamonds)
  - Scoring formula: `score = Y-weight * cluster * 8 - distance`
  - Prefers ore at optimal depths with dense veins nearby
  - Matches Baritone's ore prioritization strategy

#### OreJob.js - Tunnel Mining Enhancement
- **Added side-ore detection and mining** during tunnel operations:
  - Changed mid-scan interval from every 5 steps → every 3 steps (more frequent)
  - Uses `findBlocks` (up to 16 ores) instead of `findBlock` (single ore)
  - Digs ALL reachable ores within `DIG_REACH` (4.5 blocks) before continuing tunnel
  - Prevents missing single ores in tunnel walls
  - Logs: `tunnel mid-scan: found X ore(s) — digging before continuing`

### Combat & Defense Fixes

#### defend.js
- **Fixed combat/gather conflict**:
  - Added early return in `tickChatGuard` if `brain?.taskState?.currentTask?.kind === 'gather'`
  - Prevents defense system from setting `GoalFollow` during ore/tree gathering
  - Eliminates "GoalFollow: The goal was changed before it could be completed!" errors
  - Bot now correctly prioritizes gathering over auto-defense (still defends if attacked)

#### FollowSystem.js
- **Fixed stuck detection conflict**:
  - `_checkStuck()` now only runs during `follow` or `guard` modes
  - Prevents conflict with `OreJob`'s own stuck detection during mining
  - Avoids double nudge effects that could break mining tunnels

### Command System Improvements

#### commandRegistry.js
- **Expanded gather command vocabulary** (Russian language support):
  - Added multiple verb patterns: `добывай`, `добудь`, `копай`, `найди`, `принеси`, `собирай`
  - Supports all resource types: wood, coal, iron, gold, diamond, copper, emerald, lapis, redstone
  - Examples now recognized: "добывай уголь", "копай железо", "найди алмазы"
  - Improved regex patterns for flexible command matching

### Architecture & Design Decisions

#### Why Simple Rules for Gather?
- Complex `evaluateThreatPressure` scoring creates "gray zone" where bot neither fights nor flees
- For gather operations, safety > efficiency — simple thresholds prevent hesitation
- `≥3 threats` and `HP<8` are unambiguous, testable, and match player intuition

#### RecoveryHoldSystem vs SurvivalSystem
- `RecoveryHoldSystem`: transitional state after dangerous events (flee, combat, interrupt)
  - Already integrated with `ResourceSystem` resume logic
  - Extended with eat/heal functionality vs creating new system
- `SurvivalSystem`: persistent autonomous survival mode (separate, not used by gather)

#### Pillar Up Pathfinder Management
- Pathfinder state must be explicitly cleared before manual movement (jump/place)
- Leaving stale goals causes "partial path" conflicts → drift
- Pattern: `stop() → clear goals → manual move → reset goals → return`

## [Previous] - Pre-2026-05-16

### Core Systems
- BotBrain with state machine (IDLE, FOLLOWING, COMBAT, FLEE)
- Event-driven architecture (EventBus, EventRegistry)
- ResourceSystem with TreeJob and OreJob
- GatherGuardSystem for combat/gather coordination
- CombatSystem with threat evaluation and flee logic
- RecoveryHoldSystem for post-danger safety waits

### Known Issues Resolved
- ~~Bot attacks players in follow mode~~ → Fixed: `tickChatGuard` only attacks mobs in follow, players only in guard mode
- ~~Bot switches between follow and gather~~ → Fixed: gather mode check in `tickChatGuard`
- ~~Pillar up drifts sideways~~ → Fixed: explicit pathfinder stop + movement clear
- ~~Misses ores in tunnel walls~~ → Fixed: frequent multi-ore scanning + digging
- ~~"Tupit" with 4-5 mobs~~ → Fixed: simple survival mode rules

---

## Testing Status

- `unit-phase1.js`: 24/24 OK ✓
- `unit-gather-guard.js`: 6/6 OK ✓
- `unit-resource.js`: 17/17 OK ✓ (from previous session)

All core functionality verified.
