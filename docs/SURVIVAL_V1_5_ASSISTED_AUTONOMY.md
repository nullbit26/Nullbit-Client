# Архитектурный план: Survival v1.5 (Assisted Autonomy)

**Статус:** Concept / Future  
**База:** Survival v1 (уже реализован)  
**Цель:** Дать AI-ассистенту право самостоятельно включать режим выживания при соблюдении жёстких guardrails.

---

## 1. Суть концепции (Policy-Governed Autonomy)

Ассистент получает право самостоятельно включать режим выживания (Survival Mode), если видит в этом необходимость. Однако он делает это не через прямой взлом управления, а через "слой политик" (Policy Layer), который гарантирует, что ИИ не сломает текущие планы пользователя и не вмешается в бой.

### Формула приоритетов

```
Hard Safety (Combat/FLEE) > Human Override (User) > Assistant Intent (AI) > Background Tick (Scheduler)
```

| Уровень | Что может | Что не может |
|---------|-----------|--------------|
| **Hard Safety** | Прервать любую активность при угрозе жизни | Не конфликтует с user intent напрямую |
| **Human Override** | Отключить любой режим, включая survival | Нарушать guardrails после собственной команды |
| **Assistant Intent** | Включить survival при определённых условиях | Выключить survival, включённый пользователем |
| **Background Tick** | Есть, лечиться, мониторить состояние | Включать/выключать survival |

---

## 2. Жёсткие ограничения (Guardrails)

### Правило 1: User Always Wins

Если пользователь сказал `stop` или выключил выживание, накладывается `manualOverrideUntil` (например, на 60 секунд). В течение этого окна Ассистент не имеет права снова включать survival, как бы сильно бот ни был голоден.

```javascript
// Псевдокод
if (Date.now() < this._manualOverrideUntil) {
  return { allowed: false, reason: 'USER_OVERRIDE_ACTIVE' }
}
```

**Триггеры manual override:**
- Любая команда `stop` / `стоп`
- Команда `не выживай` / `stop survival`
- Команды движения: `come`, `follow`, `guard`, `attack`, `patrol`
- Явное переключение режима через AI tool (если пользователь через чат сказал "не надо")

### Правило 2: Assistant Can Only Enable

Ассистент имеет право перевести режим из `OFF` в `ON_ASSISTANT`. Но он **не имеет права** выключить режим, если тот был включен пользователем (`ON_MANUAL`).

```javascript
// Допустимые переходы
OFF → ON_MANUAL (user command)
OFF → ON_ASSISTANT (AI tool)
ON_ASSISTANT → OFF (user command или успешное восстановление)
ON_MANUAL → OFF (только user command)
```

### Правило 3: Combat / FLEE Immunity

Ассистент не может включить survival во время:
- Активного `CombatSession` (`isCombatSessionActive()`)
- Состояния `CoreStates.FLEE`
- Активного `CoreStates.COMBAT`

Безопасность в бою обеспечивается слоем Combat, а не Survival.

### Правило 4: Reason Codes

Каждое автоматическое включение должно сопровождаться чёткой причиной (Reason Code). ИИ не может просто включить режим "потому что захотел".

**Обязательная структура:**
```javascript
{
  source: 'ASSISTANT',
  reasonCode: 'LOW_FOOD_SAFE_WINDOW',
  reasonText: 'Food level 8/20, no threats in 20 blocks, safe to eat',
  confidence: 0.95,  // AI certainty score
  at: Date.now()
}
```

---

## 3. Состояния Survival (State Machine)

```
                    ┌─────────────────────────────────────┐
                    │                                     │
                    ▼                                     │
┌─────────┐    ┌──────────┐    ┌──────────────┐    ┌──────────┐
│   OFF   │───▶│ON_MANUAL │◀───│ON_ASSISTANT  │────│   OFF    │
└────┬────┘    └────┬─────┘    └──────┬───────┘    └──────────┘
     │              │                  │
     │  (user)      │ (user)           │ (AI tool)
     │              │                  │
     └──────────────┘                  │
              (manualOverride 60s)     │
                                       │
                              (auto-disable on full recovery)
```

### Таблица переходов

| From → To | Trigger | Source | Guard Condition |
|-----------|---------|--------|-----------------|
| OFF → ON_MANUAL | `выживай` command | User | Always allowed |
| OFF → ON_ASSISTANT | `enable_survival` tool | AI | `!isCombatSessionActive() && !FLEE && manualOverrideExpired && reasonCodeValid` |
| ON_MANUAL → OFF | `не выживай` / `stop` | User | Always allowed |
| ON_ASSISTANT → OFF | `не выживай` / `stop` / auto-recovery | User/System | User command OR (food >= 20 && hp >= max) |
| ANY → OFF | Brain destroy / disconnect | System | Always |

