# Recovery Hold System (with Auto-Heal)

## Overview

RecoveryHoldSystem provides a transitional safety state after dangerous events (combat, flee, gather interrupt). It blocks risky actions until conditions are safe, with automatic healing via food consumption.

## Purpose

**Not a full SurvivalSystem** — RecoveryHold is:
- Transitional (temporary state between danger and normal operation)
- Event-triggered (enters automatically on FLEE→IDLE, combat end, gather interrupt)
- Safety-focused (prevents immediate return to danger)
- Self-healing (auto-eats to regenerate HP)

## Trigger Conditions (Automatic Entry)

```javascript
REASONS = {
  POST_FLEE:       // State changed FLEE → IDLE
  POST_COMBAT:     // Combat ended
  GATHER_INTERRUPTED:  // ResourceSystem paused due to threat
  MAX_HOLD_TIMEOUT:    // Forced exit after max duration
  MANUAL:          // Explicit enter() call
}
```

## Auto-Heal Mechanism

### Conditions for Eating
```javascript
if (food < 20 && hp < safeHp && hasAnyFood(bot)) {
  _tryEatToHeal()
}
```

- **Food saturation not full** (< 20)
- **HP below safe threshold** (configurable, default 14)
- **Has edible food** in inventory

### Food Selection
```javascript
FOOD_DENYLIST = new Set([
  'rotten_flesh',      // Hunger debuff
  'spider_eye',        // Poison
  'pufferfish',        // Poison + nausea
  'poisonous_potato',  // Poison chance
  'chorus_fruit'       // Random teleport
])

// Selection algorithm:
// 1. Filter out denylist items
// 2. Get food data from bot.registry.foodsByName
// 3. Score by effectiveQuality (foodPoints × saturation)
// 4. Pick highest quality
```

### Eating Process
```javascript
_tryEatToHeal():
  if (_isEating) return                    // Already eating
  if (Date.now() < _eatCooldownUntil) return  // Recent failure

  bestFood = findBestFood()
  if (!bestFood) return

  _isEating = true
  async:
    - equip(bestFood, 'hand')
    - consume()
    - log success
  catch:
    - set cooldown (3 seconds)
    - log failure
  finally:
    - _isEating = false
```

## Exit Conditions

Safe exit requires ALL of:
1. **Minimum hold time elapsed** (default 4 seconds)
2. **Not in combat or flee state**
3. **No active combat session**
4. **No immediate danger** (evaluateThreatPressure)
5. **No recent aggro pressure**
6. **HP at or above safe threshold** (14 default)

Emergency exit:
- **Maximum hold time reached** (default 8 seconds) → exit regardless of HP

## State Diagram

```
                    [IDLE / Normal Operation]
                            ↑
                            | RecoveryHoldEvents.EXIT
                            |
    FLEE → IDLE ───────→ [RECOVERY HOLD] ←─────── GATHER_INTERRUPTED
           (enter)           │
                             ├── Hold min 4s
                             ├── Check: combat? → stay
                             ├── Check: danger? → stay
                             ├── Check: HP < safe? → eat & stay
                             └── Check: HP ≥ safe? → exit
                            |
                            | (max 8s timeout)
                            ↓
                    [EXIT: MAX_HOLD_TIMEOUT]
```

## Configuration

```javascript
// In config object
{
  recoveryHoldMinMs: 4000,        // Minimum hold duration
  recoveryHoldMaxMs: 8000,        // Maximum hold duration (safety)
  combatFleeSafeHp: 14,           // HP threshold to consider "safe"
  // (also affects CombatSystem flee decisions)
}
```

## Integration with ResourceSystem

```javascript
// ResourceSystem waits for RecoveryHold before resuming
_resumeGather():
  if (brain.recoveryHoldSystem?.isActive()) {
    // Defer until EXIT event
    bus.on(RecoveryHoldEvents.EXIT, () => {
      startGather(interruptedResource)
    })
    return
  }
  // Resume immediately if not in recovery
```

This ensures gather doesn't resume while healing or in danger.

## Logs

```
[RecoveryHoldSystem] enter hold, reason: POST_FLEE
[RecoveryHoldSystem] ate cooked_beef to heal
[RecoveryHoldSystem] ate bread to heal
[RecoveryHoldSystem] exit hold, reason: SAFE heldMs: 6200
```

## Comparison: RecoveryHoldSystem vs SurvivalSystem

| Feature | RecoveryHoldSystem | SurvivalSystem |
|---------|-------------------|----------------|
| Duration | Temporary (4-8s) | Persistent (while active) |
| Trigger | Automatic on danger events | Manual activation (bus event) |
| Scope | Post-danger recovery | Continuous autonomous survival |
| Navigation | No pathfinder ownership | No pathfinder ownership |
| Combat | Yields to CombatSystem | Yields to CombatSystem |
| Eating | Auto-heal when HP < safe | Auto-eat when hungry |
| Use case | Gather/Combat aftermath | General autonomous mode |

## Why Extend RecoveryHold vs New System?

**Existing integration:**
- Already wired to ResourceSystem resume logic
- Already triggered by all relevant danger events
- EventBus infrastructure in place

**Minimal change:**
- Adding eat/heal is localized to `_tick()`
- No new event types needed
- No changes to callers needed

**Future path:**
- Can rename to `SurvivalHoldSystem` if scope expands
- Or extract heal logic to shared utility for both systems
