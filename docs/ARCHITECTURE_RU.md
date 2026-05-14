# Архитектура AI_Bot (Mineflayer)

Документ самодостаточен: описывает основные модули, порядок запуска и потоки событий, чтобы другой ассистент или разработчик мог быстро оценить узкие места, дублирование логики и направления улучшений без доступа к истории чатов.

Статус: **ACTIVE (HIGH-LEVEL)**. Для продуктовой командной поверхности см. `docs/COMMAND_SYSTEM_CURRENT.md`.

---

## 1. Точки входа и порядок загрузки

1. **`index.js`** — загрузка `ConfigManager` из `.env`, затем `require('./startBot').start()`.
2. **`startBot.js`** — основной «композиционный корень» сессии:
   - `mineflayer.createBot(...)`;
   - `bot.loadPlugin(pathfinder)`;
   - в `inject_allowed` — таймауты pathfinder, `Movements`, опасные блоки, `blockUpdate` для пересчёта цели;
   - `createUtils(bot)`;
   - **`new BotBrain(bot, { config, utils, navigation: true })`**;
   - **`PartyIFFSystem`**: `partyIFF = new PartyIFFSystem({ bot, config, brain })`, присвоение **`brain.partyIFF`** и **`bot.partyIFF`**, вызов **`partyIFF.init()`** (подписка на `whisper` для party-команд в личке);
   - **`createMovementActions`**, **`createDefend`** (передаются `voice`, `eventBus`, `NavEvents`, `getCoreState`, **`brain`** и т.д.);
   - **`createCombatActions`**, **`createCraftActions`**, **`createAI`** (`ai.js` → `systems/AIIntentSystem.js`, в `deps` передаётся `brain`);
   - **`brain.attachAwarenessSystem({...})`** — сканирование, ИИ, брифинг;
   - **`brain.attachGameplaySystems({ bot, config, state, utils, movementActions, combatActions, defend, reconnect })`** — Follow, Combat, Defend, Recovery;
   - **`wireBrainGameplayListeners`** — прямые подписки на `GameplayEvents` (крафт, полёт);
   - **`bindBotEvents(bot, deps)`** — физика, чат, движение, `partyIFF` в `onChat`; в **`deps`** передаётся **`brain`** (сброс боя/FLEE и памяти на **`spawn`** в `handleSpawn`, см. §7);
   - на **`end`**: `brain.destroy('bot_end')`;
   - на **`spawn`**: сброс reconnect, **`brain.init()`**, при наличии **`bot.voiceChat.connect()`**, стартовая фраза через **`brain.voice.speak`**.

Итого: бот и pathfinder создаются первыми, затем мозг, IFF на бот+мозг, defend/movement/combat/craft, ИИ с `pushIntent`, осведомлённость, игровые системы, обработчики событий, инициализация мозга и голоса на спавне.

---

## 2. BotBrain (`core/BotBrain.js`)

**Компоненты конструктора (в порядке создания):**

| Компонент | Назначение |
|-----------|------------|
| `EventBus` | строгий реестр имён событий (`EventRegistry`) |
| `StateManager` | FSM: `IDLE`, `FOLLOWING`, `COMBAT`, `FLEE` |
| `Scheduler` | периодические задачи на тиках бота |
| `OperationalMemory` | снимок окружения, угрозы, память агрессоров, follow-target |
| `VoiceSystem` (если есть `config` + `utils`) | Silero + опционально SVC UDP; наружу **`brain.voice`** |
| `NavigationController` (если не отключён) | обработка `nav:*` |
| Системы `attachAwarenessSystem` / `attachGameplaySystems` | подключаются позже |

**`init()` (порядок):** лог шины → `voiceSystem` → `recoverySystem` → `navigation` → `awarenessSystem` → `defendSystem` → `followSystem` → `combatSystem` → `core:brain_ready`.

**`destroy(reason)` (порядок):** `core:brain_shutdown` → отключение лога шины → **`partyIFF.destroy`** → `combatSystem` → `followSystem` → `defendSystem` → `awarenessSystem` → `recoverySystem` → `navigation` → `voiceSystem` → `scheduler.destroy` → `removeAllListeners` на шине.

