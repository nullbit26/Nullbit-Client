# Systems Overview

## Architecture

Event-driven architecture with clear separation of concerns:

```
┌─────────────────────────────────────────────────────────────┐
│                      BotBrain (Core)                        │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────┐   │
│  │ StateManager │ │   Memory     │ │   Scheduler      │   │
│  └──────────────┘ └──────────────┘ └──────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ↓                     ↓                     ↓
┌──────────────┐    ┌──────────────────┐    ┌──────────────┐
│  Combat      │    │  Resource/Gather   │    │  Follow/Guard│
│  System      │◄──►│  Systems           │◄──►│  System      │
└──────────────┘    └──────────────────┘    └──────────────┘
        ↑                     ↑                     ↑
        └─────────────────────┼─────────────────────┘
                              ↓
                    ┌──────────────────┐
                    │  Survival/Defense│
                    │  Support Systems │
                    │  (GatherGuard,   │
                    │   RecoveryHold,  │
                    │   Awareness)     │
                    └──────────────────┘
```

## Core Systems

### 1. StateManager
- **File**: `core/StateManager.js`
- **States**: `IDLE`, `FOLLOWING`, `COMBAT`, `FLEE`
- **Purpose**: Single source of truth for bot behavioral mode
- **Events**: `CoreEvents.STATE_CHANGED`

### 2. CombatSystem
- **File**: `systems/CombatSystem.js`
- **Purpose**: Manages combat engagement, flee navigation, weapon selection
- **Key Features**:
  - Threat evaluation via `evaluateThreatPressure()`
  - Flee pathfinding with obstacle breaking
  - Sprint-jump fallback when no path
  - Combat session tracking

### 3. ResourceSystem (Gather)
- **File**: `systems/ResourceSystem.js`
- **Purpose**: Orchestrates tree chopping and ore mining jobs
- **Jobs**:
  - `TreeJob`: Scans, navigates, chops trees (with leaf clearing)
  - `OreJob`: Tunnel mining, pillar up, ore detection
  - `CaveExplorerJob`: Explores caves when surface ores exhausted
- **Shaft digging router `_digShaftDown(oreName)`**:
  - `targetY < 0` → `_digShaftDownVertical` (fast 1×2 vertical shaft, gravity descent)
  - `targetY ≥ 0` → staircase (safe, no fall risk)
- **`_digShaftDownVertical(targetY)`**: lava/void safety checks, anti-stuck, deepslate 10s timeout
- **`_climbToSurface()`**: activates if bot Y < 0; digs up + jumps; broken pickaxe chain: craft at table → axe → shovel → abort

### 4. FollowSystem
- **File**: `systems/FollowSystem.js`
- **Purpose**: Navigation to player (follow/guard modes)
- **Features**:
  - Stuck detection with nudge (only in follow/guard, not gather)
  - Path probing with partial path handling
  - Teleport recovery on large distance

## Support Systems

### 5. GatherGuardSystem
- **File**: `systems/GatherGuardSystem.js`
- **Purpose**: Bridges gather operations with combat interrupts
- **Key Logic**:
  - **SURVIVAL MODE**: ≥3 threats or HP<8 → immediate flee
  - Pause gather on threat detection
  - Resume gather after combat/recovery
- **Integration**: `ResourceSystem` ↔ `CombatSystem`

### 6. RecoveryHoldSystem (Enhanced)
- **File**: `systems/RecoveryHoldSystem.js`
- **Purpose**: Post-danger safety state with auto-healing
- **Features**:
  - Automatic entry after flee/combat/gather interrupt
  - Auto-eat to heal (best food, avoid bad food)
  - Waits for HP regeneration
  - Max timeout safety (8s)
- **Integration**: Blocks `ResourceSystem` resume until safe

### 7. AwarenessSystem
- **File**: `systems/AwarenessSystem.js`
- **Purpose**: Threat detection and tracking
- **Outputs**: `AwarenessEvents.THREAT_DETECTED` with threat list

