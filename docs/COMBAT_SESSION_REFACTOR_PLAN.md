# План распила `attackEntity.js` и стабилизации боевой логики

> Status: **PLAN / DESIGN (historical migration notes)**.
> Use `docs/ARCHITECTURE_RU.md` + `docs/COMMAND_SYSTEM_CURRENT.md` for current behavior contracts.

Документ для разработчиков и ИИ-ассистентов: **цель**, **принципы**, **фазы**, **что не трогать**, **как подключать новые механики** без размножения регрессов.

Контекст проекта: Mineflayer-бот, `BotBrain` + шина событий, `CombatSystem` (FLEE / engage), тяжёлая сессия боя в `attackEntity.js`, `defend.js` с pathfinder. Подробнее об архитектуре: `docs/ARCHITECTURE_RU.md`; **текущая спецификация FLEE / retreat** — **`docs/ARCHITECTURE_RU.md` §6.1**.

---

## 1. Проблема

В `attackEntity.js` в одном `setInterval` смешаны:

- **политика** (когда ranged/melee/recover/archer, когда volley, крит, щит);
- **исполнение** (`pathfinder.setGoal`, `equip`, `lookAt`, `activateItem`).

Новая механика обычно добавляет ещё один `if` в тот же тикер. Растёт число **комбинаций состояний** (режим + предмет в руке + дистанция + FLEE/defend снаружи). Легко сломать уже работающую ветку в другом углу файла.

Дополнительно: общий ресурс **бот** (одна рука, один pathfinder, один поток тиков) без явной модели «кто владелец команды на этот тик».

---

## 2. Целевая идея (кратко)

1. **Один объект сессии боя** (`CombatSession` или аналог) с полями состояния вместо разрозненных модульных `let` вокруг `attackEntity`.
2. На каждом тике: **`tick(snapshot) → intents`** — не более одного намерения на подсистему (nav / ranged / melee / recover).
3. **Исполнители тупые**: только выполняют intent, не читают `strategy` и не ветвятся на «весь бой сразу».
4. **Новая механика** = новая **политика** или расширение матрицы приоритетов, а не новый разброс условий по файлу.

Публичный API **`attackEntity` / `stopAttack` / `isCombatSessionActive`** снаружи **сохраняем** (контракт для `CombatSystem`, `defend.js`, `events.js`).

---

## 3. Жёсткие ограничения (не нарушать)

- **Замороженное движение** (см. `.cursor/rules/frozen-movement.mdc`): не рефакторить `actions/movement.js`, pathfinder-интеграцию в движке, stuck/recovery, raycast/nav-assist. В бою по-прежнему только вызовы `bot.pathfinder.setGoal` из слоя боя — без переноса «физики» в новые модули.
- **`CombatSystem` FLEE / heal / reengage** — не менять контракт сессии боя (`isCombatSessionActive`, `ceasePvpCombat`) без отдельного согласованного рефакторинга.
- **`defend.js`** — глубокая переработка не входит в первую волну; только совместимость с флагом сессии.

Дополнительные **кросс-срезные** требования (согласованы для фаз 2 и 4):

- **State lock (жёстко):** пока активна сессия боя (`CombatSession` / флаг сессии), **никакие** другие подсистемы (Patrol, Follow, bus-nav и т.п.) **не вызывают** `pathfinder.setGoal`. Навигацией владеет только бой до завершения сессии.
- **Cleanup при завершении сессии (фаза 2):** при окончании сессии (бот мёртв, нет цели, цель мёртва) **обязательно** вызвать `bot.clearControlStates()`, чтобы бот не «дожимал» старый ввод и не шёл в стену бесконечно.
- **Throttling навигации (фаза 4):** исполнитель nav **обязан** дросселировать `setGoal` — обновлять путь только если цель сместилась примерно **на 1–2 блока** и больше (снижение «дрожания» pathfinder).

---

## 4. Фазы работ

### Фаза 0 — подготовка

- Зафиксировать чеклист ручной проверки после каждого шага:
  - aggressive melee;
  - defensive;
  - переключение ranged ↔ melee;
  - `strategy: 'archer'` и авто-archer при отсутствии меча;
  - прерывание / соседство с FLEE (`CombatSystem`);
  - defend point / entity во время активной сессии;
  - follow / guard после выхода из FLEE (если актуально).
- После каждого коммита: `npm run smoke:di` (минимум).

### Фаза 1 — «мёртвый» распил (поведение 1:1)

Только разнесение кода по файлам + импорты, **без изменения логики**.

Предлагаемый каталог `combat/session/` (имена можно слегка подстроить под репо):

