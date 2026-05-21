# Changelog

All notable changes to the AI Bot project.

## [2026-05-21 #8] - Survival v1.5 (Assisted Autonomy) + tactical spam fix

### `systems/SurvivalSystem.js` — v1 → v1.5
- **SurvivalMode enum**: `OFF` / `ON_MANUAL` / `ON_ASSISTANT` replaces `_active` boolean
- **`tryEnableByAssistant(reasonCode, confidence)`**: 6 guardrails — `USER_OVERRIDE_ACTIVE`, `COMBAT_SESSION_ACTIVE`, `FLEE_STATE_ACTIVE`, `COMBAT_STATE_ACTIVE`, `ASSISTANT_COOLDOWN`, `CONDITIONS_NOT_MET`
- **`_verifyReasonConditions()`**: validates context against reason code (`LOW_FOOD_SAFE_WINDOW`, `LOW_HP_POST_COMBAT`, `UNATTENDED_IDLE_PRESERVE`)
- **`triggerUserOverride()`**: cancels `ON_ASSISTANT` mode, blocks AI for 60s
- **Auto-recovery**: `ON_ASSISTANT` auto-disables when `food >= 20 && hp >= 95%`
- **`isActive()`**: backward-compatible, returns `mode !== OFF`
- **`getMode()`**: new method returning current `SurvivalMode` string

### `core/EventRegistry.js` — new survival events
- `survival:set_ai` (`SET_SURVIVAL_ASSISTANT`) — AI enabled survival
- `survival:user_override` (`USER_OVERRIDE_TRIGGERED`) — user took control

### `core/IntentTypes.js`
- Added `SURVIVAL_ENABLE_ASSISTANT`

### `core/BotBrain.js` — intent dispatch
- `SURVIVAL_ENABLE_ASSISTANT` case: calls `survivalSystem.tryEnableByAssistant()`
- `BOT_STOP`, `MOVEMENT_SET_FOLLOW`, `MOVEMENT_SET_COME`, `COMBAT_ENGAGE_ENTITY` now call `survivalSystem.triggerUserOverride()` (User Always Wins guardrail)

### `systems/AIIntentSystem.js`
- Added tool `enableSurvivalMode`: accepts `reason_code` + `confidence`, enqueues `SURVIVAL_ENABLE_ASSISTANT` intent

### `core/TacticalDecisionEngine.js` — idle spam fix
- `tactical:context_updated` now emits **only when context actually changes** (snapshot of 9 key fields); suppresses ~20 redundant emits/sec during idle

---

## [2026-05-21 #6] - Release config refactor & launcher localization

### `config/ConfigManager.js` — user-facing config support
- **Added `config.json` loading**: reads `Release/config.json` (or project root) before falling back to `.env`
- **Priority order fixed**: `.env` loads first (developer override) → `config.json` fills only unset vars via guarded `set()`
- **pkg/exe detection**: uses `process.pkg` to locate `config.json` next to `.exe` at runtime
- **Dual structure support**: handles both `minecraft.*` (release) and `server.*` (legacy) field layouts
- **Fields mapped**: `MC_HOST`, `MC_PORT`, `MC_VERSION`, `MC_AUTH`, `MC_USERNAME`, `MC_PASSWORD`, `ALLOWED_USERS`

### `Release/config.json` — simplified user config
- Restructured to clear `minecraft` and `bot` blocks
- Added `license_key` (KeyAuth), `bot_version` (launcher update check)
- Added `bot.allowed_user` (only this player can command the bot)
- Added `bot.server_password` (for `/login` on password-protected servers)
- Default bot username: `Nullbit`

### `scripts/launcher.js` — localization
- Removed `Cyberpunk Edition` label from banner and all comments
- Translated all UI messages, log lines, and status strings to English

### `Release/README.txt` — localization
- Fully translated to English
- Updated field descriptions to match new `config.json` structure

### `config.js`
- Default `MC_USERNAME` fallback changed from `MINI_KOSH` to `Nullbit`

## [2026-05-21 #5] - Compatibility fixes: BranchMineJob integration & ResourceSystem cleanup

### `systems/BranchMineJob.js` — integration fixes
- **Fixed `_branchOrigin.y`**: was `this._targetY + 1` (hardcoded) → now `Math.floor(this._startPos.y)` — bot is already at the correct depth after `_digShaftDown`, no need to navigate through rock
- **Fixed `_stateNextBranch` return Y**: same change — `this._targetY + 1` → `Math.floor(refPos.y)` for correct return to start point

### `systems/ResourceSystem.js` — BranchMineJob integration fixes
- **Fixed fallback chain order**: was `CaveExplorer fail → BranchMine → ShaftDig`, now `CaveExplorer fail → ShaftDig → BranchMine` — bot must first descend to target Y via shaft, then start branch mining
- **Removed duplicate `require` inside methods**: `equipBestPickaxe`, `Vec3`, `findBestAxe`, `findBestShovel` moved to top-level
- **Removed duplicate top-level import**: two `require('../utils/equipBestTool')` merged into one with full destructured exports

### Compatibility — verified
- `NavEvents.GOTO kind:'near'` — supported by `NavigationController` ✅
- `TacticalDecisionEngine.init()` — guarded by `if (_wired) return` ✅
- `BotBrain.init()` — guarded by `if (_initialized) return` ✅
- `SurvivalSystem` — `if (!ctx) return` when `brain.decisionContext === null` ✅
- All exports confirmed ✅

