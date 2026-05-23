# OreJob Tunnel Mining & Pillar Up

## Overview

OreJob provides autonomous ore mining with intelligent navigation, Y-level targeting, raycasting visibility checks, vein mining, and vertical climbing (pillar up) capabilities.

## Navigation Strategy (Efficiency First)

### Flow
```
Main Loop:
    ↓
1. Find best ore (Y-filter + raycast + cluster scoring)
    ↓
2. If within DIG_REACH → dig immediately
    ↓
3. Try surface navigation (TreeJob-style pathfinding)
    ├─ Success: ore now in reach → dig
    └─ Fail: continue to tunnel
    ↓
4. Stop pathfinder, then brute-force tunnel
    ↓
5. Mid-scan every 3 steps for side ores
    ↓
6. Vein mining after each block
```

### Why Navigation First?

**Problem (v1)**: Bot tunneled even to surface ore, wasting 30+ seconds
**Solution (v2)**: Try normal navigation before tunnel

| Scenario | v1 (Always Tunnel) | v2 (Nav First) | Improvement |
|----------|-------------------|----------------|-------------|
| Surface coal (15 blocks) | 30s tunnel | 5s walk | **6x faster** |
| Cave iron (visible) | 20s tunnel | 8s nav | **2.5x faster** |
| Buried diamond | 40s tunnel | 40s tunnel | Same |

**Implementation**: `_navToOre()` probes pathfinder, falls back to `_tunnel()` with `NavEvents.STOP`

## Y-Level Targeting

### Optimal Depths by Ore Type (1.18+ Generation)

```javascript
ORE_Y_TARGETS = {
  diamond:    { min: -64, max: 16,  weight: y<0 ? 10 : 1 },  // Y=-59 best
  redstone:   { min: -64, max: 16,  weight: y<0 ? 8 : 2 },  // Deep only
  lapis:      { min: -64, max: 64,  weight: near 0 ? 10 : 2 }, // Y=0 exposed
  iron:       { min: -64, max: 320, weight: 0<y<80 ? 5 : 2 },
  copper:     { min: -16, max: 112, weight: y>0 ? 5 : 2 },
  coal:       { min: 0,   max: 320, weight: y>64 ? 8 : 4 },  // Mountains
  emerald:    { min: -16, max: 320, weight: y>200 ? 10 : 1 } // Extreme hills
}
```

**Benefits**:
- No more searching for diamonds on surface (Y=64+)
- Prioritizes deepslate layers for rare ores
- Logs: `Y-filter: 256 → 48 (range -64..16)` — shows efficiency

## Raycasting / Line-of-Sight

### Purpose
Avoid wasting time on ore behind unbreakable walls (bedrock, obsidian).

### Algorithm
```javascript
_hasLineOfSight(bot, targetPos):
  - Raycast from bot to target
  - Check each block along path
  - If unbreakable found → return false
  - Otherwise → return true

Unbreakable blocks: bedrock, obsidian, crying_obsidian, reinforced_deepslate
```

**Combined with Y-filter**: Eliminates 30-50% of "bad" ore candidates immediately.

## Vein Mining

After each ore block dug:
1. Check 6 neighbors (±X, ±Y, ±Z)
2. If same ore type and in reach → dig immediately
3. Prevents "1 block → rescan → 1 block" inefficiency

**Log**: `vein mining: found adjacent iron_ore`

## Tunnel Mining (`_tunnel` method)

### Flow
```
State: DIG_LOG (target ore unreachable)
    ↓
_stateFindSpot() → No valid standing position found
    ↓
_tunnel(targetOrePosition)
    ↓
Loop up to TUNNEL_MAX_STEPS (32):
    ├─ Check: Reached ore? (dist <= DIG_REACH) → return true
    ├─ Check: Stuck? → force dig ahead or pillar up
    ├─ Mid-scan: Every 3 steps, find and dig nearby ores
    ├─ Horizontal: Dig 2-high passage, step forward
    └─ Vertical: Dig up/down as needed
```

### Side Ore Detection (Mid-Scan)

Every 3 steps, bot scans for ores within reach:

```javascript
if (step > 0 && step % 3 === 0) {
  const nearbyOres = bot.findBlocks({
    matching: oreMatcher,
    maxDistance: DIG_REACH,  // 4.5 blocks
    count: 16                // Up to 16 ores
  })
  // Dig ALL found ores before continuing
  for (const ore of nearbyOres) {
    await _digBlock(ore)
  }
}
```