**PartyIFF** создаётся и **`init()`** вызывается в **`startBot.js`** (до первого `brain.init()` на спавне); уничтожение идёт через **`BotBrain.destroy`**.

---

## 3. EventRegistry и IntentTypes

- **`core/EventRegistry.js`** — канонические строки событий и JSDoc-типы полезной нагрузки: `CoreEvents`, `NavEvents`, `AwarenessEvents`, `VoiceEvents`, `MovementEvents`, `GameplayEvents`, `CombatEvents`, `DefendEvents`, `IntentEvents`.
- **`core/IntentTypes.js`** — строки `type` для очереди намерений в `BotBrain.pushIntent` / инструментов ассистента в **`AIIntentSystem`**.

**Важно:** в реестре объявлено **`CombatEvents.SET_GUARD`** (`combat:set_guard`), в **`IntentTypes`** есть **`COMBAT_SET_GUARD`**, и теперь в **`BotBrain._dispatchIntent`** есть ветка `case IntentTypes.COMBAT_SET_GUARD` с эмитом `CombatEvents.SET_GUARD`.

---

## 4. Таблица `systems/*`

| Система | Роль | Ключевые события / входы |
|---------|------|---------------------------|
| **AwarenessSystem** | Быстрый/фоновый скан, обновление `OperationalMemory`, предупреждения, `entityHurt` / `entityDead` | Шина: `awareness:threat_detected`, `damaged`, `player_death_nearby`, `premium_loot`; тики через `Scheduler`; mineflayer: `entityHurt`, `entityDead`, `spawn`/`end`. На **`entityDead`** для **не-игрока** запись с этим **`entity.id`** удаляется из **`currentThreats`** (чтобы мёртвые мобы не висели в памяти угроз). |
| **FollowSystem** | Follow / come / idle / guard через шину; при follow+guard — `nav:goto` и `state.navFollowViaBus` | `movement:set_follow`, `set_come`, `set_idle`; **`combat:set_guard`** → `combatActions.setModeGuard`; периодический тик |
| **CombatSystem** | Мост `combat:engage_entity` / `stop_attack` → `attackEntity` / `stopAttack` (в payload **`ENGAGE_ENTITY`** опционально **`entityId`** — приоритетный резолв цели из чат-команды **`attack_direct`**); оркестрация **FLEE** (`nav:goto`, фазы, sticky plan, pressure, hysteresis выхода); хил в FLEE через **`combat/flee/HealController.js`** (см. **§6.1**) | `CombatEvents.*`, `NavEvents.*`, слушатель здоровья бота, `CoreStates` |
| **DefendSystem** | Тонкая обвязка: события шины → вызовы **`defend.js`** | `defend:patrol_mode`, `defend_point`, `defend_entity`, `stop_all` |
| **RecoverySystem** | Результаты пути, `nav:recovery` → застревание / backoff dig; авто-reconnect на `end` | `nav:path_result`, `nav:recovery`, `nav:stuck` (эмит после recovery), `bot` `end` |
| **VoiceSystem** | TTS и UDP SVC по конфигу | `voice:speak`, `voice:stop` |
| **PartyIFFSystem** | Список пати, IFF мобов/игроков, временная враждебность по урону, команды party | Не центральный bus для IFF: **`bot.partyIFF`**, вызовы из Awareness / defend / combat; **`whisper`** + публичный чат через **`tryHandleChatCommand`** из `events.js` |
| **AIIntentSystem** (`createAI`) | Ассистент / NVIDIA; **инструменты** → `brain.pushIntent` | Зависит от `deps.brain` |

---

## 4.1 Источники истины по областям

- **Командная поверхность (парсинг/диспетчер/delivery/policy):** `docs/COMMAND_SYSTEM_CURRENT.md`.
- **High-level архитектура и порядок инициализации:** этот документ (`ARCHITECTURE_RU.md`).
- **Движение/pathfinder frozen-stack:** `docs/PATHFINDER_AND_MOVEMENT.md` + `.cursor/rules/frozen-movement.mdc`.
- **Исторический аудит командной системы:** `docs/COMMAND_SYSTEM_AUDIT.md` (артефакт, не текущая спецификация).

---