### 8. HomeBaseSystem
- **Files**: `systems/HomeBaseSystem.js`, `systems/HomeBaseConfig.js`, `systems/StorageSystem.js`, `systems/CraftingSystem.js`
- **Purpose**: Autonomous round-trip to base when inventory full or tool broken
- **Flow**:
  ```
  Inventory full / no tool
      ↓
  Navigate to base (dig to surface first if underground)
      ↓
  StorageSystem.depositAll() → all chests (keeps food, tools, torches)
      ↓
  CraftingSystem.craftMissingTools() — pickaxe + axe if needed
      ↓
  Restock torches: withdrawItem('torch') → craftTorches() if still low
      ↓
  StorageSystem.restockForExpedition():
    - Best pickaxe (iron+) from chests
    - Best sword (stone+) from chests
    - Food up to 16 items
    - Torches up to 16
    - crafting_table (1 if not in inventory) ← NEW
    - Best armor (helmet/chest/legs/boots) → auto-equip
      ↓
  Resume gather loop
  ```
- **`_navigateToBase()` — stuck detection (v2)**:
  - Underground stuck (`stuckSince`): dist unchanged 15s + Y < chestY-5 → `_digToSurface`
  - Surface stuck (`lastProgressDist/lastProgressAt`): no progress >2 blocks in 30s → force `canDig=true`, `canSwim=true`, `liquidCost=1`, re-emit GOTO
  - Hard abort: no progress 90s → `return false`
  - **Bug fixed (2026-05-19 #5)**: bot exited mine but spun `re-emitting goto` forever at dist=121 — terrain/forest/water blocked path, horizontal stuck detection was missing
- **`_digToSurface(targetY)`**:
  - Mode 1 (solid ceiling/wall): dig staircase toward chest, jump-step up
  - Mode 2 (open cave): pillar up with scaffold block; fallback to nearest wall staircase
  - MAX_STEPS=300, stuckCount>40 → abort
- **StorageSystem** (v2): multi-chest, iterates `getChestPositions()` for all operations
  - `depositAll()` — fills chests in order until inventory clear
  - `withdrawItem(name, count)` — searches all chests
  - `withdrawCraftingMaterials(needs)` — splits across chests
  - `restockForExpedition()` — full pre-expedition restock incl. crafting_table
  - `absentEverywhere` tracker incl. `craftingTable`
- **CraftingSystem** (v2): stone tools + `craftTorches(targetCount)` (no table needed)
- **HomeBaseConfig** (v2): multi-chest registry
  - `_chestPositions[]` — all chests in base radius
  - `getChestPositions()` — array of all positions
  - `scanNearbyChests(bot, radius=10)` — rescan on demand
  - Saved/loaded from `./config/homebase.json`
- **"тут база" command**: scans `findBlocks` radius=10, registers all chests, reports count

### 9. SurvivalSystem (Standalone)
- **File**: `systems/SurvivalSystem.js`
- **Purpose**: Persistent autonomous survival mode
- **Features**:
  - Auto-eat when hungry
  - Activated via `SurvivalEvents.SET_SURVIVAL`
  - **Phase 3**: reads `brain.decisionContext` instead of calling `evaluateThreatPressure()` directly — skips tick if context not ready
- **Note**: Separate from RecoveryHold; not used by gather operations

### 11. TacticalDecisionEngine (Phase 3)
- **File**: `core/TacticalDecisionEngine.js`
- **Purpose**: Single source of truth for threat/survival assessment — eliminates duplicate `evaluateThreatPressure()` calls
- **How it works**:
  - Registers 1-tick interval in `Scheduler` (highest priority, runs every `physicsTick`)
  - Calls `buildDecisionContext()` **once per tick** for the whole bot
  - Caches frozen result in `brain.decisionContext` enriched with Scorer weights
  - Emits `TacticalEvents.CONTEXT_UPDATED` (`tactical:context_updated`)
- **Scorer weights** (all 0..1):
  - `threatScore` — `1.0` on `immediateDanger`, `0.7` on `recentAggroPressure`, else `combinedPressure/3`
  - `survivalScore` — `hpScore + foodScore×0.4`
  - `resourceScore` — `0` without task; `0.5..1.0` based on `currentTask + inventoryFillRatio + inventoryValueScore`
- **Init last, destroy first** in `BotBrain`

### 14. BranchMineJob
- **File**: `systems/BranchMineJob.js`
- **Purpose**: Systematic branch mining at optimal Y-levels when no caves or surface ore exist
- **Y-targets** (1.18+): `diamond=-59`, `iron=16`, `coal=96`, `gold=-16`, `copper=48`, `lapis=0`, `redstone=-59`, `emerald=232`
- **FSM**: `PLAN_BRANCH` → `NAV_TO_START` → `DIG_BRANCH` → `NEXT_BRANCH` → `COMPLETE/FAIL`
- **Key parameters**: `BRANCH_LENGTH=32`, `BRANCH_SPACING=4` (no overlap), `MAX_BRANCHES=8`, `ORE_SCAN_RADIUS=6`, `TORCH_INTERVAL=8` — all read from `process.env`, configurable via NEURAL tab
- **Side scanning**: each step checks 3 blocks left + right; digs to ore, returns to axis
- **Safety**: `DANGER_RE` (lava/water) aborts tunnel; `GRAVITY_RE` (sand/gravel) pre-dug; torch every 8 steps
- **Integration** in `ResourceSystem`: `CaveExplorerJob fail` → `BranchMineJob` → `_digShaftDown` (last resort)
- **Inventory**: calls `dropJunk()` at `fillRatio >= 0.85` in-shaft

### 15. ConfigManager (Neural Hot-Reload)
- **File**: `config/ConfigManager.js`
- **New exports**: `applyNeuralOverrides(neural, target)`, `watchNeural(configPath, liveConfig, log)`
- **`applyNeuralOverrides`**: maps `config.json → neural.*` fields onto a live config object with min/max clamping; safe to call anytime
- **`watchNeural`**: `fs.watch` on `config.json` with 300ms debounce; calls `applyNeuralOverrides` on change → patches live `config` in-place
- **Launched in**: `index.js` after `start()` — `pkg`-aware path detection for both exe and dev modes
- **Real-time params** (take effect immediately): all COMBAT FLEE, PVP, NAVIGATION, AI parameters
- **Restart-only params**: `BRANCH_LENGTH`, `MAX_BRANCHES`, `ORE_SCAN_RADIUS`, `TORCH_INTERVAL` — module-level constants in `BranchMineJob`

### 13. InventoryManager
- **File**: `utils/InventoryManager.js`
- **Purpose**: Auto-drop junk items during expeditions to avoid premature base returns
- **API**:
  - `JUNK_ITEMS` — explicit denylist: cobblestone, dirt, gravel, andesite, diorite, granite, sand, netherrack, etc.
  - `KEEP_ALWAYS` — protected set: all tools, armor, ores, food, torches, crafting_table — **never dropped**
  - `isJunk(item)` — true if in `JUNK_ITEMS` OR not in `KEEP_ALWAYS` and zero value per `ITEM_VALUES`
  - `shouldDropJunk(bot, threshold=0.85)` — true when `fillRatio ≥ threshold` (31+ of 36 slots used)
  - `dropJunk(bot, opts)` — drops cheapest items first until `targetFreeSlots` freed; `maxDrops=16` safety cap
- **Integration**:
  - `OreJob.js` — before every `slots <= 2 → paused_for_home` check: drops junk in-shaft
  - `ResourceSystem.js` — before `INVENTORY_FULL` gather stop: same logic for TreeJob loop
- **Drop order**: explicit `JUNK_ITEMS` → zero-value unknowns (both sorted by stack count asc)

### 12. CavePersistence
- **File**: `utils/CavePersistence.js`
- **Purpose**: Persist `_visitedCaves` Map across bot restarts so bot doesn't revisit empty caves
- **API**:
  - `loadVisitedCaves(map, ttlMs, path)` — loads `caves.json` on startup, drops expired entries
  - `saveVisitedCaves(map, ttlMs, path)` — writes to disk, evicting expired before write
  - `addAndPersist(map, key, ts, ttlMs, path)` — adds entry + immediate flush
- **File**: `./config/caves.json` (next to `homebase.json`)
- **TTL**: 25 minutes (matches `CAVE_VISITED_TTL_MS` in `CaveExplorerJob`)
- **Integration**: `ResourceSystem` loads on construction, saves after every `CaveExplorerJob.run()`

### 10. DefendSystem + defend.js
- **Files**: `systems/DefendSystem.js`, `defend.js`
- **Purpose**: Defense during follow/guard modes
- **Key Fix**: `tickChatGuard` checks gather mode to avoid conflicts
- **Logic**: Attack mobs near owner in follow mode, players too in guard mode

## Command System

### CommandRegistry
- **File**: `commands/commandRegistry.js`
- **Purpose**: Maps natural language (Russian/English) to events
- **Features**:
  - Pattern matching with regex
  - Multiple verb support: `добывай`, `копай`, `собирай`, etc.
  - Emits events: `ResourceEvents.GATHER_START`, `CombatEvents.FOLLOW`, etc.

### Resource Commands (Russian)
```javascript
// Without amount — mine indefinitely:
"добывай уголь"         → gather_start coal
"копай железо"          → gather_start iron
"найди алмазы"          → gather_start diamond
"добудь дерево"         → gather_start wood
"хватит добывать"       → gather_stop

// With amount — stop when target reached:
"добудь 30 железа"      → gather_start iron, target=30
"копай 2 стака угля"    → gather_start coal, target=128
"mine 64 iron"          → gather_start iron, target=64
"добудь 10 алмазов"     → gather_start diamond, target=10
```

## Key Design Patterns

### 1. Event-Driven Communication
```javascript
// No direct method calls between systems
// Systems emit events, others listen
bus.emit(CombatEvents.FLEE_START, { reason: 'survival' })
bus.on(CombatEvents.FLEE_START, handler)
```

### 2. State Ownership
- Only `StateManager` changes state
- Systems request transitions via events
- Prevents conflicting state changes

### 3. Priority System
```
Priority: CombatSystem > RecoveryHoldSystem > ResourceSystem
- CombatSystem owns pathfinder during combat/flee
- RecoveryHoldSystem blocks resume until safe
- ResourceSystem yields to both
```

### 4. Pause/Resume Pattern
```javascript
// ResourceSystem on interrupt:
pauseGather('HOSTILE_CONTACT')  // Emit GATHER_PAUSED
// GatherGuardSystem handles interrupt
// Later: resumeGather() restores interrupted task
```

### 5. Failed Block Tracking
```javascript
// Systems track failed positions:
_failedBlocks: Map<blockKey, timestamp>
// Prevents retry loops, expires after TTL
```

## Integration Flow Examples

### Gather → Combat → Recovery → Resume
```
1. Bot gathering iron (OreJob tunneling)
2. 4 zombies appear (AwarenessSystem)
3. GatherGuardSystem detects threat
   └─ SURVIVAL MODE: ≥3 threats → FLEE
4. ResourceSystem.pauseGather()
5. CombatSystem handles flee navigation
6. FLEE → IDLE transition
7. RecoveryHoldSystem enters (POST_FLEE)
8. Bot eats, heals to safe HP
9. RecoveryHoldSystem exits (SAFE)
10. GatherGuardSystem._resumeGather()
11. OreJob continues tunneling
```

### Pillar Up in Open Cave
```
1. OreJob._tunnel() stuck (no blocks to dig)
2. Detects: air ahead, air above, air further above
3. Triggers _pillarUp(targetY)
4. Stops pathfinder, clears movement
5. Scaffolding: jump + place under self
6. Reaches targetY
7. Resets pathfinder state
8. Returns to _tunnel(), continues from new height
```

## Testing

### Unit Tests
- `scripts/unit-phase1.js` — Core systems (StateManager, Memory, Scheduler) — 24/24
- `scripts/unit-resource.js` — ResourceSystem, TreeJob, OreJob — 16/16
- `scripts/unit-gather-guard.js` — GatherGuardSystem, interrupt handling
- `scripts/unit-threat-pressure.js` — Threat evaluation logic
- `scripts/unit-survival.js` — SurvivalSystem — 12/12
- `scripts/unit-phase3.js` — TacticalDecisionEngine, Scorer weights — 15/15
- `scripts/unit-cave-persistence.js` — CavePersistence load/save/TTL — 15/15
- `scripts/unit-inventory-manager.js` — InventoryManager isJunk/dropJunk/shouldDropJunk — 20/20
- `scripts/unit-branch-mine.js` — BranchMineJob Y-targets, FSM, direction helpers — 20/20

### Integration Testing
- Manual in-game testing for:
  - Tree chopping with combat interrupt
  - Ore tunneling with pillar up
  - Multi-threat survival mode
  - Recovery hold with auto-heal

## Recent Changes

See `CHANGELOG.md` for detailed list.

### 2026-05-23 — NEURAL Tab + Hot-Reload
1. **NEURAL tab** (Launcher) — `NULLBIT/renderer/index.html`, `app.js`, `style.css`: new sub-item under CORE ACCESS; 5 parameter groups (COMBAT FLEE, PVP, NAVIGATION, MINING, AI); `saveNeuralConfig()` writes to `config.json → neural`; `loadConfigUI()` reads and populates fields
2. **ConfigManager hot-reload** — `config/ConfigManager.js`: added `applyNeuralOverrides(neural, target)` with min/max clamping; added `watchNeural(configPath, liveConfig, log)` — `fs.watch` + 300ms debounce + in-place `Object.assign` on live `config`
3. **index.js watcher** — starts `watchNeural` after `start()` with `pkg`-aware path; no bot restart needed for real-time param changes
4. **BranchMineJob constants fixed** — `systems/BranchMineJob.js`: `BRANCH_LENGTH`, `MAX_BRANCHES`, `ORE_SCAN_RADIUS`, `TORCH_INTERVAL` now read from `process.env` (were hardcoded)
5. **ConfigManager neural mapping** — `config/ConfigManager.js`: `loadConfigJson` now also maps `raw.neural.*` → `process.env` on bot startup

### 2026-05-21 #8
1. **SurvivalSystem v1.5** — `systems/SurvivalSystem.js`: `SurvivalMode` enum (`OFF`/`ON_MANUAL`/`ON_ASSISTANT`); `tryEnableByAssistant()` with 6 guardrails; `triggerUserOverride()` (60s block); auto-recovery for `ON_ASSISTANT`; backward-compatible `isActive()`
2. **EventRegistry** — `core/EventRegistry.js`: added `survival:set_ai`, `survival:user_override`
3. **IntentTypes** — `core/IntentTypes.js`: added `SURVIVAL_ENABLE_ASSISTANT`
4. **BotBrain dispatch** — `core/BotBrain.js`: new `SURVIVAL_ENABLE_ASSISTANT` case; `triggerUserOverride()` wired to `BOT_STOP`, `MOVEMENT_SET_FOLLOW`, `MOVEMENT_SET_COME`, `COMBAT_ENGAGE_ENTITY`
5. **AIIntentSystem tool** — `systems/AIIntentSystem.js`: added `enableSurvivalMode` tool
6. **TacticalDecisionEngine spam fix** — `core/TacticalDecisionEngine.js`: `tactical:context_updated` emits only on state change (snapshot diff)

### 2026-05-21 #6
1. **ConfigManager** — `config/ConfigManager.js`: now loads `config.json` (user-facing) after `.env` (developer); `pkg`-aware path detection; dual structure support (`minecraft.*` / `server.*`); maps to `process.env` via guarded `set()`
2. **Release/config.json** — restructured with `license_key`, `bot_version`, `minecraft.*`, `bot.allowed_user`, `bot.server_password`; default username `Nullbit`
3. **Launcher localization** — `scripts/launcher.js`: removed `Cyberpunk Edition`, all messages translated to English
4. **config.js** — default `MC_USERNAME` fallback: `MINI_KOSH` → `Nullbit`

### 2026-05-21 #5
1. **BranchMineJob fixes** — `_branchOrigin.y` и `_stateNextBranch` return Y: hardcoded `_targetY+1` → `Math.floor(_startPos.y)` (реальная позиция после шахты)
2. **ResourceSystem fallback order** — исправлен порядок: `CaveExplorer fail → ShaftDig → BranchMine` (был: ShaftDig как last resort, теперь Branch mine после спуска)
3. **ResourceSystem imports cleanup** — убраны дублирующие `require` внутри методов (`equipBestPickaxe`, `Vec3`, `findBestAxe`, `findBestShovel`); два top-level `require('../utils/equipBestTool')` объединены в один

### 2026-05-21 #4
1. **BranchMineJob** — `systems/BranchMineJob.js`: branch mining FSM at optimal Y-levels; side ore scanning; integrated into `ResourceSystem` as fallback between CaveExplorer and ShaftDig

### 2026-05-21 #3
1. **InventoryManager** — `utils/InventoryManager.js`: `JUNK_ITEMS`, `KEEP_ALWAYS`, `dropJunk()`; integrated into `OreJob` (in-shaft drop before `paused_for_home`) and `ResourceSystem` (before `INVENTORY_FULL` stop)

### 2026-05-21 #2
1. **Cave Persistence** — `utils/CavePersistence.js`: visited caves survive restarts; `ResourceSystem` loads on init, saves after each `CaveExplorerJob.run()`

### 2026-05-21 #1
1. **TacticalDecisionEngine** (Phase 3) — `core/TacticalDecisionEngine.js`: single `buildDecisionContext()` call per tick; `brain.decisionContext` cache; `threatScore`/`survivalScore`/`resourceScore` scorer weights; `SurvivalSystem` reads cache; `GatherGuardSystem._getOrBuildPressure()` with 150ms TTL fallback

### 2026-05-19 #5
1. **HomeBaseSystem nav stuck fix** — `_navigateToBase` no longer loops forever after surfacing; 30s surface stuck → force canDig+canSwim; 90s hard abort

### 2026-05-19 #4
1. **Vertical shaft descent** — `_digShaftDownVertical` for deep ores (targetY<0), lava/void safety
2. **`_climbToSurface` threshold Y<0** — was Y<-30
3. **Broken pickaxe mid-climb** — craft at table → axe → shovel → abort chain
4. **crafting_table in expedition restock** — bot carries table to enable underground crafting
5. **Impossible 2×2 pickaxe craft removed** — vanilla requires crafting table

### 2026-05-19 #3
1. **Torch Placement** — `OreJob._tryPlaceTorch()` every 8 tunnel steps, auto-crafts from coal+sticks
2. **Multi-Chest Base** — `HomeBaseConfig` stores all chests in radius 10, all storage ops iterate them
3. **Pre-Expedition Restock** — `StorageSystem.restockForExpedition()` takes best gear, food, armor
4. **Target Amount** — `startGather(type, N)` stops when N items collected; command: `"добудь 30 железа"`
5. **craftTorches** — `CraftingSystem.craftTorches()` crafts from inventory (no table)
6. **Auto Armor Equip** — After restocking, bot equips best armor from inventory