---

## 4. Разрешённые причины для авто-включения (Reason Codes)

Ассистент может инициировать `survival:enable_assistant`, передав один из кодов:

### `LOW_FOOD_SAFE_WINDOW`
**Условия:**
- `bot.food < 14`
- Нет immediate danger (`!pressure.immediateDanger`)
- `safeToRecover === true`
- Не в бою / FLEE

**Действие:** Включить survival, дождаться пока бот поест

### `LOW_HP_POST_COMBAT`
**Условия:**
- `CombatSession` только что закончился (был `isCombatSessionActive()`, теперь `false`)
- `CoreStates` перешло из `COMBAT` / `FLEE` в `IDLE`
- `bot.health < combatFleeSafeHp` (обычно 16)
- Есть еда в инвентаре

**Действие:** Включить survival для стабилизации HP

### `UNATTENDED_IDLE_PRESERVE`
**Условия:**
- Бот в `IDLE` > 5 минут без команд
- Нет активных задач (follow, guard, patrol, defend)
- Food или HP не на максимуме
- Нет угроз поблизости

**Действие:** Включить survival для энергосбережения / поддержания здоровья

### `INVENTORY_HEAL_OPPORTUNITY` *(опционально)*
**Условия:**
- Обнаружены лечебные зелья / золотые яблоки
- Бот не в бою
- HP < max

**Действие:** Включить survival для использования премиум-лечения

---

## 5. Техническая реализация

### 5.1 Изменения в `systems/SurvivalSystem.js`

#### Состояния вместо boolean

```javascript
const SurvivalMode = Object.freeze({
  OFF: 'OFF',
  ON_MANUAL: 'ON_MANUAL',      // User explicitly enabled
  ON_ASSISTANT: 'ON_ASSISTANT' // AI enabled via tool
})

// Вместо this._active = false
this._mode = SurvivalMode.OFF
this._manualOverrideUntil = 0
this._lastAssistantAttemptAt = 0  // Для debounce
this._lastAssistantReason = null
```

#### Debounce / Cooldown

```javascript
const ASSISTANT_ATTEMPT_COOLDOWN_MS = 10000  // Между попытками ИИ

_canAssistantAttemptNow() {
  return Date.now() > this._lastAssistantAttemptAt + ASSISTANT_ATTEMPT_COOLDOWN_MS
}
```

#### Метод для AI tool

```javascript
/**
 * Попытка включить survival со стороны ассистента.
 * @param {string} reasonCode - один из разрешённых кодов
 * @param {number} confidence - 0..1
 * @returns {{allowed: boolean, reason: string, newMode?: string}}
 */
tryEnableByAssistant(reasonCode, confidence = 0.5) {
  // Guard: reason code valid
  if (!REASON_CODES.has(reasonCode)) {
    return { allowed: false, reason: 'INVALID_REASON_CODE' }
  }
  
  // Guard: user override window
  if (Date.now() < this._manualOverrideUntil) {
    return { 
      allowed: false, 
      reason: 'USER_OVERRIDE_ACTIVE',
      overrideExpiresIn: this._manualOverrideUntil - Date.now()
    }
  }
  
  // Guard: combat safety
  if (isCombatSessionActive()) {
    return { allowed: false, reason: 'COMBAT_SESSION_ACTIVE' }
  }
  if (this._brain.state.getState() === CoreStates.FLEE) {
    return { allowed: false, reason: 'FLEE_STATE_ACTIVE' }
  }
  if (this._brain.state.getState() === CoreStates.COMBAT) {
    return { allowed: false, reason: 'COMBAT_STATE_ACTIVE' }
  }
  
  // Guard: debounce
  if (!this._canAssistantAttemptNow()) {
    return { allowed: false, reason: 'ASSISTANT_COOLDOWN' }
  }
  
  // Guard: already enabled by user
  if (this._mode === SurvivalMode.ON_MANUAL) {
    return { allowed: false, reason: 'ALREADY_MANUAL_ON' }
  }
  
  // Guard: conditions match reason code
  const conditionCheck = this._verifyReasonConditions(reasonCode)
  if (!conditionCheck.valid) {
    return { allowed: false, reason: 'CONDITIONS_NOT_MET', details: conditionCheck.details }
  }
  
  // Success
  this._mode = SurvivalMode.ON_ASSISTANT
  this._lastAssistantAttemptAt = Date.now()
  this._lastAssistantReason = {
    code: reasonCode,
    confidence,
    at: Date.now()
  }
  
  this._brain.log.info('[SurvivalSystem] AI enabled survival:', reasonCode, 'confidence:', confidence)
  this._bus.emit(SurvivalEvents.SET_SURVIVAL_ASSISTANT, { 
    reasonCode, 
    confidence, 
    at: Date.now() 
  })
  
  return { allowed: true, reason: 'OK', newMode: this._mode }
}
```