## 5. `defend.js` и `DefendSystem`

- **`defend.js`** — фактическая логика точки/сущности/патруля, pathfinder-цели, вызов **`attackEntity`** / **`findThreat`**, интеграция с **`state`** и (через контекст создания) с шиной для навигации в COMBAT/FLEE.
- **`systems/DefendSystem.js`** — только подписки на **`DefendEvents`** и делегирование в объект **`createDefend`**.

**Патруль:** по умолчанию выключён: **`config.defendPatrolEnabled`** = `PATROL_ENABLED=1` **или** `DEFEND_PATROL_ENABLED=1`. Без этого `patrolMode` и patrol-ноги у defend-point логируются как пропущенные. В **`AIIntentSystem`** при вызове инструмента patrol без флага возвращается подсказка включить `PATROL_ENABLED`.

**Точка / сущность:** публичные команды проходят parse -> dispatch -> `commands/handlers/defend` и уже оттуда вызывают **`defend.defendEntity` / `defend.defendPoint`**; через шину — **`DefendSystem`** из намерений ассистента.

**`findThreat`:** использует **`bot.partyIFF`**: для игроков предпочтительно **`isDefenseThreatEntity`** (не пати, эффективный HOSTILE); иначе fallback на **`isPartyUsername`**.

---

## 6. `attackEntity.js`: сессия боя

- Эксклюзивность/активность боя хранится в **`combat/session/sessionFlags.js`** (`tryEnterCombatExclusive`, `register/unregisterCombatSession`, `getCombatSessionActive`, lifecycle signal `onCombatSessionActiveChanged`).
- **`isCombatSessionActive()`** из `attackEntity.js` — публичный фасад для систем (**`CombatSystem`**, **`events.js`**, **`defend.js`**, command hooks), чтобы не конкурировать за pathfinder во время боя/FLEE.
- **`CombatSystem`** переводит состояние в **`COMBAT`**, вызывает **`attackEntity`**; при входе в **`FLEE`** — остановка боя, **`nav:goto`** от угрозы, периодический **`_fleeTick`**. Нормативное описание побега, хила, давления угроз и выхода из FLEE — **§6.1** (не дублировать здесь устаревшие условия «только по дистанции»).

**Инвариант:** FSM `FLEE` и session lifecycle могут кратко расходиться; готовность команд и command policy завязаны на session lifecycle, а не только на `CoreStates`.

### 6.1 FLEE и retreat: оркестрация (источник истины по поведению)

Вся логика принятия решений в FLEE живёт в **`systems/CombatSystem.js`**. Движение по-прежнему только через шину **`NavEvents.GOTO`** / **`STOP`** и существующий navigation stack — **pathfinder / movement не рефакторятся** (см. §11).

**Модули `combat/flee/` (только policy, без своего pathfinding):**

| Файл | Назначение |
|------|------------|
| **`combat/flee/HealController.js`** | Одна активная попытка consume за раз; окно безопасности по тикам (`combatFleeHealSafeWindowTicks`); задержка после последнего flee-nav (`combatFleeHealAfterNavDelayMs`); backoff/cooldown после успеха/фейла; при фейле в FLEE — повторная эмиссия случайной flee-цели. |
| **`combat/flee/evaluateThreatPressure.js`** | Сводка по **`memory.getCurrentThreats()`** и **`memory.getActiveThreatMemory()`**: дистанция до ближайшей угрозы, число близких угроз, `immediateDangerScore`, `recentAggroScore`, `combinedPressure`, флаги **`healWindowSafe`**, **`safeToRecover`**, **`safeToExitFlee`**, **`retreatScore`** / **`shouldEnterFleeByRisk`**. **`lastAttacker`** в расчёт давления **не** входит (семантика поля — см. §8). |

**Вход в FLEE (`_onHealth`):**

- Жёсткий порог HP: **`shouldFleeByHp`** (`combatFleeCriticalHp`, `combatFleeCriticalRatio`) — как раньше.
- Дополнительно (если не выключено **`COMBAT_FLEE_RETREAT_SCORE=0`**): **`shouldEnterFleeByRisk`** — `retreatScore` ≥ **`combatFleeRetreatScoreThreshold`** при активной сессии боя, плюс опционально только если **`HP/maxHealth ≤ combatFleeRetreatRiskHpRatioMax`** (по умолчанию **0.94**; **`COMBAT_FLEE_RETREAT_HP_RATIO_MAX=1`** — отключить порог). Это не «экстренный» отдельный канал: тот же `health`, тот же `CombatSystem`.

