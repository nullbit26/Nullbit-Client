# Документация: движение, pathfinder и патчи

Краткое описание изменений относительно монолитного `legacy/bot.js`, целей (чего добились) и списка патчей к зависимостям.

Статус: **ACTIVE SOURCE OF TRUTH** для movement/pathfinder-области (с учётом frozen movement policy).

---

## 1. Архитектура приложения

Монолит вынесен в `legacy/bot.js`. Рабочая точка входа — **`index.js`**, модули CommonJS с **инъекцией `bot`** в фабрики (`createUtils(bot)`, `createMovementActions(bot, deps)` и т.д.).

Основные файлы:

| Файл | Назначение |
|------|------------|
| `config.js` | Настройки из `process.env`, таймауты pathfinder, follow/stuck, политика копания |
| `state.js` | Общий runtime-state, `resetStuckState(bot)` |
| `utils.js` | `log`, `debugLog`, `getPlayerEntity`, `getFrontBlock`, `getFeetBlock` |
| `ai.js` | LLM + intent tools, `parseCommand`-совместимость через command-router, `getBotContext` |
| `actions/movement.js` | Pathfinder, режимы follow/come/idle, repath, anti-stuck, барьерная копка |
| `actions/combat.js` | Guard + PvP |
| `actions/craft.js` | `craftGear` |
| `events.js` | `bindBotEvents(bot, deps)` — spawn, physicsTick, chat, `path_update` |
| `index.js` | `createBot`, плагины, wiring DI, `dotenv`, SIGINT |
| `nav-movements.js` | Расширение `Movements`: опционально только осевые соседи A* |
| `natural-dig-policy.js` | Whitelist природных блоков для копки + blacklist остальных diggable |
| `physics-compat.js` | Подгонка hitbox (+N к width/height), см. issue #223 |

---

## 2. Чего добились (поведение)

1. **Убран конфликт с `@nxg-org/mineflayer-auto-jump`**  
   Плагин удалён из зависимостей и кода. Управление прыжком/бегом остаётся у **mineflayer-pathfinder**, без второго «мозга» на пробел.

2. **Исправлен баг sprint-jump в pathfinder 2.4.5**  
   Раньше ветка `canStraightLine(path, true)` шла **раньше** `canSprintJump(path)`, из‑за чего бот почти не переходил в режим **sprint + jump** для препятствий. После патча порядок проверок исправлен (см. раздел «Патчи»).

3. **Не сбрасываем `jump` поверх pathfinder**  
   В `events.js` убран код, который на каждом `physicsTick` принудительно ставил `jump` в `false` — он выполнялся **после** pathfinder и отменял нормальный sprint-jump.