| Файл | Содержимое |
|------|------------|
| `combat/session/constants.js` | `CFG`, утилита `sleep` |
| `combat/session/geometry.js` | `distanceTo`, `predictPosition`, `computeRangedLeadTicks`, `predictRangedAimPoint`, `bowDrawMsForDist`, `crossbowChargeMs` |
| `combat/session/rangedPolicy.js` | `computeRangedCombat`, `pickRangedMovementGoal`, `isNarrowForRanged`, `performRangedVolley`, `minMsUntilNextRangedVolley`, стабилизация движения перед залпом |
| `combat/session/meleeActions.js` | `critAttack`, `strafeStep`, `sprintResetBeforeMeleeHit`, `dodgeArrow` |
| `combat/session/inventoryCombat.js` | `equipByDistance` и тесно связанная экипировка в бою |
| `combat/session/danger.js` | `isInDanger`, `detectIncomingArrows` |
| `combat/session/potions.js` | `drinkPotion` (если выделяется без циклических зависимостей) |
| `combat/session/sessionFlags.js` | `getCombatSessionActive` / `setCombatSessionActive` — общий флаг сессии без циклических импортов из `attackEntity.js` |
| `attackEntity.js` | Точка входа: `attackEntity`, `stopAttack`, `isCombatSessionActive`, экспорт `CFG` при необходимости + реэкспорт из подмодулей |

Критерий готовности фазы 1: тот же diff по смыслу «пустой», только файлы разнесены; чеклист + smoke зелёные.

**Статус:** фаза 1 в репозитории выполнена (каталог `combat/session/` + glue в `attackEntity.js`, без класса `CombatSession`).

### Фаза 2 — мозг сессии (`CombatSession`)

- Перенести **состояние** с глобальных `let` на **экземпляр** сессии (флаги режима, `rangedVolleyBusy`, recover, strafe, тайминги атаки и т.д.).
- Тикер сжать до схемы:

  ```text
  обновить target → session.tick({...}) → выполнить intents по фиксированному приоритету
  ```

**Фиксированный приоритет intents (не менять порядок без аудита):**

1. Конец сессии (смерть бота, нет цели, цель мертва) — в том числе `bot.clearControlStates()` (см. §3).
2. Опасность (лава, tripwire, near_danger) — локальный escape, сброс nav при необходимости.
3. Recover — зелья/щит; **блок** агрессивного nav к цели и ranged volley по правилам сессии.
4. Ranged volley (если политика разрешила и нет блокировок).
5. Nav к цели (одна цель `setGoal` за тик с throttling, как сейчас по смыслу).
6. Melee: strafe / crit по правилам.

Новые фичи встраиваются как **новый шаг** или как условие внутри существующего шага с явной документацией.

### Фаза 3 — политики стратегий (чистые функции)

Вынести правила без побочных эффектов на `bot.pathfinder`:

- `combat/policies/autoStrategy.js` — авто-archer при отсутствии меча и наличии лука/стрел;
- `combat/policies/archer.js` — дистанции, fallback на defensive;
- при необходимости: `aggressive.js` / `defensive.js` — только числа и флаги «что хотим», не вызовы API.

`CombatSession.tick` **склеивает** выход политик в intents.

### Фаза 4 — исполнители (executors)

- `combat/executors/navExecutor.js` — только `setGoal` / `null` + **обязательный** throttling (перевыставление цели только при смещении цели ~**1–2 блока** и выше; см. §3).
- `combat/executors/rangedExecutor.js` — equip лук + `performRangedVolley`.
- `combat/executors/meleeExecutor.js` — `critAttack`, `strafeStep`.

Исполнители **не** читают `strategy` напрямую — только payload intent.

### Фаза 5 — наблюдаемость

- Опционально: флаг env `COMBAT_DEBUG_TICK=1` — редкий лог: режим, `dist`, `held`, последний intent, причина «volley пропущен».
- Метрика: число смен `setGoal` за тик / за секунду — всплеск = гонка или регресс.

### Фаза 6 — тесты без Minecraft

- Юнит-тесты на **чистые** функции: `computeRangedCombat`, `computeArcherGoal`, при необходимости «сухой» `session.planTick(mockSnapshot)` без вызова pathfinder.
- Даже 10–15 кейсов резко снижают регресс при добавлении веток.

(В репозитории сейчас `npm test` — заглушка; имеет смысл добавить минимальный раннер, например `node --test`, в отдельной задаче.)

---

## 5. Порядок коммитов (рекомендуемый)

1. Фаза 1 — несколько маленьких PR/коммитов (по 1–2 файла из списка).
2. Фаза 2 — **один** сфокусированный PR: сессия + перенос состояния; затем стабилизация по чеклисту.
3. Фазы 3–4 — по одной стратегии или одному исполнителю за PR.
4. Фаза 6 — параллельно с фазой 3, по мере появления чистых функций.

---

## 6. Как добавлять новую механику после рефактора

1. Описать поведение как **политику**: вход (снимок: hp, dist, held, flags), выход (intents или запреты).
2. Встроить в **приоритет** (или в существующий шаг с явным комментарием «почему здесь»).
3. Добавить **юнит-тест** на политику или на `planTick`.
4. Прогнать чеклист + `npm run smoke:di`.

Не добавлять произвольные `if` в конец тикера без места в приоритете.

---

## 7. Связанные файлы (ориентир)

- `attackEntity.js` — текущий монолит сессии боя.
- `systems/CombatSystem.js` — FLEE, engage, heal, reengage, `lastMode`.
- `defend.js` — вызов `attackEntity` / проверка активной сессии.
- `core/BotBrain.js` — намерения, шина.
- `docs/ARCHITECTURE_RU.md` — общая карта.

---

## 8. Версия документа

- Создано для передачи ассистентам и ревью; при существенных изменениях плана обновлять дату и краткий changelog внизу файла.

*Последнее обновление: 2026-05-12.*