#### Обновлённые user методы

```javascript
_onSet() {  // User command
  this._mode = SurvivalMode.ON_MANUAL
  this._manualOverrideUntil = 0  // Сброс override при явном включении
  // ...
}

_onStop() {  // User command stop / stop survival
  const wasEnabled = this._mode !== SurvivalMode.OFF
  this._mode = SurvivalMode.OFF
  this._isEating = false
  this._eatCooldownUntil = 0
  
  // Ключевой момент: ставим override window при выключении пользователем
  if (wasEnabled) {
    this._manualOverrideUntil = Date.now() + MANUAL_OVERRIDE_WINDOW_MS  // 60000
  }
  // ...
}

// Также trigger override при любой user movement/combat команде
triggerUserOverride() {
  if (this._mode === SurvivalMode.ON_ASSISTANT) {
    // Если ИИ включил — user команда выключает
    this._onStop()
  }
  this._manualOverrideUntil = Date.now() + MANUAL_OVERRIDE_WINDOW_MS
}
```

### 5.2 Новые события в `EventRegistry.js`

```javascript
const SurvivalEvents = Object.freeze({
  SET_SURVIVAL: 'survival:set',              // User enabled
  STOP_SURVIVAL: 'survival:stop',            // User disabled
  SET_SURVIVAL_ASSISTANT: 'survival:set_ai',  // AI enabled
  USER_OVERRIDE_TRIGGERED: 'survival:user_override'  // User took control
})
```

### 5.3 Интеграция с AIIntentSystem

#### Новый Intent Type

```javascript
// core/IntentTypes.js
const IntentTypes = Object.freeze({
  // ... existing ...
  SURVIVAL_ENABLE_ASSISTANT: 'SURVIVAL_ENABLE_ASSISTANT'
})
```

#### Tool для LLM

```javascript
// tools/enableSurvivalTool.js
const enableSurvivalTool = {
  name: 'enable_survival_mode',
  description: 'Enable survival mode when bot needs to eat/heal safely. Use ONLY when: (1) bot is hungry or wounded, (2) no enemies nearby, (3) not in combat. Always provide clear reason.',
  parameters: {
    type: 'object',
    properties: {
      reason_code: {
        type: 'string',
        enum: ['LOW_FOOD_SAFE_WINDOW', 'LOW_HP_POST_COMBAT', 'UNATTENDED_IDLE_PRESERVE'],
        description: 'Why survival mode is needed'
      },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: 'How certain you are this is correct (0.5+ recommended)'
      },
      reasoning: {
        type: 'string',
        description: 'Human-readable explanation for the decision'
      }
    },
    required: ['reason_code', 'confidence', 'reasoning']
  }
}
```

#### Prompt инструкция для ассистента

```markdown
## Survival Mode Tool (enable_survival_mode)

You may enable survival mode AUTOMATICALLY only when ALL conditions are met:
1. Bot health < 20 OR food < 20
2. No combat session active
3. Bot is not in FLEE state
4. No immediate threats nearby (safe window)
5. User has not recently given a command (last 60 seconds)

IF user recently said "stop", "follow", "attack", "guard", or disabled survival — DO NOT use this tool for 60 seconds.

When in doubt, ask user: "Хочешь включить режим выживания?"
```

---

## 6. Авто-выключение (Auto-recovery)

Когда survival был включён ассистентом (`ON_ASSISTANT`), система может автоматически выключить его при восстановлении:

```javascript
_tick() {
  if (this._mode === SurvivalMode.OFF) return
  
  // ... existing checks ...
  
  // Auto-disable for AI-enabled mode when recovered
  if (this._mode === SurvivalMode.ON_ASSISTANT) {
    const fullyRecovered = (
      this._bot.food >= 20 &&
      this._bot.health >= this._bot.maxHealth * 0.95
    )
    if (fullyRecovered && !pressure.immediateDanger) {
      this._mode = SurvivalMode.OFF
      this._brain.log.info('[SurvivalSystem] Auto-disabled after recovery')
      this._bus.emit(SurvivalEvents.STOP_SURVIVAL, { 
        reason: 'AUTO_RECOVERY_COMPLETE',
        at: Date.now()
      })
      return
    }
  }
  
  // ... eating logic ...
}
```

**Примечание:** `ON_MANUAL` не выключается автоматически — только по команде пользователя.

---

## 7. Unit-тесты (ожидаемые)