**Фазы внутри FLEE:** `BREAK_CONTACT` → `STABILIZE` → `RECOVER` (см. `combatFleeBreakContactBlocks`, `combatFleeStabilizeMinMs`, `combatFleeRecoverThreatBlocks`). В **`BREAK_CONTACT`** лечение не стартует; навигация смещена в сторону быстрого отрыва (в т.ч. random goal).

**Sticky flee plan:** объект плана с полями **`planId`**, **`createdAt`**, **`goal`**, **`phaseAtCreate`**, **`reason`**, плюс **`startNearest`** для оценки прогресса. Повторная эмиссия того же **`goal`** вместо постоянной перегенерации цели; replan только с явным **`reason`** в логах: **`no_path`**, **`timeout`**, **`pressure_spike`**, **`distance_collapse`**, **`plan_ttl_exceeded`**. Конфиг: **`combatFleePlanHoldMs`**, **`combatFleePlanMaxMs`**, **`combatFleePlanMinReplanMs`**, **`combatFleeEmergencyReplanDistance`**, **`combatFleePressureSpikeDelta`**. При **`_enterFlee`** в **`_lastCombinedPressure`** записывается текущий **`combinedPressure`**, чтобы не было ложного spike на первом тике после нулевого baseline.

**Выход из FLEE / реэнгейдж:** требуется непрерывное удержание предпосылок выхода не меньше **`combatFleeExitHysteresisMs`** (сброс таймера при потере **`safeToExitFlee`** или иных условий кандидата). В **`_logFleeEndDecision`** для `hp_safe` / `no_heal_items_min_time_or_clear` добавляются **`exitHysteresisMs`**, **`exitStableMs`**. Жёсткие выходы (**watchdog**, **`max_flee_time`**, **`stop_attack`**) hysteresis **не** используют.

**Лечение в FLEE:** `HealController` получает «безопасные» тики через **`pressure.healWindowSafe`** (учёт дистанции и свежести агро из **`evaluateThreatPressure`**); фаза **`BREAK_CONTACT`** лечение блокирует.

**Основные переменные окружения (неполный список):** `COMBAT_FLEE_HEAL_SAFE_BLOCKS`, `COMBAT_FLEE_CLEAR_THREAT_BLOCKS`, `COMBAT_FLEE_EXIT_HYSTERESIS_MS`, `COMBAT_FLEE_PLAN_HOLD_MS`, `COMBAT_FLEE_PLAN_MAX_MS`, `COMBAT_FLEE_PLAN_MIN_REPLAN_MS`, `COMBAT_FLEE_EMERGENCY_REPLAN_DISTANCE`, `COMBAT_FLEE_RETREAT_SCORE`, `COMBAT_FLEE_RETREAT_SCORE_THRESHOLD`, `COMBAT_FLEE_RETREAT_HP_RATIO_MAX`, `COMBAT_FLEE_PRESSURE_SPIKE_DELTA`, `COMBAT_FLEE_AGGRO_FRESH_MS`, `COMBAT_FLEE_AGGRO_HORIZON_MS`, `COMBAT_FLEE_EXIT_AGGRO_MAX` и др. — см. **`config.js`**, ключи **`combatFlee*`**.

**Тесты:** `node scripts/unit-threat-pressure.js` (pressure / retreat score); **`npm run smoke:di`** — общая проводка DI.

---

## 7. `events.js`: чат, party, шина vs legacy