**Why every 3 steps?**
- Balance between speed and thoroughness
- 5 steps allowed too many ores to be passed
- 1 step would be too slow (constant scanning)

**Why `findBlocks` instead of `findBlock`?**
- `findBlock` returns single closest match
- `findBlocks` returns all matches (up to `count`)
- Critical for ore veins where multiple blocks are exposed

### Stuck Recovery

Bot detects stuck when:
- No X/Z movement for 3 seconds
- Pathfinder has active goal

Recovery actions (priority order):
1. **Blocks ahead**: Force dig 2-high passage
2. **Air ahead, air above, air further above**: Pillar up (stuck in open cave)
3. **Air ahead, blocks above**: Dig up to climb

## Pillar Up (`_pillarUp` method)

### Use Cases
- Stuck in open cave (nothing to dig to climb out)
- Need to reach ore above current position
- Escaped into open space after digging

### Algorithm
```javascript
_pillarUp(targetY):
  // 1. Safety checks
  - No lava/water below
  - No gravel/sand above (falling block danger)
  - Has placeable blocks (cobblestone, dirt, stone, etc.)

  // 2. Stop pathfinder (CRITICAL)
  bot.pathfinder.stop()
  bot.pathfinder.setGoal(null)
  bot.setControlState('forward', false)
  bot.setControlState('back', false)
  ... (clear all movement)

  // 3. Scaffolding loop
  while currentY < targetY:
    - Equip block
    - Look straight down
    - Jump + place block under self
    - Land on new block

  // 4. Reset pathfinder
  bot.pathfinder.setGoal(null)  // Clean state for next navigation
```

### Pathfinder Management

**Why explicit pathfinder stop?**
- Pathfinder may have partial path calculated
- During manual jump/place, pathfinder fights for control
- Result: Bot drifts sideways ("partial path" effect)

**Pattern used:**
```javascript
// Before manual movement:
pathfinder.stop()
pathfinder.setGoal(null)
clearAllMovement()

// Manual movement sequence:
// ... jump, place, etc. ...

// After completion:
pathfinder.setGoal(null)  // Ensure clean state
```

## Constants

```javascript
DIG_REACH = 4.5           // Max distance to dig without moving
TUNNEL_MAX_STEPS = 32     // Max tunnel iterations before giving up
TUNNEL_STUCK_MS = 3000    // Time before considering stuck
PARTIAL_LIMIT = 4         // Partial paths before abandoning spot
NAV_TIMEOUT_MS = 12000    // Hard nav deadline

// Pillar up
PLACEABLE = /^(cobblestone|stone|dirt|andesite|granite|diorite|netherrack|deepslate|cobbled_deepslate)$/i
```

## Safety Features

### Danger Block Detection
```javascript
DANGER_BLOCKS = /^(lava|flowing_lava|water|flowing_water)$/i
GRAVITY_BLOCKS = /^(gravel|sand|red_sand)$/i

// Checked before:
- Digging down (lava below)
- Digging up (gravel above)
- Pillar up (lava below, gravel above)
- Tunnel step (danger ahead)
```

### Lava Avoidance
- Immediate abort if lava detected in dig path
- Pillar up aborts if lava appears below during climb
- No recovery attempted — returns `false`, lets caller decide

## Logs

```
[OreJob] tunnel: stuck in open cave — trying pillar up
[OreJob] pillar up: scaffolding from y=32 to y=38
[OreJob] pillar up: succeeded at y=38
[OreJob] tunnel mid-scan: found 3 ore(s) — digging before continuing
[OreJob] tunnel: unsafe below (danger:lava) — aborting
```

## `_tunnelToPos` — Tunnel to Drop Position

Used when ore drops on the ground and bot needs to navigate to pick it up.