### should reject assistant enable if manual override window is active
```javascript
brain.eventBus.emit('survival:set', { at })  // User enabled
brain.eventBus.emit('survival:stop', { at }) // User disabled
assert.ok(sys._manualOverrideUntil > Date.now())
const result = sys.tryEnableByAssistant('LOW_FOOD_SAFE_WINDOW', 0.9)
assert.strictEqual(result.allowed, false)
assert.strictEqual(result.reason, 'USER_OVERRIDE_ACTIVE')
```

### should allow assistant enable if idle and low food
```javascript
// Setup: IDLE state, food=8, no threats, no override
const result = sys.tryEnableByAssistant('LOW_FOOD_SAFE_WINDOW', 0.9)
assert.strictEqual(result.allowed, true)
assert.strictEqual(sys._mode, 'ON_ASSISTANT')
```

### should not allow assistant to disable user-enabled survival
```javascript
brain.eventBus.emit('survival:set', { at })  // User enabled
assert.strictEqual(sys._mode, 'ON_MANUAL')
// AI cannot disable
const result = sys.tryEnableByAssistant('LOW_FOOD_SAFE_WINDOW', 0.9)
assert.strictEqual(result.allowed, false)
assert.strictEqual(result.reason, 'ALREADY_MANUAL_ON')
```

### stop command should reset assistant survival and trigger override window
```javascript
sys.tryEnableByAssistant('LOW_FOOD_SAFE_WINDOW', 0.9)  // AI enabled
assert.strictEqual(sys._mode, 'ON_ASSISTANT')
brain.eventBus.emit('survival:stop', { at })  // User said stop
assert.strictEqual(sys._mode, 'OFF')
assert.ok(sys._manualOverrideUntil > Date.now())
```

### should auto-disable ON_ASSISTANT when fully recovered
```javascript
sys.tryEnableByAssistant('LOW_FOOD_SAFE_WINDOW', 0.9)
// Simulate eating to full
bot.food = 20
bot.health = 20
brain.scheduler.fireTick('survival_system_tick')
assert.strictEqual(sys._mode, 'OFF')
```

### should respect assistant cooldown between attempts
```javascript
sys.tryEnableByAssistant('LOW_FOOD_SAFE_WINDOW', 0.9)
const result = sys.tryEnableByAssistant('LOW_FOOD_SAFE_WINDOW', 0.9)
assert.strictEqual(result.reason, 'ASSISTANT_COOLDOWN')
```

---

## 8. Улучшения концепции (дополнительно)

### 8.1 Graceful Degradation на ошибки

Если `tryEnableByAssistant` возвращает `allowed: false` по причине, отличной от cooldown — логировать это в `OperationalMemory` как `failedAssistantIntents`. Если >3 отказов подряд — AI получает системное сообщение "Твои попытки включить survival блокируются, возможно user хочет контролировать сам".

### 8.2 Predictive Triggering

Вместо реактивного "сейчас мало еды" — использовать `AwarenessSystem` для предиктивного включения:
- Бот идёт в опасную зону (пещера, ад) → включить survival заранее
- Ночь наступает → включить survival если нет кровати поблизости

### 8.3 User Preference Persistence

Сохранять в `OperationalMemory` предпочтения пользователя:
```javascript
memory.survivalUserPreference = {
  allowAssistantAuto: true | false,  // User может запретить ИИ включать
  preferredThresholds: { food: 12, hp: 14 },
  lastInteractionMode: 'MANUAL' | 'ASSISTANT'
}
```

### 8.4 Explainability / Transparency

При включении survival ассистентом — автоматически отправлять в чат:
```
[AI] Включаю режим выживания: еды мало (8/20), врагов нет, безопасно поесть.
```

Или (если пользователь запретил чат-спам):
```
[AI → Logs] Survival ON_ASSISTANT | Reason: LOW_FOOD_SAFE_WINDOW | Confidence: 0.92
```

---

## 9. Минимальная реализация (MVP для v1.5)

Если нужно сделать быстро — минимальный набор:

1. **Только состояния:** `OFF`, `ON_MANUAL`, `ON_ASSISTANT` (без auto-recovery)
2. **Только один reason code:** `LOW_FOOD_SAFE_WINDOW`
3. **Только guardrails:** manual override + combat immunity
4. **Tool:** один `enable_survival_mode` в AIIntentSystem
5. **Без:** predictive triggering, persistence, chat notifications

Приоритет реализации: **Guardrails > Tool > States > Auto-recovery**

---

## Связанные файлы

- `systems/SurvivalSystem.js` — основной модуль (текущий v1)
- `core/EventRegistry.js` — события survival
- `commands/handlers/survival.js` — user команды
- `systems/AIIntentSystem.js` — интеграция с LLM
- `docs/SURVIVAL_V1_5_ASSISTED_AUTONOMY.md` — этот документ
