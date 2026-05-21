# AI Bot for Minecraft

Autonomous Minecraft bot with AI-driven decision making for resource gathering, combat, and survival.

## Features

### Core Capabilities
- **Resource Gathering**: Automated tree chopping, ore mining, branch mining, cave exploration
- **Combat System v2.0**: CombatSession FSM — ranged/melee, critical hits, totem support, shield management
- **PvP Mode**: Auto-equip, smart healing priorities, shield management, voice chat phrases
- **Survival Mode**: Self-preservation during gather with auto-healing
- **Voice Commands**: Natural language control (Russian/English)
- **Follow/Guard**: Escort and protect player

### Recent Enhancements (2026-05)
- **TacticalDecisionEngine**: Single per-tick decision context shared across all systems
- **BranchMineJob**: Branch mining at optimal Y-levels with FSM, integrated into ResourceSystem
- **InventoryManager**: Auto-drop junk during expeditions, configurable whitelist
- **CavePersistence**: Saves visited caves state across bot restarts (TTL 25 min)
- **GlobalWatchdog**: Global deadlock detector — resets bot after 30–90s of no movement
- **CombatSession v2.0**: Full FSM rewrite — ranged volley, crit attack, totem auto-equip, strafing
- **PvP Mode overhaul**: Auto-equip best gear, improved heal priorities, smart shield handling
- **Flee Logic Overhaul**: Fixed eternal BREAK_CONTACT, live threat distances, tuned thresholds
- **HomeBaseSystem**: Fixed infinite partial-loop navigation, multi-chest support
- **Army Bot System**: 20-bot squad with combat, formations, gear distribution

## Quick Start

```bash
# Install dependencies
npm install

# Run unit tests
node scripts/unit-phase1.js
node scripts/unit-resource.js
node scripts/unit-gather-guard.js

# Start bot (configure credentials first)
npm start
```

## Voice Commands (Russian)

### Gathering
- `"добывай уголь"` / `"копай железо"` / `"собирай дерево"`
- `"хватит добывать"` — stop gathering
- `"достаточно"` — stop current task

### Navigation
- `"иди за мной"` / `"следуй"` — follow player
- `"стой тут"` / `"жди"` — stop and wait
- `"защищай меня"` — guard mode (attack threats near player)

### Combat
- `"бей"` / `"атакуй"` — attack target
- `"беги"` / `"спасайся"` — flee from threats

## Army Bot Commands (`!squad`)

### Movement
- `!squad follow` — follow commander
- `!squad come` — come to commander
- `!squad stop` — stop everything

### Combat
- `!squad guard` — guard position, return after combat
- `!squad attack nearest` — each bot attacks nearest hostile mob
- `!squad escort` — follow commander AND attack mobs

### Formations
- `!squad form line` — shoulder-to-shoulder line
- `!squad form column` — 2-wide march column
- `!squad form circle` — ring around commander
- `!squad form square` — 4×5 square

### Gear
- `!squad gear` — equip all gear from inventory
- `!squad gear weapon` / `armor` / `torch`

### Targeting
- `!squad#5 come` — command specific bot
- `!squad#1-10 guard` — command range of bots

## Architecture

### Core Systems
- **BotBrain**: Central orchestration with state machine (IDLE, FOLLOWING, COMBAT, FLEE)
- **TacticalDecisionEngine**: Per-tick unified decision context (`threatScore`, `survivalScore`, `resourceScore`)
- **ResourceSystem**: TreeJob, OreJob, BranchMineJob, CaveExplorerJob — orchestrated gathering
- **CombatSystem**: Threat evaluation, engagement, flee navigation with tuned timeouts
- **CombatSession v2.0**: FSM-based fight loop — ranged volley, crit melee, totem, strafing, shield
- **PvPMode**: PvP-specific logic — auto-equip, smart heal, shield management
- **GatherGuardSystem**: Combat/gather coordination with SURVIVAL MODE
- **RecoveryHoldSystem**: Post-danger recovery with auto-heal and jitter-escape
- **GlobalWatchdog**: Deadlock detection — emits `WATCHDOG_DEADLOCK`, triggers jitter-escape
- **AwarenessSystem**: Threat detection and tracking
- **InventoryManager**: Junk auto-drop during expeditions
- **CavePersistence**: Persists visited cave state across restarts

### Army Bot System (`sex_army_test.js`)
- **20 soldier bots** (`Beer_1`–`Beer_20`) spawned with staggered 1.5s delay
- **mineflayer-pvp**: Real combat with attack cooldown and target pursuit
- **mineflayer-pathfinder**: Formation navigation and follow
- **gear_config.js**: Role-based gear (crossbowmen / spearmen)
- **give_gear.js**: HomeBot (op) auto-distributes gear to all bots
- **start_army.bat**: One-click full startup → spawn → gear → equip