- **`onChat`**: фильтр через общий helper **`mayControlBot`** (пати OR `allowedUsers`, пустой список = open), затем parse/dispatch команды.
- Исполнение команд выполняется через **`dispatchCommand`** + `commands/handlers/*` (в т.ч. **`commands/handlers/combat.js`** для **`attack_direct`**); `events.js` не держит switch/case по командам и **не** эмитит боевые события для чата — только маршрутизация.
- Фактический command flow: **queue/busy gate -> mayControlBot -> parsePlayerMessage -> dispatchCommand -> AI fallback (если parse=null)**.
- **`createCommandContext`**: в **`deps`** передаётся **`brain`** — для политики **`attack_direct`** нужны **`getCoreState()`** (гейт **`FLEE`**) и **`defend.isDefendActive()`**; подробности и коды ответов см. **`docs/COMMAND_SYSTEM_CURRENT.md` §7**.
- Режим follow/guard в **`handlePhysicsTick`**: при **`state.navFollowViaBus`** периодический repath идёт через **`NavEvents.GOTO`** на шине; иначе **`repathToTarget`**.
- Defend/party/inventory/misc команды также идут через parse -> dispatch (единый command-router путь).
- **`bindBotEvents(bot, deps)`** принимает **`brain`** в **`deps`**. В **`handleSpawn`** (конец обработчика **`bot.on('spawn', …)`**): вызывается **`brain.combatSystem._endFlee('spawn')`** (снятие подписок FLEE на **`nav:path_result`**, watchdog, periodic flee-task), сброс flee-состояния (**`HealController`**, sticky plan, hysteresis выхода, **`_fleeNavLocked`**, **`_noPathStreak`**, **`_fleeDirectionNx`/`Nz`** и т.д. — см. **`_endFlee`**), очистка **`memory.setCurrentThreats([])`** и **`setLastAttacker(null)`**, при необходимости **`brain.state.transition(CoreStates.IDLE)`**.

---

## 8. OperationalMemory (`memory/OperationalMemory.js`)

- **`nearbyPlayers`** / **`applyScanSnapshot`**: из снимка `scanEnvironment` (игроки, дистанции и пр.).
- **`currentThreats`**: `Map<string, { id, name, distance }>` (ключ = `String(id)`), заполняется **`AwarenessSystem`** из **`PartyIFF.listThreatsWithin`** (HOSTILE + aggro в радиусе). Наружу `getCurrentThreats()` возвращает массив `Array.from(map.values())`.
- **`threatMemory`**: до **16** записей (`MAX_THREAT_ENTRIES`), дедуп по **`entityId`**; TTL по умолчанию **120 с** (`DEFAULT_THREAT_TTL_MS`), если `expiresAt` не задан — **`lastSeenAt + 120_000`**. API: **`recordThreat`**, **`getActiveThreatMemory`**, **`purgeExpiredThreats`**, **`isThreatEntityActive`**.
- **`lastAttacker`**: **не** «кто ударил бота» — это последний **близкий игрок, получивший урон** (социальный/таунт и т.п.): **`setLastAttacker` / `getLastAttacker`**. Для **`computeFleeGoal` / FLEE** эта запись **не** используется как «вектор от врага» (раньше ошибочно могла тянуть бота к союзнику).
- **`followTarget`**: снимок цели follow/guard из **`FollowSystem`** (`username`, координаты, `mode`, `at`).
- **`hazards`**, **`lastScanSnapshot`**: расширяемые поля.

---

## 9. PartyIFF (`systems/PartyIFFSystem.js`)

- **Данные:** основной файл **`data/party.json`** (`{ party: string[] }`); при отсутствии — миграция из **`data/combat-friends-chat.json`** + **`config.partySeedUsers`** (env: `PARTY`, `COMBAT_FRIENDS`, `BOT_FRIENDS`).
- **Команды:** `party` / `friend` + `add|remove|list|clear` — в публичном чате и в **`whisper`** с тем же правилом доступа **`mayControlBot`** (без отдельной whisper-ветки прав).
- **IFF:** уровни **`FRIEND` | `NEUTRAL` | `PROVOKABLE` | `HOSTILE`**; база по типу сущности, пати-игрокам, спискам мобов; пауки зависят от освещённости.
- **`markAggroFromDamage(victim, attacker)`**: если пострадал «наш» бот / пати-игрок / дружелюбный моб — в **`OperationalMemory.recordThreat`** (или fallback-map без brain) на **120 с** (`AGGRO_TTL_MS`); источник урона не из пати.