### Flow
```
1. horizDist > 1.2 → HORIZONTAL mode
   - yaw = atan2(-rawDx, -rawDz)
   - aX = bx + round(sin(yaw))   ← forward direction
   - aZ = bz + round(cos(yaw))
   - Dig 2-high passage ahead
   - If dy < -1: also dig floor ahead
   - forward 350ms

2. horizDist < 1.2 && dy < -1.5 → GO DOWN
   - Dig floor block below
   - Wait for gravity (200ms)

3. horizDist < 1.2 && dy > 1.5 → GO UP
   - Dig ceiling + block above
   - Jump 350ms

4. STUCK DETECTION (every step)
   - If bot moved < 0.3 blocks over 3 steps
   - → jump + forward 400ms to break free
```

### Key Fixes
- **(2026-05-19 #1)** **Repeated same-block dig**: bot was re-digging same block because `forward` (250ms) wasn't enough to move. Fixed: increased to 350ms, added stuck detection.
- **(2026-05-19 #1)** **Not descending**: when `dy < -1.5` and `horizDist < 1.2`, bot now digs floor and waits for gravity.
- **(2026-05-19 #2)** **Bot walked AWAY from drop**: `aX/aZ` used `sin(-yaw)/cos(-yaw)` = reverse direction. Fixed: `sin(yaw)/cos(yaw)`. Logs showed dist growing 4.0→4.9→5.9→FAILED.

### Constants
```javascript
maxSteps = 20          // Max iterations (was 15)
arrival radius = 1.5   // Pickup range in blocks (was 1.2)
stuck threshold = 0.3  // Min blocks moved per step
stuck trigger = 3      // Steps before jump recovery
forward time = 350ms   // Time to hold forward per step
```

## `_collectDrops` — Entity-Based Drop Collection

Called after dig if drop was not auto-collected. Uses real item-entity positions.

### Flow
```
1. Emit NavEvents.STOP — kill pathfinder immediately
2. Scan bot.entities — filter type=object/objectType=1
   within 6 blocks XZ and 6 blocks Y
3. Sort by distance (closest first)
4. For each drop entity:
   - If distToDrop <= 1.5 → wait 300ms for auto-pickup
   - Else → _tunnelToPos(drop.position) bruteforce
   - Wait 400ms after each
5. Skip if entity already disappeared (collected)
```

### Why entity position vs block position
- Ore block position = where the block **was**
- Drop entity position = where the item **is now** (may have fallen/slid)
- Entity approach eliminates misses when drop rolls into adjacent block

## `_tryPlaceTorch` — Automatic Torch Placement

Called every `TORCH_INTERVAL=8` tunnel steps to light the tunnel.

### Flow
```
1. Check inventory for torch item by registry ID
2. If no torches → try to craft:
   - Need coal/charcoal + sticks in inventory
   - bot.recipesFor(torchId, null, 1, null) — no table needed
   - Crafts 1 batch (4 torches)
3. If still no torch → return silently
4. Try floor placement: blockAt(bx, footY-1, bz) with face (0,1,0)
5. Fallback: try all 4 walls, place on first solid one
6. Log: "torch: placed on floor/wall at x,y,z"
```

### Constants
```javascript
TORCH_INTERVAL = 8   // Place torch every N tunnel steps
```

## `_collectDrops` — Entity-Based Drop Collection

Called after dig if drop was not auto-collected. Uses real item-entity positions.

### Flow
```
1. Emit NavEvents.STOP — kill pathfinder immediately
2. Scan bot.entities — filter e.name === 'item'
   within 8 blocks XZ and 6 blocks Y
3. Sort by distance (closest first)
4. For each drop entity:
   - walkToEntity() — move toward entity position
   - Arrival radius: 2.5 blocks (increased from 2.0 to fix oscillation)
   - Wait 500ms on arrival for auto-pickup
5. Skip if entity already disappeared (collected)
```

### Key Fix (2026-05-19)
- Filter changed from `objectType===1` to `e.name === 'item'` — fixes no-drop-found bug
- Arrival radius increased `2.0 → 2.5` — fixes stuck oscillation near drops
- `DIG_TIMEOUT_MS` reduced `8000 → 3000` — faster recovery on unreachable blocks

### Why entity position vs block position
- Ore block position = where the block **was**
- Drop entity position = where the item **is now** (may have fallen/slid)
- Entity approach eliminates misses when drop rolls into adjacent block

## Integration

- **`_tryPlaceTorch` triggered by**: `_tunnel()` every `TORCH_INTERVAL` steps
- **`_collectDrops` triggered by**: after main ore dig + after vein mining
- **No pathfinder**: all methods stop nav before executing
