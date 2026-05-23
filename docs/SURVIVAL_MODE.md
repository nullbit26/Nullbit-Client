# Survival Mode for Gather Operations

> **Scope:** this document covers the **gather-specific** survival rules in `GatherGuardSystem` (flee thresholds during resource collection).
> For the autonomous **SurvivalSystem v1.5** (AI-assisted eating, `SurvivalMode` FSM, `tryEnableByAssistant`), see `docs/SURVIVAL_V1_5_ASSISTED_AUTONOMY.md` and `systems/SurvivalSystem.js`.

## Overview

Survival Mode provides deterministic, safety-first decision making during resource gathering operations. It replaces complex threat scoring with simple thresholds to eliminate "decision paralysis."

## Activation

Survival Mode triggers automatically in `GatherGuardSystem._handleCombatPause()` when:
- `nearbyThreatCount >= 3` (3 or more hostile mobs detected)
- `bot.health < 8` (critical health level)
- Threat is a **Creeper** (always flee, regardless of other factors)

## Flow

```
Threat Detected During Gather
    ↓
GatherGuardSystem._onThreatDetected()
    ↓ (pause gather, emit GATHER_PAUSED)
_handleCombatPause()
    ↓
Check Survival Rules (fast path)
    ├─ ≥3 threats? ──→ FLEE_START → _waitForIdle → RecoveryHold
    ├─ HP < 8? ────→ FLEE_START → _waitForIdle → RecoveryHold
    └─ Otherwise ──→ Evaluate complex rules (fight/flee)
    ↓
RecoveryHoldSystem (auto-heal phase)
    ├─ Eat food if hungry and HP < safe
    ├─ Wait for HP regeneration
    └─ Exit when safe
    ↓
_resumeGather() → Resume original gather task
```

## Configuration

```javascript
// In GatherGuardSystem
const FIGHT_MAX_THREATS = 2        // Max threats to consider fighting
const FIGHT_MIN_HP_RATIO = 0.45    // 45% HP minimum for fighting
const COMBAT_WAIT_TIMEOUT_MS = 30_000  // Max combat duration
const POST_COMBAT_COOLDOWN_MS = 1500   // Pause before resuming

// In RecoveryHoldSystem (via config)
recoveryHoldMinMs: 4000    // Minimum hold time (ms)
recoveryHoldMaxMs: 8000    // Maximum hold time (ms)
combatFleeSafeHp: 14       // Safe HP threshold to exit recovery
```

## Key Differences from Regular Combat

| Aspect | Regular Combat | Survival Mode (Gather) |
|--------|---------------|----------------------|
| Decision basis | Complex scoring (HP, distance, threat count, aggro) | Simple thresholds |
| Threat count | Can fight up to 2 threats | Flee at 3+ immediately |
| HP threshold | 45% for fight | Flee at <8 HP immediately |
| Creeper | Evaluated normally | Always flee |
| Recovery | Optional | Always heal to safe HP before resume |

## Logs

```
[GatherGuardSystem] SURVIVAL MODE: 4 threats detected — immediate flee
[GatherGuardSystem] SURVIVAL MODE: low HP (6) — immediate flee
[RecoveryHoldSystem] ate cooked_porkchop to heal
[RecoveryHoldSystem] exit hold, reason: SAFE heldMs: 5200
[GatherGuardSystem] resuming gather after combat (resource=iron)
```

## Integration Points

- **Input**: `AwarenessEvents.THREAT_DETECTED` → `GatherGuardSystem._onThreatDetected()`
- **Pause**: `ResourceSystem.pauseGather('HOSTILE_CONTACT')` → `GATHER_PAUSED`
- **Flee**: `CombatEvents.FLEE_START` → CombatSystem handles navigation
- **Recovery**: `CoreEvents.STATE_CHANGED` (FLEE→IDLE) → `RecoveryHoldSystem.enter()`
- **Resume**: `RecoveryHoldEvents.EXIT` → `GatherGuardSystem._resumeGather()`

## Why Simple Rules?

Complex `evaluateThreatPressure()` scoring can produce ambiguous results:
- 5 threats at distance 15, HP 90% → retreatScore = 1.2 (< 1.95 threshold)
- Result: Neither fight nor flee, bot "tupit"

Simple rules guarantee immediate action:
- 5 threats → flee (no calculation needed)
- HP 6/20 → flee (no calculation needed)

For gather operations, false positives (unnecessary flee) are acceptable.
False negatives (death while calculating) are not.
