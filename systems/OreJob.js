'use strict'

/**
 * OreJob v2 — simple linear mining loop, no FSM state cache.
 *
 * Flow per iteration:
 *   1. findBlock → nearest ore not in _failed and within vertical limit
 *   2. If within DIG_REACH → dig directly
 *   3. Else try nav to a standing spot within reach
 *   4. If nav fails → brute-force tunnel toward ore
 *   5. After dig → collect drops, rescan
 *   6. If ore unreachable after tunnel → mark _failed, move on
 */

const { Vec3 } = require('vec3')
const { getFreeSlots } = require('../utils/inventoryValue')
const { dropJunk, shouldDropJunk } = require('../utils/InventoryManager')
const { NavEvents } = require('../core/EventRegistry')
const { equipBestPickaxe, equipBestShovel } = require('../utils/equipBestTool')
const { BaseJob } = require('./BaseJob')

/** Resource telemetry counters for NULLBIT Launcher (shared with TreeJob) */
let oreMinedCount = 0
let oreFailedCount = 0
let tunnelFallbackCount = 0
let lastOreJsonEmit = 0

/** @private Emit resource debug JSON for NULLBIT Launcher (throttled: once per 5 sec) */
function _emitOreJobDebug (extra = {}) {
  try {
    const now = Date.now()
    if (now - lastOreJsonEmit < 5000 && !extra.summary) return
    lastOreJsonEmit = now
    
    const payload = {
      type: 'resource',
      trees: 0, // OreJob doesn't chop trees
      ores: oreMinedCount,
      fallbacks: tunnelFallbackCount,
      dangerStops: 0, // Tracked separately
      status: extra.summary ? 'SUMMARY' : (extra.status || 'MINING'),
      summary: extra.summary || null,
      job: 'OreJob',
      ...extra
    }
    console.log(JSON.stringify(payload))
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
/** Max distance to dig ore without moving — matches player survival reach */
const DIG_REACH = 4.5
/** Optimal distance for mining - bot will try to get this close */
const OPTIMAL_DIG_DISTANCE = 3.0
/** Nav goal arrival range */
const SPOT_NAV_RANGE = 1
/** Nav stall timeout before giving up on a spot */
const NAV_STALL_MS = 4000
/** Full nav deadline per spot attempt */
const NAV_TIMEOUT_MS = 12_000
/** Consecutive partial path results before abandoning spot */
const PARTIAL_LIMIT = 4
/** Wait after arriving before dig */
const DIG_SETTLE_MS = 200
/** Wait after dig before collecting drops */
const DROPS_WAIT_MS = 1000
/** Radius to sweep for dropped items */
const DROP_COLLECT_RADIUS = 8
/** Dig timeout per block */
const DIG_TIMEOUT_MS = 3_000
/** Cooldown after failed dig before retrying */
const DIG_FAIL_COOLDOWN_MS = 1500
/** Max tunnel steps per run */
const TUNNEL_MAX_STEPS = 32
/** Hard job time limit — exit after this regardless (ms) */
const JOB_TIMEOUT_MS = 3 * 60_000
/** Dig timeout per tunnel block */
const TUNNEL_DIG_TIMEOUT_MS = 6_000
/** Max vertical distance to ore before skipping (avoids absurd tunnels) */
const MAX_ORE_VERT_DIST = 12
/** Place a torch every N tunnel steps if available */
const TORCH_INTERVAL = 8
/** Scan radius for findBlock searches */
const ORE_SCAN_RADIUS = 32

/** Y-Level targeting for optimal ore mining (1.18+ world generation)
 *  Prevents scanning surface for diamonds or bedrock for coal
 */
const ORE_Y_TARGETS = Object.freeze({
  // Deep ores — prioritize deepslate levels
  diamond: { min: -64, max: 16, weight: (y) => y < 0 ? 10 : 1 },  // Most at Y=-59
  redstone: { min: -64, max: 16, weight: (y) => y < 0 ? 8 : 2 },  // Most at Y=-59
  lapis: { min: -64, max: 64, weight: (y) => Math.abs(y) < 16 ? 10 : 2 },  // Y=0 exposed

  // Surface/mid ores
  iron: { min: -64, max: 320, weight: (y) => y > 0 && y < 80 ? 5 : 2 },  // Hills/mountains
  copper: { min: -16, max: 112, weight: (y) => y > 0 ? 5 : 2 },
  coal: { min: 0, max: 320, weight: (y) => y > 64 ? 8 : 4 },  // High mountains
  emerald: { min: -16, max: 320, weight: (y) => y > 200 ? 10 : 1 },  // Only mountains

  // Nether ores (if in nether)
  gold: { min: -64, max: 32, weight: (y) => y < 0 ? 6 : 3 },  // Nether gold + overwater
  nether_gold: { min: 10, max: 117, weight: () => 1 },
  ancient_debris: { min: 6, max: 120, weight: (y) => y >= 15 && y <= 21 ? 10 : 1 }  // Y=15-21 best
})

/** Lava / water — abort tunnel immediately */
const DANGER_BLOCKS = /^(lava|flowing_lava|water|flowing_water)$/
/** Gravity blocks that collapse into dug space */
const GRAVITY_BLOCKS = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel|concrete_powder)$/
/** Blocks best dug with shovel */
const SHOVEL_BLOCKS = /^(dirt|grass_block|podzol|mycelium|coarse_dirt|rooted_dirt|mud|muddy_mangrove_roots|sand|red_sand|gravel|soul_sand|soul_soil|suspicious_sand|suspicious_gravel|concrete_powder|snow|snow_block|clay)$/
/** Time to hold 'forward' key per tunnel step */
const TUNNEL_STEP_MS = 400
/** Settle delay after each tunnel step */
const TUNNEL_SETTLE_MS = 150

/** Candidate standing offsets around an ore block */
const SPOT_OFFSETS = [
  [1,0,0],[-1,0,0],[0,0,1],[0,0,-1],
  [1,-1,0],[-1,-1,0],[0,-1,1],[0,-1,-1],
  [1,-2,0],[-1,-2,0],[0,-2,1],[0,-2,-1],
  [1,1,0],[-1,1,0],[0,1,1],[0,1,-1],
  [0,-1,0],
  [1,0,1],[-1,0,1],[1,0,-1],[-1,0,-1]
]

/** @param {number} ms */
const sleep = ms => new Promise(r => setTimeout(r, ms))

function _dist3 (a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z
  return Math.sqrt(dx*dx + dy*dy + dz*dz)
}

function _bk (p) { return `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}` }

/**
 * Get Y-level targeting config for a resource name.
 * Falls back to generic {min: -64, max: 320} if no specific config.
 * @param {string} resourceName
 * @returns {{min: number, max: number, weight: (y:number)=>number}}
 */
function _getYTarget (resourceName) {
  // Map resource names to ORE_Y_TARGETS keys
  const key = Object.keys(ORE_Y_TARGETS).find(k =>
    resourceName.toLowerCase().includes(k)
  )
  return key ? ORE_Y_TARGETS[key] : { min: -64, max: 320, weight: () => 1 }
}

/**
 * Simple raycast to check if target is reachable without passing through unbreakable blocks.
 * Returns true if no unbreakable blocks (bedrock, obsidian, etc.) in direct path.
 * @param {import('mineflayer').Bot} bot
 * @param {{x,y,z}} targetPos
 * @returns {boolean}
 */
function _hasLineOfSight (bot, targetPos) {
  if (!bot.entity?.position || !bot.blockAt) return true

  const start = bot.entity.position.clone()
  const end = new Vec3(targetPos.x, targetPos.y, targetPos.z)
  const dist = start.distanceTo(end)
  if (dist < 1.5) return true // Already adjacent

  // Check blocks along ray
  const dir = end.minus(start).normalize()
  const steps = Math.ceil(dist)

  for (let i = 1; i <= steps; i++) {
    const checkPos = start.plus(dir.scaled(i))
    const block = bot.blockAt(checkPos)
    if (!block) continue

    // Unbreakable blocks that would block path
    const isUnbreakable = /^(bedrock|obsidian|crying_obsidian|reinforced_deepslate)$/i.test(block.name)
    if (isUnbreakable) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// OreJob v2 — linear loop, no FSM cache
// ---------------------------------------------------------------------------
class OreJob extends BaseJob {
  /**
   * @param {object} opts
   * @param {{x,y,z}} seedPos
   * @param {Map<string,number>} failedBlocks
   * @param {()=>boolean} alive
   */
  constructor (opts, seedPos, failedBlocks, alive) {
    super()
    this._bot            = opts.bot
    this._bus            = opts.bus
    this._match          = opts.blockMatcher
    this._dropMatch      = opts.dropMatcher || opts.blockMatcher
    this._name           = opts.resourceName || 'ore'
    this._log            = opts.logger || null
    this._interrupt      = opts.shouldInterrupt || (() => false)
    this._onCollected    = opts.onBlockCollected || null
    this._seedPos        = seedPos
    this._navPollMs      = opts.navPollMs   ?? 200
    this._dropsWaitMs    = opts.dropsWaitMs ?? DROPS_WAIT_MS
    this._digSettleMs    = opts.digSettleMs ?? DIG_SETTLE_MS
    this._failed         = failedBlocks
    this._waterBlacklist = new Set() // Remember dangerous water locations
    this._alive          = alive

    // Observer for tunnel mining
    this._isNavigating = false
    this._observerInterval = null
    this._navigationPaused = false

    // Command system
    this._shouldReturnToBase = false
    this._homeBaseSystem = opts.homeBaseSystem || null
    this._pendingReturnToBase = opts.pendingReturnToBase || (() => false)

    this._partials = 0
    this._tel = {
      startMs: Date.now(), oreDigged: 0, navProbes: 0,
      totalPartials: 0, failedOres: 0, failReason: null,
      tunnelAttempts: 0, tunnelBlocks: 0
    }

    this._onPathResult = ({ status } = {}) => {
      if (status === 'partial') { this._partials++; this._tel.totalPartials++ }
    }
    this._bus.on(NavEvents.PATH_RESULT, this._onPathResult)
  }

  destroy () { this._bus.off(NavEvents.PATH_RESULT, this._onPathResult) }

  get metrics () {
    const t = this._tel
    return {
      jobType: 'ore', durationMs: Date.now() - t.startMs,
      blocksDigged: t.oreDigged, navProbes: t.navProbes,
      totalPartials: t.totalPartials, blockerClears: 0,
      failedBlocks: t.failedOres, failReason: t.failReason || null,
      tunnelAttempts: t.tunnelAttempts, tunnelBlocks: t.tunnelBlocks
    }
  }

  // ---------------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------------
  async run () {
    try {
      try { await equipBestPickaxe(this._bot) } catch (_) {}

      let tunnelFails = 0  // consecutive tunnel/nav failures across different ores
      const jobDeadline = Date.now() + JOB_TIMEOUT_MS

      while (this._alive()) {
        if (this._interrupt()) return 'interrupted'
        if (Date.now() > jobDeadline) {
          this._info(`job timeout after ${JOB_TIMEOUT_MS / 1000}s — exiting`)
          return this._tel.oreDigged > 0 ? 'complete' : 'fail'
        }

        // 0. Check if need to return home (inventory full or no tools)
        if (shouldDropJunk(this._bot, 0.85)) {
          const freed = await dropJunk(this._bot, { targetFreeSlots: 6, logger: this._log })
          if (freed > 0) this._info(`dropped ${freed} junk stacks to free space`)
        }
        const slots = getFreeSlots(this._bot)
        if (slots <= 2) {
          this._info('inventory full — returning home')
          return 'paused_for_home'
        }

        // Check for manual return to base command
        if (this._shouldReturnToBaseCheck()) {
          const result = await this._executeReturnToBase()
          if (result === 'base_return_complete') {
            this._info('returnToBase: resumed ore gathering after base trip')
            continue // Resume ore gathering
          } else {
            return 'base_return_failed'
          }
        }

        // Check for broken/missing pickaxe
        const hasPickaxe = this._bot.inventory.items().some(i => i.name.includes('pickaxe'))
        if (!hasPickaxe) {
          this._info('no pickaxe — returning home for crafting')
          return 'paused_for_home'
        }

        // 1. Find nearest ore not in failed list
        const ore = this._findOre()
        if (!ore) {
          return this._tel.oreDigged > 0 ? 'complete' : 'fail'
        }

        const oreKey = _bk(ore.position)

        // 2. Already in reach — dig immediately
        const botPos = this._bot.entity?.position
        if (botPos && _dist3(botPos, ore.position) <= DIG_REACH) {
          const ok = await this._digBlock(ore)
          if (ok) { tunnelFails = 0 } else { this._markFailed(ore.position, 'dig_failed'); tunnelFails++ }
          continue
        }

        // 3. Too far to tunnel — skip
        if (botPos && _dist3(botPos, ore.position) > TUNNEL_MAX_STEPS) {
          this._info(`ore at ${oreKey} too far (dist=${Math.round(_dist3(botPos, ore.position))}) — skipping`)
          this._markFailed(ore.position, 'too_far')
          tunnelFails++
          if (tunnelFails >= 8) { this._info('too many failures — giving up'); return this._tel.oreDigged > 0 ? 'complete' : 'fail' }
          continue
        }

        // 4. Try normal navigation first (efficient for surface/visible ores)
        this._info(`attempting nav to ${oreKey}`)
        const navOk = await this._navToOre(ore)
        if (this._interrupt()) return 'interrupted'
        if (navOk === 'retarget') {
          this._info(`navigation retargeted to closer ore`)
          continue
        }
        if (navOk === 'flooded') {
          this._info(`nav led into water — escaping and blacklisting ore`)
          await this._escapeFromWater()
          this._markFailed(ore.position, 'flooded')
          continue
        }
        if (navOk === true) {
          this._info(`nav succeeded — ore now in reach`)
          tunnelFails = 0
          continue
        }

        // 5. Check distance before tunneling - skip distant ores
        const oreDist = botPos ? _dist3(botPos, ore.position) : 0
        const MAX_TUNNEL_DISTANCE = 32  // Tunnel to ores within reasonable range
        
        if (oreDist > MAX_TUNNEL_DISTANCE) {
          this._info(`ore too far (${oreDist.toFixed(1)} > ${MAX_TUNNEL_DISTANCE}) — blacklisting and skipping`)
          this._markFailed(ore.position, 'distance_limit')
          tunnelFails++
          if (tunnelFails >= 8) { this._info('too many failures — giving up'); return this._tel.oreDigged > 0 ? 'complete' : 'fail' }
          continue
        }

        // 5a. Try navigating through existing open tunnels (no digging) before brute-forcing
        {
          const openPathOk = await this._navThroughOpenTunnel(ore.position)
          if (this._interrupt()) return 'interrupted'
          if (openPathOk) {
            this._info(`reached ore via existing tunnel — skipping dig`)
            tunnelFails = 0
            continue
          }
        }

        // 6. Nav failed — stop pathfinder then brute-force tunnel (only for close ores)
        this._bus.emit(NavEvents.STOP, { reason: 'nav_failed_will_tunnel' })
        this._info(`nav failed — tunnelling to ${oreKey} (distance: ${oreDist.toFixed(1)})`)
        const tunnelOk = await this._tunnel(ore.position)
        if (this._interrupt()) return 'interrupted'

        if (tunnelOk === 'flooded') {
          this._info('flooded zone — blacklisting ore, searching elsewhere')
          this._markFailed(ore.position, 'flooded')
          continue
        }

        if (!tunnelOk) {
          this._markFailed(ore.position, 'tunnel_failed')
          tunnelFails++
          if (tunnelFails >= 8) { this._info('too many failures — giving up'); return this._tel.oreDigged > 0 ? 'complete' : 'fail' }
          continue
        }

        // Tunnel done — loop back, _findOre will pick up ore now in reach
        tunnelFails = 0
        continue
      }
    } finally {
      this.destroy()
      const t = this._tel
      this._info(
        `telemetry ore=${this._name} seed=${_bk(this._seedPos)}` +
        ` durationMs=${Date.now()-t.startMs} oreDigged=${t.oreDigged}` +
        ` navProbes=${t.navProbes} totalPartials=${t.totalPartials}` +
        ` failedOres=${t.failedOres} tunnelAttempts=${t.tunnelAttempts}` +
        ` tunnelBlocks=${t.tunnelBlocks}`
      )
    }
    return 'interrupted'
  }

  // ---------------------------------------------------------------------------
  // Find nearest ore
  // ---------------------------------------------------------------------------
  _findOre () {
    const bot = this._bot
    const botPos = bot.entity?.position
    
    this._info(`findOre: starting search - blacklist size: ${this._failed.size}`)

    // Fast-path: check seed block directly (it's the one ResourceSystem already found)
    const s = this._seedPos
    if (s) {
      const seedBlk = bot.blockAt?.(new Vec3(Math.floor(s.x), Math.floor(s.y), Math.floor(s.z)))
      if (seedBlk && this._match.test(seedBlk.name) && !this._failed.has(_bk(seedBlk.position))) {
        return seedBlk
      }
    }

    // Use findBlocks (plural) to get candidates, with cluster scoring for veins
    if (bot.findBlocks) {
      // Larger count for rare ores - scan up to 256 blocks
      const positions = bot.findBlocks({
        matching: blk => blk != null && this._match.test(blk.name),
        maxDistance: ORE_SCAN_RADIUS,
        count: 256
      })
      // Get Y-level targeting for this resource type
      const yTarget = _getYTarget(this._name)

      // Filter by Y-range, line-of-sight, water blacklist, submerged check, and apply depth weighting
      const valid = positions.filter(p => {
        if (this._failed.has(_bk(p))) return false
        // Y-level filter: skip ore outside optimal depth range
        if (p.y < yTarget.min || p.y > yTarget.max) return false
        // Line-of-sight filter: skip ore behind unbreakable walls (bedrock, obsidian)
        if (!_hasLineOfSight(bot, p)) return false
        // CRITICAL: Skip ore that is submerged in water
        if (this._isOreSubmergedInWater(p)) return false
        // Water blacklist filter: skip ores near blacklisted water areas
        if (this._isNearBlacklistedWater(p)) return false
        return true
      })
      // Log filtering info including cluster blacklist effectiveness
      if (valid.length < positions.length) {
        const totalBlocked = positions.length - valid.length
        const failedCount = positions.filter(p => this._failed.has(_bk(p))).length
        const otherBlocked = totalBlocked - failedCount
        
        this._info(`ore filter: ${positions.length} → ${valid.length} (blocked: ${totalBlocked}, cluster: ${failedCount}, other: ${otherBlocked})`)
        
        // Extra detail for rare ores
        if (/diamond|redstone|emerald/.test(this._name)) {
          const blocked = positions.filter(p =>
            !this._failed.has(_bk(p)) &&
            p.y >= yTarget.min && p.y <= yTarget.max &&
            !_hasLineOfSight(bot, p)
          ).length
          this._info(`Y-filter details: blocked=${blocked} (range ${yTarget.min}..${yTarget.max})`)
        }
      }
      if (valid.length === 0) return null

      // Score: Distance is primary, with small bonus for Y-weight and cluster
      // This prioritizes nearest ore first (vacuum cleaner behavior)
      let best = null
      let bestScore = -Infinity
      for (const p of valid) {
        const dist = botPos ? _dist3(p, botPos) : 0
        const yWeight = yTarget.weight(p.y)
        // Count nearby ore blocks (cluster density)
        let clusterCount = 0
        for (const other of valid) {
          if (other === p) continue
          if (_dist3(p, other) <= 3) clusterCount++
        }
        // Score: -distance (primary) + small bonuses for Y-weight and clusters
        // Distance penalty is much higher than any bonus
        const score = -dist * 100 + yWeight * 2 + clusterCount * 1
        if (score > bestScore) {
          bestScore = score
          best = p
        }
      }
      if (!best) return null
      return bot.blockAt?.(new Vec3(best.x, best.y, best.z)) || null
    }

    // Last resort: single findBlock
    if (bot.findBlock) {
      return bot.findBlock({
        matching: blk => {
          if (!blk || !blk.position) return false
          if (!this._match.test(blk.name)) return false
          if (this._failed.has(_bk(blk.position))) return false
          return true
        },
        maxDistance: ORE_SCAN_RADIUS
      })
    }

    return null
  }

  // ---------------------------------------------------------------------------
  // Nav to a spot within reach of ore.  Returns true if arrived.
  // ---------------------------------------------------------------------------
  async _navToOre (ore) {
    const orePos = ore.position

    // Find walkable candidates around ore
    const spots = this._candidateSpots(orePos)

    // Probe top spots
    for (const spot of spots.slice(0, 3)) {
      if (this._interrupt()) return false
      this._tel.navProbes++
      const reached = await this._probeNav(spot, 6000)
      if (reached === 'flooded') return 'flooded'
      if (reached) {
        const navResult = await this._fullNav(spot)
        if (navResult === 'flooded') return 'flooded'
        return navResult
      }
    }

    // Last resort: nav directly to ore block position (pathfinder finds its own spot)
    if (this._interrupt()) return false
    this._tel.navProbes++
    const directReached = await this._probeNav(
      { x: orePos.x, y: orePos.y, z: orePos.z }, 8000
    )
    if (directReached === 'flooded') return 'flooded'
    if (directReached) return true

    // Final fallback: if already within DIG_REACH, dig (drop collection handled by _tunnelToPos)
    const botPos = this._bot.entity?.position
    if (botPos && _dist3(botPos, orePos) <= DIG_REACH) {
      this._info(`nav failed but ore in reach (${_dist3(botPos, orePos).toFixed(1)}) — digging directly`)
      return true
    }

    return false
  }

  // ---------------------------------------------------------------------------
  // Try to reach ore position using only ALREADY OPEN passages (canDig=false).
  // If pathfinder finds a route through existing tunnels — use it.
  // Restores canDig=true afterwards regardless of outcome.
  // Returns true if arrived within DIG_REACH.
  // ---------------------------------------------------------------------------
  async _navThroughOpenTunnel (orePos) {
    const bot = this._bot
    const botPos = bot.entity?.position
    if (!botPos) return false

    // Temporarily disable digging in pathfinder movements
    let movementsPatched = false
    try {
      if (bot.pathfinder?.movements) {
        bot.pathfinder.movements.canDig = false
        movementsPatched = true
      }
    } catch (_) {}

    this._info(`open-tunnel nav: trying existing passages to ${Math.floor(orePos.x)},${Math.floor(orePos.y)},${Math.floor(orePos.z)}`)
    this._bus.emit(NavEvents.GOTO, {
      kind: 'near',
      x: orePos.x, y: orePos.y, z: orePos.z,
      range: Math.ceil(DIG_REACH)
    })

    let arrived = false
    const deadline = Date.now() + 15_000
    let lastPos = botPos.clone()
    let lastMoveAt = Date.now()

    while (Date.now() < deadline) {
      if (this._interrupt()) break
      await sleep(300)
      const cur = bot.entity?.position
      if (!cur) break
      // Check arrival
      if (_dist3(cur, orePos) <= DIG_REACH) { arrived = true; break }
      // Abort early if bot hasn't moved at all for 4s (no open path)
      if (_dist3(cur, lastPos) > 0.3) { lastPos = cur.clone(); lastMoveAt = Date.now() }
      if (Date.now() - lastMoveAt > 4000) {
        this._info(`open-tunnel nav: no movement for 4s — no open path exists`)
        break
      }
    }

    this._bus.emit(NavEvents.STOP, { reason: 'open_tunnel_nav_done' })

    // Restore canDig
    try {
      if (movementsPatched && bot.pathfinder?.movements) {
        bot.pathfinder.movements.canDig = true
      }
    } catch (_) {}

    return arrived
  }

  // ---------------------------------------------------------------------------
  // Collect standing spot candidates around ore, sorted by score
  // ---------------------------------------------------------------------------
  _candidateSpots (orePos) {
    const bot = this._bot
    const botPos = bot.entity?.position
    const result = []
    for (const [dx, dy, dz] of SPOT_OFFSETS) {
      const sx = orePos.x + dx, sy = orePos.y + dy, sz = orePos.z + dz
      const floor = bot.blockAt?.(new Vec3(sx, sy - 1, sz))
      if (!floor || floor.boundingBox === 'empty') continue
      const head = bot.blockAt?.(new Vec3(sx, sy + 1, sz))
      if (head && head.boundingBox !== 'empty') continue
      const dist = _dist3({x:sx,y:sy,z:sz}, orePos)
      if (dist > DIG_REACH) continue
      const fromBot = botPos ? _dist3({x:sx,y:sy,z:sz}, botPos) : 0
      result.push({ x: sx, y: sy, z: sz, score: (DIG_REACH - dist) - fromBot * 0.3 })
    }
    return result.sort((a, b) => b.score - a.score)
  }

  // ---------------------------------------------------------------------------
  // Short probe nav — returns true if arrived within timeout
  // ---------------------------------------------------------------------------
  async _probeNav (spot, ms) {
    // Tell pathfinder to avoid water blocks before routing
    let waterAvoiding = false
    try {
      if (this._bot.pathfinder?.movements) {
        this._bot.pathfinder.movements.blocksToAvoid?.add('water')
        this._bot.pathfinder.movements.blocksToAvoid?.add('flowing_water')
        waterAvoiding = true
      }
    } catch (_) {}
    this._bus.emit(NavEvents.GOTO, { kind: 'near', x: spot.x, y: spot.y, z: spot.z, range: SPOT_NAV_RANGE })
    const deadline = Date.now() + ms
    const startPos = this._bot.entity?.position?.clone?.() ?? null
    const MOVEMENT_CHECK_MS = 2500  // check if bot moved after 2.5s
    const MOVEMENT_MIN = 0.5        // must have moved at least 0.5 blocks
    let movementChecked = false
    while (Date.now() < deadline) {
      if (this._interrupt()) return false
      await sleep(this._navPollMs)
      const pos = this._bot.entity?.position
      if (!pos) continue

      // Water guard — current position
      const fy = Math.floor(pos.y)
      const bx = Math.floor(pos.x), bz = Math.floor(pos.z)
      const bF = this._bot.blockAt?.(new Vec3(bx, fy, bz))
      const bH = this._bot.blockAt?.(new Vec3(bx, fy + 1, bz))
      if ((bF && /^(water|flowing_water)$/i.test(bF.name)) ||
          (bH && /^(water|flowing_water)$/i.test(bH.name))) {
        this._info('_probeNav: bot entered water — stopping')
        this._bus.emit(NavEvents.STOP, { reason: 'entered_water' })
        return 'flooded'
      }
      // Fall-into-water guard — scan column below for water within 40 blocks
      if (this._waterBelowBot(bx, fy, bz, 40)) {
        this._info('_probeNav: water below bot (cave lake) — stopping nav')
        this._bus.emit(NavEvents.STOP, { reason: 'water_below' })
        return false
      }

      if (_dist3(pos, spot) <= SPOT_NAV_RANGE + 0.8) return true
      // Early abort: if bot hasn't moved at all after MOVEMENT_CHECK_MS, pathfinder is stuck on partial
      if (!movementChecked && Date.now() - (deadline - ms) >= MOVEMENT_CHECK_MS) {
        movementChecked = true
        if (startPos && pos && _dist3(pos, startPos) < MOVEMENT_MIN) {
          this._bus.emit(NavEvents.STOP, { reason: 'probe_no_movement' })
          return false
        }
      }
    }
    this._bus.emit(NavEvents.STOP, { reason: 'probe_timeout' })
    try {
      if (waterAvoiding && this._bot.pathfinder?.movements) {
        this._bot.pathfinder.movements.blocksToAvoid?.delete('water')
        this._bot.pathfinder.movements.blocksToAvoid?.delete('flowing_water')
      }
    } catch (_) {}
    return false
  }

  // ---------------------------------------------------------------------------
  // Full nav to a spot with stall/partial detection
  // ---------------------------------------------------------------------------
  async _fullNav (spot) {
    const botPos = this._bot.entity?.position
    if (botPos && _dist3(botPos, spot) <= SPOT_NAV_RANGE + 0.5) return true

    this._partials = 0
    this._bus.emit(NavEvents.GOTO, { kind: 'near', x: spot.x, y: spot.y, z: spot.z, range: SPOT_NAV_RANGE })

    // Start tunnel observer for nearby ore detection
    this._startObserver()

    const deadline = Date.now() + NAV_TIMEOUT_MS
    let lastDist = Infinity, stalledSince = null
    let lastRetargetCheck = Date.now()

    while (this._alive() && Date.now() < deadline) {
      if (this._interrupt()) return false
      if (this._partials >= PARTIAL_LIMIT) return false
      await sleep(this._navPollMs)
      const pos = this._bot.entity?.position
      if (!pos) continue

      // ── Water guard: stop immediately if pathfinder walked bot into water ──
      const fy = Math.floor(pos.y)
      const bx = Math.floor(pos.x), bz = Math.floor(pos.z)
      const bFoot = this._bot.blockAt?.(new Vec3(bx, fy, bz))
      const bHead = this._bot.blockAt?.(new Vec3(bx, fy + 1, bz))
      if ((bFoot && /^(water|flowing_water)$/i.test(bFoot.name)) ||
          (bHead && /^(water|flowing_water)$/i.test(bHead.name))) {
        this._info('_fullNav: bot entered water during navigation — stopping')
        this._bus.emit(NavEvents.STOP, { reason: 'entered_water' })
        this._stopObserver()
        return 'flooded'
      }
      // Fall-into-water guard — scan column below for water within 40 blocks
      if (this._waterBelowBot(bx, fy, bz, 40)) {
        this._info('_fullNav: water below bot (cave lake) — stopping nav')
        this._bus.emit(NavEvents.STOP, { reason: 'water_below' })
        this._stopObserver()
        return false
      }

      const dist = _dist3(pos, spot)
      if (dist <= SPOT_NAV_RANGE + 0.5) {
        this._stopObserver()
        return true
      }
      if (lastDist - dist > 0.3) { lastDist = dist; stalledSince = null }
      else if (!stalledSince) stalledSince = Date.now()
      else if (Date.now() - stalledSince > NAV_STALL_MS) return false

      // Dynamic retargeting: check for closer ore every 2 seconds
      if (Date.now() - lastRetargetCheck > 2000) {
        lastRetargetCheck = Date.now()
        const closerOre = this._findOre()
        if (closerOre && closerOre.position) {
          const closerDist = _dist3(pos, closerOre.position)
          const currentTargetDist = _dist3(pos, spot)
          if (closerDist < currentTargetDist - 3) { // Only switch if significantly closer
            this._info(`dynamic retarget: found closer ore at ${closerDist.toFixed(1)} vs ${currentTargetDist.toFixed(1)}`)
            this._bus.emit(NavEvents.STOP, { reason: 'dynamic_retarget' })
            return 'retarget' // Special signal to retarget
          }
        }
      }
    }
    
    // Stop tunnel observer
    this._stopObserver()
    return false
  }

  // ---------------------------------------------------------------------------
  // Dig a single ore block.  Returns true on success.
  // ---------------------------------------------------------------------------
  async _digBlock (ore) {
    const fresh = this._bot.blockAt?.(ore.position)
    if (!fresh || !this._match.test(fresh.name)) return true // already gone — treat as success

    const botPos = this._bot.entity?.position
    if (!botPos) return false

    try { await equipBestPickaxe(this._bot) } catch (_) {}

    // Snapshot inventory BEFORE digging to detect auto-collect
    const oreBefore = this._countOreInInventory()
    const oreWorldPos = { x: ore.position.x, y: ore.position.y, z: ore.position.z }
    const distToOre = _dist3(botPos, ore.position)
    if (distToOre > DIG_REACH) {
      this._info(`_digBlock: ore at dist=${distToOre.toFixed(1)} > reach=${DIG_REACH} — skipping`)
      return false
    }

    const eyeY = botPos.y + (this._bot.entity?.height ?? 1.62)
    const jump = ore.position.y >= eyeY
    if (jump) this._bot.setControlState('jump', true)

    await sleep(this._digSettleMs)

    let ok = false
    try {
      const isHardOre = /deepslate|obsidian|ancient_debris/.test(fresh.name)
      await Promise.race([
        this._bot.dig(fresh, true),
        new Promise((_, rej) => setTimeout(() => rej(new Error('dig_timeout')), isHardOre ? 10_000 : DIG_TIMEOUT_MS))
      ])
      ok = true
    } catch (e) {
      this._tel.failReason = e?.message === 'dig_timeout' ? 'dig_timeout' : 'dig_error'
    } finally {
      if (jump) this._bot.setControlState('jump', false)
    }

    if (!ok) {
      await sleep(DIG_FAIL_COOLDOWN_MS)
      return false
    }

    this._tel.oreDigged++
    oreMinedCount++
    _emitOreJobDebug({ summary: `Ore mined: ${this._name} at ${_bk(oreWorldPos)}` })
    if (this._onCollected) this._onCollected()
    this._info(`dug ore at ${_bk(oreWorldPos)} dist=${distToOre.toFixed(1)}`)

    // Wait for drop to land, then check if it auto-collected into inventory
    await sleep(this._dropsWaitMs)
    const oreAfter = this._countOreInInventory()
    if (oreAfter <= oreBefore) {
      this._info(`drop not auto-collected (inv: ${oreBefore}→${oreAfter}) — scanning for item entities`)
      await this._collectDrops(oreWorldPos)
    } else {
      this._info(`drop auto-collected (inv: ${oreBefore}→${oreAfter})`)
    }

    // Vein mining: mine connected ore neighbors while in reach
    await this._mineVeinRecursively(ore.position)

    return true
  }

  /**
   * Recursively mine entire ore vein starting from position.
   * Uses BFS to find all connected ore blocks of same type.
   * @private
   * @param {{x,y,z}} startPos
   */
  async _mineVeinRecursively (startPos) {
    const bot = this._bot
    // Start BFS from neighbors of the already-broken block
    const DIRS = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]
    const queue = DIRS.map(([dx,dy,dz]) => ({ x: startPos.x+dx, y: startPos.y+dy, z: startPos.z+dz }))
    const visited = new Set([_bk(startPos)])
    let minedCount = 0

    while (queue.length > 0) {
      if (this._interrupt()) break

      const pos = queue.shift()
      const key = _bk(pos)
      if (visited.has(key)) continue
      visited.add(key)

      const block = bot.blockAt?.(new Vec3(pos.x, pos.y, pos.z))
      if (!block || !this._match.test(block.name)) continue

      // Only mine if within reach of current bot position
      const curPos = bot.entity?.position
      if (!curPos || _dist3(curPos, pos) > DIG_REACH) continue

      try { await equipBestPickaxe(bot) } catch (_) {}
      let ok = false
      try {
        const isHard = /deepslate|obsidian|ancient_debris/.test(block.name)
        await Promise.race([
          bot.dig(block, true),
          new Promise((_, rej) => setTimeout(() => rej(new Error('dig_timeout')), isHard ? 10_000 : DIG_TIMEOUT_MS))
        ])
        ok = true
      } catch (_) {}

      if (ok) {
        minedCount++
        this._tel.oreDigged++
        oreMinedCount++
        _emitOreJobDebug({ summary: `Vein ore mined: ${this._name}` })
        if (this._onCollected) this._onCollected()
        for (const [dx,dy,dz] of DIRS) {
          const nb = { x: pos.x+dx, y: pos.y+dy, z: pos.z+dz }
          if (!visited.has(_bk(nb))) queue.push(nb)
        }
      }
    }

    if (minedCount > 0) {
      await sleep(this._dropsWaitMs)
      await this._collectDrops(startPos)
      this._info(`vein mining: mined ${minedCount} extra ore blocks`)
    }
  }

  // ---------------------------------------------------------------------------
  // Try to place a torch at current bot position (on floor or wall behind).
  // Silently skips if no torches in inventory or placement fails.
  // ---------------------------------------------------------------------------
  async _tryPlaceTorch () {
    const bot = this._bot
    const torchId = bot.registry.itemsByName['torch']?.id
    let torch = torchId ? bot.inventory.findInventoryItem(torchId, null) : null

    // If no torches, try to craft from coal/charcoal + sticks in inventory
    if (!torch && torchId) {
      const coal = bot.inventory.items().find(i => i.name === 'coal' || i.name === 'charcoal')
      const sticks = bot.inventory.items().find(i => i.name === 'stick')
      if (coal && sticks) {
        try {
          const recipe = bot.recipesFor(torchId, null, 1, null)[0]
          if (recipe) {
            await bot.craft(recipe, 1)
            torch = bot.inventory.findInventoryItem(torchId, null)
            if (torch) this._info(`torch: crafted 4 torches from inventory`)
          }
        } catch (_) {}
      }
    }

    if (!torch) return

    const pos = bot.entity?.position
    if (!pos) return

    const footY = Math.floor(pos.y)
    const bx = Math.floor(pos.x)
    const bz = Math.floor(pos.z)

    // Determine movement direction from bot yaw → right-hand side wall
    // Yaw: 0=south(+z), π/2=west(-x), π=north(-z), 3π/2=east(+x)
    const yaw = bot.entity?.yaw ?? 0
    // Forward vector (rounded)
    const fwdX = Math.round(-Math.sin(yaw))
    const fwdZ = Math.round(Math.cos(yaw))
    // Right-hand side = rotate forward 90° clockwise: (fx,fz) → (fz,-fx)
    const rightX = fwdZ
    const rightZ = -fwdX

    // Try right-hand wall at head height (footY+1) first — like a player
    const wallSides = [
      [rightX, rightZ],    // right side
      [-rightX, -rightZ],  // left side
      [-fwdX, -fwdZ],      // behind
    ]
    for (const [dx, dz] of wallSides) {
      if (dx === 0 && dz === 0) continue
      for (const dy of [1, 0]) { // head height first, then foot height
        const wallBlock = bot.blockAt?.(new Vec3(bx + dx, footY + dy, bz + dz))
        if (wallBlock && wallBlock.boundingBox === 'block') {
          try {
            await bot.equip(torch, 'hand')
            await bot.placeBlock(wallBlock, new Vec3(-dx, 0, -dz))
            this._info(`torch: placed on wall at ${bx},${footY + dy},${bz} (side ${dx},${dz})`)
            return
          } catch (_) {}
        }
      }
    }

    // Fallback: floor
    const floorBlock = bot.blockAt?.(new Vec3(bx, footY - 1, bz))
    if (floorBlock && floorBlock.boundingBox === 'block') {
      try {
        await bot.equip(torch, 'hand')
        await bot.placeBlock(floorBlock, new Vec3(0, 1, 0))
        this._info(`torch: placed on floor at ${bx},${footY},${bz}`)
      } catch (_) {}
    }
  }

  // ---------------------------------------------------------------------------
  // Brute-force tunnel toward ore position.
  // Returns true if we got within DIG_REACH, false if aborted (danger/exhausted).
  // ---------------------------------------------------------------------------
  async _tunnel (orePos) {
    const bot = this._bot
    this._tel.tunnelAttempts++
    tunnelFallbackCount++
    _emitOreJobDebug({ summary: `Tunnel fallback used for ${this._name}` })

    const startPos = bot.entity?.position
    if (!startPos) return false

    const dx0 = Math.floor(orePos.x) - Math.floor(startPos.x)
    const dy0 = Math.floor(orePos.y) - Math.floor(startPos.y)
    const dz0 = Math.floor(orePos.z) - Math.floor(startPos.z)
    this._info(`tunnel start: dx=${dx0} dy=${dy0} dz=${dz0} target=${_bk(orePos)}`)

    // CRITICAL: Check if bot is in water and escape before tunneling
    const pos = bot.entity?.position
    if (pos) {
      const footY = Math.floor(pos.y)
      const cx = Math.floor(pos.x)
      const cz = Math.floor(pos.z)
      const blockAtFeet = bot.blockAt?.(new Vec3(cx, footY, cz))
      const blockAbove = bot.blockAt?.(new Vec3(cx, footY + 1, cz))
      
      if ((blockAtFeet && /^(water|flowing_water)$/i.test(blockAtFeet.name)) ||
          (blockAbove && /^(water|flowing_water)$/i.test(blockAbove.name))) {
        this._info(`tunnel: abort - bot is in water! Attempting escape...`)
        await this._escapeFromWater()
        return false
      }
    }

    let lastPos = startPos.clone()
    let lastPosTime = Date.now()
    let stuckSince = 0
    let stuckAttempts = 0

    for (let step = 0; step < TUNNEL_MAX_STEPS; step++) {
      if (!this._alive() || this._interrupt()) return false

      const pos = bot.entity?.position
      if (!pos) return false

      // Stuck detection: if not moved for 3s, force dig ahead
      const dx = Math.abs(pos.x - lastPos.x)
      const dz = Math.abs(pos.z - lastPos.z)
      if (dx > 0.05 || dz > 0.05) {
        lastPos = pos.clone()
        lastPosTime = Date.now()
        stuckSince = 0
      } else {
        if (stuckSince === 0) stuckSince = Date.now()
        const stuckMs = Date.now() - stuckSince
        if (stuckMs > 3000) {
          stuckAttempts++
          if (stuckAttempts >= 3) {
            this._info(`tunnel: stuck ${stuckAttempts} times — giving up`)
            return false
          }
          this._info(`tunnel: stuck for ${stuckMs}ms — forcing dig ahead (attempt ${stuckAttempts})`)
          const yaw = Math.atan2(-(orePos.x - pos.x), -(orePos.z - pos.z))
          const aX = Math.floor(pos.x) + Math.round(Math.sin(-yaw))
          const aZ = Math.floor(pos.z) + Math.round(Math.cos(-yaw))
          const footY = Math.floor(pos.y)
          // Debug: log what blocks are ahead
          const blockLow = bot.blockAt?.(new Vec3(aX, footY, aZ))
          const blockHigh = bot.blockAt?.(new Vec3(aX, footY + 1, aZ))
          this._info(`tunnel: digging at (${aX},${footY},${aZ})=${blockLow?.name || 'null'} and (${aX},${footY + 1},${aZ})=${blockHigh?.name || 'null'}`)
          // If path ahead is clear (air) but still stuck, check above
          if (blockLow?.name === 'air' && blockHigh?.name === 'air') {
            const upX = Math.floor(pos.x)
            const upZ = Math.floor(pos.z)
            const blockUp1 = bot.blockAt?.(new Vec3(upX, footY + 2, upZ))
            const blockUp2 = bot.blockAt?.(new Vec3(upX, footY + 3, upZ))
            // If above is also air — stuck in open cave, try pillar up
            if ((!blockUp1 || blockUp1.name === 'air') && (!blockUp2 || blockUp2.name === 'air')) {
              this._info(`tunnel: stuck in open cave — trying pillar up`)
              const oreY = Math.floor(orePos.y)
              const pillarOk = await this._pillarUp(oreY)
              if (pillarOk) {
                this._info(`tunnel: pillar up succeeded — resuming`)
                stuckSince = 0
                lastPos = bot.entity?.position?.clone() || lastPos
                lastPosTime = Date.now()
                continue // retry tunnel from new height
              }
              this._info(`tunnel: pillar up failed — aborting`)
              return false
            }
            // Blocks above — dig up to escape
            this._info(`tunnel: trapped — digging up y+2=${blockUp1?.name} y+3=${blockUp2?.name}`)
            await bot.look(bot.entity.yaw, -Math.PI / 2, true)
            await this._digIfSolid(bot, new Vec3(upX, footY + 2, upZ))
            await this._digIfSolid(bot, new Vec3(upX, footY + 3, upZ))
            bot.setControlState('jump', true)
            await sleep(800)
            bot.setControlState('jump', false)
          } else {
            // Force dig 2-high passage regardless of pathfinder
            await this._digIfSolid(bot, new Vec3(aX, footY, aZ))
            await this._digIfSolid(bot, new Vec3(aX, footY + 1, aZ))
          }
          // Step forward into cleared space
          bot.setControlState('forward', true)
          await sleep(400)
          bot.setControlState('forward', false)
          // Reset stuck timer after forced dig
          stuckSince = 0
          lastPos = bot.entity?.position?.clone() || lastPos
        }
      }

      if (_dist3(pos, orePos) <= DIG_REACH) return true

      // Place torch every TORCH_INTERVAL steps to light the tunnel
      if (step > 0 && step % TORCH_INTERVAL === 0) {
        await this._tryPlaceTorch()
      }

      const rawDx = orePos.x - pos.x
      const rawDy = orePos.y - pos.y
      const rawDz = orePos.z - pos.z
      const horizDist = Math.sqrt(rawDx*rawDx + rawDz*rawDz)
      const footY = Math.floor(pos.y)
      const bx = Math.floor(pos.x)
      const bz = Math.floor(pos.z)

      if (horizDist < 1.5 && Math.abs(rawDy) > 1) {
        // ── VERTICAL ──
        if (rawDy < 0) {
          // Dig down
          const danger = this._colSafe(bx, footY - 1, bz)
          if (danger) { 
            this._info(`tunnel: unsafe below (${danger}) - blacklisting target ore`)
            this._markFailed(orePos, 'unsafe_below')
            return false 
          }
          // Check for gravity blocks above that could trap us
          const gravAbove = this._colSafe(bx, footY + 2, bz) || this._colSafe(bx, footY + 3, bz)
          if (gravAbove && gravAbove.includes('gravity')) {
            this._info(`tunnel: unsafe above (${gravAbove}) when digging down`)
            return false
          }
          await bot.look(bot.entity.yaw, Math.PI / 2, true)
          await this._digIfSolid(bot, new Vec3(bx, footY - 1, bz))
          await sleep(TUNNEL_SETTLE_MS + 200)
        } else {
          // Dig up
          const danger = this._colSafe(bx, footY + 1, bz)
          if (danger) { 
            this._info(`tunnel: unsafe above (${danger}) - blacklisting target ore`)
            this._markFailed(orePos, 'unsafe_above')
            return false 
          }
          await bot.look(bot.entity.yaw, -Math.PI / 2, true)
          await this._digIfSolid(bot, new Vec3(bx, footY + 1, bz))
          await this._digIfSolid(bot, new Vec3(bx, footY + 2, bz))
          bot.setControlState('jump', true)
          await sleep(TUNNEL_STEP_MS)
          bot.setControlState('jump', false)
          await sleep(TUNNEL_SETTLE_MS)
        }
      } else {
        // ── HORIZONTAL ──
        const yaw = Math.atan2(-rawDx, -rawDz)
        const pitch = horizDist > 0 ? -Math.atan2(rawDy, horizDist) : 0
        await bot.look(yaw, Math.max(-1.0, Math.min(1.0, pitch)), true)

        const aX = Math.floor(pos.x) + Math.round(Math.sin(-yaw))
        const aZ = Math.floor(pos.z) + Math.round(Math.cos(-yaw))

        const danger = this._colSafe(aX, footY, aZ)
        if (danger) { 
          this._info(`tunnel: unsafe ahead (${danger}) - blacklisting target ore`)
          this._markFailed(orePos, 'unsafe_ahead')
          return false 
        }

        // Dig 2-high passage
        await this._digIfSolid(bot, new Vec3(aX, footY,     aZ))
        await this._digIfSolid(bot, new Vec3(aX, footY + 1, aZ))

        // Clear stair-down floor if going downward
        if (rawDy < -1) {
          const flr = bot.blockAt?.(new Vec3(aX, footY - 1, aZ))
          if (flr && flr.boundingBox !== 'empty' && flr.name !== 'air' &&
              !DANGER_BLOCKS.test(flr.name) && !GRAVITY_BLOCKS.test(flr.name)) {
            await this._digIfSolid(bot, new Vec3(aX, footY - 1, aZ))
          }
        }

        // Step forward
        const before = bot.entity?.position
        bot.setControlState('forward', true)
        await sleep(TUNNEL_STEP_MS)
        bot.setControlState('forward', false)
        await sleep(TUNNEL_SETTLE_MS)

        // Jump if stuck
        const after = bot.entity?.position
        if (before && after && _dist3(before, after) < 0.1) {
          bot.setControlState('jump', true)
          bot.setControlState('forward', true)
          await sleep(TUNNEL_STEP_MS)
          bot.setControlState('forward', false)
          bot.setControlState('jump', false)
          await sleep(TUNNEL_SETTLE_MS)
        }

        // ── POST-STEP ORE SWEEP ──
        const curPos = bot.entity?.position
        if (curPos && await this._scanAndDigNearby(bot, curPos, orePos)) return true
      }
    }

    // Reached step limit — return whether we're now close enough
    const finalPos = bot.entity?.position
    return !!(finalPos && _dist3(finalPos, orePos) <= DIG_REACH)
  }

  // ---------------------------------------------------------------------------
  // Scan ±5x±3x±5 cube around pos for matching ore, dig closest ones.
  // Returns true if original orePos is now within DIG_REACH after digging.
  // ---------------------------------------------------------------------------
  async _scanAndDigNearby (bot, pos, orePos) {
    const cx = Math.floor(pos.x), cy = Math.floor(pos.y), cz = Math.floor(pos.z)
    const hits = []
    for (let dx = -5; dx <= 5; dx++) {
      for (let dy = -3; dy <= 3; dy++) {
        for (let dz = -5; dz <= 5; dz++) {
          if (dx === 0 && dy === 0 && dz === 0) continue
          const v = new Vec3(cx + dx, cy + dy, cz + dz)
          const b = bot.blockAt?.(v)
          if (b && this._match.test(b.name) && !this._failed.has(_bk(v))) {
            hits.push({ block: b, dist: Math.sqrt(dx*dx + dy*dy + dz*dz) })
          }
        }
      }
    }
    if (hits.length === 0) return false
    hits.sort((a, b) => a.dist - b.dist)
    // Use slightly generous threshold — euclidean grid diagonal vs actual reach
    const reachable = hits.filter(h => h.dist <= DIG_REACH + 0.5)
    this._info(`nearby scan: ${hits.length} ore(s) in range — ${reachable.length} reachable — digging`)
    for (const { block } of reachable) {
      if (this._interrupt()) return false
      const fresh = bot.blockAt?.(block.position)
      if (fresh && this._match.test(fresh.name)) await this._digBlock(fresh)
    }
    const cur = bot.entity?.position
    return !!(cur && _dist3(cur, orePos) <= DIG_REACH)
  }

  // Stubs — no-op observer hooks (used in _fullNav for future extension)
  _startObserver () {}
  _stopObserver () {}

  // ---------------------------------------------------------------------------
  // Safety check for one tunnel column (foot level).
  // Returns null if safe, or a reason string.
  // ---------------------------------------------------------------------------
  _colSafe (x, footY, z) {
    const bot = this._bot
    for (const dy of [0, 1, 2]) {
      const blk = bot.blockAt?.(new Vec3(x, footY + dy, z))
      if (!blk) continue
      if (DANGER_BLOCKS.test(blk.name))  return `danger:${blk.name}@+${dy}`
      if (dy === 2 && GRAVITY_BLOCKS.test(blk.name)) return `gravity:${blk.name}@+2`
    }
    const floor = bot.blockAt?.(new Vec3(x, footY - 1, z))
    if (floor && DANGER_BLOCKS.test(floor.name)) return `danger_floor:${floor.name}`
    
    // NEW: Check for water in adjacent blocks that could flood tunnel
    for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      for (const dy of [0, 1]) { // Check water at foot and head level
        const sideBlock = bot.blockAt?.(new Vec3(x + dx, footY + dy, z + dz))
        if (sideBlock && /^(water|flowing_water)$/i.test(sideBlock.name)) {
          return `water_adjacent:${sideBlock.name}@+${dy} (${dx > 0 ? 'east' : dx < 0 ? 'west' : dz > 0 ? 'south' : 'north'})`
        }
      }
    }
    
    return null
  }

  // ---------------------------------------------------------------------------
  // Dig a block if it's solid (not air/empty). Swaps to best tool.
  // ---------------------------------------------------------------------------
  async _digIfSolid (bot, vec) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const blk = bot.blockAt?.(vec) // re-read each attempt — avoid stale ref
      if (!blk || blk.name === 'air' || blk.boundingBox === 'empty') return
      const isHard = /deepslate|obsidian|ancient_debris/.test(blk.name)
      const timeout = isHard ? 10_000 : TUNNEL_DIG_TIMEOUT_MS
      try {
        if (SHOVEL_BLOCKS.test(blk.name)) await equipBestShovel(bot)
        else await equipBestPickaxe(bot)
        await Promise.race([
          bot.dig(blk, true),
          new Promise((_, rej) => setTimeout(() => rej(new Error('dig_timeout')), timeout))
        ])
        this._tel.tunnelBlocks++
        return // success
      } catch (e) {
        const reason = e?.message ?? ''
        if (reason === 'dig_timeout') {
          this._info(`digIfSolid: timeout on ${blk.name} at ${vec} (attempt ${attempt + 1})`)
          return // don't retry on timeout — move on
        }
        if (reason.includes('Aborted') || reason.includes('aborted') || reason.includes('interrupted')) {
          // Dig was interrupted (look change etc.) — retry once after short wait
          await sleep(200)
          continue
        }
        this._info(`digIfSolid error: ${reason}`)
        return
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Mark a block position as temporarily failed (CLUSTER BLACKLISTING)
  // ---------------------------------------------------------------------------
  _markFailed (pos, reason = 'unknown') {
    this._tel.failedOres++
    const now = Date.now()
    
    // Mark the original failed block
    const originalKey = _bk(pos)
    const wasInBlacklist = this._failed.has(originalKey)
    this._failed.set(originalKey, now)
    
    this._info(`markFailed: ${originalKey} (reason: ${reason}) - blacklist size: ${this._failed.size} ${wasInBlacklist ? '(was already)' : '(new)'}`)
    
    // CLUSTER BLACKLIST: Mark all nearby ore blocks of same type as failed
    const bot = this._bot
    const px = Math.floor(pos.x)
    const py = Math.floor(pos.y)
    const pz = Math.floor(pos.z)
    const originalBlock = bot.blockAt?.(new Vec3(px, py, pz))
    
    if (originalBlock) {
      const oreType = originalBlock.name
      const CLUSTER_RADIUS = 3 // Blacklist 3x3x3 cube around failed ore
      let blacklistedCount = 0
      
      for (let dx = -CLUSTER_RADIUS; dx <= CLUSTER_RADIUS; dx++) {
        for (let dy = -CLUSTER_RADIUS; dy <= CLUSTER_RADIUS; dy++) {
          for (let dz = -CLUSTER_RADIUS; dz <= CLUSTER_RADIUS; dz++) {
            const checkPos = new Vec3(px + dx, py + dy, pz + dz)
            const checkBlock = bot.blockAt?.(checkPos)
            
            if (checkBlock && checkBlock.name === oreType) {
              const clusterKey = _bk(checkPos)
              if (!this._failed.has(clusterKey)) {
                this._failed.set(clusterKey, now)
                blacklistedCount++
              }
            }
          }
        }
      }
      
      if (blacklistedCount > 0) {
        this._info(`cluster blacklist: ${oreType} at ${originalKey} - blacklisted ${blacklistedCount} nearby blocks (reason: ${reason})`)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Pillar up (scaffolding): place blocks under self while jumping to climb
  // ---------------------------------------------------------------------------
  async _pillarUp (targetY) {
    const bot = this._bot
    const pos = bot.entity?.position
    if (!pos) return false

    const footY = Math.floor(pos.y)
    const cx = Math.floor(pos.x)
    const cz = Math.floor(pos.z)

    // CRITICAL FIX: Don't pillar down - only pillar up
    if (targetY <= footY) {
      this._info(`pillar up: abort — target y=${targetY} <= current y=${footY} (would build down)`)
      return false
    }

    // CRITICAL FIX: Check for at least 2 air blocks above for jumping
    const blockAbove1 = bot.blockAt?.(new Vec3(cx, footY + 1, cz))
    const blockAbove2 = bot.blockAt?.(new Vec3(cx, footY + 2, cz))
    if (!blockAbove1 || !blockAbove2 || blockAbove1.name !== 'air' || blockAbove2.name !== 'air') {
      this._info(`pillar up: abort — not enough air space above (y+1=${blockAbove1?.name}, y+2=${blockAbove2?.name})`)
      return false
    }

    // Safety check: no lava/water directly below
    const blockBelow = bot.blockAt?.(new Vec3(cx, footY - 1, cz))
    if (blockBelow && /^(lava|flowing_lava|water|flowing_water)$/i.test(blockBelow.name)) {
      this._info(`pillar up: abort — ${blockBelow.name} below`)
      return false
    }

    // Safety check: no falling gravel/sand directly above (would crush us)
    const blockAbove3 = bot.blockAt?.(new Vec3(cx, footY + 3, cz))
    const blockAbove4 = bot.blockAt?.(new Vec3(cx, footY + 4, cz))
    if ((blockAbove3 && /^(gravel|sand|red_sand)$/i.test(blockAbove3.name)) ||
        (blockAbove4 && /^(gravel|sand|red_sand)$/i.test(blockAbove4.name))) {
      this._info('pillar up: abort — falling blocks above')
      return false
    }

    // Find placeable blocks in inventory (cobblestone, dirt, stone, etc)
    const PLACEABLE = /^(cobblestone|stone|dirt|andesite|granite|diorite|netherrack|deepslate|cobbled_deepslate)$/i
    const items = bot.inventory?.items() || []
    const blockItem = items.find(i => PLACEABLE.test(i.name))
    if (!blockItem) {
      this._info('pillar up: no placeable blocks in inventory')
      return false
    }

    this._info(`pillar up: scaffolding from y=${footY} to y=${targetY} (upward only)`)

    // Stop pathfinder and clear movement to prevent drift from partial paths
    if (bot.pathfinder) {
      bot.pathfinder.stop()
      bot.pathfinder.setGoal(null)
    }
    bot.setControlState('forward', false)
    bot.setControlState('back', false)
    bot.setControlState('left', false)
    bot.setControlState('right', false)
    bot.setControlState('sprint', false)

    const steps = Math.max(1, targetY - footY)
    let failedAttempts = 0
    const MAX_FAILED_ATTEMPTS = 3

    for (let i = 0; i < steps + 3; i++) { // +3 margin for overshoot
      if (this._interrupt()) return false
      const currentPos = bot.entity?.position
      if (!currentPos) return false
      const currentY = Math.floor(currentPos.y)
      if (currentY >= targetY) {
        this._info(`pillar up: reached y=${currentY}`)
        // Reset pathfinder for next navigation
        if (bot.pathfinder) bot.pathfinder.setGoal(null)
        return true
      }

      // Re-check safety each step
      const curCx = Math.floor(currentPos.x)
      const curCy = Math.floor(currentPos.y)
      const curCz = Math.floor(currentPos.z)
      const belowNow = bot.blockAt?.(new Vec3(curCx, curCy - 1, curCz))
      if (belowNow && /^(lava|flowing_lava)$/i.test(belowNow.name)) {
        this._info('pillar up: abort — lava detected below')
        // Reset pathfinder before abort
        if (bot.pathfinder) bot.pathfinder.setGoal(null)
        return false
      }

      // Equip block
      try {
        await bot.equip(blockItem, 'hand')
      } catch (e) {
        this._info('pillar up: equip failed')
        // Reset pathfinder before abort
        if (bot.pathfinder) bot.pathfinder.setGoal(null)
        return false
      }

      // Look straight down at the block under our feet
      await bot.look(bot.entity.yaw, Math.PI / 2, true)

      // Jump and place block under self (scaffolding technique)
      bot.setControlState('jump', true)
      await sleep(50) // small delay to start jump

      // Place block on the block we're standing on (face UP = under us)
      const standingBlock = bot.blockAt?.(new Vec3(curCx, curCy - 1, curCz))
      let placed = false
      if (standingBlock && standingBlock.name !== 'air') {
        try {
          await bot.placeBlock(standingBlock, new Vec3(0, 1, 0)) // place on top = under us
          placed = true
        } catch (e) {
          // Try center placement if edge placement failed
          try {
            await bot.look(bot.entity.yaw, Math.PI / 2 + 0.1, true)
            await bot.placeBlock(standingBlock, new Vec3(0, 1, 0))
            placed = true
          } catch (e2) { /* will retry next iteration */ }
        }
      }

      // Continue jump and land on new block
      await sleep(200)
      bot.setControlState('jump', false)
      await sleep(150) // wait to land on new block

      if (!placed) {
        failedAttempts++
        this._info(`pillar up: place failed, retrying... (${failedAttempts}/${MAX_FAILED_ATTEMPTS})`)
        if (failedAttempts >= MAX_FAILED_ATTEMPTS) {
          this._info('pillar up: too many failed attempts — aborting')
          return false
        }
        // Don't return false immediately, try again
      } else {
        failedAttempts = 0 // Reset on success
      }
    }

    const finalY = Math.floor(bot.entity?.position?.y || 0)
    const success = finalY >= targetY
    this._info(`pillar up: ${success ? 'succeeded' : 'failed'} at y=${finalY}`)
    // Always reset pathfinder for next navigation
    if (bot.pathfinder) bot.pathfinder.setGoal(null)
    return success
  }

  // ---------------------------------------------------------------------------
  // Brute-force tunnel to a known position (where drop fell after digging).
  // No entity search needed — we know exactly where the ore was.
  // ---------------------------------------------------------------------------
  async _tunnelToPos (targetPos) {
    const bot = this._bot
    const botPos = bot.entity?.position
    if (!botPos) return

    const dist = _dist3(botPos, targetPos)
    if (dist <= 1.2) {
      this._info(`tunnelToPos: already at target (dist=${dist.toFixed(1)}) — waiting for pickup`)
      await sleep(500)
      return
    }

    this._info(`tunnelToPos: target=${_bk(targetPos)} dist=${dist.toFixed(1)} — brute-force digging`)
    this._bus.emit(NavEvents.STOP, { reason: 'tunnel_to_drop' })

    const invBefore = this._countOreInInventory()
    const maxSteps = 20

    let lastStepPos = botPos.clone()
    let samePosSince = 0

    for (let step = 0; step < maxSteps; step++) {
      if (this._interrupt()) { this._info('tunnelToPos: interrupted'); return }

      const cur = bot.entity?.position
      if (!cur) return
      const distNow = _dist3(cur, targetPos)

      // Close enough — item auto-pickup radius is ~1.5 block
      if (distNow <= 1.5) {
        this._info(`tunnelToPos: reached target (step ${step}, dist=${distNow.toFixed(1)})`)
        await sleep(500) // wait for auto-pickup
        const invAfter = this._countOreInInventory()
        if (invAfter > invBefore) {
          this._info(`tunnelToPos: pickup confirmed (inv: ${invBefore}→${invAfter})`)
        }
        return
      }

      // Stuck detection: if bot didn't move for 2 steps, try jumping
      if (_dist3(cur, lastStepPos) < 0.3) {
        samePosSince++
      } else {
        samePosSince = 0
        lastStepPos = cur.clone()
      }
      if (samePosSince >= 3) {
        this._info(`tunnelToPos: stuck at ${_bk(cur)} for ${samePosSince} steps — jumping`)
        bot.setControlState('jump', true)
        bot.setControlState('forward', true)
        await sleep(400)
        bot.setControlState('forward', false)
        bot.setControlState('jump', false)
        await sleep(150)
        samePosSince = 0
        lastStepPos = bot.entity?.position?.clone() || cur.clone()
        continue
      }

      const rawDx = targetPos.x - cur.x
      const rawDz = targetPos.z - cur.z
      const dy = targetPos.y - cur.y
      const footY = Math.floor(cur.y)
      const bx = Math.floor(cur.x)
      const bz = Math.floor(cur.z)
      const horizDist = Math.sqrt(rawDx * rawDx + rawDz * rawDz)

      const blkLow = bot.blockAt?.(new Vec3(bx, footY, bz))
      const blkHigh = bot.blockAt?.(new Vec3(bx, footY + 1, bz))
      this._info(`tunnelToPos: step ${step} dist=${distNow.toFixed(1)} dy=${dy.toFixed(1)} dh=${horizDist.toFixed(1)} dig (${bx},${footY},${bz})=${blkLow?.name||'air'}`)

      if (horizDist < 1.2 && dy < -1.5) {
        // ── NEED TO GO DOWN ── dig floor and step down
        await bot.look(bot.entity.yaw, Math.PI / 2, true)
        await this._digIfSolid(bot, new Vec3(bx, footY - 1, bz))
        await sleep(200) // let gravity drop us
        lastStepPos = bot.entity?.position?.clone() || cur.clone()
      } else if (horizDist < 1.2 && dy > 1.5) {
        // ── NEED TO GO UP ── dig ceiling and jump
        await this._digIfSolid(bot, new Vec3(bx, footY + 1, bz))
        await this._digIfSolid(bot, new Vec3(bx, footY + 2, bz))
        bot.setControlState('jump', true)
        await sleep(350)
        bot.setControlState('jump', false)
        await sleep(150)
        lastStepPos = bot.entity?.position?.clone() || cur.clone()
      } else {
        // ── HORIZONTAL ── dig 2-high passage ahead and walk
        const yaw = Math.atan2(-rawDx, -rawDz)
        const aX = bx + Math.round(Math.sin(yaw))
        const aZ = bz + Math.round(Math.cos(yaw))

        await bot.look(yaw, 0, true)
        await this._digIfSolid(bot, new Vec3(aX, footY,     aZ))
        await this._digIfSolid(bot, new Vec3(aX, footY + 1, aZ))

        // Also dig floor ahead if target is lower
        if (dy < -1) {
          await this._digIfSolid(bot, new Vec3(aX, footY - 1, aZ))
        }

        bot.setControlState('forward', true)
        await sleep(350)
        bot.setControlState('forward', false)
        await sleep(100)
        lastStepPos = bot.entity?.position?.clone() || cur.clone()
      }

      // Check if we picked it up mid-walk
      const invNow = this._countOreInInventory()
      if (invNow > invBefore) {
        this._info(`tunnelToPos: picked up mid-tunnel (step ${step}, inv: ${invBefore}→${invNow})`)
        return
      }
    }

    const finalDist = bot.entity?.position ? _dist3(bot.entity.position, targetPos).toFixed(1) : '?'
    this._info(`tunnelToPos: FAILED after ${maxSteps} steps — dist=${finalDist}`)
  }

  // ---------------------------------------------------------------------------
  // Count ore items currently in inventory (raw ore + deepslate variants)
  // ---------------------------------------------------------------------------
  _countOreInInventory () {
    const items = this._bot.inventory?.items() || []
    return items.reduce((sum, item) => {
      if (item && this._dropMatch.test(item.name)) return sum + item.count
      return sum
    }, 0)
  }

  // ---------------------------------------------------------------------------
  // Collect nearby dropped items — direct vector walk, no yaw math, no pathfinder
  // ---------------------------------------------------------------------------
  async _collectDrops (orePos = null) {
    const bot = this._bot
    const botPos = bot.entity?.position
    if (!botPos || !bot.entities) return

    // Stop pathfinder immediately
    this._bus.emit(NavEvents.STOP, { reason: 'collect_drops' })

    // Anchor point: prefer mined ore position, fall back to bot position
    const anchor = orePos || botPos

    // Only collect drops within 4 blocks of the mined ore block
    // This prevents chasing drops on the surface when underground
    const DROP_ANCHOR_RADIUS = 4
    const drops = Object.values(bot.entities).filter(e => {
      if (!e?.position) return false
      if (e.id === bot.entity?.id) return false
      if ((e.name ?? '').toLowerCase() !== 'item') return false
      // Must be near where the ore was mined
      const dx = Math.abs(e.position.x - anchor.x)
      const dy = Math.abs(e.position.y - anchor.y)
      const dz = Math.abs(e.position.z - anchor.z)
      return dx <= DROP_ANCHOR_RADIUS && dy <= DROP_ANCHOR_RADIUS && dz <= DROP_ANCHOR_RADIUS
    }).sort((a, b) => _dist3(a.position, botPos) - _dist3(b.position, botPos))

    if (drops.length === 0) {
      this._info('collectDrops: no item entities nearby')
      return
    }
    this._info(`collectDrops: ${drops.length} drop(s) in range`)

    const invBefore = this._countOreInInventory()

    for (const drop of drops) {
      if (this._interrupt()) break
      if (!drop.position) continue
      if (!bot.entities[drop.id]) continue // already collected

      await this._walkToEntity(drop, invBefore)

      // Stop as soon as we picked something up
      const invNow = this._countOreInInventory()
      if (invNow > invBefore) {
        this._info(`collectDrops: picked up (inv: ${invBefore}→${invNow})`)
        return
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Walk toward a drop entity using direct vector — dig solid blocks on path.
  // No yaw sin/cos — just normalize dx/dz vector and step block by block.
  // ---------------------------------------------------------------------------
  async _walkToEntity (entity, invBefore) {
    const bot = this._bot
    const MAX_STEPS = 10
    let lastDist = Infinity
    let noProgressSteps = 0

    for (let step = 0; step < MAX_STEPS; step++) {
      if (this._interrupt()) return
      if (!bot.entities[entity.id]) return // collected

      const cur = bot.entity?.position
      if (!cur) return

      // Use live entity position (it may move/fall)
      const target = bot.entities[entity.id]?.position || entity.position
      const dist = _dist3(cur, target)
      this._info(`walkToEntity: step ${step} dist=${dist.toFixed(1)} target=${target.x.toFixed(0)},${target.y.toFixed(0)},${target.z.toFixed(0)}`)

      if (dist <= 2.5) {
        this._info(`walkToEntity: in pickup range — waiting`)
        await sleep(500)
        return
      }

      // Skip if not making progress after 3 steps
      if (dist >= lastDist - 0.2) {
        noProgressSteps++
        if (noProgressSteps >= 3) {
          this._info(`walkToEntity: no progress (dist=${dist.toFixed(1)}) — skipping drop`)
          return
        }
      } else {
        noProgressSteps = 0
      }
      lastDist = dist

      // Direct vector bot → drop (no yaw, no sin/cos)
      const dx = target.x - cur.x
      const dy = target.y - cur.y
      const dz = target.z - cur.z
      const len = Math.sqrt(dx * dx + dz * dz)
      if (len < 0.01) { await sleep(200); continue }

      // Step to the next block in the direction of the drop
      const stepX = Math.round(dx / len)
      const stepZ = Math.round(dz / len)
      const footY = Math.floor(cur.y)
      const nextX = Math.floor(cur.x) + stepX
      const nextZ = Math.floor(cur.z) + stepZ

      // Check vertical: if drop is above, try to jump-reach
      if (dy > 1.5 && len < 1.5) {
        await this._digIfSolid(bot, new Vec3(Math.floor(cur.x), footY + 1, Math.floor(cur.z)))
        await this._digIfSolid(bot, new Vec3(Math.floor(cur.x), footY + 2, Math.floor(cur.z)))
        bot.setControlState('jump', true)
        await sleep(350)
        bot.setControlState('jump', false)
        await sleep(150)
        continue
      }

      // Dig blocks on direct path if solid
      const blkLow = bot.blockAt?.(new Vec3(nextX, footY, nextZ))
      const blkHigh = bot.blockAt?.(new Vec3(nextX, footY + 1, nextZ))

      const isAirLow  = !blkLow  || blkLow.boundingBox  === 'empty' || blkLow.name  === 'air'
      const isAirHigh = !blkHigh || blkHigh.boundingBox === 'empty' || blkHigh.name === 'air'

      if (!isAirLow)  await this._digIfSolid(bot, new Vec3(nextX, footY,     nextZ))
      if (!isAirHigh) await this._digIfSolid(bot, new Vec3(nextX, footY + 1, nextZ))

      // Walk forward one step
      const yaw = Math.atan2(-dx, -dz)
      await bot.look(yaw, 0, true)
      bot.setControlState('forward', true)
      await sleep(350)
      bot.setControlState('forward', false)
      await sleep(100)

      // Check pickup after each step
      const invNow = this._countOreInInventory()
      if (invNow > invBefore) return
    }
  }

  // ---------------------------------------------------------------------------
// Escape from water with retreat and blacklist system
// ---------------------------------------------------------------------------
async _escapeFromWater () {
  const bot = this._bot
  const pos = bot.entity?.position
  if (!pos) return

  this._info('water escape: starting evacuation')

  // Stop any current navigation
  this._bus.emit(NavEvents.STOP, { reason: 'water_escape' })
  bot.setControlState('forward', false)
  bot.setControlState('back', false)
  bot.setControlState('left', false)
  bot.setControlState('right', false)
  bot.setControlState('jump', false)

  // Blacklist surrounding water blocks
  const footY = Math.floor(pos.y)
  const cx = Math.floor(pos.x)
  const cz = Math.floor(pos.z)
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      for (let dy = -1; dy <= 4; dy++) {
        const b = bot.blockAt?.(new Vec3(cx + dx, footY + dy, cz + dz))
        if (b && /^(water|flowing_water)$/i.test(b.name)) {
          this._waterBlacklist.add(`${cx+dx},${footY+dy},${cz+dz}`)
        }
      }
    }
  }
  this._info(`water escape: blacklisted ${this._waterBlacklist.size} water locations`)

  // ── STEP 1: try retreating backwards (fast path — water was just entered)
  const retreatOk = await this._tryRetreatFromWater()
  if (retreatOk) {
    this._info('water escape: retreated successfully')
    return
  }

  // ── STEP 2: dig straight up until above water — never dig into water blocks
  this._info('water escape: digging upward to surface')
  const MAX_UP = 40
  for (let i = 0; i < MAX_UP; i++) {
    if (this._interrupt()) return
    const cur = bot.entity?.position
    if (!cur) break

    const fy = Math.floor(cur.y)
    const bx = Math.floor(cur.x)
    const bz = Math.floor(cur.z)

    // Are we out of water?
    const blockFoot = bot.blockAt?.(new Vec3(bx, fy, bz))
    const blockHead = bot.blockAt?.(new Vec3(bx, fy + 1, bz))
    const isInWater = (b) => b && /^(water|flowing_water)$/i.test(b.name)
    if (!isInWater(blockFoot) && !isInWater(blockHead)) {
      this._info(`water escape: out of water at Y=${fy} after ${i} steps`)
      this._bus.emit(NavEvents.STOP, { reason: 'water_escape_complete' })
      return
    }

    // Dig upward — only if block above is solid (not water/air)
    for (const dy of [1, 2]) {
      const above = bot.blockAt?.(new Vec3(bx, fy + dy, bz))
      if (!above) continue
      if (isInWater(above)) {
        // Block above is water — safe to swim through, don't dig
        continue
      }
      if (above.boundingBox !== 'empty' && above.name !== 'air') {
        // Solid block above — dig it (creates upward passage without exposing water)
        try {
          await Promise.race([
            bot.dig(above, true),
            new Promise((_, r) => setTimeout(() => r(new Error('dig_timeout')), 4000))
          ])
        } catch (_) {}
        await sleep(100)
      }
    }

    // Jump/swim upward
    bot.setControlState('jump', true)
    await sleep(400)
    bot.setControlState('jump', false)
    await sleep(150)
  }

  // ── STEP 3: if still in water, brute-force dig horizontally to find edge + dig out
  this._info('water escape: digging horizontally to water edge')
  const curPos = bot.entity?.position
  if (!curPos) return

  // Find nearest non-water column within 8 blocks
  const fx = Math.floor(curPos.x)
  const fz = Math.floor(curPos.z)
  const fy2 = Math.floor(curPos.y)

  let bestEdge = null
  let bestDist = Infinity
  for (let dx = -8; dx <= 8; dx++) {
    for (let dz = -8; dz <= 8; dz++) {
      if (dx === 0 && dz === 0) continue
      const d = Math.sqrt(dx*dx + dz*dz)
      if (d >= bestDist) continue
      // Check if this column is non-water at foot level
      const b = bot.blockAt?.(new Vec3(fx + dx, fy2, fz + dz))
      if (!b || /^(water|flowing_water|lava|flowing_lava)$/i.test(b.name)) continue
      bestEdge = new Vec3(fx + dx, fy2, fz + dz)
      bestDist = d
    }
  }

  if (bestEdge) {
    this._info(`water escape: tunnelling to edge at ${_bk(bestEdge)} dist=${bestDist.toFixed(1)}`)
    await this._digToWaterEdge(bestEdge)
  } else {
    // Last resort: keep jumping
    this._info('water escape: no edge found — jumping')
    bot.setControlState('jump', true)
    await sleep(1500)
    bot.setControlState('jump', false)
  }
}

// ---------------------------------------------------------------------------
// Dig horizontally toward a water-edge target, never opening water behind walls
// ---------------------------------------------------------------------------
async _digToWaterEdge (targetPos) {
  const bot = this._bot
  const MAX_STEPS = 16

  for (let step = 0; step < MAX_STEPS; step++) {
    if (this._interrupt()) return
    const cur = bot.entity?.position
    if (!cur) return

    const dist = _dist3(cur, targetPos)
    if (dist <= 1.5) {
      this._info(`water edge: reached (step ${step})`)
      this._bus.emit(NavEvents.STOP, { reason: 'water_escape_complete' })
      return
    }

    // Are we out of water? Done.
    const fy = Math.floor(cur.y)
    const bx = Math.floor(cur.x)
    const bz = Math.floor(cur.z)
    const bFoot = bot.blockAt?.(new Vec3(bx, fy, bz))
    const bHead = bot.blockAt?.(new Vec3(bx, fy + 1, bz))
    const isWater = (b) => b && /^(water|flowing_water)$/i.test(b.name)
    if (!isWater(bFoot) && !isWater(bHead)) {
      this._info('water edge: out of water mid-tunnel')
      this._bus.emit(NavEvents.STOP, { reason: 'water_escape_complete' })
      return
    }

    const dx = targetPos.x - cur.x
    const dz = targetPos.z - cur.z
    const len = Math.sqrt(dx*dx + dz*dz)
    if (len < 0.01) { await sleep(200); continue }

    const yaw = Math.atan2(-dx, -dz)
    const stepX = Math.round(dx / len)
    const stepZ = Math.round(dz / len)
    const nextX = Math.floor(cur.x) + stepX
    const nextZ = Math.floor(cur.z) + stepZ

    // Before digging: check if block ahead hides water behind it — skip if so
    for (const dy of [0, 1]) {
      const ahead = bot.blockAt?.(new Vec3(nextX, fy + dy, nextZ))
      if (!ahead) continue
      if (isWater(ahead)) continue // already water — swim through
      if (ahead.boundingBox === 'empty' || ahead.name === 'air') continue

      // Check the block BEHIND ahead — if it's water, don't dig (would flood)
      const behind = bot.blockAt?.(new Vec3(nextX + stepX, fy + dy, nextZ + stepZ))
      if (behind && isWater(behind)) {
        this._info(`water edge: skip dig at (${nextX},${fy+dy},${nextZ}) — water behind`)
        continue
      }

      try {
        await Promise.race([
          bot.dig(ahead, true),
          new Promise((_, r) => setTimeout(() => r(new Error('dig_timeout')), 4000))
        ])
      } catch (_) {}
      await sleep(100)
    }

    // Also swim/jump upward if needed
    bot.setControlState('jump', true)
    await bot.look(yaw, 0, true)
    bot.setControlState('forward', true)
    await sleep(350)
    bot.setControlState('forward', false)
    bot.setControlState('jump', false)
    await sleep(100)
  }

  this._info('water edge: max steps reached')
}

// ---------------------------------------------------------------------------
// Scan in all 6 directions from bot position for water within `depth` blocks.
// Stops scanning a direction on first solid block (can't pass through it).
// Returns true if water is reachable in any direction.
// ---------------------------------------------------------------------------
_waterBelowBot (bx, fy, bz, depth) {
  const bot = this._bot
  // Down: full depth (fall into cave lake), others: 6 blocks (immediate surroundings)
  const DIRS = [
    [0, -1, 0, depth], // down  — fall risk, scan far
    [0,  1, 0, 6],     // up    — water ceiling nearby
    [1,  0, 0, 6],     // east
    [-1, 0, 0, 6],     // west
    [0,  0, 1, 6],     // south
    [0,  0, -1, 6],    // north
  ]
  for (const [dx, dy, dz, d] of DIRS) {
    for (let i = 1; i <= d; i++) {
      const b = bot.blockAt?.(new Vec3(bx + dx*i, fy + dy*i, bz + dz*i))
      if (!b) break
      if (/^(water|flowing_water)$/i.test(b.name)) return true
      if (b.boundingBox === 'block') break // solid wall — stop this direction
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Check if ore block is submerged in water
// ---------------------------------------------------------------------------
_isOreSubmergedInWater (pos) {
  const bot = this._bot
  const px = Math.floor(pos.x)
  const py = Math.floor(pos.y)
  const pz = Math.floor(pos.z)
  
  // Check if the ore block itself is surrounded by water
  const oreBlock = bot.blockAt?.(new Vec3(px, py, pz))
  if (!oreBlock) return false
  
  // Check all 6 faces around the ore for water
  const surroundingPositions = [
    new Vec3(px + 1, py, pz), // east
    new Vec3(px - 1, py, pz), // west  
    new Vec3(px, py, pz + 1), // south
    new Vec3(px, py, pz - 1), // north
    new Vec3(px, py + 1, pz), // up
    new Vec3(px, py - 1, pz)  // down
  ]
  
  let waterCount = 0
  for (const checkPos of surroundingPositions) {
    const block = bot.blockAt?.(checkPos)
    if (block && /^(water|flowing_water)$/i.test(block.name)) {
      waterCount++
    }
  }
  
  // If 3+ faces are water, consider the ore submerged
  if (waterCount >= 3) {
    this._info(`ore submerged: ${oreBlock.name} at (${px},${py},${pz}) surrounded by ${waterCount} water faces`)
    return true
  }
  
  // Also check if ore is directly in water (same position)
  const blockAtOre = bot.blockAt?.(new Vec3(px, py, pz))
  if (blockAtOre && /^(water|flowing_water)$/i.test(blockAtOre.name)) {
    this._info(`ore in water: ${oreBlock.name} at (${px},${py},${pz}) is in water block`)
    return true
  }
  
  return false
}

// ---------------------------------------------------------------------------
// Scan for nearby ore blocks during movement (tunnel observer)
// ---------------------------------------------------------------------------
_scanNearbyOre (radius = 3) {
  const bot = this._bot
  const pos = bot.entity?.position
  if (!pos) return null

  // Check in a cube around the bot
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -1; dy <= 2; dy++) { // Check from foot level to head level
      for (let dz = -radius; dz <= radius; dz++) {
        const checkPos = new Vec3(
          Math.floor(pos.x) + dx,
          Math.floor(pos.y) + dy,
          Math.floor(pos.z) + dz
        )
        
        const block = bot.blockAt?.(checkPos)
        if (block && this._match.test(block.name)) {
          // Skip if already targeted or failed
          if (!this._failed.has(_bk(block.position))) {
            return block
          }
        }
      }
    }
  }
  
  return null
}

// ---------------------------------------------------------------------------
// Check if position is near blacklisted water areas
// ---------------------------------------------------------------------------
_isNearBlacklistedWater (pos) {
  const checkRadius = 5 // Check 5 blocks around ore position
  const px = Math.floor(pos.x)
  const py = Math.floor(pos.y)
  const pz = Math.floor(pos.z)
  
  for (let dx = -checkRadius; dx <= checkRadius; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dz = -checkRadius; dz <= checkRadius; dz++) {
        const checkKey = `${px + dx},${py + dy},${pz + dz}`
        if (this._waterBlacklist.has(checkKey)) {
          return true
        }
      }
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Try to retreat backwards from water
// ---------------------------------------------------------------------------
async _tryRetreatFromWater () {
  const bot = this._bot
  const pos = bot.entity?.position
  if (!pos) return false

  // Get opposite direction of where we were trying to go
  const yaw = bot.entity.yaw + Math.PI // Reverse direction
  
  // Try to move backwards 5-10 blocks
  for (let step = 0; step < 10; step++) {
    // Look backwards and move
    await bot.look(yaw, 0, true)
    bot.setControlState('back', true)
    await sleep(300)
    bot.setControlState('back', false)
    await sleep(200)
    
    // Check if we're on dry land now
    const currentPos = bot.entity?.position
    if (currentPos) {
      const footY = Math.floor(currentPos.y)
      const cx = Math.floor(currentPos.x)
      const cz = Math.floor(currentPos.z)
      const blockAt = bot.blockAt?.(new Vec3(cx, footY, cz))
      const blockBelow = bot.blockAt?.(new Vec3(cx, footY - 1, cz))
      
      if (blockAt && blockBelow &&
          blockAt.name === 'air' &&
          !(/^(water|flowing_water)$/i.test(blockBelow.name))) {
        this._info('water retreat: reached dry land by backing up');
        return true;
      }
    }
  }
  
  return false;
  }

  _startObserver () {
    if (this._observerInterval) {
      clearInterval(this._observerInterval)
      this._observerInterval = null
    }
    this._isNavigating = true
    this._navigationPaused = false
  }

  _stopObserver () {
    if (this._observerInterval) {
      clearInterval(this._observerInterval);
      this._observerInterval = null;
    }
    this._isNavigating = false;
    this._navigationPaused = false;
  }

  _info (...args) {
    try { this._log?.info?.('[OreJob]', ...args) } catch (_) {}
  }

  // ---------------------------------------------------------------------------
  // Command system
  // ---------------------------------------------------------------------------
  /**
   * Command the bot to return to base
   */
  returnToBase () {
    this._info('returnToBase: command received - will return to base after current operation')
    this._shouldReturnToBase = true
  }

  /**
   * Check if bot should return to base
   */
  _shouldReturnToBaseCheck () {
    return this._shouldReturnToBase || this._pendingReturnToBase()
  }

  /**
   * Execute return to base using HomeBaseSystem
   */
  async _executeReturnToBase () {
    if (!this._homeBaseSystem) {
      this._info('returnToBase: no HomeBaseSystem available')
      this._shouldReturnToBase = false
      return 'base_return_failed'
    }

    this._info('returnToBase: executing return to base')
    
    try {
      // Stop any ongoing navigation
      this._bus.emit(NavEvents.STOP, { reason: 'return_to_base' })
      this._stopObserver()
      
      // Execute round trip to base
      await this._homeBaseSystem.executeRoundTrip({
        reason: 'manual_command',
        deposit: true,
        craft: true,
        repair: true
      })
      
      this._info('returnToBase: successfully returned from base')
      this._shouldReturnToBase = false
      return 'base_return_complete'
      
    } catch (error) {
      this._info(`returnToBase: error - ${error?.message}`)
      this._shouldReturnToBase = false
      return 'base_return_failed'
    }
  }
}

module.exports = { OreJob, _bk }