### Event-Driven Design
All systems communicate via EventBus:
```javascript
// Example: Gather interrupt flow
AwarenessSystem ──THREAT_DETECTED──► GatherGuardSystem
                                        ↓
                              ResourceSystem.pauseGather()
                                        ↓
                              CombatSystem ──FLEE_START──►
                                        ↓
                              RecoveryHoldSystem (heal)
                                        ↓
                              ResourceSystem.resumeGather()
```

## Documentation

- [CHANGELOG.md](CHANGELOG.md) — Full change history
- [docs/INDEX.md](docs/INDEX.md) — Documentation index & reading order
- [docs/SYSTEMS_OVERVIEW.md](docs/SYSTEMS_OVERVIEW.md) — Architecture deep dive
- [docs/COMBAT_SESSION_REFACTOR_PLAN.md](docs/COMBAT_SESSION_REFACTOR_PLAN.md) — CombatSession v2.0 (COMPLETE)
- [docs/PVP_MODE.md](docs/PVP_MODE.md) — PvP mode design
- [docs/SURVIVAL_MODE.md](docs/SURVIVAL_MODE.md) — Survival mode for gather
- [docs/RECOVERY_HOLD.md](docs/RECOVERY_HOLD.md) — Auto-heal system
- [docs/OREJOB_TUNNEL.md](docs/OREJOB_TUNNEL.md) — Mining and pillar up

## Configuration

Key settings in `config/`:
```javascript
{
  combatFleeSafeHp: 14,                    // Safe HP threshold
  recoveryHoldMinMs: 4000,                  // Min recovery time
  survivalEatBelowFood: 18,                // Food threshold for auto-eat
  combatFleeRetreatScoreThreshold: 2.5     // Flee decision threshold (was 1.95)
  combatFleeRetreatRiskHpRatioMax: 0.72    // HP gate for flee (was 0.94)
  combatFleeNavDistance: 10                 // Flee distance blocks (was 20)
}
```

## Testing

```bash
# Run all unit tests
node scripts/unit-phase1.js             # Core systems: 24/24 OK
node scripts/unit-resource.js           # Resource gathering: 17/17 OK
node scripts/unit-gather-guard.js       # Combat/gather: 6/6 OK
node scripts/unit-phase3.js             # TacticalDecisionEngine: 15/15 OK
node scripts/unit-inventory-manager.js  # InventoryManager: 20/20 OK
node scripts/unit-cave-persistence.js   # CavePersistence: 15/15 OK
```

## Safety Features

- **Lava detection**: Aborts mining near lava
- **Gravity block detection**: Avoids gravel/sand collapses
- **Creeper priority**: Always flee from creepers
- **Stuck recovery**: Pillar up in open caves, dig ahead when blocked
- **Timeout protection**: All operations have hard time limits

## Known Limitations

- FindBlocks returns max 64 results within 32-block radius
- Block visibility limited to loaded chunks
- Food blacklist may reject valid foods in modded environments
- Pathfinder can struggle with complex terrain (water, ladders)

## License

Private project — not for public distribution.

## Recent Changes

See [CHANGELOG.md](CHANGELOG.md) for full details.

### 2026-05-21: BranchMineJob, InventoryManager, CavePersistence, TacticalDecisionEngine
1. **BranchMineJob** — branch mining at optimal Y-levels (`diamond:-58`, `iron:16`, etc.) with FSM
2. **InventoryManager** — auto-drops junk (cobblestone, dirt, gravel etc.) during expeditions; configurable whitelist
3. **CavePersistence** — saves visited caves across restarts with 25-min TTL
4. **TacticalDecisionEngine** — single per-tick context (`threatScore`, `survivalScore`, `resourceScore`); 15/15 tests

### 2026-05-20: CombatSession v2.0, PvP Overhaul, Flee Fix
1. **CombatSession v2.0** — full FSM rewrite: ranged volley, crit melee, totem auto-equip, strafing, shield — COMPLETE
2. **PvP Mode overhaul** — auto-equip best gear/armor, heal priority system, smart shield (no interrupt during eat)
3. **Flee Logic** — live threat distances, thinkTimeout 4000ms, navBoost 10 blocks, retreatScore 2.5
4. **GlobalWatchdog** — deadlock detector: 30s COMBAT/FLEE, 90s GATHER → jitter-escape + IDLE
5. **HomeBaseSystem** — fixed infinite partial-loop: 30s no progress → force canDig+canSwim, 90s → abort

### 2026-05-19: Mining, Storage, Navigation
1. **Vertical shaft digging** — fast 1×2 column for `targetY < 0` with lava/void safety
2. **Broken pickaxe recovery** — craft stone pickaxe underground, fallback to axe/shovel
3. **Multi-chest support** — `depositAll`, `withdrawItem`, `restockForExpedition` across all chests
4. **Torch placement** — every 8 tunnel steps, auto-craft if needed
5. **Drop collection fix** — `sin(-yaw)` → `sin(yaw)`, entity-based collection

