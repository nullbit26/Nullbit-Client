# PvP Mode System Documentation

## Overview

PvP Mode — это микро-система ближнего боя 1 на 1 для Minecraft бота. Контролирует цель, хил, движение и экипировку.

**Файлы:**
- `systems/PvPMode.js` — основная логика PvP
- `systems/CombatSystem.js` — интеграция с системой боя

## Возможности

### 1. Авто-экипировка

При входе в PvP бот автоматически надевает:

| Слот | Приоритет экипировки |
|------|---------------------|
| Голова (head) | netherite_helmet → diamond_helmet → iron_helmet → ... |
| Торс (torso) | netherite_chestplate → diamond_chestplate → ... |
| Штаны (legs) | netherite_leggings → diamond_leggings → ... |
| Ботинки (feet) | netherite_boots → diamond_boots → ... |
| Левая рука (off-hand) | shield |
| Правая рука (hand) | netherite_sword → diamond_sword → ... → netherite_axe |

**Логика:**
- Порядок важен: броня → щит → оружие
- Если в руке не меч (щит/зелье/едa) — принудительно меняет на лучшее оружие
- Асинхронные операции с `await` для корректной последовательности

### 2. Система хила

#### Приоритеты на близкой дистанции (< 6 блоков)
1. **Splash Potion** (healing/instant_health) — мгновенный хил
2. **Enchanted Golden Apple** — если нет splash
3. **Golden Apple** — fallback

#### Приоритеты на дальней дистанции (> 6 блоков)
1. **Enchanted Golden Apple**
2. **Golden Apple**
3. **Drinkable healing potions**
4. **Food**

#### Критический режим (HP ≤ 6)
- Кулдаун хила: **500мс** (вместо 1500мс)
- Бот **не атакует**, только хилится
- Форсируется переход в KITE состояние
- **Бот не прерывает еду** даже под атакой — приоритет выживания

### 3. Состояния боя

```
ENGAGE    → Агрессивный бой, сближение
KITE      → Отступление + хил + щит
TRADE     → Обмен ударами при критическом HP
```

**Переключение:**
- HP ≤ 4: TRADE (обмен ударами или смерть)
- HP ≤ 8 и дистанция < 8: KITE (отступление с хилом)
- HP преимущество ≥ 5 или HP ≥ 15: ENGAGE

### 4. Защита щитом

- Щит всегда в off-hand во время боя
- При KITE на дистанции < 6 — щит активирован
- **Не трогает щит пока ест** — чтобы не прервать хил
- После еды автоматически возвращает щит в off-hand

### 5. Атака

- Кулдаун: 600мс
- Дистанция: ≤ 3.5 блоков
- W-Tap техника для оптимального knockback
- **Не атакует пока ест** — хил в приоритете

### 6. Voice Chat фразы

| Событие | Фраза |
|---------|-------|
| Вход в PvP | "Ну, сука, пизда тебе, еблан" |
| Убийство игрока | "ха-ха, обоссан лучшим" |

### 7. После боя

При убийстве цели:
1. Если HP < 20 → хилится (использует доступные предметы)
2. Через 2 секунды → останавливается
3. Голосовая фраза (если настроена)

## Технические детали

### Флаги состояния

```js
_isEating           // Предотвращает двойное consume
_controlLocked      // Блокировка других систем
_shieldActive       // Состояние щита
_lastCriticalLog    // Дебаг-лог критического HP (раз в секунду)
```

### Physics Tick

- Частота: 50мс (20Hz)
- Выполняет: `_tick()` → `_microCombat()` → `_tryHeal()` / `_tryAttack()`

### Интеграция с CombatSystem

```js
// CombatSystem вызывает PvPMode
_onEngage({ entityId, entityName }) {
  const target = this._bot.entities[entityId]
  if (target) {
    void this._pvpMode.setTarget(target).catch(() => {})
  }
}

// Остановка по команде "стоп"
_onStop() {
  this._pvpMode.clearTarget()
  this._brain.state.transition(CoreStates.IDLE)
}
```

## Исправленные баги

| Баг | Решение |
|-----|---------|
| Спам логов при критическом HP | Флаг `_lastCriticalLog`, лог раз в секунду |
| Зависание после еды (не менял меч) | `finally` блок в `_useFoodItem()` с `_equipBestWeapon()` |
| Двойная попытка съесть предмет | Флаг `_isEating` в `_useFoodItem()` |
| Щит в основной руке вместо меча | Принудительная проверка и смена в `_equipBestWeapon()` |
| Не экипировалась вся броня | Асинхронный `_equipBestGear()` с `await` |
| Не работал splash potion | Улучшенная проверка NBT: `nbt?.value?.Potion?.value` |
| Щит прерывал хил | Проверка `this._isEating` в `_activateShield()` / `_deactivateShield()` |
| Не останавливался по "стоп" | Подписка на `MovementEvents.SET_IDLE` в `CombatSystem` |

## Конфигурация

В `config.js`:

```js
pvpEnabled: true              // Включить PvP режим
pvpIdealDistance: 2.9         // Идеальная дистанция для атаки
pvpMicroRange: 5.0            // Радиус микро-контроля
pvpPhysicsTickMs: 50          // Частота тика (50ms = 20Hz)
pvpAttackCooldown: 600          // Кулдаун атаки (ms)
pvpKiteHpThreshold: 8         // Порог для KITE состояния
pvpTradeHpThreshold: 4        // Порог для TRADE состояния
```

## Логирование

Ключевые сообщения в консоли:

```
[PvPMode] Equipped armor: netherite_helmet to head
[PvPMode] Forced weapon equip: netherite_sword (was: splash_potion)
[PvPMode] Equipped shield to off-hand
[PvPMode] CRITICAL HP! Forcing heal...
[PvPMode] Healing with splash potion at close range
[PvPMode] Healing with enchanted_golden_apple at close range
[PvPMode] Finished consuming: golden_apple
[PvPMode] Re-equipping weapon after eating
[PvPMode] Victory! HP not full, healing before stop...
```

## TODO / Future Improvements

- [ ] Дальний бой (луки, арбалеты, трезубцы)
- [ ] Умный выбор цели при нескольких противниках
- [ ] Интеграция с ender pearls для escape
- [ ] Totem of Undying автоматическая экипировка в off-hand
- [ ] Стратегия "circle strafing" для уклонения

## Связанные системы

- `CombatSystem.js` — основной контроллер боя
- `RecoveryHoldSystem.js` — восстановление после боя
- `SurvivalSystem.js` — управление общим состоянием
