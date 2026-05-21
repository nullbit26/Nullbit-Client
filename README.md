# AI Bot for Minecraft

Autonomous Minecraft bot with AI-driven decision making for resource gathering, combat, and survival.

## Features

### Core Capabilities
- **Resource Gathering**: Automated tree chopping and ore mining with tunnel navigation
- **Combat System**: Threat evaluation, fight/flee decisions, weapon selection
- **Survival Mode**: Self-preservation during gather with auto-healing
- **Voice Commands**: Natural language control (Russian/English)
- **Follow/Guard**: Escort and protect player

### Recent Enhancements
- **Flee Logic Overhaul**: Fixed eternal BREAK_CONTACT, reduced timeouts, proper threat distance calculation
- **Army Bot System**: 20-bot squad with combat, formations, gear distribution
- **SURVIVAL MODE** for Gather: Simple rules (≥3 threats = flee, HP<8 = flee) eliminate decision paralysis
- **Auto-Heal**: Recovery hold automatically eats food and waits for HP regeneration
- **Improved Mining**: Side ore detection every 3 steps, pillar up with pathfinder management
- **Enhanced Commands**: Multiple Russian verbs for gather operations

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
- **ResourceSystem**: TreeJob (wood), OreJob (mining), CaveExplorerJob (cave exploration)
- **CombatSystem**: Threat evaluation, engagement, flee navigation
- **GatherGuardSystem**: Combat/gather coordination with SURVIVAL MODE
- **RecoveryHoldSystem**: Post-danger recovery with auto-heal
- **AwarenessSystem**: Threat detection and tracking

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
- [docs/SYSTEMS_OVERVIEW.md](docs/SYSTEMS_OVERVIEW.md) — Architecture deep dive
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
node scripts/unit-phase1.js        # Core systems: 24/24 OK
node scripts/unit-resource.js        # Resource gathering: 17/17 OK
node scripts/unit-gather-guard.js  # Combat/gather: 6/6 OK
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

### 2026-05-20: Flee Logic Overhaul
1. **Eternal BREAK_CONTACT fix** - Use live entity positions instead of stale memory.distance
2. **Pathfinder timeouts** - Increased thinkTimeout to 4000ms during flee (was 1500ms)
3. **Flee distance optimization** - Reduced navBoost to 10 blocks (was 20)
4. **Threshold adjustments** - retreatScoreThreshold: 2.5, retreatRiskHpRatioMax: 0.72
5. **Player threat inclusion** - Flee direction now considers hostile players
6. **Logging accuracy** - Fixed nearest:0 display when no threats exist

### 2026-05-19 #2: Drop Collection & HomeBaseSystem Fixes
1. **`_tunnelToPos` direction bug** — bot walked AWAY from drops (`sin(-yaw)` → `sin(yaw)`) — ~40% ore loss eliminated
2. **`_collectDrops` entity-based** — scans real item entities via `bot.entities`, bruteforce to exact drop position, no pathfinder
3. **HomeBaseSystem nav loop** — subscribed to `GATHER_START` event, aborts nav poll within 500ms when gather resumes

### 2026-05-19: Navigation & Mining Loop Fixes
1. **`paused_for_home` infinite loop** — `ResourceSystem` now calls `executeRoundTrip()` and waits instead of spinning 60+/sec
2. **`_tunnelToPos` stuck** — stuck detection + proper vertical descent + 350ms forward time
3. **HomeBaseSystem** — round-trip navigation (home → deposit → craft → back) confirmed stable

### 2026-05-17: Army Bot System
1. **20-bot squad** with mineflayer-pvp combat
2. **guard/attack/escort** — fully working mob combat
3. **Formations** — line, column, circle, square with commander facing
4. **Auto gear distribution** — HomeBot (op) gives gear on startup
5. **One-click start** — `start_army.bat` handles everything

### 2026-05-16: Mining & Survival
1. **SURVIVAL MODE**: Simple flee thresholds for gather operations
2. **Auto-Heal**: Recovery hold eats food and waits for HP
3. **Pillar Up Fix**: Pathfinder management prevents drift
4. **Side Ore Mining**: Tunnel wall scanning every 3 steps
5. **Command Expansion**: Russian verb synonyms for gather