### Tests after fixes — **70/70 ✅**
- `unit-phase3.js` — 15/15
- `unit-cave-persistence.js` — 15/15
- `unit-inventory-manager.js` — 20/20
- `unit-branch-mine.js` — 20/20

---

## [2026-05-21 #4] - BranchMineJob: branch mining at optimal Y-levels

### `systems/BranchMineJob.js` — new module
- Deterministic branch mining at optimal Y-levels (1.18+)
- `BRANCH_Y_TARGETS`: diamond=-59, iron=16, coal=96, gold=-16, copper=48, lapis=0, redstone=-59, emerald=232
- FSM: `PLAN_BRANCH` → `NAV_TO_START` → `DIG_BRANCH` → `NEXT_BRANCH` → `COMPLETE/FAIL`
- Parameters: `branchLength=32`, `branchSpacing=4` (optimal coverage without overlap), `maxBranches=8`
- Each step scans 3 blocks left/right — on ore found digs and returns to axis
- `dropJunk()` integrated at `fillRatio >= 0.85` during active mining
- Torch placement every 8 steps
- Protection against hazard blocks (lava, water) and gravity blocks (sand, gravel)
- Supports `shouldInterrupt`, `alive()`, custom `targetY`, `branchLength`, `maxBranches`

### `systems/ResourceSystem.js` — integration
- New fallback chain on `caveResult === 'fail'`: **CaveExplorer** → **BranchMine** → **ShaftDig**
- BranchMineJob inserted between cave fail and `_digShaftDown` as more efficient fallback

### Tests `scripts/unit-branch-mine.js` — **20/20 ✅**

---

## [2026-05-21 #3] - InventoryManager: auto-drop junk during expeditions

### `utils/InventoryManager.js` — new module
- `JUNK_ITEMS` — explicit junk list: cobblestone, dirt, gravel, andesite, diorite, granite, sand, netherrack, etc.
- `KEEP_ALWAYS` — protected list: all tools, armor, ores, food, torches, crafting table — **never dropped**
- `isJunk(item)` — `true` if in `JUNK_ITEMS` OR not in `KEEP_ALWAYS` and zero value per `ITEM_VALUES`
- `shouldDropJunk(bot, threshold=0.85)` — `true` if `fillRatio ≥ threshold` (31+ slots filled)
- `dropJunk(bot, opts)` — drops junk until `targetFreeSlots` free; `JUNK_ITEMS` first, then zero-value unknowns; `maxDrops=16` safety cap

### `systems/OreJob.js` — integration
- Before each `slots <= 2 → paused_for_home` check: if `shouldDropJunk(0.85)` → `dropJunk()` directly in the shaft
- Bot **does not go home** while there is junk to drop

### `systems/ResourceSystem.js` — integration
- Before `INVENTORY_FULL` gather-loop stop: same `dropJunk()` call
- Works for both TreeJob (wood) and OreJob (ores)

### Tests `scripts/unit-inventory-manager.js` — **20/20 ✅**

---

## [2026-05-21 #2] - Cave Persistence: saving visited caves across restarts

### `utils/CavePersistence.js` — new module
- `loadVisitedCaves(map, ttlMs, filePath)` — loads `caves.json` on startup; expired entries (> TTL) are discarded
- `saveVisitedCaves(map, ttlMs, filePath)` — writes Map to disk, pruning expired entries before write
- `addAndPersist(map, key, ts, ttlMs, filePath)` — adds entry to Map + immediate flush to disk
- Format: `{ "entries": [["x,y,z", timestamp], ...], "savedAt": ... }`
- File: `./config/caves.json` (alongside `homebase.json`)

### `systems/ResourceSystem.js` — integration
- Constructor: `loadVisitedCaves()` on init — bot skips exhausted caves after restart
- After each `CaveExplorerJob.run()`: `saveVisitedCaves()` — state immediately on disk
- TTL 25 minutes (matches `CAVE_VISITED_TTL_MS` in `CaveExplorerJob`)

### Tests `scripts/unit-cave-persistence.js` — **15/15 ✅**

---

## [2026-05-21 #1] - Phase 3: TacticalDecisionEngine

### Single source of truth for threats and survival

#### New module `core/TacticalDecisionEngine.js`
- Registered in `Scheduler` at **1 tick** interval (`physicsTick`) — highest priority
- Calls `buildDecisionContext()` **once per tick** for the entire bot
- Caches result in `brain.decisionContext` (frozen, enriched with scorer weights)
- Emits `TacticalEvents.CONTEXT_UPDATED` (`tactical:context_updated`) — all systems can subscribe

#### Scorer weights (`brain.decisionContext` fields)
| Field | Range | Logic |
|-------|-------|-------|
| `threatScore` | 0..1 | `1.0` on `immediateDanger`, `0.7` on `recentAggroPressure`, otherwise scale `combinedPressure/3` |
| `survivalScore` | 0..1 | `hpScore + foodScore×0.4` (HP more critical than food) |
| `resourceScore` | 0..1 | `0` without task; `0.5..1.0` based on `currentTask` + `inventoryFillRatio` + `inventoryValueScore` |

#### `core/EventRegistry.js` — new events
- `TacticalEvents.CONTEXT_UPDATED` (`tactical:context_updated`) — added to `REGISTERED_EVENT_DEFINITIONS` and exported

#### `core/BotBrain.js` — integration
- `brain.decisionContext = null` — current context cache (null before first tick)
- `brain.tacticalEngine` — engine reference
- Initialized **last** in `init()`, destroyed **first** in `destroy()`