**`entityHurt`:** подписка **только** в **`AwarenessSystem`** (`_onEntityHurt`). Сначала при наличии `source` вызывается **`partyIFF.markAggroFromDamage`**, затем логика «раненый игрок рядом» / taunt. **`PartyIFFSystem`** сам на **`entityHurt`** **не** вешается — **двойной обработки нет**.

---

## 10. `config.js` и `state.js` (кратко)

- **`config.js`**: подключение к миру (`host`, `port`, `username`, `version`, `auth`, пароль), **`allowedUsers`**, ключи ИИ (OpenAI Assistants, NVIDIA, Anthropic), голос (Silero, SVC UDP, устройства), дистанции follow/guard/come, **`defendPatrolEnabled`**, **`commandAttack*`** (дистанция/epsilon для чат-атаки `attack_direct`, override defend при охране — см. **`docs/COMMAND_SYSTEM_CURRENT.md` §7**), массив тонкой настройки pathfinder / nav-assist / wall-stick / combat flee / reconnect — в основном из **env** с разумными дефолтами.
- **`state.js`**: **`mode`** (`idle|follow|guard|come`), **`targetUsername`**, счётчики тиков, **`navFollowViaBus`**, anti-stuck / recovery / nav-assist / wall-stick поля, reconnect-таймер. **`resetStuckState(bot)`** сбрасывает «застревание» при спавне.

---

## 11. Замороженный стек движения

В репозитории зафиксировано правило **не рефакторить** движение и pathfinder «заодно»: **`actions/movement.js`**, **`mineflayer-pathfinder`**, **`nav-movements.js`**, патчи, anti-stuck / recovery в movement, **`nav-assist.js`**, raycast, обработчики в **`events.js`**, связанные с этим стеком. Подробнее: **`.cursor/rules/frozen-movement.mdc`**. Новые возможности — отдельными модулями и тонким wiring сверху.

---

## 12. Возможные направления улучшений

- **Унифицировать guard:** расширить инструменты ассистента на явный сценарий `COMBAT_SET_GUARD` с `targetUsername` (диспетчер в `BotBrain` уже поддерживает этот intent).
- **Потребители памяти:** явно задокументировать контракт **`lastAttacker`** vs **`threatMemory`** (возможное переименование поля в коде/API для ясности).
- **Чат vs шина:** постепенно свести дублирование прямых вызовов defend и bus-driven путей к одному стилю там, где это безопасно для UX.
- **Тесты:** smoke уже есть (`npm run smoke:di`); unit на давление угроз / retreat score: `node scripts/unit-threat-pressure.js`; unit-тесты на **`OperationalMemory`**, **`PartyIFF.getEffectiveIFF`**, разбор intent-очереди.
- **Документация:** держать этот файл в синхроне с новыми `DefendEvents` / инструментами ассистента.
- **Ошибки:** централизованная политика логирования при сбое `attackEntity` / defend async (сейчас часто `catch` с пустым телом).
- **PartyIFF lifecycle:** явно описать порядок `init` в `startBot` vs `brain.init` для новых подписок на mineflayer.
- **FLEE / defend:** расширить метрики или логи, когда defend откладывает ноги из-за COMBAT/FLEE/session (уже частично в комментариях `DefendSystem`).
- **Строгая шина:** при полном отказе от legacy-веток в `events.js` упростить ветвление `if (eventBus)`.

---

## 13. Подтверждённые изменения после запуска проекта

**Актуальное поведение FLEE / retreat / хила в бою** задокументировано в **§6.1**; ниже — в основном исторические пометки по эволюции кода.

Ниже перечислены правки, проверенные в рабочем цикле и давшие ожидаемое поведение:

- **Race FLEE vs defend устранён:**
  - `CombatSystem._enterFlee()` сначала переводит FSM в `CoreStates.FLEE`, потом останавливает PvP-сессию и только затем шлёт `nav:goto`.
  - в `defend.js` FLEE считается блокирующим состоянием наравне с COMBAT.
  - в циклах `patrolMode` / `defendPoint` / `defendEntity` добавлено ожидание выхода из FLEE через `CoreEvents.STATE_CHANGED` (таймаут 10s, затем `continue`).