4. **Подгонка hitbox под сервер / лаги**  
   По мотивам [mineflayer-pathfinder #223](https://github.com/PrismarineJS/mineflayer-pathfinder/issues/223): опционально увеличиваются `bot.entity.width` и `height` на `config.physicsHitboxInflate` (по умолчанию 0.05, env `PHYS_HITBOX_INFLATE`).

5. **Обход препятствий и реже «упор в блок»**  
   - Опция **`PATH_CARDINAL_ONLY=1`**: класс `NavMovements` отключает **диагональные** шаги в `getNeighbors` — меньше спорных диагоналей у стен/деревьев (см. [issue #310](https://github.com/PrismarineJS/mineflayer-pathfinder/issues/310)).  
   - Увеличены **`thinkTimeout` / `tickTimeout`** pathfinder и чаще обновляется цель follow — дольше ищется обход, чаще пересчитывается маршрут.  
   - На **`path_update`** с `noPath` / `timeout` — повторная публикация цели (с кулдауном).

6. **Сначала обход, затем прокладка через сырой ландшафт**  
   - При **`PATH_DIG_NATURAL` ≠ `0`**: `movement.canDig = true`, **`digCost`** по умолчанию высокий — A* **сначала** ищет длинный обход.  
   - В **`blocksCantBreak`** — все копаемые блоки **кроме** whitelist **`natural-dig-policy.js`** (`isPathBreakAllowed`): дерево (брёвна, листва, лианы), **земля, камень, гравий, песок, deepslate, netherrack**, терракота без глазури, цементный порошок и т.д. **Не** руду, кирпичи/плитки, доски, медные блоки, обсидиан, спавнеры.  
   - **`pathThinkTimeoutMs`** по умолчанию увеличен — больше шансов найти **большой** обход до таймаута.  
   - **Anti-stuck**: быстрый repath + при необходимости **ручная** копка по тому же whitelist (в т.ч. камень/земля).  
   - **Углы / edge без `isCollidedHorizontally`**: «почти нет прогресса» + низкая гориз. скорость при активном пути; **`tickPathStallEscape`** на каждом `physicsTick` — если `isMoving()` и смещение меньше ~0.11 блока **PATH_STALL_ESCAPE_TICKS** тиков подряд → repath + проба копки (см. обсуждения pathfinder #157, #223).

7. **Инициализация pathfinder**  
   Таймауты `thinkTimeout` / `tickTimeout` выставляются в **`bot.once('inject_allowed', ...)`**, потому что до этого события `bot.pathfinder` ещё не создан (`loadPlugin` только ставит плагин в очередь).

8. **Прочее**  
   - `dotenv`, ключи API в `.env`, `.gitignore` для `.env`.  
   - `legacy/bot.js` — резервная копия монолита.  
   - `npm run smoke:di` — smoke-тест графа DI без подключения к серверу.

---

## 3. Патчи к зависимостям (npm / patch-package)

### 3.1. `mineflayer-pathfinder@2.4.5` — sprint-jump (логика PR #338)

**Файл патча:** `patches/mineflayer-pathfinder+2.4.5.patch`

**Суть:** в `node_modules/mineflayer-pathfinder/index.js`, внутри цикла движения по пути, переставлен порядок веток `if / else if`:

- **Было:** сначала `allowSprinting && physics.canStraightLine(path, true)` (sprint без прыжка), потом `canSprintJump`.
- **Стало:** сначала **`canSprintJump`**, потом **`canStraightLine(path, true)`**.

**Зачем:** если прыжок с разбегом возможен, он совместим с «прямой линией»; старый порядок почти никогда не доходил до sprint-jump.

**Применение:** скрипт **`postinstall": "patch-package"`** в `package.json` — после каждого `npm install` патч накатывается автоматически.

**Важно:** для **генерации** новых патчей `patch-package` обычно нужен **git** в PATH; файл в `patches/` уже закоммичен вручную и применяется без git.

### 3.2. Другие пакеты

Отдельных патчей к `mineflayer`, `prismarine-physics` и т.д. **нет** — правки только в нашем коде + один патч к pathfinder.

---

## 4. Переменные окружения (основные)

| Переменная | Смысл |
|------------|--------|
| `PATH_CARDINAL_ONLY=1` | Только осевые соседи в A* (`NavMovements`) |
| `PATH_THINK_TIMEOUT_MS` / `PATH_TICK_TIMEOUT_MS` | Лимиты поиска пути |
| `PATH_DIG_NATURAL=0` | Отключить плановое копание природы pathfinder’ом |
| `PATH_DIG_NATURAL_COST` | Стоимость копки в A* (**выше** — охотнее **обход**; **ниже** — охотнее **рубить**) |
| `PATH_REPATH_AFTER_STUCK_MS` | Задержка перед repath на шаге 1 anti-stuck |
| `PATH_FAST_BARRIER_AFTER_REPATH_MS` | После repath: пауза (мс), затем проба барьерной копки без второго длинного цикла; `0` — выкл. |
| `STUCK_CHECK_TICKS` | Период проверки залипания (меньше — чаще) |
| `PATH_MINE_BARRIER_ON_STUCK=0` или `PATH_MINE_VEG_ON_STUCK=0` | Выключить ручную копку барьера при залипании |
| `PATH_REPUBLISH_ON_FAILURE=0` | Не пере-публиковать цель на `noPath`/`timeout` |
| `FOLLOW_REFRESH_TICKS`, `MIN_FOLLOW_REPATH_DISTANCE` | Частота обновления `GoalFollow` |
| `STUCK_CHECK_TICKS`, `MAX_STUCK_BEFORE_NUDGE` | Anti-stuck |
| `PHYS_HITBOX_INFLATE` | 0 = выключить подгон hitbox |

Полный список см. в **`config.js`**.

---

## 5. Известные ограничения

- Pathfinder и физика **клиентские**; при сильном desync с сервером (VPN, античит) возможны редкие залипания — смягчаются hitbox, repath, ручная копка листвы.  
- Копание **только** по whitelist природы + ручной барьер; чужие постройки из досок не должны ломаться этой логикой.
- Ручной барьер (`tryMineBarrierAhead`) выбирает блок по **`barrierBreakPriority`** в `natural-dig-policy.js`: бревно / ствол / камень / земля **выше**, чем декоративная трава и цветы (раньше трава могла «перебить» лог из‑за неверного score — визуально бот у дерева, в логе `short_grass`).

---

*Документ отражает состояние репозитория на момент последних правок по движению и pathfinder.*