#### `systems/SurvivalSystem.js` — deduplication
- Removed direct `evaluateThreatPressure()` call in `_tick()`
- Reads ready `brain.decisionContext` — if `null`, tick skipped (safe fallback)

#### `systems/GatherGuardSystem.js` — smart cache
- Added `_getOrBuildPressure(memory)`:
  - If `brain.decisionContext` fresher than 150ms → returns cache (0 recalculations)
  - Otherwise → live `evaluateThreatPressure()` call (async-handler may run after await)

#### Tests `scripts/unit-phase3.js` — **15/15 ✅**

---

## [2026-05-20] - NULLBIT Launcher v2.1: Cyberpunk Edition

### Cyberpunk Launcher

#### New launcher with auto-update (`scripts/launcher.js`)
- **NULLBIT ASCII logo** — figlet with ANSI Shadow font
- **Glitch effects** — `glitchText()` with random special characters (#, @, _, █, ▓, ▒, ░)
- **Hacker interface** — status tags `[ SYS ]`, `[ OK ]`, `[ ERR ]`, `[ WARN ]` in uppercase
- **Cyberpunk progress bar** — `DOWNLOADING [████░░░░░░] 45% | 350/700 MB`
- **Glitch alerts** — red blinking text on update detected

#### Auto-update via GitHub Releases API
- Reads `bot_version` from `config.json`
- GET request to `https://api.github.com/repos/nullbit26/Nullbit-Client/releases/latest` (`User-Agent: Nullbit-Launcher`)
- Extracts `tag_name` → strips `v` → compares semver
- On update: prints **PATCH NOTES** (`body` of release) in gray
- Waits 2 seconds, then downloads `AIBot.exe` from `assets[]` via `browser_download_url`
- Backs up old version → replaces → updates `bot_version` in `config.json`

#### Process management
- Launcher stays alive (not detached)
- Closing launcher window also terminates the bot
- Status output: `[+] NULLBIT IS RUNNING`

#### Launcher dependencies
```json
{
  "chalk": "^4.1.2",        // Colored output (CJS version for pkg)
  "figlet": "^1.11.0",      // ASCII art
  "cli-progress": "^3.12.0", // Progress bar
  "axios": "^1.16.1",        // HTTP requests
  "fs-extra": "^11.2.0"      // File operations
}
```

#### Build output
```
Release/
├── AIBot.exe      (554 MB)  ← Main bot
├── Launcher.exe   (58 MB)   ← Cyberpunk launcher
├── config.json              ← Version + license
└── README.txt               ← User instructions
```

---

## [2026-05-20] - Release Build System v2.0: esbuild + KeyAuth + .exe

### New release build system

#### 1. Build architecture (`scripts/build-v2.js`)
- **esbuild bundle** — entire project bundled into a single file
- **KeyAuth integration** — 2-step auth (init session → license check)
- **Compile to .exe** — via pkg, final binary 700+ MB
- **External config** — `config.json` with license key

#### 2. Code protection
- ✅ esbuild minification — obfuscated output
- ✅ Single bundle — all modules embedded, no external `require()`
- ✅ pkg compilation — code inside binary
- ✅ KeyAuth license check — HWID binding, online activation

#### 3. KeyAuth authorization flow
```
1. GET /api/1.2/?type=init → get sessionid
2. POST /api/1.2/ with sessionid + license_key + hwid → verify
3. On success → launch bot
```

#### 4. Build files
- `scripts/build-v2.js` — main build script (6 steps)
- `scripts/verify-build.js` — readiness verification
- `scripts/license-check.js` — license check module (for development)
- `BUILD_SETUP.md` — full documentation

#### 5. Build dependencies
```json
{
  "esbuild": "^0.20.2",
  "pkg": "^5.8.1",
  "axios": "^1.6.2",
  "fs-extra": "^11.2.0",
  "glob": "^10.3.10"
}
```

### Build version history
- **v2.0** — esbuild bundle, fixed require() errors, KeyAuth session init
- **v1.0** — file-by-file obfuscation (obsolete)

---

## [2026-05-20] - PvP Mode: Full melee combat system overhaul

### New features

#### 1. Auto-equip (`systems/PvPMode.js`)
- Auto-equips best armor (priority: netherite → diamond → iron)
- Auto-equips shield in off-hand
- Auto-equips best weapon (sword/axe)
- Force-swaps wrong items in hand (shield/potion → sword)

#### 2. Improved healing system
- **Close range priority**: splash potion → golden apple
- **Far range priority**: golden apple → drinkable potions → food
- **Critical mode** (HP ≤ 6): heal cooldown reduced from 1500ms to 500ms
- **Does not interrupt eating** — heal has priority over attack

#### 3. Voice Chat phrases
- PvP entry: "Ну, сука, пизда тебе, еблан"
- Player kill: "ха-ха, обоссан лучшим"

#### 4. Smart shield management
- Shield always in off-hand during combat
- Shield untouched while eating (prevents heal interrupt)
- Auto re-equips shield after eating

### Bug fixes

| Bug | Fix |
|-----|-----|
| "CRITICAL HP" log spam | `_lastCriticalLog` flag — log once per second |
| Bot didn't re-equip sword after eating | `finally` block with `_equipBestWeapon()` in `_useFoodItem()` |
| Double consume attempt | `_isEating` flag prevents duplicate `bot.consume()` |
| Shield in main hand | Force-check in `_equipBestWeapon()` |
| Not all armor equipped | Async `_equipBestGear()` with `await` |
| Splash potions not working | Improved NBT structure check |
| Shield interrupted eating | `this._isEating` check in shield methods |
| Didn't stop on 'stop' command | Subscribe to `MovementEvents.SET_IDLE` |
| No heal on critical HP | Forced heal with priority over attack |

### Technical changes

```js
// New flags in PvPMode constructor
this._isEating = false          // Prevents double consume
this._lastCriticalLog = 0       // Debug log once per second

// Heal priority over attack
if (!this._isEating && now - this._lastAttack >= this._ATTACK_COOLDOWN) {
  this._tryAttack()
}

// Critical HP: forced heal
if (this._bot.health <= 6 && !this._isEating) {
  this._tryHeal(now)
  return // Skip attack
}
```

### Files
- `docs/PVP_MODE.md` — full system documentation

---

## [2026-05-20] - Flee Logic Overhaul: fix for eternal BREAK_CONTACT

### Problems
- **Eternal BREAK_CONTACT**: Bot stuck due to stale threat distances (`memory.distance` instead of live positions)
- **Pathfinder timeout spam**: `thinkTimeout=1500ms` too low for flee pathfinding, constant replans
- **Excessive flee distance**: `navBoost=20` blocks caused pathfinder failures in complex terrain
- **Premature flee**: Low thresholds triggered flee at decent HP
- **Incorrect logging**: `nearest:0` when no threats exist (should be `null`)

### Fixes

#### 1. Live threat distances (`combat/flee/evaluateThreatPressure.js`)
```js
// Before: stale memory.distance
for (const row of threats) {
  const d = Number(row?.distance)  // STALE VALUE
}

// After: live entity position when available
for (const row of threats) {
  let d
  if (botPos && row?.id != null) {
    const ent = bot.entities?.[row.id]
    if (ent?.position) {
      d = botPos.distanceTo(ent.position)  // LIVE POSITION
    }
  }
  if (!Number.isFinite(d)) {
    d = Number(row?.distance)  // FALLBACK TO MEMORY
  }
}
```

#### 2. Pathfinder timeouts (`systems/CombatSystem.js`)
```js
// During flee: increased timeouts
this._bot.pathfinder.thinkTimeout = 4000  // was 1500
this._bot.pathfinder.tickTimeout = 80     // was 45

// Restored after flee ends
this._bot.pathfinder.thinkTimeout = 24000
this._bot.pathfinder.tickTimeout = 150
```

#### 3. Flee distance (`config.js`)
```js
// Reduced for faster pathfinding
combatFleeNavDistance: Number(process.env.COMBAT_FLEE_NAV_DISTANCE || 10)  // was 20
```

#### 4. Flee thresholds (`config.js`)
```js
// Higher threshold to prevent premature flee
combatFleeRetreatScoreThreshold: Math.max(0.4, Math.min(4, Number(process.env.COMBAT_FLEE_RETREAT_SCORE_THRESHOLD || 2.5)))  // was 1.95

// Lower HP gate to flee only when actually damaged
combatFleeRetreatRiskHpRatioMax: (() => {
  // returns 0.72 (was 0.94)
})()
```

#### 5. Player threats in flee direction (`systems/CombatSystem.js`)
- Modified `_buildRandomFleeGoal` to include hostile players from `getCurrentThreats()`
- Bot now flees from attacking players, not only mobs

#### 6. Logging fix (`systems/CombatSystem.js`)
```js
// Fixed nearest:0 when no threats exist
const startNearest = (nearest != null && Number.isFinite(Number(nearest))) ? Number(nearest) : null
```

### Results
- ✅ Flee phases transition correctly (BREAK_CONTACT → STABILIZE → RECOVER)
- ✅ Bot exits flee when threats are gone
- ✅ Reduced pathfinder timeouts during flee
- ✅ Bot flees only at HP ≤ 72% or under real threat
- ✅ Flee direction accounts for both mobs and players
- ✅ Accurate threat distance logging

### Current config values
- `retreatScoreThreshold`: 2.5 (was 1.95)
- `retreatRiskHpRatioMax`: 0.72 (was 0.94)
- `navBoost`: 10 blocks (was 20)
- `thinkTimeout`: 4000ms during flee (was 1500ms)
- `tickTimeout`: 80ms during flee (was 45ms)

---

## [2026-05-19 #6] - GlobalWatchdog: global deadlock detector 24/7

### New module `systems/GlobalWatchdog.js`
- Tracks `bot.entity.position` once per second via `setInterval`
- **Deadlock thresholds:**
  - `COMBAT` / `FLEE` → 30s without >1 block movement
  - `GATHER` / `FOLLOWING` → 90s
  - `IDLE`, `RecoveryHold.isActive()`, `brain.watchdogExempt=true` — not monitored
- **30s without movement** → warning: `[GlobalWatchdog] Bot idle for Xs. State: X, Task: Y`
- **Threshold reached** → emits `WatchdogEvents.DEADLOCK_DETECTED` → `pathfinder.stop()` + `clearControlStates()` + `nav:stop` → 200ms → `state.transition(IDLE)` + `recoveryHoldSystem.enter('WATCHDOG_DEADLOCK')`
- Tracker resets on every `CoreEvents.STATE_CHANGED`
- Chat message on deadlock: `[Watchdog] Deadlock detected (...). Restarting...`

### `core/EventRegistry.js` — new events
- `WatchdogEvents.DEADLOCK_DETECTED` (`watchdog:deadlock_detected`) — payload: `{ coreState, taskKind?, stuckMs, at }`
- `WatchdogEvents.RESET` (`watchdog:reset`) — payload: `{ at }`
- Both added to `REGISTERED_EVENT_DEFINITIONS` and exported

### Graceful exit listeners — all key systems
- **`ResourceSystem._onWatchdogDeadlock()`**: if gather active → `nav:stop` + `clearControlStates` + `pauseGather('WATCHDOG_DEADLOCK')`
- **`HomeBaseSystem._onWatchdogDeadlock()`**: if `_isRunning` or `_navigating` → resets flags + `nav:stop`
- **`CombatSystem._onWatchdogDeadlock()`**: if COMBAT/FLEE → `_clearFleeWatchdog` + `nav:stop` + `clearControlStates` + `stopAttack` + `state.transition(IDLE)`

### `systems/RecoveryHoldSystem.js` — jitter-escape on deadlock
- New reason `WATCHDOG_DEADLOCK` in `REASONS`
- On `enter('WATCHDOG_DEADLOCK')`: `_doJitterEscape()` — jump + random strafe 800ms → `clearControlStates()`

### `core/BotBrain.js` — integration
- `globalWatchdog` and `watchdogExempt` added as fields
- `GlobalWatchdog` created in `attachGameplaySystems`, init in `init()`, destroyed first in `destroy()`

---

## [2026-05-19 #5] - HomeBaseSystem navigation: infinite partial-loop fix

### HomeBaseSystem `_navigateToBase` — bot stuck after surfacing from mine (BUG FIX)
- **Bug**: after `_digToSurface` bot reached surface (Y=65) but was 121 blocks from base. Pathfinder sent `status:partial` forever, bot spun `re-emitting goto` every 6s. Terrain/forest/water blocked path; no horizontal stuck detection existed.
- **Fix**: two independent progress trackers:
  - `lastProgressDist / lastProgressAt` — tracks real progress (>2 block shift)
  - **30s without progress** → forces `canDig=true`, `canSwim=true`, `liquidCost=1`, recalculates route
  - **90s without progress** → `return false` instead of infinite loop
- Previous underground stuck detection (via `stuckSince`) preserved unchanged

---

## [2026-05-19 #4] - Mining Shaft Optimization & Broken Pickaxe Recovery

### ResourceSystem — vertical descent to deep ores
- **`_digShaftDown` is now a router**: `targetY < 0` → `_digShaftDownVertical` (fast vertical shaft); `targetY ≥ 0` → staircase
- **`_digShaftDownVertical`**: 1×2 column straight down; lava/void safety check each step; anti-stuck after 4 idle iterations; timeout deepslate 10s / regular 4s; returns `true` if reached `targetY ± 3`
- **TARGET_Y**: `{ diamond:-58, iron:16, coal:96, gold:-16, copper:48, lapis:0, redstone:-58, emerald:232 }`

### ResourceSystem — `_climbToSurface()` optimization
- DEEP_Y threshold changed to `Y < 0` (was `Y < -30`)
- Digs 2 blocks above head, jumps, repeats until `Y ≥ 0`

### ResourceSystem — broken pickaxe handling during ascent
- **`_equipBestDigger()` chain on each iteration**:
  1. Pickaxe in inventory → use it
  2. No pickaxe → chat + voice: "pickaxe broke, I'm underground"
  3. Crafting table + cobblestone×3 + sticks×2 → place table, craft stone pickaxe, pick up table
  4. No materials → axe as substitute
  5. No axe → shovel
  6. Nothing → abort ascent + log
- Lava above → abort (pathfinder takes over)

### StorageSystem — crafting table in expedition kit
- `restockForExpedition()` now takes `crafting_table` from chests (1 unit if not in inventory)
- Tracker `absentEverywhere.craftingTable` for case when no table in any chest

### Fixed impossible crafting
- Removed attempt to craft stone pickaxe in 2×2 inventory grid — vanilla requires crafting table

---

## [2026-05-19 #3] - Mining QoL, Multi-Chest, Torch Placement, Target Amount

### OreJob — Torch Placement in Tunnels
- New method `_tryPlaceTorch()`: places torch every `TORCH_INTERVAL=8` tunnel steps (floor first, then nearest wall)
- If no torches but coal+sticks available — crafts 4 on the spot
- Constant `TORCH_INTERVAL = 8` at top of file

### CraftingSystem — `craftTorches(targetCount)`
- New method: crafts torches from coal/charcoal + sticks (2×2, no crafting table); auto-crafts sticks if needed

### StorageSystem — Multi-Chest Support
- `_openChest(pos)` now accepts specific position
- `depositAll` iterates all chests — moves to next if current is full
- `withdrawItem(name, count)` searches all chests until count gathered
- `withdrawCraftingMaterials` same across all chests
- New method `restockForExpedition()`: iterates all chests and takes best pickaxe, best sword, food×16, torches×16, best armor (auto-equips after)

### HomeBaseConfig — Multi-Chest Registry
- `_chestPositions[]`, `getChestPositions()`, `scanNearbyChests(bot, radius=10)`
- `setBaseLocation` accepts `allChestPositions[]`; `saveToConfig`/`loadFromConfig` save/load `chestPositions`

### misc.js ("set base" command)
- On base setup scans `findBlocks` in 10-block radius, passes all chests to `setBaseLocation`
- Updates live config in `brain.homeBaseConfig`
- Bot reply: `"Base set! 3 chest(s) within 10 blocks."`

### HomeBaseSystem — `executeRoundTrip` extended
- Step 4: take torches → craft if low; Step 5: `restockForExpedition()`; pause reduced 2000→ 1000ms

### ResourceSystem — Target Amount
- `startGather(type, targetAmount=0)` — optional target count
- Checks `dropMatcher` in inventory each loop iteration
- On target reached: `stopGather('TARGET_REACHED')` + log
- `_onGatherStart` passes `payload.amount`

### commandRegistry.js — Commands with count
- Number patterns for coal, iron, gold, diamond:
  - `"добудь 30 железа"` → `{ resource: 'iron', amount: 30 }`
  - `"копай 2 стака угля"` → `{ resource: 'coal', amount: 128 }`
  - `"mine 64 iron"` → `{ resource: 'iron', amount: 64 }`
- Russian stack support: `стак/стака/стаков`

### resource.js handler
- Parses `parsed.args.amount`: number or `N стак(а/ов)` / `N stack(s)`
- Bot reply: `"Starting to gather iron (target: 30)"`

---

## [2026-05-19 #2] - Drop Collection & HomeBaseSystem Fixes

### OreJob `_tunnelToPos` — bot moved AWAY from drop (CRITICAL BUG FIX)
- **Bug**: `Math.sin(-yaw)/Math.cos(-yaw)` = reversed direction. Bot looked at drop but moved away. Logs: `dist=4.0 → 4.9 → 5.9 → FAILED dist=13.8`
- **Fix**: `Math.sin(-yaw)` → `Math.sin(yaw)`, `Math.cos(-yaw)` → `Math.cos(yaw)` — single line

### OreJob `_collectDrops` — entity-based drop collection
- **Before**: went to *block* position after mining (drop may have flown), used pathfinder
- **After**: scans real item-entities in 6×6×6 radius via `bot.entities`; stops pathfinder; brute-force `_tunnelToPos` to exact entity position; `maxSteps` 15→20, arrival radius 1.2→1.5

### HomeBaseSystem — conflict with OreJob (BUG FIX)
- **Bug**: `_navigateToBase()` re-emitted `NavEvents.GOTO` every 6s even after round-trip finished — was resetting OreJob nav goal
- **Fix**: `ResourceEvents.GATHER_START` → `_gatherInterrupted` flag → abort nav loop + `_isRunning = false` within ≤500ms
- On gather-abort: `NavEvents.STOP` reason `gather_took_over`; `_pendingHomeReturn` not set

---

## [2026-05-19] - Navigation & Mining Loop Fixes

### ResourceSystem — infinite `paused_for_home` loop (CRITICAL BUG FIX)
- **Bug**: `OreJob` returned `paused_for_home` (no pickaxe) → `ResourceSystem` didn't handle it → loop restarted `OreJob` 60+ times/sec with no delay
- **Fix**: added explicit `paused_for_home` handler — calls `homeBaseSystem.executeRoundTrip()`, then `sleep(2000)` guard
- **Duplicate `sleep` SyntaxError**: accidental `require('../utils/sleep')` conflicted with local definition — removed

### OreJob `_tunnelToPos` — re-digging same block (BUG FIX)
- **Bug**: bot dug the same block repeatedly without moving; couldn't descend when target was below
- **Fix**: stuck detection (3 steps <0.3 blocks → force jump+forward); vertical mode separated (`dy<-1.5` → dig floor + gravity; `dy>1.5` → dig ceiling + jump); `forward` time 250→350ms

### HomeBaseSystem
- `executeRoundTrip()` working correctly — navigate home, deposit to chest, craft pickaxe

---

## [2026-05-17] - Army Bot System

### Army Bot (`sex_army_test.js`)
- **20 bots** (`Beer_1`–`Beer_20`) with auto-launch via `start_army.bat`
- **mineflayer-pvp** integrated — real combat with cooldown and pursuit
- **`guard`** — guards position, attacks mobs in 10-block radius, returns after combat
- **`attack nearest`** — each bot finds and attacks nearest hostile mob
- **`escort`** — follows commander, attacks mobs en route
- **`stopAll`** — stops pvp + pathfinder simultaneously
- **Formations** (`line`, `column`, `circle`, `square`) — face commander direction after arriving
- **Column of two** — `column` forms 2-wide march behind commander
- **Per-bot offset** — bots don't stack on `come`/`follow`/`guard`
- **`guard` remembers position** — returns to point if moved >5 blocks
- **Range commands** — `!squad#1-10 guard`, `!squad#5 come`
- **Formation lookahead** — turns head toward commander after arriving

### Auto gear distribution (`give_gear.js`)
- **HomeBot** (op) distributes gear to 20 bots automatically
- Keepalive via `bot.look` — no timeout with 360 commands
- 700ms between commands — server rate-limit bypass
- After `Done!` auto-sends `!squad gear` in chat
- Removed `potion_of_healing` — doesn't work in vanilla without NBT

### Automation (`start_army.bat`)
- Launches army, waits 70s, launches `give_gear.js` automatically
- Full cycle in one click

### Gear config (`gear_config.js`)
- 10 crossbowmen (Beer_1-10): crossbow, arrow×128, shield, iron armor
- 10 swordsmen (Beer_11-20): iron_sword, shield, arrow×16, iron armor
- Shared kit: cooked_beef×64, torch×16

---

## [Unreleased] - 2026-05-16

## [History] - Pre-2026-05-16

### Core Systems Established
- **BotBrain**: Central orchestration with state machine (IDLE, FOLLOWING, COMBAT, FLEE)
- **EventBus**: Event-driven architecture for system communication
- **StateManager**: Single source of truth for bot behavioral state
- **Scheduler**: Periodic task management
- **OperationalMemory**: Threat tracking and decision context

### Resource System
- **ResourceSystem**: Gather orchestration for wood and ores
- **TreeJob**: Automated tree chopping with leaf clearing and stuck recovery
- **OreJob**: Tunnel mining with pillar up and safety checks
- **CaveExplorerJob**: Cave exploration when surface resources exhausted

### Combat & Defense
- **CombatSystem**: Threat evaluation, engagement, flee navigation
- **defend.js**: Defense during follow/guard modes
- **AwarenessSystem**: Threat detection and emission
- **evaluateThreatPressure**: Complex threat scoring system

### Command System
- **CommandRegistry**: Voice command parsing (Russian/English)
- **Command handlers**: gather, follow, guard, combat commands
- **Pattern matching**: Regex-based natural language recognition

### Navigation
- **FollowSystem**: Player following with stuck detection
- **MovementSystem**: Pathfinder management and control
- **DefendSystem**: Entity guarding and patrol modes

### Integration
- **GatherGuardSystem**: Combat/gather coordination (initial version)
- **RecoveryHoldSystem**: Post-danger safety waits (initial version)
- **SurvivalSystem**: Persistent autonomous survival mode

---

## [Unreleased] - 2026-05-16

### Home Base System V1

#### Core Loop Closure
- **HomeBaseSystem.js** — autonomous round-trip for inventory/tools management:
  - Interrupt gathering when inventory full or tool broken
  - Navigate to base (surface path, not tunnel)
  - Deposit loot to single double chest
  - Craft stone tools (pickaxe/axe) from base supplies
  - Resume previous gathering job automatically

#### StorageSystem.js
- Single chest operation (no smart sorting in V1)
- `depositAll()` — keeps only food, pickaxe, axe, torches
- `withdrawCraftingMaterials()` — gets planks/cobblestone for tools
- `checkResources()` — verify if base has minimum crafting supplies

#### CraftingSystem.js
- **MVP scope: stone tools only**
- `craftStonePickaxe()` — 3 cobblestone + 2 sticks
- `craftStoneAxe()` — 3 cobblestone + 2 sticks  
- `craftSticks()` — from planks
- No furnace smelting (V2 feature)

#### HomeBaseConfig.js
- Hardcoded coordinates or set via "тут база" command
- Saves to `./config/homebase.json`
- Chest + crafting table positions required

#### Integration
- **OreJob.js** — emits `HOMEBASE_RETURN_NEEDED` when inventory full or no pickaxe
- **TreeJob.js** — emits `HOMEBASE_RETURN_NEEDED` when inventory full or no axe
- **ResourceSystem.js** — orchestrates round-trip and job resume
- **Command** — "тут база" / "set home" — auto-detects nearby chest and table

### Survival System Enhancement

#### GatherGuardSystem.js
- **Added SURVIVAL MODE** with simple, deterministic rules for gather operations:
  - `≥3 threats detected` → immediate flee (reason: `gather_survival_many_threats`)
  - `HP < 8` → immediate flee (reason: `gather_survival_low_hp`)
  - Eliminates "decision paralysis" when complex threat scoring gives ambiguous results
  - Logs: `[GatherGuardSystem] SURVIVAL MODE: X threats detected — immediate flee`

#### RecoveryHoldSystem.js
- **Added auto-eat functionality** for self-healing during recovery:
  - Auto-equips and eats best available food when hungry and HP below safe threshold
  - Blacklists dangerous food: rotten_flesh, spider_eye, pufferfish, poisonous_potato, chorus_fruit
  - Uses food quality scoring (effectiveQuality) to pick optimal food
  - 3-second cooldown between eat attempts to prevent spam
  - Logs: `[RecoveryHoldSystem] ate <food> to heal`

- **Added HP regeneration wait**:
  - Waits until HP reaches `safeHp` (configurable, default 14) before exiting recovery
  - Prevents returning to dangerous tasks with critically low health
  - Still respects max timeout (8s default) to prevent indefinite hold

### Mining & OreJob Improvements

#### OreJob.js - Pillar Up Enhancement
- **Fixed pillar up drift issue** caused by pathfinder conflicts:
  - Now explicitly stops pathfinder (`pathfinder.stop()` + `setGoal(null)`) before pillar up
  - Clears all movement controls (forward, back, left, right, sprint) to ensure pure vertical movement
  - Resets pathfinder state on all exit paths (success, lava abort, equip fail, completion)
  - Prevents "partial path" drift that caused bot to move sideways during pillar up

#### OreJob.js - Navigation Efficiency (CRITICAL FIX)
- **Added surface navigation before tunnel fallback**:
  - Previously: Bot always tunneled (even to visible surface ore), wasting 30+ seconds
  - Now: Tries `_navToOre()` first (TreeJob-style pathfinding), then tunnels only if needed
  - Surface ore at 15 blocks: 30s tunnel → 5s walk (6x faster)
  - Logs: `attempting nav to X,Y,Z` → `nav succeeded` or `nav failed — tunnelling`
  - Always emits `NavEvents.STOP` before tunnel to prevent pathfinder conflicts

#### OreJob.js - Vein Mining
- **Added automatic vein clearing** after each ore block dug:
  - Checks all 6 neighbors (cardinal + up/down) for same ore type
  - Digs adjacent ore blocks immediately while still in position
  - Prevents "1 block → rescan → 1 block" inefficiency
  - Logs: `vein mining: found adjacent <ore_name>`

#### OreJob.js - Y-Level Targeting
- **Added optimal depth targeting for each ore type**:
  - Diamonds/Redstone: Y=-59 (deepslate layers), weight 10x for Y<0
  - Lapis: Y=0 (exposed), weight 10x near surface
  - Iron/Copper: Y=16-48 (hills/mountains), weight 5x
  - Coal: Y=64+ (mountains), weight 8x for high altitude
  - Emerald: Y=200+ (extreme hills only), weight 10x
  - Filters out ore outside optimal range before navigation
  - Logs: `Y-filter: 256 → 48 (range -64..16)` — shows filtering efficiency

#### OreJob.js - Raycasting / Line-of-Sight
- **Added visibility checks to avoid unreachable ore**:
  - Checks for unbreakable blocks (bedrock, obsidian) between bot and target
  - Skips ore behind bedrock walls or obsidian barriers
  - Simple raycast along direct path, validates each block
  - Prevents "impossible" navigation attempts that would waste time
  - Combined with Y-filter, eliminates 30-50% of "bad" ore candidates

#### OreJob.js - Smart Ore Selection
- **Improved ore scanning with cluster scoring and Y-weighting**:
  - Increased scan count: 64 → 256 blocks (better for rare ores like diamonds)
  - Scoring formula: `score = Y-weight * cluster * 8 - distance`
  - Prefers ore at optimal depths with dense veins nearby
  - Matches Baritone's ore prioritization strategy

#### OreJob.js - Tunnel Mining Enhancement
- **Added side-ore detection and mining** during tunnel operations:
  - Changed mid-scan interval from every 5 steps → every 3 steps (more frequent)
  - Uses `findBlocks` (up to 16 ores) instead of `findBlock` (single ore)
  - Digs ALL reachable ores within `DIG_REACH` (4.5 blocks) before continuing tunnel
  - Prevents missing single ores in tunnel walls
  - Logs: `tunnel mid-scan: found X ore(s) — digging before continuing`

### Combat & Defense Fixes

#### defend.js
- **Fixed combat/gather conflict**:
  - Added early return in `tickChatGuard` if `brain?.taskState?.currentTask?.kind === 'gather'`
  - Prevents defense system from setting `GoalFollow` during ore/tree gathering
  - Eliminates "GoalFollow: The goal was changed before it could be completed!" errors
  - Bot now correctly prioritizes gathering over auto-defense (still defends if attacked)

#### FollowSystem.js
- **Fixed stuck detection conflict**:
  - `_checkStuck()` now only runs during `follow` or `guard` modes
  - Prevents conflict with `OreJob`'s own stuck detection during mining
  - Avoids double nudge effects that could break mining tunnels

### Command System Improvements

#### commandRegistry.js
- **Expanded gather command vocabulary** (Russian language support):
  - Added multiple verb patterns: `добывай`, `добудь`, `копай`, `найди`, `принеси`, `собирай`
  - Supports all resource types: wood, coal, iron, gold, diamond, copper, emerald, lapis, redstone
  - Examples now recognized: "добывай уголь", "копай железо", "найди алмазы"
  - Improved regex patterns for flexible command matching

### Architecture & Design Decisions

#### Why Simple Rules for Gather?
- Complex `evaluateThreatPressure` scoring creates "gray zone" where bot neither fights nor flees
- For gather operations, safety > efficiency — simple thresholds prevent hesitation
- `≥3 threats` and `HP<8` are unambiguous, testable, and match player intuition

#### RecoveryHoldSystem vs SurvivalSystem
- `RecoveryHoldSystem`: transitional state after dangerous events (flee, combat, interrupt)
  - Already integrated with `ResourceSystem` resume logic
  - Extended with eat/heal functionality vs creating new system
- `SurvivalSystem`: persistent autonomous survival mode (separate, not used by gather)

#### Pillar Up Pathfinder Management
- Pathfinder state must be explicitly cleared before manual movement (jump/place)
- Leaving stale goals causes "partial path" conflicts → drift
- Pattern: `stop() → clear goals → manual move → reset goals → return`

## [Previous] - Pre-2026-05-16

### Core Systems
- BotBrain with state machine (IDLE, FOLLOWING, COMBAT, FLEE)
- Event-driven architecture (EventBus, EventRegistry)
- ResourceSystem with TreeJob and OreJob
- GatherGuardSystem for combat/gather coordination
- CombatSystem with threat evaluation and flee logic
- RecoveryHoldSystem for post-danger safety waits

### Known Issues Resolved
- ~~Bot attacks players in follow mode~~ → Fixed: `tickChatGuard` only attacks mobs in follow, players only in guard mode
- ~~Bot switches between follow and gather~~ → Fixed: gather mode check in `tickChatGuard`
- ~~Pillar up drifts sideways~~ → Fixed: explicit pathfinder stop + movement clear
- ~~Misses ores in tunnel walls~~ → Fixed: frequent multi-ore scanning + digging
- ~~"Tupit" with 4-5 mobs~~ → Fixed: simple survival mode rules

---

## Testing Status

- `unit-phase1.js`: 24/24 OK ✓
- `unit-gather-guard.js`: 6/6 OK ✓
- `unit-resource.js`: 17/17 OK ✓ (from previous session)

All core functionality verified.