- **Intent guard починен:**
  - в `BotBrain._dispatchIntent` добавлен `case IntentTypes.COMBAT_SET_GUARD` с `eventBus.emit(CombatEvents.SET_GUARD, { targetUsername, at })`.

- **FLEE навигация и хил (эволюция → см. §6.1):** ранее развели по времени после `nav:goto` и lock; позже хил вынесен в **`HealController`**, добавлены фазы FLEE, sticky plan, pressure, hysteresis выхода — детали в **§6.1**.

- **FLEE watchdog обновлён:**
  - аварийный таймер застревания FLEE увеличен с 8s до 15s, с форс-переходом в `IDLE`.

- **FLEE goal (`computeFleeGoal`):**
  - направление — **нормализованная сумма взвешенных векторов «от всех угроз»** по позициям из **`currentThreats`** (ближе враг — больший вес);
  - если список пуст — fallback по **`bot.entities`**: живые **`player` / `mob` / `hostile`** в радиусе менее **32** блоков;
  - **fallback по `lastAttacker` убран** — поле описывает союзного/раненого игрока рядом, а не цель для отступления;
  - при смерти **не-игрока** **`AwarenessSystem._onEntityDead`** удаляет его **`id`** из **`currentThreats`** (через `setCurrentThreats` отфильтрованного списка).

- **`OperationalMemory.currentThreats` переведён на Map:**
  - внутренне `Map<string, { id, name, distance }>`; наружу API остаётся массивом (`getCurrentThreats()`).
  - `isThreatEntityActive()` сначала проверяет map по `String(entityId)`, затем fallback на TTL threat-memory.

- **Совместимость зелий с 1.21.11:**
  - в `utils/combatConsumables.js` `potionLooksLikeHeal()` больше не зависит только от `item.nbt`.
  - поддержан fallback через `item.nbtData`; при отсутствии читаемых данных зелья `potion|splash_potion|lingering_potion` считаются лечебными (по принятому контракту инвентаря).

- **Defend не атакует во время FLEE:**
  - `defendEntity` и `tickChatGuard` блокируют запуск атаки, если `getCoreState() === CoreStates.FLEE`.

- **Cooldown FLEE вынесен в `BotBrain`:**
  - в `core/BotBrain.js` добавлены `setFleeCooldown(ms)` и `isFleeCooldown()`.
  - `CombatSystem` больше не хранит собственный `_fleeCooldownUntil`; использует `brain.isFleeCooldown()` / `brain.setFleeCooldown(8000)`.
  - `startBot.js` передаёт `brain` в `createDefend(...)`, а `defend.js` блокирует pathfinder/guard также при активном `brain.isFleeCooldown()`.

- **FLEE noPath-handling усилен:**
  - в `CombatSystem` добавлены `_onNoPath`, `_noPathStreak`, `_emitFleeNavRandom()`.
  - при `nav:path_result` со статусом `noPath` в состоянии FLEE бот снимает nav-lock и выбирает случайную flee-цель.
  - после 3 подряд `noPath` выполняется краткий jump-пинок (400 ms) для выхода из залипания.

- **Watchdog FLEE продлевается от прогресса пути:**
  - добавлен `_onFleeSuccess`, подписка на `NavEvents.PATH_RESULT`.
  - при `status === 'success'` watchdog перезапускается на 8s («no progress window»), иначе действует базовый watchdog 15s.
  - при выходе из FLEE идут отписки и от `_onNoPath`, и от `_onFleeSuccess`.

- **Таймауты pathfinder под FLEE:** при эмиссии flee-цели временно ускоряются (`thinkTimeout=1500`, `tickTimeout=45`); в **`_endFlee`** возвращаются значения из `config` — см. **§6.1** / код `CombatSystem`.

- **Хил в FLEE:** выбор еды/зелья/splash, окна безопасности и backoff — **`HealController`** + поля **`evaluateThreatPressure`** (**§6.1**); исторически хил не дергался вплотную к угрозе без порога дистанции.

- **Дефолты FLEE в `config.js`:** со временем добавлены `combatFleeHealSafeBlocks`, plan/pressure/hysteresis/retreat-score ключи — полный перечень в **`config.js`** и **§6.1**.

---

*Файл в кодировке UTF-8.*
